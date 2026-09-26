---
id: runbook-inline-json-args-ps51
title: RUNBOOK group-credit scan recipe passes its JSON inline, which Windows PowerShell 5.1 breaks before aws.exe sees it
type: bug
severity: low
status: open
area: runbook
created: 2026-09-25
refs: RUNBOOK.md:1828, RUNBOOK.md:2352-2360
---

**Problem.** The group-credit reconciliation recipe at `RUNBOOK.md:1828` builds
its expression attribute values with `ConvertTo-Json -Compress` and passes the
result as a bare argument (`--expression-attribute-values $v`). Windows
PowerShell 5.1 re-quotes arguments on the way to a native `.exe` and strips the
double quotes, so `aws.exe` receives `{:xc:{S:groupxc#},...}` and rejects the
value. The RUNBOOK already documents this trap and its fix for `--parameters`
(the CloudWatch-agent note: build the JSON, write it BOM-free with
`[IO.File]::WriteAllText`, pass `file://<path>`), and the 2026-09-25
"One-to-one conversation automation switch" section uses that form. Found by the
share-skip-fix build research (ops F1); the operator machine runs PS 5.1 with no
`pwsh`.

**Suggested fix.** Rewrite the recipe in the temp-file form:
`[IO.File]::WriteAllText("$env:TEMP\group-credit-scan.json", $v)` then
`--expression-attribute-values "file://$env:TEMP\group-credit-scan.json"`.
Sweep the RUNBOOK for any other inline `ConvertTo-Json` argument at the same time.
