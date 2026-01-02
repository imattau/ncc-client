import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { nip19, getPublicKey } from 'nostr-tools';

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
      // Simple retry to wait for injection
      let attempts = 0;
      while (typeof window.nostr === 'undefined' && attempts < 10) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
      }

      if (typeof window.nostr === 'undefined') {
        alert('Nostr extension not found! Make sure you have Alby, nos2x, or similar installed.');
        setState(prev => ({ ...prev, isLoading: false }));
        return;
      }
      
      const pubkey = await window.nostr.getPublicKey();
      setState({ pubkey, privkey: null, method: 'nip07', isLoading: false });
      persist('nip07', pubkey, null);
    } catch (e: any) {
      console.error("NIP-07 Login Error:", e);
      alert('Login failed: ' + (e.message || "Unknown error"));
      setState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const loginWithNsec = (nsecOrHex: string) => {
    try {
      let hex = nsecOrHex;
      let bytes: Uint8Array;

      // Helper to convert hex string to Uint8Array
      const hexToBytes = (hexString: string) => 
        Uint8Array.from(hexString.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

      // Helper to convert Uint8Array to hex string
      const bytesToHex = (uint8: Uint8Array) =>
        Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');

      if (nsecOrHex.startsWith('nsec')) {
        const { data } = nip19.decode(nsecOrHex);
        // data is Uint8Array in modern nostr-tools
        if (data instanceof Uint8Array) {
            bytes = data;
            hex = bytesToHex(data);
        } else {
            // fallback for older versions or if it returns string
            hex = data as string;
            bytes = hexToBytes(hex);
        }
      } else {
        // Assume raw hex input
        bytes = hexToBytes(hex);
      }
      
      const pubkey = getPublicKey(bytes);
      setState({ pubkey, privkey: hex, method: 'nsec', isLoading: false });
      persist('nsec', pubkey, hex);
    } catch (e) {
      console.error(e);
      alert('Invalid Private Key: ' + (e as Error).message);
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