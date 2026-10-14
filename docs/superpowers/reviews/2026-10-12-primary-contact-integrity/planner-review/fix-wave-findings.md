# Planner fix wave - findings list (Cameron's rulings, 2026-10-13)

Branch `feat/primary-contact-integrity`, worktree
`W:\tmp\primary-contact-integrity`, base tip `0867ba2d` (0 behind `main`
8a56128c). Source: `planner-verdict.md` (V1-V9 and the decisions list),
`R1-adversarial.md`, `R1-conformance.md`. Cameron ruled on every open item on
2026-10-13; this file is the COMPLETE list for ONE fix wave. Nothing outside
it is in scope.

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
(rev 6 + amendments). The spec is amended IN THIS WAVE where noted. The plan
(`docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`) is the
as-built plan and is NOT edited; this file supersedes it for these items.

---

## F1 (V1, adversarial MEDIUM) - the property box's one-click names a landlord-typed contact only

**Problem.** The property page's no-primary box counts every live,
non-caseworker row as eligible (`dashboard/src/routes/listing/ListingDetail.tsx:478-480`)
and offers a one-click `Make <Name> primary` when exactly one exists
(`:1037-1048`). That can make a TENANT the primary; the tenant then lands on
other tenants' new tour/placement people lists and is named in their intros,
and auto-primary no longer heals it (a LIVE flagged primary exists). The
backfill's `noEligible` lines steer staff to that box.

**Ruling.** The one-click names a contact eligible for AUTOMATIC routing only
(`isAutoRoutingEligible`, `app/src/lib/propertyContact.ts:55-63`: typed
landlord, live, not a phone/email routing pointer).

- Server: a response-only row flag `autoEligible?: true` on `UnitContactView`
  (`app/src/routes/units.ts:286-289`), set in `enrichRosterView`
  (`:543-557`) from the complete read it already does
  (`isAutoRoutingEligible(contact)`); absent otherwise and absent on an
  incomplete read (same contract as `deleted` / `caseworker`, spec 7.5). Never
  stored. The dashboard's row type gains it.
- Dashboard box action (replaces the current three-way branch):
  - exactly ONE row with `autoEligible` -> `Make <Name> primary` (unchanged
    write: `onMakePrimaryContact`);
  - TWO OR MORE `autoEligible` rows -> `Choose a primary` (enters edit mode,
    unchanged);
  - ZERO `autoEligible` rows but at least one live non-caseworker row (not
    `deleted`, not `caseworker`) -> the no-eligible line (F3's new copy) AND
    the `Choose a primary` button (edit mode), so staff can still pick by hand
    deliberately;
  - no live non-caseworker row (all deleted, or only caseworkers) -> the
    no-eligible line only, no button.
- Edit mode's per-row "Make primary" stays type-agnostic (a deliberate pick
  with the name on the row). Unchanged.
- The code comment at `ListingDetail.tsx:471-477` ("broader than the server's
  AUTOMATIC rule ... on purpose") is rewritten to the new rule.
- Backfill script `app/scripts/assign-primary-contacts.ts` noEligible copy
  (`:329`, `:452`, `:466`) - use exactly:
  - per-unit log: `no eligible contact: no live contact is typed landlord (add a property manager or owner on the property page)`
    (keep the `${SCRIPT_NAME} - ` prefix);
  - summary count: `  No eligible contact - no live contact is typed landlord (add a property manager or owner): ${n}`;
  - list: `Properties with no eligible contact (open each one and add a property manager or owner): ${ids}`.
  Update the script's header comment (`:29`) and its run test to match.
- RUNBOOK "Primary contacts backfill" (`RUNBOOK.md:506`, `:511`, `:512`,
  `:516`): the quoted strings change as above; step 4 no longer says the box
  sets "one live contact that is not a caseworker" in one click - say the box
  offers the one-click only for a contact typed landlord, and that on a
  property whose live contacts are tenants (or caseworkers) the box asks for a
  property manager or owner to be added (an added contact typed landlord
  becomes the primary automatically).
- Spec 7.4 "Action" bullets and 7.5 per-row flags rewritten to this rule
  (drop "This is a DELIBERATE click, so it is broader than the automatic
  rule"). Spec 8 noEligible bullet: "listed by unit id so Sam can add a
  property manager or owner (the property box says so)".
- `e2e/support/selectors.md:88` no-primary-box row: the action counts rows
  typed landlord (`autoEligible`); the four cases above; F3's new line.

**Tests (TDD, red first).**
- API: `enrichRosterView` sets `autoEligible` for a live typed-landlord row,
  NOT for a tenant row, a caseworker row, a deleted landlord row, or a
  phone_ref/email_ref record; the flag is absent when the read is incomplete
  (beside `app/test/unitsApiPropertyContact.test.ts` /
  `unitsApiPropertyContactWrites.test.ts`).
- Dashboard (`ListingDetail.test.tsx`): one tenant row only -> NO
  `Make <Tenant> primary`, the no-eligible line + `Choose a primary`; one
  landlord-typed row + one tenant row -> `Make <Landlord> primary`; two
  `autoEligible` rows -> `Choose a primary`; caseworker-only -> line, no
  button; all-deleted -> line, no button.
- e2e: no new spec needed if the existing `primary-contact-integrity.spec.ts`
  (a) case still drives the one-click with a landlord-typed Mark (verify it
  does); any spec that expected a one-click on a non-landlord row is updated.

## F2 (builder Q2 / adversarial code-review F1) - deleting the landlord of record of a NO-flag roster hands off

**Problem.** `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`:
the contact-delete fan-out targets a unit only when its FLAGGED row is the
deleted contact (`app/src/services/primaryHandoff.ts:86-88`), and
`handOffPrimaryFrom` re-checks the same (`app/src/repos/unitsRepo.ts:1739-1741`).
On a roster with no flagged row, the landlord of record IS the property's
contact, so deleting it leaves the property with nobody.

**Ruling.** Apply the issue's restricted recipe in BOTH places:

- target predicate (Scan): `contactId === unit.landlordId (non-empty) ?
  landlordWasPrimary(unitContacts(unit), contactId) : flagged?.contactId === contactId`.
  `landlordWasPrimary` alone is true for every no-flag unit; the
  landlord-of-record test is what keeps one delete from targeting all of them.
  The derived-landlord-row case (no stored list) behaves as today.
- `handOffPrimaryFrom`'s re-check on its consistent re-read: the same
  predicate (so a retry still re-checks; `not_primary` otherwise).
- Unchanged: `chooseHeir` with the deleted contact EXCLUDED and never read;
  `applyPrimary` flags the heir and sets the scalar; `landlordId` is NOT
  changed; the audit row is `unit_primary_contact_assigned { reason:
  'handoff_on_delete', from: <deleted landlord> }`; no heir -> nothing
  changes; unknown -> logged and skipped.
- One shared predicate (export it, e.g. next to `landlordWasPrimary` in
  `unitsRepo.ts`), used by the service, the repo and any fake that mirrors
  them - not three copies.
- Docs: spec 4.6 "Delete the contact" bullet (targets = flagged primary, OR
  the landlord of record when no row is flagged) and the LAST bullet
  ("Restore vs. contact delete on a roster with NO flagged row") rewritten:
  restore and delete now AGREE - on a no-flag roster the landlord of record is
  the primary (`landlordWasPrimary`) and both hand off. Spec 9.2's matching
  sentence if it repeats the asymmetry. Resolve
  `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`
  (status: resolved, a dated RESOLVED block naming the commit). Sweep code
  comments that describe the asymmetry (primaryHandoff.ts, unitsRepo.ts,
  routes/contacts.ts, ContactDetail.tsx) and the GLOSSARY zero-primary bullet
  (spec 12) if it lists this path.

**Tests (TDD, red first).**
- FakeWorld/service: `landlordId: c-ll`, list `[c-ll landlord unflagged,
  c-pm pm unflagged (pm typed landlord)]`, delete c-ll -> c-pm flagged,
  scalar = c-pm, ONE audit row `handoff_on_delete` from c-ll.
- Negative: a no-flag unit whose landlord of record is SOMEONE ELSE is not a
  target when an unrelated rostered contact is deleted.
- Negative: a unit with a FLAGGED row other than the deleted landlord of
  record is not a target (flag wins).
- Retry re-check: the unit gained a flagged row between the Scan and the
  write -> `not_primary`, nothing written.
- One DynamoDB Local case beside
  `app/test/unitsRepoHandOffPrimary.integration.test.ts`.

## F3 (builder Q1) - spec 7.4's no-eligible line

Replace, everywhere it is live copy or a live doc:

- old: `Add the landlord or property manager - they become the primary automatically.`
- new: `Add a property manager or owner - they become the primary automatically.`

Places: spec 7.4, `dashboard/src/routes/listing/ListingDetail.tsx:148`
(`NO_ELIGIBLE_LINE`), `ListingDetail.test.tsx:2671` (and any other test that
pins it), `e2e/support/selectors.md:88`, RUNBOOK step 4's paraphrase. Do NOT
edit the plan or the review records (history).

## F4 - NO change (Cameron)

Classifying an already-seated contact as a property manager still promotes
nobody (spec 4.4; builder Q3 / R2-1). Stays a documented known gap. Do not
touch.

## F5 - two cheap LOWs

**F5a (V2 / adversarial R1 finding 3).** "Restore without a landlord" and the
landlord SWAP read contact liveness STRONGLY CONSISTENT again.

- `contactsRepo.getManyByIds(ids, { requireComplete?, consistentRead? })`;
  `batchGetByIds` passes `ConsistentRead: true` in that table's
  `RequestItems` entry when asked (`app/src/repos/contactsRepo.ts:957-997`,
  `:1288-1290`). Default unchanged (eventually consistent).
- `readRosterContacts` gains an options argument carrying `consistentRead`
  (`app/src/lib/propertyContact.ts:86-104`).
- The restore route uses it for BOTH reads: the "Restore without a landlord"
  heir pick (`app/src/routes/units.ts:597-601`) and the `readContacts` it
  hands `restoreWithLandlord` for the swap / clear hand-off
  (`units.ts:2092`). Every other caller stays as it is (Cameron: restore
  paths only).
- The API-test fake (`app/test/helpers/twilioWebhookHarness.ts:2289`, and any
  other `getManyByIds` fake the touched tests use) mirrors the signature.
- Pins: a contactsRepo test that the BatchGet input carries
  `ConsistentRead: true` only when asked; the restore route test (extend the
  `app/test/unitsRestoreLandlord.test.ts` "(PIN) reads the remaining contacts
  in ONE complete batch read" case, and the swap case) asserts
  `consistentRead: true` reached `getManyByIds`.
- `docs/issues/roster-liveness-read-eventual-consistency.md`: dated Update
  block - the restore paths read consistently again (the regression against
  main is closed); the other write-deciding callers (add, remove, delete
  fan-out, script) stay eventually consistent; the issue stays OPEN, narrowed.
  Update its `refs:`.
- Spec 4.2: one sentence that the restore paths' liveness read is strongly
  consistent.

**F5b (V3).** The contact Delete dialog sentence:

- old: `If they're a property's primary contact, the landlord or another contact on that property takes over, and restoring them won't change that back.`
- new: `If they're a property's primary contact, the landlord or another contact on that property takes over when someone can, and restoring them won't change that back.`

Places: spec 7.6, `dashboard/src/routes/contact/ContactDetail.tsx:141`,
`ContactDetail.test.tsx:3043`. Not the plan or the records.

---

## Out of scope (accepted, do not touch)

V4 stale scalar on a non-primary remove, V5 in-request Scan, V6 import
cycle, V7 duplicated checks / vacuous ladder pin, V8 backfill audits no-flag
units, V9 no real-repo e2e walk of the delete hand-off, the
`relay-provision-includes-deleted-contacts` issue, and F4 above.

## Done means

- Every item above is built TDD (red, then green, logs kept), committed with
  explicit paths, records committed as produced.
- Live self-QA of the property box on a hermetic lane: a tenant-only zero-
  primary property shows the new line + `Choose a primary` and NO one-click;
  a landlord-typed sole contact shows `Make <Name> primary`. Screenshots in
  the records' `self-qa` area.
- The branch's own gates green on the final tip; then the planner re-reviews
  and re-gates.
