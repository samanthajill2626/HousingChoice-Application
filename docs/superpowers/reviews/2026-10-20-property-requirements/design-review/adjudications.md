# Spec design review - adjudications

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`.
Reviewer reports: `R1-reviewer-a.md` (A1-A17), `R1-reviewer-b.md` (B1-B18).
Severity labels are the reviewers'. "Decision changed" is the planner's call:
did the ruling change what gets built, add or remove a surface, or move an
invariant.

## Round 1 (spec revision 1 -> revision 2)

| Finding | Ruling | What changed in revision 2 | Decision changed |
|---|---|---|---|
| A1 / B1 [HIGH] string sets serialize to `{}`; empty set illegal; ADD/DELETE overlap | ACCEPT | D5: one plain map `requirement_sources: { item: 'copied' \| 'set_here' }`, written whole with the item keys, REMOVEd when empty; tests assert it on the HTTP response | yes (storage shape) |
| A2 / B5 [HIGH/MED] create form omits blanks, so a cleared prefill is never touched | ACCEPT | D5: create classifies ALL twelve items (absent = blank). D7: Save held while the landlord's record loads or after it fails (B5's second half) | yes |
| A3 / B2 [MED] landlord changes via restore and roster claim keep stale sources | ACCEPT | D5: every writer of `landlordId` (PATCH, `restoreWithLandlord`, `addContact` claim) REMOVEs the map; importer fill explicitly accepted with reasoning; D6: page re-reads the landlord on a `landlordId` change | yes (two more surfaces) |
| A4 [MED] legacy `pets` boolean ties the two pets items | ACCEPT (option b) | D1: any write touching either pets item writes both keys in the new shape, preserving the other item's interpreted value; text "No pets" is not parsed (expected set-on-this-property result stated); the stale-bundle reason corrected (raw API callers only) | yes |
| A5 / B4 [MED] hidden fixed deposit under One month's rent | ACCEPT | D1: One month's rent and a fixed amount are alternatives; 400 `deposit_conflict`; forms clear the amount | yes |
| A6 / B8 [MED] whole-map replace on every landlord save | ACCEPT | D2: landlord stores flat `req_` keys, PATCHed one by one by the existing dirty-tracked form; audit lists changed `req_` keys | yes (storage shape) |
| A7 / B3 [MED] Activity projection drops `reason` | ACCEPT | D13 + section 7: lift `reason` for `unit_updated` only when exactly `requirements_applied`; test that `listing_status_changed` reason stays unserved | yes (one more surface) |
| A8 / B6 [MED] "same allowlist" tag claim has no mechanism; voucher sizes would mislabel | ACCEPT | New D10a: explicit field -> tag table including derived publications; app test walks it against `toUnitFlyer`; dashboard parity; Goal 6 reworded to the test | yes |
| A9 / B14 [LOW] "recordable as No" contradicts D1; same-day RTA | ACCEPT | D1 scopes the true/REMOVE rule to requirement checkboxes and says No = not recorded on purpose; D10: same-day RTA keeps its kind and Yes/No/- display | no (precision) |
| A10 / B12 [LOW] normalizer also widens stored 5..12; 4+ issue not closed | ACCEPT | Section 4 states both; section 7 closes `broadcast-4plus-exact-match-underreach` | no (precision) |
| A11 / B17 / B11 [LOW] reads and races unnamed; PATCH landlord change + items undefined; one conditional write cannot tell skip reasons | ACCEPT | D5 names the PATCH reads (consistent) and accepts the race explicitly; combined case = reset then classify against the new landlord. D8: per-unit consistent pre-read gives skip reasons and changed keys; condition failure after the read = `changed_during_apply`; no-change units are `already_matches` and not written | no (precision; mechanism made explicit) |
| A12 / B10 [LOW] item ids and `expected` shape undefined | ACCEPT | D1 adds an item-id column; D8 defines `expected` as `{ item: { key: value \| null } }` covering exactly the listed items | no (precision) |
| A13 / B7 [LOW/MED] Select all undercuts Goal 3; rows all-or-nothing | ACCEPT in part | Select all REMOVED (it was a planner addition, not Cameron's). Rows mark each own-value item; section 4 describes the first-Apply workflow (uncheck items on the left). Goal 3 reworded to what the mechanism delivers. Per-row per-item control REJECTED: Cameron chose dialog B over the grid (C), which was exactly that control; added to non-goals | yes (Select all removed) |
| A14 [LOW] landlord page not told to reload units after Apply | ACCEPT | D8: page refetches its properties; section 7 lists `useContactFile.ts` | no (precision) |
| A15 / B18 [LOW] stored sizes the new rule rejects | ACCEPT | D4: off-chip stored values listed as "Not a valid size, removed when you save" | no (precision) |
| A16 [LOW] property managers are landlord-typed | ACCEPT | D2: any landlord-typed contact holds requirements; properties copy only from the landlord of record; non-goal reworded | no (wording) |
| A17 / B15 [LOW] GLOSSARY and diagram drift; UnitCreateForm description wrong | ACCEPT | Section 2 corrected; D1 states the qualifications reversal; section 7 docs list adds GLOSSARY `:176-187` and the sequence diagram | no (docs) |
| B9 [LOW] in-memory units fake not listed | ACCEPT | Section 7 lists `twilioWebhookHarness.ts:2857-2925` | no (precision) |
| B13 [LOW] stale-bundle policy applied to one field only | ACCEPT | D11: one policy - keep every existing key the projection can fill, only ADD keys; old flyer pages render imperfectly until reload, accepted. D12: wire returns `bedroomSizes` plus `bedroomSize` (first) for open older dashboards | no (precision) |
| B16 [LOW] `pets` kind stated three ways; "flexible" copy differs | ACCEPT in part | D1/D2: boolean accepted on the UNIT write only, never `req_pets`. Copy difference REJECTED as a change: both texts are approved - the form keeps Sam's label "Flexible / payment terms available" (tracker #12, Sep 30), the flyer uses the tenant-facing "flexible / payment plan available" Cameron approved on 2026-10-20; D11 now says the difference is deliberate | no |

Round 1 changed decisions (storage shapes, create classification, the
landlord-change surfaces, the deposit rule, the tag mechanism, Select all),
so round 2 runs. Reviewer A landed slightly more unique accepted findings
(A4, A6 framing, A13 scope, A14, A16) and continues; it gets B's report.

Rejections in round 1 (for the human spec gate):

1. Per-property, per-item choices in Apply (B7 second half): rejected -
   Cameron picked dialog B over the grid C, which was that control; the
   left-column unchecking covers the first-Apply case.
2. Making the form and flyer "flexible" copy identical (B16 second half):
   rejected - both texts were separately approved (Sam's form label; the
   flyer wording Cameron approved).
