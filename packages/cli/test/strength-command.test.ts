import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, DEFAULT_STRENGTH_MUTANTS, cacheDir, loadCommittedCases, type SandboxProbe } from '@port-anything/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStrengthArgs, runCheck, strengthCommand, type CheckSpec } from '../src/strength-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

// A small tool in JS; the reference and the candidate start as the same file.
const TOOL = `#!/usr/bin/env node
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'add') console.log(Number(a) + Number(b));
else if (cmd === 'max') console.log(Number(a) > Number(b) ? a : b);
else {
  console.error('usage: tool add|max A B');
  process.exit(2);
}
`;

const CASES = [['add', '1', '2'], ['max', '1', '2'], ['max', '5', '3']];

let project: string | undefined;
afterEach(() => {
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
  project = undefined;
});

/** A project with the tool as reference (`ref/tool.js`) and candidate (`port/tool.js`, or the given source). */
function makeProject(candidate = TOOL, cases = CASES, candidateConfig = '{ cmd: ./port/tool.js }'): string {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-strength-')));
  for (const [dir, source] of [['ref', TOOL], ['port', candidate]] as const) {
    mkdirSync(join(project, dir));
    writeFileSync(join(project, dir, 'tool.js'), source);
    chmodSync(join(project, dir, 'tool.js'), 0o755);
  }
  writeFileSync(join(project, 'port-anything.yaml'), `version: 1\nprogram_name: tool\nreference: { cmd: ./ref/tool.js }\ncandidate: ${candidateConfig}\ncorpus: { min_cases_per_feature: 1 }\n`);
  mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
  writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), cases.map((argv) => JSON.stringify({ argv, origin: 'recorded' })).join('\n'));
  return project;
}

const strength = (argv: string[], cwd: string) => strengthCommand(['--no-sandbox', ...argv], { cwd, probe: NO_SANDBOX });

describe('parseStrengthArgs', () => {
  it('reads --mutants, --json and --no-sandbox, with 200 mutants by default', () => {
    expect(parseStrengthArgs([])).toEqual({ mutants: DEFAULT_STRENGTH_MUTANTS, json: false, noSandbox: false });
    expect(DEFAULT_STRENGTH_MUTANTS).toBe(200);
    expect(parseStrengthArgs(['--mutants', '50', '--json', '--no-sandbox'])).toEqual({ mutants: 50, json: true, noSandbox: true });
    expect(parseStrengthArgs(['--mutants=7'])).toMatchObject({ mutants: 7 });
  });

  it('rejects a count that is not a positive whole number, and unknown options', () => {
    for (const bad of ['0', '-3', '1.5', 'many', '']) expect(() => parseStrengthArgs([`--mutants=${bad}`]), bad).toThrow(/--mutants must be a positive whole number/);
    expect(() => parseStrengthArgs(['--smoke'])).toThrow(/smoke/);
    expect(() => parseStrengthArgs(['extra'])).toThrow(/extra/);
  });
});

// Each mutant runs the corpus on both sides, a few seconds per test.
describe('strengthCommand with the generic source mutator', { timeout: 60_000 }, () => {
  it('reports the share of mutants the corpus catches and lists the survivors', async () => {
    const cwd = makeProject();
    const result = await strength([], cwd);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        'corpus strength 66.6%: the corpus kills 4 of 6 mutants of the candidate',
        'candidate ./port/tool.js, mutated with port-anything generic source mutator, sandbox: none (--no-sandbox)',
        '6 of 6 mutants tested: 4 caught, 2 missed, 0 timed out, 0 unviable',
        'on the 3 of 3 cases the candidate matches',
        "surviving mutants (2), behavior the corpus doesn't test:",
        // No case has a == b, and none is a usage error.
        '  tool.js:4:47: replace > with >=',
        '  tool.js:7:16: replace 2 with 3',
        '',
      ].join('\n'),
    );
    // The candidate's source is restored, and the scratch space is gone.
    expect(readFileSync(join(cwd, 'port', 'tool.js'), 'utf8')).toBe(TOOL);
    expect(existsSync(join(cwd, '.port-anything', 'tmp'))).toBe(false);
  });

  it('prints the same as JSON, every caught mutant by name', async () => {
    const cwd = makeProject(TOOL, [...CASES, ['max', '4', '04'], ['nope']]);
    const json = JSON.parse((await strength(['--json'], cwd)).stdout);
    expect(json).toEqual({
      candidate: './port/tool.js',
      tool: 'port-anything generic source mutator',
      sandbox: 'none (--no-sandbox)',
      cases: { matching: 5, total: 5 },
      generated: 6,
      mutants: 6,
      caught: 6,
      missed: 0,
      timeout: 0,
      unviable: 0,
      score: 1,
      survivors: [],
      caught_mutants: [
        'tool.js:2:40: replace 2 with 3',
        'tool.js:3:42: replace + with -',
        'tool.js:3:9: replace === with !==',
        'tool.js:4:14: replace === with !==',
        'tool.js:4:47: replace > with >=',
        'tool.js:7:16: replace 2 with 3',
      ],
      notes: [],
    });
  });

  it('tests a fixed sample when there are more mutants than --mutants', async () => {
    const cwd = makeProject();
    const first = JSON.parse((await strength(['--json', '--mutants', '3'], cwd)).stdout);
    expect(first).toMatchObject({ generated: 6, mutants: 3 });
    const again = JSON.parse((await strength(['--json', '--mutants', '3'], cwd)).stdout);
    expect([...again.caught_mutants, ...again.survivors]).toEqual([...first.caught_mutants, ...first.survivors]);
    expect((await strength(['--mutants', '3'], cwd)).stdout).toContain('3 of 6 mutants tested (a fixed sample; --mutants sets the size)');
  });

  it('measures on the cases the candidate matches, so a port in progress has a score too', async () => {
    // This candidate gets max wrong when the first number is larger: the case `max 5 3` is left out.
    const cwd = makeProject(TOOL.replace("Number(a) > Number(b) ? a : b", "Number(a) > Number(b) ? b : b"));
    const json = JSON.parse((await strength(['--json'], cwd)).stdout);
    expect(json.cases).toEqual({ matching: 2, total: 3 });
    expect(json.survivors).toContain('tool.js:4:47: replace > with >=');
  });

  it('rebuilds each mutant with candidate.build and counts one that does not build as unviable', async () => {
    // The candidate runs a built copy of the source; a mutant whose source has `!==` fails this build.
    const cwd = makeProject(TOOL, CASES, "{ cmd: ./port/out/tool.js, build: 'mkdir -p port/out && ! grep -q \"!==\" port/tool.js && cp port/tool.js port/out/tool.js' }");
    // The Makefile marks port/ as the candidate's source tree (out/ is build output, never mutated).
    writeFileSync(join(cwd, 'port', 'Makefile'), '');
    mkdirSync(join(cwd, 'port', 'out'));
    writeFileSync(join(cwd, 'port', 'out', 'tool.js'), TOOL, { mode: 0o755 });
    const json = JSON.parse((await strength(['--json'], cwd)).stdout);
    expect(json).toMatchObject({ mutants: 6, caught: 2, missed: 2, unviable: 2, score: 0.5 });
    expect(json.caught_mutants).toEqual(['tool.js:2:40: replace 2 with 3', 'tool.js:3:42: replace + with -']);
    // Built in copies of the project, never in the project itself.
    expect(readFileSync(join(cwd, 'port', 'out', 'tool.js'), 'utf8')).toBe(TOOL);
  });

  it('mutates the copy when the candidate is given by an absolute path into the project', async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, 'port-anything.yaml'), `version: 1\nprogram_name: tool\nreference: { cmd: ./ref/tool.js }\ncandidate: { cmd: ${JSON.stringify(join(cwd, 'port', 'tool.js'))} }\n`);
    const json = JSON.parse((await strength(['--json'], cwd)).stdout);
    expect(json).toMatchObject({ mutants: 6, caught: 4, missed: 2, score: 0.6667 });
  });

  it('exits 3 when the candidate matches no case, or has neither a build step nor a script to mutate', async () => {
    const wrong = makeProject(TOOL.replace("console.log(Number(a) + Number(b))", "console.log('?')").replace('? a : b', "? '?' : '?'"));
    const none = await strength([], wrong);
    expect(none).toMatchObject({ exitCode: 3, stdout: '' });
    expect(none.stderr).toMatch(/The candidate matches none of the 3 cases/);
    rmSync(wrong, { recursive: true, force: true });

    const compiled = makeProject();
    writeFileSync(join(compiled, 'port', 'tool'), TOOL, { mode: 0o755 });
    writeFileSync(join(compiled, 'port-anything.yaml'), 'version: 1\nprogram_name: tool\nreference: { cmd: ./ref/tool.js }\ncandidate: { cmd: ./port/tool }\n');
    const unbuilt = await strength([], compiled);
    expect(unbuilt.exitCode).toBe(3);
    expect(unbuilt.stderr).toMatch(/no build step and is not a script.*set candidate\.build/);
  });

  it('exits 3 without a candidate', async () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, 'port-anything.yaml'), 'version: 1\nreference: { cmd: ./ref/tool.js }\n');
    expect((await strength([], cwd)).stderr).toMatch(/No candidate to measure/);
  });
});

describe('strength --check', () => {
  const spec = (cwd: string, cases: string[]): CheckSpec => ({ project: cwd, candidate: './port/tool.js', cases, noSandbox: true, concurrency: 2, errors: join(cwd, 'errors.log') });
  const ids = async (cwd: string) => (await loadCommittedCases(cwd, new BlobStore(cacheDir(cwd)))).map((c) => c.id);

  it('passes while every case matches and stops at a diverging one', async () => {
    const cwd = makeProject();
    expect(await runCheck(spec(cwd, await ids(cwd)), { probe: NO_SANDBOX })).toEqual({});
    writeFileSync(join(cwd, 'port', 'tool.js'), TOOL.replace('+ Number(b)', '- Number(b)'));
    const [add] = await ids(cwd);
    expect(await runCheck(spec(cwd, await ids(cwd)), { probe: NO_SANDBOX })).toEqual({ diverged: { case: add, fields: ['stdout'] } });
  });

  it('counts a divergence only when a re-run of the case confirms it', async () => {
    const cwd = makeProject();
    // Wrong on every other run, as a case that times out under load would be: never twice in a row.
    const counter = join(cwd, 'runs');
    writeFileSync(
      join(cwd, 'port', 'tool.js'),
      TOOL.replace("const [cmd, a, b]", `const fs = require('fs');\nconst n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;\nfs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));\nif (n % 2 === 0) { console.log('?'); process.exit(0); }\nconst [cmd, a, b]`),
    );
    expect(await runCheck({ ...spec(cwd, await ids(cwd)), concurrency: 1 }, { probe: NO_SANDBOX })).toEqual({});
    expect(readFileSync(counter, 'utf8')).toBe('6');
  });

  it('runs a given executable in place of the candidate, and takes paths under root from the working directory', async () => {
    const cwd = makeProject();
    const mutant = join(cwd, 'mutant.js');
    writeFileSync(mutant, TOOL.replace('+ Number(b)', '* Number(b)'), { mode: 0o755 });
    expect(await runCheck(spec(cwd, await ids(cwd)), { executable: mutant, probe: NO_SANDBOX })).toHaveProperty('diverged');
    // As in Stryker's sandbox: a copy of port/ as the working directory, here with the bug in it.
    const sandbox = join(cwd, 'sandbox');
    mkdirSync(sandbox);
    writeFileSync(join(sandbox, 'tool.js'), TOOL.replace('+ Number(b)', '* Number(b)'), { mode: 0o755 });
    const cwdBefore = process.cwd();
    process.chdir(sandbox);
    try {
      expect(await runCheck({ ...spec(cwd, await ids(cwd)), root: join(cwd, 'port') }, { probe: NO_SANDBOX })).toHaveProperty('diverged');
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it('exits 3 and logs why when the check cannot run, so a failure never counts as a catch', async () => {
    const cwd = makeProject();
    const file = join(cwd, 'spec.json');
    writeFileSync(file, JSON.stringify({ ...spec(cwd, ['sha256:' + '0'.repeat(64)]) }));
    const result = await strengthCommand(['--check', file], { cwd });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(join(cwd, 'errors.log'), 'utf8')).toMatch(/The corpus changed while measuring: 1 of the cases to check are gone/);
  });
});
