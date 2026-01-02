import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNCC } from '../context/NCCContext';
import { RelayManager } from '../lib/relays';
import { nip19, getPublicKey } from 'nostr-tools';
import { Package, Plus, RefreshCw, Key, ShieldCheck, Trash2, Lock, Upload } from 'lucide-react';
import { encryptPrivateRecipients, NCC02Builder, parsePrivateFlag } from 'ncc-02-js';
import clsx from 'clsx';

interface ManagedIdentity {
    pubkey: string;
    privkey?: string; // nsec/hex if owned
    label: string;
}

// Simple HTML escaping helper
const escapeHtml = (str: string) => {
    return str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[m] as string);
};

export function Inventory() {
    const { pubkey: currentPubkey, method, signEvent, encryptNip44 } = useAuth();
    const { pool, ncc05Publisher } = useNCC();
    
    const [identities, setIdentities] = useState<ManagedIdentity[]>(() => {
        const saved = localStorage.getItem('ncc_managed_identities');
        return saved ? JSON.parse(saved) : [];
    });

    const [newIdentity, setNewIdentity] = useState({ label: '', key: '' });
    const [showAdd, setShowAdd] = useState(false);
    const [loading, setLoading] = useState(false);
    const [records, setRecords] = useState<any[]>([]);

    const [editingRecord, setEditingRecord] = useState<any>(null);
    const [editContent, setEditContent] = useState('');

    const [showCreateService, setShowCreateService] = useState(false);
    const [serviceForm, setServiceForm] = useState({
        ownerPubkey: '',
        serviceId: 'relay',
        endpoint: '',
        isPrivate: false,
        recipients: ''
    });

    const [showCreateLocator, setShowCreateLocator] = useState(false);
    const [locatorForm, setLocatorForm] = useState({
        ownerPubkey: '',
        identifier: 'addr',
        type: 'ws',
        url: '',
        family: 'onion',
        isPrivate: false,
        recipients: ''
    });
    const [sidecarDiscovery, setSidecarDiscovery] = useState<{ loading: boolean, services: any[] }>({ loading: false, services: [] });

    const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
    const bytesToHex = (uint8: Uint8Array) => Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');

    const allManagedPubkeys = [
        ...(currentPubkey ? [currentPubkey] : []),
        ...identities.map(i => i.pubkey)
    ];

    const scanRecords = async () => {
        if (allManagedPubkeys.length === 0) return;
        setLoading(true);
        try {
            const events = await pool.querySync(RelayManager.load(), {
                kinds: [30053, 30058, 30059, 30060, 30061],
                authors: allManagedPubkeys
            });
            
            // Deduplicate replaceable events (keep latest)
            const latest = new Map();
            events.forEach(ev => {
                const d = ev.tags.find((t: any) => t[0] === 'd')?.[1] || '';
                const key = `${ev.kind}:${ev.pubkey}:${d}`;
                if (!latest.has(key) || ev.created_at > latest.get(key).created_at) {
                    latest.set(key, ev);
                }
            });

            setRecords(Array.from(latest.values()));
        } catch (e) {
            console.error("Scan failed", e);
        } finally {
            setLoading(false);
        }
    };

    // Persist identities
    useEffect(() => {
        localStorage.setItem('ncc_managed_identities', JSON.stringify(identities));
    }, [identities]);

    useEffect(() => {
        scanRecords();
    }, [identities.length, currentPubkey]);

    const handleAddIdentity = () => {
        try {
            let hex = newIdentity.key;
            let priv: string | undefined;
            
            if (newIdentity.key.startsWith('nsec')) {
                const decoded = nip19.decode(newIdentity.key);
                hex = bytesToHex(decoded.data as Uint8Array);
                priv = hex;
                hex = getPublicKey(decoded.data as Uint8Array);
            } else if (newIdentity.key.startsWith('npub')) {
                hex = nip19.decode(newIdentity.key).data as string;
            } else if (newIdentity.key.length === 64) {
                // Assume hex (could be pub or priv, try get pub)
                try {
                    const bytes = hexToBytes(newIdentity.key);
                    const derivedPub = getPublicKey(bytes);
                    priv = hex;
                    hex = derivedPub;
                } catch(e) {
                    // It was likely just a hex pubkey
                }
            }

            if (allManagedPubkeys.includes(hex)) {
                alert("Identity already managed");
                return;
            }

            setIdentities([...identities, { 
                pubkey: hex, 
                privkey: priv, 
                label: newIdentity.label || `Service ${hex.slice(0,4)}` 
            }]);
            setNewIdentity({ label: '', key: '' });
            setShowAdd(false);
        } catch (e) {
            alert("Invalid Key Format");
        }
    };

    const removeIdentity = (pk: string) => {
        setIdentities(identities.filter(i => i.pubkey !== pk));
    };

    const handleCreateService = async () => {
        const iden = identities.find(i => i.pubkey === serviceForm.ownerPubkey) || 
                     (serviceForm.ownerPubkey === currentPubkey ? { pubkey: currentPubkey, privkey: undefined } : null);
        
        if (!iden) return alert("Select a managed identity first.");
        
        setLoading(true);
        try {
            const builder = new NCC02Builder(iden.privkey || (({
                getPublicKey: () => Promise.resolve(iden.pubkey),
                signEvent: (ev: any) => signEvent(ev)
            }) as any));

            let encryptedRecipients: string[] | undefined;
            if (serviceForm.isPrivate && serviceForm.recipients) {
                const recipientList = serviceForm.recipients.split(',')
                    .map(r => r.trim())
                    .filter(r => r)
                    .map(r => r.startsWith('npub') ? (nip19.decode(r).data as string) : r);
                
                if (recipientList.length > 0) {
                    const signer = iden.privkey || ({
                        nip44Encrypt: (p: string, t: string) => encryptNip44(p, t),
                        getPublicKey: () => Promise.resolve(iden.pubkey)
                    });
                    encryptedRecipients = await encryptPrivateRecipients(signer as any, recipientList);
                }
            }

            const record = await builder.createServiceRecord({
                serviceId: serviceForm.serviceId,
                endpoint: serviceForm.endpoint || undefined,
                expiryDays: 30,
                isPrivate: serviceForm.isPrivate,
                privateRecipients: encryptedRecipients
            });

            await pool.publish(RelayManager.load(), record);
            alert("NCC-02 Service Record Published!");
            setShowCreateService(false);
            scanRecords();
        } catch (e: any) {
            alert("Publish failed: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateLocator = async () => {
        const iden = identities.find(i => i.pubkey === locatorForm.ownerPubkey) || 
                     (locatorForm.ownerPubkey === currentPubkey ? { pubkey: currentPubkey, privkey: undefined } : null);
        
        if (!iden) return alert("Select a managed identity first.");

        setLoading(true);
        try {
            const recipientList = locatorForm.recipients.split(',')
                .map(r => r.trim())
                .filter(r => r)
                .map(r => r.startsWith('npub') ? (nip19.decode(r).data as string) : r);

            const payload = {
                v: 1,
                ttl: 3600,
                updated_at: Math.floor(Date.now() / 1000),
                endpoints: [{
                    type: locatorForm.type,
                    url: locatorForm.url,
                    priority: 1,
                    family: locatorForm.family
                }],
                ...(locatorForm.isPrivate && { privaterecipients: recipientList })
            };

            const customSigner = iden.privkey ? undefined : (async (ev: any) => signEvent(ev));

            await ncc05Publisher.publish(RelayManager.load(), (iden.privkey || customSigner) as any, payload, { 
                public: !locatorForm.isPrivate, 
                identifier: locatorForm.identifier,
                recipientPubkey: recipientList[0] 
            });

            alert("NCC-05 Locator Published!");
            setShowCreateLocator(false);
            scanRecords();
        } catch (e: any) {
            alert("Publish failed: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    const detectSidecar = async () => {
        setSidecarDiscovery(prev => ({ ...prev, loading: true }));
        try {
            const res = await fetch('http://localhost:3005/inventory');
            const data = await res.json();
            if (data && data.services) {
                setSidecarDiscovery({ loading: false, services: data.services });
            }
        } catch (e) {
            setSidecarDiscovery({ loading: false, services: [] });
            alert("NCC Sidecar not detected on localhost:3005.");
        }
    };

    const importService = (s: any) => {
        setLocatorForm({
            ...locatorForm,
            type: s.type || 'ws',
            url: s.onion_address || '',
            family: 'onion'
        });
    };

    const handleRenew = async (rec: any) => {
        const iden = identities.find(i => i.pubkey === rec.pubkey);
        const auxiliaryNsec = iden?.privkey;
        
        setLoading(true);
        try {
            const now = Math.floor(Date.now() / 1000);
            const newEvent = { 
                kind: rec.kind,
                created_at: now,
                tags: [...rec.tags],
                content: rec.content,
                pubkey: rec.pubkey
            };

            // Update expiry tag if it exists (for NCC-02)
            const expIdx = newEvent.tags.findIndex((t: any) => t[0] === 'exp');
            if (expIdx !== -1) {
                const newExp = now + (30 * 24 * 60 * 60); // +30 days
                newEvent.tags[expIdx] = ['exp', newExp.toString()];
            }

            // Ensure 'private' tag is present (defaulting to false if missing for new protocol compliance)
            const privTagIdx = newEvent.tags.findIndex((t: any) => t[0] === 'private');
            if (privTagIdx === -1) {
                // If it was missing but has 'u' tag, it's public. If no 'u' tag, it's private.
                const isPub = newEvent.tags.some((t: any) => t[0] === 'u');
                newEvent.tags.push(['private', isPub ? 'false' : 'true']);
            }

            let signed;
            if (auxiliaryNsec) {
                const { finalizeEvent } = await import('nostr-tools/pure');
                signed = finalizeEvent(newEvent, hexToBytes(auxiliaryNsec));
            } else {
                signed = await signEvent(newEvent);
            }

            await pool.publish(RelayManager.load(), signed);
            alert("Record Renewed!");
            scanRecords();
        } catch (e: any) {
            alert("Renew failed: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveEdit = async () => {
        if (!editingRecord) return;
        const iden = identities.find(i => i.pubkey === editingRecord.pubkey);
        const auxiliaryNsec = iden?.privkey;

        setLoading(true);
        try {
            const updated = { 
                kind: editingRecord.kind,
                content: editContent, 
                created_at: Math.floor(Date.now() / 1000),
                tags: [...editingRecord.tags],
                pubkey: editingRecord.pubkey
            };

            let signed;
            if (auxiliaryNsec) {
                const { finalizeEvent } = await import('nostr-tools/pure');
                signed = finalizeEvent(updated, hexToBytes(auxiliaryNsec));
            } else {
                signed = await signEvent(updated);
            }

            await pool.publish(RelayManager.load(), signed);
            alert("Record Updated!");
            setEditingRecord(null);
            scanRecords();
        } catch (e: any) {
            alert("Update failed: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* Header / Actions */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Package className="text-primary w-6 h-6" />
                    <h2 className="text-xl font-bold">Infrastructure Inventory</h2>
                </div>
                <div className="flex gap-2">
                    <button className={clsx("btn btn-sm", loading && "loading")} onClick={scanRecords}>
                        <RefreshCw className="w-4 h-4" /> Scan Network
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateLocator(!showCreateLocator)}>
                        <Upload className="w-4 h-4" /> Publish NCC-05
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateService(!showCreateService)}>
                        <ShieldCheck className="w-4 h-4" /> Publish NCC-02
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => setShowAdd(!showAdd)}>
                        <Plus className="w-4 h-4" /> Add Identity
                    </button>
                </div>
            </div>

            {/* Create Locator Form (NCC-05) */}
            {showCreateLocator && (
                <div className="card bg-base-100 shadow-lg border border-secondary/20 mb-6">
                    <div className="card-body p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold text-sm">Publish NCC-05 Service Locator</h3>
                            <button className={clsx("btn btn-xs btn-outline btn-secondary", sidecarDiscovery.loading && "loading")} onClick={detectSidecar}>
                                {sidecarDiscovery.loading ? 'Detecting...' : 'Sidecar Detect'}
                            </button>
                        </div>

                        {sidecarDiscovery.services.length > 0 && (
                            <div className="mb-4 space-y-2 bg-base-200 p-2 rounded-lg border border-base-300">
                                <p className="text-[9px] uppercase font-bold opacity-50 px-1">Local Sidecar Services</p>
                                {sidecarDiscovery.services.map((s, i) => (
                                    <div key={i} className="flex items-center justify-between p-2 bg-base-100 rounded border border-base-200">
                                        <div className="flex flex-col min-w-0"><span className="text-xs font-bold truncate">{s.name || s.id}</span></div>
                                        <button className="btn btn-xs btn-ghost text-secondary" onClick={() => importService(s)}>Import</button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Identity</label>
                                <select className="select select-bordered select-sm" value={locatorForm.ownerPubkey} onChange={e => setLocatorForm({...locatorForm, ownerPubkey: e.target.value})}>
                                    <option value="">Select Identity...</option>
                                    {allManagedPubkeys.map(pk => <option key={pk} value={pk}>{identities.find(i => i.pubkey === pk)?.label || (pk === currentPubkey ? "Primary Account" : pk.slice(0,12))}</option>)}
                                </select>
                            </div>
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Identifier (d-tag)</label>
                                <input className="input input-bordered input-sm" placeholder="e.g. addr" value={locatorForm.identifier} onChange={e => setLocatorForm({...locatorForm, identifier: e.target.value})} />
                            </div>
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Type</label>
                                <select className="select select-bordered select-sm" value={locatorForm.type} onChange={e => setLocatorForm({...locatorForm, type: e.target.value})}>
                                    <option value="ws">WebSocket</option><option value="http">HTTP</option><option value="tcp">TCP</option>
                                </select>
                            </div>
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Family</label>
                                <select className="select select-bordered select-sm" value={locatorForm.family} onChange={e => setLocatorForm({...locatorForm, family: e.target.value})}>
                                    <option value="onion">Onion (Tor)</option><option value="ipv4">IPv4</option>
                                </select>
                            </div>
                            <div className="form-control sm:col-span-2">
                                <label className="label text-[10px] font-bold uppercase opacity-50">URL</label>
                                <input className="input input-bordered input-sm font-mono" placeholder="xyz...onion" value={locatorForm.url} onChange={e => setLocatorForm({...locatorForm, url: e.target.value})} />
                            </div>
                            <div className="form-control sm:col-span-2">
                                <label className="label cursor-pointer justify-start gap-4">
                                    <input type="checkbox" className="toggle toggle-secondary toggle-sm" checked={locatorForm.isPrivate} onChange={e => setLocatorForm({...locatorForm, isPrivate: e.target.checked})} />
                                    <span className="label-text font-bold text-xs">Private Discovery (Encrypted)</span>
                                </label>
                            </div>
                            {locatorForm.isPrivate && (
                                <div className="form-control sm:col-span-2 fade-in">
                                    <label className="label text-[10px] font-bold uppercase opacity-50">Authorized Recipients</label>
                                    <textarea className="textarea textarea-bordered h-20 text-xs font-mono" placeholder="npub1..." value={locatorForm.recipients} onChange={e => setLocatorForm({...locatorForm, recipients: e.target.value})} />
                                </div>
                            )}
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button className="btn btn-sm btn-ghost" onClick={() => setShowCreateLocator(false)}>Cancel</button>
                            <button className={clsx("btn btn-sm btn-secondary", loading && "loading")} onClick={handleCreateLocator} disabled={!locatorForm.ownerPubkey || !locatorForm.url}>Publish Locator</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Create Service Form (NCC-02) */}
            {showCreateService && (
                <div className="card bg-base-100 shadow-lg border border-secondary/20">
                    <div className="card-body p-4">
                        <h3 className="font-bold text-sm mb-3">Publish NCC-02 Service Record</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Identity</label>
                                <select 
                                    className="select select-bordered select-sm"
                                    value={serviceForm.ownerPubkey}
                                    onChange={e => setServiceForm({...serviceForm, ownerPubkey: e.target.value})}
                                >
                                    <option value="">Select Managed Identity...</option>
                                    {allManagedPubkeys.map(pk => (
                                        <option key={pk} value={pk}>
                                            {identities.find(i => i.pubkey === pk)?.label || (pk === currentPubkey ? "Primary Account" : pk.slice(0,12))}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="form-control">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Service ID</label>
                                <input 
                                    className="input input-bordered input-sm" 
                                    placeholder="e.g. relay, media, api"
                                    value={serviceForm.serviceId}
                                    onChange={e => setServiceForm({...serviceForm, serviceId: e.target.value})}
                                />
                            </div>
                            <div className="form-control sm:col-span-2">
                                <label className="label text-[10px] font-bold uppercase opacity-50">Endpoint URL (Optional)</label>
                                <input 
                                    className="input input-bordered input-sm font-mono" 
                                    placeholder="wss://... or https://..."
                                    value={serviceForm.endpoint}
                                    onChange={e => setServiceForm({...serviceForm, endpoint: e.target.value})}
                                />
                            </div>
                            <div className="form-control sm:col-span-2">
                                <label className="label cursor-pointer justify-start gap-4">
                                    <input 
                                        type="checkbox" 
                                        className="toggle toggle-secondary toggle-sm" 
                                        checked={serviceForm.isPrivate} 
                                        onChange={e => setServiceForm({...serviceForm, isPrivate: e.target.checked})} 
                                    />
                                    <span className="label-text font-bold text-xs">Private Service (Requires 'private' tag)</span>
                                </label>
                            </div>
                            {serviceForm.isPrivate && (
                                <div className="form-control sm:col-span-2 fade-in">
                                    <label className="label text-[10px] font-bold uppercase opacity-50">Authorized Recipients (npubs, comma separated)</label>
                                    <textarea 
                                        className="textarea textarea-bordered h-20 text-xs font-mono"
                                        placeholder="npub1..., npub1..."
                                        value={serviceForm.recipients}
                                        onChange={e => setServiceForm({...serviceForm, recipients: e.target.value})}
                                    />
                                </div>
                            )}
                        </div>
                        <div className="card-actions justify-end mt-4">
                            <button className="btn btn-sm btn-ghost" onClick={() => setShowCreateService(false)}>Cancel</button>
                            <button className={clsx("btn btn-sm btn-secondary", loading && "loading")} onClick={handleCreateService} disabled={!serviceForm.ownerPubkey}>Publish Record</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add Identity Form */}
            {showAdd && (
                <div className="card bg-base-100 shadow-lg border border-primary/20">
                    <div className="card-body p-4">
                        <h3 className="font-bold text-sm mb-3">Add Identity to Manage</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <input 
                                className="input input-bordered input-sm" 
                                placeholder="Label (e.g. My Media Node)"
                                value={newIdentity.label}
                                onChange={e => setNewIdentity({...newIdentity, label: e.target.value})}
                            />
                            <input 
                                className="input input-bordered input-sm font-mono" 
                                placeholder="nsec / npub / hex"
                                value={newIdentity.key}
                                onChange={e => setNewIdentity({...newIdentity, key: e.target.value})}
                            />
                        </div>
                        <div className="card-actions justify-end mt-2">
                            <button className="btn btn-sm btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
                            <button className="btn btn-sm btn-primary" onClick={handleAddIdentity} disabled={!newIdentity.key}>Add</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Identities List */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Main Account */}
                <div className="card bg-base-300 border border-base-content/10">
                    <div className="card-body p-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <ShieldCheck className="text-success w-4 h-4" />
                                <span className="font-bold text-sm">Primary Account (Active Session)</span>
                            </div>
                            <div className="badge badge-outline badge-xs">{method}</div>
                        </div>
                        <div className="text-[10px] font-mono opacity-50 truncate">{currentPubkey}</div>
                    </div>
                </div>

                {/* Added Identities */}
                {identities.map(id => (
                    <div key={id.pubkey} className="card bg-base-100 border border-base-200">
                        <div className="card-body p-4">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                    <Key className={clsx("w-4 h-4", id.privkey ? "text-warning" : "opacity-30")} />
                                    <span className="font-bold text-sm truncate" dangerouslySetInnerHTML={{ __html: escapeHtml(id.label) }}></span>
                                </div>
                                <button className="btn btn-ghost btn-xs text-error" onClick={() => removeIdentity(id.pubkey)}>
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            </div>
                            <div className="text-[10px] font-mono opacity-50 truncate">{id.pubkey}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Records List */}
            <div className="space-y-4">
                <h3 className="text-sm font-bold opacity-50 uppercase tracking-widest px-1">Found Services</h3>
                {records.length === 0 && !loading && (
                    <div className="text-center p-12 bg-base-200 rounded-box border-2 border-dashed border-base-300">
                        <Package className="w-12 h-12 mx-auto mb-2 opacity-20" />
                        <p className="opacity-50">No NCC records found for these identities.</p>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-3">
                    {records.map(rec => {
                        const iden = identities.find(i => i.pubkey === rec.pubkey);
                        const label = iden ? iden.label : "Primary";
                        const d = rec.tags.find((t: any) => t[0] === 'd')?.[1] || 'none';
                        const isExpired = rec.kind === 30059 && rec.tags.find((t: any) => t[0] === 'exp' && parseInt(t[1]) < Date.now() / 1000);
                        const isPrivate = rec.kind === 30059 && parsePrivateFlag(rec.tags);

                        return (
                            <div key={rec.id} className={clsx("card bg-base-100 border shadow-sm", isExpired ? "border-error/30" : "border-base-200")}>
                                <div className="card-body p-4">
                                    <div className="flex items-start justify-between">
                                        <div className="flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="badge badge-neutral badge-xs font-bold" dangerouslySetInnerHTML={{ __html: escapeHtml(label) }}></span>
                                                <span className="text-sm font-black uppercase">Service: <span dangerouslySetInnerHTML={{ __html: escapeHtml(d) }}></span></span>
                                                {isPrivate && <Lock className="w-3 h-3 text-warning" />}
                                                {isExpired && <div className="badge badge-error badge-xs">EXPIRED</div>}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] opacity-50">Kind {rec.kind}</span>
                                                <span className="text-[10px] opacity-30 font-mono">{new Date(rec.created_at * 1000).toLocaleString()}</span>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            {(iden?.privkey || (rec.pubkey === currentPubkey && method !== 'readonly')) && (
                                                <>
                                                    <button 
                                                        className="btn btn-xs btn-outline btn-primary" 
                                                        onClick={() => handleRenew(rec)}
                                                        disabled={loading}
                                                    >
                                                        Renew
                                                    </button>
                                                    <button 
                                                        className="btn btn-xs btn-outline" 
                                                        onClick={() => { setEditingRecord(rec); setEditContent(rec.content); }}
                                                        disabled={loading}
                                                    >
                                                        Edit
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <pre className="text-[9px] bg-black text-green-500 p-2 rounded mt-2 overflow-x-auto max-h-24">
                                        {JSON.stringify(rec, null, 2)}
                                    </pre>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Edit Modal */}
            {editingRecord && (
                <div className="modal modal-open">
                    <div className="modal-box max-w-2xl">
                        <h3 className="font-bold text-lg mb-2">Edit Record Content</h3>
                        <p className="text-xs opacity-50 mb-4">Editing Kind {editingRecord.kind} for {editingRecord.pubkey.slice(0, 12)}...</p>
                        <textarea 
                            className="textarea textarea-bordered w-full h-64 font-mono text-xs"
                            value={editContent}
                            onChange={e => setEditContent(e.target.value)}
                        />
                        <div className="modal-action">
                            <button className="btn btn-ghost" onClick={() => setEditingRecord(null)}>Cancel</button>
                            <button className={clsx("btn btn-primary", loading && "loading")} onClick={handleSaveEdit}>Save Changes</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}