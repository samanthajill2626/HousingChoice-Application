# E2-readers - delta research findings (WP1 B1 Ranking inputs)

Reader E2 (readers and renderers). Range: the whole app (app/src, app/test,
app/scripts, dashboard/src, e2e/tests, e2e/scenarios, e2e/support, scripts)
measured against spec rev 10 in full and plan sections 0-4 (lines 1-515),
with a by-name grep of the whole plan for every surface found. Tree: the
branch source is main @d0e2c2d8 (`git diff d0e2c2d8 HEAD -- app dashboard e2e
scripts` is empty). Method: enumerate every reader, renderer and consumer of
the state B1 changes - the four tenant attributes and their `_source` keys,
the `notes` box, the changed shapes (noteLines, ExtractionInput, the target
and field lists, DROP_REASONS, ApplyOutcome, RunDraft / AiRunRecord /
AiRunRecordView, ApplyDeps, ExtractionJobDeps, UnitItem.priority,
getDisplaysByIds, IncompleteBatchReadError, listByContact), unit `priority`,
and the suggestion targets - and classify each as COVERED (a plan task),
UNAFFECTED (why) or GAP. Two of the four findings repeat or extend findings
already filed by D2-S2 and D7-S7; they are marked so the orchestrator can
merge them.

## E2-readers-1 - BLOCKER - dashboard requirements.test.ts pins PROPERTY_FORM_FIELDS twice; S2.2 updates only one (same defect as D2-S2-1)

- Plan location: Task S2.2 Step 1b (plan lines 3152-3156), Step 2 RED
  (3230-3237), Step 7 GREEN (3371-3380); S2.4 Step 4 (3559).
- What the plan says: Step 1b makes "the same two edits to its table case:
  old (:599-600) ..." and inserts `['Priority', ['priority'], 'staff_only'],`;
  Step 7 expects "36 rows in both tables" (the app parity table and that one
  dashboard case).
- What the tree holds: `dashboard/src/routes/listing/requirements.test.ts`
  reads the mirror's `PROPERTY_FORM_FIELDS` (import at :7) in TWO exhaustive
  cases: :223-260 (`describe('PROPERTY_FORM_FIELDS (the D10a tag table)')`,
  `it('lists every New / Edit property-form field in form order with its
  tag')`, an exact `toEqual` of 35 `[label, flyer]` pairs, Same-day RTA at
  :242, No evictions at :243) and :598-641 (the `[label, keys, flyer]` case
  the plan edits). No step touches the first. After S2.2 Step 3b adds the
  mirror row (`dashboard/src/routes/listing/requirements.ts:275`), the first
  case receives 36 pairs and fails: Step 7 is red, the S2.2 commit leaves the
  dashboard suite red, and S2.4 Step 4 fails.
- Correction: D2-S2-1's correction (a) + (b). Edit (a), the one missing
  today, in `dashboard/src/routes/listing/requirements.test.ts` (anchor unique,
  LF endings, the file's 6-space indent):

old:
```ts
      ['Same-day RTA', 'on_flyer'],
      ['No evictions while on the program', 'staff_only'],
```
new:
```ts
      ['Same-day RTA', 'on_flyer'],
      // WP1 B1 spec D6: the Priority switch, its own row after Same-day RTA.
      ['Priority', 'staff_only'],
      ['No evictions while on the program', 'staff_only'],
```

  Step 7's "36 rows in both tables" then reads "36 rows in all three pins
  (app/test/propertyFormFlyerParity.test.ts:174-197, requirements.test.ts
  :224-260 and :598-641)".

## E2-readers-2 - MINOR - the intake card shows "Preferences and constraints" (a textarea) in a KV row that collapses its line breaks

- Plan location: Task S1.5 Step 4c-4e (plan lines 2557-2633); S1.4 (the
  `textarea` control); S1.1 `parseTenantMatchingInputs` (plan 993-1039).
  Spec D2 (edit form controls by `control`; record rows "as the other intake
  rows have").
- What the plan says: the matching rows render through the existing row
  loop, `<KV k={r.k} v={<>{r.v}{badge}</>} />`, with
  `v: formatTenantMatchingValue(input, contact[input.key]) || BLANK`. S1.4
  gives `preferences_constraints` a textarea, and the staff parser trims only
  the ends of a text value, so line breaks a staff member types are stored.
- What the tree holds: `KV` puts `v` in `<span className={styles.v}>`
  (`dashboard/src/routes/contact/Card.tsx:144-165`); `.v`
  (`dashboard/src/routes/contact/Card.module.css:116-118`) sets only a color -
  no `white-space: pre-wrap`, no `overflow-wrap`. "No apartments" + newline +
  "Needs a yard" therefore displays as one run-together line, and a long
  unbroken value (a pasted link) can overflow the card. The Notes box had this
  exact defect and fixed it on its own class (Card.module.css:354-362: "Notes
  are PROSE: preserve the author's newlines (the old chip collapsed them)").
  Every existing intake row is a single-line input, so B1's textarea is the
  first multi-line value a KV row renders; the record no longer shows what
  staff typed. (The suggestion chip is fine: `.chip` wraps and `.heard` sets
  no nowrap, SuggestionChip.module.css:5-21.)
- Correction (S1.5, same commit):
  1. `dashboard/src/routes/contact/Card.module.css`, insert after the `.v`
     rule:

```css
/* A free-text tenant matching input (WP1 B1 spec D2): Preferences and
 * constraints is a textarea, so keep the author's line breaks, and break a
 * long unbroken value rather than overflowing the card. */
.vProse {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
```

  2. `dashboard/src/routes/contact/Card.tsx`, beside `responseClass`:
     `export const proseValueClass = styles.vProse ?? '';`
  3. `EligibilityIntakeCard.tsx`: import `proseValueClass` beside
     `BLANK, Card, KV` from './Card.js'; each matching row (Step 4c's
     `matchingRows` object) also carries `prose: input.kind === 'text'`; the
     row type gains `prose?: boolean`; and the KV line of the render (Step 4e
     region, :117 today) becomes

```tsx
          <KV k={r.k} v={<>{r.prose ? <span className={proseValueClass}>{r.v}</span> : r.v}{r.src ? <AutoBadge {...(r.src.at !== undefined && { at: r.src.at })} /> : null}</>} />
```

     (the five existing rows carry no `prose` and render as today).
  4. Test, appended to `EligibilityIntakeCard.test.tsx` (import
     `styles from './Card.module.css'`, the AppFrame.test.tsx:115 precedent):
     render with `preferences_constraints: 'No apartments\nNeeds a yard'` and
     `area_preference: 'Decatur'`; assert
     `expect(screen.getByText(/No apartments/)).toHaveClass(styles.vProse!)`
     and `expect(screen.getByText('Decatur')).toHaveClass(styles.vProse!)`,
     and `expect(screen.getByText('Yes')).not.toHaveClass(styles.vProse!)`
     for a `lifEligible: true` row. Plus a CSS source pin in the
     Timeline.styles.test.ts pattern (`css: false` means no test can measure
     layout): the `.vProse` body of Card.module.css matches
     `/white-space:\s*pre-wrap/` and `/overflow-wrap:\s*anywhere/`.

## E2-readers-3 - NOTE - e2e/support/selectors.md also states the 12-target decision-ledger order (extends D7-S7-10)

- Plan location: no task (S7 cites selectors.md at plan line 15811; S3.8's
  count sweep, 5578-5713, and the S6 docs tasks do not include it).
- Note: beyond the chip labels, the "Notes lines" region and the Priority
  controls D7-S7-10 lists, `e2e/support/selectors.md:81` asserts "Rows render
  in the DECISION_TARGETS display order (firstName, lastName, voucherSize,
  housingAuthority, pets, evictions, tenure, porting, address, status, type,
  phone)" and names `agency_not_authority` as the one drop-reason label
  exception. After S3.1 / S3.7 the order is sixteen targets (the four after
  porting) and `text_field_filled` reads "Field already filled". Missions keep
  this file current in-branch (git log: 93ebccbd, 5809b2ad, d75a567a). If the
  orchestrator adds D7-S7-10's doc line, the same edit replaces the
  parenthesized list with `(firstName, lastName, voucherSize,
  housingAuthority, pets, evictions, tenure, porting, area_preference,
  max_tenant_portion, accessibility_need, preferences_constraints, address,
  status, type, phone)` and adds "`text_field_filled` reads `Field already
  filled`" beside the agency exception. The file carries pre-existing em
  dashes; only added lines must be ASCII. No gate depends on it.

## E2-readers-4 - NOTE - the open demotion-persistence issue does not record that a demoted conversation now loses its Notes lines

- Plan location: none; spec section 3 lists
  docs/issues/voice-extraction-window-demotion-persistence.md as out of scope,
  and spec section 8 Q1 records Cameron's acceptance.
- Note: the issue body (:13-30) describes the persistence as demoting "ALL
  field writes to review chips" and calls it "SAFE-DIRECTION (over-caution,
  never a wrong write)". After S4.3 the same window also withholds every
  Notes line - model and system lines, feedback lines included - counted only
  as `notesDemoted`, so for up to 30 days such a conversation records no
  Notes lines at all and the Possible caseworkers `ai_note` signal cannot
  fire there. That is a loss, not a downgrade to a chip. Optional, docs-only
  (S6): append to the issue body "Since WP1 B1 (spec 2026-10-26 D4, Q1) a
  demoted run also appends NO Notes line - model and system lines alike,
  feedback lines included (counted as notesDemoted in the run record) - so a
  conversation demoted this way records no Notes lines while the call stays
  in the window." Severity stays the triager's call.

## Verified with no finding

- The four attributes, storage to screen (COVERED / UNAFFECTED): `getById`
  reads the whole item (contacts carry projections only for display and
  recipient batch reads, contactsRepo.ts:1105-1135); GET /api/contacts/:id
  spreads it (contacts.ts:1277-1306); PATCH returns ALL_NEW
  (contactsRepo.ts:1694; contacts.ts:2255); POST create and suggestion
  accept/dismiss return the full item (suggestions.ts:51-53, :207);
  listByType / findByPhone return full items and every GSI projects ALL
  (infra/modules/dynamodb/main.tf:57, app/src/lib/dynamoAdmin.ts:57);
  `contactsRepo.update` has no key allowlist and aliases every name
  (:1577-1617). Dashboard: useContact -> getContact (endpoints.ts:1480-1492)
  -> TenantFile passes `contact` whole to EligibilityIntakeCard
  (TenantFile.tsx:269-276) -> S1.3 / S1.5; edit form S1.4; chips S1.3 Step 5 +
  S1.5 (TenantFile places each chip explicitly and has no fallback chip
  area, :166-267); `_source` via
  `aiSourceOf` (suggestionTargets.ts:24-31) + S1.5; CURRENT PROFILE S3.5
  (a stored 0 survives: `typeof raw === 'number'`); AI run detail S3.7. No
  contacts export, merge or search index carries a field list (vocabulary is
  roles, relationship roles and custom-field labels only). The importer
  writes by UpdateCommand SET (lib/import/apply.ts:1196-1198, :1239), so the
  four survive a re-import. Caseworker conversion REMOVEs only
  housingAuthority and drops pending suggestions generically
  (caseworkerConversion.ts:532-543) - the four stay on a converted contact
  exactly as pets / tenure do. `contact_updated` audit events have no
  renderer. Today's ai_suggestions group counts pending suggestions
  generically (today.ts:1172-1201). The intake fieldset is tenant-only in the
  edit form while TenantFile also serves team_member - pre-existing for every
  intake row.
- Labels (WI11): no e2e or dashboard selector is a substring of a new label
  or the reverse (e2e/scenarios/steps.ts:930 `'Pets'`,
  contact-detail.spec.ts:63 `'Notes'`, ContactEditForm.test.tsx label
  regexes, every `AI suggestion for <label>` group name,
  placement-create.spec.ts:132 and ContactDetail.test.tsx:1216 `'Tenant'` are
  in other dialogs / exact).
- `notes` readers: the Preferences & notes cards (TenantFile.tsx:298-310,
  UnknownFile.tsx:204-216, PartnerFile) render through NotesText, plain text
  with pre-wrap (Card.tsx:455-489) - UNAFFECTED; CURRENT PROFILE
  (jobs/extraction.ts:163) unchanged; `hasAiCaseworkerNote`
  (lib/caseworkers.ts:42-82, read at possibleCaseworkers.ts:82) needs a line
  STARTING `[Auto - <date>] identified as ...`, so a feedback line never trips
  it, and the classification example that feeds it (prompt.ts:97-104) sits
  outside the bullet S4.6 rewrites - WI6 COVERED. The only other `[Auto - `
  matchers are apply.ts (S4.2 / S4.3) and prompt.ts (S4.6 keeps and pins the
  sentence). The PATCH and the edit form put no length cap on `notes`
  (contacts.ts:642-647, ContactEditForm.tsx:1101-1108). Public intake writes no
  `notes`; the dev reseed deletes every row and re-seeds (devReset.ts), so no
  state leaks between e2e specs.
- noteLines shape: consumers are apply.ts:713-751 and schema.ts:124-127,
  :268-273 (S4.3); the fake driver passes payloads untyped
  (extractionFake.ts:103) and `filterNoteLines` drops non-objects (S4.2);
  app test files using noteLines are exactly contactStaffNotes,
  extractionAdapter, extractionApply and extractionSchema, all in S4.3's
  list; e2e payloads are exactly the four WI4 sites; the probe reads no
  noteLines; `rawResult` is stored as the driver returned it and rendered as
  JSON only (AiRunDetail.tsx:88). The ai_run.completed payload names its
  fields (jobs/extraction.ts:791-802), so its key-set pin
  (extractionJob.test.ts:1733-1735) is unaffected. The 4096-token output cap
  (adapters/extraction.ts:184) covers twelve field ops plus up to twenty
  200-character note objects.
- ExtractionInput.sentPropertiesBlock: every literal (extractionAdapter.test.ts
  baseInput :33 / :38 and its spreads, extractionRunWindow.test.ts:77,
  extractionSchema.test.ts :412 / :478 / :500 / :593 / :608,
  jobs/extraction.ts:586, the probe :205) is in S5.4, and app/test is
  typechecked (app/package.json typecheck runs tsconfig.test.json). The
  console and anthropic drivers log counts only (adapters/extraction.ts:224-232,
  :287-295).
- Target and field lists: every consumer iterates generically - aiRuns.ts:33-42
  (decisionCounts), decisions.ts:63, schema.ts:323-330 / :366,
  suggestionResolutionRepo.ts:489 / :651 (16 keys, under the 100-key BatchGet
  cap), suggestionResolution.ts:226 / :822, contactClassification.ts:82,
  jobs/extraction.ts:690, Today, the PATCH supersede loop
  (contacts.ts:1966-1977). Every pin is in a task: extractionRunTypes.test.ts
  :9 / :17, suggestionReclassification.test.ts:245-249 and its drift guard
  :251-285, extractionJob.test.ts:1129, AiRunsSection.test.tsx:25 / :87 /
  :91-94, types.test.ts:343-375, the stale-count comments including
  contacts.ts:1098 (S3.3 3f). No `Record<DropReason | DecisionTarget |
  ExtractableField>` literal exists outside Partial or loop-built maps.
- ApplyDeps.factMinConfidence: exactly six construction sites (worker.ts:489,
  dev.ts:765, extractionApply makeDeps, contactStaffNotes.test.ts:381, the two
  job harnesses), all named at plan 5907-5912 (RequirementsApplyDeps in
  contactRequirementsApply.ts is unrelated). ExtractionJobDeps: four sites
  (worker.ts:464-501, dev.ts:733-777 - no test sets `extractionTickDeps` -,
  the two harnesses); pollLoop.test.ts names runDueExtractions in a comment
  only.
- ApplyOutcome has no consumer outside jobs/extraction.ts and tests; the only
  whole-outcome pins are extractionApply.test.ts:207 and :268-279 (PR31).
  AiRunRecord / RunDraft / AiRunRecordView: putRun spreads its input
  (aiRunsRepo.ts:223-251), the detail route returns `run` whole (aiRuns.ts:272)
  so the new counts and fingerprint reach the dashboard, the list route names
  its fields (aiRuns.ts:194-217) and the counts are detail-only per spec; no
  test pins a whole run record or its key set; the new "Notes lines" region
  name collides with no existing region selector.
- getDisplaysByIds (units): one production caller (tours.ts:551) and one fake
  (twilioWebhookHarness.ts:2991), both fine with an optional second
  parameter; the `#unitId, #address` projection (unitsRepo.ts:1293) returns
  the whole address map propertyLabel needs (lib/address.ts:12-21).
  IncompleteBatchReadError: every existing construction passes two arguments
  (contactsRepo.ts:1099 and tests) and the default third keeps the contacts
  message. listByContact already filters isListed (listingSendsRepo.ts:486-497;
  plan C1 at 7765 records isListed as module-private). The job runs only on
  tenant and unknown contacts (jobs/extraction.ts:457-462), matching D5.1.
- Unit priority: today's readers are unitFields.ts:106 and :359 (docblock),
  unitsRepo.ts:464-465, unitFields.test.ts:645 / :707 and airtableSource.ts:58 /
  :156 (parsed, never written; lib/import/apply.ts has no priority); the
  dashboard has none; no seed holds it; the only public unit payload is the
  toUnitFlyer allowlist (unitFields.ts:403-480; public.ts:854) and the only
  other public routes are the housing-fair POST and the authority list; every
  staff unit route returns the item spread (units.ts); there is no unit
  duplicate or copy writer; merge fields read no unit or contact attribute
  generically; no property-form test counts checkboxes or Staff only tags;
  ListingDetail tests do not pin the full KV list.
- EligibilityIntakeCard's BLANK-count pins (EligibilityIntakeCard.test.tsx:36,
  :53, :59, :66) move in S1.5 (plan 2259-2299); TenantFile, files and
  ContactDetail tests count no BLANKs; no e2e counts intake rows.
