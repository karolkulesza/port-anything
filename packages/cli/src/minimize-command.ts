import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  DEFAULT_MINIMIZE_RUNS,
  SandboxUnavailableError,
  describeSignature,
  inlineCase,
  minimizeCluster,
  openCaseRunner,
  readConfigFile,
  resolveCluster,
  reproPath,
  saveRepro,
  shortCaseId,
  signatureKey,
  type CanonicalCase,
  type Config,
  type InlineContent,
  type SandboxProbe,
} from '@port-anything/core';
import { loadCorpus } from './corpus.js';
import { clusterCases, display, prepareSides, removeScratch, scratchDir, type CliResult } from './run-command.js';

/** The options of `port-anything minimize`. */
export interface MinimizeArgs {
  /** `[<run-id>/]<n>`: the cluster to minimize, in the latest run of the whole corpus unless a run is named. */
  cluster: string;
  json: boolean;
  noSandbox: boolean;
}

export const USAGE = 'Usage: port-anything minimize [<run-id>/]<cluster> [--json] [--no-sandbox]';

/** Reads the arguments after `minimize`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseMinimizeArgs(argv: readonly string[]): MinimizeArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { json: { type: 'boolean' }, 'no-sandbox': { type: 'boolean' } }, strict: true, allowPositionals: true });
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw new ConfigError(`${positionals.length === 0 ? 'Which cluster?' : 'Give one cluster.'}\n${USAGE}`);
  return { cluster: positionals[0]!, json: values.json ?? false, noSandbox: values['no-sandbox'] ?? false };
}

/** `port-anything minimize` in a project directory: reads `port-anything.yaml` and the committed cases, then minimizes (see `executeMinimize`). */
export async function minimizeCommand(argv: readonly string[], options: { cwd: string; probe?: SandboxProbe }): Promise<CliResult> {
  let prepared: ExecuteMinimizeOptions;
  try {
    const args = parseMinimizeArgs(argv);
    const config = await readConfigFile(options.cwd);
    const cases = await loadCorpus(options.cwd, config, { noSandbox: args.noSandbox, ...(options.probe === undefined ? {} : { probe: options.probe }) });
    prepared = { projectDir: options.cwd, config, cases, args, ...(options.probe === undefined ? {} : { probe: options.probe }) };
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
  return executeMinimize(prepared);
}

export interface ExecuteMinimizeOptions {
  /** Holds `.port-anything/`; relative program paths in the config start here. */
  projectDir: string;
  config: Config;
  /** The corpus; its stdin and fixtures must already be in the project's blob store. */
  cases: readonly CanonicalCase[];
  args: MinimizeArgs;
  /** The sandbox probe's result; probed on this machine when absent. */
  probe?: SandboxProbe;
}

/**
 * Minimizes a saved cluster: from its smallest case, delta-debugs argv tokens, fixtures and stdin
 * down to the smallest case that still diverges with the cluster's signature, running the
 * reference and the cluster's candidate (at most `DEFAULT_MINIMIZE_RUNS` runs), and saves the
 * result as the cluster's repro, `.port-anything/runs/<run-id>/repros/<n>.json`. Exit code 1 when
 * the repro shows the divergence, 0 when no case of the cluster diverges that way any more (fixed,
 * or flaky), 3 when it can't start.
 */
export async function executeMinimize(options: ExecuteMinimizeOptions): Promise<CliResult> {
  try {
    return await execute(options);
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SandboxUnavailableError) return fail(e.message);
    throw e;
  }
}

const fail = (message: string): CliResult => ({ exitCode: 3, stdout: '', stderr: `port-anything minimize: ${message}\n` });

async function execute({ projectDir, config, cases, args, probe }: ExecuteMinimizeOptions): Promise<CliResult> {
  if (config.sandbox.mode === 'container') {
    throw new ConfigError('sandbox mode "container" is not available yet; set sandbox.mode to local.');
  }
  const target = await resolveCluster(projectDir, args.cluster);
  const clusterOf = await clusterCases(projectDir, target, cases);
  const command = target.run.candidate_commands[target.cluster.candidate - 1]!;
  const { runner: runnerOptions } = await prepareSides(projectDir, config, [command], { noSandbox: args.noSandbox, ...(probe === undefined ? {} : { probe }) });
  const store = runnerOptions.store;
  const workDir = scratchDir(projectDir);
  let result;
  let programName;
  try {
    const runner = await openCaseRunner({ ...runnerOptions, workDir, rerun: false });
    programName = runner.programName;
    result = await minimizeCluster({ runner, key: signatureKey(target.cluster.signature), cases: clusterOf, store, maxRuns: DEFAULT_MINIMIZE_RUNS });
  } finally {
    await removeScratch(projectDir, workDir);
  }
  const repro = await saveRepro(projectDir, {
    run_id: target.run.run_id,
    cluster: target.cluster.cluster,
    source: result.source,
    reproduced: result.reproduced,
    runs: result.runs,
    max_runs: DEFAULT_MINIMIZE_RUNS,
    exhausted: result.exhausted,
    case: await inlineCase(result.case, store),
  });
  const file = relative(projectDir, reproPath(projectDir, repro.run_id, repro.cluster));
  const exitCode = repro.reproduced ? 1 : 0;
  const summary = { address: target.address, candidate: display(command), signature: target.cluster.signature, program_name: programName, file, ...repro };
  if (args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };

  const lines = [`cluster ${summary.address} · candidate ${target.cluster.candidate} ${summary.candidate} · ${describeSignature(summary.signature)}`];
  if (!repro.reproduced) {
    lines.push(
      `No case of the cluster diverges this way any more (${repro.runs} run${repro.runs === 1 ? '' : 's'}): fixed since the run, or flaky. Run port-anything run for new clusters.`,
    );
  } else {
    lines.push(
      repro.exhausted
        ? `minimized ${shortCaseId(repro.source)} until the run budget (${repro.max_runs}) ran out; a smaller repro may exist`
        : `minimized ${shortCaseId(repro.source)} in ${repro.runs} run${repro.runs === 1 ? '' : 's'}`,
    );
    lines.push(`repro: ${[programName, ...repro.case.argv].map(shellWord).join(' ')}`);
    for (const [name, value] of Object.entries(repro.case.env)) lines.push(`  env ${name}=${JSON.stringify(value)}`);
    for (const [path, content] of Object.entries(repro.case.fixtures)) lines.push(`  file ${path}: ${showContent(content)}`);
    if (repro.case.stdin !== null) lines.push(`  stdin: ${showContent(repro.case.stdin)}`);
  }
  lines.push(`saved ${file}`);
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** A word as a POSIX shell would need it written. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Inline content for the terminal: text as a JSON string, so control characters show. */
function showContent(content: InlineContent): string {
  return typeof content === 'string' ? JSON.stringify(content) : `base64 ${content.base64}`;
}
