# D1-S1 delta research - plan section 5 (S1 Tenant matching inputs)

Checked: plan lines 1-515 (binding sections 0-4) and 516-2894 (tasks S1.1-S1.7
and the S1 coverage table) of
`docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md` (v6) against the
worktree source, which is main @d0e2c2d8, and against spec rev 10 D1, D2,
D3 (promptGuidance wording) and sections 4-5. Every quoted "old" anchor was
checked verbatim and for uniqueness; every import, export, helper, harness
field and vitest path the S1 code calls was checked in the live tree; the
tsconfig that compiles each new or touched file was traced (dashboard bundler,
app tsconfig.test.json NodeNext, e2e NodeNext); every new label and chip noun
was checked against every getByLabel / getByLabelText / getByRole name /
getByText query in e2e and the dashboard contact tests. Nothing blocks a step,
reddens a gate or drifts from the spec; three record-only notes follow.

## D1-S1-1 - NOTE - The dashboard mirror is compiled by the E2E typecheck too, not only the app's

- Plan location: S1 cross-slice notes (plan :646-649); S1.3 Step 3 mirror
  header comment (plan :1629-1630); S1.3 Step 6 (plan :1885-1887).
- What the plan says: `dashboard/src/api/types.ts` is "ALSO compiled by the app
  typecheck (types.ts:6-8; app/test/contactTimeline.test.ts imports it)", so the
  mirror it imports types from must stay import-free and NodeNext-clean.
- What the tree holds: a THIRD program compiles types.ts and therefore the
  mirror: `e2e/tests/tour-roster.spec.ts:62-65` value-imports
  `REMINDER_KIND_LABELS` / `REMINDER_SKIP_REASON_LABELS` from
  `../../dashboard/src/api/types.js`, and `e2e/tsconfig.json` includes
  `tests/**/*.ts` under the base NodeNext options with `types: ["node"]`. The
  planned mirror (no imports, ES2022-level code) and the type-only `.js`-suffixed
  import in types.ts compile under all three programs, and Playwright's runtime
  transform elides `import type`, so nothing breaks. The planned guard ("no
  later slice may give it an import") protects the e2e program as well.
- Correction (optional, text only): in the S1 cross-slice note and the mirror
  header, read "the APP and E2E typechecks compile types.ts
  (app/test/contactTimeline.test.ts, e2e/tests/tour-roster.spec.ts)". No code
  change.

## D1-S1-2 - NOTE - S1.5 leaves the card's `suggestions` prop comment stale

- Plan location: Task S1.5 Step 4b (plan :2507-2555).
- What the plan says: 4b replaces the imports and the `contact` prop type; the
  file header (4a) is rewritten to say a pending suggestion for any extractable
  row renders a chip.
- What the tree holds: the next line after 4b's replaced block,
  `dashboard/src/routes/contact/EligibilityIntakeCard.tsx:28`, reads
  `/** Pending AI suggestions for this contact (chips for pets/evictions/tenure). */`
  and stays as is, now incomplete (the four matching rows also take chips).
- Correction: in S1.5 Step 4b, also replace that line (ASCII, unique in the
  file) with
  `  /** Pending AI suggestions for this contact (a chip for every extractable row: pets, evictions, tenure and the tenant matching inputs). */`.

## D1-S1-3 - NOTE - The four rows also render on a team_member's file (as the existing intake rows do)

- Plan location: Task S1.5 (plan :2222-2652); spec D2 "Record ... four
  always-render rows".
- What the plan says: the four rows always render in the Eligibility intake
  card; TenantFile.tsx is not edited (C1).
- What the tree holds: `ContactDetail.tsx:1329` renders `TenantFile` for every
  non-landlord/partner/unknown kind, and TenantFile states it "also serves
  team_member contacts" (`TenantFile.tsx:185-189`); `EligibilityIntakeCard` is
  rendered unconditionally (`TenantFile.tsx:269-276`). So a team member's file
  already shows Pets / Evictions / ... as BLANK rows, and after S1.5 it also
  shows the four matching rows as BLANK. The edit form gates the controls on
  `isTenant` (plan S1.4 3e sits inside the `isTenant ?` block,
  `ContactEditForm.tsx:855-897`), so no write path appears. This matches spec
  D2 ("as the other intake rows have"); recorded only so a reviewer does not
  re-raise it.
- Correction: none required. If Cameron wants the card tenant-only, that is a
  separate change to TenantFile (out of B1 scope).

## Verified with no finding

- (a) tsconfig coverage: `app/src/lib/tenantMatchingInputs.ts` is in
  app/tsconfig.json, tsconfig.scripts.json and tsconfig.test.json (`src`), and is
  pulled into the DASHBOARD program by the mirror test's
  `../../../../app/src/lib/tenantMatchingInputs.js` import (path depth correct,
  precedent `dashboard/src/routes/listing/requirementsMirror.test.ts:18`);
  `dashboard/src/routes/contact/tenantMatchingInputs.ts` is in the dashboard
  program (`include: ["src"]`, bundler) and is pulled into the app test program
  and the e2e program through types.ts. dashboard/package.json is
  `"type": "module"`, so under NodeNext the mirror is ESM; it has no imports, so
  no suffix rule applies. types.ts's new import is `import type` with a `.js`
  suffix, like its existing `retryPromise.js` import (types.ts:8). No rootDir in
  tsconfig.test.json or e2e/tsconfig.json. TypeScript is 5.9.3 (`as const
  satisfies`, key-remapped mapped types over a union of objects, template
  literal `as const` keys all supported); `interface X extends <non-generic
  mapped alias>` is a valid base type. `Contact` keeps its
  `[key: string]: unknown` index signature (types.ts:2453), compatible with the
  inherited optional keys; `TenantMatchingInputPatch` (a mapped type) is
  assignable to `Readonly<Record<string, unknown>>` by the implicit index
  signature rule, so the drift test's `app.parseTenantMatchingInputs(built.patch)`
  compiles. `api/index.ts:3` is `export * from './types.js'`, so
  `TenantMatchingInputSources` reaches EligibilityIntakeCard through the barrel.
  No cycle: suggestionTargets.ts -> mirror (no imports); types.ts -> mirror (type
  only).
- (b) WI7: `app/src/lib/seed/lean.ts` imports nothing from cast.ts
  (lean.ts:13-16); cast is merged only for `full` (seed/index.ts:127-133). The
  S1.6 anchor (cast.ts:453-454) is verbatim and unique; persona 4 is
  `contact-cast-searching-tenant`, type tenant, status searching
  (cast.ts:437-458). None of the four keys exists anywhere in app, dashboard, e2e
  or fake-twilio today. The S1.6 neighbor suites exist (seedRequirements,
  seedMatrix, seedData, seedContactTypeInvariants) and none pins persona 4's key
  set (seedMatrix.test.ts:741-756 checks phones/pointers only;
  seedPersonaDrift, seedRosterShape, seedHeardFrom read other attributes). The
  S1.6 test shape matches seedRequirements.test.ts:8-36 (SEED, castItems,
  matrixItems(now), buildLiveStaticItems(now)).
- (c) WI11: no new label or chip noun contains, or sits inside, any existing
  non-exact query on the contact page. Checked every e2e `getByLabel` string
  (incl. steps.ts:930-934 Pets/Evictions/Time at current address/LIF eligible,
  :1184 Notes, :1714-1717 Street address/City/State/ZIP, :3157 Voucher expiration
  date, contact-detail.spec.ts:63/:105), every e2e `getByRole('group'|'textbox')`
  name, the intake-card `getByText` queries ('cat', 'yes', '1 cat', 'none',
  '3 years', 'Yes'/'No' - none is a substring of the four labels; the four labels
  contain no "no"), and every dashboard contact-test `ByLabelText` regex (/role/i,
  /Phone/i, /Voucher size/i, ...) and `name: /Tenant/i`-style regex (all on
  button/radio/combobox/menuitem/link roles, never textbox/spinbutton/img/group).
  Testing Library string matchers are exact by default. The only
  `getByLabel('Tenant')` (placement-create.spec.ts:132) is scoped to the New
  placement dialog. No dashboard test counts textboxes, spinbuttons, Auto badges
  or BLANKs outside EligibilityIntakeCard.test.tsx / LandlordOnboardingCard.test.tsx.
- (d) Components and their tests: ContactEditForm anchors (:10, :62, :279-282,
  :466-469, :888-897) verbatim and unique; `base` is the as-opened contact
  (:183) and has an index signature, so `tenantMatchingFormValues(contact)` /
  `buildTenantMatchingPatch(matching, base)` type-check; the error path renders
  `<p role="alert">` (:1144-1148), so `findByRole('alert')` sees the portion copy;
  `.field`, `.label`, `.input`, `.textarea` exist in the module CSS and
  `--sp-1` is a token (ui/tokens.css:68). Test fixtures TENANT/LANDLORD
  (ContactEditForm.test.tsx:32-50), `updateContact` mock, `fireEvent`,
  `waitFor`, `userEvent` all exist; import anchor :30 exists. No pre-existing
  ContactEditForm case changes (untouched matching values diff to `{}`).
  ContactCreateForm.test.tsx anchor :19 and `setup()` exist. EligibilityIntakeCard
  anchors (:1-9 with the real em dash, :10-27, :72, :95-96, :98-104, :118) are
  verbatim and unique; KV renders `div.kv > span.k + span.v`
  (Card.tsx:144-166), so `getByText(label).parentElement` is the row and the
  BLANK / Auto assertions are non-vacuous. The four test count edits (:34-36,
  :53, :57-59, :65-66) are all the BLANK counts in the file and are made in the
  same task; new counts 9/8/9/9 and 5 are correct. SuggestionChip anchors
  (:19-21, :29-36, :43) verbatim; `SUGGESTION`, `renderChip` exist; the new prop is
  optional and the three call sites (ContactDetail.tsx:682,
  EligibilityIntakeCard.tsx:102, TenantFile.tsx:170) are unaffected. JSX spread
  of `undefined | {...}` has precedent (TenantFile.tsx:272-275).
  `SuggestionItem` required fields are all present in the plan's literals
  (types.ts:2236-2254). suggestionTargets.ts:6-22 anchor verbatim.
- (e) Route: contacts.ts header :9-10, import :34, triage lifEligible :776-781,
  create lifEligible :975-979 verbatim and unique; `patch` is
  `Record<string, unknown>`; create `item` is `Partial<ContactItem> & { type }`
  and ContactItem carries `[key: string]: unknown` (contactsRepo.ts:387), so
  `item[key] = value` compiles; `changedFields` feeds the awaited
  `contact_updated` audit before `res.json` (:2188-2192, :2255); null -> REMOVE
  in the real repo (contactsRepo.ts:1577-1615) and the harness fake
  (twilioWebhookHarness.ts:2490); GET returns the raw item (:1277-1298); the
  pending-suggestion read per changed field is best-effort (:1964-1978). Harness
  names exist: `makeWebhookHarness`, `ORIGIN_SECRET` (:249),
  `world.auditEvents` with `entityKey` / `event_type` / `payload` (:294-299),
  `TEST_SESSION_COOKIE` (authSession.ts:112). RED reason holds: a body with only
  the four keys answers 400 `no updatable fields supplied` (:833-835). No app
  code uses `keyof ContactItem`, `keyof Contact`, `keyof ContactPatch`.
- (f) Commands: every vitest path in S1 exists or is created by its task
  (app: contactIntakeFields, contactTriage, seedRequirements, seedMatrix,
  seedData, seedContactTypeInvariants; dashboard: ContactEditForm,
  ContactCreateForm, EligibilityIntakeCard, SuggestionChip, TenantFile,
  files); dashboard vitest includes `src/**/*.test.{ts,tsx}`
  (vite.config.ts:146). Every S1.7 Step 1 path exists, so its empty diff is not
  vacuous. The S1.7 Step 3 lint list covers every touched .ts/.tsx; ESLint 9.39
  flat config matches dot-files (`dot: true`), so the `.lint-base-*` baseline
  copy is linted under the same rules.
- Lint: every import the S1 code adds is used; no unused locals; no new hooks
  rule exposure (useId at component top level; no effects).
- ASCII: plan lines 516-2894 hold no non-ASCII byte; the only non-ASCII anchor
  line (EligibilityIntakeCard.tsx:1) is replaced whole; no `\u` escape sits in
  any edited region.
- Spec: D1 table, promptGuidance wording (spec D3 :202-213), D2 server rules and
  copy, edit-form controls, record rows, `$1,200 / month` in row and chip, API
  types (per PR24), create form unchanged, seed (per PR25) - all built by S1 as
  the coverage table says; provenance clear deferred to S3 per PR2.
