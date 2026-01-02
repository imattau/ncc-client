import { createContext, useContext, useState, ReactNode } from 'react';

interface DiscoveryState {
  pubkeyInput: string;
  setPubkeyInput: (v: string) => void;
  serviceId: string;
  setServiceId: (v: string) => void;
  step: 'idle' | 'verifying' | 'resolving' | 'complete';
  setStep: (v: 'idle' | 'verifying' | 'resolving' | 'complete') => void;
  logs: string[];
  addLog: (msg: string) => void;
  clearLogs: () => void;
  error: string | null;
  setError: (v: string | null) => void;
  resolvedEndpoint: any;
  setResolvedEndpoint: (v: any) => void;
  rawEvents: any[];
  setRawEvents: (v: any[]) => void;
  profiles: Record<string, any>;
  setProfiles: (v: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>)) => void;
  decryptedPayloads: Record<string, any>;
  setDecryptedPayloads: (v: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>)) => void;
  showExpired: boolean;
  setShowExpired: (v: boolean) => void;
  attestedIds: string[];
  setAttestedIds: (v: string[] | ((prev: string[]) => string[])) => void;
}

const DiscoveryContext = createContext<DiscoveryState | undefined>(undefined);

export function DiscoveryProvider({ children }: { children: ReactNode }) {
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [step, setStep] = useState<'idle' | 'verifying' | 'resolving' | 'complete'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolvedEndpoint, setResolvedEndpoint] = useState<any>(null);
  const [rawEvents, setRawEvents] = useState<any[]>([]);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [decryptedPayloads, setDecryptedPayloads] = useState<Record<string, any>>({});
  const [showExpired, setShowExpired] = useState(false);
  const [attestedIds, setAttestedIds] = useState<string[]>([]);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg]);
  const clearLogs = () => setLogs([]);

  const value = {
    pubkeyInput, setPubkeyInput,
    serviceId, setServiceId,
    step, setStep,
    logs, addLog, clearLogs,
    error, setError,
    resolvedEndpoint, setResolvedEndpoint,
    rawEvents, setRawEvents,
    profiles, setProfiles,
    decryptedPayloads, setDecryptedPayloads,
    showExpired, setShowExpired,
    attestedIds, setAttestedIds
  };

  return (
    <DiscoveryContext.Provider value={value}>
      {children}
    </DiscoveryContext.Provider>
  );
}

export function useDiscovery() {
  const context = useContext(DiscoveryContext);
  if (!context) throw new Error('useDiscovery must be used within DiscoveryProvider');
  return context;
}
