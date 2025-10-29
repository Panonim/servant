FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# For HEALTHCHECK
RUN apk add --no-cache curl

# Copy manifests first to leverage layer cache
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app
COPY server.js ./server.js
COPY public ./public

ENV PORT=6060
EXPOSE 6060

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://localhost:6060/healthz || exit 1

CMD ["node", "server.js"]

