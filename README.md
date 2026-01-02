# NCC Client PoC: Services Without DNS

A reference implementation and Proof of Concept (PoC) for the **Nostr Community Conventions (NCC)**, specifically focusing on **NCC-02** (Trust and Discovery) and **NCC-05** (Identity-Bound Service Locators).

This client demonstrates how to build a decentralized infrastructure where **Nostr Identities (Pubkeys)** replace traditional **DNS Hostnames**.

## 🛰️ Core Concept: No-DNS Architecture

In this model, services (like Nostr relays, media servers, or chat rooms) are not found via standard DNS lookups. Instead:
1. **Ownership (NCC-02):** An identity publishes a record (Kind 30059) claiming ownership of a service identifier (e.g., `relay`).
2. **Location (NCC-05):** The identity publishes dynamic locator records (Kind 30058) containing the physical endpoints (IPs, Tor `.onion` addresses).
3. **Trust:** Users verify ownership and can optionally require third-party attestations (Kind 30060) before connecting.

## ✨ Key Features

### 🔍 Hierarchical Service Discovery
- **Targeted Discovery:** Enter an `npub` to find all services published by that specific user.
- **Global Discovery:** Search bootstrap relays for all active NCC services across the network.
- **Hierarchical View:** Results are logically grouped by **Publisher -> Service -> Endpoints**, reflecting the real-world relationship between identity and infrastructure.
- **Freshness Tracking:** View "Last Updated" timestamps for every publisher based on their live Nostr activity.

### 🔐 Privacy & Encryption
- **Private Services:** Automatically detects services marked as private (lacking a public `u` tag).
- **NIP-44 Decryption:** Securely decrypts targeted locator records. Supports both local **NSEC** signing and **NIP-07** browser extensions (e.g., Alby).
- **Targeted Audience:** Highlights locators specifically intended for you based on the publisher's `privaterecipients` list.

### 🧅 Tor Onion Support
- **Local Sidecar Bridge:** Includes a built-in WebSocket-to-Tor bridge (`scripts/tor-bridge.js`) that allows standard, sandboxed web browsers to speak to Tor Hidden Services.
- **Mobile Friendly:** Supports Orbot (Android) and Tor Browser users via a "Connect Directly" flow.
- **Protocol Normalization:** Automatically handles protocol conversion (e.g., `http` -> `ws`) for onion relays.

### 📡 Interactive Nostr Feed
- **NCC-Aware:** A live feed that displays standard Kind 1 notes alongside NCC events (30058-30061).
- **Rich Metadata:** Automatically fetches user profiles (Kind 0) to display avatars and names for all authors.
- **Real-time Status:** Continuous monitoring of relay connectivity with auto-reconnect and watchdog timers.

### ✍️ Trust & Monitoring
- **One-Click Attestation:** Publicly attest to the validity or trust of a service directly from the Discovery view.
- **Service Tracking:** Automatically monitors connected services for live endpoint updates. If a relay changes its IP or Onion address, the client detects it immediately.
- **Expiration Management:** Automatically flags and hides stale or expired service records (based on `ttl` and `exp` tags).

## 🛠️ Technology Stack

- **Framework**: React 18 + Vite (TypeScript)
- **Styling**: Tailwind CSS + DaisyUI (Mobile-responsive)
- **Nostr Stack**: `nostr-tools`, `ncc-02-js`, `ncc-05-js`
- **Sidecar**: Node.js + `ws` + `socks-proxy-agent` (Tor Bridge)

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+
- **Tor**: A local Tor daemon running (default port `9050`).
  - *Linux*: `sudo systemctl start tor`
  - *Mac*: `brew services start tor`

### 2. Installation
```bash
git clone <repository-url>
cd ncc-client
npm install
```

### 3. Development
Start the web app and the Tor bridge concurrently:
```bash
npm run dev
```
The app will be available at `http://localhost:5173` (and exposed to your local network).

### 4. Usage Flow
1. **Login**: Use an `nsec` or a browser extension.
2. **Discover**: Go to the Discovery tab and perform a Global Search.
3. **Decrypt**: If a record is private, click "Decrypt" (requires private key access).
4. **Connect**: Click an endpoint pill. If it's an onion, select **"Use Bridge"**.
5. **Feed**: View live data from the resolved relay.

## 🧪 Testing & Debugging

The project includes a suite of tools to verify the "No-DNS" stack:
- `npm test`: Runs logic and connectivity unit tests.
- `npm run check-bridge`: Verifies the local Tor bridge is reachable.
- `npm run check-local`: Tests the health of a local relay on port 8081.
- `node scripts/test-tor-http.js`: Verifies your system Tor can reach the outside world.
- `node scripts/scan-onion-ports.js`: Probes an onion address for active ports.

---
*Built as a Proof of Concept for the Nostr Community Conventions.*