import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clusterDivergences, featureWeights, type Divergence } from '../src/cluster.js';
import { ConfigError } from '../src/config.js';
import type { FieldShape } from '../src/diff-shape.js';
import {
  LARGE_WAIVER_SHARE,
  WAIVERS_FILE,
  describeWaiver,
  matchWaivers,
  parseWaivers,
  readWaiversFile,
  suggestWaivers,
  suggestedPredicates,
  waiverCoverage,
  type Waiver,
  type WaivableDivergence,
} from '../src/waivers.js';

const waiver = (match: Waiver['match'], category: Waiver['category'] = 'intentional'): Waiver => ({ match, category, reason: 'r' });
const shape = (field: FieldShape['field'], s: FieldShape['shape'], detail?: string): FieldShape => (detail === undefined ? { field, shape: s } : { field, shape: s, detail });

describe('parseWaivers', () => {
  it('reads the plan example: predicates on feature, field, shape and regex, with a category and a reason', () => {
    const waivers = parseWaivers([
      { match: { feature: 'fmt.json', field: 'stdout', shape: 'number-format' }, category: 'intentional', reason: 'jaq prints 1.0 as 1.0; jq prints 1' },
      { match: { feature: 'opt.debug', field: 'stderr', regex: '^sort: ' }, category: 'platform', reason: 'message prefix differs; not user-facing' },
    ]);
    expect(waivers).toEqual([
      { match: { feature: 'fmt.json', field: 'stdout', shape: 'number-format' }, category: 'intentional', reason: 'jaq prints 1.0 as 1.0; jq prints 1' },
      { match: { feature: 'opt.debug', field: 'stderr', regex: '^sort: ' }, category: 'platform', reason: 'message prefix differs; not user-facing' },
    ]);
  });

  it('takes an empty file as no waivers', () => {
    expect(parseWaivers(null)).toEqual([]);
    expect(parseWaivers([])).toEqual([]);
  });

  it('rejects, with the key path, a waiver that would match everything, lacks a reason or has an unknown key', () => {
    const problems = (input: unknown) => {
      try {
        parseWaivers(input);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error('parsed');
    };
    expect(problems([{ match: {}, category: 'intentional', reason: 'all of it' }])).toMatch(/0\.match: .*at least one of feature, field, shape, regex/);
    expect(problems([{ match: { field: 'stdout' }, category: 'intentional', reason: '  ' }])).toMatch(/0\.reason/);
    expect(problems([{ match: { field: 'stdout' }, category: 'cosmetic', reason: 'x' }])).toMatch(/0\.category/);
    expect(problems([{ match: { field: 'stdout', detail: 'x' }, category: 'platform', reason: 'x' }])).toMatch(/0\.match/);
    expect(problems([{ match: { shape: 'float-format' }, category: 'platform', reason: 'x' }])).toMatch(/0\.match\.shape/);
    expect(problems([{ match: { regex: '(' }, category: 'platform', reason: 'x' }])).toMatch(/0\.match\.regex: not a valid regular expression/);
    expect(problems([{ match: { field: 'exit', regex: 'x' }, category: 'platform', reason: 'x' }])).toMatch(/0\.match\.regex: .*stdout or stderr/);
    expect(problems({ match: { field: 'stdout' } })).toMatch(/must be a list/);
  });
});

describe('readWaiversFile', () => {
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'pa-waivers-'));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it('reads port-anything/waivers.yaml, and takes a missing file as no waivers', async () => {
    expect(WAIVERS_FILE).toBe('port-anything/waivers.yaml');
    expect(await readWaiversFile(project)).toEqual([]);
    mkdirSync(join(project, 'port-anything'));
    writeFileSync(
      join(project, WAIVERS_FILE),
      `- match: { feature: opt.debug, field: stderr, regex: "^sort: " }
  category: platform
  reason: "message prefix differs; not user-facing"
`,
    );
    expect(await readWaiversFile(project)).toEqual([waiver({ feature: 'opt.debug', field: 'stderr', regex: '^sort: ' }, 'platform')].map((w) => ({ ...w, reason: 'message prefix differs; not user-facing' })));
  });

  it('names the file in errors, for bad YAML and for a bad waiver', async () => {
    writeFileSync(join(project, WAIVERS_FILE), '- match: { field: stdout\n');
    await expect(readWaiversFile(project)).rejects.toThrow(/port-anything\/waivers\.yaml is not valid YAML/);
    writeFileSync(join(project, WAIVERS_FILE), '- match: { field: stdout }\n  category: intentional\n');
    await expect(readWaiversFile(project)).rejects.toThrow(/port-anything\/waivers\.yaml is not valid:\n {2}0\.reason/);
  });
});

describe('matchWaivers', () => {
  const d = (features: string[], shapes: FieldShape[], reference: WaivableDivergence['reference'] = {}): WaivableDivergence => ({ features, shapes, reference });

  it('waives a field when every key of the predicate holds for it', () => {
    const div = d(['fmt.json'], [shape('stdout', 'number-format')]);
    expect(matchWaivers(div, [waiver({ feature: 'fmt.json', field: 'stdout', shape: 'number-format' })])).toEqual({ fields: [[0]], waived: true, remaining: [] });
    for (const miss of [{ feature: 'fmt.yaml' }, { field: 'stderr' as const }, { shape: 'number-value' as const }, { feature: 'fmt.json', field: 'stdout' as const, shape: 'line-order' as const }]) {
      expect(matchWaivers(div, [waiver(miss)])).toEqual({ fields: [[]], waived: false, remaining: [shape('stdout', 'number-format')] });
    }
  });

  it('counts an untagged case as base, as clustering and scoring do', () => {
    expect(matchWaivers(d([], [shape('stdout', 'other')]), [waiver({ feature: 'base' })]).waived).toBe(true);
  });

  it('waives each diverging field on its own, so a case only counts as waived when all of them are', () => {
    const div = d(['opt.l'], [shape('exit', 'exit-code', '2 vs 1'), shape('stdout', 'number-value')]);
    const partial = matchWaivers(div, [waiver({ field: 'stdout', shape: 'number-value' })]);
    expect(partial).toEqual({ fields: [[], [0]], waived: false, remaining: [shape('exit', 'exit-code', '2 vs 1')] });
    const full = matchWaivers(div, [waiver({ field: 'stdout' }), waiver({ feature: 'opt.l', shape: 'exit-code' }), waiver({ feature: 'opt.l' })]);
    expect(full).toEqual({ fields: [[1, 2], [0, 2]], waived: true, remaining: [] });
  });

  it("tests a regex against the reference's normalized output of the field, never the candidate's", () => {
    const w = [waiver({ field: 'stderr', regex: '^sort: ' })];
    expect(matchWaivers(d([], [shape('stderr', 'message-text')], { stderr: 'sort: cannot read: x\n' }), w).waived).toBe(true);
    expect(matchWaivers(d([], [shape('stderr', 'message-text')], { stderr: 'error: sort: x\n' }), w).waived).toBe(false);
    // Without the reference's text (or for a field that has none) a regex matches nothing.
    expect(matchWaivers(d([], [shape('stderr', 'message-text')]), w).waived).toBe(false);
    // Without a field, a regex tests whichever of stdout and stderr diverges.
    const any = [waiver({ regex: 'total' })];
    expect(matchWaivers(d([], [shape('exit', 'exit-code', '0 vs 1'), shape('stdout', 'other')], { stdout: '3 total\n' }), any)).toEqual({
      fields: [[], [0]],
      waived: false,
      remaining: [shape('exit', 'exit-code', '0 vs 1')],
    });
  });
});

describe('waiverCoverage', () => {
  it('counts the cases each waiver covers at least one field of, and flags those covering more than 10% of the cases', () => {
    expect(LARGE_WAIVER_SHARE).toBe(0.1);
    const waivers = [waiver({ field: 'stdout' }), waiver({ field: 'stderr' }), waiver({ feature: 'nothing' })];
    const matches = [
      matchWaivers({ features: [], shapes: [shape('stdout', 'other'), shape('stderr', 'message-text')] }, waivers),
      matchWaivers({ features: [], shapes: [shape('stdout', 'other')] }, waivers),
    ];
    expect(waiverCoverage(waivers, matches, 20)).toEqual([
      { waiver: 1, cases: 2, share: 0.1, large: false },
      { waiver: 2, cases: 1, share: 0.05, large: false },
      { waiver: 3, cases: 0, share: 0, large: false },
    ]);
    expect(waiverCoverage(waivers, matches, 19)[0]).toEqual({ waiver: 1, cases: 2, share: 2 / 19, large: true });
    expect(waiverCoverage(waivers, [], 0)[0]).toEqual({ waiver: 1, cases: 0, share: 0, large: false });
  });
});

describe('describeWaiver', () => {
  it('shows the predicate and the category on one line', () => {
    expect(describeWaiver(waiver({ feature: 'opt.debug', field: 'stderr', regex: '^sort: ' }, 'platform'))).toBe('feature opt.debug, field stderr, regex /^sort: / (platform)');
  });
});

describe('suggestWaivers', () => {
  it('prints one predicate per diverging field, from the signature without its detail, with the only feature', () => {
    const text = suggestWaivers({
      address: '20261014-190203-a1b2/2',
      signature: { fields: ['exit', 'stderr'], shapes: [shape('exit', 'exit-code', '2 vs 1'), shape('stderr', 'message-text')] },
      features: [{ feature: 'error.usage', cases: 3 }],
    });
    expect(text).toBe(
      [
        '# Cluster 20261014-190203-a1b2/2: exit 2 vs 1, stderr message-text · features error.usage (3)',
        '# Paste into port-anything/waivers.yaml, pick the category and write the reason.',
        '- match: { feature: error.usage, field: exit, shape: exit-code }',
        '  category: intentional # intentional | reference-bug | platform',
        '  reason: ""',
        '- match: { feature: error.usage, field: stderr, shape: message-text }',
        '  category: intentional # intentional | reference-bug | platform',
        '  reason: ""',
        '',
      ].join('\n'),
    );
  });

  it('leaves the feature out when the cluster has several, and says how to narrow it', () => {
    const text = suggestWaivers({
      address: '20261014-190203-a1b2/1',
      signature: { fields: ['stdout'], shapes: [shape('stdout', 'number-value')] },
      features: [
        { feature: 'opt.l', cases: 2 },
        { feature: 'base', cases: 1 },
      ],
    });
    expect(text).toContain('# Its cases have several features: add feature: <name> to waive only one of them.\n- match: { field: stdout, shape: number-value }\n');
  });

  it('gives a waiver that keeps matching its cases after a clustering heuristic changes', () => {
    // Run 1: the stdout number-value divergences form cluster 2.
    const run1: Divergence[] = [
      { caseId: 'a', features: ['opt.l'], shapes: [shape('exit', 'exit-code', '2 vs 1')] },
      { caseId: 'b', features: ['opt.l'], shapes: [shape('exit', 'exit-code', '2 vs 1')] },
      { caseId: 'c', features: ['opt.l'], shapes: [shape('exit', 'exit-code', '2 vs 1')] },
      { caseId: 'd', features: ['opt.l'], shapes: [shape('stdout', 'number-value')] },
      { caseId: 'e', features: ['opt.l'], shapes: [shape('stdout', 'number-value')] },
    ];
    const clusters1 = clusterDivergences(run1, featureWeights(run1));
    const target = clusters1.findIndex((k) => k.cases.includes('d'));
    expect(target).toBe(1);
    const waivers = suggestedPredicates(clusters1[target]!).map((match) => ({ match, category: 'intentional' as const, reason: 'counts differ on purpose' }));
    expect(waivers.map((w) => w.match)).toEqual([{ feature: 'opt.l', field: 'stdout', shape: 'number-value' }]);
    const waivedIn = (divs: readonly Divergence[]) => divs.filter((x) => matchWaivers(x, waivers).waived).map((x) => x.caseId);
    expect(waivedIn(run1)).toEqual(['d', 'e']);

    // Run 2, after the heuristics change: the classifier now gives number-value a detail and
    // splits on it, the exit cluster no longer exists and a new divergence outranks the target, so
    // cluster numbers, keys and sizes all change.
    const run2: Divergence[] = [
      { caseId: 'd', features: ['opt.l'], shapes: [shape('stdout', 'number-value', 'one number')] },
      { caseId: 'e', features: ['opt.l'], shapes: [shape('stdout', 'number-value', 'several numbers')] },
      { caseId: 'f', features: ['opt.l'], shapes: [shape('stdout', 'line-order')] },
      { caseId: 'g', features: ['opt.l'], shapes: [shape('stdout', 'line-order')] },
      { caseId: 'h', features: ['opt.l'], shapes: [shape('stdout', 'line-order')] },
    ];
    const clusters2 = clusterDivergences(run2, featureWeights(run2));
    expect(clusters2.map((k) => k.cases)).toEqual([['f', 'g', 'h'], ['d'], ['e']]);
    expect(waivedIn(run2)).toEqual(['d', 'e']);
  });
});
