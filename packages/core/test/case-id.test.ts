import { describe, expect, it } from 'vitest';
import { CaseIdError, resolveCaseId, shortCaseId } from '../src/case-id.js';

const id = (hex: string) => `sha256:${hex.padEnd(64, '0')}`;

const A = id('9f2e1a4b11');
const B = id('9f2e1a4b22');
const C = id('0123abcd');
const ids = [A, B, C];

function rejection(input: string, list: string[] = ids): CaseIdError {
  try {
    resolveCaseId(input, list);
  } catch (e) {
    if (e instanceof CaseIdError) return e;
    throw e;
  }
  throw new Error(`"${input}" resolved`);
}

describe('shortCaseId', () => {
  it('shows c_ and 8 hex digits', () => {
    expect(shortCaseId(A)).toBe('c_9f2e1a4b');
    expect(shortCaseId(A, 10)).toBe('c_9f2e1a4b11');
  });
});

describe('resolveCaseId', () => {
  it('resolves a unique prefix in every accepted spelling', () => {
    for (const input of ['0123', 'c_0123ab', 'C_0123AB', 'sha256:0123abcd', ' 0123abcd ', C]) {
      expect(resolveCaseId(input, ids)).toBe(C);
    }
  });

  it('resolves a prefix that is unique only at full length', () => {
    expect(resolveCaseId('9f2e1a4b1', ids)).toBe(A);
    expect(resolveCaseId(B, ids)).toBe(B);
  });

  it('errors on an ambiguous prefix and names every match', () => {
    const e = rejection('c_9f2e');
    expect(e.code).toBe('ambiguous');
    expect(e.matches).toEqual([A, B]);
    // 8 digits would print the same short ID twice, so the message uses enough to tell them apart.
    expect(e.message).toContain('c_9f2e1a4b1, c_9f2e1a4b2');
  });

  it('errors on an ambiguous prefix even when the display length is the prefix length', () => {
    expect(rejection('c_9f2e1a4b').code).toBe('ambiguous');
  });

  it('counts a repeated ID once', () => {
    expect(resolveCaseId('0123', [C, C])).toBe(C);
  });

  it('caps the list of matches in the message', () => {
    const many = Array.from({ length: 15 }, (_, i) => id(`abcd${i.toString(16).padStart(2, '0')}`));
    const e = rejection('abcd', many);
    expect(e.matches).toHaveLength(15);
    expect(e.message).toContain('and 5 more');
  });

  it('errors when nothing matches', () => {
    expect(rejection('ffff').code).toBe('not-found');
    expect(rejection('ffff', []).code).toBe('not-found');
  });

  it.each(['', 'c_', '9f2', 'c_9f2', 'xyz123', 'c_9f2e-1', '9'.repeat(65)])('rejects malformed input %j', (input) => {
    expect(rejection(input).code).toBe('invalid');
  });
});
