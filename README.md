v0.1 covers non-interactive CLIs.

# Port Anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything records what a program actually does, generates thousands more test cases, runs the original and the port side by side, and reports a parity score with a minimal reproducer for every difference. It is packaged so a coding agent (Claude Code, Codex, Cursor, Gemini CLI) can drive the whole port.

<!-- GIF of `port-anything compare` goes here: docs/compare.gif -->

**Status:** early. Commands, file formats and exit codes may still change before v1.0.

## Quickstart (60 seconds)

Needs Node 22.15+. Nothing to configure: `compare` reads the reference's `--help`, generates cases, runs both programs in a sandbox and prints a parity score per candidate.

**Linux** (Debian 12, with the `rust-coreutils` package: GNU `sort` against the uutils multicall binary):

```sh
npx port-anything compare /usr/bin/sort 'coreutils sort'
```

**macOS** (BSD `sort` against GNU `sort` from Homebrew coreutils):

```sh
brew install coreutils
npx port-anything compare /usr/bin/sort gsort
```

The first argument is the reference: what it does is correct by definition. Every other argument is a candidate, and with several of them you get a feature × candidate matrix:

```sh
npx port-anything compare /usr/bin/sort 'coreutils sort' 'busybox sort'
```

Name the binaries explicitly: on Ubuntu 25.10 and later, plain `sort` already *is* uutils. Both sides run under the same program name (argv[0]), so error messages that start with the program's name don't count as differences.

- **Sandbox.** `compare` fuzzes a program it knows nothing about, so every case runs without network access and can write only inside its own temporary directory: bubblewrap on Linux (`sudo apt install bubblewrap`), `sandbox-exec` on macOS. If no sandbox works, `compare` refuses to run and says how to fix it; `--no-sandbox` runs without one, for programs you trust. Known destructive tools (`rm`, `dd`, `mkfs`…) need `--i-know`.
- **Output.** A parity line per candidate and per-feature numbers, plus `port-anything-report.html`. `--json` prints the same result machine-readably, for scripts and agents. Nothing else is written unless you pass `--save`, which turns the run into a project (below).
- **Exit codes:** 0 = no divergences, 1 = divergences, 3 = usage or config error.

The score is the **mean of per-feature parity** (a feature is a flag, subcommand or input form), so a rarely used flag counts as much as the common path. `--help`, `--version` and similar output differ between implementations by design: they are reported on their own, outside the headline. Parity is evidence from the cases that ran, never a proof of equivalence.

## A project, for a real port

`compare` is zero-config. A port you work on for weeks gets a project instead: `port-anything.yaml` (how to build and run each side, the normalizers, the strictness profile) and a `port-anything/` directory with the cases, all committed. [`examples/wc-lite`](examples/wc-lite) is a complete one: a small `wc` in C, a Rust port, and bad ports with one bug each.

```sh
port-anything run          # run the corpus against every candidate: parity, clusters of divergences
port-anything report       # the latest run as port-anything-report.html, .json and a parity badge
port-anything waive --from-cluster 1   # print a waiver for an accepted difference, to paste into port-anything/waivers.yaml
```

Divergences are grouped into clusters (same fields, same diff shape), each with a reproducer you can paste into a shell, because an agent fixes a cluster, not a case. The badge shows the same headline as the report.

## Prior art

Snapshot tools compare a program to its own past. Port Anything compares two (or more) programs, and generates the inputs.

| Tool | What it does | How Port Anything differs |
|---|---|---|
| [`uufuzz`](https://github.com/uutils/coreutils/tree/main/fuzz) and the uutils fuzz targets | Differential fuzzers that run uutils against GNU, per utility (`cksum`, `cut`, `date`, `sort`, `tr`, `wc`…) | Generic rather than per project; a per-flag parity matrix; clustered, minimized repros; a report. Our coreutils showcase leaves out the utilities they already fuzz. |
| [flagdiff](https://github.com/uutils/coreutils/issues/15254) | An AI-driven differential fuzzer over all of coreutils, reported to uutils as one issue per finding | Few findings, de-duplicated, clustered and minimized before anyone sees them; N-way, so busybox and toybox get a column too; inputs whose *content* matters, not only flag combinations. |
| [uutils GNU test suite tracking](https://github.com/uutils/coreutils-tracking) | Runs the GNU test suite against uutils and charts the pass rate over time | Cases generated beyond the GNU suite, a per-flag matrix, minimized repros, and the same thing for any pair of programs. |
| [Babelmark](https://babelmark.github.io/) | Renders one Markdown input in dozens of implementations side by side | The model for the N-way matrix, but one hand-typed input at a time; no generation, scoring or minimization. |
| Mutation testing (`cargo-mutants`, Stryker, `mull`) | Measures how good a test suite is by checking it catches injected bugs | Not a competitor: Port Anything uses mutated ports to test its own detection, and will use it to report how strong a corpus is. |
| `trycmd` / `snapbox`, `insta` / `insta-cmd` | Snapshot tests for CLIs, in Rust | Snapshots of one program's past output: no second program, no generation, no clustering. |
| `bats`, `cram`, `shelltestrunner` | Hand-written CLI test suites | Hand-written expectations; Port Anything takes its expectations from the reference. These suites make good seed cases. |
| `diffoscope` | Deep diffs of files and archives | A diff viewer for two artifacts, not a test harness. |
| [keploy](https://github.com/keploy/keploy) | Records and replays HTTP traffic for API tests | HTTP services only. Port Anything starts with CLIs and would integrate keploy for services rather than rebuild it. |
| Google's C → Rust work (giflib-rs) | AI translation plus differential fuzzing, per library | The same method, done in-house for one project at a time. Port Anything packages it for any pair of programs. |

## Integrity: what it can and can't promise

An agent told to make a number go up will be tempted to game it: hardcode outputs, loosen normalizers, delete cases, waive everything. Here is the honest threat model.

- **The agent runs locally as you, with a shell.** It can read every file you can, run commands in a pseudo-terminal, and edit any file in the repo.
- **So local checks can make cheating slower and visible, not impossible.** The enforcement point is git and CI: everything that defines the score is a committed file, so every change to it is a diff someone can review, and CI can recompute the score from scratch on every push.

What v0.1 does:

- Normalizers, the strictness profile, the cases and the waivers live in committed files. Put them under `CODEOWNERS` to require a human review of every change.
- The report lists every normalizer with the number of cases it changed, and every waiver with its reason and the cases it covers, flagging large ones. A waiver is a predicate (feature, field, diff shape), never a list of case IDs.
- Features without enough cases are listed as untested or under-sampled instead of quietly counting as passed.
- A candidate that answers differently when a diverging case is re-run is counted as diverging, not excluded as flaky, so randomness doesn't hide hard cases.

Not in v0.1 yet, and the report says so: a committed manifest of case hashes with a `verify` command, an environment fingerprint, a **fresh holdout** (new cases from a seed that is never stored, compared live against the reference, which defeats a lookup table of expected outputs), and keeping the candidate from calling or linking the reference: in local mode the candidate still sees your `PATH`, so a "port" that just runs the original isn't caught yet.

## Showcases

The coreutils compatibility matrix (GNU coreutils against uutils, busybox and toybox) and the jq matrix (jq against jaq and gojq), with every finding marked new, already tracked or fixed upstream: [github.com/port-anything/showcases](https://github.com/port-anything/showcases).

## Development

Requires Node 22.15+ and pnpm (`corepack enable` picks the version pinned in `package.json`).

```sh
pnpm install
pnpm -r build      # build before testing: the CLI tests run the built bin
pnpm -r typecheck
pnpm -r test
pnpm lint:workflows   # actionlint via Docker
```

The Linux-only parts (the bubblewrap sandbox, strace, comparing GNU coreutils with uutils, busybox and toybox, or jq with jaq and gojq) are developed in a Linux container, also from macOS. It needs Docker and builds `Dockerfile.dev` (Ubuntu 25.10) on first use:

```sh
scripts/dev-linux.sh pnpm -r test   # any command, run in the container with the repo at /repo
scripts/dev-linux.sh                # a shell
pnpm test:linux                     # container smoke test, then build and test
```

The container installs its own `node_modules` (in Docker volumes, so macOS builds of native packages stay on the host), runs commands with your uid, sets `PA_SANDBOX_TESTS=1` so the sandbox tests run (they are skipped elsewhere), and disables Docker's seccomp and AppArmor confinement and its `/proc` masking so bubblewrap can create its sandbox inside. In the container, `sort` is uutils and `gnusort` is GNU.

| Package | What it is |
|---|---|
| [`packages/cli`](packages/cli) | `port-anything`, the CLI |
| [`packages/core`](packages/core) | `@port-anything/core`, the engine |
| [`packages/mcp`](packages/mcp) | `@port-anything/mcp`, the MCP server |
| [`packages/report`](packages/report) | `@port-anything/report`, the HTML report and badge |

Releases are versioned with [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset`.

## License

[Apache-2.0](LICENSE)
