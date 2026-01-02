import { useState, useEffect, useRef } from 'react';
import { SimplePool, Event } from 'nostr-tools';
import { Radio } from 'lucide-react';

interface FeedProps {
  relayUrl: string | null;
}

export function Feed({ relayUrl }: FeedProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const pool = useRef(new SimplePool());
  
  // Clear events when relay changes
  useEffect(() => {
    setEvents([]);
    setStatus('disconnected');
  }, [relayUrl]);

  useEffect(() => {
    if (!relayUrl) return;

    setStatus('connecting');
    
    // We strictly use ONLY the provided relayUrl for the feed
    // We do NOT use the bootstrap relays here.
    const sub = pool.current.subscribeMany(
      [relayUrl],
      [{ kinds: [1], limit: 20 }] as any,
      {
        onevent(event) {
          setEvents(prev => {
            if (prev.find(e => e.id === event.id)) return prev;
            return [event, ...prev].sort((a, b) => b.created_at - a.created_at);
          });
          setStatus('connected');
        },
        oneose() {
           // connected
           setStatus('connected');
        }
      }
    );

    return () => {
      sub.close();
    };
  }, [relayUrl]);

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
        
        {events.map(ev => (
          <div key={ev.id} className="card bg-base-100 shadow-sm border border-base-200">
            <div className="card-body p-4">
               <div className="flex items-start justify-between mb-2">
                 <div className="font-bold text-sm text-primary truncate w-1/2">{ev.pubkey}</div>
                 <div className="text-xs opacity-50">{new Date(ev.created_at * 1000).toLocaleString()}</div>
               </div>
               <p className="whitespace-pre-wrap break-words text-sm">{ev.content}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
