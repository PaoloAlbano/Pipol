FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./

ENV PORT=8787
EXPOSE 8787

USER node

CMD ["node", "server.js"]
