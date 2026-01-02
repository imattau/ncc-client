import { createContext, useContext, useMemo } from 'react';
import { SimplePool } from 'nostr-tools';
import { NCC05Resolver, NCC05Publisher } from 'ncc-05-js';
import { NCC02Resolver } from 'ncc-02-js';
import { pool } from '../lib/pool';
import { RelayManager } from '../lib/relays';

interface NCCContextType {
  ncc05Resolver: NCC05Resolver;
  ncc05Publisher: NCC05Publisher;
  ncc02Resolver: NCC02Resolver;
  pool: SimplePool;
}

const NCCContext = createContext<NCCContextType | undefined>(undefined);

export function NCCProvider({ children }: { children: React.ReactNode }) {
  
  const value = useMemo(() => {
    const bootstrap = RelayManager.load();

    // Global URL Transformer for NCC-05
    // Automatically wraps onion addresses in the bridge URL
    const urlTransformer = (ep: any) => {
        if (ep.url.includes('.onion') && !ep.url.includes('/bridge?target=')) {
            const originalUrl = ep.url;
            ep.url = `ws://${window.location.host}/bridge?target=${encodeURIComponent(originalUrl)}`;
            console.log(`[NCC-SDK] 🧅 Auto-Bridged Onion: ${originalUrl}`);
        }
        return ep;
    };

    // NCC-05 init
    const ncc05Resolver = new NCC05Resolver({ 
      pool, 
      bootstrapRelays: bootstrap,
      urlTransformer
    });
    
    const ncc05Publisher = new NCC05Publisher({ 
      pool,
      timeout: 5000 
    });

    // NCC-02 init
    const ncc02Resolver = new NCC02Resolver(bootstrap, {
       pool,
       // In the future, we can inject follows from WoT here
    });

    return {
      ncc05Resolver,
      ncc05Publisher,
      ncc02Resolver,
      pool
    };
  }, []);

  return (
    <NCCContext.Provider value={value}>
      {children}
    </NCCContext.Provider>
  );
}

export function useNCC() {
  const context = useContext(NCCContext);
  if (!context) throw new Error('useNCC must be used within NCCProvider');
  return context;
}
