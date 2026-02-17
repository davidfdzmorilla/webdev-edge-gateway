export interface RouteConfig {
  id: string;
  path: string;           // e.g. "/api/notifications"
  upstream: string;       // e.g. "http://localhost:3012"
  rateLimit?: { max: number; window: number }; // requests per window (seconds)
  requiresAuth?: boolean;
  abTest?: { variants: Array<{ upstream: string; weight: number }> };
  circuitBreaker?: { threshold: number; timeout: number }; // failures before open, ms
}

export const routes: RouteConfig[] = [
  {
    id: 'portfolio',
    path: '/proxy/portfolio',
    upstream: 'http://localhost:3001',
    rateLimit: { max: 100, window: 60 },
  },
  {
    id: 'notifications',
    path: '/proxy/notifications',
    upstream: 'http://localhost:3012',
    rateLimit: { max: 50, window: 60 },
    circuitBreaker: { threshold: 5, timeout: 30000 },
  },
  {
    id: 'platform',
    path: '/proxy/platform',
    upstream: 'http://localhost:3013',
    rateLimit: { max: 100, window: 60 },
  },
];
