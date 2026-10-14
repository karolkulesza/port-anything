import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { chmod, lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { blobRef, type BlobStore } from './blob-store.js';

/** Relative path → ref of its content, for every file under a directory, in path order. */
export type FsSnapshot = ReadonlyMap<string, string>;

/** What a case did to its working directory; the `fs` field of an observation. */
export interface FsChanges {
  created: Record<string, string>;
  modified: Record<string, string>;
  deleted: string[];
}

/** Created and modified files up to this size have their content stored (`fsChanges`). */
export const DEFAULT_MAX_STORED_FILE_BYTES = 1024 * 1024;

// Files above this are hashed in pieces rather than read whole.
const READ_WHOLE_BYTES = 1024 * 1024;

/**
 * The bytes a link stands for: its target, behind a prefix no text file starts with, so a file
 * replaced by a link to the same content still shows as modified. Links are never followed: the
 * target may be outside the case's directory.
 */
export function symlinkBlob(target: string | Buffer): Buffer {
  return Buffer.concat([SYMLINK_PREFIX, Buffer.from(target)]);
}

const SYMLINK_PREFIX = Buffer.from('\0symlink\0');

/** Whether stored bytes are a link's (see `symlinkBlob`) rather than a file's content. */
export function isSymlinkBlob(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(0, SYMLINK_PREFIX.length).equals(SYMLINK_PREFIX);
}

/**
 * Every regular file and link under `dir`, with the ref of its content. Directories themselves
 * aren't listed (an empty one doesn't show), nor are FIFOs, sockets and devices.
 *
 * A file or directory the case made unreadable is given read permission back by its owner first,
 * so call this only on a case's own directory, after the case has finished. Names that aren't
 * valid UTF-8 are listed with U+FFFD in place of the bad bytes.
 */
export async function snapshotDir(dir: string): Promise<Map<string, string>> {
  return new Map([...(await scan(dir))].map(([rel, entry]) => [rel, entry.ref]));
}

interface ScannedEntry {
  /** The path as the file system has it (the name may not be valid UTF-8). */
  path: Buffer;
  kind: 'file' | 'link';
  ref: string;
}

async function scan(dir: string): Promise<Map<string, ScannedEntry>> {
  const entries: [string, ScannedEntry][] = [];
  await walk(Buffer.from(dir), '', async (path, rel, kind) => {
    const ref = kind === 'link' ? blobRef(symlinkBlob(await readlink(path, { encoding: 'buffer' }))) : await hashFile(path);
    entries.push([rel, { path, kind, ref }]);
  });
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(entries);
}

type Visit = (path: Buffer, rel: string, kind: 'file' | 'link') => Promise<void>;

async function walk(dir: Buffer, prefix: string, visit: Visit): Promise<void> {
  // Listing needs read permission and reaching the entries needs search (x), so restore both.
  const { mode } = await lstat(dir);
  if ((mode & 0o700) !== 0o700) await chmod(dir, mode | 0o700);
  const names: Dirent<Buffer>[] = await readdir(dir, { withFileTypes: true, encoding: 'buffer' });
  for (const entry of names) {
    const path = Buffer.concat([dir, Buffer.from('/'), entry.name]);
    const rel = prefix + entry.name.toString('utf8');
    if (entry.isDirectory()) await walk(path, `${rel}/`, visit);
    else if (entry.isSymbolicLink()) await visit(path, rel, 'link');
    else if (entry.isFile()) await visit(path, rel, 'file');
  }
}

async function withReadAccess<T>(path: Buffer, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    await chmod(path, (await lstat(path)).mode | 0o400);
    return read();
  }
}

async function hashFile(path: Buffer): Promise<string> {
  const { size } = await lstat(path);
  if (size <= READ_WHOLE_BYTES) return blobRef(await withReadAccess(path, () => readFile(path)));
  return withReadAccess(
    path,
    () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
          .on('data', (chunk) => hash.update(chunk))
          .on('error', reject)
          .on('end', () => resolve(`blob:sha256:${hash.digest('hex')}`));
      }),
  );
}

/** Compares two snapshots; `before` may be a case's fixtures (path → ref). */
export function diffSnapshots(before: FsSnapshot | Readonly<Record<string, string>>, after: FsSnapshot): FsChanges {
  const old = before instanceof Map ? (before as FsSnapshot) : new Map(Object.entries(before));
  const changes: FsChanges = { created: {}, modified: {}, deleted: [] };
  for (const [path, ref] of after) {
    // As a key of a plain object it would vanish silently; observations can't hold it anyway.
    if (path === '__proto__') throw new Error('The case left a file named "__proto__", which an observation cannot record.');
    const previous = old.get(path);
    if (previous === undefined) changes.created[path] = ref;
    else if (previous !== ref) changes.modified[path] = ref;
  }
  for (const path of old.keys()) if (!after.has(path)) changes.deleted.push(path);
  changes.deleted.sort();
  return changes;
}

export interface FsChangesOptions {
  /** Where to keep the content of created and modified files. Without one, only refs are recorded. */
  store?: BlobStore;
  /** Larger files keep only their ref. */
  maxStoredBytes?: number;
}

/**
 * What the case did to `dir` since `before` (a snapshot taken before it ran, or its fixtures).
 * With a store, the content of small created and modified files is kept, so a report can show it.
 */
export async function fsChanges(
  dir: string,
  before: FsSnapshot | Readonly<Record<string, string>>,
  options: FsChangesOptions = {},
): Promise<FsChanges> {
  const after = await scan(dir);
  const changes = diffSnapshots(before, new Map([...after].map(([rel, entry]) => [rel, entry.ref])));
  const { store } = options;
  if (store) {
    const max = options.maxStoredBytes ?? DEFAULT_MAX_STORED_FILE_BYTES;
    for (const [rel, ref] of [...Object.entries(changes.created), ...Object.entries(changes.modified)]) {
      const { path, kind } = after.get(rel)!;
      const bytes =
        kind === 'link'
          ? symlinkBlob(await readlink(path, { encoding: 'buffer' }))
          : (await lstat(path)).size <= max
            ? await readFile(path)
            : undefined;
      // Only bytes that still match the snapshot are kept.
      if (bytes !== undefined && bytes.length <= max && blobRef(bytes) === ref) await store.put(bytes);
    }
  }
  return changes;
}
