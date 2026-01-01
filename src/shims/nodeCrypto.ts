const browserCrypto = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;

const cryptoShim = {
  getRandomValues(target: Uint8Array) {
    if (!browserCrypto) {
      throw new Error("Web Crypto API is unavailable in this environment");
    }
    return browserCrypto.getRandomValues(target);
  },
  randomUUID() {
    if (browserCrypto && typeof browserCrypto.randomUUID === "function") {
      return browserCrypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 12);
  },
  subtle: browserCrypto?.subtle
};

export const webcrypto = browserCrypto ?? undefined;

export default cryptoShim;
