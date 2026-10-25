import { scoreCandidate, waiverCoverage, type ScoredCase, type Waiver } from '@port-anything/core';
import type { ReportInput } from '../src/index.js';

/** A 3-candidate run the report tests share. Needs @port-anything/core built (`pnpm build`), like the CLI tests. */

export const id = (n: number) => `sha256:${n.toString(16).padStart(8, '0')}${'a'.repeat(56)}`;

/** The corpus: 25 `base` cases, 22 `opt.n`, 5 `opt.x` (under-sampled), 3 `opt.help` (self-description). */
const CORPUS = [
  ...Array.from({ length: 25 }, () => ['base']),
  ...Array.from({ length: 22 }, () => ['opt.n']),
  ...Array.from({ length: 5 }, () => ['opt.x']),
  ...Array.from({ length: 3 }, () => ['opt.help']),
].map((features, n) => ({ caseId: id(n + 1), features, origin: n < 40 ? ('recorded' as const) : ('generated' as const) }));

const SPEC_FEATURES = ['base', 'opt.n', 'opt.x', 'opt.help', 'opt.z'].map((name) => ({ name, selfDescription: false }));

export const WAIVERS: Waiver[] = [
  { match: { feature: 'opt.x', field: 'stdout', shape: 'missing-trailing-newline' }, category: 'intentional', reason: 'trailing newline <by design>' },
  { match: { feature: 'base', field: 'exit', shape: 'exit-code' }, category: 'reference-bug', reason: 'the original exits 0 after "write error"' },
];

/**
 * One candidate: which cases diverge, which of those a waiver covers (waiver index, from 0), and
 * which were scored on a re-run after the first run timed out.
 */
function candidate(command: string, diverging: readonly number[], waived: ReadonlyMap<number, number> = new Map(), recovered: readonly number[] = []) {
  const cases: ScoredCase[] = CORPUS.map((c, n) => ({ ...c, verdict: diverging.includes(n + 1) ? 'diverge' : 'match', waived: waived.has(n + 1), timeoutRecovered: recovered.includes(n + 1) }));
  const score = scoreCandidate(cases, { minCasesPerFeature: 20, features: SPEC_FEATURES });
  const matches = CORPUS.map((_, n) => (waived.has(n + 1) ? { fields: [[waived.get(n + 1)!]], waived: true, remaining: [] } : { fields: [[]], waived: false, remaining: [] }));
  return {
    command,
    match: CORPUS.length - diverging.length,
    diverge: diverging.length - waived.size,
    waived: waived.size,
    score,
    waivers: waiverCoverage(WAIVERS, matches, CORPUS.length),
    waivedCases: [...waived].map(([n, w]) => ({ case: id(n), waivers: [w + 1] })),
    timeoutRecovered: recovered.map(id),
  };
}

export const INPUT: ReportInput = {
  runId: '20261014-180203-a1b2',
  created: '2026-10-14T18:02:03.000Z',
  programName: 'tool',
  sandbox: 'bwrap (no network)',
  reference: './bin/tool',
  compare: { profile: 'default', stderr: { mode: 'loose', similarity: 0.8 } },
  cases: CORPUS.length,
  normalizers: [{ normalizer: 'tmp-paths', cases: 4 }],
  waivers: WAIVERS,
  holdout: { ran: true, cases: 180, inCorpus: 20, flakyReference: 1, alpha: 0.01, saved: 61 },
  candidates: [
    { ...candidate('./port-a/tool', []), holdout: { match: 179, diverge: 0, parity: 1, ci95: [0.979, 1], features: 2, gap: { corpus: 1, holdout: 1, gap: 0, pValue: 1, features: 2 }, significant: false } },
    { ...candidate('./port-b/tool', [2, 3, 30, 53, 54], new Map(), [5, 30]), holdout: { match: 168, diverge: 11, parity: 0.94, ci95: [0.902, 0.977], features: 2, gap: null, noGap: 'the corpus has no generated mutated cases to compare with', significant: false } },
    {
      ...candidate("'./port c/tool' --strict", [1, 4, 26, 27, 28, 48, 49], new Map([[1, 1], [48, 0], [49, 0]])),
      // Fitted to the corpus: a lookup table of its expected outputs.
      holdout: { match: 118, diverge: 61, parity: 0.66, ci95: [0.591, 0.728], features: 2, gap: { corpus: 0.958, holdout: 0.61, gap: 0.348, pValue: 0.00000012, features: 2 }, significant: true },
    },
  ],
  clusters: [
    { cluster: 1, candidate: 2, signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'number-value' }] }, features: [{ feature: 'base', cases: 2 }, { feature: 'opt.n', cases: 1 }], size: 3, weight: 0.12, cases: [id(2), id(3), id(30)], repro: id(3) },
    { cluster: 2, candidate: 2, signature: { fields: ['stdout'], shapes: [{ field: 'stdout', shape: 'other' }] }, features: [{ feature: 'opt.help', cases: 2 }], size: 2, weight: 0.6, cases: [id(53), id(54)] },
    { cluster: 3, candidate: 3, signature: { fields: ['exit'], shapes: [{ field: 'exit', shape: 'exit-code', detail: '0 vs 2' }] }, features: [{ feature: 'opt.n', cases: 3 }, { feature: 'base', cases: 1 }], size: 4, weight: 0.17, cases: [id(4), id(26), id(27), id(28)], repro: id(26) },
  ],
  repros: {
    [id(3)]: { argv: ['-n', 'a file.txt'], env: { LC_ALL: 'C' }, stdin: { bytes: 6, text: 'x\n<y>\n' }, fixtures: [{ path: 'a file.txt', bytes: 4, text: 'abc\n' }] },
    [id(1)]: { argv: [], env: {}, stdin: { bytes: 70000, text: 'z'.repeat(40), truncated: true }, fixtures: [{ path: 'bin.dat', bytes: 3 }] },
  },
};
