import { baselineCommand } from './baseline-command.js';
import { compareCommand } from './compare-command.js';
import { minimizeCommand } from './minimize-command.js';
import { reportCommand } from './report-command.js';
import { runCommand } from './run-command.js';
import { waiveCommand } from './waive-command.js';
import { specCommand } from './spec-command.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** The project directory; defaults to the current directory. */
  cwd?: string;
  /** Gets a line as each stage of a long command starts. */
  progress?: (line: string) => void;
}

const NOTICE = `port-anything: rewrite it in any language and show nothing changed.

Usage: port-anything compare '<ref cmd>' '<candidate cmd>'… [--budget 500] [--save] [--json] [--i-know] [--no-sandbox]
       port-anything spec infer [--no-sandbox]
       port-anything baseline [--repeats N] [--no-sandbox]
       port-anything run [--candidate <cmd>]… [--json] [--no-sandbox]

Exit codes: 0 all good, 1 divergences, 3 config or usage error.
Docs: https://github.com/karolkulesza/port-anything
`;

/**
 * Runs the CLI with the given arguments (without the node and script paths). An unexpected error
 * exits 3 rather than crashing, since a crash's exit code 1 would read as "divergences found".
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  try {
    return await dispatch(argv, options);
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    return { exitCode: 3, stdout: '', stderr: `port-anything: internal error, the run did not finish:\n${detail}\n` };
  }
}

async function dispatch(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return { exitCode: 0, stdout: NOTICE, stderr: '' };
  if (command === 'compare') {
    return compareCommand(rest, { cwd: options.cwd ?? process.cwd(), ...(options.progress === undefined ? {} : { progress: options.progress }) });
  }
  if (command === 'run') return runCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'minimize') return minimizeCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'spec') return specCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'baseline') return baselineCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'waive') return waiveCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'report') return reportCommand(rest, { cwd: options.cwd ?? process.cwd() });
  return { exitCode: 3, stdout: '', stderr: `port-anything: "${command}" is not available yet in this version; only "compare", "run", "minimize", "baseline", "waive", "report" and "spec infer" are.\n` };
}
