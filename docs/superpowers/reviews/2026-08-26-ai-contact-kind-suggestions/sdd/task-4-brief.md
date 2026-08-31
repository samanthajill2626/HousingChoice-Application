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

