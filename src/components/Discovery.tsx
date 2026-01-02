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

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

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
                  // Store content AND tags for logic
                  profileMap[ev.pubkey] = { ...content, _tags: ev.tags };
              } catch (e) {
                  // ignore
              }
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
      
      // Check for 'privaterecipients' tag in Kind 0
      // Format assumption: ["privaterecipients", "pubkey1", "pubkey2"...] or multiple tags
      return profile._tags.some((t: string[]) => 
          t[0] === 'privaterecipients' && t.includes(myPubkey)
      );
  };

  // NOTE: Simple manual decrypt button handler for PoC
  const handleDecryptClick = async (ev: any) => {
      if (!myPrivkey) {
          alert("Please login with a private key (nsec) to decrypt.");
          return;
      }
      try {
           // hexToBytes is needed for nostr-tools v2, but let's check what version we have.
           // Assuming v2+, keys are Uint8Array.
           // However, if we get typing errors, we might need a helper.
           
           // Simple hex to bytes helper inline if not imported
           const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

           const privKeyBytes = hexToBytes(myPrivkey);
           const key = nip44.getConversationKey(privKeyBytes, ev.pubkey);
           const decrypted = nip44.decrypt(ev.content, key);
           setDecryptedPayloads(prev => ({ ...prev, [ev.id]: JSON.parse(decrypted) }));
      } catch(e) {
          console.error(e);
          alert("Decryption failed. You may not be the target recipient or the key is incorrect.");
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

      // GLOBAL SEARCH (No Pubkey)
      if (!hex) {
          addLog(`🌐 Global Search: Querying bootstrap relays for Kind 30059/30058...`);
          
          const filter: any = {
             kinds: [30058, 30059],
             limit: 50 // Limit to avoid overwhelming PoC
          };
          
          if (serviceId) {
             filter['#d'] = [serviceId];
             addLog(`   Filter by Service ID: '${serviceId}'`);
          }

          const events = await pool.querySync(DEFAULT_RELAYS, filter);
          setRawEvents(events);
          fetchProfiles(events); // Fetch metadata
          addLog(`✅ Found ${events.length} records globally.`);
          setStep('complete');
          return;
      }

      // 1. Inspect/Resolve NCC-02
      addLog(`🔍 NCC-02: Querying Kind 30059 events...`);
      let allEvents: any[] = [];
      
      // If serviceId is provided, we use the library resolver.
      // If not, we'll manually fetch kind 30059 to see what's available.
      if (serviceId) {
        await ncc02Resolver.resolve(hex, serviceId, {
          requireAttestation: false, 
          minLevel: 'self'
        });
        addLog(`✅ NCC-02: Service '${serviceId}' verified.`);
      } else {
        // Fetch all 30059 for this pubkey
        const events = await pool.querySync(ncc02Resolver.relays, {
           kinds: [30059],
           authors: [hex]
        });
        allEvents = [...allEvents, ...events];
        addLog(`✅ NCC-02: Found ${events.length} service records.`);
      }
      
      // 2. Inspect/Resolve NCC-05
      setStep('resolving');
      addLog(`🌍 NCC-05: Querying Kind 30058 events...`);
      
      if (serviceId) {
        const locationRecord = await ncc05Resolver.resolve(hex, undefined, serviceId, { gossip: false });
        if (locationRecord && locationRecord.endpoints?.length > 0) {
           const bestEndpoint = locationRecord.endpoints.sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0))[0];
           setResolvedEndpoint(bestEndpoint);
           addLog(`📍 NCC-05: Found location for '${serviceId}'.`);
        }
      } else {
         // Fetch all 30058 for this pubkey
         const events = await pool.querySync((ncc05Resolver as any).bootstrapRelays, {
            kinds: [30058],
            authors: [hex]
         });
         allEvents = [...allEvents, ...events];
         addLog(`✅ NCC-05: Found ${events.length} locator records.`);
      }
      
      setRawEvents(allEvents);
      fetchProfiles(allEvents); // Fetch metadata

      if (!serviceId) {
         setStep('complete');
      } else if (resolvedEndpoint) {
         setStep('complete');
      } else {
         addLog(`⚠️ No specific endpoint resolved for '${serviceId}'.`);
         setStep('idle');
      }

    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Discovery failed');
      addLog(`❌ Error: ${e.message}`);
      setStep('idle');
    }
  };


  const handleConnect = () => {
    if (!resolvedEndpoint) return;
    
    // Normalize URL
    let url = resolvedEndpoint.url || resolvedEndpoint.uri;
    
    // Basic fix for onions or missing protocols
    if (!url.includes('://')) {
       if (url.includes('.onion')) {
          url = `ws://${url}`; // Tor usually needs ws/wss
       } else {
          url = `wss://${url}`;
       }
    }
    
    // If it's http/s, switch to ws/s for Nostr
    if (url.startsWith('http')) {
        url = url.replace('http', 'ws');
    }

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
            <input 
              className="input input-bordered" 
              placeholder="npub1..." 
              value={pubkeyInput}
              onChange={e => setPubkeyInput(e.target.value)}
            />
          </div>
          
           <div className="form-control">
            <label className="label text-xs">Service ID (Optional - leave empty to list all)</label>
            <input 
              className="input input-bordered" 
              placeholder="e.g. relay, media" 
              value={serviceId} 
              onChange={e => setServiceId(e.target.value)}
            />
          </div>

          <button 
            className="btn btn-primary" 
            onClick={handleDiscover}
            disabled={step === 'verifying' || step === 'resolving'}
          >
            {step !== 'idle' && step !== 'complete' && <span className="loading loading-spinner"></span>}
            Run Discovery
          </button>
        </div>

        {error && (
           <div className="alert alert-error mt-4">
             <AlertTriangle className="w-5 h-5" />
             <span>{error}</span>
           </div>
        )}

        {/* Logs / Progress */}
        <div className="mt-4 bg-base-300 p-4 rounded-box font-mono text-xs max-h-40 overflow-y-auto">
           {logs.length === 0 && <span className="opacity-50">Waiting to start...</span>}
           {logs.map((log, i) => (
             <div key={i} className="mb-1">{log}</div>
           ))}
        </div>

        {/* Threaded Events View */}
        {rawEvents.length > 0 && (
           <div className="mt-4">
              <h4 className="text-sm font-bold mb-2">Found Services ({rawEvents.length} events)</h4>
              
              {(() => {
                  // 1. Grouping Logic
                  const threads: Record<string, { service?: any, locators: any[] }> = {};

                  // Helper to get unique key
                  const getKey = (ev: any) => `${ev.pubkey}:${ev.tags.find((t: any) => t[0] === 'd')?.[1]}`;

                  // First pass: Index Services (30059)
                  rawEvents.filter(e => e.kind === 30059).forEach(ev => {
                      const key = getKey(ev);
                      if (!threads[key]) threads[key] = { locators: [] };
                      threads[key].service = ev;
                  });

                  // Second pass: Attach Locators (30058) or mark orphan
                  rawEvents.filter(e => e.kind === 30058).forEach(ev => {
                      const key = getKey(ev);
                      if (threads[key]) {
                          threads[key].locators.push(ev);
                      } else {
                          // Orphan locator (no service record found)
                          // We create a thread anyway to show it, but it won't have a service definition
                          if (!threads[key]) threads[key] = { locators: [] };
                          threads[key].locators.push(ev);
                      }
                  });

                  return (
                    <div className="space-y-4">
                        {Object.values(threads).map((thread, i) => {
                            const root = thread.service || thread.locators[0]; // Use service or first locator for header info
                            const dTag = root.tags.find((t: any) => t[0] === 'd')?.[1] || 'none';
                            const pubkey = root.pubkey;
                            const displayName = getDisplayName(pubkey);

                            // Private Service Detection: No 'u' (endpoint) tag in 30059
                            const isPrivateService = thread.service && !thread.service.tags.find((t: any) => t[0] === 'u');

                            return (
                                <div key={i} className="border border-base-300 bg-base-100 rounded-box overflow-hidden">
                                    {/* Thread Header */}
                                    <div className="p-3 bg-base-200 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <div className={`badge ${thread.service ? 'badge-secondary' : 'badge-ghost'} badge-sm`}>
                                                {thread.service ? (isPrivateService ? 'Private Service' : 'Service Defined') : 'Locator Only'}
                                            </div>
                                            <span className="font-bold text-sm">{dTag}</span>
                                        </div>
                                        <span className="text-xs opacity-50 font-mono truncate max-w-[120px]">{displayName}</span>
                                    </div>

                                    {/* Thread Body */}
                                    <div className="p-2 space-y-2">
                                        
                                        {/* 1. The Service Record (Parent) */}
                                        {thread.service && (
                                            <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box">
                                                <input type="checkbox" /> 
                                                <div className="collapse-title text-xs font-mono py-2 min-h-0 flex items-center gap-2">
                                                    📄 Policy / Definition (NCC-02)
                                                    {isPrivateService && <Lock className="w-3 h-3 text-warning" />}
                                                </div>
                                                <div className="collapse-content"> 
                                                    <pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded">
                                                        {JSON.stringify(thread.service, null, 2)}
                                                    </pre>
                                                </div>
                                            </div>
                                        )}

                                        {/* 2. The Locators (Children) */}
                                        {thread.locators.map((loc) => {
                                            // Check publisher's Kind 0 for 'privaterecipients'
                                            const targeted = isTargetedToMe(loc.pubkey);
                                            // Check if content looks encrypted (no starting brace)
                                            const isEncrypted = !loc.content.trim().startsWith('{');
                                            const decrypted = decryptedPayloads[loc.id];

                                            return (
                                              <div key={loc.id} className={`ml-4 border-l-2 ${targeted ? 'border-success' : 'border-primary'} pl-2`}>
                                                  <div className="collapse collapse-arrow bg-base-100 border border-base-200 rounded-box">
                                                      <input type="checkbox" /> 
                                                      <div className="collapse-title text-xs font-mono py-2 min-h-0 flex items-center gap-2 flex-wrap">
                                                          <span>📍 Endpoint (NCC-05)</span>
                                                          <span className="opacity-50 text-[10px]">
                                                              {new Date(loc.created_at * 1000).toLocaleTimeString()}
                                                          </span>
                                                          {targeted && (
                                                              <div className="badge badge-success badge-xs gap-1">
                                                                  <User className="w-2 h-2" />
                                                                  For You
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
                                                                  <div className="alert alert-warning text-xs p-2">
                                                                      <Lock className="w-4 h-4" />
                                                                      <span>Content is encrypted.</span>
                                                                  </div>
                                                                  <button 
                                                                    className="btn btn-xs btn-neutral"
                                                                    onClick={(e) => { e.stopPropagation(); handleDecryptClick(loc); }}
                                                                  >
                                                                     Attempt Decrypt
                                                                  </button>
                                                                  <div className="text-[10px] opacity-50 break-all font-mono">
                                                                      {loc.content.slice(0, 50)}...
                                                                  </div>
                                                              </div>
                                                          ) : (
                                                              <pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded">
                                                                  {JSON.stringify(decrypted || loc, null, 2)}
                                                              </pre>
                                                          )}
                                                      </div>
                                                  </div>
                                              </div>
                                            );
                                        })}

                                        {thread.locators.length === 0 && (
                                            <div className="text-xs opacity-50 italic ml-4 p-2">
                                                No location endpoints published yet.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                  );
              })()}
           </div>
        )}

        {/* Success / Connect */}
        {resolvedEndpoint && step === 'complete' && (
          <div className="mt-6 p-4 bg-base-200 rounded-box border border-success">
             <div className="flex items-center gap-2 mb-4">
                <ShieldCheck className="text-success w-6 h-6" />
                <div>
                   <h4 className="font-bold">Discovery Successful</h4>
                   <p className="text-sm opacity-70">
                     Found <strong>{resolvedEndpoint.type}</strong> at: <br/>
                     <span className="font-mono bg-base-100 px-1 rounded">
                        {resolvedEndpoint.url || resolvedEndpoint.uri}
                     </span>
                   </p>
                </div>
             </div>
             
             <button className="btn btn-success w-full" onClick={handleConnect}>
                Connect to Relay
                <ArrowRight className="w-4 h-4 ml-2" />
             </button>
          </div>
        )}
      </div>
    </div>
  );
}


