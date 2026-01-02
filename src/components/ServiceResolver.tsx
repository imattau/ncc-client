import { useState } from 'react';
import { useNCC } from '../context/NCCContext';
import { nip19 } from 'nostr-tools';
import { Search, Globe, ShieldCheck, AlertTriangle, ExternalLink } from 'lucide-react';

interface ResolvedService {
  endpoints: any[];
  updated_at: number;
  ttl: number;
}

export function ServiceResolver() {
  const { ncc05Resolver } = useNCC();
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [identifier, setIdentifier] = useState('addr'); // default per spec
  const [result, setResult] = useState<ResolvedService | null>(null);
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

      // Resolve using ONLY bootstrap relays (gossip: false)
      const record = await ncc05Resolver.resolve(hex, undefined, identifier, { gossip: false });
      if (record) {
        setResult(record);
      } else {
        setError('No service record found.');
      }
    } catch (e: any) {
      console.error(e);
      setError(e.message || 'Resolution failed');
    } finally {
      setLoading(false);
    }
  };

  const attemptConnection = async (endpoint: any) => {
    // Check for url or uri for backward compatibility/safety, but prefer url per types
    const uri = endpoint.url || endpoint.uri; 
    const isOnion = endpoint.family === 'onion' || (uri && uri.includes('.onion'));
    
    if (isOnion) {
      const confirmed = window.confirm(`TOR DETECTED: ${uri}\n\nThe application prefers this Onion address.\nDo you want to attempt to connect via Tor?`);
      if (!confirmed) return;
      
      // In a real environment, this might proxy. In browser, we just try fetch or open.
      // If it's http/https we can try opening it.
      if (endpoint.type === 'http' || endpoint.type === 'https') {
          // Check if uri has protocol
          let url = uri;
          if (!url.startsWith('http')) url = `http://${url}`;
          window.open(url, '_blank');
      } else {
          alert(`Cannot auto-connect to non-HTTP Onion service (${endpoint.type}) from browser.\nEndpoint: ${uri}`);
      }
    } else {
       // Standard connection
       if (endpoint.type === 'http' || endpoint.type === 'https') {
           let url = uri;
           if (!url.startsWith('http')) url = `http://${url}`;
           window.open(url, '_blank');
       } else {
           alert(`Connecting to ${endpoint.type}://${uri}`);
       }
    }
  };

  return (
    <div className="card bg-base-100 shadow-lg border border-base-200">
      <div className="card-body">
        <h3 className="card-title text-xl mb-4 flex items-center">
          <Globe className="w-6 h-6 mr-2 text-primary" />
          Service Resolution (NCC-05)
        </h3>
        
        <div className="flex flex-col gap-4">
          <div className="form-control">
            <label className="label">Target Pubkey (npub/hex)</label>
            <input 
              className="input input-bordered" 
              placeholder="npub1..." 
              value={pubkeyInput}
              onChange={e => setPubkeyInput(e.target.value)}
            />
          </div>
          <div className="form-control">
            <label className="label">Identifier (d-tag)</label>
            <input 
              className="input input-bordered" 
              placeholder="addr" 
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
            />
          </div>
          <button 
            className="btn btn-primary" 
            onClick={handleResolve}
            disabled={loading}
          >
            {loading ? <span className="loading loading-spinner"></span> : <Search className="w-4 h-4 mr-2" />}
            Resolve
          </button>
        </div>

        {error && (
          <div className="alert alert-error mt-4">
            <AlertTriangle className="w-6 h-6" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-6 space-y-4">
            <div className="badge badge-success gap-2">
              <ShieldCheck className="w-4 h-4" />
              Resolved Successfully
            </div>
            
            <div className="overflow-x-auto">
              <table className="table table-zebra w-full">
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Type</th>
                    <th>Family</th>
                    <th>URI</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {result.endpoints.map((ep, idx) => {
                     const uri = ep.url || ep.uri;
                     const isOnion = ep.family === 'onion' || (uri && uri.includes('.onion'));
                     return (
                      <tr key={idx} className={isOnion ? "bg-base-200" : ""}>
                        <td>{ep.priority}</td>
                        <td>{ep.type}</td>
                        <td className="font-mono text-xs">{ep.family}</td>
                        <td className="font-mono text-sm break-all">
                          {isOnion && <span className="text-purple-500 font-bold mr-2">[TOR]</span>}
                          {uri}
                        </td>
                        <td>
                          <button 
                            className={`btn btn-sm ${isOnion ? 'btn-secondary' : 'btn-ghost'}`}
                            onClick={() => attemptConnection(ep)}
                          >
                            <ExternalLink className="w-4 h-4" />
                            {isOnion ? 'Connect (Tor)' : 'Connect'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="text-xs opacity-50">
              Updated: {new Date(result.updated_at * 1000).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}