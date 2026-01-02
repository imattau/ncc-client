# NCC Client PoC

A simple Nostr client demonstrating the application of **NCC-02** (Trust/Discovery) and **NCC-05** (Service Resolution) libraries.

## Features

- **Service Resolution (NCC-05)**: Resolve identity-bound service locators.
  - **Onion Support**: Auto-detects and prioritizes `.onion` addresses, prompting the user for connection (requires browser support or Tor configuration).
- **Service Publishing**: Publish your own service endpoints using your Nostr identity.
- **Trust Explorer (NCC-02)**: Verify service records against third-party attestations.
- **Authentication**: NIP-07 (Extension), NSEC (Private Key), and Read-Only modes.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run Locally**
   ```bash
   npm run dev
   ```

3. **Build**
   ```bash
   npm run build
   ```

## Architecture

- **Libs**: `ncc-02-js`, `ncc-05-js` (linked locally).
- **Stack**: React, Vite, TailwindCSS + DaisyUI.
- **Relays**: Configured in `src/lib/relays.ts`.
- **Tor Integration**: Includes a local WebSocket-to-Tor bridge for browser-based .onion connectivity.

## Tor Onion Support

This client supports connecting to Nostr relays hosted as Tor hidden services (even from standard web browsers) via a local bridge sidecar.

### 1. Requirements
- A local Tor daemon running (typically port 9050).
- The relay should be mapped to port 80 in the Tor configuration (e.g., `HiddenServicePort 80 127.0.0.1:8081`).

### 2. Running the Bridge
The bridge is automatically started when you run the development environment:
```bash
npm run dev
```
Alternatively, you can run just the bridge:
```bash
npm run bridge
```

### 3. Connecting
During Discovery, when an Onion address is found:
1. Click **Connect**.
2. Select **"Use Bridge"**.
3. The client will tunnel the WebSocket traffic through your local bridge to the Tor network.

## Testing & Debugging

The project includes several utility scripts in `scripts/` to verify connectivity:
- `npm run check-bridge`: Verifies the bridge is reachable.
- `npm run check-local`: Verifies the local relay is healthy on port 8081.
- `node scripts/test-tor-http.js`: Tests basic Tor SOCKS connectivity.
- `node scripts/scan-onion-ports.js`: Probes common ports on an onion address.
