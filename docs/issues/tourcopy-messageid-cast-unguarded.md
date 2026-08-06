---
id: tourcopy-messageid-cast-unguarded
title: composeTourReminderBody casts to MessageId, so a new ReminderKind without catalog twins fails OPEN at runtime
type: bug
severity: low
status: open
area: app/messages
created: 2026-08-06
refs: app/src/messages/tourCopy.ts, app/src/repos/tourRemindersRepo.ts, app/test/tourCopyCallSites.test.ts
---

**Problem.** `composeTourReminderBody` picks its catalog entry by building the
id from the rung kind and CASTING:

```ts
const id: MessageId = street.length > 0
  ? (`tour.${kind}` as MessageId)
  : (`tour.${kind}_no_address` as MessageId);
```

The cast silences the only check that would catch a missing entry. Add a member
to `ReminderKind` (`app/src/repos/tourRemindersRepo.ts`) without also adding its
`tour.<kind>` and `tour.<kind>_no_address` catalog entries and TypeScript is
happy; at runtime `MESSAGE_CATALOG[id]` is `undefined` and `resolveMessage`
throws a bare `TypeError` reading `.editable` of undefined.

**Why that is worse than an ordinary crash.** Every caller of this composer
contains exactly ONE error type - `UncomposableReminderError` - and rethrows
anything else, deliberately, so unknown bugs stay loud rather than silently
retiring rungs. A `TypeError` therefore escapes all six containment blocks:

- send paths: the throw reaches the per-row catch in `runDueTourReminders`, the
  row is never claimed, and `listDue` hands it back every 60 seconds forever -
  the perpetual "sending shortly" failure `claimSkip` exists to prevent;
- read paths: 500 on the tour reminders list, the contact timeline, and the
  group-thread scheduled bucket.

So the failure mode for "someone added a rung kind" is a poll loop plus three
broken endpoints, discovered in production rather than at compile time.

**Reachability.** Not reachable today - `ReminderKind` has been stable and all
five kinds have their entries. It is a TRAP FOR THE NEXT PERSON, not a live
defect, which is why severity is low. The trap is well-baited: adding a kind is
a natural, small-looking change, and nothing in the type system, the test suite,
or `app/test/tourCopyCallSites.test.ts` (which enforces "route through the
composer", not "the composer can resolve every kind") will object.

**Suggested fix.** A parity test is the cheap, durable option: iterate the
`ReminderKind` union and assert that every kind except `no_show_checkin` has
BOTH a `tour.<kind>` and a `tour.<kind>_no_address` entry in `MESSAGE_CATALOG`.
That converts the runtime crash into a red test the moment the union grows.

A stricter alternative is to drop the cast in favour of an explicit
`Record<ReminderKind, { withAddress: MessageId; withoutAddress: MessageId }>`
map, which makes the compiler enforce exhaustiveness directly. That is a larger
edit to code three review passes just verified; the parity test buys most of the
safety for a fraction of the churn.

**Provenance.** Found independently by both the planner's spec-conformance pass
(residual R2) and the plan-blind adversarial pass during the
feat/tour-reminder-details merge review, 2026-08-05/06. Deliberately not fixed
on that branch: it is a latent trap rather than a defect in the shipped change.
