# Refactor guard: compare a program with itself at another commit

Before you, or a coding agent, refactor a command-line program, the version you have committed is
the behavior to keep. `port-anything compare --ref git:<rev>` builds the program as it was at that
commit and uses it as the reference. The candidate is the program as it is now in your working
copy. Everything else is the same as a normal `compare`: cases generated from the reference's
`--help`, the same sandbox, and the same parity line and feature matrix. Any difference is a
behavior change the refactor brought in.

| `--ref` | Reference |
|---|---|
| `git:HEAD` | The last commit, so your uncommitted changes are what's compared |
| `git:HEAD~1` | The commit before it |
| `git:main` | Another branch, such as the one a pull request goes into |
| `git:v1.4.0` | A release tag |

Anything `git rev-parse` takes as a commit works.

## Try it on the example

From the top of a clone of this repository (needs a C compiler), go to the
[wc-lite example](../examples/wc-lite) and build its reference, a small `wc` in C. Then compare
the build against the same program at the last commit:

```sh
cd examples/wc-lite
cc -O2 -o ref/wc-lite ref/wc-lite.c
port-anything compare --ref git:HEAD ./ref/wc-lite
```

```text
building git:HEAD (…) in a temporary worktree …
reference: ./ref/wc-lite at git:HEAD (…), built with `cc -O2 -o ref/wc-lite ref/wc-lite.c`
read "wc-lite --help": 7 flags, 1 positional form
generated 500 cases (budget 500)
…
./ref/wc-lite: parity 100.0%  (mean of 6 features; 500/500 cases)
```

Nothing has changed yet, so every case matches. Now make a change that looks like a harmless
cleanup: in `ref/wc-lite.c`, cut `is_space` down to the whitespace most people think of:

```c
static int is_space(unsigned char b) {
    return b == ' ' || b == '\t' || b == '\n';
}
```

Rebuild and compare again. Some generated inputs hold a carriage return, vertical tab or form
feed, and the counts for those inputs now differ:

```sh
cc -O2 -o ref/wc-lite ref/wc-lite.c
port-anything compare --ref git:HEAD ./ref/wc-lite   # exit code 1
```

```text
./ref/wc-lite: parity 99.0%  (mean of 6 features; 496/500 cases)

  feature                         parity
  base                            100.0% 118/118
  opt.L                           99.2% 136/137
  opt.c                           98.9% 195/197
  …
  opt.w                           97.7% 174/178
```

`compare` exits 1 when any case diverges, so the guard works as a check in a script or CI job.
`--json` prints the same result as JSON, with every diverging case's arguments and the fields that
differ. Put the file back when you're done:

```sh
git checkout -- ref/wc-lite.c
cc -O2 -o ref/wc-lite ref/wc-lite.c
```

## Where the reference comes from

The commit is checked out in a temporary git worktree, detached, so no branch is created or
moved. Your working copy, uncommitted changes included, is left alone. Then:

- **With a `port-anything.yaml` in the directory you run from**, the reference is its
  `reference.cmd`, built first with its `reference.build`. Both are read from the config as it is
  now, not as it was at the commit, so a build command you've just fixed is the one that runs. The
  example above works this way: its config builds `ref/wc-lite` with `cc`.
- **Without a config**, the reference is the first candidate's command, run from the checkout with
  no build step. That suits scripts and other programs that are committed as they run. A compiled
  program needs a config, because its build output isn't committed and so isn't in the checkout.

A minimal config for a refactor guard on a Rust program:

```yaml
version: 1
reference:
  cmd: ./target/release/tool
  build: cargo build --release
```

With it, `port-anything compare --ref git:main ./target/release/tool` builds `main` in the
checkout and compares that build with the one in `./target/release`, which you build yourself.

How the command is found in the checkout:

- A relative path such as `./target/release/tool` is looked up in the checkout's copy of the
  directory you run from.
- An absolute path into the repository is moved into the checkout, both as the program and as a
  whole argument. For a script run by an interpreter, give the script's absolute path:
  `python3 /home/me/tool/tool.py`. A path inside an argument such as `--config=/home/me/tool/x.toml`
  is passed on unchanged.
- A command with nothing in the repository, such as `/usr/bin/sort`, would be the same program at
  every commit, so it's refused.

## Things to know

- The checkout has only what the commit has. Untracked and ignored files, such as build output or
  local test data, aren't there. `reference.build` runs with `sh -c` in the checkout's copy of the
  directory you ran from, on your machine, not in the sandbox. The cases run in the sandbox as usual.
- The checkout goes in the repository's git directory (`.git/port-anything-ref-…`) and is removed
  when the run ends. If a run is killed before it can clean up, `git worktree prune` after deleting
  that directory removes the leftover. `git worktree list` shows any that remain.
- git runs your `post-checkout` hook, if you have one, in the checkout.
- `--save` can't be combined with `--ref`, because `port-anything.yaml` can't record a git
  reference.
- Exit codes are those of `compare`: 0 when every case matches, 1 when any diverges, 3 for a usage
  or config error, including a revision that names no commit or a failed `reference.build`.
- In CI, check out the full history (with `actions/checkout`, `fetch-depth: 0`) so the base branch
  is there, and compare against it with `--ref git:origin/main`.
