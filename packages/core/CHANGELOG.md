# @port-anything/core

## 0.1.2

### Patch Changes

- 9d92f4e: `run` keeps both sides of every divergence (the outputs after normalizers, as blob refs in the run), and shows what differs: `run --cluster <n>` prints a line diff of the cluster's first case (exit code, stdout, stderr, changed files), and the HTML report shows one under each cluster's repro (`diff` in `port-anything-report.json`). A full run says where to look. Before, only the MCP tools showed the diff, and a person had to re-run a repro to see what was wrong.
- d39874e: `generate` mutates the recorded cases (generator v2, the new default): one token at a time in an argument that holds a program or a query, and byte by byte in stdin and input files. A program whose input is code, such as awk, now gets a generated corpus, a fresh holdout and a gap test from its recorded cases; before, every case the CLI spec gave was a syntax error and the corpus stayed empty. Without recorded cases, v2 generates the same cases as v1. A project saved by an earlier version is pinned to `corpus.generator: v1` and keeps its corpus; to switch, set `corpus.generator: v2` and run `generate` and `baseline` again (the corpus changes, so the manifest does too). In v2, editing a recorded case also changes the generated cases derived from it.
- 37124db: The help parser reads the GNU two-column layout gawk uses (`-f progfile		--file=progfile`): the long spelling becomes an alias instead of a description, so features get their long names and `--help` and `--version` are reported apart. It also keeps every `Usage:` line, skips a `[POSIX or GNU style options]` group, reads `var=val` and `'program-text'` placeholders, lets a flag in a usage line take the value its option line gives it (`-f progfile` is no positional), and reads `a|b|c` as choices.
- c5fdb6d: A run of a candidate whose git tree has uncommitted changes is no longer passed off as its commit: the history line records `dirty: true` next to the commit (`false` on a clean tree; new files git doesn't ignore count, while git-ignored build outputs and the project's own port-anything files don't), `run` says the run is recorded as dirty, and the port-report skill names those changes in its summary. Older history lines, without the field, still read.
- a8c8841: More flags count as self-description, scored apart from the headline like `--help` and `--version`: `--copyright`, `--license` and `--warranty` when they take no value, a flag whose description says it prints the copyright, license or warranty, and the option the help text was read with (a short-only `-h`).
- c764253: `compare` and `spec infer` read a program that has no help option: when `--help` and `-h` give nothing usable, they read the usage line the program prints when called with no arguments (onetrue-awk, BSD tools). A positional offered as an alternative to a flag (`[-f progfile | 'prog']`) is kept. When there is still nothing to read, the error says what to do instead, and the new docs page `docs/cli-spec.md` describes the CLI spec and the recorded cases' format.

## 0.1.1

No changes in this release.

## 0.1.0

No changes in this release.

## 0.0.1

No changes in this release.
