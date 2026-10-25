---
'port-anything': patch
'@port-anything/core': patch
---

More flags count as self-description, scored apart from the headline like `--help` and `--version`: `--copyright`, `--license` and `--warranty` when they take no value, a flag whose description says it prints the copyright, license or warranty, and the option the help text was read with (a short-only `-h`).
