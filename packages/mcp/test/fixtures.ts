import type { ClusterSummary, NextReport, RunDelta, StatusReport } from '../src/index.js';

export const RUN = '20261016-083000-a1b2';

export function cluster(n: number, overrides: Partial<ClusterSummary> = {}): ClusterSummary {
  return { run: RUN, cluster: n, candidate: 1, size: 13 - n, description: 'stdout trailing-newline', features: [{ feature: 'opt.n', cases: 8 }, { feature: 'base', cases: 4 }], ...overrides };
}

export const STATUS: StatusReport = {
  run: { id: RUN, created: '2026-10-16T08:30:00.000Z', cases: 500, programName: 'sort', sandbox: 'bwrap', compare: 'standard (stderr loose, similarity 0.6)' },
  candidates: [{ candidate: 1, command: './port/target/release/sort', parity: 0.9345, features: 12, match: 467, diverge: 30, waived: 3 }],
  clusters: { total: 7, open: 6, top: [1, 2, 3, 4, 5].map((n) => cluster(n)) },
  integrity: {
    manifest: { cases: 500, environment: 'same' },
    flakyReference: 2,
    waivers: 1,
    largeWaivers: 0,
    normalizers: [{ normalizer: 'tmp-paths', cases: 3 }],
  },
};

/**
 * The longest `status` can get on a real project: every list well past its cap and every string
 * past its cut, with realistic long commands, feature names and signatures.
 */
export function worstStatus(): StatusReport {
  const long = (base: string) => Array.from({ length: 10 }, () => base).join(' ');
  const features = Array.from({ length: 40 }, (_, i) => ({ feature: `opt.numeric-sort-with-a-long-name-${i}`, cases: 99_999 }));
  return {
    run: { id: RUN, created: '2026-10-16T08:30:00.000Z', cases: 999_999, programName: 'a-program-name-that-goes-on-and-on', sandbox: 'sandbox-exec, no network', compare: 'standard (stderr loose, similarity 0.6)' },
    candidates: Array.from({ length: 9 }, (_, i) => ({
      candidate: i + 1,
      command: long('/home/someone/projects/port-of-the-tool/target/release/tool-rs --compat-mode=gnu'),
      parity: 0.123456,
      features: 9_999,
      match: 999_999,
      diverge: 999_999,
      waived: 999_999,
    })),
    clusters: {
      total: 99_999,
      open: 99_999,
      top: Array.from({ length: 9 }, (_, i) => ({
        run: RUN,
        cluster: 99_990 + i,
        candidate: 9,
        size: 999_999,
        description: long('stdout line-order (first difference at line 12), stderr message-text, exit 1 vs 2'),
        features,
      })),
    },
    integrity: {
      manifest: { cases: 999_999, environment: { differs: ['os', 'arch', 'libc', 'locale', 'reference'] } },
      flakyReference: 999_999,
      waivers: 9_999,
      largeWaivers: 9_999,
      normalizers: Array.from({ length: 20 }, (_, i) => ({ normalizer: `float-tolerance (rtol 1e-9) on stdout of fmt.json ${i}`, cases: 999_999 })),
    },
  };
}

export const NEXT: NextReport = {
  kind: 'cluster',
  cluster: cluster(1),
  open: 6,
  programName: 'sort',
  repro: { argv: ['-n', 'in.txt'], env: {}, stdin: null, fixtures: { 'in.txt': '3\n1\n' }, source: 'c_9f2e1a4b', minimized: true, exhausted: false },
  diff: [
    { field: 'stdout', reference: '1\n3\n', candidate: '1\n3' },
    { field: 'exit', reference: '0', candidate: '2' },
  ],
};

export const DELTA: RunDelta = {
  run: '20261016-090000-c3d4',
  selection: `cluster ${RUN}/1`,
  cases: 12,
  baseline: RUN,
  flakyReference: 0,
  candidates: [{ candidate: 1, command: './port/target/release/sort', match: 10, diverge: 2, waived: 0, fixed: 10, broke: 0, brokeCases: [] }],
  clusters: { total: 1, top: [cluster(1, { run: '20261016-090000-c3d4', size: 2 })] },
};
