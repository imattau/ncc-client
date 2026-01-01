import { getPublicKey, generateSecretKey } from "nostr-tools";
import { nip19 } from "nostr-tools";

export type AuthMethod = "nip07" | "nip46" | "bunker" | "nsec";

export type AuthSessionDetails = {
  secretHex?: string;
  bunkerInput?: string;
};

export type AuthSession = {
  method: AuthMethod;
  pubkey: string;
  label: string;
  details?: AuthSessionDetails;
};

const SECRET_STORAGE_KEY = "ncc-client-auth-secret";
const SESSION_STORAGE_KEY = "ncc-client-auth-session";

export class AuthManager {
  private readonly secretKey: Uint8Array;

  constructor() {
    this.secretKey = this.loadOrCreateSecret();
  }

  getSecretKey() {
    return this.secretKey;
  }

  getPublicKey() {
    return getPublicKey(this.secretKey);
  }

  loadSession(): AuthSession | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthSession;
    } catch {
      return null;
    }
  }

  persistSession(session: AuthSession | null) {
    if (typeof window === "undefined") return;
    try {
      if (session) {
        window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } else {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }

  decodeNsec(value: string): string | null {
    if (/^[0-9a-f]{64}$/i.test(value)) {
      return value.toLowerCase();
    }
    if (!/^nsec1/i.test(value)) {
      return null;
    }
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === "nsec" && decoded.data) {
        return this.toHex(decoded.data);
      }
      return null;
    } catch {
      return null;
    }
  }

  private loadOrCreateSecret(): Uint8Array {
    if (typeof window === "undefined") {
      return generateSecretKey();
    }
    const stored = window.localStorage.getItem(SECRET_STORAGE_KEY);
    if (stored && /^[0-9a-f]{64}$/i.test(stored)) {
      return this.hexToBytes(stored);
    }
    const fresh = generateSecretKey();
    this.saveSecret(fresh);
    return fresh;
  }

  private saveSecret(secret: Uint8Array) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SECRET_STORAGE_KEY, this.toHex(secret));
  }

  private toHex(data: Uint8Array) {
    return Array.from(data)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private parseHex(hex: string) {
    const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  hexToBytes(hex: string) {
    return this.parseHex(hex);
  }
}
