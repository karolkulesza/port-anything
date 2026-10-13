import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BLOB_REF_PATTERN } from './model.js';

export type BlobErrorCode = 'invalid' | 'not-found' | 'corrupt';

export class BlobError extends Error {
  override readonly name = 'BlobError';
  constructor(
    readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Ref of some content, without storing it: `blob:sha256:<hex>` of its bytes (strings as UTF-8). */
export function blobRef(data: string | Uint8Array): string {
  return `blob:sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** The project's cache directory, `.port-anything/cache/` (git-ignored). */
export function cacheDir(projectDir: string): string {
  return join(projectDir, '.port-anything', 'cache');
}

function hexOf(ref: string): string {
  const match = BLOB_REF_PATTERN.exec(ref);
  if (!match) throw new BlobError('invalid', `"${ref}" is not a blob ref: expected blob:sha256:<64 lowercase hex>.`);
  return match[1]!;
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Content-addressed store for stdin, fixtures and captured output. Each blob is one file named by
 * the SHA-256 of its bytes, so storing the same content twice keeps one copy, and reading checks
 * the bytes still match the name.
 */
export class BlobStore {
  /** `root` is the cache directory (see `cacheDir`); blobs live under `root/blobs/sha256/`. */
  constructor(readonly root: string) {}

  /** File that holds the blob, `blobs/sha256/<first 2 hex>/<other 62 hex>`, whether or not it exists. */
  path(ref: string): string {
    const hex = hexOf(ref);
    return join(this.root, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2));
  }

  /** Stores the content and returns its ref. Content already stored intact is not written again. */
  async put(data: string | Uint8Array): Promise<string> {
    // A copy, so a caller changing its array while the write is pending can't store other bytes.
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const ref = blobRef(bytes);
    const file = this.path(ref);
    try {
      if (bytes.equals(await readFile(file))) return ref;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    // Write next to the target, then rename: readers and concurrent writers of the same blob only
    // ever see a complete file. There is no fsync, so a power loss can still leave a damaged blob;
    // `get` reports it as corrupt and the next `put` of that content rewrites it.
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, bytes);
      await rename(temp, file);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
    return ref;
  }

  /** The blob's bytes. Fails with `not-found` if it isn't stored, `corrupt` if its bytes changed. */
  async get(ref: string): Promise<Buffer> {
    const file = this.path(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (e) {
      if (isMissing(e)) throw new BlobError('not-found', `Blob ${ref} is not in the cache (${this.root}).`);
      throw e;
    }
    if (blobRef(bytes) !== ref) {
      throw new BlobError('corrupt', `Blob ${ref} is corrupt: ${file} no longer matches its hash.`);
    }
    return bytes;
  }

  /** Whether a blob file exists for the ref. Doesn't check its content; `get` does. */
  async has(ref: string): Promise<boolean> {
    const file = this.path(ref);
    try {
      return (await stat(file)).isFile();
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }
}
