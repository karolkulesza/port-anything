import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { fsChanges, snapshotDir } from '../src/fs-diff.js';
import { caseEnvironment, runProcess } from '../src/process-runner.js';
import type { SandboxSetup } from '../src/sandbox.js';

// The fs diff of cases run in each local sandbox. Runs in the dev container: scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('fs diff in the local sandbox (Linux)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pa-fs-diff-linux-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const SETUPS: SandboxSetup[] = [
    { kind: 'bwrap', isolatePids: true },
    { kind: 'unshare', mapCurrentUser: true },
  ];

  it.each(SETUPS)('sees what a case created, changed and deleted (%j)', async (sandbox) => {
    const dir = join(root, `case-${sandbox.kind}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'in.txt'), 'b\na\n');
    writeFileSync(join(dir, 'old.txt'), 'old\n');
    const before = await snapshotDir(dir);
    const r = await runProcess({
      argv: ['sh', '-c', 'mkdir -p out && sort in.txt > out/sorted.txt && echo more >> in.txt && rm old.txt'],
      cwd: dir,
      env: caseEnvironment({ home: dir }),
      sandbox,
    });
    expect(r.exit).toBe(0);
    const store = new BlobStore(join(root, 'cache'));
    expect(await fsChanges(dir, before, { store })).toEqual({
      created: { 'out/sorted.txt': blobRef('a\nb\n') },
      modified: { 'in.txt': blobRef('b\na\nmore\n') },
      deleted: ['old.txt'],
    });
    expect((await store.get(blobRef('a\nb\n'))).toString()).toBe('a\nb\n');
  });

  it('lists a name that is not valid UTF-8, and stores its content', async () => {
    const dir = join(root, 'latin1');
    mkdirSync(dir);
    const store = new BlobStore(join(root, 'cache-latin1'));
    const r = await runProcess({
      argv: ['sh', '-c', "printf 'x' > \"$(printf 'caf\\351')\""],
      cwd: dir,
      env: caseEnvironment({ home: dir }),
      sandbox: { kind: 'bwrap', isolatePids: true },
    });
    expect(r.exit).toBe(0);
    const changes = await fsChanges(dir, {}, { store });
    expect(changes.created).toEqual({ 'caf�': blobRef('x') });
    expect(await store.has(blobRef('x'))).toBe(true);
  });
});
