---
id: rankings-page-hook-edges
title: The Rankings page can leave Rank on "Starting..." after a window toggle, and its press marks can disagree with the job shown
type: bug
severity: low
status: open
area: dashboard/rankings
created: 2026-10-29
refs: dashboard/src/routes/settings/rankings/useAnchorRanking.ts:363, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:197, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:186, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:371, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:380, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:152, dashboard/src/routes/settings/rankings/RankAnchorPanel.tsx:160
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
   useAnchorRanking.ts:197) reuses the held slice whenever its key string
   matches (the key is `kind:id:window`, :186), so the new context inherits
   `ranking: true`. The press then answers for the OLD context and is
   dropped (`if (currentRef.current !== cur) return;`, :363), so nothing
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
   (useAnchorRanking.ts:371), so the status reads "Done ... (joined the
   ranking already running)". Needs the job to finish between the claim and
   its 202. Suggested: set `joined` from a press only while the job shown is
   live.

3. **A stale job view can clear a 409 message while the new job runs**
   (R2-dashboard-8 b, CONFIRMED). A press refused 409 `ranking_running`
   marks the followed job live (:380) and asks for a job read; when that read
   is coalesced behind an OLDER job read (issued before the press), the older
   read's view of the PREVIOUS job's end satisfies "the job ended" and
   clears "A ranking is running for this record. Try again when it
   finishes." while the job the 409 named still runs. The trailing read then
   shows that job running, so the page is not wrong for long. Suggested: on
   a 409 remember the press's issue number and let only a view issued after
   it clear the error.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R2-dashboard.md (R2-dashboard-3, R2-dashboard-8) and R2-adjudications.md.
