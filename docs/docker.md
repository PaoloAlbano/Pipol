# Running everything with Docker

Three images run the whole app: the **web** image (the app served by nginx), the **relay** and the **auth** server. With them anyone can replicate the complete setup on their own machine or server.

| Service | Image built from | What it does |
|---------|------------------|--------------|
| `web` | [`Dockerfile`](../Dockerfile) | The PWA, served by nginx. It also proxies the relay (`/signal`, `/ice`) and the auth server (`/auth`) under its own address, so the browser talks to one origin only |
| `relay` | [`relay/Dockerfile`](../relay/Dockerfile) | Signaling WebSocket, encrypted fallback relay and ICE servers. See [Relay server](relay.md) |
| `auth` | [`auth/Dockerfile`](../auth/Dockerfile) | Key derivation for sign-in with an identity provider (Google, GitHub, …) |

## Quick start

```bash
docker compose up --build     # or: make docker-up
```

Open <http://localhost:8080>. Two browsers (or one normal and one private window) opening the same quick-room link talk to each other. `make docker-down` stops everything.

The app is static, so the app finds the relay by itself: it uses `wss://<the address you opened>/signal`. Nothing else has to be configured to chat.

> **Secure context.** Camera, microphone and the cryptography of the app only work on `https://` pages and on `http://localhost`. On any other address (a server, a LAN address) put HTTPS in front of the `web` container: a reverse proxy such as Caddy or Traefik, a Cloudflare tunnel, and so on. Forward `X-Forwarded-Proto` and the visitor's address (see [Behind another proxy](#behind-another-proxy)).

## Configuration

Settings come from the shell or from a `.env` file next to `docker-compose.yml` (copy [`.env.example`](../.env.example)). A variable that is not set is not passed to the container, so each service keeps its own default.

**Build-time (the app is static: change one and run `docker compose build web`)**

| Variable | Default | Meaning |
|----------|---------|---------|
| `VITE_AUTH_URL` | `/auth` | Where the app finds the auth server. The default is the nginx proxy; set a full URL to use an auth server elsewhere, or leave `/auth` and run without sign-in providers |
| `VITE_DHT_RELAY_URL` | empty | Only to use a relay at another address than the app's own |
| `VITE_ICE_URL`, `VITE_TURNSTILE_SITE_KEY`, `VITE_TURN_DISABLED` | empty | See [TURN and calls](turn.md) |

**Run-time**

| Variable | Service | Meaning |
|----------|---------|---------|
| `WEB_PORT` | web | Port published on the host (default `8080`) |
| `RELAY_UPSTREAM`, `AUTH_UPSTREAM`, `DNS_RESOLVER` | web | Where nginx finds the other services. Defaults: `http://relay:8787`, `http://auth:8080` and Docker's DNS. Change them to point the web image at a relay or auth server that is not in this compose file |
| Every variable in [Relay server](relay.md#configuration-at-a-glance) (`ICE_ALLOWED_ORIGINS`, `TURN_*`, `CLOUDFLARE_*`, `HEARTBEAT_INTERVAL_MS`, `RELAY_STATS_INTERVAL_SEC`, …) | relay | Passed through when set. `TRUST_PROXY_HOPS` is `1` here: the `web` container is the one proxy in front of the relay |
| `RELAY_CPUS`, `RELAY_MEMORY` | relay | Resource limits (for instance `0.5` and `512m`), to reproduce a small hosting plan. Unset means no limit |
| `PIPOL_MASTER_KEY_V1`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_ORIGINS`, `PIPOL_CURRENT_KEY_VERSION`, `PIPOL_RETIRED_VERSIONS` | auth | See below |

### Sign-in providers (auth)

Without any provider the app still works with guest and passphrase identities. To add Google or GitHub:

1. Generate the server secret: `make auth-gen-key` prints a line like `PIPOL_MASTER_KEY_V1=…`. Put it in `.env` and **keep it**: it is the root of the derived identities, and losing it changes them.
2. Register the app with the provider and set its client id and secret (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, …). The redirect URI is your app's address.
3. `docker compose up -d auth`.

### `/ice` and the allow-list

The relay's `/ice` refuses requests without an `Origin` header when `ICE_ALLOWED_ORIGINS` is set, and browsers do not send one on a same-origin `GET`. nginx therefore adds the app's own origin to those requests (and leaves the `Origin` of cross-origin requests alone), so `ICE_ALLOWED_ORIGINS=https://pipol.example.com` works as in [Protecting `/ice`](relay.md#protecting-ice).

### Behind another proxy

If a TLS terminator or load balancer sits in front of `web`, it must pass `X-Forwarded-For` and `X-Forwarded-Proto`. The relay counts proxies from the right to find the visitor for the `/ice` rate limit: with one more proxy in front of `web`, set `TRUST_PROXY_HOPS=2`. On Docker Desktop, connections to a published port all appear to come from one internal address, so every browser shares the `/ice` limit (30 requests a minute by default); that is why browsers tested from the same machine can see `429` there. It does not happen on a Linux host.

## Capacity

### What the `web` image is set up for

A chat client keeps a WebSocket open for as long as it is in a workspace, so the first limits are the number of open connections and files. The image and `docker-compose.yml` raise them:

| Setting | Value | Why |
|---------|-------|-----|
| `worker_connections` | 65535 per worker | A proxied WebSocket takes two (client and relay). With N workers (one per CPU) the container holds about N × 65535 / 2 WebSockets |
| `worker_rlimit_nofile` and the container's `nofile` ulimit | 262144 | At least twice `worker_connections`, otherwise nginx stops accepting at the limit |
| `proxy_read_timeout` / `proxy_send_timeout` on `/signal` | 1 hour | nginx closes a connection that stays silent for 60 s by default, which shows up as close code `1006` in a quiet chat. The relay also pings every 25 s |
| `net.ipv4.ip_local_port_range` | `1024 65535` | Each proxied WebSocket uses one local port towards the relay: the default range caps the container at about 28,000. With the wider range the ceiling is about 64,000 per `web` container; beyond that, scale `web` out (several containers, or several addresses with `proxy_bind`) |
| `net.core.somaxconn` and `listen … backlog` | 4096 | A large accept queue for bursts of reconnecting clients |
| `reuseport`, `multi_accept` | on | Spread new connections across the workers |
| `access_log` | off | One line per connection would be heavy and would name visitors' addresses |

These sysctls and ulimits are applied by Docker Compose. With another runtime (Kubernetes, Nomad, plain `docker run`) set the same values: `--ulimit nofile=262144:262144 --sysctl net.core.somaxconn=4096 --sysctl 'net.ipv4.ip_local_port_range=1024 65535'`.

### Measured numbers

All with `relay/stress/stress.js` (see [Stress test](#stress-test)); idle connections and the traffic of a chat, not video. They are guides for planning, not guarantees: your hardware, network and traffic will differ.

**This stack, on a laptop** (Docker Desktop, 4 CPUs, 7.7 GB, client on the same machine):

| Test | Result |
|------|--------|
| Idle connections through nginx | 20,000 at the same time, no failure and none dropped; joining takes 3–10 ms (p95). Right after the test nginx held about 120 MB and the relay about 220 MB, roughly 10 KB per connection |
| Connections kept silent | 300 connections idle for 100 s: all still open (no `1006`) |
| Joins per second | 100 per second, no failure |

**A small relay** (`RELAY_CPUS=0.5 RELAY_MEMORY=512m`, through nginx):

| Test | Result |
|------|--------|
| 1,000 conversations of 2 (2,000 connections) | everything delivered, latency p95 4 ms |
| One room, everyone writing a message every 5 s | 200 people: p95 11 ms; 300 people: p95 200 ms; **500 people: p95 3.2 s** (the limit of this plan: CPU) |

**The relay deployed on Render's free plan** (reached from a home connection, so the numbers include the network):

| Test | Result |
|------|--------|
| Idle connections | 2,000 without errors, joining in 130–190 ms (the network round trip) |
| One room | 100 people: p95 58 ms; 200 people: p95 600 ms; **300 people: it collapses** (49 % delivered, seconds of latency). About 5,500 deliveries a second is the ceiling of that instance |
| Image transfers (5 MB) | 25 at the same time complete, at about 13 MB/s in total, with ~4 s per chunk |
| Many conversations | 250 conversations (500 connections) clean. At 500 conversations (1,000 connections), about half of the connections were closed with code `1006` while messages were still delivered. The same test against a relay on the same machine never lost one, so the cause was between the test and Render (the home network, Cloudflare or Render itself); it has not been pinned down |

### What the numbers mean for the app

- **A room of the relay is a workspace**: everyone in it is in the same signaling room, and messages that cannot go peer to peer go to all of them. The relay holds comfortably the workspaces of a few dozen people on a small plan, and a few hundred on a modest CPU.
- **Most traffic does not pass through the relay**: messages travel peer to peer when the data channel opens. The tests are the worst case, when everything goes through the fallback.
- **The browser limits before the relay does**: every member opens a WebRTC connection to every other one (a mesh), so 50 people mean 49 connections per browser, and video is practical only for a handful of people.
- **One relay instance.** Rooms live in the memory of the process, so the relay cannot be split across instances: two instances would put two members of the same room in different places. Scale it up (more CPU), not out. To use more than one relay today, give different workspaces different relays: a workspace can carry its own relay address in its invite link ("Advanced configuration" when creating it). Real horizontal scaling (sharding rooms by name, or a shared bus between instances) is planned but not built.
- **`/ice`, TURN and sign-in are not covered by these numbers.** `/ice` is rate limited per address on purpose and each request may consume TURN credits; `/derive` calls the identity provider, so do not load it.

## Stress test

`relay/stress/stress.js` simulates peers at the protocol level (the relay only forwards opaque payloads, so fake sealed envelopes are enough) and ramps up one scenario in stages. It stops at the first stage that crosses a limit: more than 5 % of connections failing, joining slower than 5 s (p95), fewer than 95 % of the messages delivered, message latency over 3 s (p95), or the health check not answering three times in a row.

```bash
make docker-up
make docker-stress                                        # from inside the stack, default: 1,000 connections
STRESS_SCENARIO=bigroom make docker-stress                # one of: conns, fanout, bigroom, rooms, payload, churn
node relay/stress/stress.js --url ws://localhost:8080 --scenario conns --max-conns 20000 --rate 250
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

> **Only load what you run.** Against any host that is not `localhost` the script requires `--yes`. Do not point it at a server you do not control, and be careful with hosted services: they can bill for the traffic or treat a burst from one address as abuse. A test from one home connection also measures that connection, so run it close to the server (the `make docker-stress` profile runs inside the stack's network) before drawing conclusions about the server.

To see the load on the relay while testing, start it with `RELAY_STATS_INTERVAL_SEC=5`: it writes a line with connections, rooms, memory and the number of clients it had to cut off.

## Tests against the stack

`make docker-e2e` runs the browser tests (Playwright, without the macOS-only visual tests) against the running stack instead of the dev server. The relay's own tests (`make relay-test`) cover the heartbeat and the slow-client cut-off.
