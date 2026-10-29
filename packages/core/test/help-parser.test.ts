import { spawnSync } from 'node:child_process';
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
  it('reads a LIST of positions and a signed [-]NUM as numbers, and no flag from a range list in the prose', () => {
    const help = parseHelp(`Usage: slice OPTION... [FILE]...
Show chosen pieces of each input line.

  -p, --pieces=LIST       show just the pieces in LIST
  -w, --words=LIST        show just the words in LIST
  -m, --max=[-]NUM        stop after NUM lines
      --help        print this text

LIST is one range or several, joined by commas.  A range is written as:

  A     piece A alone
  A-    piece A up to the line end
  A-B   pieces A to B
  -B    pieces 1 to B
`);
    expect(flag(help.flags, '-p').values).toEqual([{ name: 'LIST', type: 'int' }]);
    expect(flag(help.flags, '-m').values).toEqual([{ name: '[-]NUM', type: 'int' }]);
    expect(help.flags.map((f) => f.names[0])).toEqual(['-p', '-w', '-m', '--help']);
  });

  it('keeps an option right under a two-column line that is not a range', () => {
    const help = parseHelp(`Usage: check EXPR

  EXPR is true or false:

  WORD                 true when WORD isn't empty
  -e WORD              true when WORD is empty
  NAME                 the context to use
  -c, --compute        work out the context first
`);
    expect(help.flags.map((f) => f.names[0])).toEqual(['-e', '-c']);
  });

  it('types an uppercase LIST as numbers, a lowercase list (Go CLIs) as text', () => {
    expect(valueType('LIST')).toBe('int');
    expect(valueType('list')).toBe('string');
  });

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

  it('reads the GNU two-column layout: a long spelling in the description column, one usage line per form (gawk)', () => {
    const help = parseHelp(`Usage: gawk [POSIX or GNU style options] -f progfile [--] file ...
Usage: gawk [POSIX or GNU style options] [--] 'program' file ...
POSIX options:\t\tGNU long options: (standard)
\t-f progfile\t\t--file=progfile
\t-F fs\t\t\t--field-separator=fs
\t-v var=val\t\t--assign=var=val
Short options:\t\tGNU long options: (extensions)
\t-C\t\t\t--copyright
\t-d[file]\t\t--dump-variables[=file]
\t-e 'program-text'\t--source='program-text'
\t-h\t\t\t--help
\t-L[fatal|invalid|no-ext]\t--lint[=fatal|invalid|no-ext]
\t-V\t\t\t--version
`, { program: 'gawk' });
    const read = (name: string) => {
      const f = flag(help.flags, name);
      return [f.names, f.values.map((v) => `${v.name}:${v.type}${v.optional === true ? '?' : ''}`)];
    };
    expect(read('-f')).toEqual([['-f', '--file'], ['progfile:path']]);
    expect(read('-v')).toEqual([['-v', '--assign'], ['var=val:string']]);
    expect(read('-e')).toEqual([['-e', '--source'], ['program-text:string']]);
    expect(read('-d')).toEqual([['-d', '--dump-variables'], ['file:path?']]);
    expect(read('-L')).toEqual([['-L', '--lint'], ['fatal|invalid|no-ext:enum?']]);
    expect(read('-h')).toEqual([['-h', '--help'], []]);
    expect(help.flags.every((f) => f.description === undefined)).toBe(true);
    // Both usage lines; `[POSIX or GNU style options]` names options, and `-f` takes `progfile`.
    expect(help.forms.map((f) => [f.flags, f.args.map((a) => `${a.name}${a.arity}`)])).toEqual([
      [['-f'], ['file+']],
      [[], ['program1', 'file+']],
    ]);
  });

  it('takes a usage-line flag\'s value from its option line, skips an options group, and keeps prose out of the forms', () => {
    const cp = parseHelp(
      'Usage: cp [OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...\n\n  -t, --target-directory=DIRECTORY  copy all SOURCE arguments into DIRECTORY\n  -T, --no-target-directory    treat DEST as a normal file\n',
      { program: 'cp' },
    );
    expect(cp.forms.map((f) => [f.flags, f.args.map((a) => `${a.name}${a.arity}`)])).toEqual([
      [[], ['SOURCE1', 'DEST1']],
      [['-t'], ['SOURCE+']],
    ]);
    expect(parseHelp('Usage: bash [GNU long option] [option] script-file ...\n', { program: 'bash' }).forms[0]!.args.map((a) => a.name)).toEqual(['script-file']);
    expect(parseHelp('Usage: bar [options] file\nUsage: see the man page for details\n', { program: 'bar' }).forms).toHaveLength(1);
  });

  it('reads a bare a|b as choices, but not a pair of placeholders', () => {
    const help = parseHelp('Usage: frob [OPTION]...\n\n  -i FILE|DIR      input path\n  -p HOST|IP       peer\n  -f, --format=pem|der  format\n');
    expect(flag(help.flags, '-i').values).toEqual([{ name: 'FILE|DIR', type: 'path' }]);
    expect(flag(help.flags, '-p').values[0]!.type).toBe('string');
    expect(flag(help.flags, '-f').values).toEqual([{ name: 'pem|der', type: 'enum', choices: ['pem', 'der'] }]);
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

  it('takes one positional from a group of alternative words, and none from a flag with an optional value', () => {
    expect(parseHelp('usage: frob [a | b]\n').forms[0]!.args).toEqual([{ name: 'a', type: 'string', arity: '?' }]);
    expect(parseHelp('usage: frob [FILE | -]\n').forms[0]!.args).toEqual([{ name: 'FILE', type: 'path', arity: '?' }]);
    expect(parseHelp('usage: kill [-l [SIGNAL] | -s SIGNAL] PID...\n').forms[0]!.args).toEqual([{ name: 'PID', type: 'int', arity: '+' }]);
    expect(parseHelp('usage: svc {start|stop}\n').forms[0]!.args).toEqual([]);
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

  // xxd's layout: forms on their own lines under `Usage:`, separated by an `or` line; signs written
  // as optional groups in front of a value (`[-]offset`, `[+][-]seek`); a two-letter `-ps`.
  const XXD_STYLE = `Usage:
       frob [options] [infile [outfile]]
    or
       frob -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]
Options:
    -a          toggle autoskip.
    -c cols     format <cols> octets per line.
    -h          print this summary.
    -l len      stop after <len> octets.
    -ps         output in plain hexdump style.
    -r          reverse operation.
    -r -s off   revert with <off> added to file positions.
    -s [+][-]seek  start at <seek> bytes abs. (or +: rel.) infile offset.
    -v          show version.
`;

  it('reads an `or` line between usage lines as a separator, not a positional (xxd style)', () => {
    const help = parseHelp(XXD_STYLE);
    const optional = (name: string) => ({ name, type: 'path', arity: '?' });
    expect(help.forms.map((f) => [f.usage, f.flags, f.args])).toEqual([
      ['frob [options] [infile [outfile]]', [], [optional('infile'), optional('outfile')]],
      ['frob -r [-s [-]offset] [-c cols] [-ps] [infile [outfile]]', ['-r'], [optional('infile'), optional('outfile')]],
    ]);
    // `or` with the next form on the same line.
    expect(parseHelp('Usage: frob [-a] FILE\n   or  frob -l\n').forms.map((f) => f.usage)).toEqual(['frob [-a] FILE', 'frob -l']);
  });

  it('reads `[-]offset` and `[+][-]seek` as a flag value with an optional sign, not a positional', () => {
    const help = parseHelp(XXD_STYLE);
    expect(flag(help.flags, '-s').values).toEqual([{ name: 'seek', type: 'int' }]);
    expect(parseHelp('usage: frob [-s [-]offset] [file]\n').flags).toEqual([{ names: ['-s'], values: [{ name: 'offset', type: 'int' }] }]);
    expect(parseHelp('usage: frob [-s [-]offset] [file]\n').forms[0]!.args).toEqual([{ name: 'file', type: 'path', arity: '?' }]);
    // A `[-]` on its own is still an optional `-` operand, which names nothing.
    expect(parseHelp('usage: frob [-] [file]\n').forms[0]!.args).toEqual([{ name: 'file', type: 'path', arity: '?' }]);
  });

  it('reads a listed `-ps` as one flag, with `-p` as a guessed spelling, not as the cluster -p -s', () => {
    const help = parseHelp(XXD_STYLE);
    expect(flag(help.flags, '-ps')).toMatchObject({ names: ['-ps'], aliasCandidates: ['-p'] });
    expect(help.flags.some((f) => f.names.includes('-p'))).toBe(false);
    expect(flag(help.flags, '-s').names).toEqual(['-s']);
    // No guess when the letter is listed on its own, has a short spelling, or starts several names.
    const find = parseHelp('Usage: frob [-H] [path...]\n  -name PATTERN   match the name\n  -newer FILE     newer than FILE\n  -quit           stop\n  -q              quiet\n  -x, -xdev       stay on one file system\n  -depth          depth first\n');
    expect(find.flags.filter((f) => f.aliasCandidates !== undefined).map((f) => [f.names[0], f.aliasCandidates])).toEqual([['-depth', ['-d']]]);
  });

  it('puts guessed spellings in the spec after the listed ones, and marks "print this summary" as self-description', () => {
    const spec = cliSpecFromHelp('frob', parseHelp(XXD_STYLE), {}, '--help');
    expect(spec.flags.find((f) => f.names.includes('-ps'))).toMatchObject({ names: ['-ps', '-p'], feature: 'opt.ps', arity: 0 });
    expect(spec.flags.filter((f) => f.self_description === true).map((f) => f.names[0])).toEqual(['-h', '-v']);
    expect(spec.forms.flatMap((f) => f.args.map((a) => a.name))).toEqual(['infile', 'outfile', 'infile', 'outfile']);
  });

  it("gives no guessed spellings to a subcommand's flags, which no probe checks", () => {
    const root = parseHelp('usage: frob <command>\n\nCommands:\n  build   Build it\n');
    const build = parseHelp('usage: frob build [-json] [-v]\n\n  -json   print JSON\n  -race   detect races\n  -v      verbose\n');
    expect(flag(build.flags, '-json').aliasCandidates).toEqual(['-j']);
    const spec = cliSpecFromHelp('frob', root, { build });
    expect(spec.subcommands[0]!.flags.map((f) => f.names)).toEqual([['-json'], ['-race'], ['-v']]);
  });

  it('copes with text that has no usage line or no options', () => {
    expect(parseHelp('')).toEqual({ flags: [], forms: [], subcommands: [] });
    expect(parseHelp('Just a sentence about frob.\n')).toEqual({ flags: [], forms: [], subcommands: [] });
  });
});

// vim's xxd prints its help on `-h`; captured here at test time, never committed.
const xxdHelp = (() => {
  const r = spawnSync('xxd', ['-h'], { encoding: 'utf8' });
  return r.error === undefined && /usage:/i.test(`${r.stdout}${r.stderr}`) ? `${r.stdout}${r.stderr}` : undefined;
})();

describe.runIf(xxdHelp !== undefined)('parseHelp on the installed xxd', () => {
  it('reads both forms without an `or` or `offset` positional, -s with its value, -ps with -p as a guess', () => {
    const help = parseHelp(xxdHelp!, { program: 'xxd' });
    expect(help.forms.length).toBeGreaterThanOrEqual(2);
    for (const form of help.forms) expect(form.args.map((a) => a.name)).toEqual(['infile', 'outfile']);
    expect(flag(help.flags, '-s').values).toHaveLength(1);
    expect(flag(help.flags, '-ps').aliasCandidates).toEqual(['-p']);
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
    ['offset', 'int'],
    ['seek', 'int'],
    ['len', 'int'],
    ['[-]NUM', 'int'],
    ['[+-]N', 'int'],
    ['FIELD', 'int'],
    ['FIELDS', 'int'],
    ['FILENUM', 'int'],
    ['FIRST', 'int'],
    ['INCREMENT', 'int'],
    ['LAST', 'int'],
    ['INPUT', 'path'],
    ['OUTPUT', 'path'],
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
    expect(isSelfDescription({ names: ['-h'], description: 'print this summary.' })).toBe(true);
    expect(isSelfDescription({ names: ['-s'], description: 'print a summary of the changes' })).toBe(false);
    expect(isSelfDescription({ names: ['-V', '--version-sort'], description: 'show version numbers in order' })).toBe(false);
  });

  it('marks copyright and license notices that take no value, and the option the help was read with', () => {
    expect(isSelfDescription({ names: ['-C', '--copyright'] })).toBe(true);
    expect(isSelfDescription({ names: ['--license'], values: [] })).toBe(true);
    expect(isSelfDescription({ names: ['--license'], values: [{ name: 'SPDX', type: 'string' }] })).toBe(false);
    expect(isSelfDescription({ names: ['-L'], description: 'print the license and exit' })).toBe(true);
    // A short-only `-h` without a description is the help only when that is how the help was read.
    expect(isSelfDescription({ names: ['-h'] })).toBe(false);
    expect(isSelfDescription({ names: ['-h'] }, '-h')).toBe(true);
    expect(isSelfDescription({ names: ['-h'] }, '--help')).toBe(false);
    // A scanner's own feature, and a read-with option that takes a value, are not.
    expect(isSelfDescription({ names: ['-c', '--copyright'], description: 'also display copyright text found within the file' })).toBe(false);
    expect(isSelfDescription({ names: ['-l', '--license'], description: 'Scan for licenses' })).toBe(false);
    expect(isSelfDescription({ names: ['--copyright'], description: 'print copyright information and exit' })).toBe(true);
    expect(isSelfDescription({ names: ['-c'], description: 'print copyright lines found in each file' })).toBe(false);
    expect(isSelfDescription({ names: ['-h'], values: [{ name: 'HOST', type: 'string' }] }, '-h')).toBe(false);
  });

  it('marks the flag the help was read with in the spec, and gawk\'s notices', () => {
    const bsd = parseHelp('usage: frob [-h] [-q] file\n');
    const self = (spec: ReturnType<typeof cliSpecFromHelp>) => spec.flags.filter((f) => f.self_description === true).map((f) => f.names[0]);
    expect(self(cliSpecFromHelp('frob', bsd, {}, '-h'))).toEqual(['-h']);
    expect(self(cliSpecFromHelp('frob', bsd))).toEqual([]);
    const gawk = parseHelp('Usage: gawk [POSIX or GNU style options] -f progfile [--] file ...\nShort options:\t\tGNU long options: (extensions)\n\t-C\t\t\t--copyright\n\t-h\t\t\t--help\n\t-L[fatal|invalid]\t--lint[=fatal|invalid]\n\t-V\t\t\t--version\n');
    expect(self(cliSpecFromHelp('gawk', gawk, {}, '--help'))).toEqual(['-C', '-h', '-V']);
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
