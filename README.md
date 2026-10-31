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

## TURN server (calls behind strict NATs and firewalls)

Direct connections work on most networks. Behind symmetric NATs, mobile carriers or strict firewalls a TURN server relays the traffic; it only sees packets that are already end-to-end encrypted, though it does see IP addresses. TURN is used for **video calls only**, and only as a last resort.

Everyone can choose their own TURN (user setting, then the workspace, then the app default served by the relay's `GET /ice`), and it can be switched off per user (Settings), per app build (`VITE_TURN_DISABLED=true`) or on the relay (`ICE_DISABLED=true`). The relay works with Cloudflare Realtime TURN, coturn, any TURN with a fixed login, and services such as Metered or Xirsys, and protects `/ice` with an origin allow-list, a rate limit, optional Cloudflare Turnstile and, with Cloudflare, a usage guard.

- [Relay server](docs/relay.md): every environment variable, how to configure each TURN provider, verify it and disable it.
- [TURN and calls](docs/turn.md): how the app uses STUN/TURN, settings, build variables, diagnostics, security model.
- Hardened coturn example: [`relay/turnserver.example.conf`](relay/turnserver.example.conf).

## Running in a closed network

The goal is to run everything on a private network with no calls to third parties. It is not fully supported yet: a few outgoing requests are still built in (public STUN, emoji images, the relay's DHT node). See [Closed networks](docs/closed-network.md) for what to set and what is still pending.

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
## Known limitations

| Area | Limitation | Potential improvement |
|------|-----------|----------------------|
| **Browser P2P** | Hyperswarm requires the Holepunch DHT relay for browser peers (no raw UDP in browsers). Data is still E2E encrypted; relay nodes only assist with discovery.
| **Multi-writer convergence** | Messages are merged by timestamp — concurrent writes with identical timestamps may appear in non-deterministic order. | Integrate [Autobase v6](https://github.com/holepunchto/autobase) for true causal-order convergence. |
| **Group video (large rooms)** | WebRTC mesh means N×(N-1)/2 connections. Practical limit ≈ 4–6 peers. | Integrate a Selective Forwarding Unit (SFU) such as [LiveKit](https://livekit.io). |
| **TURN is optional** | Without a configured TURN server only public STUN is used and connections behind symmetric NATs may fail. | See [TURN server](#turn-server-calls-behind-strict-nats-and-firewalls). |
| **OPFS availability** | OPFS requires HTTPS or localhost and is not available in all browsers. Falls back to RAM with a console warning. | Show a persistent UI warning if persistence is unavailable. |
| **Key storage** | Identity keypair is stored in `localStorage`. | Encrypt with a user passphrase via Web Crypto (`SubtleCrypto` + AES-GCM). |
