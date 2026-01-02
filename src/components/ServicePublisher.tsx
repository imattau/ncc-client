import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNCC } from '../context/NCCContext';
import { Upload, Save, Package } from 'lucide-react';
import { RelayManager } from '../lib/relays';
import { nip19 } from 'nostr-tools';
import clsx from 'clsx';

export function ServicePublisher() {
  const { signEvent, method } = useAuth();
  const { ncc05Publisher } = useNCC();
  
  const [isPrivate, setIsPrivate] = useState(false);
  const [recipients, setRecipients] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [sidecarDiscovery, setSidecarDiscovery] = useState<{ loading: boolean, services: any[] }>({ loading: false, services: [] });
  
  // Simple form state for one endpoint for PoC
  const [endpoint, setEndpoint] = useState({
    type: 'ws',
    url: '',
    priority: 1,
    family: 'onion'
  });

  const detectSidecar = async () => {
      setSidecarDiscovery(prev => ({ ...prev, loading: true }));
      try {
          // Probing ncc-sidecar local inventory API
          const res = await fetch('http://localhost:3005/inventory');
          const data = await res.json();
          if (data && data.services) {
              setSidecarDiscovery({ loading: false, services: data.services });
          }
      } catch (e) {
          console.warn("Sidecar not detected at localhost:3005");
          setSidecarDiscovery({ loading: false, services: [] });
          alert("NCC Sidecar not detected on localhost:3005. Ensure it is running.");
      }
  };

  const importService = (s: any) => {
      setEndpoint({
          type: s.type || 'ws',
          url: s.onion_address || '',
          priority: 1,
          family: 'onion'
      });
  };

  if (method === 'readonly') return <div className="alert alert-warning">Read-only users cannot publish. Please login with an extension or nsec.</div>;

  const handlePublish = async () => {
    setLoading(true);
    setSuccess('');
    try {
      const recipientList = recipients.split(',')
        .map(r => r.trim())
        .filter(r => r)
        .map(r => r.startsWith('npub') ? (nip19.decode(r).data as string) : r);

      const payload = {
        v: 1,
        ttl: 3600,
        updated_at: Math.floor(Date.now() / 1000),
        endpoints: [endpoint],
        // If private, the library will handle encryption for these recipients
        ...(isPrivate && { privaterecipients: recipientList })
      };

      // Publish record
      // The library's ncc05Publisher needs a signer. 
      // We pass a custom signer function that uses our unified AuthContext.signEvent
      await ncc05Publisher.publish(RelayManager.load(), signEvent as any, payload, { 
          public: !isPrivate, 
          identifier: 'addr',
          recipientPubkey: recipientList[0] // Encrypt for the first recipient in the PoC
      });
      setSuccess(`Service Published ${isPrivate ? 'Privately' : 'Publicly'}!`);
    } catch (e: any) {
      console.error(e);
      alert('Publish failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Sidecar Integration */}
      <div className="card bg-base-300 border border-base-content/10 shadow-sm">
          <div className="card-body p-4">
              <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                      <Package className="text-secondary w-5 h-5" />
                      <h3 className="font-bold text-sm">NCC Sidecar Integration</h3>
                  </div>
                  <button 
                    className={clsx("btn btn-xs btn-outline btn-secondary", sidecarDiscovery.loading && "loading")} 
                    onClick={detectSidecar}
                  >
                      {sidecarDiscovery.loading ? 'Detecting...' : 'Detect Local Services'}
                  </button>
              </div>
              
              {sidecarDiscovery.services.length > 0 && (
                  <div className="mt-3 space-y-2 fade-in">
                      <p className="text-[10px] opacity-60 uppercase font-bold tracking-widest px-1">Local Services Found</p>
                      {sidecarDiscovery.services.map((s, i) => (
                          <div key={i} className="flex items-center justify-between p-2 bg-base-100 rounded border border-base-200">
                              <div className="flex flex-col min-w-0">
                                  <span className="text-xs font-bold truncate">{s.name || s.id}</span>
                                  <span className="text-[9px] font-mono opacity-50 truncate">{s.onion_address}</span>
                              </div>
                              <button className="btn btn-xs btn-ghost text-secondary" onClick={() => importService(s)}>Import</button>
                          </div>
                      ))}
                  </div>
              )}
          </div>
      </div>

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
               <option value="ws">WebSocket (Relay)</option>
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

           <div className="form-control md:col-span-2 border-t pt-4 mt-2">
              <label className="label cursor-pointer justify-start gap-4">
                <input 
                    type="checkbox" 
                    className="toggle toggle-secondary" 
                    checked={isPrivate} 
                    onChange={e => setIsPrivate(e.target.checked)} 
                />
                <span className="label-text font-bold">Private Discovery (Encrypted)</span>
              </label>
              <p className="text-[10px] opacity-60 mb-2">Private records are only visible to specific pubkeys using NIP-44 encryption.</p>
              
              {isPrivate && (
                  <div className="fade-in">
                    <label className="label text-xs">Recipients (Comma separated npubs)</label>
                    <textarea 
                        className="textarea textarea-bordered w-full h-20 text-xs font-mono" 
                        placeholder="npub1..., npub1..."
                        value={recipients}
                        onChange={e => setRecipients(e.target.value)}
                    />
                  </div>
              )}
           </div>
        </div>

        <div className="card-actions justify-end mt-4">
          <button 
            className="btn btn-secondary" 
            onClick={handlePublish}
            disabled={loading || !endpoint.url || (isPrivate && !recipients)}
          >
            {loading ? <span className="loading loading-spinner"></span> : <Save className="w-4 h-4 mr-2" />}
            {isPrivate ? 'Publish Private' : 'Publish to Network'}
          </button>
        </div>

        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  </div>
  );
}
