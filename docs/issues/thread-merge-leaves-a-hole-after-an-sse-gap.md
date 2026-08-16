---
id: thread-merge-leaves-a-hole-after-an-sse-gap
title: Merge-on-refetch leaves an invisible hole when more than one page lands between refetches
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-14
refs: dashboard/src/routes/shared/threadPaging.ts:4, dashboard/src/routes/conversation/useRelayThread.ts:279, dashboard/src/routes/conversation/useGroupThread.ts:197, dashboard/src/routes/contact/useContactTimeline.ts:410, docs/superpowers/specs/2026-08-13-thread-history-paging-design.md:110
---

**Problem.** The thread hooks MERGE each refetched newest page into what they
already hold rather than replacing it. That is deliberate and correct for the
case it was designed for: the newest page is "the newest N", so a window that
shifts forward would otherwise drop the entries that fell out of it, taking the
operator's paged-in history with them.

Merging keeps everything already seen. It does NOT fetch anything it has not
seen. So when MORE THAN ONE PAGE of new entries lands between two refetches, the
newest page no longer overlaps what is held, and the union is two disjoint
blocks with an unfetched hole between them:

```
held:     [ ... m40 m41 m42 ]                     (paged in earlier)
server:   [ ... m40 m41 m42 ][ m43 ... m140 ]     (98 new entries arrive)
newest50: [ m91 ... m140 ]
merged:   [ ... m40 m41 m42 ][ m91 ... m140 ]     <- m43..m90 silently missing
```

The hole is worse than the truncation this feature replaced, in one specific
way: truncation was VISIBLE (the thread just started 50 entries ago), while this
reads as a continuous transcript. Nothing in the UI marks the discontinuity, and
no later action fills it - `loadOlder` pages backwards from the OLDEST held
entry, so it walks away from the hole, not into it.

**Reachability.** Not by volume alone: every persisted message schedules a
300ms-debounced refetch, so a thread receiving 98 messages refetches many times
along the way. The realistic trigger is a GAP IN THE SSE STREAM - a backgrounded
tab whose timers are throttled, a laptop sleeping, a dropped connection - after
which the hooks resume with no replay and no resync. `useEventStream` delivers
live events only; nothing reconciles what was missed while disconnected. A
broadcast fan-out or a busy group thread during a disconnect is the shape that
gets there.

Found by the plan-blind adversarial reviewer at final review. The header comment
in `threadPaging.ts` asserted the opposite ("Merging by id cannot [leave a
hole]") - that claim was wrong and has been corrected in the same change that
filed this issue, along with spec section 4.1.

**Suggested fix.** Detect the discontinuity rather than trying to prevent it. The
newest page and the held set are both ordered, so the hooks can compare the
oldest id of the incoming page against the newest id held: if the incoming page's
oldest entry sorts ABOVE the newest held entry, the two do not overlap and there
is a gap. Options once detected, cheapest first:

1. Fall back to REPLACE for that refetch and reset the paging state (`hasOlder`
   true, bound re-seeded). The operator loses paged-in history - the old
   behavior - but the transcript is continuous and honest, and the control is
   there to page back.
2. Walk forward from the newest held entry until the pages meet. Correct and
   invisible, but the messages route only pages BACKWARDS (`before`); this needs
   an `after` bound added to `GET /api/conversations/:id/messages`, which is also
   the fix wanted by
   [`thread-hooks-refetch-whole-page-per-event`](thread-hooks-refetch-whole-page-per-event.md).
3. Render an explicit "N messages not loaded" separator at the seam and let the
   operator fill it on demand.

Option 1 is a contained frontend change and restores an honest transcript
immediately; option 2 is the real fix and shares its server work with the
delta-refetch issue above.

Related: [`thread-hooks-refetch-whole-page-per-event`](thread-hooks-refetch-whole-page-per-event.md)
(an `after` bound would serve both), and
[`contact-timeline-sse-refetch-unfiltered`](contact-timeline-sse-refetch-unfiltered.md).
