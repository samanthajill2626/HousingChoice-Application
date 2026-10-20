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

## Round 2 (spec revision 2 -> revision 3)

Reviewer A continued (`R2-reviewer-a.md`, findings R2-1 to R2-12). It
confirmed the round-1 fixes A1-A9 and A11-A17 against the code and conceded
A10's second half and both round-1 rejections.

| Finding | Ruling | What changed in revision 3 | Decision changed |
|---|---|---|---|
| R2-1 [MED] Apply runs on hours-old page state; server never enforces Goal 3; 409 retry loops | ACCEPT | D8: the dialog re-reads the landlord and its properties on open and after a 409 (and says so); the request carries per-unit `ownItems`; the server skips `changed_since_opened` when a changing own value was not shown | yes (server enforcement) |
| R2-2 [MED] a hand-checked row keeps its check after gaining an own value | ACCEPT | D8: a hand-checked row resets to unchecked when it gains an own-value item; hand unchecks stay | yes |
| R2-3 [LOW] whole-map rewrite unfenced; stale PATCH can write a removed map back | ACCEPT | D5: PATCH writes the map conditioned on the `requirement_sources` and `landlordId` it read, retries up to 3 times (the `updateRosterIfCurrent` pattern), then 409 `property_changed`; Apply's write carries the same condition; the accepted residual race is stated precisely (landlord values only) | yes (mechanism) |
| R2-4 [LOW] create classifying all items marks API creates and stale-form fields as exceptions | ACCEPT | D5/D7: the form sends `requirements_snapshot`; with it, all items classify against the snapshot (a copy stays a copy even if the landlord changed meanwhile); without it, only body items classify and the rest stay never touched. D7's failed-load case now saves without a snapshot instead of blocking Save | yes |
| R2-5 [LOW] "Deposit notes" collides with `getByLabel('Notes')` | ACCEPT (selector fix) | D1 names the label "Deposit notes" (Sam's term, kept); section 7 switches `steps.ts:1515` and `listing-activity.spec.ts:293` to `{ exact: true }` | no |
| R2-6 [LOW] raw boolean `pets` write self-contradicts; server-changed item not classified | ACCEPT | D1 separates a WRITTEN boolean (means the read interpretation, both items change) from a STORED one met by a one-item write (partner keeps its value); D5 classifies every item whose stored keys the write actually changes, after normalization | no (precision) |
| R2-7 [LOW] deposit edges | ACCEPT | D1: conflict check on a consistent read; forms always send the amount as null with One month's rent. D8: 409 `deposit_conflict` when the landlord holds both. D11: wording for flexible alone; no row for notes alone | no (precision) |
| R2-8 [LOW] Apply write is a new repo method; cap has no dialog behavior | ACCEPT | D8 names `unitsRepo.applyRequirements`; cap 100 per request, the dialog batches; section 7 lists the method | no (precision) |
| R2-9 [LOW] day one: every property purple against empty landlords | ACCEPT | D6: when the landlord has no requirement recorded at all, no tags or landlord lines, only "<Landlord> has no requirements recorded yet." | yes (display rule) |
| R2-10 [LOW] Goal 6 overpromises landlord-form tags | ACCEPT | Goal 6 narrowed to property forms + the landlord's requirements; other landlord fields never reach a flyer | no (wording) |
| R2-11 [LOW] an open older composer narrows a multi-size draft | ACCEPT | D12 states and accepts it (until reload) | no |
| R2-12 [LOW] audit field list undefined for server-added keys | ACCEPT | D13: changed unit keys including server-changed partner keys; never `requirement_sources` | no (precision) |

Round 2 changed decisions (Apply server enforcement and re-read, hand-check
reset, the PATCH fence, the create snapshot, the day-one display rule), so
round 3 runs with the same reviewer. No rejections in round 2.

## Round 3 (spec revision 3 -> revision 4)

Reviewer A continued (`R3-reviewer-a.md`, R3-1 to R3-10): no BLOCKING, HIGH or
MEDIUM; every round-2 fix holds except R2-5 (incomplete) and R2-9 (partial).

| Finding | Ruling | What changed in revision 4 | Decision changed |
|---|---|---|---|
| R3-1 [LOW] a tag inside the `<label>` breaks exact label selectors | ACCEPT | D10: the tag stays out of the accessible name (outside the label text, `aria-describedby`) | no (precision) |
| R3-2 [LOW] D6 display vs D8 own values disagree for an all-blank landlord | ACCEPT | D6 defines OWN VALUE by the table, never by the display; D8 uses that definition; test added | no (precision) |
| R3-3 [LOW] Apply marks unchanged listed items `copied`, relabeling an exception | ACCEPT | D5/D8: only items whose keys the Apply wrote become `copied` | no (aligns with the D5 rule) |
| R3-4 [LOW] snapshot is an unchecked client claim; all-or-400 is brittle | ACCEPT in part | D5 states the snapshot is TRUSTED (staff tool, only the New form produces it, only with a `landlordId`); missing items fall back to the no-snapshot rule, missing keys count as blank, unknown items ignored. Verifying against the current landlord with a 409 REJECTED: it would undo R2-4's point (a field copied from the landlord stays a copy even when the landlord changed while the form was open) | no |
| R3-5 [LOW] no-snapshot rule contradicts the general rule for blank body values | ACCEPT | D5: without a snapshot, only items the create actually writes (non-blank) are classified | no (precision) |
| R3-6 [LOW] the landlord-wide "no requirements yet" rule only fixes day one and hides stale copies | ACCEPT | D6: per-item rule - a never-touched value against a BLANK landlord item shows no tag (still an own value for Apply); the landlord-wide suppression is removed, the note stays informational | yes (display rule) |
| R3-7 [LOW] hand-check reset rule worded two ways | ACCEPT | D8: resets only when an own-value item is ADDED | no (wording) |
| R3-8 [LOW] batching: mid-run 409 or failure undefined | ACCEPT | D8: stop, re-read, report "Updated N properties before this stopped" | no (precision) |
| R3-9 [LOW] `property_changed` copy discards typed edits | ACCEPT | D5: the form stays open, "Save again." | no (copy) |
| R3-10 [LOW] the null amount on every landlord save logs `req_deposit` | ACCEPT | D1: null only on the save that CHECKS One month's rent | no (precision) |

Round 3 changed one decision (the D6 per-item display rule), so round 4 -
the cap - runs. If round 4 changes a decision, the open findings go to
Cameron as a decision instead of a round 5.

Rejections in round 3: R3-4's verification half (see the table).

Rejections in round 1 (for the human spec gate):

1. Per-property, per-item choices in Apply (B7 second half): rejected -
   Cameron picked dialog B over the grid C, which was that control; the
   left-column unchecking covers the first-Apply case.
2. Making the form and flyer "flexible" copy identical (B16 second half):
   rejected - both texts were separately approved (Sam's form label; the
   flyer wording Cameron approved).
