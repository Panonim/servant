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

ENV PORT=6061
EXPOSE 6061

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://localhost:6061/healthz || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
