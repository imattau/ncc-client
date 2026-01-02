import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { KeyRound, Eye, Wallet } from 'lucide-react';

export function Auth() {
  const { loginWithNip07, loginWithNsec, loginReadOnly, isLoading } = useAuth();
  const [inputKey, setInputKey] = useState('');
  const [mode, setMode] = useState<'options' | 'nsec' | 'readonly'>('options');

  if (isLoading) return <div className="loading loading-spinner loading-lg"></div>;

  return (
    <div className="card w-96 bg-base-100 shadow-xl border border-base-300">
      <div className="card-body">
        <h2 className="card-title justify-center mb-4">Nostr Login</h2>

        {mode === 'options' && (
          <div className="flex flex-col gap-3">
            <button 
              className="btn btn-primary w-full" 
              onClick={() => loginWithNip07()}
            >
              <Wallet className="w-4 h-4 mr-2" />
              Extension (NIP-07)
            </button>
            <button 
              className="btn btn-neutral w-full"
              onClick={() => setMode('nsec')}
            >
              <KeyRound className="w-4 h-4 mr-2" />
              Private Key (nsec)
            </button>
            <button 
              className="btn btn-ghost w-full"
              onClick={() => setMode('readonly')}
            >
              <Eye className="w-4 h-4 mr-2" />
              Read Only
            </button>
          </div>
        )}

        {(mode === 'nsec' || mode === 'readonly') && (
          <div className="flex flex-col gap-3">
            <div className="form-control">
              <label className="label">
                <span className="label-text">
                  {mode === 'nsec' ? 'Enter nsec / hex private key' : 'Enter npub / hex public key'}
                </span>
              </label>
              <input 
                type="text" 
                placeholder={mode === 'nsec' ? "nsec1..." : "npub1..."}
                className="input input-bordered w-full" 
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
              />
            </div>
            <div className="flex gap-2 mt-2">
               <button 
                className="btn btn-ghost flex-1"
                onClick={() => setMode('options')}
              >
                Back
              </button>
              <button 
                className="btn btn-success flex-1"
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
