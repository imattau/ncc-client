import { useState } from 'react';
import { useNCC } from '../context/NCCContext';
import { useAuth } from '../context/AuthContext';
import { nip19, nip44 } from 'nostr-tools';
import { Network, ArrowRight, ShieldCheck, AlertTriangle, Lock, User, Unlock } from 'lucide-react';
import { DEFAULT_RELAYS } from '../lib/relays';

interface DiscoveryProps {
  onConnect: (url: string) => void;
}

export function Discovery({ onConnect }: DiscoveryProps) {
  const { ncc05Resolver, ncc02Resolver, pool } = useNCC();
  const { pubkey: myPubkey, privkey: myPrivkey } = useAuth();
  
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [serviceId, setServiceId] = useState(''); // Empty for "all"
  
  // State for the multi-step process
  const [step, setStep] = useState<'idle' | 'verifying' | 'resolving' | 'complete'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Result
  const [resolvedEndpoint, setResolvedEndpoint] = useState<any>(null);
  const [rawEvents, setRawEvents] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [decryptedPayloads, setDecryptedPayloads] = useState<Record<string, any>>({});
  const [showExpired, setShowExpired] = useState(false);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  // Helper to check expiration
  const isExpired = (ev: any) => {
      const now = Math.floor(Date.now() / 1000);
      
      // NCC-02 (Kind 30059): Check 'exp' tag
      if (ev.kind === 30059) {
          const expTag = ev.tags.find((t: any) => t[0] === 'exp');
          if (expTag && parseInt(expTag[1]) < now) return true;
      }
      
      // NCC-05 (Kind 30058): Check 'ttl' in content
      if (ev.kind === 30058) {
          try {
              if (ev.content.trim().startsWith('{')) {
                  const payload = JSON.parse(ev.content);
                  if (payload.updated_at && payload.ttl) {
                      const expiresAt = payload.updated_at + payload.ttl;
                      if (expiresAt < now) return true;
                  }
              } else {
                  const decrypted = decryptedPayloads[ev.id];
                  if (decrypted && decrypted.updated_at && decrypted.ttl) {
                       const expiresAt = decrypted.updated_at + decrypted.ttl;
                       if (expiresAt < now) return true;
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
          const profileEvents = await pool.querySync(DEFAULT_RELAYS, {
              kinds: [0],
              authors: authors
          });
          const profileMap: Record<string, any> = {};
          profileEvents.forEach(ev => {
              try {
                  const content = JSON.parse(ev.content);
                  profileMap[ev.pubkey] = { ...content, _tags: ev.tags };
              } catch (e) { /* ignore */ }
          });
          setProfiles(prev => ({...prev, ...profileMap}));
      } catch (e) {
          console.error("Failed to fetch profiles", e);
      }
  };

  const getDisplayName = (pubkey: string) => {
      const profile = profiles[pubkey];
      if (profile && (profile.display_name || profile.name)) {
          return profile.display_name || profile.name;
      }
      try {
          const npub = nip19.npubEncode(pubkey);
          return `${npub.slice(0, 10)}...${npub.slice(-4)}`;
      } catch (e) {
          return pubkey.slice(0, 8);
      }
  };
  
  const isTargetedToMe = (publisherPubkey: string) => {
      if (!myPubkey) return false;
      const profile = profiles[publisherPubkey];
      if (!profile || !profile._tags) return false;
      return profile._tags.some((t: string[]) => 
          t[0] === 'privaterecipients' && t.includes(myPubkey)
      );
  };

  const handleDecryptClick = async (ev: any) => {
      if (myPrivkey) {
          try {
              const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
              const privKeyBytes = hexToBytes(myPrivkey);
              const key = nip44.getConversationKey(privKeyBytes, ev.pubkey);
              const decrypted = nip44.decrypt(ev.content, key);
              setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
          } catch(e) {
              alert("Decryption failed. Key incorrect or invalid format.");
          }
      } else if (window.nostr && window.nostr.nip44) {
          try {
              const decrypted = await window.nostr.nip44.decrypt(ev.pubkey, ev.content);
              setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
          } catch(e) {
              alert("Extension decryption failed.");
          }
      } else {
          alert("Please login with a private key (nsec) or NIP-07 extension supporting NIP-44.");
      }
  };

  const handleDiscover = async () => {
    setStep('verifying');
    setLogs([]);
    setError(null);
    setResolvedEndpoint(null);
    setRawEvents([]);
    setProfiles({});
    setDecryptedPayloads({});

    try {
      let hex = pubkeyInput;
      if (pubkeyInput.startsWith('npub')) {
        const { data } = nip19.decode(pubkeyInput);
        hex = data as string;
      }

      if (!hex) {
          addLog(`🌐 Global Search: Querying bootstrap relays for Kind 30059/30058...`);
          const filter: any = { kinds: [30058, 30059], limit: 50 };
          if (serviceId) filter['#d'] = [serviceId];
          const events = await pool.querySync(DEFAULT_RELAYS, filter);
          setRawEvents(events);
          fetchProfiles(events);
          addLog(`✅ Found ${events.length} records globally.`);
          setStep('complete');
          return;
      }

      addLog(`🔍 NCC-02: Querying Kind 30059 events...`);
      let allEvents: any[] = [];
      if (serviceId) {
        await ncc02Resolver.resolve(hex, serviceId, { requireAttestation: false, minLevel: 'self' });
        addLog(`✅ NCC-02: Service '${serviceId}' verified.`);
      } else {
        const events = await pool.querySync(ncc02Resolver.relays, { kinds: [30059], authors: [hex] });
        allEvents = [...allEvents, ...events];
        addLog(`✅ NCC-02: Found ${events.length} service records.`);
      }
      
      setStep('resolving');
      addLog(`🌍 NCC-05: Querying Kind 30058 events...`);
      if (serviceId) {
        const locationRecord = await ncc05Resolver.resolve(hex, undefined, serviceId, { gossip: false });
        if (locationRecord && locationRecord.endpoints?.length > 0) {
           setResolvedEndpoint(locationRecord.endpoints.sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0))[0]);
           addLog(`📍 NCC-05: Found location for '${serviceId}'.`);
        }
      } else {
         const events = await pool.querySync((ncc05Resolver as any).bootstrapRelays, { kinds: [30058], authors: [hex] });
         allEvents = [...allEvents, ...events];
         addLog(`✅ NCC-05: Found ${events.length} locator records.`);
      }
      
      setRawEvents(allEvents);
      fetchProfiles(allEvents);
      setStep('complete');
    } catch (e: any) {
      setError(e.message || 'Discovery failed');
      setStep('idle');
    }
  };

  const handleConnect = () => {
    if (!resolvedEndpoint) return;
    let url = resolvedEndpoint.url || resolvedEndpoint.uri;
    if (!url.includes('://')) {
       url = url.includes('.onion') ? `ws://${url}` : `wss://${url}`;
    }
    if (url.startsWith('http')) url = url.replace('http', 'ws');
    onConnect(url);
  };

  return (
    <div className="card bg-base-100 shadow-lg border border-base-200">
      <div className="card-body">
        <h3 className="card-title text-xl mb-4 flex items-center">
          <Network className="w-6 h-6 mr-2 text-primary" />
          Discovery (Dev Mode)
        </h3>
        
        <div className="flex flex-col gap-4">
          <div className="form-control">
            <label className="label">Target Pubkey</label>
            <input className="input input-bordered" placeholder="npub1..." value={pubkeyInput} onChange={e => setPubkeyInput(e.target.value)} />
          </div>
          <div className="form-control">
            <label className="label text-xs">Service ID (Optional)</label>
            <input className="input input-bordered" placeholder="e.g. relay" value={serviceId} onChange={e => setServiceId(e.target.value)} />
          </div>
          <div className="form-control">
             <label className="cursor-pointer label justify-start gap-4">
               <span className="label-text">Show Expired</span> 
               <input type="checkbox" className="toggle toggle-sm toggle-warning" checked={showExpired} onChange={e => setShowExpired(e.target.checked)} />
             </label>
          </div>
          <button className="btn btn-primary" onClick={handleDiscover} disabled={step === 'verifying' || step === 'resolving'}>
            {step !== 'idle' && step !== 'complete' && <span className="loading loading-spinner"></span>}
            Run Discovery
          </button>
        </div>

        {error && <div className="alert alert-error mt-4"><AlertTriangle className="w-5 h-5" /><span>{error}</span></div>}

        <div className="mt-4 bg-base-300 p-4 rounded-box font-mono text-xs max-h-40 overflow-y-auto">
           {logs.length === 0 && <span className="opacity-50">Waiting...</span>}
           {logs.map((log, i) => <div key={i} className="mb-1">{log}</div>)}
        </div>

        {rawEvents.length > 0 && (
           <div className="mt-4 space-y-6">
              <h4 className="text-sm font-bold mb-2">Found Services ({rawEvents.length} events)</h4>
              {(() => {
                  const byPublisher: Record<string, any[]> = {};
                  rawEvents.forEach(ev => {
                      if (!byPublisher[ev.pubkey]) byPublisher[ev.pubkey] = [];
                      byPublisher[ev.pubkey].push(ev);
                  });

                  return Object.entries(byPublisher).map(([pubkey, events]) => {
                      const displayName = getDisplayName(pubkey);
                      const npub = nip19.npubEncode(pubkey);
                      const threads: Record<string, { service?: any, locators: any[] }> = {};
                      const getBaseId = (ev: any) => (ev.tags.find((t: any) => t[0] === 'd')?.[1] || 'unknown').replace(/-locator$/, '').replace(/-loc$/, '');

                      events.forEach(ev => {
                          const baseId = getBaseId(ev);
                          if (!threads[baseId]) threads[baseId] = { locators: [] };
                          if (ev.kind === 30059) threads[baseId].service = ev;
                          else if (ev.kind === 30058) threads[baseId].locators.push(ev);
                      });

                      const activeThreadKeys = Object.keys(threads).sort().filter(k => {
                          if (showExpired) return true;
                          const t = threads[k];
                          return (t.service && !isExpired(t.service)) || t.locators.some(l => !isExpired(l));
                      });
                      
                      if (activeThreadKeys.length === 0) return null;

                      return (
                          <div key={pubkey} className="card bg-base-100 shadow-md border border-base-300">
                              <div className="card-body p-4">
                                  <div className="flex items-center gap-3 mb-4 pb-2 border-b border-base-200">
                                      <div className="avatar placeholder"><div className="bg-neutral text-neutral-content rounded-full w-10"><span>{displayName.slice(0, 2).toUpperCase()}</span></div></div>
                                      <div><div className="font-bold">{displayName}</div><div className="text-[10px] opacity-50">{npub.slice(0, 20)}...</div></div>
                                  </div>
                                  <div className="space-y-4">
                                      {activeThreadKeys.map(baseId => {
                                          const t = threads[baseId];
                                          const isPrivate = t.service && !t.service.tags.find((tag: any) => tag[0] === 'u');
                                          const sExpired = t.service && isExpired(t.service);
                                          return (
                                              <div key={baseId} className="space-y-2">
                                                  <div className="flex items-center gap-2 px-1"><span className="font-bold text-xs uppercase opacity-70">Service: {baseId}</span>{sExpired && <div className="badge badge-error badge-xs">EXPIRED</div>}</div>
                                                  <div className={`border ${sExpired ? 'border-error bg-error/5' : 'border-base-200'} rounded-box overflow-hidden ml-2`}>
                                                      <div className="p-2 bg-base-200/50">
                                                          {t.service ? (
                                                              <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box">
                                                                  <input type="checkbox" /> 
                                                                  <div className="collapse-title text-xs font-bold py-2 min-h-0 flex items-center gap-2">NCC-02 Record {isPrivate && <Lock className="w-3 h-3 text-warning" />}{sExpired && <AlertTriangle className="w-3 h-3 text-error" />}</div>
                                                                  <div className="collapse-content"><pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded mt-2">{JSON.stringify(t.service, null, 2)}</pre></div>
                                                              </div>
                                                          ) : <div className="text-[10px] opacity-50 p-1">No NCC-02</div>}
                                                      </div>
                                                      {/* 3. NCC-05 Locators (The Endpoints) */}
                                                      <div className="p-2 space-y-2 bg-base-100">
                                                          <div className="text-[9px] font-bold opacity-30 ml-4 uppercase">Locators</div>
                                                          {/* Public Endpoints from NCC-02 (if any) */}
                                                          {t.service && t.service.tags.filter((tag: any) => tag[0] === 'u').map((tag: any, idx: number) => (
                                                              <div key={`u-${idx}`} className="ml-4 pl-2 border-l-2 border-secondary/50 flex items-center justify-between p-2 bg-base-200/30 rounded text-xs">
                                                                  <span className="font-mono">{tag[1]}</span>
                                                                  <button className="btn btn-xs btn-secondary" onClick={() => onConnect(tag[1])}>
                                                                      Connect (Public)
                                                                  </button>
                                                              </div>
                                                          ))}

                                                          {t.locators.length > 0 ? (
                                                              t.locators.map((loc: any) => {
                                                                  const targeted = isTargetedToMe(loc.pubkey);
                                                                  const isEncrypted = !loc.content.trim().startsWith('{');
                                                                  const decrypted = decryptedPayloads[loc.id];
                                                                  const locExpired = isExpired(loc);
                                                                  
                                                                  if (!showExpired && locExpired) return null;
                                                                  
                                                                  // Extract endpoints from decrypted payload or public content
                                                                  let endpoints: any[] = [];
                                                                  try {
                                                                      const data = decrypted || (!isEncrypted ? JSON.parse(loc.content) : null);
                                                                      if (data && data.endpoints) {
                                                                          endpoints = data.endpoints;
                                                                      }
                                                                  } catch (e) { /* ignore */ }

                                                                  return (
                                                                      <div key={loc.id} className={`ml-4 border-l-2 ${targeted ? 'border-success' : locExpired ? 'border-error' : 'border-primary'} pl-2`}>
                                                                          <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box shadow-sm">
                                                                              <input type="checkbox" /> 
                                                                              <div className="collapse-title text-xs font-mono py-2 min-h-0 flex items-center gap-2 flex-wrap">
                                                                                  <span>📍 NCC-05 Endpoint</span>
                                                                                  <span className="opacity-50 text-[10px]">
                                                                                      {new Date(loc.created_at * 1000).toLocaleTimeString()}
                                                                                  </span>
                                                                                  {targeted && (
                                                                                      <div className="badge badge-success badge-xs gap-1">
                                                                                          <User className="w-2 h-2" />
                                                                                          For You
                                                                                      </div>
                                                                                  )}
                                                                                  {locExpired && (
                                                                                       <div className="badge badge-error badge-xs gap-1">
                                                                                          <AlertTriangle className="w-2 h-2" />
                                                                                          Expired
                                                                                      </div>
                                                                                  )}
                                                                                  {isEncrypted && !decrypted && (
                                                                                      <div className="badge badge-warning badge-xs gap-1">
                                                                                          <Lock className="w-2 h-2" />
                                                                                          Encrypted
                                                                                      </div>
                                                                                  )}
                                                                                  {decrypted && (
                                                                                      <div className="badge badge-info badge-xs gap-1">
                                                                                          <Unlock className="w-2 h-2" />
                                                                                          Decrypted
                                                                                      </div>
                                                                                  )}
                                                                              </div>
                                                                              <div className="collapse-content"> 
                                                                                  {isEncrypted && !decrypted ? (
                                                                                      <div className="flex flex-col gap-2 p-2">
                                                                                          <button 
                                                                                            className="btn btn-xs btn-neutral"
                                                                                            onClick={(e) => { e.stopPropagation(); handleDecryptClick(loc); }}
                                                                                          >
                                                                                             Attempt Decrypt
                                                                                          </button>
                                                                                      </div>
                                                                                  ) : (
                                                                                      <div className="space-y-2 mt-2">
                                                                                          {/* Actionable Endpoints */}
                                                                                          {endpoints.length > 0 && (
                                                                                              <div className="flex flex-wrap gap-2 mb-2">
                                                                                                  {endpoints.map((ep: any, epIdx: number) => {
                                                                                                      let url = ep.url || ep.uri;
                                                                                                      // Protocol Normalization
                                                                                                      if (url && !url.includes('://')) {
                                                                                                          url = url.includes('.onion') ? `ws://${url}` : `wss://${url}`;
                                                                                                      }
                                                                                                      // Check if it's a relay-compatible protocol
                                                                                                      const isRelay = url && (url.startsWith('ws') || url.startsWith('wss'));
                                                                                                      
                                                                                                      return (
                                                                                                          <button 
                                                                                                              key={epIdx}
                                                                                                              className={`btn btn-xs ${isRelay ? 'btn-primary' : 'btn-outline'}`}
                                                                                                              onClick={() => isRelay ? onConnect(url) : window.open(url, '_blank')}
                                                                                                              title={`Priority: ${ep.priority}`}
                                                                                                          >
                                                                                                              {ep.family === 'onion' && '🧅 '}
                                                                                                              Connect {ep.type || (isRelay ? 'Relay' : 'Web')}
                                                                                                          </button>
                                                                                                      );
                                                                                                  })}
                                                                                              </div>
                                                                                          )}
                                                                                          <pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded">
                                                                                              {JSON.stringify(decrypted || loc, null, 2)}
                                                                                          </pre>
                                                                                      </div>
                                                                                  )}
                                                                              </div>
                                                                          </div>
                                                                      </div>
                                                                  );
                                                              })
                                                          ) : (
                                                              <div className="text-[10px] opacity-50 ml-6 italic">No active locators.</div>
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
                  });
              })()}
           </div>
        )}

        {resolvedEndpoint && step === 'complete' && (
          <div className="mt-6 p-4 bg-base-200 rounded-box border border-success">
             <div className="flex items-center gap-2 mb-4"><ShieldCheck className="text-success w-6 h-6" /><div><h4 className="font-bold">Discovery Successful</h4><p className="text-sm opacity-70"><span className="font-mono bg-base-100 px-1 rounded">{resolvedEndpoint.url || resolvedEndpoint.uri}</span></p></div></div>
             <button className="btn btn-success w-full" onClick={handleConnect}>Connect to Relay<ArrowRight className="w-4 h-4 ml-2" /></button>
          </div>
        )}
      </div>
    </div>
  );
}