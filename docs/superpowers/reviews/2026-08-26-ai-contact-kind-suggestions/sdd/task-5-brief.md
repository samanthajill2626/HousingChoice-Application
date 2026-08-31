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

