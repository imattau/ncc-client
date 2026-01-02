import { useState, useEffect, useRef } from 'react';
import { SimplePool, Event, Relay } from 'nostr-tools';
import { Radio, User, RefreshCw, AlertCircle } from 'lucide-react';

interface FeedProps {
  relayUrl: string | null;
}

interface UserProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
}

export function Feed({ relayUrl }: FeedProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [profiles, setProfiles] = useState<Record<string, UserProfile>>({});
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pool = useRef(new SimplePool());
  
  // Clear events when relay changes
  useEffect(() => {
    setEvents([]);
    setProfiles({});
    setStatus('disconnected');
    setErrorMsg(null);
  }, [relayUrl]);

  const connectAndSubscribe = async () => {
    if (!relayUrl) return;

    // Browser Safety Check for Onion Addresses
    if (relayUrl.includes('.onion')) {
        setStatus('error');
        setErrorMsg("Browsers cannot connect to .onion Relays directly. Use a Tor-enabled native app.");
        return;
    }

    setStatus('connecting');
    setErrorMsg(null);
    setEvents([]);

    console.log(`[Feed] Attempting to connect to ${relayUrl}...`);

    try {
        // Explicitly test connection first
        // This ensures we don't just sit in 'connecting' forever or fake it
        const r = await Relay.connect(relayUrl);
        console.log(`[Feed] Connection verified to ${relayUrl}`);
        r.close(); // Close the test connection, let SimplePool manage the real one
    } catch (e: any) {
        console.error(`[Feed] Connection failed:`, e);
        setStatus('error');
        setErrorMsg(e.message || "Connection timed out or refused.");
        return;
    }

    // Subscribe via Pool
    const sub = pool.current.subscribeMany(
      [relayUrl],
      [{ kinds: [1], limit: 40 }] as any,
      {
        onevent(event) {
          console.debug(`[Feed] Event received:`, event.id);
          setEvents(prev => {
            if (prev.find(e => e.id === event.id)) return prev;
            return [event, ...prev].sort((a, b) => b.created_at - a.created_at);
          });
          setStatus('connected');
        },
        oneose() {
           console.log(`[Feed] EOSE (End of Stored Events) received.`);
           setStatus('connected');
        }
      }
    );

    return () => {
      sub.close();
    };
  };

  useEffect(() => {
    if (relayUrl) {
        const cleanupPromise = connectAndSubscribe();
        return () => {
            cleanupPromise.then(cleanup => cleanup && cleanup());
        };
    }
  }, [relayUrl]);

  // Fetch Profiles (Kind 0) for new authors
  useEffect(() => {
    if (!relayUrl || events.length === 0) return;

    const authorsToFetch = [...new Set(events.map(e => e.pubkey))].filter(pk => !profiles[pk]);
    
    if (authorsToFetch.length === 0) return;

    const sub = pool.current.subscribeMany(
      [relayUrl],
      [{ kinds: [0], authors: authorsToFetch }] as any,
      {
        onevent(event) {
          try {
            const content = JSON.parse(event.content);
            setProfiles(prev => ({ ...prev, [event.pubkey]: content }));
          } catch (e) {
            // ignore malformed json
          }
        },
        oneose() {
           // done
        }
      }
    );
    
    return () => {
       sub.close();
    };
  }, [events, relayUrl]);

  if (!relayUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-base-content/50 border-2 border-dashed border-base-300 rounded-box">
        <Radio className="w-12 h-12 mb-4" />
        <h3 className="font-bold text-lg">No Relay Connected</h3>
        <p>Use the Service Discovery tab to find and connect to a relay.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between bg-base-100 p-4 rounded-box shadow-sm border border-base-200">
        <div className="flex items-center gap-3">
           <div className={`badge ${status === 'connected' ? 'badge-success' : status === 'connecting' ? 'badge-warning' : 'badge-error'} badge-xs animate-pulse`}></div>
           <div className="flex flex-col">
               <span className="font-mono text-sm font-bold">{relayUrl}</span>
               <span className="text-xs opacity-50 capitalize">
                   {status} {status === 'connected' && `(${events.length} events)`}
               </span>
           </div>
        </div>
        <div>
            {status === 'error' ? (
                <button className="btn btn-sm btn-error" onClick={() => connectAndSubscribe()}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry
                </button>
            ) : (
                <div className="text-xs opacity-50">Live Feed</div>
            )}
        </div>
      </div>

      {status === 'error' && (
          <div className="alert alert-error text-sm">
              <AlertCircle className="w-4 h-4" />
              <span>Failed to connect: {errorMsg}</span>
          </div>
      )}

      <div className="space-y-4">
        {events.length === 0 && status === 'connected' && (
           <div className="text-center p-12 opacity-50 border-2 border-dashed border-base-200 rounded-box">
               <div className="loading loading-dots loading-md mb-2"></div>
               <p>Connected. Waiting for events...</p>
           </div>
        )}
        
        {events.map(ev => {
          const profile = profiles[ev.pubkey];
          const name = profile?.display_name || profile?.name || ev.pubkey.slice(0, 8);
          
          return (
            <div key={ev.id} className="card bg-base-100 shadow-sm border border-base-200">
              <div className="card-body p-4">
                 <div className="flex items-start gap-3">
                   {/* Avatar */}
                   <div className="avatar">
                     <div className="w-10 h-10 rounded-full bg-base-300">
                       {profile?.picture ? (
                         <img src={profile.picture} alt={name} onError={(e) => (e.currentTarget.src = `https://api.dicebear.com/7.x/identicon/svg?seed=${ev.pubkey}`)} />
                       ) : (
                         <div className="flex items-center justify-center w-full h-full text-base-content/30 bg-base-200">
                            <User className="w-5 h-5" />
                         </div>
                       )}
                     </div>
                   </div>
                   
                   {/* Content */}
                   <div className="flex-1 min-w-0">
                     <div className="flex items-center justify-between mb-1">
                       <div className="font-bold text-sm truncate text-primary">{name}</div>
                       <div className="text-[10px] opacity-50 whitespace-nowrap ml-2 font-mono">
                         {new Date(ev.created_at * 1000).toLocaleTimeString()}
                       </div>
                     </div>
                     <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{ev.content}</p>
                   </div>
                 </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}