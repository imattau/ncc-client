import { useState } from 'react';
import { useNCC } from '../context/NCCContext';
import { nip19 } from 'nostr-tools';
import { Shield, CheckCircle, XCircle } from 'lucide-react';

export function TrustExplorer() {
  const { ncc02Resolver } = useNCC();
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [serviceId, setServiceId] = useState('media');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      let hex = pubkeyInput;
      if (pubkeyInput.startsWith('npub')) {
        const { data } = nip19.decode(pubkeyInput);
        hex = data as string;
      }
      
      // NCC-02 Resolve
      const service = await ncc02Resolver.resolve(hex, serviceId, {
        requireAttestation: false,
        minLevel: 'self'
      });
      
      setResult(service);
    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card bg-base-100 shadow-lg border border-base-200">
      <div className="card-body">
        <h3 className="card-title text-xl mb-4 flex items-center">
          <Shield className="w-6 h-6 mr-2 text-accent" />
          Trust Explorer (NCC-02)
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
            <input 
              className="input input-bordered" 
              placeholder="media" 
              value={serviceId}
              onChange={e => setServiceId(e.target.value)}
            />
          </div>
          <button 
            className="btn btn-accent" 
            onClick={handleResolve}
            disabled={loading}
          >
            {loading ? <span className="loading loading-spinner"></span> : "Verify Service"}
          </button>
        </div>

        {error && (
          <div className="alert alert-error mt-4">
            <XCircle className="w-6 h-6" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-6 p-4 bg-base-200 rounded-box">
             <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="text-success w-5 h-5" />
                <span className="font-bold">Service Verified</span>
             </div>
             <pre className="text-xs overflow-auto bg-base-300 p-2 rounded">
               {JSON.stringify(result, null, 2)}
             </pre>
          </div>
        )}
      </div>
    </div>
  );
}
