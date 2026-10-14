import { randomBytes } from 'node:crypto';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, parseProgramCommand, resolveProgram, type ResolvedProgram } from '@port-anything/core';

/** What a CLI command returns: the exit code and what to print. */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A program from the config or the command line; relative paths start at the project directory. */
export async function resolveCommand(cmd: string | readonly string[], projectDir: string): Promise<ResolvedProgram> {
  try {
    return await resolveProgram(parseProgramCommand(cmd), { cwd: projectDir });
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

/**
 * Runs `use` with a fresh scratch directory inside the project rather than /tmp, which may be
 * mounted noexec, and removes it afterwards.
 */
export async function withScratchDir<T>(projectDir: string, label: string, use: (dir: string) => Promise<T>): Promise<T> {
  const workDir = join(projectDir, '.port-anything', 'tmp', `${label}-${randomBytes(6).toString('hex')}`);
  try {
    return await use(workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rmdir(join(projectDir, '.port-anything', 'tmp')).catch(() => {}); // kept while another command uses it
  }
}

/** A command as the user wrote it; an argv list is shown with quotes around words with spaces. */
export function display(cmd: string | readonly string[]): string {
  return typeof cmd === 'string' ? cmd : cmd.map((w) => (/[\s'"]/.test(w) || w === '' ? `'${w}'` : w)).join(' ');
}
