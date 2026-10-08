# Caseworkers conformance review - round 1

Date: 2026-10-08. Independent reviewer: GPT-6 Astra.
Worktree: W:/tmp/caseworkers, feat/caseworkers.
Reviewed HEAD: 76357a5fed86172e4645516bd16b74647fbc0cd5.
Merge base/main: d874915873a61864f6d051a0a9af3f0bb8e7e6e2.
Source gate commit: 5272f85e3c98467ffc149e7b14492ba125984401; HEAD adds only
the completion-gate record to that source.

## Verdict

REQUEST CHANGES for CF-1: concurrent ordinary PATCHes can create a caseworker
while bypassing the conversion, including its refusal of an open placement.
This is independently reproduced through the real Express routes.

Coverage: 75/75 tasks, including 7.5a and 10.8a, plus both checkpoints.
73 tasks CONFORM, 2 are PARTIAL, none are MISSING. Task 4.3 is partial because
of CF-1. Task 10.4 remains partial because its required populated-picker
batch is baseline-red. That is a separately attributed existing problem,
not a second new branch finding. C6 remains unapplied; this review makes no
scope decision about it. CONFORMS assesses a task against its approved
contract within the evidence limits below, not every possible execution.

## Contract and method

Read AGENTS.md, the Codex mission profile, workflow and glossary; spec
revision 15 D16-D22 and branch-B intersections in D6, D10 and sections 5.2,
6, 9, 10, 11 and 12; binding plan sections 0-3, slice assembly notes and all
75 task contracts; closed design/plan adjudications, planner/assembly and
rebaseline rulings, execution corrections and slice handoffs. Used the diff
package as an inventory and inspected live producers, consumers and focused
test bodies. The parallel adversarial review was not read.

Independently checked corrections against source: C1 preserves post-commit
ERROR reporting; C2 carries eligible raw organization text; C3 excludes
self-links; C4 guards stale contact/dialog callbacks; C5 fits the choices at
phone width. O1 names the actual server allowlist; O2 correctly distinguishes
an explicit type PATCH from an edit-form type change. Their earlier
acceptance was not treated as implementation proof.

Selected lane: independent assessment within the authorized feature mission.
Checks: source/contracts, meaningful assertions, parent gate records, and a
focused local race probe. No production source, aggregate/browser suite,
live app port, main sync, infrastructure, deployment or environment was
changed. No staging or commit. Raw material stays in
.superpowers/review/conformance/; this artifact contains assessment only.

## CF-1 - P1 - Concurrent partial PATCHes bypass the sole conversion action

**Contract:** Spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md:646`
and `:660` require existing contacts to become caseworkers only through the
conversion; even Partner-then-Caseworker edits cannot bypass its refusals and
writes. Plan `docs/superpowers/plans/2026-10-07-caseworkers.md:121` and `:391`
repeat this. The accepted lack of refusal checks for generic changes to
other kinds does not waive the new conversion-only invariant.

**Fault:** `app/src/routes/contacts.ts:1522` reads classification consistently
and `:1615` checks the merged type/role, but `:1743` writes with only the
optional staff-notes expectation. The checked classification is not fenced.
Two individually allowed partial updates can compose into partner/Caseworker
without the removal record, cleanup or refusal checks. The conversion's own
revision fence cannot protect a path that never calls it.

**Explicit reproduced interleaving:** Start with a live tenant with no role,
an open rta placement, and housing-authority/agency values. A conversion
request first returns 409 caseworker_open_placement for this very contact.

1. PATCH A sends `{type:'partner'}`, reads the tenant with no role, passes
   the merged-kind check, then pauses immediately before contacts.update.
2. PATCH B sends `{role:'Caseworker'}`, independently reads the tenant,
   passes because its merged type remains tenant, and commits.
3. A resumes its unconditional type update. Both HTTP responses are 200.
4. The final row is partner/Caseworker, classification_revision 2, with the
   original authority/agency and no caseworker_conversion. The blocking
   placement is unchanged.

**Empirical proof:** The deterministic probe completed twice; the retained
run has exit 0 and records the refusal, both 200s, unguarded write arguments
and final incorrect row:

- `.superpowers/review/conformance/patch-interleaving.mts`
- `.superpowers/review/conformance/patch-interleaving.out.txt`
- `.superpowers/review/conformance/patch-interleaving.exit.txt`

It runs via node --import tsx with a 20-second probe timer, actual contacts
and caseworker-review Express routes, and supertest's ephemeral server.
The FakeWorld getById wrapper returns independent structured clones, so its
usual shared object references cannot mask a real database interleaving.
Production expectation assembly at `app/src/repos/contactsRepo.ts:1541`
only adds supplied expectations, matching the probe's guardless writes.
No DynamoDB data or live app port was used. The sequential cases at
`app/test/contactTriage.test.ts:727` and consistent-read assertion at `:775`
do not exercise this concurrent composition.

**Narrow fix:** Condition classification-changing PATCHes on the raw
classification revision they checked, composing that expectation with the
staff-notes guard. On a lost condition, reread/re-evaluate or return a conflict
before side effects. Preserve absent revision versus stored zero and existing
other-kind behavior. Add a two-request regression using independent snapshots
and this schedule; assert it cannot create a caseworker or bypass a refusal.
Also cover staff-notes guard composition. General refusal checks for every
contact retype are not required for this fix.

## Complete task map

Citations identify the reviewed source and meaningful supporting assertions.
Tests are additional evidence, not substitutes for implementation inspection.
Browser/gate outcomes are the parent's completed hermetic runs; this reviewer
did not start a competing lane. All abbreviated same-cell filenames retain
the immediately preceding directory; colon-only references retain its file.

### S1 - matching rules (4)

| Task | Status | Evidence |
| --- | --- | --- |
| 1.1 | CONFORMS | `app/src/lib/caseworkers.ts:34` owns the constant; `app/src/services/extraction/contactKinds.ts:25` accepts only the exact partner preset. `app/test/contactKinds.test.ts:24`, `:43` pin acceptance and whitespace rejection. |
| 1.2 | CONFORMS | `app/src/lib/caseworkers.ts:52`, `:62`, `:75`, `:86` separate normalized role, wider mentions, prefixed AI note and partner identity. `app/test/caseworkers.test.ts:44`, `:75`, `:106` cover different boundaries. |
| 1.3 | CONFORMS | `app/src/lib/orgNames.ts:20` extends OrgField and maps organization to both kinds; consumption at `app/src/services/caseworkerConversion.ts:336` validates requested organization accordingly. |
| 1.4 | CONFORMS | `dashboard/src/routes/contact/caseworkerRole.ts:17` mirrors the leaf rules. `caseworkerRoleMirror.test.ts:28`, `:62`, `:70` compare varied resolved answers against the app and prevent constant-answer agreement. |

### S2 - repositories and fakes (5)

| Task | Status | Evidence |
| --- | --- | --- |
| 2.1 | CONFORMS | `app/src/repos/contactsRepo.ts:89`, `:296`, `:659`, `:1508`, `:1541` provide fields, numeric/raw multi-expectations, no-op checks and notDeleted. Fake guards: `app/test/helpers/twilioWebhookHarness.ts:2406`; real/fake parity: `app/test/caseworkerRepoParity.integration.test.ts:180`, `:248`, `:258`. |
| 2.2 | CONFORMS | `app/src/repos/contactsRepo.ts:1178`, `:1261` query all holder pages, resolve pointers, exclude deleted/dangling records and deduplicate phone/email holders. `app/test/caseworkerRepoParity.integration.test.ts:319`, `:365` exercise both keys. |
| 2.3 | CONFORMS | `app/src/repos/contactsRepo.ts:353`, `:1011`, `:1284` add a separate recipient projection. `app/test/caseworkerRepoParity.integration.test.ts:377`, `:416` prove recipient metadata and the original narrow display API separately. |
| 2.4 | CONFORMS | `app/src/repos/conversationsRepo.ts:1586` conditionally retypes the expected type and returns the updated row. `app/test/caseworkerRepoParity.integration.test.ts:424`, `:445`, `:455`, `:466` cover update, skip, null name and type-less rows. |
| 2.5 | CONFORMS | `app/src/repos/unitsRepo.ts:335`, `:493`, `:1026` implement deleted:any in query/scan; fake paging is `app/test/helpers/twilioWebhookHarness.ts:3000`. `app/test/caseworkerRepoParity.integration.test.ts:511`, `:518`, `:542` cover no-limit, cursors and landlord lookup. |

### S3 - services (8)

| Task | Status | Evidence |
| --- | --- | --- |
| 3.1 | CONFORMS | `app/src/services/contactClassification.ts:62`, `:105` retain identity-conditional deletion, revision ordering and verdicts; PATCH uses them at `app/src/routes/contacts.ts:1769`. `app/test/contactClassification.test.ts:90`, `:116` assert accepted and post-revision behavior. C1 is optional for ordinary callers. |
| 3.2 | CONFORMS | `app/src/services/caseworkerConversion.ts:195`, `:217`, `:471` enforce domain, all refusals and read-only preview, with deleted-unit paging. `app/test/caseworkerConversion.test.ts:147`, `:169`, `:237`, `:265` test these boundaries. |
| 3.3 | CONFORMS | `app/src/services/caseworkerConversion.ts:274` keeps stored organization, then derives agency before authority, resolves both lists and carries eligible raw text. `app/test/caseworkerConversion.test.ts:278`, `:324` cover derivation and C2 raw carry. |
| 3.4 | CONFORMS | `app/src/services/caseworkerConversion.ts:298`, `:323` check every contact address and other live holders; closed/group/already-partner threads are excluded and shared/type-less counts differ. `app/test/caseworkerConversion.test.ts:356`, `:394`, `:405` exercise these cases. |
| 3.5 | CONFORMS | `app/src/services/caseworkerConversion.ts:530`, `:541`, `:552`, `:566`, `:576` perform one fenced classification/cleanup/record commit. `app/test/caseworkerConversion.test.ts:424` asserts exact guards/final fields; `:530`, `:588` test conflicts and raw values. |
| 3.6 | CONFORMS | `app/src/services/caseworkerConversion.ts:356`, `:387`, `:410`, `:426`, `:521` implement suggestion/thread cleanup, events/audit/vocabulary and repair without rewriting the contact, logging post-commit failures. `app/test/caseworkerConversion.test.ts:639`, `:682`, `:704`, `:827`, `:854` assert effects and returned-row events. No-new-milestone repair is explicitly planned. |
| 3.7 | CONFORMS | `app/src/services/caseworkerConversion.ts:594` limits dismissal, guards deletion, avoids a revision bump and audits. `app/test/caseworkerConversion.test.ts:929`, `:943`, `:966` cover successful/refused/racing deletion cases. |
| 3.8 | CONFORMS | `app/src/services/possibleCaseworkers.ts:24`, `:55`, `:61`, `:79`, `:97` exhaust three partitions, apply signal/base boundaries, exclusions and sorting. `app/test/possibleCaseworkers.test.ts:33`, `:64`, `:86`, `:114`, `:156` exercise positive/negative signals, paging and C3 self-link exclusion. |

### S4 - routes and import (5)

| Task | Status | Evidence |
| --- | --- | --- |
| 4.1 | CONFORMS | `app/src/routes/contacts.ts:297`, `:531` reject all three server-owned keys through both parsers, including null/false values, while new contacts can still use the preset. |
| 4.2 | CONFORMS | `app/src/routes/contacts.ts:672`, `:1518`, `:1654` parse/clear organization and apply D5 against both lists, consistently reading unchanged values. `app/test/contactOrgNames.test.ts:181` covers PATCH and `:157` asserts POST ignores organization. |
| 4.3 | PARTIAL | `app/src/routes/contacts.ts:1522`, `:1615`, `:1631` implement sequential merged-kind rejection, consistent reads and manual-source stamping. The update at `:1743` does not fence the checked classification. CF-1 empirically proves the concurrent bypass. |
| 4.4 | CONFORMS | `app/src/routes/caseworkerReview.ts:36`, `:59`, `:64`, `:74` provide strict bodies, responses and session actor; `app/src/routes/contacts.ts:1008`, `:1186` share dependencies and register before dynamic-ID routes. `app/test/caseworkerReviewApi.test.ts:85`, `:145`, `:170` assert conversion, invalid bodies and auth. |
| 4.5 | CONFORMS | `app/src/lib/import/apply.ts:1058`, `:1085`, `:1106`, `:1147` preserve manual type/status/authority/agency. `app/test/importApply.integration.test.ts:403` checks actual stored results. The approved importer read/write race remains documented. |

### S5 - organization server (7)

| Task | Status | Evidence |
| --- | --- | --- |
| 5.1 | CONFORMS | `app/src/repos/contactsRepo.ts:1839`, `:1858`, `:1878` guard and SET/REMOVE organization while refusing blank SETs. `app/test/orgRecordWriters.integration.test.ts:135`, `:167` test real/fake set, remove, conflict and absent expectations. |
| 5.2 | CONFORMS | `app/src/services/orgRecords.ts:200`, `:329`, `:396` append organization last for either kind and implement its rewrite/clear pass. `app/test/orgRewriteService.test.ts:73` and `app/test/orgRewriteJob.test.ts:109` assert field order and aggregate pass counts. |
| 5.3 | CONFORMS | `app/src/services/orgRecords.ts:450` computes organization columns and distinct inUse/kindLocked totals; `app/src/routes/organizations.ts:117` selects the refusal mode. `app/test/orgRecords.test.ts:62` proves distinct records and organization-only kind freedom; `app/test/organizationsApi.test.ts:572` exercises HTTP refusals. |
| 5.4 | CONFORMS | `app/src/services/orgRecords.ts:534` enumerates off-list organization over both kinds and its holders; `app/src/routes/organizations.ts:61` accepts the field. `app/test/orgRecords.test.ts:131`, `:249` and `app/test/organizationsApi.test.ts:122` assert rows/record expansion. |
| 5.5 | CONFORMS | `app/src/services/orgRewrite.ts:184`, `:219`, `:453` use both kinds for organization revalidation, require kind only for Add and refuse Move/Split. `app/test/orgRewriteService.test.ts:394` asserts both outcomes; `:229`, `:717` cover lapsed claim and Run again. |
| 5.6 | CONFORMS | `app/src/routes/organizations.ts:175` validates exactly one of kind/kinds, a nonempty unique allowed subset; `app/src/services/orgNames.ts:263` resolves across it. `app/test/organizationsApi.test.ts:181` exercises the route. |
| 5.7 | CONFORMS | `app/src/routes/dev.ts:1226` expands the existing hermetic fixture seam. `app/test/devOrgFixture.test.ts:59` asserts stored raw organization. `e2e/README.md:602` documents it; `e2e/tests/dashboard-next/org-lists.spec.ts:876` uses it on test-owned contacts. |

### S6 - share server (5) and checkpoint

| Task | Status | Evidence |
| --- | --- | --- |
| 6.1 | CONFORMS | `app/src/routes/broadcasts.ts:347`, `:446`, `:845`, `:880` admit tenant/partner seeds and explicit recipients with other fences intact; `app/src/services/audienceResolution.ts:148` keeps filter audiences tenant-only. `app/test/broadcastApi.test.ts:2351`, `:2387`, `:2404`, `:2419` distinguish these paths. |
| 6.2 | CONFORMS | `app/src/routes/broadcasts.ts:460` emits voucher facts only for tenants, excluding residual tenant facts from partner candidates. The real candidate construction is exercised at `app/test/broadcastApi.test.ts:2351`. |
| 6.3 | CONFORMS | Both mint sites, `app/src/jobs/broadcastFanOut.ts:875` and `:1396`, use conversationTypeFor(contact), preserving existing threads. `app/test/broadcastFanOut.test.ts:320`, `:335` separately assert existing-thread reuse and reconcile adoption's partner thread. |
| 6.4 | CONFORMS | `app/src/routes/units.ts:151`, `:1028`, `:1041` use recipient projection, trim role and omit unresolved metadata; `app/src/repos/listingSendsRepo.ts:117`, `:180` extend wire rows without changing persisted tenantName. `app/test/listingSendsApi.test.ts:409` checks returned type/role. |
| 6.5 | CONFORMS | `app/src/routes/contactTimeline.ts:695`, `:706`, `:773` distinguish recounted zero from stored counts and preserve the Sent to prefix used at `:1461`, matching the binding assembly wording rule. |
| Checkpoint after S6 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S6.md:9` records bare typecheck 0 and npm test 0 across all workspaces: 734 files/14242 passed, one optional built-dashboard diagnostic skip, no skipped DynamoDB suite. Verification-only boundary, not rerun here. |

### S7 - organization dashboard (7)

| Task | Status | Evidence |
| --- | --- | --- |
| 7.1 | CONFORMS | `dashboard/src/api/types.ts:3513`, `:3557`, `:3705` mirror field/totals/resolve bodies; `dashboard/src/api/endpoints.ts:2957` sends kind or kinds. `dashboard/src/routes/orgs/orgCopy.ts:29`, `:48`, `:405`, `:632`, `:667` centralize both-list wording, field routing, no-Split errors and distinct totals. |
| 7.2 | CONFORMS | `dashboard/src/routes/orgs/OrgPicker.tsx:243` names the both-list Add action organization while preserving single-kind wording. Conversion and partner edit forms use this picker. |
| 7.3 | CONFORMS | `dashboard/src/routes/orgs/NewOrgDialog.tsx:103`, `:117`, `:144`, `:159`, `:247` check both lists and disable Add until explicit kind selection; `dashboard/src/routes/orgs/OrgKindChoice.tsx:21` has unselected radios. No organization Move/Split is offered. |
| 7.4 | CONFORMS | `dashboard/src/routes/settings/OrgListPane.tsx:157`, `OrgDetailPanel.tsx:126`, `OrgEntryDialogs.tsx:107`, `:452`, `:512` consume distinct counts/refusals and explain organization-only kind changes. `dashboard/src/routes/orgs/orgCopy.ts:644` uses inUse.deleted instead of column sums. |
| 7.5 | CONFORMS | `dashboard/src/routes/settings/NotOnListSection.tsx:71`, `:262`, `:367`, `:379`, `:459` offer both-kind Use, explicit-kind Add and Clear for organization, retaining field-specific Move/Split elsewhere. `e2e/tests/dashboard-next/org-lists.spec.ts:887` asserts disabled/unselected Add and stored rewrites. |
| 7.5a | CONFORMS | `dashboard/src/routes/settings/orgSelection.ts:49` includes organization in the URL allowlist. `e2e/tests/dashboard-next/org-lists.spec.ts:889` opens its URL-addressed panel and confirms the Organization fact. |
| 7.6 | CONFORMS | `dashboard/src/routes/contact/ContactEditForm.tsx:149`, `:229`, `:515`, `:1021` route answers/errors by originating field and select the right Add mode. `dashboard/src/routes/orgs/orgCopy.ts:57` keeps organization answers in organization. |

S7's focused regression record at
`docs/superpowers/reviews/2026-10-07-caseworkers/S7-report.md:133` contains
12 files/336 passing tests. The source checks additionally traced values
through wire types, field setters, dialogs and totals rather than treating
that suite count as sufficient evidence by itself.

### S8 - contact dashboard (13)

| Task | Status | Evidence |
| --- | --- | --- |
| 8.1 | CONFORMS | `dashboard/src/api/types.ts:2344`, `:2359`, `:2363`, `:2372` define conversion/possible/preview responses; `dashboard/src/api/endpoints.ts:1475`, `:1489`, `:1501`, `:1514` implement four endpoints. `e2e/performance/mutationCatalog.ts:142` inventories both writes; `mutationCatalog.test.ts:364` checks all 120 raw mutations/fingerprints. |
| 8.2 | CONFORMS | `dashboard/src/routes/contact/KindPicker.tsx:84`, `:94`, `:134`, `:154`, `:211` gate the exact preset, filter wider suggestions and replace the placeholder. C5's grid is `KindPicker.module.css:55`; `e2e/tests/dashboard-next/contact-create.spec.ts:177` measures/clicks all choices at 375px. |
| 8.3 | CONFORMS | `dashboard/src/routes/contact/CaseworkerDialog.tsx:186`, `:209`, `:220`, `:241`, `:249`, `:327` implement preview/refusals, typed settlement, changed-only organization, conflict reload and already-caseworker repair. `e2e/tests/dashboard-next/caseworkers.spec.ts:258` exercises the real dialog and resulting conversion. |
| 8.4 | CONFORMS | `dashboard/src/routes/contact/ContactCreateForm.tsx:258` offers the preset without organization. `e2e/tests/dashboard-next/contact-create.spec.ts:213`, `:231` assert absent inputs and stored partner/Caseworker. |
| 8.5 | CONFORMS | `dashboard/src/routes/contact/ContactEditForm.tsx:416`, `:433`, `:515`, `:586`, `:711` gate by stored caseworker identity, settle partner organization and handle conversion-required/org errors. Unchanged off-list organization is omitted on unrelated saves. Server concurrency remains the separate 4.3 failure. |
| 8.6 | CONFORMS | `dashboard/src/routes/contact/UnknownFile.tsx:128` inserts Mark as Caseworker after Partner and calls the dialog callback without PATCHing. `e2e/tests/dashboard-next/caseworkers.spec.ts:474` uses it. |
| 8.7 | CONFORMS | `dashboard/src/routes/contact/ContactActionsMenu.tsx:183` conditionally offers Make caseworker, closes the menu and calls the host; 8.8 owns eligibility. |
| 8.8 | CONFORMS | `dashboard/src/routes/contact/ContactDetail.tsx:678`, `:689`, `:984`, `:1167`, `:1230`, `:1380` connect eligibility, dialog refresh and type-specific header facts. C4's generation check prevents A's completion from closing/refetching B. |
| 8.9 | CONFORMS | `dashboard/src/routes/contact/PartnerFile.tsx:112`, `:125` display role/organization and retained staff notes, hiding obsolete tenant facts. `docs/issues/staff-notes-on-landlord-partner-files.md:38` closes only the partner half. |
| 8.10 | CONFORMS | `dashboard/src/routes/contacts/FilterChips.tsx:21`, `:81` move shared ChipGroup/Chip behavior including zero-count semantics; `dashboard/src/routes/contacts/TenantFilters.tsx:10` imports it. The tenant filter algorithm is preserved. |
| 8.11 | CONFORMS | `dashboard/src/routes/contacts/ContactsList.tsx:40`, `:53`, `:64`, `:274` add/share the link in the intended order; `dashboard/src/routes/contacts/CaseworkersList.tsx:198` uses the same tabs. |
| 8.12 | CONFORMS | `dashboard/src/routes/contacts/CaseworkersList.tsx:81`, `:97`, `:150`, `:172`, `:222`, `:257`, `:305` load/filter rows, manage organization URL selections, render signals and reload after make/dismiss. `e2e/tests/dashboard-next/caseworkers.spec.ts:405`, `:414`, `:432` prove signals, conversion and persistent dismissal. |
| 8.13 | CONFORMS | `dashboard/src/app/nav.ts:71`, `dashboard/src/App.tsx:66`, `:159` wire route/link and partner dot. `e2e/performance/routes.ts:664`, `routes.test.ts:403` record/exercise profiler exclusion; `e2e/tests/dashboard-next/frame.spec.ts:26` expects the nav item. |

### S9 - share dashboard (6) and checkpoint

| Task | Status | Evidence |
| --- | --- | --- |
| 9.1 | CONFORMS | `dashboard/src/routes/listing/ListingDetail.tsx:1026`, `:1030` and `ListingActionsMenu.tsx:107` use Sent to and Send this property with existing destinations intact. |
| 9.2 | CONFORMS | `dashboard/src/routes/listing/listingFormat.ts:243` labels resolved non-tenants by displayKind; `dashboard/src/routes/contact/Card.tsx:221`, `:238` render kind outside the identity link. `e2e/tests/dashboard-next/partner-share.spec.ts:192` asserts Caseworker on the delivered recipient row. |
| 9.3 | CONFORMS | `dashboard/src/routes/listing/listingFormat.ts:183` supplies neutral singular/plural and No recipients reached for zero. Server stored-label/recount distinctions are checked separately in 6.5. |
| 9.4 | CONFORMS | `dashboard/src/routes/broadcasts/RecipientPreview.tsx:294`, `:364`, `:393`, `:530` and `AudienceFilters.tsx:182` use recipients in review/reach surfaces, retaining tenant-only search/filter wording. |
| 9.5 | CONFORMS | `dashboard/src/routes/broadcasts/BroadcastsList.tsx:91`, `:132`, `broadcastFormat.ts:72`, `BroadcastResults.tsx:58` update list/results and unresolved Recipient fallback; persisted tenant keys remain unchanged. |
| 9.6 | CONFORMS | `dashboard/src/routes/contact/PartnerFile.tsx:151` renders Properties sent without tour chips; `ContactDetail.tsx:1133` supplies existing loaded slices/seed navigation. `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:71`, `:93`, `:177` resolve the partner seed while search stays tenant-only. `e2e/tests/dashboard-next/partner-share.spec.ts:116` proves the full path. |
| Checkpoint after S9 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S9.md:9` records bare typecheck 0 and npm test 0 across all workspaces: 738 files/14359 passed and one optional staticSmoke diagnostic skip. This required checkpoint is independently accounted for, not inferred from final gates. |

### S10 - verification, browser coverage and records (15)

| Task | Status | Evidence |
| --- | --- | --- |
| 10.1 | CONFORMS | Verification-only. `e2e/performance/routes.test.ts:403`, `mutationCatalog.test.ts:364` assert registry/fingerprint completeness, not just counts. `docs/superpowers/reviews/2026-10-07-caseworkers/S10-report.md:10` records unchanged pins and 30 focused/503 e2e-unit tests passing. No duplicate edit/issue or RED was required. |
| 10.2 | CONFORMS | `e2e/tests/dashboard-next/frame.spec.ts:26` pins nav; `contact-create.spec.ts:177`, `:201`, `:231` assert six buttons fit/click at 375px and store the preset. `docs/superpowers/reviews/2026-10-07-caseworkers/C5-responsive-fix.md:1` records measured red geometry and green unchanged strict assertions. |
| 10.3 | CONFORMS | Verification of S5-owned pins: `e2e/tests/dashboard-next/org-lists.spec.ts:623` includes organization/distinct totals; `e2e/README.md:602` documents the fixture field used at `org-lists.spec.ts:876`. The fixture types compile in the bare gate. No duplicate edit was needed. |
| 10.4 | PARTIAL | Wording pins conform, but the required batch failed at `e2e/tests/dashboard-next/matching-entry-points.spec.ts:228` for a below-viewport existing picker option. `docs/superpowers/reviews/2026-10-07-caseworkers/S10-report.md:114`, `:191` record reproduction and detached-baseline attribution. Full-suite green does not replace this focused failure; C6 remains unapplied. |
| 10.5 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:228`, `:258`, `:284` create a unique tenant, exercise preview/dialog and verify stored cleanup/manual record/thread type; `:313` uses seeded placement/landlord contacts only for GET preview and Cancel. No refusal fixture is converted or dismissed. |
| 10.6 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:405`, `:414`, `:432` assert test-owned signal rows, convert one, dismiss another and confirm stored dismissal after reload. Negative fixtures distinguish staff notes and unprefixed text from AI notes. |
| 10.7 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:451`, `:469`, `:474`, `:482`, `:494` use unique inbound unknown/exact-phone lookup, actual dialog, stored partner/manual record and cleared suggestion. `app/test/caseworkerConversion.test.ts:655` separately proves accepted versus superseded verdicts. |
| 10.8 | CONFORMS | `e2e/tests/dashboard-next/partner-share.spec.ts:62`, `:81`, `:116`, `:157`, `:168`, `:175` use a fresh consented partner/property, asserting exactly one provider outbound, partner thread and persisted listing send. Thread inspection occurs only AFTER send, avoiding false proof from a pre-open mint. |
| 10.8a | CONFORMS | `e2e/tests/dashboard-next/org-lists.spec.ts:861`, `:884`, `:893`, `:901`, `:909` assert unique Organization values, initially disabled Add/unselected Kind, stored explicit-kind Add and agency Use. Rewrites are awaited without global count/empty assumptions. |
| 10.9 | CONFORMS | `e2e/support/selectors.md:119`, `:120`, `:121`, `:128`, `:131` document actual conversion/preset/share/organization controls and isolation. Settings references match merged link/panel behavior and organization URL selection. |
| 10.10 | CONFORMS | `documentation/GLOSSARY.md:345`, `:373` define caseworker/organization, distinguishing contact.caseworker, contact type and organization list. `:340` cross-references off-list settlement; Matching/partner references are updated. |
| 10.11 | CONFORMS | `RUNBOOK.md:450` documents deploy needs, one-write conversion, repair, restoration, unfenced extraction and cleanup boundaries. Adjacent walkthrough correction is recorded at `docs/superpowers/reviews/2026-10-07-caseworkers/S10-report.md:338` and matches actual controls. These are instructions, not claims that live repairs ran. |
| 10.12 | CONFORMS | All six follow-ups exist: `docs/issues/contact-retype-skips-caseworker-refusals.md:12`, `tours-placements-no-contact-type-check.md:12`, `extraction-in-flight-writes-onto-converted-caseworker.md:12`, `imported-unknown-threads-surface-as-unknown-on-today.md:12`, `a2p-campaign-covers-caseworker-shares.md:12`, `possible-caseworkers-and-roster-refusal-scans.md:12`. `staff-notes-on-landlord-partner-files.md:38` preserves the unbuilt half. O2's explicit type-PATCH wording matches source. |
| 10.13 | CONFORMS | Verification-only: `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S10-full.md:10` records the distinct pre-sync full run: exit 0, 337 passed; `:24` retains the 10.4 limit. No reviewer rerun was appropriate. |
| 10.14 | CONFORMS | Verification-only: `docs/superpowers/reviews/2026-10-07-caseworkers/completion-gates-r1.md:4`, `:12` identify the one final sync, unchanged source and five bare gate results. Live HEAD matches this provenance. No additional sync/aggregate suite was started during independent review. |

## Verification limits and disposition

Parent gate evidence: typecheck exit 0; npm test exit 0, 738 files/14359
passing tests and one optional built-dashboard identity skip; smoke exit 0,
1649 imports across 286 emitted files; e2e exit 0, 337 passed with no skipped
or flaky cases; scoped lint raw exit 1, but zero new errors by same-path
baseline comparison. Existing react-hooks/set-state-in-effect errors are
BroadcastComposer.tsx:204/229/248/263 and ContactsList.tsx:184 (main:148).
These are not new findings. No DynamoDB suite skipped or fault marker appeared.

This reviewer did not rerun parent gates, claim a new live self-QA pass, use
C6's proposed code, or broaden approved scope. CF-1 is independently proved
by the retained probe; the task map also inspects integration behavior and
meaningful assertions. Parent adjudication, a fix/regression for CF-1, and
remaining mission handback work follow. All owned experiment processes have
completed. This report remains unstaged for the parent's required commit.
