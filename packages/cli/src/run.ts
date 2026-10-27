import { baselineCommand, USAGE as BASELINE_USAGE } from './baseline-command.js';
import { compareCommand, USAGE as COMPARE_USAGE } from './compare-command.js';
import { generateCommand, USAGE as GENERATE_USAGE } from './generate-command.js';
import { minimizeCommand, USAGE as MINIMIZE_USAGE } from './minimize-command.js';
import { reportCommand, USAGE as REPORT_USAGE } from './report-command.js';
import { hookCommand, USAGE as HOOK_USAGE } from './hook-command.js';
import { initCommand, USAGE as INIT_USAGE } from './init-command.js';
import { mcpCommand, USAGE as MCP_USAGE } from './mcp-command.js';
import { runCommand, USAGE as RUN_USAGE } from './run-command.js';
import { setupCommand, USAGE as SETUP_USAGE } from './setup-command.js';
import { waiveCommand, USAGE as WAIVE_USAGE } from './waive-command.js';
import { specCommand, USAGE as SPEC_USAGE } from './spec-command.js';
import { strengthCommand, USAGE as STRENGTH_USAGE } from './strength-command.js';
import { verifyCommand, USAGE as VERIFY_USAGE } from './verify-command.js';
import { TOOL_VERSION } from './version.js';

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

// Each command's own usage line, so the overview can't drift from what the command accepts.
const USAGES = [COMPARE_USAGE, INIT_USAGE, SETUP_USAGE, SPEC_USAGE, GENERATE_USAGE, BASELINE_USAGE, RUN_USAGE, MINIMIZE_USAGE, REPORT_USAGE, WAIVE_USAGE, VERIFY_USAGE, STRENGTH_USAGE, MCP_USAGE, HOOK_USAGE, 'Usage: port-anything --version'];

const NOTICE = `port-anything: check that a rewrite still behaves like the original.

${USAGES.map((usage, i) => (i === 0 ? usage : usage.replace(/^Usage:/, '      '))).join('\n')}

Exit codes: 0 all good, 1 divergences, 2 integrity broken (verify), 3 config or usage error.
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
  if (command === '--version' || command === '-V') return { exitCode: 0, stdout: `port-anything ${TOOL_VERSION}\n`, stderr: '' };
  if (command === 'compare') {
    return compareCommand(rest, { cwd: options.cwd ?? process.cwd(), ...(options.progress === undefined ? {} : { progress: options.progress }) });
  }
  if (command === 'run') return runCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'init') return initCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'minimize') return minimizeCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'spec') return specCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'generate') return generateCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'baseline') return baselineCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'waive') return waiveCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'report') return reportCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'verify') return verifyCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'strength') return strengthCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'mcp') return mcpCommand(rest, { cwd: options.cwd ?? process.cwd() });
  if (command === 'setup') return setupCommand(rest);
  if (command === 'hook') return hookCommand(rest);
  return { exitCode: 3, stdout: '', stderr: `port-anything: "${command}" is not available yet in this version; only "init", "setup", "compare", "spec infer", "generate", "baseline", "run", "minimize", "waive", "report", "verify", "strength", "mcp" and "hook" are.\n` };
}
