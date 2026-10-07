---
id: org-settings-details-read-no-age-cap
title: Settings > Housing authorities & agencies - a details read that never settles blocks every later one, so the Not on the list table and the use counts stop refreshing
type: bug
severity: low
status: open
area: dashboard/settings
created: 2026-10-07
refs: dashboard/src/routes/settings/useOrgAdmin.ts:57-61, dashboard/src/routes/settings/useOrgAdmin.ts:66-69, dashboard/src/routes/settings/useOrgAdmin.ts:129-137
---

**Problem.** The Settings section reads its details - the use counts and the "Not on the
list" rows - one request pair at a time. A request made while one is in flight only marks
"read once more after it lands" (`dashboard/src/routes/settings/useOrgAdmin.ts:57-61`),
and the two reads have no timeout or age cap (`:66-69`). So a read that never settles (a
hung request - see [placement-detail-bundle-fetch-stall](./placement-detail-bundle-fetch-stall.md)
and the keep-alive notes in `dashboard/vite.config.ts`) blocks every later one, the
once-on-stop re-read after a rewrite included (`:129-137`). After an admin settles a
value, the rewrite runs and stops and the status line says done, but the table and the
counts never refresh until the page remounts: the settled row still offers Use / Clear,
and each later action's re-read queues behind the hung one. A stale page, not bad data -
the server refuses a settle that no longer applies. The same class as R2-FE-5, which fix
B14 closed for the list poll only. Code review R3-FE-4
(`docs/superpowers/reviews/2026-10-06-clean-org-names/code-review/R3-FE.md`; the mechanism
reproduced on the hook, the trigger plausible), ruled to file rather than fix
(`R3-adjudications.md` there). Filed during the clean-org-names build
(`feat/clean-org-names`).

**Suggested fix.** Give each details read an age cap, as B14 gave the list poll: abort
and restart a read older than about 10-15 s (for example
`AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])`), releasing the slot
so the queued request runs.
