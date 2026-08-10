---
id: relay-stale-participant-phone
title: Group texts keep using the phone stored on the participant row after a contact's number is corrected
type: bug
severity: med
status: open
area: app
created: 2026-08-05
refs:
---

**Problem.** A relay group texts the number stored on the participant ROW,
not the contact's current phone - so correcting a contact's number after they
joined leaves the group texting the old number indefinitely. Pre-existing
behavior; the contact-rosters feature makes it VISIBLE (the card's fact-mode
deliverability rule flags the mismatch, and live remove deliberately follows
the stored row phone so removal still works) but does not fix it. Filed per
the contact-rosters spec (section 12).

**Suggested fix.** Decide the blessed remedy: (a) document call-through
remove + re-add as the operator fix (announces the member again - arguably
correct, the number changed), or (b) add a "refresh member phone" affordance
that rewrites the participant row silently (needs a burn/W1 check: the new
number may collide with another group on the same pool number). (b) without
the burn check would recreate the phone-conflict class W1 exists to prevent.
