import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baselineCases } from '../src/baseline.js';
import { BlobStore } from '../src/blob-store.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { parseProgramCommand, resolveProgram } from '../src/program.js';

const TOOL = `#!/bin/sh
case "$1" in
  where) pwd ;;
  pid) echo "pid $$" ;;
  same) echo same ;;
esac
`;

// Runs in the dev container: scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('baselineCases (Linux)', () => {
  let root: string;
  let store: BlobStore;
  let cases: CanonicalCase[];
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pa-baseline-linux-'));
    writeFileSync(join(root, 'tool'), TOOL, { mode: 0o755 });
    store = new BlobStore(join(root, 'cache'));
    cases = ['where', 'pid', 'same'].map((name) => canonicalCase({ argv: [name], origin: 'generated' }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs each repeat in a fresh bwrap sandbox with its own directory; its own PID namespace keeps the PID stable', async () => {
    const reference = await resolveProgram(parseProgramCommand(join(root, 'tool')));
    const result = await baselineCases({ reference, cases, store, sandbox: { kind: 'bwrap', isolatePids: true }, workDir: join(root, 'work') });
    const [where, pid, same] = result.cases;
    const dirs = await Promise.all(where!.observations.map(async (o) => (await store.get(o.stdout)).toString()));
    expect(new Set(dirs).size).toBe(3);
    expect(where).toMatchObject({ status: 'normalized', fixes: [{ field: 'stdout', normalizers: ['tmp-paths'] }] });
    expect(pid!.status).toBe('stable');
    expect(same!.status).toBe('stable');
    expect(result.proposals).toEqual([{ spec: { name: 'tmp-paths', options: {}, scope: ['stdout'] }, cases: 1 }]);
  });
});
