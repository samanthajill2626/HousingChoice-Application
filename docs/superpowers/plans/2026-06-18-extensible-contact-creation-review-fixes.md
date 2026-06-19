<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Orchestrator handoff — Review fixes for Extensible Contact Creation

Paste the block below to the orchestrator that built the extensible-contact-creation +
"Property Manager as a custom kind" feature. The feature is **already merged to `main` and
green** (app 1162 tests, dashboard 367, e2e 14/14). These are **post-merge review findings** —
fix them on a **fresh branch off current `main`** so they can be pulled in afterward. Do NOT
re-do the feature; only make the targeted fixes below.

---

You are the **orchestrator**. The extensible-contact-creation feature you built is merged to
`main` and passing. A second-pass review found the issues below. Go back and fix them on a
**new branch** so they can be reviewed and pulled in.

Reference docs (read for context):
- Spec: `docs/superpowers/specs/2026-06-18-extensible-contact-creation-design.md`
- PM spec: `docs/superpowers/specs/2026-06-18-*property-manager*` (the "Property Manager as a custom kind" spec)
- Plan: `docs/superpowers/plans/2026-06-18-extensible-contact-creation.md`

## Setup
- Create a fresh git **worktree under `w:\tmp`** on a NEW branch off **current `main`** (e.g.
  `git worktree add w:\tmp\hc-contact-fixes -b contact-create-fixes`). Work only there.
- Never touch `main`'s HEAD; never commit to `main`; **do not merge** — the human pulls it in.
- Confirm baseline green first (app + dashboard typecheck/lint/unit).

## Execution
- One fix per logical issue, TDD where practical (add the regression test, see it fail, fix,
  see it pass, commit). Keep each commit unit-green (typecheck + eslint + the relevant Vitest).
- **e2e is gated** — don't boot the stack mid-fix; run the e2e pass once at the end **after
  human approval**. NOTE: the e2e stack is flaky right after `e2e:reseed`/long sessions — if a
  spec fails at `devLogin` (the "Today" heading), `e2e:restart` + reseed and re-run before
  treating it as real.
- Disposition each finding (fix vs. consciously-pedantic-skip with a one-line rationale); report
  a ledger at the end. Run a reviewer + adversarial pass over your fixes.

## Findings to fix (priority order)

### 1. [Med-High] The Edit dialog cannot LINK relationships — no candidates passed
`dashboard/src/routes/contact/ContactDetail.tsx` (~line 308, the `<ContactEditForm …>` render).
`ContactEditForm`'s `candidates` prop defaults to `[]` and `ContactDetail` never passes it, so in
the **edit** dialog `RelationshipsEditor → ContactSearchField` has nothing to search — you can
only add free-text relationships, never link an existing contact. (The **create** path works —
`ContactsList` passes `candidates={contacts}` from `useContacts`.)
- **Fix:** `ContactDetail` must supply a real candidate roster to `ContactEditForm` (e.g. load
  via `useContacts('all')` or an equivalent lightweight fetch) and pass it through. Exclude the
  current contact (see #5).
- **Test:** a `ContactDetail`/`ContactEditForm` unit test asserting the edit relationship picker
  surfaces candidates; extend the create e2e (or add one) to **edit** a contact and link an
  existing contact as a relationship (not just text).

### 2. [Med] Index keys on removable editor rows corrupt input state
`dashboard/src/routes/contact/RelationshipsEditor.tsx:80` and `CustomFieldsEditor.tsx:61` use
`<li key={i}>` (array index). Removing a non-last row makes React reuse DOM for the shifted rows,
bleeding the removed row's input state into the row that slides up — and scrambling
`ContactSearchField`'s internal `activeIndex` for relationship rows.
- **Fix:** give each row a **stable id** assigned when the row is created (monotonic counter or a
  generated id carried in the editor's row model / a parallel id list), and key by that. Both
  editors are controlled — pick the cleanest stable-key approach consistent with the codebase.
- **Test:** render 3 rows, edit the 2nd, remove the 1st, assert the remaining rows show the
  correct values (no bleed).

### 3. [Low-Med] `setBusy(false)` missing on the create success path
`dashboard/src/routes/contact/ContactCreateForm.tsx:122` — after `onCreated(contact)` the `busy`
flag is never reset (only the `catch` resets it). Harmless today because the caller unmounts the
dialog, but it's a latent "Creating…" lock + possible unmounted-setState warning.
- **Fix:** reset `busy` on success (a `finally` guarded against the abort/unmount, or set false
  before `onCreated`).
- **Test:** render with an `onCreated` that does NOT unmount → after a successful create the
  Create button is re-enabled.

### 4. [Low-Med] Escape is a no-op in the contact-search combobox (a11y)
`dashboard/src/routes/contact/ContactSearchField.tsx` (~line 91). The Escape handler sets
`activeIndex` but never dismisses the suggestion list (`isListShown` derives only from
`matches.length`). The code comment admits the intended `dismissed` flag was not implemented —
ARIA combobox requires Escape to collapse the popup.
- **Fix:** add a local `dismissed` boolean; set true on Escape; reset on input change; gate
  `isListShown` on `!dismissed && matches.length > 0`.
- **Test:** type to open the list → Escape → list (listbox/options) gone → typing reopens it.

### 5. [Low-Med] No self-link guard (fix together with #1)
Once #1 is fixed, the edit dialog's `candidates` will include the contact being edited, so a
navigator could link a contact to itself.
- **Fix:** exclude the current contact's `contactId` from the `candidates` passed to the edit
  form (simplest at the `ContactDetail` wiring) and/or filter it in `ContactSearchField`.
- **Test:** editing a contact, the relationship search does not offer that same contact.

### 6. [Low] PATCH stores `role: ""` instead of clearing it
`app/src/routes/contacts.ts:308–313` — `parseTriageBody` writes `patch['role'] = r` even when
`r === ''`, so `PATCH {role:''}` persists an empty string (the **create** path omits empty role).
Display is currently safe (`displayKind` uses `?.trim() || typeLabel`), so this is data-hygiene
only — but it diverges from create and leaves a stale `""` attribute.
- **Fix:** make it consistent. Either skip writing an empty role (then a role can be set but not
  cleared — matches create), or — better, since "clear role" = convert an Other-kind back to a
  standard type — add a **REMOVE** path to `contactsRepo.update` for empty/`null` role and use it.
  Decide based on whether clearing a role must be supported; recommend supporting REMOVE.
- **Test:** PATCH `{role:''}` on a contact that had a role → `GET` returns the contact with **no**
  `role` attribute; badge falls back to the type label.

### 7. [Low, cosmetic] KindPicker highlights "Other" instead of the PM preset for identical data
`dashboard/src/routes/contact/KindPicker.tsx` (~line 31–41). When the user goes Other → role
"Property Manager" → base Landlord, `isPmPresetValue` is guarded by `!otherSelected`, so
`activePrimarySegment` returns `'other'` rather than the "Property Manager" preset — contradicting
the PM spec's "harmlessly lights up the preset segment." Saved data is identical/correct.
- **Fix:** treat `{type:'landlord', role: PM_ROLE}` as the PM preset regardless of `otherSelected`.
- **Test:** pin the segment highlight for that data combination.

### 8. [Low] Test + comment hygiene
- `dashboard/src/routes/contacts/useContacts.test.tsx` — the `all`-filter test asserts the call
  **count** but not the **types**. Strengthen it to assert the fanned-out types are exactly
  `['landlord','tenant','unknown']` so a `pm` re-introduction fails the test.
- Stale `pm` comments: `app/src/lib/tables.ts` (~line 78 GSI comment "tenant | landlord | pm |
  team_member") and `app/src/routes/contacts.ts` (~line 272 "Landlord/PM company name") — drop `pm`.
- `app/src/lib/seedData.ts` (~line 78): `type: 'housing_authority_staff'` is **not** a valid
  `ContactType`, so that seed contact (Renee Carter / `contact-hastaff-0001`) is unreachable
  through every list/triage surface. **Triage:** change to `team_member` or remove the entry.
  (Pre-existing drift, made visible by the `pm` removal — your call to fix or defer.)

## Done means
All fixes committed on the branch; unit suites + typecheck + eslint green across `app/` +
`dashboard/`; the gated e2e pass green (after approval); a disposition ledger reported. Leave the
branch for the human to pull in — do not merge to `main`.
