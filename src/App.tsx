import { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NCCProvider } from './context/NCCContext';
import { Auth } from './components/Auth';
import { ServiceResolver } from './components/ServiceResolver';
import { ServicePublisher } from './components/ServicePublisher';
import { TrustExplorer } from './components/TrustExplorer';
import { Globe, LogOut } from 'lucide-react';
import clsx from 'clsx';

function Main() {
  const { pubkey, logout, method } = useAuth();
  const [activeTab, setActiveTab] = useState<'resolve' | 'publish' | 'trust'>('resolve');

  if (!pubkey) {
    return (
      <div className="min-h-screen bg-base-200 flex items-center justify-center p-4">
        <Auth />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base-200">
      {/* Navbar */}
      <div className="navbar bg-base-100 shadow-sm px-4">
        <div className="flex-1">
          <a className="btn btn-ghost text-xl gap-2">
            <Globe className="text-primary" />
            NCC Client <span className="text-xs opacity-50 font-normal">PoC</span>
          </a>
        </div>
        <div className="flex-none gap-4">
          <div className="flex flex-col items-end text-xs hidden sm:flex">
             <span className="opacity-70">{method === 'readonly' ? 'Read Only' : 'Authenticated'}</span>
             <span className="font-mono">{pubkey.slice(0, 8)}...{pubkey.slice(-4)}</span>
          </div>
          <button className="btn btn-ghost btn-circle" onClick={logout} title="Logout">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto p-4 max-w-4xl">
        
        {/* Tabs */}
        <div role="tablist" className="tabs tabs-boxed mb-6 bg-base-100 p-2">
          <a 
            role="tab" 
            className={clsx("tab", activeTab === 'resolve' && "tab-active")}
            onClick={() => setActiveTab('resolve')}
          >
            Service Discovery (NCC-05)
          </a>
          <a 
            role="tab" 
            className={clsx("tab", activeTab === 'publish' && "tab-active")}
            onClick={() => setActiveTab('publish')}
          >
            Publish Service
          </a>
          <a 
             role="tab" 
             className={clsx("tab", activeTab === 'trust' && "tab-active")}
             onClick={() => setActiveTab('trust')}
          >
            Trust Explorer (NCC-02)
          </a>
        </div>

        {/* Views */}
        <div className="fade-in">
          {activeTab === 'resolve' && <ServiceResolver />}
          {activeTab === 'publish' && (
             method === 'readonly' 
             ? <div className="alert">Read-only users cannot publish. Please login with NIP-07 or Private Key.</div>
             : <ServicePublisher />
          )}
          {activeTab === 'trust' && <TrustExplorer />}
        </div>

      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <NCCProvider>
        <Main />
      </NCCProvider>
    </AuthProvider>
  )
}

export default App
