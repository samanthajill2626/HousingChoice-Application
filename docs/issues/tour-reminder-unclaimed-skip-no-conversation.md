---
id: tour-reminder-unclaimed-skip-no-conversation
title: "Tour reminder rungs for tenants without a 1:1 conversation are skipped WITHOUT being claimed - due forever, panel says 'sending shortly' indefinitely"
type: bug
severity: medium
status: resolved
area: app
created: 2026-07-13
resolved: 2026-07-13
refs: app/src/jobs/tourReminders.ts:282, app/src/jobs/tourReminders.ts:240, app/src/jobs/tourReminders.ts:261
---

**Found (2026-07-13)** while reproducing a "Reminders panel doesn't update"
report on the local dev stack. The panel was fine (its dueAt-anchored poll from
c7c33a9 was firing every 20s, verified in the network log); the SERVER was the
stale side: the rung sat `upcoming` with `sentAt: null` for 8+ minutes past
dueAt.

**Root cause.** `processReminderRow` resolves the tenant's 1:1 conversation by
phone and, when none exists, logs `'tour reminder: no 1:1 conversation found -
skipping'` and RETURNS - without `claimSend`. The same applies to the earlier
guards (tour not found, contact not found, contact has no phone). An unclaimed
row stays in `listDue` forever:

- the worker re-lists and re-skips it EVERY 60s poll (warn-log spam, wasted
  reads),
- the Reminders panel truthfully renders `upcoming` -> the chip says "sending
  shortly" indefinitely (which presents exactly like a UI liveness bug),
- the reminder silently never delivers, and nothing surfaces the failure to
  staff.

Repro: create a tenant via the API (no conversation), tour it, wait past the
confirmation rung's dueAt. Once I created the 1:1 (fake-twilio inbound), the
next worker poll claimed + sent and the panel self-updated within its 20s
window - confirming both the panel fix and this gap.

**Contrast:** the stale-STAGE guard in placementNudges (and the unknown-kind
guard in this same file) claim-retire their rows so they never reappear. The
no-conversation guard predates that pattern.

**Decision needed (product-lite).** Two coherent fixes:
1. **Ensure the conversation** (preferred?): a known tenant with a phone can
   have a `tenant_1to1` conversation created on demand - broadcastFanOut
   already does exactly this for send recipients. The reminder then delivers.
2. **Claim-retire the row** (minimum): stamp the claim on the skip path(s) so
   the row leaves `listDue`, and surface a distinct state (or suppression
   reason) so the panel can say "Skipped - no conversation" instead of
   "sending shortly" forever.

Either way the panel's amber chip should never be a permanent lie. Not a
regression from c7c33a9 (the skip predates it); graduated to the registry
because it silently drops a tenant-facing communication.

**Resolution (2026-07-13) - option 2, Cameron's call.** All four undeliverable
guards (tour missing / contact missing / no phone / no 1:1 conversation) now
CLAIM-SKIP the row: `tourRemindersRepo.claimSkip(reminderId, now, reason)`
stamps `skippedAt` + `skipReason` under the same atomic condition claimSend
uses, listDue/claimSend/cancelForTour all treat skipped as terminal, and the
skip emits `scheduled.updated`. The reminders view surfaces `state: 'skipped'`
+ `skipReason`; the Reminders panel chip reads `Skipped - <reason>` (plain
hyphen, danger tone) and the contact timeline's upcoming bucket excludes
skipped rows. Live-verified on the dev stack: an open tour page flipped from
"sending shortly" to "Skipped - no conversation" with no reload, ~80s end to
end. Option 1 (create the 1:1 on demand so the reminder DELIVERS) remains a
possible future improvement; the visible skip makes the gap actionable by
staff in the meantime.
