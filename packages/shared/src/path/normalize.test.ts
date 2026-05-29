import { describe, it, expect } from 'vitest';
import {
  normalizePath, isValidPath, caseFoldPath, splitPath, joinPath,
  extname, suffixPath, PathValidationError,
} from './normalize';

describe('path normalization', () => {
  it('normalizes separators and trims slashes', () => {
    expect(normalizePath('\\a\\b\\c.md')).toBe('a/b/c.md');
    expect(normalizePath('/a/b/')).toBe('a/b');
    expect(normalizePath('a//b///c')).toBe('a/b/c');
  });

  it('applies NFC normalization', () => {
    const nfd = 'cafe\u0301.md'; // e + combining acute
    expect(normalizePath(nfd)).toBe('café.md'.normalize('NFC'));
  });

  it('rejects empty, dot segments', () => {
    expect(() => normalizePath('')).toThrow(PathValidationError);
    expect(() => normalizePath('a/../b')).toThrow(PathValidationError);
    expect(() => normalizePath('./a')).toThrow(PathValidationError);
  });

  it('rejects illegal characters and reserved names', () => {
    expect(isValidPath('a<b.md')).toBe(false);
    expect(isValidPath('a/b:c.md')).toBe(false);
    expect(isValidPath('CON')).toBe(false);
    expect(isValidPath('nul.md')).toBe(false);
    expect(isValidPath('a/LPT1.txt')).toBe(false);
  });

  it('rejects trailing space or dot', () => {
    expect(isValidPath('a/b .md')).toBe(true); // space before ext ok
    expect(isValidPath('a/b. ')).toBe(false);
    expect(isValidPath('a/b ')).toBe(false);
    expect(isValidPath('folder./x')).toBe(false);
  });

  it('case-fold detects case-only collisions', () => {
    expect(caseFoldPath(normalizePath('Notes/Foo.md'))).toBe('notes/foo.md');
  });

  it('split / join / extname', () => {
    expect(splitPath('a/b/c.md')).toEqual(['a/b', 'c.md']);
    expect(splitPath('c.md')).toEqual(['', 'c.md']);
    expect(joinPath('a/b', 'c.md')).toBe('a/b/c.md');
    expect(joinPath('', 'c.md')).toBe('c.md');
    expect(extname('a/b.md')).toBe('.md');
    expect(extname('a/b')).toBe('');
    expect(extname('a/.hidden')).toBe('');
  });

  it('suffixPath inserts before extension', () => {
    expect(suffixPath('notes/a.md', 2)).toBe('notes/a (2).md');
    expect(suffixPath('a', 3)).toBe('a (3)');
  });
});
