# Adversarial Design Review - Round 4B

Reviewed the specification through `156b2b96`, the adjudications, and both
round-three reports. The new contact revision plus cross-table transaction does
close the previously accepted delayed-route and in-flight-finalization schedules
when its guards operate on materialized revisions. Two defects remain in the
specified contract.

## 1. [HIGH] Legacy revision zero cannot be used as a DynamoDB equality guard as specified

### What is wrong

D11 gives an absent `classification_revision` the *logical* value `0`, and then
requires every guarded delete to pin the contact revision it read. DynamoDB does
not treat a missing number attribute as equal to numeric zero: a condition such
as `#classificationRevision = :zero` is false when the attribute is absent.
The design never specifies the required physical-zero condition
(`attribute_not_exists(#revision) OR #revision = :zero`), nor does it materialize
zero before a guarded delete. Thus its no-migration legacy guarantee is not
implementable from the specified mechanism.

This is not merely an update-expression detail. An old extraction can have taken
an Unknown contact snapshot before deployment; that contact can have been
classified by the pre-D11 path and still lack the new field. After deployment the
extraction writes its revision-0 type row, consistently reads the now-classified
legacy contact as logical revision 0, and must delete it. The required transaction
cannot pin the observed `0` with ordinary DynamoDB equality, so it reports a
contact-version conflict forever even though no classification writer advanced a
revision. The stale row remains pending on a classified contact, exactly the
state D11 was introduced to forbid.

### Evidence

- D11 explicitly makes an absent contact revision `0`, makes a legacy type row
  revision `0`, promises no migration, and then requires the transaction to pin
  the live revision: spec D11, lines 287-308 and 339-346.
- The planned repository field remains optional rather than being backfilled:
  spec section 6.1, lines 426-433.
- The current update primitive only conditions contact existence and supports
  physical attribute removal, so an implementation cannot rely on an existing
  version column or an implicit zero: `app/src/repos/contactsRepo.ts:1152-1211`.
- The two existing DynamoDB integration suites provision one table each
  (`ai_extraction` only and `contacts` only), so the current integration seam
  does not accidentally exercise this cross-table, absent-attribute condition:
  `app/test/extractionRepo.integration.test.ts:32-70` and
  `app/test/contactsRepo.integration.test.ts:50-65`.
- Section 8 tests newer-Unknown and delayed-route outcomes, but never requires a
  contact whose stored revision is absent and a suggestion whose source revision
  is logical zero: spec section 8.1, lines 520-554.

### What it implies

Specify the exact condition semantics for a logical revision zero on both sides
of the transaction, including cancellation classification, and add a real
DynamoDB cross-table integration test covering an absent legacy contact field.
It must prove both the classified stale-cleanup path and the Unknown pending path
work without first writing a migration/backfill. Otherwise the claimed
forward-only legacy compatibility is a stranded-suggestion regression at the
deployment boundary.

## 2. [MEDIUM] The data-flow section contradicts D11 on the terminal reason for a newer Unknown epoch

### What is wrong

D11 deliberately distinguishes two successful extraction cleanups: a currently
classified contact is `type_already_classified`, while an Unknown contact at a
newer classification revision is `type_classification_changed`. Section 5.2
instead says every successfully cleaned stale write is
`type_already_classified`. These rules cannot both determine the same persisted
AI-run decision. The listed test for the newer-Unknown schedule requires the
D11-specific reason, so a builder following the data flow verbatim will either
write the wrong forensic verdict or fail the specified tests.

### Evidence

- D11 assigns `type_classification_changed` when the contact is Unknown at a
  newer revision: spec lines 318-323.
- Section 5.2 says a successfully cleaned stale write is always
  `type_already_classified`: spec lines 365-374.
- The surface inventory adds `type_classification_changed` to the decision
  assembly: spec lines 430-435; the test matrix specifically requires it for a
  newer Unknown epoch: spec lines 520-524.

### What it implies

Correct section 5.2 so it repeats D11's two-way outcome rule, and make the
outcome assertion explicit in the delayed retype-to-Unknown test. The run log is
the audit record of why a staff-visible suggestion disappeared; collapsing the
two causes destroys the very classification-epoch distinction D11 adds.

## Attack surfaces checked without further material findings

- Delayed route drains across classify -> retype Unknown -> new-epoch put ->
  later matching classification. The returned contact revision and cross-table
  guard stop the old route before it can delete the new row.
- Type and role PATCH ownership, including role-only writes. D11 correctly makes
  either patch advance the epoch; the shared PATCH route is the production type
  mutation surface (`app/src/routes/contacts.ts:1518-1535`).
- Exact suggestion replacement and deletion-result ownership. Immutable
  suggestion revisions are already the repository identity fence
  (`app/src/repos/extractionRepo.ts:667-693`); D11's three-result contract is
  sufficient once the legacy-zero predicate is stated.
- In-flight AI-run finalization. Retaining a pending decision after a lost delete
  allows `putRun` to merge a marker verdict only while pending
  (`app/src/repos/aiRunsRepo.ts:229-263`), matching D11's handoff.
- Existing fake/stub repos. Adding a guarded repository method will require the
  typed test doubles to implement it (for example,
  `app/test/helpers/twilioWebhookHarness.ts:3225-3274` and
  `app/test/twilioSmsWebhook.test.ts:1135-1154`), but TypeScript exposes that
  surface at build time; it is not a separate design omission.
