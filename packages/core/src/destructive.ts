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

// docker/podman object commands that delete or publish: `docker image rm`, `podman system prune`.
const CONTAINER_OBJECTS = ['container', 'image', 'volume', 'network', 'system', 'builder', 'pod', 'manifest'];
const containerPaths = (tool: string): string[][] => [
  [tool, 'rm'], [tool, 'rmi'], [tool, 'push'], [tool, 'kill'],
  ...CONTAINER_OBJECTS.flatMap((object) => [[tool, object, 'rm'], [tool, object, 'prune'], [tool, object, 'push']]),
];

/**
 * Subcommands that delete history, files or remote state, or publish something: the tool, then
 * the subcommand path (`docker system prune`).
 */
export const DESTRUCTIVE_SUBCOMMANDS: readonly (readonly string[])[] = Object.freeze(
  [
    ['git', 'push'], ['git', 'clean'], ['git', 'reset'], ['git', 'rm'], ['git', 'gc'], ['git', 'prune'],
    ['git', 'filter-branch'], ['git', 'filter-repo'], ['git', 'update-ref'], ['git', 'send-email'],
    ['hg', 'push'], ['hg', 'strip'], ['hg', 'purge'],
    ...containerPaths('docker'), ...containerPaths('podman'),
    ['kubectl', 'delete'], ['npm', 'publish'], ['npm', 'unpublish'], ['cargo', 'publish'], ['cargo', 'yank'],
  ].map((path) => Object.freeze(path)),
);

// GNU coreutils installed with a `g` prefix (Homebrew on macOS): `grm`, `gshred`.
const GNU_PREFIXED = new Set(['rm', 'rmdir', 'unlink', 'shred', 'dd']);
const TOOLS = new Set(DESTRUCTIVE_TOOLS);
// So `docker container rm` is reported as itself, not as `docker rm`.
const LONGEST_FIRST = [...DESTRUCTIVE_SUBCOMMANDS].sort((a, b) => b.length - a.length);

function destructiveTool(name: string): string | null {
  if (TOOLS.has(name)) return name;
  if (name.startsWith('mkfs.')) return 'mkfs';
  if (name.startsWith('g') && GNU_PREFIXED.has(name.slice(1))) return name.slice(1);
  return null;
}

/**
 * What makes a command line destructive: the denylisted tool (`rm`) or tool and subcommand path
 * (`git push`, `docker system prune`), or null. `argv[0]` may be a path; a multicall binary
 * (`busybox rm`) is judged by its applet. A subcommand path matches anywhere among the arguments
 * that aren't flags, so a flag value before it (`git -C dir push`) can't hide it; this errs on the
 * side of refusing (`git log push` matches too).
 */
export function destructiveCommand(argv: readonly string[]): string | null {
  if (argv.length === 0) return null;
  let rest = argv.slice(1);
  let name = basename(argv[0]!);
  if (MULTICALL_BINARIES.includes(name) && rest.length > 0) {
    name = basename(rest[0]!);
    rest = rest.slice(1);
  }
  const tool = destructiveTool(name);
  if (tool !== null) return tool;
  const words = rest.filter((arg) => !arg.startsWith('-'));
  for (const [t, ...path] of LONGEST_FIRST) {
    if (t !== name) continue;
    for (let i = 0; i + path.length <= words.length; i++) {
      if (path.every((word, j) => words[i + j] === word)) return [name, ...path].join(' ');
    }
  }
  return null;
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
