---
id: staff-thread-needs-triage-chip-all-unread
title: An internal staff member's 1:1 thread still carries the "Needs triage" chip on the All and Unread inbox tabs
type: bug
severity: low
status: open
area: app
created: 2026-09-02
refs: app/src/routes/inbox.ts, dashboard/src/routes/inbox/InboxRow.tsx, dashboard/src/api/types.ts, app/src/lib/unknownQueue.ts
---

**Problem.** Spun out of
[`inbox-filter-tabs-full-walk`](inbox-filter-tabs-full-walk.md) on 2026-09-02
when that issue was re-stamped resolved; this is the labelling half of a
ruling whose queue half is closed.

`roleFromContact` in `app/src/routes/inbox.ts` maps a contact's `type` to the
row's `role` and returns `'unknown'` for ANY type that is not `tenant`,
`landlord` or `partner` - so `team_member` (the internal-staff bucket:
`lib/seed/lean.ts`, "excluded from audience fan-out, no 1:1 lifecycle") falls
through. `buildContactRow` then sets `needsTriage: role === 'unknown'`, the
wire row ships `role: 'unknown', needsTriage: true`, and
`dashboard/src/routes/inbox/InboxRow.tsx` renders the amber "Needs triage"
chip on it. A colleague's 1:1 thread therefore looks like an unidentified
number on the All and Unread tabs.

The founder ruled 2026-08-25 that team members do not belong in a triage
queue. The Unknown TAB honours that by construction - it queries the contacts
`byTypeStatus` partition for `type='unknown'`, and `UNKNOWN_TAB_TYPE_DECISIONS`
in `app/src/lib/unknownQueue.ts` records the per-type ruling - so a
`team_member` can never appear THERE. But `roleFromContact` was deliberately
left untouched on that branch, because widening it is a WIRE change: the
`role` union reaches `dashboard/src/api/types.ts` and every tab renders it.
Only the queue half closed; the chip half is this issue.

**Live impact: none measured.** Zero `team_member` contacts with an open 1:1
thread in dev and prod on 2026-08-25 (`--audit-tab-vs-partition`). The
mechanism is live; the population is empty. That is why this is `low` and a
record-accuracy item rather than a defect an operator has seen.

**Suggested fix.** Two shapes, pick one and keep the other out:

1. **Narrow `needsTriage`** to `contact.type === 'unknown'` and leave `role`
   alone. Smallest change: the chip disappears from staff rows, the `role`
   union and every consumer of it are untouched, and `needsTriage` becomes the
   same predicate the Unknown tab's queue already uses. The `unknown` filter's
   own `roleFromContact(contact) !== 'unknown'` belt (a no-op by construction,
   see the comment above it) is unaffected.
2. **Widen `roleFromContact`** with a `'team_member'` (and, if wanted,
   explicit `'unknown'`) arm and extend the `role` union on the wire. Honest,
   but it is the blast-radius change the 2026-08-25 branch declined: every tab,
   `dashboard/src/api/types.ts`, the row chip styling, and any switch over
   `role` move with it.

Whichever shape lands, add a pin in `app/test/inboxFeed.test.ts` or
`app/test/inboxApi.test.ts`: a `team_member` contact's 1:1 row on `filter=all`
ships `needsTriage: false`. No such pin exists today, which is how the queue
half could close without the chip half.
