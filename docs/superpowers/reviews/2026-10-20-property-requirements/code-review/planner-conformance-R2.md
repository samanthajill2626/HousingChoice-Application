# Planner conformance review, round 2 - fix wave FW5 (feat/property-requirements)

Reviewer: the round-1 spec-conformance reviewer, continued (read-only; no
suite, vitest, npm script or e2e run - the gates are live in this worktree).
Material: `git diff 4a976cec..c1cc7e80` (60e64d66 PR-1, 5627a9d3 PR-2,
3c400035 PR-3, ca8f64d4 PR-4, 5360615f PR-5, dd6f5a8a issue file, c1cc7e80
report), judged against the spec (revision 6) and the exact strings of
`planner-adjudications.md`. Also read: `build/FW5-planner.md`. Not read: the
plan, any other review record, `.superpowers/`. Code cited by file:line at
c1cc7e80.

**Summary: 0 BLOCKING, 0 HIGH, 0 MEDIUM, 3 LOW, 4 INFO (7 findings).** Every
ruling landed as written. The landlord legend matches PR-2 character for
character in code, the unit test and the e2e (checked byte-wise, ASCII). The
three LOW findings are places where the code now differs from the approved
spec's TEXT because a ruling changed it (D8 twice, plus the D8 race
reason) - the spec was not amended, so Cameron should see them as
divergences. Nothing in FW5 crosses an out-of-scope line.

What did we all miss in round 1: my D8 verdict (PARTLY) never named PA-1 -
D8's own sentence "an exception set after the dialog loaded is never
overwritten unseen" was not met for an own value changed to a DIFFERENT own
value; the plan-blind reviewer caught it. PR-1 now meets that sentence. And
PC-17 was my error (see "Rulings contested", below).

## What FW5 changes against the spec, decision by decision

| Decision | Round-2 verdict | Evidence |
|---|---|---|
| D7 (New form's locked landlord read) | CONFORMS | consistent read UnitCreateForm.tsx:234; D7 asks only that the form "loads the contact itself" (see PC2-6 for the picker path) |
| D8 wire shape | DEVIATES - PC2-1 | `units[].seen` required: contactRequirementsApply.ts:48-49, 146-158; dashboard/src/api/types.ts:2696-2703 |
| D8 skip rule (changed_since_opened) | DEVIATES from the text, CONFORMS to its intent - PC2-2 | app/src/lib/requirements.ts:466-472 |
| D8 race reason (changed_during_apply) | DEVIATES - PC2-3 | contactRequirementsApply.ts:165-194, 263 |
| D8 dialog re-read | CONFORMS (see PC2-4, PC2-6) | ApplyRequirementsDialog.tsx:166 |
| D9 landlord fieldset | CONFORMS | note gated to the property audience RequirementsFields.tsx:153; landlord legend FlyerTag.tsx:40 = PR-2 string exactly; tags unchanged |
| D10 public free-text notes | CONFORMS | property forms keep the note (RequirementsFields.test.tsx:87 expects it for audience 'property' only) |
| D11 Deposit / Application fee "$N" | CONFORMS (see PC2-5) | FlyerPage.tsx:145-147, 156, 164; whole amounts print as before |
| D1 money (any finite number >= 0) | touched - PC2-5 | flyer rounds a third decimal |

PR-2 string check (byte-wise, ASCII, no non-ASCII byte): the ruling's
`On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).`
equals dashboard/src/routes/listing/FlyerTag.tsx:40,
dashboard/src/routes/listing/FlyerTag.test.tsx:47 (exact `toEqual`) and
e2e/tests/dashboard-next/contact-detail.spec.ts:163 (`exact: true`).
ContactEditForm.test.tsx:1450 pins a substring of it (enough; the exact pin
is FlyerTag.test.tsx). The old legend text appears nowhere in app, dashboard,
e2e, documentation or docs/issues; e2e/support/selectors.md never quoted
either legend. The property legend and every tag are unchanged.

## Findings

### PC2-1 - LOW - D8's Apply body gained a required `seen` (a new 400)

- Spec: D8 fixes the body as
  `{ units: [{ unitId, ownItems: string[] }], items: string[], expected: {...} }`
  and lists the 400s (unknown or empty items, inexact expected, units empty /
  repeated / over 100, an ownItems entry not listed).
- Code (ruling PR-1): every `units[]` entry must now carry `seen` - an object
  keyed by EXACTLY its de-duplicated ownItems (`{}` when it has none), each the
  item's whole unit value as the dialog read it - or the request is a 400 with
  a new message, E_SEEN (app/src/routes/contactRequirementsApply.ts:48-49,
  146-158; wire type dashboard/src/api/types.ts:2696-2703; sent by
  applyRequestBody dashboard/src/routes/contact/applyRequirementsModel.ts:163-185).
  Pinned: app/test/requirementsApplyApi.test.ts:174-207 (eight 400 cases),
  the e2e body pin e2e/tests/dashboard-next/property-requirements.spec.ts:364-374.
- Consequence: the API contract the spec documents is no longer the one the
  server accepts; a raw caller following the spec gets 400 on every request
  (no dashboard bundle older than this deploy sends Apply, so no staff page is
  affected). The FW5 report itself says the spec was not edited.
- Suggested fix: amend spec D8 (body shape, the E_SEEN 400) when the branch
  merges, or list it in the handback divergences for Cameron.

### PC2-2 - LOW - an accepted own value is now also skipped when it changed since the dialog read it

- Spec: D8 "skip it as `changed_since_opened` when one is an own value the
  request did not list in that unit's `ownItems` (an exception set after the
  dialog loaded is never overwritten unseen)", and the closing paragraph: a
  property edited after the dialog loaded is still written "UNLESS the edit
  created an own value the dialog did not show (`changed_since_opened`) or
  raced the write (`changed_during_apply`)".
- Code: a changing own item is written only when it is in ownItems AND its
  value now equals (D1) its `seen` value; otherwise the whole unit is skipped
  `changed_since_opened` (app/src/lib/requirements.ts:466-472). Pinned:
  app/test/requirementsApplyApi.test.ts:450 (skip) and :470 (still written when
  unchanged); requirementsApply.test.ts:122, 130.
- Consequence: STRICTER than D8's first sentence, and exactly what D8's
  parenthesis and closing paragraph promise ("an own value the dialog did not
  show") - the round-1 code did not keep that promise (PA-1). One side effect
  worth Cameron's eye: the dialog reads the landlord's properties through the
  byLandlord GSI, which is eventually consistent, so an own value staff edited
  seconds before opening Apply can be shown (and sent as `seen`) stale; the
  server then skips that property as "changed since you opened this - review
  it again" - a safe false alarm that a re-open clears (see PC2-6).
- Suggested fix: none in code; amend D8's skip sentence to the code's rule.

### PC2-3 - LOW - a lost Apply write can now report landlord_changed / deleted / not_found

- Spec: D8 "A condition failure is skipped as `changed_during_apply`."
- Code (ruling PR-5): on a ConditionalCheckFailedException the route re-reads
  the unit once (consistent), re-plans it, and reports `landlord_changed`,
  `deleted` or `not_found` when that is the re-read's skip; anything else -
  and a re-read that throws (logged, best-effort) - stays
  `changed_during_apply` (app/src/routes/contactRequirementsApply.ts:165-194,
  263). Staff then read "has a different landlord now" / "was deleted" / "no
  longer exists" (applyRequirementsModel.ts:174-186, unchanged copy) instead of
  "changed since you opened this - review it again".
- Consequence: more accurate than the spec's text; a different reason than D8
  states for the race. The best-effort branch (a throwing re-read does not
  fail the request after earlier properties were written) is the implementer's
  reading of "anything else", flagged in the FW5 report.
- Suggested fix: none in code; amend D8's race sentence, or list it for
  Cameron.

### PC2-4 - INFO - GET /api/contacts/:contactId gained `?consistent=1`

- Spec: D7 / D8 say "loads the contact itself" / "RE-READS the landlord
  contact"; they define no API parameter.
- Code (ruling PR-3): `consistent=1` reads with `{ consistentRead: true }`, any
  other value or none is the read as before (app/src/routes/contacts.ts:1260-1266;
  client dashboard/src/api/endpoints.ts:1474-1488; callers
  ApplyRequirementsDialog.tsx:166, UnitCreateForm.tsx:234). Pinned:
  app/test/landlordRequirementsPatch.test.ts:60-90, endpoints.test.ts:850,
  ApplyRequirementsDialog.test.tsx:113, UnitCreateForm.test.tsx:576.
- Consequence: additive API surface; no existing caller changes.

### PC2-5 - INFO - the flyer now rounds a requirement amount to two decimals

- Spec: D11 Deposit and Application fee read "$N"; D1 money is "a finite
  number >= 0" and numbers compare exactly (the forms take `step="any"`).
- Code (ruling PR-4): dashboard/src/routes/public/FlyerPage.tsx:145-147 prints
  a whole amount as before ("$1500") and any other with `toFixed(2)`
  ("$1250.40"). A stored amount with a third decimal (1250.456 - the API and
  the forms accept it) now prints "$1250.46" where the round-1 page printed the
  stored number. The staff views already round the same way
  (formatRequirementMoney, maximumFractionDigits 2).
- Consequence: tenants can see an amount that differs from the stored one in
  the third decimal - only for a value nobody would type for a deposit or fee.
- Suggested fix: accept; or limit requirement money to cents at the validator
  (new validation, Cameron's call).

### PC2-6 - INFO - PR-3's consistent reads cover two of the three landlord / unit re-reads

- Spec: D7 has two entry points; D8 re-reads the landlord AND its properties.
- Code: the consistent flag reaches the locked New-form read and the Apply
  dialog's landlord read only. The New form's PICKER path (Properties list
  "+ New property") still fills from the landlord list read on mount
  (UnitCreateForm.tsx:210, `getAllContacts`), and the Apply dialog's property
  list comes from `getAllUnits({ landlordId })` - a GSI query, which cannot be
  consistent.
- Consequence: the PA-3 window remains on those two reads. On the picker path
  D5 already accepts the result (an untouched field is `copied`, and the
  property then shows "Landlord updated", "which is the truth"). On the Apply
  side, PR-1 turns a stale unit read into a spurious `changed_since_opened`
  skip (PC2-2) - never a wrong write.
- Suggested fix: none needed; noted so the PR-3 rationale is not read as
  covering every read.

### PC2-7 - INFO (test gap) - PR-5's `deleted` and `not_found` race reasons are untested

- Code: LOST_WRITE_REASONS holds landlord_changed, deleted and not_found
  (contactRequirementsApply.ts:165-169). Only the landlord-changed race has a
  test (app/test/requirementsApplyApi.test.ts:575); the first-read skips at
  :535 do not exercise the re-read. A mutant deleting `'deleted'` or
  `'not_found'` from the set would survive (FW5's M15 removed the whole filter,
  which the existing race tests catch).
- PROPOSED TEST (not run): in app/test/requirementsApplyApi.test.ts, the same
  wrapper as :575, but the wrapper soft-deletes the stored unit (sets a
  non-empty `deleted_at`) before calling the real fenced write -> expect
  `skipped: [{ unitId, reason: 'deleted' }]`, nothing written, no audit; and a
  second case where the wrapper removes the unit from the harness map ->
  `reason: 'not_found'`. Expected GREEN today; RED with either value removed
  from LOST_WRITE_REASONS.

## Rulings contested (round-1 findings)

- PC-17 - I CONCEDE; the ruling's premise was mine and wrong. The test exists
  at dashboard/src/routes/contact/ContactEditForm.test.tsx:1494-1506 (an
  it.each over a landlord holding `req_deposit: 1400` and one holding none,
  asserting the exact PATCH `{ req_deposit_one_month: true, req_deposit: null }`),
  added in 230ccae4. My round-1 grep for it was cut off by `head` before it
  reached that file. FW5 was right not to add a duplicate; PC-17 should be
  struck.
- PC-8 (no unit_updated row for a no-op fenced PATCH) - CONTEST THE ROUTING,
  not the code. The ruling cites plan review PR2-2, but a plan ruling does not
  amend the approved spec: D13 says "A staff edit keeps unit_updated". It
  should be listed in the handback divergences for Cameron, like PC-10.
- PC-9 (a boolean `pets` beside any `no_pets` key is a 400) - same: accept NO
  CODE, but list it for Cameron; D1 says the key "still accepts a boolean"
  without that exception.
- PC-11 (the "Owning landlord" Staff only tag) - contest "listed where
  visible": that tag IS visible, on the New property form beside the owner
  (UnitCreateForm.tsx:417-437), so it belongs on Cameron's list with PC-12,
  PC-13 and PC-16.
- PC-15 (Apply body leniency / strictness) - now compounded by PC2-1: the D8
  wire contract changed twice over (ownItems and now seen required). Route
  both to Cameron as one D8 spec amendment.
- Every other NO CODE row on my findings (PC-2..PC-7, PC-10, PC-12..PC-14,
  PC-16, PC-18): agreed as ruled.
