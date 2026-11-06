# Running everything with Docker

Three images run the whole app: the **web** image (the app, built when the container starts), the **relay** and the **auth** server. With them anyone can replicate the complete setup on their own machine or server.

| Service | Image built from | What it does |
|---------|------------------|--------------|
| `web` | [`Dockerfile`](../Dockerfile) | Builds the app when it starts, with the addresses of the relay and the auth server you give it, and serves it with nginx |
| `relay` | [`relay/Dockerfile`](../relay/Dockerfile) | Signaling WebSocket, encrypted fallback relay and ICE servers. See [Relay server](relay.md) |
| `auth` | [`auth/Dockerfile`](../auth/Dockerfile) | Key derivation for sign-in with an identity provider (Google, GitHub, …) |

## Quick start

```bash
docker build -t pipol-web .
docker build -t pipol-relay relay
docker build -t pipol-auth auth

docker run -d --name pipol-relay -p 8787:8787 \
  --ulimit nofile=262144:262144 --sysctl net.core.somaxconn=4096 \
  -e TRUST_PROXY_HOPS=0 \
  pipol-relay

docker run -d --name pipol-auth -p 8081:8080 pipol-auth

docker run -d --name pipol-web -p 8080:8080 \
  -e VITE_DHT_RELAY_URL=ws://localhost:8787 \
  -e VITE_AUTH_URL=http://localhost:8081 \
  pipol-web
```

Open <http://localhost:8080>. Two browsers (or one normal and one private window) opening the same quick-room link talk to each other. Stop everything with `docker rm -f pipol-web pipol-relay pipol-auth`.

**The three containers do not talk to each other.** The browser talks to the relay and to the auth server directly, so each one publishes a port and the web container is told the addresses the *browser* must use (`localhost:8787` and `localhost:8081` above). If you publish a different port, change the address in `-e VITE_…` to match.

> **Secure context.** Camera, microphone and the cryptography of the app only work on `https://` pages and on `http://localhost`. On any other address you need HTTPS, and then the relay must be `wss://` (a secure page cannot open a plain `ws://` connection).

## Where the app finds the relay and the auth server

The app is static: the addresses are fixed into it when it is built. The web image builds it **when the container starts**, from its environment, so you choose them with `-e` instead of at `docker build` time. The build takes a few seconds. An address with the wrong scheme stops the container with a clear message before anything is built (the relay must start with `ws://` or `wss://`, the others with `http://` or `https://`).

| Variable | Default in the image | Meaning |
|----------|----------------------|---------|
| `VITE_DHT_RELAY_URL` | `ws://localhost:8787` | Where the browser reaches the relay: `ws://…` or `wss://…`. Empty: the relay at the same address as the app (when something in front of it forwards `/signal` and `/ice`) |
| `VITE_AUTH_URL` | `http://localhost:8081` | Where the browser reaches the auth server. Empty: no sign-in providers (guest and passphrase identities still work) |
| `VITE_ICE_URL`, `VITE_TURNSTILE_SITE_KEY`, `VITE_TURN_DISABLED` | empty | See [TURN and calls](turn.md) |

To change one of them, run the container again with the new value (`docker rm -f pipol-web`, then `docker run … -e VITE_…=…`): it builds again.

**Size.** The image holds Node and the dependencies it needs to build when it starts (about 730 MB), instead of a finished build (a few tens of MB). In exchange there is nothing to rebuild when an address changes.

**Security headers.** The web image sends none: no Content-Security-Policy, no `X-Frame-Options`, no HSTS. Put them on the reverse proxy in front of it, which you need anyway for HTTPS. The headers the hosted app uses are listed in [`public/_headers`](../public/_headers), and they can be copied from there. If you add the Content-Security-Policy, note that it allows `https:`, `wss:` and `ws:` for connections but **not plain `http:`**: add the exact addresses of your relay and auth server to its `connect-src` if they are on `http`.

## Configuring each container

Every setting is an `-e NAME=value` (or `--env-file`) on the container it belongs to. Give each container only its own variables: a file with every secret should not go to all three.

**Relay** (every variable is in [Relay server](relay.md#configuration-at-a-glance)): for example `-e ICE_ALLOWED_ORIGINS=…`, `-e TURN_URLS=…`, `-e CLOUDFLARE_TURN_KEY_ID=…`, `-e RELAY_STATS_INTERVAL_SEC=10`.

- **`TRUST_PROXY_HOPS`**: the relay's default is `1`, which is right behind one proxy. When browsers connect to it directly, as above, use `0`: with `1` the relay would believe the `X-Forwarded-For` header the client sends, which anyone can forge, and the `/ice` rate limit could be bypassed. With a proxy or load balancer in front, set as many hops as you have.
- **Limits** to reproduce a small hosting plan: `--cpus 0.5 --memory 512m`.

**Auth** (`-e`): `PIPOL_MASTER_KEY_V1`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_ORIGINS`, `PIPOL_CURRENT_KEY_VERSION`, `PIPOL_RETIRED_VERSIONS`. See below.

### Sign-in providers (auth)

Without any provider the app still works with guest and passphrase identities. To add Google or GitHub:

1. Generate the server secret: `make auth-gen-key` prints a line like `PIPOL_MASTER_KEY_V1=…`. Pass it to the container and **keep it**: it is the root of the derived identities, and losing it changes them.
2. Register the app with the provider and set its client id and secret (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, …). The redirect URI is your app's address.
3. Run the auth container again with those `-e` options.

### On a server

1. Give each of the three a public HTTPS address (a reverse proxy such as Caddy or Traefik, or a Cloudflare tunnel). The relay and the auth server must be reachable from the browsers, not only from the web container.
2. Set `VITE_DHT_RELAY_URL=wss://relay.example.com` and `VITE_AUTH_URL=https://auth.example.com` on the web container.
3. Restrict who may call them: `-e ICE_ALLOWED_ORIGINS=https://app.example.com` on the relay (see [Protecting `/ice`](relay.md#protecting-ice)) and `-e ALLOWED_ORIGINS=https://app.example.com` on the auth server. Unset, any website may use them.
4. Set `TRUST_PROXY_HOPS` on the relay to the number of proxies in front of it, so the `/ice` rate limit reads the visitor's address and not the proxy's.
5. Add the security headers on the proxy in front of the web container (see above).

On Docker Desktop, connections to a published port all appear to come from one internal address, so every browser shares the `/ice` limit (30 requests a minute by default) and browsers tested from the same machine can see `429`. It does not happen on a Linux host.

## Capacity

### What the images are set up for

A chat client keeps a WebSocket open to the **relay** for as long as it is in a workspace. The web container only serves static files, so it carries no connections and needs no tuning. For the relay, the run command above raises the first walls:

| Setting | Value | Why |
|---------|-------|-----|
| `--ulimit nofile=…` | 262144 | The default limit of open files (often 1024) would stop the relay at about a thousand connections |
| `--sysctl net.core.somaxconn=…` | 4096 | A larger accept queue for bursts of reconnecting clients |
| Heartbeat | ping every 25 s | The relay drops clients that stopped answering, and the traffic stops proxies and load balancers from closing connections that look idle (`HEARTBEAT_INTERVAL_MS`) |
| Slow clients | cut off above 32 MB buffered | A client that cannot keep up is disconnected instead of using the relay's memory (`MAX_CLIENT_BUFFER_MB`) |

Under Kubernetes, Nomad or another runtime, set the equivalent values. **If you put a reverse proxy in front of the relay, it has limits of its own**, and the usual defaults close a silent WebSocket after 60 s (close code `1006` in a quiet chat) and cap the number of connections: raise the read timeout above the heartbeat interval (an hour is fine) and its connection and file-descriptor limits.

### Measured numbers

All with `relay/stress/stress.js` (see [Stress test](#stress-test)); idle connections and the traffic of a chat, not video. They are guides for planning, not guarantees: your hardware, network and traffic will differ.

**The relay on a laptop** (Docker Desktop, 4 CPUs, 7.7 GB, client on the same machine, straight to the relay's port):

| Test | Result |
|------|--------|
| Idle connections | 20,000 at the same time, no failure and none dropped; joining takes 2–11 ms (p95). The relay held about 240 MB, roughly 12 KB per connection |
| Connections kept silent | 300 connections idle for 100 s: all still open (no `1006`) |
| Joins per second | 100 per second, no failure |

**A small relay** (`--cpus 0.5 --memory 512m`, same setup):

| Test | Result |
|------|--------|
| 1,000 conversations of 2 (2,000 connections) | everything delivered, latency p95 3 ms |
| One room, everyone writing a message every 5 s | 200 people: p95 12 ms; 300 people: p95 117 ms; **500 people: p95 2.4 s and 96 % delivered** (the limit of this plan is its CPU); 750 people: 57 % delivered |

**The relay deployed on Render's free plan** (reached from a home connection, so the numbers include the network):

| Test | Result |
|------|--------|
| Idle connections | 2,000 without errors, joining in 130–190 ms (the network round trip) |
| One room | 100 people: p95 58 ms; 200 people: p95 600 ms; **300 people: it collapses** (49 % delivered, seconds of latency). About 5,500 deliveries a second is the ceiling of that instance |
| Image transfers (5 MB) | 25 at the same time complete, at about 13 MB/s in total, with ~4 s per chunk |
| Many conversations | 250 conversations (500 connections) clean. At 500 conversations (1,000 connections), about half of the connections were closed with code `1006`, **all in the same second**, while messages were still delivered. A relay on the same machine never lost one, so the cause is on the way to Render or in Render itself (for instance the instance restarting under load); it has not been pinned down |

### What the numbers mean for the app

- **A room of the relay is a workspace**: everyone in it is in the same signaling room, and messages that cannot go peer to peer go to all of them. The relay holds comfortably the workspaces of a few dozen people on a small plan, and a few hundred on a modest CPU.
- **Most traffic does not pass through the relay**: messages travel peer to peer when the data channel opens. The tests are the worst case, when everything goes through the fallback.
- **The browser limits before the relay does**: every member opens a WebRTC connection to every other one (a mesh), so 50 people mean 49 connections per browser, and video is practical only for a handful of people.
- **One relay instance.** Rooms live in the memory of the process, so the relay cannot be split across instances: two instances would put two members of the same room in different places. Scale it up (more CPU), not out. To use more than one relay today, give different workspaces different relays: a workspace can carry its own relay address in its invite link ("Advanced configuration" when creating it). Real horizontal scaling (sharding rooms by name, or a shared bus between instances) is planned but not built.
- **`/ice`, TURN and sign-in are not covered by these numbers.** `/ice` is rate limited per address on purpose and each request may consume TURN credits; `/derive` calls the identity provider, so do not load it.

## Stress test

`relay/stress/stress.js` simulates peers at the protocol level (the relay only forwards opaque payloads, so fake sealed envelopes are enough) and ramps up one scenario in stages. It stops at the first stage that crosses a limit: more than 5 % of connections failing, joining slower than 5 s (p95), fewer than 95 % of the messages delivered, message latency over 3 s (p95), or the health check not answering three times in a row.

```bash
(cd relay && npm ci)          # once: the script uses the relay's `ws` dependency
node relay/stress/stress.js --url ws://localhost:8787                                   # all scenarios but bigroom
node relay/stress/stress.js --url ws://localhost:8787 --scenario conns --max-conns 20000 --rate 250
node relay/stress/stress.js --url ws://localhost:8787 --scenario bigroom --max-room 750
```

| Scenario | What it does |
|----------|--------------|
| `conns` | Idle connections in stages up to `--max-conns` (50 … 40,000) |
| `fanout` | A room that grows from 2 to `--max-room` people, then a growing message rate |
| `bigroom` | One big room, everyone writing every 5 s (not part of `all`: use it with a large `--max-room`) |
| `rooms` | Many conversations of 2, up to `--max-rooms` |
| `payload` | Simultaneous image transfers (110 chunks of 48 KB, about 5 MB each) |
| `churn` | Joins per second, each client leaving half a second later |

Options: `--rate` (new connections per second, default 40), `--hold` (seconds per stage, default 8), `--out file.json` (results as JSON). For every stage it prints connections open, failed and lost (with the close codes and whether they were lost together or spread out), join and message latency, and the response time of `GET /`.

> **Only load what you run.** Against any host that is not `localhost` the script requires `--yes`. Do not point it at a server you do not control, and be careful with hosted services: they can bill for the traffic or treat a burst from one address as abuse. A test from one home connection also measures that connection, so run it close to the server before drawing conclusions about the server.

To see the load on the relay while testing, start it with `-e RELAY_STATS_INTERVAL_SEC=5`: it writes a line with connections, rooms, memory and the number of clients it had to cut off (`docker logs pipol-relay`).

## Tests against the running images

With the three containers up, `make docker-e2e` runs the browser tests (Playwright, without the macOS-only visual tests) against the app on `http://localhost:8080` instead of the dev server: the browser opens the app and talks to the relay on 8787. Set `E2E_BASE_URL` to use another address. The relay's own tests (`make relay-test`) cover the heartbeat and the slow-client cut-off.
