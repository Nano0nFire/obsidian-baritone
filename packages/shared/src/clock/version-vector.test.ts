import { describe, it, expect } from 'vitest';
import {
  bump, join, dominates, isConcurrent, compareVV, equals,
  strictlyDominates, serializeVV, parseVV, EMPTY_VV,
} from './version-vector';

describe('version-vector', () => {
  it('bump increments a device counter', () => {
    const a = bump(EMPTY_VV, 'd1');
    expect(a).toEqual({ d1: 1 });
    expect(bump(a, 'd1')).toEqual({ d1: 2 });
    expect(bump(a, 'd2')).toEqual({ d1: 1, d2: 1 });
  });

  it('join takes pointwise maximum', () => {
    expect(join({ d1: 2, d2: 1 }, { d1: 1, d2: 3, d3: 1 })).toEqual({ d1: 2, d2: 3, d3: 1 });
  });

  it('dominates / strictlyDominates', () => {
    expect(dominates({ d1: 2, d2: 1 }, { d1: 1, d2: 1 })).toBe(true);
    expect(dominates({ d1: 1 }, { d1: 1 })).toBe(true);
    expect(strictlyDominates({ d1: 2 }, { d1: 1 })).toBe(true);
    expect(strictlyDominates({ d1: 1 }, { d1: 1 })).toBe(false);
    expect(dominates({ d1: 1 }, { d1: 2 })).toBe(false);
  });

  it('detects concurrency', () => {
    expect(isConcurrent({ d1: 1 }, { d2: 1 })).toBe(true);
    expect(isConcurrent({ d1: 2, d2: 1 }, { d1: 1, d2: 2 })).toBe(true);
    expect(isConcurrent({ d1: 2 }, { d1: 1 })).toBe(false);
  });

  it('compareVV classifies relations', () => {
    expect(compareVV({ d1: 1 }, { d1: 1 })).toBe('equal');
    expect(compareVV({ d1: 2 }, { d1: 1 })).toBe('dominates');
    expect(compareVV({ d1: 1 }, { d1: 2 })).toBe('dominated');
    expect(compareVV({ d1: 1 }, { d2: 1 })).toBe('concurrent');
  });

  it('equals is symmetric', () => {
    expect(equals({ d1: 1, d2: 2 }, { d2: 2, d1: 1 })).toBe(true);
    expect(equals({ d1: 1 }, { d1: 2 })).toBe(false);
  });

  it('serialize is canonical and round-trips', () => {
    expect(serializeVV({ d2: 1, d1: 2 })).toBe('{"d1":2,"d2":1}');
    expect(serializeVV({ d1: 0, d2: 3 })).toBe('{"d2":3}'); // drops zeros
    expect(parseVV(serializeVV({ d1: 5 }))).toEqual({ d1: 5 });
  });
});
