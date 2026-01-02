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
      return Array.isArray(parsed) ? parsed : DEFAULT_RELAYS;
    } catch (e) {
      return DEFAULT_RELAYS;
    }
  },

  save(relays: string[]) {
    localStorage.setItem('ncc_bootstrap_relays', JSON.stringify(relays));
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