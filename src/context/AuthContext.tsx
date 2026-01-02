import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { nip19 } from 'nostr-tools';

// Types
export type LoginMethod = 'nip07' | 'nsec' | 'readonly';

interface AuthState {
  pubkey: string | null;
  privkey: string | null; // Hex
  method: LoginMethod | null;
  isLoading: boolean;
}

interface AuthContextType extends AuthState {
  loginWithNip07: () => Promise<void>;
  loginWithNsec: (nsec: string) => void;
  loginReadOnly: (npub: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    pubkey: localStorage.getItem('ncc_pubkey'),
    privkey: localStorage.getItem('ncc_privkey'),
    method: (localStorage.getItem('ncc_method') as LoginMethod) || null,
    isLoading: false,
  });

  useEffect(() => {
    // Attempt auto-login for NIP-07 if previously used
    if (state.method === 'nip07' && !state.pubkey) {
      // Wait a bit for extension to load
      setTimeout(() => loginWithNip07(), 500);
    }
  }, []);

  const loginWithNip07 = async () => {
    setState(prev => ({ ...prev, isLoading: true }));
    try {
      if (typeof window.nostr === 'undefined') {
        alert('Nostr extension not found!');
        return;
      }
      const pubkey = await window.nostr.getPublicKey();
      setState({ pubkey, privkey: null, method: 'nip07', isLoading: false });
      persist('nip07', pubkey, null);
    } catch (e) {
      console.error(e);
      alert('Login failed');
      setState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const loginWithNsec = (nsecOrHex: string) => {
    try {
      let hex = nsecOrHex;
      if (nsecOrHex.startsWith('nsec')) {
        const { data } = nip19.decode(nsecOrHex);
        hex = data as string;
      }
      // TODO: Derive pubkey from private key (need library helper or curve calc)
      // nostr-tools v2 split this out. Let's assume user provides valid key for now
      // or import getPublicKey from nostr-tools
      import('nostr-tools').then(({ getPublicKey }) => {
          // hexToBytes is usually in @noble/hashes/utils or exported by nostr-tools depending on version.
          // nostr-tools v2 exports it directly often? Let's check imports.
          // Actually, let's just use a simple hexToBytes function or import it.
          // checking nostr-tools exports... let's assume it has a utility or use a custom one.
          const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
          
          const pubkey = getPublicKey(hexToBytes(hex));
          setState({ pubkey, privkey: hex, method: 'nsec', isLoading: false });
          persist('nsec', pubkey, hex);
      });
    } catch (e) {
      alert('Invalid Private Key');
    }
  };

  const loginReadOnly = (npubOrHex: string) => {
     try {
      let hex = npubOrHex;
      if (npubOrHex.startsWith('npub')) {
        const { data } = nip19.decode(npubOrHex);
        hex = data as string;
      }
      setState({ pubkey: hex, privkey: null, method: 'readonly', isLoading: false });
      persist('readonly', hex, null);
     } catch(e) {
         alert('Invalid Public Key');
     }
  }

  const logout = () => {
    setState({ pubkey: null, privkey: null, method: null, isLoading: false });
    localStorage.removeItem('ncc_pubkey');
    localStorage.removeItem('ncc_privkey');
    localStorage.removeItem('ncc_method');
  };

  const persist = (method: LoginMethod, pubkey: string, privkey: string | null) => {
    localStorage.setItem('ncc_method', method);
    localStorage.setItem('ncc_pubkey', pubkey);
    if (privkey) localStorage.setItem('ncc_privkey', privkey);
  };

  return (
    <AuthContext.Provider value={{ ...state, loginWithNip07, loginWithNsec, loginReadOnly, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};

// Add window type
declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: any) => Promise<any>;
      nip44?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
    };
  }
}
