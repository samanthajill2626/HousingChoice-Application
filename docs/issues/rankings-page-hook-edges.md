---
id: rankings-page-hook-edges
title: The Rankings page can leave Rank on "Starting..." after a window toggle, its press marks can disagree with the job shown, a late read can show an older generation's end, and a new generation can leave the last one's final batches unread
type: bug
severity: low
status: open
area: dashboard/rankings
created: 2026-10-29
updated: 2026-10-29
refs: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:388, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:213, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:202, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:401, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:410, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:152, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:160, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:227, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:268, app/src/services/ranking/readRanking.ts:357, app/src/services/ranking/readRanking.ts:365, app/src/services/ranking/job.ts:194, app/src/repos/rankingRunsRepo.ts:334, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:239, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:245, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:184, app/src/services/ranking/job.ts:179, app/src/services/ranking/job.ts:211
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
   useAnchorRanking.ts:213) reuses the held slice whenever its key string
   matches (the key is `kind:id:window`, :202), so the new context inherits
   `ranking: true`. The press then answers for the OLD context and is
   dropped (`if (currentRef.current !== cur) return;`, :388), so nothing
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
   (useAnchorRanking.ts:401), so the status reads "Done ... (joined the
   ranking already running)". Needs the job to finish between the claim and
   its 202. Suggested: set `joined` from a press only while the job shown is
   live.

3. **A stale job view can clear a 409 message while the new job runs**
   (R2-dashboard-8 b, CONFIRMED). A press refused 409 `ranking_running`
   marks the followed job live (:410) and asks for a job read; when that read
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
   after every view applied (useAnchorRanking.ts:227-228), and the first read
   and Retry offer their job with the issue number they took when SENT
   (:268), while the server's read gathers the pool and cards first and
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

**Update (2026-10-29, WP1 B2a code review R4, findings R4-dashboard-2 and
R4-dashboard-3).** One more edge and a second path to item 3, each
reproduced by the round 4 dashboard reviewer with a throwaway hook test.
Like the four above, neither changes a stored score or job. The hook's line
numbers above were re-pointed again after fix wave FW4 (7fb7b723) grew two
comments. Items 1 to 4 still hold at that code: FW4 changed only how a
press's job of the generation on screen is ordered (it now goes through the
order rules instead of a gate), so item 2's join, behind the finished view
on screen, is dropped by the order rules and still sets the joined mark.

5. **A followed job replaced on screen by a new generation that is still
   queued or running is never counted as ended: its last batches are not
   read, and the joined mark moves to the new job** (R4-dashboard-2,
   CONFIRMED, NOT A REGRESSION - the hook before the review's fix waves
   behaves the same). The page follows gen-1 (live on screen). gen-1
   finishes its last batch or batches and ends, and before the page's next
   job read is served another actor's press claims gen-2 (a press can claim
   only once gen-1 has ended: job.ts:178-185, :211-223). That read shows
   gen-2 queued. A view of another generation counts its finished batches
   from zero (none here, so nothing grew) and counts as an end only when it
   is not live (useAnchorRanking.ts:235-239); the press marks clear only on
   a view that is not live (:245). So nothing reads the full ranking for
   gen-1's tail, and a joined mark from this page's press on gen-1 (:401)
   stays under gen-2: "Waiting for a free slot (joined the ranking already
   running)" (RankAnchorPanel.tsx:183-184). The table catches up at gen-2's
   first finished batch or at its end (a queued gen-2 waits while every
   slot is busy, up to RANKING_QUEUE_EXPIRY_MS, after which its `expired`
   view ends it and reads); the joined mark clears when gen-2 ends. A
   worker takeover (a new generation replacing a live one) takes the same
   path; nothing of the old generation is unread there, only the mark
   carries. The window is the event's read latency after gen-1 ends while
   events arrive, or one 5 s poll interval while they do not (two admins,
   or two tabs, on one anchor). It is item 4's class (a table older than
   the job shown) by another path. Suggested (the reviewer's fix, verified
   on a scratch copy of the hook: its probe green and the rankings
   directory green, alone and together with FW4-1's change): count a live
   view on screen replaced by another generation as the followed job's end,
   for the read and for the marks - `const leftLive = newGeneration &&
   shown !== null && isJobLive(shown.status);`, then `ended = leftLive ||
   (...as now...)` and `followedEnded = leftLive || (...as now...)`. Keyed
   on the view on screen, not on `wasLive`, so a 409's forced follow keeps
   its copy when the job the 409 named first appears (the hook test "a
   press refused 409 ranking_running says so and follows the running job"
   stays green). Test: a press joins gen-1 running 1 of 2 (one full read
   for the finished batch); one event whose job read answers gen-2 queued
   -> one more full read, and `joined` is false. Re-checked at 7fb7b723
   with the same probe (a throwaway, deleted): the full-read count stays at
   2 and `joined` stays true, so the edge still holds after FW4.

Item 3 has a second path (R4-dashboard-3, CONFIRMED, INFO, NOT A
REGRESSION - the hook after fix wave FW1 behaves the same). The first read
(or Retry) R is out; the admin presses Rank (Rank is enabled while the
first read loads) and the press is refused 409 because a live job of the
other window exists; the 409 marks the page as following (:410). R took
its job snapshot before that job was claimed and lands after the 409 with
the previous generation's end. It is the first job view, so it is applied,
and because the 409 forced the follow it counts as the followed job's end
(:245) and clears "A ranking is running for this record. Try again when it
finishes." The follow-up job read then shows the named job running,
without the copy. The status line shows that job running and Rank is
disabled, so the lost copy says nothing the page does not. Item 3's
suggested fix covers this path too (remember the 409 press's issue number;
only a view issued after it clears the copy), since R was issued before
the press. Test: hold the first read and the follow-up job read; the 409;
release R with gen-1 done, then the job read with gen-2 running -> the 409
copy stays through both.

Source (item 5 and item 3's second path): docs/superpowers/reviews/
2026-10-28-wp1-b2-ranking-engine/code-review/R4-dashboard.md
(R4-dashboard-2, R4-dashboard-3) and R4-adjudications.md.
