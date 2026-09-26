# share-skip-fix - whole-branch review, ADVERSARIAL (plan-blind)

Branch `feat/share-skip-fix` at 34dc2bea, merge base bbaad87d. Input: the
whole-branch package (`.superpowers/review/whole-branch-package.txt`) plus the
live tree. Nothing under `docs/superpowers/` was read. Read-only: no tracked
file was edited; one throwaway test (`app/test/zz-adv-share.test.ts`) was run
alone and deleted. A full `npm run e2e` owned the lane throughout, so no e2e
command was run; the lean-seed consequences below are a static sweep and the
running suite is the arbiter for them.

Verdict: no MUST-FIX. The send decision is sound (a dashboard share still
meets kill switch, opt-out on either contact or the conversation, deleted and
consent; only the switch and the breaker are lifted), `created_via` has exactly
one writer, and the real repo, the fake and the derive agree. Two SHOULD-FIX
items are user-visible labels the branch left inconsistent with its own D6 rule.

Empirical evidence: throwaway probe, 4/4 passing against the real fan-out +
real sendMessage over the fake world:
- P1 an all-skipped (no-consent) dashboard share finalizes `sent` and writes
  the `units#` `broadcast_sent` audit row with `tenantCount: 1`;
- P2 a two-recipient share with one no-consent skip and one 30007 failure
  finalizes `sent` (derived: sent 0, delivered 0, failed 1, skipped 1);
- P3 a deleted duplicate that `findByPhone` returns first no longer blocks the
  live recipient on the same phone (I8 as intended);
- P4 a recipient both `sms_unreachable` and soft-deleted is recorded
  `unreachable`, not `contact_deleted`.
Also run alone, all green: broadcastsRepo.integration (21), seedProfile.integration
(4), seedData, seedPersonaDrift, seedRosterShape, seedUnreadFlag,
seedMessageTransport, seedHistory, seedMatrixCoherence, seedLive, seedMedia,
seedTourTrails, castMessageTransport.

---

## Findings

### 1. SHOULD-FIX - "Sent to N tenants" still counts skipped recipients, beside a share the branch now labels "Not sent"

- Evidence: `finalize` computes `total` as the size of the recipients map
  (app/src/jobs/broadcastFanOut.ts:735) and appends the property audit row
  `broadcast_sent` with `tenantCount: total` (broadcastFanOut.ts:741). That row
  renders as "Sent to N tenants" on the property Activity card
  (dashboard/src/routes/listing/listingFormat.ts:130-135) and on the
  landlord's contact timeline (app/src/routes/contactTimeline.ts:302 and
  :670-678), both deep-linking to the share. Probe P1: an all-skipped share
  writes `tenantCount: 1`, so the property card says "Sent to 1 tenant" and
  links to a results page whose pill says "Not sent" (D6) and whose only row
  says "No texting consent recorded" (D7). Skipped AND failed slots both
  inflate N.
- Pre-existing count, but the branch's D5/D6 thesis is precisely "a skipped
  slot is not a send", and this is the one surface still saying it is. It is
  the "property activity count" consumer in the charter.
- Fix: write `tenantCount` from the derived stats as the recipients actually
  attempted (sent + sending + delivered + failed, or delivered-or-in-flight if
  failures should not count), and either skip the audit row when that is 0 or
  carry the derived buckets so `describeUnitActivity` / `unitAuditToMilestone`
  can say "Not sent" (and "Sent to 1 of 3"). Extend
  broadcastFanOut.test.ts:248-262 with a skipped recipient so the count is
  pinned.

### 2. SHOULD-FIX - a share that reached nobody reads "Sent" (positive) when its slots are skipped + failed

- Evidence: finalize marks `failed` only when `stats.failed >= total`
  (broadcastFanOut.ts:746-749), which ignores skipped slots; D6 reads "Not sent"
  only when skipped >= audience (dashboard/src/routes/broadcasts/broadcastFormat.ts:95-104),
  which ignores failed slots. A share whose every slot is skipped-or-failed
  falls between the two rules. Probe P2: one no-consent skip + one 30007
  failure -> status `sent`, derived sent 0 / delivered 0 / failed 1 /
  skipped 1 -> the pill reads "Sent" in the positive tone. The test at
  dashboard/src/routes/broadcasts/broadcastFormat.test.ts:181 pins exactly
  this case as "Sent".
- Bounded (needs 2+ recipients, at least one skip and one failure, no
  success), but it is the same "reads Sent, reached nobody" symptom as Sam's #5.
- Fix: one rule for "reached nobody": when status is `sent` and
  sent + sending + delivered + queued == 0, present "Not sent" (skips only) or
  "Failed"/"Not delivered" (any failure) - or make finalize's `allFailed`
  treat `failed + skipped >= total && failed > 0` as failed. Re-pin line 181.

### 3. NOTE - drafts created before the deploy stay automated when sent after it

- Evidence: `created_via` is stamped only at draft creation
  (app/src/routes/broadcasts.ts:448-455); the fan-out keys the person's-send
  decision on it (broadcastFanOut.ts:463). A draft sitting in the Drafts tab
  (or resumed via `?draftId=`) that predates the deploy is sent through the
  same authenticated `/send` route (broadcasts.ts:588-783, the ONLY enqueuer
  of `broadcast.send`, :762) yet is refused `manual_mode` on a switched-off
  conversation - the Sam #5 bug, for those drafts. The RUNBOOK section does
  not mention it.
- Impact is small once the bulk enable has run (few `manual` 1:1 rows left),
  hence NOTE.
- Fix: stamp the marker at SEND time in the authenticated route (e.g. in the
  `markSending` update), which covers old drafts and is no weaker for a future
  engine (one that bypasses the route never gets the stamp either way); or
  record the gap in the RUNBOOK.

### 4. NOTE - D4 widens the false "will retry" promise to shares

- Evidence: a person-sent share into a switched-off conversation that fails
  30003 gets a retry enqueued by the status webhook
  (app/src/routes/webhooks/twilio.ts:3350-3368); the retry sends
  `automated: true` (app/src/jobs/retrySend.ts:196-206) and is refused
  `manual_mode`; the share row reads "Phone unreachable - will retry (error
  30003)" (dashboard deliveryStatus.ts:778 via shareRecipientReason, no relay
  opt). Even on a switched-on thread the retry carries no `broadcastId`, so the
  share row never moves off Failed. Before D4 these shares were skipped, so
  this population is new.
- Owned by feat/retry-send-window (the e2e assertion only pins the
  `^Phone unreachable` prefix). Record the interplay there; no change here.

### 5. NOTE - skip reason codes live as bare strings in three places with no drift guard

- Evidence: the fan-out writes `opted_out` / `unreachable` / `contact_deleted`
  / `no_consent` as literals (broadcastFanOut.ts:396, :406, :422, :439); the
  bucket predicates re-list them (app/src/repos/broadcastsRepo.ts:204-213);
  the dashboard map re-lists them plus the wrapper codes
  (dashboard/src/routes/contact/deliveryStatus.ts:948-965). `errorCode` is
  typed `string`, so a rename in one place silently files opt-outs under
  `skipped_other` and renders "Not sent (<code>)". Wrapper codes reachable on
  this path but unmapped: `conversation_not_found`, `relay_not_supported`,
  `group_text_not_supported` (raw-code fallback). The persisted buckets and the
  derive DO agree today (same predicates on the same code) - verified.
- Fix: a `BroadcastSkipCode` union in broadcastsRepo.ts used by every
  `recordRecipient({status:'skipped'})` call and by the predicates, and a
  dashboard mirror typed `Record<ShareSkipCode, string>` so a missing entry is
  a compile error ("keep in sync", as types.ts already does for BroadcastStats).

### 6. NOTE - the finalize-log test proves the fixture, not "derived"

- Evidence: broadcastFanOut.test.ts:321-343 asserts `skipped_other === 1` on
  the "broadcast send finalized" line (:342). In that fixture the persisted
  counter is also 1 (the fake's bumpStats creates it,
  app/test/helpers/twilioWebhookHarness.ts:2979-2990), so reverting
  broadcastFanOut.ts:756-768 to `finalItem.stats.*` survives. Mutation not
  executed (source edits were off-limits while the e2e stack ran); read from
  the code.
- Fix: seed persisted stats that disagree with the map (e.g. a stale
  `skipped_opted_out: 5`) and assert the logged value is the derived one.

### 7. NOTE - deleted and consent are now judged on the fan-out's snapshot

- Evidence: sendMessage uses `recipient ?? phoneContact` for the deleted and
  JIT-consent gates (app/src/services/sendMessage.ts:317-360); for a share the
  recipient is the item the fan-out read at the top of the iteration
  (broadcastFanOut.ts:379, :471). A soft-delete or consent removal landing in
  that window is not seen; opt-out stays fresh (fresh `findByPhone` plus the
  conversation flag, sendMessage.ts:321-324). Window is milliseconds and the
  fan-out already fenced the same snapshot, so both gates are redundant for
  this caller. Accepting it is reasonable; worth one line in the I8 comment.

### 8. NOTE - smaller items

- a. Fence order reports an unreachable + deleted recipient as "Number can't
  receive texts" (probe P4; broadcastFanOut.ts:405-431). Both land in
  `skipped_other`; "Contact was deleted" is the more actionable reason.
  Consider judging deleted before unreachable (after opt-out).
- b. Hand-adding a tenant who is ALREADY listed (e.g. an unchecked,
  already-sent audience row) is a silent no-op: no check, no seed, no note
  (dashboard/src/routes/broadcasts/RecipientPreview.tsx:212-214). Under D5's
  "a deliberate pick stays checked" it should check and seed that row.
- c. app/test/broadcastApi.test.ts:387 still sums the buckets without
  `sending` and `skipped_other`; it passes only because its fixture has
  neither. Use the same sum as broadcastFanOut.test.ts:1035-1046.
- d. D8 on a property with no address (address is optional at create,
  app/src/lib/unitFields.ts) pre-fills " <link>" with a leading space
  (resolveTemplate.ts:40, BroadcastComposer.tsx:189-195). Cosmetic; the
  operator sees it before sending. A trim would do.

---

## Swept and found clean

- `created_via` writers: exactly one (routes/broadcasts.ts:454), behind the
  session-authenticated /api router; PATCH only replaces seed ids
  (:848-877); `markSending` preserves the attribute; no other creator of a
  broadcast or enqueuer of `broadcast.send` exists in app/src. No non-dashboard
  path can set it; no replay turns an automated share into a person's one.
- Person's send still enforces the kill switch (sendMessage.ts:296), opt-out on
  the conversation flag, the phone-matched contact AND the recipient
  (:321-334), deleted and consent (:340-360); only manual mode and the breaker
  are skipped (:364). The fan-out's own fences use the same `hasSmsConsent` and
  `isDeleted` as the wrapper, so the two layers cannot disagree.
- Duplicate-phone matrix: recipient opted out -> first fence; duplicate opted
  out -> wrapper refuses `contact_opted_out` (covered,
  broadcastFanOut.test.ts:856); duplicate deleted or no-consent -> recipient
  judged (P3, I8 test). A `phone#` key resolves the same `findByPhone` contact
  the wrapper reads; no contact row -> `failed no_contact`, unchanged.
- Persisted buckets vs derive: every skip path selects its bucket with the same
  predicates `deriveBroadcastStats` uses; legacy code-less skips stay under
  opted-out on both sides; `bumpStats` ADDs a missing nested `skipped_other`
  (integration test re-run green). SSE (fan-out and both webhook rollup emits)
  always carries derived stats.
- `priorRecipientContactIds`: real repo and fake apply the identical rule
  (sent/sending shares, non-skipped slots); both dashboard readers (the
  per-candidate flag incl. the `phone#` key, and the hand-add annotation) read
  that one set.
- `BroadcastStatusPill` has two render sites (list row, results header), both
  pass derived stats; `DeliveryBadge` renders only on the results page.
- `sendMessage`'s `recipient` input: one caller (the fan-out); every fake and
  spy takes `SendMessageInput` structurally, unaffected.
- `POINTER_PARTITION_PREFIXES` export: the conversations table has only
  `phone#` / `email#` / `token#` pointer keys (conversationsRepo.ts:511-527).
- Races: no new concurrency. Slot write then counter bump, finalize on
  persisted `failed`, and webhook rollup ordering are unchanged; skip buckets
  are chosen deterministically from the recorded code; a continuation carries
  only transient keys, so a slot is never skipped twice.
- Lean seed (Dario, conv-0002): 1-BR so every e2e share audience (all
  `bedroomSize: 2`, exact match in services/audienceResolution.ts:153-154) and
  the unique-authority a2p fence exclude him; his thread is the oldest row with
  `unread_count: 0`, so it neither displaces Tasha as newest nor enters Unread;
  inbox specs anchor positively (deleted-contact-resurfacing
  `expectTashaHidden`, group-text-inbox); roster-paging only needs "more than
  a page"; `+15550100004` appears in app tests only as in-memory fixtures,
  never against the lean world. The running `npm run e2e` remains the arbiter.
- Import D3 (`:aiMode` by `isGroup`, still `if_not_exists`) and the audit
  `transactPut` refactor (one item builder) read clean; `setMode` has one
  runtime caller (the breaker), so the ops scripts' trip-evidence invariant
  holds on this tree.

Housekeeping: this review's probe was deleted; at hand-off `git status` shows
only this report, untracked and not committed.
