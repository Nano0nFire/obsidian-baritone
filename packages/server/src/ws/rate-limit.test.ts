import { describe, expect, it } from 'vitest';
import { ErrorCode, SyncError } from '@obsidian-sync/shared';
import { FixedWindowRateLimiter, LoginRateLimiter } from './rate-limit.js';

describe('fixed-window rate limiter', () => {
  it('allows requests under the limit, blocks over the limit, and resets after the window', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 100, now: () => now });

    expect(limiter.consume('ip:1')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('ip:1')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('ip:1')).toMatchObject({ allowed: false, retryAfterMs: 100 });

    now += 101;
    expect(limiter.consume('ip:1')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('throws a protocol SyncError when assertAllowed is over limit', () => {
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1_000, now: () => 10 });
    limiter.assertAllowed('ws:127.0.0.1', 'Too many WebSocket connection attempts');

    expect(() => limiter.assertAllowed('ws:127.0.0.1', 'Too many WebSocket connection attempts')).toThrow(SyncError);
    try {
      limiter.assertAllowed('ws:127.0.0.1', 'Too many WebSocket connection attempts');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.RATE_LIMITED });
    }
  });
});

describe('login rate limiter', () => {
  it('records failed attempts by ip and username, locks out, and clears after success', () => {
    let now = 5_000;
    const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 1_000, lockoutMs: 5_000, now: () => now });

    expect(limiter.check('127.0.0.1', 'alice').allowed).toBe(true);
    limiter.recordFailure('127.0.0.1', 'alice');
    limiter.recordFailure('127.0.0.1', 'alice');
    expect(limiter.check('127.0.0.1', 'alice')).toMatchObject({ allowed: false, retryAfterMs: 5_000 });

    expect(limiter.check('127.0.0.1', 'bob').allowed).toBe(true);
    expect(limiter.check('127.0.0.2', 'alice').allowed).toBe(true);

    limiter.recordSuccess('127.0.0.1', 'alice');
    expect(limiter.check('127.0.0.1', 'alice').allowed).toBe(true);

    limiter.recordFailure('127.0.0.1', 'alice');
    limiter.recordFailure('127.0.0.1', 'alice');
    now += 5_001;
    expect(limiter.check('127.0.0.1', 'alice').allowed).toBe(true);
  });
});
