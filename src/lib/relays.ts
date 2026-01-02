import { SimplePool } from 'nostr-tools';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export interface RelayHealth {
    url: string;
    lastSeen: number;
    status: 'online' | 'offline' | 'unknown';
    supportsNCC: boolean;
}

export const RelayManager = {
  load(): string[] {
    const saved = localStorage.getItem('ncc_bootstrap_relays');
    if (saved === null) return DEFAULT_RELAYS;
    try {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? (parsed.length > 0 ? parsed : DEFAULT_RELAYS) : DEFAULT_RELAYS;
    } catch (e) {
      return DEFAULT_RELAYS;
    }
  },

  save(relays: string[]) {
    localStorage.setItem('ncc_bootstrap_relays', JSON.stringify(relays));
  },

  async fetchFromNostr(pool: SimplePool, pubkey: string): Promise<string[] | null> {
    const relays = await pool.querySync(DEFAULT_RELAYS, {
        kinds: [10002],
        authors: [pubkey],
        limit: 1
    });

    if (relays.length > 0) {
        const urls = relays[0].tags
            .filter(t => t[0] === 'r')
            .map(t => t[1]);
        if (urls.length > 0) {
            this.save(urls);
            return urls;
        }
    }
    return null;
  },

  async saveToNostr(pool: SimplePool, pubkey: string, signEvent: (ev: any) => Promise<any>): Promise<void> {
    const urls = this.load();
    const event = {
        kind: 10002,
        created_at: Math.floor(Date.now() / 1000),
        tags: urls.map(url => ['r', url]),
        content: '',
        pubkey
    };

    const signed = await signEvent(event);
    const pubs = pool.publish(urls.length > 0 ? urls : DEFAULT_RELAYS, signed);
    await Promise.any(pubs); // Wait for at least one relay to accept it
  },

  add(url: string) {
    const current = this.load();
    if (!current.includes(url)) {
      this.save([...current, url]);
    }
  },

  remove(url: string) {
    const current = this.load();
    const filtered = current.filter(u => u !== url);
    this.save(filtered.length > 0 ? filtered : DEFAULT_RELAYS);
  },

  restoreDefaults() {
      this.save(DEFAULT_RELAYS);
  }
};