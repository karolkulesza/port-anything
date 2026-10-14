import { basename } from 'node:path';
import { ConfigError } from './config.js';
import { MULTICALL_BINARIES } from './program.js';

/**
 * Tools that delete or overwrite data, wipe disks, end processes or raise privileges. Generated
 * argv for them refuses to run without `--i-know`, sandbox or not. `mkfs` covers `mkfs.<type>`.
 */
export const DESTRUCTIVE_TOOLS: readonly string[] = Object.freeze([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe', 'wipefs', 'dd', 'mkfs', 'mke2fs', 'mkswap', 'newfs',
  'fdisk', 'sfdisk', 'gdisk', 'cfdisk', 'parted', 'blkdiscard', 'diskutil',
  'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'halt', 'poweroff',
  'sudo', 'doas', 'su',
]);

/**
 * Subcommands that delete history, files or remote state, or publish something: the tool, then
 * the subcommand path. docker and podman are judged by `CONTAINER_VERBS` instead.
 */
export const DESTRUCTIVE_SUBCOMMANDS: readonly (readonly string[])[] = Object.freeze(
  [
    ['git', 'push'], ['git', 'clean'], ['git', 'reset'], ['git', 'rm'], ['git', 'gc'], ['git', 'prune'],
    ['git', 'filter-branch'], ['git', 'filter-repo'], ['git', 'update-ref'], ['git', 'send-email'],
    ['hg', 'push'], ['hg', 'strip'], ['hg', 'purge'],
    ['kubectl', 'delete'], ['npm', 'publish'], ['npm', 'unpublish'], ['cargo', 'publish'], ['cargo', 'yank'],
  ].map((path) => Object.freeze(path)),
);

/** Tools that act on the host's container daemon, outside any sandbox. */
export const CONTAINER_TOOLS: readonly string[] = Object.freeze(['docker', 'podman']);

/**
 * A subcommand word that deletes, stops or publishes under docker and podman, at any depth:
 * `docker rm`, `docker system prune`, `docker compose down`, `podman volume remove`.
 */
export const CONTAINER_VERBS: readonly string[] = Object.freeze(['rm', 'rmi', 'remove', 'prune', 'push', 'kill', 'stop', 'down', 'reset']);

// Object groups of docker/podman commands, used only to name what was matched.
const CONTAINER_GROUPS = new Set(['container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'compose', 'pod', 'manifest', 'machine', 'context']);

// GNU coreutils installed with a `g` prefix (Homebrew on macOS): `grm`, `gshred`.
const GNU_PREFIXED = new Set(['rm', 'rmdir', 'unlink', 'shred', 'dd']);
const TOOLS = new Set(DESTRUCTIVE_TOOLS);

function destructiveTool(name: string): string | null {
  if (TOOLS.has(name)) return name;
  if (name.startsWith('mkfs.')) return 'mkfs';
  if (name.startsWith('g') && GNU_PREFIXED.has(name.slice(1))) return name.slice(1);
  return null;
}

/**
 * The destructive subcommand among `words` (subcommand names, no flags), or null. `anywhere`
 * lets a denylisted path start at any word; otherwise it must start at the first.
 */
function destructivePath(name: string, words: readonly string[], anywhere: boolean): string | null {
  if (CONTAINER_TOOLS.includes(name)) {
    const verb = words.findIndex((word) => CONTAINER_VERBS.includes(word));
    if (verb === -1) return null;
    if (!anywhere) return [name, ...words.slice(0, verb + 1)].join(' ');
    // Words before the verb may be flag values (`--context c`); name only an object group.
    const group = verb > 0 && CONTAINER_GROUPS.has(words[verb - 1]!) ? [words[verb - 1]!] : [];
    return [name, ...group, words[verb]!].join(' ');
  }
  const starts = anywhere ? words.length : Math.min(words.length, 1);
  for (const [t, ...path] of DESTRUCTIVE_SUBCOMMANDS) {
    if (t !== name) continue;
    for (let i = 0; i < starts && i + path.length <= words.length; i++) {
      if (path.every((word, j) => words[i + j] === word)) return [name, ...path].join(' ');
    }
  }
  return null;
}

/**
 * What makes a command line destructive: the denylisted tool (`rm`) or tool and subcommand, or
 * null. `argv[0]` may be a path; a multicall binary (`busybox rm`) is judged by its applet. A
 * subcommand matches anywhere among the arguments that aren't flags, so a flag value before it
 * (`git -C dir <subcommand>`) can't hide it; this errs on the side of refusing.
 */
export function destructiveCommand(argv: readonly string[]): string | null {
  if (argv.length === 0) return null;
  let rest = argv.slice(1);
  let name = basename(argv[0]!);
  if (MULTICALL_BINARIES.includes(name) && rest.length > 0) {
    name = basename(rest[0]!);
    rest = rest.slice(1);
  }
  return destructiveTool(name) ?? destructivePath(name, rest.filter((arg) => !arg.startsWith('-')), true);
}

/**
 * Like `destructiveCommand` for a known subcommand path (from a CLI spec, so no flags): a
 * denylisted path must start it, so `git stash push` and `git remote prune` are not refused.
 */
export function destructiveSubcommand(program: string, path: readonly string[]): string | null {
  const name = basename(program);
  // A multicall binary's subcommands are its applets: `busybox rm`.
  if (MULTICALL_BINARIES.includes(name) && path.length > 0) {
    return destructiveTool(basename(path[0]!)) ?? destructivePath(basename(path[0]!), path.slice(1), false);
  }
  return destructivePath(name, path, false);
}

/** A denylisted tool or subcommand, refused because `--i-know` wasn't given. A config error (exit 3). */
export class DestructiveToolError extends ConfigError {
  constructor(readonly command: string) {
    super(
      `Refusing to generate and run cases for "${command}": it is on the list of destructive tools and subcommands. ` +
        'Pass --i-know to run it anyway (inside the sandbox).',
    );
  }
}

/** Throws a `DestructiveToolError` for a denylisted command line unless `iKnow` is set. */
export function assertNotDestructive(argv: readonly string[], options: { iKnow?: boolean } = {}): void {
  if (options.iKnow === true) return;
  const command = destructiveCommand(argv);
  if (command !== null) throw new DestructiveToolError(command);
}
