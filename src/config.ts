export interface RouteConfig {
  id: string;
  path: string;           // e.g. "/api/notifications"
  upstream: string;       // e.g. "http://localhost:3012"
  rateLimit?: { max: number; window: number }; // requests per window (seconds)
  requiresAuth?: boolean;
  abTest?: { variants: Array<{ upstream: string; weight: number }> };
  circuitBreaker?: { threshold: number; timeout: number }; // failures before open, ms
}

// Use UPSTREAM_HOST env var to support Docker (host.docker.internal) vs direct (localhost)
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'localhost';

export const routes: RouteConfig[] = [
  {
    id: 'portfolio',
    path: '/proxy/portfolio',
    upstream: `http://${UPSTREAM_HOST}:3001`,
    rateLimit: { max: 100, window: 60 },
  },
  {
    id: 'notifications',
    path: '/proxy/notifications',
    upstream: `http://${UPSTREAM_HOST}:3012`,
    rateLimit: { max: 50, window: 60 },
    circuitBreaker: { threshold: 5, timeout: 30000 },
  },
  {
    id: 'platform',
    path: '/proxy/platform',
    upstream: `http://${UPSTREAM_HOST}:3013`,
    rateLimit: { max: 100, window: 60 },
  },
];
