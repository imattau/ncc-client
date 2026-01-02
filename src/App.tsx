import { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NCCProvider } from './context/NCCContext';
import { Auth } from './components/Auth';
import { Discovery } from './components/Discovery';
import { Feed } from './components/Feed';
import { ServicePublisher } from './components/ServicePublisher';
import { TrustExplorer } from './components/TrustExplorer';
import { Inventory } from './components/Inventory';
import { Settings } from './components/Settings';
import { Globe, LogOut, Radio } from 'lucide-react';
import clsx from 'clsx';

import { useTracking } from './context/TrackingContext';
import { useEffect } from 'react';

interface ActiveService {
  pubkey: string;
  serviceId: string;
}

function Main() {
  const { pubkey, logout, method } = useAuth();
  const { tracked, findTracked } = useTracking();
  const [activeTab, setActiveTab] = useState<'discovery' | 'feed' | 'publish' | 'trust' | 'inventory' | 'settings'>('discovery');
  const [activeRelay, setActiveRelay] = useState<string | null>(() => localStorage.getItem('ncc_active_relay'));
  const [currentService, setCurrentService] = useState<ActiveService | null>(() => {
      const saved = localStorage.getItem('ncc_active_service');
      return saved ? JSON.parse(saved) : null;
  });
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);

  // Monitor Bridge Status
  useEffect(() => {
      const checkBridge = async () => {
          try {
              const ws = new WebSocket(`ws://${window.location.host}/bridge?target=internal-ping`);
              const timer = setTimeout(() => ws.close(), 2000);
              ws.onopen = () => { clearTimeout(timer); setBridgeOnline(true); ws.close(); };
              ws.onerror = () => { clearTimeout(timer); setBridgeOnline(false); };
          } catch (e) { setBridgeOnline(false); }
      };
      checkBridge();
      const interval = setInterval(checkBridge, 30000);
      return () => clearInterval(interval);
  }, []);

  const handleConnect = (url: string, serviceInfo?: { pubkey: string, id: string }) => {
    setActiveRelay(url);
    localStorage.setItem('ncc_active_relay', url);
    if (serviceInfo) {
        const info = { pubkey: serviceInfo.pubkey, serviceId: serviceInfo.id };
        setCurrentService(info);
        localStorage.setItem('ncc_active_service', JSON.stringify(info));
    }
    setActiveTab('feed');
  };

  const handleLogout = () => {
    logout();
    setActiveRelay(null);
    setCurrentService(null);
    localStorage.removeItem('ncc_active_relay');
    localStorage.removeItem('ncc_active_service');
  };

  // Monitor for updates to the current active service
  useEffect(() => {
      if (!currentService || !activeRelay) return;

      const trackedInfo = findTracked(currentService.pubkey, currentService.serviceId);
      if (!trackedInfo) return;

      // Logic to determine if we should update activeRelay
      // Check NCC-05 Decrypted Payload for endpoints
      let endpoints = trackedInfo.decryptedPayload?.endpoints;
      
      if (!endpoints && trackedInfo.latestEvent?.content.startsWith('{')) {
          try {
              endpoints = JSON.parse(trackedInfo.latestEvent.content).endpoints;
          } catch (e) {
              console.error("Failed to parse NCC-05 content", e);
          }
      }
      
      if (endpoints && endpoints.length > 0) {
          // Sort by priority and get best
          const best = [...endpoints].sort((a, b) => a.priority - b.priority)[0];
          let newUrl = best.url || best.uri;
          
          // Protocol normalization
          if (!newUrl.includes('://')) {
              newUrl = newUrl.includes('.onion') ? `ws://${newUrl}` : `wss://${newUrl}`;
          }
          if (newUrl.startsWith('http')) newUrl = newUrl.replace('http', 'ws');

          // If the URL has changed, update it!
          // We need to be careful with Bridged URLs vs Direct URLs.
          // For now, if it's an onion and we are currently using a bridge, we re-bridge it.
          if (activeRelay.includes('/bridge?target=')) {
              const currentTarget = decodeURIComponent(new URL(activeRelay).searchParams.get('target') || '');
              if (newUrl !== currentTarget) {
                  const bridgeUrl = `ws://${window.location.host}/bridge?target=${encodeURIComponent(newUrl)}`;
                  console.log(`🚀 NCC Auto-Update: Relay endpoint changed from ${currentTarget} to ${newUrl} (via Bridge)`);
                  setActiveRelay(bridgeUrl);
                  localStorage.setItem('ncc_active_relay', bridgeUrl);
              }
          } else if (newUrl !== activeRelay) {
              console.log(`🚀 NCC Auto-Update: Relay endpoint changed from ${activeRelay} to ${newUrl}`);
              setActiveRelay(newUrl);
              localStorage.setItem('ncc_active_relay', newUrl);
          }
      }
  }, [tracked, currentService, activeRelay]);

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
           <div className={`badge badge-sm gap-1 hidden sm:flex ${bridgeOnline === true ? 'badge-success' : bridgeOnline === false ? 'badge-error' : 'badge-ghost'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${bridgeOnline === true ? 'bg-success-content animate-pulse' : 'bg-base-content opacity-30'}`}></div>
              {bridgeOnline === true ? 'Bridge' : 'Bridge Offline'}
           </div>
           {activeRelay && (
              <div className="badge badge-success gap-2 hidden sm:flex">
                 <Radio className="w-3 h-3" />
                 {activeRelay.includes('target=') ? 'Bridged Onion' : activeRelay}
              </div>
           )}
          <div className="flex flex-col items-end text-xs hidden sm:flex">
             <span className="opacity-70">{method === 'readonly' ? 'Read Only' : 'Authenticated'}</span>
             <span className="font-mono">{pubkey.slice(0, 8)}...{pubkey.slice(-4)}</span>
          </div>
          <button className="btn btn-ghost btn-circle" onClick={handleLogout} title="Logout">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto p-4 max-w-4xl">
        
        {/* Tabs */}
        <div role="tablist" className="tabs tabs-boxed mb-6 bg-base-100 p-2 overflow-x-auto flex-nowrap">
          <a 
            role="tab" 
            className={clsx("tab", activeTab === 'discovery' && "tab-active")}
            onClick={() => setActiveTab('discovery')}
          >
            Discovery (02+05)
          </a>
          <a 
            role="tab" 
            className={clsx("tab", activeTab === 'feed' && "tab-active")}
            onClick={() => setActiveTab('feed')}
          >
            Feed {activeRelay && '🟢'}
          </a>
          <a 
            role="tab" 
            className={clsx("tab", activeTab === 'publish' && "tab-active")}
            onClick={() => setActiveTab('publish')}
          >
            Publish
          </a>
          <a 
             role="tab" 
             className={clsx("tab", activeTab === 'trust' && "tab-active")}
             onClick={() => setActiveTab('trust')}
          >
            Trust Explorer
          </a>
          <a 
             role="tab" 
             className={clsx("tab", activeTab === 'inventory' && "tab-active")}
             onClick={() => setActiveTab('inventory')}
          >
            My Inventory
          </a>
          <a 
             role="tab" 
             className={clsx("tab", activeTab === 'settings' && "tab-active")}
             onClick={() => setActiveTab('settings')}
          >
            Settings
          </a>
        </div>

        {/* Views */}
        <div className="fade-in">
          {activeTab === 'discovery' && <Discovery onConnect={handleConnect} />}
          {activeTab === 'feed' && <Feed relayUrl={activeRelay} />}
          {activeTab === 'publish' && (
             method === 'readonly' 
             ? <div className="alert">Read-only users cannot publish. Please login with NIP-07 or Private Key.</div>
             : <ServicePublisher />
          )}
          {activeTab === 'trust' && <TrustExplorer />}
          {activeTab === 'inventory' && <Inventory />}
          {activeTab === 'settings' && <Settings />}
        </div>

      </div>
    </div>
  );
}

import { TrackingProvider } from './context/TrackingContext';
import { DiscoveryProvider } from './context/DiscoveryContext';
import { WoTProvider } from './context/WoTContext';

function App() {
  return (
    <AuthProvider>
      <NCCProvider>
        <WoTProvider>
          <TrackingProvider>
            <DiscoveryProvider>
              <Main />
            </DiscoveryProvider>
          </TrackingProvider>
        </WoTProvider>
      </NCCProvider>
    </AuthProvider>
  )
}

export default App
