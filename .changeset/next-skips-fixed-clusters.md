---
'port-anything': patch
'@port-anything/mcp': patch
---

The MCP `next` tool re-runs each open cluster's repro before offering it, and skips a cluster whose repro no longer diverges (a fix for another cluster covered it, as a smoke run's `fixed` count may show) with a one-line note naming the skipped clusters. Before, it offered such a cluster with an empty diff and asked for a re-run. The `port-plan` and `port-report` skills now bring up `port-anything strength` and the mutation tool it needs (`cargo-mutants`, Stryker, `mull`), so corpus strength is planned for instead of found missing at the end.
