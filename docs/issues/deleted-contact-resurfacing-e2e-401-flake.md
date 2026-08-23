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

**Measurement (2026-08-23, `fix/test-hardening-wave2`).** Did NOT reproduce.
Two full `npm run e2e` runs on the same commit: 251 passed / 2 failed (21.5m)
then 253 passed (19.0m). This spec passed in BOTH, as did every other issue on
the C6/C11 flake list. The two failures in run 1 were different specs, both new
and both filed separately.

Deliberately NOT closed on that. Two green runs cannot prove an intermittent
failure absent, and this issue's own history is of a spec that passes repeatedly
and then does not. Recorded so the next person has a dated data point rather
than a re-measurement to redo - and note the DynamoDB Local contention that
several of these were filed under has since been fixed, so a recurrence now
means something different than it did before.


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
