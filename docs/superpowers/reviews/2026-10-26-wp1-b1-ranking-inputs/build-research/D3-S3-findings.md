# D3-S3 findings - plan section 7 (S3 Extraction reconciles the four fields)

Reader D3-S3 checked plan lines 1-515 (binding sections 0-4), 666-1064 (Task
S1.1, the list module S3 imports) and 3628-5791 (S3: contradictions, cross-slice
notes, tasks S3.1-S3.9 and the S3 coverage table) against the worktree at
branch HEAD ede08552, whose app/, dashboard/, e2e/, scripts/ and RUNBOOK.md are
byte-identical to main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those
paths is empty). Checked: every quoted old anchor (verbatim, unique, ASCII on
the anchor lines), every name/import/export/helper/fixture the S3 code and test
sketches call, every consumer of DECISION_TARGETS / DecisionTarget /
TENANT_ONLY_TARGETS / DROP_REASONS / DropReason / ExtractableField /
EXTRACTABLE_FIELDS / PROVENANCE_FIELDS / ExtractionProfileSnapshot in app,
scripts, dashboard and e2e, the runtime import graph the new imports create,
the prompt pins, the RED/GREEN claims of each step, the WI3 count grep (run
here against the tree, output reviewed hit by hit), and the S1.1 / S1.2 /
S1.3 planned code S3 builds on. Nothing was run. Five MINOR findings and two
NOTEs; no BLOCKER and no MAJOR.

## D3-S3-1 - MINOR - S3's start-gate assumption about `<key>_source` on ContactItem is false, and the gate says stop

- Plan location: section 7 "Assumptions S3 builds on" (plan lines 3651-3652,
  gate at 3658-3659).
- What the plan says: "`ContactItem` (`app/src/repos/contactsRepo.ts`)
  declares the four keys (text as `string`, `max_tenant_portion` as `number`)
  and their `_source` keys." and "If any of these is false at S3 start, stop
  and report it in the S3 report before writing code."
- What the tree / S1 holds: S1.2 Step 3b (plan 1265-1281) makes
  `export interface ContactItem extends TenantMatchingInputValues`, which
  carries the four VALUE keys only; PR24 (plan 307-309) gives `_source` keys
  to the dashboard `Contact` only. App-side `<key>_source` exists only through
  ContactItem's `[key: string]: unknown` index signature
  (app/src/repos/contactsRepo.ts:387). So the assumption is false at S3 start
  by design, and a literal implementer halts on it. Nothing in S3 needs a
  typed `_source` key: apply writes `writePatch[\`${field}_source\`]` into a
  `Record<string, unknown>` (app/src/services/extraction/apply.ts:300-301) and
  the S3 tests seed `_source` through `Record<string, unknown>` helpers
  (app/test/suggestions.test.ts:24-35).
- Correction: replace the bullet at plan 3651-3652 with:
  "- `ContactItem` (`app/src/repos/contactsRepo.ts`) extends
  `TenantMatchingInputValues`, so it declares the four VALUE keys (text as
  `string`, `max_tenant_portion` as `number`). It does NOT declare
  `<key>_source` keys (PR24); those ride the `[key: string]: unknown` index
  signature, which is all S3 uses."

## D3-S3-2 - MINOR - S3.3 Step 2 lists a RED case that is green on unchanged code (PROVENANCE pin is tautological); step labels in the same list are off

- Plan location: Task S3.3 Step 1b, case "PROVENANCE_FIELDS is every
  extractable field plus address ..." (plan 4373-4375); Step 2 RED list (plan
  4662-4666, 4673-4674).
- What the plan says: Step 2 says the extractionSchema cases
  "EXTRACTABLE_FIELDS is the eight, then the four", "PROVENANCE_FIELDS ...",
  "carries ONE all-required fieldOp entry ..." fail "(the list is still
  eight)". It also says the suggestions "$1,200" case "fails AGAIN after 3a
  alone ... and only passes after 3b".
- What the tree holds: `PROVENANCE_FIELDS` is defined as
  `[...EXTRACTABLE_FIELDS, 'address']` (app/src/services/extraction/schema.ts:40),
  so `expect(PROVENANCE_FIELDS).toEqual([...EXTRACTABLE_FIELDS, 'address'])`
  passes today and after the change alike - it can never fail for the stated
  reason and does not prove the four joined PROVENANCE (section 0: confirm
  each RED is red for the stated reason). Separately, Step 3's labels are
  3a-3c = schema.ts and 3d-3e = suggestionResolution.ts; the "$1,200" accept
  only passes after 3e (the coerceAccept delegation), not 3b.
- Correction: in Step 1b replace the PROVENANCE case body with
  `expect(PROVENANCE_FIELDS).toEqual([...ORIGINAL, ...MATCHING, 'address']);`
  (RED today: the four are missing; GREEN after 3b). In Step 2 replace
  "fails AGAIN after 3a alone (the generic arm writes the string "$1,200")
  and only passes after 3b" with "fails AGAIN after 3a-3c alone (the generic
  arm writes the string "$1,200") and only passes after 3e".

## D3-S3-3 - MINOR - The S3.8 count sweep misses five stale target/field counts; its own WI3 rule then forces edits to files its commit does not stage

- Plan location: Task S3.8 edit list (plan 5585-5677), "Do NOT touch" (5679-5683),
  WI3 grep rule (5691-5702), commit (5704-5710); C1 (3663-3689).
- What the plan says: the listed edits plus "Every remaining hit must be one
  of the "Do NOT touch" items above or a word unrelated to the target/field
  sets", and "a `12` that counts the decision targets is a stale count - fix
  it in this task (comment) or report it (code)". The commit stages an
  explicit path list.
- What the tree holds: running the plan's exact WI3 grep against this tree,
  these hits count the target / field / journal-key sets, are in neither the
  edit list nor "Do NOT touch", and sit in files S3.8's `git add` omits:
  `app/src/jobs/journalSweep.ts:229` ("throttled 12-key read"),
  `app/src/jobs/journalSweep.ts:251` ("closed 12-key journal set"),
  `app/test/journalSweep.test.ts:512` ("reads the contact's 12 journals"),
  `app/test/suggestionResolutionRecovery.test.ts:17` ("walk all twelve keys"),
  `app/test/extractionSchema.test.ts:536` ("the eight scalar fields"). Also,
  once item 13 rewrites AiRunsSection.test.tsx:109 to "sixteen", the next
  lines still say "Both of these rows summed to 12" (:111) over fixture rows
  that sum to 12 (`not_addressed: 11` / `12`, :113-114).
- Correction: add to S3.8's list (whole-line edits, comments only):
  15. `app/src/jobs/journalSweep.ts:229`
      `      // throttled 12-key read used to propagate out of this loop into the`
      -> `      // throttled journal-key read used to propagate out of this loop into the`
  16. `app/src/jobs/journalSweep.ts:251`
      `        // POST-LOOP TRUTH CHECK on the contact's closed 12-key journal set.`
      -> `        // POST-LOOP TRUTH CHECK on the contact's closed journal key set (sixteen since B1).`
  17. `app/test/journalSweep.test.ts:512`
      `        // recoverAbandoned reads the contact's 12 journals with a consistent`
      -> `        // recoverAbandoned reads the contact's 16 journal keys with a consistent`
  18. `app/test/suggestionResolutionRecovery.test.ts:17`
      `// twelve keys on an ordinary page read.`
      -> `// sixteen keys on an ordinary page read.`
  19. `app/test/extractionSchema.test.ts:536`
      `    // The reconciliation contract the eight scalar fields already have.`
      -> `    // The reconciliation contract the scalar fields already have.`
  20. `dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx:111` - change
      only "summed to 12" to "summed to 16", and in :113-114 change
      `not_addressed: 11` to `not_addressed: 15` and `not_addressed: 12` to
      `not_addressed: 16` (fixture values; the case asserts only the
      "1 wrote, 0 suggested" / "0 wrote, 0 suggested" text, so it stays green).
  Add `app/src/jobs/journalSweep.ts app/test/journalSweep.test.ts
  app/test/suggestionResolutionRecovery.test.ts app/test/extractionSchema.test.ts`
  to S3.8's `git add`. (suggestionResolutionRecovery.test.ts:118
  `maxAttempts: 12` stays per C1.)

## D3-S3-4 - MINOR - Three docs go stale with S3 and no task updates them

- Plan location: S3 has no docs task (PR2: docs are S6); S6.7 (plan
  15128-15256) edits only RUNBOOK "### AI extraction, ~1442-1496"; S3.8 does
  not touch e2e/support.
- What the plan says: spec D3 "Every hard-coded count is updated"; spec 4
  docs list RUNBOOK "the extraction section".
- What the tree holds:
  - `RUNBOOK.md:1596` (inside "### AI extraction", past S6.7's range):
    "The extracted fields are the eight scalar profile fields plus the"
    - stale once S3.3 makes twelve.
  - `RUNBOOK.md:614`: "an Accept of a tenant-only suggestion (housing
    authority, voucher size, pets, evictions, time at current address,
    porting, status) on a contact that is not a tenant is refused" - after
    S3.1 the four are tenant-only too (409 suggestion_contact_not_tenant),
    so the operator list is incomplete.
  - `e2e/support/selectors.md:81`: "Rows render in the DECISION_TARGETS
    display order (firstName, lastName, voucherSize, housingAuthority, pets,
    evictions, tenure, porting, address, status, type, phone)" - wrong after
    S3.7 (the four sit after porting).
  All three lines are ASCII.
- Correction: add to S6.7 two ASCII edits: RUNBOOK.md:1596 "the eight scalar
  profile fields" -> "the twelve scalar profile fields (the eight intake
  fields and the four tenant matching inputs)"; RUNBOOK.md:614 "(housing
  authority, voucher size, pets, evictions, time at current address, porting,
  status)" -> "(housing authority, voucher size, pets, evictions, time at
  current address, porting, status, and since WP1 B1 area preference, maximum
  tenant portion, accessibility need, preferences and constraints)". Add to
  S3.8 item 21 (and its `git add`): e2e/support/selectors.md:81 "porting,
  address, status, type, phone)" -> "porting, then the tenant matching inputs
  in list order (area_preference, max_tenant_portion, accessibility_need,
  preferences_constraints), address, status, type, phone)". (A doc may name
  the keys; the readers pin covers app/src only.)

## D3-S3-5 - MINOR - Spec 5 asks for coercion on BOTH paths; the accept path never tests 1200.50 or out of range

- Plan location: Task S3.3 Step 1e (plan 4503-4607); S3 coverage row "Spec 5
  D3: coercion both paths" (5782).
- What the plan says: the coverage row maps "($1,200 -> 1200, 1200.50
  dropped, out of range dropped, 500 cap drops)" on both paths to S3.2 and
  S3.3.
- What the tree / plan holds: spec 5 D3 (spec lines 640-641) requires
  "coercion both paths (500 cap drops, `$1,200` -> 1200, `1200.50` dropped,
  out of range dropped)". S3.2 covers all four on `coerceField`; S3.3's accept
  tests cover only '1200', '$1,200' and a 501-char text. A future edit that
  stops `coerceAccept` delegating (C3) for dollars would pass every S3 test.
- Correction: append to S3.3 Step 1e's describe:
  ```ts
  it('refuses a fractional or out-of-range dollars suggestion, KEEPING it (one coercion rule)', async () => {
    const { app, world } = makeWebhookHarness();
    const contactId = seedTenant(world);
    for (const [i, suggestedValue] of ['1200.50', '20001'].entries()) {
      await seedSuggestion(world, {
        ownerContactId: contactId, target: 'max_tenant_portion', suggestedValue, conversationId: `conv-r${i}`,
      });
      const res = await accept(app, contactId, 'max_tenant_portion');
      expect(res.status, suggestedValue).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_suggestion_value' });
      expect(await world.extractionRepo.getSuggestion(contactId, 'max_tenant_portion')).toBeDefined();
    }
    expect(world.contacts.find((c) => c.contactId === contactId)?.['max_tenant_portion']).toBeUndefined();
  });
  ```
  Add it to Step 2's RED list (400 `unknown_target` today, so the status
  passes but the body assertion fails - RED for the stated reason).

## D3-S3-6 - NOTE - S3.3's dismiss-PIN rationale names the wrong check; the conclusion holds

- Plan location: Task S3.3 Step 2 (plan 4675-4677).
- What the plan says: "The dismiss PIN is green (dismiss validates the target
  with `isDecisionTarget`, already 16 since S3.1)".
- What the tree holds: `buildPlan` returns the dismiss plan for ANY target
  before any target check (app/src/services/suggestionResolution.ts:282-291);
  `isDecisionTarget` is used only by the verdict stamp
  (suggestionResolution.ts:459). The PIN is green regardless of S3.1.
- Correction: none required; optionally read "(dismiss returns its plan for
  any target before any target check, suggestionResolution.ts:282)".

## D3-S3-7 - NOTE - Focus (c): the bare-integer suggestion value is guaranteed by apply, not by suggestionMatchesAppliedValue

- Plan location: S1 cross-slice note (plan 634-640) and PR27 (316-321), which
  S3 relies on.
- What the tree holds: `suggestionMatchesAppliedValue`
  (app/src/routes/contacts.ts:206-215) runs only for `target === 'type'`
  (contacts.ts:2047), so it never compares a dollars value. The bare-integer
  form is guaranteed because apply suggests `String(value)` of the COERCED
  value (apply.ts:330) - 1200 -> "1200" - and dismissal tombstones and the
  re-suggest check normalize that same string (apply.ts:839,
  normalizeSuggestionValue schema.ts:301-304). The S3.3 "$1,200" accept test
  is therefore only reachable through a hand-seeded suggestion; it still
  usefully pins the shared coercion. No change needed.
- Also NOTE: S3.9 Step 4 lints 10 of the ~27 files S3 touches (it omits
  app/scripts/extraction-prompt-probe.ts, app/src/routes/contacts.ts,
  app/src/repos/suggestionResolutionRepo.ts,
  app/src/services/extraction/decisions.ts and every test file); the plan's
  test code adds no unused import or binding (checked), and gate 5 at S7
  lints the whole branch, so this is record only.

## Verified with no finding

- Anchors, verbatim and unique on this tree: runTypes.ts:1-9, :13, :28-30,
  :52-54; journalSweep.ts:73-76, :84-86; apply.ts:31-32, :91-103 (head of
  coerceField), :139-140, the S3.4 `continue;`/`const coerced = coerceField(...)`
  anchor (:218-222, unique); adapters/extraction.ts:23, :46-54, :96-97, :172;
  schema.ts:21, :23-40, :70-93, :329, :364; suggestionResolution.ts:24, :31,
  :46, :106-108, :160-163, :722; contacts.ts:1097-1099, :2043;
  suggestionResolutionRepo.ts:204; decisions.ts:9; prompt.ts:10, :43-44, :76,
  :107-109; jobs/extraction.ts:51, :162-163; AiRunDetail.tsx:3, :34-44;
  dashboard api/types.ts:312-314, :2241; api/types.test.ts:357-359;
  AiRunsSection.test.tsx:25, :87, :91-94, :109; ai-run-log.spec.ts:144, :146,
  :152, :164-166, :272; extractionApply.test.ts:16; extractionSchema.test.ts:4-7;
  extractionJob.test.ts:23-24, :1129; journalSweep.test.ts:135;
  suggestionReclassification.test.ts:245-249;
  suggestionReclassificationGuard.test.ts:19; extractionDecisions.test.ts:3,
  :10; extractionOps.test.ts:27, :57; suggestionResolutionRepo.integration.test.ts:261-262;
  probe :187-192. All anchor lines are ASCII (contacts.ts and api/types.ts
  carry non-ASCII elsewhere only); the S3 and S1.1 plan ranges are 0 non-ASCII
  bytes.
- Focus (a): the only exhaustive structures over the target/drop-reason sets
  are `ExtractionOpsView = Record<DecisionTarget, ...>` (schema.ts:321, filled
  by a DECISION_TARGETS loop), `Partial<Record<DecisionTarget, ...>>`
  (decisions.ts, aiRunsRepo.ts, jobs/extraction.ts), loops in aiRuns.ts:35 and
  suggestionResolutionRepo.ts:651, the dashboard mirrors
  DECISION_TARGET_ORDER and AI_RUN_DROP_REASON_LABELS (+ types.test.ts
  SERVER_DROP_REASONS), and SUGGESTION_TARGET_LABEL (S1). No complete object
  literal, satisfies-check or exhaustive switch elsewhere (app, scripts,
  dashboard, e2e). Every commit S3.1-S3.7 stays type-correct in order: S3.1
  grows DecisionTarget before S3.2 grows ExtractableField, so
  parseExtractionOps's `view[field]` stays valid; S3.2 fixes the only
  ExtractionProfileSnapshot index write (the probe). The drift guard
  (suggestionReclassification.test.ts:262-285) stays green after S3.1 because
  ACCEPTABLE_TARGETS includes DECISION_TARGETS minus `type`; the fake
  listJournals (test/helpers/suggestionResolutionFake.ts:213) has no target list.
- Focus (b): schema optional count is 0 today (fields, statusAdvance,
  typeSuggestion, phoneAddition, speakerRoles items, address and the root all
  list every key as required), so the S3.3 "(PIN) zero" case is a true pin;
  `countOptionalParams` is defined in-file (extractionSchema.test.ts:43);
  `Object.fromEntries` over EXTRACTABLE_FIELDS keeps key order; walkSchema and
  the fingerprint test are unaffected.
- Focus (c): `coerceAccept` delegation compiles and is cycle-free
  (suggestionResolution.ts is imported only by jobs/journalSweep.ts,
  routes/api.ts, routes/suggestions.ts; none reachable from apply.ts);
  buildPlan's 400 precedes the claim, so a refused accept keeps the chip (as
  the existing address case, suggestions.test.ts:327-343); serializeContact
  passes every key through (routes/suggestions.ts:51-53).
- Focus (d): S3.4's check sits after fieldApplies and before coercion and the
  demotedFields push (apply.ts:327); RunDecision/ApplyDecision dropReason is
  DropReason, which S3.1 extends; buildDecisions carries the hit's dropReason.
- Focus (e): `toProfile` is exported (jobs/extraction.ts:142);
  profileFieldNames uses Object.entries (:356-362) so the four reach
  profileFieldsPopulated; CURRENT PROFILE is `JSON.stringify(profile)`, so the
  four reach the model; extractionJob.test.ts helpers tenantContactWith (:159),
  makeHarness/`seen`/`runs` (:238-312), dueRow (:315), msg (:69), convWith
  (:171) exist with the shapes used.
- Focus (f): no existing prompt pin covers prompt.ts:43-44, :76 or :107-109;
  caseworkers.test.ts, extractionAdapter.test.ts and the org-name /
  noteLines / address prompt cases stay green; no later slice's prompt text
  adds "eight", "their rent portion" or "stairs are OK".
- Focus (g): SWEEP_MAX_ATTEMPTS_PER_CALL derived from DECISION_TARGETS.length
  (journalSweep.test.ts:377-378 use the constant); PR36's
  suggestionResolution.ts:46 anchor and replacement read correctly.
- Focus (h): DECISION_TARGET_ORDER spread of the import-free dashboard mirror
  (plan S1.3 1643-1660 exports TENANT_MATCHING_INPUTS with `.key`); the RED
  claims for the ordering, label and types.test cases hold; 16 alphabetical
  fixture keys sort as listed; the Reason cell is the last cell.
- Focus (i): the e2e marker fixture edit is the only change needed in e2e; no
  e2e spec counts decisions, rows or no-finding outcomes; decisionRow's
  `^<target>\b` regex does not collide with the four keys.
- Focus (j): `profile[field] = recorded` in the probe (:191) fails to compile
  once ExtractableField grows (TS7053), `Object.assign` compiles at S3.2 and
  after S3.5; tsconfig.scripts.json includes scripts + src; WI13 regex sees
  exactly one specifier; no later slice edits runTypes.ts.
- tenantMatchingInputsReaders pin: none of the ten READERS spells a key today,
  no S3 code block adds one, and no later-slice code for those files does
  (later key literals land in the probe, its data module and tests only).
- vitest's SSR import transform makes a missing export `undefined`, so S3.2's
  RED fails only the new describe, as claimed.
