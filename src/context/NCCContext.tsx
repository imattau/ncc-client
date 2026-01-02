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
    // NCC-05 init - strictly use bootstrap relays only
    const ncc05Resolver = new NCC05Resolver({ 
      pool, 
      bootstrapRelays: bootstrap,
      // Note: If the library supports a 'gossip: false' global toggle, we'd set it here.
      // Since it's passed in resolve() options, we ensure the UI call respects it.
    });
    
    const ncc05Publisher = new NCC05Publisher({ 
      pool,
      timeout: 5000 
    });

    // NCC-02 init - strictly use bootstrap relays only
    const ncc02Resolver = new NCC02Resolver(bootstrap, {
       pool
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
