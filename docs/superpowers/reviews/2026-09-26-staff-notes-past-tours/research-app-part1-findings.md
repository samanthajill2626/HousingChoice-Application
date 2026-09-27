# Research findings - app side of Part 1 (staff notes) + invariant sweep

Date: 2026-09-26
Branch: `feat/staff-notes-past-tours` (tree identical to main @0dafe3c1 at read time)
Scope: plan Task 1 drift check against the live tree, the `staff_notes` /
`staff_notes_updated_at` writer and reader sweep, and the in-memory fake's
fidelity to the real contacts repo.
Method: read-only (Read/Grep/Glob). Byte-exact quotations backing every citation
are in the gitignored run-state file
`.superpowers/sdd/research-app-part1-reference.md`.

Verdict: NO BLOCKING and NO SHOULD-FIX findings. Every plan Task 1 anchor
matches the tree (one comment-range drift that no edit depends on), the planned
test code is consistent with the harness, the repo types and the lint preset,
and no writer or non-staff reader can touch either key. The items below are
NOTE-level corrections to spec prose, one plan explanation, and edge cases the
handback or a later task should know about.

## Findings

### N1 - NOTE - spec 2.1 says `notes` is a provenance field; it is not

- Where: spec section 2.1, the PATCH bullet ("`notes` is one of them via
  `PROVENANCE_FIELDS`, line 102").
- Tree: `app/src/services/extraction/schema.ts:24-40` defines
  `PROVENANCE_FIELDS` as the eight `EXTRACTABLE_FIELDS` plus `address`;
  `notes` is not among them. `app/src/routes/contacts.ts:102` is only the
  import, and the loop at `contacts.ts:1520-1524` therefore never clears any
  `notes_source` (none exists; the notes append at
  `app/src/services/extraction/apply.ts:704` writes no provenance).
- Impact: none on this feature. The conclusion the spec draws for
  `staff_notes` (not a provenance field, no `staff_notes_source`) holds.
- Correction: strike "`notes` is one of them" from spec 2.1 if the spec is
  revised; no code or plan change.

### N2 - NOTE - spec 2.1 says the seeds write contact `notes`; they write `preferences_notes`

- Where: spec section 2.1 ("the seeds (`app/src/lib/seed/*.ts`) write `notes`").
- Tree: the seeds never write contact `notes`. They write `preferences_notes`
  (`app/src/lib/seed/lean.ts:121`, `app/src/lib/seed/cast.ts:456`,
  `app/src/lib/seed/cast.ts:731`, `app/src/lib/seed/matrix.ts:819`), a key
  with no reader anywhere in `app/` or `dashboard/`.
- Impact: the seeded e2e tenant `contact-tenant-0001` has NO `notes`, so its
  "Preferences & notes" card renders the PendingPanel copy in the lean world.
  The planned e2e comparison (card innerText identical before and after) and the
  Task 4 unit test (which asserts the "No preferences yet" copy on a contact
  without notes) are unaffected. The invariant is unaffected (seeds are literal
  fixtures and cannot carry `staff_notes`).
- Correction: spec wording only. Anyone writing the e2e should not expect
  seeded notes text on that card. (A dead seed key is pre-existing debt, out of
  scope here.)

### N3 - NOTE - plan Task 1 misdescribes what demotes the `pets` write

- Where: plan Task 1, the paragraph after the test file ("demoted to a
  suggestion by the inferred-role rule ... only with a `roles` map").
- Tree: the demotion is gated by the ctx flag `hasInferredRoleContent === true`
  (`apply.ts:258`, `apply.ts:286`; the existing test sets it at
  `app/test/extractionApply.test.ts:746`). `result.speakerRoles` is audit
  metadata only (`apply.ts:480-486`). The contact has no roles concept here.
- Impact: none. The planned test passes neither the flag nor roles, the contact
  is `type: 'tenant'` (so `fieldApplies` admits `pets`, `apply.ts:146-151`),
  and the write lands directly - the same shape the existing test pins at
  `app/test/extractionApply.test.ts:720-728`. `outcome.wrote` will be
  `['pets']`, `notedLines` 1, exactly two `update` calls, and the notes patch
  will be `existing` + newline + `[Auto - Sep 26] stairs are a problem`
  (`autoPrefix`, `apply.ts:153-158`, UTC).
- Correction: the fallback advice is moot; optionally reword to "only when
  `hasInferredRoleContent: true` is passed".

### N4 - NOTE - the JSON body is deep-trimmed before the parser sees `staff_notes`

- Where: `app/src/app.ts:142` mounts `trimJsonBody()`
  (`app/src/middleware/trimStrings.ts:22-23`, `43-47`), which trims every
  string VALUE in a JSON body at both ends, before `parseTriageBody`. The
  harness uses the real `buildApp`, so the unit tests see the same behavior.
- Effect on the stored value: `staff_notes` is stored trimmed at both ends
  (interior whitespace and newlines kept), exactly like `notes`. A
  whitespace-only save stores `''`, which the card already renders as empty.
- Effect on Task 3 (dashboard card): its no-op check compares the UNTRIMMED
  draft to the stored value. A draft that differs from the stored text only by
  leading or trailing whitespace (e.g. a trailing Enter) sends a PATCH that
  changes no text but re-stamps `staff_notes_updated_at`, so "Last edited"
  moves to today. Harmless; the spec's rule ("Save with the draft equal to the
  stored value ... no request") is followed as written.
- Correction (optional, Task 3): compare the trimmed draft to the stored value
  in `save()` (the stored value is always server-trimmed). Otherwise record it
  in the handback as known behavior.

### N5 - NOTE - the PATCH is not type-gated, so a retyped tenant's staff notes go invisible

- Where: `parseTriageBody` (`contacts.ts:502-717`) is not type-aware for plain
  fields, so `staff_notes` is accepted for any contact type (same convention as
  every other plain field). The card is rendered only for
  `contact.type === 'tenant'` (spec 3.6).
- Edge: a tenant with staff notes later retyped to landlord, partner,
  team_member or unknown keeps `staff_notes` stored, but no file renders it
  (TenantFile gates to tenants; LandlordFile, PartnerFile and UnknownFile get
  no card). Nothing is lost; retyping back restores the card.
- Correction: none required for this build. Suggest adding one sentence to
  `docs/issues/staff-notes-on-landlord-partner-files.md` (which does not
  mention retyping today) when that issue is next touched.

### N6 - NOTE - the writer inventory is wider than the spec lists; every extra writer is fixed-key

- Spec 2.1 / 3.1 name PATCH, POST, the import, the seeds, the public sign-up,
  the transition service and extraction. The tree has more contact writers,
  all verified unable to name `staff_notes` or `staff_notes_updated_at`
  (explicit field lists or fixed keys):
  auto-capture stubs `app/src/services/contactCapture.ts:111`; group
  detection/conversion stubs and stamps `app/src/services/groupMembers.ts:155`,
  `:165`, `app/src/services/groupConvert.ts:319`, `:337-347`, `:351`, `:471`;
  unmatched-email create and addEmail `app/src/routes/unmatchedEmail.ts:323`,
  `:462-468`; consent stamps `app/src/routes/webhooks/twilio.ts:1164`,
  `:1205`, `app/src/routes/webhooks/voice.ts:626`; flag writers
  `twilio.ts:3737`, `:3796`, `app/src/jobs/broadcastFanOut.ts:595`,
  `app/src/services/emailEvents.ts:161`,
  `app/src/services/numberSuppression.ts:161-162`, `contacts.ts:1961-2010`;
  soft-delete/restore and phone/email curation `contacts.ts:2085-2684`;
  `housing_fair_welcomed` `app/src/routes/public.ts:306`; the suggestion
  accept transaction, which writes the contacts table directly
  (`app/src/repos/suggestionResolutionRepo.ts:754-784`, `:841-979`) with a
  patch built only for `status`, `phone`, `address` and the eight extractable
  targets, anything else refused `unknown_target`
  (`app/src/services/suggestionResolution.ts:185-286`); the performance seed
  (`app/src/lib/performanceSeed.ts`, dev-only BatchWrite of generated
  fixtures). Merge/dedupe: no such feature exists.
- Destructive writers worth one line in the handback: seeds and the dev
  reseed replace items whole after a table clear
  (`app/src/lib/seed/index.ts:153`, `app/src/lib/seed/live.ts:463`,
  `app/src/lib/devReset.ts:49-58`), so a reseed wipes staff notes (desired for
  the byte-stable lean world). The import retract hard-deletes an
  import-created contact on a workbook `drop` (`app/src/lib/import/apply.ts:599`,
  `:740-746`), which would take any staff notes typed on it - operator-run,
  import-created contacts only, pre-existing for every field.
- Correction: none. The planned `ContactItem` comment's "not the import, not
  the seeds, ..." list is illustrative, not exhaustive; it remains true.

### N7 - NOTE - staff-only readers return the whole item; no non-staff reader exists

- GET detail (`contacts.ts:1099-1118`) and LIST (`contacts.ts:1008-1013`,
  and the `?phone=` lookup at `contacts.ts:958`) return the WHOLE stored item:
  `getById` is an unprojected GetItem, `listByType` is a `byTypeStatus` Query
  with no ProjectionExpression (`app/src/repos/contactsRepo.ts:1119-1135`) on a
  GSI that projects ALL (`app/src/lib/tables.ts:60`). So `staff_notes` and its
  stamp round-trip on reload as the spec assumes.
- Other whole-item responses, all staff-only under the `/api` auth gate:
  `contacts.ts:1033`, `:1043`, `:1849`, `:1982`, `:2028`, `:2196`, `:2223`,
  `:2395`, `:2437`, `:2497`, `:2531`, `:2585`, `:2608`, `:2668`, `:2702`;
  `app/src/routes/statusTransition.ts:288`;
  `app/src/routes/suggestions.ts:44-45`, `:172`;
  `app/src/routes/unmatchedEmail.ts:415`, `:451`. The staff contact LIST
  therefore carries `staff_notes` on the wire even though no list view renders
  it (same as `notes` today).
- Allowlists that drop it: the display projection
  (`contactsRepo.ts:866-868`, used for inbox, broadcast, AI-run and unit labels),
  InboxRow (`app/src/routes/inbox.ts:112-144`), Today items
  (`app/src/routes/today.ts:933-941`), broadcast recipients and seed resolution
  (`app/src/routes/broadcasts.ts:223-258`, `:334-363`), unit roster enrichment
  (`app/src/routes/units.ts:348-375`), `toProfile`
  (`app/src/jobs/extraction.ts:131-159`; the model sees only that object,
  `app/src/services/extraction/prompt.ts:171`), and the missed-call intake gate
  (`app/src/jobs/missedCallAutoText.ts:80`).
- Non-staff surfaces: the public router answers `{ ok: true }` or a unit flyer
  projection (`app/src/routes/public.ts:336`, `:356`); SSE events carry no
  contact record (`app/src/lib/events.ts:295-301`, `:255-257`); the
  `contact_updated` audit carries field NAMES only (`contacts.ts:1800-1804`) and
  no app route renders a `contacts#` audit row; no template receives a spread
  contact; no CSV/export route exists; no log line logs a whole contact.
- Correction: none.

### N8 - NOTE - line drift in spec 2.1 citations (no plan edit depends on them)

- Provenance loop: cited 1518-1522, actual `contacts.ts:1520-1524` (comment
  1516-1519). This is also the task brief's anchor; the plan's edits do not
  touch it.
- Pre-read: cited 1419, actual `contacts.ts:1422`. Update call: cited 1554,
  actual `contacts.ts:1556` (1554 is the `let`). `parseCreateBody`: cited
  741-830, the function runs `contacts.ts:741-916`.
- Notes append section: cited `apply.ts:670-707`, actual `apply.ts:672-710`
  (the `update` call at 704 is exact); race comment cited 686-690, actual
  `apply.ts:685-688`.
- Correction: none needed for the build; fix if the spec is revised.

### N9 - NOTE - ASCII check on the two touched app files must use the added-lines form

- `app/src/routes/contacts.ts` and `app/src/repos/contactsRepo.ts` already
  carry non-ASCII (e.g. em dashes on line 1 of each, arrows and an ellipsis at
  `contacts.ts:4-8`). The plan's whole-file `tr` check would report non-zero on
  both; its shell notes list other example files but not these two.
- Correction: when checking Task 1's files, use the plan's added-lines form
  (`git diff -- FILE` piped to the added-lines filter). Task 1 itself has no
  ASCII step, so this only matters if the builder applies the global rule.

## Checked and found correct (no finding)

- Every Task 1 code anchor: `park_reason` at `contactsRepo.ts:134`; the
  `notes` block at `contacts.ts:568-573` (new block goes before 574); header
  line `contacts.ts:7`; consent stamp `contacts.ts:1500-1506`; the no-field
  error `contacts.ts:714`; the audit append `contacts.ts:1800-1804` with
  entityKey `contacts#<id>` and `fields`; the response `contacts.ts:1849`.
- Harness: `ORIGIN_SECRET`, `createFakeWorld`, `makeWebhookHarness`
  (`twilioWebhookHarness.ts:202`, `:414`, `:4275`), return shape includes
  `app` and `world` (`:4266-4273`, `:4518`); `TEST_SESSION_COOKIE`
  (`authSession.ts:112`); `createLogCapture().stream` (`logCapture.ts:6-39`);
  `createLogger({ destination, level })` (`logger.ts:16-20`, `:178`).
- Fake `contacts.update` mirrors the real repo for this feature
  (`twilioWebhookHarness.ts:2050-2077` vs `contactsRepo.ts:1262-1341`):
  SET-merge, `''` accepted on non-key attributes, `null` removes, nothing
  stripped, whole item returned. The fake returns the live stored object where
  the real returns a fresh ALL_NEW copy; the new tests do not depend on that.
- `ApplyDeps` shape and the four extraction stub names (`apply.ts:34-44`);
  `applyExtraction` context (`apply.ts:160-174`); outcome `wrote` and
  `notedLines` (`apply.ts:46-57`, `:717`); `ExtractionResult.fields` and
  `noteLines` (`app/src/adapters/extraction.ts:56-60`, `:79-94`).
- POST `/api/contacts` answers 201 `{ contact }` (`contacts.ts:1084`);
  `(555) 010-7000` normalizes to `+15550107000`
  (`app/test/contactsCrud.test.ts:88-95`); the create allowlist ignores
  unknown keys (`contacts.ts:741-916`).
- The ISO regex matches `toISOString` output. Test files are typechecked under
  `strict` and `noUncheckedIndexedAccess` (`app/tsconfig.test.json:14`,
  `tsconfig.base.json:3`, `:12`); the planned test code type-checks against
  those types by inspection, and `request.Test`, `as never` and non-null
  assertions have precedent and are not flagged by the lint preset
  (`eslint.config.mjs:15-16`).
- Red/green counts: four of the five PATCH tests fail before the change (three
  on the 400 status, the non-string test on its message); the notes-only
  PATCH, POST and both AI tests pass as regression pins; 8 pass after.
  A single-file run needs no Docker (`app/vitest.config.ts:121-129`).
- The real `getSuggestion` is an unvalidated GetItem
  (`app/src/repos/extractionRepo.ts:699-708`), so the per-field best-effort
  read returns nothing for `staff_notes` and logs no WARN.
