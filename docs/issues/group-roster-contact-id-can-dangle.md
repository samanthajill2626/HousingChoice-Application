---
id: group-roster-contact-id-can-dangle
title: A group_text roster keeps a contactId that no longer exists, and nothing re-mints it
type: bug
severity: low
status: open
area: app
created: 2026-08-12
refs: app/src/routes/webhooks/twilio.ts:1186, app/src/services/groupMembers.ts
---

**Problem.** A `group_text` thread's `participants` roster is written ONCE, at
thread creation - `resolveGroupMembers` is called only inside the
`existing === undefined` branch (`twilio.ts:1186-1190`). Every later inbound on
that thread files without re-resolving members. So if a member's contact row
stops existing after the thread was created, the roster keeps pointing at a
contactId that resolves to nothing, and no code path repairs it.

Observed live on dev during the 2026-08-11 group-texting self-QA: a member's
contact was hard-deleted, and two subsequent group inbounds on the existing
thread filed normally while the roster's `contactId` stayed dangling. Nothing
errored and nothing re-minted the contact.

Reachability is LOW, which is why this is not blocking: the product soft-deletes
contacts rather than hard-deleting them, and the import's retract path is now
explicitly guarded against deleting a contact that carries the detection origin
marker or appears on any group_text roster. The realistic routes are an operator
acting directly on the table, or some future hard-delete path.

Impact when it does happen is degradation, not breakage - and notably LESS than
it would have been under the rejected design: because delivery and attribution
keys are PHONE-scoped (`phone#<E164>`, spec 15.6) rather than contactId-scoped,
message attribution and per-member delivery kept working correctly through the
whole episode. What degrades is anything that resolves a roster member's
contactId to a contact record - the member panel's contact link and the
suppression seam's contact-level read.

**Suggested fix.** Options, cheapest first:
1. Treat an unresolvable roster contactId as "no contact" at the read sites
   (member panel, suppression seam) so it degrades explicitly instead of
   silently. Probably sufficient given the reachability.
2. Re-resolve a roster member whose contact is missing on the next inbound.
   `contactIdForPhone` is deterministic, so a re-mint regenerates the SAME id and
   the roster stitches back together with no write to `participants` - confirmed
   live: deleting the contact and later re-minting it through a NEW thread
   produced the identical id and healed the reference. The cost is one point
   read per member per inbound, which is why it is not the default choice.

Do NOT rewrite `participants` to repair it - the roster is the thread's identity
input, and re-keying it is exactly what the single-conditional-claim rule exists
to prevent.
