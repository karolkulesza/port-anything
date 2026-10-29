---
'@port-anything/core': patch
'port-anything': patch
---

The help parser types more placeholders, so `compare` generates valid values for them instead of text that every call rejects: `[-]NUM` (head, tail), `LIST` (cut), `FIELD` and `FILENUM` (join) and `FIRST INCREMENT LAST` (seq) are numbers, and `INPUT [OUTPUT]` (uniq) are files. Before, most of those programs' flags got few or no cases (`cut` and `seq` got two). A line of a list in the help prose, such as cut's `-M  from first to M'th …` under `N-M`, is no longer read as a flag.
