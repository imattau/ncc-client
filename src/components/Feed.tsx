import { useState, useEffect, useRef } from 'react';
import { SimplePool, Event } from 'nostr-tools';
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
  const pendingCommitRef = useRef<Event[]>([]);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleEventCommit = (event: Event) => {
    pendingCommitRef.current.push(event);
    if (commitTimerRef.current) return;

    commitTimerRef.current = setTimeout(() => {
        const batch = [...pendingCommitRef.current];
        pendingCommitRef.current = [];
        commitTimerRef.current = null;

        setEvents(prev => {
            const newEvents = [...prev];
            let changed = false;
            batch.forEach(ev => {
                if (!newEvents.find(e => e.id === ev.id)) {
                    newEvents.push(ev);
                    changed = true;
                }
            });
            if (!changed) return prev;
            return newEvents.sort((a, b) => b.created_at - a.created_at);
        });
    }, 100);
  };
  
  // Clear events when relay changes
  useEffect(() => {
    setEvents([]);
    setProfiles({});
    setStatus('disconnected');
    setErrorMsg(null);
    pendingCommitRef.current = [];
    if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
    }
  }, [relayUrl]);

  const connectAndSubscribe = async () => {
    if (!relayUrl) return;

    setStatus('connecting');
    setErrorMsg(null);
    setEvents([]);

    // Warning for Tor
    if (relayUrl.includes('.onion')) {
        console.warn("[Feed] Tor connection requested. Handshake may take up to 45 seconds.");
    }

    console.log(`[Feed] Subscribing to ${relayUrl}...`);

    let hasReceivedAnything = false;

    const sub = pool.current.subscribeMany(
      [relayUrl],
      [{ kinds: [1, 30058, 30059, 30060, 30061], limit: 50 }] as any,
      {
        onevent(event) {
          hasReceivedAnything = true;
          scheduleEventCommit(event);
          setStatus('connected');
        },
        oneose() {
           hasReceivedAnything = true;
           console.log(`[Feed] EOSE received from ${relayUrl}.`);
           setStatus('connected');
        },
        onclose(reasons) {
            console.error("[Feed] Subscription closed:", reasons);
            if (!hasReceivedAnything) {
                setStatus('error');
                setErrorMsg(`Connection closed by relay or bridge.`);
            }
        }
      }
    );

    // Watchdog timer for slow connections (especially Tor)
    const watchdog = setTimeout(() => {
        if (!hasReceivedAnything && status === 'connecting') {
            console.error(`[Feed] Connection watchdog triggered after 30s`);
            setStatus('error');
            setErrorMsg("Relay did not respond. Tor might be slow or the relay is empty.");
            sub.close();
        }
    }, 30000);

    return () => {
      clearTimeout(watchdog);
      sub.close();
    };
  };

  useEffect(() => {
    if (relayUrl) {
        let cleanup: any;
        connectAndSubscribe().then(c => cleanup = c);
        return () => cleanup && cleanup();
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
      <div className="flex flex-col bg-base-100 p-4 rounded-box shadow-sm border border-base-200 gap-3">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
               <div className={`badge ${status === 'connected' ? 'badge-success' : status === 'connecting' ? 'badge-warning' : 'badge-error'} badge-xs animate-pulse`}></div>
               <div className="flex flex-col min-w-0">
                   <span className="font-mono text-sm font-bold truncate max-w-[200px] sm:max-w-md">{relayUrl}</span>
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
                    <button 
                        className={`btn btn-sm btn-ghost ${status === 'connecting' ? 'loading' : ''}`} 
                        onClick={() => connectAndSubscribe()}
                        disabled={status === 'connecting'}
                    >
                        <RefreshCw className="w-4 h-4" />
                        <span className="hidden sm:inline ml-2">Refresh</span>
                    </button>
                )}
            </div>
        </div>
        
        {/* Kind Breakdown Bar */}
        {status === 'connected' && events.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-base-200">
                <div className="text-[10px] uppercase font-bold opacity-30 w-full mb-1">Content Summary</div>
                {[1, 30058, 30059, 30060, 30061].map(k => {
                    const count = events.filter(e => e.kind === k).length;
                    if (count === 0) return null;
                    return (
                        <div key={k} className="badge badge-ghost badge-sm text-[10px] gap-1">
                            Kind {k}: <span className="font-bold">{count}</span>
                        </div>
                    );
                })}
            </div>
        )}
      </div>

      {status === 'error' && (
          <div className="alert alert-error text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>Failed to connect: {errorMsg}</span>
          </div>
      )}

      <div className="space-y-4">
        {events.length === 0 && status === 'connected' && (
           <div className="text-center p-12 opacity-50 border-2 border-dashed border-base-200 rounded-box">
               <div className="loading loading-dots loading-md mb-2"></div>
               <p>Connected. Waiting for events...</p>
               <p className="text-xs mt-2 italic">Note: Some relays may be empty or only store specific NCC kinds.</p>
           </div>
        )}
        
        {events.map(ev => {
          const profile = profiles[ev.pubkey];
          const name = profile?.display_name || profile?.name || ev.pubkey.slice(0, 8);
          
          // NCC Compliance Checks (Identifying "Correct" records)
          const hasExp = ev.tags.some(t => t[0] === 'exp');
          const hasTtl = ev.tags.some(t => t[0] === 'ttl');
          const isPrivate = ev.tags.some(t => t[0] === 'private' && t[1] === 'true');
          
          let hasTtlInContent = false;
          try {
              if (ev.kind === 30058 && ev.content.startsWith('{')) {
                  const p = JSON.parse(ev.content);
                  if (p.ttl) hasTtlInContent = true;
              }
          } catch(e) {}

          const isNcc02 = ev.kind === 30059 && hasExp;
          const isNcc05 = ev.kind === 30058 && (hasTtl || hasTtlInContent || isPrivate);
          const isNccAttestation = ev.kind === 30060;
          const isNccRevocation = ev.kind === 30061;

          return (
            <div key={ev.id} className="card bg-base-100 shadow-sm border border-base-200 overflow-hidden">
              <div className="card-body p-3 sm:p-4">
                 <div className="flex items-start gap-3">
                   {/* Avatar */}
                   <div className="avatar flex-shrink-0">
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
                     <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-1 gap-1">
                       <div className="font-bold text-sm truncate text-primary pr-2">{name}</div>
                       <div className="flex flex-wrap items-center gap-1">
                          {isNcc05 && <div className="badge badge-primary badge-xs scale-90 sm:scale-100">NCC-05 LOCATOR</div>}
                          {isNcc02 && <div className="badge badge-secondary badge-xs scale-90 sm:scale-100">NCC-02 SERVICE</div>}
                          {isNccAttestation && <div className="badge badge-accent badge-xs scale-90 sm:scale-100">NCC-02 ATTEST</div>}
                          {isNccRevocation && <div className="badge badge-error badge-xs scale-90 sm:scale-100">NCC-02 REVOKE</div>}
                          
                          {/* Generic Fallback for NCC kinds without expected tags */}
                          {!isNcc05 && !isNcc02 && !isNccAttestation && !isNccRevocation && ev.kind >= 30058 && ev.kind <= 30061 && (
                              <div className="badge badge-ghost badge-xs opacity-50 text-[8px]">KIND {ev.kind}</div>
                          )}

                          <div className="text-[9px] opacity-40 whitespace-nowrap font-mono ml-auto sm:ml-0">
                            {new Date(ev.created_at * 1000).toLocaleTimeString()}
                          </div>
                       </div>
                     </div>
                     <div className="text-sm leading-relaxed mt-1">
                        {ev.kind === 1 ? (
                            <p className="whitespace-pre-wrap break-words">{ev.content}</p>
                        ) : (
                            <div className="bg-base-200/50 p-2 rounded border border-base-300 text-xs font-mono overflow-x-auto">
                                <div className="font-bold mb-1 opacity-50 italic text-[10px]">
                                    {isNcc05 ? "Identity-Bound Locator" : 
                                     isNcc02 ? "Pubkey-Owned Service Record" :
                                     isNccAttestation ? "Service Attestation" :
                                     isNccRevocation ? "Service Revocation" : `Event Kind ${ev.kind}`}
                                </div>
                                <div className="flex gap-2 mb-1">
                                    <span className="opacity-50">d-tag:</span>
                                    <span className="font-bold">{ev.tags.find(t => t[0] === 'd')?.[1] || 'none'}</span>
                                </div>
                                <div className="opacity-70 mt-1 truncate max-w-full">
                                    <span className="opacity-50 mr-1">Content:</span>
                                    {ev.content.slice(0, 80)}{ev.content.length > 80 && '...'}
                                </div>
                            </div>
                        )}
                     </div>
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
