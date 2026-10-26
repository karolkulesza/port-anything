---
'port-anything': patch
---

The flaky-reference cases a run leaves out are visible in its numbers: they count in each candidate's `raw.flaky_reference` and per feature (never scored), `report.json` lists them in a new top-level `flaky_reference`, the HTML report's integrity panel lists them, and the MCP `status` tool shows them next to the cases compared.
