# NCC Client PoC: Infrastructure Management & Discovery Without DNS

A reference implementation and Proof of Concept (PoC) for the **Nostr Community Conventions (NCC)**, specifically focusing on **NCC-01** (Service Details), **NCC-02** (Trust and Discovery), and **NCC-05** (Identity-Bound Service Locators).

This client demonstrates how to build a decentralized infrastructure where **Nostr Identities (Pubkeys)** replace traditional **DNS Hostnames**.

## 🛰️ Core Concept: No-DNS Architecture

In this model, services (like Nostr relays, media servers, or chat rooms) are not found via standard DNS lookups. Instead:
1. **Ownership (NCC-02):** An identity publishes a record (Kind 30059) claiming ownership of a service identifier (e.g., `relay`).
2. **Location (NCC-05):** The identity publishes dynamic locator records (Kind 30058) containing physical endpoints (IPs, Tor `.onion` addresses).
3. **Trust:** Users verify ownership and can optionally require third-party attestations (Kind 30060) or Web of Trust (WoT) validation before connecting.

---

## ✨ Key Features

### 🔍 Discovery & Social Trust (WoT)
- **Hierarchical Discovery:** Group results by **Publisher -> Service -> Endpoints**.
- **Social Graph Filtering:** Enable **"Network Only"** mode to only see services authored or attested by people you follow (Kind 3).
- **Social Proof:** View "✓ Trusted by X in your network" badges to identify socially validated infrastructure.
- **Aggressive Resolution:** Discover infrastructure via `npub` using an identity-centric resolution engine that scans both public service records and private locators.

### 🔐 Privacy-First Publishing
- **Targeted Private Locators:** Publish service endpoints that are encrypted (NIP-44) for a specific list of authorized `npubs`.
- **NIP-07 Support:** Seamlessly decrypt private records using browser extensions like Alby without exposing your private key.
- **Session-Only Security:** Private keys are stored in `sessionStorage` and cleared automatically when the tab is closed.

### 📦 Infrastructure Management (My Inventory)
- **Live Fleet Scan:** View all active NCC records published by your primary account and auxiliary service identities.
- **One-Click Renewal:** Automatically bump `created_at` and `exp` tags to keep your services active and prevent them from appearing as "Expired".
- **JSON Editor:** Directly modify service metadata or endpoint lists with an integrated record editor.
- **Identity Swapping:** Manage multiple "owned" identities (via stored `nsecs`) from a single dashboard.

### 🚀 Sidecar & Tor Integration
- **Deep Sidecar Integration:** One-click import of local onion services detected from your running `ncc-sidecar` (localhost:3005).
- **Auto-Bridging:** Onion addresses are automatically wrapped in the local Tor bridge URL for immediate browser reachability.
- **Endpoint Probing:** Test real-world latency and reachability of any service endpoint before committing to a connection.
- **Real-time Bridge Monitor:** Navbar indicator showing the health of your local Tor-to-WebSocket bridge.

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+
- **Tor (Optional)**: Required for `.onion` support. A local Tor daemon must be running (default port `9050`).
- **Nostr Extension**: Alby or nos2x (recommended for secure signing).

### 2. Installation & Development
```bash
npm install
npm run dev
```
The app will be available at `http://localhost:5173`. The Tor bridge will start automatically on port 3001.

---

## 🛠 Usage Workflows

### How to Find a Trusted Relay
1. Go to **Discovery**.
2. Enable **Network Only (WoT)** to filter by your social graph.
3. Use **Global Search** or enter a specific `npub`.
4. Look for the **"Network Trusted"** badge and click an endpoint to connect.

### How to Publish a Private Service
1. Go to **Publish**.
2. (Optional) Click **"Detect Local Services"** to import from your sidecar.
3. Toggle **"Private Discovery"**.
4. Paste the `npubs` of your authorized users.
5. Click **"Publish Private"**.

### How to Manage Your Fleet
1. Go to **My Inventory**.
2. Click **"Add Identity"** to include your auxiliary service `nsecs`.
3. Use **"Renew"** to refresh expiring records or **"Edit"** to rotate physical endpoints.

---

## 🧪 Testing & Debugging

- `npm test`: Runs logic and connectivity unit tests.
- `npm run check-bridge`: Verifies the local Tor bridge is reachable.
- `npx tsc --noEmit`: Performs a full TypeScript type check.

---
*Built as a Proof of Concept for the Nostr Community Conventions.*