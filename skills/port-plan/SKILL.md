---
name: port-plan
description: Plan a port (a rewrite of a command-line program in another language) with Port Anything before writing it - refine the CLI spec and its feature tags, produce a port order from the cases (core parsing, then output formatting, then features by how often they occur), and scaffold the candidate project wired into port-anything.yaml. Use for "plan the port of X to Rust", "set up the port", "what order should I port these flags in", "scaffold the candidate", or before running port-loop on a new port.
---

# port-plan: plan a port before writing it

You prepare a port of a command-line program (the **reference**) so the work can go cluster by
cluster afterwards (the `port-loop` skill). Three outputs: a refined **CLI spec** with good
feature tags, a **port order**, and a **candidate project** that builds and is wired into the
Port Anything config. You don't port features here; the scaffold only has to build and run.

The CLI is `port-anything` if it is on `PATH`, otherwise `npx port-anything` (Node 22.15+). Its
commands refuse to run cases without a sandbox; don't add `--no-sandbox` on your own, tell the
user what the refusal says.

## 1. The project

1. **Config.** If the directory has no `port-anything.yaml`, create the project:

   ```sh
   port-anything init . --ref ./path/to/original
   ```

   The reference command is a path plus any leading arguments. If the reference is built from
   source, add its build command as `reference.build` in `port-anything.yaml`, and build it.
2. **Spec.** If there is no `port-anything/cli-spec.yaml`, infer one from the reference's help:

   ```sh
   port-anything spec infer
   ```

   It reads `--help` (or `-h`, or the usage line the program prints with no arguments, and each subcommand's `--help`), writes the spec and checks it with a few probe
   invocations. Exit `0` every probe passes, `1` one failed (the spec is written anyway, fix it
   in step 2), `3` nothing could be inferred, or a spec already exists (it may hold refinements:
   it is never overwritten).

## 2. Refine the CLI spec

The generator makes its cases from the spec, and the scores are per feature tag, so the spec
decides what gets tested and how the results read. A help text never tells the whole story.
Compare the spec with the reference's man page, its documentation and its source when you have
them, and run the reference to settle doubts. Fix:

- **Missing flags** (undocumented in `--help` but real), and flags the parser misread.
- **Spellings:** every name of a flag in one entry (`names: [-n, --numeric-sort]`), not one
  entry per spelling.
- **Values:** `arity` (how many values the flag takes) equal to the number of `values`; each
  value's `type` (`string`, `int`, `size`, `path`, `enum` with its `choices`), and `optional:
  true` for a flag whose single value may be left out (`--color[=WHEN]`).
- **Forms:** one per usage line, with the flags it requires and its positional arguments (`arity`
  `1`, `?`, `*` or `+`).
- **Subcommands**, each with its own flags, forms and feature tag.
- **Feature tags:** each tag is one behavior to port and to score; they must be unique. Keep the
  generated `opt.<flag>` tags unless two flags are one behavior (aliases share one entry and one
  tag). Mark `--help`, `--version` and the like `self_description: true`: they are scored apart,
  since help text may differ.

Then regenerate the cases from the refined spec. It validates the spec first (exit `3` lists
every problem by its key path), and records the generator and seed it used in
`port-anything.yaml` when the config has none, so every checkout regenerates the same cases:

```sh
port-anything generate
```

If it warns that features got no case, or that most of the reference's answers were its usage
text, the spec's forms or flag arities don't match the program (a usage line read as a positional,
a flag value left out): fix them and generate again.

Refine the spec **before** `port-anything baseline` freezes the corpus. After a baseline, a spec
change changes the cases, so `port-anything verify` fails until the corpus is frozen again: ask
the user first.

## 3. The port order

Order the work so each step builds on the previous one and the parity rises steadily:

1. **Core parsing:** argument parsing, usage errors, exit codes, error messages for missing
   files. Every case depends on it. In the scores: the usage-error and file-error cases, and the
   cases with unknown or invalid options.
2. **Output formatting:** the default behavior with no flags (the `base` feature): what is
   printed, in what layout, with what separators and final newline.
3. **Features by frequency in the recorded corpus,** most frequent first: what real use exercises
   most. Count the feature tags of the recorded cases (`port-anything/recorded/*.jsonl`, one case
   per line with a `features` list), for example:

   ```sh
   cat port-anything/recorded/*.jsonl | jq -r '.features[]?' | sort | uniq -c | sort -rn
   ```

   Without recorded cases, use the generated corpus: the per-feature case counts `baseline`
   prints (`froze … per feature: …`), or those of a run (`port-anything run --json`, each
   candidate's `score.features[].cases`, once a candidate exists). Adding recorded cases changes
   the generated ones (they are mutated too), so take the counts after the last change. Break ties by dependency (a flag that changes how others behave first) and by size.

Write the plan to `port-plan.md` in the project directory (or where the user asks): the
reference and its version, the spec's flags, forms and subcommands in short, the ordered list
(each step with its feature tags and case counts), and the spec changes you made and why.

## 4. Scaffold the candidate

1. Create the candidate project in its own directory, with the target language's standard layout
   and build (`cargo new --bin port`, `go mod init`, `npm init`…), unless the user already has
   one.
2. Give it an entry point that runs under the reference's program name, parses arguments the way
   the spec describes (unknown option: the reference's usage error and exit code) and does
   nothing else yet. No stub output copied from the reference.
3. Wire it into `port-anything.yaml`:

   ```yaml
   candidate:
     cmd: ./port/target/release/tool    # the built program, relative to the project directory
     build: cargo build --release --manifest-path port/Cargo.toml
   ```

4. Build it with that command and run the whole corpus once, for the starting point:

   ```sh
   port-anything run
   ```

   Exit `1` (divergences) is expected here. Add the starting parity to `port-plan.md`.

Then the port itself is the `port-loop` skill's job, one cluster at a time, in the plan's order.

## Rules

- Never change the reference or its source. The spec describes it; it doesn't fix it.
- Don't edit `.port-anything/` by hand, or the committed cases under `port-anything/recorded/`.
- A spec change after a baseline, a waiver or a normalizer needs the user's agreement and goes in
  its own commit with the reason.
- Never add `--no-sandbox` without the user's explicit agreement.
