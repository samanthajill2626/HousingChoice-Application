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

