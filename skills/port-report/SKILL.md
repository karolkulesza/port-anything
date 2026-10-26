---
name: port-report
description: Report where a port (a rewrite of a command-line program) stands against its original with Port Anything - a full run of the project's corpus, the HTML report and badge, and a short human summary of the parity, what changed since the last run, the open divergence clusters and the integrity of the numbers. Use for "how far is the port", "write a parity report", "summarize the port-anything results", "status of the rewrite for the team", or at the end of a port-loop session.
---

# port-report: a full run, the report and a summary people can read

You produce an honest picture of a port's parity for a person who won't read the raw numbers:
run the whole corpus, write the report files, and summarize them. You measure; you don't fix
anything and you don't change the project.

The CLI is `port-anything` if it is on `PATH`, otherwise `npx port-anything` (Node 22.15+). The
`port-anything` MCP server's `status` tool, when it is connected, gives the same headline and the
integrity state in a few lines.

## 1. Run

In the project directory (the one with `port-anything.yaml`):

1. **Build** both sides with the config's `reference.build` and `candidate.build` (or each entry
   of `candidates`). Record what you measured: each side's version or git commit.
2. **Integrity first**, when the corpus is frozen (`.port-anything/MANIFEST.json` exists):

   ```sh
   port-anything verify
   ```

   Exit `0` the cases and the reference's output match the manifest (a warning instead when this
   machine's environment differs from the one it was frozen in: say so); `2` **integrity
   broken**: the cases, the generator settings, the normalizers or the reference's answers
   changed since the freeze. Then the parity can't be trusted: lead the summary with it.
3. **The full run** (never a smoke or cluster run: only a run of the whole corpus is a result):

   ```sh
   port-anything run
   ```

   Exit `0` every case matched, `1` some diverged (a normal result), `3` it couldn't start (read
   stderr). It refuses to run without a sandbox; don't add `--no-sandbox` on your own, tell the
   user what the refusal says.
4. **The report files:**

   ```sh
   port-anything report
   ```

   It writes `port-anything-report.html` (self-contained, a repro and a diff per cluster),
   `port-anything-report.json` and a badge per candidate (`port-anything-badge.svg`,
   `port-anything-badge-2.svg`…), from the latest full run.
5. **Corpus strength** (how much a parity on this corpus means; the report files don't include
   it):

   ```sh
   port-anything strength --json
   ```

   It mutates the (first) candidate, builds each mutant and runs the corpus on it: `score` is the
   share of mutants the corpus catches, `survivors` the mutants it missed (behavior no case
   tests), `tool` the mutation tool used. Exit `0` it ran, `3` it couldn't (read stderr). It needs
   a mutation tool for the candidate's language: `cargo-mutants` for Rust (without it `strength`
   refuses: `cargo install --locked cargo-mutants`), Stryker for JS/TS and `mull` for C/C++ (a
   generic source mutator runs without them; its `notes` say so). Those install outside the
   project or into the candidate's dependencies: don't install them yourself; when `strength`
   refuses for lack of one, report strength as not measured and name the tool. It can take a long
   time, so say so before starting it: `cargo-mutants` and the generic mutator build the
   candidate once per mutant, on a sample of `--mutants N` (200 by default); Stryker and `mull`
   build once but test every mutant, whatever `--mutants` says.

## 2. Read the numbers

From `port-anything-report.json`:

| Field | Meaning |
|---|---|
| `run_id`, `created`, `cases` | The run, when it ran, how many cases it compared. |
| `flaky_reference` | Cases left out because the reference's own output varied between runs in `port-anything baseline`, each with the fields that varied. With `cases` they make up the frozen corpus; `candidates[].raw.flaky_reference` counts them, and they are never scored. |
| `program_name`, `reference`, `sandbox` | The name every side ran as, the reference command, the sandbox. |
| `compare.profile` | How strictly outputs are compared. |
| `normalizers`, `waivers` | What hides run-to-run noise, and the accepted differences: both change what counts as a match. |
| `candidates[].command` | The candidate. |
| `candidates[].headline` | The headline: mean of per-feature parity (0 to 1) over `candidates[].headline_features`; `null` when no feature has enough cases. |
| `candidates[].raw` | Plain counts over every case: `scored`, `match`, `diverge`, `waived`, `flaky_reference`, `flaky_candidate`, `timeouts`. Read them next to the headline: cases with an invalid option belong to no feature. |
| `candidates[].origins` | The same split by where cases come from: `recorded` (real use), `imported` (another test suite), `generated`. Parity on recorded cases is the one closest to real use. |
| `candidates[].features[]` | Per feature: `feature`, `parity`, `cases`, `match`, `diverge`, `under_sampled` (too few cases to count), `self_description` (help and version, not in the headline), `in_headline`. |
| `candidates[].untested` | Features of the spec no case exercised: untested, not passing. |
| `clusters[]` | The run's divergence clusters, highest priority first: `cluster`, `candidate`, `description` (the signature in words), `size`, `features`, `repro` (the case the HTML report shows as a repro). |

And from `.port-anything/history.jsonl` (one line per full run, newest last): each candidate's
`parity`, `scored` and `match` over time. Compare the latest line with the one before for the
change since the previous run.

For a cluster you want to show by example, `port-anything minimize <n> --json` prints its
minimized repro (argv, stdin and input files in full); the `next` tool does the same for the top
cluster, with the diff.

## 3. Write the summary

Write `port-report.md` in the project directory (or where the user asks), short enough to read in
two minutes:

1. **Headline:** per candidate, parity as a percentage, features averaged, matching cases out of
   scored ones, and the change since the previous full run ("parity 94.1% (+3.2 since run …),
   812 of 860 cases").
2. **Integrity:** the `verify` result (or "corpus not frozen"), waivers and normalizers in use
   (a waiver covering many cases deserves a line of its own), flaky-reference cases left out,
   untested and under-sampled features, and the corpus strength ("the corpus kills 91.0% of 200
   mutants, cargo-mutants", or "not measured: cargo-mutants isn't installed"). Numbers mean
   little without this.
3. **Open work:** the top clusters (up to 5) in one line each: what differs, how many cases,
   which features. Then the weakest features from `features[]`.
4. **What was measured:** each side's version or commit, the date, the sandbox, the cases, the
   exact commands you ran. Point to `port-anything-report.html` for the detail.

Tone: factual and specific. Quote the tool's numbers, never estimate them; "parity 94.1% over 12
features", never "almost done". Don't round 99.6% up to 100%.

## Rules

- Measure only: don't edit the candidate, the reference, the config, the cases, the waivers or
  anything under `.port-anything/`.
- Never add `--no-sandbox` without the user's explicit agreement; a report of an unsandboxed run
  says so.
- Don't publish the report, the badge or the summary anywhere (a PR comment, a README, a post)
  unless the user asks.
