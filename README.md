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
- **Video calls** — WebRTC mesh with mute, camera toggle (the others see your avatar), screen sharing, a highlight on whoever is speaking, and Picture-in-Picture of the whole call
- **Layouts** — adaptive grid and spotlight view that fit any screen, phones included; spotlight switches on by itself when somebody shares their screen
- **Video quality** — 480p, 720p, 1080p, or **Max** (up to 4K at 60 fps on direct connections), see [Video calls](#video-calls)
- **Calls that survive a change of network** — the connection restarts, or is made again, by itself when a device moves from Wi-Fi to 4G or drops; every tile says *Connecting…*, *Reconnecting…* or *Weak connection* when it is not fine
- **E2E encrypted by design** — all traffic is encrypted end-to-end; no server can read your messages, not even the relay when it has to forward them
- **Signed messages** — messages, edits, deletions and reactions are signed with the author's key: nobody can write as, or change the messages of, another member ([details](docs/security.md))
- **Installable PWA** — works offline, installable on desktop and mobile
- **No account required** — identity is a local cryptographic keypair

## Video calls

Everybody in a call connects to everybody else (a full mesh): there is no media server. Camera and microphone controls, screen sharing and the layout switch are in the call bar; on a phone, the microphone and camera buttons are under the video.

**Video quality** (Settings → Video quality, it can be changed during a call):

| Profile | Camera | What is sent |
|---------|--------|--------------|
| 480p | 640×480, about 20 fps | the browser decides |
| 720p | 1280×720, about 20 fps | the browser decides |
| 1080p (default) | 1920×1080, about 20 fps | the browser decides |
| Max | the biggest picture the camera has, up to 4K, at 60 fps | up to 60 fps on a **direct** connection; through a TURN relay that connection goes down to 1080p at 25 fps |

Max encodes the video once per direct connection, so it needs a powerful device when several people are in the call.

**Network changes and dropped connections.** If the connection to somebody drops or the device changes network, the call restarts its connection on its own (a few tries, a few seconds apart) instead of ending. If it cannot be kept, or never connects, the call connects to that person again, waiting a little longer after each failure (2 s, 4 s, … up to 30 s), for as long as they are in the call.

**What you see.** Everybody in the call has a tile from the moment they join: *Connecting…* while their picture has not arrived, *Reconnecting…* while a connection that worked is being recovered, and a *Weak connection* badge when the round trip is slow or many packets are lost.

**Picture-in-Picture.** The button in the call bar opens a small window with the whole call and the mute, camera and end-call buttons. It opens by itself when you switch to another tab. Browsers without Document Picture-in-Picture show only one video in a standard Picture-in-Picture window.

**Where the video passes.** Turn on *Show network stats overlay* in Settings to see, on each tile, whether the video goes `direct · same network`, `direct · internet` or `via TURN`.

### Browser requirements

- A recent Chromium-based browser (Chrome or Edge) gives the full experience. Document Picture-in-Picture needs Chrome or Edge 116 or later.
- Camera, microphone and storage need HTTPS or `localhost`.
- Screen sharing is not available in most mobile browsers.

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

### Everything in Docker

```bash
docker build -t pipol-web .
docker build -t pipol-relay relay
docker build -t pipol-auth auth
```

Runs the whole app as three images (the web app, the relay and the auth server). See [Running everything with Docker](docs/docker.md) for how to start them, the configuration, capacity and the stress test.

## TURN server (calls behind strict NATs and firewalls)

Direct connections work on most networks. Behind symmetric NATs, mobile carriers or strict firewalls a TURN server relays the traffic; it only sees packets that are already end-to-end encrypted, though it does see IP addresses. TURN is used for **video calls only**, and only as a last resort. When chat cannot connect directly it goes through the relay server, also end-to-end encrypted: see [What the relay can see](docs/relay.md#what-the-relay-can-see).

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
make e2e           # browser tests with Playwright (two or more real browsers, fake camera)
make lint          # ESLint
make format        # Prettier
```
## Known limitations

| Area | Limitation | Potential improvement |
|------|-----------|----------------------|
| **Browser P2P** | Hyperswarm requires the Holepunch DHT relay for browser peers (no raw UDP in browsers). Data is still E2E encrypted; relay nodes only assist with discovery.
| **Multi-writer convergence** | Messages are merged by timestamp — concurrent writes with identical timestamps may appear in non-deterministic order. | Integrate [Autobase v6](https://github.com/holepunchto/autobase) for true causal-order convergence. |
| **Group video (large rooms)** | WebRTC mesh means N×(N-1)/2 connections. Practical limit ≈ 4–6 peers, fewer with the Max quality, which encodes up to 4K at 60 fps once per direct connection. | Integrate a Selective Forwarding Unit (SFU) such as [LiveKit](https://livekit.io). |
| **TURN is optional** | Without a configured TURN server only public STUN is used and connections behind symmetric NATs may fail. | See [TURN server](#turn-server-calls-behind-strict-nats-and-firewalls). |
| **OPFS availability** | OPFS requires HTTPS or localhost and is not available in all browsers. Falls back to RAM with a console warning. | Show a persistent UI warning if persistence is unavailable. |
| **Key storage** | Identity keypair is stored in `localStorage`. | Encrypt with a user passphrase via Web Crypto (`SubtleCrypto` + AES-GCM). |
