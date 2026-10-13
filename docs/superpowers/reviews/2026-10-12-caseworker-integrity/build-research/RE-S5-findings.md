# RE - S5 live-tree drift check (seeds, e2e, docs) - findings

Reader RE, 2026-10-12. Plan `docs/superpowers/plans/2026-10-12-caseworker-integrity.md`
sections 0-3 and slice S5 (plan:12652-14477), against the worktree at
`fix/caseworker-integrity` @670fb701 (main @19607658 + docs only). Rulings
applied: `plan-research/plan-assembly-rulings.md`, `plan-review/adjudications.md`,
`plan-research/S5-findings.md`. Code is cited by `file:line`; byte-exact quotes
are in `.superpowers/sdd/research/RE-S5-reference.md`.

Totals: 1 BLOCKER, 2 CORRECTION, 5 NOTE.

---

## 1. BLOCKER - Task 5.5 Step 2: the API move to Lost carries no `lostReason`, so it answers 400

- **Plan.** plan:13628-13631, in the new placements-page.spec.ts test:
  `req.post(.../placements/${placementId}/transition, { data: { toStage: 'lost', source: 'manual' } })`
  then `expect(lost.ok(), await lost.text()).toBeTruthy()`.
- **Tree.** `app/src/routes/statusTransition.ts:187-196`: a move to `lost`
  requires `lostReason.category` or non-empty `lostReason.text`, else
  `400 { error: 'a lost move requires lostReason.category or non-empty lostReason.text' }`.
  Valid categories: `app/src/lib/statusModel.ts:306-314`. No S1-S4 task
  changes this rule. No existing e2e moves a placement to Lost through the API
  (`lost-modal.spec.ts` uses the UI modal, which always sends a reason), so the
  plan had no precedent to copy.
- **Effect.** The test fails at fixture setup; the refusal it exists to prove
  (the placement-page sentence, the 409 `contact_not_tenant`) is never reached.
  The slice gate's step 4 cannot pass.
- **Correction.** Replace plan line 13629 with:
  `    data: { toStage: 'lost', source: 'manual', lostReason: { category: 'tenant_withdrew' } },`
  Nothing else in the test changes. (Verified: with that body the rest of the
  flow matches the tree - `gateFor('lost', 'send_application')` is `'none'`,
  `dashboard/src/routes/placements/transitionGate.ts:21-30`, so the UI move
  goes straight to `runTransition` and its `.catch` with no dialog;
  `PlacementDetail.tsx:560-563` is the `role="alert"` bar S3 Task 3.17 feeds.)

## 2. CORRECTION - Task 5.9 Step 3b: `unit-primary-contact-unchecked` cites lines in two files S4 edits first

- **Plan.** refs line plan:14324 (`app/src/routes/units.ts:1055`,
  `app/src/repos/unitsRepo.ts:815`) and body plan:14329 (`units.ts:1055-1058`),
  plan:14336 (`unitsRepo.ts:815-824`), plan:14355 and plan:14369
  (`unitsRepo.ts:816-817`).
- **Tree.** Correct today (`units.ts:1055-1056` the scalar comment on
  `POST /api/units/:id/contacts`; `unitsRepo.ts:815-824` the scalar sync;
  `:816-817` the masked-call comment). But S4 lands first and shifts both:
  Task 4.2 inserts ~15 lines into `POST /api/units` (after the org-list block,
  `units.ts:~489`) plus an import, Task 4.4 adds imports - all above :1050;
  Task 4.5 inserts the ~24-line `restoreWithLandlord` member after
  `rewriteAcceptedAuthorities` in the `UnitsRepo` interface
  (`unitsRepo.ts:474-478`), above :815. Every OTHER `file:line` in the four new
  issues sits in a file S1-S4 do not edit and is correct (checked:
  `statusModel.ts:118`, `StageMenu.tsx:155`, `lost-modal.spec.ts:27`,
  `placement-history.spec.ts:16`, `import/apply.ts:883/1065/1110/1519`,
  `contactsRepo.ts:1501`, `unitFields.ts:46/104`, `webhooks/voice.ts:627`,
  `conversationsRepo.ts:207`, `rosterProvision.ts:233/525`,
  `tourContacts.ts:124`, `rosterResolution.ts:293`).
- **Correction.** Add to Step 3b, before writing the file: re-derive the five
  numbers on the S5-time tree and substitute them -
  `cd "W:/tmp/caseworker-integrity"; grep -n "keeps the primary_contact scalar" app/src/routes/units.ts`
  (= N; refs `units.ts:N`, body `units.ts:N-(N+3)`), and
  `cd "W:/tmp/caseworker-integrity"; grep -n "Keep the \`primary_contact\` scalar" app/src/repos/unitsRepo.ts`
  (= M; refs `unitsRepo.ts:M`, body `unitsRepo.ts:M-(M+9)` and the stale
  comment `unitsRepo.ts:(M+1)-(M+2)`, both occurrences).

## 3. CORRECTION - Task 5.8 Step 3: the Resolution gives the contact-list add the wrong 404 code

- **Plan.** plan:14106-14109: "...and a Landlord-role contact-list add that
  claims a vacant slot refuse a contact not typed `landlord` (404
  `landlord_not_found`, 409 `landlord_not_landlord`)."
- **Tree / S4.** `POST /api/units/:id/contacts` answers a missing contact with
  its existing 404 `contact_not_found` (`app/src/routes/units.ts:1097-1099`),
  and S4 Task 4.4 keeps that read (consistent now) and its 404, adding only
  the two 409s after it (plan:10257-10282, 404 at plan:10259).
  `landlord_not_found` is unit create / PATCH only (spec section 4 table; S4
  Tasks 4.2-4.3). A resolved issue is the record future readers trust for the
  wire contract.
- **Correction.** Replace that parenthetical so the bullet reads: "...refuse a
  contact not typed `landlord` with 409 `landlord_not_landlord` (a missing
  contact is 404 `landlord_not_found` on unit create and PATCH; the
  contact-list add keeps its 404 `contact_not_found`)." Reflow to the file's
  width; ASCII.

## 4. NOTE - `stale-suggestions-survive-contact-retype` (open, low) is partly resolved by D1; the plan does not touch it

- `docs/issues/stale-suggestions-survive-contact-retype.md` (created
  2026-07-20) says the accept routes are not type-gated, so a stale tenant
  suggestion survives a re-type and can be accepted onto a non-tenant; its
  fix (a) is "type-gate the accept branches to mirror apply's eligibility".
  Neither the plan nor the spec names it (grep: no mention).
- After this branch: D1 type-gates the ACCEPT of the seven tenant-only targets
  (409 `suggestion_contact_not_tenant`, chip kept, dismiss allowed) and fences
  an accept spanning a reclassification - that is fix (a) for those targets,
  and the issue's own example (`voucherSize`) is closed. Still open:
  `address` - extraction applies it to tenants only
  (`app/src/services/extraction/apply.ts:382-384`) but D1 classifies it
  NEUTRAL by Cameron's ruling (spec section 1, I1), so a stale address
  suggestion can still be accepted onto a non-tenant; and fix (b), clearing
  pending suggestions on a type change, was not done.
- **Recommendation.** Keep it `open`; in Task 5.8 add a short ASCII
  "**Partly addressed (<date>).**" paragraph (and `updated: <date>`) stating
  the above and linking `claimed-suggestion-accept-after-caseworker-conversion`.
  It is outside spec section 7's list, so per W1 the orchestrator should
  confirm before adding it; otherwise record it in the slice report.

## 5. NOTE - `landlord-of-record-no-reassign-ui` (Task 5.9 Step 3) calls UnitCreateForm "the only dashboard writer of `landlordId`"

- plan:14282-14285. After S4 the dashboard has three writers: New property;
  the Contacts card's Landlord-role add that claims a vacant slot
  (`app/src/repos/unitsRepo.ts:823`); and the S4 restore dialog (restore with
  / without a landlord). The issue's own later sentences describe both, so it
  contradicts itself. Suggested wording: "...is picked on New property
  (`UnitCreateForm.tsx`), and no dashboard screen changes it on a live property
  afterwards" (drop "the only dashboard writer of `landlordId`").

## 6. NOTE - the restore dialog's title is bound now; two S5 texts still say it is not

- Ruling S5-2 binds the title to "Restore property" (ruling S4-8; S4 Task
  4.10 `title="Restore property"`, plan:11927). The Task 5.4 comment
  "found by its sentence (its title is S4's choice)" (plan:13383) and
  CONTRACT ISSUE 2's proposed "Restore this property" (plan:12703-12704) are
  stale. The selectors work as written (sentence filter + the dialog's only
  combobox), so no test change is needed; optionally fix the comment, and the
  5.6 "Property page (deleted)" row could name
  `getByRole('dialog', { name: 'Restore property' })` as the primary handle.

## 7. NOTE - small doc refresh options (no action required)

- Task 5.8 Edit B rewrites only the tail of the `tours-placements-no-contact-type-check`
  refs line; the line also keeps `app/src/services/statusTransition.ts:335`
  (`deriveTenantStatus`), which S3 Tasks 3.8/3.10 shift. The replacement could
  include the refreshed number (`grep -n "deriveTenantStatus" app/src/services/statusTransition.ts`).
- `import-bypasses-contact-type-rules` (Task 5.9 Step 2) could add "Related:
  `reimport-reverts-unknown-triage`" (open, low; the same importer `#type`
  write, `apply.ts:1110`).

## 8. NOTE - verified clean (for the slice report; no action)

- **5.1 seed test.** Every import exists with the used signature
  (`SEED` lean.ts:85; `castItems()` cast.ts:1493; `matrixItems(now)`
  matrix.ts:1414; `buildLiveStaticItems(now)` live.ts:103;
  `generatePerformanceSeed` / `resolvePerformanceSeedConfig(input, anchor)` /
  `PerformanceSeedInput` performance.ts:1170/249/52; `isCaseworker`
  caseworkers.ts:86; `unitContacts` / `UnitItem` unitsRepo.ts:296/140). The
  WORLDS match the seeders (seed/index.ts:110-163 full = lean + cast + matrix,
  then `seedLive` writes `buildLiveStaticItems`; `resetPerformanceData` resets
  to lean first, performanceSeed.ts:250-256). An in-memory run of the plan's
  exact checker (scratch replica, no DynamoDB) reproduces the planner's
  numbers - lean 0/1/2/2, full 17/39/60/61, both performance worlds
  50/51/15/18 - with ZERO violations and zero caseworkers in any seed (full:
  74 contacts, no partner holds a role). Both negative controls produce
  exactly the expected `toEqual` objects. The assembled final file typechecks
  under the base config (strict, noUncheckedIndexedAccess), lints clean via
  `--stdin`, and is ASCII. The stub RED is as described (6 failing).
- **Anchors.** Every find/replace block in 5.3-5.8 exists verbatim and exactly
  once (caseworkers.spec.ts tail, property-roster.spec.ts tail,
  placements-page.spec.ts import + tail, tour-auto-close.spec.ts tail,
  selectors.md:133 row end with :134 blank and :135 `## Narrow viewport`,
  RUNBOOK.md:473, the three issue files' `status: open` / last lines / refs
  tail). The four new issue files do not exist yet.
- **e2e code.** The four post-edit specs (plan edits applied to scratch
  copies) typecheck against the e2e tsconfig settings and lint clean; added
  lines are ASCII. Helpers and names match: `devLogin`, `uniquePhone`,
  `createContact`, `readContact`, `readPreview` (caseworkers);
  `devLogin`, `freshPhone`, `Party`, `createContact`, `createAvailableUnit`
  (property-roster); `devLoginAndReset`, `placementBanner` (placements-page);
  `pastAt`, `daysFromNow`, `patchTour`, `getTour`, `tourHeader`,
  `REOPEN_TO_TOURED`, `UNIT_B` (tour-auto-close). UI names match the tree and
  S2-S4: "Edit contact details" CardAction, Modal "Edit contact", "Change
  type", group "Contact kind" with Tenant/Landlord segments and aria-pressed
  (KindPicker.tsx:176-195), TypeChangeRefusalList inside the Type block
  (S2 2.6), sentences and `/placements/`, `/listings/` links (S2 2.5), the
  deleted banner `role="status"` + Restore (ListingDetail.tsx:686-693), the
  restore dialog sentence / three buttons / one combobox (S4 4.10-4.11),
  ContactSearchField options portaled and pickable inside a Modal (precedent
  contact-create.spec.ts:279-289), Reopen dialog `role="alert"` and
  "Yes, reopen" (TourModals.tsx:439-490 + S3 3.13), More actions -> Placement
  stage -> menuitemradio (PlacementDetail.tsx:827-848). Counts: caseworkers
  5+1=6, property-roster 1+3=4, tour-auto-close 3+2=5 (new describe sits
  outside the existing describe's afterEach; file-level beforeAll reseeds),
  placements-page 11+1. `fullyParallel: false`, `workers: 1`.
- **5.2 W3 sweep.** Re-ran the five greps plus wider ones (every
  `/api/units` create's landlordId source incl. `seedAvailableUnit` callers -
  all `teamCreatesLandlord`; UI "Mark as"/"Change type" flows - unknowns only;
  type PATCHes; Accepts incl. Today; dev seams in routes/dev.ts - none creates
  tours/placements/units/seats). Same sites as the plan's table, all clean.
- **Gate traps.** e2e `tsconfig.json` includes `tests/**/*.ts`; root
  `typecheck` covers app/test (tsconfig.test.json) and e2e. The eslint config
  lints e2e `.ts`. `mutationCatalog.test.ts` stays green for S4's
  `restoreUnit(unitId, opts?)`: `methodFromObject` follows the
  `...(opts !== undefined && { body })` spread's `&&` right arm, which carries
  no method, so `request:POST` holds (mutationCatalog.test.ts:112-155). The
  `viewport.guard` scan is not tripped. No test validates selectors.md,
  RUNBOOK.md or docs/issues.
- **Docs.** The RUNBOOK replacement matches spec D1-D3/L1/L2 and the code
  (tenure = "Time at current address", ContactEditForm.tsx:765; the journal
  sweep is daily, jobs/journalSweep.ts:1; `type_source: 'manual'` is stamped
  only by the PATCH override and the conversion, contacts.ts:1645,
  caseworkerConversion.ts:559). The four new issues use valid frontmatter
  (`scripts/issues.mjs` TYPES/SEVERITIES/STATUSES; id = filename), refs to
  slugs that exist (`extraction-in-flight-writes-onto-converted-caseworker`,
  `voice-business-number-roster`), no duplicates in the registry, ASCII.
  `docs/issues/INDEX.md` is gitignored (.gitignore:62).
