import { randomBytes } from 'node:crypto';
import { realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  CLI_SPEC_FILE,
  CaseIdError,
  ConfigError,
  DEFAULT_STDERR_SIMILARITY,
  LARGE_WAIVER_SHARE,
  MIN_GAP_CASES,
  PROFILE_FIELDS,
  SandboxUnavailableError,
  appendHistory,
  WAIVERS_FILE,
  cacheDir,
  chooseSandbox,
  clusterDivergences,
  configCandidates,
  DEFAULT_GENERATOR,
  describeFeatures,
  describeSignature,
  describeWaiver,
  featureWeights,
  caseOutcome,
  freshHoldoutSeed,
  gapCluster,
  generateArgvCases,
  generateFreshHoldout,
  generatedCorpusSettings,
  gitHead,
  holdoutGap,
  holdoutParity,
  holdoutSettings,
  inlineCase,
  latestRun,
  measureSlowdown,
  matchWaivers,
  loadRun,
  normalizerLabel,
  openClusterCases,
  probeSandbox,
  readBaselineRecord,
  readCliSpecFile,
  readConfigFile,
  readSeedFixtures,
  readWaiversFile,
  resolveCaseId,
  resolveCluster,
  runCases,
  runsDir,
  saveRun,
  scoreCandidate,
  shortCaseId,
  smokeSubset,
  stderrMode,
  waiverCoverage,
  type CanonicalCase,
  type CaseRun,
  type CliSpec,
  type CompareOptions,
  type Config,
  type GapCase,
  type GapFeature,
  type ResolvedCluster,
  type ResolvedProgram,
  type ScoredCase,
  type RunRecord,
  type RunCasesOptions,
  type RunCasesResult,
  type SandboxChoice,
  type SandboxProbe,
  type SavedCluster,
  type Score,
  type Slowdown,
  type Waiver,
  type WaiverCoverage,
  type WaiverMatch,
} from '@port-anything/core';
import { display, resolveCommand, type CliResult } from './common.js';
import { loadCorpus } from './corpus.js';

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
  /** `--feature <f>`: run only the cases of that feature. */
  feature?: string;
  /** Run only these cases: IDs or prefixes (see `resolveCaseId`). No option sets it; the MCP server does. */
  caseIds?: readonly string[];
  /** `--holdout N`: fresh-holdout cases for this run instead of `holdout.fresh_cases`; 0 runs none. */
  holdout?: number;
  json: boolean;
  noSandbox: boolean;
}

// Documented options that later versions add.
const NOT_YET = ['all'];

export const USAGE = 'Usage: port-anything run [--smoke | --cluster [<run-id>/]<n> | --feature <f> | --holdout N] [--candidate <cmd>]… [--json] [--no-sandbox]';

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
        feature: { type: 'string' },
        holdout: { type: 'string' },
        json: { type: 'boolean' },
        'no-sandbox': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    if ([values.smoke === true, values.cluster !== undefined, values.feature !== undefined].filter(Boolean).length > 1) {
      throw new Error('--smoke, --cluster and --feature run different subsets; give one of them.');
    }
    if (values.feature === '') throw new Error('--feature needs a feature name, such as opt.n.');
    let holdout: number | undefined;
    if (values.holdout !== undefined) {
      if (!/^\d+$/.test(values.holdout) || !Number.isSafeInteger(Number(values.holdout))) throw new Error(`--holdout takes a number of cases (0 for none), got "${values.holdout}".`);
      if (values.smoke === true || values.cluster !== undefined || values.feature !== undefined) throw new Error(HOLDOUT_WITH_SUBSET);
      holdout = Number(values.holdout);
    }
    return {
      candidates: values.candidate ?? [],
      ...(values.cluster === undefined ? {} : { cluster: values.cluster }),
      ...(values.feature === undefined ? {} : { feature: values.feature }),
      smoke: values.smoke ?? false,
      ...(holdout === undefined ? {} : { holdout }),
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
    const cases = await loadCorpus(options.cwd, config, { noSandbox: args.noSandbox, ...(options.probe === undefined ? {} : { probe: options.probe }) });
    const waivers = await readWaiversFile(options.cwd);
    const holdout = await holdoutInputs(options.cwd, config, args);
    prepared = {
      projectDir: options.cwd,
      config,
      cases,
      waivers,
      args,
      ...(holdout === undefined ? {} : { holdout }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    };
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
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
  /** What a fresh holdout is generated from; without it, a run has none. */
  holdout?: HoldoutInputs;
}

/** The CLI spec and seed fixtures a fresh holdout is generated from, like the generated corpus. */
export interface HoldoutInputs {
  spec: CliSpec;
  seeds: readonly Uint8Array[];
}

/**
 * The project's CLI spec and seed fixtures, when this run generates a fresh holdout: a run of the
 * whole corpus, with holdout cases asked for, in a project that has a CLI spec.
 */
async function holdoutInputs(projectDir: string, config: Config, args: RunArgs): Promise<HoldoutInputs | undefined> {
  if (!wholeCorpus(args) || (args.holdout ?? holdoutSettings(config).freshCases) === 0) return undefined;
  let spec: CliSpec;
  try {
    spec = await readCliSpecFile(projectDir);
  } catch (e) {
    if (e instanceof ConfigError && e.message.startsWith('No ')) return undefined;
    throw e;
  }
  return { spec, seeds: await readSeedFixtures(projectDir) };
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

const HOLDOUT_WITH_SUBSET = '--holdout goes with a run of the whole corpus, not with --smoke, --cluster or --feature.';

/** Whether a run runs the whole corpus: no subset asked for. */
const wholeCorpus = (args: RunArgs) => args.smoke !== true && args.cluster === undefined && args.feature === undefined && args.caseIds === undefined;

/** What a run reports, as `--json` prints it. */
export type RunSummary = Awaited<ReturnType<typeof performRun>>['summary'];

/**
 * Runs and saves a run as `executeRun` describes, and returns its summary, its exit code and the
 * IDs of the cases it ran (flaky-reference cases left out), for callers that report it their own
 * way (the MCP server). Throws a `ConfigError` or `SandboxUnavailableError` when it can't start.
 */
export async function performRun({ projectDir, config, cases, waivers = [], args, probe, holdout: holdoutFrom }: ExecuteRunOptions) {
  if (config.sandbox.mode === 'container') {
    throw new ConfigError('sandbox mode "container" is not available yet; set sandbox.mode to local.');
  }
  const subsets = [args.smoke === true, args.cluster !== undefined, args.feature !== undefined, args.caseIds !== undefined].filter(Boolean).length;
  if (subsets > 1) throw new ConfigError('--smoke, --cluster and --feature run different subsets; give one of them.');
  const subset = args.cluster === undefined ? undefined : await resolveCluster(projectDir, args.cluster);
  const commands =
    args.candidates.length > 0 ? args.candidates : subset !== undefined ? [subset.run.candidate_commands[subset.cluster.candidate - 1]!] : configCandidates(config).map((c) => c.cmd);
  if (commands.length === 0) {
    throw new ConfigError('No candidate to run: set candidate (or candidates) in port-anything.yaml, or pass --candidate <cmd>.');
  }
  if (cases.length === 0) throw new ConfigError('No cases to run: add some to port-anything/recorded/*.jsonl, or generate them with port-anything generate.');
  if (args.holdout !== undefined && !wholeCorpus(args)) throw new ConfigError(HOLDOUT_WITH_SUBSET);
  const corpusIds = new Set(cases.map((c) => c.id));
  let smoke: { from: string | null; corpus: number; clusters: number; per_feature: number; passing: number } | undefined;
  let picked: { feature: string } | { cases: string[] } | undefined;
  if (subset !== undefined) cases = await clusterCases(projectDir, subset, cases);
  else if (args.feature !== undefined) {
    const feature = args.feature;
    const of = cases.filter((c) => c.features.includes(feature));
    if (of.length === 0) {
      const known = [...new Set(cases.flatMap((c) => c.features))].sort();
      throw new ConfigError(`No case has feature "${feature}"; the corpus has ${known.length === 0 ? 'no features' : `${known.slice(0, 20).join(', ')}${known.length > 20 ? `, and ${known.length - 20} more` : ''}`}.`);
    }
    cases = of;
    picked = { feature };
  } else if (args.caseIds !== undefined) {
    const byId = new Map(cases.map((c) => [c.id, c]));
    const ids = new Set<string>();
    for (const typed of args.caseIds) {
      try {
        ids.add(resolveCaseId(typed, byId.keys()));
      } catch (e) {
        if (e instanceof CaseIdError) throw new ConfigError(e.message);
        throw e;
      }
    }
    if (ids.size === 0) throw new ConfigError('No case given to run.');
    cases = [...ids].map((id) => byId.get(id)!);
    picked = { cases: [...ids] };
  } else if (args.smoke === true) {
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
  const waived = await waiverMatches(result, cases, waivers, store, commands.length);
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
  const minCasesPerFeature = config.corpus?.min_cases_per_feature;
  const corpusCandidates = commands.map((command, i) => {
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
      const score = scoreCandidate(scoredCases(result, cases, matches, i), minCasesPerFeature === undefined ? {} : { minCasesPerFeature });
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
    });

  // The fresh holdout, on a run of the whole corpus only.
  const settings = holdoutSettings(config);
  const freshCases = args.holdout ?? settings.freshCases;
  const fresh: FreshHoldoutResult =
    !wholeCorpus(args)
      ? { summary: { ran: false, reason: 'only a run of the whole corpus generates one' } }
      : freshCases === 0
        ? { summary: { ran: false, reason: args.holdout === 0 ? 'turned off with --holdout 0' : 'turned off (holdout.fresh_cases: 0)' } }
        : holdoutFrom === undefined
          ? { summary: { ran: false, reason: `no ${CLI_SPEC_FILE} to generate cases from (port-anything spec infer writes one)` } }
          : await runFreshHoldout({
              projectDir,
              config,
              inputs: holdoutFrom,
              cases: freshCases,
              alpha: settings.gapAlpha,
              corpus: corpusIds,
              runner: runnerOptions,
              waivers,
              corpusCases: cases,
              corpusScored: commands.map((_, i) => scoredCases(result, cases, waived[i]!, i)),
              scores: corpusCandidates.map((c) => c.score),
            });

  const report = {
    program_name: result.programName,
    sandbox: sandbox.label,
    reference: display(config.reference.cmd),
    compare: describeCompare(compare),
    cases: result.cases.length,
    flaky_reference: flakyReference,
    normalizers: changed(),
    waivers,
    holdout: fresh.summary,
    candidates: corpusCandidates.map((c, i) => (fresh.candidates === undefined ? c : { ...c, holdout: fresh.candidates[i]! })),
    clusters,
  };
  const saved = await saveRun(projectDir, { subset: subset !== undefined ? { cluster: subset.address } : smoke !== undefined ? { smoke } : (picked ?? null), ...report, candidate_commands: commands });
  if (fresh.failures !== undefined && fresh.failures.length > 0) {
    const lines = await Promise.all(fresh.failures.map(async (c) => JSON.stringify({ ...(await inlineCase(c, store)), features: c.features, origin: c.origin })));
    await writeFile(join(runsDir(projectDir), saved.run_id, HOLDOUT_FAILURES_FILE), `${lines.join('\n')}\n`);
  }
  if (saved.subset === null) {
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
  const exitCode = summary.candidates.some((c) => c.diverge > 0 || c.slowdown?.exceeded === true || ('holdout' in c && c.holdout.significant)) ? 1 : 0;
  return { summary, exitCode, ran: result.cases.map((c) => c.caseId) };
}

async function execute(options: ExecuteRunOptions): Promise<CliResult> {
  const { summary, exitCode } = await performRun(options);
  const { flaky_reference: flakyReference, clusters } = summary;
  if (options.args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };

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
    if ('holdout' in c) lines.push(...candidateHoldoutLines(c.holdout));
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
  if (summary.subset === null) lines.push(holdoutLine(summary.holdout));
  if (summary.holdout.ran && summary.holdout.saved > 0) {
    lines.push(`fresh-holdout cases that diverge, saved for reproduction: .port-anything/runs/${summary.run_id}/${HOLDOUT_FAILURES_FILE}`);
    lines.push(`  (in the format of ${'port-anything/recorded/*.jsonl'}: copy the file there to keep them in the corpus)`);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** Per candidate and case, the waivers covering its diverging fields; undefined for a match. */
async function waiverMatches(result: RunCasesResult, cases: readonly CanonicalCase[], waivers: readonly Waiver[], store: BlobStore, candidates: number): Promise<(WaiverMatch | undefined)[][]> {
  const regexes = waivers.some((w) => w.match.regex !== undefined);
  const waived: (WaiverMatch | undefined)[][] = [];
  for (let i = 0; i < candidates; i++) {
    waived.push(
      await Promise.all(
        result.cases.map(async (c, n) => {
          const run = c.candidates[i]!;
          if (run.comparison.verdict === 'match') return undefined;
          // A candidate that timed out where the reference finished diverges, and no waiver covers that.
          if (timedOut(c, i)) return { fields: run.shapes.map(() => []), waived: false, remaining: run.shapes };
          const text = async (field: 'stdout' | 'stderr') => (await store.get(run.normalized.reference[field])).toString('utf8');
          const reference = regexes ? { stdout: await text('stdout'), stderr: await text('stderr') } : {};
          return matchWaivers({ features: cases[n]!.features, shapes: run.shapes, reference }, waivers);
        }),
      ),
    );
  }
  return waived;
}

const timedOut = (c: CaseRun, i: number) => c.candidates[i]!.observation.timeout && !c.reference.timeout;

/** One candidate's cases as scoring sees them. */
function scoredCases(result: RunCasesResult, cases: readonly CanonicalCase[], matches: readonly (WaiverMatch | undefined)[], i: number, flakyReference?: ReadonlySet<string>): ScoredCase[] {
  return result.cases.map((c, n) => ({
    caseId: c.caseId,
    features: cases[n]!.features,
    origin: cases[n]!.origin,
    verdict: c.candidates[i]!.comparison.verdict,
    waived: matches[n]?.waived === true,
    flakyCandidate: c.candidates[i]!.flaky,
    // A case the reference also times out on is compared like any other.
    candidateTimeout: timedOut(c, i),
    timeoutRecovered: c.candidates[i]!.timeoutRecovered,
    ...(flakyReference === undefined ? {} : { flakyReference: flakyReference.has(c.caseId) }),
  }));
}

/** Where a run saves the fresh-holdout cases that diverged, next to its `run.json`. */
export const HOLDOUT_FAILURES_FILE = 'holdout-failures.jsonl';

/** Whether a run had a fresh holdout and, if it did, what it ran. */
export type HoldoutSummary =
  | { ran: false; reason: string }
  | {
      ran: true;
      /** Cases asked for (`holdout.fresh_cases`, `--holdout`). */
      requested: number;
      /** New cases run: the generated ones the corpus doesn't have. */
      cases: number;
      /** Generated cases left out because the corpus has them. */
      in_corpus: number;
      /** New cases left out because the reference's own output varied on them. */
      flaky_reference: number;
      alpha: number;
      /** Diverging cases saved in the run's directory (see `HOLDOUT_FAILURES_FILE`). */
      saved: number;
    };

/** One candidate's fresh holdout, and its gap to the corpus. */
export interface CandidateHoldout {
  match: number;
  diverge: number;
  waived: number;
  /** Mean of per-feature parity over the holdout's cases of the corpus headline's features; null when it has none. */
  parity: number | null;
  ci95: [number, number] | null;
  /** Features `parity` is the mean over. */
  features: number;
  /**
   * The gap test, on the byte-mutated cases of both sides (see `holdoutGap`); null when either
   * side has none of the headline's features (`no_gap` says why).
   */
  gap: { corpus: number; holdout: number; gap: number; p_value: number; features: GapFeature[]; clusters: { corpus: number; holdout: number } } | null;
  no_gap?: string;
  /** The gap is significant at `holdout.gap_alpha`: the run fails. */
  significant: boolean;
  /** IDs of the holdout cases it diverged on. */
  diverging: string[];
}

interface FreshHoldoutResult {
  summary: HoldoutSummary;
  candidates?: CandidateHoldout[];
  /** The cases any candidate diverged on, to save. */
  failures?: CanonicalCase[];
}

/**
 * Generates a fresh holdout from a new seed that is never stored, the way the corpus is generated,
 * and runs it against the reference and every candidate. A case a candidate diverges on runs on
 * the reference once more: when the reference's own output changes, the case is left out as
 * flaky-reference (the corpus learns those from baseline; new cases can't). Waivers apply as on
 * the corpus. Each candidate's holdout is then compared with its corpus score (see `holdoutGap`).
 */
async function runFreshHoldout(options: {
  projectDir: string;
  config: Config;
  inputs: HoldoutInputs;
  cases: number;
  alpha: number;
  corpus: ReadonlySet<string>;
  runner: Omit<RunCasesOptions, 'cases' | 'workDir'>;
  waivers: readonly Waiver[];
  /** The corpus as it ran (flaky-reference cases left out), and each candidate's outcomes on it. */
  corpusCases: readonly CanonicalCase[];
  corpusScored: readonly (readonly ScoredCase[])[];
  scores: readonly Score[];
}): Promise<FreshHoldoutResult> {
  const { projectDir, config, inputs, runner, waivers } = options;
  const { store } = runner;
  const generated = generatedCorpusSettings(config);
  const minCasesPerFeature = config.corpus?.min_cases_per_feature;
  const workDir = scratchDir(projectDir);
  let fresh;
  let result: RunCasesResult;
  const flaky = new Set<string>();
  try {
    fresh = await generateFreshHoldout(inputs.spec, {
      seed: freshHoldoutSeed(),
      cases: options.cases,
      corpus: options.corpus,
      generator: generated?.generator ?? DEFAULT_GENERATOR,
      iKnow: false,
      ...(generated === undefined ? {} : { errorPathCap: generated.errorPathCap }),
      ...(minCasesPerFeature === undefined ? {} : { minCasesPerFeature }),
      seeds: inputs.seeds,
      observe: async (cases, blobs) => {
        for (const c of cases) for (const ref of [c.stdin, ...Object.values(c.fixtures)]) if (ref !== null) await store.put(blobs.get(ref)!);
        const observed = await runCases({ ...runner, candidates: [], cases, workDir: join(workDir, 'observe') });
        return observed.cases.map((c) => c.reference);
      },
    });
    result = await runCases({ ...runner, cases: fresh.cases, workDir: join(workDir, 'run') });
    const diverging = fresh.cases.filter((_, n) => result.cases[n]!.candidates.some((r) => r.comparison.verdict === 'diverge'));
    if (diverging.length > 0) {
      const again = await runCases({ ...runner, candidates: [runner.reference], cases: diverging, workDir: join(workDir, 'again'), rerun: false });
      for (const c of again.cases) if (c.candidates[0]!.comparison.verdict === 'diverge') flaky.add(c.caseId);
    }
  } finally {
    await removeScratch(projectDir, workDir);
  }
  const cases = fresh.cases;
  const waived = await waiverMatches(result, cases, waivers, store, options.scores.length);
  // The gap compares byte mutants only: argv cases come first and take a share of a corpus that
  // depends on its budget (most of a small holdout for a large CLI, little of a 10000-case
  // corpus). The corpus's argv cases are the ones its seed generates; recorded and imported cases
  // aren't generated at all.
  const argvIds =
    generated === undefined ? new Set<string>() : new Set(generateArgvCases(inputs.spec, { seed: generated.seed, generator: generated.generator, iKnow: false }).cases.map((c) => c.case.id));
  const corpusMutant = options.corpusCases.map((c) => generated !== undefined && c.origin === 'generated' && !argvIds.has(c.id));
  const holdoutMutant = fresh.strategies.map((s) => s === 'mutation');
  const toGap = (c: CanonicalCase, scored: ScoredCase): GapCase => {
    const o = caseOutcome(scored);
    return { features: c.features, cluster: gapCluster(c), outcome: o === 'match' ? 'match' : o === 'diverge' ? 'diverge' : 'excluded' };
  };
  const failing = new Set<string>();
  const candidates = options.scores.map((corpusScore, i): CandidateHoldout => {
    const scored = scoredCases(result, cases, waived[i]!, i, flaky);
    const score = scoreCandidate(scored, { minCasesPerFeature: 1 });
    const headline = new Set(corpusScore.headlineFeatures);
    const holdoutGapCases = cases.map((c, n) => toGap(c, scored[n]!));
    const parity = holdoutParity(holdoutGapCases, headline);
    const corpusGapCases = options.corpusCases.flatMap((c, n) => (corpusMutant[n] ? [toGap(c, options.corpusScored[i]![n]!)] : []));
    const gap = holdoutGap(
      corpusGapCases,
      holdoutGapCases.filter((_, n) => holdoutMutant[n]),
      { alpha: options.alpha, features: headline },
    );
    const noGap =
      gap.gap !== null
        ? undefined
        : corpusGapCases.length === 0
          ? 'the corpus has no generated byte-mutated cases to compare with (port-anything generate makes them)'
          : !holdoutMutant.some(Boolean)
            ? 'the holdout has no byte-mutated cases (raise holdout.fresh_cases)'
            : `no feature of the parity has ${MIN_GAP_CASES} byte-mutated cases on both sides (a larger corpus.budget or holdout.fresh_cases gives more)`;
    const diverging = result.cases.flatMap((c, n) => (caseOutcome(scored[n]!) === 'diverge' ? [c.caseId] : []));
    for (const id of diverging) failing.add(id);
    return {
      match: score.raw.match,
      diverge: score.raw.diverge,
      waived: score.raw.waived,
      parity: parity.parity,
      ci95: parity.ci95,
      features: parity.features,
      gap:
        gap.gap === null
          ? null
          : { corpus: gap.corpus!, holdout: gap.holdout!, gap: gap.gap, p_value: gap.pValue!, features: gap.features, clusters: gap.clusters },
      ...(noGap === undefined ? {} : { no_gap: noGap }),
      significant: gap.significant,
      diverging,
    };
  });
  const failures = cases.filter((c) => failing.has(c.id));
  return {
    summary: { ran: true, requested: options.cases, cases: cases.length, in_corpus: fresh.inCorpus, flaky_reference: flaky.size, alpha: options.alpha, saved: failures.length },
    candidates,
    failures,
  };
}

/** Whether the run had a fresh holdout, for the text output. */
function holdoutLine(h: HoldoutSummary): string {
  if (!h.ran) return `fresh holdout: not run, ${h.reason}`;
  const parts = [`fresh holdout: ${count(h.cases, 'new case')} from a seed that is not stored`];
  if (h.in_corpus > 0) parts.push(`${h.in_corpus} more generated were in the corpus already`);
  if (h.flaky_reference > 0) parts.push(`${h.flaky_reference} left out as flaky-reference (the reference varied)`);
  return parts.join(', ');
}

/** A candidate's fresh-holdout parity and its gap to the corpus. */
function candidateHoldoutLines(h: CandidateHoldout): string[] {
  const ci = h.ci95 === null ? '' : ` (95% CI ${percent(h.ci95[0])}–${percent(h.ci95[1])})`;
  const lines = [h.parity === null ? "  fresh holdout: no new case of the parity's features" : `  fresh holdout ${percent(h.parity)}${ci}, mean of ${count(h.features, 'feature')}`];
  if (h.gap === null) {
    lines.push(`  gap to the corpus not tested: ${h.no_gap}`);
    return lines;
  }
  const g = h.gap;
  const p = g.p_value < 0.0001 ? 'p < 0.0001' : `p = ${g.p_value.toPrecision(2)}`;
  lines.push(
    `  gap to the corpus ${(g.gap * 100).toFixed(1)} points on byte-mutated cases of ${count(g.features.length, 'feature')} (corpus ${percent(g.corpus)}, holdout ${percent(g.holdout)}): ${h.significant ? 'SIGNIFICANT' : 'not significant'} (${p})`,
  );
  if (h.significant) lines.push('  the candidate does better on the corpus than on cases it has never seen, beyond chance: it may be fitted to the corpus (a lookup table of expected outputs)');
  return lines;
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
  if ('feature' in subset) return `, feature ${subset.feature} only`;
  if ('cases' in subset) return `, ${subset.cases.length === 1 ? '1 given case' : `${subset.cases.length} given cases`} only`;
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
