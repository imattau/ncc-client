import { createContext, useContext, useState, ReactNode } from 'react';
import { nip19, getPublicKey, nip44, finalizeEvent } from 'nostr-tools';
import { pool } from '../lib/pool';

// Types
export type LoginMethod = 'nip07' | 'nsec' | 'readonly' | 'nip46';

interface AuthState {
  pubkey: string | null;
  privkey: string | null; // Hex
  method: LoginMethod | null;
  isLoading: boolean;
  // NIP-46 session data
  bunkerPubkey?: string | null;
  bunkerRelay?: string | null;
  clientSecretKey?: string | null; // Hex
}

interface AuthContextType extends AuthState {
  loginWithNip07: () => Promise<void>;
  loginWithNsec: (nsec: string) => void;
  loginReadOnly: (npub: string) => void;
  loginWithNip46: (signerPubkey: string, relay: string, clientSecret: string) => void;
  signEvent: (event: any) => Promise<any>;
  decryptNip44: (senderPubkey: string, ciphertext: string) => Promise<string>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    pubkey: localStorage.getItem('ncc_pubkey'),
    privkey: sessionStorage.getItem('ncc_privkey'),
    method: (localStorage.getItem('ncc_method') as LoginMethod) || null,
    isLoading: false,
    bunkerPubkey: localStorage.getItem('ncc_bunker_pubkey'),
    bunkerRelay: localStorage.getItem('ncc_bunker_relay'),
    clientSecretKey: sessionStorage.getItem('ncc_client_secret'),
  });

  const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

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
        alert('Nostr extension not found!');
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

      if (nsecOrHex.startsWith('nsec')) {
        const { data } = nip19.decode(nsecOrHex);
        bytes = data as Uint8Array;
        hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        hex = nsecOrHex;
        bytes = hexToBytes(hex);
      }
      
      const pubkey = getPublicKey(bytes);
      setState({ pubkey, privkey: hex, method: 'nsec', isLoading: false });
      persist('nsec', pubkey, hex);
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

  const loginWithNip46 = (signerPubkey: string, relay: string, clientSecret: string) => {
      setState(prev => ({
          ...prev,
          pubkey: signerPubkey,
          method: 'nip46',
          bunkerPubkey: signerPubkey,
          bunkerRelay: relay,
          clientSecretKey: clientSecret,
          isLoading: false
      }));
      persist('nip46', signerPubkey, null, { bunkerPubkey: signerPubkey, bunkerRelay: relay, clientSecret });
  };

  const signEvent = async (event: any) => {
      if (state.method === 'nsec' && state.privkey) {
          return finalizeEvent(event, hexToBytes(state.privkey));
      }
      if (state.method === 'nip07' && window.nostr) {
          return window.nostr.signEvent(event);
      }
      if (state.method === 'nip46' && state.bunkerPubkey && state.bunkerRelay && state.clientSecretKey) {
          const secret = hexToBytes(state.clientSecretKey);
          const requestId = Math.random().toString(36).substring(7);
          const request = {
              id: requestId,
              method: 'sign_event',
              params: [JSON.stringify(event)]
          };

          const conversationKey = nip44.getConversationKey(secret, state.bunkerPubkey);
          const encrypted = nip44.encrypt(JSON.stringify(request), conversationKey);

          const reqEvent = finalizeEvent({
              kind: 24133,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', state.bunkerPubkey]],
              content: encrypted
          }, secret);

          await pool.publish([state.bunkerRelay], reqEvent);

          // Wait for response
          return new Promise((resolve, reject) => {
              const sub = pool.subscribeMany(
                  [state.bunkerRelay!],
                  [{ kinds: [24133], '#p': [getPublicKey(secret)], authors: [state.bunkerPubkey!] }] as any,
                  {
                      onevent(ev) {
                          try {
                              const dec = nip44.decrypt(ev.content, conversationKey);
                              const resp = JSON.parse(dec);
                              if (resp.id === requestId) {
                                  sub.close();
                                  if (resp.result) resolve(JSON.parse(resp.result));
                                  else reject(new Error(resp.error || "Remote signing failed"));
                              }
                          } catch (e) {}
                      }
                  }
              );
              // Timeout
              setTimeout(() => { sub.close(); reject(new Error("Remote signing timed out")); }, 30000);
          });
      }
      throw new Error("No signing method available");
  };

  const decryptNip44 = async (senderPubkey: string, ciphertext: string) => {
      if (state.method === 'nsec' && state.privkey) {
          const key = nip44.getConversationKey(hexToBytes(state.privkey), senderPubkey);
          return nip44.decrypt(ciphertext, key);
      }
      if (state.method === 'nip07' && window.nostr?.nip44) {
          return window.nostr.nip44.decrypt(senderPubkey, ciphertext);
      }
      if (state.method === 'nip46' && state.bunkerPubkey && state.bunkerRelay && state.clientSecretKey) {
          const secret = hexToBytes(state.clientSecretKey);
          const requestId = Math.random().toString(36).substring(7);
          const request = {
              id: requestId,
              method: 'nip44_decrypt',
              params: [senderPubkey, ciphertext]
          };

          const conversationKey = nip44.getConversationKey(secret, state.bunkerPubkey);
          const encrypted = nip44.encrypt(JSON.stringify(request), conversationKey);

          const reqEvent = finalizeEvent({
              kind: 24133,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', state.bunkerPubkey]],
              content: encrypted
          }, secret);

          await pool.publish([state.bunkerRelay], reqEvent);

          return new Promise<string>((resolve, reject) => {
              const sub = pool.subscribeMany(
                  [state.bunkerRelay!],
                  [{ kinds: [24133], '#p': [getPublicKey(secret)], authors: [state.bunkerPubkey!] }] as any,
                  {
                      onevent(ev) {
                          try {
                              const dec = nip44.decrypt(ev.content, conversationKey);
                              const resp = JSON.parse(dec);
                              if (resp.id === requestId) {
                                  sub.close();
                                  if (resp.result) resolve(resp.result);
                                  else reject(new Error(resp.error || "Remote decryption failed"));
                              }
                          } catch (e) {}
                      }
                  }
              );
              setTimeout(() => { sub.close(); reject(new Error("Remote decryption timed out")); }, 30000);
          });
      }
      throw new Error("No decryption method available");
  };

  const logout = () => {
    setState({ pubkey: null, privkey: null, method: null, isLoading: false, bunkerPubkey: null, bunkerRelay: null, clientSecretKey: null });
    localStorage.removeItem('ncc_pubkey');
    localStorage.removeItem('ncc_method');
    localStorage.removeItem('ncc_privkey'); 
    localStorage.removeItem('ncc_bunker_pubkey');
    localStorage.removeItem('ncc_bunker_relay');
    sessionStorage.removeItem('ncc_privkey');
    sessionStorage.removeItem('ncc_client_secret');
  };

  const persist = (method: LoginMethod, pubkey: string, privkey: string | null, extra?: any) => {
    localStorage.setItem('ncc_method', method);
    localStorage.setItem('ncc_pubkey', pubkey);
    if (privkey) {
        sessionStorage.setItem('ncc_privkey', privkey);
    } else {
        sessionStorage.removeItem('ncc_privkey');
    }

    if (method === 'nip46' && extra) {
        localStorage.setItem('ncc_bunker_pubkey', extra.bunkerPubkey);
        localStorage.setItem('ncc_bunker_relay', extra.bunkerRelay);
        sessionStorage.setItem('ncc_client_secret', extra.clientSecret);
    }
  };

  return (
    <AuthContext.Provider value={{ ...state, loginWithNip07, loginWithNsec, loginReadOnly, loginWithNip46, signEvent, decryptNip44, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

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