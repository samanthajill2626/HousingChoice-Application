# Task 2 review - persistence and fencing

## Verdicts

- **SPEC-CONFORMANCE: FAIL**
- **TASK-QUALITY: CHANGES REQUIRED**
- Findings: 2 (1 high, 1 medium)

Review was read-only. Per dispatch, no tests were run. Evidence below is from the exact
`e8100f3e..fcf65dda` package, the committed source, the approved spec/adjudications,
the S2 brief/report, and the live worklist.

## Findings

### HIGH - The production-like webhook harness does not advance the contact classification fence

**Proof:** `app/test/helpers/twilioWebhookHarness.ts:1770-1786` applies `type` and
`role` patches by assigning/removing fields and returns the contact, but never increments
`classification_revision`. The new guarded fake at
`app/test/helpers/twilioWebhookHarness.ts:3280-3292` then compares the unchanged logical
revision and can delete when it matches.

**Concrete failing interleaving:** start with an Unknown contact at logical revision 0.
Harness PATCH A classifies it as Tenant; unlike the real repo, the fake remains at revision
0. Harness PATCH B later retypes it and publishes a new epoch's suggestion, but it also
remains at revision 0. A delayed drain from A still passes the fake's contact check at line
3284 and can delete B's exact suggestion at lines 3288-3292. In production,
`ContactsRepo.update` advances the committed revisions to 1 and 2, so A's revision-1
transaction must return `contact_revision_changed` and preserve B. The fake therefore
cannot prove the approved committed-order invariant and can hide the exact stale-route race
this feature introduces the fence to prevent.

**Required change:** make the harness `ContactsRepo.update` atomically model the real
supplied-`type`/`role` revision increment before returning, including `role: null`, and add
a harness assertion that two sequential kind writes produce revisions 1 then 2 and that the
older guarded delete cannot remove the later-epoch suggestion. Race injection hooks can
remain Task 4 work; the base fake semantics must be faithful in S2.

### MEDIUM - Required condition/helper parity for legacy suggestion identity is not executable

**Proof:** `app/test/extractionRepo.test.ts:951-1005` tests only the pure
`sameSuggestionIdentity` helper. The guarded-delete integration block at
`app/test/extractionRepo.integration.test.ts:124-208` creates every candidate through
`putSuggestion`, which always stamps a revision at `app/src/repos/extractionRepo.ts:578`.
It therefore never executes the transaction's legacy branches at
`app/src/repos/extractionRepo.ts:286-310`. The same block covers revision-0 mismatch and
revision-1 equality, but not the brief's explicit later-revision mismatch case. There is
also no test for the required unexplained-cancellation rethrow at
`app/src/repos/extractionRepo.ts:841`.

**Concrete failing scenario:** regress the legacy no-run transaction predicate by removing
`attribute_not_exists(#runId)`, or by omitting `attribute_not_exists(#revision)`. An old
legacy identity could then delete a replacement with the same `createdAt` but a newly
present `runId` or `revision`. All current S2 tests still pass: helper tests never exercise
DynamoDB, and every guarded integration candidate is revisioned. This leaves the
load-bearing revision-first / legacy-exact parity unpinned despite the S2 brief requiring
it.

**Required change:** add real or faithful transaction tests for legacy exact deletion with
runId absent, present-vs-absent runId mismatch, a revisioned replacement sharing legacy
fields, later numeric revision mismatch, and cancellation with both observed predicates
still true rethrowing the original error.

## Attacked but held

- **Atomic contact increment:** `app/src/repos/contactsRepo.ts:1175-1206` detects only
  supplied non-`undefined` `type`/`role` fields and appends `if_not_exists(..., 0) + 1` to
  the existing single update. `role: null` is included. The integration test at
  `app/test/contactsRepo.integration.test.ts:332-359` covers ordinary-update parity,
  absent-to-one, role clearing, retype to Unknown, and concurrent revisions `{1, 2}`.
- **Logical zero physical predicate:** `app/src/repos/extractionRepo.ts:783-801` uses
  `attribute_not_exists(classification_revision) OR classification_revision = 0` plus
  contact existence for expected revision 0. The DynamoDB integration cases at
  `app/test/extractionRepo.integration.test.ts:124-155` exercise physically absent and
  explicit-zero contacts.
- **Cross-table atomicity:** `app/src/repos/extractionRepo.ts:788-813` uses one
  `TransactWriteCommand` containing the contact `ConditionCheck` and exact suggestion
  `Delete`; there is no read-then-delete gap.
- **Cancellation ownership:** `app/src/repos/extractionRepo.ts:817-841` performs consistent
  reads after transaction cancellation, checks contact revision before suggestion identity,
  and rethrows when both predicates still appear satisfied. Non-transaction failures are
  rethrown.
- **Identity precedence:** `app/src/repos/extractionRepo.ts:131-143` and `:274-310` both
  prefer immutable revision and otherwise require absent revision, exact `createdAt`, and
  present-or-absent exact `runId`. The transaction key is derived from owner/target, so the
  identity's routing fields are pinned by the selected item key.
- **Stale replacement safety in real DynamoDB:**
  `app/test/extractionRepo.integration.test.ts:157-193` proves an old revision cannot delete
  a replacement and a contact-revision change preserves the exact suggestion.
- **Generic replacement behavior:** the existing CAS replacement loop remains intact at
  `app/src/repos/extractionRepo.ts:568-697`; S2 only copies the optional source revision when
  provided.
- **No runtime kind activation or ContactType widening:** `ContactType` remains
  `tenant | landlord | partner | team_member | unknown` at
  `app/src/repos/contactsRepo.ts:51`. The exact S2 diff does not touch extraction schema,
  parser, prompt, seed/import, dependency, environment, table definition, or infrastructure
  files.
- **Other typed ExtractionRepo construction sites:** the two job fakes have typed inert
  stubs, the SMS fake remains fail-fast, and the webhook extraction fake performs
  contact-first diagnosis plus exact suggestion identity. The blocking fidelity gap is the
  webhook harness's contact writer described above.
