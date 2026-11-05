# jq matrix

jq 1.8.2 (reference) vs jaq 3.1.1 and gojq 0.12.19, upstream release binaries, Linux aarch64.

Seeds: the 550 cases in jq's `tests/jq.test` at the `jq-1.8.2` tag, imported as `jq -c FILTER` cases (`port-anything/recorded/jq-test.jsonl`, MIT/BSD-2-Clause like jq; see `COPYING.jq-tests`). Mutants: 3000 requested with a token mutator (seed 42; dictionary of 1032 filter tokens and 207 input tokens from the seeds, `jq --help` and the man page), 2920 distinct after de-duplication: 80% mutated filters, 20% mutated JSON inputs (`token-mutants.jsonl`).

Compared on exit status and stdout only (lenient profile): the three never share error wording.

| | jaq 3.1.1 | gojq 0.12.19 |
|---|---|---|
| **parity** (report headline: mean of the three rows below) | **72.1%** | **81.2%** |
| jq.test seeds | 367 of 550 (66.7%) | 449 of 550 (81.6%) |
| mutated filters | 1966 of 2340 (84.0%) | 2133 of 2340 (91.1%) |
| mutated inputs | 381 of 580 (65.6%) | 411 of 580 (70.8%) |
| all cases | 2714 of 3470 (78.2%) | 2993 of 3470 (86.2%) |

Percentages are truncated to one decimal, as in the report. Raw match rates, nothing waived: most divergences are documented, intentional differences (below). 3 cases where jq's result varied between baseline runs (timeouts under load, not jq nondeterminism) are left out; 4 cases per candidate gave a different result on a re-run (mostly timeouts or signals under load) and still count as divergences (about 0.1 points).

## Findings

**New** (reproduced by hand, no matching issue found at the time; reported 2026-10-20):
- jaq panics (exit 101) instead of reporting a syntax error when a filter ends inside a comment with a bracket open: `jaq -n '(#'`. Found only by mutation. Fixed upstream, released in jaq 3.1.2 ([#476](https://github.com/01mf02/jaq/issues/476)).
- jaq `from_entries` reads only `key`/`value`; entries using `name`, `Name`, `Key` or `Value` become a `null` key. Now documented as an incompatibility ([#478](https://github.com/01mf02/jaq/issues/478)).
- gojq `isnan` errors on non-numbers where jq returns `false`. gojq had chosen this on purpose and changed it to match jq ([#327](https://github.com/itchyny/gojq/issues/327)).

**Already documented** (reported, then found in jaq's README; not counted as new): jaq aborts with a stack overflow (exit 134) on deeply nested values: printing, `tojson`, JSON input and `fromjson` from a few thousand levels; jq and gojq print or stop with an error at 10000. jaq's README already listed this in its "Security" section ([#477](https://github.com/01mf02/jaq/issues/477)). Related: jaq #454, #467.

**Fixed upstream:** gojq `abs` on non-numbers (fixed on `main`, unreleased).

**Documented differences** (jaq's manual, gojq's README; not findings): error-message text inside `try … catch .`, gojq's sorted object keys, NaN/Infinity input, decNumber precision and `have_decnum`, features jaq doesn't have (`$__loc__`, `?//`, `INDEX`/`JOIN`, `builtins`, `modulemeta`, …), float indices and slices, updates past the end of arrays, jq's 10000-level depth limits, `"abc" * 1000000000`: jq stops with "Repeat string result too long", jaq builds the 3 GB string fine (`| length` answers at once) and times out printing it, jq's double arithmetic on large integers.

## Reproduce

Inside a Linux container with the three binaries at the paths in `port-anything.yaml`: `port-anything baseline && port-anything run && port-anything report`. Versions: [`versions.txt`](versions.txt).
