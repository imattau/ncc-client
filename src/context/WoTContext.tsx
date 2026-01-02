import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useNCC } from './NCCContext';
import { RelayManager } from '../lib/relays';

interface WoTContextType {
  follows: string[];
  isFollowing: (pubkey: string) => boolean;
  refreshFollows: () => Promise<void>;
  loading: boolean;
}

const WoTContext = createContext<WoTContextType | undefined>(undefined);

export function WoTProvider({ children }: { children: ReactNode }) {
  const { pubkey } = useAuth();
  const { pool } = useNCC();
  const [follows, setFollows] = useState<string[]>(() => {
      const saved = localStorage.getItem('ncc_wot_follows');
      return saved ? JSON.parse(saved) : [];
  });
  const [loading, setLoading] = useState(false);

  const refreshFollows = async () => {
    if (!pubkey) return;
    setLoading(true);
    try {
      // Fetch Kind 3 (Contact List)
      const event = await pool.get(RelayManager.load(), {
        kinds: [3],
        authors: [pubkey]
      });

      if (event) {
        const followList = [
          pubkey, // Include self
          ...event.tags
            .filter((t: any) => t[0] === 'p')
            .map((t: any) => t[1])
        ];
        
        setFollows(followList);
        localStorage.setItem('ncc_wot_follows', JSON.stringify(followList));
      } else {
        // If no follow list exists, at least include self
        setFollows([pubkey]);
        localStorage.setItem('ncc_wot_follows', JSON.stringify([pubkey]));
      }
    } catch (e) {
      console.error("Failed to fetch WoT", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (pubkey) {
        setFollows(prev => prev.includes(pubkey) ? prev : [pubkey, ...prev]);
        refreshFollows();
    } else {
        setFollows([]);
        localStorage.removeItem('ncc_wot_follows');
    }
  }, [pubkey]);

  const isFollowing = (pk: string) => follows.includes(pk);

  return (
    <WoTContext.Provider value={{ follows, isFollowing, refreshFollows, loading }}>
      {children}
    </WoTContext.Provider>
  );
}

export function useWoT() {
  const context = useContext(WoTContext);
  if (!context) throw new Error('useWoT must be used within WoTProvider');
  return context;
}
