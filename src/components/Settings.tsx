import { useState, useEffect } from 'react';
import { RelayManager, RelayHealth } from '../lib/relays';
import { useNCC } from '../context/NCCContext';
import { useAuth } from '../context/AuthContext';
import { Settings as SettingsIcon, Server, Shield, Trash2, Plus, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { nip19, nip44 } from 'nostr-tools';
import clsx from 'clsx';

export function Settings() {
    const { pool, ncc05Resolver } = useNCC();
    const { pubkey: sessionPubkey, privkey: sessionPrivkey, signEvent } = useAuth();
    const [relays, setRelays] = useState<string[]>(() => RelayManager.load());
    const [health, setHealth] = useState<Record<string, RelayHealth>>({});
    const [newRelay, setNewRelay] = useState('');
    const [isChecking, setIsChecking] = useState(false);
    const [isResolving, setIsResolving] = useState(false);
    const [resolveStatus, setResolveStatus] = useState<string | null>(null);
    const [pendingEndpoints, setPendingEndpoints] = useState<string[] | null>(null);

    const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);

    const checkHealth = async () => {
        setIsChecking(true);
        const results: Record<string, RelayHealth> = {};
        
        for (const url of relays) {
            try {
                // Feature detection: Query for a single NCC record to see if relay supports it
                const events = await pool.querySync([url], { kinds: [30058, 30059], limit: 1 });
                results[url] = {
                    url,
                    lastSeen: Date.now(),
                    status: 'online',
                    supportsNCC: events.length > 0
                };
            } catch (e) {
                results[url] = {
                    url,
                    lastSeen: Date.now(),
                    status: 'offline',
                    supportsNCC: false
                };
            }
        }
        setHealth(results);
        setIsChecking(false);
    };

    useEffect(() => {
        checkHealth();
    }, []);

    const handleAdd = async () => {
        console.log("[Settings] handleAdd called with:", newRelay);
        if (!newRelay) return;
        let input = newRelay.trim();
        
        // Handle npub resolution
        if (input.startsWith('npub')) {
            console.log("[Settings] Detected npub input, starting identity-centric resolution...");
            setIsResolving(true);
            setResolveStatus("Fetching authored records...");
            try {
                const { data: pubkey } = nip19.decode(input);
                const hex = pubkey as string;
                
                // Construct a NostrSigner-compatible object for the library
                const signer = {
                    getPublicKey: async () => sessionPubkey || '',
                    signEvent: async (ev: any) => signEvent(ev),
                    getConversationKey: async (peer: string) => {
                        if (!sessionPrivkey) throw new Error("Decryption requires NSEC or active remote signer");
                        return nip44.getConversationKey(hexToBytes(sessionPrivkey), peer);
                    }
                };

                // Use the library's new resolveLatest method (Identity-Centric)
                // It handles NIP-33, deduplication, and newest-record logic internally.
                setResolveStatus("Resolving latest locator...");
                const payload = await ncc05Resolver.resolveLatest(hex, sessionPrivkey ? sessionPrivkey : (signer as any));

                if (payload && payload.endpoints?.length > 0) {
                    setResolveStatus(null);
                    // Filter out any that were already bridged (transformer handles it, but let's be safe)
                    const endpoints = payload.endpoints.map((ep: any) => ep.url);
                    setPendingEndpoints(endpoints);
                } else {
                    // Fallback to NCC-02 public tags if no locator found
                    setResolveStatus("Checking public service records...");
                    const bootstrap = RelayManager.load();
                    const events = await pool.querySync(bootstrap, {
                        kinds: [30059],
                        authors: [hex],
                        limit: 10
                    });
                    
                    const freshest = events.sort((a, b) => b.created_at - a.created_at)[0];
                    const uTags = freshest?.tags.filter(t => t[0] === 'u').map(t => t[1]);

                    if (uTags && uTags.length > 0) {
                        setPendingEndpoints(uTags);
                    } else {
                        throw new Error("No valid infrastructure endpoints found for this identity.");
                    }
                }
            } catch (e: any) {
                console.error("[Settings] Resolution Error:", e);
                alert("Resolution failed: " + e.message);
            } finally {
                setIsResolving(false);
                setResolveStatus(null);
                checkHealth();
            }
            return;
        }

        let url = input;
        if (!url.startsWith('ws')) url = `wss://${url}`;
        RelayManager.add(url);
        setRelays(RelayManager.load());
        setNewRelay('');
        checkHealth();
    };

    const handleRemove = (url: string) => {
        RelayManager.remove(url);
        setRelays(RelayManager.load());
    };

    const handleRestore = () => {
        RelayManager.restoreDefaults();
        setRelays(RelayManager.load());
        checkHealth();
    };

    const confirmAdd = (url: string) => {
        let finalUrl = url;
        // Protocol normalization
        if (!finalUrl.includes('://')) {
            finalUrl = finalUrl.includes('.onion') ? `ws://${finalUrl}` : `wss://${finalUrl}`;
        }

        // ⚡️ Auto-Bridge Onion Addresses
        if (finalUrl.includes('.onion') && !finalUrl.includes('/bridge?target=')) {
            const originalUrl = finalUrl;
            finalUrl = `ws://${window.location.host}/bridge?target=${encodeURIComponent(originalUrl)}`;
            console.log(`[Settings] 🧅 Bridging: ${originalUrl} -> ${finalUrl}`);
        }
        
        RelayManager.add(finalUrl);
        setRelays(RelayManager.load());
        setPendingEndpoints(null);
        setNewRelay('');
        checkHealth();
    };

    const cancelAdd = () => {
        setPendingEndpoints(null);
        setNewRelay('');
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <SettingsIcon className="text-primary w-6 h-6" />
                    <h2 className="text-xl font-bold">Network Settings</h2>
                </div>
                <button 
                    className={clsx("btn btn-sm btn-ghost", isChecking && "loading")} 
                    onClick={checkHealth}
                    disabled={isChecking}
                >
                    <RefreshCw className="w-4 h-4 mr-2" /> Refresh Health
                </button>
            </div>

            {/* Bootstrap Relays Management */}
            <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body">
                    <h3 className="card-title text-sm opacity-70 uppercase mb-4 flex items-center gap-2">
                        <Server className="w-4 h-4" /> Bootstrap Relays
                    </h3>
                    
                    <div className="space-y-3">
                        {relays.map(url => {
                            const h = health[url];
                            return (
                                <div key={url} className="flex items-center justify-between p-3 bg-base-200/50 rounded-lg border border-base-300">
                                    <div className="flex flex-col min-w-0">
                                        <span className="font-mono text-xs font-bold truncate">{url}</span>
                                        <div className="flex items-center gap-2 mt-1">
                                            {h?.status === 'online' ? (
                                                <span className="badge badge-success badge-xs gap-1">
                                                    <CheckCircle2 className="w-2 h-2" /> Online
                                                </span>
                                            ) : h?.status === 'offline' ? (
                                                <span className="badge badge-error badge-xs gap-1">
                                                    <AlertTriangle className="w-2 h-2" /> Offline
                                                </span>
                                            ) : (
                                                <span className="badge badge-ghost badge-xs">Checking...</span>
                                            )}
                                            
                                            {h?.supportsNCC && (
                                                <span className="badge badge-primary badge-xs">NCC-Ready</span>
                                            )}
                                        </div>
                                    </div>
                                    <button 
                                        className="btn btn-ghost btn-xs text-error" 
                                        onClick={() => handleRemove(url)}
                                        title="Remove Relay"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>

                    {!pendingEndpoints ? (
                        <>
                            <div className="flex gap-2 mt-4">
                                <input 
                                    className="input input-bordered input-sm flex-1 font-mono text-xs" 
                                    placeholder="wss://... or npub1..."
                                    value={newRelay}
                                    onChange={e => setNewRelay(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleAdd()}
                                    disabled={isResolving}
                                />
                                <button className={clsx("btn btn-sm btn-primary", isResolving && "loading")} onClick={handleAdd} disabled={isResolving || !newRelay}>
                                    {isResolving ? 'Resolving...' : <><Plus className="w-4 h-4 mr-1" /> Add</>}
                                </button>
                            </div>
                            {resolveStatus && (
                                <div className="flex items-center gap-2 mt-2 px-1 text-[10px] text-primary animate-pulse font-bold">
                                    <RefreshCw className="w-3 h-3 animate-spin" />
                                    {resolveStatus}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="mt-4 p-4 bg-base-200 rounded-box border border-primary/20 fade-in">
                            <div className="flex items-center justify-between mb-3">
                                <h4 className="text-xs font-bold uppercase opacity-70">Discovered Endpoints</h4>
                                <button className="btn btn-xs btn-ghost" onClick={cancelAdd}>Cancel</button>
                            </div>
                            <div className="space-y-2">
                                {pendingEndpoints.map((url, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 bg-base-100 rounded border border-base-300">
                                        <span className="text-[10px] font-mono truncate flex-1 pr-2">{url}</span>
                                        <button className="btn btn-xs btn-primary" onClick={() => confirmAdd(url)}>Add This</button>
                                    </div>
                                ))}
                            </div>
                            <p className="text-[9px] opacity-50 mt-3 italic">Select an endpoint above to add it to your bootstrap list. Onion addresses will be automatically bridged.</p>
                        </div>
                    )}
                    
                    <div className="card-actions justify-start mt-2">
                        <button className="btn btn-link btn-xs opacity-50" onClick={handleRestore}>Restore Default Relays</button>
                    </div>
                </div>
            </div>

            {/* Protocol Security Section */}
            <div className="card bg-base-100 shadow-sm border border-base-200">
                <div className="card-body">
                    <h3 className="card-title text-sm opacity-70 uppercase mb-4 flex items-center gap-2">
                        <Shield className="w-4 h-4" /> Security & Protocol
                    </h3>
                    
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-bold">NCC Protocol Version</p>
                                <p className="text-xs opacity-50">Current supported schema version</p>
                            </div>
                            <div className="badge badge-neutral">v1.0</div>
                        </div>

                        <div className="alert alert-info py-2 text-[10px] leading-tight">
                            <RefreshCw className="w-3 h-3 flex-shrink-0" />
                            <span>Discovery currently prioritizes relays with the <b>NCC-Ready</b> badge. These relays have recently returned valid NCC events.</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
