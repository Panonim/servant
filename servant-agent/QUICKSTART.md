# ServAnt Agent - Quick Start Guide

This guide will help you set up ServAnt Agent in minutes.

## Prerequisites

- Docker and Docker Compose installed
- Access to Docker socket (`/var/run/docker.sock`)
- `openssl` for token generation (usually pre-installed)

## Setup Methods

### Method 1: Manual Setup

```bash
# 1. Generate a secure token
openssl rand -hex 32

# 2. Copy the example env file
cp .env.example .env

# 3. Edit .env and set your token
nano .env

# 4. Start the agent
docker-compose up -d
```

### Method 3: Direct Docker Run

```bash
# Generate token
export AGENT_TOKEN=$(openssl rand -hex 32)
echo "Save this token: $AGENT_TOKEN"

# Run the container
docker run -d \
  --name servant-agent \
  -p 6061:6061 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e AGENT_TOKEN=$AGENT_TOKEN \
  ghcr.io/panonim/servant-agent:latest
```

## Testing the Agent

### Health Check (No authentication required)

```bash
curl http://localhost:6061/healthz
# Expected output: ok
```

### List Containers

```bash
# Set your token
export TOKEN="your-token-here"

# Make authenticated request
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:6061/api/containers/json?all=1
```

### Get Container Stats

```bash
# Get container ID first
CONTAINER_ID=$(docker ps -q | head -1)

# Get stats snapshot
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:6061/api/containers/$CONTAINER_ID/stats?stream=0"

# Stream stats (press Ctrl+C to stop)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:6061/api/containers/$CONTAINER_ID/stats?stream=1"
```

## Production Deployment

### Behind Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name agent.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:6061;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # For stats streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 5m;
    }
}
```

Update agent configuration:
```bash
TRUST_PROXY=true
ALLOWED_ORIGINS=https://yourdashboard.com
```

### Behind Traefik

```yaml
services:
  servant-agent:
    image: ghcr.io/panonim/servant-agent:latest
    environment:
      AGENT_TOKEN: ${AGENT_TOKEN}
      TRUST_PROXY: "true"
      ALLOWED_ORIGINS: "https://yourdashboard.com"
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.agent.rule=Host(`agent.example.com`)"
      - "traefik.http.routers.agent.entrypoints=websecure"
      - "traefik.http.routers.agent.tls.certresolver=letsencrypt"
```

## Security Best Practices

1. **Token Management**
   - Use strong tokens (32+ characters)
   - Store tokens in environment variables or secrets management
   - Rotate tokens periodically

2. **Network Security**
   - Use HTTPS in production (via reverse proxy)
   - Configure `ALLOWED_ORIGINS` to restrict CORS
   - Set `TRUST_PROXY=true` when behind proxy

### Authentication fails

```bash
# Verify token is correct
docker-compose exec servant-agent env | grep AGENT_TOKEN

# Test with curl
curl -v -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:6061/api/containers/json
```

## Support

- Report issues: https://github.com/Panonim/servant/issues

## Configuration Options

All configuration is done via environment variables. Here's a complete list:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6061` | Port the server listens on |
| `HOST` | `0.0.0.0` | Host address to bind the server to |
| `LOG_LEVEL` | `info` | Logging verbosity: `error`, `warn`, `info`, `debug` |
| `RATE_LIMIT` | `60` | Maximum requests per window |
| `RATE_WINDOW_MS` | `60000` | Rate limiting window in milliseconds (default: 1 minute) |
| `TRUST_PROXY` | `false` | Set to `true` if behind a reverse proxy |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Path to Docker socket |
| `STREAM_MAX_MS` | `300000` | Maximum duration for streaming stats connections (5 minutes) |
| `KEEP_ALIVE_MS` | `10000` | Keep-alive timeout for connections |
| `SHUTDOWN_GRACE_MS` | `1500` | Grace period for shutdown (milliseconds) |
| `ALLOWED_HOSTS` | (none) | Comma-separated list of allowed hostnames for requests |
| `ALLOWED_ORIGINS` | (none) | Comma-separated list of allowed CORS origins |
| `AGENT_TOKEN` | (required) | Authentication token for agent API access (minimum 32 characters) |
