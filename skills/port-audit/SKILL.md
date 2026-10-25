---
name: port-audit
description: Measure an existing rewrite (a port, a reimplementation, a clone) of a command-line program against the original with Port Anything, and write an audit report with per-feature parity and verified, minimized divergences. Use for "audit this port", "how compatible is X with Y", "compare my Rust rewrite with the original", "is busybox sort GNU-compatible", or a compatibility matrix of several implementations of one tool.
---

# port-audit: measure a rewrite against its original

You audit one or more **candidates** (the rewrites) against a **reference** (the original
program) by driving `port-anything compare --json`, then turn its numbers into a short, honest
audit report. You measure; you don't fix. Never edit the programs under audit.

`compare` is zero-config: it reads the reference's `--help`, generates a few hundred test cases
(argv, stdin, input files) from it, runs the reference twice more on every case to find output
that varies between runs, runs every candidate on the same cases in a sandbox, and compares exit
code, stdout, stderr and file changes. It writes nothing outside a scratch directory.

## 1. Set up

1. **The CLI.** Use `port-anything` if it is on `PATH`, otherwise `npx port-anything` (Node
   22.15+). `port-anything compare` without arguments prints its usage line (and exits 3): that
   is enough to check it is installed.
2. **The programs.** Get an exact command for the reference and for each candidate. A command is
   a path plus any leading arguments, quoted as one string: `/usr/bin/sort`, `./target/release/wc`,
   `'coreutils sort'`, `'busybox sort'`. Prefer explicit paths: a bare name may resolve to a
   different implementation than you think (on some distributions `sort` already is the rewrite).
   Build any side that needs building first, in release mode. Record each side's version
   (`--version`, the git commit, or the package version) for the report; when they don't tell
   the sides apart (local builds often print the same version), add a short hash of each binary
   (`shasum`).
3. **Same name.** Every side runs under the same `argv[0]` (the reference's file name, or the
   tool name of a multicall command such as `'coreutils sort'`), so a program that prints its
   own name in errors doesn't diverge. Two multicall sides with different tool names can't be
   compared.
4. **Sandbox.** `compare` fuzzes the programs, so it runs every case in a sandbox without network
   (`bwrap` on Linux, `sandbox-exec` on macOS) and refuses with exit 3 when there is none. Don't
   add `--no-sandbox` on your own: tell the user what the refusal says and let them choose (a
   container, installing bubblewrap, or accepting an unsandboxed run).
5. **Destructive tools.** For tools that delete or overwrite (`rm`, `dd`, `git push`-style
   subcommands…) `compare` refuses without `--i-know`. Ask the user before adding it.

## 2. Run compare

```sh
port-anything compare '<reference>' '<candidate 1>' '<candidate 2>' --json > audit.json
```

- One reference, any number of candidates (N-way: every candidate runs on the same cases).
- `--budget N` sets how many cases to generate (default 500). Raise it (`--budget 2000`) when
  the result lists many under-sampled features; lower it for a quick first look.
- Progress lines go to stderr; stdout is the JSON only. A run takes from seconds to a few
  minutes, mostly depending on the budget and on how many candidates there are.
- **Exit codes:** `0` every candidate matched on every case; `1` at least one case diverged (the
  normal outcome of an audit, not a failure of the run); `3` the run couldn't start (arguments,
  a program not found, no sandbox, a destructive tool): read stderr, fix, rerun.
- The same programs and budget always give the same cases, so a rerun after a fix is comparable.

## 3. Read the JSON

| Field | Meaning |
|---|---|
| `program_name` | The `argv[0]` every side ran as. |
| `reference` | The reference command, as given. |
| `sandbox` | The sandbox used (`none (--no-sandbox)` when unsandboxed: say so in the report). |
| `spec.help`, `spec.flags`, `spec.forms`, `spec.subcommands`, `spec.features` | The help invocation read (`--help` or `-h`, or empty: the program was run with no arguments and printed its usage line) and what was read from it. Few flags for a rich tool means its help text was hard to parse: say the audit covers only these. |
| `corpus.cases`, `corpus.budget`, `corpus.seed`, `corpus.generator` | Cases generated, the budget asked for, and the seed and generator version (fixed, for repeatability). |
| `corpus.stop`, `corpus.observed`, `corpus.dropped` | Why generation stopped (`budget`…), how many cases the reference ran while generating, and how many were dropped (duplicate output, too many errors, over budget). |
| `corpus.skipped` | Destructive subcommands left out. |
| `untested` | Features of the spec that no case exercised. Untested, not passing. |
| `baseline.repeats`, `baseline.stable`, `baseline.normalized` | Extra reference runs per case, and how many cases gave the same output every time, as is or after the normalizers. |
| `baseline.flaky_reference` | Cases whose reference output varied between its own runs (`case`, `argv`, `fields`). They are left out of every score. |
| `normalizers` | Normalizers applied to every side to hide run-to-run noise (timestamps, temp paths, PIDs…), with the number of cases each one changed. |
| `candidates[].command` | The candidate, as given. |
| `candidates[].parity` | The headline: the **mean of per-feature parity** over the features that count (0 to 1), so a feature with many cases doesn't drown the rest. `null` when no feature has enough cases. |
| `candidates[].features` | How many features the headline averages. |
| `candidates[].match`, `candidates[].cases` | Matching cases out of all scored cases, each case counted once. **Always read these next to `parity`:** cases with an unknown or invalid option belong to no feature, so a candidate can show 100% parity and still have divergences (a wrong exit code on a usage error, say). Report `match`/`cases` in the results and triage every divergence, whatever the headline. |
| `candidates[].per_feature[]` | One entry per feature: `feature` (`base` = no flags, `opt.<flag>` = cases using that flag), `match`, `cases`, `parity`. |
| `candidates[].per_feature[].selfDescription` | `--help` / `--version` style features: listed, never in the headline (help text is allowed to differ). |
| `candidates[].per_feature[].underSampled` | Too few cases to count in the headline: report the numbers, don't conclude from them. |
| `candidates[].divergences[]` | Every diverging case: `case` (its ID), `argv` (the arguments after the program name) and `fields` (what differed: `exit` code, `signal`, `timeout`, `stdout`, `stderr`, `fs` for files created, changed or deleted). |
| `candidates[].timeout_recovered` | Cases where the candidate's first run timed out but its re-run finished (`case`, `argv`): a busy machine can stall any program, so the re-run is what was compared and scored. Usually empty; many entries mean the machine was overloaded or the candidate is often slow, so say so. A case that times out on both runs is a divergence (`timeout`). |
| `saved` | Files written by `--save` (a `port-anything.yaml` project and the inferred CLI spec, to keep working on the port with the full project commands); empty without it. Only step 4 uses `--save`. |
| `duration_ms` | Wall time of the run. |

The JSON doesn't include each case's stdin or input files (an `argv` may name an input file,
such as `data.txt`, but not its contents): a divergence tells you **which arguments** and
**which outputs**. For the inputs, get the minimized repros (step 4), or rebuild the input by
hand (step 5).

## 4. Get minimized repros

When there are divergences, turn the audit into a project to get each cluster of divergences
with a minimized repro, inputs included. In an empty working directory (`--save` refuses to
overwrite a project), and with **absolute paths** for every program (`--save` writes the commands
into `port-anything.yaml` as given, and a relative path wouldn't resolve from there):

```sh
port-anything compare '<reference>' '<candidate 1>' '<candidate 2>' --save --json > audit.json
port-anything run
port-anything minimize 1 --json
```

- `--save` writes `port-anything.yaml` (the same programs, budget and seed) and the inferred
  `port-anything/cli-spec.yaml`, so `port-anything run` there regenerates the same cases and
  groups each candidate's divergences into numbered **clusters** (same fields, same kind of
  difference), most important first. Its exit codes are those of `compare`.
- `port-anything minimize <n> --json` shrinks cluster `n` of the latest run to a minimal case and
  prints it under `case`: `argv`, `stdin` and `fixtures` (the input files) in full, plus whether
  it still diverges (`reproduced`). It runs both programs many times: minimize the clusters you
  report, not all of them.
- With the `port-anything` MCP server connected in that directory (`port-anything mcp`), the
  `next` tool gives the top cluster's repro and the reference vs candidate diff in one call.

Use the repros as the starting point of step 5: they replace guessing the input, not reproducing
it by hand.

## 5. Triage the divergences

Don't report raw divergence counts. Turn them into a few **findings**, each verified by hand:

1. **Group** each candidate's `divergences` by the flags in `argv` and by `fields`. Features with
   low parity in `per_feature` tell you where to look first. Many divergences usually come from a
   handful of causes.
2. **Reproduce** each group directly (from its cluster's repro when you have one), outside
   `port-anything`: run the reference and the
   candidate with the same `argv` under the same name, in an empty temporary directory, with a
   small stdin or input file you write. Compare exit code, stdout and stderr (`diff <(ref …)
   <(cand …)`, `echo $?`). Keep the side effects inside the temporary directory. Write probe
   loops as `#!/bin/bash` scripts (or run them with `bash -c`) and quote every argument (`"$@"`,
   arrays): in zsh an unquoted `$args` is not split into words, which gives false differences.
   Keep scripts and inputs in a working directory next to the report.
3. **Minimize**: shrink the arguments and the input until removing anything makes the difference
   go away. A finding is one short command line plus a few bytes of input, the reference's
   output and the candidate's.
4. **Rule out false positives** before calling anything a bug:
   - version skew: the reference is an older or newer release than the one the rewrite targets
     (when versions can't be told apart, say that this wasn't checked);
   - environment: locale, time zone, terminal width, the user, files that exist on one machine;
   - noise the normalizers missed (paths, dates, PIDs): rerun twice;
   - documented, intentional differences of the candidate (check its docs and issue tracker,
     when it has them; say in the report when there was nothing to check);
   - only the wording of an error message differs while the exit code agrees: a real but minor
     difference, report it as such;
   - for deliberately minimal implementations (busybox, toybox…), a missing flag is "not
     implemented", not a wrong answer: report it as coverage.
5. If a group doesn't reproduce by hand, say so ("seen by `compare` on generated input, not
   reproduced by hand") rather than dropping it or guessing.

Then spend a short, bounded pass (a few dozen invocations) **probing what generated cases may
miss**, especially for candidates at 100%: input edge cases the tool's domain suggests (empty
input, no trailing newline, CRLF line endings, invalid UTF-8, very long lines, binary data,
several files, a missing file), combined with the features in `per_feature`. Matching parity
means "no difference on these cases", not "no difference". Report what this pass finds as
separate findings marked "found by hand, not by `compare`", and list what you probed in the
caveats.

## 6. Write the audit

Write the report to `port-audit-<program>.md` in the current directory (or where the user asks),
and keep `audit.json` next to it. Structure:

1. **Setup**: reference and candidates with versions, OS and architecture, sandbox, budget, cases,
   date, the exact `compare` command.
2. **Results**: one line per candidate (parity as a percentage, features averaged, matching
   cases, divergences), then the feature × candidate matrix from `per_feature` (mark under-sampled and
   self-description features).
3. **Findings**, most important first. For each: a one-line title, the minimized command and
   input, the reference's and the candidate's output (or exit code), which feature it falls
   under, how many divergences it explains (its cluster's size, or inferred from the argv and
   fields pattern without clusters: say which), and whether it was reproduced by hand (or found by hand
   only).
4. **Coverage and caveats**: `untested` features, under-sampled features, `flaky_reference`
   cases, the `normalizers` applied, skipped destructive subcommands, anything you ruled out as
   a false positive and why.
5. **Next steps**: a higher budget, features to test by hand, findings worth reporting upstream.

Tone: factual and specific. "parity 97.2% over 14 features; 3 findings", never "X is broken".
Don't claim coverage the run didn't have.

## Rules

- Measure only: don't modify the reference, the candidates or their sources.
- Never add `--no-sandbox` or `--i-know` without the user's explicit agreement.
- Don't file issues, open pull requests or post anywhere. Draft upstream reports in the audit if
  useful; the user decides. Before drafting one, check the project's issue tracker (when there
  is one) for an existing report and mention it instead.
- Every finding in the report has been reproduced, or is marked as not reproduced.
