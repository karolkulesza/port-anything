import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  CLI_SPEC_FILE,
  CONFIG_FILE,
  ConfigError,
  DEFAULT_GENERATOR,
  DEFAULT_MIN_CASES_PER_FEATURE,
  SandboxUnavailableError,
  assertNotDestructive,
  baselineCases,
  baselineRecord,
  cacheDir,
  chooseSandbox,
  cliSpecYaml,
  defaultProgramName,
  DEFAULT_GENERATOR_SEED,
  generateCorpus,
  inferCliSpec,
  normalizerEntry,
  normalizerLabel,
  parseConfigSource,
  parseProgramCommand,
  probeSandbox,
  readConfigFile,
  readSeedFixtures,
  resolveProgram,
  runCases,
  shortCaseId,
  specFeatures,
  writeBaselineRecord,
  type CliSpec,
  type NormalizerSpec,
  type ProgramCommand,
  type ResolvedProgram,
  type SandboxProbe,
} from '@port-anything/core';
import { display, resolveCommand, type CliResult } from './common.js';
import { cacheGeneratedCorpus } from './corpus.js';
import { checkoutRev, isInside, parseGitRef, removeCheckout, rerootPath, runBuild, type GitCheckout } from './git-ref.js';

/** Generated cases `compare` runs unless `--budget` says otherwise. */
export const DEFAULT_COMPARE_BUDGET = 500;
/** The generator seed of every `compare` run, so the same programs always get the same cases. */
export const COMPARE_SEED = DEFAULT_GENERATOR_SEED;
/** Reference runs per case that look for output varying between runs. */
export const COMPARE_REPEATS = 2;
/**
 * Further reference runs of a case a candidate diverges on, stopping at the first that differs.
 * Output that varies by chance (`sort --random-sort` on two lines) can agree in every baseline run;
 * a case whose reference varies here is flaky-reference too. A random order of two lines that
 * fooled the earlier runs and made a candidate diverge still fools all 4 one time in 16.
 */
export const COMPARE_RECHECKS = 4;

/** The arguments of `port-anything compare`. */
export interface CompareArgs {
  /** The reference command, or `git:<rev>` as `--ref` gave it. */
  reference: string;
  /** With `--ref git:<rev>`: the revision whose build is the reference. */
  gitRev?: string;
  candidates: string[];
  budget: number;
  save: boolean;
  json: boolean;
  iKnow: boolean;
  noSandbox: boolean;
}

export const USAGE = [
  "Usage: port-anything compare '<ref cmd>' '<candidate cmd>'… [--budget 500] [--save] [--json] [--i-know] [--no-sandbox]",
  "       port-anything compare --ref git:<rev> '<candidate cmd>'… [--budget 500] [--json] [--i-know] [--no-sandbox]",
].join('\n');

/** Reads the arguments after `compare`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseCompareArgs(argv: readonly string[]): CompareArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        budget: { type: 'string' },
        ref: { type: 'string' },
        save: { type: 'boolean' },
        json: { type: 'boolean' },
        'i-know': { type: 'boolean' },
        'no-sandbox': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  let reference: string | undefined;
  let candidates: string[];
  let gitRev: string | undefined;
  if (values.ref !== undefined) {
    gitRev = parseGitRef(values.ref);
    if (gitRev === undefined) throw new ConfigError(`--ref takes git:<rev> (a commit, branch or tag, such as git:HEAD~1), got "${values.ref}".\n${USAGE}`);
    [reference, candidates] = [values.ref, positionals];
    if (candidates.length === 0) throw new ConfigError(`compare --ref needs at least one candidate.\n${USAGE}`);
    if (values.save) throw new ConfigError('--save can\'t record a git reference in port-anything.yaml; run compare --ref without --save.');
  } else {
    [reference, ...candidates] = positionals;
    if (reference === undefined || candidates.length === 0) throw new ConfigError(`compare needs a reference and at least one candidate.\n${USAGE}`);
  }
  let budget = DEFAULT_COMPARE_BUDGET;
  if (values.budget !== undefined) {
    if (!/^\d+$/.test(values.budget) || Number(values.budget) < 1) throw new ConfigError(`--budget must be a whole number of at least 1, got "${values.budget}".`);
    budget = Number(values.budget);
  }
  return {
    reference,
    ...(gitRev === undefined ? {} : { gitRev }),
    candidates,
    budget,
    save: values.save ?? false,
    json: values.json ?? false,
    iKnow: values['i-know'] ?? false,
    noSandbox: values['no-sandbox'] ?? false,
  };
}

export interface CompareOptions {
  /** Where relative program paths start, and where `--save` writes the project. */
  cwd: string;
  /** The sandbox probe's result; probed on this machine when absent. */
  probe?: SandboxProbe;
  /** Gets a line for each stage as it starts (the CLI prints them on stderr). */
  progress?: (line: string) => void;
  /** Where the scratch directory goes; defaults to the system's temporary directory. */
  tmpDir?: string;
  /** Cases running at once; defaults to the number of CPU cores. */
  concurrency?: number;
  /** Per run of a case; defaults to the runner's. */
  timeoutMs?: number;
}

/**
 * `port-anything compare`: zero-config parity of one or more candidates against a reference. Reads
 * the reference's `--help` into a CLI spec, generates a corpus from it, runs every case twice more
 * on the reference to find output that varies between runs (normalizers for it, `flaky-reference`
 * for what still varies), then runs every candidate and reports per-feature parity. A case a
 * candidate diverges on runs on the reference a few more times, and is flaky-reference too if the
 * reference varies there. Nothing is written outside a scratch directory, unless `--save` writes
 * `port-anything.yaml` and the CLI spec. Exit code 0 when every candidate matches on every case,
 * 1 when any case diverges, 3 when the run can't start (arguments, programs, sandbox, a
 * destructive tool).
 */
export async function compareCommand(argv: readonly string[], options: CompareOptions): Promise<CliResult> {
  try {
    return await execute(parseCompareArgs(argv), options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything compare: ${message}\n` });

async function execute(args: CompareArgs, options: CompareOptions): Promise<CliResult> {
  const started = Date.now();
  const progress = options.progress ?? (() => {});
  const candidates = await Promise.all(args.candidates.map((cmd) => resolveCommand(cmd, options.cwd)));
  const gitReference = args.gitRev === undefined ? undefined : await gitReferenceCommand(args, options.cwd);
  // A git reference is built later; the candidates are checked now, before anything is built.
  let reference = gitReference === undefined ? await resolveCommand(args.reference, options.cwd) : undefined;
  checkPrograms(reference === undefined ? candidates : [reference, ...candidates], args);
  if (args.save) await assertCanSave(options.cwd);
  const sandbox = chooseSandbox(options.probe ?? (await probeSandbox()), { noSandbox: args.noSandbox });

  const scratch = await mkdtemp(join(options.tmpDir ?? tmpdir(), 'port-anything-compare-'));
  let checkout: GitCheckout | undefined;
  try {
    let git: CompareSummary['git'];
    if (gitReference !== undefined) {
      checkout = await checkoutRev(options.cwd, args.gitRev!);
      const where = `git:${checkout.rev} (${checkout.commit.slice(0, 7)})`;
      if (gitReference.build === undefined) progress(`checking out ${where} in a temporary worktree …`);
      else {
        progress(`building ${where} in a temporary worktree …`);
        await runBuild(gitReference.build, checkout.projectDir);
      }
      reference = await resolveAtCommit(gitReference, checkout);
      git = { rev: checkout.rev, commit: checkout.commit, cmd: display(gitReference.cmd), build: gitReference.build ?? null };
    }
    if (reference === undefined) throw new Error('unreachable: no reference');
    const programName = checkPrograms([reference, ...candidates], args);

    const store = new BlobStore(cacheDir(scratch));
    const common = {
      reference,
      store,
      sandbox,
      programName,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };

    progress(`reading ${programName}'s help text …`);
    const { spec, helpArgv } = await inferCliSpec({ ...common, workDir: join(scratch, 'spec') });

    progress(`generating up to ${args.budget} cases …`);
    const stored = new Set<string>();
    const corpus = await generateCorpus(spec, {
      seed: COMPARE_SEED,
      generator: DEFAULT_GENERATOR,
      iKnow: args.iKnow,
      budget: args.budget,
      // A saved project regenerates its cases with the seed fixtures there, so these must use them too.
      ...(args.save ? { seeds: await readSeedFixtures(options.cwd) } : {}),
      observe: async (cases, blobs) => {
        for (const c of cases) {
          for (const ref of [c.stdin, ...Object.values(c.fixtures)]) {
            if (ref === null || stored.has(ref)) continue;
            await store.put(blobs.get(ref)!);
            stored.add(ref);
          }
        }
        const run = await runCases({ ...common, candidates: [], cases, workDir: join(scratch, 'generate') });
        return run.cases.map((c) => c.reference);
      },
    });
    const cases = corpus.cases.map((c) => c.case);

    progress(`running the reference ${COMPARE_REPEATS} more times on ${cases.length} cases …`);
    const baseline = await baselineCases({ ...common, cases, repeats: COMPARE_REPEATS, workDir: join(scratch, 'baseline') });
    const flaky = new Map<string, string[]>(baseline.cases.filter((c) => c.status === 'flaky-reference').map((c) => [c.caseId, c.unstable]));
    const normalizers = baseline.proposals.map((p) => p.spec);

    progress(`running ${candidates.length === 1 ? 'the candidate' : `${candidates.length} candidates`} …`);
    const scored = cases.filter((c) => !flaky.has(c.id));
    const run = await runCases({ ...common, candidates, cases: scored, normalizers, recheckReference: COMPARE_RECHECKS, workDir: join(scratch, 'run') });
    // The reference varied on a re-check: flaky-reference after all, so out of the score and listed.
    const late = new Map(run.cases.flatMap((c) => (c.referenceVaried === undefined ? [] : [[c.caseId, c.referenceVaried] as const])));
    for (const [id, fields] of late) flaky.set(id, fields);
    const result = { ...run, cases: run.cases.filter((c) => !late.has(c.caseId)) };
    const trusted = baseline.cases.filter((c) => !late.has(c.caseId));

    const selfDescription = new Set(specFeatures(spec).filter((f) => f.selfDescription).map((f) => f.name));
    const byId = new Map(cases.map((c) => [c.id, c]));
    const summary: CompareSummary = {
      program_name: result.programName,
      sandbox: sandbox.label,
      reference: args.reference,
      ...(git === undefined ? {} : { git }),
      spec: specSummary(spec, helpArgv),
      corpus: {
        cases: cases.length,
        budget: args.budget,
        generator: DEFAULT_GENERATOR,
        seed: COMPARE_SEED,
        stop: corpus.stats.stop,
        observed: corpus.stats.observed,
        dropped: corpus.stats.dropped,
        skipped: corpus.skipped,
      },
      untested: specFeatures(spec)
        .map((f) => f.name)
        .filter((name) => !cases.some((c) => c.features.includes(name))),
      baseline: {
        repeats: COMPARE_REPEATS,
        stable: trusted.filter((c) => c.status === 'stable').length,
        normalized: trusted.filter((c) => c.status === 'normalized').length,
        flaky_reference: cases.filter((c) => flaky.has(c.id)).map((c) => ({ case: c.id, argv: c.argv, fields: flaky.get(c.id)! })),
      },
      normalizers: normalizers.map((spec, n) => ({
        normalizer: normalizerLabel(spec),
        cases: result.cases.filter((c) => c.candidates.some((run) => run.normalizedBy.includes(n))).length,
      })),
      candidates: args.candidates.map((command, i) => {
        const verdicts = result.cases.map((c) => ({ case: byId.get(c.caseId)!, comparison: c.candidates[i]!.comparison, recovered: c.candidates[i]!.timeoutRecovered }));
        const score = scoreParity(
          verdicts.map((v) => ({ features: v.case.features, match: v.comparison.verdict === 'match' })),
          selfDescription,
        );
        const divergences = verdicts
          .filter((v) => v.comparison.verdict === 'diverge')
          .map((v) => ({ case: v.case.id, argv: v.case.argv, fields: v.comparison.fields }));
        // Scored on the re-run, whose first run timed out where the reference finished: listed, never silent.
        const timeoutRecovered = verdicts.filter((v) => v.recovered).map((v) => ({ case: v.case.id, argv: v.case.argv }));
        return { command, ...score, divergences, timeout_recovered: timeoutRecovered };
      }),
      saved: [],
      duration_ms: 0,
    };
    if (args.save) {
      summary.saved = await save(options.cwd, { args, programName: result.programName, spec, normalizers });
      // The project starts with this run's cases and flaky-reference list, so its first run compares the same cases.
      const config = await readConfigFile(options.cwd);
      await cacheGeneratedCorpus(options.cwd, config, { cases, stats: corpus.stats, skipped: corpus.skipped, blobs: corpus.blobs });
      await writeBaselineRecord(options.cwd, baselineRecord(baseline));
    }
    summary.duration_ms = Date.now() - started;

    const exitCode = summary.candidates.some((c) => c.divergences.length > 0) ? 1 : 0;
    if (args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };
    return { exitCode, stdout: formatCompare(summary), stderr: '' };
  } finally {
    if (checkout !== undefined) await removeCheckout(checkout);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Checks that the programs can run under one name and that none is destructive (without `--i-know`); returns the name. */
function checkPrograms(programs: readonly ResolvedProgram[], args: CompareArgs): string {
  const programName = pinnedName(programs);
  for (const program of programs) {
    assertNotDestructive([program.path, ...(program.tool === undefined ? [] : [program.tool]), ...program.args], args);
  }
  assertNotDestructive([programName], args);
  return programName;
}

/** The reference `--ref git:<rev>` builds and runs at that commit. */
interface GitReferenceCommand {
  cmd: string | readonly string[];
  build?: string;
  /** Whether `cmd` is the config's `reference.cmd` rather than a command on the command line. */
  fromConfig: boolean;
}

/**
 * With a `port-anything.yaml` in the directory, `reference.cmd` and `reference.build` from it (as
 * they are now, not at the commit); without one, the first candidate's command and no build step.
 */
async function gitReferenceCommand(args: CompareArgs, cwd: string): Promise<GitReferenceCommand> {
  const hasConfig = await access(join(cwd, CONFIG_FILE)).then(
    () => true,
    () => false,
  );
  if (!hasConfig) return { cmd: args.candidates[0]!, fromConfig: false };
  const { reference } = await readConfigFile(cwd);
  return { cmd: reference.cmd, ...(reference.build === undefined ? {} : { build: reference.build }), fromConfig: true };
}

/**
 * Finds the reference in the checkout: a relative executable starts at the checkout's copy of the
 * project directory, and an absolute path into the repository (the executable, or an argument such
 * as the script of `python3 /repo/tool.py`) points into the checkout instead. A command with
 * nothing in the checkout would be the same at every commit, so it's refused.
 */
async function resolveAtCommit(ref: GitReferenceCommand, checkout: GitCheckout): Promise<ResolvedProgram> {
  let command: ProgramCommand;
  try {
    command = parseProgramCommand(ref.cmd);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const executable = (await rerootPath(command.executable, checkout)) ?? command.executable;
  const args = await Promise.all(command.args.map(async (arg) => ({ arg, rerooted: await rerootPath(arg, checkout) })));
  command = { ...command, executable, args: args.map((a) => a.rerooted ?? a.arg) };
  const at = `in the checkout of git:${checkout.rev}${ref.build === undefined ? ` (no reference.build in ${CONFIG_FILE} ran there)` : ' after reference.build'}`;
  let program: ResolvedProgram;
  try {
    program = await resolveProgram(command, { cwd: checkout.projectDir });
  } catch (e) {
    throw new ConfigError(`${(e as Error).message.replace(/\.$/, '')} ${at}.`);
  }
  if (!isInside(program.path, checkout.worktree) && !args.some((a) => a.rerooted !== undefined)) {
    throw new ConfigError(
      `Nothing in the reference ${display(ref.cmd)}${ref.fromConfig ? ` (reference.cmd in ${CONFIG_FILE})` : ''} is in the repository (it runs ${program.path}), so it would be the same program at every commit. Give the program's path in the repository (./bin/tool), or, for a script run by an interpreter, the script's absolute path (python3 ${join(checkout.repoTop, 'tool.py')}).`,
    );
  }
  return program;
}

/** The argv[0] every side runs as; a multicall side fixes it, so two that disagree can't be compared. */
function pinnedName(programs: readonly ResolvedProgram[]): string {
  const name = defaultProgramName(programs);
  const other = programs.find((p) => p.tool !== undefined && p.tool !== name);
  if (other !== undefined) {
    throw new ConfigError(`${display([other.executable, other.tool!])} runs only as "${other.tool}", but another side runs as "${name}"; compare programs that run under the same name.`);
  }
  return name;
}

function specSummary(spec: CliSpec, helpArgv: readonly string[]): CompareSummary['spec'] {
  const features = specFeatures(spec);
  return {
    help: helpArgv.join(' '),
    flags: spec.flags.length,
    forms: spec.forms.length,
    subcommands: spec.subcommands.length,
    features: features.length,
  };
}

/** One case of one candidate, as the parity counts it. */
interface ParityCase {
  features: readonly string[];
  match: boolean;
}

export interface FeatureParity {
  feature: string;
  match: number;
  cases: number;
  parity: number;
  selfDescription: boolean;
  /** Fewer cases than the minimum (and not self-description): shown, but out of the headline. */
  underSampled: boolean;
}

export interface Parity {
  /** Mean of the per-feature parity over the headline's features; null when none qualifies. */
  parity: number | null;
  /** How many features the headline averages. */
  features: number;
  /** Over cases, each counted once. */
  match: number;
  cases: number;
  per_feature: FeatureParity[];
}

/**
 * Per-feature parity and the headline: the mean over features, so each feature weighs the same
 * however many cases it has. A case counts once in each of its features. The generator tags cases
 * without flags `base`; the cases it leaves untagged (unknown flags) count only in the case totals.
 * Self-description features and features with fewer than `minCases` cases are reported but left
 * out of the headline.
 */
export function scoreParity(cases: readonly ParityCase[], selfDescription: ReadonlySet<string>, minCases = DEFAULT_MIN_CASES_PER_FEATURE): Parity {
  const counts = new Map<string, { match: number; cases: number }>();
  for (const c of cases) {
    for (const feature of new Set(c.features)) {
      const n = counts.get(feature) ?? { match: 0, cases: 0 };
      n.cases++;
      if (c.match) n.match++;
      counts.set(feature, n);
    }
  }
  const per_feature = [...counts.keys()].sort().map((feature): FeatureParity => {
    const { match, cases: n } = counts.get(feature)!;
    const self = selfDescription.has(feature);
    return { feature, match, cases: n, parity: match / n, selfDescription: self, underSampled: !self && n < minCases };
  });
  const headline = per_feature.filter((f) => !f.selfDescription && !f.underSampled);
  return {
    parity: headline.length === 0 ? null : headline.reduce((sum, f) => sum + f.parity, 0) / headline.length,
    features: headline.length,
    match: cases.filter((c) => c.match).length,
    cases: cases.length,
    per_feature,
  };
}

/** A share as a percentage with one decimal, rounded down so a single divergence never shows 100%. */
export function percent(share: number): string {
  return `${(Math.floor(share * 1000 + 1e-9) / 10).toFixed(1)}%`;
}

/** What `compare --json` prints. */
export interface CompareSummary {
  program_name: string;
  sandbox: string;
  /** The reference command, or `git:<rev>` with `--ref`. */
  reference: string;
  /** With `--ref git:<rev>`: the commit it named, and the command and build that ran there. */
  git?: { rev: string; commit: string; cmd: string; build: string | null };
  spec: { help: string; flags: number; forms: number; subcommands: number; features: number };
  corpus: {
    cases: number;
    budget: number;
    generator: string;
    seed: number;
    stop: string;
    /** Cases the reference ran while generating, kept or not. */
    observed: number;
    dropped: { duplicate: number; errorCap: number; budget: number };
    /** Destructive subcommands left out. */
    skipped: string[];
  };
  /** Spec features no case carries: listed rather than silently not counted. */
  untested: string[];
  baseline: { repeats: number; stable: number; normalized: number; flaky_reference: { case: string; argv: string[]; fields: string[] }[] };
  normalizers: { normalizer: string; cases: number }[];
  candidates: (Parity & {
    command: string;
    divergences: { case: string; argv: string[]; fields: string[] }[];
    /** Cases scored on the candidate's re-run, its first run having timed out where the reference finished. */
    timeout_recovered: { case: string; argv: string[] }[];
  })[];
  saved: string[];
  duration_ms: number;
}

/** The summary as `compare` prints it without `--json`. */
export function formatCompare(s: CompareSummary): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    ...(s.git === undefined
      ? []
      : [`reference: ${s.git.cmd} at git:${s.git.rev} (${s.git.commit.slice(0, 7)}), ${s.git.build === null ? 'no build step' : `built with \`${s.git.build}\``}`]),
    `read ${helpInvocation(s.program_name, s.spec.help)}: ${plural(s.spec.flags, 'flag')}, ${plural(s.spec.forms, 'positional form')}${s.spec.subcommands > 0 ? `, ${plural(s.spec.subcommands, 'subcommand')}` : ''}`,
    `every side runs as \`${s.program_name}\` (argv[0] pinned) · sandbox: ${s.sandbox}`,
    `generated ${plural(s.corpus.cases, 'case')} (budget ${s.corpus.budget})${s.corpus.skipped.length > 0 ? `; left out as destructive: ${s.corpus.skipped.join(', ')}` : ''}`,
    `reference re-run ${s.baseline.repeats}× per case: ${s.baseline.stable} stable, ${s.baseline.normalized} stable after normalizers, ${s.baseline.flaky_reference.length} flaky-reference (left out)`,
    s.normalizers.length === 0 ? 'normalizers: none' : `normalizers (cases changed): ${s.normalizers.map((n) => `${n.normalizer} ${n.cases}`).join(', ')}`,
    '',
  ];
  for (const c of s.candidates) {
    const headline = c.parity === null ? 'parity n/a (no feature has enough cases)' : `parity ${percent(c.parity)}`;
    lines.push(`${c.command}: ${headline}  (mean of ${plural(c.features, 'feature')}; ${c.match}/${c.cases} cases)`);
  }

  // Feature × candidate matrix.
  const features = [...new Set(s.candidates.flatMap((c) => c.per_feature.map((f) => f.feature)))].sort();
  const mark = (f: FeatureParity | undefined) => (f === undefined ? '' : f.selfDescription ? ' (self-description)' : f.underSampled ? ' (under-sampled)' : '');
  const cell = (f: FeatureParity | undefined) => (f === undefined ? '-' : `${percent(f.parity)} ${f.match}/${f.cases}`);
  const rows = features.map((feature) => {
    const cells = s.candidates.map((c) => c.per_feature.find((f) => f.feature === feature));
    return { name: `${feature}${mark(cells.find((c) => c !== undefined))}`, cells: cells.map(cell) };
  });
  const header = { name: 'feature', cells: s.candidates.map((_, i) => (s.candidates.length === 1 ? 'parity' : `cand ${i + 1}`)) };
  const width = Math.max(...[header, ...rows].map((r) => r.name.length));
  const cellWidths = header.cells.map((h, i) => Math.max(h.length, ...rows.map((r) => r.cells[i]!.length)));
  lines.push('');
  for (const r of [header, ...rows]) lines.push(`  ${r.name.padEnd(width)}  ${r.cells.map((c, i) => c.padEnd(cellWidths[i]!)).join('  ')}`.trimEnd());
  if (s.candidates.some((c) => c.per_feature.some((f) => f.underSampled))) {
    lines.push(`under-sampled: fewer than ${DEFAULT_MIN_CASES_PER_FEATURE} cases, left out of the parity`);
  }
  if (s.untested.length > 0) lines.push(`untested (no generated case): ${s.untested.join(', ')}`);
  if (s.baseline.flaky_reference.length > 0) {
    lines.push('', 'flaky-reference (output still varies between reference runs):');
    for (const f of s.baseline.flaky_reference) lines.push(`  ${shortCaseId(f.case)}  ${s.program_name} ${display(f.argv)}  ${f.fields.join(', ')}`);
  }
  for (const c of s.candidates.filter((c) => c.timeout_recovered.length > 0)) {
    lines.push('', `${c.command}: timeout, recovered on re-run (the re-run was compared): ${c.timeout_recovered.length}`);
    for (const r of c.timeout_recovered) lines.push(`  ${shortCaseId(r.case)}  ${s.program_name} ${display(r.argv)}`);
  }
  if (s.saved.length > 0) lines.push('', `saved ${s.saved.join(' and ')}`);
  lines.push('', `done in ${Math.round(s.duration_ms / 1000)} s`);
  return `${lines.join('\n')}\n`;
}

const SAVED = [CONFIG_FILE, CLI_SPEC_FILE];

/** `--save` never overwrites: a config or spec already there may hold someone's edits. */
async function assertCanSave(dir: string): Promise<void> {
  for (const file of SAVED) {
    const exists = await access(join(dir, file)).then(
      () => true,
      () => false,
    );
    if (exists) throw new ConfigError(`--save would overwrite ${file}; run compare elsewhere, or remove it first.`);
  }
}

/**
 * Writes the run as a project: `port-anything.yaml` (the programs, the proposed normalizers, and
 * the generator settings the corpus regenerates from) and the inferred CLI spec.
 */
async function save(dir: string, run: { args: CompareArgs; programName: string; spec: CliSpec; normalizers: readonly NormalizerSpec[] }): Promise<string[]> {
  const q = JSON.stringify;
  const program = (cmd: string) => `\n  cmd: ${q(cmd)}`;
  const config = [
    '# Written by port-anything compare --save.',
    'version: 1',
    `program_name: ${q(run.programName)}`,
    `reference:${program(run.args.reference)}`,
    ...(run.args.candidates.length === 1
      ? [`candidate:${program(run.args.candidates[0]!)}`]
      : ['candidates:', ...run.args.candidates.map((cmd) => `  - cmd: ${q(cmd)}`)]),
    'sandbox:',
    '  mode: local',
    ...(run.normalizers.length === 0 ? [] : ['normalizers:', ...run.normalizers.map((n) => `  - ${q(normalizerEntry(n))}`)]),
    'corpus:',
    `  generator: ${DEFAULT_GENERATOR}`,
    `  generator_seed: ${COMPARE_SEED}`,
    `  budget: ${run.args.budget}`,
    '',
  ].join('\n');
  parseConfigSource(config); // never write a config that doesn't load
  await writeFile(join(dir, CONFIG_FILE), config, { flag: 'wx' });
  await mkdir(dirname(join(dir, CLI_SPEC_FILE)), { recursive: true });
  await writeFile(join(dir, CLI_SPEC_FILE), cliSpecYaml(run.spec), { flag: 'wx' });
  return SAVED;
}

/** The call whose output the spec was read from: `"sort --help"`, or `"awk" with no arguments`. */
export function helpInvocation(program: string, help: string): string {
  return help === '' ? `"${program}" with no arguments` : `"${program} ${help}"`;
}
