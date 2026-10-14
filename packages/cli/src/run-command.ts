import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  SandboxUnavailableError,
  cacheDir,
  chooseSandbox,
  configCandidates,
  loadCommittedCases,
  normalizerLabel,
  probeSandbox,
  readBaselineRecord,
  readConfigFile,
  runCases,
  shortCaseId,
  type CanonicalCase,
  type Config,
  type SandboxProbe,
} from '@port-anything/core';
import { display, resolveCommand, withScratchDir, type CliResult } from './common.js';

export type { CliResult } from './common.js';

/** The options of `port-anything run` this version understands. */
export interface RunArgs {
  /** `--candidate <cmd>`, repeatable; replaces the configured candidates. */
  candidates: string[];
  json: boolean;
  noSandbox: boolean;
}

// Documented options that later versions add.
const NOT_YET = ['smoke', 'feature', 'cluster', 'all', 'holdout'];

/** Reads the arguments after `run`. Throws a `ConfigError` (exit 3) for anything it doesn't know. */
export function parseRunArgs(argv: readonly string[]): RunArgs {
  const later = NOT_YET.find((name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)));
  if (later !== undefined) throw new ConfigError(`--${later} is not available yet in this version of port-anything run.`);
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        candidate: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        'no-sandbox': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
    return { candidates: values.candidate ?? [], json: values.json ?? false, noSandbox: values['no-sandbox'] ?? false };
  } catch (e) {
    throw new ConfigError(`${(e as Error).message}\nUsage: port-anything run [--candidate <cmd>]… [--json] [--no-sandbox]`);
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
 * diverge (exact comparison after the configured normalizers), and how many cases each normalizer
 * changed. Exit code 0 when every candidate matches on every case, 1 when any
 * case diverges, 3 when the run can't start (config, programs, sandbox).
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
  const commands = args.candidates.length > 0 ? args.candidates : configCandidates(config).map((c) => c.cmd);
  if (commands.length === 0) {
    throw new ConfigError('No candidate to run: set candidate (or candidates) in port-anything.yaml, or pass --candidate <cmd>.');
  }
  if (cases.length === 0) throw new ConfigError('No cases to run: add some to port-anything/recorded/*.jsonl.');

  const reference = await resolveCommand(config.reference.cmd, projectDir);
  const candidates = await Promise.all(commands.map((cmd) => resolveCommand(cmd, projectDir)));
  const sandbox = chooseSandbox(probe ?? (await probeSandbox()), { noSandbox: args.noSandbox });

  // Cases whose reference output varied in the last baseline are left out of the comparison and listed.
  const flaky = new Map((await readBaselineRecord(projectDir))?.flaky_reference.map((f) => [f.case, f.fields]));
  const flakyReference = cases.filter((c) => flaky.has(c.id)).map((c) => ({ case: c.id, fields: flaky.get(c.id)! }));
  const result = await withScratchDir(projectDir, 'run', (workDir) =>
    runCases({
      reference,
      candidates,
      cases: cases.filter((c) => !flaky.has(c.id)),
      store: new BlobStore(cacheDir(projectDir)),
      sandbox,
      workDir,
      ...(config.program_name === undefined ? {} : { programName: config.program_name }),
      timeoutMs: config.sandbox.timeout,
      envAllowlist: config.sandbox.env_allowlist,
      env: config.sandbox.env,
      normalizers: config.normalizers,
    }),
  );

  // Per normalizer, the cases where it changed either side of a comparison (of any candidate, or of one).
  const changed = (candidate?: number) =>
    config.normalizers.map((spec, n) => ({
      normalizer: normalizerLabel(spec),
      cases: result.cases.filter((c) => c.candidates.some((run, i) => (candidate === undefined || i === candidate) && run.normalizedBy.includes(n))).length,
    }));
  const summary = {
    program_name: result.programName,
    sandbox: sandbox.label,
    reference: display(config.reference.cmd),
    cases: result.cases.length,
    flaky_reference: flakyReference,
    normalizers: changed(),
    candidates: commands.map((command, i) => {
      const divergences = result.cases
        .filter((c) => c.candidates[i]!.comparison.verdict === 'diverge')
        .map((c) => ({ case: c.caseId, fields: c.candidates[i]!.comparison.fields }));
      return { command: display(command), match: result.cases.length - divergences.length, diverge: divergences.length, normalizers: changed(i), divergences };
    }),
  };
  const exitCode = summary.candidates.some((c) => c.diverge > 0) ? 1 : 0;
  if (args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };

  const lines = [`Ran ${summary.cases} case${summary.cases === 1 ? '' : 's'} as "${summary.program_name}", sandbox: ${summary.sandbox}`, `reference ${summary.reference}`];
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
    for (const d of c.divergences) lines.push(`  ${shortCaseId(d.case)}  ${d.fields.join(', ')}`);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
