import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  BlobStore,
  ConfigError,
  cacheDir,
  caseEnvironment,
  describeSignature,
  environmentFingerprint,
  fingerprintDifferences,
  latestRun,
  loadRepro,
  openCaseRunner,
  openClusterCases,
  readConfigFile,
  readManifest,
  readWaiversFile,
  runsAfter,
  shortCaseId,
  type CaseRun,
  type Observation,
  type RunRecord,
  type SandboxProbe,
  type SavedCluster,
} from '@port-anything/core';
import { createServer, type Backend, type CandidateDelta, type ClusterSummary, type FieldDiff, type NextReport, type RunDelta, type RunSelection, type StatusReport } from '@port-anything/mcp';
import { resolveCommand, type CliResult } from './common.js';
import { loadCorpus } from './corpus.js';
import { minimizeCommand } from './minimize-command.js';
import { compareLabel, performRun, prepareSides, removeScratch, scratchDir, type RunArgs, type RunSummary } from './run-command.js';
import { TOOL_VERSION } from './version.js';

export const USAGE = 'Usage: port-anything mcp';

/**
 * `port-anything mcp`: the MCP server for the project in the current directory, over stdio, until
 * the client closes it. Exit 0 then, 3 for unexpected arguments.
 */
export async function mcpCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe; stdin?: Readable; stdout?: Writable }): Promise<CliResult> {
  if (argv.length > 0) return { exitCode: 3, stdout: '', stderr: `port-anything mcp: unexpected argument "${argv[0]}"; it takes none.\n${USAGE}\n` };
  const server = createServer(projectBackend(options.cwd, options.probe === undefined ? {} : { probe: options.probe }), { version: TOOL_VERSION });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport(options.stdin, options.stdout));
  await closed;
  return { exitCode: 0, stdout: '', stderr: '' };
}

/** What `run` saves beyond what addressing clusters needs (see `executeRun`). */
type SavedRun = RunRecord & Pick<RunSummary, 'program_name' | 'sandbox' | 'compare' | 'cases' | 'normalizers' | 'waivers' | 'flaky_reference' | 'candidates'>;

/** A run with what `status` and `next` show; a run saved by an older version lacks some of it. */
function savedRun(run: RunRecord): SavedRun {
  const keys = ['program_name', 'sandbox', 'compare', 'cases', 'normalizers', 'waivers', 'flaky_reference', 'candidates'] as const;
  const saved = run as Partial<SavedRun>;
  if (keys.some((key) => saved[key] === undefined) || saved.candidates!.some((c) => c.score === undefined || c.divergences === undefined)) {
    throw new ConfigError(`Run ${run.run_id} was saved by an older version of port-anything; run port-anything run again.`);
  }
  return run as SavedRun;
}

const summary = (run: string, k: SavedCluster): ClusterSummary => ({
  run,
  cluster: k.cluster,
  candidate: k.candidate,
  size: k.size,
  description: describeSignature(k.signature),
  features: k.features,
});

/**
 * The clusters of a run of the whole corpus still open: all but those whose latest re-run (a run
 * of exactly that cluster, later on) found its candidate no longer diverging. In the run's order,
 * which ranks each candidate's clusters, highest priority first.
 */
async function openClusters(projectDir: string, run: SavedRun): Promise<SavedCluster[]> {
  const fixed = new Set<number>();
  for (const later of await runsAfter(projectDir, run)) {
    const subset = later.subset;
    if (subset === null || !('cluster' in subset) || !subset.cluster.startsWith(`${run.run_id}/`)) continue;
    const k = run.clusters[Number(subset.cluster.slice(run.run_id.length + 1)) - 1];
    if (k === undefined) continue;
    const command = run.candidates[k.candidate - 1]?.command;
    const rerun = (later as Partial<SavedRun>).candidates?.find((c) => c.command === command);
    if (rerun === undefined) continue;
    if (rerun.diverge === 0) fixed.add(k.cluster);
    else fixed.delete(k.cluster);
  }
  return run.clusters.filter((k) => !fixed.has(k.cluster));
}

/** A field of an observation, as text for a diff. */
async function fieldText(o: Observation, field: FieldDiff['field'], store: BlobStore): Promise<string> {
  switch (field) {
    case 'exit':
      return o.exit === null ? 'none (signal)' : String(o.exit);
    case 'signal':
      return o.signal ?? 'none';
    case 'timeout':
      return o.timeout ? 'timed out' : 'finished';
    case 'stdout':
    case 'stderr': {
      const bytes = await store.get(o[field]);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return `<${bytes.length} bytes, not UTF-8, sha256 ${o[field].slice('sha256:'.length, 'sha256:'.length + 12)}>`;
      }
    }
    case 'fs': {
      const hash = (ref: string) => ref.slice('sha256:'.length, 'sha256:'.length + 12);
      const lines = [
        ...Object.entries(o.fs.created).map(([path, ref]) => `created ${path} ${hash(ref)}`),
        ...Object.entries(o.fs.modified).map(([path, ref]) => `modified ${path} ${hash(ref)}`),
        ...o.fs.deleted.map((path) => `deleted ${path}`),
      ];
      return `${lines.sort().join('\n')}\n`;
    }
  }
}

/** The diverging fields of a candidate's run of a case, both sides after the normalizers. */
async function fieldDiffs(run: CaseRun, store: BlobStore): Promise<FieldDiff[]> {
  const c = run.candidates[0]!;
  if (c.comparison.verdict === 'match') return [];
  return Promise.all(
    c.comparison.fields.map(async (field) => ({ field, reference: await fieldText(c.normalized.reference, field, store), candidate: await fieldText(c.normalized.candidate, field, store) })),
  );
}

/** The cases that diverged for a candidate in a run: steady and flaky-candidate ones. */
const diverging = (c: RunSummary['candidates'][number]) => new Set([...c.divergences.map((d) => d.case), ...c.flaky_candidate.map((d) => d.case)]);

/** Broken cases `run` names per candidate. */
const NAMED_BROKEN = 5;

/**
 * The MCP tools over the project in `projectDir`, running programs in the sandbox `probe` finds
 * (probed when absent); `noSandbox` runs them unsandboxed, for tests.
 */
export function projectBackend(projectDir: string, options: { probe?: SandboxProbe; noSandbox?: boolean } = {}): Backend {
  const noSandbox = options.noSandbox ?? false;
  const probe = options.probe === undefined ? {} : { probe: options.probe };
  const regenerate = { noSandbox, ...probe };

  async function status(): Promise<StatusReport> {
    const latest = await latestRun(projectDir);
    const manifest = await readManifest(projectDir);
    let environment: NonNullable<StatusReport['integrity']['manifest']>['environment'] = 'unknown';
    if (manifest !== undefined) {
      try {
        const config = await readConfigFile(projectDir);
        const reference = await resolveCommand(config.reference.cmd, projectDir);
        const caseEnv = caseEnvironment({ home: projectDir, allowlist: config.sandbox.env_allowlist, env: config.sandbox.env });
        const differs = fingerprintDifferences(manifest.fingerprint, await environmentFingerprint({ reference, caseEnv }));
        environment = differs.length === 0 ? 'same' : { differs };
      } catch {
        // No config or reference to fingerprint here: unknown.
      }
    }
    const frozen = manifest === undefined ? null : { cases: manifest.cases.length, environment };
    if (latest === undefined) {
      return { run: null, candidates: [], clusters: { total: 0, open: 0, top: [] }, integrity: { manifest: frozen, flakyReference: 0, waivers: 0, largeWaivers: 0, normalizers: [] } };
    }
    const run = savedRun(latest);
    const open = await openClusters(projectDir, run);
    return {
      run: { id: run.run_id, created: run.created, cases: run.cases, programName: run.program_name, sandbox: run.sandbox, compare: compareLabel(run.compare) },
      candidates: run.candidates.map((c, i) => ({
        candidate: i + 1,
        command: c.command,
        parity: c.score.headline,
        features: c.score.headlineFeatures.length,
        match: c.match,
        diverge: c.diverge,
        waived: c.waived,
      })),
      clusters: { total: run.clusters.length, open: open.length, top: open.slice(0, 5).map((k) => summary(run.run_id, k)) },
      integrity: {
        manifest: frozen,
        flakyReference: run.flaky_reference.length,
        waivers: run.waivers.length,
        largeWaivers: run.waivers.filter((_, n) => run.candidates.some((c) => c.waivers[n]?.large === true)).length,
        normalizers: run.normalizers,
      },
    };
  }

  async function next(): Promise<NextReport> {
    const latest = await latestRun(projectDir);
    if (latest === undefined) return { kind: 'no-run' };
    const run = savedRun(latest);
    const open = await openClusters(projectDir, run);
    const k = open[0];
    if (k === undefined) return { kind: 'none-open', run: run.run_id, total: run.clusters.length };
    const address = `${run.run_id}/${k.cluster}`;
    let repro = await loadRepro(projectDir, run.run_id, k.cluster);
    if (repro === undefined) {
      const minimized = await minimizeCommand([address, '--json', ...(noSandbox ? ['--no-sandbox'] : [])], { cwd: projectDir, ...probe });
      if (minimized.exitCode === 3) throw new Error(minimized.stderr.trim());
      repro = await loadRepro(projectDir, run.run_id, k.cluster);
      if (repro === undefined) throw new Error(`Minimizing cluster ${address} saved no repro.`);
    }
    // The repro, run once more on the reference and the cluster's candidate, for the diff.
    const config = await readConfigFile(projectDir);
    const store = new BlobStore(cacheDir(projectDir));
    const corpus = await loadCorpus(projectDir, config, regenerate);
    const [reproCase] = await openClusterCases(projectDir, { ...run, clusters: [k] }, corpus, store);
    if (reproCase === undefined) throw new Error(`Cluster ${address} has no case to show.`);
    const command = run.candidate_commands[k.candidate - 1]!;
    const { runner: runnerOptions } = await prepareSides(projectDir, config, [command], regenerate);
    const workDir = scratchDir(projectDir);
    let programName: string;
    let observed: CaseRun;
    try {
      const runner = await openCaseRunner({ ...runnerOptions, workDir, rerun: false });
      programName = runner.programName;
      observed = await runner.run(reproCase);
    } finally {
      await removeScratch(projectDir, workDir);
    }
    return {
      kind: 'cluster',
      cluster: summary(run.run_id, k),
      open: open.length,
      programName,
      repro: { ...repro.case, source: shortCaseId(repro.source), minimized: repro.reproduced, exhausted: repro.exhausted },
      diff: await fieldDiffs(observed, store),
    };
  }

  async function run(selection: RunSelection): Promise<RunDelta> {
    const baseline = await latestRun(projectDir);
    const config = await readConfigFile(projectDir);
    const cases = await loadCorpus(projectDir, config, regenerate);
    const waivers = await readWaiversFile(projectDir);
    const args: RunArgs = {
      candidates: [],
      json: true,
      noSandbox,
      ...('smoke' in selection ? { smoke: true } : 'cluster' in selection ? { cluster: selection.cluster } : 'feature' in selection ? { feature: selection.feature } : { caseIds: selection.cases }),
    };
    const { summary: done, ran } = await performRun({ projectDir, config, cases, waivers, args, ...probe });
    const before = baseline === undefined ? undefined : (baseline as Partial<SavedRun>);
    const candidates = done.candidates.map((c, i): CandidateDelta => {
      const base = before?.candidates?.find((b) => b.command === c.command && b.divergences !== undefined);
      const now = diverging(c);
      const counts = { candidate: i + 1, command: c.command, match: c.match, diverge: c.diverge, waived: c.waived };
      if (base === undefined) return { ...counts, fixed: null, broke: null, brokeCases: [] };
      const was = diverging(base);
      const broke = [...now].filter((id) => !was.has(id));
      return { ...counts, fixed: ran.filter((id) => was.has(id) && !now.has(id)).length, broke: broke.length, brokeCases: broke.slice(0, NAMED_BROKEN).map((id) => shortCaseId(id)) };
    });
    const subset = done.subset;
    const selected =
      subset === null
        ? 'the whole corpus'
        : 'cluster' in subset
          ? `cluster ${subset.cluster}`
          : 'feature' in subset
            ? `feature ${subset.feature}`
            : 'cases' in subset
              ? `${subset.cases.length === 1 ? '1 given case' : `${subset.cases.length} given cases`}`
              : `smoke subset of a ${subset.smoke.corpus}-case corpus`;
    return {
      run: done.run_id,
      selection: selected,
      cases: done.cases,
      baseline: candidates.some((c) => c.fixed !== null) ? baseline!.run_id : null,
      flakyReference: done.flaky_reference.length,
      candidates,
      clusters: { total: done.clusters.length, top: done.clusters.map((k) => summary(done.run_id, k)) },
    };
  }

  return { status, next, run };
}
