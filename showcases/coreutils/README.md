# coreutils matrix

GNU coreutils 9.12 (reference, built from source) vs uutils 0.12.0, uutils `main` @ 2fb77e8 (0.13.0), busybox 1.38.0 (`defconfig`) and toybox 0.8.15. Utilities picked because uutils has no fuzz target for them. `od`, `nl`, `comm` and `fmt` ship in at least three of the implementations; `join` and `numfmt` only in GNU and uutils (busybox's default configuration and toybox lack them), so for those two this is a pairwise comparison, kept because neither has a uutils fuzzer. 1000 generated cases per utility (seed 42; `numfmt` 922 after de-duplication), 30 s timeout per case.

| utility | uutils 0.12.0 | uutils main | busybox 1.38 | toybox 0.8.15 |
|---|---|---|---|---|
| od | 90.5% | 90.5% | 54.3% | 9.4% |
| nl | 81.3% | 81.3% | 48.5% | 14.3% |
| comm | 97.4% | 99.6% | 11.3% | 11.3% |
| fmt | 88.4% | 92.6% | — | 11.3% |
| join | 97.8% | 98.6% | — | — |
| numfmt | 99.9% | 99.9% | — | — |

Parity = mean per-feature match rate (exit status, stdout, stderr), truncated to one decimal as in `run.txt` and the report. "—": not built into that implementation's default configuration.

## What the divergences are

**New** (reproduced by hand, no matching issue found at the time; reported 2026-10-20):
- `numfmt` with the default delimiter keeps a tab between fields; GNU writes a space. `printf '1\t2\n' | numfmt` → GNU `1 2`, uutils `1<TAB>2`. Fixed upstream ([#15552](https://github.com/uutils/coreutils/issues/15552)).
- `fmt -p PREFIX` adds a newline to an unprefixed last line that has none (GNU copies it unchanged). `printf x | fmt -p '#'` → GNU `x`, uutils `x\n`. Fixed upstream ([#15553](https://github.com/uutils/coreutils/issues/15553)).
- `od -w1K` accepted (GNU rejects the suffix); `nl -l 18446744073709551616` rejected (GNU accepts). Fixed upstream ([#15551](https://github.com/uutils/coreutils/issues/15551)).
- busybox `od -c -x` (output types of different sizes) prints the zero padding of the last block as if it were input. Related code path: busybox bug 13246. Not reported (busybox takes reports on its mailing list).
- toybox `fmt`: `printf 'a\001b\n' | toybox fmt` writes `\e[7m\e[27m` before the word. `utf8len()` emits the reverse-video escapes even when it only measures. Reported as [landley/toybox#615](https://github.com/landley/toybox/issues/615); fixed in toybox's repository on 2026-10-22, not in a release yet (the GitHub issue is still open).

**Fixed upstream** (found by earlier runs of the same setup): uutils `numfmt` scientific notation in unselected fields (#15312), `od -B` (#15313), `od -S` past end of input (#15314).

**Already tracked** (not reported again):
- `od -w FILE` / `od --strings FILE` take the next word as the option value: uutils #10725.
- `od -f` float formatting: uutils #13608.
- `nl -v -1` / `-i -1` rejected: uutils PR #12459.
- `od` with a missing file drops the final offset line; `join` with a trailing blank adds an empty field (also under `-z`); `numfmt --from=a` (abbreviated values); `fmt` treats `\r`, `\v`, `\f` as blanks (a line holding only `\f` comes out empty): all in the flagdiff report, uutils #15254.
- `fmt -g` line breaking: uutils #5162.

**Not bugs:** `--version`/`--help` text and error-message wording (the bulk of the uutils stderr divergences); busybox and toybox `comm` don't check sort order (POSIX doesn't require it); busybox and toybox reject GNU long options and flags they don't implement (most of their low scores); toybox `fmt -w` accepts widths GNU rejects as out of range.

## Coverage gaps

The generator's cap on error-path cases left `join -a/-j/-o/-v/-1/-2` and `numfmt --to/--field/--format` without cases in this run. `csplit` and `pr` were left out: `csplit` needs pattern-aware operands, `pr` prints a date in its header.

## Reproduce

Each utility directory is a port-anything project. Inside a Linux container with the five implementations installed at the paths in `port-anything.yaml`: `port-anything baseline && port-anything run && port-anything report`. Versions, distro and kernel: [`versions.txt`](versions.txt).
