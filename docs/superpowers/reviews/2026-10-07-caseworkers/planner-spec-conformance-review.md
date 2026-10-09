# Planner spec-conformance and bug review - Caseworkers branch B

Date: 2026-10-09. Requested by Cameron: review the whole branch against the
spec to confirm it achieves what it set out to do, and review the code for
bugs. Reviewer: the planner (Claude Code, cloud session), with seven
independent sub-agent reviewers. Every finding below was re-checked by the
planner at the cited lines before it was recorded; two layout findings were
also measured in the running app.

| Item | Value |
| --- | --- |
| Reviewed HEAD | `9c14f54b` (feat/caseworkers; includes the Linux harness merges `9481ecf5` and `e156aafb`) |
| Base / main | `d874915873a61864f6d051a0a9af3f0bb8e7e6e2` (main unchanged) |
| Contract | spec `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md` revision 15, branch B: D16-D22 and the (B) lines of D6, D10, 5.2, 6, 9, 10, 11, 12; plan sections 0-3 and 3.9 copy |
| Gate status | unchanged from `planner-final-review.md` addendum: all five gates exit 0 / ratchet pass on merged head 9481ecf5 (e2e on Chromium 141, not the pinned 149) |

## Verdict

**The branch achieves what the spec and Sam's #19 asked for. No P1 and no
P2 implementation defect was found.** The review produced fourteen P3 items
(nine small code defects, three test-quality gaps, two documentation nits) and
six spec gaps that are product questions rather than defects. The earlier
verdict stands: QUALIFIED PASS for Cameron's merge decision, with the same
three standing qualifications (Task 10.4 baseline-red and C6 unapplied;
R2-ADV-1 reproduced and parent-deferred; the unexplained first FINAL2
blank-document failure).

None of the P3s blocks merge. P3-1 to P3-5 and T-1/T-2 are each a few lines and
could ride one small fix wave before or right after merge; that is Cameron's
call, and nothing was changed by this review.

## How the review was run

Seven reviewers, each read-only, each given the spec slice, the known
qualifications (so they hunted for new gaps), and permission to prove claims
with focused tests or a temporary repro file that they deleted afterwards (the
tree was verified clean at the end):

| Reviewer | Lens | Result |
| --- | --- | --- |
| A | Server spec: D16 server, D19, D21, D22 | ~45 requirements CONFORM; 2 P3 |
| B | Server spec: D17 organization in the org-list server, D20 shares, D22 | ~35 CONFORM; 2 P3 |
| C | Dashboard spec: D6/D10 (B), D16-D22 UI, every D20/D22 wording item | ~60 CONFORM; 3 P3 |
| D | Adversarial: authz, messaging safety, conversion integrity, input handling, test quality | 0 P1/P2; 2 P3 |
| G | Goal level: Sam's #19 asks, G5, non-goals, I1/I2 writer inventory, sections 10-12 | all asks achieved; 2 doc P3; spec gaps |
| E | Line-by-line correctness, all 33 changed server files | 2 P3 (1 duplicate) |
| F | Line-by-line correctness, all 37 changed dashboard files | 4 P3 (2 duplicates) |

Executions by the reviewers, all exit 0 (DynamoDB Local up, AWS keys unset):
focused app suites covering conversion, review API, possible list, PATCH
triage, CRUD, org names/records/rewrite/API, broadcasts, fan-out,
listing-sends, timeline, batch reads, importer and the real/fake parity
integration file (about 1,700 app cases across the runs); about 2,900
dashboard cases; dashboard `tsc --noEmit`. Temporary repros: the full
conversion against REAL repositories on DynamoDB Local (guards, removes,
thread re-type, soft-deleted-unit refusals; 5/5 and 2/2), and one repro per
confirmed behavioural P3 noted below.

## 1. Requirement map (condensed)

CONFORMS unless marked. Evidence is at HEAD; each line has a pinning test
unless "no test".

**D16 matching and the one conversion**
- `CASEWORKER_ROLE` one constant; canonicalizer byte-exact partner + Caseworker - `app/src/lib/caseworkers.ts:34`, `app/src/services/extraction/contactKinds.ts:25-29`.
- Three tiers: `isCaseworkerRole` `caseworkers.ts:52-55`; mentions `:62-66`; tab predicate `isCaseworker` `:86-88`; dashboard mirror pinned by `caseworkerRoleMirror.test.ts`.
- PATCH 409 `caseworker_use_conversion` on the MERGED type/role, fenced by the raw revision (CF-1 fix) - `app/src/routes/contacts.ts:1616-1628`, `:1531`, `:1746-1757`.
- POST may create partner + Caseworker and ignores org fields - `parseCreateBody` `contacts.ts:807-985`.
- KindPicker preset offered only on a new or STORED caseworker, order Tenant, Landlord, Partner, Caseworker, Property Manager, Other; placeholder and datalist drop caseworker roles - `dashboard/src/routes/contact/KindPicker.tsx:40-47,134,211`, `ContactEditForm.tsx:592`. Layout defect P3-1; role carry P3-2.
- Unknown card "Mark as Caseworker" fourth, opens the dialog - `UnknownFile.tsx:126-143`. More actions "Make caseworker" only for a live stored tenant/landlord/partner not already a caseworker - `ContactDetail.tsx:682-685,984`.

**D17 organization**
- PATCH D5 against both kinds, never `otherKind`, unchanged off-list passes, `''` REMOVEs - `contacts.ts:672-677,1658-1674`, `app/src/lib/orgNames.ts:36,95-115`.
- Settings usage column; distinct `inUse` / `kindLocked` totals feed the two refusals and dialogs - `app/src/services/orgRecords.ts:451-520`, `app/src/routes/organizations.ts:119-124,310,323`, `dashboard/src/routes/settings/OrgEntryDialogs.tsx:112,118,455-457`.
- Rename/merge of either kind rewrite organization, listed last; Not-on-the-list organization rows across all types incl. deleted; resolve Use (either kind) / Add (kind required) / Clear; Run again and job claim re-validate across both kinds - `orgRecords.ts:210-214,534-587`, `orgRewrite.ts:196-244,286-297,452-542`. Move/Split refusal ordering P3-5.
- `/check` `kinds` (exactly one of kind/kinds) - `organizations.ts:178-220`. Dev fixture accepts organization, local only - `app/src/routes/dev.ts:1229-1236`.
- Partner edit-form picker over both lists, organization-mode "Is this really new?" with required kind; partner page Role, Organization, Staff notes; header facts by type - `ContactEditForm.tsx:714-739`, `orgs/NewOrgDialog.tsx`, `PartnerFile.tsx:115-133`, `ContactDetail.tsx:1380-1393`. (No e2e drives the edit-form picker: T-3.)

**D18 Caseworkers tab** - nav sub-link and route `dashboard/src/app/nav.ts:71`, `App.tsx:161`; list by `isCaseworkerRole` and organization chips `CaseworkersList.tsx:81-170`; profiler: explicit exclusion with filed issue `e2e/performance/routes.test.ts:403-405`, `docs/issues/perf-pages-contacts-caseworkers-surface.md`; no page width cap. Long-organization layout P3-7.

**D19 Possible list and the conversion**
- Possible: three partitions paged to exhaustion; exclusions; four signals with D22 rules - `app/src/services/possibleCaseworkers.ts:22-101`. Pointer-row exposure P3-8.
- Route domain (pointer/non-ContactType/deleted 404, team_member 400, dismiss rules, strict body) - `caseworkerConversion.ts:195-208,594-612`, `app/src/routes/caseworkerReview.ts:36-54`.
- Preview = same code, read-only; refusals placement/tour/landlord/roster with ids, soft-deleted units included - `caseworkerConversion.ts:217-266,471-504`; real repo parity `caseworkerRepoParity.integration.test.ts:510-546`.
- Organization: request `''`/D5/omitted; stored, else agency-first across both lists, else authority; D13-limited carry - `:136-148,274-286,336-348,535-537`.
- Commit: every field set/removed, `caseworker_conversion` record, five-clause guard, 404 vs 409 mapping - `:541-583`; repo guards `app/src/repos/contactsRepo.ts:1501-1564`.
- Steps 2-4 (type drain accepted, supersede all, own-thread re-type via all-holders read conditional on read type, audit, milestone, events, vocabulary), error-level logging, repair path - `:350-451,521-528`; `app/src/lib/contactThreads.ts`; `conversationsRepo.ts:1586-1622`. Repair audit P3-3.
- Dialog: one component on all three entry points, preview only on open, refusal sentences with links, removed values, thread counts, what stays, organization sent only when changed, contact_changed re-read, generation-bound results - `CaseworkerDialog.tsx:186-351`, `ContactDetail.tsx:291-293,691-699`. Error copy P3-6; accessible name P3-9.

**D20/D22 shares** - one tenant-or-partner predicate for seeds and explicit recipients `app/src/routes/broadcasts.ts:346-348,449,848`; filters stay tenant-only `app/src/services/audienceResolution.ts:149` (test gap T-2); gates unchanged `broadcastFanOut.ts:265-285`; both mint sites `conversationTypeFor` `:878-881,1397-1400`; voucher facts tenant-only `broadcasts.ts:466-468`; recipients `type`/`role` via a separate projection `contactsRepo.ts:1018-1025`, `units.ts:156-162,1029-1046`; timeline labels `contactTimeline.ts:695-709`; PartnerFile Properties sent + Send `PartnerFile.tsx:158-181`; every D20/D22 neutral wording item and every intentionally tenant-worded control verified in `dashboard/src/routes/broadcasts/*` and `listing/*`.

**D21** - generic retype keeps the unknown-only flip `contacts.ts:1880-1915`; `type_source` stamping `:1632-1638` (audit P3-4); server-owned keys refused on POST/PATCH `:297-304,534,812`; importer guard `app/src/lib/import/apply.ts:1073-1188`.

**Sections 9-12** - I1: every writer of `contact.organization` is the D5-checked PATCH, the conversion (stated carry exception), the org rewrite, or the local dev fixture; I2: every 1:1 thread mint site types by contact (public intake `tenant_1to1` and the importer's `unknown_1to1` are the stated exceptions). Section 10 bullets delivered; RUNBOOK repair procedure matches the code (status gap D-1); all six section 12 (B) follow-ups filed; GLOSSARY updated; no added "home" in staff copy.

**Non-goals honoured** - no filter audience or composer search reaches partners; no new ContactType; /join and public intake untouched; tenant `caseworker` free-text untouched; names stored, never ids.

## 2. Did it achieve Sam's #19?

| Ask (spec 1.1) | Verdict |
| --- | --- |
| Caseworkers easy to tell apart | Achieved on contact screens (Caseworker chip, role, organization line). Comms screens still say "Partner" (SG-5). |
| ...and find | Achieved: Contacts > Caseworkers. No search box on that tab (SG-5). |
| Each caseworker belongs to an organization | Achieved as an optional field, derived on conversion; not asked at creation (SG-3). |
| List of all caseworkers with an organization filter | Achieved. |
| Property shares from the right-hand panel, normal message | Achieved; live-verified end to end, including a share to a converted caseworker. |
| Caseworkers saved as tenants listed to confirm, then converted | Achieved for the words caseworker / case worker / case manager and role-less partners; see SG-1 and SG-2. |

## 3. Verified findings

### Code defects (all P3)

- **P3-1 KindPicker clips "Other" in the desktop New-contact modal.** `dashboard/src/routes/contact/KindPicker.module.css:11-30` (single non-wrapping flex row, `overflow: hidden`; the two-column grid applies only below 600px, `:55`). With six choices the bar needs 457px and has 446px. Measured LIVE on lane 5 (Chromium 141, Linux fonts) at 1280, 768 and 600px: "Other" right edge 458 > 444, visibly cut. Hits everyone creating a contact on desktop, and editing a stored caseworker. The e2e geometry pin checks only 375px. Fix: let the bar wrap (e.g. `flex-wrap: wrap`, `flex: 1 1 auto`) or switch on a container query.
- **P3-2 Caseworker -> Other keeps the "Caseworker" role on a tenant or landlord base.** `KindPicker.tsx:146-147`. New contact -> Caseworker -> Other -> Tenant saves `{type:'tenant', role:'Caseworker'}` (reviewer repro). The Property Manager preset already carries its role the same way. Fix: clear the role when leaving the Caseworker preset.
- **P3-3 The repair path's audit omits `caseworker_conversion`.** `app/src/services/caseworkerConversion.ts:524-526` calls `followOn` without `record`, so `:431` drops it. D19 step 4 says the audit carries the record and make-again re-runs step 4; RUNBOOK.md:466 relies on it. After a failed first audit, a repair and a later re-conversion, the first conversion's removed values are lost (reviewer repro printed the repair payload without it). Fix: pass `record: c.caseworker_conversion` on repair.
- **P3-4 A staff type override's audit omits `type_source`.** `app/src/routes/contacts.ts:1637` adds it to the patch only; the audit `:1941` and log `:1963` use `parsed.changedFields`. Fix: push `'type_source'` onto `changedFields`.
- **P3-5 Organization Move/Split can answer 409 instead of the spec's 400.** `app/src/services/orgRewrite.ts:503-516` checks the field inside `plan()`, after the rewrite lock and the name-variant check (`:473-484`), so those paths answer `org_rewrite_running` / `org_value_is_name_variant` (reviewer repro). Nothing is written; the dashboard never offers these actions. Fix: refuse the pairs beside the `kind` checks at `:458-463`.
- **P3-6 Errors that cannot succeed say "please try again".** `dashboard/src/routes/contact/CaseworkerDialog.tsx:196-198,254-255` and `dashboard/src/routes/contacts/CaseworkersList.tsx:181-182`: a 404 (contact deleted or converted elsewhere) or the dismiss 400 shows a retry that loops. Only reachable from a stale Possible list. Fix: final wording for 404/400 and refetch the list.
- **P3-7 A very long organization hides the caseworker's name on the Caseworkers list at mid widths.** `CaseworkersList.tsx:229-231` places `.org` in `.meta`, which is `flex: 0 0 auto` without wrapping above 560px (`dashboard/src/routes/contacts/ContactsList.module.css:164-169`). Measured LIVE: a 96-character organization leaves the name 0px wide and overflows the row at 1024px and 900px viewports; the longest starting-list name (HUD-VASH, 50 chars) still fits (name 83px at 860px). Names may be up to 120 characters. Fix: make `.org` the shrinking, ellipsized child.
- **P3-8 The contacts PATCH accepts a phone/email pointer-row id.** No `phone_ref`/`email_ref` guard in the PATCH body (`contacts.ts:1500-1995`; GET guards at `:1204`); pre-existing on main. New consequence: a typed pointer row would surface on Possible caseworkers (`possibleCaseworkers.ts:31` has no pointer filter, unlike `orgRecords` `everyContact`) where Make/Not-a-caseworker answer 404, so it cannot be cleared. Needs a deliberate API call; reviewer repro: PATCH 200 on a `phoneref#...` id, dismiss 404. The FakeWorld `listByType` drops pointers (`app/test/helpers/twilioWebhookHarness.ts:2293`), so no test can see it. Fix: 404 pointer ids in the PATCH and skip them in `readPartition`.
- **P3-9 Possible-row button's accessible name does not contain its visible label.** `CaseworkersList.tsx:279`: visible "Make caseworker", name "Make <name> a caseworker" (WCAG 2.5.3 Label in Name). Plan 3.9 binds this name, so changing it is a plan decision (e.g. "Make caseworker: <name>").

### Test-quality gaps (P3)

- **T-1 The landlord-of-record paging loop is never exercised past page one.** The FakeWorld `listByLandlord` slices to 50 and never returns a cursor (`twilioWebhookHarness.ts:2879-2885`), unlike its `list` / `listByStatus`. Breaking the loop at `caseworkerConversion.ts:233-241` would stay green. Fix the fake's paging and add a page-two case.
- **T-2 No test sends a non-tenant down the housing-authority audience path.** The tenant-only fence (`audienceResolution.ts:149`, pre-existing) is load-bearing because the index holds every type, but `audienceResolution.test.ts:138-151` has only tenants on that path and `broadcastApi.test.ts:2419` uses no housing authority. Deleting the fence would go unnoticed. Add a partner holding the filtered authority.
- **T-3 No e2e drives the partner edit-form Organization picker** (unit coverage only).

All eight highest-risk behaviours otherwise have tests that would fail on a plausible regression (commit guard, refusals incl. soft-deleted units, thread ownership, PATCH merged-kind 409, server-owned keys, partner recipient gating, fan-out mint type, organization D5).

### Documentation (P3)

- **D-1 RUNBOOK restoration never mentions status.** The conversion sets `status: active`; `caseworker_conversion` (spec-defined shape) holds no prior status; "Putting a mistaken conversion back" (RUNBOOK.md, Caseworkers section) restores type, role and fields only. Add a step to restore the status from the timeline's earlier status milestone.
- **D-2 Stale line references** in `docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md:9,17` (`contacts.ts:1530`, `:1891`; now `:1536-1537`, `:1897-1909`).

### Spec gaps - questions for Cameron and Sam, not defects

- **SG-1 Other role words are not found.** Possible caseworkers matches only "caseworker", "case worker", "case manager" (`caseworkers.ts:39`; D22 defines it so). The old Other placeholder suggested "Case worker, Social worker"; the new one still suggests "Social worker" on a tenant/landlord base (`KindPicker.tsx:211`). Tenant-saved "Social worker" helpers are never listed and new ones can still be made that way. Check the stored role vocabulary and decide whether more words count, and whether the placeholder should stop suggesting a helper role. (The goal-level reviewer rated this P2 as a product risk.)
- **SG-2 Already-confirmed caseworkers are re-confirmed one by one.** About 19 caseworkers Sam confirmed during the import review are now role-less partners and appear on Possible caseworkers among every other role-less partner (D19 accepts this).
- **SG-3 Organization is never asked at creation** (D16 decision), so new caseworkers sit under "Not recorded" until edited.
- **SG-4 Some refusals strand the record.** A refusal on a soft-deleted property links to a read-only page without saying "restore it first"; a caseworker record that holds a client's open placement can only convert after the placement ends.
- **SG-5 Where Sam may still not find or recognise caseworkers:** no search on the Caseworkers tab; Today labels their threads "Partner" (`dashboard/src/routes/today/buildToday.ts:64`); AI-flagged unknown caseworkers live only in the Unknown queue.
- **SG-6 A re-import can make a caseworker without the conversion.** An unstamped tenant/landlord whose role already satisfies `isCaseworkerRole` (e.g. a pre-deploy staff retype, which carries no `type_source`) becomes partner + caseworker if the importer types it `partner`, skipping the refusals and cleanup. Same accepted class as D21's unstamped re-import revert; the consequence is new.

### Rejected or downgraded claims

None of the reviewers' P1/P2 claims needed rejecting (there were none). Duplicates were merged (the fake `listByLandlord` gap was reported by three reviewers; the KindPicker role carry and the retry wording by two each). Minor observations recorded but not counted: `findAllByPhone` sees only the first secondary holder of a number (the API's `phone_in_use` guard prevents a second, `contacts.ts:2529-2537`); the AI-note "starts with" match has no word boundary; a whitespace-only agency counts as an agency and is not carried.

## 4. What this review did not do

No code was changed. No full suite or e2e was re-run for this review (the
gate results in `planner-final-review.md` apply; this review changed nothing
they cover). The two layout measurements used Chromium 141 with Linux fonts;
macOS (SF Pro) is expected to clip like Inter, Windows (Segoe UI) may fit with
near-zero slack - not measured. Production data shapes behind SG-1 and SG-2
(how many "Social worker" roles exist; whether imported employers sit in
housingAuthority/agency) were not available.
