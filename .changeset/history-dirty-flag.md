---
'port-anything': patch
'@port-anything/core': patch
---

A run of a candidate whose git tree has uncommitted changes is no longer passed off as its commit: the history line records `dirty: true` next to the commit (`false` on a clean tree; new files git doesn't ignore count, while git-ignored build outputs and the project's own port-anything files don't), `run` says the run is recorded as dirty, and the port-report skill names those changes in its summary. Older history lines, without the field, still read.
