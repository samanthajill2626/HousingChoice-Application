# Plan review R1 (reviewer A) - share-skip-fix Branch A implementation plan

Plan: `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (v1, commit a0e594b5).
Spec: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A, v8).
Method: adversarial, read-only. Every claim about existing behavior cites a
file:line read in this worktree at a0e594b5. Anything not verified is marked
UNVERIFIED. The question asked: if a builder with no context executes this plan
literally, do they produce the spec?

Short answer: the backend and dashboard logic tasks (6-11) are mostly right and
their anchors are accurate. The plan fails at its proof layer: both new e2e
tests are broken or prove nothing new, the D8 e2e repin makes a currently-green
spec flaky, the slice-1 rehearsal cannot reach the lane it names (and points at
the human's live-stack database instead), and the final main sync merges a
stale ref.

---

## 1. [HIGH] Task 14 test 2 cannot pass: an opted-out recipient never reaches the fan-out

What is wrong. Test 2 makes a tenant opt out with an inbound STOP, then creates a
seeded draft and posts `/send` with `recipientContactIds: [stopped.contactId]`,
expecting `send.ok()` and later a "Not sent" share with an "Opted out of texts"
row. The plan's justification (plan line 3135-3137: "the seeded path sends to the
explicit id") is false. The send route's explicit-selection path re-applies the
hard fences and drops a contact whose `sms_opt_out` is set; with nobody left it
returns 400 `empty_audience`.

Evidence.
- `app/src/routes/broadcasts.ts:660` `if (contact.sms_opt_out === true) continue; // HARD exclusion (re-enforced)`; `:670-673` empty set -> `400 empty_audience`.
- `app/src/routes/broadcasts.ts:340-348` `resolveSeeds` drops the same contact from the draft's seeds.
- An inbound STOP from a contact's primary number sets the CONTACT flag: `app/src/services/numberSuppression.ts:160-161` (`setFlag(contact.contactId, 'sms_opt_out')` when scope is primary); the test tenant's phone is its primary (created by POST /api/contacts).
- Plan line 3143-3146 asserts `expect(send.ok()).toBeTruthy()`; the fallback notes at plan line 3164 cover a conversation-only opt-out and a strict-mode collision, never this refusal.

What it implies. `npm run e2e` (gate 4) is red at Task 14 and the builder must
redesign the test with no guidance. Until then no end-to-end test proves D6
("Not sent") or D7 (a reason on a skipped row), both required by spec section 7.
A shape that works after D4: a tenant with NO recorded consent sent through the
explicit-selection API path. The route does not fence consent, the fan-out's
consent fence skips it as `no_consent` ("No texting consent recorded"), and the
one-recipient share is all-skipped. `e2e/tests/dashboard-next/a2p-compliance.spec.ts:434-493`
already drives exactly this fence through the API.

## 2. [HIGH] The D8 e2e regexes anchor the flyer link at `/p/<unitId>$`, but the real link ends `?cta=text`

What is wrong. Three new e2e assertions require the one-to-one text to END with
`/p/<unitId>`:
- plan line 2789 (the Task 12 repin of `matching-entry-points.spec.ts`),
- plan line 3080 (Task 14 test 1, first share),
- plan line 3105 (Task 14 test 1, second share).

The server's flyer link is `${base}/p/${unitId}?cta=text`, and the composer swaps
to the server link as soon as the draft exists.

Evidence.
- `app/src/lib/mergeFields.ts:28-30` returns `` `${base}/p/${unitId}?cta=text` ``.
- `app/src/routes/broadcasts.ts:474` returns it as `flyerUrl` on draft create; `dashboard/src/routes/broadcasts/useComposerDraft.ts:179` stores it; `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:189` prefers `draft.flyerUrl` over the same-origin fallback and the effect re-seeds on `draft.flyerUrl` change (`:196`).
- `dashboard/src/routes/broadcasts/BroadcastComposer.prefill.test.tsx:52-55` mocks the draft response with exactly `https://example.test/p/unit-0001?cta=text`.
- The existing assertion the plan replaces is deliberately unanchored: `e2e/tests/dashboard-next/matching-entry-points.spec.ts:134` `new RegExp(`/p/${unitId}`)`.

What it implies. The anchored regex matches only the transient pre-draft text
(same-origin fallback link, visible for roughly the 600 ms draft debounce plus a
round trip). Playwright's polling either catches that transient and passes on a
value that is overwritten a moment later, or misses it and fails after 10 s. A
spec that is green today becomes flaky. The D8 proof asserts a value that never
sends. The composer unit-test regexes (plan line 2764) pass only because that
file's default `createBroadcast` mock carries no `flyerUrl`
(`BroadcastComposer.test.tsx:85-87`), so they give false comfort. Fix: drop the
`$` anchor, or anchor on `/p/<unitId>(\?\S*)?$`.

## 3. [HIGH] The stage resolver hard-codes access key `local`, so the Task 5 rehearsal cannot reach an e2e lane and lands in the human's live-stack database

What is wrong. For `--env local`, `resolveStageClient` always builds the client
with `credentials: { accessKeyId: 'local', ... }` (plan line 250). `--prefix`
changes only table names. DynamoDB Local here runs without `-sharedDb`, so each
access key is a separate database. The e2e lane's `hc-local-<L>-*` tables live
in database `hclane<L>`. Database `local` is the human's live `npm run dev -- --local` stack.

Evidence.
- `scripts/db.mjs:28` (no `-sharedDb`: one database per accessKeyId and region).
- `e2e/support/lane.mjs:159-160` (lane 0 / the live dev stack "rides the 'local' credential fallback"); `:166-168` `laneAccessKeyId(lane)` -> `hclane<L>`; `:308` the lane result carries that key.
- `scripts/e2e-session.mjs:119-125` forces `AWS_ACCESS_KEY_ID: accessKeyId` (the lane key) for every lane child, and says an ambient key "would silently merge every lane back into ONE database".
- `app/src/lib/dynamo.ts:66` app clients use `process.env.AWS_ACCESS_KEY_ID ?? 'local'`. The plan's resolver ignores the env var entirely.

What it implies.
- Task 5 Step 2 (plan line 1473-1485) cannot produce its expected output: the census Scan of `hc-local-<L>-conversations` in database `local` fails with ResourceNotFoundException (UNVERIFIED only in that stale `hc-local-<L>-` tables might exist in database `local` from the pre-2026-07-02 `-sharedDb` era, in which case the census reads the wrong data and the `--apply` step WRITES into the live-stack database).
- The natural "fix" for a builder who hits ResourceNotFound is to drop `--prefix`. That is `--env local` against `hc-local-` in database `local`: Cameron's live local stack, with `--apply`. Global Constraints line 16 permits agents `--env local` without that caveat.
- The stage-resolver test at plan line 120-125 ("never the live hc-local- stack") asserts only the prefix string, so it certifies the unsafe behavior.

Fix: the local stage must also take the lane's access key (derive `hclane<L>`
from `hc-local-<L>-`, or add an explicit `--access-key`), refuse a lane prefix
with key `local`, and test that pairing.

## 4. [MEDIUM] Task 15 "syncs main" by merging `origin/main`, which is 11 commits behind local `main`

What is wrong. Task 15 Step 1 runs `git fetch origin main; git merge origin/main`
(plan line 3191-3192). In this repository `origin/main` lags the local `main`
that AGENTS.md's gates and this repo's merges use.

Evidence (read-only git, 2026-09-25): `git rev-list --left-right --count main...origin/main` = `11 0`
(local main is 11 ahead). `origin/main` = 185545f0 (2026-09-10). `main` = cd8e8ddd.
`git merge-base --is-ancestor main HEAD` is false. `origin/main` is already an ancestor of the branch, so the merge is a no-op.
AGENTS.md gate 5 diffs against local `main` (`main...HEAD`).

What it implies. The branch reaches handback without the latest main (today:
the relay WARN fix 685f2ede and the 30003 rulings). The gates run against a stale
base, and the handback records a sync that did not happen. The plan itself
anticipates `feat/retry-send-window` / `feat/send-outcome-reconcile` landing
first (plan line 3195). That is exactly the case where a skipped sync ships an
untested combination. Merge local `main`.

## 5. [MEDIUM] The fix script writes the switch and its audit event non-atomically; a failed append leaves an unaudited, unlogged switch (I6)

What is wrong. `enable()` issues the conditional `UpdateCommand` first, then
`audit.append(...)` (plan line 1141). `result.enabled += 1` and the
"conversation switched on" log line (the only place the id is printed) come after
the append (plan line 1147-1148). If the append throws (throttling, a transient
fault), the error aborts the run. The PARTIAL report carries counters only, and
this row is not among them.

Evidence. Plan line 1113-1150; the PARTIAL catch at plan line 1090-1098 logs `{...result}` with no id.
Spec I6 (spec line 317-318): "D2 only ever turns switches on ... and audits every change";
spec D2 (line 159-160): "Every switch it turns on gets a `mode_changed` audit event".

What it implies. A production row can end up `auto` with no audit event and no
log line naming it. A re-run classifies it `alreadyOn` (plan line 1070), so it is
never audited. Use one `TransactWriteItems` (conditional Update plus the audit
Put), or at minimum log the id before the append and on its failure.

## 6. [MEDIUM] No e2e test proves the headline #5 fix: a skipped earlier share is no longer "Already sent"

What is wrong. Spec section 7 (spec line 379-385) requires, end to end: "a tenant
whose earlier share was skipped is not 'Already sent' on the next share of the
property, while one whose text went out (or failed - the interim rule, pinned as
such) is". Task 14 covers only "went out -> Already sent". There is no skipped
case and no failed pin. Test 1's second half (plan line 3102-3116) passes on the
CURRENT code: a seeded row already starts checked when flagged.

Evidence. `dashboard/src/routes/broadcasts/RecipientPreview.tsx:79` `checked: c.has_consent && (c.seeded || !c.alreadySentThisProperty)` is existing code.
The only new thing test 1 proves for D5 is the note copy. The plan's Task 14
header comment (plan line 2994-3000) and self-review (plan line 3217) claim D5 coverage.

What it implies. Sam's reported symptom (the review list marks the skipped
tenant "Already sent") has unit and route coverage (Task 8) but no acceptance
proof, contrary to the spec. A feasible shape: send a no-consent tenant (skipped
`no_consent`, see finding 1), record consent, open a new share of the same
property, and assert the row is not flagged. For the failed pin, use a tenant
whose send fails.

## 7. [LOW] Task 7's sendMessage I8 test uses a fixture API that does not exist

`f.contacts.push(...)` (plan line 1925-1934) is not on the fixture. `makeFakes`
takes a single `contact` override (`app/test/sendMessage.test.ts:55-87`), and its
fake `findByPhone: async () => contact` ignores the phone (`:200`). Two contacts
on one phone cannot be expressed by "adapting the calls" (plan line 1941). The
fixture must gain a second contact for `getById`. That is a test-infrastructure
change the plan does not state.

## 8. [LOW] Task 7's sendMessage edit instruction contradicts itself

Plan line 1994 says to replace the block "from `const contact = await contacts.findByPhone(...)`
through the JIT consent gate" with a snippet that ends at the opt-out throw.
Plan line 2019 then says "Keep the deleted gate and the JIT consent gate exactly
as they are". A literal replace deletes both gates (`app/src/services/sendMessage.ts:320-344`).
Existing sendMessage tests would catch it, but the instruction should say
"replace the lookup and the opt-out gate only".

## 9. [LOW] The new fan-out deleted fence runs before the opt-out fence, inverting the wrapper's documented precedence

Plan line 2021 places the deleted fence "BEFORE the first fence". The wrapper
orders opt-out first, then deleted: "softer than opt-out (TCPA wins)"
(`app/src/services/sendMessage.ts:320-323`). Under the plan, a recipient who is
both soft-deleted and opted out reads "Contact was deleted" and is counted in
`skipped_other` instead of opted-out. That is the kind of misfiling D7 exists to
stop. Put the deleted fence after the opt-out fence.

## 10. [LOW] Task 6 misses one test that its change breaks

`app/test/deriveBroadcastStats.test.ts:28-52` ("computes every bucket from the
map") asserts the derived object with an exact `toEqual` that has no
`skipped_other`. After Task 6 derives `skipped_other: 0`, it fails. Plan line 1772
names only `broadcastApi.test.ts:1220-1229` and says Step 6 expects PASS.
Discoverable, but the plan's list of touched tests is incomplete.

## 11. [LOW] Several of Task 7's "failing" tests are green before any implementation

Step 4 (plan line 1945-1946) expects FAIL. Four of the new tests pass on the
pre-Task-7 code:
- I1 (c-del is already refused by the wrapper's deleted gate through `findByPhone`, `sendMessage.ts:324-327`).
- I2 (current behavior).
- The phone#-keyed test (automated sends to a fresh auto conversation).
- The fan-out I8 test (automated sends skip the JIT gate, `sendMessage.ts:338`).

These are regression pins, not red-green TDD, and a builder checking for red
will be confused.

## 12. [LOW] Plan-internal claims that are false

- Self-review invariant map (plan line 3217) does not match the spec's invariants (spec line 308-324):
  - "I3 T3 (if_not_exists)": spec I3 is about skipped slots and "Not sent".
  - "I5 (blasts unchanged)": spec I5 is "nothing turns a switch OFF".
  - "I6 (no new slot status)": spec I6 is "D2 only turns on and audits".
  - "I7 T2 (conditional writes)": spec I7 is "production written only by the Cameron-run script".

  Downstream plan-anchored reviewers inherit this map.
- Plan line 3219 says the phone#-keyed case is "covered by the existing `phone#` fan-out test ... T7 Step 2 adds no new case". No such test exists (`grep phone# app/test/broadcastFanOut.test.ts` is empty), and Task 7 Step 2 does add one (plan line 1899-1913).
- Plan line 1731 says "the persisted counters never carried `skipped_no_consent`". The fan-out's consent fence bumps it (`app/src/jobs/broadcastFanOut.ts:402`). The change is harmless; the rationale is wrong.

## 13. [LOW] The slice-1 stop rule contradicts itself

Global Constraints line 26 says slice 1 is "handed to Cameron BEFORE Tasks 6+
start being built", then in the same bullet says the orchestrator "continues".
Task 5 Step 3 (plan line 1489) says "STOP for review", then "Building continues
with Task 6 without waiting for Cameron's production runs". A builder cannot tell
whether Task 6 waits for the slice review, the handoff, or nothing. Spec section 6
says only "before the rest is done".

## 14. [LOW] RUNBOOK text: wrong timing heading and a query that cannot match

- Plan line 1409 heads the section "Owed after the share-skip-fix deploy". Spec section 6 and the section's own step 5 (plan line 1419) have the runs happen before merge and deploy.
- The Logs Insights query at plan line 1423 uses `filter msg = '... exceeded - conversation ...'` with an ASCII hyphen. The stored message has an em dash (`app/src/services/sendMessage.ts:363`), so the equality never matches, which the text itself concedes. Give `filter msg like /circuit breaker TRIPPED/` instead.

## 15. [LOW] The census overstates "rungs that start sending once D2 runs"

`oneToOneSwitchedOff` (plan line 668) counts every manual conversation, including
breaker-tripped ones that bulk D2 deliberately leaves off (plan line 1072). It
also counts rungs of superseded ladders that the job retires without sending
(`app/src/jobs/tourReminders.ts:1190-1205`, the ladder-generation gate the census
does not replay). The number Cameron reads before applying is an upper bound
presented as the release count. Split by cause, or label it an upper bound.

## 16. [LOW] Reason-map placement moves the spec section 6 merge points, but the handback relay still cites them

Spec D7 (spec line 242-243) says the wording "lives with the dashboard's existing
staff-facing reason wording". Appendix A (spec line 430-431) locates that in
`dashboard/src/routes/contact/deliveryStatus.ts`. Spec section 6 (spec line 361-365)
tells SOR and RSW the merge points are "the dashboard internal-code reason map and
`deliveryReason`'s options" and "the results-row reason gate".

The plan puts a parallel map in `broadcastFormat.ts` (Global Constraints line 21
attributes that location to D7, which does not name it) and deletes the
DeliveryBadge `pres.isFailure` gate (`dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31`).
The Task 15 relay (plan line 3211) still says "A's merge points are spec section 6 item 3".
SOR's `send_unconfirmed` reason now has to go into `shareRecipientReason`, and
nothing tells SOR that.

## 17. [LOW] Seed surfaces not enumerated

- Spec section 5 (spec line 336-337) lists seed fixtures as writers of the person's-share record. The full-profile seeded draft `broadcast-mx-draft-01` (`app/src/lib/seed/matrix.ts:1233`) gets no `created_via`, so sending it in the demo world is an automated send. The plan's self-review maps "seed broadcast fixtures" to T6, which only adds `skipped_other: 0`.
- The full profile is lean + cast + matrix (`app/src/lib/seed/index.ts:7`), so Task 13's Dario also lands in the demo world. Spec section 5 says "every other seed world is unchanged". Either acknowledge that or say it is intended.

## 18. [LOW] UNVERIFIED: `ADD stats.skipped_other` on pre-deploy stats maps is never exercised against DynamoDB

Drafts created before deploy, and shares in flight at deploy, carry `stats` maps
without `skipped_other`. After deploy the fan-out bumps it with a nested `ADD`
(`app/src/repos/broadcastsRepo.ts:691-733`). That code's own comment rests on
"stats fields pre-exist". Every Task 6/7 fan-out test uses the in-memory double
(`app/test/helpers/twilioWebhookHarness.ts:2978-2988`), which accepts any key. The
DynamoDB behavior of a nested ADD on a missing key inside an existing map was not
verified here. A `broadcastsRepo.integration` case would settle it.

## 19. [LOW] Single-mode output and refusal logging

Spec D2 (spec line 161) says "Output: counts by type (and, for single mode, the
one id)". A single-mode dry run never prints the id. `run()` logs table and mode
only (plan line 1108-1111), and `reportEnableRun` logs counters (plan line
1218-1226). The "not found" and "not a one-to-one conversation" refusals are
input validation, but they surface through the PARTIAL catch as "the run ABORTED
... PARTIAL result" at ERROR (plan line 1090-1098). That tells the operator the
wrong story.

## 20. [LOW] D8 makes the resolved-1:1 guard's stated rationale false, and only one comment is updated

`RecipientPreview.tsx:58-61` and `:119` ("the body names ONE tenant") and
`BroadcastComposer.tsx:262` ("the resolved text names ONE tenant and must never
send to a broader audience") justify the guard and the reset by the tenant's name
in the body. After D8 there is no name. The behavior is kept on purpose (spec D8),
but the plan updates only the auto-seed effect's comment (plan line 2822), which
leaves wrong reasoning beside the code SOR and RSW will read.

## 21. [LOW] `timeout 1500 npm run e2e` is shell-dependent and a timeout kill orphans the stack

Global Constraints line 25 and plan line 3168 / 3203 use `timeout 1500`. In
PowerShell (this machine's primary shell), `timeout` is Windows `timeout.exe`,
not a command wrapper. In Git Bash, a timeout kill leaves the lane's children
running. AGENTS.md: "reuseExistingServer adopts an orphaned stack on a commit
match alone ... After aborting a run, confirm no listener survives on the lane's
ports". The plan names the shell for neither and has no post-kill check.

---

## Coverage walk (spec -> plan), for the record

- D1: T1. The census logic and test fixtures match the repo's APIs (verified: `toursRepo.patch`, `tourRemindersRepo.create({skipped})` / `listDue` excludes skipped, `DISCONTINUED_REMINDER_KINDS` = {confirmation}, `retiredByTourStart`, `placementNudgesRepo.claimSend`). Overstatement: finding 15.
- D2: T2. Logic sound. Findings 3, 5, 19.
- D3: T3. Correct (`app/src/lib/import/apply.ts:1082-1107`, `input.isGroup` exists). The existing `ai_mode: 'manual'` import tests are group_text rows only (`app/test/importApply.integration.test.ts:547-601`).
- D4, I1, I2, I8: T7. Implementation is correct in substance (verified the gate order and `automated` readers in `sendMessage.ts:275-440`; no other reader of the audit `automated` flag). Findings 7, 8, 9, 11.
- D5, I3 (half), I4: T8 and T9 are correct (one reader verified: `routes/broadcasts.ts:516-544`; no other caller of `priorRecipientContactIds`). E2E gap: finding 6.
- D6, I3 (half): T11 is correct. E2E broken: finding 1.
- D7: T6 and T10 are correct (all three skip writers enumerated: `broadcastFanOut.ts:382/398/495`; the wire passes derived stats unfiltered, `routes/broadcasts.ts:293/311`). Findings 10, 16, 18.
- D8: T12 is correct in the dashboard; e2e wrong: finding 2. Findings 20.
- D9: T4. Finding 14.
- D10: already filed (verified the WP2 issue item 8, `import-conversations-missing-phone-claim.md`, `tenant-timeline-property-sent-milestone-after-failed-delivery.md`).
- Section 5 lean seed: T13. Values check out (phone `+15550100004` unused in any seed or e2e; TS0 is earliest; voucherSize 1 is excluded by exact-match bedroom filters, `app/src/services/audienceResolution.ts:153-154`). Finding 17.
- Section 6 slicing: finding 13. Section 7: findings 1, 2, 6.
- Completion gates: finding 4 (sync), finding 21.
