# Plan review R1 - reviewer A (caseworkers, branch B)

Plan: docs/superpowers/plans/2026-10-07-caseworkers.md @66cdacf1. Spec rev 14.

SCOPE NOTE (read first): this review covers S1-S4 in depth (every task read,
anchors and named symbols checked against HEAD) plus the S9->S10 handoff and
Task 10.11/10.12. Three delegated sub-reviews (S5+S7, S6+S9, S8+S10) had NOT
returned when this report was forced to hand back. S5, S6, S7, S8, S9 and the
S10 e2e specs are therefore NOT reviewed here; absence of findings for them
means "not examined", not "clean".

## F1 [MEDIUM] Plan cites rulings and a verification note that are not in the plan

What: the plan cites "CONTRACT ISSUE 3/4" (Task 2.4, 2.5 headings), "contract
issue 2/3/6/7" (S3, S4), "CI-2..CI-7" (S10) and, at plan:1131, "see the
verified note at the end of CONTRACT ISSUES". No CONTRACT ISSUES section
exists in the assembled plan (grep finds only the references). The text lives
in the GITIGNORED drafts (.superpowers/sdd/plan-drafts/S1-S2.md:1-63,
S3-S4.md, ...), each draft numbering its own issues from 1, so "contract
issue 2" means different things in S2 and S3.
Implies: a no-context builder (or a fresh worktree, where .superpowers/ is
absent) cannot resolve these citations; the one safety claim that depends on
it (F2) is unverifiable from the plan. Fold the CONTRACT ISSUES lists into
section 3 (or plan-assembly-rulings.md, which is committed) with slice-prefixed
ids.

## F2 [MEDIUM] Task 1.4's mirror test drags the app's AWS/Anthropic module graph into the dashboard typecheck

What: caseworkerRoleMirror.test.ts imports app/src/lib/caseworkers.ts, which
imports CASEWORKER_ROLE from services/extraction/contactKinds.ts
(plan 3.2, Task 1.2). contactKinds.ts type-imports adapters/extraction.ts
(@anthropic-ai/sdk, pino logger) and repos/contactsRepo.ts (node:crypto,
@aws-sdk, lib/config with NodeJS.ProcessEnv: contactsRepo.ts:5-22,
lib/config.ts:499,512). dashboard/tsconfig.json restricts "types" to
vite/client, vitest/globals, jest-dom. Every existing app mirror imports a
leaf module (mediaTypes, retrySendWindow, sendOutcome:
dashboard/src/routes/contact/*Mirror.test.ts). The draft claims a probe
exited 0 (plan-drafts/S1-S2.md:55-63) but the plan does not carry it (F1).
Implies: the dashboard typecheck now compiles ~18 app files under dashboard
compiler settings; any later app change that type-errors there (or a node
types resolution change) turns the DASHBOARD gate red for an app edit.
Cheap fix: define CASEWORKER_ROLE in lib/caseworkers.ts (a leaf importing only
lib/orgNames.ts) and have contactKinds.ts import it from there.

## F3 [MEDIUM] "Every task ends green" is false for e2e between S6 and S10.4, and the S10 start state contradicts the assembly note

What: section 0 says every task ends green. Task 6.5 (landlord timeline
labels) and S9 Tasks 9.1/9.3/9.4 change copy pinned by e2e specs that only
S10 Task 10.4 edits (handoff table, plan:16230-16260: landlord-activity.spec.ts:122,
broadcasts.spec.ts:143/247, steps.ts:1054, matching-entry-points.spec.ts:152/206/235/263,
listing-activity.spec.ts:143/215, share-sent-outcome.spec.ts:671,
share-skip-fix.spec.ts:31/190, org-lists.spec.ts:349/465). "Before Task 10.1"
then says routes.test.ts and mutationCatalog.test.ts are RED at S10 start
(CI-6), while the assembly note at the top of S10 says those steps MOVED into
S8 (8.1, 8.13) and are skip-if-done.
Implies: a builder who runs `npm run e2e` at the CP checkpoint or after S9
sees a red suite the plan calls green; Task 10.1's RED evidence may not exist.
State the e2e red window explicitly in section 0 and fix the S10 start-state
line, or move each pin edit into the task that changes the copy.

## F4 [LOW] Post-conversion landlord-of-record and roster additions are unfenced and unfiled

What: the conversion refuses landlord-of-record and roster seats (Task 3.2),
but nothing afterward stops a caseworker becoming either: units.ts:429 sets
landlordId with no contact-type check, and rosterEdits.ts has no type check
(grep finds only owner type pass-through at :588, :735; full read not done,
partly UNVERIFIED). Spec section 12 and Task 10.12 step 3 file only tours and
placements (`tours-placements-no-contact-type-check`).
Implies: the same refusal-bypass class as tours/placements, unrecorded. Widen
step 3's issue to units and rosters.

## Verified OK (S1-S4)

- Anchors unique at HEAD: contacts.ts "exhausted bounded retries",
  "A2P/CTIA consent capture (spec", parseTriageBody/parseCreateBody two-line
  anchors (:520-521, :786-788), "Structured postal address (edit form)..." (:654),
  the D5 field loop, "ORGANIZATION NAMES (spec 2026-10-06 D5)...",
  `orgNamesService?: OrgNamesService;`, the orgNames const, the vocabulary
  route; api.ts aiExtractionEnabled block (:878-880, `units` local at :644);
  import/apply.ts upsertContact anchors incl. the 3-line UpdateExpression block (:1168-1170).
- Named symbols exist: TERMINAL_STAGES (statusModel.ts:118), isDeleted,
  unitContacts, listSuggestionsByContact, hasOrgControlChar (covers D13's
  invisible chars), checkScalarWrite semantics, FakeWorld fields used, logCapture.atLevel,
  failAuditAppendFor; no tsconfig noUnusedLocals (stub deps are safe).
- Typed full-repo fakes: ContactsRepo (audienceResolution, contactCapture,
  sendMessage, scheduledSendSuppression, harness) and ConversationsRepo
  (contactCapture, sendMessage, scheduledSendSuppression, harness) match S2's
  list; placementNudges/poolNumbers/relayWarm use `as unknown as` casts.
- Contact type/role writers: only the contacts PATCH/POST, importer (type only,
  guarded by Task 4.5), unmatched-email create (no role), public intake,
  capture stubs; extraction never writes type (apply.ts:578-625 suggests only)
  and skips partners (jobs/extraction.ts:457). The edit form builds a diffed
  patch, so server-owned refusals do not break re-saves.
- AI note format matches hasAiCaseworkerNote (apply.ts:145-149, :742 one prefix per line).

## S5-S10

Coverage of this section: S5 Tasks 5.1-5.7 read in full against HEAD; S6
Task 6.1 (outline) and 6.3 (full), both fan-out mint sites checked
(broadcastFanOut.ts:871, :1386); S7 Tasks 7.4 and 7.6 in full, 7.1 header
(7.2, 7.3, 7.5 NOT read in depth); S8 assembly notes, Tasks 8.5, 8.8, 8.9 in
full, 8.3 (organization send logic), 8.12 (design), 8.13 (outline) - 8.1, 8.2,
8.4, 8.6, 8.7, 8.10, 8.11 only skimmed; S9 Task 9.6 in full; S10 Tasks
10.5 and 10.7 (setup and assertions), 10.9 vs 9.6. The shares sub-review
(S6, S9, share parts of S10) returned; its findings 1-4 below were
re-verified by me (cited lines). The S5+S7 and S8+S10 sub-reviews did NOT
return; their slices are covered only to the depth stated above.

## F5 [HIGH] Task 9.6 makes three PartnerFile props required but never wires S8 Task 8.9's new test render

What: Task 9.6 adds REQUIRED props `units`, `listingsSentPending`,
`listingsSent` to PartnerFile and dereferences them unconditionally
(`new Map(units.map(...))`, `listingsSent.length`; plan ~16100-16150). It
updates only the original `renderIt` in files.test.tsx (anchor
`groupThreadsTruncated={false}` + `/>`, files.test.tsx:563-564) and hedges
"If S8 rewrote this renderIt". S8 Task 8.9 did not rewrite it: it APPENDED a
new `renderPartner` (plan 13086-13097) passing none of the three. 9.6's
GREEN runs `npx vitest run src/routes/contact src/routes/broadcasts` and
`npm run typecheck` (plan ~16210-16212).
Implies: at 9.6 the four S8.9 cases crash (`units` undefined) and the
dashboard typecheck fails TS2741; the plan's claim that typecheck "proves the
required props are wired at the one <PartnerFile call site" is false (three
sites after S8). Fix: 9.6 adds the three props to `renderPartner` too.

## F6 [MEDIUM] Task 9.6's PartnerFile header-comment anchor is deleted by Task 8.9

What: 9.6 quotes "// Preferences & notes, and Media from comms. Deliberately
omits the tenant cards" / "(voucher / housing authority / listings-sent /
...". S8 Task 8.9 (plan 13141-13166) replaces PartnerFile.tsx:1-15 wholesale
with different text; 9.6's own "keep S8's text" hedge still quotes HEAD.
Implies: a literal Edit fails; the header ends up never mentioning
Properties sent.

## F7 [MEDIUM] Task 10.9 collides with Task 9.6 on e2e/support/selectors.md

What: 9.6 step 3 (plan ~16188-16208) already rewrites the em-dash
"| Thread | send |" row (selectors.md:45) and inserts a "Contact page |
Properties sent card" row and a "Property page (Sent to card)" row. 10.9
Step 1 targets the ORIGINAL em-dash line 45 (gone) and Step 2 adds "Partner
page | Properties sent..." and "Property page | the 'Sent to' card" rows that
duplicate 9.6's with a different regex (`/Properties sent/` vs
`/^Properties sent/`). S10's assembly notes give 10.9 no skip-if-done.
Implies: the Edit fails, or the selector contract ships duplicate,
conflicting rows.

## F8 [MEDIUM] Two doc lines the handoff assigns to S10 are edited by no task

What: the S9->S10 handoff (plan 16258-16261) says S10 owns
documentation/GLOSSARY.md:120 ('offers "Send to tenants"') and
documentation/sequence-diagram-to-test.md:135 ('"Send to N tenant(s)"').
Both texts exist at HEAD; no S10 task (10.10 included) edits either - the
only plan mention of sequence-diagram-to-test.md is the handoff line.
Implies: GLOSSARY keeps the retired label, against AGENTS.md's rule that
GLOSSARY changes in the same change as the wording.

## F9 [MEDIUM] S8's binding note contradicts its own code on where isCaseworkerContact lives

What: the S8 assembly note (plan 10118) says `isCaseworkerContact` lives in
caseworkerRole.ts and "every importer imports it from there", overriding the
task text; Task 8.3's code defines it in CaseworkerDialog.tsx (plan 11355)
and Tasks 8.3/8.5/8.8/8.12 import it from './CaseworkerDialog.js' (plan
10933, 11988, 12878, 14144).
Implies: a literal builder must re-target five import sites and a test
import by hand from a header note.

## F10 [LOW] Settings "+N deleted" counts column hits, not deleted records

What: Task 5.3's tally does `if (deleted) row.deleted += 1` once per hit
(plan ~6950); a deleted tenant holding a name as housingAuthority AND
organization counts 2, while Task 7.4's Delete dialog total reads the
distinct `inUse` (1). Spec D10 shows "the count of deleted records".
Implies: "1 record still holds this name (..., 2 deleted)". Use
`inUse.deleted` for the displayed deleted count, or count distinct.

## F11 [LOW] Task 10.7 finds its unknown contact on page 1 of an unordered list

What: `findUnknownContactId` polls `GET /api/contacts?type=unknown` with the
default limit 50 (contacts.ts:377, :1010) over byTypeStatus, unordered within
a status; the exact `?phone=` lookup exists (contacts.ts:992-1001).
Implies: a flake once the lane holds over 50 unknowns; mitigated today by the
spec's beforeAll reseed. Use `?phone=`.

## F12 [LOW] Stale tenant-only share wording the plan does not name

What (verified): dashboard/src/routes/contact/Card.tsx:193-195 doc says
"Sent to tenants"; RUNBOOK.md:179, 376, 386, 415 say "Sent to tenants".
Implies: comments and operational docs name a heading that no longer exists.

(F13-F17 come from the S8+S10 sub-review, which returned after F5-F12 were
written; each was re-verified by me at the cited lines.)

## F13 [HIGH] Task 8.13's new AppFrame order test can never pass

What: the replacement "Contacts is a parent ..." test reads the child order
with `getAllByRole('link').map((a) => a.getAttribute('aria-label'))` (plan
14546). Child nav links carry no aria-label: NavContents.tsx:97-107 renders
`<NavLink key to className onClick>` with the label as a child span; only the
parent link sets `aria-label={item.label}` (NavContents.tsx:55).
Implies: the four children read null, the filtered list is [], and the
`toEqual(['Tenants','Landlords','Caseworkers','Unknown'])` stays red after
GREEN; Task 8.13 cannot commit green as written. Use textContent / accessible
name instead.

## F14 [HIGH] Task 8.9 breaks an existing e2e assertion that no task fixes

What: 8.9 adds `<KV k="Role" v={displayKind(...)} />` to PartnerFile, which
renders "Partner" for a role-less partner, beside the header pill that already
reads "Partner". e2e/tests/flows/conversation-fact-extraction.spec.ts:342
asserts `page.getByText('Partner', { exact: true })` right after Mark as
Partner - it now resolves two elements (strict-mode violation). No S8, S9 or
S10 task edits that line; Task 10.13 expects 0 failed and its triage list
does not name this cause.
Implies: the e2e gate is red from 8.9 and the failure surfaces only in the
final full run, where it reads as a regression. Scope the assertion (header
pill) in Task 8.9.

## F15 [MEDIUM] The dialog's leftOther sentence contradicts binding plan 3.9

What: plan 3.9 (plan:414, BINDING, and S8's assembly note says "verbatim")
fixes "1 conversation without a type stays as it is." / "<n> conversations
without a type stay as they are."; Task 8.3's RED test and implementation use
"1 other conversation stays as it is." / "<n> other conversations stay as
they are." (plan 11027, 11460-11461).
Implies: a literal build ships copy 3.9 forbids, or the builder rewrites
both test and code by hand.

## F16 [MEDIUM] Tasks 10.1 and 10.2 redo S8 work with different anchors and impossible REDs

What: S8 (8.1, 8.13) already adds the two mutation-catalog entries (after
`runOrgRewriteAgain`, plan 10248-10284), the route exclusion, the TODO, the
issue file and the contact-create.spec.ts:201 fix. Task 10.1 Step 1 still
expects "2 failed tests ... Any other failure: stop and report" (plan
16395) and Step 4 inserts after `runExtraction` (plan 16453), a different
anchor; 10.2 Step 1 expects 1 failure at :201. The assembly note says
skip-if-done but gives no detection rule matching 8.x's placement.
Implies: a literal builder stops on a RED that is green, or adds duplicate
catalog entries / a second TODO (the duplicates trip
mutationCatalog.test.ts fingerprint uniqueness).

## F17 [LOW] CaseworkerConversionRecord.by is documented two ways

What: plan 3.2 (plan:175) says `by` is the actor's userId; Task 2.1's
ContactItem doc (plan 1521) and Task 8.1's dashboard mirror (plan 10369) say
"The actor's email". The route passes `req.user?.userId` (Task 4.4).
Implies: two shipped doc comments are wrong; RUNBOOK readers may look for an
email.
