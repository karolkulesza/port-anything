import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxProbe } from '@port-anything/core';
import { afterEach, describe, expect, it } from 'vitest';
import { strengthCommand } from '../src/strength-command.js';

// Which mutation tool `strength` picks, and the Stryker and mull runs end to end. Those two need
// the tools, so they run only where they are:
//   PA_STRENGTH_STRYKER=1  installs @stryker-mutator/core from npm into a temporary package
//   mull-runner-N, clang-N and clang++-N on the PATH (mull's .deb for that LLVM version)
// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

const JS_TOOL = `#!/usr/bin/env node
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'add') console.log(Number(a) + Number(b));
else if (cmd === 'max') console.log(Number(a) > Number(b) ? a : b);
else {
  console.error('usage: tool add|max A B');
  process.exit(2);
}
`;

const C_TOOL = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 4) { fprintf(stderr, "usage: tool add|max A B\\n"); return 2; }
  long a = atol(argv[2]), b = atol(argv[3]);
  if (strcmp(argv[1], "add") == 0) printf("%ld\\n", a + b);
  else if (strcmp(argv[1], "max") == 0) printf("%ld\\n", a > b ? a : b);
  else return 2;
  return 0;
}
`;

const CASES = [['add', '1', '2'], ['max', '1', '2'], ['max', '5', '3']];

let project: string | undefined;
afterEach(() => {
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
  project = undefined;
});

/** A project with `files` (path → content; executable when the name has no extension or ends in .js), a config and the cases. */
function makeProject(files: Record<string, string>, candidate: string): string {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-strength-tools-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), content);
    if (/(^|\/)[^./]+$|\.js$/.test(path)) chmodSync(join(project, path), 0o755);
  }
  writeFileSync(join(project, 'port-anything.yaml'), `version: 1\nprogram_name: tool\nreference: { cmd: ./ref/tool }\ncandidate: ${candidate}\ncorpus: { min_cases_per_feature: 1 }\n`);
  mkdirSync(join(project, 'port-anything', 'recorded'), { recursive: true });
  writeFileSync(join(project, 'port-anything', 'recorded', 'recorded.jsonl'), CASES.map((argv) => JSON.stringify({ argv, origin: 'recorded' })).join('\n'));
  return project;
}

const sandboxed = process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1';
// Stryker and mull run the built CLI for each mutant, not this test's process.
const cliEntry = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const strength = (cwd: string, argv: string[] = []) => strengthCommand([...(sandboxed ? [] : ['--no-sandbox']), ...argv], { cwd, cliEntry, ...(sandboxed ? {} : { probe: NO_SANDBOX }) });

const onPath = (name: RegExp) =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((f) => name.test(f)));
const mullVersion = onPath(/^mull-runner-\d+$/)
  .map((f) => f.replace('mull-runner-', ''))
  .find((v) => onPath(new RegExp(`^clang-${v}$`)).length > 0);
const cc = onPath(/^(cc|gcc|clang)$/)[0];

describe('strength picks its mutation tool', { timeout: 120_000 }, () => {
  it('uses the generic mutator for a JS package without Stryker, and says how to get Stryker', async () => {
    const cwd = makeProject({ 'ref/tool': JS_TOOL, 'port/tool.js': JS_TOOL, 'port/package.json': '{"name": "port", "private": true}' }, '{ cmd: ./port/tool.js }');
    const json = JSON.parse((await strength(cwd, ['--json'])).stdout);
    expect(json).toMatchObject({ tool: 'port-anything generic source mutator', mutants: 6, caught: 4 });
    expect(json.notes).toEqual(['Stryker is not installed for port (npm install --save-dev @stryker-mutator/core), so the generic source mutator ran.']);
  });

  it.runIf(cc !== undefined && mullVersion === undefined)('uses the generic mutator for C without mull, rebuilding each mutant', async () => {
    const cwd = makeProject({ 'ref/tool': JS_TOOL, 'port/tool.c': C_TOOL }, `{ cmd: ./port/tool, build: '${cc} -o port/tool port/tool.c' }`);
    execFileSync(cc!, ['-o', 'port/tool', 'port/tool.c'], { cwd });
    const json = JSON.parse((await strength(cwd, ['--json', '--mutants', '4'])).stdout);
    expect(json).toMatchObject({ tool: 'port-anything generic source mutator', generated: 15, mutants: 4 });
    expect(json.notes).toEqual(['mull and its clang are not on the PATH, so the generic source mutator ran.']);
  });

  it('refuses a candidate whose source is outside the project, since it mutates a copy of the project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pa-cli-strength-outside-')));
    try {
      writeFileSync(join(outside, 'tool.js'), JS_TOOL);
      const cwd = makeProject({ 'ref/tool': JS_TOOL }, `{ cmd: [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(outside, 'tool.js'))}] }`);
      // Without a sandbox: bwrap hides the host's /tmp, where the candidate's script is.
      const result = await strengthCommand(['--no-sandbox'], { cwd, probe: NO_SANDBOX });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain(`The candidate's source (found from ${join(outside, 'tool.js')}) is outside the project directory`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.env.PA_STRENGTH_STRYKER === '1')('strength with Stryker', { timeout: 600_000 }, () => {
  it('mutates a JS candidate with Stryker in its sandbox and reports every mutant', async () => {
    const cwd = makeProject({ 'ref/tool': JS_TOOL, 'port/tool.js': JS_TOOL, 'port/package.json': '{"name": "port", "private": true}' }, '{ cmd: ./port/tool.js }');
    execFileSync('npm', ['install', '--no-fund', '--no-audit', '--save-dev', '@stryker-mutator/core@10.0.0'], { cwd: join(cwd, 'port'), stdio: 'ignore' });
    const result = await strength(cwd);
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n').filter((l) => !l.startsWith('candidate '))).toEqual([
      'corpus strength 70.5%: the corpus kills 12 of 17 mutants of the candidate',
      '17 of 17 mutants tested: 12 caught, 5 missed, 0 timed out, 0 unviable',
      'on the 3 of 3 cases the candidate matches',
      "surviving mutants (5), behavior the corpus doesn't test:",
      '  tool.js:4:10: ConditionalExpression, replace with true',
      '  tool.js:4:37: EqualityOperator, replace with Number(a) >= Number(b)',
      '  tool.js:5:6: BlockStatement, replace with {}',
      '  tool.js:6:17: StringLiteral, replace with ""',
      '  tool.js:7:3: CallExpression, replace with ;',
      '',
    ]);
    expect(result.stdout).toContain('mutated with Stryker 10.0.0');
    expect(readdirSync(join(cwd, 'port')).sort()).toEqual(['node_modules', 'package-lock.json', 'package.json', 'tool.js']);
  });
});

describe.runIf(mullVersion !== undefined)('strength with mull', { timeout: 600_000 }, () => {
  it('builds a C candidate once with mull and switches each mutant on while the corpus runs', async () => {
    const clang = `clang-${mullVersion}`;
    const cwd = makeProject({ 'ref/tool.c': C_TOOL, 'port/tool.c': C_TOOL, 'port/Makefile': 'tool: tool.c\n\t$(CC) $(CFLAGS) -o tool tool.c\n' }, '{ cmd: ./port/tool, build: make -B -C port }');
    execFileSync(clang, ['-O2', '-o', 'ref/tool', 'ref/tool.c'], { cwd });
    execFileSync('make', [`CC=${clang}`, '-C', 'port'], { cwd, stdio: 'ignore' });
    const result = await strength(cwd);
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n').filter((l) => !l.startsWith('candidate '))).toEqual([
      'corpus strength 83.3%: the corpus kills 5 of 6 mutants of the candidate',
      '6 of 6 mutants tested: 5 caught, 1 missed, 0 timed out, 0 unviable',
      'on the 3 of 3 cases the candidate matches',
      "surviving mutants (1), behavior the corpus doesn't test:",
      '  port/tool.c:8:59: cxx_gt_to_ge, replace with >=',
      '',
    ]);
    expect(result.stdout).toMatch(/mutated with mull \d+\.\d+\.\d+/);
  });
});
