export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export const RelayManager = {
  load(): string[] {
    const saved = localStorage.getItem('ncc_bootstrap_relays');
    if (saved === null) return DEFAULT_RELAYS;
    try {
      return JSON.parse(saved);
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
    this.save(current.filter(u => u !== url));
  }
};