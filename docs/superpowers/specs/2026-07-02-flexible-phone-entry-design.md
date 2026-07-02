<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Flexible phone entry — accept human formats everywhere, store E.164

**Date:** 2026-07-02 · **Status:** design (ready for implementation plan)
**Related:** `app/src/lib/phone.ts` (the existing backend normalizer — the semantics
to mirror), `dashboard/src/routes/settings/VoiceSection.tsx`,
`dashboard/src/routes/contact/ContactCreateForm.tsx`,
`dashboard/src/routes/contact/PhoneManager.tsx`,
`dashboard/src/routes/public/IntakeForm.tsx`, `app/src/routes/voiceApi.ts`.

## 1. Why

Humans type phone numbers as `4049824978`, `(404) 982-4978`, `404-982-4978`, or
`+1 404 982 4978` — not E.164. Today the UX is inconsistent and partly hostile:

- **Settings ▸ Voice cell field is strict at BOTH layers**: the client hard-rejects
  anything non-E.164 ("Enter a number in E.164 format, e.g. +14045550100",
  `VoiceSection.tsx` ~L65 local `isE164`) AND the server's verify-start +
  originate-`phone` checks are strict `isE164` with no normalization
  (`app/src/routes/voiceApi.ts`). A staffer typing their own cell normally is
  rejected. This is the acute bug.
- **Contact create / PhoneManager work by accident** — they send raw text and the
  backend normalizes (`contacts.ts` uses `normalizeToE164`) — but their
  placeholders (`e.g. +14041112222`) train staff that E.164 is required, and junk
  input costs a server round-trip to find out.
- The backend already has the RIGHT normalizer: `app/src/lib/phone.ts`
  `normalizeToE164` (NANP-first, no country guessing) + `formatPhoneForDisplay`.
  The gap is (a) the dashboard has no client-side equivalent and (b) two voice
  endpoints bypass it.

## 2. Normalization rules (LOCKED — identical on both sides)

Mirror `app/src/lib/phone.ts` exactly; these are the decided semantics:

| Input | Result |
|---|---|
| Bare **10 digits** (any punctuation/spacing) | assume US → `+1XXXXXXXXXX` |
| **11 digits leading 1** | `+1XXXXXXXXXX` |
| **Explicit `+`** prefix | respected as-is (any country), E.164 shape-check only — never re-guess a typed country code |
| Anything else (7 digits, garbage, wrong shape) | invalid — inline error, no guessing |

**Interaction model (DECIDED): normalize-on-blur, NOT an as-you-type mask.** The
field is free text; on blur (and again on submit) the value normalizes — valid
input snaps to the friendly display form, invalid input gets an inline error
BEFORE any server round-trip. No cursor-jumping input masks.

## 3. Dashboard: one shared phone module

New `dashboard/src/lib/phone.ts`:
- `normalizeToE164(raw): string | undefined` — a VERBATIM port of the app's
  function (same table above). Both files get a comment pinning them to each
  other ("keep in sync with <other path>") — the unit tests pin the same cases
  on both sides so drift fails a test, not a user.
- `formatPhoneDisplay(e164): string` — `+1XXXXXXXXXX` → `(404) 982-4978`;
  non-NANP returned unchanged. (The contact routes already have a local
  `formatPhone` in `routes/contact/format.ts` — consolidate: it should re-export
  or be replaced by the lib version, ONE formatter.)
- Optionally a tiny `usePhoneField` helper (value, display, error, onBlur) so the
  four forms don't hand-roll the same blur logic — implementer's call; no
  over-abstraction if two lines suffice.

## 4. Touch points

**Dashboard inputs — all become free-text + normalize-on-blur/submit + friendly
placeholder (`(404) 555-0123`) + inline invalid error
("Enter a 10-digit US number, or a full international number starting with +"):**
1. **Settings ▸ Voice cell** (`VoiceSection.tsx`): REMOVE the local strict
   `isE164`/error copy; normalize on blur; send the E.164 to verify-start. This
   is the acute fix.
2. **ContactCreateForm** phone field.
3. **PhoneManager** add-number field.
4. **Public IntakeForm** phone field (backend already normalizes; this adds the
   same client behavior + placeholder so the public funnel matches).
5. Sweep any other dashboard `placeholder="+1…"` / E.164-error copy (e.g. relay
   member add, if it has a phone input) to the same pattern — grep, don't assume.

**Server (validate-flexibly, store canonically — never trust the client):**
6. `app/src/routes/voiceApi.ts` verify-start `{cell}`: `isE164` →
   `normalizeToE164`; store/dial the NORMALIZED value; same 400 `invalid_cell` on
   undefined.
7. `app/src/routes/voiceApi.ts` originate `{phone}`: same switch; the normalized
   value must still match one of the contact's own numbers (the ownership check
   compares E.164-to-E.164, unchanged).
8. Audit for any other strict `isE164` request-validation (grep `isE164(` in
   routes) — display/GSI-shape checks stay strict; REQUEST-input checks
   normalize.

**Display consistency (cheap wins in the same pass):** where raw E.164 is shown
to staff in the touched components (e.g. VoiceSection's verified-cell line),
render `formatPhoneDisplay` instead.

## 5. Out of scope

- As-you-type masking (decided against).
- Non-NANP default-country support / libphonenumber (the `+`-explicit path covers
  international; the backend comment already marks the widening seam).
- Changing stored data (already E.164; no migration).

## 6. Testing

- **Dashboard unit:** the shared `normalizeToE164` port — same case table as the
  app's tests (10-digit, 11-digit, punctuation, `+` international, 7-digit reject,
  garbage reject). Per-form: blur snaps to display form; invalid shows inline
  error and blocks submit; the API receives E.164.
- **App unit:** voiceApi verify-start accepts `(404) 982-4978` (stores
  `+14049824978`); originate `{phone}` accepts flexible input but still rejects a
  number the contact doesn't own; garbage still 400s.
- **e2e:** the Settings ▸ Voice verify flow driven with a HUMAN-format cell
  (e.g. `404-982-4978`) end-to-end; contact-create with `(470) 555-0132`
  resolves to the E.164 contact (existing steps.ts verbs may need the input
  format relaxed, not the assertions — stored values stay E.164).

## 7. Rollout

Pure app+dashboard change, no infra/schema/env. Existing data untouched.
