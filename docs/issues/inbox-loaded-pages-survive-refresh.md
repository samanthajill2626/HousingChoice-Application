---
id: inbox-loaded-pages-survive-refresh
title: Inbox rows loaded past page one are dropped by a refresh; the reviewed design to keep them is deferred
type: improvement
severity: low
status: deferred
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/inbox/useInbox.ts, docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md, docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/
---

**Problem.** After `feat/inbox-rows-timestamps` (Sam's improvements item #17)
the inbox page holds 100 rows, auto-loads the next page on scroll, and keeps
page one plus the scroll position across a live update and the back button.
Rows the operator loaded PAST page one are not kept: a complete refresh (any
inbox-affecting SSE event, Retry, or the reconcile that follows a return to
the page) replaces the list with a fresh page one, and the dropped rows reload
as she scrolls. If her scroll position was among the dropped rows the browser
clamps it to the new bottom and auto-load fetches the next page once. This
begins at row 101 at the default page size.

**The boundary-page reload cost (build review AD-15, 2026-09-25; corrected
at round 2, R2-7).** For a reader parked past page one, EVERY complete head
read (every inbox-affecting SSE event) drops the tail and the browser clamps
her scroll position to the bottom of page one: she is returned to about row
100 on every event, which is the visible cost spec section 8 states. Auto-load
then re-fetches the next page once (the sentinel is inside the 400px margin
and the head read moved the epoch), and that page appends BELOW her, so it
does not bring her back. Only a reader parked near row 100 sees nothing. Each
event costs two requests and up to 100 rows removed and re-added. A tiny
`?limit` re-chains the whole list on every event (the e2e spec pins this at
`limit=2`). Keeping the loaded pages is what removes it.

**Why it was deferred.** Keeping those rows correctly was designed across
four adversarial review rounds; the last reviewed text is DRAFT 6 of the spec
(commit `35843a25`, sections 5.5, 5.6 and 5.8; adjudications under
`docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/`). Round 4 found
defects in DRAFT 5's re-walk that DRAFT 6 fixed, and DRAFT 6's fixes were
never re-reviewed before the design was dropped, so a builder starts from
DRAFT 6 and should expect one more review round. It needs:

- a head-plus-tail list model by PROVENANCE on the tabs whose page one is
  cut by `lastActivityAt` (All, Groups), with a boundary rule that keeps rows
  that slid out of page one and drops rows a complete head read no longer
  returns, and special handling for the All tab's additive relay/group rows;
- a replace-on-complete-head model on Unread and Unknown, whose page one is
  cut by a different key (the newest unread thread; the triage queue order),
  so no "slid out" inference is sound there;
- a RE-WALK of the loaded pages on every return to the page (one read per
  `limit` rows of tail, capped), bounded by the triggering head's boundary,
  so a row the operator just triaged, renamed or deleted on its contact page
  is not shown stale; and its interleavings with auto-load, a meanwhile head
  read, and a page failure;
- a residue even then: a loaded row does not reflect a non-activity change
  made elsewhere (another operator's read, a rename in another tab) while
  the operator stays on the page.

That was about half the mission's build hours for a case that starts at
row 101, so Cameron chose "page one persists" (Option B) at the spec gate on
2026-09-25.

**Reopen when** a second operator works the inbox concurrently, or Sam
reports losing her place past the first 100 rows, or the page size is
lowered for latency reasons and the tail becomes the common case.

**Suggested fix.** Build DRAFT 6 sections 5.5, 5.6 (branch P) and 5.8 (the
re-walk) after one more review round of its round-4 fixes; the round-2
through round-4 adjudications list the interleavings the design must hold
and the tests that pin them.
