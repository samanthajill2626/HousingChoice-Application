# R2 adjudications - feat/today-checklist (tracker #31)

Adjudicated by the build orchestrator, 2026-10-25, on `R2-review.md`
(fresh reviewer, HEAD b41088cd; HIGH 0, MEDIUM 0, LOW 2, INFO 1; nothing
loses, duplicates, strands or misdirects a send). R2 agreed with the R1
no-change rulings (R1A-3, R1A-4, R1A-6, R1SC-4) and with FW1-5; it found
FW1-3, FW1-4, FW1-5 and FW1-6 real, FW1-1 and FW1-2 real with gaps.

## Fix wave 2 (one child, fresh) - must-fix

- FW2-1 (R2-1, LOW, CONFIRMED; introduced by FW1-2). The identity de-dupe
  keeps the unread pass's row unconditionally, so the person's ONE Identify
  row can carry a blank `who` (an unnamed unknown contact whose newest
  thread is an email thread with no display name) or sort last (the unread
  pass could not read the owner) - spec 5.2 ("who + New unknown contact";
  "oldest first by the contact's created_at"). Accepted R2's challenge:
  MERGE, not skip. When the triage pass meets a contactId the unread pass
  emitted, keep the one row and fill what the triage pass knows better: the
  `who` when the kept row's is blank or its owner was unresolved
  (nameFromContact(contact), else the formatted contact phone), and the rank
  (createdAtRank(contact)) when the kept row's rank is +Infinity. Tests pin
  `who` AND order (R2's two probes), not only the keys.
- FW2-2 (R2-2, LOW, CONFIRMED; FW1-1 scope gap). Two more live-refetch
  transitions still drop per-viewer state: (a) a refetch where Tours to book
  or Quiet shares is unavailable collapses that section's "Show all"
  expansion when it comes back; (b) a 404 fallback refetch unmounts Quiet
  shares, which re-seeds (first property open) on the next server load.
  Accepted R2's challenge: spec 6.3 / 2.1 / PR34 hold for every live
  refetch, not only a failed request. Fix: keep the per-viewer state above
  the branches - either lift LimitedList's `expanded` (a controlled prop) and
  Quiet shares' `seeded` / `openByUnit` into an always-mounted parent, or
  keep the components mounted and render the unavailable copy (and, on the
  fallback, nothing) inside them. Visible behavior otherwise unchanged (the
  spec 2.5 unavailable copy, the spec 3.1 single fallback line). Tests: R2's
  three probes committed.
- FW2-3 (R2-3, INFO, CONFIRMED). The 404 fallback (buildToday.ts) still emits
  one Identify row per unknown_1to1 THREAD, so a contact with a phone thread
  and an email thread is listed twice under one React key. Effectively dead
  in prod (runs only on a 404 from an old server), but the fix is a few
  lines: one Identify row per contact (first thread in the fallback's own
  order wins; copy and unread rule unchanged, spec 3.1). Test: R2's probe.

## Not changed

- R2's handback note (spec 8's "appears in Tours to book live" rests on GSI
  propagation inside one ~300 ms debounce, which DynamoDB Local cannot show):
  goes to the handback beside PR90 / WI8.
- The perf terminal contract not listing the refresh note (R2 swept, not
  raised): the note only appears after a ready load, so it is never a
  page's first terminal. No change.
- Pre-existing, not raised by R2 and not this mission's: the phone de-dupe
  can suppress a DIFFERENT needs_review contact holding the same phone as an
  emitted thread. Handback note only.
