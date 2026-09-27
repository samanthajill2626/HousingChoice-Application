# Drift worklist - feat/staff-notes-past-tours (merged from four research readers)

Date: 2026-09-27
Author: the build orchestrator (Fable 5.1), resumed after the first orchestrator died
on a planner API limit at 03:36Z with three of four research files landed.
Inputs (all in this directory): `research-app-part1-findings.md` (N1-N9),
`research-dashboard-part1-findings.md` (R-1..R-4, cited below as D1-R*),
`research-dashboard-part2-findings.md` (R-1..R-8, cited as D2-R*),
`research-e2e-findings.md` (E-1..E-8 plus its sibling adjudications).
Byte-exact quotations backing every citation live in the four
`.superpowers/sdd/research-*-reference.md` files (ignored run state).

Verdict across all four: the plan's code and anchors hold against the live tree
(identical to main @0dafe3c1). ONE blocking item outside the plan's file list
(D2-R1, gate 2 collision), five SHOULD-FIX items, the rest NOTEs. Every item below
carries the orchestrator's disposition: ADOPT (the named slice does it), MINE (the
orchestrator does it), RECORD (handback only, no change). Decisions taken alone
under the overnight rule are numbered OD-n and repeated in the handback.

## Slice map (strictly serial, one tree one writer)

| slice | plan task | files |
|---|---|---|
| S1 | Task 1 | app/src/repos/contactsRepo.ts (type), app/src/routes/contacts.ts, app/test/contactStaffNotes.test.ts (new) |
| S2 | Tasks 2-4 | dashboard/src/api/types.ts (additive), StaffNotesCard.tsx/.module.css/.test.tsx (new), TenantFile.tsx (+ new test), ContactDetail.tsx (one prop) |
| S3 | Task 5 | e2e/tests/dashboard-next/contact-detail.spec.ts (two locators), tenant-staff-notes.spec.ts (new) |
| S4 | Task 6 | dashboard/src/routes/tours/useTours.ts (+ test) |
| S5 | Task 7 + D2-R1 | ToursPage.tsx/.module.css/.test.tsx, dashboard/src/App.tsx, e2e/performance/routes.test.ts (one exclusion) |
| S6 | Task 8 | dashboard/src/routes/tours/TourDetail.tsx (+ test) |
| S7 | Task 9 | e2e/tests/dashboard-next/tours-past.spec.ts (new) |
| S8 | Task 10 | ONE main sync, five gates, records, handback (orchestrator) |

## S1 - app (plan Task 1)

- ADOPT N9: ASCII check on `app/src/routes/contacts.ts` and
  `app/src/repos/contactsRepo.ts` uses the ADDED-LINES form (both files already
  carry non-ASCII on line 1): `git diff -- FILE | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c`.
- RECORD N1: spec 2.1's "`notes` is one of them via PROVENANCE_FIELDS" is wrong
  (`app/src/services/extraction/schema.ts:24-40` lists the eight extractable fields
  plus `address`); the conclusion for `staff_notes` (no provenance) still holds.
- RECORD N2: the seeds write `preferences_notes`, never contact `notes`
  (`app/src/lib/seed/lean.ts:121`); the seeded tenant's "Preferences & notes" card
  renders the PendingPanel copy - the e2e innerText comparison is stable.
- RECORD N3: the `pets` write in the planned extraction test lands directly
  (demotion needs `hasInferredRoleContent: true`, `apply.ts:258,286`); the plan's
  fallback advice is moot.
- RECORD N4: `trimJsonBody()` (`app/src/app.ts:142`) trims every string value before
  `parseTriageBody`, so `staff_notes` is stored trimmed at both ends. See S2 OD-2.
- RECORD N5: the PATCH is not type-gated; a tenant retyped to another kind keeps
  `staff_notes` stored but no file renders it (nothing lost). MINE: one sentence
  appended to `docs/issues/staff-notes-on-landlord-partner-files.md` at S8.
- RECORD N6/N7: writer and reader inventories are wider than the spec lists; every
  extra writer is fixed-key (cannot name `staff_notes`); reseed and the import
  retract hard-delete whole items (pre-existing for every field); staff-only readers
  return the whole item (the field rides the contact LIST on the wire, unrendered);
  no non-staff surface can carry it.
- Anchors verified: `park_reason` at `contactsRepo.ts:134`; the `notes` block at
  `contacts.ts:568-573`; header comment `contacts.ts:7`; consent stamp
  `contacts.ts:1500-1506`; no-field error `contacts.ts:714`; audit append
  `contacts.ts:1800-1804`; response `contacts.ts:1849`; harness exports
  (`twilioWebhookHarness.ts:202,414,4275`), `TEST_SESSION_COOKIE`
  (`authSession.ts:112`), `createLogCapture` (`logCapture.ts:6-39`),
  `ApplyDeps` (`apply.ts:34-44`). Red/green: 4 of 5 PATCH tests red before, 8 green after.

## S2 - dashboard Part 1 (plan Tasks 2-4)

- ADOPT OD-2 (from N4): in `StaffNotesCard.save()`, the no-op check compares the
  TRIMMED draft to the stored value (`draft.trim() === stored.trim()`), because the
  server stores the value trimmed; a draft that differs only by leading/trailing
  whitespace would otherwise re-stamp "Last edited" for no text change. The request
  still sends the raw draft (`{ staff_notes: draft }`), exactly as the unit test
  asserts. Decision taken alone; both readings honor spec 3.6.
- ADOPT D1-R3: Task 4 Step 4's neighbor run adds
  `src/routes/contact/files.test.tsx` (TenantFile's other render site; it renders
  the new card read-only with a plain "+ Add" aside; no query there collides).
- RECORD D1-R2: `ApiError` is at `dashboard/src/api/client.ts:13`, constructor
  `:22`, signature `(status, code, message, body?)` - the plan's `new ApiError(500, 'boom', 'boom')` is valid.
- RECORD D1-R4: a custom kind layered on the tenant base (`type === 'tenant'`, e.g.
  a "Case worker") gets the card under the literal spec gate. Planner-alone reading;
  handback names it.
- Anchors verified: `types.ts:2005` / `:2098` are the `notes?: string;` lines;
  `Card`/`CardAction`/`EmptyRow`/`NotesText`/`responseClass.muted` exports
  (`Card.tsx:11-52,86,262,300-308`); Button props (`Button.tsx:9-32,67-73`); all
  ten CSS tokens exist (`dashboard/src/ui/tokens.css:9-77`); the focus effect trips
  no rule of the `recommended-latest` preset; TenantFile's 13 required props;
  MemoryRouter alone suffices for the TenantFile test; "Add a note" / "No
  preferences yet" at `TenantFile.tsx:251,262`; the ContactDetail call site
  `:1058` with `onEdit` at `:1079`; `setContact` is `(contact: Contact) => void`
  (`useContact.ts:13`); team_member routes to TenantFile (`ContactDetail.tsx:551-558`).

## S3 - e2e Part 1 (plan Task 5)

- ADOPT D1-R1 (CONFIRMED by the e2e reader's layout probe: a 500px editor overflows
  the card by 208px while `<main>` reads 0): in the 360px step, after the textarea
  is visible and before Cancel, ALSO call
  `expectNoHorizontalOverflowIn(staffCard, 'Staff notes card in edit mode at 360px')`
  (import it from `../../support/viewport.js` beside the existing names). Keep the
  page-level call. `staffCard` (the Card root `<section>`, overflow-visible per
  `Card.module.css:4-9`) is the right locator; `.right` has no accessible handle.
- ADOPT E-2: if a hermetic session predates the slice's commits, do NOT
  `e2e:restart` (the commit stamps are fixed at launch and the preflight throws on
  a mismatch, `e2e/support/preflight.ts:96-129`): `npm run e2e:stop`, then a fresh
  `npm run e2e:session`. Uncommitted edits keep the stamps valid; a commit
  invalidates them.
- ADOPT E-7: the grep form that reaches Playwright from the worktree root is
  `npm run e2e -w @housingchoice/e2e -- --grep "<regex>"` (the plan's form); root
  `npm run e2e -- --grep` is eaten by the inner npm hop.
- RECORD E-8 / OD-5: both new specs keep the house-style
  `process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174'` line (57 existing
  spec files); unreachable under `npm run e2e`. Not changed.
- Collision sweep (e2e findings): the ONLY existing locators the new DOM breaks are
  `contact-detail.spec.ts:59` and `:73`, which Task 5 scopes; every other
  `getByLabel('Notes')` is dialog-scoped or on a property/landlord page.
- Run order: tenant-staff-notes runs 55th; nothing after it reads the tenant file
  with a notes-sensitive locator; it leaves Tasha with `staff_notes: ''` (hidden).

## S4 - dashboard Part 2 data (plan Task 6)

- RECORD D2-R8: the plan says 15 new tests; the block defines 16. ASCII: use the
  added-lines check on `useTours.ts` and `useTours.test.ts` (both already carry
  non-ASCII).
- Anchors verified: `getTours(params, signal?)` accepts `{ from, to }`
  (`endpoints.ts:2595-2617`); the test file's bare mock must become the
  spread-`importActual` form (the hook now value-imports `TOUR_STATUS_LABELS`);
  `TOUR_STATUS_LABELS.canceled` is "Canceled" (`types.ts:873`); the async IIFE
  pattern is clean under `set-state-in-effect`; the pre-existing
  `useTours.ts:116` lint error is baseline.

## S5 - dashboard Part 2 page (plan Task 7) + the gate-2 collision

- ADOPT D2-R1 [BLOCKING], OD-1: `e2e/performance/routes.test.ts:347-388` reads
  `dashboard/src/App.tsx` and requires the route set minus its local `excluded` set
  (`:375-382`) to equal `EXPECTED_KEYS` (`:29-38`, no `/tours/past`); it runs under
  root `npm test` (gate 2). Option (a): add `'/tours/past'` to `excluded` with a
  comment naming the reason (a new list view not yet a profiler surface; issue
  `perf-pages-tours-past-surface`), and run
  `cd W:\tmp\staff-notes-past-tours\e2e && npx vitest run performance/routes.test.ts`
  in the slice. Option (b) (registering a 32nd profiler surface) changes Cameron's
  `perf:pages` contract ("exactly 31 registered surfaces", e2e/README.md) and is
  NOT taken overnight. The e2e reader confirmed (a) is complete: `routes.test.ts`
  is the only reader of App.tsx; `mutationCatalog.test.ts` scans only non-test
  files under `dashboard/src` and the branch adds no raw transport call; the
  viewport guard is not tripped. MINE: file `docs/issues/perf-pages-tours-past-surface.md`.
- ADOPT D2-R2 [SHOULD-FIX]: the held-promise variable in the bulk test is declared
  WITHOUT an initializer and with `undefined` in its type
  (`let release: (() => void) | undefined;`) - the repo idiom
  (`useMarkThreadRead.test.tsx:61`); an initializer of `null` narrows the type to
  `null` and the later call is TS2349 under `npm run typecheck`.
- ADOPT D2-R3: type the ref prop `React.RefObject<boolean>` (`MutableRefObject` is
  deprecated in @types/react 19.2.17; `useRef(false)` returns `RefObject<boolean>`).
- ADOPT D2-R5, OD-3: close the mid-batch tab round trip gap. The plan's render-time
  `bulkBusy` is CHILD state, so Past -> Active -> Past while a batch runs remounts
  a view whose controls are enabled but inert (the page-owned ref drops the
  click), and the old batch's `reloadPast()` lands on the unmounted hook so the new
  view keeps a list fetched mid-batch. Two page-owned additions, both written only
  inside event handlers or effects (no setState in an effect body):
  (1) `bulkBusy` moves to the PAGE (`const [bulkBusy, setBulkBusy] = useState(false)`
  in `ToursPage`), passed to the child beside the ref, set only inside `markToured`;
  (2) a page-owned `pastReloadRef = useRef<(() => void) | null>(null)`; the child
  registers its hook's `reload` in an effect (`pastReloadRef.current = reloadPast;
  return () => { pastReloadRef.current = null; }`) and the runner ends with
  `pastReloadRef.current?.()` instead of a direct `reloadPast()` - so the CURRENT
  Past child (the remounted one, if any) is the one refreshed. The unit tests'
  `reloadPast` call counts are unchanged (the ref holds that same function).
  Decision taken alone; spec 4.5 says EVERY mark control is disabled while a batch
  runs, and the plan's shape left one path where they were not.
- ADOPT D2-R6: `whenLabel` (page AND test helper) maps U+202F / U+00A0 to a plain
  space after `toLocaleTimeString`, following `dashboard/src/routes/inbox/inboxTime.ts:7-13`,
  so exact time-string assertions hold on an ICU 72+ host. Decision OD-6 (portability only).
- ADOPT D2-R7: `beforeEach` resets `reloadPast` with `mockReset()` (not `mockClear`) so
  the "dropped rows" test's installed implementation cannot leak under a future Vitest.
- ADOPT D2-R8: refresh the stale comments the plan leaves behind -
  `ToursPage.tsx:1-2` ("two URL-backed VIEWS ... Active | Closed tabs"),
  `ToursPage.module.css:1` ("two-section layout") and `:35-36` ("Active / Closed
  view tabs") - to name three views. Added lines ASCII-only (all four Part-2 files
  already carry non-ASCII: use the added-lines check on every one).
- RECORD D2-R4: the slice report must NOT repeat the plan's "same ordering the
  Closed tab has today": the Past fetch lives in a child that mounts after the
  four list lookups land, so Past adds one request round trip after them (Closed's
  fetch runs at page level, in parallel).
- Importer checklist (verified): `ToursPage` is imported only by `App.tsx:47`
  (routes `:239-240`) and `ToursPage.test.tsx:65` (routes `:208-209`); the `closed`
  prop is used only at `App.tsx:240` and `ToursPage.test.tsx:209` - both rewritten.
  `useTours.js` exports are imported by `ToursPage.tsx:40`, `useTours.test.ts:13,24`
  and `ToursPage.test.tsx:17,37`. The one unlisted consumer is `routes.test.ts` (above).
- Invariant sweep (tour status writers): every dashboard status PATCH is in
  `TourDetail.tsx` (`:319` Mark toured, `:325` Mark no-show, `:465/:468` Book /
  Reschedule, `:482-487` Mark already toured, `:496-500` exit gate, `:522` Cancel);
  the Past runner sends the same body as `:319` plus a re-read guard none of them
  have, and opens no dialog (spec 4.4). `location.state` has one other reader,
  `ImageViewerProvider` (`imageViewer/ImageViewerProvider.tsx:79,115,163`), whose
  helpers spread every other key through, so `state.back` survives an image open.
  Every other detail page hard-codes its back link (no competing convention).
- Anchors verified: every class the plan references exists in `ToursPage.module.css`;
  the only container is `.page` (`:4-11`); all fifteen tokens exist; fixtures give
  "Alice Smith", "Bob Jones", `123 Peachtree St, Atlanta, GA, 30303`,
  `456 Oak Ave, Decatur, GA, 30030` (`ToursPage.test.tsx:94-132`); `Button` passes
  `aria-label` through; the callback ref with a block body trips no rule;
  `usePastTours` is never called on Active or Closed, so the profiler's `/tours` and
  `/tours/closed` GET contracts are unchanged.

## S6 - TourDetail (plan Task 8)

- Anchors verified: router import at line 26; the `modal` union `:237-239`; the
  keyed mount of `TourDetailLoaded` `:129-139`; the back link `:595-597`
  ("Back to tours"); CTAs `:547-558`; the test file's router mock re-exports
  `actual` and stubs only `useNavigate`, and react-router 7.18.0's
  `useSearchParams` calls its own `useNavigate`, so the strip navigates for real in
  tests; `NavigateOptions.state` and `LinkProps.state` exist;
  `createLocation(..., state = null)` confirms the state must be carried; the dialog
  is named "Record outcome" (`TourModals.tsx:311`) and renders inline with no
  `inert` on siblings; its "Cancel" is the only one on the page; the state
  initializer is pure and the strip effect is clean (`setSearchParams` is not a
  `useState` setter; the four deps are complete). Pre-existing `react-hooks/purity`
  error at `TourDetail.tsx:269` (base) is baseline and shifts down.
- ASCII: added-lines check on both files.

## S7 - e2e Part 2 (plan Task 9)

- ADOPT E-3 [SHOULD-FIX]: `test.slow();` is the first line of the Past-tab test body
  (repo idiom, `deleted-contact-resurfacing.spec.ts:71`): it is a ten-stage flow on a
  60s cap on a night with another mission's e2e on the box.
- ADOPT E-2: after any COMMIT since the session launched, `e2e:stop` then a fresh
  `e2e:session` (never `e2e:restart`).
- ADOPT E-4, OD-4: keep the global thread-store outbound delta (spec 4.7 wording)
  AND add the suite's per-party idiom: capture `const since = new Date().toISOString();`
  right before the bulk click and, after the 2s settle, assert
  `getOutboundTo(page.request, { to: '+15550100001', since })` (Tasha) and
  `{ to: '+15550100002', since }` (Marcus Bell, landlord of both units) are both
  empty. `getOutboundTo` is exported from `e2e/fixtures/fakeTwilio.ts:201-211`.
- ADOPT E-5: also call `expectNoHorizontalOverflowIn(region, 'Past tours region at 360px')`
  (the `<section aria-label="Past tours">`, which holds toolbar and list) beside the
  page-level check, which the probe shows is real on the Tours page.
- RECORD E-8: `fakeTwilio.ts` types at `:167-188`, `getOutboundTo` at `:201-211`,
  `listThreads` at `:375-379`; field names match the plan's `outboundCount`.
- Run order: tours-past runs 59th, right before unknown-caller-triage, which reseeds
  in `beforeEach` - the three past-dated tours, their milestones and the arm's
  skipped `booked_too_late` rows leak to no later spec. Nothing sends (POST awaits
  the arm inline, `tours.ts:346-351`; toured / no_show are ladder-terminal, `:1354-1357`).

## S8 / orchestrator-owned (plan Task 10 + gates)

- MINE E-1 [SHOULD-FIX]: if `timeout 2700` fires (exit 124), the Playwright RUNNER
  survives (Git Bash npm shim does not exec; GNU timeout signals only its MSYS
  child). Recipe order becomes: (1) read `e2e/.artifacts/lane.json`; (2) list this
  worktree's processes (`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*staff-notes-past-tours*' }`),
  `taskkill /PID <pid> /T /F` from the TOP of each surviving tree (the runner
  `...\@playwright\test\cli.js test` and, if separate, the `scripts/e2e-session.mjs`
  launcher), re-list until empty; (3) `npm run e2e:stop`; (4) prove the four lane
  ports free. The app, worker and fake are spawned with RELATIVE paths and are
  indistinguishable from voicemail-greeting's - never hand-kill one; only Vite
  (absolute path) and the runner are attributable.
- MINE E-6: preferred lanes are 13 (this worktree: 10301/10311/10321/10331) and 15
  (voicemail-greeting); never set `E2E_LANE` or run `lane.mjs` by hand; never stop
  the shared containers; run gate 4 from the Bash tool (GNU `timeout`; the
  PowerShell `timeout` is a pause command). Gate 2 beside another e2e is the
  environmental contention case: re-run-and-compare by FILE; any `[dynamoAdmin]`
  line is a real sighting.
- MINE E-7: to isolate one spec file:
  `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<file>.spec.ts`.
- MINE: file `docs/issues/perf-pages-tours-past-surface.md` (OD-1) and append the
  retype sentence to `docs/issues/staff-notes-on-landlord-partner-files.md` (N5).
- Gate 5 baseline (plan Task 10): pre-existing errors in touched files at main
  @0dafe3c1 - `useTours.ts` `react-hooks/set-state-in-effect` (`useClosedTours`,
  line 116 at base); `TourDetail.tsx` `react-hooks/purity` (line 269 at base);
  `TenantFile.tsx` unused `FieldSource` import (line 14). Attribute by rule and
  context at the merge base, not by line number.

## Decisions taken alone (overnight rule) - repeated in the handback

- OD-1 gate-2 collision: exclude `/tours/past` from the profiler route-registry test
  and file an issue, rather than register a 32nd profiler surface tonight.
- OD-2 StaffNotesCard no-op save compares the trimmed draft (server trims).
- OD-3 bulk busy flag and the reload function become page-owned (ref-registered) so
  a mid-batch tab round trip cannot show enabled-but-inert controls or a stale list.
- OD-4 the no-send e2e proof keeps the global delta and adds per-party since-scoped
  checks for the tenant and the landlord.
- OD-5 the new specs keep the house-style `:5174` env fallback.
- OD-6 `whenLabel` normalizes U+202F / U+00A0 to a plain space (ICU portability).
