---
'port-anything': patch
---

`run` and `baseline` warn about a feature tag in `port-anything/recorded/*.jsonl` that the CLI spec doesn't define, naming the file and line where it first appears, so a typo or a recorder bug isn't silently scored as a feature of its own.
