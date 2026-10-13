v0.1 covers non-interactive CLIs.

# Port Anything

> Rewrite it in Rust (or Go, TS, Swift…) and *show* nothing changed.

Port Anything records what a program actually does, generates thousands more test cases, runs the original and the port side by side, and reports a parity score with a minimal reproducer for every difference. It is packaged so a coding agent (Claude Code, Codex, Cursor, Gemini CLI) can drive the whole port.

**Scope of v0.1:** black-box programs you can run as a process with pipes (argv, stdin, environment, input files), compared on exit code, stdout, stderr and file changes. One reference, one or more candidates. Linux first; macOS in container mode. Programs that need a terminal (TUIs, interactive prompts), network services and GUI apps are out of scope for now.

**Status:** in development. Nothing is released yet; the first release will be `0.1.0`.

## License

[Apache-2.0](LICENSE)
