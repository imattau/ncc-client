import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useNCC } from './NCCContext';
import { RelayManager } from '../lib/relays';
import { nip44 } from 'nostr-tools';

interface TrackedService {
  pubkey: string;
  serviceId: string;
  latestEvent: any | null; // Kind 30058 (Locator)
  serviceDef: any | null; // Kind 30059 (Definition)
  decryptedPayload: any | null;
  lastChecked: number;
}

interface TrackingContextType {
  tracked: TrackedService[];
  trackService: (pubkey: string, serviceId: string) => void;
  untrackService: (pubkey: string, serviceId: string) => void;
  isTracked: (pubkey: string, serviceId: string) => boolean;
  findTracked: (pubkey: string, serviceId: string) => TrackedService | undefined;
  syncToNostr: () => Promise<void>;
  restoreFromNostr: () => Promise<void>;
}

const TrackingContext = createContext<TrackingContextType | undefined>(undefined);

export function TrackingProvider({ children }: { children: ReactNode }) {
  const { pool } = useNCC();
  const { pubkey: currentPubkey, privkey, signEvent, encryptNip44, decryptNip44, method } = useAuth(); // Only auto-decrypt if we have privkey (NSEC)
  const [tracked, setTracked] = useState<TrackedService[]>(() => {
    const saved = localStorage.getItem('ncc_tracked_services');
    return saved ? JSON.parse(saved) : [];
  });

  // Persist to local storage
  useEffect(() => {
    localStorage.setItem('ncc_tracked_services', JSON.stringify(tracked));
  }, [tracked]);

  const syncToNostr = async () => {
      if (!currentPubkey || method === 'readonly') return;
      try {
          // Sync simplified list (pubkey + serviceId)
          const data = tracked.map(t => ({ pubkey: t.pubkey, serviceId: t.serviceId }));
          const ciphertext = await encryptNip44(currentPubkey, JSON.stringify(data));

          const event = {
              kind: 30078,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['d', 'ncc-client-tracking']],
              content: ciphertext,
              pubkey: currentPubkey
          };

          const signed = await signEvent(event);
          const pubs = pool.publish(RelayManager.load(), signed);
          await Promise.any(pubs);
      } catch (e) {
          console.error("Tracking sync failed", e);
          throw e;
      }
  };

  const restoreFromNostr = async () => {
      if (!currentPubkey) return;
      try {
          const events = await pool.querySync(RelayManager.load(), {
              kinds: [30078],
              authors: [currentPubkey],
              '#d': ['ncc-client-tracking'],
              limit: 1
          });

          if (events.length > 0) {
              const plaintext = await decryptNip44(currentPubkey, events[0].content);
              const data = JSON.parse(plaintext);
              if (Array.isArray(data)) {
                  setTracked(prev => {
                      const merged = [...prev];
                      data.forEach((item: any) => {
                          if (!merged.find(m => m.pubkey === item.pubkey && m.serviceId === item.serviceId)) {
                              merged.push({
                                  pubkey: item.pubkey,
                                  serviceId: item.serviceId,
                                  latestEvent: null,
                                  serviceDef: null,
                                  decryptedPayload: null,
                                  lastChecked: Math.floor(Date.now() / 1000)
                              });
                          }
                      });
                      return merged;
                  });
              }
          }
      } catch (e) {
          console.error("Tracking restore failed", e);
          throw e;
      }
  };

  const handleEvent = useCallback(async (ev: any) => {
    const dTag = ev.tags.find((t: any) => t[0] === 'd')?.[1];
    if (!dTag) return;

    // Normalize ID for matching (strip -locator)
    const baseId = dTag.replace(/-locator$/, '').replace(/-loc$/, '');

    setTracked(prev => {
      const idx = prev.findIndex(t => t.pubkey === ev.pubkey && t.serviceId === baseId);
      if (idx === -1) return prev; // Not tracked

      const current = prev[idx];
      let updated = false;
      const next = { ...current };

      if (ev.kind === 30059) {
        if (!current.serviceDef || ev.created_at > current.serviceDef.created_at) {
           next.serviceDef = ev;
           updated = true;
        }
      } else if (ev.kind === 30058) {
        if (!current.latestEvent || ev.created_at > current.latestEvent.created_at) {
           next.latestEvent = ev;
           next.lastChecked = Math.floor(Date.now() / 1000);
           next.decryptedPayload = null; // Reset decryption for new event
           updated = true;
           
           // Attempt Auto-Decrypt if NSEC available
           if (privkey && !ev.content.trim().startsWith('{')) {
               try {
                   const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
                   const key = nip44.getConversationKey(hexToBytes(privkey), ev.pubkey);
                   const decrypted = nip44.decrypt(ev.content, key);
                   next.decryptedPayload = JSON.parse(decrypted);
               } catch (e) {
                   console.error("Auto-decrypt failed", e);
               }
           }
        }
      }

      if (!updated) return prev;

      const newTracked = [...prev];
      newTracked[idx] = next;
      return newTracked;
    });
  }, [privkey]);

  // Active Monitoring Subscription
  useEffect(() => {
    if (tracked.length === 0) return;

    const authors = [...new Set(tracked.map(t => t.pubkey))];
    
    // Subscribe to updates
    const sub = pool.subscribeMany(
      RelayManager.load(),
      [{ kinds: [30053, 30058, 30059], authors: authors }] as any,
      {
        onevent(ev) {
          handleEvent(ev);
        }
      }
    );

    return () => {
      sub.close();
    };
  }, [tracked.length, handleEvent, pool]); // Re-sub if list or handler changes

  const trackService = (pubkey: string, serviceId: string) => {
    setTracked(prev => {
      if (prev.some(t => t.pubkey === pubkey && t.serviceId === serviceId)) return prev;
      return [...prev, {
        pubkey,
        serviceId,
        latestEvent: null,
        serviceDef: null,
        decryptedPayload: null,
        lastChecked: Math.floor(Date.now() / 1000)
      }];
    });
  };

  const untrackService = (pubkey: string, serviceId: string) => {
    setTracked(prev => prev.filter(t => !(t.pubkey === pubkey && t.serviceId === serviceId)));
  };

  const isTracked = (pubkey: string, serviceId: string) => {
    return tracked.some(t => t.pubkey === pubkey && t.serviceId === serviceId);
  };

  const findTracked = (pubkey: string, serviceId: string) => {
    return tracked.find(t => t.pubkey === pubkey && t.serviceId === serviceId);
  };

  return (
    <TrackingContext.Provider value={{ tracked, trackService, untrackService, isTracked, findTracked, syncToNostr, restoreFromNostr }}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTracking() {
  const context = useContext(TrackingContext);
  if (!context) throw new Error('useTracking must be used within TrackingProvider');
  return context;
}