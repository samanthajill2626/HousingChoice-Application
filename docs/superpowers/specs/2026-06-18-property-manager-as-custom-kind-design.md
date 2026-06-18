# Property Manager as a custom kind (collapse the `pm` contact type) — design

**Status:** approved (brainstorm), pending implementation plan.
**Date:** 2026-06-18.
**Builds on:** the Extensible Contact Creation feature
(`docs/superpowers/specs/2026-06-18-extensible-contact-creation-design.md`), now merged to `main`
(`53b42cc`). That feature added the per-contact `role` custom-kind mechanism this change relies on.
**Surface:** `app/` contacts repo/routes/tests; `dashboard/` contact + contacts routes/tests.

## Problem

`pm` (property manager) is one of the fixed `ContactType` base values
(`tenant | landlord | pm | team_member | unknown`), but there aren't enough property managers, and
they have no genuinely separate behaviour, to justify a first-class type. In practice `pm` is a
half-integrated special case:

- The contact **list / file / filter** group `pm` with `landlord` (the Landlords tab fetches both;
  `LandlordFile` renders both; the create/edit forms show the Company field for both).
- But the **comms layer** (inbox role, conversation type, voice/webhook author attribution) only
  checks `type === 'landlord'`, so a `pm` contact silently falls through to `unknown` there.

The Extensible Contact Creation feature introduced exactly the right tool to express this without a
dedicated type: a **custom kind** is a `role` string layered on a base `type`. A property manager is
naturally **`type: 'landlord'` + `role: 'Property Manager'`**.

## Decision (locked in brainstorming)

- **Collapse `pm` into `landlord` + role.** Remove `pm` as a base `ContactType`; "Property Manager"
  becomes a custom kind on the `landlord` base.
- **Greenfield — no migration.** No contact is currently stored with `type: 'pm'` (seed data has
  none; the user confirmed no `pm` records exist). The change is forward-only; no data migration.
- **Remove `'pm'` from the enum entirely** (not kept as a deprecated value). Backend create/triage
  validation rejects `type: 'pm'` going forward (`400`).
- **Keep a one-click "Property Manager" preset** in the Kind picker (discoverable), which now
  resolves to `type: 'landlord'` + `role: 'Property Manager'` instead of `type: 'pm'`.
- **Canonical label is the spelled-out, capitalised "Property Manager"** everywhere it is shown
  (segment label + role string), replacing the old abbreviated "Property mgr".

## Out of scope — the *other* `pm` (do NOT touch)

`UnitContact.role: 'landlord' | 'pm' | 'owner' | 'other'` (`app/src/repos/unitsRepo.ts`,
`UNIT_CONTACT_ROLES`) is a **different axis**: the role a contact plays on a specific unit's roster.
This `'pm'` is unrelated to the contact's *type* and is **unchanged** by this work. In the test
files below, `role: 'pm'` (unit-roster) usages stay; only `type: 'pm'` (contact-type) usages change.

## 1. Data model

- `ContactType` drops `'pm'` → `'tenant' | 'landlord' | 'team_member' | 'unknown'`
  (backend `app/src/repos/contactsRepo.ts`; dashboard `dashboard/src/api/types.ts`).
- Backend create/triage validation (the `CONTACT_TYPES` list in `app/src/routes/contacts.ts`,
  ~line 99–105) drops `'pm'`, so `POST /api/contacts` and `PATCH /api/contacts/:id` with
  `type: 'pm'` now return `400`.
- A shared constant `PM_ROLE = 'Property Manager'` lives in
  `dashboard/src/routes/contact/contactProfile.ts` and is the single source for the preset role
  string (imported by the Kind picker).
- The `CONTACT_TYPE_LABEL` map (also in `contactProfile.ts`) drops its `pm` entry (the enum no
  longer has `pm`).

## 2. Kind picker (the one nuanced piece)

`dashboard/src/routes/contact/KindPicker.tsx`:

- Primary segments stay visually **Tenant · Landlord · Property Manager · Other**.
- The **Property Manager** segment now emits `{ type: 'landlord', role: PM_ROLE }` (a preset custom
  kind) instead of `{ type: 'pm' }`. Tenant/Landlord still emit `{ type, role: '' }`.
- The **Other** guided base-type sub-choice drops "Property mgr" → offers just **Tenant / Landlord**
  (the real bases a custom kind can sit on).
- **Active-segment detection:** `type === 'landlord' && role === PM_ROLE` highlights the
  *Property Manager* segment; `type === 'landlord' && role === ''` highlights *Landlord*. If a user
  reaches the same shape via Other → role "Property Manager" → base Landlord, it harmlessly lights
  up the preset segment (identical data — acceptable).
- The internal UI segment key may stay `'pm'` as a **label-only** identifier; it no longer maps to a
  `ContactType`.

## 3. Collapse the now-redundant `landlord || pm` special-casing

Because property managers *are* landlords now, every `landlord || pm` / `isLandlordOrPm` branch
collapses to a plain `landlord` check:

- `dashboard/src/routes/contacts/useContacts.ts` — `TYPES_FOR`: `landlord: ['landlord']` and `all`
  drops `pm` → `['tenant', 'landlord', 'unknown']`. (PMs now appear under Landlords automatically
  because they are `type: 'landlord'`.)
- `dashboard/src/routes/contact/ContactDetail.tsx` — the file/pill selector `landlord || pm` →
  `landlord`. The pill **colour** stays landlord; the pill **label** already uses `displayKind`, so
  a PM shows "Property Manager" (its role) and a plain landlord shows "Landlord".
- `dashboard/src/routes/contact/ContactCreateForm.tsx` (`isLandlordOrPm`) and
  `ContactEditForm.tsx` (`isLandlord`) → plain `landlord` (still drives the Company field).
- `dashboard/src/routes/contact/LandlordFile.tsx` — the hard-coded
  `contact.type === 'pm' ? 'Property manager' : 'Landlord'` "Role" row becomes
  `displayKind(contact, (t) => CONTACT_TYPE_LABEL[t])` → "Property Manager" or "Landlord" via the
  badge rule (one source of truth).
- **Bonus (no extra work):** the comms/inbox/voice paths that only checked `type === 'landlord'`
  (`app/src/routes/inbox.ts`, `app/src/routes/contacts.ts` conversation-type, `webhooks/twilio.ts`,
  `webhooks/voice.ts`) now treat property managers correctly, because PMs are `landlord`-typed.

## 4. Auto-suggest

No special vocabulary seeding. The first property manager created via the preset writes
"Property Manager" into the `roles` vocabulary through the existing best-effort write-path
(`POST`/`PATCH` → `contactVocabularyRepo.add`), so it appears in role auto-suggest thereafter.

## 5. Testing

**Backend (`app/test/`):**
- Update `type: 'pm'` **contact** seeds → `type: 'landlord'` in `contactTriage.test.ts`,
  `casesVoiceRouting.test.ts`, `unitsApiRoster.test.ts`. **Leave** the `role: 'pm'` **unit-roster**
  usages in those files untouched (different concept).
- The triage test that sends `{ type: 'pm' }` (`contactTriage.test.ts` ~line 180) is updated:
  assert `type: 'pm'` is now **rejected with 400** (the enum no longer accepts it).
- Full `app/` unit suite + typecheck stay green.

**Frontend (`dashboard/`):**
- `KindPicker.test.tsx` — the Property Manager segment fires `{ type: 'landlord', role:
  'Property Manager' }`; the Other base-type sub-choice no longer offers Property mgr; the preset
  segment is shown active for a `{landlord, 'Property Manager'}` value.
- `useContacts.test.tsx` — the Landlords filter fetches only `['landlord']`; `all` no longer fetches
  `pm`.
- A badge check: a `{ type: 'landlord', role: 'Property Manager' }` contact reads "Property Manager"
  on the list row and the detail pill (via `displayKind`).
- Full `dashboard/` unit suite + typecheck + eslint stay green.

**e2e (`e2e/tests/dashboard-next/`, gated — run only in the final approval pass):**
- Optionally extend `contact-create.spec.ts` (or a sibling): create a contact via the **Property
  Manager** preset → it lands under the **Landlords** filter, badged "Property Manager", and
  persists across a reload. The existing specs + full Playwright suite stay green.

## 6. Build process

Small, mechanical, well-bounded (removing one special-case across ~10 files + tests). Implemented in
a dedicated worktree off `main` (`w:\tmp\hc-pm-role`, branch `property-manager-role`) — never moving
`main`'s HEAD. TDD per change; **e2e deferred to a single gated pass** after unit work is green and
approved (same protocol as the feature it builds on). Adversarial review focuses on: any missed
`landlord || pm` / `type === 'pm'` site (search must be exhaustive), the Kind-picker active-segment
detection, and confirming the **unit-roster `pm` role is untouched**.

## 7. Non-goals

- Migrating data (greenfield — none exists).
- Changing the `UnitContact.role` axis or `UNIT_CONTACT_ROLES`.
- A per-custom-kind filter/tab (still a base-type filter; "Property Manager" lives under Landlords).
- Re-theming the landlord pill colour for PMs (they share the landlord colour by design).
