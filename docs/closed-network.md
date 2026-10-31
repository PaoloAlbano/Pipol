# Closed networks

Pipol is meant to run on a private network (intranet, air-gapped) with no calls to third parties. **This is not fully supported yet**: a few outgoing requests are still built in (listed below). The work to remove them is planned.

## What you can do today

| Component | For a closed network |
|-----------|----------------------|
| Relay and web app | Host both on your network. Point the app at your relay (`VITE_DHT_RELAY_URL`, or the workspace's custom relay URL) and, if you use login, at your auth server (`VITE_AUTH_URL`) |
| TURN | Do not set any `CLOUDFLARE_*` variable. Run your own coturn: `TURN_PROVIDER=coturn` with `TURN_URLS` pointing at an internal host (coturn also answers STUN). Or switch TURN off: `ICE_DISABLED=true` on the relay and `VITE_TURN_DISABLED=true` in the app build. See [Relay server](relay.md#your-own-coturn) |
| Turnstile | Leave `TURNSTILE_SECRET` and `VITE_TURNSTILE_SITE_KEY` unset (the default). Nothing is loaded from Cloudflare and the relay never calls it. Protect `/ice` with `ICE_ALLOWED_ORIGINS` and the rate limit instead |
| Cloudflare usage guard | Leave the `CLOUDFLARE_*` variables unset |
| Login | Use an OIDC provider you host (add it to `auth/providers.json` with its issuer), or skip login with quick rooms |

The Content-Security-Policy in `public/_headers` allows `challenges.cloudflare.com` for Turnstile; if you serve the app yourself you can remove that entry, since nothing loads from there unless Turnstile is configured.

There are no CDN fonts or other third-party assets.

## Still contacting the outside world today

1. **Public STUN (Google).** The built-in default in `src/webrtc/ice.js` (`stun.l.google.com` and `stun1.l.google.com`) is used by:
   - **chat connections**, unless "Also use TURN for chat" or "Always relay" is on, even when `/ice` returns your own coturn;
   - **calls** as a fallback, when `/ice` returns no servers (no TURN configured, an error, or **Off** in Settings).

   With an internal coturn behind `/ice`, calls use only your servers, but chat connections still query Google's STUN. Until the default is configurable, block outbound UDP to ports 3478 and 19302 at your firewall: peers on the same network should still connect through their local addresses.
2. **Emoji images.** The emoji picker loads OpenMoji SVGs from `cdn.jsdelivr.net` (`src/p2p/emoji-wordlist.js`). If blocked, the picker shows broken images.
3. **The relay's DHT node.** `relay/server.js` starts a `hyperdht` node that contacts the public Holepunch bootstrap nodes. Without internet the relay still starts (about 6 seconds slower, measured with an unreachable bootstrap) and signalling (`/signal`) does not depend on it.

## Planned

- A configurable STUN list (`VITE_STUN_URLS`, or `none`), applied to chat connections, to "Off" in Settings and to the fallback.
- A configurable base URL for the emoji images, or assets served locally (OpenMoji is CC BY-SA 4.0).
- Relay: `DHT_BOOTSTRAP` (internal nodes) and `DHT_DISABLED=true`, after checking that the app only needs `/signal`.
- A check, with a test, that nothing else is fetched from outside at runtime (fonts, scripts, OIDC providers).
