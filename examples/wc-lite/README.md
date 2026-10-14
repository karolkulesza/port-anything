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
  minimum is 20); `help` and `version` are reported on their own, outside the parity.

## Bad ports

Each cargo feature of the port compiles in one deliberate bug:

| Feature | Bug | Shows up in |
|---|---|---|
| `bad-off-by-one` | counts a last line without a newline as a line | stdout |
| `bad-crlf` | leaves the CR of a CRLF line ending out of `-L` | stdout |
| `bad-exit-code` | exits 1 instead of 2 on a usage error | exit code |

## Running it

Needs a C compiler and cargo.

```sh
cc -O2 -o ref/wc-lite ref/wc-lite.c
cargo build --release --manifest-path port/Cargo.toml
cargo build --release --manifest-path port/Cargo.toml --features bad-crlf --target-dir port/target/bad-crlf

port-anything run                         # the port: every case matches
port-anything run --candidate ./port/target/release/wc-lite --candidate ./port/target/bad-crlf/release/wc-lite
port-anything report                      # the latest run as port-anything-report.html
```

The cases run in the local sandbox (bubblewrap on Linux); add `--no-sandbox` where there is none.
