---
'port-anything': patch
'@port-anything/core': patch
---

The help parser reads the GNU two-column layout gawk uses (`-f progfile		--file=progfile`): the long spelling becomes an alias instead of a description, so features get their long names and `--help` and `--version` are reported apart. It also keeps every `Usage:` line, skips a `[POSIX or GNU style options]` group, reads `var=val` and `'program-text'` placeholders, lets a flag in a usage line take the value its option line gives it (`-f progfile` is no positional), and reads `a|b|c` as choices.
