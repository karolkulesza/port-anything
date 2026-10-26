import { describe, expect, it } from 'vitest';
import { FEATURE_ROWS, STATUS_CHARACTERS, cut, formatCase, formatFeatures, formatNext, formatProbe, formatRun, formatStatus, lineDiff } from '../src/index.js';
import { CASE, DELTA, FEATURES, NEXT, PROBE, RUN, STATUS, worstStatus } from './fixtures.js';
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
    expect(text).toContain(`run ${RUN} (2026-10-16 08:30 UTC): 500 cases + 2 flaky-reference left out, as "sort", sandbox bwrap`);
    expect(text).toContain('c1 ./port/target/release/sort: parity 93.4% over 12 features; 467 match, 30 diverge, 3 waived');
    expect(text).toContain('clusters: 7, 6 open; top 5:');
    expect(text).toContain('  #1 c1 · 12 cases · stdout trailing-newline · opt.n (8), base (4)');
    expect(text).toContain('  #5 c1');
    expect(text).toContain('integrity: manifest frozen, 500 cases, same environment; port-anything verify checks it');
    expect(text).toContain('flaky-reference 2 · waivers 1 · normalizers (cases changed): tmp-paths 3');
  });

  it('counts the flaky-reference cases left out next to the cases the run compared (done when)', () => {
    expect(formatStatus(STATUS)).toContain(`run ${RUN} (2026-10-16 08:30 UTC): 500 cases + 2 flaky-reference left out, as "sort", sandbox bwrap`);
    expect(formatStatus({ ...STATUS, integrity: { ...STATUS.integrity, flakyReference: 0 } })).toContain(`run ${RUN} (2026-10-16 08:30 UTC): 500 cases as "sort"`);
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

describe('formatCase', () => {
  it('shows the case, both observations and the diff', () => {
    const text = formatCase(CASE);
    expect(text).toContain('case c_9f2e1a4b · generated · features opt.n\n');
    expect(text).toContain(`in cluster ${RUN}/1: c1 · 12 cases · stdout trailing-newline`);
    expect(text).toContain('  $ sort -n in.txt\n  env LC_ALL="C"\n  file in.txt: "3\\n1\\n"\n');
    expect(text).toContain('reference:\n  exit 0\n  stdout: 2 lines\n    | 1\n    | 3\n  stderr: (empty)\n  files: no changes\n');
    expect(text).toContain('candidate c1 ./port/target/release/sort:\n  exit 2\n  stdout: 2 lines, no newline at the end\n');
    expect(text).toContain('  stderr: 1 line\n    | sort: oops\n  files: 1 line\n    | created out.txt 3f2a00000000\n');
    expect(text).toContain('diff (reference -, candidate +, after normalizers):\nstdout:\n  @@ line 3');
    expect(text).toContain('exit: reference 0, candidate 2');
  });

  it('says when the case matches, is in no cluster, timed out or was killed', () => {
    const text = formatCase({ ...CASE, cluster: null, diff: [], reference: { ...CASE.reference, exit: null, signal: 'SIGSEGV' }, observed: { ...CASE.observed, timeout: true } });
    expect(text).toContain('not in a cluster of the latest full run');
    expect(text).toContain('reference:\n  killed by SIGSEGV');
    expect(text).toContain(':\n  timed out');
    expect(text).toContain('match: the same after normalizers');
  });

  it('caps long output and shows invisible characters', () => {
    const stdout = `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const text = formatCase({ ...CASE, reference: { ...CASE.reference, stdout, stderr: 'tab\there \n' } });
    expect(text).toContain('  stdout: 100 lines\n');
    expect(text).toContain('    | … 80 more lines');
    expect(text).not.toContain('line 20\n');
    expect(text).toContain('    | "tab\\there "');
  });
});

describe('formatFeatures', () => {
  it('lists the features with their cases, parity and marks', () => {
    const text = formatFeatures(FEATURES);
    expect(text).toContain('spec port-anything/cli-spec.yaml: program sort, 3 features\n');
    expect(text).toContain(`parity from run ${RUN} (2026-10-16 08:30 UTC), headline: c1 ./port/target/release/sort 93.4%`);
    expect(text).toContain('features: 4; under-sampled = fewer than 20 scored cases, not in the headline\n');
    expect(text).toContain('  opt.n · -n, --numeric-sort · 40 cases · 95.0%\n');
    expect(text).toContain('  opt.help · --help · 2 cases · 100.0% [self-description]\n');
    expect(text).toContain('  opt.k · -k, --key KEYDEF · 0 cases [untested]\n');
    expect(text).toContain('  base · 5 cases · 60.0% [under-sampled, not in spec]\n');
  });

  it('shows parity per candidate when there are several', () => {
    const two = { ...FEATURES, candidates: [...FEATURES.candidates, { candidate: 2, command: './b', parity: 0.5 }], features: [{ ...FEATURES.features[0]!, parity: [0.95, null] }] };
    expect(formatFeatures(two)).toContain('  opt.n · -n, --numeric-sort · 40 cases · c1 95.0% c2 n/a\n');
  });

  it('works without a spec or a run, and caps the list', () => {
    const rows = Array.from({ length: FEATURE_ROWS + 5 }, (_, i) => ({ feature: `opt.f${i}`, spec: `--f${i}`, cases: null, parity: [], selfDescription: false, underSampled: false }));
    const text = formatFeatures({ spec: { program: 'x', features: rows.length }, run: null, candidates: [], prefix: 'opt.', features: rows });
    expect(text).toContain('no saved run of the whole corpus yet');
    expect(text).toContain('features starting "opt.": 65\n');
    expect(text).toContain('  opt.f0 · --f0\n');
    expect(text).toContain('  +5 more: pass prefix to narrow');
    expect(formatFeatures({ ...FEATURES, spec: null })).toContain('no CLI spec');
    expect(formatFeatures({ ...FEATURES, spec: null })).not.toContain('not in spec');
  });

  it('stays bounded at its longest', () => {
    const long = 'x'.repeat(500);
    const rows = Array.from({ length: 500 }, () => ({ feature: long, spec: long, cases: 99_999, parity: [0.5, 0.5, 0.5, 0.5], selfDescription: true, underSampled: true }));
    const text = formatFeatures({ ...FEATURES, candidates: Array.from({ length: 4 }, (_, i) => ({ candidate: i + 1, command: long, parity: 0.5 })), features: rows });
    expect(text.split('\n').length).toBeLessThan(FEATURE_ROWS + 10);
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThan(250);
  });
});

describe('formatProbe', () => {
  it('shows the invocation, what the reference did and where it was saved', () => {
    const text = formatProbe(PROBE);
    expect(text).toContain('probe 20261016-091500-e5f6, reference only, saved to .port-anything/probes/20261016-091500-e5f6.json (not part of the corpus):\n');
    expect(text).toContain('  $ sort -k 2\n  stdin: "b 2\\na 1\\n"\nreference:\n  exit 0\n  stdout: 2 lines\n    | a 1\n    | b 2\n');
  });
});
