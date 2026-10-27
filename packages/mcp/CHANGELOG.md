# @port-anything/mcp

## 0.1.2

### Patch Changes

- 9d92f4e: `run` keeps both sides of every divergence (the outputs after normalizers, as blob refs in the run), and shows what differs: `run --cluster <n>` prints a line diff of the cluster's first case (exit code, stdout, stderr, changed files), and the HTML report shows one under each cluster's repro (`diff` in `port-anything-report.json`). A full run says where to look. Before, only the MCP tools showed the diff, and a person had to re-run a repro to see what was wrong.
- 2407360: The MCP `next` tool re-runs each open cluster's repro before offering it, and skips a cluster whose repro no longer diverges (a fix for another cluster covered it, as a smoke run's `fixed` count may show) with a one-line note naming the skipped clusters. Before, it offered such a cluster with an empty diff and asked for a re-run. The `port-plan` and `port-report` skills now bring up `port-anything strength` and the mutation tool it needs (`cargo-mutants`, Stryker, `mull`), so corpus strength is planned for instead of found missing at the end.
- Updated dependencies [9d92f4e]
- Updated dependencies [d39874e]
- Updated dependencies [37124db]
- Updated dependencies [c5fdb6d]
- Updated dependencies [a8c8841]
- Updated dependencies [c764253]
  - @port-anything/core@0.1.2

## 0.1.1

### Patch Changes

- @port-anything/core@0.1.1

## 0.1.0

### Patch Changes

- @port-anything/core@0.1.0

## 0.0.1

No changes in this release.
