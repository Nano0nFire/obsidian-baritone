import { describe, it, expect } from 'vitest';
import { contentHash, contentHashText, hashText, isValidContentHash } from './content-hash';
import { comparePathClock, pathClockWins, nextLamport, observeLamport } from '../clock/lamport';

describe('content-hash', () => {
  it('hashes text deterministically', async () => {
    const a = await hashText('hello');
    const b = await hashText('hello');
    expect(a).toBe(b);
    expect(a).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('contentHash prefixes and validates', async () => {
    const h = await contentHashText('x');
    expect(h.startsWith('sha256:')).toBe(true);
    expect(isValidContentHash(h)).toBe(true);
    expect(isValidContentHash('sha256:zzz')).toBe(false);
  });

  it('hashes raw bytes', async () => {
    const h = await contentHash(new Uint8Array([1, 2, 3]));
    expect(isValidContentHash(h)).toBe(true);
  });
});

describe('lamport path clock', () => {
  it('larger lamport wins', () => {
    expect(comparePathClock({ lamport: 2, deviceId: 'a' }, { lamport: 1, deviceId: 'z' })).toBeGreaterThan(0);
  });
  it('ties broken by deviceId', () => {
    expect(pathClockWins({ lamport: 1, deviceId: 'b' }, { lamport: 1, deviceId: 'a' })).toBe(true);
    expect(pathClockWins({ lamport: 1, deviceId: 'a' }, { lamport: 1, deviceId: 'b' })).toBe(false);
  });
  it('lamport advances past observed', () => {
    expect(nextLamport(observeLamport(3, { lamport: 7, deviceId: 'x' }))).toBe(8);
  });
});
