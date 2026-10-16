import { describe, expect, it } from 'vitest';
import { STATUS_CHARACTERS, cut, formatNext, formatRun, formatStatus, lineDiff } from '../src/index.js';
import { DELTA, NEXT, RUN, STATUS, worstStatus } from './fixtures.js';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('counts more than a BPE tokenizer would on plain text', () => {
    // "The quick brown fox jumps over the lazy dog." is 10 tokens in common BPE tokenizers.
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThanOrEqual(10);
  });
});

describe('formatStatus', () => {
  it('shows the headline, the top clusters and the integrity state', () => {
    const text = formatStatus(STATUS);
    expect(text).toContain(`run ${RUN} (2026-10-16 08:30 UTC): 500 cases as "sort", sandbox bwrap`);
    expect(text).toContain('c1 ./port/target/release/sort: parity 93.4% over 12 features; 467 match, 30 diverge, 3 waived');
    expect(text).toContain('clusters: 7, 6 open; top 5:');
    expect(text).toContain('  #1 c1 · 12 cases · stdout trailing-newline · opt.n (8), base (4)');
    expect(text).toContain('  #5 c1');
    expect(text).toContain('integrity: manifest frozen, 500 cases, same environment; port-anything verify checks it');
    expect(text).toContain('flaky-reference 2 · waivers 1 · normalizers (cases changed): tmp-paths 3');
  });

  it('stays under 500 tokens', () => {
    expect(estimateTokens(formatStatus(STATUS))).toBeLessThan(500);
  });

  it('stays under 500 tokens at its longest: lists capped, long names cut', () => {
    const text = formatStatus(worstStatus());
    expect(text.split('\n').filter((l) => l.startsWith('  #')).length).toBeGreaterThanOrEqual(1);
    expect(text.length).toBeLessThanOrEqual(STATUS_CHARACTERS + 200);
    expect(text).toContain("+6 more candidates");
    expect(text).toContain('environment differs (os, arch, libc, locale, reference)');
    expect(estimateTokens(text)).toBeLessThan(500);
  });

  it('says how to get a run when there is none', () => {
    expect(formatStatus({ ...STATUS, run: null })).toMatch(/No saved run.*port-anything run/);
  });

  it('says when the corpus is not frozen', () => {
    expect(formatStatus({ ...STATUS, integrity: { ...STATUS.integrity, manifest: null } })).toContain('manifest not frozen (port-anything baseline)');
  });
});

describe('lineDiff', () => {
  it('shows only the changed lines, with a little context', () => {
    expect(lineDiff('a\nb\nc\nd\ne\n', 'a\nb\nc\nX\ne\n')).toEqual(['@@ line 4', '  b', '  c', '- d', '+ X']);
  });

  it('writes lines with invisible differences as JSON strings', () => {
    expect(lineDiff('1\n3\n', '1\n3 \n')).toEqual(['@@ line 2', '  1', '- 3', '+ "3 "']);
  });

  it('shows a missing trailing newline as a missing empty line', () => {
    expect(lineDiff('1\n3\n', '1\n3')).toEqual(['@@ line 3', '  1', '  3', '- ']);
  });

  it('caps the lines shown per side', () => {
    const many = Array.from({ length: 50 }, (_, i) => `${i}`).join('\n');
    const diff = lineDiff(many, '');
    expect(diff.filter((l) => l.startsWith('- ')).length).toBe(13);
    expect(diff).toContain('- … 38 more lines');
  });

  it('is empty for equal texts', () => {
    expect(lineDiff('x', 'x')).toEqual([]);
  });
});

describe('cut', () => {
  it('cuts by characters, not UTF-16 units', () => {
    expect(cut('ééééé', 3)).toBe('éé…');
    expect(cut('abc', 3)).toBe('abc');
  });
});

describe('formatNext', () => {
  it('shows the cluster, its repro and the diff', () => {
    const text = formatNext(NEXT);
    expect(text).toContain(`cluster ${RUN}/1 (highest priority of 6 open): c1 · 12 cases · stdout trailing-newline`);
    expect(text).toContain('repro (minimized from c_9f2e1a4b):');
    expect(text).toContain('  $ sort -n in.txt');
    expect(text).toContain('  file in.txt: "3\\n1\\n"');
    expect(text).toContain('stdout:\n  @@ line 3');
    expect(text).toContain('exit: reference 0, candidate 2');
    expect(text).toContain(`call run with cluster "${RUN}/1"`);
  });

  it('says when the repro no longer diverges', () => {
    expect(formatNext({ ...NEXT, diff: [] } as typeof NEXT)).toContain('no longer diverges');
  });

  it('handles no run and no open cluster', () => {
    expect(formatNext({ kind: 'no-run' })).toMatch(/No saved run/);
    expect(formatNext({ kind: 'none-open', run: RUN, total: 0 })).toContain('has no clusters');
    expect(formatNext({ kind: 'none-open', run: RUN, total: 3 })).toContain('All 3 clusters');
  });
});

describe('formatRun', () => {
  it('shows the deltas against the baseline run', () => {
    const text = formatRun(DELTA);
    expect(text).toContain(`run 20261016-090000-c3d4: cluster ${RUN}/1, 12 cases`);
    expect(text).toContain('c1 ./port/target/release/sort: 10 match, 2 diverge; fixed 10, broke 0');
    expect(text).toContain(`deltas against run ${RUN}`);
    expect(text).toContain('address them as "20261016-090000-c3d4/<n>"');
  });

  it('names a few broken cases, and says when there is no baseline', () => {
    const broke = formatRun({ ...DELTA, candidates: [{ ...DELTA.candidates[0]!, broke: 7, brokeCases: ['c_00000001', 'c_00000002'] }] });
    expect(broke).toContain('broke 7 (c_00000001 c_00000002, +5 more)');
    const none = formatRun({ ...DELTA, baseline: null, candidates: [{ ...DELTA.candidates[0]!, fixed: null, broke: null }] });
    expect(none).toContain('no baseline run to compare with');
  });
});
