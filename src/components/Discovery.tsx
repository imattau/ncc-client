import { useState } from 'react';
import { useNCC } from '../context/NCCContext';
import { nip19 } from 'nostr-tools';
import { Network, ArrowRight, ShieldCheck, AlertTriangle } from 'lucide-react';

interface DiscoveryProps {
  onConnect: (url: string) => void;
}

export function Discovery({ onConnect }: DiscoveryProps) {
  const { ncc05Resolver, ncc02Resolver } = useNCC();
  
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [serviceId, setServiceId] = useState('relay'); // Default to looking for a relay
  
  // State for the multi-step process
  const [step, setStep] = useState<'idle' | 'verifying' | 'resolving' | 'complete'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Result
  const [resolvedEndpoint, setResolvedEndpoint] = useState<any>(null);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);

  const handleDiscover = async () => {
    setStep('verifying');
    setLogs([]);
    setError(null);
    setResolvedEndpoint(null);

    try {
      let hex = pubkeyInput;
      if (pubkeyInput.startsWith('npub')) {
        const { data } = nip19.decode(pubkeyInput);
        hex = data as string;
      }

      // 1. NCC-02 Verification
      addLog(`🔍 NCC-02: Verifying ownership of service '${serviceId}'...`);
      // We don't enforce attestation for this PoC to allow self-hosted services easily
      await ncc02Resolver.resolve(hex, serviceId, {
        requireAttestation: false, 
        minLevel: 'self'
      });
      
      // trustRecord structure depends on the lib version, safe to just say verified if it didn't throw.
      addLog(`✅ NCC-02: Service verified.`);
      
      // 2. NCC-05 Resolution
      setStep('resolving');
      addLog(`🌍 NCC-05: Resolving location for identifier '${serviceId}'...`);
      
      const locationRecord = await ncc05Resolver.resolve(hex, undefined, serviceId, { gossip: false });
      
      if (!locationRecord || !locationRecord.endpoints || locationRecord.endpoints.length === 0) {
        throw new Error('Service verified, but no location endpoints found via NCC-05.');
      }
      
      addLog(`📍 NCC-05: Found ${locationRecord.endpoints.length} endpoints.`);
      
      // Select best endpoint (simple priority sort)
      const bestEndpoint = locationRecord.endpoints.sort((a: any, b: any) => (a.priority || 0) - (b.priority || 0))[0];
      setResolvedEndpoint(bestEndpoint);
      setStep('complete');

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
          Service Discovery
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
            <label className="label">Service ID</label>
            <select 
              className="select select-bordered" 
              value={serviceId} 
              onChange={e => setServiceId(e.target.value)}
            >
               <option value="relay">Relay (relay)</option>
               <option value="media">Media Server (media)</option>
               <option value="outbox">Outbox (outbox)</option>
               <option value="chat">Chat Server (chat)</option>
            </select>
          </div>

          <button 
            className="btn btn-primary" 
            onClick={handleDiscover}
            disabled={step === 'verifying' || step === 'resolving'}
          >
            {step !== 'idle' && step !== 'complete' && <span className="loading loading-spinner"></span>}
            Discover Service
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

