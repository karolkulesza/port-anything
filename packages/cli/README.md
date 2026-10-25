v0.1 covers non-interactive CLIs.

# port-anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything records what a program actually does, generates thousands more test cases, runs the original and the port side by side, and reports a parity score with a minimal reproducer for every difference.

**First results:** run on six GNU coreutils against uutils, busybox and toybox, and on jq against jaq and gojq, it found 12 differences nobody had reported; 8 are already fixed upstream. [The matrix and the write-up](https://github.com/port-anything/showcases/blob/main/WRITEUP.md).

Requires Node 22.15+. Linux and macOS. Programs run with pipes (argv, stdin, environment, input files), never a terminal; TUIs, interactive prompts, network services and GUI apps are out of scope for now.

## Quickstart: `compare`

Compare programs without any setup. Port Anything reads the reference's `--help`, generates 500 cases from it, runs the reference twice more to spot nondeterministic output, then runs every candidate in a sandbox and prints a parity line per candidate and a feature × candidate matrix.

Linux (Debian 12, with the `rust-coreutils` and `bubblewrap` packages: GNU `sort` against the [uutils](https://github.com/uutils/coreutils) multicall binary):

```sh
npx port-anything compare /usr/bin/sort 'coreutils sort'
```

macOS (BSD `sort` against GNU `sort` from Homebrew's `coreutils`):

```sh
brew install coreutils
npx port-anything compare /usr/bin/sort gsort
```

The first argument is the reference; every other argument is a candidate. Name programs by explicit path when the plain name is ambiguous: on Ubuntu 25.10 and later, `sort` already *is* uutils. Both sides run under the reference's program name (`argv[0]` is pinned), so a multicall binary such as `'coreutils sort'` or `'busybox sort'` works as a candidate.

| Option | What it does |
|---|---|
| `--budget N` | Number of generated cases (default 500) |
| `--json` | Print the result as JSON instead of text, for scripts and agents |
| `--save` | Write `port-anything.yaml` and the inferred `port-anything/cli-spec.yaml`: a project where `port-anything run` runs the same cases (never overwrites) |
| `--i-know` | Allow a tool known to be destructive (`rm`, `dd`, `mkfs`…) |
| `--no-sandbox` | Run without a sandbox, for programs you trust |

**Safety:** every case runs in a sandbox with no network (`bwrap`, or `unshare` as a fallback, on Linux; `sandbox-exec` on macOS), in a scratch directory with relative paths only. If no sandbox works, `compare` refuses to run unless you pass `--no-sandbox`.

## A project, for a real port

A port you work on for weeks gets a project: `port-anything.yaml` (how to build and run each side, the normalizers, the strictness profile) and a `port-anything/` directory with the cases, all committed. `compare --save` starts one. The generated cases aren't committed: every checkout regenerates the same ones from the CLI spec and the generator seed in the config. `generate` also mutates the cases recorded in `port-anything/recorded/`: one token at a time in an argument that holds a program or a query, and byte by byte in stdin and input files. That's how a program whose input is code (awk, sed, a SQL shell) gets a generated corpus and a fresh holdout, since its `--help` can't write a valid program. In a project directory:

```sh
npx port-anything generate --budget 5000   # a bigger corpus; the budget and seed go into port-anything.yaml
npx port-anything run          # parity, and the divergences grouped into clusters
npx port-anything report       # the latest run as port-anything-report.html (with a repro per cluster), port-anything-report.json and a parity badge
npx port-anything waive --from-cluster 1   # a waiver for an accepted difference, to paste into port-anything/waivers.yaml
npx port-anything baseline     # run the reference 3 times per case, propose normalizers, freeze .port-anything/MANIFEST.json
npx port-anything verify       # check the cases and the reference's output against the manifest
npx port-anything init . --ci  # a GitHub Actions workflow that recomputes the score on every push, and CODEOWNERS lines to add
npx port-anything mcp          # MCP server over stdio for your agent: status, next (repro + diff), run (fixed/broke deltas), case, features, probe
npx port-anything setup        # register that server and the skills (port-loop, port-plan, port-audit, port-report) with each agent installed: Claude Code, Codex, Cursor, Gemini CLI
npx port-anything --version    # the installed version
```

To see the parity delta right after each edit in Claude Code, turn on the smoke hook in the port's `.claude/settings.json` (it isn't installed by `setup` or the plugin). After an Edit or Write to a file of the project outside `port-anything/`, `.port-anything/` and the reference's directory, `port-anything hook` builds the candidate (`candidate.build`), runs the smoke subset and gives the agent what got fixed or broke and the top clusters. A failed build is reported the same way; past `--timeout` seconds (default 60) it stops and says the smoke run was skipped. It never blocks the edit.

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx -y port-anything hook", "timeout": 90 }] }
    ]
  }
}
```

[`examples/wc-lite`](https://github.com/karolkulesza/port-anything/tree/main/examples/wc-lite) in the repo is a complete project to try this on.

**Exit codes:** 0 = no divergences, 1 = divergences (or parity below `compare.min_parity` when it is set, or a significant fresh-holdout gap), 2 = integrity broken (`verify`), 3 = usage or config error.

More, including the integrity threat model: [github.com/karolkulesza/port-anything](https://github.com/karolkulesza/port-anything)

## License

[Apache-2.0](https://github.com/karolkulesza/port-anything/blob/main/LICENSE)
