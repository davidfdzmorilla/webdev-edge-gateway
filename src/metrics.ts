import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const registry = new Registry();

export const requestsTotal = new Counter({
  name: 'gateway_requests_total',
  help: 'Total requests through gateway',
  labelNames: ['route', 'status', 'method'],
  registers: [registry],
});

export const requestDuration = new Histogram({
  name: 'gateway_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['route'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'gateway_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['route'],
  registers: [registry],
});

export const rateLimitHits = new Counter({
  name: 'gateway_rate_limit_hits_total',
  help: 'Total rate limit rejections',
  labelNames: ['route'],
  registers: [registry],
});
