export class LruCache<K extends string, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize = 100) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const next = this.map.keys().next();
      if (!next.done) {
        this.map.delete(next.value);
      }
    }
    this.map.set(key, value);
  }

  has(key: K) {
    return this.map.has(key);
  }

  entries() {
    return Array.from(this.map.entries());
  }

  toObject() {
    const snapshot = {} as Record<K, V>;
    this.map.forEach((value, key) => {
      snapshot[key] = value;
    });
    return snapshot;
  }

  clear() {
    this.map.clear();
  }
}
