---
id: relay-stale-participant-phone
title: Group texts keep using the phone stored on the participant row after a contact's number is corrected
type: bug
severity: med
status: resolved
area: app
created: 2026-08-05
resolved: 2026-09-01
refs: app/src/repos/conversationsRepo.ts:104-109, app/src/lib/participantNames.ts
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

**Resolution (2026-09-01, feat/participant-snapshot-refresh).** Ruling
2026-08-31 (Cameron, spec decision 5): option (a) - documented behavior, no code
change. To correct a member's number, remove them and re-add them; the group
re-announces them, which is CORRECT, because their number really did change.
Option (b) stays rejected: a silent rewrite of the participant row would
recreate the phone-conflict class the W1 burn check exists to prevent.

The name-resolution work on this branch deliberately does not touch this.
`participants[].phone` is never rewritten by any name-resolution path -
`withLiveNames` (`app/src/lib/participantNames.ts`) replaces only `name` and
returns a bare-phone member unchanged - and roster sends still address
`participants[].phone`. Reopen only if the blessed remedy changes, not because
a name now resolves at read time.
