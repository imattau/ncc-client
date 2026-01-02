import { useNCC } from '../context/NCCContext';
import { useAuth } from '../context/AuthContext';
import { useTracking } from '../context/TrackingContext';
import { useDiscovery } from '../context/DiscoveryContext';
import { nip19, nip44 } from 'nostr-tools';
import { Network, ShieldCheck, AlertTriangle, Lock, BadgeCheck } from 'lucide-react';
import { DEFAULT_RELAYS } from '../lib/relays';

interface DiscoveryProps {
  onConnect: (url: string) => void;
}

export function Discovery({ onConnect }: DiscoveryProps) {
  const { ncc05Resolver, ncc02Resolver, pool } = useNCC();
  const { pubkey: myPubkey, privkey: myPrivkey } = useAuth();
  const { trackService, isTracked, untrackService } = useTracking();
  
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
    showExpired, setShowExpired
  } = useDiscovery();

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
          const profileEvents = await pool.querySync(DEFAULT_RELAYS, { kinds: [0], authors: authors });
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
  
  const isTargetedToMe = (publisherPubkey: string) => {
      if (!myPubkey) return false;
      const profile = profiles[publisherPubkey];
      if (!profile || !profile._tags) return false;
      return profile._tags.some((t: string[]) => t[0] === 'privaterecipients' && t.includes(myPubkey));
  };

  const handleDecryptClick = async (ev: any) => {
      if (myPrivkey) {
          try {
              const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
              const key = nip44.getConversationKey(hexToBytes(myPrivkey), ev.pubkey);
              const decrypted = nip44.decrypt(ev.content, key);
              setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
          } catch(e) { alert("Decryption failed."); }
      } else if (window.nostr && window.nostr.nip44) {
          try {
              const decrypted = await window.nostr.nip44.decrypt(ev.pubkey, ev.content);
              setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
          } catch(e) { alert("Extension decryption failed."); }
      } else { alert("NIP-44 capability not found."); }
  };

  const handleDiscover = async () => {
    setStep('verifying'); clearLogs(); setError(null); setResolvedEndpoint(null); setRawEvents([]); setProfiles({}); setDecryptedPayloads({});
    
    // Timeout helper
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
          const filter: any = { kinds: [30058, 30059], limit: 50 };
          if (serviceId) filter['#d'] = [serviceId];
          const events = await withTimeout(
              pool.querySync(DEFAULT_RELAYS, filter), 
              10000, 
              "Global search timed out after 10s"
          );
          setRawEvents(events); fetchProfiles(events);
          addLog(`✅ Found ${events.length} records globally.`); setStep('complete');
          return;
      }
      
      addLog(`🔍 NCC-02: Querying Kind 30059 events...`);
      let allEvents: any[] = [];
      if (serviceId) {
        await withTimeout(
            ncc02Resolver.resolve(hex, serviceId, { requireAttestation: false, minLevel: 'self' }),
            10000,
            "NCC-02 Resolution timed out"
        );
        addLog(`✅ NCC-02: Service '${serviceId}' verified.`);
      } else {
        const events = await withTimeout(
            pool.querySync(ncc02Resolver.relays, { kinds: [30059], authors: [hex] }),
            10000,
            "NCC-02 Query timed out"
        );
        allEvents = [...allEvents, ...events];
        addLog(`✅ NCC-02: Found ${events.length} service records.`);
      }
      
      setStep('resolving');
      addLog(`🌍 NCC-05: Querying Kind 30058 events...`);
      if (serviceId) {
        const locationRecord = await withTimeout(
            ncc05Resolver.resolve(hex, undefined, serviceId, { gossip: false }),
            10000,
            "NCC-05 Resolution timed out"
        );
        if (locationRecord && locationRecord.endpoints?.length > 0) {
           setResolvedEndpoint(locationRecord.endpoints.sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0))[0]);
           addLog(`📍 NCC-05: Found location for '${serviceId}'.`);
        }
      } else {
         const events = await withTimeout(
             pool.querySync((ncc05Resolver as any).bootstrapRelays, { kinds: [30058], authors: [hex] }),
             10000,
             "NCC-05 Query timed out"
         );
         allEvents = [...allEvents, ...events];
         addLog(`✅ NCC-05: Found ${events.length} locator records.`);
      }
      setRawEvents(allEvents); fetchProfiles(allEvents); setStep('complete');
    } catch (e: any) { 
        setError(e.message || 'Discovery failed'); 
        addLog(`❌ Error: ${e.message}`);
        setStep('idle'); 
    }
  };

  const handleConnect = (targetUrl?: string, serviceInfo?: { pubkey: string, id: string }) => {
    if (serviceInfo && !isTracked(serviceInfo.pubkey, serviceInfo.id)) {
        trackService(serviceInfo.pubkey, serviceInfo.id);
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
            onConnect(bridgeUrl);
            return;
        } else {
            const direct = window.confirm("Attempt direct connection?");
            if (direct) { onConnect(url); return; }
            navigator.clipboard.writeText(url); return;
        }
    }
    onConnect(url);
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
          let signedEvent;
          if (myPrivkey) {
              const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
              const { finalizeEvent } = await import('nostr-tools/pure');
              signedEvent = finalizeEvent(eventTemplate, hexToBytes(myPrivkey));
          } else if (window.nostr) {
              signedEvent = await window.nostr.signEvent(eventTemplate);
          } else {
              return alert("No signing method available. Use NSEC or Extension.");
          }

          if (signedEvent) {
              addLog(`✍️ Publishing Attestation for ${dTag}...`);
              await pool.publish(DEFAULT_RELAYS, signedEvent);
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
          <button className="btn btn-primary w-full" onClick={() => handleDiscover()} disabled={step === 'verifying' || step === 'resolving'}>
            {step !== 'idle' && step !== 'complete' && <span className="loading loading-spinner"></span>}
            Run Discovery
          </button>
        </div>

        {error && <div className="alert alert-error mt-4 text-xs"><AlertTriangle className="w-4 h-4 flex-shrink-0" /><span>{error}</span></div>}

        <div className="mt-4 bg-base-300 p-3 rounded-box font-mono text-[10px] max-h-32 overflow-y-auto">
           {logs.length === 0 && <span className="opacity-50">Idle...</span>}
           {logs.map((log, i) => <div key={i} className="mb-1">{log}</div>)}
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

                      const threads: Record<string, { service?: any, locators: any[] }> = {};
                      events.forEach(ev => {
                          const baseId = (ev.tags.find((t: any) => t[0] === 'd')?.[1] || 'unknown').replace(/-locator$/, '').replace(/-loc$/, '');
                          if (!threads[baseId]) threads[baseId] = { locators: [] };
                          if (ev.kind === 30059) threads[baseId].service = ev;
                          else threads[baseId].locators.push(ev);
                      });

                      const activeKeys = Object.keys(threads).sort().filter(k => showExpired || (threads[k].service && !isExpired(threads[k].service)) || threads[k].locators.some(l => !isExpired(l)));
                      if (activeKeys.length === 0) return null;

                      return (
                          <div key={pubkey} className="card bg-base-100 border border-base-300 w-full overflow-hidden shadow-sm">
                              <div className="card-body p-3">
                                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3 pb-2 border-b border-base-200">
                                      <div className="flex items-center gap-3 min-w-0">
                                          <div className="avatar placeholder"><div className="bg-neutral text-neutral-content rounded-full w-8"><span>{name.slice(0, 2).toUpperCase()}</span></div></div>
                                          <div className="min-w-0">
                                              <div className="font-bold text-sm truncate">{name}</div>
                                              <div className="text-[9px] opacity-50 truncate">{npub}</div>
                                          </div>
                                      </div>
                                      <div className="text-[9px] opacity-40 font-mono text-right sm:text-left">
                                          Last Update: {lastUpdateStr}
                                      </div>
                                  </div>
                                  <div className="space-y-4">
                                      {activeKeys.map(baseId => {
                                          const t = threads[baseId];
                                          const isPrivate = t.service && !t.service.tags.find((tag: any) => tag[0] === 'u');
                                          const sExpired = t.service && isExpired(t.service);
                                          const tracked = isTracked(pubkey, baseId);
                                          return (
                                              <div key={baseId} className="space-y-2">
                                                  <div className="flex items-center justify-between px-1">
                                                      <div className="flex items-center gap-1 min-w-0">
                                                          <span className="font-black text-[10px] uppercase opacity-70 truncate">Service: {baseId}</span>
                                                          {sExpired && <div className="badge badge-error badge-xs scale-75">EXPIRED</div>}
                                                      </div>
                                                      <div className="flex items-center gap-3">
                                                          {t.service && (
                                                              <button 
                                                                className="btn btn-ghost btn-xs text-secondary gap-1 p-0 h-auto min-h-0" 
                                                                title="Attest to this service"
                                                                onClick={() => handleAttest(t.service)}
                                                              >
                                                                  <BadgeCheck className="w-3 h-3" />
                                                                  <span className="text-[9px]">Attest</span>
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
                                                                  <div className="collapse-title text-[10px] font-bold py-1 min-h-0 flex items-center gap-2">NCC-02 Record {isPrivate && <Lock className="w-3 h-3 text-warning" />}</div>
                                                                  <div className="collapse-content"><pre className="text-[9px] bg-black text-green-500 p-2 rounded mt-1 overflow-x-auto">{JSON.stringify(t.service, null, 2)}</pre></div>
                                                              </div>
                                                          ) : <div className="text-[9px] opacity-50 px-2 italic">No NCC-02</div>}
                                                      </div>
                                                      <div className="p-2 space-y-2">
                                                          {t.service?.tags.filter((tag: any) => tag[0] === 'u').map((tag: any, i: number) => (
                                                              <div key={i} className="flex items-center justify-between gap-2 p-2 bg-base-200/50 rounded-lg">
                                                                  <span className="text-[9px] font-mono truncate flex-1">{tag[1]}</span>
                                                                  <button className="btn btn-xs btn-secondary flex-shrink-0" onClick={() => handleConnect(tag[1], { pubkey, id: baseId })}>Connect</button>
                                                              </div>
                                                          ))}
                                                          {t.locators.map(loc => {
                                                              const targeted = isTargetedToMe(loc.pubkey);
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
                                                                                              <button key={j} className="btn btn-xs btn-primary w-full flex flex-col items-start h-auto py-2 gap-1" onClick={() => isR ? handleConnect(u, { pubkey, id: baseId }) : window.open(u, '_blank')}>
                                                                                                  <div className="flex items-center gap-1 font-bold"> {ep.family==='onion'&&'🧅'} Connect {ep.type||(isR?'Relay':'Web')}</div>
                                                                                                  <div className="text-[8px] opacity-70 truncate w-full">{u}</div>
                                                                                              </button>
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
                <div className="min-w-0"><h4 className="font-bold text-xs">Target Resolved</h4><p className="text-[10px] opacity-70 truncate font-mono">{resolvedEndpoint.url || resolvedEndpoint.uri}</p></div>
             </div>
             <button className="btn btn-success btn-sm w-full" onClick={() => handleConnect()}>Connect to Relay</button>
          </div>
        )}
      </div>
    </div>
  );
}
