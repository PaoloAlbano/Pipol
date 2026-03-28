<div align="center">
  <img src="public/icons/icon.svg" alt="Pipol" width="96" />

# Pipol

[![CI](https://github.com/PaoloAlbano/Pipol/actions/workflows/ci.yml/badge.svg)](https://github.com/PaoloAlbano/Pipol/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/PaoloAlbano/Pipol/branch/main/graph/badge.svg)](https://codecov.io/gh/PaoloAlbano/Pipol)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

</div>

**Pipol** ([pipol.dev](https://pipol.dev)) is a fully peer-to-peer group chat and video call Progressive Web App (PWA). No backend, no central server — all data stays on your device.

## Features

- **Group chat** — persistent, encrypted message history via Hypercore
- **Video calls** — WebRTC mesh with mute, camera toggle, and screen sharing
- **Layouts** — adaptive grid and spotlight (pin) view, auto-switches on screen share
- **E2E encrypted by design** — all traffic is encrypted end-to-end; no server can read your messages
- **Installable PWA** — works offline, installable on desktop and mobile
- **No account required** — identity is a local cryptographic keypair

## Architecture

```
User A (browser)                    User B (browser)
───────────────                     ───────────────
  Hyperswarm DHT ←── relay node ──→ Hyperswarm DHT
        │                                   │
  Corestore (OPFS)              Corestore (OPFS)
  ─ message core A ──replicate──▶ message core A
  ◀─────────────── replicate── message core B
        │                                   │
  Hyperbeam (per pair)  ←────────→ Hyperbeam (per pair)
  [WebRTC SDP/ICE]                [WebRTC SDP/ICE]
        │                                   │
  RTCPeerConnection ←── media ──→ RTCPeerConnection
  [audio/video tracks]
```

| Layer | Technology | Role |
|-------|-----------|------|
| Peer discovery | **Hyperswarm** | Finds peers sharing the same room-code topic via the Holepunch DHT |
| Connection security | **NoiseSecretStream** | Encrypts all peer-to-peer traffic |
| Multiplexing | **Protomux** | Shares a single noise stream between the control channel and Hypercore replication |
| Message persistence | **Hypercore** | Append-only log, one per peer per room; replicated automatically |
| Local storage | **random-access-web** (OPFS) | Browser-native persistent storage; falls back to RAM |
| Video signaling | **Hyperbeam** | Encrypted 1-to-1 pipe per peer pair carrying WebRTC SDP + ICE candidates |
| Media | **WebRTC** (`RTCPeerConnection`) | Full mesh topology; media never touches a relay |

### Room code → Hyperswarm topic

```
topic = BLAKE2b( UTF-8(roomCode) )   // 32 bytes
```

Every peer who knows the room code independently derives the same 32-byte topic and joins that Hyperswarm topic.

### Message flow

1. Each peer owns one **named Hypercore** per room (`messages:{roomCode}`), keyed from the Corestore's primary key (= identity secret key).
2. On connection, peers exchange their core keys via the `HELLO` control message.
3. The receiving peer calls `store.get({ key })` — Corestore replicates the remote core automatically.
4. New blocks trigger `append` events; the UI merges all cores by timestamp.

### WebRTC signaling via Hyperbeam

```
CALL_INIT  ─── Hyperswarm control channel ──▶  responder
both sides compute:
  beamKey = BLAKE2b( sort([myPubKey, remotePubKey]).join() )
initiator:  new Hyperbeam(beamKey) → send SDP offer
responder:  new Hyperbeam(beamKey) → send SDP answer
ICE candidates flow both ways on the same beam.
```

The beam key is derived symmetrically — no additional key exchange needed.

## Getting started

```bash
pnpm install
pnpm run dev 
```

Open `http://localhost:5173` in two browser tabs, on two devices on the same network, or anywhere with internet access (Hyperswarm uses public DHT relay nodes for NAT traversal).

### Production build

```bash
pnpm run build
pnpm run preview
```

## Development

```bash
make install       # install dependencies
make dev           # start dev server
make test          # run tests once
make test-watch    # watch mode
make coverage      # test coverage report
make lint          # ESLint
make format        # Prettier
```

## File structure

```
src/
  p2p/
    storage.js    # Identity (keypair + username), settings, room-code generator
    swarm.js      # Hyperswarm discovery, Protomux control channel, replication
    autobase.js   # Multi-writer message store (one Hypercore per peer, merged by timestamp)
    beam.js       # Hyperbeam encrypted channels for WebRTC signaling
    db.js         # IndexedDB persistence with AES-256-GCM encryption
  webrtc/
    peer.js       # RTCPeerConnection wrapper (offer/answer/ICE, mesh topology)
    media.js      # getUserMedia, stream lifecycle, mute, screen share
  components/
    Home.jsx      # Lobby: create / join a room
    Room.jsx      # Active room: orchestrates P2P stack, chat, and video call
    ChatMessages.jsx
    ChatInput.jsx
    VideoGrid.jsx      # Grid and spotlight layouts
    VideoControls.jsx
    SettingsModal.jsx
  styles/
    global.css
    home.css
    room.css
    chat.css
    video.css
    settings.css
  App.jsx
  main.jsx
tests/
  components/    # React component tests (Vitest + Testing Library)
  p2p/           # Storage and DB unit tests
  webrtc/        # Media utility tests
public/
  manifest.json  # PWA manifest
  sw.js          # Service worker (app-shell caching)
  icons/
```

## Known limitations

| Area | Limitation | Potential improvement |
|------|-----------|----------------------|
| **Browser P2P** | Hyperswarm requires the Holepunch DHT relay for browser peers (no raw UDP in browsers). Data is still E2E encrypted; relay nodes only assist with discovery. | Run under [Pear Runtime](https://pear.how) for fully decentralised UDP-based DHT. |
| **Multi-writer convergence** | Messages are merged by timestamp — concurrent writes with identical timestamps may appear in non-deterministic order. | Integrate [Autobase v6](https://github.com/holepunchto/autobase) for true causal-order convergence. |
| **Group video (large rooms)** | WebRTC mesh means N×(N-1)/2 connections. Practical limit ≈ 4–6 peers. | Integrate a Selective Forwarding Unit (SFU) such as [LiveKit](https://livekit.io). |
| **ICE / STUN only** | Only public STUN servers are configured. Connections behind symmetric NATs may fail. | Add a TURN server (e.g. self-hosted `coturn`). |
| **OPFS availability** | OPFS requires HTTPS or localhost and is not available in all browsers. Falls back to RAM with a console warning. | Show a persistent UI warning if persistence is unavailable. |
| **Key storage** | Identity keypair is stored in `localStorage`. | Encrypt with a user passphrase via Web Crypto (`SubtleCrypto` + AES-GCM). |
