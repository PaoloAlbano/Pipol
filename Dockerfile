# syntax=docker/dockerfile:1

# Web app image: the built PWA served by nginx, with the relay (/signal, /ice) and the auth server (/auth)
# proxied under the same origin, so the browser needs no cross-origin configuration.
#
#   docker build -t pipol-web .
#   docker run -p 8080:8080 --ulimit nofile=262144:262144 -e RELAY_UPSTREAM=http://relay:8787 pipol-web
#
# Everything is on one origin, so the app finds the relay by itself (wss://<host>/signal). Only the auth server
# needs a build argument, because the app has no other way to know where it is (VITE_AUTH_URL, default /auth).
# The Vite variables are fixed at build time: change one and rebuild.

# ── Build ───────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY docker/headers-to-nginx.mjs ./docker/

ARG VITE_AUTH_URL=/auth
ARG VITE_DHT_RELAY_URL=
ARG VITE_ICE_URL=
ARG VITE_TURNSTILE_SITE_KEY=
ARG VITE_TURN_DISABLED=
ENV VITE_AUTH_URL=$VITE_AUTH_URL \
    VITE_DHT_RELAY_URL=$VITE_DHT_RELAY_URL \
    VITE_ICE_URL=$VITE_ICE_URL \
    VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY \
    VITE_TURN_DISABLED=$VITE_TURN_DISABLED

RUN pnpm build \
 && node docker/headers-to-nginx.mjs public/_headers /headers.conf

# ── Serve ───────────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:stable-alpine

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /headers.conf /etc/nginx/headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Where the proxied services are (replaced in the server block at start-up)
ENV RELAY_UPSTREAM=http://relay:8787 \
    AUTH_UPSTREAM=http://auth:8080 \
    DNS_RESOLVER=127.0.0.11

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
