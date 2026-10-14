import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { ImportOptionsBase, Importer } from './import.js';

/** Default size limit for one fixture file, as for the recorder's copy mode (§7.1). */
export const DEFAULT_MAX_FIXTURE_BYTES = 1024 * 1024;

/** Token in `argv` that stands for the fixture's path. */
export const FIXTURE_PLACEHOLDER = '{}';

export interface FixturesImportOptions extends ImportOptionsBase {
  /**
   * Arguments for each case. With `input: 'file'`, every `{}` becomes the fixture's path, and the
   * path is appended when there is no `{}`. Default: none.
   */
  argv?: string[];
  /**
   * `file` (default): the fixture is a file in the case's working directory, at its path relative
   * to `path`. `stdin`: the fixture's bytes are the case's stdin.
   */
  input?: 'file' | 'stdin';
  /** Larger files are skipped. Default 1 MiB. */
  maxBytes?: number;
}

/**
 * One case per regular file under `path` (or for `path` itself, if it's a file), in sorted path
 * order. Symlinks and other non-regular files are skipped with a reason.
 */
export const fixturesImporter: Importer<FixturesImportOptions> = {
  kind: 'fixtures',
  async read(options, collector) {
    const argv = options.argv ?? [];
    const input = options.input ?? 'file';
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_FIXTURE_BYTES;
    if (input === 'stdin' && argv.some((a) => a.includes(FIXTURE_PLACEHOLDER))) {
      throw new Error(`"${FIXTURE_PLACEHOLDER}" stands for the fixture's path, so it can't be used when fixtures go to stdin.`);
    }
    const root = options.path;
    const top = await stat(root); // the path given is followed even if it's a symlink
    const files = top.isDirectory() ? await walk(root) : [root];
    for (const file of files) {
      const at = { file };
      const info = file === root ? top : await lstat(file);
      if (!info.isFile()) {
        collector.skip(at, info.isSymbolicLink() ? 'symbolic link' : 'not a regular file');
        continue;
      }
      if (info.size > maxBytes) {
        collector.skip(at, `larger than ${maxBytes} bytes`);
        continue;
      }
      const bytes = await readFile(file);
      const path = top.isDirectory() ? relative(root, file).split(sep).join('/') : basename(file);
      if (input === 'stdin') {
        await collector.add({ argv, stdin: bytes, at });
      } else {
        const args = argv.some((a) => a.includes(FIXTURE_PLACEHOLDER))
          ? argv.map((a) => a.replaceAll(FIXTURE_PLACEHOLDER, path))
          : [...argv, path];
        await collector.add({ argv: args, stdin: null, fixtures: { [path]: bytes }, at });
      }
    }
  },
};

/** Every entry under `dir` that isn't a directory, sorted by path. Symlinks are listed, not followed. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}
