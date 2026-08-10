---
id: deleted-contact-resurfacing-e2e-401-flake
title: deleted-contact-resurfacing e2e spec flakes in full-suite runs (mid-spec 401s)
type: bug
severity: low
status: open
area: e2e
created: 2026-08-05
refs: e2e/tests/dashboard-next/deleted-contact-resurfacing.spec.ts:90
---

**Problem.** In a full-suite run (contact-rosters mission, S3 slice-end, 2026-08-05)
`deleted contact texts back: resurfaces with Deleted chip...` failed at the
inbox-row visibility assert (spec :90). The webserver log shows the browser's own
`GET /api/conversations` and `GET /api/inbox` returning **401** in the failure
window - the page lost its session mid-spec, so the inbox never rendered. The
spec passes solo (14.8s) and the immediate full-suite re-run was 204/204 green,
on the same commit. One sighting so far. Signature to recognize it by: the
failing assert is an inbox-row `toBeVisible` timeout AND the `[WebServer]` lines
in the same window show browser-agent 401s on `/api/*`.

**Suggested fix.** None yet - first find what invalidates the session (a
concurrent spec's reseed epoch? cookie clock?) if it recurs. Until then treat as
a known flake: re-run the file solo, then the full suite, before blaming a
change.
