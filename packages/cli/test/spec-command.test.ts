import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_SPEC_FILE, readCliSpecFile, type SandboxProbe } from '@port-anything/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { specCommand } from '../src/spec-command.js';

// Needs @port-anything/core built (`pnpm build`), like the other CLI tests.
const TOOL = (lax: boolean) => `#!/bin/sh
if [ "$1" = --help ]; then
  printf 'Usage: frob [OPTION]... [FILE]...\\n\\n  -q, --quiet     say less\\n  -n, --count=N   stop after N lines\\n      --help      display this help and exit\\n'
  exit 0
fi
while [ $# -gt 0 ]; do
  case "$1" in
    -q|--quiet) ;;
    -n|--count) [ $# -ge 2 ] || { echo "frob: option '$1' requires an argument" >&2; exit 2; }; shift ;;
    -*) ${lax ? ':' : `echo "frob: unrecognized option '$1'" >&2; exit 2`} ;;
  esac
  shift
done
`;

const NO_SANDBOX: SandboxProbe = { usable: undefined, attempts: [{ kind: 'bwrap', ok: false, error: 'bwrap is not installed' }], fix: '  1. Install bubblewrap.' };

describe('port-anything spec infer', () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'pa-spec-command-')));
    writeFileSync(join(project, 'frob'), TOOL(false), { mode: 0o755 });
    writeFileSync(join(project, 'lax'), TOOL(true), { mode: 0o755 });
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nprogram_name: frob\nreference:\n  cmd: ./frob\n');
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  const infer = (args: string[] = ['infer', '--no-sandbox']) => specCommand(args, { cwd: project, probe: NO_SANDBOX });

  it('writes the spec, reports what it found and that every probe passed, and leaves no scratch files', async () => {
    const result = await infer();
    expect(result).toEqual({
      exitCode: 0,
      stdout: [
        `Wrote ${CLI_SPEC_FILE} from "frob --help", sandbox: none (--no-sandbox)`,
        '  3 flags, 1 form, 0 subcommands; 3 features (1 self-description)',
        'Probes: 8 of 8 pass',
        '',
      ].join('\n'),
      stderr: '',
    });
    const spec = await readCliSpecFile(project);
    expect(spec.flags.map((f) => f.feature)).toEqual(['opt.quiet', 'opt.count', 'opt.help']);
    expect(spec.forms[0]!.args).toEqual([{ name: 'FILE', type: 'path', arity: '*' }]);
    expect(readdirSync(join(project, '.port-anything'))).toEqual(['cache']);
  });

  it('refuses to overwrite an existing spec', async () => {
    expect((await infer()).exitCode).toBe(0);
    const again = await infer();
    expect(again.exitCode).toBe(3);
    expect(again.stderr).toMatch(/cli-spec.yaml already exists and may hold refinements; delete it/);
  });

  it('writes the spec but exits 1 and lists the failed probes when the reference accepts unknown flags (listed flags then cannot be judged)', async () => {
    writeFileSync(join(project, 'port-anything.yaml'), 'version: 1\nprogram_name: frob\nreference:\n  cmd: ./lax\n');
    const result = await infer();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Probes: 1 of 8 pass, 2 fail, 5 inconclusive\n');
    expect(result.stdout).toContain('  fail  --port-anything-no-such-flag: exit 0: the program accepts the unknown flag --port-anything-no-such-flag\n');
    expect(result.stdout).toContain('  fail  -Q: exit 0: the program accepts the unknown flag -Q\n');
    expect(existsSync(join(project, CLI_SPEC_FILE))).toBe(true);
  });

  it('prints its usage for --help, and exits 3 for a wrong command line, a missing sandbox, a missing config or a reference without help', async () => {
    expect(await infer(['--help'])).toEqual({ exitCode: 0, stdout: 'Usage: port-anything spec infer [--no-sandbox]\n', stderr: '' });
    expect((await infer([])).stderr).toMatch(/which spec command\?\nUsage: port-anything spec infer/);
    expect((await infer(['guess'])).stderr).toMatch(/unknown spec command "guess"/);
    expect((await infer(['infer', '--bogus'])).stderr).toMatch(/bogus/);
    const sandboxless = await infer(['infer']);
    expect(sandboxless.exitCode).toBe(3);
    expect(sandboxless.stderr).toMatch(/Install bubblewrap/);
    writeFileSync(join(project, 'frob'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await infer()).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/no help text/) });
    rmSync(join(project, 'port-anything.yaml'));
    expect(await infer()).toMatchObject({ exitCode: 3, stderr: expect.stringMatching(/No port-anything.yaml/) });
    expect(existsSync(join(project, CLI_SPEC_FILE))).toBe(false);
  });
});
