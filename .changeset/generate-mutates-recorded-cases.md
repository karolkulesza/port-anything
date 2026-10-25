---
'port-anything': patch
'@port-anything/core': patch
---

`generate` mutates the recorded cases (generator v2, the new default): one token at a time in an argument that holds a program or a query, and byte by byte in stdin and input files. A program whose input is code, such as awk, now gets a generated corpus, a fresh holdout and a gap test from its recorded cases; before, every case the CLI spec gave was a syntax error and the corpus stayed empty. Without recorded cases, v2 generates the same cases as v1, and a project pinned to `corpus.generator: v1` keeps its corpus.
