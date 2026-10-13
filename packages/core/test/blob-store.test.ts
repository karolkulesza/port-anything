import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobError, BlobStore, blobRef, cacheDir } from '../src/blob-store.js';
import { BlobRefSchema, canonicalCase } from '../src/model.js';

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

async function rejection(promise: Promise<unknown>): Promise<BlobError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof BlobError) return e;
    throw e;
  }
  throw new Error('resolved');
}

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-blobs-'));
  store = new BlobStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('blobRef', () => {
  it('is blob:sha256: and the SHA-256 of the bytes', () => {
    expect(blobRef('hello\n')).toBe(`blob:sha256:${sha('hello\n')}`);
    expect(BlobRefSchema.parse(blobRef(''))).toBe(`blob:sha256:${sha('')}`);
  });

  it('hashes a string as UTF-8, the same as its bytes', () => {
    expect(blobRef('héllo')).toBe(blobRef(Buffer.from('héllo', 'utf8')));
  });
});

describe('cacheDir', () => {
  it('is .port-anything/cache in the project', () => {
    expect(cacheDir('/p')).toBe(join('/p', '.port-anything', 'cache'));
  });
});

describe('BlobStore', () => {
  it('stores bytes and returns their ref; get returns the same bytes', async () => {
    const data = randomBytes(10_000);
    const ref = await store.put(data);
    expect(ref).toBe(blobRef(data));
    expect(await store.get(ref)).toEqual(data);
  });

  it('stores strings as UTF-8 and the empty blob', async () => {
    expect((await store.get(await store.put('héllo'))).toString('utf8')).toBe('héllo');
    expect(await store.get(await store.put(''))).toEqual(Buffer.alloc(0));
  });

  it('keeps one file per content: putting it again changes nothing', async () => {
    const a = await store.put('same');
    const b = await store.put(Buffer.from('same'));
    expect(b).toBe(a);
    await store.put('other');
    expect(await listFiles(dir)).toHaveLength(2);
  });

  it('dedups concurrent puts of the same content', async () => {
    const refs = await Promise.all(Array.from({ length: 20 }, () => store.put('racing')));
    expect(new Set(refs).size).toBe(1);
    expect(await listFiles(dir)).toEqual([store.path(refs[0]!)]);
    expect((await store.get(refs[0]!)).toString()).toBe('racing');
  });

  it('lays blobs out under blobs/sha256/<2 hex>/<rest>', async () => {
    const ref = await store.put('layout');
    const hex = sha('layout');
    expect(store.path(ref)).toBe(join(dir, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2)));
    expect(await readFile(store.path(ref), 'utf8')).toBe('layout');
  });

  it('has() reports whether a ref is stored', async () => {
    const ref = await store.put('present');
    expect(await store.has(ref)).toBe(true);
    expect(await store.has(blobRef('absent'))).toBe(false);
  });

  it('resolves every blob ref of a stored case', async () => {
    const c = canonicalCase({
      argv: ['-l', 'input.txt'],
      stdin: await store.put('from stdin\n'),
      fixtures: { 'input.txt': await store.put('a\nb\n'), 'dir/nested': await store.put(randomBytes(64)) },
      origin: 'recorded',
    });
    for (const ref of [c.stdin!, ...Object.values(c.fixtures)]) {
      expect(blobRef(await store.get(ref))).toBe(ref);
    }
    expect((await store.get(c.fixtures['input.txt']!)).toString()).toBe('a\nb\n');
  });

  it('get() of a missing blob fails with not-found', async () => {
    const e = await rejection(store.get(blobRef('never stored')));
    expect(e.code).toBe('not-found');
    expect(e.message).toContain(blobRef('never stored'));
  });

  it('rejects malformed refs everywhere', async () => {
    for (const bad of ['sha256:' + sha('x'), 'blob:sha256:' + sha('x').toUpperCase(), 'blob:sha256:abc', 'blob:sha256:../../etc/passwd']) {
      expect((await rejection(store.get(bad))).code).toBe('invalid');
      expect((await rejection(store.has(bad))).code).toBe('invalid');
      expect(() => store.path(bad)).toThrow(BlobError);
    }
  });

  it('get() detects a blob whose content no longer matches its ref', async () => {
    const ref = await store.put('original');
    await writeFile(store.path(ref), 'tampered');
    const e = await rejection(store.get(ref));
    expect(e.code).toBe('corrupt');
    expect(e.message).toContain(ref);
  });

  it('put() repairs a corrupt blob instead of keeping it', async () => {
    const ref = await store.put('original');
    await writeFile(store.path(ref), 'tampered');
    expect(await store.put('original')).toBe(ref);
    expect((await store.get(ref)).toString()).toBe('original');
  });

  it('leaves no temporary files behind', async () => {
    await Promise.all(['a', 'b', 'a', 'c', 'b'].map((s) => store.put(s)));
    const files = await listFiles(dir);
    expect(files).toHaveLength(3);
    for (const f of files) expect(f).toMatch(/[0-9a-f]{62}$/);
  });
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}
