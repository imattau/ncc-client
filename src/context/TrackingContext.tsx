import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useNCC } from './NCCContext';
import { DEFAULT_RELAYS } from '../lib/relays';
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
}

const TrackingContext = createContext<TrackingContextType | undefined>(undefined);

export function TrackingProvider({ children }: { children: ReactNode }) {
  const { pool } = useNCC();
  const { privkey } = useAuth(); // Only auto-decrypt if we have privkey (NSEC)
  const [tracked, setTracked] = useState<TrackedService[]>(() => {
    const saved = localStorage.getItem('ncc_tracked_services');
    return saved ? JSON.parse(saved) : [];
  });

  // Persist
  useEffect(() => {
    localStorage.setItem('ncc_tracked_services', JSON.stringify(tracked));
  }, [tracked]);

  // Active Monitoring Subscription
  useEffect(() => {
    if (tracked.length === 0) return;

    const authors = [...new Set(tracked.map(t => t.pubkey))];
    
    // Subscribe to updates
    const sub = pool.subscribeMany(
      DEFAULT_RELAYS,
      [{ kinds: [30058, 30059], authors: authors }] as any,
      {
        onevent(ev) {
          handleEvent(ev);
        }
      }
    );

    return () => {
      sub.close();
    };
  }, [tracked.length]); // Re-sub if list changes (simple approach)

  const handleEvent = async (ev: any) => {
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
                   // hexToBytes helper
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
  };

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

  return (
    <TrackingContext.Provider value={{ tracked, trackService, untrackService, isTracked }}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTracking() {
  const context = useContext(TrackingContext);
  if (!context) throw new Error('useTracking must be used within TrackingProvider');
  return context;
}
