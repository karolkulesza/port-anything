import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { compareExact } from '../src/compare.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { parseProgramCommand, resolveProgram, type ResolvedProgram } from '../src/program.js';
import { NormalizersSchema } from '../src/normalize.js';
import { runCases, type RunCasesOptions } from '../src/run-cases.js';

// A small program and two ports of it, as shell scripts. Each logs its runs to $PA_TEST_LOG
// (allow-listed below), so the tests can count how often each side ran.
const TOOL = (variant: 'ref' | 'good' | 'bad') => `#!/bin/sh
echo "${variant} $*" >> "$PA_TEST_LOG"
case "$1" in
  echo) shift; echo "$@" ;;
  upper) ${variant === 'bad' ? 'cat' : "tr 'a-z' 'A-Z'"} ;;
  cat) shift; cat "$@" ;;
  write) echo made > out.txt; rm -f gone.txt ;;
  pwd) pwd; echo "$HOME" ;;
  name) echo "$(basename "$0"): usage" >&2; exit ${variant === 'bad' ? 2 : 1} ;;
  env) echo "$PA_TEST_SETTING $LANG $TZ" ;;
  self) echo "$0" ;;
  warn) echo "${variant === 'ref' ? 'tool: x: cannot open' : variant === 'good' ? 'tool-copy:  x: cannot open ' : 'error: no such thing'}" >&2; exit 1 ;;
esac
`;

describe('runCases', () => {
  let root: string;
  let store: BlobStore;
  let log: string;
  let ref: ResolvedProgram;
  let good: ResolvedProgram;
  let bad: ResolvedProgram;
  let cases: CanonicalCase[];
  let scratch = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-run-cases-')));
    mkdirSync(join(root, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(root, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    log = join(root, 'runs.log');
    store = new BlobStore(join(root, 'cache'));
    ref = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool')));
    good = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-copy')));
    bad = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-bad')));
    const input = await store.put('hello\n');
    const fixture = await store.put('fixture text\n');
    const doomed = await store.put('bye\n');
    cases = [
      { argv: ['echo', 'a', 'b'] },
      { argv: ['upper'], stdin: input },
      { argv: ['cat', 'x', 'dir/in.txt'], fixtures: { 'dir/in.txt': fixture } },
      { argv: ['write'], fixtures: { 'gone.txt': doomed } },
      { argv: ['pwd'] },
      { argv: ['name'] },
      { argv: ['env'] },
    ].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const options = (candidates: ResolvedProgram[], extra: Partial<RunCasesOptions> = {}): RunCasesOptions => ({
    reference: ref,
    candidates,
    cases,
    store,
    sandbox: { kind: 'none' },
    workDir: join(root, `work-${scratch++}`),
    envAllowlist: ['PA_TEST_LOG'],
    env: { PA_TEST_SETTING: 'from-config' },
    hostEnv: { ...process.env, PA_TEST_LOG: log },
    ...extra,
  });
  const verdicts = (result: Awaited<ReturnType<typeof runCases>>, candidate: number) =>
    result.cases.map((c) => ({ id: c.caseId, ...c.candidates[candidate]!.comparison }));
  const logLines = () => readFileSync(log, 'utf8').trim().split('\n');

  it('gives the same verdicts against 2 candidates as two separate runs (done when)', async () => {
    const both = await runCases(options([good, bad]));
    const alone = [await runCases(options([good])), await runCases(options([bad]))];
    expect(verdicts(both, 0)).toEqual(verdicts(alone[0]!, 0));
    expect(verdicts(both, 1)).toEqual(verdicts(alone[1]!, 0));
    // And the verdicts are the expected ones, so the equality above isn't vacuous.
    expect(verdicts(both, 0).every((v) => v.verdict === 'match')).toBe(true);
    // `name` exits 2 where the reference exits 1; its stderr is byte for byte the same, so only the exit code diverges.
    expect(verdicts(both, 1).filter((v) => v.verdict === 'diverge').map((v) => v.fields)).toEqual([['stdout'], ['exit']]);
    // The reference did the same in every run; only `pwd` prints the run's own scratch directory.
    const references = both.cases.map((c, i) => compareExact(c.reference, alone[0]!.cases[i]!.reference).fields);
    expect(references).toEqual([[], [], [], [], ['stdout'], [], []]);
  });

  it('compares the normalized observations, keeps the raw ones, and says which normalizers changed each comparison', async () => {
    // Each side runs from its own program directory, so $0 differs until tmp-paths replaces it.
    const own = [{ argv: ['self'] }, { argv: ['echo', 'x'] }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
    const raw = await runCases(options([good], { cases: own }));
    expect(raw.cases.map((c) => c.candidates[0]!.comparison.verdict)).toEqual(['diverge', 'match']);
    expect(raw.cases.map((c) => c.candidates[0]!.normalizedBy)).toEqual([[], []]);

    const normalizers = NormalizersSchema.parse(['pids', 'tmp-paths']);
    const result = await runCases(options([good], { cases: own, normalizers }));
    expect(result.cases.map((c) => c.candidates[0]!.comparison.verdict)).toEqual(['match', 'match']);
    expect(result.cases.map((c) => c.candidates[0]!.normalizedBy)).toEqual([[1], []]);
    const self = result.cases[0]!;
    expect((await store.get(self.reference.stdout)).toString()).toMatch(/\/programs\/side-0\/tool\n$/);
    expect((await store.get(self.candidates[0]!.observation.stdout)).toString()).toMatch(/\/programs\/side-1\/tool\n$/);
  });

  it('compares under the standard profile by default, or the one given', async () => {
    // The good port prints the same message under its own file name, with other spacing; the bad one another message.
    const warn = [canonicalCase({ argv: ['warn'], origin: 'recorded' })];
    const fields = (result: Awaited<ReturnType<typeof runCases>>) => result.cases[0]!.candidates.map((c) => c.comparison.fields);
    expect(fields(await runCases(options([good, bad], { cases: warn })))).toEqual([[], ['stderr']]);
    expect(fields(await runCases(options([good, bad], { cases: warn, compare: { profile: 'strict' } })))).toEqual([['stderr'], ['stderr']]);
    expect(fields(await runCases(options([good, bad], { cases: warn, compare: { profile: 'lenient' } })))).toEqual([[], []]);
    expect(fields(await runCases(options([good, bad], { cases: warn, compare: { profile: 'standard', stderr: { similarity: 0 } } })))).toEqual([[], []]);
  });

  it('observes the reference once per case, however many candidates there are', async () => {
    rmSync(log, { force: true });
    await runCases(options([good, bad, good]));
    const lines = logLines();
    expect(lines.filter((l) => l.startsWith('ref ')).length).toBe(cases.length);
    expect(lines.filter((l) => l.startsWith('good ')).length).toBe(2 * cases.length);
    expect(lines.filter((l) => l.startsWith('bad ')).length).toBe(cases.length);
  });

  it('records what the reference did: output, exit code, stdin, fixtures and the fs diff', async () => {
    const result = await runCases(options([good], { concurrency: 3 }));
    expect(result.programName).toBe('tool');
    const [echo, upper, cat, write, , name, env] = result.cases.map((c) => c.reference);
    expect(result.cases.map((c) => c.caseId)).toEqual(cases.map((c) => c.id));
    expect((await store.get(echo!.stdout)).toString()).toBe('a b\n');
    expect((await store.get(upper!.stdout)).toString()).toBe('HELLO\n');
    expect((await store.get(cat!.stdout)).toString()).toBe('fixture text\n');
    expect((await store.get(cat!.stderr)).toString()).toMatch(/x/);
    expect(cat!.exit).toBe(1); // x is missing
    expect(write!.fs).toEqual({ created: { 'out.txt': blobRef('made\n') }, modified: {}, deleted: ['gone.txt'] });
    expect((await store.get(write!.fs.created['out.txt']!)).toString()).toBe('made\n');
    expect(name).toMatchObject({ exit: 1, signal: null, timeout: false, runs: 1, stable: true });
    expect((await store.get(name!.stderr)).toString()).toBe('tool: usage\n');
    expect((await store.get(env!.stdout)).toString()).toBe('from-config C.UTF-8 UTC\n');
  });

  it('runs every side in the same working directory, which is also HOME', async () => {
    const result = await runCases(options([good, bad]));
    const pwd = result.cases[4]!;
    const [dir, home] = (await store.get(pwd.reference.stdout)).toString().trim().split('\n');
    expect(home).toBe(dir);
    expect(pwd.candidates.map((c) => c.comparison.verdict)).toEqual(['match', 'match']);
  });

  it('streams each case as it finishes', async () => {
    const seen: string[] = [];
    const result = await runCases(options([good], { concurrency: 2, onCase: (c) => seen.push(c.caseId) }));
    expect([...seen].sort()).toEqual(result.cases.map((c) => c.caseId).sort());
  });

  it('runs with no candidates, observing the reference only', async () => {
    const result = await runCases(options([]));
    expect(result.cases).toHaveLength(cases.length);
    expect(result.cases.every((c) => c.candidates.length === 0)).toBe(true);
  });

  it('fails when a case needs a blob the store does not have', async () => {
    const missing = canonicalCase({ argv: ['upper'], stdin: blobRef('not stored'), origin: 'recorded' });
    await expect(runCases(options([good], { cases: [missing] }))).rejects.toThrow(/not in the cache/);
  });
});
