# share-skip-fix (Branch A) - planner review: SPEC CONFORMANCE (whole branch)

Reviewer: independent spec-conformance reviewer, dispatched by the planner.
Date: 2026-09-25. READ-ONLY: nothing was run (no npm, no tests, no scripts);
only read-only `git` commands; gate state was READ from logs already on disk.

- Branch `feat/share-skip-fix` @ `3abc9796` (tip; `813c0c44` merged main).
  Merge base with `main` = `cd8e8ddd` = main, so `git diff main...HEAD` is the
  branch's own change: 51 files outside `docs/` (RUNBOOK.md included),
  +3512/-201 by `git diff --stat`.
- Contract: `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md`
  (Branch A; D1-D10, I1-I8, sections 5-7).
- Read whole: the spec; `build-handback.md`; `whole-branch-review-adjudications.md`;
  the Branch B stub; the plan's Global Constraints, Review Focus, Tasks 3 and 13;
  `git diff main...HEAD` for every non-docs file; full text of
  `app/jobs/broadcastFanOut.ts`, the gates of `app/services/sendMessage.ts`, the
  draft/preview/send routes of `app/routes/broadcasts.ts`, both ops scripts and
  `app/scripts/lib/stageClient.ts`, `RecipientPreview.tsx`, the composer
  effects, the reason maps in `deliveryStatus.ts`, the new e2e spec, and every
  new or changed test.

Paths below are relative to the worktree root; `app/...` and `dashboard/...`
are the workspaces.

## 1. Conformance table

| Item | Verdict | Delivered by (file:line) | Pinned by |
|---|---|---|---|
| D1 census (read-only) | DELIVERED | `app/scripts/conversation-automation-census.ts:224-275` one Scan, pointer rows excluded (:235-241), typeless as `(none)` (:242), switched-off by cause (:250-272), breaker list id/type/time/evidence (:260-269), claim mismatches (:277-281), pending rungs via the job's own `DISCONTINUED_REMINDER_KINDS` / `retiredByTourStart` / `isSupersededRung` / `resolveUsableGroup` (:302-344), nudges held manual-only (:347-348); counts + trip ids only (:354-372); target logged before the first read (:386-403) | `app/test/conversationAutomationCensus.test.ts:76` (every group, paging, read-only by command recorder AND before/after table equality :209-213), :218 |
| D2 fix script | DELIVERED | `app/scripts/enable-conversation-automation.ts`: dry run unless `--apply` (:382); population `planRow` (:136-146: `isOneToOneBucket`, typeless in, pointer/group out, `manual` only); bulk trip exclusion unless `--include-breaker-tripped` (:144, :275-284); single mode refuses unknown id / pointer / group as usage errors (:325-334); every write conditional (:219-222); switch + `mode_changed` manual->auto with reason `bulk_enable` or `operator_resume` in ONE TransactWriteItems (:203-244); counts by type (:310-321), single-mode id (:187-190); target safety `stageClient.ts:143-176` (explicit `hc-<env>-` prefix :152, account 938565869261 asserted, injectable :154-160, client from `hcCredentials()` :161-168; `scripts/lib/hcAws.mjs:14,17`) | `app/test/enableConversationAutomation.test.ts:116` (dry run writes nothing), :159 (apply, re-run no-op, one event per change), :195, :204 (single mode + refusals), :241/:275/:313 (conditional losses), :356/:399 (atomicity, abort); `app/test/stageClient.test.ts:68` (wrong account refuses). Evidence widened - finding 2 |
| D3 import default | DELIVERED | `app/src/lib/import/apply.ts:1093` (`if_not_exists`, unchanged), :1114 (`isGroup ? 'manual' : 'auto'`) | `app/test/importGroupGuards.test.ts:201`; `app/test/importApply.integration.test.ts:243-252`. "A re-run never changes an existing switch" is pinned structurally (the `if_not_exists` clause), not by a re-run over a `manual` row |
| D4 person's shares | DELIVERED | `app/src/routes/broadcasts.ts:448-462` (`createdVia: 'dashboard'` hard-coded; the only `broadcasts.create` call in `app/src`; `/api` behind `sessionMiddleware` + `requireAuth`, `app/src/app.ts:211-225`); `app/src/repos/broadcastsRepo.ts:165, :341, :548` (stored as `created_via`; `created_by` kept, routes :449); `app/src/jobs/broadcastFanOut.ts:463-473` (`automated: !staffShare`, strict `=== 'dashboard'`, read off the item already loaded - no lookup); `app/src/services/sendMessage.ts:366-385` (switch + breaker only when automated) | `app/test/broadcastApi.test.ts:164`; `app/test/broadcastFanOut.test.ts:382, :458, :503`; `app/test/sendMessage.test.ts:833` (pre-existing: a human send is never counted) |
| D5 "Already sent" + review list | DELIVERED | `app/src/repos/broadcastsRepo.ts:576-614` (skip at :600; sent/sending gate :590 unchanged, so queued/sent/delivered/failed count); harness mirror `app/test/helpers/twilioWebhookHarness.ts:3011-3024`; one set feeds the per-candidate flag and the hand-add annotation (`app/src/routes/broadcasts.ts:521-524, :547-549, :569`); no send-time exclusion (:624-625, :659-669); `dashboard/src/routes/broadcasts/RecipientPreview.tsx:91` (flagged seeds start checked), :165-169 (Select all keeps seeds), :216-243 (a hand-add is a checked seed; an already-listed pick is promoted), :364 (note, straight quotes) | `app/test/broadcastsRepo.integration.test.ts:359`; `app/test/broadcastApi.test.ts:1205`; `RecipientPreview.test.tsx:218, :248, :290, :309`; e2e `share-skip-fix.spec.ts:197-201, :231-237, :270-274` |
| D6 "Not sent" | DELIVERED | `dashboard/src/routes/broadcasts/broadcastFormat.ts:95-104` (`sent` + audience > 0 + skip buckets >= audience); `BroadcastStatusPill.tsx:19-27`; `BroadcastResults.tsx:138`; `BroadcastsList.tsx:144`; stored status and finalize untouched (`broadcastFanOut.ts:746-749`) | `broadcastFormat.test.ts:171`; `StatChips.test.tsx:193`; e2e `share-skip-fix.spec.ts:217, :225-229` |
| D7 reasons + honest counts | DELIVERED | fences with reasons `broadcastFanOut.ts:395-404` (`opted_out`), :405-414 (`unreachable`), :421-431 (`contact_deleted`), :438-448 (`no_consent`); refusal code + bucket :541-560; persisted buckets through `bumpStats` (`broadcastsRepo.ts:755-796`, ADD creates `skipped_other` on a legacy row); derived buckets :213-222, :254-306; finalize log from derived stats `broadcastFanOut.ts:756-770`; wording `dashboard/src/routes/contact/deliveryStatus.ts:948-966` (byte-identical to the spec table; not the catalog), row gate `broadcastFormat.ts:144-152`, `DeliveryBadge.tsx:36`; `INTERNAL_CODE_REASONS` (:913-935) and `deliveryReason` (:983-1008) untouched, so the 30003 wording is untouched; Skipped chip `StatChips.tsx:34`; slot status union unchanged | `app/test/deriveBroadcastStats.test.ts:75`; `broadcastFanOut.test.ts:306, :310, :329` (log reads derived over stale persisted), :405, :483; `broadcastsRepo.integration.test.ts:147`; `broadcastFormat.test.ts:132`; `StatChips.test.tsx:97, :161, :171`; e2e :219, :266 |
| D8 one-to-one default | DELIVERED | `dashboard/src/routes/broadcasts/resolveTemplate.ts:40` (`[Address] [FlyerLink]`; address port of `app/src/lib/address.ts:112-126`); `BroadcastComposer.tsx:188-199` (one-recipient mode only; no name/greeting/beds/rent), :272-283 (filters flip still resets to the blast default); `MessageEditor.tsx:85` (placeholder); `DEFAULT_SEND_TEMPLATE` unchanged; no catalog entry | `resolveTemplate.test.ts:107`; `BroadcastComposer.test.tsx:368-412`; `MessageEditor.test.tsx:98`; e2e `share-skip-fix.spec.ts:165-171`, `matching-entry-points.spec.ts:138` |
| D9 RUNBOOK | DELIVERED | `RUNBOOK.md:337-366`: one trip fires no alarm (:351), Logs Insights `circuit breaker TRIPPED`, Settings -> System status -> Recent errors, the census list, read-only Query of `conversations#<id>` in `hc-<env>-audit_events` via `housingchoice` for `mode_changed` and `message_sent` automated true; resume with single mode (:364); dev/prod census, dry run, apply (:343-348); import-window rule (:349) | n/a (doc). Stale status + shorthand - findings 4, 5 |
| D10 issues | DELIVERED | `docs/issues/ai-mode-switch-gates-all-automation.md:66` (item 8); `docs/issues/import-conversations-missing-phone-claim.md`; `docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md` | n/a (docs). Stale nudge claim - finding 6; phone-claim sizing never captured - finding 1 |
| I1 | DELIVERED | kill switch `sendMessage.ts:298-301` (before every automated check; `sms_sending_disabled` -> skipped via `broadcastFanOut.ts:541-560`); opt-out `broadcastFanOut.ts:395-404` + `sendMessage.ts:323-336`; deleted `broadcastFanOut.ts:421-431` + `sendMessage.ts:342-345`; consent `broadcastFanOut.ts:438-448` (every share) + `sendMessage.ts:356-362` (person's sends) | `broadcastFanOut.test.ts:405, :483` |
| I2 | DELIVERED | `broadcastFanOut.ts:463` (anything but `'dashboard'` is automated); the route is the only runtime writer (`routes/broadcasts.ts:454`); seed fixtures also write it (`app/src/lib/seed/matrix.ts:1239`, `performance.ts:1031`), a writer section 5 allows | `broadcastFanOut.test.ts:329, :503` |
| I3 | PARTIAL | clause 1: `broadcastsRepo.ts:600`. Clause 2 holds on D6's two surfaces only; the property Activity entry and the landlord timeline still read "Sent to N tenants" for an all-skipped share | finding 3 |
| I4 | DELIVERED | hint only (`routes/broadcasts.ts:547-549`; never excluded at send :624-625, :659-669); seeded rows stay checked (`RecipientPreview.tsx:91, :167, :223, :238`) | `RecipientPreview.test.tsx:218, :309`; e2e :201, :237, :274 |
| I5 | DELIVERED | the only `manual` writes the diff adds or keeps: the import's group branch (unchanged behavior, `apply.ts:1114`) and the lean fixture row section 5 asks for (`app/src/lib/seed/lean.ts:273-286`); the fix script writes only `auto` (`enable-conversation-automation.ts:214`); the breaker is untouched (`sendMessage.ts:366-385`) | `enableConversationAutomation.test.ts:159` (group, unset, tripped rows untouched) |
| I6 | DELIVERED | `enable-conversation-automation.ts:203-244` (conditional Update + audit Put in one transaction), :219-222 (one-to-one + `manual` condition) | `enableConversationAutomation.test.ts:159, :356` |
| I7 | DELIVERED (code) | no Terraform, table/GSI spec, package.json, lockfile or `.env` in `git diff --stat main...HEAD`; the census is read-only (test above). Production-run facts are relayed, not verified: `build-handback.md:143-153` | UNVERIFIED for the prod run itself |
| I8 | DELIVERED | `sendMessage.ts:243-252` (`recipient` input), :319-322 (`contact = recipient ?? phoneContact`), :323-326 (opt-out on the conversation flag, the phone-matched contact OR the recipient), :342, :356 (deleted/consent judge `contact`); `broadcastFanOut.ts:471` passes the fenced contact on every fan-out send (phone# keys resolve through `findByPhone`, :692-700); no other caller passes `recipient` (grep), so the automatic retry (`app/src/jobs/retrySend.ts:205`, `automated: true`) and staff Retry keep today's gates | `sendMessage.test.ts:662, :688, :703`; `broadcastFanOut.test.ts:442, :458` |

Conformance: 17 of 18 items DELIVERED (I3 PARTIAL).

## 2. Section 5 surfaces

- The switch. Writers: runtime creation untouched (`app/src/repos/conversationsRepo.ts`
  not in the diff); the import (D3, `apply.ts:1114`); relay/group-text creation
  and conversion untouched; the breaker untouched (`sendMessage.ts:366-385`); D2
  new; seeds: lean gains `conv-0002` only (`lean.ts:273-286`), and the
  `matrix.ts` / `performance.ts` hunks touch broadcast rows only (no switch
  change - the profiler's rows stay switched off, as section 5 says). Readers:
  the wrapper (`sendMessage.ts:367`); `app/src/services/scheduledSendSuppression.ts`
  is not in the diff. DELIVERED.
- Person's-share record. Writers: the route (`routes/broadcasts.ts:454`) and
  seed fixtures (`matrix.ts:1239`, `performance.ts:1031`); never the engine
  (there is none yet). Readers: the send job (`broadcastFanOut.ts:463`); the
  share list's attribution is unchanged (`routes/broadcasts.ts:313`). Note: the
  two seed worlds stamp it on shares no test sends (`broadcast-mx-draft-01` has
  no reader outside `matrix.ts`) - plan-prescribed, harmless, not a finding.
- Recipient reason and stats. Writers: the fan-out's fences and its persisted
  counters (D7 row). Readers: results rows and chips, list stats, derived stats,
  the finalize log (now from derived stats, `broadcastFanOut.ts:756-770`),
  "already sent" (D5), the labels (D6). No other reader sums the skip buckets
  (grep of `skipped_no_consent` in `app/src` and `dashboard/src`). DELIVERED.
- One-to-one default text: the composer's one-recipient mode and the editor's
  placeholder in that mode (D8 row). DELIVERED.

## 3. Section 7 acceptance

- Hermetic tests per decision: D1-D8 each pinned (table); D9/D10 are docs.
  The D2 list is complete: dry run writes nothing (:116); apply turns on only
  one-to-one `manual` rows, typeless in, group rows never (:159); tripped rows
  skipped unless included (:116, :195); single mode refuses a group thread
  (:204); a re-run changes nothing (:159); every change audited (:159, :356); a
  real-AWS run on the wrong account refuses (`stageClient.test.ts:68`).
- End to end (`e2e/tests/dashboard-next/share-skip-fix.spec.ts`), all six:
  (1) staff one-to-one share into a switched-off conversation is delivered -
  :146-195 (switch asserted `manual` first at :154; slot proven to ride
  `conv-0002` at :194-195); (2) skipped earlier -> not "Already sent" -
  :231-237; (3) went out -> flagged :197-201, and failed -> flagged, pinned as
  the interim rule, with two recipients so the share finalizes `sent` -
  :240-274; (4) skipped rows show their reason - :219 (no consent; the other
  reasons are hermetic, because the send route re-fences opted-out and
  unreachable before the fan-out); (5) all-skipped reads "Not sent" - header
  :217, list row under the Sent tab :225-229; (6) the one-to-one default text -
  :165-171 and `matching-entry-points.spec.ts:138`. The lean world carries the
  switched-off tenant conversation (section 4 below).
- Five gates: claimed green on `813c0c44` (`build-handback.md:70-86`). Read
  from logs, not run: `.superpowers/sdd/gates-synced/e2e.log` ends
  `278 passed (20.2m)` / `E2E-EXIT=0` with 0 `[dynamoAdmin]` lines. The
  planner's in-flight re-run on the tip (`.superpowers/planner-gates/head.txt`
  = `3abc9796`): typecheck exit 0; smoke exit 0 ("1413 import specifier(s)
  across 248 emitted file(s)"); npm test exit 0 (app 369, dashboard 191,
  e2e-unit 21, fake-twilio 34, fake-twilio-web 13 files; 0 `[dynamoAdmin]`);
  eslint exit 1 with exactly 14 errors on the 5 files the handback baselines
  (spot-check: `DEFAULT_SEND_TEMPLATE` at `BroadcastComposer.test.tsx:37` is an
  unused import on `main` too, so the unused-import trap does not apply); e2e
  still running at review time - gate 4 on the tip UNVERIFIED.
- Handback content: the diagnosed cause (`diagnosis.md`) - present; what D2
  changed - prod present, dev absent; issues filed or amended - present; the
  D1 numbers - PARTIAL (finding 1).

## 4. Seed world rule

- Byte-stable: literal ids and timestamps only (`app/src/lib/seed/lean.ts:34,
  :50-51, :188-201, :273-286`); nothing clock- or random-derived.
- Every timestamp before T2 (`2026-06-01T14:05:45.000Z`, `lean.ts:20`): the
  contact's `consent_at` / `created_at` are T0 14:00 (:200-201); the
  conversation's `last_activity_at` / `imported_at` / `created_at` are TS0
  13:20 (:34, :277, :284-285) - also older than every other conversation row
  (TC0 13:30, TG0-TG2 13:40-13:45), so Tasha stays the newest inbox row
  (`app/test/seedData.test.ts:89-101`).
- `unread_count: 0` (:282). camelCase names and object participants (:193-195,
  :280).
- Excluded from existing audiences: `voucherSize: 1` (:195); every
  pre-existing e2e blast filters `bedroomSize: 2`
  (`broadcasts.spec.ts:129, :322`; `landlord-activity.spec.ts:85`;
  `listing-activity.spec.ts:105, :185`; `a2p-compliance.spec.ts:464`), and the
  property-page flow pre-fills 2-BR from a `beds: 2` unit
  (`matching-entry-points.spec.ts:70, :210`). Only the new spec's own seeded
  shares reach him.
- Verdict: CONFORMS.

## 5. Findings

### 1. MEDIUM - The handback lacks the D1 census numbers; the claim-mismatch count that sizes the D10 phone-claim issue was never captured

What is wrong. Section 7: "Handback reports: the D1 numbers ...". The
handback reports only `rungsReleasedByBulkEnable = 0` and the D2 apply line;
the census's own counts (switched-off by cause, `importClaimMismatches`,
`pendingNudgesHeldManualOnly`, `breakerTrippedUnaudited`) are absent for prod,
and nothing at all is recorded for the dev runs the handback says happened.

Evidence. `build-handback.md:143-153` ("full census line no longer in his
terminal, row counts per the apply line"); `.superpowers/sdd/cameron-runs.md`
("D1 prod census line (rungs released, nudges held, claim mismatches):
PENDING", later closed without them). D10's issue depends on the number:
`docs/issues/import-conversations-missing-phone-claim.md:30-32` ("The
share-skip-fix census (Branch A, D1) reports how many imported rows have a
claim that points at a different conversation, which sizes the real damage");
spec D10 "(low risk; D1 sizes the mismatches)". The only verbatim run record
is under the gitignored `.superpowers/sdd/`, which AGENTS.md ("Mission reasoning
is version-controlled") says dies with the worktree.

What it implies. The D10 phone-claim issue stays unsized, and the acceptance
item is PARTIAL. It is recoverable without risk: the census is read-only, and
`importClaimMismatches` does not depend on the switch state, so one census run
per environment (Cameron's go) re-measures it after the apply. The run record
should land in the committed records path before the worktree is removed.

### 2. LOW - D1/D2 treat the breaker's send counter as trip evidence, wider than the spec's definition

What is wrong. D1 defines a breaker trip as "a `mode_changed` audit event with
reason `breaker_trip`", and D2 excludes "conversations with a breaker trip on
record". The build also counts a `manual` one-to-one row carrying
`outbound_minute_bucket` as tripped - with no audit event - and excludes it
from the bulk run at planning AND through the bulk write condition.

Evidence. `conversation-automation-census.ts:151-153, :260-269`;
`enable-conversation-automation.ts:144, :201, :222, :275-284`; RUNBOOK.md:343-345
documents it; recorded as an adjudicated spec-vs-tree call
(`build-handback.md:63-67`).

What it implies. Delivered differently from the spec's words, but sound: the
import writes only its own deterministic `uuidv5` rows
(`app/src/lib/import/ids.ts:64-66`) while runtime rows are `conv-<uuid>`
(`app/src/repos/conversationsRepo.ts:1268`), so the breaker is the only runtime
writer of `manual` and `manual` plus the counter can only be a trip (possibly
one whose audit append was lost). It errs toward Cameron's review, and the
prod apply excluded 0 rows (`breakerTrippedExcluded: 0`). No action beyond
knowing it; WP2's switch must revisit the rule (the scripts say so).

### 3. LOW - I3's second clause holds only on D6's two surfaces: the property Activity entry and the landlord timeline still read "Sent to N tenants" for an all-skipped share

What is wrong. I3: "a share in which every recipient was skipped never reads
'Sent'". Finalize writes a `broadcast_sent` unit-audit row with `tenantCount`
= the recipients-map size for EVERY finished share, all-skipped included, and
two surfaces render it as "Sent to N tenants".

Evidence. `app/src/jobs/broadcastFanOut.ts:739-745`;
`dashboard/src/routes/listing/listingFormat.ts:130-136` (property Activity
card); `app/src/routes/contactTimeline.ts:670-678` (landlord timeline
milestone). The build read I3 as D6's scope (`build-handback.md:63-64`;
`whole-branch-review-adjudications.md` A1), and spec section 2 lists "the
property activity count" as Branch B's.

What it implies. The label Sam objected to ("Sent" for a share that texted
nobody) survives on the property page and the landlord's timeline, and each
entry links to a results page that says "Not sent". Branch B's stubbed D5(c)
fixes only the COUNT, so it would render "Sent to 0 tenants" - the invariant's
literal wording would still not hold after B. Worth a line in B's rewrite; no
change asked of A (the entry is outside D6's named surfaces).

### 4. LOW - The D9 RUNBOOK section still says the dev/prod runs are owed

What is wrong. The section opens "Owed as soon as slice 1 of
`feat/share-skip-fix` is reviewed - BEFORE its merge and deploy: ONE census
read, then ONE fix-script apply, dev then prod, each on Cameron's explicit go."
The handback records both environments applied on 2026-09-25.

Evidence. `RUNBOOK.md:339`; `build-handback.md:145-153`.

What it implies. Merged as is, RUNBOOK advertises an owed production data
mutation that already happened (a re-run is idempotent, so harmless, but it is
exactly the per-section status line that rots away from its outcome). The
section's how-to content (D9's substance) is complete.

### 5. LOW - RUNBOOK copy uses the spec-only "share" shorthand

What is wrong. The spec's vocabulary note restricts "share" / "one-to-one
share" / "blast" to the spec document itself: "(never UI, RUNBOOK or issue
copy)"; staff-facing copy says "property send". The new RUNBOOK section uses
it twice.

Evidence. `RUNBOOK.md:339` ("one-to-one shares already work for switched-on
conversations"); `RUNBOOK.md:364` ("a reminder ladder plus a share in one
minute"). No UI string and no new issue file uses it (grep of the added
dashboard lines and the seven issue files the branch adds).

What it implies. Wording only: "one-to-one property sends", "a property send".

### 6. LOW - The WP2 issue (D10) still says the switch stops placement nudges, contradicting the spec's correction

What is wrong. Spec section 1 item 4 was corrected on 2026-09-25: placement
nudges are held for manual sending and go out as a person's send, so the switch
never stops one. The WP2 issue this branch files and amends still lists
placement nudges among the texts the switch "silently stops".

Evidence. `docs/issues/ai-mode-switch-gates-all-automation.md:19-22`; last
touched by `fc89dd0a` (spec v3), before the correction; contradicted by the
census (`pendingNudgesHeldManualOnly`, `conversation-automation-census.ts:347-348`)
and `RUNBOOK.md:341` ("Placement nudges are NOT affected either way").

What it implies. The WP2 brief carries a false problem statement; its item 2
requirement ("System texts never read it: ... placement nudges ...", :55)
remains valid. A one-line correction to the Problem paragraph.

## 6. Not verified here

- Gate 4 (`npm run e2e`) on the tip `3abc9796`: the planner's re-run was still
  writing `.superpowers/planner-gates/e2e.log` at review time.
- Every production and dev fact (who ran what, when, with which output): relayed
  through the planner and recorded only in the handback and the gitignored
  `.superpowers/sdd/cameron-runs.md`.
- The live UI eyeball: the handback says it was not run (browser build absent);
  the DOM layer rests on the passing e2e suite.
