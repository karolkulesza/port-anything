# port-anything

## 0.1.0

### Minor Changes

- First feature release: audit a rewrite against the program it replaces.
  
  - `compare`: zero-config. Infers a CLI spec from `--help`, generates a corpus, baselines the reference and prints per-feature parity and a feature × candidate matrix for any number of candidates, with `--json` for scripts.
  - Generated cases: argv from the spec (forms, boundary values, pairwise flags, invalid calls) and byte mutation of seed inputs, de-duplicated by observation, with a budget and a minimum per feature.
  - Sandboxed runs (bubblewrap on Linux, `sandbox-exec` on macOS) with a pinned `argv[0]` and a fixed environment; candidate re-runs tell flaky from wrong, reference re-runs catch nondeterminism.
  - Divergences clustered by field, diff shape and feature, and delta-debugged to a minimal repro (`minimize`).
  - Score: mean of per-feature parity; under-sampled and self-description features (`--help`, `--version`) reported apart.
  - Projects: `init`, `spec infer`, `generate`, `baseline` (normalizer proposals), `run` (`--smoke`, `--cluster`, `--feature`), predicate waivers (`waive --from-cluster`), parity history.
  - `report`: a self-contained `port-anything-report.html` with a repro per cluster, `port-anything-report.json`, and a parity badge.
  - `port-audit` skill for coding agents; `port-anything --version`.
  
  Also included (preview; formats may still change): `compare --ref git:<rev>` (compare against another commit of the same program, as a refactor guard), the slowdown gate (`compare.max_slowdown`), `baseline`'s frozen manifest and `verify`, a fresh holdout on every full run with a significance-gated gap, `compare.min_parity`, sandbox mode `container`, `init --ci`, the `port-anything mcp` server, the `port-loop`, `port-plan` and `port-report` skills, `setup` for Claude Code, Codex, Cursor and Gemini CLI, the smoke `hook`, and `strength`.

## 0.0.1

### Patch Changes

- d3f4b0d: First release: `port-anything compare '<ref cmd>' '<candidate cmd>'…` compares a program with one or more ports with zero configuration. It infers a CLI spec from `--help`, generates 500 cases, runs the reference twice to find nondeterministic output, runs each candidate in a sandbox with no network, and prints a parity line per candidate and a feature × candidate matrix (`--json` for machines, `--save` to keep the setup as a project). Also included: `spec infer`, `baseline` and `run` for a saved project.
