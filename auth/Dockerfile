FROM node:26-slim

WORKDIR /app

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY server.js providers.json ./
COPY src ./src

# The version and the commit this image was built for (shown by /version); set by the release
ARG GIT_COMMIT=
ARG APP_VERSION=
ENV GIT_COMMIT=$GIT_COMMIT APP_VERSION=$APP_VERSION

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/healthcheck').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

USER node

CMD ["node", "server.js"]
