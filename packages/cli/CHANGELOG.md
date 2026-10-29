# port-anything

## 0.1.3

### Patch Changes

- eab5f2a: The help parser types more placeholders, so `compare` generates valid values for them instead of text that every call rejects: `[-]NUM` (head, tail), `LIST` (cut), `FIELD` and `FILENUM` (join) and `FIRST INCREMENT LAST` (seq) are numbers, and `INPUT [OUTPUT]` (uniq) are files. Before, most of those programs' flags got few or no cases (`cut` and `seq` got two). A line of a list in the help prose, such as cut's `-M  from first to M'th …` under `N-M`, is no longer read as a flag.

## 0.1.2

### Patch Changes

- 9d92f4e: `run` keeps both sides of every divergence (the outputs after normalizers, as blob refs in the run), and shows what differs: `run --cluster <n>` prints a line diff of the cluster's first case (exit code, stdout, stderr, changed files), and the HTML report shows one under each cluster's repro (`diff` in `port-anything-report.json`). A full run says where to look. Before, only the MCP tools showed the diff, and a person had to re-run a repro to see what was wrong.
- a5b1398: The MCP `features` tool's header counts what it lists (the spec's features, `base`, and tags the spec doesn't define), and shows `base` as the no-flag feature rather than "not in spec".
- fbeea0f: The flaky-reference cases a run leaves out are visible in its numbers: they count in each candidate's `raw.flaky_reference` and per feature (never scored), `report.json` lists them in a new top-level `flaky_reference`, the HTML report's integrity panel lists them, and the MCP `status` tool shows them next to the cases compared.
- d39874e: `generate` mutates the recorded cases (generator v2, the new default): one token at a time in an argument that holds a program or a query, and byte by byte in stdin and input files. A program whose input is code, such as awk, now gets a generated corpus, a fresh holdout and a gap test from its recorded cases; before, every case the CLI spec gave was a syntax error and the corpus stayed empty. Without recorded cases, v2 generates the same cases as v1. A project saved by an earlier version is pinned to `corpus.generator: v1` and keeps its corpus; to switch, set `corpus.generator: v2` and run `generate` and `baseline` again (the corpus changes, so the manifest does too). In v2, editing a recorded case also changes the generated cases derived from it.
- f0eff0b: `port-anything --help` and the package description now say what the tool checks: that a rewrite still behaves like the original.
- 37124db: The help parser reads the GNU two-column layout gawk uses (`-f progfile		--file=progfile`): the long spelling becomes an alias instead of a description, so features get their long names and `--help` and `--version` are reported apart. It also keeps every `Usage:` line, skips a `[POSIX or GNU style options]` group, reads `var=val` and `'program-text'` placeholders, lets a flag in a usage line take the value its option line gives it (`-f progfile` is no positional), and reads `a|b|c` as choices.
- c5fdb6d: A run of a candidate whose git tree has uncommitted changes is no longer passed off as its commit: the history line records `dirty: true` next to the commit (`false` on a clean tree; new files git doesn't ignore count, while git-ignored build outputs and the project's own port-anything files don't), `run` says the run is recorded as dirty, and the port-report skill names those changes in its summary. Older history lines, without the field, still read.
- 2407360: The MCP `next` tool re-runs each open cluster's repro before offering it, and skips a cluster whose repro no longer diverges (a fix for another cluster covered it, as a smoke run's `fixed` count may show) with a one-line note naming the skipped clusters. Before, it offered such a cluster with an empty diff and asked for a re-run. The `port-plan` and `port-report` skills now bring up `port-anything strength` and the mutation tool it needs (`cargo-mutants`, Stryker, `mull`), so corpus strength is planned for instead of found missing at the end.
- 6915619: `run` scores with the CLI spec: a feature marked `self_description: true` (a `-v` that prints a version banner) is reported apart and left out of the headline, in the run, `report.json` and the fresh holdout, whatever its name. A run of the whole corpus also lists the spec's features that no case exercised as untested.
- a8c8841: More flags count as self-description, scored apart from the headline like `--help` and `--version`: `--copyright`, `--license` and `--warranty` when they take no value, a flag whose description says it prints the copyright, license or warranty, and the option the help text was read with (a short-only `-h`).
- c764253: `compare` and `spec infer` read a program that has no help option: when `--help` and `-h` give nothing usable, they read the usage line the program prints when called with no arguments (onetrue-awk, BSD tools). A positional offered as an alternative to a flag (`[-f progfile | 'prog']`) is kept. When there is still nothing to read, the error says what to do instead, and the new docs page `docs/cli-spec.md` describes the CLI spec and the recorded cases' format.
- f193d40: `run` and `baseline` warn about a feature tag in `port-anything/recorded/*.jsonl` that the CLI spec doesn't define, naming the file and line where it first appears, so a typo or a recorder bug isn't silently scored as a feature of its own.

## 0.1.1

### Patch Changes

- The npm README has the first-results line and links to the showcase write-up.

## 0.1.0

### Minor Changes

- First feature release: audit a rewrite against the program it replaces.
  
  - `compare`: zero-config. Infers a CLI spec from `--help`, generates a corpus, baselines the reference and prints per-feature parity and a feature × candidate matrix for any number of candidates, with `--json` for scripts.
  - Generated cases: argv from the spec (forms, boundary values, pairwise flags, invalid calls) and byte mutation of seed inputs, de-duplicated by observation, with a budget and a minimum per feature.
  - Sandboxed runs (bubblewrap on Linux, `sandbox-exec` on macOS) with a pinned `argv[0]` and a fixed environment; candidate re-runs tell flaky from wrong, reference re-runs catch nondeterminism.
  - Divergences clustered by field, diff shape and feature, and delta-debugged to a minimal repro (`minimize`).
  - Score: mean of per-feature parity; under-sampled and self-description features (`--help`, `--version`) reported apart.
  - Projects: `init`, `spec infer`, `generate`, `baseline` (normalizer proposals), `run` (`--smoke`, `--cluster`, `--feature`), predicate waivers (`waive --from-cluster`), parity history.
  - `report`: a self-contained `port-anything-report.html` with a repro per cluster, `port-anything-report.json`, and a parity badge.
  - `port-audit` skill for coding agents; `port-anything --version`.
  
  Also included (preview; formats may still change): `compare --ref git:<rev>` (compare against another commit of the same program, as a refactor guard), the slowdown gate (`compare.max_slowdown`), `baseline`'s frozen manifest and `verify`, a fresh holdout on every full run with a significance-gated gap, `compare.min_parity`, sandbox mode `container`, `init --ci`, the `port-anything mcp` server, the `port-loop`, `port-plan` and `port-report` skills, `setup` for Claude Code, Codex, Cursor and Gemini CLI, the smoke `hook`, and `strength`.

## 0.0.1

### Patch Changes

- d3f4b0d: First release: `port-anything compare '<ref cmd>' '<candidate cmd>'…` compares a program with one or more ports with zero configuration. It infers a CLI spec from `--help`, generates 500 cases, runs the reference twice to find nondeterministic output, runs each candidate in a sandbox with no network, and prints a parity line per candidate and a feature × candidate matrix (`--json` for machines, `--save` to keep the setup as a project). Also included: `spec infer`, `baseline` and `run` for a saved project.
