# Relay server

`relay/server.js` is a small Node server. It never sees message content when peers can connect directly; it only helps them find each other and, when a direct connection fails, carries traffic as a fallback.

## What it serves

| Path | What | Notes |
|------|------|-------|
| `GET /` | Health check, answers `OK` | Used by load balancers and tests |
| `WebSocket /signal` | Room-based signalling: peers join a room and exchange WebRTC offers/answers and ICE candidates. Also the `relay-data` fallback when a data channel cannot open | Main entry point of the app |
| `WebSocket /` | DHT relay for browsers (`@hyperswarm/dht-relay`) | Needs the relay's `hyperdht` node |
| `GET /ice` | ICE servers (STUN/TURN) with short-lived credentials | Protected, see [Protecting `/ice`](#protecting-ice). `ICE_DISABLED=true` turns it off |

Run it with `make start-relay` (or `cd relay && npm start`), or with the Docker image built from `relay/Dockerfile`. It listens on `PORT` (default `8787`).

## Configuration at a glance

The relay is configured only through environment variables. Nothing is required: with no variables it works as a signalling relay and `/ice` answers an empty list (clients use public STUN).

### Server

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | Listening port |
| `LOG_HIDE_SENSITIVE` | off | `true` stops the relay from logging who connects: the lines with client IPs, room names and peer ids are not written. See [Logs and privacy](#logs-and-privacy) |

### TURN provider

`/ice` hands out TURN credentials. Choose a provider with `TURN_PROVIDER`, or leave it unset and the first provider whose variables are present is used (order: `coturn`, `static`, `http`, `cloudflare`). The relay logs the provider it picked at startup, and reports a misspelt or incomplete `TURN_PROVIDER`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `TURN_PROVIDER` | auto | `coturn`, `static`, `http` or `cloudflare` |
| `TURN_TTL` | `3600` | Lifetime in seconds of minted credentials. The app renews them before they expire |
| `ICE_DISABLED` | off | `true`/`1`/`yes` switches `/ice` off: it answers `404`, whatever else is configured |

| Provider | Variables | Use it with |
|----------|-----------|-------------|
| `coturn` | `TURN_URLS`, `TURN_SECRET` | [coturn](https://github.com/coturn/coturn) with `use-auth-secret`, [eturnal](https://eturnal.net), any TURN REST API with a shared secret. Each request gets its own short-lived credential |
| `static` | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Any TURN with a single fixed login |
| `http` | `TURN_API_URL`, optional `TURN_API_AUTHORIZATION` | A service that returns ICE servers over HTTP (Metered, Xirsys, your own API). Accepts `[ … ]` or `{ "iceServers": [ … ] }` |
| `cloudflare` | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/). Each request gets its own credential |

`TURN_URLS` is a comma-separated list, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. URLs on port 53 are dropped from every provider's answer (browsers block it and waiting for the timeout slows ICE down).

### Protecting `/ice`

| Variable | Default | Meaning |
|----------|---------|---------|
| `ICE_ALLOWED_ORIGINS` | unset (open) | Comma-separated web origins allowed to call `/ice`, e.g. `https://pipol.pages.dev,https://*.pipol.pages.dev,http://localhost:5173`. A leading `*.` matches any subdomain; `*` allows everything. When set, other sites **and requests without an `Origin` header** (curl, scripts) get `403` |
| `ICE_RATE_LIMIT` | `30` | Requests per minute per client IP; `0` disables. Beyond it: `429` with `Retry-After` |
| `TRUST_PROXY_HOPS` | `1` | Reverse proxies in front of the relay: **`3` on Render** (Cloudflare, then Render's own proxy, then the relay; measured, see [Cloudflare setup](cloudflare.md#44-the-rate-limit-and-trust_proxy_hops)), `1` behind a single proxy of your own. The client IP is read from `X-Forwarded-For` counting entries from the right; `0` uses the socket address |
| `TURNSTILE_SECRET` | unset (off) | Requires a valid Cloudflare Turnstile token on every `/ice` request. Works with any TURN provider |

### Cloudflare usage guard (variables)

Only with the `cloudflare` provider. See [Cloudflare usage guard](#cloudflare-usage-guard).

| Variable | Default | Meaning |
|----------|---------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | | Cloudflare account id |
| `CLOUDFLARE_ANALYTICS_TOKEN` | | API token with **Account Analytics: Read** (not the TURN key token) |
| `CLOUDFLARE_MONTHLY_BUDGET_GB` | unset | Stop issuing credentials at this monthly egress (decimal GB) |
| `CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB` | `8` | Revoke a credential that relays more than this in one hour; `0` disables |
| `CLOUDFLARE_GUARD_INTERVAL_MIN` | `5` | How often usage is checked |

### Testing overrides

`TURNSTILE_VERIFY_URL`, `CLOUDFLARE_TURN_API_URL` and `CLOUDFLARE_GRAPHQL_URL` replace the Cloudflare endpoints. They exist only so the integration tests can run against fake servers; do not set them in production.

## Recipes

### Cloudflare Realtime TURN

The complete walkthrough, with verification and troubleshooting, is in [Setting up the relay with Cloudflare](cloudflare.md). In short:

1. Cloudflare dashboard → Realtime → TURN: create a **TURN key** (any name). You get a **Token ID** and an **API token** (the token is shown once).
2. On the relay set `CLOUDFLARE_TURN_KEY_ID=<Token ID>` and `CLOUDFLARE_TURN_API_TOKEN=<API token>` (optionally `TURN_PROVIDER=cloudflare`). The API token here is the one of the TURN key, **not** a general Cloudflare API token.
3. Redeploy or restart the relay and check the log: `[relay] TURN credentials: provider "cloudflare"`.
4. `curl https://<relay>/ice` must return `iceServers` with `turn.cloudflare.com`, a `username` and a `credential` (add an `Origin` header if you set `ICE_ALLOWED_ORIGINS`, and a Turnstile token if you require it).

Pricing: the first 1,000 GB per month are free, then $0.05 per GB (traffic from Cloudflare to the client). STUN at `stun.cloudflare.com` is free. Set a billing/usage alert on your account and consider the [usage guard](#cloudflare-usage-guard).

### Your own coturn

1. Start from [`relay/turnserver.example.conf`](../relay/turnserver.example.conf). It sets `use-auth-secret`, quotas and a bandwidth cap and, importantly, **blocks relaying towards internal networks** (`denied-peer-ip` for loopback, private ranges and the cloud metadata address `169.254.169.254`). Without that, valid credentials turn the TURN into a proxy into your network.
2. Put the same secret in coturn's `static-auth-secret` and in the relay's `TURN_SECRET`.
3. On the relay: `TURN_PROVIDER=coturn`, `TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp`, `TURN_SECRET=…`.

The relay gives each request its own credential id, so coturn's `user-quota` applies per issuance and each allocation is attributable in the coturn logs. Hosts that only expose HTTP (such as Render) cannot run a TURN server: use a VPS with the UDP/TCP ports open. `make turn-e2e` starts a throw-away hardened coturn in Docker and checks the whole chain.

### Metered, Xirsys or another service

Use the `http` provider: `TURN_API_URL` is the URL of the service's "get ICE servers" API (with the API key in it, or in `TURN_API_AUTHORIZATION`). Free tiers: Metered 20 GB/month with an account; Xirsys 500 MB/month with a hard cap, too little for video.

### A fixed login

`TURN_PROVIDER=static` with `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`. Credentials never expire and are shared by everyone, so prefer `coturn` or `cloudflare`.

## Protecting `/ice`

`/ice` must be reachable by every browser that opens the app, so it cannot require a login: anyone who knows the relay URL can ask for credentials and use your TURN until they expire. The relay applies these checks, in this order:

| # | Check | Configured by | Refused with |
|---|-------|---------------|--------------|
| 1 | Allowed origin | `ICE_ALLOWED_ORIGINS` | `403 origin-not-allowed` |
| 2 | Rate limit per IP | `ICE_RATE_LIMIT`, `TRUST_PROXY_HOPS` | `429 rate-limited` |
| 3 | Turnstile token | `TURNSTILE_SECRET` | `403 turnstile-required` / `turnstile-failed`, `503 turnstile-unavailable` |
| 4 | Monthly budget not used up (Cloudflare) | `CLOUDFLARE_MONTHLY_BUDGET_GB` | `200` with an empty list (clients use public STUN) |
| 5 | A credential minted for this request | provider, `TURN_TTL` | `502 ice-unavailable` if the provider fails |

The origin check stops other websites and casual use, but `Origin` can be forged outside a browser, so on its own it does not stop a script. Turnstile and the usage guard are the layers that do.

### Turnstile

[Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) is a free challenge that proves the request comes from a real browser on your site. The widget runs in the background; only if Cloudflare is unsure it shows a small check. The browser ends up with a token that is single-use and valid for 5 minutes; the relay verifies it with Cloudflare using the secret key.

It is independent of the TURN provider and does not require your site to be hosted on Cloudflare (a Cloudflare account is only needed to create the widget).

1. Cloudflare dashboard → Turnstile → add a widget for your app's hostname(s), mode *Managed*. Note the **site key** and the **secret key**.
2. Relay: `TURNSTILE_SECRET=<secret key>`.
3. App build: `VITE_TURNSTILE_SITE_KEY=<site key>`. The Content-Security-Policy in `public/_headers` already allows `challenges.cloudflare.com`.

The webapp decides at build time whether to use Turnstile; the relay does not tell it. **Configure both sides together**: if the relay requires Turnstile and the app has no site key, `/ice` answers `403` and the app silently falls back to public STUN (no TURN). A new token is requested for every `/ice` fetch, and it is only sent to the app's own relay, never to a third-party one. If Cloudflare cannot be reached the relay refuses with `503` (fail closed) and the app uses public STUN.

When Turnstile is on, the app loads a script from `challenges.cloudflare.com`. Leave it off (the default) if you do not want that third party involved.

### Cloudflare usage guard

Credentials can never be hidden from the browser, so with the `cloudflare` provider the relay also bounds the damage using Cloudflare's own usage analytics. It mints **one credential per request**, and every few minutes it reads the TURN usage:

- a credential that relayed more than `CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB` in the last hour is **revoked**;
- once the month's egress reaches `CLOUDFLARE_MONTHLY_BUDGET_GB`, `/ice` **stops issuing credentials** until usage drops; credentials already issued expire within `TURN_TTL`.

It needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ANALYTICS_TOKEN` (create an API token with **Account Analytics: Read**).

Choosing the hourly limit: 8 GB/hour is about 18 Mbit/s sustained. A call received entirely through TURN is roughly 1 GB/hour for two people at 720p, 2.7 GB/hour for four at 720p, 4.5 GB/hour for four at 1080p, and 8–9 GB/hour for six at 1080p with screen sharing (estimates). Only a minority of participants need TURN. Measure your real calls with the diagnostics overlay (the `↓` rate on the tile, times 3,600) and set the limit to about twice the heaviest normal case. A scraper pulling data at 50–100 Mbit/s passes 8 GB within minutes and is revoked within about 15.

The guard **fails open**: if analytics cannot be read it keeps its last state and only logs; it never takes `/ice` down by itself. At startup it logs `TURN usage this month: … GB`; if the token or the query is wrong it logs the error instead, so check the log after configuring it. The analytics queries follow Cloudflare's documentation and are tested against fake responses, not against a live account.

The guard exists only for Cloudflare. For coturn use its native limits (`max-bps` per session, `user-quota`, `total-quota`, `bps-capacity`, see the example configuration) and the bandwidth of your server plan; for Metered/Xirsys, the limits of your plan.

## Logs and privacy

By default the relay logs enough to operate it, and that includes identifiers: the address of each DHT connection, the first characters of a peer id and the **name of the room** being joined or left (for a quick room that name is the room's secret), the IP and proxy chain of the first client that hits the rate limit, and the first characters of a revoked credential's id.

Set `LOG_HIDE_SENSITIVE=true` and those lines are **not written at all**:

| Not logged | Still logged |
|------------|--------------|
| `DHT + connected` / `DHT - disconnected` (client address) | Startup lines, TURN provider, `/ice` policy |
| `joined room` / `left room` (peer id, room name) | `/ice` errors, Turnstile refusals |
| `/ice rate limit hit for …` (IP and proxy chain) | Usage guard lines (budget reached, usage this month, errors) |
| The first characters of a credential id (the line `TURN credential revoked: N GB in the last hour` is still written, without the id) | Unexpected errors |

At startup the relay writes `log: client IPs, room names and peer ids are not logged (LOG_HIDE_SENSITIVE)`. Only the exact value `true` turns it on.

The switch only changes the relay's own log. The hosting platform keeps its own request logs, and the relay process still holds IP addresses in memory while it counts requests for the rate limit (never written anywhere). Since the rate-limit line is not written, turn the switch off temporarily when you need it, for instance to set `TRUST_PROXY_HOPS` from the logged proxy chain ([Cloudflare setup](cloudflare.md#44-the-rate-limit-and-trust_proxy_hops)).

## Verifying

1. **Startup log** (every line starts with `[relay]`):

   | Message | Meaning |
   |---------|---------|
   | `TURN credentials: provider "cloudflare"` | The provider in use |
   | `TURN credentials: not configured (clients use public STUN)` | No provider variables found |
   | `TURN disabled: unknown TURN_PROVIDER … / missing its variables` | `TURN_PROVIDER` is misspelt or incomplete |
   | `/ice access: origins: 2 allowed; 30 requests/min per IP` | Effective origin and rate-limit policy (`open to every origin` if unset) |
   | `/ice human check (Turnstile): required` | `TURNSTILE_SECRET` is set |
   | `TURN usage guard: …` and `TURN usage this month: … GB` | Guard enabled and able to read analytics |
   | `TURN usage guard could not read Cloudflare analytics: …` | Wrong token, permissions or query |
   | `/ice endpoint: DISABLED (ICE_DISABLED=true)` | The endpoint is off |
   | `log: client IPs, room names and peer ids are not logged` | `LOG_HIDE_SENSITIVE` is on |

2. **The endpoint**: `curl https://<relay>/ice` (with an `Origin` header if you set an allow-list). A healthy answer is `{"iceServers":[…],"ttl":3600}` with a `username` and `credential` on the TURN entry. `{"iceServers":[],"ttl":0}` means no provider is configured (or the budget is used up).

3. **In the app**: Settings → Connection (TURN) → **Test connection** must say a relayed address was allocated. During a call with diagnostics on, the tile shows **direct** or **via TURN (udp/tcp/tls)**; "Always relay" forces the second.

During operation the log also shows `/ice rate limit hit for <ip> (TRUST_PROXY_HOPS=…, X-Forwarded-For: …, socket: …)` (once per client; the proxy chain it prints is what you need to set `TRUST_PROXY_HOPS`, see [Cloudflare setup](cloudflare.md#44-the-rate-limit-and-trust_proxy_hops)), `/ice Turnstile refused: <codes>`, `/ice failed: <reason>`, `TURN budget reached …` and `TURN credential xxxxxxxx… revoked: N GB in the last hour`.

## Disabling

- **TURN only**: remove the provider variables (`CLOUDFLARE_TURN_*`, `TURN_URLS`, …). `/ice` then answers an empty list and clients use public STUN.
- **The whole endpoint**: `ICE_DISABLED=true`. `/ice` answers `404` and the app treats it as "no TURN here". The rest of the relay is unaffected.
- **If you suspect abuse**: revoke or delete the TURN key in the Cloudflare dashboard (this invalidates credentials already issued) and remove it from the relay.
- **In the app**: see [TURN and calls](turn.md#switching-it-off).

## Deploying

- **Docker**: `docker build -t pipol-relay relay` then run it with the variables above (`-e NAME=value`). The image runs as the unprivileged `node` user and exposes `8787`.
- **Render** or similar: build from `relay/Dockerfile`, set the variables under Environment and redeploy (the relay caches credentials in memory, so a restart clears them). Set `TRUST_PROXY_HOPS=3` on Render (the default `1` would count Render's internal proxies, of which there are several, instead of your users) and check it as described in [Cloudflare setup](cloudflare.md#44-the-rate-limit-and-trust_proxy_hops). A free instance sleeps when idle: the first `/ice` after a pause can be slow, and after 4 seconds the app falls back to public STUN.
- Never commit secrets (`CLOUDFLARE_TURN_API_TOKEN`, `TURN_SECRET`, `TURNSTILE_SECRET`, …). If one leaks, revoke it at the provider and replace it.

## Tests

```bash
make relay-test                 # unit and integration tests (Node test runner)
cd relay && npm run test:coverage   # same, with a coverage table in the output
make turn-e2e                   # needs Docker: real coturn + relay + Chromium
```
