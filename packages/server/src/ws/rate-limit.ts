import { ErrorCode, SyncError } from '@obsidian-sync/shared';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface FixedWindowRateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

interface WindowState {
  startedAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, WindowState>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.max = Math.max(1, options.max);
    this.windowMs = Math.max(1, options.windowMs);
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const at = this.now();
    const current = this.buckets.get(key);
    const state = !current || at - current.startedAt >= this.windowMs ? { startedAt: at, count: 0 } : current;
    state.count += 1;
    this.buckets.set(key, state);
    const retryAfterMs = Math.max(0, this.windowMs - (at - state.startedAt));
    return { allowed: state.count <= this.max, remaining: Math.max(0, this.max - state.count), retryAfterMs };
  }

  assertAllowed(key: string, message: string): void {
    const result = this.consume(key);
    if (!result.allowed) throw rateLimited(message, result.retryAfterMs);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export interface LoginRateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  now?: () => number;
}

interface LoginState {
  windowStartedAt: number;
  failures: number;
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly records = new Map<string, LoginState>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(options: LoginRateLimiterOptions) {
    this.maxFailures = Math.max(1, options.maxFailures);
    this.windowMs = Math.max(1, options.windowMs);
    this.lockoutMs = Math.max(1, options.lockoutMs);
    this.now = options.now ?? Date.now;
  }

  check(ip: string, username: string): RateLimitResult {
    const key = loginKey(ip, username);
    const at = this.now();
    const record = this.records.get(key);
    if (!record) return { allowed: true, remaining: this.maxFailures, retryAfterMs: 0 };
    if (record.lockedUntil > at) return { allowed: false, remaining: 0, retryAfterMs: record.lockedUntil - at };
    if (at - record.windowStartedAt >= this.windowMs) {
      this.records.delete(key);
      return { allowed: true, remaining: this.maxFailures, retryAfterMs: 0 };
    }
    return { allowed: true, remaining: Math.max(0, this.maxFailures - record.failures), retryAfterMs: 0 };
  }

  assertAllowed(ip: string, username: string): void {
    const result = this.check(ip, username);
    if (!result.allowed) throw rateLimited('Too many login attempts', result.retryAfterMs);
  }

  recordFailure(ip: string, username: string): void {
    const key = loginKey(ip, username);
    const at = this.now();
    const current = this.records.get(key);
    const record = !current || at - current.windowStartedAt >= this.windowMs
      ? { windowStartedAt: at, failures: 0, lockedUntil: 0 }
      : current;
    record.failures += 1;
    if (record.failures >= this.maxFailures) record.lockedUntil = at + this.lockoutMs;
    this.records.set(key, record);
  }

  recordSuccess(ip: string, username: string): void {
    this.records.delete(loginKey(ip, username));
  }
}

export function rateLimited(message: string, retryAfterMs: number): SyncError {
  return new SyncError(ErrorCode.RATE_LIMITED, message, { retryAfterMs });
}

function loginKey(ip: string, username: string): string {
  return `${ip.trim() || 'unknown'}:${username.trim().toLocaleLowerCase()}`;
}
