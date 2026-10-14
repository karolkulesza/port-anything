import { runCommand } from './run-command.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** The project directory; defaults to the current directory. */
  cwd?: string;
}

const NOTICE = `port-anything: rewrite it in any language and show nothing changed.

Not released yet. Follow progress at https://github.com/karolkulesza/port-anything
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
  if (command === 'run') return runCommand(rest, { cwd: options.cwd ?? process.cwd() });
  return { exitCode: 3, stdout: '', stderr: `port-anything: "${command}" is not available yet in this version; only "run" is.\n` };
}
