# Libraries: compare through a driver

Port Anything runs programs. A library has no command line, so give each side one: a thin
**driver** that reads one call per line on stdin, makes the call, and prints one result per line
on stdout. The reference library gets a driver in its language, and the port gets a driver in
its own. Both drivers are then ordinary command-line programs, and everything else applies as it
does to any program: `run`, clusters, minimized repros, the report and history.

## The driver protocol

Each line in is a JSON object naming the function and its arguments. Each line out is the result,
either the return value or an error:

```text
{"fn":"parse","args":["1h30m"]}    →  {"ok":5400}
{"fn":"format","args":[5400]}      →  {"ok":"1h30m"}
{"fn":"parse","args":["1x"]}       →  {"error":"bad-unit"}
```

The protocol is a convention between your two drivers, so it can grow what your library needs
(several arguments, objects, byte strings as hex), as long as both drivers agree. What makes a
driver work for comparison:

- **One line out for every line in, in order**, also for a line it can't read (an error result).
- **Errors are values.** Map each error of the library to a name, and map the port's errors to the
  same names: a C status code and a Rust error variant that mean the same thing print the same.
  Don't print the language's own error text.
- **The same bytes for the same value.** Results are compared byte for byte, so both drivers must
  write JSON the same way: the same key order, no spaces, integers as integers, the same escaping.
- **Nothing else on stdout.** No timings, pointers or random values. A crash, such as a panic or a
  segfault, is fine: it shows up as a divergence in the exit code and stderr.
- **Each case starts a new driver process.** Calls in different cases can't affect each other.
  When the order of calls matters, put them in the same case.

An agent writes a driver in a few minutes. Ask for one per side, with the protocol above and the
library's error list.

## Worked example: a C library and its Rust port

[`examples/durations`](../examples/durations) is a small C library, `dur`, that parses and formats
durations such as `1h30m`, with a Rust port of it. Each has a driver:

- `ref/dur.c`, `ref/dur.h`: the library. `dur_parse` returns a status code (`DUR_EMPTY`,
  `DUR_BAD_NUMBER`, `DUR_BAD_UNIT`, `DUR_OVERFLOW`) and `dur_format` writes into a buffer.
- `ref/driver.c`: the reference's driver, in C.
- `port/src/lib.rs`: the port. `parse` returns `Result<i64, ParseError>` and `format` returns a
  `String`.
- `port/src/bin/dur-driver.rs`: the port's driver, in Rust. It maps `ParseError::BadUnit` to
  `"bad-unit"`, as the C driver maps `DUR_BAD_UNIT`.
- `port-anything.yaml` and `port-anything/recorded/calls.jsonl`: the project and its cases.

The drivers parse their input by hand, so the example builds with no dependencies. A real driver
would use a JSON library (cJSON, serde_json).

From the top of a clone of this repository (needs a C compiler and cargo), build both sides and
send a call to each driver:

```sh
cd examples/durations
cc -O2 -o ref/dur-driver ref/driver.c ref/dur.c
cargo build --release --manifest-path port/Cargo.toml
printf '%s\n' '{"fn":"parse","args":["1h30m"]}' '{"fn":"format","args":[5400]}' | ./ref/dur-driver
printf '%s\n' '{"fn":"parse","args":["1h30m"]}' '{"fn":"format","args":[5400]}' | ./port/target/release/dur-driver
```

```text
{"ok":5400}
{"ok":"1h30m"}
```

A case is one line of a `port-anything/recorded/*.jsonl` file: the calls go in its `stdin`, one per
line, and `features` names what it covers, which is what parity is counted by. One of the
example's cases:

```text
{"argv":[],"stdin":"{\"fn\":\"parse\",\"args\":[\"1x\"]}\n","features":["error.bad-unit","fn.parse"],"origin":"recorded"}
```

Run every case on both drivers:

```sh
port-anything run
```

```text
Ran 55 cases as "dur-driver", sandbox: …
candidate 1 ./port/target/release/dur-driver: 55 of 55 cases match
  parity 100.0%, mean of 7 features (55 of 55 scored cases match)
```

The port's `bad-overflow` feature compiles in a bug: it adds up the parts of a duration without
checking for overflow, so a duration too long for 64 bits wraps around instead of giving
`"overflow"`. Build it and run it as the candidate:

```sh
cargo build --release --manifest-path port/Cargo.toml --features bad-overflow --target-dir port/target/bad-overflow
port-anything run --candidate ./port/target/bad-overflow/release/dur-driver   # exit code 1
```

```text
candidate 1 ./port/target/bad-overflow/release/dur-driver: 49 of 55 cases match, 6 diverge
  cluster 1: 6 cases · stdout other · features error.overflow (6), fn.parse (6)
```

From here it's a normal project: `port-anything minimize 1` shrinks the cluster to a minimal
repro, and `port-anything report` writes the HTML report.

## Your own library

1. Write the two drivers, one per side.
2. Set up the project with `port-anything init <dir> --ref <reference driver> --candidate <port driver>`,
   or write `port-anything.yaml` yourself. The example's:

   ```yaml
   version: 1
   program_name: dur-driver
   reference:
     cmd: ./ref/dur-driver
     build: cc -O2 -o ref/dur-driver ref/driver.c ref/dur.c
   candidate:
     cmd: ./port/target/release/dur-driver
     build: cargo build --release --manifest-path port/Cargo.toml
   sandbox:
     mode: local
     timeout: 10s
   corpus:
     min_cases_per_feature: 3
   ```

   A feature needs 20 cases by default to count in the parity; `corpus.min_cases_per_feature`
   lowers that for a small hand-written corpus like this one.
3. Write the cases in `port-anything/recorded/*.jsonl`, or have your agent write them, for
   example from the library's own unit tests: each test's calls become a case's stdin. Tag them
   by function (`fn.parse`) and by error (`error.overflow`), so the parity shows which part
   of the library differs.
4. `port-anything run`.

`port-anything compare` doesn't fit a driver: it generates command-line arguments from `--help`,
and a driver takes its calls on stdin.
