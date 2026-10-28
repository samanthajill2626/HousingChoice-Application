# E1-writers - build research findings (WP1 B1 Ranking inputs)

Reader E1-writers checked the spec (rev 10) in full and plan sections 0-4
(plan lines 1-515), grepping the rest of the plan by name for task
coverage, against the worktree at ede08552 (source = main @d0e2c2d8). The
question: every MUTATION SURFACE of the six states B1 protects or changes
(the four tenant fields and their `<key>_source` keys; the tenant `notes`
box; unit `priority`; target-keyed extraction state - suggestions, journals,
dismissal tombstones, run decisions; the AI run record's new counts; and
listing_sends staying read-only from the extraction path), across app/,
dashboard/, e2e/, app/scripts/, repo-root scripts/ and the seeds. Every
writer found is either covered by a plan task or unaffected; no writer is
missing from the plan. Three NOTEs record residual risks and one cheap
tightening. The full writer enumeration is under "Verified with no
finding".

## E1-1 - NOTE - The `text_field_filled` drop reads the run's contact snapshot; a staff fill landing during the model call is overwritten

- Plan location: Task S3.4 Step 3 (plan 4952-4998; the condition at plan
  4974).
- What the plan says: drop a model `write` on a text field when
  `isFilledText(contact[field])`, where `contact` is `ctx.contact`.
- What the tree holds: `ctx.contact` is the job's eventually consistent
  `contacts.getById` at app/src/jobs/extraction.ts:438, taken before the
  message read, the org-list read (:565), B1's two new reads (S5.6) and the
  model call (:586). apply then commits every field write in ONE
  unconditional `deps.contacts.update(contactId, writePatch)`
  (app/src/services/extraction/apply.ts:498-500). A staff PATCH that fills
  the same field between :438 and :500 is overwritten by the model's value
  and re-stamped `<key>_source` (an Auto badge on text staff did not type).
  Spec D3 (spec 177-178) says the model "never rewrites staff text live".
  The same snapshot race exists today for pets / evictions / tenure, the
  notes read-modify-write accepts it (apply.ts:726-729), and the staff-notes
  spec accepted last-write-wins parity for contact fields
  (docs/issues/staff-notes-stale-page-overwrite.md); so this is a residual
  of an accepted class, not a regression.
- Correction: default - none in code; the S3 report (S3.9) records it as an
  accepted residual with these cites. Only if the planner wants D3's
  sentence to hold under concurrency: in S3.4, for each TEXT key the loop
  writes, pass an as-read guard on the batched write,
  `deps.contacts.update(contactId, writePatch, { expect: textKeys.map((key) => ({ attr: key, value: typeof contact[key] === 'string' ? contact[key] : null })) })`
  (`ApplyDeps.contacts` already exposes `update`'s optional `opts`,
  app/src/repos/contactsRepo.ts:869, :743-753; the value-as-read form keeps
  the whitespace-only PIN true), and on `ConditionalCheckFailedException`
  retry the update once WITHOUT those keys and their `_source` keys,
  recording each as `dropped` / `text_field_filled`; plus one
  extractionApply case whose `updateImpl` throws that exception on the
  first call.

## E1-2 - NOTE - The staff edit form replaces the whole Notes box from the copy it opened with: a second wholesale replace beside the filed importer one

- Plan location: section 3 WI14 (plan 177-179); spec 4 "Tenant `notes`"
  writers (spec 607-613). No task.
- What the plan says: the importer's replace on re-import is the one filed
  watch item (docs/issues/import-overwrites-notes-box.md).
- What the tree holds: ContactEditForm keeps the contact AS OPENED
  (`const [base] = useState(contact)`,
  dashboard/src/routes/contact/ContactEditForm.tsx:183), seeds the Notes
  textarea from the opened contact (:228) and, when the text differs from
  `base.notes`, sends the WHOLE box (:379); the PATCH stores it verbatim
  (app/src/routes/contacts.ts:642-646, SET through contactsRepo.update).
  Every `[Auto - ...]` line extraction appended while the form was open -
  from B1 the matching facts and the feedback lines B2 attaches to
  properties - is erased by a save that touched the notes. Pre-existing and
  inside the accepted last-write-wins class (staff-notes spec Q12, cited in
  docs/issues/staff-notes-stale-page-overwrite.md); B1 raises its cost for
  the same reason the spec gave for filing the importer case.
- Correction: no B1 code change. S4.8 Step 6: the S4 report records it next
  to WI14 with these cites, so the planner can file it (or fold it into
  docs/issues/import-overwrites-notes-box.md) at the verdict. The cheap fix
  already has a precedent: the staff_notes stale-save guard
  (`staff_notes_expected_updated_at`, contacts.ts:1980-1987).

## E1-3 - NOTE - WI10's grep checks repository method names only; a listing_sends write through a service helper would pass it

- Plan location: Task S5.9 Step 3 (plan 10748-10755).
- What the plan says: `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -E "putShareMemory|setDeclined|clearDeclined|getByKeyConsistent" -- app/src/jobs/extraction.ts app/src/services/extraction`,
  expect no output; with the S5.6 proxy test (which watches only
  `deps.listingSends` / `deps.units`).
- What the tree holds: listing_sends is also written through service
  helpers that carry their own repo deps - `applyShareLedgerEntry` and
  `applyFlyerShareEntry` (app/src/services/shareLedger.ts:232, :276),
  `applyLaterAttempt`, `applyLaterAttemptBounded` and
  `originalRowLedgerWrite` (app/src/services/shareAttemptOutcome.ts:241,
  :297, :320). A call to one of them from the extraction path passes both
  the grep and the proxy test.
- Correction: replace the S5.9 Step 3 command with
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -E "putShareMemory|setDeclined|clearDeclined|getByKeyConsistent|applyShareLedgerEntry|applyFlyerShareEntry|applyLaterAttempt|originalRowLedgerWrite|createListingSendsRepo" -- app/src/jobs/extraction.ts app/src/services/extraction app/src/lib/propertyLabel.ts`
  and keep "Expect NO output (exit 1)". Checked: it prints nothing on the
  tree today, and no planned extraction-path text matches it (the planned
  sentPropertiesBlock.ts imports `lib/shareLedgerKeys.js`, which the pattern
  does not name; `createListingSendsRepo` appears only in the S5.6 worker.ts
  and dev.ts edits, outside these paths).

## Verified with no finding

The writer enumeration, by state. COVERED = a plan task builds or pins it;
UNAFFECTED = it writes none of the state (or is generic and needs nothing).

State 1 - the four tenant fields and their `<key>_source` keys:
- contacts PATCH `parseTriageBody` (contacts.ts:574) - COVERED S1.2; the
  provenance clear loop (contacts.ts:1943-1947, `PROVENANCE` built from
  `PROVENANCE_FIELDS` at :1100) - COVERED S3.3; the PATCH's supersede of a
  pending suggestion for a changed field (contacts.ts:1966-1978,
  :2039-2055) is generic - pinned by S3.3's "a human area_preference edit
  clears area_preference_source AND deletes the pending suggestion".
- contacts POST `parseCreateBody` - COVERED S1.2 (a clear is a no-op on
  create). No strict key allowlist rejects the new keys first ("unknown
  keys are ignored", contacts.ts:421); `refuseServerOwnedFields`
  (:314-327) names none of them.
- dashboard ContactEditForm - COVERED S1.3/S1.4: dirty-tracked against the
  opened contact; `buildTenantMatchingPatch` (plan 1727) sends a Number for
  dollars and null on a clear. Other dashboard contact writers name none of
  the four: ConsentCaptureModal.tsx:52, ContactDetail.tsx:755 and :899,
  StaffNotesCard.tsx:124.
- extraction apply direct write + `<key>_source` stamp - COVERED S3.3 /
  S3.4; the default arm of `fieldApplies` (apply.ts:137-142) makes the four
  tenant-only, so an unknown contact records `wrong_contact_type`
  (apply.ts:210-219).
- suggestion accept, the EXTRACTABLE arm of `buildPlan`
  (suggestionResolution.ts:380-402) - COVERED S3.3 (PR13). Journal replay
  and the daily journal sweep replay the stored plan (no re-coercion) -
  UNAFFECTED.
- caseworker conversion (caseworkerConversion.ts:533-543) - UNAFFECTED:
  its patch names none of the four; `followOn` supersedes EVERY pending
  suggestion through `listSuggestionsByContact` (:359-369), with the verdict
  stamp gated on `isDecisionTarget` (contactClassification.ts:82), which
  S3.1 extends.
- type change through the PATCH, tenant to any other type - UNAFFECTED by
  design: values and `<key>_source` stay (tenant-only is a UI guarantee,
  spec D2), pending suggestions stay and their accept is refused / fenced
  through `TENANT_ONLY_TARGETS` (COVERED S3.1, the four new
  suggestionReclassificationGuard cases); the job skips landlord / partner /
  team_member (jobs/extraction.ts:457) and apply drops the four for
  unknown. Same as pets / tenure today.
- public intake (public.ts:594-625 create, :661 update), contact capture
  and group stubs (`createIfAbsent`: contactCapture.ts:111,
  groupMembers.ts:155, groupConvert.ts:347), unmatched-email create
  (unmatchedEmail.ts:465-471), consent stamps (webhooks/voice.ts:748,
  webhooks/twilio.ts:1210, :1251), status writes (statusTransition.ts:371,
  :650), caseworker-review dismiss (caseworkerConversion.ts:592) -
  UNAFFECTED: each writes named fields only.
- importer `upsertContact` (lib/import/apply.ts:1106-1250) - UNAFFECTED: an
  UpdateItem SET of named import-owned fields, never a PutItem over an
  existing contact; the retract (:646) decides on provenance and activity,
  not an attribute list.
- seeds: cast persona 4 - COVERED S1.6 (full profile only, seed/index.ts
  :126-133); lean, matrix, live and the performance seed write none of the
  four (performance.ts does not import cast.ts). No code anywhere writes the
  four keys today (repo grep: only docs match).
- app/scripts/* (backfill-*, clean-org-names, assign-primary-contacts,
  import-*) and repo-root scripts/*.mjs - UNAFFECTED.
- dev routes: org-fixture allowlists housingAuthority / agency /
  organization (dev.ts:1328), zero-primary fixture (dev.ts:1440) -
  UNAFFECTED. e2e writes only through the API and dev routes (no DynamoDB
  client anywhere in e2e/).
- whole-item writers: contactsRepo `create` / `createIfAbsent`
  (contactsRepo.ts:1479-1516) are conditional on attribute_not_exists and
  never replace a contact; `update` (:1577-1699) is a generic SET / REMOVE.
- `_source` clearers: the PATCH loop (COVERED S3.3); `rewriteOrgFields`
  (contactsRepo.ts:1985-1989) and the conversion (caseworkerConversion.ts
  :541) touch housingAuthority_source only. No writer removes one of the
  four without its `_source` (a PATCH null clears both).
- `trimJsonBody` trims ends only (middleware/trimStrings.ts:22-36), so the
  S1.2 multi-line case keeps its interior newline. No contact merge path
  and no bulk contact writer exist.

State 2 - the tenant Notes box (`notes`):
- extraction apply append (apply.ts:713-751) - COVERED S4.2 / S4.3; the
  only writer of `[Auto - ...]` lines (repo grep).
- staff PATCH (contacts.ts:642-646) - listed in spec 4; its whole-box
  replace from a stale form is E1-2.
- staff POST create (contacts.ts:907-909) - not in spec 4's writer list;
  UNAFFECTED (the initial staff text; no extraction rule applies).
- importer replace (lib/import/apply.ts:1196-1198) - COVERED WI14 (filed,
  S4.8 diff check).
- seeds write `preferences_notes`, never `notes`; public intake, voice,
  email and the dev fixtures write no `notes` - UNAFFECTED.

State 3 - unit `priority`:
- units POST / PATCH through `validateUnitBody` (units.ts:926, :2308; the
  create spreads every validated field via `planRequirementWrite`,
  unitRequirementWrite.ts:169, into `units.create`) - COVERED S2.1 / S2.2.
- dashboard writers UnitCreateForm.tsx:359 and ListingEditForm.tsx:257 -
  COVERED S2.2; PlacementDetail.tsx:669 writes final_rent only -
  UNAFFECTED.
- requirements apply (`updateIfRequirementsCurrent` / `applyRequirements`)
  writes requirement keys only; the importer's unit facts
  (lib/import/apply.ts:1515-1561) write no priority (airtableSource.ts:156
  parses it, nothing writes it); seeds, the performance seed, dev fixtures
  and e2e carry no priority (grep) - UNAFFECTED (PR3).
- never exposed: the flyer projection is an allowlist naming priority on its
  never-list (unitFields.ts:352-360); merge fields read explicit unit keys
  (mergeFields.ts); the PROPERTIES SENT units read projects unitId and
  address only (unitsRepo.ts:1293). No whole-unit replace exists
  (unitsRepo.create is conditional, unitsRepo.ts:1252-1258).

State 4 - target-keyed extraction state (suggestions, journals, dismissal
tombstones, run decisions):
- apply `putSuggestionSafe` / `hasDismissal` (apply.ts:825-866) - COVERED
  S3; the dismissal key compares `String(coerced)`, so a portion suggestion
  "1200" and its tombstone agree (PR27).
- `buildDecisions` over DECISION_TARGETS (decisions.ts:63) and
  `stampSuperseded` (jobs/extraction.ts:690) - COVERED S3.1.
- resolution journals: `listJournals` BatchGets the DECISION_TARGETS keys
  (suggestionResolutionRepo.ts:651; 16 keys, under the 100-key cap);
  `effectiveGuard` reads TENANT_ONLY_TARGETS (:489); the sweep budget -
  COVERED S3.1 (`SWEEP_MAX_ATTEMPTS_PER_CALL = DECISION_TARGETS.length`).
- routes/suggestions.ts has no target allowlist; `aiRunsRepo.setVerdict`
  is generic. A `dism#` key with a 500-character normalized value stays
  under DynamoDB's 2,048-byte key limit (worst case about 1,580 bytes).
- the seeds write no extraction rows (grep).

State 5 - AI run records:
- `recordRun` (jobs/extraction.ts:644-681) is the only `putRun` caller and
  builds a FIXED literal - COVERED S4.4 (notesBelowFloor, notesDemoted),
  S5.6 (sentPropertiesFingerprint), S5.7 (feedbackLines,
  unlabeledAddressLines). `putRun` spreads its input (aiRunsRepo.ts:225);
  GET /:runId returns the whole run (aiRuns.ts:272); the list route's fixed
  projection (aiRuns.ts:198-217) is not required by the spec to carry the
  counts. ApplyDeps construction sites, including
  app/test/contactStaffNotes.test.ts:381 - COVERED S4.3 (1h).

State 6 - listing_sends read-only from the extraction path:
- the new job deps are `Pick<ListingSendsRepo, 'listByContact'>` and
  `Pick<UnitsRepo, 'getDisplaysByIds'>` (plan S5.6 3b); `listByContact` is
  a pure paged Query with no write-on-read (listingSendsRepo.ts:486-498) -
  COVERED S5.6 (proxy test) and S5.9 (grep; tightening in E1-3). The
  writers - shareLedger, the units outcome route (units.ts:1693, :1708,
  :1737), the public flyer sign-up and the dev listing-send fixture
  (dev.ts:1501) - sit outside the extraction path: UNAFFECTED.
