# durations

A small C library that parses and formats durations such as `1h30m` (`ref/`), a Rust port of it
(`port/`), a driver for each side, and the Port Anything project that checks the port against the
reference through the drivers. [Libraries: compare through a driver](../../docs/library-drivers.md)
walks through it.

- `ref/dur.h`, `ref/dur.c`: the reference library. `dur_parse` reads an optional `-` and parts
  such as `90s` or `1h30m` (units `d`, `h`, `m`, `s`, in any order, adding up) and returns a
  status code; `dur_format` writes the parts from days down, leaving out zero parts.
- `ref/driver.c`: its driver. One JSON call per stdin line, one JSON result per stdout line.
- `port/`: the Rust port (`src/lib.rs`) and its driver (`src/bin/dur-driver.rs`), which must
  answer every call exactly like the C driver.
- `port-anything.yaml` and `port-anything/recorded/calls.jsonl`: the config and the cases.

The cargo feature `bad-overflow` compiles in one deliberate bug: the parts of a duration are added
up without checking for overflow.

## Running it

Needs a C compiler and cargo.

```sh
cc -O2 -o ref/dur-driver ref/driver.c ref/dur.c
cargo build --release --manifest-path port/Cargo.toml
port-anything run                         # every case matches

cargo build --release --manifest-path port/Cargo.toml --features bad-overflow --target-dir port/target/bad-overflow
port-anything run --candidate ./port/target/bad-overflow/release/dur-driver
```

The cases run in the local sandbox (bubblewrap on Linux); add `--no-sandbox` where there is none.
