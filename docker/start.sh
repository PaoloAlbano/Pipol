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

# An address with the wrong scheme would give an app that silently cannot connect: stop here instead
check() {
  name=$1 value=$2
  shift 2
  [ -n "$value" ] || return 0
  for scheme in "$@"; do
    case "$value" in "$scheme"*) return 0 ;; esac
  done
  echo "[web] $name must start with $*, got: $value" >&2
  exit 1
}
check VITE_DHT_RELAY_URL "${VITE_DHT_RELAY_URL:-}" ws:// wss://
check VITE_AUTH_URL "${VITE_AUTH_URL:-}" http:// https://
check VITE_ICE_URL "${VITE_ICE_URL:-}" http:// https://

# vite is called directly: pnpm would try to download itself again, and the container may have no internet
node node_modules/vite/bin/vite.js build --logLevel warn

echo "[web] serving on port 8080"
# -e: the default error log path is not writable by this user; nginx otherwise warns about it at start-up
exec nginx -e /dev/stderr -g 'daemon off;'
