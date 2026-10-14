import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { cliSpecYaml, parseCliSpec } from '../src/cli-spec.js';
import { cliSpecFromHelp, parseHelp, type HelpFlag } from '../src/help-parser.js';

// The parser against the help texts of real tools in the dev container (Ubuntu: GNU coreutils with
// a "gnu" prefix, uutils, busybox, toybox, jq, gojq, jaq, git…). The texts are captured here, at
// test time, and never committed: many are GPL. Run with: scripts/dev-linux.sh pnpm -r test

interface Expected {
  /** Flags by one of their names: the names they must have, their values. */
  flags?: Record<string, { names?: string[]; values?: object[]; self?: boolean }>;
  /** Positional arguments of the first form. */
  args?: object[];
  /** Subcommands that must be found. */
  subcommands?: string[];
  /** Fewest flags the parse must find. */
  minFlags: number;
}

interface Tool {
  argv: string[];
  program: string;
  expected: Expected;
}

const file = { name: 'FILE', type: 'path', arity: '*' };
const self = { self: true };

const TOOLS: Tool[] = [
  {
    argv: ['gnusort', '--help'],
    program: 'gnusort',
    expected: {
      minFlags: 30,
      args: [file],
      flags: {
        '-n': { names: ['-n', '--numeric-sort'], values: [] },
        '-k': { names: ['-k', '--key'], values: [{ name: 'KEYDEF', type: 'string' }] },
        '-o': { values: [{ name: 'FILE', type: 'path' }] },
        '-S': { values: [{ name: 'SIZE', type: 'size' }] },
        '--parallel': { values: [{ name: 'N', type: 'int' }] },
        '--sort': { values: [{ type: 'enum', choices: ['general-numeric', 'human-numeric', 'month', 'numeric', 'random', 'version'] }] },
        '-c': { names: ['-c', '--check'], values: [{ type: 'enum', choices: ['diagnose-first', 'quiet', 'silent'], optional: true }] },
        '--help': self,
        '--version': self,
      },
    },
  },
  {
    argv: ['gnuwc', '--help'],
    program: 'gnuwc',
    expected: {
      minFlags: 9,
      args: [file],
      flags: { '-l': { names: ['-l', '--lines'] }, '--total': { values: [{ type: 'enum', choices: ['auto', 'always', 'only', 'never'] }] }, '--help': self },
    },
  },
  {
    argv: ['gnuls', '--help'],
    program: 'gnuls',
    expected: {
      minFlags: 50,
      args: [file],
      flags: {
        '--color': { values: [{ name: 'WHEN', type: 'enum', choices: ['always', 'auto', 'never'], optional: true }] },
        '--quoting-style': { values: [{ type: 'enum' }] },
        '-w': { names: ['-w', '--width'], values: [{ name: 'COLS', type: 'int' }] },
        '-l': { values: [] },
      },
    },
  },
  {
    argv: ['gnudate', '--help'],
    program: 'gnudate',
    expected: {
      minFlags: 10,
      args: [{ name: '+FORMAT', type: 'string', arity: '?' }],
      flags: {
        '-u': { names: ['-u', '--utc', '--universal'] },
        '-I': { names: ['-I', '--iso-8601'], values: [{ name: 'FMT', type: 'enum', optional: true }] },
        '--rfc-3339': { values: [{ name: 'FMT', type: 'enum', choices: ['date', 'seconds', 'ns'] }] },
        '-r': { values: [{ name: 'FILE', type: 'path' }] },
      },
    },
  },
  {
    argv: ['gnucut', '--help'],
    program: 'gnucut',
    expected: { minFlags: 8, args: [file], flags: { '-f': { names: ['-f', '--fields'], values: [{ name: 'LIST', type: 'string' }] }, '-d': { values: [{ name: 'DELIM' }] } } },
  },
  {
    argv: ['gnunumfmt', '--help'],
    program: 'gnunumfmt',
    expected: {
      minFlags: 15,
      flags: {
        '--invalid': { values: [{ name: 'MODE', type: 'enum', choices: ['abort', 'fail', 'warn', 'ignore'] }] },
        '--round': { values: [{ name: 'METHOD', type: 'enum' }] },
        '--header': { values: [{ name: 'N', type: 'int', optional: true }] },
      },
    },
  },
  {
    argv: ['gnuhead', '--help'],
    program: 'gnuhead',
    expected: { minFlags: 6, args: [file], flags: { '-n': { names: ['-n', '--lines'], values: [{ type: 'string' }] }, '-q': { names: ['-q', '--quiet', '--silent'] } } },
  },
  {
    argv: ['gnuod', '--help'],
    program: 'gnuod',
    expected: { minFlags: 12, flags: { '-A': { names: ['-A', '--address-radix'], values: [{ name: 'RADIX' }] }, '-N': { values: [{ name: 'BYTES', type: 'size' }] } } },
  },
  {
    argv: ['sort', '--help'],
    program: 'sort',
    expected: {
      minFlags: 25,
      args: [file],
      flags: {
        '-o': { values: [{ name: 'FILENAME', type: 'path' }] },
        '--sort': { values: [{ type: 'enum', choices: ['general-numeric', 'human-numeric', 'month', 'numeric', 'version', 'random'] }] },
        '-c': { values: [{ type: 'enum', optional: true }] },
        '--help': self,
      },
    },
  },
  {
    argv: ['ls', '--help'],
    program: 'ls',
    expected: { minFlags: 50, args: [file], flags: { '--color': { values: [{ type: 'enum', choices: ['always', 'auto', 'never'], optional: true }] }, '-V': self } },
  },
  {
    argv: ['grep', '--help'],
    program: 'grep',
    expected: {
      minFlags: 40,
      args: [{ name: 'PATTERNS', type: 'string', arity: '1' }, file],
      flags: {
        '-e': { names: ['-e', '--regexp'], values: [{ name: 'PATTERNS' }] },
        '--color': { names: ['--color', '--colour'], values: [{ type: 'enum', choices: ['always', 'never', 'auto'], optional: true }] },
        '-d': { values: [{ name: 'ACTION', type: 'enum', choices: ['read', 'recurse', 'skip'] }] },
        '-m': { values: [{ name: 'NUM', type: 'int' }] },
      },
    },
  },
  {
    argv: ['sed', '--help'],
    program: 'sed',
    expected: {
      minFlags: 12,
      flags: {
        '-e': { names: ['-e', '--expression'], values: [{ name: 'script' }] },
        '-f': { names: ['-f', '--file'], values: [{ name: 'script-file', type: 'path' }] },
        '-i': { values: [{ name: 'SUFFIX', optional: true }] },
        '-E': { names: ['-E', '-r', '--regexp-extended'] },
      },
    },
  },
  {
    argv: ['diff', '--help'],
    program: 'diff',
    expected: { minFlags: 40, flags: { '-u': { names: ['-u', '-U', '--unified'], values: [{ name: 'NUM', type: 'int' }] }, '--color': { values: [{ type: 'enum', optional: true }] } } },
  },
  {
    argv: ['tar', '--help'],
    program: 'tar',
    expected: {
      minFlags: 100,
      args: [file],
      flags: {
        '-x': { names: ['-x', '--extract', '--get'], values: [] },
        '-d': { names: ['-d', '--diff', '--compare'] },
        '-f': { values: [{ name: 'ARCHIVE' }] },
        '-C': { values: [{ name: 'DIR', type: 'path' }] },
        '--usage': self,
        '-?': self,
      },
    },
  },
  {
    argv: ['xargs', '--help'],
    program: 'xargs',
    expected: {
      minFlags: 15,
      args: [{ name: 'COMMAND', type: 'string', arity: '1' }, { name: 'INITIAL-ARGS', type: 'string', arity: '*' }],
      flags: { '-n': { values: [{ name: 'MAX-ARGS', type: 'int' }] }, '-0': { names: ['-0', '--null'] } },
    },
  },
  {
    argv: ['jq', '--help'],
    program: 'jq',
    expected: {
      minFlags: 25,
      args: [{ name: 'jq filter', type: 'string', arity: '1' }, { name: 'file', type: 'path', arity: '*' }],
      flags: {
        '--arg': { values: [{ name: 'name' }, { name: 'value' }] },
        '--indent': { values: [{ name: 'n', type: 'int' }] },
        '--slurpfile': { values: [{ name: 'name' }, { name: 'file', type: 'path' }] },
        '-f': { values: [] },
        '-h': self,
      },
    },
  },
  {
    argv: ['gojq', '--help'],
    program: 'gojq',
    expected: { minFlags: 20, flags: { '--indent': { values: [{ type: 'string' }] }, '-L': { values: [{ type: 'string' }] }, '--arg': { values: [{}, {}] }, '-v': self } },
  },
  {
    argv: ['jaq', '--help'],
    program: 'jaq',
    expected: {
      minFlags: 20,
      args: [{ name: 'FILTER', type: 'string', arity: '?' }, { name: 'ARG', type: 'string', arity: '*' }],
      flags: { '--arg': { values: [{ name: 'A' }, { name: 'V' }] }, '-L': { values: [{ name: 'DIR', type: 'path' }] }, '--indent': { values: [{ name: 'N', type: 'int' }] } },
    },
  },
  {
    argv: ['git', '--help'],
    program: 'git',
    expected: {
      minFlags: 15,
      args: [{ name: 'command', type: 'string', arity: '1' }, { name: 'args', type: 'string', arity: '?' }],
      subcommands: ['clone', 'init', 'add', 'commit', 'log', 'status'],
      flags: { '-v': { names: ['-v', '--version'], self: true }, '-C': { values: [{ name: 'path', type: 'path' }] }, '--git-dir': { values: [{ name: 'path' }] } },
    },
  },
  {
    argv: ['curl', '--help'],
    program: 'curl',
    expected: {
      minFlags: 10,
      args: [{ name: 'url', type: 'string', arity: '1' }],
      flags: { '-o': { names: ['-o', '--output'], values: [{ name: 'file', type: 'path' }] }, '-s': { values: [] }, '-h': { values: [{ name: 'subject' }], self: true } },
    },
  },
  {
    argv: ['bwrap', '--help'],
    program: 'bwrap',
    expected: {
      minFlags: 50,
      args: [{ name: 'COMMAND', type: 'string', arity: '1' }, { name: 'ARGS', type: 'string', arity: '*' }],
      flags: { '--bind': { values: [{ name: 'SRC' }, { name: 'DEST' }] }, '--uid': { values: [{ name: 'UID', type: 'int' }] }, '--unshare-net': { values: [] } },
    },
  },
  {
    argv: ['strace', '--help'],
    program: 'strace',
    expected: { minFlags: 40, flags: { '-o': { names: ['-o', '--output'], values: [{ name: 'FILE', type: 'path' }] }, '-p': { values: [{ name: 'PID', type: 'int' }] }, '-h': self } },
  },
  {
    argv: ['busybox', 'sort', '--help'],
    program: 'sort',
    expected: { minFlags: 17, args: [file], flags: { '-o': { values: [{ name: 'FILE', type: 'path' }] }, '-t': { values: [{ name: 'CHAR' }] }, '-n': { values: [] } } },
  },
  {
    argv: ['busybox', 'wc', '--help'],
    program: 'wc',
    expected: { minFlags: 5, args: [file], flags: { '-L': { values: [] }, '-c': { values: [] } } },
  },
  {
    argv: ['toybox', 'sort', '--help'],
    program: 'sort',
    expected: { minFlags: 18, args: [{ name: 'FILE', type: 'path', arity: '*' }], flags: { '-o': { values: [{ name: 'FILE', type: 'path' }] }, '-t': { values: [{ name: 'X' }] }, '-x': { values: [] } } },
  },
  {
    argv: ['find', '--help'],
    program: 'find',
    expected: { minFlags: 5, args: [{ name: 'path', type: 'path', arity: '*' }, { name: 'expression', type: 'string', arity: '?' }], flags: { '-H': {}, '-D': { values: [{ name: 'debugopts' }] } } },
  },
];

/** The help text a tool prints: stdout, or stderr for tools that write help there (busybox). */
function captureHelp(argv: string[]): string {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', COLUMNS: '80' } });
  if (result.error) throw result.error;
  return result.stdout.trim() !== '' ? result.stdout : result.stderr;
}

const flagNamed = (flags: HelpFlag[], name: string) => flags.find((f) => f.names.includes(name));

describe.runIf(process.platform === 'linux' && process.env.PA_SANDBOX_TESTS === '1')('parseHelp on real tools (Linux)', () => {
  it('covers about 20 tools', () => expect(TOOLS.length).toBeGreaterThanOrEqual(20));

  it.each(TOOLS.map((t) => [t.argv.join(' '), t] as const))('%s', (_, tool) => {
    const help = parseHelp(captureHelp(tool.argv), { program: tool.program });
    const { expected } = tool;
    expect(help.flags.length).toBeGreaterThanOrEqual(expected.minFlags);
    if (expected.args) expect(help.forms[0]?.args).toMatchObject(expected.args);
    if (expected.subcommands) expect(help.subcommands.map((s) => s.name)).toEqual(expect.arrayContaining(expected.subcommands));
    const spec = cliSpecFromHelp(tool.program, help);
    for (const [name, want] of Object.entries(expected.flags ?? {})) {
      const found = flagNamed(help.flags, name);
      expect(found, `flag ${name}`).toBeDefined();
      if (want.names) expect(found!.names, `names of ${name}`).toEqual(want.names);
      if (want.values) expect(found!.values, `values of ${name}`).toMatchObject(want.values);
      if (want.values) expect(found!.values, `values of ${name}`).toHaveLength(want.values.length);
      const inSpec = spec.flags.find((f) => f.names.includes(name))!;
      expect(inSpec.self_description === true, `${name} self-description`).toBe(want.self === true);
    }
    // Every parse makes a valid spec that survives the YAML round trip.
    expect(parseCliSpec(parseDocument(cliSpecYaml(spec)).toJS())).toEqual(spec);
  });
});
