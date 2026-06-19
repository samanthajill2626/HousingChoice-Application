<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Extensible Contact Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan is executed by an orchestrator per the handoff prompt — see `docs/superpowers/specs/2026-06-18-extensible-contact-creation-design.md` §10.**

**Goal:** Let navigators create contacts from the Contacts page, including custom "kinds" (e.g. Case worker) based on a standard type, with contact-to-contact relationships (link-or-text), free-text custom fields, and rich auto-suggest.

**Architecture:** Additive fields on the flexible contact document (`role`, `relationships`, `customFields`) — no schema migration; base `type` enum unchanged. Backend extends the existing `POST`/`PATCH /api/contacts` validation + adds a singleton "vocabulary" record (DynamoDB String Sets, atomic ADD) and a read route. Frontend adds a create dialog with a unified kind-picker, shared relationship/custom-field editors reused by the edit dialog, and type-agnostic display cards. Spec: `docs/superpowers/specs/2026-06-18-extensible-contact-creation-design.md`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node/Express + DynamoDB (`@aws-sdk/lib-dynamodb`), React 19 + Vite + CSS Modules, Vitest + @testing-library/react (jsdom), Playwright e2e.

## Global Constraints

- **camelCase everywhere** (storage, wire, UI): `role`, `relationships`, `customFields`, `relationshipRoles`, `fieldLabels`. No snake_case drift. (The broadcast `audience_filter.housing_authority` param is a separate, pre-existing API contract — do NOT touch it.)
- **Design tokens only** in CSS (no hardcoded hex) — `dashboard/src/ui/tokens.css`. Follow existing component patterns: `Modal.tsx`, `ContactEditForm.tsx`, `PhoneManager.tsx` are the templates.
- **`noUncheckedIndexedAccess` is ON** — guard index access (`arr[i] ?? fallback`).
- **Base `type` enum is unchanged.** `role` layers on top; it never replaces `type`. Badge rule everywhere: `role` when non-empty, else the type label.
- **Relationship shape:** `{ role: string; name: string; contactId?: string }` — `name` is ALWAYS present (display label); `contactId` only when linked.
- **Tests:** unit + typecheck + lint green per task. **e2e is deferred to a single gated pass** (Task 14) — do NOT boot the e2e stack mid-build.
- **Worktree:** all work in a `w:\tmp` worktree on one feature branch; never move `main`'s HEAD.
- Run unit tests per workspace: `npx vitest run <path>` in `app/` or `dashboard/`. Typecheck: `npx tsc -p tsconfig.json --noEmit`. Lint: `npx eslint <paths>`.

---

## File Structure

**Backend (`app/src/`):**
- `routes/contacts.ts` — MODIFY: extend `parseCreateBody` + `parseTriageBody`; add `GET /vocabulary`; vocabulary ADD on write.
- `lib/contactProfile.ts` — CREATE: shared validators `parseRelationships`, `parseCustomFields`, `parseRole` + the `Relationship`/`CustomField` types (imported by routes + repo).
- `repos/contactVocabularyRepo.ts` — CREATE: singleton SS record `add()` + `get()`.
- `repos/contactsRepo.ts` — MODIFY: document the new optional `ContactItem` fields.

**Backend tests (`app/test/`):** `contactProfile.test.ts` (CREATE), extend `contactsCrud.test.ts` + `contactTriage.test.ts`, `contactVocabulary.test.ts` (CREATE).

**Frontend api (`dashboard/src/api/`):**
- `types.ts` — MODIFY: `Relationship`, `CustomField`, `ContactVocabulary`, `ContactCreate`; extend `Contact` + `ContactPatch`.
- `endpoints.ts` — MODIFY: `createContact`, `getContactVocabulary`.

**Frontend (`dashboard/src/routes/contact/`):**
- `CustomFieldsEditor.tsx` (+ `.module.css`) — CREATE.
- `RelationshipsEditor.tsx` (+ `.module.css`), `ContactSearchField.tsx` — CREATE.
- `KindPicker.tsx` (+ `.module.css`) — CREATE.
- `ContactCreateForm.tsx` (+ `.module.css`) — CREATE.
- `RelationshipsCard.tsx`, `CustomFieldsCard.tsx` (+ a shared `.module.css`) — CREATE.
- `useContactVocabulary.ts` — CREATE.
- `contactProfile.ts` — CREATE: shared FE helpers (badge label `displayKind(contact)`, normalize editor rows → wire shape).
- `ContactEditForm.tsx` — MODIFY: add Role/Relationships/CustomFields sections.
- `ContactDetail.tsx` — MODIFY: render the two cards + badge via `displayKind`.

**Frontend (`dashboard/src/routes/contacts/`):** `ContactsList.tsx` — MODIFY: "New contact" button + dialog + row badge.

**e2e (`e2e/tests/dashboard-next/`):** `contact-create.spec.ts` — CREATE (gated).

---

## Task 1: Shared profile validators + types (backend)

**Files:**
- Create: `app/src/lib/contactProfile.ts`
- Test: `app/test/contactProfile.test.ts`

**Interfaces:**
- Produces:
  - `interface Relationship { role: string; name: string; contactId?: string }`
  - `interface CustomField { label: string; value: string }`
  - `parseRole(v: unknown): string | { error: string }` — trims; non-string → error.
  - `parseRelationships(v: unknown): Relationship[] | { error: string }` — array; each item `{role,name}` non-empty strings (trimmed), `contactId` optional non-empty string; bad item → error.
  - `parseCustomFields(v: unknown): CustomField[] | { error: string }` — array; each `{label,value}` strings; `label` trimmed non-empty (rows with empty label are DROPPED, not errored); `value` kept as-is.

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/contactProfile.test.ts
import { describe, it, expect } from 'vitest';
import { parseRole, parseRelationships, parseCustomFields } from '../src/lib/contactProfile.js';

describe('parseRole', () => {
  it('trims a valid role', () => expect(parseRole('  Case worker ')).toBe('Case worker'));
  it('rejects a non-string', () => expect(parseRole(5)).toEqual({ error: 'role must be a string' }));
});

describe('parseRelationships', () => {
  it('accepts linked + text rows', () => {
    expect(
      parseRelationships([
        { role: 'Client', name: 'Tasha', contactId: 'c1' },
        { role: ' Spouse ', name: ' Bob ' },
      ]),
    ).toEqual([
      { role: 'Client', name: 'Tasha', contactId: 'c1' },
      { role: 'Spouse', name: 'Bob' },
    ]);
  });
  it('rejects a non-array', () => expect(parseRelationships({})).toEqual({ error: 'relationships must be an array' }));
  it('rejects a row missing role/name', () => {
    expect(parseRelationships([{ role: '', name: 'x' }])).toEqual({ error: 'each relationship needs a role and a name' });
    expect(parseRelationships([{ role: 'r', name: '  ' }])).toEqual({ error: 'each relationship needs a role and a name' });
  });
  it('rejects a non-string contactId', () => expect(parseRelationships([{ role: 'r', name: 'n', contactId: 5 }])).toEqual({ error: 'relationship contactId must be a string' }));
});

describe('parseCustomFields', () => {
  it('keeps labelled rows, drops empty-label rows', () => {
    expect(parseCustomFields([{ label: ' Agency ', value: 'AH' }, { label: '  ', value: 'x' }])).toEqual([{ label: 'Agency', value: 'AH' }]);
  });
  it('rejects a non-array', () => expect(parseCustomFields('x')).toEqual({ error: 'customFields must be an array' }));
  it('rejects a non-string value', () => expect(parseCustomFields([{ label: 'a', value: 5 }])).toEqual({ error: 'custom field value must be a string' }));
});
```

- [ ] **Step 2: Run to verify FAIL** — `cd app && npx vitest run test/contactProfile.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `app/src/lib/contactProfile.ts`**

```ts
export interface Relationship { role: string; name: string; contactId?: string }
export interface CustomField { label: string; value: string }

export function parseRole(v: unknown): string | { error: string } {
  if (typeof v !== 'string') return { error: 'role must be a string' };
  return v.trim();
}

export function parseRelationships(v: unknown): Relationship[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'relationships must be an array' };
  const out: Relationship[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return { error: 'each relationship must be an object' };
    const r = raw as Record<string, unknown>;
    const role = typeof r['role'] === 'string' ? r['role'].trim() : '';
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    if (role.length === 0 || name.length === 0) return { error: 'each relationship needs a role and a name' };
    if (r['contactId'] !== undefined && typeof r['contactId'] !== 'string') return { error: 'relationship contactId must be a string' };
    const item: Relationship = { role, name };
    if (typeof r['contactId'] === 'string' && r['contactId'].length > 0) item.contactId = r['contactId'];
    out.push(item);
  }
  return out;
}

export function parseCustomFields(v: unknown): CustomField[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'customFields must be an array' };
  const out: CustomField[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return { error: 'each custom field must be an object' };
    const c = raw as Record<string, unknown>;
    if (c['value'] !== undefined && typeof c['value'] !== 'string') return { error: 'custom field value must be a string' };
    const label = typeof c['label'] === 'string' ? c['label'].trim() : '';
    if (label.length === 0) continue; // drop empty-label rows
    out.push({ label, value: typeof c['value'] === 'string' ? c['value'] : '' });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run test/contactProfile.test.ts` → PASS.
- [ ] **Step 5: Typecheck + commit** — `npx tsc -p tsconfig.json --noEmit`; `git add -A && git commit -m "feat(contacts): shared profile validators (role/relationships/customFields)"`

---

## Task 2: POST /api/contacts accepts role/company/relationships/customFields

**Files:**
- Modify: `app/src/routes/contacts.ts` (`parseCreateBody`)
- Test: `app/test/contactsCrud.test.ts`

**Interfaces:**
- Consumes: `parseRole`, `parseRelationships`, `parseCustomFields` (Task 1).
- Produces: `POST /api/contacts` persists `role`, `company`, `relationships`, `customFields` onto the created contact (flexible doc). 409 dedupe unchanged.

- [ ] **Step 1: Failing tests** — add to `contactsCrud.test.ts`:

```ts
it('creates a contact with role, company, relationships, and customFields', async () => {
  const { app } = makeWebhookHarness();
  const res = await request(app)
    .post('/api/contacts')
    .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({
      type: 'tenant', firstName: 'Carla', lastName: 'Reyes', role: 'Case worker', company: 'AH Agency',
      relationships: [{ role: 'Client', name: 'Tasha Nguyen', contactId: 'contact-tenant-0001' }],
      customFields: [{ label: 'Agency', value: 'Atlanta Housing' }],
    });
  expect(res.status).toBe(201);
  expect(res.body.contact).toMatchObject({
    type: 'tenant', role: 'Case worker', company: 'AH Agency',
    relationships: [{ role: 'Client', name: 'Tasha Nguyen', contactId: 'contact-tenant-0001' }],
    customFields: [{ label: 'Agency', value: 'Atlanta Housing' }],
  });
});

it('400s an invalid relationship on create', async () => {
  const { app } = makeWebhookHarness();
  const res = await request(app).post('/api/contacts')
    .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({ type: 'tenant', relationships: [{ role: 'Client' }] }); // missing name
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run FAIL** — `npx vitest run test/contactsCrud.test.ts`.

- [ ] **Step 3: Extend `parseCreateBody`** — after the existing field parsing (status/phone), before defaulting status, add (mirror the PATCH `company` block already present and use the Task 1 validators):

```ts
// in parseCreateBody, after notes/status handling:
if ('company' in b) {
  if (typeof b['company'] !== 'string') return { error: 'company must be a string' };
  item.company = b['company'];
}
if ('role' in b) {
  const r = parseRole(b['role']);
  if (typeof r !== 'string') return r;            // { error }
  if (r.length > 0) item.role = r;
}
if ('relationships' in b) {
  const rels = parseRelationships(b['relationships']);
  if (!Array.isArray(rels)) return rels;          // { error }
  item.relationships = rels;
}
if ('customFields' in b) {
  const cf = parseCustomFields(b['customFields']);
  if (!Array.isArray(cf)) return cf;              // { error }
  item.customFields = cf;
}
```

Add the imports at the top of `contacts.ts`: `import { parseRole, parseRelationships, parseCustomFields } from '../lib/contactProfile.js';`. (`item` is `Partial<ContactItem> & { type }`; `ContactItem` is a flexible doc so `item.role`/`relationships`/`customFields`/`company` assign cleanly.)

- [ ] **Step 4: Run PASS** — `npx vitest run test/contactsCrud.test.ts`.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): POST /api/contacts accepts role/company/relationships/customFields"`

---

## Task 3: PATCH /api/contacts/:id accepts role/relationships/customFields

**Files:**
- Modify: `app/src/routes/contacts.ts` (`parseTriageBody`)
- Test: `app/test/contactTriage.test.ts`

**Interfaces:**
- Consumes: Task 1 validators. Produces: PATCH persists `role`/`relationships`/`customFields` (company/housingAuthority/address already supported) + appends to `changedFields`.

- [ ] **Step 1: Failing tests** — add to `contactTriage.test.ts`:

```ts
it('edits role + relationships + customFields', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'c-cw', type: 'tenant', status: 'active', phone: '+15550104444', created_at: '2026-06-12T10:00:00.000Z' });
  const res = await request(app).patch('/api/contacts/c-cw')
    .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({ role: 'Case worker', relationships: [{ role: 'Client', name: 'Tasha' }], customFields: [{ label: 'Agency', value: 'AH' }] });
  expect(res.status).toBe(200);
  expect(res.body.contact).toMatchObject({ role: 'Case worker', relationships: [{ role: 'Client', name: 'Tasha' }], customFields: [{ label: 'Agency', value: 'AH' }] });
  const audit = world.auditEvents.find((e) => e.event_type === 'contact_updated' && e.entityKey === 'contacts#c-cw');
  expect(audit?.payload?.['fields']).toEqual(expect.arrayContaining(['role', 'relationships', 'customFields']));
});

it('400s an invalid customField on edit', async () => {
  const { app, world } = makeWebhookHarness();
  world.contacts.push({ contactId: 'c-cw', type: 'tenant', status: 'active', phone: '+15550104445' });
  const res = await request(app).patch('/api/contacts/c-cw')
    .set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({ customFields: 'nope' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run FAIL** — `npx vitest run test/contactTriage.test.ts`.

- [ ] **Step 3: Extend `parseTriageBody`** — after the `address` block, before the `changedFields.length === 0` guard:

```ts
if ('role' in b) {
  const r = parseRole(b['role']);
  if (typeof r !== 'string') return r;
  patch['role'] = r;                  // may be '' to clear
  changedFields.push('role');
}
if ('relationships' in b) {
  const rels = parseRelationships(b['relationships']);
  if (!Array.isArray(rels)) return rels;
  patch['relationships'] = rels;
  changedFields.push('relationships');
}
if ('customFields' in b) {
  const cf = parseCustomFields(b['customFields']);
  if (!Array.isArray(cf)) return cf;
  patch['customFields'] = cf;
  changedFields.push('customFields');
}
```

(Import already added in Task 2.)

- [ ] **Step 4: Run PASS** — `npx vitest run test/contactTriage.test.ts`.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): PATCH /api/contacts accepts role/relationships/customFields"`

---

## Task 4: Vocabulary repo + write-path + GET /api/contacts/vocabulary

**Files:**
- Create: `app/src/repos/contactVocabularyRepo.ts`
- Modify: `app/src/routes/contacts.ts` (ADD on POST+PATCH success; GET route)
- Test: `app/test/contactVocabulary.test.ts`; extend the fake world in `app/test/helpers/twilioWebhookHarness.ts`

**Interfaces:**
- Produces:
  - `interface ContactVocabulary { roles: string[]; relationshipRoles: string[]; fieldLabels: string[] }`
  - `createContactVocabularyRepo(deps): { get(): Promise<ContactVocabulary>; add(tokens: Partial<Record<'roles'|'relationshipRoles'|'fieldLabels', string[]>>): Promise<void> }`
  - `GET /api/contacts/vocabulary` → `200 { vocabulary: ContactVocabulary }` (sorted, deduped, empty arrays when unset).
- Consumes: a `vocabularyRepo` injected into the contacts router (default real; fake in tests).

**Mechanism:** one item in the `settings` table, id `contact-vocabulary`, with three String-Set attributes. Writes use `UpdateExpression: 'ADD roles :r, relationshipRoles :rr, fieldLabels :fl'` with `:r` etc. as DynamoDB string sets (skip a set if its token list is empty — DynamoDB rejects empty sets, so build the expression dynamically from the non-empty groups). `get()` reads the item; missing/absent attributes → `[]`.

- [ ] **Step 1: Failing test** (uses the fake repo so it stays DB-free):

```ts
// contactVocabulary.test.ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

it('records role/relationship/field vocabulary on create and serves it', async () => {
  const { app, world } = makeWebhookHarness();
  await request(app).post('/api/contacts').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE)
    .send({ type: 'tenant', role: 'Case worker', relationships: [{ role: 'Client', name: 'T' }], customFields: [{ label: 'Agency', value: 'AH' }] });
  const res = await request(app).get('/api/contacts/vocabulary').set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);
  expect(res.status).toBe(200);
  expect(res.body.vocabulary).toEqual({ roles: ['Case worker'], relationshipRoles: ['Client'], fieldLabels: ['Agency'] });
  expect(world.vocabularyAdds.length).toBeGreaterThan(0); // best-effort write happened
});
```

- [ ] **Step 2: Run FAIL** — `npx vitest run test/contactVocabulary.test.ts`.

- [ ] **Step 3: Implement** the real repo (`contactVocabularyRepo.ts`) using `UpdateCommand`/`GetCommand` on the settings table (mirror an existing small repo for the doc-client wiring, e.g. `settingsRepo.ts`); add a **fake** `vocabularyRepo` to `createFakeWorld` in `twilioWebhookHarness.ts` recording `world.vocabularyAdds` + serving `get()` from an in-memory `{roles,relationshipRoles,fieldLabels}` Set trio; inject it into the contacts router (`createContactsRouter({ ..., vocabularyRepo })`, defaulting to the real repo). In `contacts.ts`: after a successful POST and PATCH, best-effort `await vocabularyRepo.add({ roles: [role?], relationshipRoles: rels.map(r=>r.role), fieldLabels: cf.map(c=>c.label) })` inside a `try/catch` that logs and never fails the response. Add the `GET /vocabulary` route **before** `GET /:contactId` (literal segment precedence, same pattern as `/read` before `/:contactId/read` in inbox.ts).

- [ ] **Step 4: Run PASS** — `npx vitest run test/contactVocabulary.test.ts`. Also run the contacts route suites: `npx vitest run test/contactsCrud.test.ts test/contactTriage.test.ts`.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): contact vocabulary repo + GET /api/contacts/vocabulary + write-path"`

---

## Task 5: Frontend api types + endpoints

**Files:**
- Modify: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`
- Test: `dashboard/src/api/endpoints.test.ts` (create if absent — otherwise a small smoke test inline)

**Interfaces:**
- Produces (types): `Relationship { role; name; contactId? }`, `CustomField { label; value }`, `ContactVocabulary { roles; relationshipRoles; fieldLabels }`; extend `Contact` + `ContactPatch` with `role?`, `relationships?`, `customFields?`; `ContactCreate { type: ContactType; firstName?; lastName?; phone?; voucherSize?; company?; role?; relationships?; customFields? }`.
- Produces (endpoints): `createContact(body: ContactCreate): Promise<Contact>` (POST `/api/contacts`, unwrap `{contact}`); `getContactVocabulary(signal?): Promise<ContactVocabulary>` (GET `/api/contacts/vocabulary`, unwrap `{vocabulary}`).

- [ ] **Step 1: Failing test** (endpoint smoke — mock `request`):

```ts
// in dashboard/src/api/endpoints.test.ts
import { vi, it, expect } from 'vitest';
vi.mock('./client.js', () => ({ request: vi.fn(() => Promise.resolve({ contact: { contactId: 'c9', type: 'tenant' } })) }));
import { request } from './client.js';
import { createContact } from './endpoints.js';
it('createContact posts and unwraps', async () => {
  const c = await createContact({ type: 'tenant', firstName: 'A' });
  expect(request).toHaveBeenCalledWith('/api/contacts', { method: 'POST', body: { type: 'tenant', firstName: 'A' } });
  expect(c).toEqual({ contactId: 'c9', type: 'tenant' });
});
```

- [ ] **Step 2: Run FAIL** — `cd dashboard && npx vitest run src/api/endpoints.test.ts`.
- [ ] **Step 3: Implement** the types (Task interfaces above) + the two endpoint functions (mirror `updateContact`/`getContactMedia` patterns).
- [ ] **Step 4: Run PASS** + `npx tsc -p tsconfig.json --noEmit`.
- [ ] **Step 5: Commit** — `git commit -am "feat(dashboard): contact create + vocabulary api types/endpoints"`

---

## Task 6: CustomFieldsEditor (shared)

**Files:** Create `dashboard/src/routes/contact/CustomFieldsEditor.tsx` (+ `.module.css`); Test `CustomFieldsEditor.test.tsx`.

**Interfaces:**
- Produces: `function CustomFieldsEditor({ rows, onChange, labelSuggestions? }: { rows: CustomField[]; onChange: (rows: CustomField[]) => void; labelSuggestions?: string[] }): JSX.Element` — controlled. Renders one labelled row per entry (label input + value input + Remove), an "+ Add custom field" button. `labelSuggestions` feed a shared `<datalist>` on the label inputs.

**Behavior + test cases:** add row appends `{label:'',value:''}`; editing a row calls `onChange` with updated rows; Remove drops the row; accessible labels ("Field label N", "Field value N", "Remove custom field N"). Use the `ContactEditForm`/`PhoneManager` input styling as the template.

- [ ] Step 1: Tests (render with 1 row → edit label fires onChange with new label; "+ Add custom field" → onChange called with an extra empty row; Remove → onChange with the row gone; suggestions render a datalist option).
- [ ] Step 2: Run FAIL. → Step 3: Implement. → Step 4: Run PASS + typecheck. → Step 5: `git commit -am "feat(dashboard): CustomFieldsEditor"`

---

## Task 7: ContactSearchField + RelationshipsEditor (shared)

**Files:** Create `dashboard/src/routes/contact/ContactSearchField.tsx`, `RelationshipsEditor.tsx` (+ `.module.css`); Test both.

**Interfaces:**
- `ContactSearchField`: `{ value: { name: string; contactId?: string }; onChange: (v: { name: string; contactId?: string }) => void; candidates: Contact[] }` — a text input over `name`; as the user types it shows matching `candidates` (client-side filter by `contactDisplayName`/phone, cap ~8); picking one sets `{ name: displayName, contactId }`; free typing clears `contactId` and keeps the text as `name`.
- `RelationshipsEditor`: `{ rows: Relationship[]; onChange: (rows: Relationship[]) => void; candidates: Contact[]; roleSuggestions?: string[] }` — one row per relationship: a relationship-role input (datalist `roleSuggestions`) + a `ContactSearchField` + Remove; "+ Add relationship" appends `{role:'',name:''}`.

**Behavior + test cases:** picking a candidate sets contactId+name; typing a non-matching name keeps it as text (no contactId); role edit + remove fire `onChange`; accessible labels. Reuse `contactDisplayName` from `./format.js`.

- [ ] Step 1: Tests (ContactSearchField: type → shows candidate → click sets contactId+name; type free text → name only. RelationshipsEditor: add/edit-role/remove → onChange shapes). 
- [ ] Step 2: FAIL → Step 3: Implement → Step 4: PASS + typecheck → Step 5: `git commit -am "feat(dashboard): RelationshipsEditor + ContactSearchField"`

---

## Task 8: useContactVocabulary hook

**Files:** Create `dashboard/src/routes/contact/useContactVocabulary.ts`; Test `useContactVocabulary.test.tsx`.

**Interfaces:**
- Produces: `useContactVocabulary(): ContactVocabulary` — fetches `getContactVocabulary` on mount (AbortController), returns `{ roles, relationshipRoles, fieldLabels }`, all `[]` until loaded and on error (best-effort; suggestions are non-critical). Mirror `useContact`'s fetch/abort shape.

- [ ] Step 1: Test (mock `getContactVocabulary` → resolves → hook returns the lists; rejects → stays `[]`). 
- [ ] Step 2: FAIL → Step 3: Implement → Step 4: PASS → Step 5: `git commit -am "feat(dashboard): useContactVocabulary"`

---

## Task 9: KindPicker

**Files:** Create `dashboard/src/routes/contact/KindPicker.tsx` (+ `.module.css`); Test `KindPicker.test.tsx`.

**Interfaces:**
- Produces: `function KindPicker({ value, onChange, roleSuggestions? }: { value: { type: ContactType | null; role: string }; onChange: (v: { type: ContactType | null; role: string }) => void; roleSuggestions?: string[] }): JSX.Element`.
- UI: a segmented choice **Tenant / Landlord / Property mgr / Other**. Choosing Tenant/Landlord/PM → `onChange({ type, role: '' })`. Choosing **Other** → reveals a **Role** text input (datalist `roleSuggestions`) + a base-type sub-choice **Tenant/Landlord/Property mgr** → `onChange({ type: baseType, role })`. While "Other" is selected but no base type yet → `type: null` (the create form keeps Create disabled until a type resolves).

**Test cases:** picking Tenant → onChange `{type:'tenant',role:''}` + no role input shown; picking Other → role input + base-type choices appear; typing a role + picking base Tenant → onChange `{type:'tenant',role:'Case worker'}`; the "Other" branch is detected by `role` non-empty OR an explicit `other` UI flag.

- [ ] Step 1: Tests → Step 2: FAIL → Step 3: Implement → Step 4: PASS + typecheck → Step 5: `git commit -am "feat(dashboard): KindPicker (type + Other guided role)"`

---

## Task 10: ContactCreateForm (the create dialog)

**Files:** Create `dashboard/src/routes/contact/ContactCreateForm.tsx` (+ `.module.css`); Test `ContactCreateForm.test.tsx`.

**Interfaces:**
- Produces: `function ContactCreateForm({ candidates, onClose, onCreated, onOpenExisting }: { candidates: Contact[]; onClose: () => void; onCreated: (c: Contact) => void; onOpenExisting: (contactId: string) => void }): JSX.Element` — a `Modal` titled "New contact" with: `KindPicker`, standard fields (first/last name, phone, + voucher [tenant] / company [landlord/pm] by the resolved base type), `RelationshipsEditor`, `CustomFieldsEditor` (the last two collapsed behind "+ Add relationship"/"+ Add custom field"). Uses `useContactVocabulary` for suggestions and the passed `candidates` for relationship linking.
- Submit → `createContact(body)`:
  - success → `onCreated(contact)`.
  - `ApiError` 409 with `err.body.contact` → render an inline conflict notice: *"That number already belongs to **{displayName}**."* + an **"Open their page"** button → `onOpenExisting(existing.contactId)`; the dialog STAYS OPEN.
  - other error → inline message; stays open.
- Create button disabled until a base `type` resolves.

**Test cases (mock `createContact`):** Tenant + name + phone → createContact called with `{type:'tenant', firstName, lastName, phone}` (no `role`); Other → role "Case worker" + base Tenant + a relationship + a custom field → body carries `role`, `relationships`, `customFields`; 201 → `onCreated`; **409 → conflict notice shows the existing name + "Open their page" calls `onOpenExisting`, NO `onCreated`, dialog still open**; submit disabled before a type is chosen.

- [ ] Step 1: Tests → Step 2: FAIL → Step 3: Implement → Step 4: PASS + typecheck + eslint → Step 5: `git commit -am "feat(dashboard): ContactCreateForm (kind picker, editors, 409 conflict)"`

---

## Task 11: "New contact" on the Contacts list

**Files:** Modify `dashboard/src/routes/contacts/ContactsList.tsx`; Test extend `ContactsList.test.tsx`.

**Interfaces:**
- Consumes: `ContactCreateForm`, `useNavigate` (react-router), `useContacts` (already provides the list — pass `contacts` as `candidates`).
- Produces: a header **"New contact"** button → opens `ContactCreateForm`; `onCreated` → `navigate('/contacts/'+c.contactId)`; `onOpenExisting(id)` → `navigate('/contacts/'+id)`. Row badge now uses `displayKind(contact)` (Task 12) — `role` ?? `TYPE_LABEL[type]`.

**Test cases:** the button renders + opens the dialog; (badge-role covered in Task 12). Keep it light — the form's behavior is tested in Task 10.

- [ ] Step 1: Test (button opens dialog) → Step 2: FAIL → Step 3: Implement → Step 4: PASS → Step 5: `git commit -am "feat(dashboard): New-contact button on Contacts list"`

---

## Task 12: Display — badge + RelationshipsCard + CustomFieldsCard

**Files:** Create `dashboard/src/routes/contact/contactProfile.ts` (FE helper), `RelationshipsCard.tsx`, `CustomFieldsCard.tsx` (+ a shared `.module.css`); Modify `ContactDetail.tsx`, `ContactsList.tsx` (badge); Test the cards + a `displayKind` unit test.

**Interfaces:**
- `contactProfile.ts`: `displayKind(contact: Pick<Contact,'type'|'role'>, typeLabel: (t: ContactType)=>string): string` → `contact.role?.trim() || typeLabel(contact.type)`. Export a `CONTACT_TYPE_LABEL` map so list + detail + create share one label source.
- `RelationshipsCard({ relationships, onEdit? })` — a `Card` titled "Relationships"; each row: relationship role + `name` (wrapped in `<Link to={'/contacts/'+contactId}>` when `contactId`, else plain). Hidden when empty unless `onEdit` (then an empty "+ Add" affordance). 
- `CustomFieldsCard({ customFields, onEdit? })` — a `Card` titled "Custom fields"; `KV` rows label→value. Hidden when empty unless `onEdit`.
- `ContactDetail.tsx`: render both cards (from `contact.relationships`/`contact.customFields`) in the file pane region for ALL kinds (below the type-specific file); header pill text = `displayKind(contact, ...)`; `onEdit` opens the existing Edit dialog.

**Test cases:** linked relationship → a Link to `/contacts/:id` with the name; text relationship → plain text, no link; custom fields → label/value rows; `displayKind` returns role when set else the type label; empty arrays → cards hidden (display-only mode).

- [ ] Step 1: Tests → Step 2: FAIL → Step 3: Implement (cards + wire into ContactDetail + badges in ContactDetail/ContactsList) → Step 4: PASS + typecheck → Step 5: `git commit -am "feat(dashboard): role badge + Relationships/CustomFields cards"`

---

## Task 13: Edit dialog gains Role / Relationships / Custom fields

**Files:** Modify `dashboard/src/routes/contact/ContactEditForm.tsx`; Test extend `ContactEditForm.test.tsx`.

**Interfaces:**
- Consumes: `RelationshipsEditor`, `CustomFieldsEditor`, `useContactVocabulary`, the contact's `candidates` (pass from `ContactDetail` — it can reuse a contacts fetch or accept a `candidates` prop; for v1 accept an optional `candidates?: Contact[]` and fall back to `[]`).
- Produces: the Edit dialog renders a **Role** text input (datalist) + the two editors, dirty-tracked into the PATCH (`role`/`relationships`/`customFields`) alongside the existing fields. Initial values from `contact.role`/`relationships`/`customFields`.

**Test cases:** editing the role → PATCH `{role}`; adding a relationship → PATCH `{relationships:[...]}`; adding a custom field → PATCH `{customFields:[...]}`; unchanged sections are NOT sent (dirty-tracking).

- [ ] Step 1: Tests → Step 2: FAIL → Step 3: Implement → Step 4: PASS + typecheck + eslint → Step 5: `git commit -am "feat(dashboard): edit role/relationships/customFields"`

---

## Task 14: e2e — create a Case worker (GATED — run only in the final approval pass)

**Files:** Create `e2e/tests/dashboard-next/contact-create.spec.ts`.

**Scenario:** dev-login → `/contacts` → "New contact" → choose **Other**, role "Case worker E2E", base **Tenant**, name + a relationship (text "Tasha N") + a custom field ("Agency"→"AH") → Create → lands on the new contact page showing badge "Case worker E2E", the relationship row, and the custom field; reload persists. Second test: create with a phone that already belongs to the seeded tenant (`+15550100001`) → conflict notice + "Open their page" navigates to `contact-tenant-0001` (and Create did NOT make a duplicate). Mirror the devLogin + structure of `contact-detail.spec.ts`. Self-contained (unique role/label per run via a timestamp).

- [ ] Step 1: Write the spec. → Step 2: (GATED) After all unit work green + approval, reseed + run `npx playwright test tests/dashboard-next/contact-create.spec.ts` then the full suite. → Step 3: Commit `git commit -am "test(e2e): create extensible contact (Other/Case worker) + 409 conflict"`.

---

## Self-Review

- **Spec coverage:** data model (T1, persisted T2/T3), create dialog + kind/Other (T9/T10), 409-ask (T10/T14), display cards + badge (T12), edit (T13), vocabulary auto-suggest (T4/T8, wired T6/T7/T9/T10/T13), backend validation (T1–T3), client-side relationship search (T7/T10/T11). Build process — see spec §10 + the orchestrator handoff prompt. ✔ all sections mapped.
- **Placeholders:** the UI tasks (T6–T13) give the exact prop interface + the test-case list + the template components to copy (Modal/ContactEditForm/PhoneManager) rather than full JSX — acceptable for an orchestrator-driven build where adversarial review covers gaps; backend + contracts + 409 flow are fully concrete.
- **Type consistency:** `Relationship {role,name,contactId?}` and `CustomField {label,value}` and `ContactVocabulary {roles,relationshipRoles,fieldLabels}` are identical across backend (T1) + frontend (T5) + UI (T6–T13). `displayKind`/badge rule consistent (T11/T12). `createContact`/`getContactVocabulary` signatures consistent (T5 → T10/T8).
