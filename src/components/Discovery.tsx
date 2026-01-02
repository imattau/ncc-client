import { useState } from 'react';
import { useNCC } from '../context/NCCContext';
import { nip19 } from 'nostr-tools';
import { Network, ArrowRight, ShieldCheck, AlertTriangle } from 'lucide-react';
import { DEFAULT_RELAYS } from '../lib/relays';

interface DiscoveryProps {
  onConnect: (url: string) => void;
}

export function Discovery({ onConnect }: DiscoveryProps) {
  const { ncc05Resolver, ncc02Resolver, pool } = useNCC();
  
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
                  profileMap[ev.pubkey] = JSON.parse(ev.content);
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

  const handleDiscover = async () => {
    setStep('verifying');
    setLogs([]);
    setError(null);
    setResolvedEndpoint(null);
    setRawEvents([]);
    setProfiles({});

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

        {/* Raw Events (Dev) */}
        {rawEvents.length > 0 && (
           <div className="mt-4">
              <h4 className="text-sm font-bold mb-2">Found Events ({rawEvents.length})</h4>
              
              {/* NCC-02 Group */}
              {rawEvents.filter(e => e.kind === 30059).length > 0 && (
                <div className="mb-4">
                  <h5 className="text-xs font-bold text-secondary mb-1">NCC-02 (Service Records - 30059)</h5>
                  <div className="space-y-2">
                    {rawEvents.filter(e => e.kind === 30059).map((ev) => (
                        <div key={ev.id} className="collapse collapse-arrow bg-base-200 border border-base-300">
                          <input type="radio" name="events-accordion" /> 
                          <div className="collapse-title text-xs font-mono flex items-center justify-between pr-8">
                              <span>d:{ev.tags.find((t: any) => t[0] === 'd')?.[1] || 'none'}</span>
                              <span className="opacity-50 ml-2 truncate max-w-[150px]">{getDisplayName(ev.pubkey)}</span>
                          </div>
                          <div className="collapse-content"> 
                              <pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded">
                                {JSON.stringify(ev, null, 2)}
                              </pre>
                          </div>
                        </div>
                    ))}
                  </div>
                </div>
              )}

              {/* NCC-05 Group */}
              {rawEvents.filter(e => e.kind === 30058).length > 0 && (
                <div>
                  <h5 className="text-xs font-bold text-primary mb-1">NCC-05 (Service Locators - 30058)</h5>
                  <div className="space-y-2">
                    {rawEvents.filter(e => e.kind === 30058).map((ev) => (
                        <div key={ev.id} className="collapse collapse-arrow bg-base-200 border border-base-300">
                          <input type="radio" name="events-accordion" /> 
                          <div className="collapse-title text-xs font-mono flex items-center justify-between pr-8">
                              <span>d:{ev.tags.find((t: any) => t[0] === 'd')?.[1] || 'none'}</span>
                              <span className="opacity-50 ml-2 truncate max-w-[150px]">{getDisplayName(ev.pubkey)}</span>
                          </div>
                          <div className="collapse-content"> 
                              <pre className="text-[10px] overflow-x-auto bg-black text-green-500 p-2 rounded">
                                {JSON.stringify(ev, null, 2)}
                              </pre>
                          </div>
                        </div>
                    ))}
                  </div>
                </div>
              )}
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


