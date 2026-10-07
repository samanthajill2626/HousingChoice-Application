# Plan review R1 - reviewer B (adversarial): caseworkers (branch B)

- Plan: `docs/superpowers/plans/2026-10-07-caseworkers.md` (worktree HEAD 66cdacf1)
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md` rev 14, branch B only
- Method: every D16-D22 decision and every (B) line in D6, D10, 5.2, 6, 9, 10,
  11, 12 walked to a task; mutation surfaces and readers grepped in `app/`,
  `dashboard/`, `e2e/`; a mechanical pass over all 265 "Current"/"replace"
  anchor blocks in the plan against the tracked files at HEAD (11 do not
  exist verbatim; 7 of those are text an earlier task creates, the rest are
  listed below); spot reads of the code each sampled anchor touches. No test
  suite was run. One read-only `tsc` probe (scratchpad tsconfig extending the
  main checkout's `dashboard/tsconfig.json`) confirmed the dashboard compiler
  accepts the app `contactKinds.ts` -> `contactsRepo.ts` type graph the S1
  mirror test pulls in (exit 0).

Overall: coverage of the spec is close to complete and the server slices
(S1-S6) are anchored with unusual care - the large majority of sampled
anchors exist and are unique, the harness/fake fallout is enumerated, and the
RED claims I checked hold. The defects are concentrated where slices meet
(S8/S9 on PartnerFile, S8 on its own binding notes, S10's opening state) and
in a handful of undefined conventions. Nothing found would ship a wrong
server invariant if the builder fixes the red gates it will hit; one finding
would ship wrong user copy silently.

---

## 1. [HIGH] S9.6 makes three PartnerFile props REQUIRED but S8.9's new test helper never passes them: S9.6 ends with red unit tests and a red dashboard typecheck that the task says are green

**What is wrong.** Task 8.9 appends a new describe to
`dashboard/src/routes/contact/files.test.tsx` whose `renderPartner` helper
renders `<PartnerFile contact phones media groupThreadsPending groupThreads
groupThreadsTruncated {...onContactUpdated} />` (plan:13085-13098). Task 9.6
then adds `units: UnitItem[]`, `listingsSentPending: boolean` and
`listingsSent: ListingSendRow[]` as REQUIRED props (plan:16066-16076, "a
forgotten wiring is a typecheck error") and renders
`listingsSent.length === 0` (plan:16126) and
`new Map(units.map(...))` (plan:16144) unconditionally. S9.6 patches only the
PRE-EXISTING `renderIt` ("Current (unique in the file):
`groupThreadsTruncated={false}` / `/>`", plan:15848-15866; the parenthetical
covers only "If S8 rewrote this `renderIt`") and its new `renderSent`.

**Evidence.**
- At HEAD the file has exactly one `groupThreadsTruncated={false}` followed by
  `/>` (`dashboard/src/routes/contact/files.test.tsx:563-564`); after S8.9 a
  second render exists whose next line is the `onContactUpdated` spread, so
  S9.6's anchor still matches only the old helper and S8.9's helper is left
  without the three props.
- At runtime `units` is `undefined` -> `units.map` throws on every S8.9 case
  (4 tests: "Details shows the Role and the Organization", "a partner with no
  role reads Partner...", "shows the Staff notes card...", "without a handler
  the Staff notes card is read-only").
- `npm run typecheck` compiles dashboard tests (`dashboard/tsconfig.json`
  `"include": ["src", ...]`), so TS2741 (missing required props) fails the
  dashboard workspace.
- S9.6 asserts the opposite: "Run: ... npx vitest run src/routes/contact
  src/routes/broadcasts - GREEN" (plan:16210) and "typecheck - exit 0
  (proves the required props are wired at the one `<PartnerFile` call
  site)" (plan:16211-16212). There are four call sites after S8.9 (two test
  helpers in files.test.tsx, S9.6's `renderSent`, and ContactDetail).
- Same task, same collision: S9.6's header-comment edit quotes HEAD's
  PartnerFile lines "// Preferences & notes, and Media from comms.
  Deliberately omits the tenant cards" (plan:16145-16152), but S8.9 already
  replaced that whole header block (plan:13141 onward replaces the text quoted
  at plan:13147). The anchor no longer exists when S9.6 runs; S9.6's hedge
  ("keep S8's text and change only these lines") names lines S8 deleted.

**Implies.** This is exactly the false independence the slice notes claim to
have coordinated ("runs after S8 ... see the coordination note"). A literal
builder hits a red gate the plan says is green and must improvise both the
props fix and the header rewrite; a builder following "any other failure:
STOP and report" stalls the slice. Fix in the plan: S9.6 must add the three
props to S8.9's `renderPartner` too (or make the props optional with
defaults), correct the call-site claim, and re-anchor the header edit on
S8.9's replacement text.

## 2. [MEDIUM] Task 8.3's CaseworkerDialog code AND its test pin the wrong `leftOther` sentence; the binding copy table says otherwise and no later gate checks it

**What is wrong.** Plan 3.9 (binding: "unit tests and e2e use these") fixes
the leftOther lines as "1 conversation without a type stays as it is." /
"<n> conversations without a type stay as they are." (plan:414). Task 8.3's
GREEN component writes "1 other conversation stays as it is." / "${leftOther}
other conversations stay as they are." (plan:11458-11462) and its RED test
asserts `getByText('1 other conversation stays as it is.')` (plan:11027).
The S8 assembly note says the count sentences "including the `leftOther`
line, are plan 3.9 verbatim (S8-4)" and overrides the task text
(plan:10120).

**Evidence.** plan:414 vs plan:11027 and plan:11458-11462; override note at
plan:10114-10121. S10's selector contract checks only the re-type line
(C11, `UI.retypesOne`), not the leftOther line, and no other unit test reads
it.

**Implies.** The task's test and code agree with each other and disagree with
the binding table, so a builder who copies the task (the normal way to
execute a TDD task) gets a GREEN test pinning the wrong copy, and nothing
afterward fails. Staff then read "other conversation" for what the server
counts as a TYPE-LESS thread (`leftOther = type-less rows only`, plan:206),
which is materially less informative. The plan's own text must be corrected,
not left to an override note.

## 3. [MEDIUM] Undefined glyph placeholders (`{--}`, `{"}`) inside "Current" anchors: the quoted text does not exist in the files

**What is wrong.** Several anchors substitute ad-hoc tokens for the em dash
and curly quotes the files actually contain, and the plan never defines the
convention (section 0 defines ASCII and the `\u` Edit-tool trap, nothing
else):
- plan:15783-15786 (Task 9.5): `Start one from a property&apos;s {"}Send to
  tenants{"}, from a tenant&apos;s {"}Properties` / `sent{"}, or with {"}Send
  a property{"}.` - the file has U+201C/U+201D
  (`dashboard/src/routes/broadcasts/BroadcastsList.tsx:132-133`).
- plan:15542 (Task 9.4): `setError('Nothing selected {--} check at least one
  tenant to send.');` - file has U+2014
  (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:294`).
- plan:8524, plan:8800, plan:14998 (Tasks 6.4, 6.4, 9.1): `{--}` in quoted
  current lines of `listingSendsApi.test.ts`, `routes/units.ts` and
  `ListingDetail.tsx`.

**Evidence.** The mechanical anchor pass found the Task 9.5 block absent from
every tracked file; the others are inline "Current `...`" quotes with the same
token. `cat -A` of BroadcastsList.tsx:132 shows the UTF-8 curly-quote bytes.

**Implies.** An Edit with these old_strings fails. The failure is loud, so the
risk is improvisation rather than silent corruption - but the improvisation
is exactly where the PowerShell rewrite / `\u` decode traps section 0 warns
about get triggered. Define the tokens in section 0 (and say "match the line,
retype it ASCII") or quote the anchors as a unique ASCII substring of the
line.

## 4. [LOW] `isCaseworkerContact`'s home is contradicted in four places; the binding note says one file, three tasks import from another

**What is wrong.** The S8 assembly note: `isCaseworkerContact` lives in
`caseworkerRole.ts` and "every importer imports it from there" (plan:10118).
Task 8.3 defines and exports it from `CaseworkerDialog.tsx` (plan:11355-11360)
and its test imports it from there (plan:10933); Task 8.5 step (b) imports it
from `./CaseworkerDialog.js` (plan:11988); Task 8.8 step (b) likewise
(plan:12878). Plan 3.1's file table also says S8 Task 8.3 adds it to
`caseworkerRole.ts` (plan:124).

**Implies.** A builder who follows the note in 8.3 then hits typecheck errors
in 8.5 and 8.8 (or vice versa). Recoverable, but the plan should say one
thing.

## 5. [LOW] S10's stated starting state and Task 10.1's RED contradict the binding move of 10.1's steps into S8

**What is wrong.** "Expected state at S10 start ... the e2e workspace's
`routes.test.ts` and `mutationCatalog.test.ts` are red (CI-6)" (plan:16299-
16302), and Task 10.1 Step 1 expects exactly "2 failed tests ... Any other
failure: stop and report" (plan:16399-16411). But the S10 assembly note says
those steps were MOVED into S8 Tasks 8.1 and 8.13 (plan:16275), and both
tasks do make those exact edits (Task 8.1 files list includes the
mutationCatalog pair; Task 8.13 edits `routes.test.ts`, `routes.ts` and
creates `docs/issues/perf-pages-contacts-caseworkers-surface.md`). Task 10.1
Step 6 then says "create" the same issue file again.

**Implies.** At S10 start both files are green; the RED the task requires
cannot be produced, and a literal "create" of the issue file overwrites S8's.
The skip-if-done note makes it recoverable; the opening checklist should be
corrected so a builder does not stop on a green.

## 6. [LOW] `CaseworkerConversionRecord.by` is documented two ways; the code comment the plan writes is wrong

**What is wrong.** Plan 3.2 (binding interfaces): `by: string; // the actor's
userId (as audit rows record actors)` (plan:175). Task 2.1's GREEN writes the
repo doc comment `/** The actor's email. */` (plan:1521) and Task 8.1 mirrors
the same into `dashboard/src/api/types.ts` (plan:10369). The route passes
`req.user?.userId` (Task 4.4) and the API test asserts
`by: TEST_SESSION_USER.userId`.

**Implies.** The shipped type docs say "email" while the stored value is a
userId; the RUNBOOK "put a mistaken conversion back" procedure (Task 10.11)
tells staff to read `by`. Fix both comments to "userId".

## 7. [LOW] Landlord-timeline wording deviates from the spec's literal D22 line without the spec being amended

**What is wrong.** Spec D22 "Share wording": "'No recipients reached' on the
property Activity and BOTH landlord-timeline label sites; every share label
keeps the 'Sent to ' prefix." Plan 3.7 (binding) and the S9 assembly note
make the stored-count site (`app/src/routes/contactTimeline.ts:762-764`) say
"Sent to 0 recipients" and reserve "No recipients reached" for the recount
site only (plan:385-388, plan:14839).

**Evidence.** The plan's reading is the defensible one - the relabel
predicate `m.label.startsWith('Sent to ')`
(`app/src/routes/contactTimeline.ts:1467`) would lose a zero-count pin
otherwise - but it contradicts the spec sentence as written.

**Implies.** A reviewer checking the build against the spec will flag it as a
defect. Record the ruling in the spec (D22 is the "more precise" line the
plan is overriding), not only in `plan-assembly-rulings.md`.

## 8. [LOW] Make on an already-caseworker silently drops a staff-picked organization, and the dialog still offers the picker

**What is wrong.** Rule 2 / Task 3.5: on `isCaseworker(c)` the service runs
the repair path and "A request organization is ignored here" (plan
Task 3.5 GREEN `make`), answering 200. The dialog (Task 8.3) renders the
Organization picker regardless of `preview.alreadyCaseworker` and sends
`organization` when changed.

**Evidence.** Reachable from the Possible list when a row is stale (another
user converted the contact after the list loaded): the preview returns
`alreadyCaseworker: true, refusals: []`, Confirm is enabled, the staff pick
is posted and discarded, and the dialog closes as a success.

**Implies.** Spec-compliant on the server (D19: "make on a caseworker re-runs
steps 2-4 only"), but the UI lets staff believe they set an organization. Hide
the picker (or say "already a caseworker - edit the organization on the
partner page") when `alreadyCaseworker` is true; no server change.

## 9. [LOW] Dangling cross-reference in Task 1.4

Task 1.4 GREEN says the dashboard typecheck compiles the app graph "see the
verified note at the end of CONTRACT ISSUES" (plan:1131). No such note
exists anywhere in the plan (grep for "CONTRACT ISSUES" finds only slice
headers). The claim itself is true (my tsc probe exits 0), but a builder told
to consult a missing note may stop. Delete or point to the real record.

## 10. [LOW] The plan never runs the AGENTS.md completion gates it ends on

**What is wrong.** The last full unit gate is the CP after S6 (plan:8976).
S7-S10 run only per-file vitest, workspace typecheck and the e2e suite
(Task 10.13). `npm run smoke` never appears in the plan; gate 5 (eslint over
`git diff --name-only --diff-filter=d main...HEAD`) and the single main sync
are never scheduled; full `npm test` is never re-run after S7-S9 touch
`dashboard/src/api/types.ts` (which plan S8 notes the app compiles) and the
e2e-workspace pins.

**Implies.** If the build orchestrator owns gates this is only a gap in the
handoff; if a builder executes the plan literally, the branch is declared
done without gates 2 (post-dashboard), 3 and 5. One closing task listing the
five bare gates and the sync closes it.

---

## Coverage walk (no finding unless listed above)

- D16: canonicalizer (1.1), helpers (1.2, 1.4), KindPicker segment / offer
  gate / mentions datalist / placeholder (8.2, 8.4, 8.5), Unknown card order
  (8.6), More actions (8.7, 8.8), PATCH 409 on the merged kind with a
  consistent read (4.3). Covered.
- D17: `KINDS_FOR_FIELD.organization` (1.3), PATCH D5 both kinds and '' ->
  REMOVE (4.2), POST still ignores (4.2 pin), usage column + `inUse` /
  `kindLocked` (5.3, 7.4), rename/merge organization LAST (5.2),
  not-on-list rows + resolve `kind` + Run again both kinds (5.4, 5.5, 7.5),
  `/check` `kinds` (5.6, 7.1-7.3), dev seam (5.7), partner page + edit form
  picker (8.5, 8.9). Covered.
- D18: tab, chips, nav child, profiler exclusion + issue (8.11-8.13). Covered.
- D19: domain incl. pointer rows (3.2), refusals incl. deleted units (2.5,
  3.2), organization derivation + carry limits (3.3), five-clause commit
  guard (2.1, 3.5), steps 2-4 + repair (3.1, 3.6), dismiss (3.7), possible
  list + signals (3.8), routes (4.4), dialog (8.3), RUNBOOK (10.11). Covered
  (findings 2, 8).
- D20: seeds + explicit list accept partners (6.1), voucher facts tenant-only
  (6.2), both mint sites (6.3), recipients `type`/`role` (2.3, 6.4), every
  wording site I could grep in `dashboard/src/routes/{broadcasts,listing}`
  and the landlord timeline (6.5, 9.1-9.5), PartnerFile card + Send (9.6),
  e2e pins (S9->S10 table matched my grep of `e2e/`). Covered (findings 1, 3,
  7).
- D21: `type_source` stamping + refusal (4.1, 4.3), importer guard (4.5),
  generic flip unchanged, conversion re-type with all-holders read (2.2, 2.4,
  3.4, 3.6), header facts by type (8.8). Covered.
- D22: matching, signals, route domain, commit guard, ids in refusals, POST
  refusals, UI placement, usage totals, share wording. Covered.
- Section 12 B follow-ups: six issue files + staff-notes update (8.9, 10.12).
  Covered.

## Surfaces checked and found enumerated (no finding)

- Contact type/role writers: contacts PATCH and POST
  (`app/src/routes/contacts.ts:1449`, `:1063`), unmatched-email create
  (`app/src/routes/unmatchedEmail.ts:462`, typed, no role), public intake
  (`app/src/routes/public.ts:257`), `createIfAbsent` stubs
  (`contactCapture.ts:111`, `groupConvert.ts:347`, `groupMembers.ts:155`,
  all unknown), importer (`app/src/lib/import/apply.ts` writes no `role`;
  `merge.ts:410-413` types caseworker-marked rows `partner` with no role ->
  `partner_no_role`), extraction apply (no role writes), suggestion accept
  (`suggestionResolution.ts:269` refuses `type`). None can make a caseworker
  of an existing contact except the conversion.
- Conversation type mint sites: `broadcastFanOut.ts:871`, `:1386` (6.3),
  `routes/contacts.ts:472` (by contact type), webhooks/inbound email (by
  contact type), `public.ts:285` (spec exception), seeds.
- Readers of thread type that a conversion changes:
  `tourReminders.ts:1093`, `routes/tourReminders.ts:1027`,
  `contactTimeline.ts:947`, `routes/contacts.ts:2397`, `twilio.ts:2670`,
  `inboundEmail.ts:817`, `today.ts:815-817` - all safe given the refusals or
  covered by section 12 filings.
- Org usage readers: `routes/organizations.ts:116-143`, dashboard
  `orgCopy.ts` (`usageTotal`, `rewriteCountsText` COUNT_LABEL - 7.1/7.4 add
  the organization key), `listingFormat.ts:213` (units only).
- `type_source`, `caseworker_review`, `caseworker_conversion` readers: only
  the importer, the possible-caseworkers read and the RUNBOOK; no dashboard
  path spreads a stored contact into a PATCH (`updateContact` callers in
  `dashboard/src` checked).
