# Caseworkers conformance review - round 2

Date: 2026-10-08. Independent reviewer: GPT-6 (Codex), with three read-only
source audits divided across S1-S4, S5-S7, and S8-S10.
Worktree: W:/tmp/caseworkers. Branch: feat/caseworkers.
Reviewed HEAD: 2113c2814182b04ec9a9f7727efad8d585bca838.
Comparison base / current main: d874915873a61864f6d051a0a9af3f0bb8e7e6e2.
Last implementation: e0da8da38313e9f494d56bbbc96b8a3def720015.
The review record commit advances only documentation on the feature branch.

## Verdict

QUALIFIED PASS. The independent conformance review is COMPLETE.

All 75 tasks, including 7.5a and 10.8a, and both checkpoints are accounted
for below: 74 tasks CONFORM, Task 10.4 is PARTIAL with a justified scope
deviation, and both checkpoints CONFORM. No new must-fix implementation
defect was found. CF-1 / Task 4.3 is independently CLOSED.

Task 10.4's required populated-picker batch remains baseline-red. It prevents
an unqualified claim that every planned verification is green. Leaving its
tested C6 proposal unapplied respects the user's scope boundary; this review
does not authorize applying it. R2-ADV-1 remains a new parent-deferred P2/med
risk for the human merge decision. The earlier blank-document browser failure
also remains unexplained. Their evidence limits and exact missing proof are
preserved below. Completion of this review does not resolve those issues.

## Scope, independence, and method

The governing contract is spec revision 15,
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`:
Branch B D16-D22, its D6/D10 intersections, and sections 5.2, 6, 9, 10, 11,
and 12. The approved plan is
`docs/superpowers/plans/2026-10-07-caseworkers.md`: all 75 tasks, sections
0-3, and the binding S8/S9/S10 assembly notes. Branch A was reviewed only
where Branch B intersects its merged contracts.

Read AGENTS.md, the requested Claude overlay, and the relevant workflow
requirements. Selected lane: independent assessment at the feature-review
stage, with the user's explicit saved-evidence-first and no-product-edit
boundaries. Source, test assertions, Git state, raw saved command metadata,
exit markers, and reports were inspected. No new suite, service, browser
session, runtime interleaving probe, deployment, sync, branch switch, or
product edit was performed. The two saved QA screenshots viewed in this
review were the 375px conversion dialog and desktop Sent to card.

Git verified the supplied HEAD and base, a clean entry status, no MERGE_HEAD,
and zero commits in HEAD..main. The process check found no node/bash/cmd
command naming this worktree. The comparison contains 220 paths before this
record; later commits after e0da8da3 change only review/issue Markdown.
Thus app, dashboard, e2e, scripts, dependencies, and other runtime inputs are
unchanged from the implementation to which FINAL2 evidence applies.
No dependency manifest, lockfile, or infrastructure delta was found in the
relevant comparison. Existing records, including the interrupted R1 report
and unexecuted earlier R2 continuation, are preserved.

The prior handback was treated as a set of claims to verify. Three independent
read-only audits checked the task groups against current producers, consumers,
test assertions, and binding assembly instructions. This reviewer separately
traced the PATCH fix through the real and fake repository, the journal risk
through claim/commit/recovery, and the saved verification provenance. Static
agreement and retained test execution are distinguished throughout.

## Findings and explicit reassessments

### CF-1 / Task 4.3 - P1 in R1, CLOSED

Requirement: spec D16 at lines 646-670 and plan section 3.5 at line 391 require
the merged result of an ordinary PATCH to refuse creation of a caseworker.
The generic other-kind retype deferral does not waive this requirement.

Current source:

- `app/src/routes/contacts.ts:1522` identifies every type/role PATCH and reads
  consistently. At `:1531` it captures the raw classification revision as a
  primitive. Nullish absence becomes the absent-attribute condition; numeric
  zero remains zero. The merged-kind refusal remains at `:1621`.
- At `app/src/routes/contacts.ts:1742` and `:1746`, the classification and optional
  staff-note expectations are ANDed into the same update at `:1753`.
  `app/src/repos/contactsRepo.ts:1501` increments the revision in that very
  UpdateCommand; `:1551` constructs every expectation. An absent guard uses
  attribute_not_exists, while zero is a numeric equality at `:1557`.
- `app/test/helpers/twilioWebhookHarness.ts:2413` evaluates every guard before
  mutating any field, and `:2427` bumps classification. The relevant real/fake
  behavior already existed; this fix needed no fake/interface change.
- A failed condition consistently rereads at `app/src/routes/contacts.ts:1765`. Disappearance
  returns 404 at `:1777`; classification-only staleness returns contact_changed.
  A stale supplied note stamp takes staff_notes_stale precedence at `:1767`.
  Note-only conflict behavior and ordinary soft-deleted edits are preserved.
  This generic route intentionally does not adopt conversion's notDeleted rule.
- Both rejection returns precede suggestion deletion/verdict work at `:1783`,
  the guarded type drain at `:1814`, events at `:1823`, and the later
  conversation/audit/vocabulary pipeline. Prewrite suggestion reads do not
  create those post-write effects.

Proof was checked rather than inferred from another reviewer's closure.
`app/test/contactTriage.test.ts:728` clones independent read snapshots.
The four schedules at `:742` hold both requests before either commits, cover
both type-first/role-first orderings and absent/zero initial revision, and first
prove the dedicated conversion refuses the same open placement. At `:798`,
the loser must return 409, preserve the winner and pending suggestion, and
produce no deletion/verdict/event/audit/conversation effects. Its retry reaches
caseworker_use_conversion at `:813`. Raw absent-to-zero and zero-to-absent
transitions are pinned at `:825`; a newly converted current row,
disappearance, and unchanged deleted semantics are covered at `:844`,
`:860`, and `:875`.

`app/test/contactStaffNotes.test.ts:130` covers both absent/held note stamps
and all four combinations of classification/note staleness. The assertions
at `:172` prove whole-write rejection. Combined disappearance is at `:190`;
an unaffected note-only write alongside classification is at `:205`.

Inspected saved exact-fixture evidence under `.superpowers/sdd/checkpoints/`:

| Evidence | Exit | Observed saved result |
| --- | --- | --- |
| FW1-red-final | 1 | 9 failed, 77 passed; rejected-write assertions received 200 on the old route |
| FW1-green-final | 0 | 230 passed in 5 files, including 44 real/fake repository parity cases |
| FW1-typecheck-final | 0 | Workspace typechecks completed |
| FW1-lint-final | 0 | Three changed source/test files had no lint errors |

The replay helper `.superpowers/sdd/fix-wave-1/replay-red.mjs` uses the
pre-fix b8dcd649 route with the final tests and restores the guarded bytes in
finally. Its purpose and saved results support exact-fixture RED/GREEN
comparison; it was read, not executed in this review. FINAL2 also includes
the committed tests. This closes the specific PATCH race. It does not close
the separately accepted importer read/write race or in-flight extraction limit.

### C6 / Task 10.4 - P2/med baseline defect, PARTIAL task

Requirement: Task 10.4 at plan line 17835 verifies the moved sharing-wording
pins with the named browser batch. The wording is implemented, but that
required batch is not green on committed source.

`dashboard/src/routes/contact/ContactSearchField.tsx:120` places the portal
below the input and `:135` retains the 9rem height floor.
`dashboard/src/routes/contact/ContactSearchField.module.css:64` makes it fixed-position. The failing
ordinary pointer click is
`e2e/tests/dashboard-next/matching-entry-points.spec.ts:228`.
The current picker and test remain unchanged by C6.

The preserved true baseline comparison is against 1861e154, the baseline
used during S10, rather than the final synced base d8749158:
`docs/superpowers/reviews/2026-10-07-caseworkers/S10-recipient-picker-baseline.md:33` records feature and true baseline
6-pass/1-fail runs with identical 1280x720 geometry (top 722.797). The larger
required batch recorded 12 passes/1 failure. The mislabeled feature-only
"baseline" run is expressly excluded in that record. The saved proposed
fix instead passed 13/13, but `docs/superpowers/reviews/2026-10-07-caseworkers/C6-picker-proposal.md:3` and `:19` state
it was restored and remains an unapplied patch.

Disposition: retain PARTIAL / justified scope deviation. This is an existing
product defect, not a newly attributed Caseworkers regression or a timing
excuse. The user has not authorized the shared-control scope expansion.
Neither the proposal's green run nor the final 337/337 suite changes the
committed batch's red result. To close this task completely requires a
separately authorized correction and the same populated-picker batch passing
on committed code, followed by the affected required checks.
Issue: `docs/issues/contact-search-popover-below-viewport.md:12`.

### R2-ADV-1 - P2/med, open parent-deferred risk

Requirement boundary: spec D19 lines 792-818 makes authority removal part of
the guarded contact commit and then supersedes pending suggestions; lines
827-838 define make-again as steps 2-4 only. Plan section 3.4 lines 348-368
states the same bounded protocol. No global prohibition on later authority
writes to partners, or atomic transaction with every claimed journal, is
specified.

The source-derived schedule is valid:

1. `app/src/services/suggestionResolution.ts:328` builds an authority
   acceptance. `:194` and `:341` guard only the patched authority and
   provenance attributes, without the originating classification.
2. `app/src/repos/suggestionResolutionRepo.ts:638` creates an active resolve
   journal while atomically deleting the pending suggestion at `:684`.
   At the claimed boundary (`app/src/services/suggestionResolution.ts:832`), the contact
   effect need not have occurred or returned success.
3. Conversion's `app/src/services/caseworkerConversion.ts:552` removes both authority
   attributes and bumps classification through the guarded commit at `:566`.
   If both authority attributes were absent before, they remain absent.
   Its sweep at `:390` queries pending owner rows through
   `app/src/repos/extractionRepo.ts:710`; the active journal has no
   ownerContactId and is outside that set.
4. `app/src/repos/suggestionResolutionRepo.ts:798` applies the durable plan's field guards.
   Both absence conditions still pass, permitting the authority and AI
   provenance to be restored. Recovery enters via
   `app/src/services/suggestionResolution.ts:676` and `app/src/jobs/journalSweep.ts:244`.
   Make-again at `app/src/services/caseworkerConversion.ts:521` runs follow-ons and cannot
   remove the restored authority.

Independent disposition: agree with retaining this as a separate scoped
follow-up rather than reopening CF-1 or calling the pending sweep incomplete.
The written contract protects its commit and pending boundary; expanding
durable acceptance/recovery semantics requires a separate design decision.
That is a scope judgment, not technical closure or evidence of low likelihood.
This is a NEW parent deferral, not a pre-existing human acceptance and not
covered by the extraction-only deferral at spec lines 1360-1362.

No executed reproduction exists. Exact missing proof is a deterministic
claim -> conversion -> resume test and a claim -> conversion -> expired-lease
recovery test, with initially absent authority/provenance and verification of
the resulting contact/verdict. Any future repair must atomically guard the
originating classification and address already-created journals; a prewrite
read alone is insufficient. Hidden authority must currently be cleared
explicitly. Issue:
`docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md:12`.

### Blank-document browser failure - med open diagnostic, unresolved cause

Task 10.14's first FINAL2 browser run ended 336 passed/1 failed; its unchanged
source rerun ended 337/337. The failed case is
`e2e/tests/scenarios/landlord-onboarding.spec.ts:119`, waiting for the
Landlord action at `e2e/scenarios/steps.ts:1412` after full navigation.
The saved diagnosis and logs place the observation before any classification
PATCH. Feature and final-base isolated files each subsequently passed 7/7.

Those results establish non-reproduction and a passing final run. They do not
prove an environmental cause or a known flake. The original failing run lacks
a browser trace; screenshot/video and server logs cannot identify the failed
document/module/bootstrap stage. No new causal finding is made here.
Exact missing evidence is a recurrence trace with final URL, document and
module response outcomes, browser errors, and whether /auth/me starts.
`docs/issues/e2e-blank-document-after-contact-navigation.md:12` and
`docs/superpowers/reviews/2026-10-07-caseworkers/landlord-gate-diagnosis.md:9` retain this limit. The prior red stays visible.

## Prior adjudications and implementation corrections

- Agree with R1 acceptance and R2 closure of CF-1, based on the independent
  source and saved-proof assessment above.
- Agree that R1-ADV-2 is explicitly accepted for Branch B. The approval is
  limited to extraction applying from its old snapshot; it does not cover
  R2-ADV-1 by implication.
- Agree with the qualified R2 journal disposition and its response. "Claimed
  acceptance not yet applied" is the accurate description. An ordinary later
  edit by staff is not an explanation for this stale durable effect.
- Agree with retaining C6 unapplied. Task 10.4 remains PARTIAL rather than
  being relabeled CONFORMS by the aggregate suite.
- C1-C5 are corrections needed to meet the approved contract, not new scope:
  conversion error-level follow-on reporting, raw eligible organization
  carry, self-link exclusion, stale dialog generation isolation, and phone
  KindPicker layout. Current source/tests support them. In particular,
  `dashboard/src/routes/contact/ContactDetail.tsx:290`, `:691`, `:984`, and `:1171` bind callbacks to
  the current contact generation; `dashboard/src/routes/contact/ContactDetail.test.tsx:2681` proves a
  late A conversion does not close/refetch B's dialog.

No substantive adjudication is overturned. I do not adopt an unqualified
"all tasks green" interpretation of the handback: it itself records the
baseline-red deviation and new parent-deferred risk. This completed review
supplies the missing independent conformance verdict while preserving the
historical fact that the earlier R2 continuation never executed.


## Complete task accounting

CONFORMS means the current implementation meets the task's approved scope,
supported by inspected source/assertions and applicable saved execution.
PARTIAL identifies an unmet planned check; its reason is stated rather than
counted as a pass. Historical RED/pin distinctions in S1-report.md through
S10-report.md remain part of the evidence, and do not imply fresh execution.
Every citation below is repository-relative at the reviewed HEAD.

### S1-S4: matching, repositories, conversion, and routes

| Task | Disposition | Current evidence and assessment |
| --- | --- | --- |
| 1.1 | CONFORMS | `app/src/lib/caseworkers.ts:34` owns the exact Caseworker constant; `app/src/services/extraction/contactKinds.ts:25` accepts the byte-exact partner preset. |
| 1.2 | CONFORMS | `app/src/lib/caseworkers.ts:52`, `:62`, `:75`, `:86` distinguish normalized tab match, loose mentions, prefixed AI-note signal, and partner predicate. |
| 1.3 | CONFORMS | `app/src/lib/orgNames.ts:27` and `:37` add organization with both kinds. Existing unchanged/blank cases are pins, as S1-report.md correctly discloses. |
| 1.4 | CONFORMS | `dashboard/src/routes/contact/caseworkerRole.ts:17` mirrors the rules; `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts:34` compares app/dashboard behavior without importing the runtime service graph. |
| 2.1 | CONFORMS | `app/src/repos/contactsRepo.ts:98`, `:300`, `:662`, `:1551` add fields and AND guards; `app/test/helpers/twilioWebhookHarness.ts:2406` mirrors pre-mutation checking. |
| 2.2 | CONFORMS | `app/src/repos/contactsRepo.ts:1171` exhausts all index pages, resolves pointers, deduplicates and excludes deleted holders; fake counterpart is `app/test/helpers/twilioWebhookHarness.ts:2183`. |
| 2.3 | CONFORMS | `app/src/repos/contactsRepo.ts:1018` and `:1284` keep recipient type/role in a separate projection; fake projection is `app/test/helpers/twilioWebhookHarness.ts:2208`. |
| 2.4 | CONFORMS | `app/src/repos/conversationsRepo.ts:1586` conditionally retypes, returns the updated row or skipped, and preserves a null display-name input; fake is `app/test/helpers/twilioWebhookHarness.ts:835`. |
| 2.5 | CONFORMS | `app/src/repos/unitsRepo.ts:312`, `:491`, `:1026` implement deleted:any without the deleted filter; fake scan cursor behavior is `app/test/helpers/twilioWebhookHarness.ts:3000`. |
| 3.1 | CONFORMS | `app/src/services/contactClassification.ts:62` and `:110` share suggestion supersession/type drain; conversion imports at `app/src/services/caseworkerConversion.ts:40`, PATCH calls at `app/src/routes/contacts.ts:1802` and `:1815`. |
| 3.2 | CONFORMS | `app/src/services/caseworkerConversion.ts:195`, `:220`, `:471` validate the subject, collect ordered refusals including deleted units, and produce read-only preview. |
| 3.3 | CONFORMS | `app/src/services/caseworkerConversion.ts:130`, `:274`, `:335` implement valid raw carry, stored/agency-first derivation across both lists, and D5 checking for explicit request choices. |
| 3.4 | CONFORMS | `app/src/services/caseworkerConversion.ts:288` and `app/src/lib/contactThreads.ts:34` inspect every phone/email thread and exclude shared or type-less rows while recording expected type. |
| 3.5 | CONFORMS | `app/src/services/caseworkerConversion.ts:506`, `:552`, `:566` recompute before one commit with raw revision/org-value/deletion conditions and conversion record; `:575` maps lost conditions. |
| 3.6 | CONFORMS | `app/src/services/caseworkerConversion.ts:350`, `:380`, `:401`, `:521` supply suggestion cleanup, conditional thread effects, error reporting and follow-on repair. R2-ADV-1 is explicitly assessed separately above. |
| 3.7 | CONFORMS | `app/src/services/caseworkerConversion.ts:594` rejects invalid dismiss subjects, writes dismissal without classification bump, and audits the changed field. |
| 3.8 | CONFORMS | `app/src/services/possibleCaseworkers.ts:22` pages the three specified partitions; `:58` applies exclusions/signals/order and `:67` excludes self-links. |
| 4.1 | CONFORMS | `app/src/routes/contacts.ts:297`, `:534`, `:812` use one server-owned-key refusal helper on POST and PATCH, including explicit null. |
| 4.2 | CONFORMS | `app/src/routes/contacts.ts:669`, `:1518`, `:1653` parse organization/clear, read consistently and check changed names against both kinds, preserving unchanged off-list values. |
| 4.3 | CONFORMS | `app/src/routes/contacts.ts:1531`, `:1621`, `:1632`, `:1746` implement merged-kind refusal, manual source and the atomic CF-1 fix; exact-fixture proof assessed above. |
| 4.4 | CONFORMS | `app/src/routes/contacts.ts:1176` registers the literal Possible route before IDs; `app/src/routes/caseworkerReview.ts:35`, `:74` strictly parse and forward actor/errors; `app/src/routes/api.ts:853` injects dependencies. |
| 4.5 | CONFORMS | `app/src/lib/import/apply.ts:1058`, `:1087`, `:1150` omit type/status/authority/agency writes for manual type source. The plan's explicit read/write race remains accepted. |

The focused suites behind these tasks include contactKinds, caseworkers,
orgNames, caseworkerRoleMirror, caseworkerRepoParity.integration,
contactClassification, caseworkerConversion, possibleCaseworkers,
contactsCrud, contactOrgNames, contactTriage, caseworkerReviewApi, and
importApply.integration. Their meaningful source assertions and the saved
slice/FINAL2 execution were assessed; the CF-1 subset received the additional
raw RED/GREEN inspection described above.

### S5-S7: organizations and share-server integration

| Task | Disposition | Current evidence and assessment |
| --- | --- | --- |
| 5.1 | CONFORMS | `app/src/repos/contactsRepo.ts:895`, `:1838` extend guarded org writes/removal; `app/test/orgRecordWriters.integration.test.ts:149` covers real/fake organization behavior. |
| 5.2 | CONFORMS | `app/src/services/orgRecords.ts:171`, `:210`, `:315` and `app/src/services/orgRewrite.ts:403`, `:440` expand either-kind rewrites with organization last and preserve target-kind selection. |
| 5.3 | CONFORMS | `app/src/services/orgRecords.ts:451`, `:469`, `:492` distinguish display counts and distinct inUse/kindLocked totals; `app/src/routes/organizations.ts:108` selects the appropriate refusal total. |
| 5.4 | CONFORMS | `app/src/services/orgRecords.ts:522` discovers off-list organization across contact types/deletion states using both kinds; `:567` returns holders for the new field. |
| 5.5 | CONFORMS | `app/src/services/orgRewrite.ts:452` requires a kind only for organization Add, refuses invalid actions/kind combinations, and accepts either-kind Use; `app/src/routes/organizations.ts:343` passes the wire value. |
| 5.6 | CONFORMS | `app/src/routes/organizations.ts:173` enforces exactly one of kind/kinds, a valid nonempty unique list, and the both-list check. |
| 5.7 | CONFORMS | `app/src/routes/dev.ts:1193`, `:1229` allow organization only within the contact fixture seam; `e2e/fixtures/orgFixture.ts:23`, `e2e/support/selectors.md:113` and `e2e/README.md:602` match. |
| 6.1 | CONFORMS | `app/src/routes/broadcasts.ts:337`, `:435`, `:843` share the tenant/partner predicate for seeds and explicit recipients. Filter audiences and composer search retain their tenant-only scope. |
| 6.2 | CONFORMS | `app/src/routes/broadcasts.ts:458` limits preview voucher facts to tenant-typed recipients. |
| 6.3 | CONFORMS | `app/src/jobs/broadcastFanOut.ts:874` and `:1396` use conversationTypeFor(contact) for both new-send and adoption mint paths; existing-thread behavior is retained. |
| 6.4 | CONFORMS | `app/src/repos/contactsRepo.ts:356`, `:1284` supply the separate type/role display projection; `app/src/routes/units.ts:1018` uses it best-effort without widening unrelated display reads. |
| 6.5 | CONFORMS | `app/src/routes/contactTimeline.ts:695`, `:765`, `:1464` use neutral recipient wording, preserve the stored Sent to prefix including zero, and reserve No recipients reached for recount. |
| 7.1 | CONFORMS | `dashboard/src/api/types.ts:3513`, `:3574`, `dashboard/src/api/endpoints.ts:2953`, and `dashboard/src/routes/orgs/orgCopy.ts:26`, `:374`, `:632` mirror wire totals, both-list checks and organization copy. |
| 7.2 | CONFORMS | `dashboard/src/routes/orgs/OrgPicker.tsx:244` labels the multi-kind add as a new organization and uses the both-list picker behavior. |
| 7.3 | CONFORMS | `dashboard/src/routes/orgs/NewOrgDialog.tsx:102`, `:116`, `:154` check both kinds, begin unselected and require a kind for Add; `dashboard/src/routes/orgs/OrgKindChoice.tsx:21` supplies accessible radios. |
| 7.4 | CONFORMS | `dashboard/src/routes/orgs/orgCopy.ts:643`, `:667` read distinct server totals; `dashboard/src/routes/settings/OrgEntryDialogs.tsx:443`, `:505` use the correct delete/kind modes. |
| 7.5 | CONFORMS | `dashboard/src/routes/settings/NotOnListSection.tsx:71`, `:261`, `:365`, `:459` implement both-kind Use, kind-required Add, no organization Move/Split, and the existing settle gate. |
| 7.5a | CONFORMS | `dashboard/src/routes/settings/orgSelection.ts:46`, `:71` admit organization to the URL field allowlist only for not-on-list selections. |
| 7.6 | CONFORMS | `dashboard/src/routes/orgs/orgCopy.ts:45` maps by field rather than entry kind; `dashboard/src/routes/contact/ContactEditForm.tsx:153`, `:227`, `:413`, `:710`, `:1019` preserve organization through state, save, 422, picker and dialog callbacks. |

The inspected tests cover organization rewrite parity, distinct counts,
kind/deletion refusals, resolve/check validation, development fixture pins,
partner seed/explicit recipient gates, both fan-out paths, recipient projection,
neutral timeline labels, both-kind dialogs, URL selection and form error routing.
Saved S5/S6/S7 reports and FINAL2 execution provide historical run provenance.


### S8-S10: dashboard, browser coverage, and operational records

| Task | Disposition | Current evidence and assessment |
| --- | --- | --- |
| 8.1 | CONFORMS | `dashboard/src/api/types.ts:2344`, `dashboard/src/api/endpoints.ts:1476`, and `e2e/performance/mutationCatalog.ts:143` mirror conversion wires and register both new mutations. |
| 8.2 | CONFORMS | `dashboard/src/routes/contact/KindPicker.tsx:81`, `:134`, `:154`, `:175` implement the preset/order, offer gate, role-mentions filtering and corrected placeholder. |
| 8.3 | CONFORMS | `dashboard/src/routes/contact/CaseworkerDialog.tsx:186`, `:220`, `:299` implement advisory preview, dirty-only organization, refusals and retry recovery; `dashboard/src/routes/contact/CaseworkerDialog.test.tsx:256` covers conflict/refusal/stale-response behavior. |
| 8.4 | CONFORMS | `dashboard/src/routes/contact/ContactCreateForm.tsx:258` offers Caseworker on create without organization input; `e2e/tests/dashboard-next/contact-create.spec.ts:231` checks stored partner/Caseworker. |
| 8.5 | CONFORMS | `dashboard/src/routes/contact/ContactEditForm.tsx:413`, `:433`, `:515`, `:586`, `:710` gate by stored caseworker identity, handle the conversion 409 and edit organization across both lists. |
| 8.6 | CONFORMS | `dashboard/src/routes/contact/UnknownFile.tsx:128` places Mark as Caseworker fourth and opens the shared conversion flow. |
| 8.7 | CONFORMS | `dashboard/src/routes/contact/ContactActionsMenu.tsx:183` exposes Make caseworker in More actions only when supplied the eligible handler. |
| 8.8 | CONFORMS | `dashboard/src/routes/contact/ContactDetail.tsx:678`, `:691`, `:984`, `:1171`, `:1230`, `:1390` control eligible entry points, stale callback isolation, type-based facts and shared dialog host. |
| 8.9 | CONFORMS | `dashboard/src/routes/contact/PartnerFile.tsx:115` displays Role/Organization and Staff notes; `docs/issues/staff-notes-on-landlord-partner-files.md:38` retains the outstanding landlord half. |
| 8.10 | CONFORMS | `dashboard/src/routes/contacts/FilterChips.tsx:20`, `:80` export the shared controls and `dashboard/src/routes/contacts/TenantFilters.tsx:10` adopts them without changing the tenant facet algorithm. |
| 8.11 | CONFORMS | `dashboard/src/routes/contacts/ContactsList.tsx:43` and `:68` add Caseworkers to the Filter contacts links in order; `dashboard/src/routes/contacts/CaseworkersList.tsx:198` uses the same tabs. |
| 8.12 | CONFORMS | `dashboard/src/routes/contacts/CaseworkersList.tsx:81`, `:97`, `:131`, `:222` implement actual/possible lists, organization URL chips, ordered signals, dismissal confirmation and refetch. |
| 8.13 | CONFORMS | `dashboard/src/app/nav.ts:69`, `dashboard/src/App.tsx:159`, `e2e/performance/routes.ts:665` and `e2e/performance/routes.test.ts:403` add the sub-link/route and explicit profiler exclusion with its issue. |
| 9.1 | CONFORMS | `dashboard/src/routes/listing/ListingDetail.tsx:1025` supplies Sent to and Send this property; the kebab uses the same neutral action name. |
| 9.2 | CONFORMS | `dashboard/src/routes/listing/listingFormat.ts:237` and `dashboard/src/routes/contact/Card.tsx:218` label resolved non-tenant recipients by displayKind and omit labels for tenants/unresolved rows. |
| 9.3 | CONFORMS | `dashboard/src/routes/listing/listingFormat.ts:177` supplies singular/plural recipient labels and the zero-reached variant. |
| 9.4 | CONFORMS | `dashboard/src/routes/broadcasts/RecipientPreview.tsx:352`, `:530` and `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:490`, `:591` use recipient copy while retaining intentionally tenant-only search/filter controls. |
| 9.5 | CONFORMS | `dashboard/src/routes/broadcasts/BroadcastsList.tsx:91`, `:132`, `dashboard/src/routes/broadcasts/broadcastFormat.ts:73`, `:225` and `dashboard/src/routes/broadcasts/BroadcastResults.tsx:45` implement neutral list/reach/results text and Recipient fallback. |
| 9.6 | CONFORMS | `dashboard/src/routes/contact/PartnerFile.tsx:154` and `dashboard/src/routes/contact/ContactDetail.tsx:1205` provide the Properties sent card and partner seed; `e2e/tests/dashboard-next/partner-share.spec.ts:116` exercises that actual entry point. |
| 10.1 | CONFORMS | `e2e/performance/mutationCatalog.ts:143`, `e2e/performance/routes.ts:665` and `e2e/performance/routes.test.ts:403` retain the S8 mutation/route pins; no duplicate implementation was needed. |
| 10.2 | CONFORMS | `e2e/tests/dashboard-next/frame.spec.ts:26` pins nav order; `e2e/tests/dashboard-next/contact-create.spec.ts:158`, `:177`, `:231` cover preset order and stored type/role. C5's phone layout is also backed by saved live measurements/screenshots. |
| 10.3 | CONFORMS | `e2e/fixtures/orgFixture.ts:23`, `e2e/README.md:602`, and `e2e/tests/dashboard-next/org-lists.spec.ts:876` match the widened organization seam/wire; S5 already moved the usage assertions. |
| 10.4 | PARTIAL | Required populated-picker batch is baseline-red at `e2e/tests/dashboard-next/matching-entry-points.spec.ts:228`. Wording pins conform. C6 remains tested but unapplied; full-suite green does not close this task. See reassessment above. |
| 10.5 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:228`, `:258`, `:284`, `:313` use an owned conversion contact and verify persisted cleanup/thread/record; seed refusals are read-only preview/Cancel. |
| 10.6 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:405`, `:414`, `:432` check owned signal rows, conversion, dismissal and reload; they avoid global Possible-list counts/empty states. |
| 10.7 | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:451`, `:469`, `:494` use a unique inbound unknown, the real dialog, and stored conversion/suggestion result; unit coverage distinguishes accepted/superseded verdicts. |
| 10.8 | CONFORMS | `e2e/tests/dashboard-next/partner-share.spec.ts:62`, `:81`, `:116`, `:157`, `:175` mint a fresh consented partner/property, send once, then inspect the partner thread and persisted listing send without pre-opening its conversation. |
| 10.8a | CONFORMS | `e2e/tests/dashboard-next/org-lists.spec.ts:861`, `:884`, `:893`, `:909` verify owned organization values, explicit Add kind, and either-kind Use with awaited rewrites. |
| 10.9 | CONFORMS | `e2e/support/selectors.md:117`, `:119`, `:128`, `:131` document the actual caseworker/organization/share controls and isolation conventions. |
| 10.10 | CONFORMS | `documentation/GLOSSARY.md:345`, `:373` define caseworker and organization while distinguishing the relationship row, partner type, and org list; existing nouns are cross-referenced. |
| 10.11 | CONFORMS | `RUNBOOK.md:450` documents deploy-only obligations, follow-on repair, mistaken-conversion restoration and unfenced writes. These are operating instructions, not claims that production repairs ran. |
| 10.12 | CONFORMS | Required issues exist for generic retypes, tour/placement/association writers, in-flight extraction, imported unknown threads, A2P and scans; details are at line 12 of each issue listed below. Staff-notes follow-up retains its unbuilt half. |
| 10.13 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S10-full.md:10` and saved 10-13-full-1 exit/log prove the distinct pre-sync 337/337 run. This historical checkpoint does not replace final-source gates or close 10.4. |
| 10.14 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/completion-gates-r2.md:4`, `:17`, `:42`, `:72` and inspected FINAL2 command/exit files apply to unchanged e0da8da3 source. Prior red, lint baseline and diagnostic skip are preserved below. |

The six Task 10.12 issues are:

- `docs/issues/contact-retype-skips-caseworker-refusals.md:12`
- `docs/issues/tours-placements-no-contact-type-check.md:12`
- `docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md:12`
- `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md:12`
- `docs/issues/a2p-campaign-covers-caseworker-shares.md:12`
- `docs/issues/possible-caseworkers-and-roster-refusal-scans.md:12`

### Both required checkpoints

| Checkpoint | Disposition | Inspected saved evidence |
| --- | --- | --- |
| After S6 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S6.md:3` identifies aea202d4 / source 7b74afd8. CP1-typecheck and CP1-npm-test command/exit files both report 0; log summaries total 734 passing files, 14242 passing cases, one optional diagnostic skip. |
| After S9 | CONFORMS | `docs/superpowers/reviews/2026-10-07-caseworkers/checkpoint-S9.md:3` identifies d3a60076 / source cf9fdb5d. CP2-typecheck and CP2-npm-test command/exit files both report 0; log summaries total 738 passing files, 14359 passing cases, one optional diagnostic skip. |

These are historical sequencing checkpoints, followed by the later applicable
FINAL2 verification. They are not credited as executions on the final fix.

## Verification applicability and limits

Inspected `completion-gates-r2.md`, `self-QA.md`, the FINAL2 saved
command/exit/log/result files, lint scope/baseline/attribution, FW1-final
RED/GREEN, and CP1/CP2 logs. Current HEAD differs from implementation e0da8da3
only in documentation. This directly supports using the saved gates; the
user expressly requested this method instead of aggregate reruns.

| Required gate | Saved outcome and qualification |
| --- | --- |
| npm run typecheck | EXIT 0; all workspaces, 30.190s. |
| npm test | EXIT 0; 738 files, 14378 passing tests. One optional built-dashboard identity diagnostic skipped because dist was absent. No DynamoDB suite skip or [dynamoAdmin] fault marker found. |
| npm run smoke | EXIT 0; 1649 import specifiers across 286 emitted files resolve under plain Node. |
| timeout 2700 npm run e2e | First FINAL2 EXIT 1, 336 passed/1 failed; unchanged-source rerun EXIT 0, 337 passed, zero reported skipped/flaky cases. The latter's flaky count does not explain the former's failure. |
| Scoped npx eslint | Raw EXIT 1 on 142 explicit changed TS/TSX paths. Zero new errors by saved same-path baseline comparison; attribution EXIT 0. Five pre-existing react-hooks/set-state-in-effect errors remain. |

The unit totals are app 9118 plus one diagnostic skip, dashboard 4371,
e2e unit 503, fake-twilio 275, and fake-twilio-web 111.
Existing lint errors are BroadcastComposer.tsx:204,229,248,263 and
ContactsList.tsx:184 (base:148). The inspected attribution algorithm preserves
rule, severity, explanatory/source/caret text and normalizes only diagnostic
and code-frame line coordinates. No rule-less JavaScript lint is credited.
The lint scope explicitly names base d8749158 and gate HEAD 00c71622.

Saved browser command metadata/results retain both full runs. The final run
at ba7492f2 used E2E_TRACE=1 and no E2E_CHILD_LOG_DIR; its source is unchanged
from e0da8da3. The isolated landlord file passes on feature and d8749158
provide comparative non-reproduction evidence only. A fresh failure trace
is still needed to resolve causality.

The saved live QA ran after gates on appCommit31ed2fee in hermetic lane 13
(ports 10301/10311/10321/10331). SELFQA-evidence.json confirms the lane identity,
run-unique fixtures, conversion removals/recorded fields, preserved notes and
thread type, linked refusals, organization settlement/usage, dismissal, and a
single fake-provider outbound partner share. The saved 375px dialog and desktop
recipient screenshot inspected here corroborate their respective UI states.
No fresh manual interaction is claimed. The existing QA report discloses its
selector/setup corrections and best-effort post-send draft cleanup 409.
Its busy/race claims rest on automated assertions rather than a manually held
network response. Its teardown is recorded; this review started no stack.

## Completion and remaining decisions

The independent conformance review is complete, including source coverage,
CF-1 closure, adjudication reassessment, 75-task accounting, both checkpoints,
and final evidence applicability. The completed record is the only intended
tracked change from this review. Existing reports are retained unchanged.

No new in-scope must-fix implementation blocker was substantiated. The
remaining verification blocker to claiming every task green is Task 10.4's
baseline picker defect. Its unapplied C6 proposal needs the separate scope
decision already identified. R2-ADV-1 remains an open parent-deferred P2/med
risk awaiting the human merge decision, with no executed reproduction and
no make-again cleanup for restored authority. The blank-document failure
remains an unresolved diagnostic even though the final suite passed.

The previously approved extraction/importer/generic retype/writer limitations
remain exactly scoped. A2P coverage remains Sam's follow-up under the explicit
decision to ship partner shares with that question open. None is relabeled
fixed by this review. No merge, deployment, main sync, worktree cleanup,
real environment edit, or product change is authorized or performed here.
