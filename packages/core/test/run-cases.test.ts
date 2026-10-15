import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore, blobRef } from '../src/blob-store.js';
import { compareExact } from '../src/compare.js';
import { canonicalCase, type CanonicalCase } from '../src/model.js';
import { parseProgramCommand, resolveProgram, type ResolvedProgram } from '../src/program.js';
import { NormalizersSchema, TMP_PLACEHOLDER } from '../src/normalize.js';
import { openCaseRunner, runCases, type CaseRun, type RunCasesOptions } from '../src/run-cases.js';

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

// A racy port: every other run of the same command gives the reference's answer, so whether a case
// diverges depends on the run. Its run count per command lives in $PA_TEST_STATE.<command>.
const RACY = `#!/bin/sh
echo "racy $*" >> "$PA_TEST_LOG"
state="$PA_TEST_STATE.$1"
n=$(cat "$state" 2>/dev/null || echo 0)
echo $((n + 1)) > "$state"
case "$1" in
  echo) shift; echo "$@" ;;
  upper) if [ $((n % 2)) = 0 ]; then cat; else tr 'a-z' 'A-Z'; fi ;;
  name) echo "$(basename "$0"): usage" >&2; exit $((2 - n % 2)) ;;
  stamp) echo "run $n" ;;
esac
`;

// A reference whose output depends on chance, like `sort --random-sort` on two lines: its first two
// runs of a command agree, so a baseline of two runs would call it stable; from the third on it differs.
const LUCKY = `#!/bin/sh
echo "lucky $*" >> "$PA_TEST_LOG"
state="$PA_TEST_STATE.lucky.$1"
n=$(cat "$state" 2>/dev/null || echo 0)
echo $((n + 1)) > "$state"
case "$1" in
  echo) shift; echo "$@" ;;
  shuffle) if [ "$n" -lt 2 ]; then printf 'a\\nb\\n'; else printf 'b\\na\\n'; fi ;;
  upper) tr 'a-z' 'A-Z' ;;
esac
`;

describe('runCases', () => {
  let root: string;
  let store: BlobStore;
  let log: string;
  let ref: ResolvedProgram;
  let good: ResolvedProgram;
  let bad: ResolvedProgram;
  let racy: ResolvedProgram;
  let lucky: ResolvedProgram;
  let cases: CanonicalCase[];
  let scratch = 0;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-run-cases-')));
    mkdirSync(join(root, 'bin'));
    for (const [file, variant] of [['tool', 'ref'], ['tool-copy', 'good'], ['tool-bad', 'bad']] as const) {
      writeFileSync(join(root, 'bin', file), TOOL(variant), { mode: 0o755 });
    }
    writeFileSync(join(root, 'bin', 'tool-racy'), RACY, { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'tool-lucky'), LUCKY, { mode: 0o755 });
    log = join(root, 'runs.log');
    store = new BlobStore(join(root, 'cache'));
    ref = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool')));
    good = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-copy')));
    bad = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-bad')));
    racy = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-racy')));
    lucky = await resolveProgram(parseProgramCommand(join(root, 'bin', 'tool-lucky')));
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
    envAllowlist: ['PA_TEST_LOG', 'PA_TEST_STATE'],
    env: { PA_TEST_SETTING: 'from-config' },
    hostEnv: { ...process.env, PA_TEST_LOG: log, PA_TEST_STATE: join(root, `state-${scratch}`) },
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
    // The normalized pair, as compared, is kept too.
    const { normalized } = self.candidates[0]!;
    expect(normalized.reference.stdout).toBe(normalized.candidate.stdout);
    expect((await store.get(normalized.reference.stdout)).toString()).toBe(`${TMP_PLACEHOLDER}/tool\n`);
  });

  it('classifies the shape of each diverging field, after normalizing, and none for a match', async () => {
    const result = await runCases(options([good, bad]));
    const shapes = (candidate: number) => result.cases.map((c) => c.candidates[candidate]!.shapes);
    expect(shapes(0).every((s) => s.length === 0)).toBe(true);
    expect(shapes(1).filter((s) => s.length > 0)).toEqual([[{ field: 'stdout', shape: 'other' }], [{ field: 'exit', shape: 'exit-code', detail: '1 vs 2' }]]);

    // `$0` names each side's own program directory (side-0, side-1); no shape once that is normalized.
    const self = [canonicalCase({ argv: ['self'], origin: 'recorded' })];
    expect((await runCases(options([good], { cases: self }))).cases[0]!.candidates[0]!.shapes).toEqual([{ field: 'stdout', shape: 'number-value' }]);
    const normalizers = NormalizersSchema.parse(['tmp-paths']);
    expect((await runCases(options([good], { cases: self, normalizers }))).cases[0]!.candidates[0]!.shapes).toEqual([]);
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
    // Plus one re-run of each of its 2 diverging cases.
    expect(lines.filter((l) => l.startsWith('bad ')).length).toBe(cases.length + 2);
  });

  it('re-runs each diverging case once; a steady divergence is not flaky', async () => {
    rmSync(log, { force: true });
    const result = await runCases(options([good, bad]));
    const lines = logLines();
    expect(lines.filter((l) => l.startsWith('bad ')).sort()).toEqual(
      [...cases.map((c) => `bad ${c.argv.join(' ')}`), 'bad upper', 'bad name'].sort(),
    );
    for (const c of result.cases) {
      expect(c.candidates[0]).toMatchObject({ flaky: false });
      expect(c.candidates[0]!.rerun).toBeUndefined();
      const run = c.candidates[1]!;
      expect(run.flaky).toBe(false);
      if (run.comparison.verdict === 'match') {
        expect(run.rerun).toBeUndefined();
        expect(run.observation).toMatchObject({ runs: 1, stable: true });
      } else {
        expect(compareExact(run.observation, run.rerun!).verdict).toBe('match');
        expect(run.observation).toMatchObject({ runs: 2, stable: true });
      }
    }
  });

  it('labels a racy port flaky-candidate and still counts the case as diverging (done when)', async () => {
    const result = await runCases(options([good, racy], { concurrency: 1 }));
    const runs = result.cases.map((c) => c.candidates[1]!);
    // First run of upper and name: wrong; re-run: right. Excluding them would give 7 of 7.
    expect(runs.map((r) => r.comparison.verdict)).toEqual(['match', 'diverge', 'diverge', 'diverge', 'diverge', 'diverge', 'diverge']);
    expect(runs.map((r) => r.flaky)).toEqual([false, true, false, false, false, true, false]);
    const [, upper, , , , name] = runs;
    expect(upper!.comparison.fields).toEqual(['stdout']);
    expect(name!.comparison.fields).toEqual(['exit']);
    expect(compareExact(result.cases[1]!.reference, upper!.rerun!).verdict).toBe('match');
    expect(upper!.observation).toMatchObject({ runs: 2, stable: false });
    const matching = (i: number) => result.cases.filter((c) => c.candidates[i]!.comparison.verdict === 'match').length;
    expect(matching(1)).toBeLessThan(matching(0));
  });

  it('compares the re-run with the first run after normalizing both, as the reference comparison does', async () => {
    // Prints a count that changes on every run, where the reference prints nothing: a steady divergence once normalized.
    const stamp = [canonicalCase({ argv: ['stamp'], origin: 'recorded' })];
    const raw = await runCases(options([racy], { cases: stamp }));
    expect(raw.cases[0]!.candidates[0]).toMatchObject({ comparison: { verdict: 'diverge' }, flaky: true });
    const normalizers = NormalizersSchema.parse([{ regex: { pattern: 'run \\d+', replacement: 'run N' } }]);
    const normalized = await runCases(options([racy], { cases: stamp, normalizers }));
    expect(normalized.cases[0]!.candidates[0]).toMatchObject({ comparison: { verdict: 'diverge' }, flaky: false, observation: { runs: 2, stable: true } });
  });

  it('re-runs the reference on a diverging case when asked, and says which fields it changed', async () => {
    rmSync(log, { force: true });
    // The bad port knows no `shuffle` (prints nothing) and cats `upper` instead of upcasing it: both diverge.
    const chance = [{ argv: ['echo', 'a'] }, { argv: ['shuffle'] }, { argv: ['upper'], stdin: cases[1]!.stdin }].map((c) => canonicalCase({ ...c, origin: 'recorded' }));
    const result = await runCases(options([bad], { reference: lucky, cases: chance, recheckReference: 4, concurrency: 1 }));
    const [echo, shuffle, upper] = result.cases;
    expect(echo!.candidates[0]!.comparison.verdict).toBe('match');
    expect(echo!.referenceVaried).toBeUndefined();
    // Runs 1 and 2 agree (the second is the first re-check); the third differs, so it stops there.
    expect(shuffle!.candidates[0]!.comparison.verdict).toBe('diverge');
    expect(shuffle!.referenceVaried).toEqual(['stdout']);
    // A reference that never varies is re-run the full 4 times and stays trusted.
    expect(upper!.candidates[0]!.comparison.verdict).toBe('diverge');
    expect(upper!.referenceVaried).toBeUndefined();
    const runs = (arg: string) => logLines().filter((l) => l === `lucky ${arg}`).length;
    expect([runs('echo a'), runs('shuffle'), runs('upper')]).toEqual([1, 3, 5]);
    // The first observation is still the one compared.
    expect((await store.get(shuffle!.reference.stdout)).toString()).toBe('a\nb\n');
  });

  it('re-checks the reference after the normalizers, and not at all by default', async () => {
    rmSync(log, { force: true });
    // The reference's `stamp`-like output: the racy port as reference prints its run count.
    const stamp = [canonicalCase({ argv: ['stamp'], origin: 'recorded' })];
    const raw = await runCases(options([bad], { reference: racy, cases: stamp, recheckReference: 2 }));
    expect(raw.cases[0]!.referenceVaried).toEqual(['stdout']);
    const normalizers = NormalizersSchema.parse([{ regex: { pattern: 'run \\d+', replacement: 'run N' } }]);
    const normalized = await runCases(options([bad], { reference: racy, cases: stamp, normalizers, recheckReference: 2 }));
    expect(normalized.cases[0]!.referenceVaried).toBeUndefined();
    rmSync(log, { force: true });
    const plain = await runCases(options([bad], { reference: racy, cases: stamp }));
    expect(plain.cases[0]!.referenceVaried).toBeUndefined();
    expect(logLines().filter((l) => l.startsWith('racy ')).length).toBe(1);
  });

  it('runs each case once with rerun off, still classifying the divergences', async () => {
    rmSync(log, { force: true });
    const result = await runCases(options([bad], { rerun: false }));
    expect(logLines().filter((l) => l.startsWith('bad ')).sort()).toEqual(cases.map((c) => `bad ${c.argv.join(' ')}`).sort());
    const diverging = result.cases.map((c) => c.candidates[0]!).filter((r) => r.comparison.verdict === 'diverge');
    expect(diverging).toHaveLength(2);
    for (const run of diverging) {
      expect(run).toMatchObject({ flaky: false, observation: { runs: 1 } });
      expect(run.rerun).toBeUndefined();
      expect(run.shapes).not.toEqual([]);
    }
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

  it('runs cases one at a time on programs pinned once, with the verdicts of a whole run', async () => {
    const whole = await runCases(options([good, bad]));
    rmSync(log, { force: true });
    const runner = await openCaseRunner(options([good, bad]));
    expect(runner.programName).toBe('tool');
    const one: CaseRun[] = [];
    for (const c of cases) one.push(await runner.run(c));
    const verdicts = (runs: CaseRun[]) => runs.map((c) => c.candidates.map((x) => ({ fields: x.comparison.fields, shapes: x.shapes })));
    expect(verdicts(one)).toEqual(verdicts(whole.cases));
    expect(logLines().filter((l) => l.startsWith('ref '))).toHaveLength(cases.length);
  });

  it('fails when a case needs a blob the store does not have', async () => {
    const missing = canonicalCase({ argv: ['upper'], stdin: blobRef('not stored'), origin: 'recorded' });
    await expect(runCases(options([good], { cases: [missing] }))).rejects.toThrow(/not in the cache/);
  });
});
