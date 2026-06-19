# Extensible contact creation — design

**Status:** approved (brainstorm), pending implementation plan.
**Date:** 2026-06-18.
**Surface:** new dashboard (`dashboard/`, :5174) Contacts list + contact-detail page; `app/` contacts routes/repos.

## Problem

Today a contact only comes into existence when an unknown number texts in (auto-capture →
triage). There is **no way to manually create a contact** from the dashboard, even though the
backend already has `POST /api/contacts`. Worse, the fixed `type` enum (tenant / landlord /
pm / team_member / unknown) doesn't fit everyone a navigator deals with — e.g. a **case
worker** the navigator talks to *instead of* the tenant. We need to:

1. Create contacts from the Contacts page.
2. Support contact "kinds" beyond the fixed enum, framed to the user as one choice (not
   "type + role"), **based on** one of the known kinds so they inherit its fields/behaviour.
3. Capture relationships between contacts (a case worker → their client) that work **whether
   or not** the related person is itself a contact we track.
4. Capture arbitrary extra info (custom fields).

## Decisions locked in brainstorming

- **Per-contact flexible**, NOT a reusable type registry. A custom kind is data on the
  contact, not a defined schema. (Reuse comes from auto-suggest, below.)
- **Custom fields are plain text** (label → value).
- **Relationships are link-or-text**: link the real record when it exists; fall back to a
  typed name when it doesn't.
- **Type & role are one question to the user** via a "kind" picker that includes **Other**.
- **Phone-already-taken does NOT auto-navigate** — it asks.
- **Rich auto-suggest is in v1**, backed by a small server-maintained vocabulary.
- Relationships + custom fields are in the **create** dialog AND editable afterward.

## 1. Data model (additions to the contact record)

The contact item is a flexible document (`[key: string]: unknown`), so these are additive —
**no schema migration.** Base `type` (the enum) is unchanged; it still drives the
`byTypeStatus`/`byHousingAuthority` GSIs, the file-pane layout, and send/behaviour. The new
fields layer human meaning on top.

```ts
// camelCase (project convention).
role?: string;                 // custom kind label, e.g. "Case worker". Set ONLY for "Other"
                               // contacts; empty for standard ones (badge falls back to type).

relationships?: Relationship[];
interface Relationship {
  role: string;                // the link label, e.g. "Client", "Caseworker", "Spouse"
  name: string;                // display label — ALWAYS present (the linked contact's name
                               // snapshot, or free text when there's no record)
  contactId?: string;          // present when linked to a real contact → clickable through
}

customFields?: CustomField[];
interface CustomField {
  label: string;               // non-empty, e.g. "Agency"
  value: string;               // plain text, e.g. "Atlanta Housing"
}
```

**Why `name` always present (not "exactly one of contactId/name"):** display is then trivial
(show `name`; if `contactId`, wrap in a link) and there's no per-relationship GET enrichment.
Linking an existing contact snapshots its display name into `name`; the link stays fresh
enough and degrades gracefully if the target is later renamed/removed.

**Badge rule (display everywhere a type badge shows):** `role` when set, else the base-type
label. So a case worker (`type: 'tenant'`, `role: 'Case worker'`) shows "Case worker" and
lives under the Tenants filter with tenant-style fields.

## 2. Creating a contact

**Entry point:** a **"New contact"** button on the Contacts list header (all four list routes:
all / tenants / landlords / unknown). Opens a create dialog (`Modal`).

**The "kind" picker (the type+role unification):** one control — *"What kind of contact is
this?"* → **Tenant · Landlord · Property mgr · Other**.

- **Tenant / Landlord / Property mgr** → sets the base `type`; `role` stays empty; that type's
  standard fields appear. The user never sees the word "role".
- **Other** → a short guided reveal:
  - *"What do you call them?"* → `role` text input **with auto-suggest** (e.g. "Case worker").
  - *"What kind of record does this person fit?"* → Tenant / Landlord / Property mgr — this is
    the base `type` that decides standard fields + file layout.
  - Then that base type's standard fields appear.

**Standard fields** (by resolved base type): First name, Last name, Phone (**optional**),
plus Voucher size (tenant) / Company (landlord). Status defaults to `active` server-side.
(Housing authority / address stay edit-after, to keep create short.)

**Relationships** — optional. A `RelationshipsEditor`: "+ Add relationship" rows, each = a
**relationship role** (text + auto-suggest: "Client") and a target chosen via a contact
search field — pick an existing contact (sets `name` + `contactId`) or just type a name
(sets `name`, no `contactId`).

**Custom fields** — optional. A `CustomFieldsEditor`: "+ Add custom field" rows, each = label
(text + auto-suggest) → value (text).

**On Create → `POST /api/contacts`:**
- **201** → navigate to `/contacts/:newContactId`.
- **409 phone_in_use** → the dialog **stays open** and shows: *"That number already belongs to
  **<Name>**."* with an **"Open their page"** button (navigates only if the user clicks) and
  the ability to change the number or cancel. (The 409 body already returns the existing
  `contact`, so we have the name + id.)
- Other validation errors → inline message; dialog stays open.

## 3. Showing it on the contact page

Two **type-agnostic** cards, rendered by `ContactDetail` (the shared shell) for ALL kinds, so
they aren't duplicated across TenantFile/LandlordFile/UnknownFile:

- **Relationships card** — one row per relationship: the relationship role + the target. A
  linked target (`contactId`) renders as a `<Link to="/contacts/:contactId">` showing `name`;
  a text target shows `name` plain. Empty → hidden or a quiet empty row. An **Edit** affordance
  opens the Edit dialog's relationships section.
- **Custom fields card** — label → value rows. **Edit** opens the Edit dialog's custom-fields
  section. Empty → hidden.

The **header badge** uses the badge rule (role ?? type). The Contacts **list row** badge uses
the same rule, so a case worker row reads "Case worker".

## 4. Editing

The existing **Edit dialog** (`ContactEditForm`) gains three sections — **Role** (free text,
editable; converting a standard contact to a custom kind = giving it a role), **Relationships**,
**Custom fields** — built from the **same** `RelationshipsEditor` / `CustomFieldsEditor`
components the create dialog uses. One editing surface; create and edit are symmetric.

**Base type is editable here too** (added 2026-06-18, superseding the original "triage-only"
note): a **Type** selector (Tenant / Landlord / Team; an off-list current value like `unknown`
is prepended so it isn't silently changed). It drives which type-specific fields render and
PATCHes `{ type }` when changed — so a mis-triaged contact (e.g. someone set up as a Tenant who
is really a Landlord) can be fixed without re-triaging from the Unknown view. Switching type is
non-destructive: the other type's fields stay on the record (dirty-tracked PATCH never blanks
them) and reappear if you switch back. The Unknown-file triage CTA remains as the fast path for
untriaged contacts.

## 5. Rich auto-suggest (server-maintained vocabulary)

A single **vocabulary record** holds the distinct tokens ever used:

```
roles: Set<string>              // custom kind labels  ("Case worker")
relationshipRoles: Set<string>  // relationship roles  ("Client")
fieldLabels: Set<string>        // custom-field labels ("Agency")
```

- **Storage:** one singleton item using DynamoDB **String Sets**, updated with an atomic
  `ADD` UpdateExpression (idempotent + concurrency-safe; no read-modify-write). Home: the
  `settings` table under a fixed id (a dedicated thin `contactVocabularyRepo`).
- **Write path:** on `POST` and `PATCH /api/contacts`, after a successful write, best-effort
  `ADD` any new `role` / relationship `role`s / custom-field `label`s to the vocabulary. A
  failure here logs and does NOT fail the contact write.
- **Read path:** `GET /api/contacts/vocabulary` → `{ roles, relationshipRoles, fieldLabels }`
  (sorted). The form loads it once (a `useContactVocabulary` hook) and feeds the datalists.

## 6. Backend changes

- **`POST /api/contacts` (parseCreateBody)** — accept `role`, `company`, `relationships`,
  `customFields` (in addition to today's type/name/phone/voucher/notes/status/contactName).
- **`PATCH /api/contacts/:id` (parseTriageBody)** — accept the same four (already gained
  `company` + `housingAuthority` + `address` in the prior change).
- **Shared validators** (used by both routes):
  - `role`: string; trimmed; stored only if non-empty.
  - `relationships`: array; each `{ role: non-empty string, name: non-empty string,
    contactId?: string }`; rows missing role or name are rejected (400). Stored as given.
  - `customFields`: array; each `{ label: non-empty string, value: string }`; rows with an
    empty label are dropped; value kept as-is.
- **Vocabulary repo + route** (section 5).
- **Contact search for relationship linking:** v1 reuses the existing contacts list data
  (all kinds) and filters client-side by name. No new search endpoint in v1; server-side
  search is a later upgrade. (The plan confirms how the picker sources the candidate list —
  likely the `all` contacts fetch.)

## 7. Components / files

**Frontend (new, under `dashboard/src/routes/contact/` unless noted):**
- `ContactCreateForm.tsx` (+ css) — create dialog: KindPicker + standard fields + editors + 409 handling.
- `KindPicker.tsx` — the Tenant/Landlord/PM/Other picker + the "Other" guided reveal.
- `RelationshipsEditor.tsx` (+ css) — add/remove/edit relationship rows.
- `CustomFieldsEditor.tsx` (+ css) — add/remove/edit label→value rows.
- `ContactSearchField.tsx` — search-to-link an existing contact (pick → name+contactId, or free text).
- `RelationshipsCard.tsx` / `CustomFieldsCard.tsx` — display on the contact page.
- `useContactVocabulary.ts` — fetch the auto-suggest vocabulary.
- api `types.ts`: `Relationship`, `CustomField`, `ContactVocabulary`, extend `Contact` +
  `ContactPatch`, add a `ContactCreate` shape. `endpoints.ts`: `createContact`,
  `getContactVocabulary` (and reuse for the search source).

**Frontend (modified):**
- `ContactsList.tsx` — "New contact" button + create-dialog state; row badge uses role ?? type.
- `ContactEditForm.tsx` — Role / Relationships / Custom-fields sections via the shared editors.
- `ContactDetail.tsx` — render the shared Relationships + Custom-fields cards; header badge role ?? type.

**Backend (modified/new, under `app/src/`):**
- `routes/contacts.ts` — extend parseCreateBody + parseTriageBody; vocabulary update on write;
  `GET /vocabulary` route. Shared relationship/custom-field validators.
- `repos/contactVocabularyRepo.ts` (new) — singleton SS record, `add()` + `get()`.
- `repos/contactsRepo.ts` — `ContactItem` typing for the new optional fields (flexible doc, so
  mostly documentation + the create path persisting them).

## 8. Non-goals (v1)

- Reusable / defined custom-type **registry** (we chose per-contact flexible).
- Custom-subtype **filters/sections in the left nav** (a case worker shows under its base type).
- **Server-side** contact search for the relationship picker (client-side for v1).
- Typed custom fields beyond text (number/date/dropdown).
- Editing a relationship's linked target's *own* record from the relationship card (just links out).

## 9. Testing

- **Backend:** POST + PATCH accept/validate `role` / `relationships` / `customFields`;
  bad rows → 400; vocabulary `ADD` on write + `GET /vocabulary`; existing dedupe-409 unchanged.
- **Frontend (unit):** KindPicker (Tenant path vs Other guided path → resolved type+role);
  RelationshipsEditor (link vs text rows, add/remove); CustomFieldsEditor (add/remove, drop
  empty-label rows); ContactCreateForm (success → navigate; 409 → "open their page" choice, no
  auto-nav); useContactVocabulary datalists; RelationshipsCard/CustomFieldsCard display
  (linked → Link, text → plain); list/header badge = role ?? type.
- **e2e:** create a "Case worker" (Other → role "Case worker", based on tenant) with a
  relationship (linked + text) and a custom field → lands on the contact page showing the role
  badge, the relationship (clickable + text), and the custom field; reload persists; the 409
  path shows the "open their page" choice without navigating.

## 10. Build process (orchestrated, with adversarial review)

This is built by an **orchestrator agent** driving sub-agents (the project's established
pattern), working from the implementation plan in `docs/superpowers/plans/`.

- **Isolation:** work happens in a dedicated git worktree under `w:\tmp` (never move `main`'s
  HEAD; never branch-switch in the shared working dir). One branch for the feature.
- **Builder sub-agents** implement each plan slice. Each slice must leave the workspace green
  at the **unit** level: typecheck + eslint + the relevant unit tests (Vitest). **e2e/integration
  is deferred to a single gated pass at the end** — agents do NOT run the e2e stack
  autonomously; the orchestrator runs it (or hands off) only after unit-level work is green and
  **after explicit approval**.
- **Reviewer sub-agent** checks each slice against the spec + conventions before it's accepted.
- **Adversarial reviewer sub-agent(s)** independently try to break the implementation and
  **flag** issues. They must consider (non-exhaustive):
  - architectural / design fit (boundaries, single-responsibility, follows existing patterns)
  - race conditions + concurrency (esp. the vocabulary `ADD` write-path, SSE/refetch, optimistic updates)
  - error handling (network failures, 409/400 paths, partial writes, the 409 "open their page" flow)
  - edge cases (empty/duplicate relationships + custom fields, self-referential links, very long values, missing names, deleted linked contacts, "Other" with no role, switching kind mid-form)
  - security (input validation/sanitization, XSS via custom-field/role/name values, authz on the new routes, no PII leakage in logs)
  - integration issues (does it break inbox/timeline/triage/edit; GSI behaviour unchanged; vocabulary route + datalists wired)
  - **camelCase / naming consistency** (project convention — `role`/`relationships`/`customFields`/`relationshipRoles`; no snake_case drift; storage vs wire vs UI names aligned)
  - validation completeness, accessibility (roles/labels/keyboard on the dialog + editors), test coverage gaps, dead/duplicated code, and anything else that smells wrong.
- **Disposition:** the **orchestrator owns every flagged issue** and must disposition each one —
  either **fix it** (dispatch a fix sub-agent) or **mark it pedantic and consciously ignore it**
  with a one-line rationale. Nothing is left undecided; pedantic findings are dropped on
  purpose, real ones are fixed and re-verified.
- **Done means:** spec satisfied, unit suites + typecheck + lint green, adversarial findings all
  dispositioned, and the gated e2e pass green (after approval). The orchestrator reports the
  disposition ledger back.

The deliverable from planning is therefore **both** the implementation plan **and** an
orchestrator handoff prompt that encodes this process.
