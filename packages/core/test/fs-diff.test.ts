import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { DEFAULT_MAX_STORED_FILE_BYTES, diffSnapshots, fsChanges, snapshotDir, symlinkBlob } from '../src/fs-diff.js';
import { canonicalObservation } from '../src/model.js';
import { caseEnvironment, runProcess } from '../src/process-runner.js';

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-fs-diff-'));
  dir = join(root, 'case');
  mkdirSync(dir);
});
afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

describe('snapshotDir', () => {
  it('maps every file, at any depth, to the ref of its content, in path order', async () => {
    write('b.txt', 'bee\n');
    write('a/deep/c.txt', 'sea\n');
    mkdirSync(join(dir, 'empty'));
    const snap = await snapshotDir(dir);
    expect([...snap]).toEqual([
      ['a/deep/c.txt', blobRef('sea\n')],
      ['b.txt', blobRef('bee\n')],
    ]);
  });

  it('hashes a large file in pieces to the same ref', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    write('big.bin', big);
    expect((await snapshotDir(dir)).get('big.bin')).toBe(blobRef(big));
  });

  it('records a link by its target, without following it', async () => {
    symlinkSync('/etc/hosts', join(dir, 'hosts'));
    symlinkSync('missing', join(dir, 'dangling'));
    const snap = await snapshotDir(dir);
    expect(snap.get('hosts')).toBe(blobRef(symlinkBlob('/etc/hosts')));
    expect(snap.get('dangling')).toBe(blobRef(symlinkBlob('missing')));
  });

  it.skipIf(process.getuid?.() === 0)('reads files and directories the case made unreadable', async () => {
    write('locked/secret.txt', 'hidden\n');
    write('private.txt', 'mine\n');
    chmodSync(join(dir, 'private.txt'), 0o000);
    chmodSync(join(dir, 'locked'), 0o000);
    const snap = await snapshotDir(dir);
    expect(snap.get('private.txt')).toBe(blobRef('mine\n'));
    expect(snap.get('locked/secret.txt')).toBe(blobRef('hidden\n'));
  });

  it('is empty for an empty directory', async () => {
    expect((await snapshotDir(dir)).size).toBe(0);
  });
});

describe('diffSnapshots', () => {
  it('lists created, modified and deleted files; unchanged ones are left out', () => {
    const before = new Map([
      ['same.txt', blobRef('same')],
      ['edit.txt', blobRef('old')],
      ['gone.txt', blobRef('bye')],
    ]);
    const after = new Map([
      ['same.txt', blobRef('same')],
      ['edit.txt', blobRef('new')],
      ['new/out.txt', blobRef('hello')],
    ]);
    expect(diffSnapshots(before, after)).toEqual({
      created: { 'new/out.txt': blobRef('hello') },
      modified: { 'edit.txt': blobRef('new') },
      deleted: ['gone.txt'],
    });
  });

  it("takes the case's fixtures as the before state", () => {
    const changes = diffSnapshots({ 'in.txt': blobRef('x'), 'z.txt': blobRef('z'), 'a.txt': blobRef('a') }, new Map());
    expect(changes.deleted).toEqual(['a.txt', 'in.txt', 'z.txt']);
  });
});

describe('fsChanges', () => {
  it('sees a file the case created (done when)', async () => {
    write('in.txt', 'b\na\n');
    const before = await snapshotDir(dir);
    const r = await runProcess({
      argv: ['sh', '-c', 'sort in.txt > out.txt'],
      cwd: dir,
      env: caseEnvironment({ home: dir }),
      sandbox: { kind: 'none' },
    });
    expect(r.exit).toBe(0);
    const changes = await fsChanges(dir, before);
    expect(changes).toEqual({ created: { 'out.txt': blobRef('a\nb\n') }, modified: {}, deleted: [] });
    // It fits the observation model as is.
    const observation = canonicalObservation({
      exit: 0, signal: null, timeout: false, stdout: blobRef(''), stderr: blobRef(''), fs: changes,
      time_ms: { wall: 1, user: null, sys: null }, rss_kb: null, runs: 1, stable: true,
    });
    expect(observation.fs).toEqual(changes);
  });

  it('stores the content of small created and modified files, not of large or unchanged ones', async () => {
    const store = new BlobStore(join(root, 'cache'));
    write('keep.txt', 'unchanged');
    write('edit.txt', 'old');
    const before = await snapshotDir(dir);
    write('edit.txt', 'new');
    write('small.txt', 'tiny');
    write('large.txt', 'x'.repeat(100));
    symlinkSync('small.txt', join(dir, 'link'));
    const changes = await fsChanges(dir, before, { store, maxStoredBytes: 50 });
    expect(Object.keys(changes.created).sort()).toEqual(['large.txt', 'link', 'small.txt']);
    expect((await store.get(changes.created['small.txt']!)).toString()).toBe('tiny');
    expect((await store.get(changes.modified['edit.txt']!)).toString()).toBe('new');
    expect(await store.get(changes.created['link']!)).toEqual(symlinkBlob('small.txt'));
    expect(await store.has(changes.created['large.txt']!)).toBe(false);
    expect(await store.has(blobRef('unchanged'))).toBe(false);
  });

  it('stores files up to 1 MiB by default', () => {
    expect(DEFAULT_MAX_STORED_FILE_BYTES).toBe(1024 * 1024);
  });

  it('notices a file replaced by a link to the same content', async () => {
    write('data', 'payload');
    const before = await snapshotDir(dir);
    unlinkSync(join(dir, 'data'));
    write('payload', 'payload');
    symlinkSync('payload', join(dir, 'data'));
    const changes = await fsChanges(dir, before);
    expect(changes.modified).toEqual({ data: blobRef(symlinkBlob('payload')) });
    expect(changes.created).toEqual({ payload: blobRef('payload') });
  });
});
