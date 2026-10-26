# The CLI spec and recorded cases

A project's cases come from two files you can write by hand: the **CLI spec**
(`port-anything/cli-spec.yaml`), the grammar the generator builds cases from, and the **recorded
cases** (`port-anything/recorded/*.jsonl`), invocations written out one by one. `compare --save` and
`port-anything spec infer` write a first CLI spec from the reference's help text. When a program
has none they can read (it answers `--help`, `-h` and a call with no arguments without a usage
line), or when what they read is wrong, write or fix the spec yourself.

## A program without help text: awk

onetrue-awk, the awk on macOS and the BSDs, answers `--help` with `unknown option --help
ignored`, and with no arguments it prints `usage: awk [-F fs] [-v var=value] [-f progfile | 'prog']
[file ...]`, which `spec infer` reads. Written by hand, the same spec is:

```yaml
version: 1
program: awk
flags:
  - names: [-F]
    feature: opt.F
    description: field separator
    arity: 1
    values:
      - { name: fs, type: string }
  - names: [-v]
    feature: opt.v
    description: assign a variable before the program runs
    arity: 1
    values:
      - { name: assignment, type: string }
  - names: [-f]
    feature: opt.f
    description: read the program from a file
    arity: 1
    values:
      - { name: progfile, type: path }
forms:
  - usage: awk [-F fs] [-v var=value] 'prog' [file ...]
    args:
      - { name: prog, type: string, arity: "1" }
      - { name: file, type: path, arity: "*" }
```

A spec alone can't write a valid awk program, though: the generator fills `prog` with words and
values, and almost every such case is a syntax error. For a program whose input is code (awk, sed,
bc, a SQL shell), the cases that matter are the ones you record, and `generate` makes more from
them by mutating them (see [Recorded cases](#recorded-cases)).

## The spec, key by key

| Key | What it holds |
|---|---|
| `version` | Always `1` |
| `program` | The program's name, as its usage line gives it |
| `flags` | The program's options (below) |
| `forms` | One entry per way to call the program: per usage line |
| `subcommands` | For `git`-style programs: each with a `name` (one word), a `feature`, and its own `flags`, `forms` and `subcommands` |

A **flag**:

| Key | What it holds |
|---|---|
| `names` | Every spelling: `[-n, --numeric-sort]`. Each is `-x`, `--long` or `-long`, with no `=` |
| `feature` | The feature tag of the cases that use the flag: the unit parity is scored per. Unique in the spec |
| `description` | Optional, for people |
| `arity` | How many values the flag takes; equal to the number of `values` |
| `values` | Each value's `name` (the placeholder), `type`, and for `type: enum` its `choices`. `optional: true` on a flag's single value means it may be left out (`--color[=WHEN]`) |
| `self_description` | `true` for `--help`, `--version` and the like: scored apart from the headline |

A **form**: `usage` (the usage line, for people), `flags` (the flags every call of this form must have: usually none, since a flag in brackets is optional) and `args`,
the positional arguments in order, each with a `name`, a `type` and an `arity`: `"1"` (exactly
one), `"?"` (optional), `"*"` (any number) or `"+"` (at least one). Quote the arity: YAML reads
a bare `1` as a number.

**Types** decide which values the generator tries: `string` (words, an empty string, `-`, Unicode
and a 4096-character string), `int` (0, -1, values past 32 and 64 bits, and `abc` or `1.5` for the
error paths), `size` (the same, and suffixes such as `1K` and `1M`), `path` (a file the case
creates in its directory, a name with spaces or Unicode, an empty file, a directory, a missing
file) and `enum` (each of the `choices`, and one that isn't).

## Recorded cases

Each line of a `port-anything/recorded/*.jsonl` file is one case: a JSON object with the `argv`
after the program name, and where the case needs them, `stdin`, `fixtures` (files the case creates
in its working directory, by relative path), `env`, and `features` (its tags, for the per-feature
score; an untagged case counts in `base`). Write `origin` as `"recorded"`. Content is UTF-8 text,
or `{"base64": "…"}` for bytes that aren't. With a CLI spec, `run` and `baseline` warn about a tag
the spec doesn't define (other than `base`), naming the file and line where it first appears: a
typo would otherwise be scored as a feature of its own. Tags of your own are fine; the warning
lists them so a typo among them stands out.

```jsonl
{"argv": ["{print $2}"], "stdin": "a b c\nd e f\n", "features": ["fields"], "origin": "recorded"}
{"argv": ["-F", ",", "{print $1}", "data.csv"], "fixtures": {"data.csv": "1,alice\n2,bob\n"}, "features": ["opt.F"], "origin": "recorded"}
{"argv": ["BEGIN {printf \"%c\", 65}"], "env": {"LC_ALL": "C"}, "features": ["printf"], "origin": "recorded"}
{"argv": ["{print length($0)}"], "stdin": {"base64": "/w=="}, "origin": "recorded"}
```

Leave out the case IDs: port-anything computes them. `port-anything run` runs the recorded cases
against the reference and every candidate, without a CLI spec. With one, `port-anything generate`
adds generated cases: the ones the spec gives, and mutants of the recorded cases, one token at a
time in an argument that holds a program or a query (`{print $2}` becomes `{print $NF}`) and byte
by byte in stdin and files. Each mutant keeps the tags of the case it came from. The fresh holdout
of every full `run` is generated the same way, so it needs the spec too.

To start such a project:

```sh
port-anything init . --ref /usr/bin/awk --candidate goawk
mkdir -p port-anything/recorded    # then write your cases into port-anything/recorded/awk.jsonl
port-anything spec infer           # or write port-anything/cli-spec.yaml as above
port-anything generate --budget 1000
port-anything run
```
