# Planner conversation checklist - tracker #31 (handback review)

Built by the planner from the full conversation replay (every HUMAN entry,
2026-10-23 15:15 to 2026-10-25 14:00) and intent.md. The spec carries most of
these; the checklist exists for what the spec does not, and the reviewers
never see it. Evidence is filled in at the verdict.

| # | Item (date raised) | Source | Status | Evidence |
|---|---|---|---|---|
| C1 | Only must-do work on the page; every must-do queue present (10-23 15:34) | Cameron | delivered | section set per spec 2; SC table 131/134 CONFORMS; Tours to book added, Unreplied removed |
| C2 | Tours to book added (Needs booking was missing) (10-23 15:47) | Cameron agreed | delivered | today.ts tours_to_book (1a042159), live via tour.updated on both create paths |
| C3 | Unreplied removed; unmatched email stays off (badges) (10-23 15:47) | Cameron | delivered | 7913fc83 Unreplied removed; no unmatched-email row |
| C4 | "At a glance" minimal: AI suggestions one collapsed line, never the largest part (10-23 15:34) | Cameron | delivered | Today.tsx At a glance; AI line collapsed (aria-expanded), opens at 5 rows (FW3-2) |
| C5 | Tours today lives in At a glance, never counts toward All caught up (10-23 15:36/15:47) | Cameron | delivered | Tours today in At a glance; glanceEmpty never blocks allCaughtUp (Today.tsx ~529-539) |
| C6 | All caught up = everything except At a glance (10-23 15:36) | Cameron | delivered | allCaughtUp = queueEmpty && settled; At a glance excluded |
| C7 | Relay groups to close on Today (10-23 15:36) | Cameron | delivered | relayCloseNags section kept on the checklist |
| C8 | Identify these contacts as its own subsection (10-23 15:47) | Cameron | delivered | identify group (1c9b875b), own section, one row per contact (FW1-2, FW2-1) |
| C9 | No jump row of section links (10-23 16:06) | Cameron | delivered | no jump row (self-QA desktop pass) |
| C10 | Every section 5 rows + Show all; past tours oldest first (10-23 16:06/16:14) | Cameron | delivered | TodaySection 5 rows + Show all N; past tours oldest first (9d7abc56) |
| C11 | Rows, not chips or badges (10-23 16:06) | Cameron | delivered | rows only; no chips/badges (self-QA) |
| C12 | Quiet shares option C as mocked (10-24 01:33/01:43) | Sam via Cameron | delivered | QuietShares.tsx option C: property lines, longest wait first, first open, replied-then-quiet first (8d38b1a8) |
| C13 | No Interested / Not interested buttons on quiet-share rows; a row opens the contact (10-23 15:34) | Cameron lean, agreed | delivered | QuietShares.tsx:18-90 person row is a Link to /contacts/:id, no buttons |
| C14 | Everything on the Follow up tab can reach Today, not only tenants (10-23 15:34) | Cameron | delivered | Quiet shares reads the Follow up core (collectWaitingFollowUps), all contact types |
| C15 | The Follow up tab itself unchanged (10-23 15:34) | Cameron | delivered | Follow up tab output byte-identical (S4.1 pin; SC review) |
| C16 | Staff outbound never moves last_heard_from_at; new outbound-only field last_reached_out_at (10-23 15:34, 10-24 01:43) | Cameron | delivered | last_heard_from_at untouched by outbound; touchLastReachedOut is the only writer of the new field |
| C17 | Only staff-sent messages/calls count; automated never; a future agent sending as staff will count later (10-23 15:34) | Cameron | delivered | staffOutreach only on the staff send and Retry routes (api.ts); staffOutreach.ts header names the future agent rule |
| C18 | Calls count on any attempt; relay posts count for every member (10-24 01:43) | Cameron | delivered | W6 stamps on dial (post-response); W4/W5 stamp every member reached |
| C19 | Shares do not restart the clock; Identify = Unknown type only (10-24 02:04) | Cameron | delivered | shares never stamp (broadcast_id gate); identify = Unknown type, not Inactive |
| C20 | One-time backfill of last_reached_out_at (10-24 16:17); agents never run it on dev/prod | Cameron | delivered, OWED post-merge | backfill-last-reached-out.ts + RUNBOOK entry; rehearsed on a hermetic lane only; Cameron runs dev then prod |
| C21 | Section headings carry no count (10-24 18:48) | Cameron | delivered | bare headings; 2026-08-03 pins untouched (a62f7cfa) |
| C22 | Retry or Send now of anything automated from its first send never counts (10-24 18:48) | Cameron | delivered | system_copy marker: Send now, Retry, 30003 retry, reconcile adoption (api.ts ~1907-1920, retrySend.ts:567, sendReconcile.ts:947) |
| C23 | AUTO with 55-minute checkpoints; compaction before start (10-24 18:48) | Cameron | delivered | AUTO dispatch after compaction; 55-minute checkpoints |
| C24 | Resume after the weekly-limit stop (10-25 14:00) | Cameron | delivered | orchestrator resumed 14:00Z, tree intact |
| C25 | Planner promise: record the Oct 23 decisions and option C in tracker #31 at the end | Planner | pending | tracker #31 update - offered to Cameron at the verdict |
| C26 | Standing: full-width pages; ASCII; never touch the live stack; no infra | Memory | delivered | full width (no page max-width); ASCII checks; no live-stack or AWS access by agents; no infra |
