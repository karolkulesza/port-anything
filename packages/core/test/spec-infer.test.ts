import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../src/blob-store.js';
import { ConfigError } from '../src/config.js';
import { parseProgramCommand, resolveProgram } from '../src/program.js';
import { inferCliSpec } from '../src/spec-infer.js';

// A small program with a help text, a subcommand and an option parser, as a shell script.
// `lax` accepts unknown flags; `ghost` lists a flag it doesn't have; `mute` prints help only for -h.
const TOOL = (variant: 'good' | 'lax' | 'ghost' | 'mute') => `#!/bin/sh
if [ "$1" = make ] && [ "$2" = --help ]; then
  printf 'Usage: frob make [-f] NAME\\n\\n  -f, --force   overwrite\\n'; exit 0
fi
if [ "$1" = ${variant === 'mute' ? '-h' : '--help'} ]; then
  cat <<'EOF'
Usage: frob [OPTION]... [FILE]...

Commands:
  make     Make a frob

Options:
  -q, --quiet        say less
  -n, --count=N      stop after N lines
${variant === 'ghost' ? '      --ghost        not really there\n' : ''}      --help         display this help and exit
EOF
  exit 0
fi
while [ $# -gt 0 ]; do
  case "$1" in
    make) ;;
    -q|--quiet) ;;
    -n|--count) [ $# -ge 2 ] || { echo "frob: option '$1' requires an argument" >&2; exit 2; }; shift ;;
    -*) ${variant === 'lax' ? ':' : `echo "frob: unrecognized option '$1'" >&2; exit 2`} ;;
  esac
  shift
done
echo ok
`;

describe('inferCliSpec', () => {
  let root: string;
  let scratch = 0;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pa-spec-infer-')));
    for (const variant of ['good', 'lax', 'ghost', 'mute'] as const) {
      mkdirSync(join(root, variant));
      writeFileSync(join(root, variant, 'frob'), TOOL(variant), { mode: 0o755 });
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const infer = async (variant: string) =>
    inferCliSpec({
      reference: await resolveProgram(parseProgramCommand(join(root, variant, 'frob'))),
      store: new BlobStore(join(root, 'cache')),
      sandbox: { kind: 'none' },
      workDir: join(root, `work-${scratch++}`),
    });

  it('reads the help of the program and its subcommands, and every probe passes', async () => {
    const { spec, helpArgv, probes } = await infer('good');
    expect(helpArgv).toEqual(['--help']);
    expect(spec.program).toBe('frob');
    expect(spec.flags.map((f) => [f.feature, f.arity, f.self_description ?? false])).toEqual([
      ['opt.quiet', 0, false],
      ['opt.count', 1, false],
      ['opt.help', 0, true],
    ]);
    expect(spec.subcommands).toMatchObject([{ name: 'make', feature: 'cmd.make', flags: [{ feature: 'cmd.make.opt.force' }], forms: [{ args: [{ name: 'NAME', arity: '1' }] }] }]);
    expect(probes.filter((p) => p.status !== 'pass')).toEqual([]);
    expect(probes.map((p) => p.kind)).toEqual(expect.arrayContaining(['unknown-long', 'unknown-short', 'missing-value', 'known-flag']));
  });

  it('fails the probes of a program that accepts unknown flags', async () => {
    const { probes } = await infer('lax');
    expect(probes.filter((p) => p.status === 'fail').map((p) => p.argv.join(' '))).toEqual([
      '--port-anything-no-such-flag',
      '-Q',
      'make --port-anything-no-such-flag',
    ]);
  });

  it('fails a listed flag the program rejects as unknown', async () => {
    const { probes } = await infer('ghost');
    expect(probes.filter((p) => p.status === 'fail').map((p) => p.flag)).toEqual(['--ghost']);
  });

  it('falls back to -h, and refuses a program without help text', async () => {
    expect((await infer('mute')).helpArgv).toEqual(['-h']);
    mkdirSync(join(root, 'silent'));
    writeFileSync(join(root, 'silent', 'frob'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(infer('silent')).rejects.toThrow(ConfigError);
    await expect(infer('silent')).rejects.toThrow('no help text');
    await expect(infer('silent')).rejects.toThrow('Write port-anything/cli-spec.yaml yourself');
  });

  it('falls back to the usage line a program prints when called with no arguments (awk)', async () => {
    mkdirSync(join(root, 'bare'));
    // Like onetrue-awk: --help and -h are unknown options, no arguments prints the usage line.
    writeFileSync(
      join(root, 'bare', 'frob'),
      `#!/bin/sh
if [ $# -eq 0 ]; then echo "usage: frob [-F fs] [-v var=value] [-f progfile | 'prog'] [file ...]" >&2; exit 2; fi
case "$1" in -F|-v|-f) [ $# -ge 2 ] || exit 2 ;; -*) echo "frob: unknown option $1 ignored" >&2 ;; esac
echo ok
`,
      { mode: 0o755 },
    );
    const { spec, helpArgv } = await infer('bare');
    expect(helpArgv).toEqual([]);
    // With working help, the program is never run with no arguments.
    mkdirSync(join(root, 'counted'));
    writeFileSync(join(root, 'counted', 'frob'), `#!/bin/sh\nif [ $# -eq 0 ]; then echo called > ${JSON.stringify(join(root, 'bare-call'))}; fi\nprintf 'Usage: frob [-q] FILE\\n'\n`, { mode: 0o755 });
    expect((await infer('counted')).helpArgv).toEqual(['--help']);
    expect(existsSync(join(root, 'bare-call'))).toBe(false);
    expect(spec.flags.map((f) => [f.names, f.arity])).toEqual([
      [['-F'], 1],
      [['-v'], 1],
      [['-f'], 1],
    ]);
    expect(spec.forms[0]!.args).toEqual([
      { name: 'prog', type: 'string', arity: '?' },
      { name: 'file', type: 'path', arity: '*' },
    ]);
  });
});
