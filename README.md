v0.1 covers non-interactive CLIs.

# Port Anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything records what a program actually does, generates thousands more test cases, runs the original and the port side by side, and reports a parity score with a minimal reproducer for every difference. It is packaged so a coding agent (Claude Code, Codex, Cursor, Gemini CLI) can drive the whole port.

**Scope of v0.1:** black-box programs you can run as a process with pipes (argv, stdin, environment, input files), compared on exit code, stdout, stderr and file changes. One reference, one or more candidates. Linux first; macOS works by copying all fixtures into the sandbox or in container mode. Programs that need a terminal (TUIs, interactive prompts), network services and GUI apps are out of scope for now.

**Status:** early release (v0.0.1). `compare` works with zero configuration and prints parity and per-feature numbers; clusters, minimal reproducers and the HTML report come in v0.1.

## Quickstart: `compare`

Requires Node 22.15+, on Linux or macOS. Compare two programs without any setup: Port Anything reads the reference's `--help`, generates 500 cases from it, runs the reference twice to spot nondeterministic output, then runs every candidate and prints a parity line per candidate and a feature × candidate matrix.

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

The container installs its own `node_modules` (in Docker volumes, so macOS builds of native packages stay on the host), runs commands with your uid, sets `PA_SANDBOX_TESTS=1` so the Linux sandbox tests run (they are skipped elsewhere; the macOS `sandbox-exec` tests run on any Mac), and disables Docker's seccomp and AppArmor confinement and its `/proc` masking so bubblewrap can create its sandbox inside. In the container, `sort` is uutils and `gnusort` is GNU.

| Package | What it is |
|---|---|
| [`packages/cli`](packages/cli) | `port-anything`, the CLI |
| [`packages/core`](packages/core) | `@port-anything/core`, the engine |
| [`packages/mcp`](packages/mcp) | `@port-anything/mcp`, the MCP server |
| [`packages/report`](packages/report) | `@port-anything/report`, the HTML report and badge |

Releases are versioned with [changesets](https://github.com/changesets/changesets): add one with `pnpm changeset`, and `pnpm changeset version` applies them. Only `port-anything` (`packages/cli`) is published so far; it bundles the engine, so publish it from its folder (`cd packages/cli && npm publish`), which builds it first.

## License

[Apache-2.0](LICENSE)
