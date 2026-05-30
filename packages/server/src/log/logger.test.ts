import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('structured logger', () => {
  it('emits JSON entries with level, timestamp, message, and context fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line), now: () => new Date('2025-01-02T03:04:05.006Z') });

    logger.info('server started', { port: 3000, requestId: 'req-1' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      timestamp: '2025-01-02T03:04:05.006Z',
      message: 'server started',
      port: 3000,
      requestId: 'req-1',
    });
  });

  it('suppresses entries below LOG_LEVEL and serializes errors safely', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line), now: () => new Date('2025-01-02T03:04:05.006Z') });

    logger.debug('hidden');
    logger.info('hidden');
    logger.error('failed', { error: new Error('boom'), secret: undefined });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'error', message: 'failed', error: { name: 'Error', message: 'boom' } });
    expect(entry).not.toHaveProperty('secret');
  });
});
