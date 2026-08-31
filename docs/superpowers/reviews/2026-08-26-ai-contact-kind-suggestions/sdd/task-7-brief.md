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

