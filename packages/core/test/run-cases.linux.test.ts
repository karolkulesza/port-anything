import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { parseProgramCommand, resolveProgram } from '../src/program.js';
import { runCases, type RunCasesResult } from '../src/run-cases.js';
import type { SandboxSetup } from '../src/sandbox.js';

// GNU sort against two candidates: an identical copy under another name and the uutils multicall
// binary. Runs in the dev container (GNU sort is /usr/bin/gnusort there): scripts/dev-linux.sh pnpm -r test
describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('runCases (Linux)', () => {
  let root: string;
  let store: BlobStore;
  let cases: CanonicalCase[];
  beforeAll(async () => {
    // Under /tmp on purpose: bwrap hides the host's /tmp, so the runner must show what cases need.
    root = mkdtempSync(join(tmpdir(), 'pa-run-cases-linux-'));
    mkdirSync(join(root, 'copies'));
    copyFileSync('/usr/bin/gnusort', join(root, 'copies', 'othersort'));
    store = new BlobStore(join(root, 'cache'));
    const lines = await store.put('banana\napple\n10\n9\n');
    cases = [
      { argv: [], stdin: lines },
      { argv: ['-n'], stdin: lines },
      { argv: ['-r', 'in.txt'], fixtures: { 'in.txt': lines } },
      { argv: ['-o', 'out.txt', 'in.txt'], fixtures: { 'in.txt': lines } },
      { argv: ['missing-file'] },
      { argv: ['--no-such-option'] },
      { argv: ['-k', '0'] },
    ].map((c) => canonicalCase({ ...c, origin: 'generated' }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const SETUPS: SandboxSetup[] = [
    { kind: 'bwrap', isolatePids: true },
    { kind: 'unshare', mapCurrentUser: true },
  ];

  const verdicts = (result: RunCasesResult, candidate: number) => result.cases.map((c) => c.candidates[candidate]!.comparison);

  it.each(SETUPS)('gives the same verdicts against 2 candidates as two separate runs (%j)', async (sandbox) => {
    const ref = await resolveProgram(parseProgramCommand('/usr/bin/gnusort'));
    const copy = await resolveProgram(parseProgramCommand(join(root, 'copies', 'othersort')));
    const uutils = await resolveProgram(parseProgramCommand('coreutils sort'));
    const run = (candidates: typeof ref[], label: string) =>
      runCases({ reference: ref, candidates, cases, store, sandbox, workDir: join(root, `${sandbox.kind}-${label}`) });

    const both = await run([copy, uutils], 'both');
    const [alone0, alone1] = [await run([copy], 'copy'), await run([uutils], 'uutils')];
    expect(both.programName).toBe('sort');
    expect(verdicts(both, 0)).toEqual(verdicts(alone0, 0));
    expect(verdicts(both, 1)).toEqual(verdicts(alone1, 0));

    // The copy matches everywhere, sorted output and errors alike; the fs diff saw sort -o.
    expect(verdicts(both, 0).every((v) => v.verdict === 'match')).toBe(true);
    expect(both.cases[3]!.reference.fs.created).toEqual({ 'out.txt': blobRef('10\n9\napple\nbanana\n') });
    expect((await store.get(both.cases[1]!.reference.stdout)).toString()).toBe('apple\nbanana\n9\n10\n');
    expect((await store.get(both.cases[4]!.reference.stderr)).toString()).toMatch(/^sort: /);
  });
});
