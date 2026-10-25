import { describe, expect, it } from 'vitest';
import { cliSpecFromHelp, isSelfDescription, parseHelp, valueType, type HelpFlag } from '../src/help-parser.js';

// Invented help texts in the layouts real tools use. The real tools' own help texts are parsed in
// help-parser.linux.test.ts, captured at test time and never committed.

const flag = (flags: HelpFlag[], name: string) => {
  const found = flags.find((f) => f.names.includes(name));
  if (!found) throw new Error(`no flag ${name} in ${JSON.stringify(flags.map((f) => f.names))}`);
  return found;
};

describe('parseHelp: GNU layout', () => {
  const text = `Usage: frob [OPTION]... [FILE]...
  or:  frob [OPTION]... --list-from=F
Frobnicate each FILE to standard output.

Mandatory arguments to long options are mandatory for short options too.
  -a, --all                  frob every line
  -k, --key=KEYDEF           frob by a key
  -n, --count=N              stop after N lines
  -o, --output=FILE          write to FILE
  -S, --buffer-size=SIZE     use SIZE bytes of memory
      --color[=WHEN]         colour the output WHEN
      --mode=WORD            frob in mode WORD: fast -f, slow -s, careful
      --total=WHEN           when to print a total line;
                               WHEN can be: auto, always, never
  -I[FMT], --iso[=FMT]       print dates in ISO format;
                               FMT='date' (the default), 'hours' or 'ns'
  -c, --check, --check=noisy  check the input only
  -C, --check=quiet, --check=silent  like -c, but quietly
  -e script, --expression=script
                             add the script
      --list-from=F          read the file list from F
      --help     display this help and exit
      --version  output version information and exit

The WHEN argument defaults to 'always' and can also be 'auto' or 'never'.
Example lines such as
-k2,3 frob by the second key
are not flags.
`;
  const help = parseHelp(text);

  it('reads the program and one form per usage line', () => {
    expect(help.program).toBe('frob');
    expect(help.forms).toEqual([
      { usage: 'frob [OPTION]... [FILE]...', flags: [], args: [{ name: 'FILE', type: 'path', arity: '*' }] },
      { usage: 'frob [OPTION]... --list-from=F', flags: ['--list-from'], args: [] },
    ]);
  });

  it('reads short and long spellings, arity and placeholder types', () => {
    expect(flag(help.flags, '-a')).toEqual({ names: ['-a', '--all'], description: 'frob every line', values: [] });
    expect(flag(help.flags, '--key').values).toEqual([{ name: 'KEYDEF', type: 'int' }]);
    expect(flag(help.flags, '-n').values).toEqual([{ name: 'N', type: 'int' }]);
    expect(flag(help.flags, '-o').values).toEqual([{ name: 'FILE', type: 'path' }]);
    expect(flag(help.flags, '-S').values).toEqual([{ name: 'SIZE', type: 'size' }]);
    expect(flag(help.flags, '-e')).toMatchObject({ names: ['-e', '--expression'], values: [{ name: 'script', type: 'string' }], description: 'add the script' });
  });

  it('reads optional values and their choices from the description or the prose below', () => {
    expect(flag(help.flags, '--color').values).toEqual([{ name: 'WHEN', type: 'enum', choices: ['always', 'auto', 'never'], optional: true }]);
    expect(flag(help.flags, '--total').values).toEqual([{ name: 'WHEN', type: 'enum', choices: ['auto', 'always', 'never'] }]);
    expect(flag(help.flags, '--mode').values).toEqual([{ name: 'WORD', type: 'enum', choices: ['fast', 'slow', 'careful'] }]);
    expect(flag(help.flags, '-I')).toMatchObject({ names: ['-I', '--iso'], values: [{ name: 'FMT', type: 'enum', choices: ['date', 'hours', 'ns'], optional: true }] });
  });

  it('turns --flag=literal spellings into choices of the flag they name', () => {
    expect(flag(help.flags, '-c')).toMatchObject({ names: ['-c', '--check'], values: [{ type: 'enum', choices: ['noisy', 'quiet', 'silent'], optional: true }] });
    expect(flag(help.flags, '-C')).toMatchObject({ names: ['-C'], values: [] });
  });

  it('skips example lines in prose', () => {
    expect(help.flags.some((f) => f.names.some((n) => n.startsWith('-k2')))).toBe(false);
  });
});

describe('parseHelp: clap layout', () => {
  const text = `Frob things.

Usage: frob [OPTIONS] <PATTERN> [PATH]...

Arguments:
  <PATTERN>  What to look for
  [PATH]...  Where to look

Options:
  -m, --mode <MODE>
          How to frob [possible values: fast, slow]
      --check[=<check>...]
          check the input [possible values: quiet, loud]
  -j, --threads <NUM_THREADS>
          Worker threads
      --arg       <A> <V>   Set A to V
  -h, --help
          Print help
  -V, --version
          Print version
`;
  const help = parseHelp(text);

  it('reads descriptions on the next line, angle placeholders and possible values', () => {
    expect(help.forms).toEqual([
      {
        usage: 'frob [OPTIONS] <PATTERN> [PATH]...',
        flags: [],
        args: [
          { name: 'PATTERN', type: 'string', arity: '1' },
          { name: 'PATH', type: 'path', arity: '*' },
        ],
      },
    ]);
    expect(flag(help.flags, '-m')).toEqual({ names: ['-m', '--mode'], description: 'How to frob [possible values: fast, slow]', values: [{ name: 'MODE', type: 'enum', choices: ['fast', 'slow'] }] });
    expect(flag(help.flags, '--check').values).toEqual([{ name: 'check', type: 'enum', choices: ['quiet', 'loud'], optional: true }]);
    expect(flag(help.flags, '-j').values).toEqual([{ name: 'NUM_THREADS', type: 'int' }]);
    expect(flag(help.flags, '--arg')).toMatchObject({ values: [{ name: 'A' }, { name: 'V' }], description: 'Set A to V' });
    expect(flag(help.flags, '-V').description).toBe('Print version');
  });
});

describe('parseHelp: other layouts', () => {
  it('reads lowercase placeholders up to the description column (jq style)', () => {
    const help = parseHelp(`Usage:\tfrob [options] <frob filter> [file...]
\tfrob [options] --raw <frob filter> [strings...]

Options:
  -n, --null                use null as input;
      --indent n            use n spaces;
      --slurpfile name file set name to the file's values;
      --raw                 take raw strings;
  -h, --help                show the help;
`);
    expect(help.program).toBe('frob');
    expect(help.forms.map((f) => [f.flags, f.args])).toEqual([
      [[], [{ name: 'frob filter', type: 'string', arity: '1' }, { name: 'file', type: 'path', arity: '*' }]],
      [['--raw'], [{ name: 'frob filter', type: 'string', arity: '1' }, { name: 'strings', type: 'string', arity: '*' }]],
    ]);
    expect(flag(help.flags, '--indent').values).toEqual([{ name: 'n', type: 'int' }]);
    expect(flag(help.flags, '--slurpfile')).toMatchObject({ values: [{ name: 'name' }, { name: 'file', type: 'path' }], description: "set name to the file's values;" });
    expect(flag(help.flags, '--raw').values).toEqual([]);
  });

  it('reads tab-separated options and adds values and flags from the usage line (busybox, toybox)', () => {
    const help = parseHelp(`Frobbox v1 multi-call binary.

Usage: frob [-abq] [-o FILE] [-t CHAR] [FILE]...

\t-a\tAll lines
\t-o FILE\tOutput to FILE
\t-t\tSeparator
\t-k N[,M] Frob by field N
`);
    expect(flag(help.flags, '-a').description).toBe('All lines');
    expect(flag(help.flags, '-o').values).toEqual([{ name: 'FILE', type: 'path' }]);
    expect(flag(help.flags, '-t').values).toEqual([{ name: 'CHAR', type: 'string' }]);
    expect(flag(help.flags, '-k')).toMatchObject({ values: [{ name: 'N[,M]', type: 'int' }], description: 'Frob by field N' });
    expect(flag(help.flags, '-b').values).toEqual([]);
    expect(flag(help.flags, '-q').values).toEqual([]);
    expect(help.forms[0]!.args).toEqual([{ name: 'FILE', type: 'path', arity: '*' }]);
  });

  it('reads a commands section and a usage line continued on indented lines (git style)', () => {
    const help = parseHelp(`usage: frob [-v | --version] [-C <path>] [--dir=<path>]
            [-p | --page | -P | --no-page]
            <command> [<args>]

Commands to start with
   make      Make a new frob
   twist     Twist a frob

and to finish
   drop      Drop the frob
`);
    expect(help.subcommands).toEqual([
      { name: 'make', description: 'Make a new frob' },
      { name: 'twist', description: 'Twist a frob' },
      { name: 'drop', description: 'Drop the frob' },
    ]);
    expect(help.forms[0]!.args).toEqual([
      { name: 'command', type: 'string', arity: '1' },
      { name: 'args', type: 'string', arity: '?' },
    ]);
    expect(flag(help.flags, '-v').names).toEqual(['-v', '--version']);
    expect(flag(help.flags, '-C').values).toEqual([{ name: 'path', type: 'path' }]);
    expect(flag(help.flags, '--dir').values).toEqual([{ name: 'path', type: 'path' }]);
    expect(flag(help.flags, '-p').names).toEqual(['-p']);
  });

  it('reads argparse-style choices and Go-style empty placeholders', () => {
    const help = parseHelp(`usage: frob [-h] [--mode {fast,slow}] [--indent=] path

options:
  -h, --help          show this help message and exit
  --mode {fast,slow}  how to frob
      --indent=       number of spaces
  -L=                 library directory
`);
    expect(flag(help.flags, '--mode').values).toEqual([{ name: '{fast,slow}', type: 'enum', choices: ['fast', 'slow'] }]);
    expect(flag(help.flags, '--indent').values).toEqual([{ name: 'INDENT', type: 'string' }]);
    expect(flag(help.flags, '-L').values).toEqual([{ name: 'L', type: 'string' }]);
    expect(help.forms[0]!.args).toEqual([{ name: 'path', type: 'path', arity: '1' }]);
  });

  it('stops the usage at an option line right under it (curl style)', () => {
    const help = parseHelp(`Usage: frob [options...] <url>
 -d, --data <data>    Data to send
 -s, --silent         Say nothing
`);
    expect(help.forms).toEqual([{ usage: 'frob [options...] <url>', flags: [], args: [{ name: 'url', type: 'string', arity: '1' }] }]);
    expect(flag(help.flags, '-d').values).toEqual([{ name: 'data', type: 'string' }]);
  });

  it('expands short-option clusters but not a flag with an attached value', () => {
    const help = parseHelp('Usage: frob [-abbc] [-x[yz]] [-Olevel] DIR\n');
    expect(help.flags.map((f) => f.names[0])).toEqual(['-a', '-b', '-c', '-x', '-y', '-z', '-O']);
    expect(flag(help.flags, '-O').values).toEqual([{ name: 'level', type: 'int' }]);
    expect(help.forms[0]!.args).toEqual([{ name: 'DIR', type: 'path', arity: '1' }]);
  });

  it('reads a usage-only text with key positions (BSD style)', () => {
    const help = parseHelp('usage: frob [-bnr] [-kPOS1[,POS2] ... ] [+POS1 [-POS2]] [-S memsize] [-t char] [file ...]\n');
    expect(help.flags.map((f) => f.names[0])).toEqual(['-b', '-n', '-r', '-k', '-S', '-t']);
    expect(flag(help.flags, '-k').values).toEqual([{ name: 'POS1', type: 'int' }]);
    expect(flag(help.flags, '-S').values).toEqual([{ name: 'memsize', type: 'size' }]);
    // `+POS1 -POS2` is the old way to write a key, not a file to read.
    expect(help.forms[0]!.args).toEqual([{ name: 'file', type: 'path', arity: '*' }]);
  });

  it('reads `-kPOS1` and `-kKEY` without brackets as a flag and its value, not a cluster', () => {
    const help = parseHelp('usage: frob [-ab] [-kPOS1] [-fKEY] [-xyz] [file ...]\n');
    expect(help.flags.map((f) => f.names[0])).toEqual(['-a', '-b', '-k', '-f', '-x', '-y', '-z']);
    expect(flag(help.flags, '-k').values).toEqual([{ name: 'POS1', type: 'int' }]);
    expect(flag(help.flags, '-f').values).toEqual([{ name: 'KEY', type: 'string' }]);
  });

  it("keeps a positional offered as an alternative to a flag, without its shell quotes (awk's `[-f progfile | 'prog']`)", () => {
    const help = parseHelp("usage: awk [-F fs] [-v var=value] [-f progfile | 'prog'] [file ...]\n");
    expect(help.flags.map((f) => [f.names[0], f.values.map((v) => v.name)])).toEqual([
      ['-F', ['fs']],
      ['-v', ['var=value']],
      ['-f', ['progfile']],
    ]);
    expect(help.forms[0]!.args).toEqual([
      { name: 'prog', type: 'string', arity: '?' },
      { name: 'file', type: 'path', arity: '*' },
    ]);
  });

  it('keeps a `+FORMAT` operand that has no `-` partner', () => {
    const help = parseHelp('usage: frob [-u] [+FORMAT]\n');
    expect(help.forms[0]!.args).toEqual([{ name: '+FORMAT', type: 'string', arity: '?' }]);
  });

  it('drops control characters and names an empty placeholder, so the spec stays valid', () => {
    const help = parseHelp('Usage: frob <...> [<>]\n  -a, --all   frob\0 all\x07\n');
    expect(help.forms[0]!.args).toEqual([
      { name: 'ARG', type: 'string', arity: '1' },
      { name: 'ARG', type: 'string', arity: '?' },
    ]);
    expect(flag(help.flags, '-a').description).toBe('frob all');
    expect(() => cliSpecFromHelp('frob', help)).not.toThrow();
  });

  it('copes with text that has no usage line or no options', () => {
    expect(parseHelp('')).toEqual({ flags: [], forms: [], subcommands: [] });
    expect(parseHelp('Just a sentence about frob.\n')).toEqual({ flags: [], forms: [], subcommands: [] });
  });
});

describe('valueType', () => {
  it.each([
    ['FILE', 'path'],
    ['NUL_FILE', 'path'],
    ['FILE1', 'path'],
    ['FILE2', 'path'],
    ['dir2', 'path'],
    ['DIR', 'path'],
    ['N', 'int'],
    ['NUM_THREADS', 'int'],
    ['MAX-ARGS', 'int'],
    ['SIZE', 'size'],
    ['KEYDEF', 'int'],
    ['POS1', 'int'],
    ['N[,M]', 'int'],
    ['memsize', 'size'],
    ['KEY', 'string'],
  ] as const)('%s is %s', (name, type) => expect(valueType(name)).toBe(type));
});

describe('isSelfDescription', () => {
  it('marks help, version and usage flags, not look-alikes', () => {
    expect(isSelfDescription({ names: ['--help'] })).toBe(true);
    expect(isSelfDescription({ names: ['-V', '--version'] })).toBe(true);
    expect(isSelfDescription({ names: ['--usage'] })).toBe(true);
    expect(isSelfDescription({ names: ['-?'] })).toBe(true);
    expect(isSelfDescription({ names: ['-h'], description: 'Display this help' })).toBe(true);
    expect(isSelfDescription({ names: ['-h'], description: 'compare human readable numbers' })).toBe(false);
    expect(isSelfDescription({ names: ['-V', '--version-sort'], description: 'show version numbers in order' })).toBe(false);
  });
});

describe('cliSpecFromHelp', () => {
  it('gives every flag and subcommand a feature and marks self-description features', () => {
    const root = parseHelp(`usage: frob [--quiet] <command>

Commands:
  make   Make one
  help   Print help

Options:
  -q, --quiet    say less
  -x             extra
      --help     display this help and exit
`);
    const make = parseHelp('Usage: frob make [-f] NAME\n\n  -f, --force   overwrite\n');
    const spec = cliSpecFromHelp('frob', root, { make });
    expect(spec.flags.map((f) => [f.feature, f.self_description ?? false])).toEqual([
      ['opt.quiet', false],
      ['opt.x', false],
      ['opt.help', true],
    ]);
    expect(spec.subcommands.map((s) => [s.feature, s.self_description ?? false, s.flags.map((f) => f.feature)])).toEqual([
      ['cmd.make', false, ['cmd.make.opt.force']],
      ['cmd.help', true, []],
    ]);
    expect(spec.subcommands[0]!.forms[0]!.args).toEqual([{ name: 'NAME', type: 'string', arity: '1' }]);
    expect(spec.flags[0]).toEqual({ names: ['-q', '--quiet'], feature: 'opt.quiet', description: 'say less', arity: 0, values: [] });
  });

  it('keeps features unique when two flags share a primary name', () => {
    const spec = cliSpecFromHelp('frob', { flags: [{ names: ['-x'], values: [] }, { names: ['--x'], values: [] }], forms: [], subcommands: [] });
    expect(spec.flags.map((f) => f.feature)).toEqual(['opt.x', 'opt.x-2']);
  });
});
