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

