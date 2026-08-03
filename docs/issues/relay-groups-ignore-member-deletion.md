---
id: relay-groups-ignore-member-deletion
title: Deleting a contact does nothing to their relay-group membership - sends and receives continue
type: decision
severity: med
status: open
area: app
created: 2026-08-03
refs: app/src/routes/webhooks/twilio.ts:525, app/src/routes/api.ts:1388, app/src/routes/today.ts:549
---

**Problem.** Soft-deleting a contact (`deleted_at`) hides them from the inbox,
Today, and broadcast targeting - but relay groups are untouched. Verified
2026-08-03: contact `isDeleted` is consulted ONLY in inbox.ts, today.ts, and the
broadcast-targeting repo filter. No relay path checks it. Concretely, for a
deleted contact who is a member of an open relay group:

- Outbound: team sends, announcements, and other members' relayed texts still
  fan out to the deleted member's phone. They keep receiving everything.
- Inbound: their texts into the group still relay to the other members and
  still appear in the group thread (relay rows are conversation-keyed, not
  contact-keyed, so nothing hides them).

Deletion reads as "we are done with this person," so both directions are
probably surprising to staff. Contrast: per-member OPT-OUT already has
first-class suppression machinery (`relay_opted_out_members` + a Today
needs_you_now item per still-opted-out member) - deletion has no analog.

**Open questions (why type: decision).** What SHOULD deletion mean for group
membership? Options include: (a) deletion auto-removes/suppresses the member
from open relay groups (mirroring the opt-out machinery, possibly reversible on
restore); (b) deletion is refused / warns while the contact is in an open
group ("remove them from group chats first"); (c) status quo is intentional -
group comms are a shared space and deletion only affects 1:1 surfaces (then
document it). Interaction with the deleted-contact resurfacing feature
(specs/2026-08-03-deleted-contact-resurfacing-design.md) needs a look too:
should a deleted member's group inbound count as "they contacted us again"?
(Today it does not - resurfacing reads 1:1 threads only.)

**Suggested fix.** Review the actual mechanics (roster shape, fan-out sites,
close/retire flows) and pick a model before building. If (a), the opt-out
suppression pattern is the template to copy.
