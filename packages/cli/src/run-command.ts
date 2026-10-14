import { randomBytes } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BlobStore,
  ConfigError,
  SandboxUnavailableError,
  cacheDir,
  chooseSandbox,
  configCandidates,
  parseProgramCommand,
  probeSandbox,
  resolveProgram,
  runCases,
  shortCaseId,
  type CanonicalCase,
  type Config,
  type SandboxProbe,
} from '@port-anything/core';

/** What a CLI command returns: the exit code and what to print. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

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
 * diverge (exact comparison). Exit code 0 when every candidate matches on every case, 1 when any
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
  if (cases.length === 0) throw new ConfigError('No cases to run.');

  const resolve = async (cmd: string | readonly string[]) => {
    try {
      return await resolveProgram(parseProgramCommand(cmd), { cwd: projectDir });
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
  };
  const reference = await resolve(config.reference.cmd);
  const candidates = await Promise.all(commands.map(resolve));
  const sandbox = chooseSandbox(probe ?? (await probeSandbox()), { noSandbox: args.noSandbox });

  // Scratch space inside the project rather than /tmp, which may be mounted noexec.
  const workDir = join(projectDir, '.port-anything', 'tmp', `run-${randomBytes(6).toString('hex')}`);
  let result;
  try {
    result = await runCases({
      reference,
      candidates,
      cases,
      store: new BlobStore(cacheDir(projectDir)),
      sandbox,
      workDir,
      ...(config.program_name === undefined ? {} : { programName: config.program_name }),
      timeoutMs: config.sandbox.timeout,
      envAllowlist: config.sandbox.env_allowlist,
      env: config.sandbox.env,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rmdir(join(projectDir, '.port-anything', 'tmp')).catch(() => {}); // kept while another run uses it
  }

  const summary = {
    program_name: result.programName,
    sandbox: sandbox.label,
    reference: display(config.reference.cmd),
    cases: result.cases.length,
    candidates: commands.map((command, i) => {
      const divergences = result.cases
        .filter((c) => c.candidates[i]!.comparison.verdict === 'diverge')
        .map((c) => ({ case: c.caseId, fields: c.candidates[i]!.comparison.fields }));
      return { command: display(command), match: result.cases.length - divergences.length, diverge: divergences.length, divergences };
    }),
  };
  const exitCode = summary.candidates.some((c) => c.diverge > 0) ? 1 : 0;
  if (args.json) return { exitCode, stdout: `${JSON.stringify(summary, null, 2)}\n`, stderr: '' };

  const lines = [`Ran ${summary.cases} cases as "${summary.program_name}", sandbox: ${summary.sandbox}`, `reference ${summary.reference}`];
  for (const [i, c] of summary.candidates.entries()) {
    lines.push(`candidate ${i + 1} ${c.command}: ${c.match} of ${summary.cases} cases match${c.diverge > 0 ? `, ${c.diverge} diverge` : ''}`);
    for (const d of c.divergences) lines.push(`  ${shortCaseId(d.case)}  ${d.fields.join(', ')}`);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

/** A command as the user wrote it; an argv list is shown with quotes around words with spaces. */
function display(cmd: string | readonly string[]): string {
  return typeof cmd === 'string' ? cmd : cmd.map((w) => (/[\s'"]/.test(w) || w === '' ? `'${w}'` : w)).join(' ');
}
