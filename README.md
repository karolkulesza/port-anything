v0.1 covers non-interactive CLIs.

# Port Anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything records what a program actually does, generates thousands more test cases, runs the original and the port side by side, and reports a parity score with a minimal reproducer for every difference. It is packaged so a coding agent (Claude Code, Codex, Cursor, Gemini CLI) can drive the whole port.

**Scope of v0.1:** black-box programs you can run as a process with pipes (argv, stdin, environment, input files), compared on exit code, stdout, stderr and file changes. One reference, one or more candidates. Linux first; macOS works by copying all fixtures into the sandbox or in container mode. Programs that need a terminal (TUIs, interactive prompts), network services and GUI apps are out of scope for now.

**Status:** in development. Nothing is released yet.

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
