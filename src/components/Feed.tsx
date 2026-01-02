import { useState, useEffect, useRef } from 'react';
import { SimplePool, Event } from 'nostr-tools';
import { Radio, User } from 'lucide-react';

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
  const pool = useRef(new SimplePool());
  
  // Clear events when relay changes
  useEffect(() => {
    setEvents([]);
    setProfiles({});
    setStatus('disconnected');
  }, [relayUrl]);

  // Fetch Feed (Kind 1)
  useEffect(() => {
    if (!relayUrl) return;

    setStatus('connecting');
    
    const sub = pool.current.subscribeMany(
      [relayUrl],
      [{ kinds: [1], limit: 40 }] as any,
      {
        onevent(event) {
          setEvents(prev => {
            if (prev.find(e => e.id === event.id)) return prev;
            return [event, ...prev].sort((a, b) => b.created_at - a.created_at);
          });
          setStatus('connected');
        },
        oneose() {
           setStatus('connected');
        }
      }
    );

    return () => {
      sub.close();
    };
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
    
    // We don't necessarily need to keep this open forever, but for a live feed it's okay.
    // Ideally we'd one-off query or batch it better, but subscribe works for now.
    return () => {
       sub.close();
    };
  }, [events, relayUrl]); // Re-run when events change (to catch new authors)

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
        <div className="flex items-center gap-2">
           <div className={`badge ${status === 'connected' ? 'badge-success' : status === 'connecting' ? 'badge-warning' : 'badge-error'} badge-xs`}></div>
           <span className="font-mono text-sm">{relayUrl}</span>
        </div>
        <div className="text-xs opacity-50">
           {status === 'connected' ? 'Live' : status}
        </div>
      </div>

      <div className="space-y-4">
        {events.length === 0 && status === 'connected' && (
           <div className="text-center p-8 opacity-50">No events found on this relay yet.</div>
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
                         <img src={profile.picture} alt={name} onError={(e) => (e.currentTarget.src = 'https://ui-avatars.com/api/?name=' + name)} />
                       ) : (
                         <div className="flex items-center justify-center w-full h-full text-base-content/30">
                            <User className="w-5 h-5" />
                         </div>
                       )}
                     </div>
                   </div>
                   
                   {/* Content */}
                   <div className="flex-1 min-w-0">
                     <div className="flex items-center justify-between mb-1">
                       <div className="font-bold text-sm truncate">{name}</div>
                       <div className="text-[10px] opacity-50 whitespace-nowrap ml-2">
                         {new Date(ev.created_at * 1000).toLocaleString()}
                       </div>
                     </div>
                     <p className="whitespace-pre-wrap break-words text-sm">{ev.content}</p>
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