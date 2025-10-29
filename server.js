// server.js (ESM)
import express from 'express';
import compression from 'compression';
import Docker from 'dockerode';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
});


const app = express();
const PORT = process.env.PORT || 6060;

// Enable gzip compression for faster transfers
app.use(compression({
  // Don't bother compressing very small responses
  threshold: 1024,
  // Respect caches/proxies if they set cache-control: no-transform
  filter: (req, res) => {
    const cacheControl = res.getHeader && res.getHeader('Cache-Control');
    if (cacheControl && /no-transform/i.test(String(cacheControl))) return false;
    return compression.filter(req, res);
  }
}));

// Normalize request paths to remove duplicate slashes (e.g., //styles.css -> /styles.css)
app.use((req, res, next) => {
  if (typeof req.url === 'string') {
    req.url = req.url.replace(/\/+/g, '/');
  }
  next();
});

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

// Basic request logging middleware that respects LOG_LEVEL and avoids chatty static logs.
app.use((req, res, next) => {
  const start = Date.now();
  const u = req.originalUrl || req.url || '';
  const isStatic = /\.(?:css|js|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|map)(?:\?|$)/i.test(u) || u.startsWith('/assets/');
  if (!isStatic && _curLevel >= 2) logger.info(`Incoming ${req.method} ${u} from ${req.ip}`);
  if (!isStatic && _curLevel >= 3) logger.debug('Headers:', req.headers, 'Query:', req.query);
  res.on('finish', () => {
    if (!isStatic && _curLevel >= 2) logger.info(`${res.statusCode} ${req.method} ${u} - ${Date.now() - start}ms`);
  });
  next();
});

// Hardening
app.disable('x-powered-by');
// If the service is behind a reverse proxy, set TRUST_PROXY to the proxy address or 'true' as appropriate.
app.set('trust proxy', process.env.TRUST_PROXY || false);

// Security headers - configured for same-origin operation
app.use(helmet({
  contentSecurityPolicy: false, // Allow loading resources in dev
  crossOriginEmbedderPolicy: false // Allow loading in iframe for dev
}));

// CORS: in Docker, the frontend and API are served from same origin
app.use(cors({
  origin: true, // Allow same-origin and API requests
  credentials: true
}));

// Replace custom Map-based rate limiter with express-rate-limit (in-process). Configurable via env.
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT || 120),
  standardHeaders: true,
  legacyHeaders: false,
});

// API key middleware (optional). If API_KEY is unset, requests are allowed (useful for local dev). In production set API_KEY.
const API_KEY = process.env.API_KEY || '';
function requireApiKey(req, res, next) {
  // When running in Docker, API and frontend are same-origin, so we can skip API key check in dev
  if (!API_KEY || process.env.NODE_ENV !== 'production') return next();
  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Helpers
// Accept Docker IDs: 12 (short) to 64 hex characters; reject other forms to avoid path traversal or names with slashes.
const isSafeId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{12,64}$/.test(v);
const clampAll = (v) => (v === '1' || v === 'true');
const safeErr = (err) => ({ error: err?.json?.message || err?.message || 'Internal error' });

// Read-only Engine proxy
const api = express.Router();

app.get('/healthz', (_, res) => res.type('text/plain').send('ok'));

// API routes
app.use('/docker', api);

// Inject configuration into frontend
app.use('/', async (req, res, next) => {
  if (req.path === '/script.js') {
    const timeSource = (process.env.TIME_SOURCE || 'local').toLowerCase();
    const timeFormat = (process.env.TIME_FORMAT || '24h').toLowerCase();
    const timeZone = process.env.TZ || 'UTC';
    
    try {
      const scriptPath = path.join(__dirname, 'public', 'script.js');
      const scriptContent = await import('fs/promises').then(fs => fs.readFile(scriptPath, 'utf8'));
      
      const configScript = `window.__CONFIG__ = {
        logLevel: ${JSON.stringify(LOG_LEVEL)},
        time: {
          source: ${JSON.stringify(timeSource === 'browser' ? 'browser' : 'local')},
          format: ${JSON.stringify(timeFormat === '12h' ? '12h' : '24h')},
          timeZone: ${JSON.stringify(timeZone)}
        }
      };\n`;
      
      res.type('application/javascript');
      res.send(configScript + scriptContent);
    } catch (err) {
      logger.error('Error serving script.js:', err);
      next(err);
    }
  } else {
    next();
  }
});

// Static frontend - serve after API routes to catch any unmatched routes
// Add strong caching for versioned assets and sensible defaults for app shell
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'ignore',
  fallthrough: true,
  etag: true,
  maxAge: '5m', // default for non-asset files
  index: 'index.html',
  setHeaders: (res, filePath) => {
    const p = String(filePath);
    // Long-cache static assets (images, icons, fonts)
    if (/\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|woff2?|ttf)$/i.test(p)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }
    // Moderate cache for JS/CSS to balance freshness and speed
    if (/\.(?:js|css)$/i.test(p)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
      return;
    }
    // HTML should not be cached aggressively
    if (/\.(?:html)$/i.test(p)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
// Apply API protections: rate limiter and optional API key
api.use(limiter);
api.use(requireApiKey);

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
      // redact snapshot stats to only include numeric metrics
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

    // For streaming, parse JSON frames and only forward filtered metrics to avoid leaking additional host info.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');

    const s = await docker.getContainer(id).stats({ stream: true, signal: abort.signal });
    const closeAll = () => {
      clearTimeout(timer);
      try { s.destroy(); } catch {}
      try { res.end(); } catch {}
    };
    s.on('data', (chunk) => {
      try {
        // docker stats tends to emit full JSON objects per chunk, but defensively split on newlines
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
            res.write(JSON.stringify(filtered) + '\n');
          } catch (e) {
            // ignore non-JSON or partial frames
          }
        }
      } catch (e) {}
    });
    s.on('end', closeAll);
    s.on('error', closeAll);
    req.on('close', () => { abort.abort(); closeAll(); });
  } catch (err) {
    clearTimeout(timer);
    const code = String(err?.statusCode || '').startsWith('4') ? err.statusCode : 500;
    res.status(code || 500).json(safeErr(err));
  }
});

// SPA fallback - catch any unmatched routes
app.use('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Timeouts and robust startup
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  logger.info(`Dashboard listening on http://${HOST}:${PORT}`);
});

// Log startup errors immediately so container orchestrators show useful logs
server.on('error', (err) => {
  logger.error('Server failed to start:', err && err.stack ? err.stack : err);
  // Exit so container managers (Docker) can restart and show the failure
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

