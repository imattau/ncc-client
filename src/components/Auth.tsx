import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { KeyRound, Eye, Wallet, Cpu, RefreshCw } from 'lucide-react';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import { QRCodeCanvas } from 'qrcode.react';
import { useNCC } from '../context/NCCContext';
import { RelayManager } from '../lib/relays';

export function Auth() {
  const { loginWithNip07, loginWithNsec, loginReadOnly, loginWithNip46, isLoading } = useAuth();
  const { pool } = useNCC();
  const [inputKey, setInputKey] = useState('');
  const [mode, setMode] = useState<'options' | 'nsec' | 'readonly' | 'nip46'>('options');
  
  // NIP-46 State
  const [connectionUri, setConnectionUri] = useState('');
  const [nip46Step, setNip46Step] = useState<'generate' | 'wait'>('generate');
  const subRef = useRef<any>(null);

  const bytesToHex = (uint8: Uint8Array) => Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');

  const generateNip46Uri = () => {
      const secret = generateSecretKey();
      const pubkey = getPublicKey(secret);
      const relay = RelayManager.load()[0] || 'wss://relay.damus.io';
      const metadata = encodeURIComponent(JSON.stringify({ name: 'NCC Client PoC' }));
      
      const uri = `nostrconnect://${pubkey}?relay=${encodeURIComponent(relay)}&metadata=${metadata}`;
      
      setConnectionUri(uri);
      setNip46Step('wait');
      startNip46Listener(pubkey, relay, secret);
  };

  const startNip46Listener = (clientPubkey: string, relay: string, secret: Uint8Array) => {
      if (subRef.current) subRef.current.close();

      console.log("[NIP-46] Listening for responses on", relay);
      
      subRef.current = pool.subscribeMany(
          [relay],
          [{ kinds: [24133], '#p': [clientPubkey] }] as any,
          {
              onevent(event) {
                  try {
                      // NIP-46 messages are encrypted via NIP-04/44 (standard specifies NIP-04 but NIP-44 is preferred now)
                      // Most current impls use NIP-04, but let's check content
                      const conversationKey = nip44.getConversationKey(secret, event.pubkey);
                      const decrypted = nip44.decrypt(event.content, conversationKey);
                      const response = JSON.parse(decrypted);

                      if (response.result === 'ack' || response.method === 'connect') {
                          console.log("[NIP-46] Connection Established with", event.pubkey);
                          loginWithNip46(event.pubkey, relay, bytesToHex(secret));
                      }
                  } catch (e) {
                      console.error("[NIP-46] Decryption failed (might be NIP-04, not supported yet in this PoC)", e);
                  }
              }
          }
      );
  };

  useEffect(() => {
      return () => {
          if (subRef.current) subRef.current.close();
      };
  }, []);

  if (isLoading) return <div className="loading loading-spinner loading-lg"></div>;

  return (
    <div className="card w-96 bg-base-100 shadow-xl border border-base-300">
      <div className="card-body p-6">
        <h2 className="card-title justify-center mb-6 font-bold text-xl">NCC Login</h2>

        {mode === 'options' && (
          <div className="flex flex-col gap-3">
            <button 
              className="btn btn-primary w-full shadow-md" 
              onClick={() => loginWithNip07()}
            >
              <Wallet className="w-4 h-4 mr-2" />
              Extension (NIP-07)
            </button>
            <button 
              className="btn btn-secondary w-full shadow-md" 
              onClick={() => setMode('nip46')}
            >
              <Cpu className="w-4 h-4 mr-2" />
              Nostr Connect (NIP-46)
            </button>
            <div className="divider text-[10px] opacity-30 uppercase tracking-widest">Legacy / Read Only</div>
            <button 
              className="btn btn-neutral btn-sm w-full"
              onClick={() => setMode('nsec')}
            >
              <KeyRound className="w-4 h-4 mr-2" />
              Private Key (nsec)
            </button>
            <button 
              className="btn btn-ghost btn-sm w-full opacity-60"
              onClick={() => setMode('readonly')}
            >
              <Eye className="w-4 h-4 mr-2" />
              Read Only (Watch)
            </button>
          </div>
        )}

        {mode === 'nip46' && (
            <div className="flex flex-col items-center gap-4 fade-in text-center">
                {nip46Step === 'generate' ? (
                    <>
                        <Cpu className="w-12 h-12 text-secondary mb-2" />
                        <h3 className="font-bold">Connect Remotely</h3>
                        <p className="text-xs opacity-60 px-4">Sign events using a mobile app (Amber, etc.) or a dedicated Bunker.</p>
                        <button className="btn btn-secondary w-full mt-4" onClick={generateNip46Uri}>
                            Generate Connection QR
                        </button>
                    </>
                ) : (
                    <div className="space-y-4">
                        <div className="bg-white p-4 rounded-xl shadow-inner border-4 border-base-200 inline-block">
                            <QRCodeCanvas value={connectionUri} size={200} />
                        </div>
                        <div className="flex flex-col gap-1 items-center">
                            <div className="flex items-center gap-2 text-primary font-bold animate-pulse">
                                <RefreshCw className="w-3 h-3 animate-spin" />
                                <span className="text-xs">Waiting for signer...</span>
                            </div>
                            <p className="text-[10px] opacity-50 px-6">Scan this QR with your Nostr signing app. Once scanned, the connection will be established automatically.</p>
                        </div>
                        <button className="btn btn-ghost btn-xs opacity-50" onClick={() => { setNip46Step('generate'); subRef.current?.close(); }}>
                            Reset Connection
                        </button>
                    </div>
                )}
                
                <button className="btn btn-ghost btn-sm w-full mt-2" onClick={() => setMode('options')}>
                    Back to Login Options
                </button>
            </div>
        )}

        {(mode === 'nsec' || mode === 'readonly') && (
          <div className="flex flex-col gap-3 fade-in">
            <div className="form-control">
              <label className="label text-xs uppercase opacity-50 font-bold">
                <span className="label-text">
                  {mode === 'nsec' ? 'Enter nsec / hex private key' : 'Enter npub / hex public key'}
                </span>
              </label>
              <input 
                type="password" 
                placeholder={mode === 'nsec' ? "nsec1..." : "npub1..."}
                className="input input-bordered w-full font-mono text-xs" 
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
              />
            </div>
            <div className="flex gap-2 mt-4">
               <button 
                className="btn btn-ghost flex-1 btn-sm"
                onClick={() => setMode('options')}
              >
                Back
              </button>
              <button 
                className="btn btn-success flex-1 btn-sm"
                onClick={() => mode === 'nsec' ? loginWithNsec(inputKey) : loginReadOnly(inputKey)}
              >
                Login
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
