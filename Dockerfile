FROM node:20-alpine

# Build argument to determine environment (defaults to production)
ARG BUILD_ENV=production
ENV NODE_ENV=${BUILD_ENV}
WORKDIR /app

# For HEALTHCHECK and proper signal handling
RUN apk add --no-cache curl tini

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

# Ensure PID 1 properly forwards signals and reaps zombies
STOPSIGNAL SIGTERM
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]

