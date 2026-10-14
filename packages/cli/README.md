v0.1 covers non-interactive CLIs.

# port-anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything runs an original program and its port side by side on generated test cases and reports a parity score per feature. This is an early release: `compare` works with zero configuration; clusters, minimal reproducers and the HTML report come in v0.1.

Requires Node 22.15+. Linux and macOS.

## Quickstart: `compare`

Compare two programs without any setup. Port Anything reads the reference's `--help`, generates 500 cases from it, runs the reference twice to spot nondeterministic output, then runs every candidate and prints a parity line per candidate and a feature × candidate matrix.

Linux (Debian 12: GNU `sort` against the [uutils](https://github.com/uutils/coreutils) multicall binary):

```sh
npx port-anything compare /usr/bin/sort 'coreutils sort'
```

macOS (BSD `sort` against GNU `sort` from Homebrew's `coreutils`):

```sh
npx port-anything compare /usr/bin/sort gsort
```

```
gsort: parity 30.3%  (mean of 17 features; 151/500 cases)

  feature               parity
  base                  55.5% 15/27
  opt.T                 75.7% 25/33
  opt.u                 66.6% 22/33
  …
untested (no generated case): opt.b, opt.c, opt.f, …
```

Name programs by explicit path when the plain name is ambiguous: on Ubuntu 25.10 and later, `sort` already *is* uutils. Both sides run under the reference's program name (`argv[0]` is pinned), so a multicall binary such as `'coreutils sort'` or `'busybox sort'` works as a candidate. Pass several candidates to compare them all against one reference.

| Option | What it does |
|---|---|
| `--budget N` | Number of generated cases (default 500) |
| `--json` | Print the result as JSON instead of text |
| `--save` | Turn the run into a project: writes `port-anything.yaml` and `port-anything/cli-spec.yaml` (never overwrites) |
| `--i-know` | Allow a tool known to be destructive (`rm`, `dd`, …) |
| `--no-sandbox` | Run without a sandbox when none is available |

**Safety:** every case runs in a sandbox with no network (`bwrap`, or `unshare` as a fallback, on Linux; `sandbox-exec` on macOS), in a scratch directory with relative paths only. If no sandbox works, `compare` refuses to run unless you pass `--no-sandbox`.

**Exit codes:** 0 = no divergence, 1 = divergences found, 3 = usage or config error.

More: [github.com/karolkulesza/port-anything](https://github.com/karolkulesza/port-anything)

## License

[Apache-2.0](https://github.com/karolkulesza/port-anything/blob/main/LICENSE)
