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
