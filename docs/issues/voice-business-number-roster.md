---
id: voice-business-number-roster
title: Future main-business-number voice path must consult the THREAD roster (stale landlord-by-unit comment)
type: debt
severity: med
status: open
area: app
created: 2026-08-05
refs: app/src/routes/webhooks/voice.ts:388
---

**Problem.** The planned "main business number -> route the caller to the
landlord by unit" voice path (stale comment at voice.ts:388) predates the
contact-rosters feature. Masked calls on tour/placement numbers now dial the
THREAD roster verbatim (landlordVoiceOverride is retired); if the future
business-number path is built against unit/landlord lookups instead of the
thread roster, goal 4 of the rosters spec ("who is on the text is who the
call reaches") silently regresses for business-number calls - the call would
reach someone the roster removed, or miss someone it added. Filed per the
contact-rosters spec (section 12).

**Suggested fix.** When that path is built, resolve the callee through the
same shared roster resolver the masked-call path uses (resolveRoster /
describeRoster - plan or participants as appropriate), never through a
unit.landlordId shortcut. Update the voice.ts:388 comment now to point here
so the future implementer cannot miss it.
