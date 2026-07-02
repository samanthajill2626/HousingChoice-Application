<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Flexible phone entry — implementation plan

Executes `docs/superpowers/specs/2026-07-02-flexible-phone-entry-design.md` (source of truth).
Verified touch-point audit: `.superpowers/sdd/phone-audit.md` (NOTE: port from the REAL
`app/src/lib/phone.ts`, not from the audit's quoted copy).

## Global Constraints (bind every task)
- Rules LOCKED — mirror `app/src/lib/phone.ts` `normalizeToE164` EXACTLY: bare 10 digits → `+1XXXXXXXXXX`;
  11 digits leading 1 → `+1…`; explicit `+` respected as-is (E.164 shape-check only, NEVER re-guess a typed
  country code); anything else → invalid (undefined), no guessing.
- Interaction DECIDED: free-text field; normalize on BLUR + re-check on submit; valid input snaps to the
  friendly display form `(404) 982-4978`; invalid gets the inline error BEFORE any server round-trip.
  NO as-you-type mask. NO new deps (no libphonenumber).
- Placeholder everywhere: `(404) 555-0123`. Inline error copy everywhere:
  `Enter a 10-digit US number, or a full international number starting with +`.
- Server keeps validating (never trust the client); stored values stay E.164 (no migration).
- Display/GSI-shape strictness stays strict; only REQUEST-input validation normalizes.
- PII: no phone values in added log lines. Terminology: unit/property/home; placement.
- Verify with REAL exit codes (write output to a file; `echo EXIT=$?` — never pipe a run through tail).
- Commit EXPLICIT paths; trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  NEVER deploy/secrets/terraform/.env/.docx. Do NOT merge.

---

## Task 1: Shared dashboard phone lib + consolidation + pinned tests

**Files:** create `dashboard/src/lib/phone.ts` + `dashboard/src/lib/phone.test.ts`; modify
`app/src/lib/phone.ts` (cross-link comment ONLY), `dashboard/src/routes/contact/format.ts`
(consolidate `formatPhone`).

- `normalizeToE164(raw): string | undefined` — VERBATIM port of the app's function (port from the real
  `app/src/lib/phone.ts`, same logic line-for-line). Also port `isE164` if the dashboard needs the shape
  check, and `formatPhoneDisplay(e164)` mirroring the app's `formatPhoneForDisplay` (name per spec:
  `formatPhoneDisplay`; `+1XXXXXXXXXX` → `(404) 982-4978`; non-NANP returned unchanged).
- Cross-linking keep-in-sync comments in BOTH files (`app/src/lib/phone.ts` ↔ `dashboard/src/lib/phone.ts`).
- **Pinned tests:** `dashboard/src/lib/phone.test.ts` pins the SAME case table as `app/test/phone.test.ts`
  (all 21 cases — read the app test and mirror every input→expected pair), so drift fails a test.
- **Consolidation:** `routes/contact/format.ts` `formatPhone` (12 importers) becomes a re-export of the lib
  formatter (minimal churn) — or replace the importers if trivially safe. ONE formatter after this task.

**Verify:** `npm run typecheck`; `npm test -w @housingchoice/dashboard` (new tests + all 12 importer
call sites still green); `npm test -w @housingchoice/app` untouched-green.

---

## Task 2: Server — voiceApi flexible validation (+ route audit)

**Files:** modify `app/src/routes/voiceApi.ts`; test `app/test/voiceOutbound.test.ts` (extend).

- Verify-start `{cell}` (~L195): `isE164` → `normalizeToE164`; STORE/SEND the NORMALIZED value through the
  whole flow (pending cell, SMS send, stamp); same `400 { code: 'invalid_cell' }` when undefined.
- Originate `{phone}` (~L119): same switch; pass the NORMALIZED value into the originate service so the
  OWNERSHIP check (`originateCall.ts` ~L125) still compares E.164-to-E.164 against the contact's own
  numbers — that guard must NOT weaken. Same `400 { code: 'invalid_phone' }` on undefined.
- Route audit: the repo has exactly these 2 request-input `isE164` sites (per audit) — confirm with a grep
  and leave any display/shape checks strict.

**Tests:** verify-start accepts `(404) 982-4978` → stores/sends `+14049824978` (assert the stored pending
cell + the SMS target are E.164); still 400s garbage (`404`, `hello`); originate accepts a human-format
`phone` that the contact owns (normalized match) and STILL rejects a number the contact does NOT own
(w/ human formatting too) + garbage 400. No raw phone in new logs.

**Verify:** typecheck; `npm test -w @housingchoice/app` green (full).

---

## Task 3: Forms — normalize-on-blur everywhere + sweep

**Files:** modify `dashboard/src/routes/settings/VoiceSection.tsx` (+ its `.test.tsx`),
`dashboard/src/routes/contact/ContactCreateForm.tsx`, `dashboard/src/routes/contact/PhoneManager.tsx`,
`dashboard/src/routes/public/IntakeForm.tsx` (+ their tests), plus anything the sweep finds.

ALL FOUR forms (spec §4 — the spec applies the pattern to all four, incl. the ones the backend already
normalizes; the point is inline errors BEFORE a server round-trip):
- Free-text input; on BLUR run `normalizeToE164`: valid → snap the field to `formatPhoneDisplay(e164)`;
  invalid (non-empty) → inline error (the locked copy), accessible per the form's existing error pattern
  (role="alert" / aria-describedby — mirror the file's own idiom); block submit while invalid; on submit
  re-normalize and send the E.164 value to the API.
- Placeholder `(404) 555-0123`. Remove VoiceSection's local `isE164` (~L32–34) + its "E.164 format" error copy.
- VoiceSection also renders the verified/pending cell via `formatPhoneDisplay` (display consistency).
- **Sweep:** grep the dashboard for other phone inputs / `+1…` placeholders / E.164 error copy (audit found
  the 4 above; re-grep `placeholder=.*\+`, `E.164`, `+140` to be sure) and convert stragglers to the pattern.
- Update `VoiceSection.test.tsx` L71–86 ("rejects bare 10-digit" — behavior now: accepted + normalized):
  rewrite per spec §6 — blur snaps to display form; invalid shows inline error + blocks submit; the API
  receives E.164.

**Tests per form:** blur with `404-982-4978` → field shows `(404) 982-4978` and submit POSTs `+14049824978`;
blur with `404` → inline error, no POST; explicit `+44…` passes through unchanged. IntakeForm: the A2P
consent gate behavior is UNCHANGED (its tests stay green).

**Verify:** typecheck; `npm test -w @housingchoice/dashboard` green (full).

---

## Task 4: e2e — human-format flows end-to-end (this worktree's lane)

**Files:** extend `e2e/tests/dashboard-next/voice-outbound.spec.ts` (or the Settings/Voice flow spec) and
`e2e/tests/dashboard-next/contact-create.spec.ts`; relax INPUT formats in steps/verbs where needed —
assertions on STORED values stay E.164.

- Settings ▸ Voice verify flow driven with a HUMAN-format cell (`404-982-4978`): field snaps on blur,
  verify-start succeeds, code arrives (dev outbox), verify completes, verified cell displays
  `(404) 982-4978`.
- Contact-create with `(470) 555-0132` → resolves to the E.164 contact (stored `+14705550132`).
- Full suite: `npm run e2e > out.txt 2>&1; echo EXIT=$?` → EXIT=0 (the suite runs on this worktree's own
  lane; warm the shared containers first: `npm run db:start && npm run s3:start`).

**Verify:** the full-suite EXIT=0 evidence + the two new/updated specs green.
