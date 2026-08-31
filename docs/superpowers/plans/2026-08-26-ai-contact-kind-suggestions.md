<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-27).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). The mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-26-ai-contact-kind-suggestions/`.

# AI Contact-Kind Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let forward-looking AI extraction recommend Tenant, Landlord, Partner, or Property Manager for an Unknown contact, let staff apply those recommendations without collapsing Property Manager into Landlord, and reconcile every type suggestion against concurrent kind changes.

**Architecture:** Widen the existing `typeSuggestion` contract to a closed staff-facing kind union while retaining `target: 'type'` and the existing stored contact model. Add a monotonic contact `classification_revision` and a revision-pinned cross-table suggestion delete so extraction and human PATCH writers can divide ownership of stale rows without deleting a newer Unknown epoch. Keep contact classification on the existing PATCH route, centralize each boundary's kind mapping, and preserve raw AI forensic payloads while humanizing only staff-facing labels.

**Tech Stack:** TypeScript, Express, React, Vitest, DynamoDB Local and AWS SDK v3 document commands, Playwright, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-26-ai-contact-kind-suggestions-design.md`

## Global Constraints

- Read the approved spec before editing; its D1-D11 decisions are fixed for this mission.
- The canonical suggestion values are exactly `tenant`, `landlord`, `property_manager`, and `partner`; the structured-output decline sentinel remains `none`.
- Property Manager remains stored as `{ type: 'landlord', role: 'Property Manager' }`; do not add a `ContactType` member.
- Every standard-kind action writes both fields and clears a stale role with `role: ''`.
- Suggestions remain advisory and Unknown-only; no extraction path writes `type` or `role` directly.
- Classification applies to the current external contact, never a represented or mentioned person.
- No migration, scan, seed change, import change, scheduled pass, or backfill.
- No production contact read or write, including the motivating production contact.
- No dependency, environment variable, table, index, infrastructure, deployment, or feature-flag change.
- Keep the generic suggestion accept endpoint's `accept_type_via_triage` refusal.
- Keep the generic replacement policy unchanged for every suggestion target other than `type`.
- Treat an absent `classification_revision` and an absent `contactClassificationRevision` as logical numeric zero.
- A kind-changing contact update remains last-commit-wins; this feature does not add request-start optimistic concurrency.
- Repository failures after a successful contact PATCH remain best-effort log-and-continue.
- New or touched source, tests, docs, prompts, labels, comments, and test names must use ASCII-only added lines.
- New automated outbound copy would require the message catalog, but this mission adds no outbound copy.
- Do not merge, deploy, change Terraform, alter `AI_EXTRACTION_ENABLED`, or run against the human's live ports.
- Run each red test before its implementation and confirm it fails for the named missing behavior, not for harness setup.
- Before every commit, run bare `git status`, verify `git rev-parse -q --verify MERGE_HEAD` has no output, and stage only the explicit paths named by that task.

## File and responsibility map

- `app/src/adapters/extraction.ts`: owns the `SuggestedContactKind` wire union.
- `app/src/services/extraction/schema.ts`: owns the structured-output enum, parser allowlist, and raw attempted-output audit behavior.
- `app/src/services/extraction/prompt.ts`: owns current-contact classification semantics and role-fact note guidance.
- `app/src/services/extraction/contactKinds.ts`: new backend-only mapping from a stored contact shape to a comparable canonical kind.
- `app/src/services/extraction/runTypes.ts`: owns the new `type_classification_changed` drop reason.
- `app/src/repos/contactsRepo.ts`: owns the atomic contact classification revision increment.
- `app/src/repos/extractionRepo.ts`: owns suggestion revision persistence, consistent point reads, and the two-table guarded delete.
- `app/src/services/extraction/apply.ts`: owns extraction-side post-put reconciliation and pending/drop decision ownership.
- `app/src/routes/contacts.ts`: owns human PATCH-side type-suggestion draining and accepted-versus-superseded verdicts.
- `app/src/worker.ts`, `app/src/routes/dev.ts`, and typed test doubles: wire the widened apply dependencies without adding a parallel path.
- `dashboard/src/routes/contact/contactProfile.ts`: owns the dashboard label and canonical kind-to-PATCH map.
- `dashboard/src/routes/contact/KindPicker.tsx`: reuses the dashboard map for the existing edit writer.
- `dashboard/src/routes/contact/UnknownFile.tsx`: renders four advisory actions and exact labels.
- `dashboard/src/routes/contact/ContactDetail.tsx`: sends both `type` and `role` through the existing PATCH route.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx`: humanizes only type-decision ledger values.
- `e2e/tests/flows/conversation-fact-extraction.spec.ts`: proves Partner and Property Manager application through the fake extraction driver and real app/dashboard stack.
- `docs/issues/caseworker-contact-type.md`: closes the tracked gap only after the implementation proof passes.

## Dependency order

Task 1 declares the four-value TypeScript union without activating new runtime model output. Task 2 adds the persistence primitives. Task 3 consumes the type and primitives to reconcile extraction writes. Task 4 consumes the repository primitive and backend kind resolver to reconcile human PATCH writes. Task 5 adds the staff UI on top of the stable PATCH contract. Only after every writer and consumer is ready, Task 6 widens the structured schema, parser, and prompt to activate Partner and Property Manager output. Task 7 proves both new flows end-to-end and closes the issue. Task 8 performs the single final `main` sync, complete feature gates, and hermetic live self-QA.

---

### Task 1: Declare the canonical kind type without runtime activation

**Files:**
- Modify: `app/src/adapters/extraction.ts:73-81`

**Interfaces:**
- Consumes: the existing inline `ExtractionResult.typeSuggestion.value` union.
- Produces: the canonical `SuggestedContactKind` TypeScript union needed by the persistence, route, and dashboard-ready backend work.
- Activation boundary: this task must not change `EXTRACTION_SCHEMA`, `parseExtractionText`, `parseExtractionOps`, or the model prompt. Production extraction must still emit only Tenant or Landlord until Task 6, after the PATCH route and dashboard can honor every new value.

- [ ] **Step 1: Add the shared wire union only**

In `app/src/adapters/extraction.ts`, define and consume:

```ts
export type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: SuggestedContactKind; reason?: string };
  // Preserve the remaining existing fields unchanged.
}
```

Do not touch the runtime schema, parser, raw-operation parser, or prompt in this task. The type widening is compile-time scaffolding only, so it has no behavioral red test and does not activate model output.

- [ ] **Step 2: Prove the declaration compiles without changing runtime output**

Run:

```powershell
npm run typecheck -w @housingchoice/app
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
```

Expected: both commands PASS. Confirm the existing schema enum and applicable parser still reject Partner and Property Manager at runtime; Task 6 owns the deliberate red/green activation of those paths.

- [ ] **Step 3: Commit the compile-time contract**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/adapters/extraction.ts
git commit -m "refactor: define AI contact kind union" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: status lists only the adapter before staging; `MERGE_HEAD` prints nothing; the commit succeeds. This commit is behavior-neutral and must not be deployed as a claim that the new model output is active.

---

### Task 2: Add classification revision persistence and guarded deletion

**Files:**
- Modify: `app/src/repos/contactsRepo.ts:91-310,492-570,967-969,1152-1211`
- Modify: `app/src/repos/extractionRepo.ts:81-111,123-214,239-244,489-725`
- Test: `app/test/contactsRepo.integration.test.ts`
- Test: `app/test/extractionRepo.test.ts`
- Test: `app/test/extractionRepo.integration.test.ts`
- Modify: `app/test/extractionJob.test.ts:170-198`
- Modify: `app/test/extractionJobDraftGuard.test.ts:101-124`
- Modify: `app/test/helpers/twilioWebhookHarness.ts:3180-3300`
- Modify: `app/test/twilioSmsWebhook.test.ts:1135-1155`

**Interfaces:**
- Consumes: `ContactsRepo.getById(contactId, { consistentRead: true })`, suggestion immutable `revision`, legacy suggestion identity fallback, and `tableName`.
- Produces: `ContactItem.classification_revision?: number`, `contactClassificationRevision(contact)`, `SuggestionItem.contactClassificationRevision?: number`, `sameSuggestionIdentity(a, b)`, consistent suggestion reads, and `deleteTypeSuggestionIfCurrentAtContactRevision`.

- [ ] **Step 1: Add red contact-revision integration tests**

Create or update one real DynamoDB contact, then pin kind-changing versus ordinary updates:

```ts
it('increments classification_revision only in the same type or role update', async () => {
  const created = await repo.create({ type: 'unknown', firstName: 'Revision' });
  expect(created.classification_revision).toBeUndefined();

  const noteOnly = await repo.update(created.contactId, { notes: 'unchanged kind' });
  expect(noteOnly.classification_revision).toBeUndefined();

  const tenant = await repo.update(created.contactId, { type: 'tenant' });
  expect(tenant.classification_revision).toBe(1);

  const roleCleared = await repo.update(created.contactId, { role: null });
  expect(roleCleared.classification_revision).toBe(2);

  const unknownAgain = await repo.update(created.contactId, { type: 'unknown' });
  expect(unknownAgain.classification_revision).toBe(3);
});
```

Add a concurrent `Promise.all` test with two kind-changing updates and assert returned revisions are `{1, 2}` in either completion order and the stored revision is `2`. This proves the increment is a single DynamoDB expression, not a read-then-write counter.

- [ ] **Step 2: Run the contact repository test and verify the red state**

Run:

```powershell
npm run db:start
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts
```

Expected: FAIL because the returned contacts do not carry `classification_revision`.

- [ ] **Step 3: Implement the atomic revision increment**

Declare the field explicitly:

```ts
export interface ContactItem {
  contactId: string;
  type: ContactType;
  classification_revision?: number;
  // Preserve every existing field and the flexible-document index signature.
}

export function contactClassificationRevision(
  contact: Pick<ContactItem, 'classification_revision'>,
): number {
  const revision = contact.classification_revision;
  return typeof revision === 'number'
    && Number.isSafeInteger(revision)
    && revision >= 0
    ? revision
    : 0;
}
```

Inside `ContactsRepo.update`, compute the kind-changing condition from supplied non-`undefined` values, including `role: null` and `type: 'unknown'`:

```ts
const changesKind = Object.entries(patch).some(
  ([key, value]) => value !== undefined && (key === 'type' || key === 'role'),
);

if (changesKind) {
  names['#classificationRevision'] = 'classification_revision';
  values[':classificationRevisionZero'] = 0;
  values[':classificationRevisionOne'] = 1;
  sets.push(
    '#classificationRevision = if_not_exists(#classificationRevision, :classificationRevisionZero) + :classificationRevisionOne',
  );
}
```

Keep the increment in the existing single `UpdateCommand` and retain `ReturnValues: 'ALL_NEW'`. Do not initialize the field in create, import, inbound capture, unmatched-email, or group-member paths.

- [ ] **Step 4: Re-run the contact-revision integration tests**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts
```

Expected: PASS, including the absent-to-one transition, `role: null`, retype-to-Unknown, ordinary-update parity, and concurrent atomic increment.

- [ ] **Step 5: Add red extraction repository tests for revision persistence and consistent reads**

Add unit assertions that `putSuggestion` copies the optional contact revision and `getSuggestion` forwards `ConsistentRead`:

```ts
it('persists the contact classification revision on a type suggestion', async () => {
  const result = await repo.putSuggestion({
    ownerContactId: 'c1',
    target: 'type',
    suggestedValue: 'partner',
    conversationId: 'conv-1',
    contactClassificationRevision: 7,
  });
  expect(result.item.contactClassificationRevision).toBe(7);
});

it('requests a consistent point read when the caller asks for one', async () => {
  await repo.getSuggestion('c1', 'type', { consistentRead: true });
  expect(doc.send).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({ ConsistentRead: true }),
  }));
});

it('compares suggestion identity by revision before the legacy fallback', () => {
  expect(sameSuggestionIdentity(
    suggestion({ revision: 'rev-1', createdAt: 'old' }),
    suggestion({ revision: 'rev-1', createdAt: 'new' }),
  )).toBe(true);
  expect(sameSuggestionIdentity(
    suggestion({ revision: 'rev-1' }),
    suggestion({ revision: 'rev-2' }),
  )).toBe(false);
  expect(sameSuggestionIdentity(
    suggestion({ revision: 'rev-1' }),
    suggestion({ revision: undefined }),
  )).toBe(false);
});

it('requires exact createdAt and present-or-absent runId for legacy rows', () => {
  expect(sameSuggestionIdentity(
    suggestion({ revision: undefined, createdAt: 't1', runId: undefined }),
    suggestion({ revision: undefined, createdAt: 't1', runId: undefined }),
  )).toBe(true);
  expect(sameSuggestionIdentity(
    suggestion({ revision: undefined, createdAt: 't1', runId: undefined }),
    suggestion({ revision: undefined, createdAt: 't1', runId: 'run-1' }),
  )).toBe(false);
  expect(sameSuggestionIdentity(
    suggestion({ revision: undefined, createdAt: 't1', runId: 'run-1' }),
    suggestion({ revision: undefined, createdAt: 't2', runId: 'run-1' }),
  )).toBe(false);
});
```

The helper fixtures must also prove that different `ownerContactId` or `target` values never compare equal.

- [ ] **Step 6: Add red two-table guarded-delete integration tests**

Provision the existing `contacts` and `ai_extraction` table specs in the test environment. Seed each suggestion through `putSuggestion` so it has an immutable suggestion revision. Cover these exact outcomes:

```ts
expect(await extraction.deleteTypeSuggestionIfCurrentAtContactRevision(
  suggestion,
  0,
)).toBe('deleted');

expect(await extraction.deleteTypeSuggestionIfCurrentAtContactRevision(
  replacedSuggestion,
  0,
)).toBe('suggestion_changed_or_absent');

expect(await extraction.deleteTypeSuggestionIfCurrentAtContactRevision(
  suggestionFromRevisionZero,
  0,
)).toBe('contact_revision_changed');
```

The first case must use a contact document with the physical revision attribute absent. Add a second zero case with physical `classification_revision: 0`. Add later-revision equality and mismatch cases. Assert a suggestion replacement survives an old identity and assert a contact revision change survives an exact suggestion identity.

- [ ] **Step 7: Run repository tests and verify the intended red state**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionRepo.test.ts test/extractionRepo.integration.test.ts
```

Expected: FAIL because the optional fields, identity helper, consistent-read option, guarded-delete type, and method do not exist.

- [ ] **Step 8: Add the guarded-delete types and signatures**

Add:

```ts
export interface SuggestionItem {
  // Preserve existing fields.
  contactClassificationRevision?: number;
}

export type GuardedTypeDeleteResult =
  | 'deleted'
  | 'suggestion_changed_or_absent'
  | 'contact_revision_changed';

export type SuggestionIdentity = Pick<
  SuggestionItem,
  'ownerContactId' | 'target' | 'createdAt' | 'runId' | 'revision'
>;

export function sameSuggestionIdentity(
  left: SuggestionIdentity,
  right: SuggestionIdentity,
): boolean {
  if (
    left.ownerContactId !== right.ownerContactId
    || left.target !== right.target
  ) return false;
  if (left.revision !== undefined || right.revision !== undefined) {
    return left.revision !== undefined
      && right.revision !== undefined
      && left.revision === right.revision;
  }
  return left.createdAt === right.createdAt
    && left.runId === right.runId;
}
```

Widen the interface without changing existing callers:

```ts
getSuggestion(
  contactId: string,
  target: string,
  opts?: { consistentRead?: boolean },
): Promise<SuggestionItem | undefined>;

deleteTypeSuggestionIfCurrentAtContactRevision(
  suggestion: SuggestionIdentity,
  expectedContactClassificationRevision: number,
): Promise<GuardedTypeDeleteResult>;
```

- [ ] **Step 9: Persist revisions and implement the two-table transaction**

At repository construction, derive both table names:

```ts
const table = tableName('ai_extraction', deps.env);
const contactsTable = tableName('contacts', deps.env);
```

Copy `contactClassificationRevision` into the `putSuggestion` item when defined and pass `ConsistentRead: opts?.consistentRead` from `getSuggestion`.

Build the contact condition exactly:

```ts
const contactCondition = expectedContactClassificationRevision === 0
  ? 'attribute_exists(contactId) AND (attribute_not_exists(#classificationRevision) OR #classificationRevision = :zero)'
  : 'attribute_exists(contactId) AND #classificationRevision = :expectedContactRevision';
```

Use one `TransactWriteCommand` containing:

```ts
TransactItems: [
  {
    ConditionCheck: {
      TableName: contactsTable,
      Key: { contactId: suggestion.ownerContactId },
      ConditionExpression: contactCondition,
      ExpressionAttributeNames: {
        '#classificationRevision': 'classification_revision',
      },
      ExpressionAttributeValues: expectedContactClassificationRevision === 0
        ? { ':zero': 0 }
        : { ':expectedContactRevision': expectedContactClassificationRevision },
    },
  },
  {
    Delete: {
      TableName: table,
      Key: { itemId: suggId(suggestion.ownerContactId, suggestion.target) },
      ConditionExpression: exactSuggestionCondition,
      ExpressionAttributeNames: exactSuggestionNames,
      ExpressionAttributeValues: exactSuggestionValues,
    },
  },
]
```

Build the DynamoDB condition from the same fields and precedence as `sameSuggestionIdentity`: prefer exact `revision`; for a legacy row require absent `revision`, exact `createdAt`, and exact present-or-absent `runId`. Use the exported helper for cancellation diagnosis and later route verdict ownership, and pin condition/helper parity in the repository tests. On `TransactionCanceledException`, consistently read both rows. Return `contact_revision_changed` first when the live logical contact revision differs; otherwise return `suggestion_changed_or_absent` when the exact row is gone or replaced. Re-throw an unexplained cancellation where both predicates still appear true and re-throw non-transaction failures. A successful transaction returns `deleted`.

- [ ] **Step 10: Run both repository suites and app typecheck**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/extractionRepo.test.ts test/extractionRepo.integration.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: repository tests PASS.

- [ ] **Step 11: Make every typed repository fake implement the new method**

Update the four exact object-literal fake sites listed in this task. In `extractionJob.test.ts` and `extractionJobDraftGuard.test.ts`, use a typed Vitest stub because those tests do not call the new path:

```ts
deleteTypeSuggestionIfCurrentAtContactRevision: vi.fn(
  async () => 'suggestion_changed_or_absent' as const,
),
```

In `twilioSmsWebhook.test.ts`, use its existing fail-fast helper:

```ts
deleteTypeSuggestionIfCurrentAtContactRevision:
  notImpl('deleteTypeSuggestionIfCurrentAtContactRevision')
    as ExtractionRepo['deleteTypeSuggestionIfCurrentAtContactRevision'],
```

For `twilioWebhookHarness.ts`, add a faithful method that reads the harness contact, compares its logical `classification_revision`, compares the exact suggestion identity, and deletes only when both match. Return the exact three-value result. Task 4 will add race injection hooks around this behavior, not replace it.

Run:

```powershell
rg -n "satisfies ExtractionRepo|: ExtractionRepo =|: ApplyDeps" app/src app/test
npm run typecheck -w @housingchoice/app
```

Expected: every concrete `ExtractionRepo` object from the search has the method and app typecheck PASSes. Cast-only recovery fakes that deliberately provide `{}` remain unchanged because they are not implementations.

- [ ] **Step 12: Commit the persistence primitive**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/repos/contactsRepo.ts app/src/repos/extractionRepo.ts app/test/contactsRepo.integration.test.ts app/test/extractionRepo.test.ts app/test/extractionRepo.integration.test.ts app/test/extractionJob.test.ts app/test/extractionJobDraftGuard.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioSmsWebhook.test.ts
git commit -m "feat: fence contact kind revisions" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the persistence primitive and all typed construction sites commit together; no unrelated dirty path is staged.

---

### Task 3: Reconcile extraction-side type suggestion writes

**Files:**
- Modify: `app/src/services/extraction/runTypes.ts:24-39`
- Modify: `app/src/services/extraction/apply.ts:16-44,160-180,534-576,697-741`
- Modify: `app/src/jobs/extraction.ts:88-106,567-590`
- Modify: `app/src/worker.ts:475-489`
- Modify: `app/src/routes/dev.ts:665-679`
- Modify: `app/test/helpers/twilioWebhookHarness.ts:1760-1790,3180-3300`
- Modify: `app/test/extractionApply.test.ts`
- Modify: `app/test/extractionJob.test.ts`
- Modify: `app/test/extractionJobDraftGuard.test.ts`
- Modify: `app/test/extractionDecisions.test.ts`
- Modify: `app/test/extractionRunTypes.test.ts`
- Modify: `app/test/twilioSmsWebhook.test.ts:1135-1155`

**Interfaces:**
- Consumes: Task 1's `SuggestedContactKind`; Task 2's logical contact revision, `PutSuggestionResult.item`, consistent `ContactsRepo.getById`, and guarded delete result.
- Produces: extraction rows tagged with their source contact revision and an apply decision that changes to dropped only after its own guarded delete commits.

- [ ] **Step 1: Add red serialization tests for the new drop reason**

Add assertions to `extractionRunTypes.test.ts` and `extractionDecisions.test.ts` that the value is accepted and round-trips in a dropped type decision:

```ts
expect([...DROP_REASONS].sort()).toEqual([
  'dismissed_before',
  'empty_value_at_parse',
  'equal_to_current',
  'invalid_value',
  'phone_already_owned',
  'phone_not_canonicalizable',
  'phone_owned_by_other',
  'repo_error',
  'status_not_onboarding_tenant',
  'type_already_classified',
  'type_classification_changed',
  'wrong_contact_type',
]);

expect(buildDecisions({
  ops: {
    ...EMPTY_OPS_VIEW,
    type: { op: 'suggest', value: 'partner' },
  },
  rawTextPresent: true,
  applyDecisions: [{
    target: 'type',
    outcome: 'dropped',
    proposedValue: 'partner',
    dropReason: 'type_classification_changed',
  }],
}).type).toMatchObject({
  outcome: 'dropped',
  dropReason: 'type_classification_changed',
});
```

- [ ] **Step 2: Add red apply tests for canonical values and the stored contact revision**

Update the apply fake to retain returned `SuggestionItem`s, then add:

```ts
it.each(['partner', 'property_manager'] as const)(
  'persists a %s type suggestion at the source contact revision',
  async (kind) => {
    const { deps, records } = makeDeps();
    const out = await run(
      deps,
      makeContact({ type: 'unknown', classification_revision: 4 }),
      { fields: {}, typeSuggestion: { value: kind, reason: 'stated role' } },
      'ts-9',
      'run-kind',
    );
    expect(records.suggestions[0]).toMatchObject({
      target: 'type',
      suggestedValue: kind,
      contactClassificationRevision: 4,
      runId: 'run-kind',
    });
    expect(out.suggested).toEqual(['type']);
    expect(out.decisions[0]).toMatchObject({
      outcome: 'suggested',
      proposedValue: kind,
    });
  },
);
```

Add the same assertion for a legacy contact with no physical field and expect `contactClassificationRevision: 0`.

- [ ] **Step 3: Add red extraction race tests around the post-put seam**

Give `makeDeps` injectable `getByIdImpl` and `guardedDeleteImpl` functions. Cover these state machines:

```ts
it('retracts its row and drops when the live contact is classified', async () => {
  // Source snapshot: unknown revision 0. Live read: tenant revision 1.
  // Guarded delete: deleted.
  expect(out.suggested).toEqual([]);
  expect(out.decisions).toContainEqual(expect.objectContaining({
    target: 'type',
    outcome: 'dropped',
    dropReason: 'type_already_classified',
  }));
  expect(deps.extraction.deleteTypeSuggestionIfCurrentAtContactRevision)
    .toHaveBeenCalledWith(expect.objectContaining({ target: 'type' }), 1);
});

it('retracts its row with type_classification_changed for a newer Unknown epoch', async () => {
  // Source snapshot: unknown revision 2. Live read: unknown revision 4.
  // Guarded delete: deleted.
  expect(out.decisions[0]).toMatchObject({
    outcome: 'dropped',
    dropReason: 'type_classification_changed',
  });
});

it.each(['suggestion_changed_or_absent'] as const)(
  'preserves a pending decision when guarded cleanup returns %s',
  async (guardedResult) => {
    // A route/finalization marker or replacement writer owns the terminal result.
    expect(out.suggested).toEqual(['type']);
    expect(out.decisions[0]).toMatchObject({ outcome: 'suggested' });
  },
);

it('re-reads after contact_revision_changed and deletes against the new live revision', async () => {
  // Reads revision 1, guard reports contact change, reads revision 2, then deletes.
  expect(getById).toHaveBeenCalledTimes(2);
  expect(guardedDelete).toHaveBeenNthCalledWith(1, expect.anything(), 1);
  expect(guardedDelete).toHaveBeenNthCalledWith(2, expect.anything(), 2);
});
```

Also assert: a stable Unknown contact at the source revision leaves the row pending and never calls guarded delete; a missing live contact or repository exception preserves the pending decision and logs a warning; four repeated contact-revision conflicts stop after the fixed bound; a successful put followed by a successful retract emits exactly one `suggestion.updated` event even though `suggested` is empty.

- [ ] **Step 4: Run the focused apply and decision tests and verify the red state**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionApply.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts
```

Expected: FAIL because apply neither records the contact revision nor performs a live read or guarded cleanup, and the new drop reason is absent.

- [ ] **Step 5: Widen apply dependencies and safe-put results**

First append the exact value to `DROP_REASONS`:

```ts
'type_classification_changed',
```

Use the already-consistent contacts point-read option through the widened pick:

```ts
export interface ApplyDeps {
  contacts: Pick<
    ReturnType<typeof createContactsRepo>,
    'getById' | 'update' | 'addPhone' | 'findByPhone'
  >;
  extraction: Pick<
    ReturnType<typeof createExtractionRepo>,
    | 'putSuggestion'
    | 'deleteSuggestion'
    | 'deleteTypeSuggestionIfCurrentAtContactRevision'
    | 'hasDismissal'
  >;
  // Preserve audit, events, logger, and now.
}
```

Return the immutable row from the safe wrapper:

```ts
type SafePutResult =
  | { ok: true; item: SuggestionItem; displaced?: SuggestionItem }
  | { ok: false; dropReason: 'dismissed_before' | 'repo_error' };

const { item, displaced } = await deps.extraction.putSuggestion(s);
return { ok: true, item, ...(displaced !== undefined && { displaced }) };
```

Do not alter dismissal behavior or any non-type suggestion caller.

- [ ] **Step 6: Implement the bounded extraction reconciliation helper**

Use a fixed local bound and an explicit outcome:

```ts
const TYPE_RECONCILE_ATTEMPTS = 4;

type TypeReconcileOutcome =
  | { state: 'pending' }
  | {
      state: 'dropped';
      dropReason: 'type_already_classified' | 'type_classification_changed';
    };
```

Implement this sequence in a private helper:

```ts
for (let attempt = 0; attempt < TYPE_RECONCILE_ATTEMPTS; attempt += 1) {
  const live = await deps.contacts.getById(ownerContactId, { consistentRead: true });
  if (live === undefined) return { state: 'pending' };

  const liveRevision = contactClassificationRevision(live);
  if (live.type === 'unknown' && liveRevision === sourceRevision) {
    return { state: 'pending' };
  }

  const deleted = await deps.extraction
    .deleteTypeSuggestionIfCurrentAtContactRevision(item, liveRevision);
  if (deleted === 'deleted') {
    return {
      state: 'dropped',
      dropReason: live.type === 'unknown'
        ? 'type_classification_changed'
        : 'type_already_classified',
    };
  }
  if (deleted === 'suggestion_changed_or_absent') {
    return { state: 'pending' };
  }
  // contact_revision_changed loops to a fresh consistent contact read.
}
return { state: 'pending' };
```

Wrap repository reads/deletes in the service's existing best-effort boundary: warn with IDs and revisions only, never values or message bodies, then preserve `pending`. Do not infer a dropped outcome from absence or replacement.

- [ ] **Step 7: Integrate the helper into only the type suggestion branch**

Record `sourceRevision = contactClassificationRevision(contact)` and include it on the put. As soon as the put succeeds, mark `suggestionStateChanged = true` and record any displaced run even if this row is retracted. Then:

```ts
const reconciliation = await reconcileTypeSuggestionAfterPut(
  deps,
  put.item,
  sourceRevision,
);
if (reconciliation.state === 'pending') {
  suggested.push('type');
  decide({
    target: 'type',
    outcome: 'suggested',
    proposedValue: result.typeSuggestion.value,
    coercedValue: result.typeSuggestion.value,
    previousValue: contact.type,
    ...(result.typeSuggestion.reason !== undefined && {
      reason: result.typeSuggestion.reason,
    }),
  });
} else {
  decide({
    target: 'type',
    outcome: 'dropped',
    dropReason: reconciliation.dropReason,
    proposedValue: result.typeSuggestion.value,
    ...(result.typeSuggestion.reason !== undefined && {
      reason: result.typeSuggestion.reason,
    }),
  });
}
```

Change the final event condition to include `suggestionStateChanged`. This covers a briefly published row that was then retracted while keeping the one-event behavior for ordinary writes, suggestions, and notes.

- [ ] **Step 8: Update every typed construction site**

The real worker and dev tick already pass complete repositories; keep those calls unchanged except for any type annotations made explicit by typecheck. Update object-literal fakes in these exact files:

```ts
// app/test/extractionApply.test.ts
contacts.getById = vi.fn(async () => liveContact);
extraction.deleteTypeSuggestionIfCurrentAtContactRevision = vi.fn(
  async () => 'deleted' as const,
);

// app/test/helpers/twilioWebhookHarness.ts
// Read the harness's contacts map/array and suggestions map. Compare the
// contact's logical classification revision first, then the exact suggestion
// identity, and delete only when both match.

// app/test/extractionJob.test.ts
// app/test/extractionJobDraftGuard.test.ts
// app/test/twilioSmsWebhook.test.ts
deleteTypeSuggestionIfCurrentAtContactRevision:
  notImpl('deleteTypeSuggestionIfCurrentAtContactRevision')
    as ExtractionRepo['deleteTypeSuggestionIfCurrentAtContactRevision'],
```

Run `rg -n "satisfies ExtractionRepo|: ExtractionRepo =|: ApplyDeps" app/src app/test` and account for every result. Do not weaken a fake with a cast merely to bypass the new contract.

- [ ] **Step 9: Add a job-level finalization handoff regression**

In `extractionJob.test.ts`, simulate `beginFinalization`, then make the classification route's equivalent delete/marker occur after the suggestion put but before `putRun`. Return `suggestion_changed_or_absent` to apply. Assert the apply decision remains pending and `putRun` preserves the marker's terminal `superseded_by_human_edit` verdict rather than replacing it with `not_presented`:

```ts
expect(record.decisions.type).toMatchObject({
  outcome: 'suggested',
  verdict: 'superseded_by_human_edit',
});
expect(await repo.getSuggestion('c1', 'type')).toBeUndefined();
```

Add the counterexample where apply's own guarded delete returns `deleted`; that run records `outcome: 'dropped'` with the correct drop reason.

- [ ] **Step 10: Run focused app tests and typecheck**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionApply.test.ts test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts test/twilioSmsWebhook.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both commands PASS. Confirm existing Tenant/Landlord type suggestions, note exact-line dedupe, non-type replacement behavior, and suggestion event counts remain green.

- [ ] **Step 11: Commit extraction-side reconciliation**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/services/extraction/runTypes.ts app/src/services/extraction/apply.ts app/src/jobs/extraction.ts app/src/worker.ts app/src/routes/dev.ts app/test/helpers/twilioWebhookHarness.ts app/test/extractionApply.test.ts app/test/extractionJob.test.ts app/test/extractionJobDraftGuard.test.ts app/test/extractionDecisions.test.ts app/test/extractionRunTypes.test.ts app/test/twilioSmsWebhook.test.ts
git commit -m "feat: retract stale AI type suggestions" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the commit contains only extraction-side reconciliation and necessary typed wiring.

---

### Task 4: Resolve type suggestions through the full contact kind

**Files:**
- Create: `app/src/services/extraction/contactKinds.ts`
- Create: `app/test/contactKinds.test.ts`
- Modify: `app/src/routes/contacts.ts:130-180,1386-1559`
- Modify: `app/test/helpers/twilioWebhookHarness.ts:1760-1790,3180-3300`
- Modify: `app/test/contactTriage.test.ts`
- Modify: `app/test/aiRunVerdicts.test.ts`
- Modify: `app/test/suggestions.test.ts`
- Modify: `app/test/todayApi.test.ts`

**Interfaces:**
- Consumes: Task 1's canonical kind union; Task 2's `contactClassificationRevision`, `GuardedTypeDeleteResult`, `sameSuggestionIdentity`, and guarded delete; existing contact PATCH status/conversation/audit behavior; AI run finalization markers.
- Produces: `canonicalSuggestedContactKind(contact)`, an exact Property Manager preset constant, and bounded human-writer reconciliation for every type/role PATCH.

- [ ] **Step 1: Add red pure-kind tests**

Create `app/test/contactKinds.test.ts` with the complete truth table:

```ts
describe('canonicalSuggestedContactKind', () => {
  it.each([
    [{ type: 'tenant', role: '' }, 'tenant'],
    [{ type: 'landlord', role: '' }, 'landlord'],
    [{ type: 'partner', role: '' }, 'partner'],
    [{ type: 'landlord', role: 'Property Manager' }, 'property_manager'],
    [{ type: 'tenant' }, 'tenant'],
  ] as const)('maps %o to %s', (contact, expected) => {
    expect(canonicalSuggestedContactKind(contact)).toBe(expected);
  });

  it.each([
    { type: 'tenant', role: 'Case Manager' },
    { type: 'landlord', role: 'Leasing Agent' },
    { type: 'landlord', role: ' Property Manager' },
    { type: 'landlord', role: 'Property Manager ' },
    { type: 'landlord', role: '   ' },
    { type: 'partner', role: 'Inspector' },
    { type: 'unknown', role: '' },
    { type: 'team_member', role: '' },
  ] as const)('does not compare unsupported stored shape %o', (contact) => {
    expect(canonicalSuggestedContactKind(contact)).toBeUndefined();
  });
});
```

Also assert `PROPERTY_MANAGER_ROLE === 'Property Manager'` exactly.

- [ ] **Step 2: Run the pure test and verify it fails because the module is absent**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactKinds.test.ts
```

Expected: FAIL with a missing-module error for `contactKinds.js`.

- [ ] **Step 3: Implement the backend full-kind resolver**

Create:

```ts
import type { SuggestedContactKind } from '../../adapters/extraction.js';
import type { ContactItem } from '../../repos/contactsRepo.js';

export const PROPERTY_MANAGER_ROLE = 'Property Manager';

type ContactKindShape = Pick<ContactItem, 'type'> & { role?: unknown };

export function canonicalSuggestedContactKind(
  contact: ContactKindShape,
): SuggestedContactKind | undefined {
  const role = typeof contact.role === 'string' ? contact.role : '';
  if (contact.type === 'landlord' && role === PROPERTY_MANAGER_ROLE) {
    return 'property_manager';
  }
  if (role !== '') return undefined;
  if (
    contact.type === 'tenant'
    || contact.type === 'landlord'
    || contact.type === 'partner'
  ) {
    return contact.type;
  }
  return undefined;
}
```

This helper compares verdicts only. It must not trim, case-fold, mutate the contact, or become a second PATCH mapping. Only the exact persisted role `Property Manager` is the preset. Any other non-empty string, including whitespace-only or leading/trailing whitespace, is a custom unsupported role.

- [ ] **Step 4: Re-run the pure-kind tests**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactKinds.test.ts
```

Expected: PASS for all supported and unsupported shapes.

- [ ] **Step 5: Add red contact triage behavior tests**

In `contactTriage.test.ts`, issue real route PATCHes and assert:

```ts
const partner = makeWebhookHarness();
seedUnknownContactAndThread(partner.world);
const partnerResponse = await request(partner.app)
  .patch('/api/contacts/contact-triage-1')
  .set('x-origin-verify', SECRET)
  .set('cookie', TEST_SESSION_COOKIE)
  .send({ type: 'partner', role: '' })
  .expect(200);
expect(partnerResponse.body.contact).toMatchObject({
  type: 'partner',
  status: 'active',
});
expect(partnerResponse.body.contact.role).toBeUndefined();
expect(partner.world.conversations.get('conv-triage-1')?.type)
  .toBe('partner_1to1');

const manager = makeWebhookHarness();
seedUnknownContactAndThread(manager.world);
const managerResponse = await request(manager.app)
  .patch('/api/contacts/contact-triage-1')
  .set('x-origin-verify', SECRET)
  .set('cookie', TEST_SESSION_COOKIE)
  .send({ type: 'landlord', role: 'Property Manager' })
  .expect(200);
expect(managerResponse.body.contact).toMatchObject({
  type: 'landlord',
  role: 'Property Manager',
  status: 'interested',
});
expect(manager.world.conversations.get('conv-triage-1')?.type)
  .toBe('landlord_1to1');
```

Add a standard Landlord PATCH with `role: ''` after a Property Manager record and assert the stale PM role is cleared. Keep existing assertions that only `unknown_1to1` conversations flip and only Tenant schedules immediate triage extraction.

- [ ] **Step 6: Add red verdict tests for complete kinds and role-only edits**

Seed pending type suggestions with contact classification revision zero. Cover:

```ts
it.each([
  ['property_manager', { type: 'landlord', role: 'Property Manager' }, 'accepted'],
  ['property_manager', { type: 'landlord', role: '' }, 'superseded_by_human_edit'],
  ['partner', { type: 'partner', role: '' }, 'accepted'],
  ['landlord', { type: 'landlord', role: 'Leasing Agent' }, 'superseded_by_human_edit'],
] as const)(
  '%s plus %o produces %s',
  async (suggestedValue, patch, verdict) => {
    const { app, world, setVerdict } = makeWorld();
    seedTenant(world, { type: 'unknown', status: 'needs_review' });
    await seedSuggestion(world, {
      ownerContactId: 'c1',
      target: 'type',
      suggestedValue,
      conversationId: 'conv-1',
      runId: 'run-kind',
      contactClassificationRevision: 0,
    });

    await patch(app, 'c1', patch).expect(200);

    expect(await world.extractionRepo.getSuggestion('c1', 'type'))
      .toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith(
      'run-kind',
      'type',
      verdict,
      expect.objectContaining({
        at: expect.any(String),
        expectedVerdict: 'pending',
        freshSuggestionCreatedAt: expect.any(String),
        by: ACTOR,
      }),
    );
  },
);
```

Use a fixed `createdAt` in one case and assert it is passed exactly as `freshSuggestionCreatedAt`, not replaced by verdict time. Add an Edit-contact-shaped role-only case: the stored base is already `landlord`, a pending `property_manager` suggestion exists, and PATCH `{ role: 'Property Manager' }` must accept it. Add role-only `{ role: '' }` from a stored PM against a pending `landlord` suggestion and expect accepted plain Landlord.

Add a legacy pending type suggestion with no `runId`. Classify the contact, then assert the exact row and Today item are removed but `setVerdict` is not called; no originating run exists to stamp.

- [ ] **Step 7: Add red adversarial race tests for the classification drain**

Use the harness's repository hooks to prove each D11 interleaving:

1. Replace the snapshotted type row during `contacts.update`; the route deletes the older-revision replacement, removes it from the contact's pending list and Today, and stamps `superseded_by_human_edit`.
2. Run the same replacement through an Edit-contact role-only PATCH.
3. Start with no pre-write type row, inject one after the contact write with an older contact revision, and assert it is drained.
4. Inject a second older-revision replacement after the first delete; assert a second consistent read and exact guarded delete removes it.
5. Classify, retype to Unknown in a later PATCH, publish a suggestion at the later revision, then release the older route drain; assert the older route receives `contact_revision_changed`, stops, and preserves the new actionable row.
6. Classify that new epoch later with the matching kind and assert accepted.
7. Delete an in-flight extraction row before its run finalizes; assert `beginFinalization` marker plus later `putRun` yields terminal `superseded_by_human_edit`, not pending or `not_presented`. Assert the route call includes `target: 'type'`, `expectedVerdict: 'pending'`, the candidate's exact `createdAt` as `freshSuggestionCreatedAt`, route actor, and route verdict time.

Each test must assert all three surfaces: repository row, contact suggestion list or Today row, and AI run verdict.

- [ ] **Step 8: Run the route tests and verify the intended red state**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts
```

Expected: FAIL because current type verdicts compare only `parsed.patch.type`, role-only edits do not resolve target `type`, and replacement rows remain pending.

- [ ] **Step 9: Separate generic field cleanup from kind cleanup**

Before the contact write:

```ts
const changesKind = 'type' in parsed.patch || 'role' in parsed.patch;
let pendingTypeBefore: SuggestionItem | undefined;
if (changesKind) {
  try {
    pendingTypeBefore = await extraction.getSuggestion(
      contactId,
      'type',
      { consistentRead: true },
    );
  } catch (err) {
    log.warn(
      { err, contactId },
      'type suggestion pre-write read failed (best-effort)',
    );
  }
}
```

Keep the existing `pendingByField` snapshot and exact delete for non-type fields. Skip `f === 'type'` in that generic loop so target `type` is handled once by the new protocol. A `role` suggestion target, if one exists in legacy data, retains generic cleanup; the special path always addresses target `type`. The pre-write read is advisory only: a read failure must be logged and must not block the contact PATCH or the post-write drain.

- [ ] **Step 10: Implement bounded older-revision draining after the contact write**

Use the `classification_revision` returned by `contacts.update`, not the pre-read and not a request-start token:

```ts
const committedRevision = contactClassificationRevision(updated);
const appliedKind = canonicalSuggestedContactKind(updated);
// Reuse the existing verdictAt binding shared with generic non-type cleanup.
```

Keep exactly one `const verdictAt = new Date().toISOString()` in the existing post-write scope and share it between the retained generic non-type loop and this type drain; do not redeclare it. Implement a maximum of four guarded delete attempts. If the pre-write snapshot is empty or failed, the first iteration must perform a post-write consistent point read before deciding there is nothing to drain. After every delete attempt, clear the candidate so the next iteration performs another consistent point read:

```ts
let candidate = pendingTypeBefore;
for (let attempt = 0; attempt < 4; attempt += 1) {
  if (candidate === undefined) {
    try {
      candidate = await extraction.getSuggestion(contactId, 'type', {
        consistentRead: true,
      });
    } catch (err) {
      log.warn({ err, contactId }, 'type suggestion drain read failed (best-effort)');
      return;
    }
    if (candidate === undefined) return;
  }

  const candidateContactRevision =
    candidate.contactClassificationRevision ?? 0;
  if (candidateContactRevision >= committedRevision) return;

let result: GuardedTypeDeleteResult;
  try {
    result = await extraction
      .deleteTypeSuggestionIfCurrentAtContactRevision(candidate, committedRevision);
  } catch (err) {
    log.warn({ err, contactId }, 'type suggestion drain failed (best-effort)');
    return;
  }
  if (result === 'contact_revision_changed') return;
  if (result === 'suggestion_changed_or_absent') {
    candidate = undefined;
    continue;
  }

  const wasPrewriteIdentity = pendingTypeBefore !== undefined
    && sameSuggestionIdentity(candidate, pendingTypeBefore);
  const verdict = wasPrewriteIdentity
    && appliedKind !== undefined
    && normalizeSuggestionValue('type', candidate.suggestedValue)
      === normalizeSuggestionValue('type', appliedKind)
      ? 'accepted'
      : 'superseded_by_human_edit';
  if (candidate.runId !== undefined) {
    try {
      await aiRuns.setVerdict(candidate.runId, 'type', verdict, {
        at: verdictAt,
        expectedVerdict: 'pending',
        freshSuggestionCreatedAt: candidate.createdAt,
        ...(req.user?.userId !== undefined && { by: req.user.userId }),
      });
    } catch (err) {
      log.warn(
        { err, contactId, field: 'type' },
        'ai run verdict stamp failed (best-effort)',
      );
    }
  }
  candidate = undefined;
}
```

The identity comparison must prefer `revision`, then use the exact legacy `createdAt` and present-or-absent `runId` fallback. A row without `runId` is still deleted when safe but has no AI run to stamp. A post-write replacement always gets `superseded_by_human_edit`, even if its value equals `appliedKind`. Stop without deleting when the candidate belongs to the same or a newer classification revision. If the first successful post-write consistent read returns no row, a publication after that read is owned by the extraction writer's post-put contact check from Task 3; do not add polling. Log a warning if four older replacements exhaust the bound. Never fail the already-committed contact PATCH for pre-read, drain-read, guarded-delete, or verdict errors.

- [ ] **Step 11: Preserve existing route-owned downstream behavior**

Do not create a new classification endpoint. Keep these existing blocks and prove them with the focused tests:

```ts
// Tenant -> onboarding, tenant_1to1, immediate triage extraction when enabled.
// Landlord and PM -> interested, landlord_1to1, no tenant extraction.
// Partner -> active, partner_1to1, no tenant extraction.
// Only unknown_1to1 linked conversations are rewritten.
```

Run the special drain after every PATCH carrying `type` or `role`, including `type: 'unknown'`. Keep all non-type suggestion resolution, audit, SSE, and status behavior intact.

- [ ] **Step 12: Keep generic type accept refused and extend the harness faithfully**

Retain this existing assertion in `suggestions.test.ts`:

```ts
expect(res.status).toBe(400);
expect(res.body.error).toBe('accept_type_via_triage');
```

Update the in-memory contact update fake so a supplied `type` or `role` atomically advances its logical revision before returning the contact. Implement the guarded delete fake with both revision checks and exact suggestion identity. Add injection hooks at the consistent read and guarded delete boundaries rather than adding test-only production branches.

- [ ] **Step 13: Run focused route tests and app typecheck**

Run:

```powershell
npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both commands PASS. Explicitly confirm Partner/PM status and conversation types, role clearing, full-kind verdicts, both UI-writer PATCH shapes, empty-snapshot and two-replacement races, re-opened Unknown epoch protection, finalization-marker handoff, Today cleanup, and generic accept refusal.

- [ ] **Step 14: Commit human-PATCH reconciliation**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/services/extraction/contactKinds.ts app/test/contactKinds.test.ts app/src/routes/contacts.ts app/test/helpers/twilioWebhookHarness.ts app/test/contactTriage.test.ts app/test/aiRunVerdicts.test.ts app/test/suggestions.test.ts app/test/todayApi.test.ts
git commit -m "feat: resolve AI suggestions by full contact kind" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the route changes stay on the existing PATCH surface and the commit contains no dashboard code.

---

### Task 5: Add four-kind staff UI and decision labels

**Files:**
- Modify: `dashboard/src/routes/contact/contactProfile.ts:1-33`
- Modify: `dashboard/src/routes/contact/contactProfile.test.ts`
- Modify: `dashboard/src/routes/contact/KindPicker.tsx:1-10,92-113`
- Modify: `dashboard/src/routes/contact/KindPicker.test.tsx`
- Modify: `dashboard/src/routes/contact/UnknownFile.tsx:1-118`
- Modify: `dashboard/src/routes/contact/UnknownFile.module.css:7-11`
- Modify: `dashboard/src/routes/contact/UnknownFile.test.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx:1-20,637-647,1035-1048`
- Modify: `dashboard/src/routes/contact/ContactDetail.test.tsx`
- Modify: `dashboard/src/routes/contact/ContactEditForm.test.tsx`
- Modify: `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:1-70`
- Modify: `dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx`

**Interfaces:**
- Consumes: the existing dashboard `ContactType`, `ContactPatch`, `PM_ROLE`, `updateContact`, `KindPicker`, Unknown contact view, and AI run detail.
- Produces: dashboard `SuggestedContactKind`, exact label mapping, exact kind-to-PATCH mapping, four accessible triage actions, and type-ledger humanization.

- [ ] **Step 1: Add red dashboard mapping tests**

Extend `contactProfile.test.ts` with the complete map and fallback behavior:

```ts
it.each([
  ['tenant', 'Tenant', { type: 'tenant', role: '' }],
  ['landlord', 'Landlord', { type: 'landlord', role: '' }],
  ['partner', 'Partner', { type: 'partner', role: '' }],
  [
    'property_manager',
    'Property Manager',
    { type: 'landlord', role: 'Property Manager' },
  ],
] as const)('maps %s to its label and PATCH', (kind, label, patch) => {
  expect(suggestedContactKindLabel(kind)).toBe(label);
  expect(patchForSuggestedContactKind(kind)).toEqual(patch);
});

it('leaves an unknown forensic value unchanged', () => {
  expect(suggestedContactKindLabel('caseworker')).toBe('caseworker');
});
```

- [ ] **Step 2: Run the mapping test and verify the new exports are absent**

Run:

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/contactProfile.test.ts
```

Expected: FAIL because the kind union, label helper, and PATCH helper do not exist.

- [ ] **Step 3: Implement the dashboard boundary map**

Import `ContactPatch` and add:

```ts
export type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';

export const SUGGESTED_CONTACT_KIND_LABEL: Record<SuggestedContactKind, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  partner: 'Partner',
  property_manager: PM_ROLE,
};

const KIND_PATCH: Record<
  SuggestedContactKind,
  Required<Pick<ContactPatch, 'type' | 'role'>>
> = {
  tenant: { type: 'tenant', role: '' },
  landlord: { type: 'landlord', role: '' },
  partner: { type: 'partner', role: '' },
  property_manager: { type: 'landlord', role: PM_ROLE },
};

export function suggestedContactKindLabel(value: string): string {
  return Object.prototype.hasOwnProperty.call(SUGGESTED_CONTACT_KIND_LABEL, value)
    ? SUGGESTED_CONTACT_KIND_LABEL[value as SuggestedContactKind]
    : value;
}

export function patchForSuggestedContactKind(
  kind: SuggestedContactKind,
): Required<Pick<ContactPatch, 'type' | 'role'>> {
  return { ...KIND_PATCH[kind] };
}
```

Returning a copy prevents a caller from mutating the module-level map.

- [ ] **Step 4: Refactor KindPicker to consume the one dashboard map**

Keep the existing segment values and Other mode. For the four canonical segments, use:

```ts
const canonicalKind: SuggestedContactKind = seg === 'pm'
  ? 'property_manager'
  : seg;
const patch = patchForSuggestedContactKind(canonicalKind);
setOtherSelected(false);
onChange({ type: patch.type, role: patch.role });
```

Retain `PM_ROLE` for exact-preset detection. Existing KindPicker tests must still prove Tenant/Landlord/Partner clear role, PM writes the exact preset, and Other custom roles remain untouched.

- [ ] **Step 5: Add red Unknown card tests for labels, order, callbacks, and disabled state**

Refactor the test render helper to accept `onTriage` and `triaging`, and add a complete suggestion factory:

```ts
function typeSuggestion(suggestedValue: string): SuggestionItem {
  return {
    itemId: 'sugg#u9#type',
    ownerContactId: 'u9',
    target: 'type',
    suggestedValue,
    reason: 'stated role',
    conversationId: 'conv-1',
    createdAt: '2026-08-26T10:00:00.000Z',
  };
}

function renderIt(opts: {
  suggestions?: SuggestionItem[];
  onTriage?: (kind: SuggestedContactKind) => void;
  triaging?: boolean;
} = {}): void {
  render(
    <MemoryRouter>
      <UnknownFile
        contact={UNKNOWN}
        phones={[{ phone: '+15550100001', primary: true }]}
        placements={[]}
        units={[]}
        media={[]}
        suggestions={opts.suggestions ?? []}
        onTriage={opts.onTriage ?? vi.fn()}
        triaging={opts.triaging}
        groupThreadsPending={false}
        groupThreads={[]}
        groupThreadsTruncated={false}
      />
    </MemoryRouter>,
  );
}
```

Then add:

```ts
it.each([
  ['partner', 'Partner'],
  ['property_manager', 'Property Manager'],
] as const)('shows the exact %s suggestion label', (value, label) => {
  renderIt({ suggestions: [typeSuggestion(value)] });
  expect(screen.getByText(`AI suggests: ${label} - stated role`)).toBeInTheDocument();
});

it('renders four actions in KindPicker order and reports canonical kinds', async () => {
  const onTriage = vi.fn();
  const user = userEvent.setup();
  renderIt({ onTriage });
  const buttons = screen.getAllByRole('button').filter(
    (button) => button.textContent?.startsWith('Mark as '),
  );
  expect(buttons.map((button) => button.textContent)).toEqual([
    'Mark as Tenant',
    'Mark as Landlord',
    'Mark as Partner',
    'Mark as Property Manager',
  ]);
  await user.click(screen.getByRole('button', { name: 'Mark as Partner' }));
  await user.click(screen.getByRole('button', { name: 'Mark as Property Manager' }));
  expect(onTriage).toHaveBeenNthCalledWith(1, 'partner');
  expect(onTriage).toHaveBeenNthCalledWith(2, 'property_manager');
});

it('disables all four actions during one in-flight classification', () => {
  renderIt({ triaging: true });
  for (const name of [
    'Mark as Tenant',
    'Mark as Landlord',
    'Mark as Partner',
    'Mark as Property Manager',
  ]) {
    expect(screen.getByRole('button', { name })).toBeDisabled();
  }
});
```

- [ ] **Step 6: Run Unknown card tests and verify the old two-action card fails**

Run:

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/UnknownFile.test.tsx
```

Expected: FAIL because `property_manager` renders as `Property_manager`, Partner/PM buttons are missing, and the callback union permits only two values.

- [ ] **Step 7: Render the four exact actions and wrap them at narrow widths**

In `UnknownFile.tsx`, remove `capitalize`, import the helpers and type, widen the callback, and write the copy and actions explicitly:

```tsx
onTriage?: (kind: SuggestedContactKind) => void;

<p className={styles.note}>
  This contact hasn&apos;t been classified yet. Classify them as a Tenant,
  Landlord, Partner, or Property Manager to file them correctly and unlock the
  matching workspace.
</p>

{typeSuggestion ? (
  <p className={styles.aiSuggest}>
    {`AI suggests: ${suggestedContactKindLabel(typeSuggestion.suggestedValue)}`}
    {typeSuggestion.reason ? ` - ${typeSuggestion.reason}` : null}
  </p>
) : null}
```

Render four `Button`s in Tenant, Landlord, Partner, Property Manager order, each with the existing `disabled={triaging || !onTriage}` rule and its canonical callback value. In CSS:

```css
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
```

- [ ] **Step 8: Add red ContactDetail PATCH tests for all four kinds and retry**

Replace the old bare-type Tenant expectation and add a table-driven test:

```ts
it.each([
  ['Tenant', 'tenant', { type: 'tenant', role: '' }],
  ['Landlord', 'landlord', { type: 'landlord', role: '' }],
  ['Partner', 'partner', { type: 'partner', role: '' }],
  [
    'Property Manager',
    'property_manager',
    { type: 'landlord', role: 'Property Manager' },
  ],
] as const)(
  'Mark as %s sends the complete kind PATCH',
  async (label, _kind, patch) => {
    updateContact.mockResolvedValue({ ...UNKNOWN, ...patch });
    renderAt('u9');
    await user.click(screen.getByRole('button', { name: `Mark as ${label}` }));
    expect(updateContact).toHaveBeenCalledWith('u9', patch);
  },
);
```

Add a rejected `updateContact` case and assert the Unknown view remains, the same four buttons re-enable, and no optimistic kind is displayed. For Partner and Property Manager successful returns, assert the page derives Partner and Property Manager from the returned contact.

- [ ] **Step 9: Implement ContactDetail triage through the canonical map**

Change only the callback:

```ts
const onTriage = (kind: SuggestedContactKind): void => {
  if (triaging) return;
  setTriaging(true);
  void updateContact(contact.contactId, patchForSuggestedContactKind(kind))
    .then((updated) => setContact(updated))
    .catch(() => {
      // Stay on the Unknown view; all actions become retryable in finally.
    })
    .finally(() => setTriaging(false));
};
```

Do not add a client-side suggestion resolution call. The returned contact remains the only state transition.

- [ ] **Step 10: Pin the existing Edit contact writer to the shared mapping**

Keep `ContactEditForm` on `updateContact` and keep its diff-only PATCH behavior. Add or retain tests proving:

```ts
// Unknown -> PM edit selection
expect(updateContact).toHaveBeenCalledWith(contactId, {
  type: 'landlord',
  role: 'Property Manager',
});

// Stored PM -> plain Landlord selection
expect(updateContact).toHaveBeenCalledWith(contactId, { role: '' });
```

The role-only second case is intentional: Task 4 makes any role-carrying PATCH reconcile target `type`. Do not add a second suggestion-resolution API call to the form.

- [ ] **Step 11: Add red AI run ledger tests**

In `AiRunsSection.test.tsx`, render a run whose type decision proposes `property_manager`, whose raw text contains `property_manager`, and whose parsed result contains the same canonical value. Assert:

```ts
const decisions = screen.getByRole('table', { name: 'Decisions' });
expect(within(decisions).getByText('Property Manager')).toBeInTheDocument();
expect(within(decisions).queryByText('property_manager')).not.toBeInTheDocument();

expect(screen.getByText('Raw model response').parentElement).toHaveTextContent(
  'property_manager',
);
expect(screen.getByText('Parsed result').parentElement).toHaveTextContent(
  'property_manager',
);
```

Add a non-type decision with an underscore and assert its existing rendering does not change.

- [ ] **Step 12: Humanize only the type decision's proposed cell**

Import `suggestedContactKindLabel` and derive:

```ts
function proposedDecisionValue(
  target: string,
  decision: AiRunDecision,
): string {
  const proposed = decision.proposedValue ?? decision.proposedOp;
  return target === 'type'
    ? suggestedContactKindLabel(proposed)
    : proposed;
}
```

Use it only in the Decision ledger's Proposed cell. Leave `run.rawText` and `run.rawResult` rendering byte-for-byte on their existing paths.

- [ ] **Step 13: Run the complete dashboard slice and typecheck**

Run:

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/contactProfile.test.ts src/routes/contact/UnknownFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/ContactEditForm.test.tsx src/routes/contact/KindPicker.test.tsx src/routes/settings/aiRuns/AiRunsSection.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands PASS. Confirm the old Tenant/Landlord tests now expect both `type` and `role`, all four actions share busy state, edit behavior uses the same mapping, PM displays distinctly, and raw forensic panes remain canonical.

- [ ] **Step 14: Commit the staff UI**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add dashboard/src/routes/contact/contactProfile.ts dashboard/src/routes/contact/contactProfile.test.ts dashboard/src/routes/contact/KindPicker.tsx dashboard/src/routes/contact/KindPicker.test.tsx dashboard/src/routes/contact/UnknownFile.tsx dashboard/src/routes/contact/UnknownFile.module.css dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/routes/contact/ContactEditForm.test.tsx dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx
git commit -m "feat: offer four AI contact kind actions" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the commit contains no API shape change and no new message-catalog entry because this task adds staff UI, not automated outbound messaging.

---

### Task 6: Activate the four-kind extraction contract

**Files:**
- Modify: `app/src/services/extraction/schema.ts:119-128,242-251,420-429`
- Modify: `app/src/services/extraction/prompt.ts:14-29,50-90`
- Test: `app/test/extractionSchema.test.ts`
- Test: `app/test/extractionOps.test.ts`

**Interfaces:**
- Consumes: Task 1's `SuggestedContactKind` union and the completed extraction, PATCH, and dashboard consumers from Tasks 2-5.
- Produces: the exact schema enum `['tenant', 'landlord', 'property_manager', 'partner', 'none']`, an applicable parser for the four canonical kinds, preserved raw attempted-output diagnostics, and a prompt contract that classifies the current external contact only.
- Activation gate: do not begin this task until the focused checks for Tasks 2-5 pass. This is the first task allowed to make a real model response produce Partner or Property Manager.

- [ ] **Step 1: Add red parser, schema, and raw-operation tests**

Pin the nested enum, both newly applicable values, the `none` fold, unsupported applicable output, and unchanged raw diagnostics:

```ts
it('pins the complete staff-facing kind enum plus the none sentinel', () => {
  const typeSuggestion = (
    EXTRACTION_SCHEMA.properties as Record<string, Record<string, unknown>>
  )['typeSuggestion'];
  const properties = typeSuggestion?.['properties']
    as Record<string, Record<string, unknown>>;
  expect(properties['value']?.['enum']).toEqual([
    'tenant',
    'landlord',
    'property_manager',
    'partner',
    'none',
  ]);
});

it.each(['partner', 'property_manager'] as const)(
  'parses the canonical %s kind',
  (kind) => {
    const result = parseExtractionText(JSON.stringify({
      fields: {},
      typeSuggestion: { value: kind, reason: 'clear self-identification' },
    }));
    expect(result.typeSuggestion).toEqual({
      value: kind,
      reason: 'clear self-identification',
    });
  },
);

it('folds none and an unsupported kind to no applicable type suggestion', () => {
  const none = parseExtractionText(JSON.stringify({
    fields: {},
    typeSuggestion: { value: 'none', reason: '' },
  }));
  const unsupported = parseExtractionText(JSON.stringify({
    fields: {},
    typeSuggestion: { value: 'caseworker', reason: 'off enum' },
  }));
  expect(none.typeSuggestion).toBeUndefined();
  expect(unsupported.typeSuggestion).toBeUndefined();
});

it.each(['partner', 'property_manager'])(
  'retains %s as the attempted type operation',
  (kind) => {
    expect(parseExtractionOps(JSON.stringify({
      typeSuggestion: { value: kind, reason: 'stated role' },
    })).type).toEqual({ op: 'suggest', value: kind, reason: 'stated role' });
  },
);
```

Retain the existing off-enum `caseworker` assertion as `op: 'suggest'`; raw attempted output must not be rewritten into a decline.

- [ ] **Step 2: Add red prompt-contract tests**

Add explicit positive and negative phrases:

```ts
it('classifies the current external contact into four mutually exclusive kinds', () => {
  const sys = buildExtractionSystemPrompt();
  expect(sys).toContain('CURRENT external contact');
  const examples = [
    ['I am looking for a two-bedroom home for my family', 'Tenant'],
    ['I own three rental properties', 'Landlord'],
    ['I manage three properties for the owner', 'Property Manager'],
    ['I am her caseworker at Hope Atlanta', 'Partner'],
    ['My caseworker at Hope Atlanta told me to call', 'Tenant'],
    ['I am calling about a client', 'none'],
  ] as const;
  for (const [phrase, expected] of examples) {
    const line = sys.split('\n').find((candidate) => candidate.includes(phrase));
    expect(line, phrase).toBeDefined();
    expect(line).toContain(`-> ${expected}`);
  }
  const managerLine = sys.split('\n')
    .find((line) => line.includes('I manage three properties for the owner'));
  expect(managerLine).toContain('not Landlord and not Partner');
  const mentionedCaseworkerLine = sys.split('\n')
    .find((line) => line.includes('My caseworker at Hope Atlanta told me to call'));
  expect(mentionedCaseworkerLine).toContain(
    'mentioned caseworker is not the contact',
  );
  expect(sys).toContain('value "none"');
});

it('requires current-transcript evidence and preserves concise role notes', () => {
  const sys = buildExtractionSystemPrompt();
  expect(sys).toContain('current transcript');
  expect(sys).toContain('Identified as a caseworker at Hope Atlanta');
  expect(sys).toContain('Identified as property manager for Example Homes');
  expect(sys).toContain('never infer an organization');
  expect(sys).toContain('RECONCILE every noteLine against the profile notes');
});
```

- [ ] **Step 3: Run the focused tests and verify both intended red causes**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
```

Expected: FAIL because the live schema/parser still permit only Tenant and Landlord and because the prompt still has the old tenant-biased rule. The existing off-enum diagnostic assertion must remain green.

- [ ] **Step 4: Widen the structured schema and applicable parser**

Use the canonical union from Task 1:

```ts
const SUGGESTED_CONTACT_KINDS = [
  'tenant',
  'landlord',
  'property_manager',
  'partner',
] as const satisfies readonly SuggestedContactKind[];

function isSuggestedContactKind(value: unknown): value is SuggestedContactKind {
  return typeof value === 'string'
    && (SUGGESTED_CONTACT_KINDS as readonly string[]).includes(value);
}
```

Set the schema enum to the four values plus `none`. Parse only `isSuggestedContactKind(typeSuggestion.value)`. Keep `parseExtractionOps` stringly so every non-empty value except `none` remains an attempted suggestion for forensic review.

- [ ] **Step 5: Replace the prompt classification block**

Write an explicit rule block equivalent to:

```ts
const kindRules = [
  '- typeSuggestion is about the CURRENT external contact whose transcript lines use the existing "client" speaker label.',
  '- Use it only when CURRENT PROFILE.contactType is "unknown" and the current transcript clearly establishes exactly one kind.',
  '- Tenant: seeks housing for themselves or their household.',
  '- Landlord: owns or personally offers housing they control.',
  '- Property Manager: manages, leases, lists, or coordinates properties for an owner or landlord; working for a landlord is not Partner and does not make the contact Landlord.',
  '- Partner: works in an outside service, program, agency, inspection, or navigation role and is not the housing seeker, owner, or property manager.',
  '- A represented or mentioned person never determines this contact kind and their facts never belong on this profile.',
  '- Do not guess from an organization name or one ambiguous word such as "manager", "agent", or "client". When evidence overlaps or is unclear, emit value "none".',
  '- A clear Partner or Property Manager identification also adds one concise role or organization noteLine, using only stated facts and the existing note reconciliation rules.',
];
```

Include the six approved D3 examples verbatim in meaning, retain `client` and `speakerRoles` wire labels, remove the old caseworker suppression, and do not pin a literal prompt fingerprint. `extractionPromptFingerprint()` already hashes the prompt and schema bytes.

- [ ] **Step 6: Run focused contract tests and app typecheck**

Run:

```powershell
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both commands PASS. Confirm the optional-parameter-count test remains green and the prompt fingerprint derives a new value without a hard-coded expectation.

- [ ] **Step 7: Commit runtime activation**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add app/src/services/extraction/schema.ts app/src/services/extraction/prompt.ts app/test/extractionSchema.test.ts app/test/extractionOps.test.ts
git commit -m "feat: activate four AI contact kinds" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the commit contains only the runtime contract and its tests. Every persistence, route, and dashboard consumer is already present and green.

---

### Task 7: Prove Partner and Property Manager end-to-end and close the issue

**Files:**
- Modify: `e2e/tests/flows/conversation-fact-extraction.spec.ts:1-90,268-300`
- Modify: `docs/issues/caseworker-contact-type.md`

**Interfaces:**
- Consumes: the existing hermetic fake extraction marker, inbound SMS capture, synchronous extraction tick, authenticated contact API, ContactDetail Unknown view, Today queue, and conversation resolver.
- Produces: two accessibility-first end-to-end flows proving the exact stored kind, status, conversation type, note, UI label, and suggestion cleanup.

- [ ] **Step 1: Add API assertion helpers beside the existing fresh-contact helper**

Use authenticated Playwright requests and existing endpoints:

```ts
async function readContact(
  request: APIRequestContext,
  contactId: string,
): Promise<Record<string, unknown>> {
  const res = await request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(res.ok(), `read contact ${contactId}`).toBeTruthy();
  return (await res.json()).contact as Record<string, unknown>;
}

async function readConversationType(
  request: APIRequestContext,
  contactId: string,
): Promise<string> {
  const res = await request.post(`${NEXT}/api/contacts/${contactId}/conversation`);
  expect(res.ok(), `resolve conversation ${contactId}`).toBeTruthy();
  return (await res.json()).conversation.type as string;
}

function formattedPhone(phone: string): string {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
}
```

- [ ] **Step 2: Add the Partner acceptance flow**

Use a fresh unknown contact and the deterministic fake payload:

```ts
await sendExtractSms(request, phone, {
  typeSuggestion: {
    value: 'partner',
    reason: 'caseworker at Hope Atlanta',
  },
  noteLines: ['Identified as a caseworker at Hope Atlanta'],
});
```

After `extractionTick`, assert the Needs triage section shows `AI suggests: Partner`, all four buttons exist, and click `Mark as Partner`. Then assert:

```ts
await expect(page.getByRole('button', { name: 'Mark as Partner' })).toHaveCount(0);
await expect(page.getByText('Partner', { exact: true })).toBeVisible();

expect(await readContact(page.request, contactId)).toMatchObject({
  type: 'partner',
  status: 'active',
});
expect((await readContact(page.request, contactId))['role']).toBeUndefined();
expect(String((await readContact(page.request, contactId))['notes']))
  .toContain('Identified as a caseworker at Hope Atlanta');
expect(await readConversationType(page.request, contactId)).toBe('partner_1to1');
```

Navigate to `/`, await Today readiness, and assert no `AI suggestions to review` list item contains the formatted phone.

- [ ] **Step 3: Add the Property Manager acceptance flow**

Use a second fresh unknown contact:

```ts
await sendExtractSms(request, phone, {
  typeSuggestion: {
    value: 'property_manager',
    reason: 'manages properties for the owner',
  },
  noteLines: ['Identified as property manager for Example Homes'],
});
```

Assert exact `AI suggests: Property Manager`, click `Mark as Property Manager`, and prove:

```ts
await expect(page.getByRole('button', { name: 'Mark as Property Manager' }))
  .toHaveCount(0);
await expect(page.getByText('Property Manager', { exact: true })).toBeVisible();

expect(await readContact(page.request, contactId)).toMatchObject({
  type: 'landlord',
  role: 'Property Manager',
  status: 'interested',
});
expect(String((await readContact(page.request, contactId))['notes']))
  .toContain('Identified as property manager for Example Homes');
expect(await readConversationType(page.request, contactId)).toBe('landlord_1to1');
```

Again assert the contact's formatted phone is absent from the Today AI-suggestion group.

- [ ] **Step 4: Run the focused post-implementation acceptance regression**

Run only through the e2e workspace:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/flows/conversation-fact-extraction.spec.ts
```

Expected after Tasks 1-6: PASS, including the existing extraction scenarios in the file. This e2e is a post-implementation acceptance and regression proof, not a fabricated red-state step; the earlier backend and dashboard tasks own the behavioral red/green tests. Do not invoke root Playwright directly.

- [ ] **Step 5: Tighten selectors or assertions only when evidence shows a real mismatch**

Use `getByRole`, `getByText`, and scoped Needs-triage sections. If a failure is a product defect, fix the owning Task 1-6 file and rerun that task's focused unit tests before rerunning this e2e file. Do not replace an accessibility selector with `data-testid`, extend timeouts without a timing diagnosis, or use the human's live `:5174` or `:8080` lane.

- [ ] **Step 6: Resolve the tracked issue after the proof is green**

Change frontmatter to:

```yaml
status: resolved
updated: 2026-08-26
resolved: 2026-08-26
```

Append a Resolution section that records:

```markdown
## Resolution

Resolved by `feat/ai-contact-kind-suggestions`. The extraction contract now
supports Partner and the existing Property Manager preset, the Unknown card
offers all four canonical kind actions, and type suggestions are reconciled
against kind-changing contact revisions. Property Manager remains a Landlord-
based record with the exact `Property Manager` role. The change is forward-only:
no existing contact or suggestion was scanned or backfilled.
```

Update stale refs in the issue body only when the new symbol names make the old references misleading; preserve its history and related issue links.

- [ ] **Step 7: Regenerate the local issue index and re-run the focused e2e**

Run:

```powershell
npm run issues
npm run e2e -w @housingchoice/e2e -- tests/flows/conversation-fact-extraction.spec.ts
```

Expected: `npm run issues` reports `caseworker-contact-type` under resolved items and changes only the gitignored index; the e2e file PASSes. Do not stage `docs/issues/INDEX.md`.

- [ ] **Step 8: Commit end-to-end proof and issue resolution**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git add e2e/tests/flows/conversation-fact-extraction.spec.ts docs/issues/caseworker-contact-type.md
git commit -m "test: prove AI partner and property manager triage" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

Expected: the commit contains the two new e2e flows and the resolved issue record; no seed, fixture payload type, or generated index is staged.

---

### Task 8: Final sync, complete gates, adversarial review, and hermetic self-QA

**Files:**
- Inspect: every file changed by `git diff --name-only main...HEAD`
- Modify: only files required by evidence from the final gates, adversarial review, or live self-QA
- Record: `.superpowers/build-log.md`

**Interfaces:**
- Consumes: all seven implementation tasks and the repository's feature-mission completion policy.
- Produces: one final sync with current local `main`, exact gate evidence, no-new-errors touched-file lint evidence, independent review fixes, and live proof for Partner and Property Manager.

- [ ] **Step 1: Inspect branch state and perform the one final main sync**

Run:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
git rev-parse HEAD
git rev-parse main
git log --oneline --decorate -5 main
```

Expected: the feature worktree is clean and no merge is in progress. If local `main` advanced from the approved base, merge it into this feature branch once with `git merge --no-edit main`; preserve both sides' intent and rerun every focused test affected by a conflict. Never merge the feature branch into `main`. If active work makes that sync conflict-prone, stop and request human direction before moving either branch.

- [ ] **Step 2: Run the focused proof matrix after the sync**

Run each command bare and record its exit code:

```powershell
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts test/extractionApply.test.ts test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/extractionRepo.test.ts test/extractionRepo.integration.test.ts test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts
npm run test -w @housingchoice/dashboard -- src/routes/contact/contactProfile.test.ts src/routes/contact/UnknownFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/ContactEditForm.test.tsx src/routes/contact/KindPicker.test.tsx src/routes/settings/aiRuns/AiRunsSection.test.tsx
npm run e2e -w @housingchoice/e2e -- tests/flows/conversation-fact-extraction.spec.ts
```

Expected: all commands PASS. If a DynamoDB suite fails first on timeouts or SQLite locks, follow `AGENTS.md`: use a clean access key to distinguish residue from a product regression before changing code.

- [ ] **Step 3: Run the required full feature gates in exact order**

Ensure DynamoDB Local is reachable, then run these commands separately, without pipes or output filters:

```powershell
npm run db:start
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Expected: all five required gates exit `0`; `npm run db:start` is setup, not one of the five gates. The touched source list is non-empty. If lint reports errors, run the same paths at the merge base and block only errors absent from that baseline; name any pre-existing errors in the handback. Remember that a green `.js` or `.mjs` result may mean the current ESLint config checked no rules.

- [ ] **Step 4: Request independent adversarial implementation review**

Give a fresh reviewer the approved spec, this plan, the branch diff, focused-test evidence, and full-gate exit codes. Require the reviewer to attack:

1. Property Manager versus Landlord/Partner semantics.
2. Current-contact versus mentioned-person prompt rules.
3. Exact absent-or-zero DynamoDB condition behavior.
4. Extraction deletion ownership and finalization-marker preservation.
5. Empty prewrite, replacement, second replacement, later Unknown epoch, and role-only PATCH races.
6. Existing generic non-type replacement behavior and generic type-accept refusal.
7. Dashboard mapping drift, four-button accessibility/busy state, and raw forensic preservation.
8. Forward-only scope, with no import, seed, migration, production, infra, or deploy mutation.

The reviewer must report findings with severity, exact file/line evidence, and a reproducible test or interleaving. It must also name attacked sections that held.

- [ ] **Step 5: Adjudicate review findings and rerun affected checks**

For every finding, record accepted or rejected with evidence in the build log. For an accepted finding, add a failing regression test first, implement the smallest correction, rerun that focused test, and rerun every full gate affected by the fix. Do not broaden scope to unrelated debt; file a follow-up issue only when the approved behavior cannot safely include the finding.

- [ ] **Step 6: Perform hermetic interactive live self-QA**

Start an isolated lane from this worktree:

```powershell
npm run e2e:session
```

Using the isolated browser profile and dev login, create two fresh Unknown contacts through fake inbound SMS markers. For Partner, verify exact suggestion label/reason, note, four actions, busy state, Partner header/file, `active`, `partner_1to1`, and removal from Needs triage and Today. For Property Manager, verify exact spaced label, PM header/file, stored Landlord base plus exact role, `interested`, `landlord_1to1`, and removal from Needs triage and Today. Resize to a narrow viewport and verify the four actions wrap without horizontal overflow. Capture screenshots under `.playwright-mcp/` and keep them untracked.

After QA:

```powershell
npm run e2e:stop
```

Expected: the hermetic session stops cleanly and no listener survives on its lane ports. Do not inspect or mutate production and do not use lane 0.

- [ ] **Step 7: Commit only evidence-driven fixes, then leave a clean branch**

If final review or QA changed code, repeat the relevant focused checks and all required gates, then commit explicit paths:

```powershell
git status --short --branch
git rev-parse -q --verify MERGE_HEAD
```

Then run one `git add --` command per literal path changed by the review or QA, reading each path directly from the clean-before-review status delta. Do not use a glob, directory, or generated path list. After verifying the staged diff, run:

```powershell
git commit -m "fix: address AI contact kind review" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

If no code changed, do not create an empty commit.

- [ ] **Step 8: Record the final handback evidence**

In `.superpowers/build-log.md`, record the synced `main` commit, feature `HEAD`, every focused and full command with exact exit code, test counts, lint attribution, adversarial findings and dispositions, live-QA scenarios/screenshots, worktree path, branch name, and remaining human gates. The final verdict may be merge-ready only if the branch is clean, review has no unresolved blocking finding, all required gates are green, and live QA passed. Merge, deployment, feature-flag rollout, and any production extraction remain human-owned.
