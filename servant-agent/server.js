// server.js (ESM) - ServAnt Agent - Headless Docker API
import express from 'express';
import Docker from 'dockerode';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
});

const app = express();
const PORT = process.env.PORT || 6061;

// Simple environment-driven logger (no external deps).
// Levels: error (0), warn (1), info (2), debug (3).
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const _levels = { error: 0, warn: 1, info: 2, debug: 3 };
const _curLevel = typeof _levels[LOG_LEVEL] === 'number' ? _levels[LOG_LEVEL] : _levels.info;
const _ts = () => new Date().toISOString();
const logger = {
  error: (...a) => { if (_curLevel >= 0) console.error('[ERROR]', _ts(), ...a); },
  warn:  (...a) => { if (_curLevel >= 1) console.warn('[WARN]', _ts(), ...a); },
  info:  (...a) => { if (_curLevel >= 2) console.log('[INFO]', _ts(), ...a); },
  debug: (...a) => { if (_curLevel >= 3) console.debug('[DEBUG]', _ts(), ...a); }
};

// Basic request logging middleware that respects LOG_LEVEL
app.use((req, res, next) => {
  const start = Date.now();
  const u = req.originalUrl || req.url || '';
  if (_curLevel >= 2) logger.info(`Incoming ${req.method} ${u} from ${req.ip}`);
  if (_curLevel >= 3) logger.debug('Headers:', req.headers, 'Query:', req.query);
  res.on('finish', () => {
    if (_curLevel >= 2) logger.info(`${res.statusCode} ${req.method} ${u} - ${Date.now() - start}ms`);
  });
  next();
});

// Hardening
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || false);

// Host header validation
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS
  ? new Set(process.env.ALLOWED_HOSTS.split(',').map(h => h.trim()))
  : null;

if (ALLOWED_HOSTS) {
  app.use((req, res, next) => {
    const host = req.hostname;
    if (ALLOWED_HOSTS.has(host)) {
      return next();
    }
    logger.warn(`Request from untrusted host: ${host}`);
    return res.status(400).send('Bad Request');
  });
  logger.info(`Host header validation enabled. Allowed hosts: ${[...ALLOWED_HOSTS].join(', ')}`);
}

// Security headers - API only, no CSP needed
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS: Allow requests from authorized origins
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

if (ALLOWED_ORIGINS.length === 0) {
  logger.warn('CORS is not configured. Requests from browsers may be blocked.');
  logger.warn('Set ALLOWED_ORIGINS to a comma-separated list of domains, e.g., "https://my-app.com,http://localhost:3000"');
} else {
  logger.info(`CORS enabled for origins: ${ALLOWED_ORIGINS.join(', ')}`);
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiter - configurable via env
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// REQUIRED: Token-based authentication
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';

if (!AGENT_TOKEN) {
  logger.error('FATAL: AGENT_TOKEN environment variable is not set!');
  logger.error('ServAnt Agent requires token authentication for security.');
  logger.error('Please set AGENT_TOKEN to a secure random string (min 32 characters).');
  logger.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

if (AGENT_TOKEN.length < 32) {
  logger.error('FATAL: AGENT_TOKEN must be at least 32 characters long for security.');
  logger.error('Generate a secure token with: openssl rand -hex 32');
  process.exit(1);
}

logger.info('ServAnt Agent starting with token authentication enabled.');

// Token authentication middleware with constant-time comparison
function requireToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  
  if (!token) {
    logger.warn(`Authentication failed: No token provided from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Bearer token required' });
  }

  // Constant-time comparison to prevent timing attacks
  const tokenBuffer = Buffer.from(token);
  const agentTokenBuffer = Buffer.from(AGENT_TOKEN);
  
  if (tokenBuffer.length !== agentTokenBuffer.length) {
    logger.warn(`Authentication failed: Invalid token from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  const isValid = crypto.timingSafeEqual(tokenBuffer, agentTokenBuffer);
  
  if (!isValid) {
    logger.warn(`Authentication failed: Invalid token from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  next();
}

// Helpers
const isSafeId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{12,64}$/.test(v);
const clampAll = (v) => (v === '1' || v === 'true');
const safeErr = (err) => ({ error: err?.json?.message || err?.message || 'Internal error' });

// Health check (no auth required)
app.get('/healthz', (_, res) => res.type('text/plain').send('ok'));

// API routes - all require authentication
const api = express.Router();
api.use(limiter);
api.use(requireToken);

// GET /containers/json?all=1
api.get('/containers/json', async (req, res) => {
  try {
    const all = clampAll(String(req.query.all ?? '1'));
    const list = await docker.listContainers({ all });
    // Filter container list to only include necessary fields
    const filtered = list.map(container => ({
      Id: container.Id,
      Names: container.Names,
      Image: container.Image,
      ImageID: container.ImageID,
      Command: container.Command,
      Created: container.Created,
      State: container.State,
      Status: container.Status,
      Ports: container.Ports,
    }));
    res.json(filtered);
  } catch (err) {
    logger.error('Error listing containers:', err);
    res.status(500).json(safeErr(err));
  }
});

// GET /containers/:id/stats?stream=1 (NDJSON) or stream=0 (snapshot)
api.get('/containers/:id/stats', async (req, res) => {
  const id = req.params.id;
  if (!isSafeId(id)) return res.status(400).json({ error: 'Invalid container id' });

  const wantStream = String(req.query.stream ?? '1') !== '0';
  const abort = new AbortController();
  const STREAM_MAX_MS = Number(process.env.STREAM_MAX_MS || 5 * 60_000);
  const timer = setTimeout(() => abort.abort(), STREAM_MAX_MS);

  try {
    if (!wantStream) {
      const snap = await docker.getContainer(id).stats({ stream: false, signal: abort.signal });
      clearTimeout(timer);
      // Filter snapshot stats to only include numeric metrics
      const filtered = {
        read: snap.read,
        preread: snap.preread,
        cpu_stats: snap.cpu_stats,
        precpu_stats: snap.precpu_stats,
        memory_stats: snap.memory_stats,
        networks: snap.networks,
        name: snap.name,
        id: snap.id
      };
      return res.json(filtered);
    }

    // For streaming, parse JSON frames and only forward filtered metrics
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');

    const s = await docker.getContainer(id).stats({ stream: true, signal: abort.signal });
    
    const closeAll = () => {
      clearTimeout(timer);
      try { s.destroy(); } catch {}
      try { res.end(); } catch {}
    };

    const onData = (chunk) => {
      try {
        const txt = chunk.toString('utf8').trim();
        if (!txt) return;
        const parts = txt.split(/\r?\n/).filter(Boolean);
        for (const p of parts) {
          try {
            const frame = JSON.parse(p);
            const filtered = {
              read: frame.read,
              preread: frame.preread,
              cpu_stats: frame.cpu_stats,
              precpu_stats: frame.precpu_stats,
              memory_stats: frame.memory_stats,
              networks: frame.networks,
              name: frame.name,
              id: frame.id
            };
            // Pause stream if buffer is full, resume on drain
            if (!res.write(JSON.stringify(filtered) + '\n')) {
              s.pause();
            }
          } catch (e) {
            // ignore non-JSON or partial frames
          }
        }
      } catch (e) {}
    };

    s.on('data', onData);
    res.on('drain', () => s.resume());
    res.on('close', () => { abort.abort(); closeAll(); });
    s.on('end', closeAll);
    s.on('error', closeAll);
    req.on('close', () => { abort.abort(); closeAll(); });
  } catch (err) {
    clearTimeout(timer);
    logger.error('Error streaming stats:', err);
    const code = String(err?.statusCode || '').startsWith('4') ? err.statusCode : 500;
    res.status(code || 500).json(safeErr(err));
  }
});

// Mount API routes
app.use('/api', api);

// 404 handler for unmatched routes
app.use('*', (_, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Timeouts and robust startup
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  logger.info(`ServAnt Agent listening on http://${HOST}:${PORT}`);
  logger.info(`Authentication: Token-based (Bearer)`);
  logger.info(`API endpoints: /api/containers/json, /api/containers/:id/stats`);
});

// Log startup errors immediately
server.on('error', (err) => {
  logger.error('Server failed to start:', err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, p) => {
  logger.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  process.exit(1);
});

server.headersTimeout = 65_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 60_000;

// Track open connections
const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

const KA_MS = Number(process.env.KEEP_ALIVE_MS || 10_000);
server.keepAliveTimeout = Math.min(server.keepAliveTimeout, KA_MS);

function shutdown(signal) {
  const graceMs = Number(process.env.SHUTDOWN_GRACE_MS || 1500);
  logger.info(`${signal} received. Shutting down gracefully (<= ${graceMs}ms)...`);

  server.close((err) => {
    if (err) {
      logger.error('Error during server.close():', err);
      process.exit(1);
    }
    logger.info('HTTP server closed cleanly. Exiting.');
    process.exit(0);
  });

  setTimeout(() => {
    if (connections.size) logger.warn(`Force-closing ${connections.size} lingering connection(s)`);
    for (const s of connections) {
      try { s.destroy(); } catch {}
    }
  }, graceMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
