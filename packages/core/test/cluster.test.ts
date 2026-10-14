import { describe, expect, it } from 'vitest';
import { clusterDivergences, clusterSignature, describeFeatures, describeSignature, featureWeights, signatureKey, type Divergence } from '../src/cluster.js';
import type { FieldShape } from '../src/diff-shape.js';

const stdout = (shape: FieldShape['shape'], detail?: string): FieldShape => ({ field: 'stdout', shape, ...(detail === undefined ? {} : { detail }) });
const exit = (detail: string): FieldShape => ({ field: 'exit', shape: 'exit-code', detail });
const d = (caseId: string, features: string[], ...shapes: FieldShape[]): Divergence => ({ caseId, features, shapes });

describe('clusterSignature', () => {
  it('is the diverging fields and their shapes, without the features', () => {
    expect(clusterSignature(d('c1', ['opt.w', 'opt.l'], exit('0 vs 1'), stdout('empty', 'candidate empty')))).toEqual({
      fields: ['exit', 'stdout'],
      shapes: [exit('0 vs 1'), stdout('empty', 'candidate empty')],
    });
  });

  it('keeps one exit-code entry when exit and signal both diverge', () => {
    const crash = d('c1', [], { field: 'exit', shape: 'exit-code', detail: '0 vs SIGSEGV' }, { field: 'signal', shape: 'exit-code', detail: '0 vs SIGSEGV' });
    expect(clusterSignature(crash)).toEqual({ fields: ['exit', 'signal'], shapes: [{ field: 'exit', shape: 'exit-code', detail: '0 vs SIGSEGV' }] });
  });

  it('gives equal keys exactly for equal signatures', () => {
    const key = (x: Divergence) => signatureKey(clusterSignature(x));
    expect(key(d('a', ['x', 'y'], stdout('line-order')))).toBe(key(d('b', ['z'], stdout('line-order'))));
    expect(key(d('a', ['x'], stdout('line-order')))).not.toBe(key(d('a', ['x'], exit('2 vs 1'), stdout('line-order'))));
    expect(key(d('a', ['x'], stdout('line-order')))).not.toBe(key(d('a', ['x'], stdout('number-value'))));
    expect(key(d('a', [], stdout('empty', 'candidate empty')))).not.toBe(key(d('a', [], stdout('empty', 'reference empty'))));
    expect(key(d('a', [], exit('2 vs 1')))).not.toBe(key(d('a', [], exit('2 vs 0'))));
  });
});

describe('featureWeights', () => {
  it('weighs each feature 1 over its case count, counting untagged cases toward base', () => {
    const weights = featureWeights([{ features: ['a'] }, { features: ['a', 'b'] }, { features: [] }, { features: ['a'] }]);
    expect(Object.fromEntries(weights)).toEqual({ a: 1 / 3, b: 1, base: 1 });
  });
});

describe('clusterDivergences', () => {
  it('groups divergences with the same signature, keeping case order', () => {
    const clusters = clusterDivergences(
      [d('c1', ['a'], stdout('number-value')), d('c2', ['a'], exit('2 vs 1')), d('c3', ['a'], stdout('number-value'))],
      new Map([['a', 0.25]]),
    );
    expect(clusters.map((c) => ({ cases: c.cases, weight: c.weight }))).toEqual([
      { cases: ['c1', 'c3'], weight: 0.5 },
      { cases: ['c2'], weight: 0.25 },
    ]);
  });

  it('groups the same shape under different features into one cluster, counting cases per feature', () => {
    const clusters = clusterDivergences(
      [d('c1', [], stdout('number-value')), d('c2', ['opt.l'], stdout('number-value')), d('c3', ['error.file', 'opt.l'], stdout('number-value'))],
      new Map([
        ['base', 0.5],
        ['opt.l', 0.25],
        ['error.file', 1],
      ]),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      cases: ['c1', 'c2', 'c3'],
      features: [
        { feature: 'opt.l', cases: 2 },
        { feature: 'base', cases: 1 },
        { feature: 'error.file', cases: 1 },
      ],
      weight: 2,
    });
  });

  it('ranks by size × feature weight: a small cluster in a thin feature can come first', () => {
    // 100 cases tag `error`, 2 tag `opt.x`: 10 error cases weigh 0.1, 1 opt.x case weighs 0.5.
    const weights = new Map([
      ['error', 1 / 100],
      ['opt.x', 1 / 2],
    ]);
    const errors = Array.from({ length: 10 }, (_, i) => d(`e${i}`, ['error'], exit('2 vs 1')));
    const clusters = clusterDivergences([...errors, d('x1', ['opt.x'], stdout('number-value'))], weights);
    expect(clusters.map((c) => c.cases.length)).toEqual([1, 10]);
    expect(clusters[0]!.weight).toBe(0.5);
    expect(clusters[1]!.weight).toBeCloseTo(0.1);
  });

  it('breaks weight ties by size, then by signature, the same way for any input order', () => {
    const weights = new Map([
      ['x', 0.1],
      ['y', 0.2],
      ['a', 0.3],
      ['w', 0.15],
    ]);
    // 0.1 + 0.2 and 0.3 tie although their floating-point sums differ; so do 0.15 + 0.15.
    const input = [d('a1', ['a'], stdout('number-value')), d('xy1', ['x', 'y'], stdout('other')), d('w1', ['w'], stdout('line-order')), d('w2', ['w'], stdout('line-order'))];
    const order = (xs: Divergence[]) => clusterDivergences(xs, weights).map((c) => c.cases.join());
    expect(order(input)).toEqual(['w1,w2', 'a1', 'xy1']);
    expect(order([...input].reverse())).toEqual(['w2,w1', 'a1', 'xy1']);
  });

  it('counts an untagged case toward base, and a feature without a weight as 0', () => {
    const clusters = clusterDivergences([d('c1', [], stdout('other')), d('c2', ['new'], stdout('line-order'))], new Map([['base', 0.5]]));
    expect(clusters.map((c) => [c.cases, c.weight])).toEqual([
      [['c1'], 0.5],
      [['c2'], 0],
    ]);
  });
});

describe('describeSignature', () => {
  it('names each field with its shape, and an exit status by its codes', () => {
    expect(describeSignature(clusterSignature(d('c', ['opt.l'], exit('2 vs 1'), stdout('prefix-suffix', 'candidate stops early'))))).toBe(
      'exit 2 vs 1, stdout prefix-suffix (candidate stops early)',
    );
    expect(describeSignature(clusterSignature(d('c', [], stdout('line-order'))))).toBe('stdout line-order');
  });

  it('lists features with their case counts', () => {
    expect(describeFeatures(clusterDivergences([d('a', ['opt.l'], stdout('other')), d('b', ['opt.l', 'opt.c'], stdout('other'))], new Map())[0]!.features)).toBe('opt.l (2), opt.c (1)');
  });
});
