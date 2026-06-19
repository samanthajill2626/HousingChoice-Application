<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Property Manager as a Custom Kind — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `pm` as a base `ContactType`; "Property Manager" becomes a custom kind — `type: 'landlord'` + `role: 'Property Manager'` — using the existing extensible-contact-creation `role` mechanism.

**Architecture:** Forward-only, no data migration (greenfield — no `type: 'pm'` records exist). Drop `'pm'` from the `ContactType` union (backend + frontend), keep a one-click "Property Manager" preset in the Kind picker that resolves to landlord+role, and collapse every `landlord || pm` special-case to a plain `landlord` check. The TypeScript compiler is the safety net: once `'pm'` leaves the union, `tsc` flags every site that referenced it.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node/Express + DynamoDB, React 19 + Vite + CSS Modules, Vitest + @testing-library/react, Playwright e2e.

## Global Constraints

- **Canonical label is `Property Manager`** (spelled out, both words capitalised) — segment label AND role string. Replaces the old abbreviated "Property mgr" / "Property manager".
- **Define the role string ONCE** as `PM_ROLE = 'Property Manager'` in `dashboard/src/routes/contact/contactProfile.ts`; import it where needed (no string literals scattered).
- **Do NOT touch the unit-roster `pm`:** `UnitContact.role: 'landlord' | 'pm' | 'owner' | 'other'` and `UNIT_CONTACT_ROLES` in `app/src/repos/unitsRepo.ts` are a different axis. In the test files, `role: 'pm'` (unit-roster) usages stay; only `type: 'pm'` (contact-type) usages change.
- **camelCase everywhere; design tokens only in CSS** (no hardcoded hex). `noUncheckedIndexedAccess` is ON.
- **Greenfield:** no migration. No contact currently has `type: 'pm'`.
- **e2e is deferred to a single gated pass** (Task 7) — do NOT boot the e2e stack mid-build.
- **Worktree:** all work in `w:\tmp\hc-pm-role` on branch `property-manager-role` (already created off `main`/`53b42cc`); never move `main`'s HEAD. Run `npm install` once in the worktree root before starting (deps are not yet installed there).
- Commands: `cd app` or `cd dashboard`; unit tests `npx vitest run <path>`; typecheck `npx tsc -p tsconfig.json --noEmit`; lint `npx eslint <paths>`. Stage only the files you change (no `git add -A`).

---

## File Structure

**Backend (`app/src/`):**
- `repos/contactsRepo.ts` — MODIFY: drop `'pm'` from `ContactType` (line 34).
- `routes/contacts.ts` — MODIFY: drop `'pm'` from `CONTACT_TYPES` (~line 102); update the `conversationTypeFor` comment (~line 178).

**Backend tests (`app/test/`):** `contactTriage.test.ts` (retarget the `{type:'pm'}` test + add a pm→400 test), `casesVoiceRouting.test.ts` + `unitsApiRoster.test.ts` (`type: 'pm'` → `type: 'landlord'` on the seeded contacts).

**Frontend (`dashboard/src/`):**
- `routes/contact/contactProfile.ts` — MODIFY: add `PM_ROLE`; later remove the `pm` entry from `CONTACT_TYPE_LABEL`.
- `routes/contact/KindPicker.tsx` — MODIFY: the "Property Manager" preset + active-segment logic + sub-choice.
- `routes/contacts/useContacts.ts` — MODIFY: `TYPES_FOR` drops `pm`.
- `routes/contact/ContactDetail.tsx`, `ContactCreateForm.tsx`, `ContactEditForm.tsx`, `LandlordFile.tsx` — MODIFY: collapse `landlord || pm` → `landlord`.
- `api/types.ts` — MODIFY: drop `'pm'` from `ContactType` (line 225) — done LAST.

**Frontend tests:** `KindPicker.test.tsx`, `useContacts.test.tsx`.

**e2e (`e2e/tests/dashboard-next/`):** extend `contact-create.spec.ts` (gated).

**Implementation order note:** the frontend removes `'pm'` from its `ContactType` LAST (Task 6), after every consumer has stopped referencing it (Tasks 2–5), so `tsc` stays green at each task boundary.

---

## Task 1: Backend — remove the `pm` contact type (validation + enum + tests)

**Files:**
- Modify: `app/src/repos/contactsRepo.ts:34`, `app/src/routes/contacts.ts` (~`CONTACT_TYPES` line 99–105, `conversationTypeFor` ~173–180)
- Test: `app/test/contactTriage.test.ts`, `app/test/casesVoiceRouting.test.ts`, `app/test/unitsApiRoster.test.ts`

**Interfaces:**
- Produces: `ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown'` (no `pm`). `POST`/`PATCH /api/contacts` with `type: 'pm'` → `400`.

- [ ] **Step 1: Add a failing test — `type:'pm'` is now rejected.** In `app/test/contactTriage.test.ts`, add (mirror the existing harness imports `makeWebhookHarness`, `SECRET`, `TEST_SESSION_COOKIE` used in that file):

```ts
it('400s a PATCH that tries to set the removed pm type', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'c-x', type: 'tenant', status: 'active', phone: '+15550109999' });
  const res = await request(app)
    .patch('/api/contacts/c-x')
    .set('x-origin-verify', SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ type: 'pm' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run it — verify it FAILS.** `cd app && npx vitest run test/contactTriage.test.ts` → the new test FAILS (pm currently accepted, returns 200).

- [ ] **Step 3: Retarget the existing pm-triage test to a still-valid no-1:1 type.** In `app/test/contactTriage.test.ts`, the existing test sends `{ type: 'pm' }` and asserts no auto-advance (lines ~174–186). Change the body and comment to use `team_member` (still a valid type with no 1:1 conversation type), preserving the assertion:

```ts
    .send({ type: 'team_member' });
  expect(world.conversations.get('conv-triage-1')?.type).toBe('unknown_1to1');
  // team_member/unknown do not resolve a 1:1 identity → no auto-advance.
  expect(res.body.contact.status).toBe('needs_review');
```

- [ ] **Step 4: Convert the `type:'pm'` contact seeds to `type:'landlord'`.** These are property-manager contacts seeded for voice/roster tests; the contact type becomes `landlord` (their unit-roster `role: 'pm'` stays). Edit:
  - `app/test/casesVoiceRouting.test.ts:39` — `type: 'pm'` → `type: 'landlord'`.
  - `app/test/unitsApiRoster.test.ts` — every `seedContact(..., { type: 'pm', ... })` (lines 70, 132, 169, 194, 215, 240, 252) → `type: 'landlord'`. **Do NOT change** the `role: 'pm'` arguments (unit-roster role).

- [ ] **Step 5: Remove `pm` from the type union + validation.**
  - `app/src/repos/contactsRepo.ts:34`:
    ```ts
    export type ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown';
    ```
  - `app/src/routes/contacts.ts` — `CONTACT_TYPES`, remove the `'pm',` line:
    ```ts
    const CONTACT_TYPES: readonly ContactType[] = [
      'tenant',
      'landlord',
      'team_member',
      'unknown',
    ] as const;
    ```
  - `app/src/routes/contacts.ts` — `conversationTypeFor` comment (~line 178): change `// pm/team_member/unknown have no 1:1 conversation type to propagate.` → `// team_member/unknown have no 1:1 conversation type to propagate.`

- [ ] **Step 6: Run tests + typecheck — verify PASS/GREEN.**
  - `cd app && npx vitest run test/contactTriage.test.ts test/casesVoiceRouting.test.ts test/unitsApiRoster.test.ts` → all PASS. (If a `casesVoiceRouting`/`unitsApiRoster` assertion now differs because it encoded the old "pm is treated as unknown/non-landlord" behaviour, reconcile it to the new model — a property manager is a landlord — and note the change in the report.)
  - `npx vitest run` (full app suite) → PASS.
  - `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.test.json --noEmit` → clean.
  - `npx eslint src/repos/contactsRepo.ts src/routes/contacts.ts test/contactTriage.test.ts test/casesVoiceRouting.test.ts test/unitsApiRoster.test.ts` → clean.

- [ ] **Step 7: Commit.**
```bash
git add app/src/repos/contactsRepo.ts app/src/routes/contacts.ts app/test/contactTriage.test.ts app/test/casesVoiceRouting.test.ts app/test/unitsApiRoster.test.ts
git commit -m "feat(api): remove pm contact type (Property Manager becomes landlord+role)"
```

---

## Task 2: Frontend — add the `PM_ROLE` constant

**Files:**
- Modify: `dashboard/src/routes/contact/contactProfile.ts`
- Test: `dashboard/src/routes/contact/contactProfile.test.ts`

**Interfaces:**
- Produces: `export const PM_ROLE = 'Property Manager'` (the canonical preset role string, imported by `KindPicker`).

- [ ] **Step 1: Write the failing test.** Add to `dashboard/src/routes/contact/contactProfile.test.ts` (mirror its existing imports):

```ts
import { PM_ROLE, displayKind } from './contactProfile.js';

it('PM_ROLE is the spelled-out label and drives the badge for a landlord-based PM', () => {
  expect(PM_ROLE).toBe('Property Manager');
  expect(displayKind({ type: 'landlord', role: PM_ROLE }, () => 'Landlord')).toBe('Property Manager');
});
```

- [ ] **Step 2: Run it — verify FAIL.** `cd dashboard && npx vitest run src/routes/contact/contactProfile.test.ts` → FAIL (`PM_ROLE` not exported).

- [ ] **Step 3: Add the constant.** In `dashboard/src/routes/contact/contactProfile.ts`, after the imports / near `CONTACT_TYPE_LABEL`, add:

```ts
/** Canonical custom-kind role for a property manager. "Property Manager" is a
 *  custom kind on the `landlord` base type (there is no `pm` ContactType). */
export const PM_ROLE = 'Property Manager';
```

- [ ] **Step 4: Run it — verify PASS** + `npx tsc -p tsconfig.json --noEmit` (clean) + `npx eslint src/routes/contact/contactProfile.ts src/routes/contact/contactProfile.test.ts` (clean).

- [ ] **Step 5: Commit.**
```bash
git add dashboard/src/routes/contact/contactProfile.ts dashboard/src/routes/contact/contactProfile.test.ts
git commit -m "feat(dashboard): PM_ROLE constant (Property Manager)"
```

---

## Task 3: Frontend — KindPicker "Property Manager" preset

**Files:**
- Modify: `dashboard/src/routes/contact/KindPicker.tsx`
- Test: `dashboard/src/routes/contact/KindPicker.test.tsx`

**Interfaces:**
- Consumes: `PM_ROLE` (Task 2).
- Produces: the "Property Manager" primary segment emits `{ type: 'landlord', role: PM_ROLE }` (preset) and is shown active for that value WITHOUT opening the Other panel. The Other base-type sub-choice offers only Tenant / Landlord.

**Key design:** the preset carries a non-empty role, so the current `inOtherMode = otherSelected || role !== ''` would wrongly treat it as Other. We exclude the preset: `isPmPreset = !otherSelected && type === 'landlord' && role === PM_ROLE`. A user who reaches the same shape by explicitly clicking Other and typing "Property Manager" (`otherSelected === true`) STAYS in Other mode (no jarring panel close).

- [ ] **Step 1: Update the tests.** In `dashboard/src/routes/contact/KindPicker.test.tsx`:

  (a) Replace the "clicking Other reveals … sub-choices" assertions (lines ~88–92) — the sub-choice no longer offers Property Manager:
```ts
    // Base-type sub-choices appear; Tenant/Landlord are shared with the segment bar
    // (length 2). Property Manager is a primary segment only (no base sub-choice).
    expect(screen.getAllByRole('button', { name: 'Tenant' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Landlord' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Property Manager' })).toHaveLength(1);
```

  (b) Add a new test for the preset (no Other panel):
```ts
  it('clicking Property Manager presets landlord + role and does NOT open Other', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Property Manager' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'landlord', role: 'Property Manager' });
    // It is a preset, not Other — no role input is revealed.
    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
  });
```

- [ ] **Step 2: Run — verify FAIL.** `cd dashboard && npx vitest run src/routes/contact/KindPicker.test.tsx` → the new/updated tests FAIL (segment still labelled "Property mgr"; preset opens Other).

- [ ] **Step 3: Implement.** Edit `dashboard/src/routes/contact/KindPicker.tsx`:

  (a) Add the import:
```ts
import { PM_ROLE } from './contactProfile.js';
```

  (b) Replace `activePrimarySegment` (lines 22–33):
```ts
/** True when the value is exactly the Property Manager preset (landlord + PM_ROLE)
 *  and the user did NOT explicitly enter Other mode. */
function isPmPresetValue(value: KindPickerValue, otherSelected: boolean): boolean {
  return !otherSelected && value.type === 'landlord' && value.role === PM_ROLE;
}

/** Derive which primary segment button should appear "active". */
function activePrimarySegment(
  value: KindPickerValue,
  otherSelected: boolean,
): PrimarySegment | null {
  if (isPmPresetValue(value, otherSelected)) return 'pm';
  const inOtherMode = otherSelected || value.role.trim() !== '';
  if (inOtherMode) return 'other';
  if (value.type === 'tenant') return 'tenant';
  if (value.type === 'landlord') return 'landlord';
  return null;
}
```

  (c) Replace the `inOtherMode` derivation (line 58) so the preset is NOT treated as Other:
```ts
  const isPmPreset = isPmPresetValue(value, otherSelected);
  const inOtherMode = !isPmPreset && (otherSelected || value.role.trim() !== '');
```

  (d) Replace `handleSegment` (lines 61–81):
```ts
  function handleSegment(seg: PrimarySegment): void {
    if (seg === 'other') {
      if (inOtherMode) {
        // Already in Other mode — keep type+role as-is (don't wipe a chosen base).
        onChange({ type: value.type, role: value.role });
      } else {
        setOtherSelected(true);
        onChange({ type: null, role: value.role });
      }
    } else if (seg === 'pm') {
      // Property Manager preset: a custom kind on the landlord base.
      setOtherSelected(false);
      onChange({ type: 'landlord', role: PM_ROLE });
    } else {
      setOtherSelected(false);
      const typeMap: Record<'tenant' | 'landlord', ContactType> = {
        tenant: 'tenant',
        landlord: 'landlord',
      };
      onChange({ type: typeMap[seg], role: '' });
    }
  }
```

  (e) Update the primary segment label (lines 96–103): change `'Property mgr'` → `'Property Manager'`. Keep the `'pm'` PrimarySegment KEY (it is a label-only UI id now, not a `ContactType`):
```ts
          const label =
            seg === 'tenant'
              ? 'Tenant'
              : seg === 'landlord'
                ? 'Landlord'
                : seg === 'pm'
                  ? 'Property Manager'
                  : 'Other';
```

  (f) Remove Property Manager from the Other base-type sub-choice (lines 148–153) — only real bases remain:
```ts
            {(
              [
                ['tenant', 'Tenant'],
                ['landlord', 'Landlord'],
              ] as [ContactType, string][]
            ).map(([t, label]) => (
```

- [ ] **Step 4: Run — verify PASS** + `npx tsc -p tsconfig.json --noEmit` (clean) + `npx eslint src/routes/contact/KindPicker.tsx src/routes/contact/KindPicker.test.tsx` (clean).

- [ ] **Step 5: Commit.**
```bash
git add dashboard/src/routes/contact/KindPicker.tsx dashboard/src/routes/contact/KindPicker.test.tsx
git commit -m "feat(dashboard): KindPicker Property Manager preset (landlord + role)"
```

---

## Task 4: Frontend — useContacts drops `pm` from the filter fan-out

**Files:**
- Modify: `dashboard/src/routes/contacts/useContacts.ts`
- Test: `dashboard/src/routes/contacts/useContacts.test.tsx`

**Interfaces:**
- Produces: `TYPES_FOR.landlord = ['landlord']`, `TYPES_FOR.all = ['tenant', 'landlord', 'unknown']` (PMs are `landlord`-typed now, so they appear under Landlords automatically).

- [ ] **Step 1: Update the tests.** In `dashboard/src/routes/contacts/useContacts.test.tsx`:

  (a) Replace the "fans out across landlord + pm" test (lines 47–59) with a single-type assertion:
```ts
  it('fetches just the landlord type for the landlord filter', async () => {
    getContacts.mockResolvedValue(page({ contactId: 'l1', type: 'landlord' }));
    render(<Probe filter="landlord" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ready'));
    expect(getContacts).toHaveBeenCalledTimes(1);
    expect((getContacts.mock.calls[0]?.[0] as { type: ContactType }).type).toBe('landlord');
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });
```

  (b) Update the "all filter" expectations (lines 67–68) from 4 to 3:
```ts
    expect(getContacts).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('count')).toHaveTextContent('3');
```

- [ ] **Step 2: Run — verify FAIL.** `cd dashboard && npx vitest run src/routes/contacts/useContacts.test.tsx` → FAIL (landlord still fans out to 2; all to 4).

- [ ] **Step 3: Implement.** In `dashboard/src/routes/contacts/useContacts.ts`, update `TYPES_FOR` (and the comment above it, which says "Landlords include property managers"):

```ts
/** The contact `type`s to fetch for a given filter. Property managers are
 *  `landlord`-typed (role "Property Manager"), so the Landlords filter covers
 *  them; 'all' fans out across every audience type (team members excluded). */
const TYPES_FOR: Record<ContactsFilter, ContactType[]> = {
  all: ['tenant', 'landlord', 'unknown'],
  tenant: ['tenant'],
  landlord: ['landlord'],
  unknown: ['unknown'],
};
```

- [ ] **Step 4: Run — verify PASS** + `npx tsc -p tsconfig.json --noEmit` (clean) + `npx eslint src/routes/contacts/useContacts.ts src/routes/contacts/useContacts.test.tsx` (clean).

- [ ] **Step 5: Commit.**
```bash
git add dashboard/src/routes/contacts/useContacts.ts dashboard/src/routes/contacts/useContacts.test.tsx
git commit -m "feat(dashboard): Landlords filter covers PMs via landlord type (drop pm fan-out)"
```

---

## Task 5: Frontend — collapse `landlord || pm` in detail + forms + file

**Files:**
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` (~line 86–95), `dashboard/src/routes/contact/ContactCreateForm.tsx:63`, `dashboard/src/routes/contact/ContactEditForm.tsx:41`, `dashboard/src/routes/contact/LandlordFile.tsx:79`
- Test: existing `ContactDetail.test.tsx` / `LandlordFile`/`files` tests must stay green (no new test required — behaviour for landlords is unchanged; PM rendering is covered by `displayKind`).

**Interfaces:**
- Consumes: `displayKind`, `CONTACT_TYPE_LABEL` (already imported where used).
- Produces: PMs (now `type: 'landlord'`, role "Property Manager") render the landlord file + pill, badged "Property Manager".

- [ ] **Step 1: Implement the four edits.**

  (a) `ContactDetail.tsx` — the `kind` selector (~line 86–95): drop the `|| contact.type === 'pm'` and update the comment:
```ts
  // Three-way by audience: landlord → landlord, unknown → untriaged, everything
  // else (tenant + team_member) → tenant. `pill`/file are chosen from this.
  const kind: 'tenant' | 'landlord' | 'unknown' =
    contact.type === 'landlord'
      ? 'landlord'
      : contact.type === 'unknown'
        ? 'unknown'
        : 'tenant';
```
  (The pill label already uses `displayKind`, so a PM shows "Property Manager".)

  (b) `ContactCreateForm.tsx:63` — rename + simplify:
```ts
  const isLandlordOrPm = resolvedType === 'landlord';
```
  (Keep the variable name as-is to avoid touching its usages, OR rename to `isLandlord` and update its references in the same file — either is fine; if renaming, update every `isLandlordOrPm` usage.)

  (c) `ContactEditForm.tsx:41`:
```ts
  const isLandlord = contact.type === 'landlord';
```

  (d) `LandlordFile.tsx:79` — replace the hard-coded `pm` ternary with the badge rule. Add the import if not present (`import { CONTACT_TYPE_LABEL, displayKind } from './contactProfile.js';`) and change the Role KV:
```ts
        <KV k="Role" v={displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])} />
```
  (A plain landlord → "Landlord"; a PM → "Property Manager".)

- [ ] **Step 2: Run the affected suites — verify GREEN.** `cd dashboard && npx vitest run src/routes/contact/ContactDetail.test.tsx src/routes/contact/files.test.tsx src/routes/contact/ContactEditForm.test.tsx src/routes/contact/ContactCreateForm.test.tsx` → PASS. Then `npx tsc -p tsconfig.json --noEmit` (clean) + `npx eslint` the four files (clean).

- [ ] **Step 3: Commit.**
```bash
git add dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactCreateForm.tsx dashboard/src/routes/contact/ContactEditForm.tsx dashboard/src/routes/contact/LandlordFile.tsx
git commit -m "refactor(dashboard): collapse landlord||pm to landlord (PMs are landlord-typed)"
```

---

## Task 6: Frontend — remove `pm` from `ContactType` + `CONTACT_TYPE_LABEL`

**Files:**
- Modify: `dashboard/src/api/types.ts:225`, `dashboard/src/routes/contact/contactProfile.ts` (`CONTACT_TYPE_LABEL`)

**Interfaces:**
- Produces: dashboard `ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown'`. No code references `'pm'` as a contact type after this task.

- [ ] **Step 1: Remove the enum value + the label entry together.**
  - `dashboard/src/api/types.ts:225`:
    ```ts
    export type ContactType = 'tenant' | 'landlord' | 'team_member' | 'unknown';
    ```
  - `dashboard/src/routes/contact/contactProfile.ts` — `CONTACT_TYPE_LABEL`, remove the `pm` line and fix the comment:
    ```ts
    /** A human label for a contact's type badge. Single source of truth, imported
     *  by ContactsList (list badges) and ContactDetail (header pill). */
    export const CONTACT_TYPE_LABEL: Record<ContactType, string> = {
      tenant: 'Tenant',
      landlord: 'Landlord',
      team_member: 'Team',
      unknown: 'Unknown',
    };
    ```

- [ ] **Step 2: Typecheck — verify the compiler finds NO remaining `pm` references.** `cd dashboard && npx tsc -p tsconfig.json --noEmit` → clean. (If `tsc` errors at any site still comparing to `'pm'`, that site was missed in Tasks 3–5 — fix it now; the error message names the file:line.)

- [ ] **Step 3: Run the FULL dashboard suite + lint — verify GREEN.** `npx vitest run` → all PASS. `npx eslint src/api/types.ts src/routes/contact/contactProfile.ts` → clean.

- [ ] **Step 4: Final exhaustive grep (no stray references).** Run and confirm only the *unit-roster* `pm` (in `unitsRepo`-related code/types) and historical spec/plan docs remain:
```bash
git grep -nE "'pm'|Property mgr" -- dashboard/src app/src | grep -viE "UnitContact|UNIT_CONTACT|roster|role"
```
Expected: no contact-`type` hits (only the unit-roster role union, which is intentional).

- [ ] **Step 5: Commit.**
```bash
git add dashboard/src/api/types.ts dashboard/src/routes/contact/contactProfile.ts
git commit -m "feat(dashboard): remove pm from ContactType + type-label map"
```

---

## Task 7: e2e — create a Property Manager via the preset (GATED — run only in the final approval pass)

**Files:**
- Modify: `e2e/tests/dashboard-next/contact-create.spec.ts`

**Scenario:** dev-login → `/contacts` → "New contact" → click the **Property Manager** preset (no Other panel opens) → fill a name + Company → Create → lands on the new contact page badged **"Property Manager"**; the detail file is the landlord file; reload persists; navigating to the **Landlords** filter (`/contacts/landlords`) shows the new contact. Self-contained (unique name/company per run via a timestamp). Mirror the existing spec's `devLogin` + selector style (`getByRole('dialog', { name: /New contact/i })`, `getByRole('button', { name: 'Property Manager' })`, `getByRole('button', { name: 'Create', exact: true })`).

- [ ] **Step 1: Write the spec test** (add a third `test(...)` to the existing `describe` in `contact-create.spec.ts`).
- [ ] **Step 2: (GATED)** After all unit work is green AND the human approves, from the worktree run `npm install` (if not already), `npm run e2e:reseed`, then `cd e2e && npx playwright test tests/dashboard-next/contact-create.spec.ts --reporter=list`, then the full suite `npx playwright test --reporter=list`. All green.
- [ ] **Step 3: Commit.**
```bash
git add e2e/tests/dashboard-next/contact-create.spec.ts
git commit -m "test(e2e): create a Property Manager via the preset (landlord + role)"
```

---

## Self-Review

- **Spec coverage:** data-model removal of `pm` (T1 backend, T6 frontend) ✔; `PM_ROLE` single source (T2) ✔; Kind picker preset + sub-choice + active-segment (T3) ✔; filter collapse (T4) ✔; detail/forms/file collapse + LandlordFile role via `displayKind` (T5) ✔; auto-suggest needs no work (existing write-path) ✔; tests incl. pm→400 + retargeted triage + roster/voice seeds (T1) and FE tests (T3/T4) ✔; unit-roster `pm` explicitly untouched (Global Constraints + T1 Step 4 + T6 Step 4 grep) ✔; gated e2e (T7) ✔.
- **Placeholder scan:** every code step shows the exact replacement. No TBD/TODO.
- **Type consistency:** `PM_ROLE = 'Property Manager'` defined in T2, consumed in T3 (KindPicker) and effectively asserted in T2/T7; `ContactType` loses `pm` in both declarations (backend T1, frontend T6); the `'pm'` that REMAINS is only `UnitContact.role` (a separate union) — called out everywhere it could be confused.
- **Ordering:** frontend `ContactType` edit is LAST (T6) so `tsc` stays green at every task boundary; the compiler is used as the completeness check in T6 Step 2.
