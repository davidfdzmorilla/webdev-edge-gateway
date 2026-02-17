import Redis from 'ioredis';

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  constructor(
    private redis: Redis,
    private id: string,
    private threshold: number,
    private timeout: number
  ) {}

  async getState(): Promise<CircuitState> {
    const failures = await this.redis.get(`cb:${this.id}:failures`);
    const openUntil = await this.redis.get(`cb:${this.id}:open_until`);

    if (openUntil) {
      if (Date.now() < parseInt(openUntil)) return 'open';
      return 'half-open';
    }

    if (parseInt(failures || '0') >= this.threshold) return 'open';
    return 'closed';
  }

  async recordSuccess(): Promise<void> {
    await this.redis.del(`cb:${this.id}:failures`, `cb:${this.id}:open_until`);
  }

  async recordFailure(): Promise<void> {
    const failures = await this.redis.incr(`cb:${this.id}:failures`);
    await this.redis.expire(`cb:${this.id}:failures`, 300);

    if (failures >= this.threshold) {
      const openUntil = Date.now() + this.timeout;
      await this.redis.set(`cb:${this.id}:open_until`, openUntil, 'PX', this.timeout);
    }
  }

  async trip(): Promise<void> {
    const openUntil = Date.now() + this.timeout;
    await this.redis.set(`cb:${this.id}:open_until`, openUntil, 'PX', this.timeout);
  }
}
