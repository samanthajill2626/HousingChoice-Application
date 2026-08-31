# Task 5 report - four-kind staff UI

## TDD evidence

- RED: `npm run test -w @housingchoice/dashboard -- src/routes/contact/contactProfile.test.ts` exited 1. All five new mapping/fallback assertions failed because `suggestedContactKindLabel` was not a function.
- GREEN: the final required focused suite exited 0: 6 files passed, 205 tests passed, duration 31.05s. Captured output: `.superpowers/sdd/2026-08-26-ai-contact-kind-suggestions/task-5-focused-tests.log`.
- Typecheck: `npm run typecheck -w @housingchoice/dashboard` exited 0.

## Delivered

- Canonical dashboard `SuggestedContactKind`, exact labels, defensive-copy PATCH map, and forensic fallback live in `contactProfile.ts`.
- `KindPicker` and Unknown-card triage both consume the single map; the Unknown card offers Tenant, Landlord, Partner, Property Manager in that order, with shared busy/disabled state and wrapping actions.
- `ContactDetail` sends only the canonical full PATCH and uses the returned contact as the sole state transition; rejected triage remains Unknown and retryable.
- Edit tests pin Unknown -> PM `{ type: 'landlord', role: 'Property Manager' }` and stored PM -> Landlord `{ role: '' }` diff-only behavior.
- The AI-run Decision ledger humanizes only `type` proposed values. Raw model response and parsed result remain untouched.

## Sweep

- Mutation boundary: `dashboard/src/api/endpoints.ts:updateContact` remains the sole contact-classification writer used by ContactDetail and ContactEditForm. No suggestion-resolution request was added.
- Renderers/readers checked: KindPicker, UnknownFile, ContactDetail kind routing/display, ContactEditForm, and AiRunDetail. Existing list/search/Today consumers remain untouched and keep role-first `displayKind` behavior.
- No server, API-shape, schema, prompt activation, E2E, infra/config, seed/import/migration, or production-data files changed.

## Lint

- Touched-file eslint command exited 1 only on pre-existing `ContactDetail.test.tsx` unused imports `PlacementsPage` and `UnitsPage` at line 5. `git show main:dashboard/src/routes/contact/ContactDetail.test.tsx` contains the same import and this slice's diff does not modify it; it is intentionally out of scope. `UnknownFile.module.css` emitted its expected no-config warning.

## Commit

- `d4fb6f2c feat: offer four AI contact kind actions`
