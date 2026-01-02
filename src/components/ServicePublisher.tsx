import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNCC } from '../context/NCCContext';
import { Upload, Save } from 'lucide-react';
import { DEFAULT_RELAYS } from '../lib/relays';

export function ServicePublisher() {
  const { privkey } = useAuth();
  const { ncc05Publisher } = useNCC();
  
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  
  // Simple form state for one endpoint for PoC
  const [endpoint, setEndpoint] = useState({
    type: 'https',
    url: '',
    priority: 1,
    family: 'ipv4'
  });

  if (!privkey) return <div className="alert alert-warning">Login with Private Key (nsec) to publish.</div>;

  const handlePublish = async () => {
    setLoading(true);
    setSuccess('');
    try {
      const payload = {
        v: 1,
        ttl: 3600,
        updated_at: Math.floor(Date.now() / 1000),
        endpoints: [endpoint]
      };

      // Publish public record
      await ncc05Publisher.publish(DEFAULT_RELAYS, privkey, payload, { public: true, identifier: 'addr' });
      setSuccess('Service Published Successfully!');
    } catch (e: any) {
      console.error(e);
      alert('Publish failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card bg-base-100 shadow-lg border border-base-200">
      <div className="card-body">
         <h3 className="card-title text-xl mb-4 flex items-center">
          <Upload className="w-6 h-6 mr-2 text-secondary" />
          Publish Service (NCC-05)
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
           <div className="form-control">
             <label className="label">Type</label>
             <select 
                className="select select-bordered" 
                value={endpoint.type}
                onChange={e => setEndpoint({...endpoint, type: e.target.value})}
             >
               <option value="https">HTTPS</option>
               <option value="http">HTTP</option>
               <option value="tcp">TCP</option>
               <option value="ipfs">IPFS</option>
             </select>
           </div>
           
           <div className="form-control">
             <label className="label">Family</label>
             <select 
                className="select select-bordered" 
                value={endpoint.family}
                onChange={e => setEndpoint({...endpoint, family: e.target.value})}
             >
               <option value="ipv4">IPv4</option>
               <option value="ipv6">IPv6</option>
               <option value="onion">Onion (Tor)</option>
             </select>
           </div>

           <div className="form-control md:col-span-2">
             <label className="label">URI / URL</label>
             <input 
               className="input input-bordered" 
               placeholder={endpoint.family === 'onion' ? "xyz...onion" : "192.168.1.1"}
               value={endpoint.url}
               onChange={e => setEndpoint({...endpoint, url: e.target.value})}
             />
           </div>
        </div>

        <div className="card-actions justify-end mt-4">
          <button 
            className="btn btn-secondary" 
            onClick={handlePublish}
            disabled={loading || !endpoint.url}
          >
            {loading ? <span className="loading loading-spinner"></span> : <Save className="w-4 h-4 mr-2" />}
            Publish to Network
          </button>
        </div>

        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}
