# R1 adjudications - feat/today-checklist (tracker #31)

Adjudicated by the build orchestrator, 2026-10-25, against HEAD c7705789
(gate battery run1 green there: typecheck 0; npm test 0 - app 533 files /
11389 passed 1 skipped, dashboard 268 / 5544, e2e workspace 22 / 509,
fake-twilio 34 / 275, fake-twilio-web 13 / 111, no [dynamoAdmin] line; smoke
0 - 1747 specifiers / 303 files; e2e 0 - 376 passed in 17.8m).

Inputs: `R1-spec-conformance.md` (R1SC-1..4: LOW 2, INFO 2; 174 CONFORMS,
6 PARTIAL, 0 MISSING) and `R1-adversarial.md` (plan-blind; R1A-1..6: LOW 4,
INFO 2). No HIGH or MEDIUM. Nothing loses, duplicates or strands a send.

## Fix wave 1 (one child, fresh) - must-fix

- FW1-1 (R1A-2 = R1SC-1, LOW, CONFIRMED by both reviewers independently).
  A failed live refetch flips useToday to status 'error'; Today.tsx unmounts
  every section; the next good load re-seeds Quiet shares (first property
  open), resets every Show all and closes the AI line. Violates spec 6.3
  ("kept by unitId across live refetches"), 2.1 and PR34. Fix: after a first
  successful load a refetch failure keeps status 'ready' and the last good
  data and sets a `refreshFailed` flag (cleared by the next good load); the
  page shows one role="alert" note above the sections and withholds "All
  caught up" while it is set (spec 2.3: an unknown state is not "done"); a
  FIRST-load failure keeps today's full-page error. Tests: both reviewers'
  probes as committed cases (quiet-share choices, a Show all expansion and
  the AI line survive a failed-then-successful refetch), the note and the
  withheld "All caught up", the first-load error unchanged.
- FW1-2 (R1A-1, LOW, CONFIRMED). One person twice in one list: (a) Identify -
  an unknown contact whose newest unread thread is an email thread (or who
  has only an email thread) is emitted by the unread pass AND by the triage
  pass, whose de-dupe is by phone only; (b) Needs you now - a member opted
  out of two open relay groups gets two identical rows. Both share one React
  key in LimitedList and inflate "Show all N". (b) is pre-existing on main
  (same row, same key) but the new 5-row list and its count make it visible.
  Fix: the triage pass also skips a contact the unread pass already emitted
  (by contactId), keeping the phone de-dupe (spec 5.2 intent: one row per
  person); the relay opt-out pass emits at most one row per member contactId.
  Tests: the reviewer's three probes as committed cases, plus the existing
  phone-newest pin unchanged.
- FW1-3 (R1SC-2, LOW). Spec 9 requires a no-stamp test for every no-stamp
  writer; four 7.3 rows have none: the reconcile's share (broadcast)
  adoption, a broadcast with no property, the Quo importer, the reseed (lean,
  full) and the performance seed. Behavior is already correct; add the pins
  (behavioral where an existing suite drives the writer).
- FW1-4 (R1SC-3, INFO). Three spec 6.1 drop-offs are not pinned on the Today
  route (unreachable, placed, no phone); the shared eligibility rule is.
  Add the three rows to the route's drop-off table.
- FW1-5 (R1A-5, INFO, PLAUSIBLE). Tours to book reads the tours byStatus GSI,
  so the one refetch a create's tour.updated triggers can miss the new
  request (or still list a just-booked one). This is the residue PR90 / WI8
  already accepts ("no mechanism is added"), but the today.ts comment names
  it only for Quiet shares. Fix: comment-only, at the Tours to book block.
- FW1-6 (R1A-4, R1A-6, R1A-3 - docs only).
  - RUNBOOK backfill entry, accepted differences: (a) on a shared or moved
    number the live W1 / W6 stamp the phone's current holder (findByPhone,
    spec 7.3 W1 "the judged recipient") while inbound attribution and the
    backfill take the thread's roster contact first, so the two halves of
    the quiet clock (and the backfill vs live) can name different contacts;
    (b) PR108's transition case: a failed Send-now row written before the
    deploy carries no system_copy, so a staff Retry of it after the deploy
    stamps live while the backfill excludes the same Retry by its Send-now
    body.
  - docs/issues/today-quiet-shares-read-cost.md: add the past-tours labeling
    cost (every Past row's tenant and property point-read per load; every
    tenant again per tour.updated, which every tour create now emits) - spec
    5.3 accepts it; record the scale.

## Adjudicated - no code change (rationale)

- R1A-3 code (past tours label every row): spec 5.3 requires it explicitly
  ("The section labels EVERY Past row ... so Show all N counts the rows
  Today actually qualifies") and records the reload cost; the cost goes to
  the issue (FW1-6). No lazy labeling: that would make "Show all N" count
  unqualified rows, against 5.3.
- R1A-4 code (attribute outbound by the roster rule): spec 7.3 binds W1 to
  "the judged recipient (heldRecipient ?? phoneContact)" and W6 to the
  contact resolveOutboundTarget finds (PR13); WORKLIST R-2 already records
  W6's first-match residue and WL-17 the backfill divergence. Changing the
  stamp target is a spec change; recorded (FW1-6) and listed in the handback
  for Cameron's eye.
- R1A-6 code: PR108 accepts the pre-deploy marker gap; recorded (FW1-6).
- R1SC-4 (PR58 "counts" on the two section-failure WARNs): the siblings PR58
  points at (today.ts contact / placement hydration WARNs) carry `err` plus
  an id, not a count, and a section-level throw has no count to report (the
  quiet-shares core throws before any count exists). Spec 2.5's "ids and
  counts only" is a PII ceiling, which both WARNs meet (no name; pinned by
  todayApi.test.ts). No change.
