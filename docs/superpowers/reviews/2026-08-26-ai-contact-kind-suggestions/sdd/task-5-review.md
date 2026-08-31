# Task 5 cold dashboard review

## Verdict

PASS. I found no must-fix or plausible behavior regression in `42313627..d4fb6f2c`.
The slice conforms to the approved S5 dashboard contract. I did not run Vite,
Vitest, typecheck, or ESLint because the mission recovery budget explicitly bans
those executions in this review. The implementer's permitted focused evidence is
quoted below, and my only executable check was `git diff --check`.

## Mandatory attacks

### Canonical map, exact Property Manager role, and defensive copies

- CONFORMS: `dashboard/src/routes/contact/contactProfile.ts:11-45` defines the
  exact four-value `SuggestedContactKind`, maps `property_manager` to
  `{ type: 'landlord', role: 'Property Manager' }` through the existing `PM_ROLE`,
  keeps Property Manager out of `ContactType`, and returns a fresh spread copy of
  the private PATCH row. No caller can mutate `KIND_PATCH` through the helper's
  return value.
- CONFORMS: `dashboard/src/routes/contact/contactProfile.test.ts:110-124` pins all
  four labels and PATCH pairs plus raw fallback for an unknown forensic value.
- Concrete mutation attack: mutating the object returned by
  `patchForSuggestedContactKind('property_manager')` cannot affect a later call,
  because each call spreads the private row at `contactProfile.ts:45`.

### KindPicker current and Other paths

- CONFORMS: exact PM detection remains `landlord` plus exact `PM_ROLE` at
  `dashboard/src/routes/contact/KindPicker.tsx:45-61`.
- CONFORMS: canonical segment clicks consume the shared PATCH helper at
  `KindPicker.tsx:96-110`; Tenant, Landlord, and Partner clear role, while PM writes
  the exact preset. The `other` branch at `KindPicker.tsx:97-104` still preserves
  an existing Other value and does not pass a custom role through the canonical
  map.
- Existing focused cases cover Tenant, PM preset, PM-to-Other preservation,
  Other-to-PM construction, rehydration, and Other re-click behavior in
  `dashboard/src/routes/contact/KindPicker.test.tsx:72-205`.

### Unknown actions, order, disabled/busy/retry, and narrow wrapping

- CONFORMS: `dashboard/src/routes/contact/UnknownFile.tsx:86-131` renders the exact
  accessible order Tenant, Landlord, Partner, Property Manager. Every action uses
  `disabled={triaging || !onTriage}` and emits its canonical kind.
- CONFORMS: `dashboard/src/routes/contact/UnknownFile.module.css:7-12` adds
  `flex-wrap: wrap` without widening or restructuring the card.
- CONFORMS: `dashboard/src/routes/contact/UnknownFile.test.tsx:74-101` pins Partner
  and Property Manager labels, exact action order/callbacks, and all-four disabled
  state.
- Interleaving attack: once ContactDetail sets the shared `triaging` flag, every
  action receives the same disabled state; a rejection reaches `finally`, clears
  only that flag, and leaves the contact object Unknown, making the same four
  actions retryable.

### ContactDetail PATCHes and returned-contact-only transition

- CONFORMS: `dashboard/src/routes/contact/ContactDetail.tsx:641-650` sends only
  `patchForSuggestedContactKind(kind)`, sets local contact state only inside the
  resolved promise with `setContact(updated)`, swallows a rejected classification
  without optimistic filing, and re-enables actions in `finally`.
- CONFORMS: `dashboard/src/routes/contact/ContactDetail.test.tsx:445-475` pins the
  full two-field PATCH for all four actions, proves returned Partner and Property
  Manager contacts leave the Unknown pane, and proves rejection leaves Unknown
  retryable.
- No suggestion accept/dismiss call was added to this path. Classification remains
  owned by the existing contact PATCH route.

### Edit form diff-only Property Manager and Landlord shapes

- CONFORMS: the form remains diff-only at
  `dashboard/src/routes/contact/ContactEditForm.tsx:232-239` and remains on the
  single `updateContact` boundary at `ContactEditForm.tsx:350-395`.
- CONFORMS: `dashboard/src/routes/contact/ContactEditForm.test.tsx:256-275` proves
  Unknown to Property Manager sends both `type: 'landlord'` and the exact role,
  while stored Property Manager to plain Landlord sends only `{ role: '' }`.
  That role-only PATCH is intentionally kind-affecting under the S4 backend
  contract.

### Direct profile readers and renderers

- CONFORMS: `displayKind` remains role-first at
  `dashboard/src/routes/contact/contactProfile.ts:63-67`.
- CONFORMS: ContactDetail routes Property Manager through the Landlord-backed file
  while retaining the role label at `dashboard/src/routes/contact/ContactDetail.tsx:548-568`.
- CONFORMS: list, search, and landlord-file renderers still use `displayKind` at
  `dashboard/src/routes/contacts/ContactsList.tsx:111`,
  `dashboard/src/routes/contact/ContactSearchField.tsx:279`, and
  `dashboard/src/routes/contact/LandlordFile.tsx:132`. Partner remains routed to
  `PartnerFile`; Tenant and Unknown routing is unchanged.
- CONFORMS: `dashboard/src/routes/today/buildToday.ts:61-71,310` remains based on
  conversation type, so Property Manager preserves the specified Landlord-backed
  conversation behavior. No contact-profile reader or renderer changed to treat
  `property_manager` as a new `ContactType`.

### AI decision ledger and forensic preservation

- CONFORMS: `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:16-21,76-78`
  humanizes only a decision whose target is exactly `type`. Non-type proposed
  values use the unchanged raw `proposedValue ?? proposedOp` result.
- CONFORMS: unknown type values fall through unchanged via
  `suggestedContactKindLabel`, while `run.rawText` and `run.rawResult` stay on their
  original render paths. `dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx:132-144`
  pins humanized `property_manager`, unchanged `snake_case`, and raw forensic panes.

### Generic suggestions and API shape

- CONFORMS: the diff package lists only the 11 S5 dashboard component/style/test
  files; it does not modify `dashboard/src/api/types.ts` or
  `dashboard/src/api/endpoints.ts`.
- CONFORMS: `dashboard/src/api/endpoints.ts:1441-1491` still keeps contact PATCH,
  generic suggestion accept, and generic suggestion dismiss as separate APIs.
  `SuggestionItem.suggestedValue` remains a string at
  `dashboard/src/api/types.ts:1748`.
- No generic suggestion callback, wire shape, target behavior, server file, seed,
  import, prompt, or schema was changed by this slice.

## Verification evidence

- Prior permitted focused dashboard run from
  `.superpowers/sdd/2026-08-26-ai-contact-kind-suggestions/task-5-focused-tests.log`:
  `Test Files  6 passed (6)` and `Tests  205 passed (205)`, exit 0, duration
  31.05s. The log contains pre-existing React `act(...)` warnings in unrelated
  manual-extraction tests; no focused case failed.
- Prior implementer report at
  `.superpowers/sdd/2026-08-26-ai-contact-kind-suggestions/task-5-report.md` records
  `npm run typecheck -w @housingchoice/dashboard` exit 0.
- Reviewer command: `git diff --check 42313627..d4fb6f2c` exit 0, no output.
- Worktree was clean at `feat/ai-contact-kind-suggestions@d4fb6f2c` during review.

## Lint attribution and non-blocking baseline observations

- The implementer reports only unused `PlacementsPage` and `UnitsPage` imports in
  `dashboard/src/routes/contact/ContactDetail.test.tsx:5`. Static comparison with
  `main:dashboard/src/routes/contact/ContactDetail.test.tsx` confirms the same
  imports are already present on main, and this slice does not edit that import
  line. I found no new static lint cause in the changed lines.
- Pre-existing, not introduced by this commit: the header comment at
  `dashboard/src/routes/contact/UnknownFile.tsx:4-7` still says classification is
  disabled until a backend endpoint exists and every contact route is GET. Runtime
  code and tests demonstrate the opposite. This is stale documentation, not an S5
  behavior regression, and is not a merge blocker for this slice.

