---
'port-anything': patch
'@port-anything/core': patch
'@port-anything/report': patch
'@port-anything/mcp': patch
---

`run` keeps both sides of every divergence (the outputs after normalizers, as blob refs in the run), and shows what differs: `run --cluster <n>` prints a line diff of the cluster's first case (exit code, stdout, stderr, changed files), and the HTML report shows one under each cluster's repro (`diff` in `port-anything-report.json`). A full run says where to look. Before, only the MCP tools showed the diff, and a person had to re-run a repro to see what was wrong.
