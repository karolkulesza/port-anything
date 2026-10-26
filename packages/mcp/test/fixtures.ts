import type { CaseReport, ClusterSummary, FeaturesReport, NextReport, ProbeReport, RunDelta, StatusReport } from '../src/index.js';

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
  skipped: [],
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

const CASE_ID = `sha256:9f2e1a4b${'0'.repeat(56)}`;

export const CASE: CaseReport = {
  id: CASE_ID,
  origin: 'generated',
  features: ['opt.n'],
  case: { argv: ['-n', 'in.txt'], env: { LC_ALL: 'C' }, stdin: null, fixtures: { 'in.txt': '3\n1\n' } },
  cluster: cluster(1),
  programName: 'sort',
  candidate: { candidate: 1, command: './port/target/release/sort' },
  reference: { exit: 0, signal: null, timeout: false, stdout: '1\n3\n', stderr: '', fs: '' },
  observed: { exit: 2, signal: null, timeout: false, stdout: '1\n3', stderr: 'sort: oops\n', fs: 'created out.txt 3f2a00000000\n' },
  diff: [
    { field: 'stdout', reference: '1\n3\n', candidate: '1\n3' },
    { field: 'exit', reference: '0', candidate: '2' },
  ],
};

export const FEATURES: FeaturesReport = {
  spec: { program: 'sort', features: 3 },
  run: { id: RUN, created: '2026-10-16T08:30:00.000Z', minCasesPerFeature: 20 },
  candidates: [{ candidate: 1, command: './port/target/release/sort', parity: 0.9345 }],
  prefix: null,
  features: [
    { feature: 'opt.n', spec: '-n, --numeric-sort', cases: 40, parity: [0.95], selfDescription: false, underSampled: false },
    { feature: 'opt.help', spec: '--help', cases: 2, parity: [1], selfDescription: true, underSampled: false },
    { feature: 'opt.k', spec: '-k, --key KEYDEF', cases: 0, parity: [null], selfDescription: false, underSampled: false },
    { feature: 'base', spec: null, cases: 5, parity: [0.6], selfDescription: false, underSampled: true },
  ],
};

export const PROBE: ProbeReport = {
  id: '20261016-091500-e5f6',
  path: '.port-anything/probes/20261016-091500-e5f6.json',
  programName: 'sort',
  case: { argv: ['-k', '2'], env: {}, stdin: 'b 2\na 1\n', fixtures: {} },
  observed: { exit: 0, signal: null, timeout: false, stdout: 'a 1\nb 2\n', stderr: '', fs: '' },
};
