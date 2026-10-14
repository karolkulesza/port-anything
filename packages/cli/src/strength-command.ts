import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  DEFAULT_STRENGTH_MUTANTS,
  SandboxUnavailableError,
  cacheDir,
  configCandidates,
  loadCommittedCases,
  mapPool,
  openCaseRunner,
  parseProgramCommand,
  readConfigFile,
  runCases,
  scoreMutants,
  type CanonicalCase,
  type Config,
  type SandboxProbe,
  type StrengthScore,
} from '@port-anything/core';
import { display, prepareSides, removeScratch, scratchDir, type CliResult } from './run-command.js';
import { chooseTool, type ToolContext } from './strength-tools.js';

/** The options of `port-anything strength`. */
export interface StrengthArgs {
  /** `--mutants N`: test at most this many mutants (a fixed sample when there are more). */
  mutants: number;
  json: boolean;
  noSandbox: boolean;
}

const USAGE = 'Usage: port-anything strength [--mutants 200] [--json] [--no-sandbox]';

/** Reads the arguments after `strength`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseStrengthArgs(argv: readonly string[]): StrengthArgs {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { mutants: { type: 'string' }, json: { type: 'boolean' }, 'no-sandbox': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    });
    const mutants = values.mutants === undefined ? DEFAULT_STRENGTH_MUTANTS : Number(values.mutants);
    if (!/^\d+$/.test(values.mutants ?? '1') || !Number.isSafeInteger(mutants) || mutants < 1) {
      throw new Error(`--mutants must be a positive whole number, got "${values.mutants}".`);
    }
    return { mutants, json: values.json ?? false, noSandbox: values['no-sandbox'] ?? false };
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
}

export interface StrengthOptions {
  cwd: string;
  probe?: SandboxProbe;
  /** The CLI's entry script, which the mutation tools run to test each mutant; defaults to this CLI's `bin.js`. */
  cliEntry?: string;
}

/**
 * `port-anything strength`: the corpus's mutation score against the candidate. A mutation tool
 * (cargo-mutants for a Rust candidate, Stryker for JS/TS, mull for C/C++, otherwise a generic
 * source mutator) makes mutants of the candidate, builds each one and runs the corpus on it; a
 * mutant is caught when some case the unmutated candidate matches now diverges. Prints the share
 * caught and the surviving mutants (behavior the corpus doesn't test). Exit code 0 when it ran, 3
 * when it couldn't (config, tools, a candidate that matches no case).
 *
 * `strength --check <spec>` is the internal step the tools run per mutant (see `checkCommand`).
 */
export async function strengthCommand(argv: readonly string[], options: StrengthOptions): Promise<CliResult> {
  if (argv[0] === '--check') return checkCommand(argv.slice(1));
  try {
    const args = parseStrengthArgs(argv);
    const config = await readConfigFile(options.cwd);
    const cases = await loadCommittedCases(options.cwd, new BlobStore(cacheDir(options.cwd)));
    return await measure({ projectDir: options.cwd, config, cases, args, cliEntry: options.cliEntry ?? defaultCliEntry(), ...(options.probe === undefined ? {} : { probe: options.probe }) });
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything strength: ${message}\n` });

/** `bin.js` next to this module once built; the running script otherwise (tests pass `cliEntry`). */
function defaultCliEntry(): string {
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
  return existsSync(bin) ? bin : resolve(process.argv[1] ?? bin);
}

/** What one mutant's check needs; written to a file that `strength --check` reads. */
export interface CheckSpec {
  /** The project whose config and committed cases to use. */
  project: string;
  /** The candidate's command, as configured. */
  candidate: string | string[];
  /** IDs of the cases to run: the ones the unmutated candidate matches. */
  cases: string[];
  noSandbox: boolean;
  /** Cases running at once within one check. */
  concurrency: number;
  /**
   * The candidate's source tree as configured, when the tool runs each check in a copy of it
   * (Stryker's sandbox): candidate paths under it are taken from the check's working directory.
   */
  root?: string;
  /**
   * Names of the variables that were set when `strength` started. With `passNewEnv`, every other
   * variable set at check time (how Stryker and mull switch a mutant on) reaches both sides.
   */
  hostEnv?: string[];
  passNewEnv?: boolean;
  /** A check that can't run appends why here, so it is reported as an error rather than a catch. */
  errors: string;
}

interface MeasureOptions {
  projectDir: string;
  config: Config;
  cases: readonly CanonicalCase[];
  args: StrengthArgs;
  cliEntry: string;
  probe?: SandboxProbe;
}

async function measure({ projectDir, config, cases, args, cliEntry, probe }: MeasureOptions): Promise<CliResult> {
  if (config.sandbox.mode === 'container') {
    throw new ConfigError('sandbox mode "container" is not available yet; set sandbox.mode to local.');
  }
  const candidates = configCandidates(config);
  const candidate = candidates[0];
  if (candidate === undefined) throw new ConfigError('No candidate to measure: set candidate in port-anything.yaml.');
  if (cases.length === 0) throw new ConfigError('No cases to run: add some to port-anything/recorded/*.jsonl.');

  // The cases the unmutated candidate matches: a mutant is caught when one of them diverges.
  const sideOptions = { noSandbox: args.noSandbox, ...(probe === undefined ? {} : { probe }) };
  const { runner, sandbox } = await prepareSides(projectDir, config, [candidate.cmd], sideOptions);
  const baselineDir = scratchDir(projectDir);
  let matching: string[];
  try {
    const result = await runCases({ ...runner, cases, workDir: baselineDir, rerun: false });
    matching = result.cases.filter((c) => c.candidates[0]!.comparison.verdict === 'match').map((c) => c.caseId);
  } finally {
    await removeScratch(projectDir, baselineDir);
  }
  if (matching.length === 0) {
    throw new ConfigError(`The candidate matches none of the ${cases.length} cases, so no mutant could be told apart; run port-anything run first.`);
  }

  const workDir = join(projectDir, '.port-anything', 'tmp', `strength-${randomBytes(6).toString('hex')}`);
  await mkdir(workDir, { recursive: true });
  try {
    const jobs = Math.max(1, Math.floor(availableParallelism() / 2));
    const spec: CheckSpec = {
      project: projectDir,
      candidate: typeof candidate.cmd === 'string' ? candidate.cmd : [...candidate.cmd],
      cases: matching,
      noSandbox: args.noSandbox,
      concurrency: Math.max(1, Math.floor(availableParallelism() / jobs)),
      hostEnv: Object.keys(process.env),
      errors: join(workDir, 'check-errors.log'),
    };
    const context: ToolContext = {
      projectDir,
      config,
      candidate: parseProgramCommand(candidate.cmd),
      ...(candidate.build === undefined ? {} : { build: candidate.build }),
      reference: parseProgramCommand(config.reference.cmd),
      workDir,
      spec,
      cliEntry,
      node: process.execPath,
      mutants: args.mutants,
      jobs,
      caseTimeoutMs: config.sandbox.timeout,
      check: (s, overrides) => runCheck(s, { ...overrides, ...(probe === undefined ? {} : { probe }) }),
    };
    const tool = await chooseTool(context);
    const run = await tool.run();
    const failures = existsSync(spec.errors) ? (await readFile(spec.errors, 'utf8')).trim() : '';
    if (failures !== '') throw new ConfigError(`Checking the mutants failed, so the score would be wrong:\n${failures}`);
    const score = scoreMutants(run.results);
    if (score.mutants === 0) throw new ConfigError(`${run.tool} found no mutant to test in the candidate${run.why === undefined ? '' : ` (${run.why})`}.`);

    const summary = {
      candidate: display(candidate.cmd),
      tool: run.tool,
      sandbox: sandbox.label,
      cases: { matching: matching.length, total: cases.length },
      generated: run.generated,
      ...score,
      notes: [...(candidates.length > 1 ? [`Measured the first of ${candidates.length} candidates.`] : []), ...tool.notes, ...run.notes],
    };
    if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };
    return { exitCode: 0, stdout: `${textReport(summary).join('\n')}\n`, stderr: '' };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rmdir(join(projectDir, '.port-anything', 'tmp')).catch(() => {}); // kept while a run uses it
  }
}

function textReport(s: StrengthScore & { candidate: string; tool: string; sandbox: string; cases: { matching: number; total: number }; generated: number; notes: string[] }): string[] {
  const counted = s.caught + s.missed + s.timeout;
  const lines = [
    s.score === null
      ? `corpus strength n/a: none of the ${s.mutants} mutants built`
      : `corpus strength ${percent(s.score)}: the corpus kills ${s.caught} of ${counted} mutants of the candidate`,
    `candidate ${s.candidate}, mutated with ${s.tool}, sandbox: ${s.sandbox}`,
    `${s.mutants} of ${s.generated} mutants tested${s.mutants < s.generated ? ' (a fixed sample; --mutants sets the size)' : ''}: ${s.caught} caught, ${s.missed} missed, ${s.timeout} timed out, ${s.unviable} unviable`,
    `on the ${s.cases.matching} of ${s.cases.total} cases the candidate matches`,
  ];
  if (s.survivors.length > 0) {
    lines.push(`surviving mutants (${s.survivors.length}), behavior the corpus doesn't test:`);
    for (const name of s.survivors) lines.push(`  ${name}`);
  }
  for (const note of s.notes) lines.push(`note: ${note}`);
  return lines;
}

/** Rounded down, as in `run`, so only a full score shows as 100.0%. */
const percent = (p: number) => `${(Math.floor(p * 1000 + 1e-9) / 10).toFixed(1)}%`;

/**
 * `strength --check <spec> [--executable <path>]`: runs the spec's cases on the candidate (with
 * `--executable` in place of its executable: the mutant the tool built) and stops at the first
 * divergence that a re-run of the case confirms. Exit code 0 when every case still matches (the mutant survives), 1 when one diverges
 * (caught), 3 when the check can't run; then it also appends why to the spec's error log.
 */
async function checkCommand(argv: readonly string[]): Promise<CliResult> {
  let spec: CheckSpec | undefined;
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: { executable: { type: 'string' } }, allowPositionals: true, strict: true });
    if (positionals.length !== 1) throw new ConfigError('Usage: port-anything strength --check <spec.json> [--executable <path>]');
    spec = JSON.parse(await readFile(positionals[0]!, 'utf8')) as CheckSpec;
    const verdict = await runCheck(spec, values.executable === undefined ? {} : { executable: values.executable });
    if (verdict.diverged === undefined) return { exitCode: 0, stdout: 'every case matches\n', stderr: '' };
    return { exitCode: 1, stdout: `case ${verdict.diverged.case} diverges: ${verdict.diverged.fields.join(', ')}\n`, stderr: '' };
  } catch (e) {
    const message = e instanceof ConfigError || e instanceof SandboxUnavailableError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (spec?.errors !== undefined) await appendFile(spec.errors, `${message.trimEnd()}\n`).catch(() => {});
    return fail(message);
  }
}

export interface CheckOverrides {
  /** Runs this file in place of the candidate's executable. */
  executable?: string;
  /** Reads the config and cases here rather than in `spec.project` (a copy of the project). */
  project?: string;
  probe?: SandboxProbe;
}

/** Runs the spec's cases on the (mutated) candidate until one diverges twice in a row. */
export async function runCheck(spec: CheckSpec, overrides: CheckOverrides = {}): Promise<{ diverged?: { case: string; fields: string[] } }> {
  const projectDir = overrides.project ?? spec.project;
  const config = await readConfigFile(projectDir);
  const wanted = new Set(spec.cases);
  const cases = (await loadCommittedCases(projectDir, new BlobStore(cacheDir(projectDir)))).filter((c) => wanted.has(c.id));
  if (cases.length !== wanted.size) throw new ConfigError(`The corpus changed while measuring: ${wanted.size - cases.length} of the cases to check are gone.`);

  const words = parseProgramCommand(spec.candidate);
  let command = [words.executable, ...(words.tool === undefined ? [] : [words.tool]), ...words.args];
  if (spec.root !== undefined) command = command.map((word) => fromRoot(word, spec.project, spec.root!, process.cwd()));
  if (overrides.executable !== undefined) command[0] = overrides.executable;

  const newEnv = spec.passNewEnv === true ? Object.keys(process.env).filter((name) => !(spec.hostEnv ?? []).includes(name)) : [];
  const sides = await prepareSides(projectDir, { ...config, sandbox: { ...config.sandbox, env_allowlist: [...config.sandbox.env_allowlist, ...newEnv] } }, [command], {
    noSandbox: spec.noSandbox,
    ...(overrides.probe === undefined ? {} : { probe: overrides.probe }),
  });
  const workDir = scratchDir(projectDir);
  const STOP = Symbol('diverged');
  let diverged: { case: string; fields: string[] } | undefined;
  try {
    const runner = await openCaseRunner({ ...sides.runner, workDir, rerun: false });
    await mapPool(cases, spec.concurrency, async (c, _index, slot) => {
      // A divergence counts once a re-run confirms it: a case that times out under the load of
      // parallel builds must not make a mutant look caught.
      for (let run = 0; run < 2; run++) {
        const result = await runner.run(c, slot);
        const comparison = result.candidates[0]!.comparison;
        if (comparison.verdict === 'match') return;
        if (run === 1) {
          diverged ??= { case: c.id, fields: comparison.fields };
          throw STOP; // no new case starts
        }
      }
    }).catch((e: unknown) => {
      if (e !== STOP) throw e;
    });
  } finally {
    await removeScratch(projectDir, workDir);
  }
  return diverged === undefined ? {} : { diverged };
}

/** A word of the candidate's command that names a path under `root` (relative to `project`), taken from `cwd` instead. */
function fromRoot(word: string, project: string, root: string, cwd: string): string {
  const path = isAbsolute(word) ? word : resolve(project, word);
  const inside = relative(root, path);
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return word;
  if (!isAbsolute(word) && !word.includes('/') && !existsSync(path)) return word; // a bare name or option, not a path
  return join(cwd, inside);
}
