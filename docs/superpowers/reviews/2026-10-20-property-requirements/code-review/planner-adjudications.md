# Planner handback review - adjudications (property requirements)

Branch feat/property-requirements at 763314e5 (code = 1c6af57d; build handback
MERGE-READY @e59362bb). The planner's independent review after the build
orchestrator's three rounds:

- Planner gate run on 763314e5 (`.superpowers/gates/planner/summary.txt`):
  typecheck 0; npm test 0 (app 522 files 10891 passed + 1 skipped, dashboard
  263/5340, e2e 22/508, fake-twilio 34/275, fake-twilio-web 13/111;
  `[dynamoAdmin]` lines 0); smoke 0 (1717 specifiers / 300 files); e2e 0
  (367 passed, 21.2m); lint exit 1 on 5 errors in BroadcastComposer.tsx (2),
  useComposerDraft.ts (1), FlyerPage.tsx (2) - the same 5 errors, same rules
  and messages, when the same 3 files are linted at main @3df43172 (the merge
  base): branch-attributed 0.
- Two fresh opus reviewers, read-only, no suites run:
  `planner-conformance.md` (spec + work map only): 0 blocking, 0 high,
  1 medium, 9 low, 8 info. `planner-adversarial.md` (plan-blind: diff + repo +
  standing charter, nothing under docs/superpowers/): 0 blocking, 0 high,
  1 medium, 4 low, 5 info.
- The planner read the flyer projection (allowlist; no staff-only key, no
  subzone), the unit fence (OR-29), the Apply route and the Apply dialog
  model, and the self-QA screenshots.

## Rulings

| # | Finding | Sev | Ruling | Fix |
|---|---|---|---|---|
| PA-1 | Apply overwrites a property's OWN value that a colleague changed to a different own value after the dialog read it: the body names own items by id only, and planUnitApply skips changed_since_opened only when an item NEWLY became own. Spec goal 3 / D8: the server refuses to overwrite an own value the dialog did not show. Verified at app/src/lib/requirements.ts:455-462. | MEDIUM | ACCEPT - PR-1 below | FW5 |
| PC-1 | The landlord form shows "Tenants see this on the public flyer." under Pets (details) and Pet fee. D10 puts that line on the PROPERTY forms only; D9 words the landlord tags "On property flyers" because landlord values reach a flyer only through a property. | MEDIUM | ACCEPT - the note renders for the property audience only; the RequirementsFields test expectation follows the audience | FW5 |
| PA-2 | The landlord legend ("On property flyers - copied to this landlord's properties, where tenants see it on the public flyer.") reads as if saving the landlord updates existing properties (copy only: it does not). Builder copy, not spec copy. | LOW | ACCEPT the copy fix (PR-2); REJECT the suggested after-save nudge (new UI beyond the spec; the property page's "Landlord updated" tags and Apply are the designed path) - listed for Cameron | FW5 |
| PA-3 | The Apply dialog's opening landlord read and the New property form's locked landlord read use the eventually consistent GET /api/contacts/:id; a read inside the replication window right after a landlord save fills the New form (and its requirements_snapshot) with the OLD terms, and rolls the landlord card back. | LOW (PLAUSIBLE) | ACCEPT - PR-3 below (both reads become consistent; cheap, and D7 / D8 say "re-read") | FW5 |
| PA-4 | The public flyer prints a requirement amount with cents raw ("$1250.4", "$37.5"): the branch widened the money inputs to cents (PR2-3) and rewrote both flyer labels. | LOW | ACCEPT - PR-4 below (cents print as two decimals; whole amounts unchanged, so no existing flyer changes) | FW5 |
| PA-7 | A landlord change (or delete) landing between Apply's read and write reports "changed since you opened this" instead of "has a different landlord now" / "was deleted". | INFO | ACCEPT (cheap, same code as PA-1) - PR-5 below | FW5 |
| PC-17 | No test of the landlord form's One-month-rent save sending `req_deposit: null`. | INFO | ACCEPT - add the reviewer's proposed test | FW5 |
| PA-5 | Requirement text has no length cap (an item can grow toward DynamoDB's 400 KB). Pre-existing class (notes, staff_notes). | LOW (PLAUSIBLE) | DEFER - file `requirement-text-no-length-cap` (tier 2, improvement, low); a cap is new validation and new copy | FW5 (issue file only) |
| PC-2 | Flyer says "an" before 8 and 11. | LOW | NO CODE - Cameron's eye (grammatical; every D11 example reads as specified) | - |
| PC-3 | "Update 1 property" / "Updated 1 property" at N = 1. | LOW | NO CODE - Cameron's eye | - |
| PC-4 | The "Filled in from ..." note is hidden when the landlord has no requirements. | LOW | NO CODE - Cameron's eye (no fill happened, so the note would be untrue) | - |
| PC-5 | Try again after a failed landlord read fills only the items staff left blank. | LOW | NO CODE - Cameron's eye | - |
| PC-6 | D7 status lines can read "the landlord" while no name is known yet. | LOW | NO CODE - Cameron's eye | - |
| PC-7 | Apply keeps staff's choices across an in-dialog re-read; two notices beyond the spec. | LOW | NO CODE - Cameron's eye (already the handback's divergence 2) | - |
| PC-8 | A fenced PATCH that changes nothing writes no unit_updated row (plain path differs). | LOW | NO CODE - PR2-2 (plan review) decided it | - |
| PC-9 | A boolean `pets` beside any `no_pets` key is a 400. | LOW | NO CODE - raw API callers only; removes an ambiguous body | - |
| PC-10 | Fences stricter than D5 / D8 state (OR-29, OR-30). | LOW | NO CODE - Cameron's eye (handback divergence 1) | - |
| PC-11..PC-16 | Owning-landlord tag row; U+2014 blank marker and the always-shown voucher row; tour card empty state; non-integer legacy size dropped from the pre-fill; Apply body dedupe / ownItems required; scope additions (contact change closes every per-contact dialog). | INFO | NO CODE - listed for Cameron where visible (PC-12 voucher row, PC-13 copy, PC-16) | - |
| PC-18 | D6 tag lightness not pinned by a test. | INFO | NO CODE - the CSS meets it; noted | - |
| PA-6 | Legacy blasts stored with bedroomSize 5..12 read as 4+ (drafts reach wider - spec section 4; SENT shares are now summarized "4+ BR"). | INFO | NO CODE - Cameron's eye (history wording for any sent 5+ share) | - |
| PA-8 | Day-one purple tags with "Landlord: blank" on every legacy value. | INFO | NO CODE - Cameron's explicit call at the spec gate (O2, 2026-10-20) | - |
| PA-9 | Touring is operational (tour_type drives Interested auto-tours). | INFO | NO CODE - spec section 4 states it; a dialog note is Cameron's call | - |
| PA-10 | A contact retyped away from landlord keeps its req_ keys. | INFO | NO CODE - spec-bound residue (handback divergence 7) | - |

## Planner rulings for fix wave FW5

- PR-1 (PA-1): each `units[]` entry of the Apply body gains `seen`: an object
  keyed by EXACTLY the ids in that entry's `ownItems`, each value the item's
  unit value as the dialog read it (`unitItemValue` of the dialog's unit read;
  every key of the item, null = blank; validated like `expected`, 400 with a
  new E_ string on a mismatch). `planUnitApply` gains the seen values: a
  changing item that is an own value is written only when it is in
  `ownItems` AND the read's `unitItemValue` equals (itemValuesEqual) its
  `seen` value; otherwise the unit is skipped `changed_since_opened` (copy
  "changed since you opened this - review it again", unchanged). The dialog's
  `applyRequestBody` sends `seen` from the units it read. Tests: the
  reviewer's scenario (an own value changed to a different own value after
  the read -> skipped, nothing written), an unchanged own value still written,
  the 400 cases, and the dialog body. The dashboard wire type follows.
- PR-2 (PC-1 + PA-2): `RequirementsFields` renders the "Tenants see this on
  the public flyer." note for the property audience only. The landlord legend
  becomes exactly:
  `On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).`
  (ASCII; Cameron's eye). The property legend and tags are unchanged.
- PR-3 (PA-3): GET /api/contacts/:contactId accepts `?consistent=1`, which
  reads with `{ consistentRead: true }` (any other value or none: today's
  read). The dashboard's `getContact` gains an optional `consistent` flag; the
  Apply dialog's opening landlord read and the New property form's locked
  landlord read pass it. Route test (the flag reaches the repo) and one test
  per caller.
- PR-4 (PA-4): the flyer's deposit and application-fee amounts print through
  one formatter: a whole number exactly as today (`$1500`), any other amount
  with two decimals (`$1250.40`, `$37.50`). FlyerPage tests for both, and the
  existing integer cases unchanged.
- PR-5 (PA-7): on a lost Apply write condition the route re-reads the unit
  once (consistent) and runs planUnitApply on it; when that plan is a skip
  for `landlord_changed`, `deleted` or `not_found`, the skip reports that
  reason; anything else stays `changed_during_apply`. Route test on the
  harness for the landlord-changed race.
- PC-17: the reviewer's proposed ContactEditForm test.
- PA-5: file `docs/issues/requirement-text-no-length-cap.md` from
  `_TEMPLATE.md` (improvement, low, open) naming the 15 requirement text
  attributes, the 100 KB body limit and the 400 KB item limit.

After FW5: the planner re-runs all five gates on the final commit and
continues BOTH planner reviewers with the re-review charge on the FW5 diff.
