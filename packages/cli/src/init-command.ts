import { parseArgs } from 'node:util';
import { ConfigError, initProject, type InitStep } from '@port-anything/core';
import type { CliResult } from './run-command.js';

export const USAGE = 'Usage: port-anything init <dir> --ref <cmd> [--candidate <cmd>]…';

/**
 * `port-anything init <dir> --ref <cmd> [--candidate <cmd>]…`: sets up a project directory (see
 * `initProject`) and lists what it wrote. Run again in a set-up project, without `--ref`, it only
 * adds what is missing. Exit code 0, or 3 for bad arguments or what it can't write.
 */
export async function initCommand(argv: readonly string[], options: { cwd: string }): Promise<CliResult> {
  try {
    if (argv.some((arg) => arg === '--ci' || arg.startsWith('--ci='))) throw new ConfigError('--ci is not available yet in this version of port-anything init.');
    let parsed;
    try {
      parsed = parseArgs({
        args: [...argv],
        options: { ref: { type: 'string' }, candidate: { type: 'string', multiple: true } },
        strict: true,
        allowPositionals: true,
      });
    } catch (e) {
      throw new ConfigError(`${(e as Error).message}\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    if (positionals.length !== 1) throw new ConfigError(`Give one project directory.\n${USAGE}`);
    const dir = positionals[0]!;
    const steps = await initProject(dir, {
      ...(values.ref === undefined ? {} : { reference: values.ref }),
      candidates: values.candidate ?? [],
      cwd: options.cwd,
    });
    const lines = [`Set up ${dir}:`, ...steps.map(describe)];
    if (steps[0]!.action === 'created') lines.push('Next: add cases to port-anything/recorded/*.jsonl, then run port-anything run.');
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof ConfigError) return { exitCode: 3, stdout: '', stderr: `port-anything init: ${e.message}\n` };
    throw e;
  }
}

function describe(step: InitStep): string {
  if (step.action === 'unchanged') return `  ${step.path}: already there`;
  if (step.added === undefined) return `  ${step.path}: ${step.action}`;
  return `  ${step.path}: ${step.action === 'created' ? 'created with' : 'added'} ${step.added.join(', ')}`;
}
