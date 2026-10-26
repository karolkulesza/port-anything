---
'port-anything': patch
---

`run` scores with the CLI spec: a feature marked `self_description: true` (a `-v` that prints a version banner) is reported apart and left out of the headline, in the run, `report.json` and the fresh holdout, whatever its name. A run of the whole corpus also lists the spec's features that no case exercised as untested.
