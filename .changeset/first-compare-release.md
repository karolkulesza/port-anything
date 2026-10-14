---
"port-anything": patch
---

First release: `port-anything compare '<ref cmd>' '<candidate cmd>'…` compares a program with one or more ports with zero configuration. It infers a CLI spec from `--help`, generates 500 cases, runs the reference twice to find nondeterministic output, runs each candidate in a sandbox with no network, and prints a parity line per candidate and a feature × candidate matrix (`--json` for machines, `--save` to keep the setup as a project). Also included: `spec infer`, `baseline` and `run` for a saved project.
