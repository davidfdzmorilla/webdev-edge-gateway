import Fastify from 'fastify';
import cors from '@fastify/cors';
import Redis from 'ioredis';
import { routes } from './config.js';
import { CircuitBreaker } from './circuitBreaker.js';
import {
  registry,
  requestsTotal,
  requestDuration,
  circuitBreakerState,
  rateLimitHits,
} from './metrics.js';
import { createLogger } from './logger.js';

const logger = createLogger('gateway');
const PORT = parseInt(process.env.PORT || '3016', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

const redis = new Redis(REDIS_URL);

redis.on('connect', () => logger.info('Redis connected', { url: REDIS_URL }));
redis.on('error', (err) => logger.error('Redis error', { error: String(err) }));

const fastify = Fastify({ logger: false });

await fastify.register(cors);

// Rate limiting helper (sliding window via Redis)
async function checkRateLimit(
  ip: string,
  routeId: string,
  max: number,
  windowSecs: number
): Promise<boolean> {
  const key = `rl:${routeId}:${ip}`;
  const now = Date.now();
  const windowMs = windowSecs * 1000;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, now - windowMs);
  pipeline.zadd(key, now, `${now}`);
  pipeline.zcard(key);
  pipeline.expire(key, windowSecs * 2);
  const results = await pipeline.exec();
  const count = (results?.[2]?.[1] as number) || 0;

  return count <= max;
}

// Simple proxy function
async function proxyRequest(upstream: string, targetPath: string, req: any, reply: any): Promise<void> {
  const url = `${upstream}${targetPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { ...req.headers, host: new URL(upstream).host },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        reply.header(key, value);
      }
    });

    const body = await response.arrayBuffer();
    reply.send(Buffer.from(body));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Register routes dynamically
for (const route of routes) {
  const cb = route.circuitBreaker
    ? new CircuitBreaker(
        redis,
        route.id,
        route.circuitBreaker.threshold,
        route.circuitBreaker.timeout
      )
    : null;

  fastify.all(`${route.path}/*`, async (req, reply) => {
    const start = Date.now();
    const ip = req.ip;

    // Rate limiting
    if (route.rateLimit) {
      const allowed = await checkRateLimit(
        ip,
        route.id,
        route.rateLimit.max,
        route.rateLimit.window
      );
      if (!allowed) {
        rateLimitHits.inc({ route: route.id });
        requestsTotal.inc({ route: route.id, status: '429', method: req.method });
        return reply.status(429).send({
          error: 'Rate limit exceeded',
          retryAfter: route.rateLimit.window,
        });
      }
    }

    // Circuit breaker check
    if (cb) {
      const state = await cb.getState();
      circuitBreakerState.set(
        { route: route.id },
        state === 'closed' ? 0 : state === 'open' ? 1 : 2
      );
      if (state === 'open') {
        requestsTotal.inc({ route: route.id, status: '503', method: req.method });
        return reply
          .status(503)
          .send({ error: 'Service temporarily unavailable (circuit open)' });
      }
    }

    // A/B test variant selection
    let upstream = route.upstream;
    if (route.abTest) {
      const rand = Math.random() * 100;
      let cumulative = 0;
      for (const variant of route.abTest.variants) {
        cumulative += variant.weight;
        if (rand <= cumulative) {
          upstream = variant.upstream;
          break;
        }
      }
    }

    // Proxy request
    try {
      // Rewrite path: strip route prefix
      const originalUrl = req.url as string;
      const pathPrefix = route.path;
      const targetPath = originalUrl.replace(pathPrefix, '') || '/';

      await proxyRequest(upstream, targetPath, req, reply);
      cb?.recordSuccess();
      const status = reply.statusCode.toString();
      requestsTotal.inc({ route: route.id, status, method: req.method });
    } catch (err) {
      cb?.recordFailure();
      requestsTotal.inc({ route: route.id, status: '502', method: req.method });
      logger.error('Proxy error', { route: route.id, error: String(err) });
      reply.status(502).send({ error: 'Bad gateway' });
    } finally {
      requestDuration.observe({ route: route.id }, (Date.now() - start) / 1000);
    }
  });
}

// Health check
fastify.get('/api/health', async () => ({
  status: 'ok',
  version: '1.0.0',
  routes: routes.length,
  uptime: process.uptime(),
}));

// Metrics endpoint
fastify.get('/metrics', async (_req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

// Routes info
fastify.get('/api/routes', async () => ({
  routes: routes.map((r) => ({
    id: r.id,
    path: r.path,
    upstream: r.upstream,
    features: {
      rateLimit: !!r.rateLimit,
      circuitBreaker: !!r.circuitBreaker,
      abTest: !!r.abTest,
      requiresAuth: !!r.requiresAuth,
    },
  })),
}));

// Circuit breaker status
fastify.get('/api/circuit-breakers', async () => {
  const status: Record<string, string> = {};
  for (const route of routes) {
    if (route.circuitBreaker) {
      const cb = new CircuitBreaker(
        redis,
        route.id,
        route.circuitBreaker.threshold,
        route.circuitBreaker.timeout
      );
      status[route.id] = await cb.getState();
    }
  }
  return { circuitBreakers: status };
});

// Dashboard HTML
fastify.get('/', async (_req, reply) => {
  reply.header('Content-Type', 'text/html');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Gateway Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:2rem}
    h1{font-size:1.875rem;font-weight:700;margin-bottom:0.5rem;background:linear-gradient(135deg,#6366f1,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .subtitle{color:#64748b;margin-bottom:2rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem}
    .card h3{font-size:1rem;font-weight:600;margin-bottom:1rem;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em}
    .route{padding:0.75rem;background:#0f172a;border-radius:8px;margin-bottom:0.5rem}
    .route-name{font-weight:600;color:#e2e8f0}
    .route-path{font-size:0.875rem;color:#6366f1;font-family:monospace}
    .route-upstream{font-size:0.75rem;color:#64748b;font-family:monospace}
    .badges{display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap}
    .badge{font-size:0.625rem;padding:0.125rem 0.5rem;border-radius:9999px;font-weight:600}
    .badge-rl{background:#1e3a5f;color:#60a5fa}
    .badge-cb{background:#3f1f1f;color:#f87171}
    .badge-ab{background:#1a3320;color:#4ade80}
    .stat{text-align:center;padding:1rem}
    .stat-value{font-size:2rem;font-weight:700;color:#6366f1}
    .stat-label{font-size:0.75rem;color:#64748b;margin-top:0.25rem}
    .status-badge{display:inline-block;padding:0.2rem 0.6rem;border-radius:9999px;font-size:0.7rem;font-weight:600}
    .status-closed{background:#1a3320;color:#4ade80}
    .status-open{background:#3f1f1f;color:#f87171}
    .status-half-open{background:#2d2000;color:#fbbf24}
    .refresh-info{font-size:0.75rem;color:#475569;margin-top:1rem;text-align:right}
  </style>
</head>
<body>
  <h1>⚡ API Gateway</h1>
  <p class="subtitle">Intelligent request routing with rate limiting, circuit breakers, and A/B testing</p>
  <div class="grid" id="stats"></div>
  <div class="card">
    <h3>Routes</h3>
    <div id="routes">Loading...</div>
  </div>
  <p class="refresh-info">Auto-refreshes every 10 seconds</p>
  <script>
    async function load() {
      try {
        const [routesRes, cbRes] = await Promise.all([
          fetch('/api/routes').then(r=>r.json()),
          fetch('/api/circuit-breakers').then(r=>r.json()),
        ]);
        const routes = routesRes.routes;
        const cbs = cbRes.circuitBreakers;

        document.getElementById('stats').innerHTML =
          '<div class="card"><div class="stat"><div class="stat-value">' + routes.length + '</div><div class="stat-label">Routes</div></div></div>' +
          '<div class="card"><div class="stat"><div class="stat-value">' + routes.filter(r=>r.features.rateLimit).length + '</div><div class="stat-label">Rate Limited</div></div></div>' +
          '<div class="card"><div class="stat"><div class="stat-value">' + routes.filter(r=>r.features.circuitBreaker).length + '</div><div class="stat-label">Circuit Breakers</div></div></div>' +
          '<div class="card"><div class="stat"><div class="stat-value">' + Object.values(cbs).filter(s=>s==='open').length + '</div><div class="stat-label">Circuits Open</div></div></div>';

        document.getElementById('routes').innerHTML = routes.map(r => {
          const cbState = cbs[r.id] || 'closed';
          const cbClass = 'status-' + cbState.replace('-', '-');
          return '<div class="route">' +
            '<div class="route-name">' + r.id + '</div>' +
            '<div class="route-path">ALL ' + r.path + '/*</div>' +
            '<div class="route-upstream">&rarr; ' + (r.upstream || 'multiple') + '</div>' +
            '<div class="badges">' +
            (r.features.rateLimit ? '<span class="badge badge-rl">Rate Limit</span>' : '') +
            (r.features.circuitBreaker ? '<span class="badge badge-cb">CB: ' + cbState + '</span>' : '') +
            (r.features.abTest ? '<span class="badge badge-ab">A/B Test</span>' : '') +
            (r.features.requiresAuth ? '<span class="badge" style="background:#2d1b4e;color:#c084fc">JWT Auth</span>' : '') +
            '</div>' +
            '</div>';
        }).join('');
      } catch (e) {
        console.error('Dashboard load error:', e);
      }
    }
    load();
    setInterval(load, 10000);
  </script>
</body>
</html>`;
});

// Start server
await fastify.listen({ port: PORT, host: '0.0.0.0' });
logger.info(`Gateway running on port ${PORT}`);
