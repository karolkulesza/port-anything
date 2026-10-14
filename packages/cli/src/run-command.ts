import { randomBytes } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  DEFAULT_STDERR_SIMILARITY,
  PROFILE_FIELDS,
  SandboxUnavailableError,
  cacheDir,
  chooseSandbox,
  clusterDivergences,
  configCandidates,
  describeFeatures,
  describeSignature,
  featureWeights,
  latestRun,
  loadCommittedCases,
  loadRun,
  normalizerLabel,
  openClusterCases,
  probeSandbox,
  readBaselineRecord,
  readConfigFile,
  resolveCluster,
  runCases,
  saveRun,
  shortCaseId,
  smokeSubset,
  stderrMode,
  type CanonicalCase,
  type CompareOptions,
  type Config,
  type ResolvedCluster,
  type RunRecord,
  type RunCasesOptions,
  type SandboxChoice,
  type SandboxProbe,
  type SavedCluster,
} from '@port-anything/core';
import { display, resolveCommand, type CliResult } from './common.js';

export { display } from './common.js';
export type { CliResult } from './common.js';

/** The options of `port-anything run` this version understands. */
export interface RunArgs {
  /** `--candidate <cmd>`, repeatable; replaces the configured candidates. */
  candidates: string[];
  /** `--cluster [<run-id>/]<n>`: re-run only that cluster's cases. */
  cluster?: string;
  /** `--smoke`: run only the smoke subset (see `smokeSubset`). */
  smoke?: boolean;
  json: boolean;
  noSandbox: boolean;
}

// Documented options that later versions add.
const NOT_YET = ['feature', 'all', 'holdout'];

const USAGE = 'Usage: port-anything run [--smoke | --cluster [<run-id>/]<n>] [--candidate <cmd>]… [--json] [--no-sandbox]';

/** Reads the arguments after `run`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const later = NOT_YET.find((name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)));
  if (later !== undefined) throw new ConfigError(`--${later} is not available yet in this version of port-anything run.`);
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        candidate: { type: 'string', multiple: true },
        cluster: { type: 'string' },
        smoke: { type: 'boolean' },
        json: { type: 'boolean' },
        'no-sandbox': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.smoke === true && values.cluster !== undefined) throw new Error('--smoke and --cluster run different subsets; give one of them.');
    return {
      candidates: values.candidate ?? [],
      ...(values.cluster === undefined ? {} : { cluster: values.cluster }),
      smoke: values.smoke ?? false,
      json: values.json ?? false,
      noSandbox: values['no-sandbox'] ?? false,
    };
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
}

/**
 * `port-anything run` in a project directory: reads `port-anything.yaml` and the committed cases
 * there, then runs them (see `executeRun`).
 */
export async function runCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  let prepared: ExecuteRunOptions;
  try {
    const args = parseRunArgs(argv);
    const config = await readConfigFile(options.cwd);
    const cases = await loadCommittedCases(options.cwd, new BlobStore(cacheDir(options.cwd)));
    prepared = { projectDir: options.cwd, config, cases, args, ...(options.probe === undefined ? {} : { probe: options.probe }) };
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }
  return executeRun(prepared);
}

export interface ExecuteRunOptions {
  /** Holds `.port-anything/`; relative program paths in the config start here. */
  projectDir: string;
  config: Config;
  /** Their stdin and fixtures must already be in the project's blob store. */
  cases: readonly CanonicalCase[];
  args: RunArgs;
  /** The sandbox probe's result; probed on this machine when absent. */
  probe?: SandboxProbe;
}

/**
 * Runs the cases against the reference and every candidate and reports, per candidate, which cases
 * diverge (under the strictness profile, after the configured normalizers), grouped into ranked
 * clusters, and how many cases each normalizer changed. The run is saved under a new run ID, so
 * its clusters can be addressed as `<run-id>/<n>`; with `--cluster`, only that cluster's cases run,
 * against its candidate unless `--candidate` is given; with `--smoke`, only the smoke subset: a
 * case for each cluster of the latest full run (its saved repro, or its smallest case), a few cases
 * per feature and a sample of the cases that passed. Exit code 0 when every candidate matches on
 * every case, 1 when any case diverges, 3 when the run can't start (config, programs, sandbox).
 */
export async function executeRun(options: ExecuteRunOptions): Promise<CliResult> {
  try {
    return await execute(options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything run: ${message}\n` });

async function execute({ projectDir, config, cases, args, probe }: ExecuteRunOptions): Promise<CliResult> {
  if (config.sandbox.mode === 'container') {
    throw new ConfigError('sandbox mode "container" is not available yet; set sandbox.mode to local.');
  }
  const subset = args.cluster === undefined ? undefined : await resolveCluster(projectDir, args.cluster);
  const commands =
    args.candidates.length > 0 ? args.candidates : subset !== undefined ? [subset.run.candidate_commands[subset.cluster.candidate - 1]!] : configCandidates(config).map((c) => c.cmd);
  if (commands.length === 0) {
    throw new ConfigError('No candidate to run: set candidate (or candidates) in port-anything.yaml, or pass --candidate <cmd>.');
  }
  if (cases.length === 0) throw new ConfigError('No cases to run: add some to port-anything/recorded/*.jsonl.');
  if (args.smoke === true && subset !== undefined) throw new ConfigError('--smoke and --cluster run different subsets; give one of them.');
  let smoke: { from: string | null; corpus: number; clusters: number; per_feature: number; passing: number } | undefined;
  if (subset !== undefined) cases = await clusterCases(projectDir, subset, cases);
  else if (args.smoke === true) {
    const latest = await latestRun(projectDir);
    const open = latest === undefined ? [] : await openClusterCases(projectDir, latest, cases, new BlobStore(cacheDir(projectDir)));
    const picked = smokeSubset({ corpus: cases, clusterCases: open, diverged: new Set(latest?.clusters.flatMap((c) => c.cases)) });
    smoke = { from: latest?.run_id ?? null, corpus: cases.length, clusters: picked.clusters, per_feature: picked.perFeature, passing: picked.passing };
    cases = picked.cases;
  }

  const { runner: runnerOptions, sandbox, compare } = await prepareSides(projectDir, config, commands, { noSandbox: args.noSandbox, ...(probe === undefined ? {} : { probe }) });
  // Cases whose reference output varied in the last baseline are left out of the comparison and listed.
  const flaky = new Map((await readBaselineRecord(projectDir))?.flaky_reference.map((f) => [f.case, f.fields]));
  const flakyReference = cases.filter((c) => flaky.has(c.id)).map((c) => ({ case: c.id, fields: flaky.get(c.id)! }));
  cases = cases.filter((c) => !flaky.has(c.id));
  const workDir = scratchDir(projectDir);
  let result;
  try {
    result = await runCases({ ...runnerOptions, cases, workDir });
  } finally {
    await removeScratch(projectDir, workDir);
  }

  // Per normalizer, the cases where it changed either side of a comparison (of any candidate, or of one).
  const changed = (candidate?: number) =>
    config.normalizers.map((spec, n) => ({
      normalizer: normalizerLabel(spec),
      cases: result.cases.filter((c) => c.candidates.some((run, i) => (candidate === undefined || i === candidate) && run.normalizedBy.includes(n))).length,
    }));
  // Each candidate's divergences in ranked clusters, numbered through the run, candidate by candidate.
  const weights = featureWeights(cases);
  const clusters: SavedCluster[] = [];
  for (const i of commands.keys()) {
    const divergences = result.cases.flatMap((c, n) => {
      const run = c.candidates[i]!;
      return run.comparison.verdict === 'diverge' ? [{ caseId: c.caseId, features: cases[n]!.features, shapes: run.shapes }] : [];
    });
    for (const cluster of clusterDivergences(divergences, weights)) {
      clusters.push({ cluster: clusters.length + 1, candidate: i + 1, signature: cluster.signature, features: cluster.features, size: cluster.cases.length, weight: cluster.weight, cases: cluster.cases });
    }
  }
  const report = {
    program_name: result.programName,
    sandbox: sandbox.label,
    reference: display(config.reference.cmd),
    compare: describeCompare(compare),
    cases: result.cases.length,
    flaky_reference: flakyReference,
    normalizers: changed(),
    candidates: commands.map((command, i) => {
      const divergences = result.cases
        .filter((c) => c.candidates[i]!.comparison.verdict === 'diverge')
        .map((c) => ({ case: c.caseId, fields: c.candidates[i]!.comparison.fields }));
      return { command: display(command), match: result.cases.length - divergences.length, diverge: divergences.length, normalizers: changed(i), divergences };
    }),
    clusters,
  };
  const saved = await saveRun(projectDir, { subset: subset !== undefined ? { cluster: subset.address } : smoke !== undefined ? { smoke } : null, ...report, candidate_commands: commands });
  const summary = { run_id: saved.run_id, subset: saved.subset, ...report };
  const exitCode = summary.candidates.some((c) => c.diverge > 0) ? 1 : 0;
  if (args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };

  const lines = [
    `Ran ${summary.cases} case${summary.cases === 1 ? '' : 's'} as "${summary.program_name}", sandbox: ${summary.sandbox}`,
    `run ${summary.run_id}${describeSubset(summary.subset)}`,
    `reference ${summary.reference}`,
    `compare ${compareLabel(summary.compare)}`,
  ];
  if (flakyReference.length > 0) {
    lines.push(`flaky-reference, left out (the reference varied in port-anything baseline): ${flakyReference.length}`);
    for (const f of flakyReference) lines.push(`  ${shortCaseId(f.case)}  ${f.fields.join(', ')}`);
  }
  if (summary.normalizers.length === 0) lines.push('normalizers: none');
  else {
    lines.push('normalizers (cases changed):');
    for (const n of summary.normalizers) lines.push(`  ${n.normalizer}: ${n.cases}`);
  }
  for (const [i, c] of summary.candidates.entries()) {
    lines.push(`candidate ${i + 1} ${c.command}: ${c.match} of ${summary.cases} cases match${c.diverge > 0 ? `, ${c.diverge} diverge` : ''}`);
    for (const cluster of clusters.filter((k) => k.candidate === i + 1)) {
      lines.push(`  cluster ${cluster.cluster}: ${cluster.size} case${cluster.size === 1 ? '' : 's'} · ${describeSignature(cluster.signature)} · features ${describeFeatures(cluster.features)}`);
      const listed = cluster.cases.slice(0, LISTED_CASES).map((id) => shortCaseId(id));
      lines.push(`    ${listed.join('  ')}${cluster.size > LISTED_CASES ? `  … and ${cluster.size - LISTED_CASES} more` : ''}`);
    }
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** What running cases needs besides the cases and a scratch directory, from the config. */
export async function prepareSides(
  projectDir: string,
  config: Config,
  commands: readonly (string | readonly string[])[],
  options: { noSandbox: boolean; probe?: SandboxProbe },
): Promise<{ runner: Omit<RunCasesOptions, 'cases' | 'workDir'>; sandbox: SandboxChoice; compare: CompareOptions }> {
  const reference = await resolveCommand(config.reference.cmd, projectDir);
  const candidates = await Promise.all(commands.map((cmd) => resolveCommand(cmd, projectDir)));
  const sandbox = chooseSandbox(options.probe ?? (await probeSandbox()), { noSandbox: options.noSandbox });
  const compare: CompareOptions = { profile: config.compare.profile, stderr: config.compare.fields.stderr };
  const runner = {
    reference,
    candidates,
    store: new BlobStore(cacheDir(projectDir)),
    sandbox,
    ...(config.program_name === undefined ? {} : { programName: config.program_name }),
    timeoutMs: config.sandbox.timeout,
    envAllowlist: config.sandbox.env_allowlist,
    env: config.sandbox.env,
    normalizers: config.normalizers,
    compare,
  };
  return { runner, sandbox, compare };
}

/** A new scratch directory for a run, inside the project rather than /tmp, which may be mounted noexec. */
export function scratchDir(projectDir: string): string {
  return join(projectDir, '.port-anything', 'tmp', `run-${randomBytes(6).toString('hex')}`);
}

export async function removeScratch(projectDir: string, workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await rmdir(join(projectDir, '.port-anything', 'tmp')).catch(() => {}); // kept while another run uses it
}

/** What part of the corpus a run ran, for its second line of text output. */
function describeSubset(subset: RunRecord['subset']): string {
  if (subset === null) return '';
  if ('cluster' in subset) return `, cluster ${subset.cluster} only`;
  const { from, corpus, clusters, per_feature: perFeature, passing } = subset.smoke;
  const open = from === null ? 'no full run yet' : `${clusters} for the open clusters of run ${from}`;
  return `, smoke subset of ${corpus} case${corpus === 1 ? '' : 's'}: ${open}, ${perFeature} by feature, ${passing} passing`;
}

/** Case IDs shown per cluster in the text output; `--json` lists them all. */
const LISTED_CASES = 5;

/**
 * The cases of a cluster, in its order; it is an error when the corpus no longer has them all. A
 * cluster of a smoke run may also have the repros its smoke subset took from the open clusters of
 * an earlier run; their content goes to the project's blob store.
 */
export async function clusterCases(projectDir: string, subset: ResolvedCluster, cases: readonly CanonicalCase[]): Promise<CanonicalCase[]> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const from = subset.run.subset !== null && 'smoke' in subset.run.subset ? subset.run.subset.smoke.from : null;
  if (from !== null && subset.cluster.cases.some((id) => !byId.has(id))) {
    let earlier: RunRecord | undefined;
    try {
      earlier = await loadRun(projectDir, from);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
    }
    if (earlier !== undefined) {
      for (const c of await openClusterCases(projectDir, earlier, cases, new BlobStore(cacheDir(projectDir)))) if (!byId.has(c.id)) byId.set(c.id, c);
    }
  }
  const missing = subset.cluster.cases.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ConfigError(
      `Cluster ${subset.address} has ${missing.length} case${missing.length === 1 ? '' : 's'} that the corpus no longer has (${missing.map((id) => shortCaseId(id)).join(', ')}); run the whole corpus for new clusters.`,
    );
  }
  return subset.cluster.cases.map((id) => byId.get(id)!);
}

/** The profile a run compared under, with how it compared stderr (absent when the profile ignores stderr). */
export function describeCompare(options: CompareOptions): { profile: string; stderr?: { mode: string; similarity?: number } } {
  if (!PROFILE_FIELDS[options.profile].includes('stderr')) return { profile: options.profile };
  const mode = stderrMode(options);
  return { profile: options.profile, stderr: mode === 'loose' ? { mode, similarity: options.stderr?.similarity ?? DEFAULT_STDERR_SIMILARITY } : { mode } };
}

export function compareLabel(c: ReturnType<typeof describeCompare>): string {
  if (c.stderr === undefined) return `${c.profile} (stderr ignored)`;
  return `${c.profile} (stderr ${c.stderr.mode}${c.stderr.similarity === undefined ? '' : `, similarity ${c.stderr.similarity}`})`;
}
