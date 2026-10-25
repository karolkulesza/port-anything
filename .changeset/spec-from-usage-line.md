---
'port-anything': patch
'@port-anything/core': patch
---

`compare` and `spec infer` read a program that has no help option: when `--help` and `-h` give nothing usable, they read the usage line the program prints when called with no arguments (onetrue-awk, BSD tools). A positional offered as an alternative to a flag (`[-f progfile | 'prog']`) is kept. When there is still nothing to read, the error says what to do instead, and the new docs page `docs/cli-spec.md` describes the CLI spec and the recorded cases' format.
