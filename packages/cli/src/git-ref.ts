import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError } from '@port-anything/core';

const exec = promisify(execFile);

/** Lines of a failed build's output shown in the error. */
const BUILD_TAIL_LINES = 20;

/** `--ref git:<rev>`: the revision, or undefined for any other value. */
export function parseGitRef(value: string): string | undefined {
  const match = /^git:(.+)$/s.exec(value);
  return match === null ? undefined : match[1];
}

/** A commit checked out in a temporary worktree. */
export interface GitCheckout {
  /** The revision as given (`HEAD~1`). */
  rev: string;
  /** The full commit hash it named when checked out. */
  commit: string;
  /** The top of the temporary worktree. */
  worktree: string;
  /** The directory in the worktree that matches the directory the command ran from. */
  projectDir: string;
  /** The top of the repository the worktree belongs to. */
  repoTop: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw new ConfigError('--ref git:<rev> needs git, which is not on the PATH.');
    throw new ConfigError(`git ${args.join(' ')} failed: ${(err.stderr ?? err.message).trim()}`);
  }
}

/**
 * Checks out `rev` of the repository holding `cwd` in a new worktree (detached, so no branch is
 * created or moved). The working copy of `cwd` is left alone, uncommitted changes included. The
 * worktree goes in the repository's git directory rather than the system's temporary directory:
 * that is visible inside the sandbox wherever the working copy is (bwrap hides /tmp), so files the
 * reference loads from next to itself are there too, and it is never mounted noexec. Remove it
 * with `removeCheckout`.
 */
export async function checkoutRev(cwd: string, rev: string): Promise<GitCheckout> {
  let repoTop: string;
  try {
    repoTop = await realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
  } catch (e) {
    throw new ConfigError(`--ref git:${rev} needs a git repository, and ${cwd} is not in one (${(e as Error).message}).`);
  }
  let commit: string;
  try {
    commit = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  } catch {
    throw new ConfigError(`--ref git:${rev}: "${rev}" names no commit in ${repoTop}.`);
  }
  const gitDir = await git(repoTop, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const worktree = await realpath(await mkdtemp(join(gitDir, 'port-anything-ref-')));
  try {
    await git(repoTop, ['worktree', 'add', '--detach', '--quiet', worktree, commit]);
  } catch (e) {
    await rm(worktree, { recursive: true, force: true });
    throw e;
  }
  const projectDir = join(worktree, relative(repoTop, await realpath(cwd)));
  return { rev, commit, worktree, projectDir, repoTop };
}

/** Removes a worktree made by `checkoutRev`, and git's record of it. */
export async function removeCheckout(checkout: Pick<GitCheckout, 'worktree' | 'repoTop'>): Promise<void> {
  try {
    await git(checkout.repoTop, ['worktree', 'remove', '--force', checkout.worktree]);
  } catch {
    // Build output git can't remove (read-only files, say): remove the files, then git's record.
    await rm(checkout.worktree, { recursive: true, force: true });
    await git(checkout.repoTop, ['worktree', 'prune']).catch(() => {});
  }
}

/** Runs `reference.build` with `sh -c` in `dir`; a failed build is a `ConfigError` with the end of its output. */
export async function runBuild(build: string, dir: string): Promise<void> {
  try {
    await exec('sh', ['-c', build], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string | null };
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trimEnd().split('\n').slice(-BUILD_TAIL_LINES);
    const status = typeof err.code === 'number' ? `exit code ${err.code}` : err.signal ? `signal ${err.signal}` : err.message;
    throw new ConfigError([`reference.build failed (${status}): ${build}`, ...output.filter((l) => l !== '').map((l) => `  ${l}`)].join('\n'));
  }
}

/** Whether `path` is `dir` or inside it. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
