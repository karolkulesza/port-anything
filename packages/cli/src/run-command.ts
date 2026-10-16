import { randomBytes } from 'node:crypto';
import { realpath, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  DEFAULT_STDERR_SIMILARITY,
  LARGE_WAIVER_SHARE,
  PROFILE_FIELDS,
  SandboxUnavailableError,
  appendHistory,
  WAIVERS_FILE,
  cacheDir,
  chooseSandbox,
  clusterDivergences,
  configCandidates,
  describeFeatures,
  describeSignature,
  describeWaiver,
  featureWeights,
  gitHead,
  latestRun,
  loadCommittedCases,
  measureSlowdown,
  matchWaivers,
  loadRun,
  normalizerLabel,
  openClusterCases,
  probeSandbox,
  readBaselineRecord,
  readConfigFile,
  readWaiversFile,
  resolveCluster,
  runCases,
  saveRun,
  scoreCandidate,
  shortCaseId,
  smokeSubset,
  stderrMode,
  waiverCoverage,
  type CanonicalCase,
  type CaseRun,
  type CompareOptions,
  type Config,
  type ResolvedCluster,
  type ResolvedProgram,
  type RunRecord,
  type RunCasesOptions,
  type SandboxChoice,
  type SandboxProbe,
  type SavedCluster,
  type Score,
  type Slowdown,
  type Waiver,
  type WaiverCoverage,
  type WaiverMatch,
} from '@port-anything/core';
import { display, prepareContainer, resolveCommand, type CliResult } from './common.js';

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
 * `port-anything run` in a project directory: reads `port-anything.yaml`, the committed cases and
 * `port-anything/waivers.yaml` there, then runs the cases (see `executeRun`).
 */
export async function runCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  let prepared: ExecuteRunOptions;
  try {
    const args = parseRunArgs(argv);
    const config = await readConfigFile(options.cwd);
    const cases = await loadCommittedCases(options.cwd, new BlobStore(cacheDir(options.cwd)));
    const waivers = await readWaiversFile(options.cwd);
    prepared = { projectDir: options.cwd, config, cases, waivers, args, ...(options.probe === undefined ? {} : { probe: options.probe }) };
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
  /** From `port-anything/waivers.yaml`; none when absent. */
  waivers?: readonly Waiver[];
  args: RunArgs;
  /** The sandbox probe's result; probed on this machine when absent. */
  probe?: SandboxProbe;
}

/**
 * Runs the cases against the reference and every candidate and reports, per candidate, which cases
 * diverge (under the strictness profile, after the configured normalizers), grouped into ranked
 * clusters, and how many cases each normalizer changed and each waiver covers. A waiver covers
 * diverging fields: a case whose diverging fields are all covered is waived (left out of the score
 * and the clusters, exit code 0), and the fields it covers are left out of a case that still diverges.
 * Flaky-candidate cases (a re-run gave a different result) still count as diverging, but are listed
 * apart rather than clustered. The run is saved under a new run ID, so
 * its clusters can be addressed as `<run-id>/<n>`; with `--cluster`, only that cluster's cases run,
 * against its candidate unless `--candidate` is given; with `--smoke`, only the smoke subset: a
 * case for each cluster of the latest full run (its saved repro, or its smallest case), a few cases
 * per feature and a sample of the cases that passed. A run of the whole corpus is also appended
 * to the parity history, with the commit checked out where each candidate comes from (see
 * `candidateSource`). With `compare.max_slowdown` set, each candidate's median time ratio is
 * checked against it. Exit code 0 when every candidate matches on every case (and is within the
 * slowdown limit), 1 when any case diverges or a candidate is too slow, 3 when the run can't start
 * (config, programs, sandbox).
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

async function execute({ projectDir, config, cases, waivers = [], args, probe }: ExecuteRunOptions): Promise<CliResult> {
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
  const { store } = runnerOptions;
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
  // Per candidate and case, the waivers covering its diverging fields; undefined for a match. A
  // candidate that timed out where the reference finished diverges, and no waiver covers that.
  const regexes = waivers.some((w) => w.match.regex !== undefined);
  const timedOut = (c: CaseRun, i: number) => c.candidates[i]!.observation.timeout && !c.reference.timeout;
  const waived: (WaiverMatch | undefined)[][] = [];
  for (const i of commands.keys()) {
    waived.push(
      await Promise.all(
        result.cases.map(async (c, n) => {
          const run = c.candidates[i]!;
          if (run.comparison.verdict === 'match') return undefined;
          if (timedOut(c, i)) return { fields: run.shapes.map(() => []), waived: false, remaining: run.shapes };
          const text = async (field: 'stdout' | 'stderr') => (await store.get(run.normalized.reference[field])).toString('utf8');
          const reference = regexes ? { stdout: await text('stdout'), stderr: await text('stderr') } : {};
          return matchWaivers({ features: cases[n]!.features, shapes: run.shapes, reference }, waivers);
        }),
      ),
    );
  }
  // Each candidate's divergences in ranked clusters, numbered through the run, candidate by candidate;
  // a waived case is left out, and a case that still diverges is clustered on the fields no waiver covers.
  const weights = featureWeights(cases);
  const clusters: SavedCluster[] = [];
  for (const i of commands.keys()) {
    const divergences = result.cases.flatMap((c, n) => {
      const run = c.candidates[i]!;
      const m = waived[i]![n];
      return m === undefined || m.waived || run.flaky ? [] : [{ caseId: c.caseId, features: cases[n]!.features, shapes: m.remaining }];
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
    waivers,
    candidates: commands.map((command, i) => {
      const matches = waived[i]!;
      const fieldsOf = (n: number, covered: boolean) => result.cases[n]!.candidates[i]!.shapes.filter((_, f) => (matches[n]!.fields[f]!.length > 0) === covered).map((x) => x.field);
      const divergences = result.cases.flatMap((c, n) => {
        const m = matches[n];
        if (m === undefined || m.waived || c.candidates[i]!.flaky) return [];
        const partly = fieldsOf(n, true);
        return [{ case: c.caseId, fields: fieldsOf(n, false), ...(partly.length === 0 ? {} : { waived_fields: partly }) }];
      });
      const waivedCases = result.cases.flatMap((c, n) => {
        const m = matches[n];
        return m?.waived === true ? [{ case: c.caseId, waivers: [...new Set(m.fields.flat())].sort((a, b) => a - b).map((w) => w + 1) }] : [];
      });
      // Flaky-candidate cases count as diverging but are listed apart from the steady divergences.
      const flakyCandidate = result.cases.flatMap((c, n) => {
        const m = matches[n];
        return m === undefined || m.waived || !c.candidates[i]!.flaky ? [] : [{ case: c.caseId, fields: c.candidates[i]!.comparison.fields }];
      });
      // Scored on the re-run, whose first run timed out where the reference finished: listed, never silent.
      const timeoutRecovered = result.cases.filter((c) => c.candidates[i]!.timeoutRecovered).map((c) => ({ case: c.caseId }));
      const score = scoreCandidate(
        result.cases.map((c, n) => ({
          caseId: c.caseId,
          features: cases[n]!.features,
          origin: cases[n]!.origin,
          verdict: c.candidates[i]!.comparison.verdict,
          waived: matches[n]?.waived === true,
          flakyCandidate: c.candidates[i]!.flaky,
          // A case the reference also times out on is compared like any other.
          candidateTimeout: timedOut(c, i),
          timeoutRecovered: c.candidates[i]!.timeoutRecovered,
        })),
        config.corpus?.min_cases_per_feature === undefined ? {} : { minCasesPerFeature: config.corpus.min_cases_per_feature },
      );
      const max = config.compare.max_slowdown;
      const slowdown =
        max === undefined
          ? undefined
          : measureSlowdown(
              result.cases.map((c) => {
                const { observation } = c.candidates[i]!;
                return { reference: { wall: c.reference.time_ms.wall, timeout: c.reference.timeout }, candidate: { wall: observation.time_ms.wall, timeout: observation.timeout } };
              }),
              max,
            );
      return {
        command: display(command),
        match: result.cases.length - divergences.length - flakyCandidate.length - waivedCases.length,
        diverge: divergences.length + flakyCandidate.length,
        waived: waivedCases.length,
        score,
        ...(slowdown === undefined ? {} : { slowdown }),
        normalizers: changed(i),
        waivers: waiverCoverage(waivers, matches.filter((m) => m !== undefined), result.cases.length),
        divergences,
        flaky_candidate: flakyCandidate,
        timeout_recovered: timeoutRecovered,
        waived_cases: waivedCases,
      };
    }),
    clusters,
  };
  const saved = await saveRun(projectDir, { subset: subset !== undefined ? { cluster: subset.address } : smoke !== undefined ? { smoke } : null, ...report, candidate_commands: commands });
  if (subset === undefined && smoke === undefined) {
    const shas = await Promise.all(
      runnerOptions.candidates.map(async (c) => {
        const dir = await candidateSource(c, projectDir);
        return dir === undefined ? null : gitHead(dir);
      }),
    );
    await appendHistory(projectDir, {
      version: 1,
      run_id: saved.run_id,
      created: saved.created,
      cases: report.cases,
      candidates: commands.map((command, i) => {
        const { score } = report.candidates[i]!;
        return { command, sha: shas[i]!, parity: score.headline, features: score.headlineFeatures.length, scored: score.raw.scored, match: score.raw.match };
      }),
    });
  }
  const summary = { run_id: saved.run_id, subset: saved.subset, ...report };
  const exitCode = summary.candidates.some((c) => c.diverge > 0 || c.slowdown?.exceeded === true) ? 1 : 0;
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
  if (summary.waivers.length > 0) {
    lines.push(`waivers (${WAIVERS_FILE}):`);
    for (const [n, w] of summary.waivers.entries()) lines.push(`  ${n + 1}. ${describeWaiver(w)}: ${w.reason}`);
  }
  for (const [i, c] of summary.candidates.entries()) {
    const flaky = c.flaky_candidate.length > 0 ? ` (${c.flaky_candidate.length} flaky-candidate)` : '';
    lines.push(`candidate ${i + 1} ${c.command}: ${c.match} of ${summary.cases} cases match${c.diverge > 0 ? `, ${c.diverge} diverge${flaky}` : ''}${c.waived > 0 ? `, ${c.waived} waived` : ''}`);
    lines.push(...scoreLines(c.score));
    if (c.slowdown !== undefined) lines.push(slowdownLine(c.slowdown));
    if (c.waivers.length > 0) lines.push(`  waivers (cases covered): ${c.waivers.map(coverageLabel).join(', ')}`);
    for (const cluster of clusters.filter((k) => k.candidate === i + 1)) {
      lines.push(`  cluster ${cluster.cluster}: ${cluster.size} case${cluster.size === 1 ? '' : 's'} · ${describeSignature(cluster.signature)} · features ${describeFeatures(cluster.features)}`);
      const listed = cluster.cases.slice(0, LISTED_CASES).map((id) => shortCaseId(id));
      lines.push(`    ${listed.join('  ')}${cluster.size > LISTED_CASES ? `  … and ${cluster.size - LISTED_CASES} more` : ''}`);
    }
    if (flaky !== '') lines.push('  flaky-candidate, a re-run gave a different result:');
    for (const d of c.flaky_candidate) lines.push(`    ${shortCaseId(d.case)}  ${d.fields.join(', ')}`);
    if (c.timeout_recovered.length > 0) lines.push('  timeout, recovered on re-run (the re-run was compared):');
    for (const d of c.timeout_recovered) lines.push(`    ${shortCaseId(d.case)}`);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/**
 * What running cases needs besides the cases and a scratch directory, from the config. In sandbox
 * mode `container`, the reference's and the configured candidates' builds run in the image first.
 */
export async function prepareSides(
  projectDir: string,
  config: Config,
  commands: readonly (string | readonly string[])[],
  options: { noSandbox: boolean; probe?: SandboxProbe },
): Promise<{ runner: Omit<RunCasesOptions, 'cases' | 'workDir'>; sandbox: SandboxChoice; compare: CompareOptions }> {
  // In container mode the builds come first: they make the programs.
  const sandbox =
    config.sandbox.mode === 'container'
      ? await prepareContainer(projectDir, config, commands, options)
      : chooseSandbox(options.probe ?? (await probeSandbox()), { noSandbox: options.noSandbox });
  const reference = await resolveCommand(config.reference.cmd, projectDir);
  const candidates = await Promise.all(commands.map((cmd) => resolveCommand(cmd, projectDir)));
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

/**
 * The directory whose git commit a candidate's history line records: the executable's, when the
 * command gives it as a path; for a name looked up on the PATH (an interpreter such as `node` or
 * `python3`, whose install may sit in a git repository of its own), the first argument that is an
 * existing file, such as the script. Undefined when there is neither, so no commit is recorded.
 */
async function candidateSource(program: ResolvedProgram, projectDir: string): Promise<string | undefined> {
  if (program.executable.includes('/')) return dirname(program.realPath);
  for (const arg of program.args) {
    try {
      const path = await realpath(resolvePath(projectDir, arg));
      if ((await stat(path)).isFile()) return dirname(path);
    } catch {
      // not a file
    }
  }
  return undefined;
}

/**
 * A candidate's parity: the headline (mean of per-feature parity), parity per origin, the cases
 * left out or counted as divergences, and the features reported outside the headline.
 */
function scoreLines(score: Score): string[] {
  const features = score.headlineFeatures.length;
  const lines = [
    score.headline === null
      ? `  parity n/a: no feature outside self-description has ${score.minCasesPerFeature} scored case${score.minCasesPerFeature === 1 ? '' : 's'} (corpus.min_cases_per_feature)`
      : `  parity ${percent(score.headline)}, mean of ${features} feature${features === 1 ? '' : 's'} (${score.raw.match} of ${score.raw.scored} scored cases match)`,
  ];
  const origins = Object.entries(score.origins).filter(([, o]) => o.cases > 0);
  if (origins.length > 1) lines.push(`  by origin: ${origins.map(([name, o]) => `${name} ${o.parity === null ? 'n/a' : percent(o.parity)} (${count(o.cases, 'case')})`).join(', ')}`);
  const { waived, flakyReference, flakyCandidate, timeouts, timeoutRecovered } = score.raw;
  const excluded = [
    [waived, 'waived (not scored)'],
    [flakyReference, 'flaky-reference (not scored)'],
    [flakyCandidate, 'flaky-candidate (diverge)'],
    [timeouts, 'timed out (diverge)'],
    [timeoutRecovered, 'timeout, recovered on re-run'],
  ] as const;
  if (excluded.some(([n]) => n > 0)) lines.push(`  ${excluded.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(' · ')}`);
  const list = (names: readonly string[]) =>
    names
      .map((name) => score.features.find((f) => f.feature === name)!)
      .map((f) => `${f.feature} ${f.parity === null ? 'n/a' : percent(f.parity)} (${count(f.scored, 'case')})`)
      .join(', ');
  if (score.underSampled.length > 0) lines.push(`  under-sampled, not in the parity: ${list(score.underSampled)}`);
  if (score.selfDescription.length > 0) lines.push(`  self-description, not in the parity: ${list(score.selfDescription)}`);
  if (score.untested.length > 0) lines.push(`  untested: ${score.untested.join(', ')}`);
  return lines;
}

/** A candidate's median time ratio against `compare.max_slowdown`. */
function slowdownLine({ ratio, cases, max, exceeded }: Slowdown): string {
  const limit = `compare.max_slowdown ${max}x`;
  if (ratio === null) return `  slowdown n/a: no case the reference finished in a measurable time (${limit})`;
  return `  slowdown ${ratio.toFixed(2)}x (median of ${count(cases, 'case')}), ${exceeded ? 'above' : 'within'} ${limit}`;
}

/** A waiver's coverage, such as `2: 3 (15.0%, more than 10% of the cases)`. */
function coverageLabel(w: WaiverCoverage): string {
  if (w.cases === 0) return `${w.waiver}: 0`;
  return `${w.waiver}: ${w.cases} (${percent(w.share)}${w.large ? `, more than ${LARGE_WAIVER_SHARE * 100}% of the cases` : ''})`;
}

/** Rounded down, so that only a full match shows as 100.0%. */
const percent = (p: number) => `${(Math.floor(p * 1000 + 1e-9) / 10).toFixed(1)}%`;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

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
