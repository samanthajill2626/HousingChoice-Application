---
id: lean-seed-ha-staffer-should-be-partner
title: Lean seed's HA staffer Renee Carter is typed team_member but is a partner by definition
type: bug
severity: med
status: resolved
area: app/seed
created: 2026-08-17
resolved: 2026-08-24
refs: app/src/lib/seed/lean.ts, documentation/GLOSSARY.md
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** Retyped to `partner` as
the one deliberate change this issue asked for, now that the TYPES_FOR.all
widening is long merged.

Smaller than feared: the "pinned trio byte-identical" constraint turned out
not to pin her TYPE anywhere - seedData.test.ts, seedPersonaDrift.test.ts, the
fake-twilio persona registry and every e2e that names her reference her name,
phone, or persona id, never `team_member`. All 59 tests across the five
seed-pinning suites passed UNCHANGED through the retype - which is exactly how
the mistype survived two months, so seedData.test.ts now pins
`type === 'partner'` on her row with that story attached. Visibility fallout
across the nine partner surfaces is covered by the branch's full e2e gate.


**Problem.** CONFIRMED MISTYPE with a traceable cause (agreed with the human
2026-08-17). The lean seed's Renee Carter ("HCV Program Specialist",
`housingAuthority: 'atlanta_housing'`) is typed `team_member`. She is an
OUTSIDE agency contact, which the glossary defines as `partner`; `team_member`
is the internal-staff bucket - it has no 1:1 conversation type to propagate,
no lifecycle, and is deliberately excluded from the audience fan-out.

CAUSE: she was originally typed `housing_authority_staff`, not a valid
`ContactType` at all, which made her unreachable through every list and triage
surface. The 2026-06-18 extensible-contact-creation review triaged that to
`team_member` as the least-wrong bucket AVAILABLE AT THE TIME; `partner` did
not exist until 2026-07-21, and nobody revisited her.

WHY NOT FIXED IN THE contact-create-relay-group BRANCH: Renee is one of the
"pinned trio" the seed-data-clean-slate design declares untouchable and
byte-identical in the lean profile, with `app/test/seedData.test.ts`, the
fake-twilio persona registry (`seed-hastaff`), and e2e specs depending on her.
More importantly, that branch widened `TYPES_FOR.all` to include `partner`;
retyping her in the same change would have made her newly visible across nine
surfaces at the same moment the filter changed, so any red test could not be
attributed to one change or the other.

**Suggested fix.** Now that the widening is merged and proven against a world
with no partner contacts, retype Renee to `partner` as an unambiguous test of
one thing: update the pinned byte-stable expectations (`seedData.test.ts`),
the persona registry, and any e2e assertion that names her, in one deliberate
change.
