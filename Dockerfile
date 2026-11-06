# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

# Web app image: the app is built when the container STARTS, with the addresses of the relay and the auth server
# taken from its environment, and served by nginx. The browser talks to the relay and the auth server directly,
# so those addresses must be reachable from the browser (not just from this container).
#
#   docker build -t pipol-web .
#   docker run -p 8080:8080 \
#     -e VITE_DHT_RELAY_URL=wss://relay.example.com \
#     -e VITE_AUTH_URL=https://auth.example.com \
#     pipol-web
#
# Building at start-up takes a few seconds, and the image carries Node and the dependencies to do it, which
# makes it larger than one that only holds a finished build. The image sends no security headers (put them on
# the reverse proxy in front of it, see docs/docker.md).
# None of the variables is a secret: they end up in the JavaScript sent to every browser (the Turnstile site key
# is public by design), so the "secrets in ARG/ENV" check, which only looks at the names, is skipped.

FROM node:24-slim

# nginx serves the built app; corepack provides pnpm for the install below
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

# Everything below runs as the unprivileged `node` user, which also owns /app (the build writes to it)
RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY --chown=node:node index.html vite.config.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node docker/start.sh ./docker/
COPY docker/nginx.conf /etc/nginx/nginx.conf

# Where the BROWSER finds the services. The defaults suit everything on one machine; change them with -e.
# Empty VITE_AUTH_URL: no sign-in providers. Empty VITE_DHT_RELAY_URL: the relay at the same address as the app.
ENV VITE_DHT_RELAY_URL=ws://localhost:8787 \
    VITE_AUTH_URL=http://localhost:8081 \
    VITE_ICE_URL= \
    VITE_TURNSTILE_SITE_KEY= \
    VITE_TURN_DISABLED=

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "docker/start.sh"]
