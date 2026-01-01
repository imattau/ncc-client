# ncc-client

Minimal proof-of-concept nostr client built to showcase the `ncc-02-js`, `ncc-05-js`, and `ncc-06-js` libraries.

## Overview

The web UI is designed around the requested three lanes:

- **Recent • Following Notes** displays the latest kind-1 posts from trusted authors.
- **Articles • Long-form** surfaces verbose, kind-30023 content with curated pacing.
- **All • Global Mirror** lets you toggle between following-only and all-relays views, while showing every known relay from the NCC relay discovery flow.

Every post card exposes standard nostr actions—like, repost, share, mute—plus live previewing of any attached file. A unified composer supports both short-form notes and articles, and file/image uploads (just select a file and publish).

## Getting started

Install dependencies and run the Vite dev server:

```bash
npm install
npm run dev
```

The dev server runs on `localhost:4173` by default. Use `npm run build` to produce a production bundle and `npm run preview` to inspect the build locally.

## Key features

- Three-column dashboard with curated lanes and a relay-aware global mirror.
- NCC runtime hooks: `useNccClient` bootstraps the relay pool from `ncc-02-js`, pipes attachments through `ncc-05-js`, and taps `ncc-06-js` for relay discovery.
- Dedicated relay discovery card that leverages `useNcc02Discovery` + `NCC02Resolver` so the UI reports resolver status, resolved endpoints, and NCC-05 fallback hints without exposing service records inside the timelines.
- Each column now streams live relay events through `SimplePool.subscribe`, starting with the latest 20 entries (the client auto-flushes pending events until each column shows at least 20 posts), lets you “load more”, and renders markdown when available in long-form posts for richer previews.
- The NCC-02 status/endpoint metadata now lives in the drawer under the hamburger menu alongside the composer, keeping the three columns uncluttered while still surfacing discovery details.
- Narrow header with a hamburger menu and profile chip; the menu slides in quick actions (new post composer, relay info) so navigation stays compact while the three columns flow top to bottom.
- Standard nostr interactions (like/repost/share/mute) wired into the UI.
- Composer that allows selecting between note and article kinds, plus file/image uploads.
- Responsive, immersive visual design inspired by luxe dashboard layouts.

## NCC library usage

The `src/services/nccClient.ts` file outlines the current integration (a `SimplePool` relay client, a browser shim of `ncc-06-js`, and a `publishEvent` helper), and `src/hooks/useNccClient.ts` exposes `connected`, `relays`, and a `refresh` action for the UI.

- `ncc-02-js` is used to craft a sample NCC-02 service record via `NCC02Builder`, demonstrating how service metadata can be rendered alongside notes and articles.
- `ncc-05-js` powers the relay prioritization in `src/config/relays.ts` via `selectEndpoints`.
- `ncc-06-js` is aliased to `src/shims/ncc06-browser.ts` in `vite.config.ts` because the published package depends on Node-only modules; the shim just returns the default relay list so the UI always has discovery metadata while the real package is still available for future Node usage.
- `nostr-tools` handles key generation, signing, and the `SimplePool` relay client so published events contain valid `pubkey`/`sig` pairs.

The NCC-02 records are never shown in the timelines; they exist solely to discover relays, while NCC-05 locator helpers resolve dynamic endpoints for private services before any relay connection is attempted.

## Relay discovery flow

- `useNcc02Discovery` (located under `src/hooks`) calls `resolveService` from `src/services/ncc02Resolver.ts`, which wraps `NCC02Resolver` and reuses the shared `SimplePool` from `nccClient.ts`.
- The service discovery card shows the resolver status, any detected endpoint (falling back to NCC-05 for private services), and the associated NCC-02 fingerprint without creating a timeline post.

## Next steps

1. Wire real relay subscriptions from `ncc-02-js` and render incoming events in each column.
2. Persist muted authors locally (IndexedDB or storage).
3. Improve media handling (preview thumbnails, streaming uploads, etc.).
