import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blob-store.js';
import { clusterDivergences, featureWeights } from '../src/cluster.js';
import { minimizeCluster } from '../src/minimize.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { parseProgramCommand, resolveProgram, type ResolvedProgram } from '../src/program.js';
import { openCaseRunner, runCases, type CaseRunner } from '../src/run-cases.js';

// A line counter and a port of it with two bugs: a last line without a newline counts as a line,
// and a usage error exits 1 instead of 2. Each run is logged to $PA_TEST_LOG.
const TOOL = (variant: 'ref' | 'bad') => `#!/bin/sh
echo "${variant} $*" >> "$PA_TEST_LOG"
for a in "$@"; do case "$a" in -x) echo "usage: tool [-l]" >&2; exit ${variant === 'ref' ? 2 : 1} ;; esac; done
${variant === 'ref' ? "tr -cd '\\n' | wc -c | tr -d ' '" : "awk 'END { print NR }'"}
`;

describe('minimizeCluster', () => {
  let root: string;
  let store: BlobStore;
  let log: string;
  let ref: ResolvedProgram;
  let bad: ResolvedProgram;
  let runner: CaseRunner;
  let scratch = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-minimize-cluster-')));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'tool'), TOOL('ref'), { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'tool-bad'), TOOL('bad'), { mode: 0o755 });
    log = join(root, 'runs.log');
    store = new BlobStore(join(root, 'cache'));
    ref = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool')));
    bad = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-bad')));
    runner = await openCaseRunner({ ...options(), rerun: false });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const options = () => ({
    reference: ref,
    candidates: [bad],
    store,
    sandbox: { kind: 'none' as const },
    workDir: join(root, `work-${scratch++}`),
    envAllowlist: ['PA_TEST_LOG'],
    hostEnv: { ...process.env, PA_TEST_LOG: log },
  });
  const make = async (argv: string[], stdin: string | null, features: string[] = []) =>
    canonicalCase({ argv, stdin: stdin === null ? null : await store.put(stdin), features, origin: 'recorded' });
  const text = async (c: CanonicalCase) => ({ argv: c.argv, stdin: c.stdin === null ? null : (await store.get(c.stdin)).toString() });
  /** The clusters a run of the cases gives, as the run command forms them. */
  const clustersOf = async (cases: CanonicalCase[]) => {
    const result = await runCases({ ...options(), cases });
    const divergences = result.cases.flatMap((c, i) =>
      c.candidates[0]!.comparison.verdict === 'diverge' ? [{ caseId: c.caseId, features: cases[i]!.features, shapes: c.candidates[0]!.shapes }] : [],
    );
    return clusterDivergences(divergences, featureWeights(cases)).map((k) => ({ key: k.key, cases: k.cases.map((id) => cases.find((c) => c.id === id)!) }));
  };

  it('minimizes each cluster from its smallest case, keeping the cluster signature', async () => {
    const cases = [
      await make(['-l'], 'one\ntwo\nthree', ['opt.l']),
      await make(['-l', '-v'], 'a long first line\nand more\nlast', ['opt.l', 'opt.v']),
      await make(['-l', '-x'], 'a\nb', ['error.usage']),
      await make(['-x'], 'one\ntwo\n', ['error.usage']),
    ];
    const [lines, usage] = await clustersOf(cases);
    expect(lines!.cases.map((c) => c.argv)).toEqual([['-l'], ['-l', '-v']]);
    expect(usage!.cases.map((c) => c.argv)).toEqual([['-l', '-x'], ['-x']]);

    const l = await minimizeCluster({ runner, key: lines!.key, cases: lines!.cases, store });
    expect(l).toMatchObject({ source: cases[0]!.id, reproduced: true, exhausted: false });
    expect(await text(l.case)).toEqual({ argv: [], stdin: 't' });

    // Without -x the exit codes agree and stdout diverges instead: another signature, so -x stays.
    const u = await minimizeCluster({ runner, key: usage!.key, cases: usage!.cases, store });
    expect(u).toMatchObject({ source: cases[2]!.id, reproduced: true });
    expect(await text(u.case)).toEqual({ argv: ['-x'], stdin: null });
  });

  it('counts one run per case tried, on the reference and the candidate', async () => {
    const cases = [await make(['-l'], 'x\ny')];
    const [k] = await clustersOf(cases);
    rmSync(log, { force: true });
    const result = await minimizeCluster({ runner, key: k!.key, cases: k!.cases, store });
    const lines = readFileSync(log, 'utf8').split('\n');
    expect(lines.filter((x) => x.startsWith('ref '))).toHaveLength(result.runs);
    expect(lines.filter((x) => x.startsWith('bad '))).toHaveLength(result.runs);
  });

  it('moves on to the next smallest case when one no longer diverges, within the same budget', async () => {
    const fine = await make(['-l'], 'ok\n');
    const diverging = await make(['-l'], 'one\ntwo');
    const [k] = await clustersOf([diverging]);
    const result = await minimizeCluster({ runner, key: k!.key, cases: [diverging, fine], store });
    expect(result).toMatchObject({ source: diverging.id, reproduced: true });
    expect(await text(result.case)).toEqual({ argv: [], stdin: 't' });

    const none = await minimizeCluster({ runner, key: k!.key, cases: [fine], store });
    expect(none).toMatchObject({ source: fine.id, reproduced: false, runs: 1, exhausted: false });
    expect(none.case.id).toBe(fine.id);

    const capped = await minimizeCluster({ runner, key: k!.key, cases: [fine, diverging], store, maxRuns: 4 });
    expect(capped).toMatchObject({ source: diverging.id, reproduced: true, runs: 4, exhausted: true });
    // When none diverges, the smallest stands for the cluster; out of budget when some were not tried.
    const allFine = [await make(['-l'], 'a longer line\n'), fine, await make(['-l'], 'no\n')];
    expect(await minimizeCluster({ runner, key: k!.key, cases: allFine, store })).toMatchObject({ source: fine.id, reproduced: false, runs: 3, exhausted: false });
    expect(await minimizeCluster({ runner, key: k!.key, cases: allFine, store, maxRuns: 2 })).toMatchObject({ source: fine.id, reproduced: false, runs: 2, exhausted: true });
  });
});
