import { useState, useEffect } from 'react';
import { useNCC } from '../context/NCCContext';
import { useAuth } from '../context/AuthContext';
import { useTracking } from '../context/TrackingContext';
import { useDiscovery } from '../context/DiscoveryContext';
import { nip19, nip44 } from 'nostr-tools';
import { Network, ShieldCheck, AlertTriangle, Lock, BadgeCheck } from 'lucide-react';
import { RelayManager } from '../lib/relays';
import clsx from 'clsx';
import { parsePrivateFlag, collectPrivateRecipients, isPrivateRecipientAuthorized } from 'ncc-02-js';

import { useWoT } from '../context/WoTContext';

// Simple HTML escaping helper
const escapeHtml = (str: string) => {
    return str.replace(/[&<"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[m] as string);
};

interface DiscoveryProps {
  onConnect: (url: string, serviceInfo?: { pubkey: string, id: string }) => void;
}

export function Discovery({ onConnect }: DiscoveryProps) {
  const { ncc02Resolver, ncc05Resolver, pool } = useNCC();
  const { pubkey: myPubkey, privkey, signEvent, decryptNip44 } = useAuth();
  const { trackService, isTracked, untrackService } = useTracking();
  const { isFollowing } = useWoT();
  
  const {
    pubkeyInput, setPubkeyInput,
    serviceId, setServiceId,
    step, setStep,
    logs, addLog, clearLogs,
    error, setError,
    resolvedEndpoint, setResolvedEndpoint,
    rawEvents, setRawEvents,
    profiles, setProfiles,
    decryptedPayloads, setDecryptedPayloads,
    showExpired, setShowExpired,
    attestedIds, setAttestedIds
  } = useDiscovery();

  const [probing, setProbing] = useState<Record<string, number | 'error' | 'loading'>>({});
  const [wotOnly, setWotOnly] = useState(false);
  const [authorizedEvents, setAuthorizedEvents] = useState<Record<string, boolean>>({});

  // Pre-calculate authorization for private events
  useEffect(() => {
      const checkAuth = async () => {
          const results: Record<string, boolean> = {};
          for (const ev of rawEvents) {
              if (ev.kind === 30058 || ev.kind === 30059) {
                  results[ev.id] = await isTargetedToMe(ev);
              }
          }
          setAuthorizedEvents(results);
      };
      if (rawEvents.length > 0 && myPubkey) {
          checkAuth();
      }
  }, [rawEvents, myPubkey, decryptedPayloads]);

  // Background Scanner: Find attestations in the existing record cache
  useEffect(() => {
      if (rawEvents.length > 0 && myPubkey) {
          const selfAttestedIds = rawEvents
              .filter(e => e.kind === 30060 && e.pubkey === myPubkey)
              .map(e => e.tags.find((t: any) => t[0] === 'e')?.[1])
              .filter(id => id) as string[];
          
          if (selfAttestedIds.length > 0) {
              setAttestedIds(prev => {
                  const combined = [...new Set([...prev, ...selfAttestedIds])];
                  return combined.length === prev.length ? prev : combined;
              });
          }
      }
  }, [rawEvents, myPubkey]);

  const probeEndpoint = async (url: string) => {
      setProbing((prev: any) => ({ ...prev, [url]: 'loading' }));
      const start = Date.now();
      
      let targetUrl = url;
      if (url.includes('.onion')) {
          targetUrl = `ws://${window.location.host}/bridge?target=${encodeURIComponent(url)}`;
      }

      try {
          // Attempt a simple WebSocket connection to test reachability
          const ws = new WebSocket(targetUrl);
          const timeout = setTimeout(() => ws.close(), 10000);
          
          await new Promise((resolve, reject) => {
              ws.onopen = () => {
                  clearTimeout(timeout);
                  ws.close();
                  resolve(true);
              };
              ws.onerror = (e) => {
                  clearTimeout(timeout);
                  reject(e);
              };
          });
          
          const latency = Date.now() - start;
          setProbing((prev: any) => ({ ...prev, [url]: latency }));
      } catch (e) {
          setProbing((prev: any) => ({ ...prev, [url]: 'error' }));
      }
  };

  const isExpired = (ev: any) => {
      const now = Math.floor(Date.now() / 1000);
      if (ev.kind === 30059) {
          const expTag = ev.tags.find((t: any) => t[0] === 'exp');
          if (expTag && parseInt(expTag[1]) < now) return true;
      }
      if (ev.kind === 30058) {
          try {
              if (ev.content.trim().startsWith('{')) {
                  const payload = JSON.parse(ev.content);
                  if (payload.updated_at && payload.ttl) {
                      if (payload.updated_at + payload.ttl < now) return true;
                  }
              } else {
                  const decrypted = decryptedPayloads[ev.id];
                  if (decrypted && decrypted.updated_at && decrypted.ttl) {
                       if (decrypted.updated_at + decrypted.ttl < now) return true;
                  }
              }
          } catch (e) { /* ignore */ }
      }
      return false;
  };

  const fetchProfiles = async (events: any[]) => {
      const authors = [...new Set(events.map(e => e.pubkey))];
      if (authors.length === 0) return;
      try {
          const profileEvents = await pool.querySync(RelayManager.load(), { kinds: [0], authors: authors });
          const profileMap: Record<string, any> = {};
          profileEvents.forEach(ev => {
              try {
                  const content = JSON.parse(ev.content);
                  profileMap[ev.pubkey] = { ...content, _tags: ev.tags };
              } catch (e) { /* ignore */ }
          });
          setProfiles(prev => ({...prev, ...profileMap}));
      } catch (e) { console.error("Failed to fetch profiles", e); }
  };

  const getDisplayName = (pubkey: string) => {
      const profile = profiles[pubkey];
      if (profile && (profile.display_name || profile.name)) {
          return profile.display_name || profile.name;
      }
      try {
          const npub = nip19.npubEncode(pubkey);
          return `${npub.slice(0, 10)}...${npub.slice(-4)}`;
      } catch (e) { return pubkey.slice(0, 8); }
  };
  
  const isTargetedToMe = async (event: any) => {
      if (!myPubkey) return false;
      
      if (event.kind === 30058) {
          // 1. Check if I am a recipient in the decrypted payload (if already decrypted)
          const dec = decryptedPayloads[event.id];
          if (dec && dec.privaterecipients?.includes(myPubkey)) return true;

          // 2. Check if I am in the author's Profile Whitelist (PoC Convention)
          const profile = profiles[event.pubkey];
          if (profile && profile._tags) {
              const whitelist = profile._tags.find((t: any) => t[0] === 'privaterecipients')?.slice(1) || [];
              if (whitelist.includes(myPubkey)) return true;
          }

          // 3. Check if I am a recipient in the raw content (if it's a public record with a private list)
          if (event.content.startsWith('{')) {
              try {
                  const data = JSON.parse(event.content);
                  if (data.privaterecipients?.includes(myPubkey)) return true;
              } catch(e) {}
          }
      }

      if (event.kind === 30059) {
          const privateRecipients = collectPrivateRecipients(event.tags);
          if (privateRecipients.length > 0) {
              const signer = {
                  nip44Decrypt: (ownerPubkey: string, ciphertext: string) => decryptNip44(ownerPubkey, ciphertext),
                  getPublicKey: () => Promise.resolve(myPubkey)
              };
              try {
                  return await isPrivateRecipientAuthorized(privateRecipients, event.pubkey, signer as any);
              } catch(e) { return false; }
          }
      }

      // 4. Check if I am mentioned in the 'p' tags of the event (Standard Nostr targeted event)
      return event.tags.some((t: any) => t[0] === 'p' && t[1] === myPubkey);
  };

  const handleDecryptClick = async (ev: any) => {
      try {
          const decrypted = await decryptNip44(ev.pubkey, ev.content);
          setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
      } catch(e: any) {
          alert("Decryption failed: " + e.message);
      }
  };

  const handleDiscover = async () => {
    setStep('verifying'); clearLogs(); setError(null); setResolvedEndpoint(null); setRawEvents([]); setProfiles({}); setDecryptedPayloads({});
    
    const withTimeout = (promise: Promise<any>, ms: number, msg: string) => 
        Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
        ]);

    try {
      let hex = pubkeyInput;
      if (pubkeyInput.startsWith('npub')) { hex = (nip19.decode(pubkeyInput).data as string); }
      
      if (!hex) {
          addLog(`🌐 Global Search: Querying bootstrap relays...`);
          // Note: Global search still uses querySync for broad discovery
          const filter: any = { kinds: [30053, 30058, 30059, 30060, 30061], limit: 50 };
          if (serviceId) filter['#d'] = [serviceId];
          const events = await withTimeout(
              pool.querySync(RelayManager.load(), filter), 
              10000, 
              "Global search timed out after 10s"
          );
          setRawEvents(events); fetchProfiles(events);
          addLog(`✅ Found ${events.length} records globally.`); setStep('complete');
          return;
      }
      
      addLog(`🔍 NCC Discovery: Querying service events...`);
      
      // Construct a NostrSigner for library use
      const signer = {
          getPublicKey: async () => myPubkey || '',
          signEvent: async (ev: any) => signEvent(ev),
          getConversationKey: async (peer: string) => {
              if (privkey) {
                  const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
                  return nip44.getConversationKey(hexToBytes(privkey), peer);
              }
              throw new Error("Local decryption key not available. Ensure you are logged in with NSEC.");
          }
      };

      // 1. Resolve Latest Infrastructure (Identity-Centric)
      addLog(`📍 NCC-05: Resolving latest locator...`);
      const locator = await withTimeout(
          ncc05Resolver.resolveLatest(hex, (signer as any)),
          10000,
          "Locator resolution timed out"
      );

      // 2. Resolve Service Status & Trust
      addLog(`🛡️ NCC-02: Verifying service trust...`);
      const status = await withTimeout(
          ncc02Resolver.resolve(hex, serviceId || 'relay', { requireAttestation: false, minLevel: 'self' }),
          5000,
          "Trust verification timed out"
      );

      // Map back to rawEvents for the existing UI rendering
      // In a full refactor, we would switch the UI to consume 'status' and 'locator' directly
      const events = [status.serviceEvent, ...(locator ? [/* dummy event for locator data */] : [])].filter(e => e);
      setRawEvents(events as any[]);
      fetchProfiles(events as any[]);
      
      if (locator && locator.endpoints?.length > 0) {
          setResolvedEndpoint(locator.endpoints[0]);
          addLog(`📍 Found ${locator.endpoints.length} endpoints.`);
      }

      setStep('complete');
    } catch (e: any) { 
        setError(e.message || 'Discovery failed'); 
        addLog(`❌ Error: ${e.message}`);
        setStep('idle'); 
    }
  };

  const handleConnect = (targetUrl?: string, serviceInfo?: { pubkey: string, id: string }) => {
    let resolvedServiceInfo = serviceInfo;
    
    // If no serviceInfo provided but we have a resolvedEndpoint, try to derive it from inputs
    if (!resolvedServiceInfo && resolvedEndpoint && pubkeyInput) {
        try {
            let hex = pubkeyInput;
            if (pubkeyInput.startsWith('npub')) {
                hex = nip19.decode(pubkeyInput).data as string;
            }
            resolvedServiceInfo = { pubkey: hex, id: serviceId || 'addr' };
        } catch (e) { /* ignore */ }
    }

    if (resolvedServiceInfo) {
        if (!isTracked(resolvedServiceInfo.pubkey, resolvedServiceInfo.id)) {
            trackService(resolvedServiceInfo.pubkey, resolvedServiceInfo.id);
        }
    }

    let url = targetUrl || (resolvedEndpoint ? (resolvedEndpoint.url || resolvedEndpoint.uri) : null);
    if (!url) return;
    if (!url.includes('://')) { url = url.includes('.onion') ? `ws://${url}` : `wss://${url}`; }
    if (url.startsWith('http')) url = url.replace('http', 'ws');

    if (url.includes('.onion')) {
        const choice = window.confirm(`🧅 Tor Onion Address Detected\n\n1. OK: Use Bridge (requires npm run bridge)\n2. Cancel: Direct (Tor Browser/Orbot)`);
        if (choice) {
            // Use Vite Proxy path /bridge
            const bridgeUrl = `ws://${window.location.host}/bridge?target=${encodeURIComponent(url)}`;
            onConnect(bridgeUrl, resolvedServiceInfo);
            return;
        } else {
            const direct = window.confirm("Attempt direct connection?");
            if (direct) { onConnect(url, resolvedServiceInfo); return; }
            navigator.clipboard.writeText(url); return;
        }
    }
    onConnect(url, resolvedServiceInfo);
  };

  const handleAttest = async (serviceRecord: any) => {
      if (!myPubkey) return alert("Please login first.");
      
      const dTag = serviceRecord.tags.find((t: any) => t[0] === 'd')?.[1];
      if (!dTag) return;

      const now = Math.floor(Date.now() / 1000);
      const expiry = now + (30 * 24 * 60 * 60); // 30 days
      
      const eventTemplate = {
          kind: 30060,
          created_at: now,
          tags: [
              ['subj', serviceRecord.pubkey],
              ['srv', dTag],
              ['e', serviceRecord.id],
              ['std', 'nostr-service-trust-v0.1'],
              ['lvl', 'verified'],
              ['nbf', now.toString()],
              ['exp', expiry.toString()]
          ],
          content: 'NCC-02 Attestation',
          pubkey: myPubkey
      };

      try {
          const signedEvent = await signEvent(eventTemplate);
          if (signedEvent) {
              addLog(`✍️ Publishing Attestation for ${dTag}...`);
              await pool.publish(RelayManager.load(), signedEvent);
              setAttestedIds(prev => [...prev, serviceRecord.id]);
              alert("Attestation Published Successfully!");
          }
      } catch (e: any) {
          console.error(e);
          alert("Attestation failed: " + e.message);
      }
  };

  return (
    <div className="card bg-base-100 shadow-lg border border-base-200">
      <div className="card-body p-4 sm:p-8">
        <h3 className="card-title text-xl mb-4 flex items-center">
          <Network className="w-6 h-6 mr-2 text-primary" />
          Discovery
        </h3>
        
        <div className="flex flex-col gap-4">
          <div className="form-control">
            <label className="label text-sm">Target Pubkey</label>
            <input className="input input-bordered w-full" placeholder="npub1..." value={pubkeyInput} onChange={e => setPubkeyInput(e.target.value)} />
          </div>
          <div className="form-control">
            <label className="label text-xs">Service ID (Optional)</label>
            <input className="input input-bordered w-full" placeholder="e.g. relay" value={serviceId} onChange={e => setServiceId(e.target.value)} />
          </div>
          <div className="form-control">
             <label className="cursor-pointer label justify-start gap-4">
               <span className="label-text text-sm">Show Expired</span> 
               <input type="checkbox" className="toggle toggle-sm toggle-warning" checked={showExpired} onChange={e => setShowExpired(e.target.checked)} />
             </label>
          </div>
          <div className="form-control">
             <label className="cursor-pointer label justify-start gap-4">
               <span className="label-text text-sm font-bold text-secondary">Network Only (WoT)</span> 
               <input type="checkbox" className="toggle toggle-sm toggle-secondary" checked={wotOnly} onChange={e => setWotOnly(e.target.checked)} />
             </label>
          </div>
          <button className="btn btn-primary w-full" onClick={() => handleDiscover()} disabled={step === 'verifying' || step === 'resolving'}>
            {step !== 'idle' && step !== 'complete' && <span className="loading loading-spinner"></span>}
            Run Discovery
          </button>
        </div>

        {error && <div className="alert alert-error mt-4 text-xs"><AlertTriangle className="w-4 h-4 flex-shrink-0" /><span>{error}</span></div>}

        <div className="mt-4 bg-base-300 p-3 rounded-box font-mono text-[10px] max-h-32 overflow-y-auto">
           {logs.length === 0 && <span className="opacity-50">Idle...</span>}
           {logs.map((log, i) => <div key={i} className="mb-1" dangerouslySetInnerHTML={{ __html: escapeHtml(log) }}></div>)}
        </div>

        {rawEvents.length > 0 && (
           <div className="mt-6 space-y-6">
              {(() => {
                  const byPub: Record<string, any[]> = {};
                  rawEvents.forEach(ev => { (byPub[ev.pubkey] = byPub[ev.pubkey] || []).push(ev); });

                  return Object.entries(byPub).map(([pubkey, events]) => {
                      const name = getDisplayName(pubkey);
                      const npub = nip19.npubEncode(pubkey);
                      const lastUpdate = Math.max(...events.map(e => e.created_at));
                      const lastUpdateStr = new Date(lastUpdate * 1000).toLocaleString();

                      const threads: Record<string, { service?: any, locators: any[], attestations: any[], revocations: any[] }> = {};
                      
                      // 1. Group events by their base service ID (stripped d-tag)
                      events.forEach(ev => {
                          const rawD = ev.tags.find((t: any) => t[0] === 'd')?.[1] || 'unknown';
                          const baseId = rawD.replace(/-locator$/, '').replace(/-loc$/, '');
                          
                          if (!threads[baseId]) threads[baseId] = { locators: [], attestations: [], revocations: [] };
                          
                          if (ev.kind === 30059) {
                              // Only keep the newest service record for this baseId
                              if (!threads[baseId].service || ev.created_at > threads[baseId].service.created_at) {
                                  threads[baseId].service = ev;
                              }
                          } else if (ev.kind === 30058) {
                              // For locators, we also only want the freshest one per baseId
                              if (threads[baseId].locators.length === 0 || ev.created_at > threads[baseId].locators[0].created_at) {
                                  threads[baseId].locators = [ev];
                              }
                          } else if (ev.kind === 30060) {
                              threads[baseId].attestations.push(ev);
                          } else if (ev.kind === 30061) {
                              threads[baseId].revocations.push(ev);
                          }
                      });

                      const activeKeys = Object.keys(threads).sort().filter(k => {
                          const t = threads[k];
                          const passesExpiry = showExpired || (t.service && !isExpired(t.service)) || t.locators.some(l => !isExpired(l));
                          if (!passesExpiry) return false;

                          if (wotOnly) {
                              // Is the author someone I follow?
                              if (isFollowing(pubkey)) return true;
                              // Has someone I follow attested to this identity's services?
                              if (t.attestations.some(a => isFollowing(a.pubkey))) return true;
                              return false;
                          }
                          return true;
                      });

                      if (activeKeys.length === 0) return null;

                      return (
                          <div key={pubkey} className="card bg-base-100 border border-base-300 w-full overflow-hidden shadow-sm">
                              <div className="card-body p-3">
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 pb-2 border-b border-base-200">
                                      <div className="flex items-center gap-3 min-w-0">
                                          <div className="avatar placeholder"><div className="bg-neutral text-neutral-content rounded-full w-8"><span dangerouslySetInnerHTML={{ __html: escapeHtml(name.slice(0, 2).toUpperCase()) }}></span></div></div>
                                          <div className="min-w-0">
                                              <div className="flex items-center gap-2">
                                                  <div className="font-bold text-sm truncate" dangerouslySetInnerHTML={{ __html: escapeHtml(name) }}></div>
                                                  {(isFollowing(pubkey) || events.some(e => e.kind === 30060 && isFollowing(e.pubkey))) && (
                                                      <div className="badge badge-secondary badge-xs gap-1">
                                                          <ShieldCheck className="w-2 h-2" /> Network Trusted
                                                      </div>
                                                  )}
                                              </div>
                                              <div className="text-[9px] opacity-50 truncate" dangerouslySetInnerHTML={{ __html: escapeHtml(npub) }}></div>
                                          </div>
                                      </div>
                                      <div className="text-[9px] opacity-40 font-mono text-right sm:text-left">
                                          Last Update: {lastUpdateStr}
                                      </div>
                                  </div>
                                  <div className="space-y-4">
                                      {activeKeys.map(baseId => {
                                          const t = threads[baseId];
                                          const isPrivate = t.service && (parsePrivateFlag(t.service.tags) ?? !t.service.tags.find((tag: any) => tag[0] === 'u'));
                                          const isAuthorized = t.service && authorizedEvents[t.service.id];
                                          const sExpired = t.service && isExpired(t.service);
                                          const isRevoked = t.revocations.length > 0;
                                          const tracked = isTracked(pubkey, baseId);
                                          
                                          const followedAttestations = t.attestations.filter(a => isFollowing(a.pubkey));
                                          // Check if current user has attested to this specific service
                                          const isAlreadyAttested = attestedIds.includes(t.service?.id) || t.attestations.some(a => a.pubkey === myPubkey);

                                          return (
                                              <div key={baseId} className="space-y-2">
                                                  <div className="flex items-center justify-between px-1">
                                                      <div className="flex flex-col min-w-0">
                                                          <div className="flex items-center gap-1">
                                                              <span className={clsx("font-black text-[10px] uppercase truncate", isRevoked ? "text-error line-through" : "opacity-70")}>Service: <span dangerouslySetInnerHTML={{ __html: escapeHtml(baseId) }}></span></span>
                                                              {isRevoked && <div className="badge badge-error badge-xs scale-75 font-bold">REVOKED</div>}
                                                              {sExpired && <div className="badge badge-error badge-xs scale-75">EXPIRED</div>}
                                                              {t.service && (() => {
                                                                  try {
                                                                      const content = JSON.parse(t.service.content);
                                                                      if (content.v > 1) return <div className="badge badge-warning badge-xs scale-75" title="Newer protocol version detected">v{content.v} !</div>;
                                                                  } catch(e) {}
                                                                  return null;
                                                              })()}
                                                          </div>
                                                          {followedAttestations.length > 0 && (
                                                              <span className="text-[8px] text-secondary font-bold">
                                                                  ✓ Trusted by {followedAttestations.length} in your network
                                                              </span>
                                                          )}
                                                      </div>
                                                      <div className="flex items-center gap-3">
                                                          {t.service && (
                                                              <button 
                                                                className={clsx(
                                                                    "btn btn-xs gap-1 p-0 h-auto min-h-0",
                                                                    isAlreadyAttested ? "text-success" : "btn-ghost text-secondary"
                                                                )}
                                                                title={isAlreadyAttested ? "You have attested to this" : "Attest to this service"}
                                                                onClick={() => !isAlreadyAttested && handleAttest(t.service)}
                                                                disabled={isAlreadyAttested}
                                                              >
                                                                  <BadgeCheck className="w-3 h-3" />
                                                                  <span className="text-[9px]">{isAlreadyAttested ? "Attested" : "Attest"}</span>
                                                              </button>
                                                          )}
                                                          <label className="flex items-center gap-1 cursor-pointer">
                                                              <span className="text-[9px] opacity-50">Track</span>
                                                              <input type="checkbox" className="checkbox checkbox-xs" checked={tracked} onChange={(e) => e.target.checked ? trackService(pubkey, baseId) : untrackService(pubkey, baseId)} />
                                                          </label>
                                                      </div>
                                                  </div>
                                                  <div className={`border ${sExpired ? 'border-error bg-error/5' : 'border-base-200'} rounded-box overflow-hidden`}>
                                                      <div className="p-2 bg-base-200/30">
                                                          {t.service ? (
                                                              <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box shadow-xs">
                                                                  <input type="checkbox" /> 
                                                                  <div className="collapse-title text-[10px] font-bold py-1 min-h-0 flex items-center gap-2">
                                                                      NCC-02 Record 
                                                                      {isPrivate && <Lock className={clsx("w-3 h-3", isAuthorized ? "text-success" : "text-warning")} />}
                                                                      {isPrivate && isAuthorized && <span className="text-[8px] text-success uppercase">Authorized</span>}
                                                                  </div>
                                                                  <div className="collapse-content"><pre className="text-[9px] bg-black text-green-500 p-2 rounded mt-1 overflow-x-auto">{JSON.stringify(t.service, null, 2)}</pre></div>
                                                              </div>
                                                          ) : <div className="text-[9px] opacity-50 px-2 italic">No NCC-02</div>}
                                                      </div>
                                                      <div className="p-2 space-y-2">
                                                          {t.service?.tags.filter((tag: any) => tag[0] === 'u').map((tag: any, i: number) => (
                                                              <div key={i} className="flex items-center justify-between gap-2 p-2 bg-base-200/50 rounded-lg">
                                                                  <div className="flex flex-col min-w-0 flex-1">
                                                                      <span className="text-[9px] font-mono truncate" dangerouslySetInnerHTML={{ __html: escapeHtml(tag[1]) }}></span>
                                                                      {probing[tag[1]] && (
                                                                          <span className={clsx("text-[8px] font-bold", probing[tag[1]] === 'error' ? "text-error" : probing[tag[1]] === 'loading' ? "animate-pulse" : "text-success")}>
                                                                              {probing[tag[1]] === 'loading' ? 'Probing...' : probing[tag[1]] === 'error' ? 'Offline' : `${probing[tag[1]]}ms`}
                                                                          </span>
                                                                      )}
                                                                  </div>
                                                                  <div className="flex items-center gap-1">
                                                                      <button className="btn btn-xs btn-ghost" onClick={() => probeEndpoint(tag[1])}>Probe</button>
                                                                      <button className="btn btn-xs btn-secondary flex-shrink-0" onClick={() => handleConnect(tag[1], { pubkey, id: baseId })}>Connect</button>
                                                                  </div>
                                                              </div>
                                                          ))}
                                                          {t.locators.map(loc => {
                                                              const targeted = authorizedEvents[loc.id];
                                                              const isEnc = !loc.content.trim().startsWith('{');
                                                              const dec = decryptedPayloads[loc.id];
                                                              const lExp = isExpired(loc);
                                                              if (!showExpired && lExp) return null;
                                                              let eps: any[] = []; try { const d = dec || (!isEnc ? JSON.parse(loc.content) : null); if (d?.endpoints) eps = d.endpoints; } catch(e){}
                                                              return (
                                                                  <div key={loc.id} className={`border-l-2 ${targeted ? 'border-success' : lExp ? 'border-error' : 'border-primary'} pl-2 ml-1`}>
                                                                      <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box">
                                                                          <input type="checkbox" /> 
                                                                          <div className="collapse-title text-[10px] py-1 min-h-0 flex flex-wrap items-center gap-1">
                                                                              <span>📍 NCC-05</span>
                                                                              {targeted && <div className="badge badge-success badge-xs scale-75">FOR YOU</div>}
                                                                              {lExp && <div className="badge badge-error badge-xs scale-75">EXPIRED</div>}
                                                                              {isEnc && !dec && <div className="badge badge-warning badge-xs scale-75">LOCKED</div>}
                                                                          </div>
                                                                          <div className="collapse-content">
                                                                              {isEnc && !dec ? (
                                                                                  <button className="btn btn-xs btn-neutral w-full mt-1" onClick={(e) => {e.stopPropagation(); handleDecryptClick(loc);}}>Decrypt</button>
                                                                              ) : (
                                                                                  <div className="space-y-2 mt-1">
                                                                                      {eps.map((ep, j) => {
                                                                                          let u = ep.url || ep.uri; if (u && !u.includes('://')) u = u.includes('.onion') ? `ws://${u}` : `wss://${u}`;
                                                                                          const isR = u && (u.startsWith('ws') || u.startsWith('wss'));
                                                                                          return (
                                                                                              <div key={j} className="flex flex-col gap-1">
                                                                                                  <button className="btn btn-xs btn-primary w-full flex flex-col items-start h-auto py-2 gap-1" onClick={() => isR ? handleConnect(u, { pubkey, id: baseId }) : window.open(u, '_blank')}>
                                                                                                      <div className="flex items-center gap-1 font-bold"> {ep.family==='onion'&&'🧅'} Connect <span dangerouslySetInnerHTML={{ __html: escapeHtml(ep.type||(isR?'Relay':'Web')) }}></span></div>
                                                                                                      <div className="text-[8px] opacity-70 truncate w-full" dangerouslySetInnerHTML={{ __html: escapeHtml(u) }}></div>
                                                                                                  </button>
                                                                                                  <div className="flex items-center justify-between px-1">
                                                                                                      <button className="text-[8px] link opacity-50" onClick={() => probeEndpoint(u)}>Probe Health</button>
                                                                                                      {probing[u] && (
                                                                                                          <span className={clsx("text-[8px] font-bold", probing[u] === 'error' ? "text-error" : probing[u] === 'loading' ? "animate-pulse" : "text-success")}>
                                                                                                              {probing[u] === 'loading' ? 'Probing...' : probing[u] === 'error' ? 'Offline' : `${probing[u]}ms`}
                                                                                                          </span>
                                                                                                      )}
                                                                                                  </div>
                                                                                              </div>
                                                                                          );
                                                                                      })}
                                                                                      <pre className="text-[8px] bg-black text-green-500 p-2 rounded overflow-x-auto">{JSON.stringify(dec || loc, null, 2)}</pre>
                                                                                  </div>
                                                                              )}
                                                                          </div>
                                                                      </div>
                                                                  </div>
                                                              );
                                                          })}
                                                      </div>
                                                  </div>
                                              </div>
                                          );
                                      })}
                                  </div>
                              </div>
                          </div>
                      );
                  });
              })()}
           </div>
        )}

        {resolvedEndpoint && step === 'complete' && (
          <div className="mt-6 p-4 bg-base-200 rounded-box border border-success flex flex-col gap-3">
             <div className="flex items-center gap-2">
                <ShieldCheck className="text-success w-6 h-6 flex-shrink-0" />
                <div className="min-w-0"><h4 className="font-bold text-xs">Target Resolved</h4><p className="text-[10px] opacity-70 truncate font-mono" dangerouslySetInnerHTML={{ __html: escapeHtml(resolvedEndpoint.url || resolvedEndpoint.uri) }}></p></div>
             </div>
             <button className="btn btn-success btn-sm w-full" onClick={() => handleConnect()}>Connect to Relay</button>
          </div>
        )}
      </div>
    </div>
  );
}
