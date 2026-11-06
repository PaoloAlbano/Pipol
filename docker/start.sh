#!/bin/sh
# Start-up of the web image: build the app with the addresses of the relay and the auth server given in the
# environment, then serve it. The app is static, so those addresses are fixed into the build; building here,
# when the container starts, is what lets you pick them with `-e` instead of at `docker build` time.
#
#   VITE_DHT_RELAY_URL   where the browser reaches the relay (ws://… or wss://…)
#   VITE_AUTH_URL        where the browser reaches the auth server (http://… or https://…); empty = no sign-in providers
#   VITE_ICE_URL, VITE_TURNSTILE_SITE_KEY, VITE_TURN_DISABLED   see docs/turn.md

set -eu

cd /app

echo "[web] building the app"
echo "[web]   relay: ${VITE_DHT_RELAY_URL:-(same address as the app)}"
echo "[web]   auth:  ${VITE_AUTH_URL:-(none)}"

# A bad address fails here, before anything is built; the Content-Security-Policy gets the addresses that were given
node docker/headers-to-nginx.mjs public/_headers /tmp/headers.conf \
  "${VITE_DHT_RELAY_URL:-}" "${VITE_AUTH_URL:-}" "${VITE_ICE_URL:-}"

# vite is called directly: pnpm would try to download itself again, and the container may have no internet
node node_modules/vite/bin/vite.js build --logLevel warn

echo "[web] serving on port 8080"
# -e: the default error log path is not writable by this user; nginx otherwise warns about it at start-up
exec nginx -e /dev/stderr -g 'daemon off;'
