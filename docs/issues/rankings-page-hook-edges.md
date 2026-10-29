---
id: rankings-page-hook-edges
title: The Rankings page can leave Rank on "Starting..." after a window toggle, its press marks can disagree with the job shown, and a late read can show an older generation's end
type: bug
severity: low
status: open
area: dashboard/rankings
created: 2026-10-29
updated: 2026-10-29
refs: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:382, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:211, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:200, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:397, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:406, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:152, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:160, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:225, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:262, app/src/services/ranking/readRanking.ts:357, app/src/services/ranking/readRanking.ts:365, app/src/services/ranking/job.ts:194, app/src/repos/rankingRunsRepo.ts:334
---

**Problem.** Three edges of the Settings > Rankings "Rank this anchor"
panel's data hook (`useAnchorRanking`, WP1 B2a spec D9, D12, D18), found by
the B2a code review round 2 (reviewer R2-dashboard, findings R2-dashboard-3
and R2-dashboard-8), each reproduced with a throwaway hook test. None
changes a stored score or the job; each leaves the panel's own copy wrong
until another change or a reload. All three were there before the review's
fix waves (R2-dashboard-3 behaves the same on the pre-fix hook).

1. **A window toggle away and back during a press leaves Rank on
   "Starting..."** (R2-dashboard-3, CONFIRMED). Press Rank on anchor K1 (its
   state slice gets `ranking: true`); toggle "Include tenants not heard
   from" (K2, whose read is slow); toggle back before K2's read lands. K1 is
   now a NEW request context, but the state update helper (`update`,
   useAnchorRanking.ts:211) reuses the held slice whenever its key string
   matches (the key is `kind:id:window`, :200), so the new context inherits
   `ranking: true`. The press then answers for the OLD context and is
   dropped (`if (currentRef.current !== cur) return;`, :382), so nothing
   clears the flag: the job itself runs and is followed, but Rank stays
   disabled reading "Starting..." (RankAnchorPanel.tsx:160) until another
   anchor or window change or a reload. The window checkbox is not disabled
   during a press (RankAnchorPanel.tsx:152); browser Back/Forward over the
   URL state does the same. A stale `rankError` or `joined` carries over the
   same way. Suggested: in that early return clear the flag on the matching
   slice only (`setSlice(prev => prev !== null && prev.key === cur.key ? {
   ...prev, ranking: false } : prev)`), or tag each slice with its context
   so a returning key starts blank. Test: hold the press, K1 -> K2 (read
   never answers) -> K1, resolve the press: `ranking` is false.

2. **The joined mark can outlive the job** (R2-dashboard-8 a, CONFIRMED).
   A press that joins a live job whose answer lands after the page already
   applied that SAME generation's finished view still sets `joined: true`
   (useAnchorRanking.ts:397), so the status reads "Done ... (joined the
   ranking already running)". Needs the job to finish between the claim and
   its 202. Suggested: set `joined` from a press only while the job shown is
   live.

3. **A stale job view can clear a 409 message while the new job runs**
   (R2-dashboard-8 b, CONFIRMED). A press refused 409 `ranking_running`
   marks the followed job live (:406) and asks for a job read; when that read
   is coalesced behind an OLDER job read (issued before the press), the older
   read's view of the PREVIOUS job's end satisfies "the job ended" and
   clears "A ranking is running for this record. Try again when it
   finishes." while the job the 409 named still runs. The trailing read then
   shows that job running, so the page is not wrong for long. Suggested: on
   a 409 remember the press's issue number and let only a view issued after
   it clear the error.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R2-dashboard.md (R2-dashboard-3, R2-dashboard-8) and R2-adjudications.md.

**Update (2026-10-29, WP1 B2a code review R3, finding R3-dashboard-3).** One
more edge, reproduced by the round 3 dashboard reviewer with a throwaway
hook test. Like the three above, it changes no stored score or job. The
hook's line numbers above were re-pointed after fix wave FW3 grew its
header comment; items 1 to 3 still hold at that code.

4. **A late job snapshot from another GENERATION can put the old
   generation's end on screen while a new one runs** (R3-dashboard-3,
   CONFIRMED, NOT A REGRESSION - the hook before the review's fix waves
   behaves the same). Fix wave FW2 orders the job views of ONE generation by
   progress; a view of another generation is still applied only if issued
   after every view applied (useAnchorRanking.ts:225-226), and the first read
   and Retry offer their job with the issue number they took when SENT
   (:262), while the server's read gathers the pool and cards first and
   reads the job last (readRanking.ts:357, then :365). Both landing orders
   lose. (a) The first read (or Retry) R is out. A job read J, issued after
   R, is served at once with the previous generation's end (gen-1 done) and
   applied. Another actor - a second admin or tab pressing Rank, or the
   worker's takeover - creates gen-2 before R takes its job snapshot; R
   lands with gen-2 and is dropped (issued before J). (b) R lands first with
   gen-2; J then lands with gen-1 done and is applied over it (issued after
   R). Either way the page shows gen-1 "Done", does not poll (the job shown
   is not live), counts gen-1's stale view as the job's end (one full read;
   the press marks clear when the page was following a job), and learns of
   gen-2 only from its next ranking.updated event. If those events are lost
   (the worker-to-app bridge is best-effort), it keeps the old Done line and
   a table read before gen-2's batches until a reload or a press. Needs a
   generation change inside the first read's gathering and a job read in
   that window; events normally correct it within a batch. Suggested: order
   views of different generations by the job record, not by issue order. A
   claim stamps `requestedAt` (job.ts:194), and a takeover keeps it and
   moves `startedAt` (rankingRunsRepo.ts:334), so a view of another
   generation is newer when its (requestedAt, startedAt) is later; keep
   issue order as the tie-break and for a null view (the hook test fixtures
   give every generation one requestedAt, so the tie-break is load-bearing
   there). Test: hold the first read; one event -> the job read answers
   gen-1 done; release the first read with gen-2 running -> the job shown is
   gen-2 and the poll keeps running. And order (b): the read with gen-2 lands
   first, the job read with gen-1 done second -> gen-2 stays and the poll
   keeps running.

Source (item 4): docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/
code-review/R3-dashboard.md (R3-dashboard-3) and R3-adjudications.md.
