# TURN and calls

## STUN, TURN and ICE in two minutes

WebRTC connects two devices directly whenever it can. To find a route it tries, in order of preference:

1. **A direct path** between the two devices (same network, or through NAT).
2. **STUN**: a public server tells each device what its public address is, which usually makes a direct path possible through NAT.
3. **TURN**: when no direct path works (symmetric NAT, some mobile carriers, strict corporate firewalls), a relay server carries the traffic.

This procedure is called **ICE** (*Interactive Connectivity Establishment*) and the list of STUN/TURN servers is the `iceServers` list given to `RTCPeerConnection`. That is why the relay's endpoint is called [`/ice`](relay.md#what-it-serves). TURN is always the last resort: the browser only uses it when every direct path failed (unless the user picks "Always relay").

A TURN server only sees packets that are already end-to-end encrypted (DTLS-SRTP), so it cannot read audio, video or messages. It does see the participants' IP addresses and the volume and timing of the traffic.

## How the app uses it

- **TURN is for video calls only.** Chat connections (data channels) use public STUN and, if they cannot connect, fall back to the relay's WebSocket. This keeps chat from consuming TURN bandwidth. A user can opt in to TURN for chat in Settings.
- The app asks the relay for the ICE servers when it joins, before each call, and again before the credentials expire, **also during a call**, swapping the new credentials into the live connections. If the relay cannot be reached it keeps the credentials it has and retries after 30 seconds.
- If anything fails (no relay answer, an error, no TURN configured) calls fall back to public STUN, so a broken TURN setup never blocks a call.

> The relay-WebSocket fallback for chat carries channel messages in clear text for the relay operator (direct messages are encrypted separately). Enabling "Also use TURN for chat" makes that fallback less likely, but does not remove it. Encrypting the fallback is planned.

## Who can choose what

Precedence, highest first:

| Level | Where | What |
|-------|-------|------|
| **User** | Settings → Connection (TURN) | **Default** (workspace/app TURN), **Custom** (your own servers: URLs, username, password), **Off** (public STUN only). Extra options: *Also use TURN for chat*, *Always relay* (hides your IP from other participants, in calls and chat; needs a TURN server and adds latency) and **Test connection**, which checks that a relayed address can be allocated |
| **Workspace** | Create workspace → Advanced configuration | Fixed TURN servers or an ICE endpoint URL, embedded in the invite link. Members can still override or disable it in their own Settings |
| **App** | The relay's `/ice`, or `VITE_ICE_URL` | The default for everyone |

Credentials written in an invite link are visible to everyone who has the link: for a workspace, prefer an ICE endpoint that issues short-lived credentials. Invites are validated strictly when opened (only `turn:`, `turns:`, `stun:` URLs, TURN entries need a username and password, endpoints must be http/https), and the "Join workspace" dialog lists any custom relay, auth or TURN servers before the user accepts.

The workspace configuration looks like this inside the invite payload:

```json
{
  "config": {
    "relayUrl": "wss://relay.example.com",
    "authUrl": "https://auth.example.com",
    "ice": {
      "servers": [{ "urls": ["turn:turn.example.com:3478"], "username": "…", "credential": "…" }],
      "url": "https://relay.example.com/ice"
    }
  }
}
```

`ice.servers` and `ice.url` are alternatives (static servers win if both are present).

## App build variables

Set at build time (`.env`, or the Pages/hosting build variables). See `.env.example`.

| Variable | Meaning |
|----------|---------|
| `VITE_DHT_RELAY_URL` | WebSocket URL of the relay, e.g. `wss://relay.example.com`. The default ICE endpoint is derived from it (`https://relay.example.com/ice`) |
| `VITE_ICE_URL` | Explicit ICE endpoint, if it is not `<relay>/ice` |
| `VITE_TURNSTILE_SITE_KEY` | Turnstile site key. Set it only if the relay sets `TURNSTILE_SECRET`; see [Turnstile](relay.md#turnstile) |
| `VITE_TURN_DISABLED` | `true`/`1`/`yes` is a kill switch, see below |
| `VITE_AUTH_URL` | The auth server (login), unrelated to TURN |

## Switching it off

- **A user**: Settings → Connection (TURN) → **Off**.
- **A workspace**: leave the TURN fields empty when creating it.
- **The whole app**: build with `VITE_TURN_DISABLED=true`. The app then uses public STUN only: it makes no `/ice` request, ignores the workspace's TURN, hides the TURN fields when creating a workspace and shows a notice in Settings. Users can still pick **Custom** servers of their own. "Always relay" has no effect without a TURN server.
- **The relay**: [`ICE_DISABLED=true`](relay.md#disabling). `/ice` answers `404`, which the app treats as "no TURN here" (it does not log a warning and does not ask again for a while).

## Diagnostics

Turn on network stats in Settings. During a call each remote tile shows how the media travels:

- **direct** (green): a direct path;
- **via TURN (udp|tcp|tls)** (orange): relayed, with the protocol used to reach the TURN server;
- below it the candidate types (`host`, `srflx`, `relay`), the round-trip time and the current rate in each direction.

If calls through TURN fail, run **Test connection** in Settings first, then check the relay log ([Verifying](relay.md#verifying)).

## Security model

- Credentials are short-lived (default 1 hour) and renewed automatically. They cannot be hidden from the browser, so whoever holds valid ones can use the TURN until they expire. That is why the relay limits who gets them: [Protecting `/ice`](relay.md#protecting-ice).
- Layers today: origin allow-list, rate limit per IP, Turnstile (only real browsers), one credential per request, and, with Cloudflare, a guard that revokes credentials with abnormal usage and stops issuing at a monthly budget. For coturn, the hardened example configuration blocks relaying to internal networks and sets quotas.
- A user who owns a real browser can still obtain credentials, but only a few per minute, each limited in time and (with Cloudflare) revoked if it relays too much.
- Not implemented yet: tying credentials to an identity (a signed ticket issued by the auth server after login, with per-user limits and bans), a usage guard for coturn, and issuing credentials only when a direct connection has failed.
