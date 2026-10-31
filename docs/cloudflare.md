# Setting up the relay with Cloudflare

Step-by-step guide to run the relay with **Cloudflare Realtime TURN**, protect `/ice` and verify everything. Everything here is done in the Cloudflare dashboard and in the settings of the service that hosts the relay (the examples use Render). The full list of variables is in [Relay server](relay.md).

What you end up with:

| Piece | Where it is configured |
|-------|------------------------|
| TURN credentials from Cloudflare | TURN key → relay variables |
| Only your sites can ask for them, with a rate limit | `ICE_ALLOWED_ORIGINS`, `ICE_RATE_LIMIT` |
| Abusive credentials are revoked, a monthly budget stops issuing | Analytics token → relay variables |
| Only real browsers can ask for them (optional, later) | Turnstile widget → relay and app |

Menu names in the dashboard change from time to time. If something is not where this page says, use the dashboard search (`Cmd/Ctrl + K`) or the linked Cloudflare documentation.

## 1. The TURN key

The TURN key is a long-term secret that stays on the relay and lets it mint short-lived credentials for the browsers. Cloudflare's documentation: [Generate credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

1. Cloudflare dashboard → **Realtime** → **TURN** and create a TURN key (any name, e.g. `pipol-relay`).
2. Copy the two values you are shown:
   - the **Token ID** → `CLOUDFLARE_TURN_KEY_ID`
   - the **API token** of the TURN key → `CLOUDFLARE_TURN_API_TOKEN` (**shown once**).
3. The API token here belongs to the TURN key. It is **not** a general Cloudflare API token.

Pricing: the first 1,000 GB per month are free, then $0.05 per GB (counted on the traffic from Cloudflare to the client). STUN at `stun.cloudflare.com` is free. Check the current terms on the Cloudflare site.

## 2. The analytics token and account id (usage guard)

Needed only for the [usage guard](relay.md#cloudflare-usage-guard): it revokes a credential that relays too much and stops issuing at a monthly budget. Skip this step to run without it; you can add it later.

**Account id**

- Dashboard search (`Cmd/Ctrl + K`) → type `Copy account ID` and select it, or
- **Workers & Pages** → *Account Details* → copy the **Account ID**.

→ `CLOUDFLARE_ACCOUNT_ID`

**API token with analytics access** (a *different* token from the TURN key's)

1. **My Profile → API Tokens → Create Token** (or **Manage Account → API Tokens** for an account-owned token; the user token from *My Profile* is the one tested here).
2. **Create Custom Token**, name it e.g. `pipol-relay-turn-analytics`.
3. Permissions: **Account → Account Analytics → Read**. Nothing else.
4. Account resources: **Include → your account**.
5. **Continue to summary → Create Token** and copy the value (**shown once**).

→ `CLOUDFLARE_ANALYTICS_TOKEN`

Check it works before using it (replace the value; it must answer `"status": "active"`):

```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer <token>"
```

Tokens have an expiry date (`expires_on` in the answer). Put it in your calendar: after that date the guard logs `could not read Cloudflare analytics` and stops working (it fails open, `/ice` keeps working).

## 3. Variables on the relay

Set these in the environment of the relay service and redeploy (on Render: *Environment*, then the service restarts).

```
TURN_PROVIDER=cloudflare
CLOUDFLARE_TURN_KEY_ID=<Token ID>
CLOUDFLARE_TURN_API_TOKEN=<API token of the TURN key>

# Who may ask for credentials
ICE_ALLOWED_ORIGINS=https://pipol.dev,https://*.pipol.dev

# Usage guard (optional)
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_ANALYTICS_TOKEN=<analytics token>
CLOUDFLARE_MONTHLY_BUDGET_GB=500
CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB=5
```

Points that are easy to get wrong:

- **`ICE_ALLOWED_ORIGINS` takes full origins, with the scheme**: `https://pipol.dev`, not `pipol.dev` or `*.pipol.dev`. Entries that are not valid are ignored, and if none is valid **every request is refused** (`403`); the log then says `origins: 0 allowed` and `ignored invalid entries: …`.
- `https://*.pipol.dev` covers subdomains but **not** `https://pipol.dev` itself: list both.
- Add `https://*.pipol.pages.dev` if you use Cloudflare Pages preview deployments, and `http://localhost:5173` for local development.
- Origins match scheme, host and port exactly (`http://pipol.dev` is not `https://pipol.dev`).
- Never commit these values and never paste the two tokens anywhere. If one leaks, revoke it in the dashboard (the TURN key, or the API token) and create a new one.

Do **not** set `TURNSTILE_SECRET` until the web app with `VITE_TURNSTILE_SITE_KEY` is released (see [Turnstile](#5-turnstile-optional)).

## 4. Verify

### 4.1 The startup log

After the redeploy the log must contain (the numbers match your settings):

```
[relay] TURN credentials: provider "cloudflare"
[relay] /ice access: origins: 2 allowed; 30 requests/min per IP
[relay] /ice human check (Turnstile): off (set TURNSTILE_SECRET to require it)
[relay] TURN usage guard: 500 GB/month budget, 5 GB/hour per credential, checked every 5 min
[relay] TURN usage this month: 0.00 GB
```

| If you see | It means |
|------------|----------|
| `TURN credentials: not configured` | The TURN variables are missing or misspelt (the names are `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`) |
| `TURN disabled: unknown TURN_PROVIDER …` or `… is missing its variables` | `TURN_PROVIDER` is misspelt or its variables are incomplete |
| `origins: 0 allowed` and `ignored invalid entries` | `ICE_ALLOWED_ORIGINS` is in the wrong format (see above) |
| `TURN usage guard: disabled (set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN …)` | One of the two guard variables is missing |
| `TURN usage guard could not read Cloudflare analytics: …` | The token, its permission or the account id is wrong; the message says which |

`TURN usage this month: 0.00 GB` is normal until there is TURN traffic.

### 4.2 The endpoint from outside

Replace `<relay>` with the relay's address and use one of your allowed origins:

```bash
# Allowed origin: 200 with iceServers (a STUN entry and a TURN entry with username and credential, ttl 3600)
curl -s -H "Origin: https://pipol.dev" https://<relay>/ice

# No Origin (curl, scripts): 403
curl -s -o /dev/null -w "%{http_code}\n" https://<relay>/ice

# Another site: 403
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" https://<relay>/ice
```

Also expected: `Access-Control-Allow-Origin` echoes your origin, `Cache-Control: no-store`, no URL on port 53 (browsers block it, the relay removes it), and every request returns a **different** username (one credential per request, which is what lets the guard revoke a single one).

### 4.3 A real TURN allocation

Credentials that Cloudflare does not accept would look fine in the answer, so check one for real: in a browser console on one of your allowed sites, or with Playwright, create an `RTCPeerConnection` with the returned `iceServers` and `iceTransportPolicy: 'relay'`; gathering must produce a candidate of type `relay`. This works over UDP 3478, TCP 3478 and TLS 443 (the last one is what passes strict corporate firewalls).

Once the web app is released, the same check is **Settings → Connection (TURN) → Test connection**, and during a call with diagnostics on, the tile shows **direct** or **via TURN**.

### 4.4 The rate limit and `TRUST_PROXY_HOPS`

The relay counts requests per client IP. Behind a hosting platform it does not see the client directly: it reads the IP from the `X-Forwarded-For` header, where every proxy on the way appends the address it received the request from. `TRUST_PROXY_HOPS` (default `1`) says which entry to trust, **counted from the right**: `1` is the last entry, `2` the one before it, and so on. If it is wrong, either everybody shares one counter (a private `10.x` address, the platform's own proxy) or the limit can be dodged by sending a fake header.

To set it from real data (if you use `LOG_HIDE_SENSITIVE=true`, switch it off for this step: the rate-limit line is not written otherwise):

1. Call `/ice` with an allowed origin more than `ICE_RATE_LIMIT` times in a minute until you get `429` (`curl -s -o /dev/null -w "%{http_code} " -H "Origin: https://pipol.dev" https://<relay>/ice`, in a loop).
2. In the relay log find the line (it is written once per blocked IP):

   ```
   [relay] /ice rate limit hit for <ip> (TRUST_PROXY_HOPS=1, X-Forwarded-For: <entries>, socket: <address>)
   ```
3. Get your public address with `curl -4 ifconfig.me` and `curl -6 ifconfig.me` (the request may have used either).
4. Find your address in the `X-Forwarded-For` list and count from the right: if it is the 3rd entry from the right, set `TRUST_PROXY_HOPS=3`. If the list is `none` or your address is not in it, the platform does not forward the client address in that header and the per-IP limit cannot tell users apart; raise `ICE_RATE_LIMIT` accordingly.
5. After redeploying, check the limit cannot be dodged with a fake header. Each request claims a different address, and with the right value the relay must still count yours and answer `429` after `ICE_RATE_LIMIT` requests:

   ```bash
   for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " -H "Origin: https://pipol.dev" -H "X-Forwarded-For: 9.9.9.$i" https://<relay>/ice; done; echo
   ```

   If every request succeeds, `TRUST_PROXY_HOPS` is too high: lower it.

A block lasts at most a minute (the counting window is 60 seconds).

## 5. Turnstile (optional)

[Turnstile](relay.md#turnstile) makes sure only real browsers on your site get credentials. It needs the relay and the web app configured **together**, so do it after the web app that supports it is released:

1. Dashboard → **Turnstile** → add a widget for your hostnames (mode *Managed*). Note the site key and the secret key.
2. Build the web app with `VITE_TURNSTILE_SITE_KEY=<site key>` and release it.
3. Then set `TURNSTILE_SECRET=<secret key>` on the relay.

If you set the secret first, `/ice` answers `403` to the current web app and TURN silently stops working.

## 6. Day-to-day

| Task | How |
|------|-----|
| See usage | Cloudflare dashboard → Realtime → TURN analytics (usage shows up within about 30 seconds). The relay log prints `TURN usage this month` at startup |
| Set an alert | Add a billing/usage notification in Cloudflare so a spike reaches you by email |
| Tune the hourly limit | Measure real calls with the diagnostics overlay (the `↓` rate times 3,600 is bytes per hour) and set `CLOUDFLARE_CREDENTIAL_HOURLY_LIMIT_GB` to about twice the heaviest normal case. See [choosing the limit](relay.md#cloudflare-usage-guard) |
| A credential was revoked | The log shows `TURN credential xxxxxxxx… revoked: N GB in the last hour` |
| Budget reached | The log shows `TURN budget reached …`; `/ice` answers an empty list and clients use public STUN until usage drops |
| Rotate the TURN key | Create a new TURN key, update the two variables, redeploy, then delete the old key (this invalidates credentials already issued) |
| Rotate the analytics token | Create a new token, update `CLOUDFLARE_ANALYTICS_TOKEN`, redeploy, delete the old one. Do it before `expires_on` |
| Emergency stop | Delete the TURN key in the dashboard and/or set `ICE_DISABLED=true` on the relay (`/ice` answers `404`) |

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `/ice` answers `403` to your own site | `ICE_ALLOWED_ORIGINS` has the wrong format, lacks the exact origin (scheme, host, port) or the request has no `Origin` header |
| `/ice` answers `{"iceServers":[],"ttl":0}` | TURN variables missing or misspelt, or the monthly budget has been reached (check the log) |
| `/ice` answers `502 ice-unavailable` | Cloudflare refused the TURN key: wrong id or token, or the key was deleted. The log has `/ice failed: Cloudflare TURN responded <status>` |
| `/ice` answers `429` | More than `ICE_RATE_LIMIT` requests per minute from one IP, or `TRUST_PROXY_HOPS` is wrong (the log line shows which IP was counted, see [4.4](#44-the-rate-limit-and-trust_proxy_hops)) |
| `/ice` answers `403 turnstile-…` | `TURNSTILE_SECRET` is set but the web app does not send a token |
| The first `/ice` after a pause is slow | A free Render instance sleeps when idle; after 4 seconds the app falls back to public STUN and uses TURN on the next request |
| `could not read Cloudflare analytics: GraphQL …` | Wrong token permission, wrong account id, or an expired token. The guard keeps working with its last state and `/ice` is not affected |
