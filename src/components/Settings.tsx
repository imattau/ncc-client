import { useState, useEffect } from 'react';
import { RelayManager, RelayHealth } from '../lib/relays';
import { useNCC } from '../context/NCCContext';
import { useAuth } from '../context/AuthContext';
import { Settings as SettingsIcon, Server, Shield, Trash2, Plus, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { nip19, nip44 } from 'nostr-tools';
import clsx from 'clsx';

export function Settings() {
    const { pool } = useNCC();
    const { privkey: sessionPrivkey } = useAuth();
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
            console.log("[Settings] Detected npub input, starting resolution...");
            setIsResolving(true);
            setResolveStatus("Fetching records...");
            try {
                const { data: pubkey } = nip19.decode(input);
                const hex = pubkey as string;
                console.log("[Settings] Decoded npub hex:", hex);
                
                // 1. Fetch all NCC records + Profile for this pubkey
                const bootstrap = RelayManager.load();
                console.log("[Settings] Querying bootstrap relays for identity:", hex);
                const events = await pool.querySync(bootstrap, {
                    kinds: [0, 30058, 30059],
                    authors: [hex]
                });

                console.log("[Settings] Found events:", events.length);

                if (events.length === 0) {
                    throw new Error("No NCC records found for this npub on the current bootstrap relays.");
                }

                // Sort everything by freshness (newest first)
                const sortedEvents = [...events].sort((a, b) => b.created_at - a.created_at);
                
                // 2. Find the single freshest record with endpoints (ignoring expired)
                setResolveStatus("Analyzing latest records...");
                let discovered: string[] = [];
                const now = Math.floor(Date.now() / 1000);
                
                for (const ev of sortedEvents) {
                    console.log(`[Settings] Probing record ${ev.id.slice(0,8)} (Kind ${ev.kind})...`);
                    
                    // CASE A: NCC-02 Service Record with public endpoint
                    if (ev.kind === 30059) {
                        const expTag = ev.tags.find(t => t[0] === 'exp');
                        if (expTag && parseInt(expTag[1]) < now) {
                            console.log("[Settings] Record is expired (NCC-02), skipping.");
                            continue;
                        }

                        const uTags = ev.tags.filter(t => t[0] === 'u');
                        if (uTags.length > 0) {
                            discovered = uTags.map(t => t[1]);
                            console.log("[Settings] Found freshest endpoints in public NCC-02");
                            break; // Stop! We found the freshest valid source.
                        }
                    }

                    // CASE B: NCC-05 Locator (might be encrypted)
                    if (ev.kind === 30058) {
                        try {
                            const isEncrypted = !ev.content.trim().startsWith('{');
                            let payload: any = null;

                            if (isEncrypted) {
                                if (sessionPrivkey) {
                                    const key = nip44.getConversationKey(hexToBytes(sessionPrivkey), ev.pubkey);
                                    const decrypted = nip44.decrypt(ev.content, key);
                                    payload = JSON.parse(decrypted);
                                } else if (window.nostr?.nip44) {
                                    setResolveStatus("Extension popup: Decrypting...");
                                    const decrypted = await window.nostr.nip44.decrypt(ev.pubkey, ev.content);
                                    payload = JSON.parse(decrypted);
                                }
                            } else {
                                payload = JSON.parse(ev.content);
                            }

                            if (payload) {
                                // Check expiry for NCC-05
                                if (payload.updated_at && payload.ttl) {
                                    if (payload.updated_at + payload.ttl < now) {
                                        console.log("[Settings] Record is expired (NCC-05), skipping.");
                                        continue;
                                    }
                                }

                                if (payload.endpoints?.length > 0) {
                                    discovered = payload.endpoints
                                        .map((ep: any) => ep.url || ep.uri)
                                        .filter((u: string) => u);
                                    
                                    if (discovered.length > 0) {
                                        console.log("[Settings] Found freshest endpoints in NCC-05 Locator");
                                        break; // Stop! We found the freshest valid source.
                                    }
                                }
                            }
                        } catch(e) {
                            console.warn("[Settings] Decryption/parsing failed for this record, continuing search...", e);
                        }
                    }
                }
                
                if (discovered.length > 0) {
                    setResolveStatus(null);
                    setPendingEndpoints(discovered);
                } else {
                    console.error("[Settings] No endpoints found in any authored records.");
                    alert("No relay endpoints found for this npub. Ensure the identity has published NCC-02 or NCC-05 records.");
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
