# wc-lite

A small `wc` in C (`ref/`), a Rust port of it (`port/`), and the Port Anything project that
checks the port against the reference. The test suite uses it to check that `port-anything run`
finds real bugs and reports no false ones.

- `ref/wc-lite.c`: the reference. Counts lines, words, UTF-8 characters, bytes and the maximum
  line length (`-l -w -m -c -L`, default `-lwc`), with a total line for several files. Exit 0 on
  success, 1 when a file can't be read, 2 on a usage error. Errors start with the name it runs as.
- `port/`: the Rust port, which must behave exactly like the reference.
- `port-anything.yaml` and `port-anything/recorded/recorded.jsonl`: the config and the cases.
  The corpus is small, so the config scores features with as few as 3 cases (the default
  minimum is 20); `help` and `version` are reported on their own, outside the parity. stderr is
  compared byte for byte (`compare.fields.stderr.mode: exact`), since the port copies every message;
  the default, loose, would let a wrong program name in an error through.

## Bad ports

Each cargo feature of the port compiles in one deliberate bug:

| Feature | Bug | Shows up in |
|---|---|---|
| `bad-off-by-one` | counts a last line without a newline as a line | stdout |
| `bad-crlf` | leaves the CR of a CRLF line ending out of `-L` | stdout |
| `bad-exit-code` | exits 1 instead of 2 on a usage error | exit code |
| `bad-missing-flag` | has no `-m`: it is an invalid option | stdout, stderr, exit code |
| `bad-rounding` | rounds a tab up to a tab stop, so a tab already at one doesn't move | stdout |
| `bad-ordering` | reads several files last to first | stdout (line order) |
| `bad-racy` | adds a different amount to `-L` on every run (stands in for a race) | stdout, flaky-candidate |
| `bad-program-name` | starts its errors with `wc` instead of the name it runs as | stderr |
| `bad-double-dash` | reads an option after `--` as an option, not a file | stdout, stderr, exit code |
| `bad-words` | ends a word only at a space, not at a tab or a newline | stdout |
| `bad-chars` | counts bytes for `-m`, not UTF-8 characters | stdout |
| `bad-vertical-space` | doesn't end a word at a vertical tab or a form feed | stdout |
| `bad-last-line` | leaves a last line without a newline out of `-L` | stdout |
| `bad-empty-input` | prints nothing for empty standard input | stdout |
| `bad-no-total` | prints no total line for several files | stdout |
| `bad-dash-file` | opens `-` as a file instead of reading standard input | stdout, stderr, exit code |
| `bad-error-status` | exits 0 when the last file reads fine, even after one that couldn't be read | exit code |
| `bad-stop-on-error` | stops at the first file that can't be read | stdout |
| `bad-long-option` | accepts `--lines` as `-l` | stdout, stderr, exit code |
| `bad-options-first` | reads an option after a file as a file | stdout, stderr, exit code |

The racy one diverges differently on each run, so its cases are listed as flaky-candidate (they
count as divergences) instead of forming a cluster. The test suite runs every bad port and checks
that each one is caught, lands in its expected cluster and minimizes to its expected repro.

## Mutation ports

[cargo-mutants](https://mutants.rs) turns the good port into dozens more bad ones, one small change
each, and the share that `port-anything run` catches on the corpus is the corpus's mutation score.
`mutation-score.json` records it with every mutant that survives and why: equivalent (the change
can't show, as with argv[0], which is always the bare program name here) or not tested by the
corpus. CI fails when the score drops or a new mutant survives. To run it (needs cargo-mutants):

```sh
cd packages/cli
PA_MUTANTS=1 pnpm exec vitest run test/wc-lite-mutants.test.ts       # check
PA_MUTANTS=update pnpm exec vitest run test/wc-lite-mutants.test.ts  # re-record, then explain new survivors
```

## Running it

Needs a C compiler and cargo.

```sh
cc -O2 -o ref/wc-lite ref/wc-lite.c
cargo build --release --manifest-path port/Cargo.toml
cargo build --release --manifest-path port/Cargo.toml --features bad-crlf --target-dir port/target/bad-crlf

port-anything run                         # the port: every case matches
port-anything run --candidate ./port/target/release/wc-lite --candidate ./port/target/bad-crlf/release/wc-lite
```

The cases run in the local sandbox (bubblewrap on Linux); add `--no-sandbox` where there is none.
