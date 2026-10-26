import { canonicalCase, type CanonicalCase, type GeneratedCorpusCache } from '@port-anything/core';
import { describe, expect, it } from 'vitest';
import { corpusChange, corpusChangeLine } from '../src/corpus.js';

const generated = (argv: string[], features: string[]): CanonicalCase => canonicalCase({ argv, features, origin: 'generated' });
const a = generated(['-a'], ['opt.a']);
const a2 = generated(['-a', '-a'], ['opt.a']);
const b = generated(['-b'], ['opt.b']);
const plain = generated([], []);

const KEY = `sha256:${'1'.repeat(64)}`;
const OTHER = `sha256:${'2'.repeat(64)}`;

function corpus(cases: CanonicalCase[], keyWithoutCommitted: string, generator: 'v1' | 'v2' = 'v2'): GeneratedCorpusCache {
  return {
    key: `sha256:${'9'.repeat(64)}`,
    keyWithoutCommitted,
    settings: { generator, seed: 42, budget: 10, errorPathCap: 0.3, minCasesPerFeature: 20 },
    cases,
    stats: { observed: cases.length, dropped: { duplicate: 0, errorCap: 0, budget: 0 }, stop: 'exhausted', underSampled: [] },
    skipped: [],
  };
}
const outline = (cases: CanonicalCase[], keyWithoutCommitted?: string) => ({
  key: `sha256:${'8'.repeat(64)}`,
  ...(keyWithoutCommitted === undefined ? {} : { keyWithoutCommitted }),
  cases: cases.map((c) => ({ id: c.id, features: c.features })),
});

describe('corpusChange', () => {
  it('is undefined for the same cases', () => {
    expect(corpusChange(outline([a, b], KEY), corpus([b, a], OTHER))).toBeUndefined();
  });

  it('blames the recorded cases only when everything else the cases come from is the same (generator v2)', () => {
    expect(corpusChange(outline([a], KEY), corpus([a, b], KEY))).toEqual({ cause: 'recorded', features: [{ feature: 'opt.b', before: 0, now: 1 }] });
    expect(corpusChange(outline([a], KEY), corpus([a, b], OTHER))?.cause).toBe('other');
    expect(corpusChange(outline([a], KEY), corpus([a, b], KEY, 'v1'))?.cause).toBe('other');
  });

  it("can't tell the cause from a cache written before the key that tells them apart", () => {
    expect(corpusChange(outline([a]), corpus([a, b], KEY))?.cause).toBe('unknown');
  });

  it('lists only the features whose count moved, untagged cases under base', () => {
    expect(corpusChange(outline([a, b], KEY), corpus([a2, b, plain], KEY))?.features).toEqual([{ feature: 'base', before: 0, now: 1 }]);
    expect(corpusChange(outline([a, b], KEY), corpus([a2, b], OTHER))).toEqual({ cause: 'other', features: [] });
  });
});

describe('corpusChangeLine', () => {
  const moved = [
    { feature: 'opt.a', before: 28, now: 1430 },
    { feature: 'opt.g', before: 2292, now: 1163 },
  ];

  it('says what changed the generated cases and how their counts moved', () => {
    expect(corpusChangeLine({ cause: 'recorded', features: moved })).toBe(
      'the recorded cases changed the generated ones (generator v2 mutates them); generated cases per feature, before → now: opt.a 28 → 1430, opt.g 2292 → 1163',
    );
    expect(corpusChangeLine({ cause: 'other', features: moved })).toMatch(
      /^the generated cases changed since they were last generated \(the CLI spec, seeds, settings or reference command changed\); generated cases per feature/,
    );
    expect(corpusChangeLine({ cause: 'unknown', features: moved })).toMatch(/\(the CLI spec, seeds, settings, reference command or recorded cases changed\)/);
  });

  it('says when every feature kept its count', () => {
    expect(corpusChangeLine({ cause: 'other', features: [] })).toBe(
      'the generated cases changed since they were last generated (the CLI spec, seeds, settings or reference command changed); the same number per feature',
    );
  });
});
