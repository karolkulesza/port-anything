---
name: port-loop
description: Drive a port (a rewrite of a command-line program) to parity with its original using a Port Anything project, one divergence cluster at a time - take the next cluster and its minimized repro, fix the port, re-run the cluster and the smoke subset, commit when green, repeat. Use for "make the port pass", "fix the parity divergences", "work through the port-anything clusters", "get the Rust port to 100%", or continuing a port that has a port-anything.yaml.
---

# port-loop: fix a port, one cluster at a time

You work on the **candidate** (the port) until it behaves like the **reference** (the original
program) on every case of a Port Anything project. Port Anything is the oracle: it runs both
programs on the same cases and groups the divergences into **clusters** (cases that differ in
the same fields, the same way), each with a minimized repro. You fix a cluster, not a case.

The oracle is the reference, the cases and the config. You change the candidate, nothing else
(the rules at the end are not optional).

## 0. Before the first iteration

1. **The project.** The current directory (or the one the user names) has `port-anything.yaml`.
   Read it: `reference.cmd`, `candidate.cmd` and `candidate.build` (or a `candidates` list) tell
   you what runs and how the port is built. No config: this is not a project yet; `port-anything compare '<ref>'
   '<candidate>' --save` starts one, but ask the user first.
2. **The tools.** Use the `port-anything` MCP server's tools when it is connected (`status`,
   `next`, `run`). If it isn't, register it once for this project:

   ```sh
   claude mcp add port-anything -- npx port-anything mcp
   ```

   (Run from the project directory: the server serves the project in its working directory.)
   Without MCP, every step below has a CLI equivalent, given next to it. The CLI is
   `port-anything` if it is on `PATH`, otherwise `npx port-anything` (Node 22.15+).
3. **Build both sides** with the config's build commands (`reference.build`, then
   `candidate.build`), in a shell. A reference that doesn't build is the user's problem to solve:
   stop and say so.

   **Sandbox mode `container`** (`sandbox.mode: container` in the config): the programs are
   built and run in the image (`sandbox.image`, `debian:12-slim` when it isn't set), not on this
   machine. `port-anything run` (and the `run` and `next` tools) build both sides in the image
   themselves before each run, and what they build may not run here. So don't build on this
   machine; build, and run a program by hand, in the image, with the project at the same path:

   ```sh
   docker run --rm -i -v "$PWD:$PWD" -w "$PWD" -u "$(id -u):$(id -g)" -e HOME=/tmp <image> sh -c '<command>'
   ```

   (`podman` takes the same options.) Every "run it yourself" and "build" below means this in
   container mode.
4. **A full run.** `next` and `run` work from the latest run of the whole corpus. Call `status`
   (CLI: the summary `port-anything run` prints): if it says there is no run, or the candidate
   changed since the latest one, run the whole corpus in a shell:

   ```sh
   port-anything run
   ```

   Exit `0` every case matched, `1` some diverged (the normal starting point), `3` the run couldn't
   start (read stderr: a missing build, no sandbox). `port-anything run` refuses to run without a
   sandbox; don't add `--no-sandbox` on your own, tell the user what the refusal says.
5. Note the headline (parity per candidate, open clusters) from `status`: you report the
   before/after at the end.

## 1. The loop

Repeat until `next` says there is no open cluster, or the user's goal (a parity, a number of
clusters, a time box) is met.

1. **Take the next cluster:** the `next` tool (CLI: `port-anything minimize <n> --json` prints
   the repro of cluster `n` of the latest run; run it on both sides yourself for the diff). It returns the cluster's signature in words (which fields
   differ and how: `stdout number-value`, `exit`, `stderr`…), its size, the features its cases
   carry, a **minimized repro** (argv, env, stdin and input files, written out in full) and the
   reference vs candidate diff on that repro. The first call on a cluster minimizes it, which
   runs both programs many times; later calls reuse the repro.
2. **Understand the reference's behavior.** The repro is the specification. Run the reference on
   it yourself, in an empty temporary directory with the repro's input files, under the program
   name the project uses (`program_name` in the config; the tools show it). Vary the input around
   the repro (one byte more, one less, another flag value) until you can state the rule in one
   sentence ("a CR before the LF counts in `-L`"). Read the reference's source when you have it:
   the behavior on the repro, not your idea of what the program should do, is what the port must
   match, including odd corners and exact error messages.
3. **Edit the candidate** to follow that rule. Fix the cause, in the code path the cluster's
   features point to; never special-case the repro's input, argv or file names.
4. **Build** with `candidate.build`. A build failure is yours to fix before going on.
5. **Re-run the cluster:** the `run` tool with `cluster` set to the cluster number from `next`
   (CLI: `port-anything run --cluster <n>`). Every case of the cluster must match now. If some
   still diverge, they are another rule hiding in the same cluster: go back to step 2 with one of
   them (`run` with `cases` set to its ID runs just that case).
6. **Check for regressions:** the `run` tool with no arguments runs the smoke subset (a case per
   open cluster, a few per feature, a sample of passing cases; CLI: `port-anything run --smoke`).
   Its answer says `fixed N, broke M` against the latest full run. `broke` must be 0. If it isn't,
   the change broke cases that used to match: look at them (`run` with `cases` set to the IDs it
   names), fix the regression, and run the smoke subset again. Don't commit while `broke` > 0.
7. **Commit** when the cluster passes and the smoke run broke nothing: only the candidate's
   files, with a message that states the rule you implemented (`fix(wc): count a CR before the LF
   in -L, as wc-lite does`). One cluster per commit, so a regression found later is easy to trace
   and revert. A full `port-anything run` appends a line to `.port-anything/history.jsonl`, the
   project's committed parity history: commit it with the fix, as the tool wrote it.
8. **Repeat** from step 1. `next` skips the clusters a later run of that cluster found fixed,
   and re-runs each remaining cluster's repro before offering it: one that no longer diverges (a
   fix for another cluster covered it, as a smoke run's `fixed` count may already show) is
   skipped with a one-line note, so it moves on by itself.

Every few clusters, and always before you stop, run the whole corpus again
(`port-anything run`): a fix can change what other cases do, and a full run re-ranks the
clusters and catches what the smoke subset doesn't sample. Continue with `next` on the new run.

### When a cluster doesn't fit the loop

- **The repro doesn't diverge any more** (`next` names the cluster as skipped, or the repro is
  marked as not minimized): a previous fix already covered it. Re-run the cluster to confirm,
  then move on.
- **The candidate is flaky** (the same case gives different output from run to run, listed as
  flaky-candidate): that is a bug in the port (a race, uninitialized memory, hash-map order,
  time), never noise to hide.
- **The difference looks intended** (the reference has a bug the user doesn't want copied, or a
  difference the project accepts): don't decide that yourself. Describe it to the user with the
  repro. If they agree to accept it, `port-anything waive --from-cluster <n>` prints a waiver to
  add to `port-anything/waivers.yaml`, and that change goes in its own commit (rules below).
- **The reference's output varies between runs** (timestamps, temp paths, PIDs): those cases are
  already left out as flaky-reference. A normalizer for them is a config change: propose it to
  the user, with the reason, in its own commit.
- **Stuck** after a few attempts on one cluster: say what you found (the rule as far as you
  understand it, what you tried), skip it and take the next one only if the user agrees.

## 2. Report

When you stop, tell the user: the parity before and after (`status`), the clusters fixed (one
line each: the rule and the commit), what's still open and why, and any waiver or normalizer you
propose. Numbers from the tools only; never estimate parity yourself.

## Rules

- **Never edit `.port-anything/`** by hand: not the manifest, the runs, the cache or the
  history. Don't delete, regenerate or restore anything in it to change a result. The tool writes
  it; you only commit what it wrote.
- **Never change the oracle to make cases pass:** the reference, its build, the committed cases
  (`port-anything/recorded/`, imported cases, seeds), `port-anything/cli-spec.yaml` and the
  corpus settings stay as they are. Removing or editing a failing case is not a fix.
- **Never call the reference from the candidate**, and never copy its output into the port: no
  running the original program, its library or a saved copy of its answers. The port must compute
  every answer itself.
- **Any change to normalizers or waivers** (`compare` and `normalizers` in `port-anything.yaml`,
  `port-anything/waivers.yaml`) needs the user's agreement and goes in **its own commit**, never
  mixed with a fix, with the reason in the message: what differs, why it is acceptable, which
  cluster it covers.
- Never add `--no-sandbox` without the user's explicit agreement.
- Commit only when green: the cluster passes and the smoke run says `broke 0`. Don't push or open
  pull requests unless the user asks.
