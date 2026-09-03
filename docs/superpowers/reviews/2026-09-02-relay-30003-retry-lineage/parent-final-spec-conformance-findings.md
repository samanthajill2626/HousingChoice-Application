# Parent final spec-conformance findings - relay 30003 retry lineage

Reviewer: independent spec-conformance pass by the mission window (parent), after
the build's own R1/R2/R3 rounds and four fix waves.

- Branch `feat/relay-30003-retry-lineage`, HEAD `9a53af9d`, merge base `main` @ `f82c149c`.
- Contract: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 6, founder-approved).
- Plan: `docs/superpowers/plans/2026-09-02-relay-30003-retry-lineage.md` (rev 5).
- Method: read-only. `git diff main...HEAD`, the source at HEAD, the test bodies,
  the issue files. NO test suite, e2e session or long-running command was run -
  the human is running the gates in this worktree concurrently.
- The build's own claimed deviations (handback "Spec text that trails the tree",
  "Residuals") were CHECKED against the tree, not trusted. Where a claim is
  accurate it is marked so below; where the spec text is what moved, it is
  recorded as a finding regardless.

Everything cited is at HEAD `9a53af9d`.

---

## Part 1 - the decisions, D1 through D23

**D1. A retry is a NEW source message row, not a promotion.** DELIVERED.
The claim appends a fresh row (`app/src/routes/webhooks/twilio.ts:2781`) whose
single-entry map is seeded `queued` (`:2793-2802`); nothing on the failed slot is
rewritten anywhere on the claim path. `ALLOWED_PRIOR` is untouched (no diff in
`app/src/repos/messagesRepo.ts` around the status machine).

**D2. The retry row MIRRORS direction, author and relay_sender_key.** DELIVERED.
`app/src/routes/webhooks/twilio.ts:2783-2789` mirrors `type` (`sms`/`mms`),
`direction`, `author`, `relaySenderKey`, and seeds `deliveryStatus: 'queued'`.
Transport MODE is read off the ORIGINAL (`:2782`, `versioned = src.transport_schema_version === TRANSPORT_SCHEMA_VERSION`)
and the seeded slot follows it: versioned gets `transportAggregationState: 'planned'`
(`:2796-2800`), legacy gets a bare `{status:'queued'}` (`:2801`). LEGACY is
handled as the ordinary case, and the retry job re-reads the mode from the RETRY
ROW rather than the root (`app/src/jobs/relayRetryLeg.ts:382-390`). Message-level
`requestedTransport` is never set, so the inbound prohibition holds; the SLOT
carries one. Proven at `app/test/relayRetryClaim.webhook.test.ts:510`, `:522`, `:540`, `:552`.
See finding 7 for the one sub-clause that drifted.

**D3. The claim is the row's `sid#<providerSid>` pointer, created atomically.**
DELIVERED. `relayRetryProviderSid` / `relayRetryDigest`
(`app/src/lib/relayRetryClaim.ts:25`, `:33`) give the deterministic SID;
`appended.deduped` is the loss signal (`twilio.ts:2833-2835` -> `already_claimed`).
16 hex chars, no `#`, no phone digits, `providerTs` a wall clock at claim time
(`twilio.ts:2770`). Pinned at `app/test/relayRetryClaim.test.ts:14-40` and
`app/test/messagesRepoRetryLineage.integration.test.ts:94`.

**D4. A duplicate QUEUE delivery is defeated by a job-execution marker, not by
the claim. BOTH guards required.** DELIVERED - both exist and are tested
separately. Marker: `app/src/jobs/relayRetryLeg.ts:350-359`
(`putJobExecutionMarker` before any send, early return on a repeat), proven at
`app/test/relayRetryLeg.test.ts:287`. Create: `twilio.ts:2833`, proven
independently at `app/test/relayRetryClaim.webhook.test.ts:350`. The two guards
are in different files and neither substitutes for the other. See finding 8 for
the marker's unspecified fail-open when no `jobId` is in context.

**D5. Keyed on the DESTINATION PHONE from the callback's `To`, digest only.**
DELIVERED. `twilio.ts:2761-2764` reads `params['To']`, normalises to E164, and
declines with `to_missing` / `to_malformed` rather than minting a second ladder;
the digest is stored and the raw handset is not
(`app/src/repos/messagesRepo.ts:2220-2237` stamps only `relay_retry_dest_digest`).
The changed-number gate compares digests, never numbers
(`app/src/jobs/relayRetryLeg.ts:532-540`), proven at
`app/test/relayRetryLeg.test.ts:388` and `:407`.

**D6. Attempt numbering, cap and backoff match the 1:1 policy exactly.**
DELIVERED. `MAX_RELAY_RETRY_ATTEMPTS = 3` and `relayRetryBackoffMs` =
60s/120s/240s (`app/src/lib/relayRetryClaim.ts:13`, `:16`); the cap is enforced
at `twilio.ts:2757-2759`. `docs/issues/quiet-hours-ungated-automated-paths.md`
is annotated, not closed, and states the same ~7-minute bound.

**D7. The fence is POSITIVE, and the read behind it is CONSISTENT.** DELIVERED.
`getByTsMsgIdConsistent` is a NEW interface method delegating to the repo's own
private `getMessageConsistent` closure - the same closure the six sibling
mutators use, not a second `GetCommand`
(`app/src/repos/messagesRepo.ts:3057`; `ConsistentRead` asserted at
`app/test/repos.test.ts` "sets ConsistentRead on the consistent read and not on
the plain one"). The claim path uses it (`twilio.ts:2695`) and the hot-path read
at the top of the handler is untouched. The fence is positive - present, has a
sender key, key is not the system value - at `twilio.ts:2697-2713`, and the test
asserts the VALUE `'system'` rather than only the imported constant
(`app/test/relayRetryClaim.webhook.test.ts:416`).

**D8. Gates on the SLOT'S POST-WRITE STATE plus THIS callback's code, never on
`transitioned`, and the read is CONSISTENT.** DELIVERED, and this is the decision
the build got most exactly right.
- THIS callback's code: `twilio.ts:2685-2686` (`mapped` must be
  undelivered/failed AND `ErrorCode` must be `30003`).
- The consistent read happens AFTER the slot write (`twilio.ts:2695`, called from
  `:3003` which sits after the `updateRecipientDeliveryStatus` / transport writes).
- The slot's POST-WRITE state, not a transition: `twilio.ts:2744-2752`. Absent
  slot or non-terminal slot -> `slot_ineligible`; `delivered` or a terminal code
  other than 30003 -> `slot_settled`; terminal + 30003 or code ABSENT -> claim.
  There is no reference to `transitioned` anywhere in the claim helper.
- Crash recovery is proven, which is the whole point of choosing state over
  transition: `app/test/relayRetryClaim.webhook.test.ts:364` ("RECOVERS a claim
  lost to a crash between the slot write and the claim").
- The code-ABSENT clause is exercised rather than assumed:
  `app/test/relayRetryClaim.webhook.test.ts:375`.
- The 30007 contradiction stays closed: `:390`.

**D9. Every attempt re-runs the relay send gates; a refusal ends the chain.**
DELIVERED. Four gates in the spec's order at
`app/src/jobs/relayRetryLeg.ts:485` (group open), `:512` (roster membership),
`:532` (digest match), `:542` (suppression). Each writes its own close code
through `refuseGate` (`:449`), logs the D23 terminal ERROR with
`retryClaim: 'gate_refused'`, and RETURNS - no further rung is claimed and
nothing is enqueued. Table-driven proof at `app/test/relayRetryLeg.test.ts:307-374`,
which also asserts `outbound.delayed` is empty (the chain really ends).

**D10. The per-leg send is EXTRACTED and shared, and the transient arm has an
owner.** DELIVERED, all four sub-parts.
- Extraction: `sendOneRelayLeg` at `app/src/jobs/relayFanOut.ts:1240`; the
  fan-out loop now calls it (`:1123-1145`). Behavior-preserving - the extracted
  body is the old loop body with `continue` becoming a returned outcome.
- `claimFanoutPass` against the RETRY row: `app/src/jobs/relayRetryLeg.ts:616-620`.
- `capped` -> `transient_cap` close written directly (`closeTerminally`, `:471`)
  plus the D23 ERROR (`:625-634`).
- The re-enqueue uses the FAN-OUT's backoff shape, not the retry ladder's
  (`:302`, `:639`), and consumes no retry rung (the payload and
  `relay_retry_attempt` are untouched).
- Both backoffs injectable through deps: `backoffMs` / `transientBackoffMs`
  (`:122`, `:129`).
Proven at `app/test/relayRetryLeg.test.ts:655`, `:686`, `:700`, `:717`, `:739`.

**D11. Lineage values on the row; the client projects the render-bearing ones.**
PARTIAL - see finding 3. Six values are stored
(`app/src/repos/messagesRepo.ts:738-754`, stamped at `:2220-2237`), the raw
destination is not, and the client projector forwards exactly four
(`dashboard/src/routes/conversation/useRelayThread.ts:519-528`). What does not
hold is the spec's sentence "four fields reach the wire": the endpoint returns
stored rows as-is, so `relay_retry_dest_digest` and `relay_retry_leg_body` reach
every browser too. The build says so in its own comments
(`dashboard/src/api/types.ts:12-16`, `:39-44`) rather than hiding it.

**D12. The retry sends the original outbound representation; RAW body on the
row, leg copy stored separately.** DELIVERED. The append stores the raw body
(`twilio.ts:2804`) and the composed copy in `relayRetryLegBody` (`:2810`);
rungs 2+ copy the stored copy verbatim rather than re-composing
(`:2775-2780`). The job sends the stored copy (`app/src/jobs/relayRetryLeg.ts:581`)
and `sendOneRelayLeg`'s docblock forbids passing a raw body
(`app/src/jobs/relayFanOut.ts:1262-1268`). The media-only arm of the composition
is handled (`twilio.ts:611-617`). Proven at
`app/test/relayRetryClaim.webhook.test.ts:330` and `app/test/relayRetryLeg.test.ts:424`
(sender renamed between attempts, copy byte-identical).

**D13. Attachments re-presigned per attempt; a retry row writes no media-pointer
rows.** DELIVERED. `isRelayRetryRow` gates the pointer writes out of the append
transaction (`app/src/repos/messagesRepo.ts:2286`, `:2373`) while the durable
`s3Key`s still ride the row; the job re-presigns through the extracted unit
(`app/src/jobs/relayFanOut.ts:1327-1333`). Proven at
`app/test/messagesRepoRetryLineage.integration.test.ts:110`, `:142`,
`app/test/relayRetryLeg.test.ts:519`, and the harness fake is pinned to match
(`app/test/twilioWebhookHarnessMediaIndex.test.ts:23`). The spec's stated
RATIONALE is wrong today (see finding 10); the behavior is built regardless.

**D14. An enqueue failure closes the retry leg terminally with `enqueue_failed`.**
DELIVERED. `closeRetryLegEnqueueFailed` at `twilio.ts:627-664`, called from the
enqueue catch (`:2861`), with the code distinct from `transient_cap` and its own
D23 ERROR (`:2871-2901`). The close is separately guarded so a throw from it does
not mislabel the outcome as `claim_failed`. Proven at
`app/test/relayRetryClaim.webhook.test.ts:575`, `:597`, `:728`. See finding 11 on
line count.

**D15. Close codes enumerated, every one with operator copy.** DELIVERED, string
for string against the spec table:
`dashboard/src/routes/contact/deliveryStatus.ts:931-934`. `enqueue_failed` and
`transient_cap` reuse their existing entries as the spec requires. Proven at
`dashboard/src/routes/contact/deliveryStatus.test.ts` ("deliveryReason - the four
retry close codes (D15)"), including the no-product-options case.

**D16. Live-surface effects, named one at a time.** DELIVERED, plus an addition
(finding 5).
- Last activity / inbox ordering after a SUCCESSFUL send, through a NEW
  status-free repo method: `touchLastActivityPreservingStatus`
  (`app/src/repos/conversationsRepo.ts:677` interface, `:1623` impl - no `status`
  in the UpdateExpression, `attribute_exists` preserved), called only on the
  `sent` outcome (`app/src/jobs/relayRetryLeg.ts:600`). Proven at
  `app/test/conversationsRepoActivityBump.integration.test.ts:77` and
  `app/test/relayRetryLeg.test.ts:469`, `:506`.
- SSE on the CLAIM: `twilio.ts:2900`, addressed to the ROOT, fires even when
  nothing transitioned (`app/test/relayRetryClaim.webhook.test.ts:764`, `:777`).
- Unread counts: unchanged (no unread write on either path).
- Push: never (no push service reachable from `relayRetryLeg.ts`).

**D17. The four wire-bound lineage fields added to `TimelineMessage` and the
relay projector; `RelayRecipientDelivery` NOT changed.** DELIVERED.
`dashboard/src/api/types.ts:45-52` (TimelineMessage) and `:17-24` (Message);
projector at `dashboard/src/routes/conversation/useRelayThread.ts:519-528`.
`RelayRecipientDelivery` has no diff - no per-leg retry state is stored on a slot,
which keeps D1's promise.

**D18. A per-member RETRY STATE derived at the join; staleness untouched; the
ticker armed by the retry state itself.** DELIVERED - and BOTH halves of
`unconfirmed` shipped, which is the failure mode this design produced five times.
- Half one, the stranded claim (never reached `sent`, aged from the RETRY ROW's
  own `at`) and half two (reached `sent`, no receipt, aged from `sentAt`) are one
  function: `rungStalenessClockMs`
  (`dashboard/src/routes/contact/relayRetryJoin.ts:190-194`) returns
  `parseRetryClock(leg.sentAt) ?? row.atMs`, and `isRetryRungLive` (`:217-229`)
  judges it through the module's single budget via `isQuietSince`
  (`dashboard/src/routes/contact/deliveryStatus.ts:98`, `STALE_SENT_AFTER_MS` at
  `:64`). One budget, two clocks - the two horizons cannot drift.
- Both halves are separately asserted:
  `dashboard/src/routes/contact/relayRetryJoin.test.ts:202` (never reached sent)
  and `:213` (sent, no receipt).
- `stalenessClockMs` is NOT touched and NOT called from the join (grep confirms
  no reference in `relayRetryJoin.ts`).
- The ticker clause: `dashboard/src/routes/contact/Timeline.tsx:864-883`, asked
  through the join's OWN exported predicates so the ticker and the chip cannot
  disagree. Both counts in the docblock moved and are now internally consistent
  with their own lists (`Timeline.tsx:773-775`, `:819`, and the run-condition
  comment at `:2079`).
- The clause TERMINATES, and that is its own test:
  `dashboard/src/routes/contact/Timeline.ticker.test.tsx:797`, `:819`, `:842`, `:895`.

**D19. The four end states, the arithmetic, one projection, `retryState` its own
field, every reason site consuming it.** PARTIAL - the substance is delivered;
two sub-clauses moved (findings 1 and 12).
- Arithmetic, exactly as the table: `deliveryStatus.ts:477-511`. `terminal` stays
  in `failed`; `retrying` is subtracted into its own count; `delivered-on-retry`
  counts itself through the projected `status: 'delivered'` plus an `on retry`
  suffix; `unconfirmed` joins the existing "not confirmed" slot as a UNION so a
  leg that is both counts once. K/R/J are disjoint by construction and the order
  is fixed (`:513-524`).
- `retryState` is a SEPARATE field and is never smuggled into `status`:
  `relayRetryJoin.ts:69-71`, `deliveryStatus.ts:177`. The only values ever written
  to `status` are members of the closed union (`relayRetryJoin.ts:345`, `:382`
  overlay a rung status that is `delivered` / `queued` / `sent` by construction).
  A compile-time assertion pins the supertype relationship
  (`relayRetryJoin.ts:79-80`).
- ALL FOUR live reason sites consume the projection, from ONE derived set
  (`projectedEntries`, `Timeline.tsx:1025`): the rollup chip (`:1054`), the
  rollup's accessible-name recital (`:1090-1092` via `recipientRows` at `:1072`),
  the inbound recital (`:1132-1143`), and the per-recipient row (`:1237-1275`).
  The FIFTH site (the message-level chip's own headline) is deliberately left out
  and its recital shares `recipientRows` (`:1117-1128`), exactly as D19 says.
- The two lifetimes are real: `indexRelayRetries` is memoized on `items`
  (`Timeline.tsx:2036`), `projectRelayLegs` is NOT memoized and recomputes
  against the bubble's clock (`:1025`).
- Composition of multiple states in one label is proven
  (`deliveryStatus.test.ts` "composes all three categories in the fixed order").
- The shared `Delivered N/N` label does not move: `retryAware` defaults off and
  the whole retry arithmetic collapses to the pre-retry two counts
  (`deliveryStatus.ts:457-459`), asserted at `deliveryStatus.test.ts` "ignores
  retryState entirely without the retry-aware flag" and "leaves the all-delivered
  label untouched without a retry".

**D20. A retry row renders ONLY when its leg delivered AND its original was
outbound, both from its own lineage; never `retry_of`.** DELIVERED.
Filter at `Timeline.tsx:1993-2001`, inside `visible`, narrowed on
`kind === 'message'` FIRST so a milestone-merged list is safe; the three reads are
`relay_retry_origin_direction`, `relay_retry_member_key` and the row's OWN slot -
no dependence on the original being loaded. Default-HIDE on a missing or
out-of-union direction. `retryOf` is never stamped
(`twilio.ts:2811-2813` documents the omission) and is asserted absent at
`app/test/relayRetryClaim.webhook.test.ts:304`. Client proof, including the
inbound-original and non-delivered cases and the untouched 1:1 collapse:
`dashboard/src/routes/contact/Timeline.test.tsx` "relay retry rows that earn no
bubble (D20)". Both non-contact hosts proven:
`dashboard/src/routes/placements/PlacementConversation.test.tsx` and
`dashboard/src/routes/tours/TourConversation.test.tsx` (milestone-merged list).

**D21. "Retrying" appears only where a retry was actually claimed.** DELIVERED.
Every `retryState` originates from a retry ROW in `indexRelayRetries`
(`relayRetryJoin.ts:131-161`); nothing derives it from an error code. The retry
bubble's own message-level chip is left at today's behavior.

**D22. An orphaned retry bubble reads honestly.** DELIVERED. The `retryRow`
option is read off the ROW, not the projection (`Timeline.tsx:1066`), and yields
`delivered N/N on retry` (`deliveryStatus.ts:587`). Orphan case proven at
`Timeline.test.tsx` "renders an orphaned delivered retry".

**D23. Attempt-aware severity ON TOP of the 21610 carve-out; announcements keep
WARN; a `retryClaim` cause on every relay failure line.** DELIVERED in substance,
with a vocabulary that outgrew the spec (finding 2).
- ON TOP, not instead of: `isTerminalRelayLegFailure`
  (`twilio.ts:433-443`) first delegates to `isTerminalDeliveryFailure` and only
  then applies the attempt-aware rule, and it applies that rule to `30003` ALONE.
  21610 therefore still reaches the WARN path unchanged (`:437`), proven at
  `app/test/twilioStatusWebhook.test.ts` "keeps 21610 at WARN on a relay leg".
- Announcement legs keep WARN: `fenced_announcement` is in the WARN set (`:440`),
  proven at `app/test/twilioStatusWebhook.test.ts` "keeps an announcement leg at
  WARN" and at the claim level `app/test/relayRetryClaim.webhook.test.ts:407`.
- A `retryClaim` cause is on EVERY relay failure line: the claim helper is called
  unconditionally for every relay status callback (`twilio.ts:3003`) and returns
  `code_not_retryable` rather than nothing when the code is not 30003
  (`:2685-2686`), so the marker at `:3077` always carries a cause. Asserted as a
  FIELD, not a string, throughout `app/test/twilioStatusWebhook.test.ts:114-470`.
- The three internal anomalies take their own message
  (`twilio.ts:96-103`, selected at `:3084-3086`).
- The shared `TRANSIENT_RETRYING_DELIVERY_CODES` keeps its VALUES and its comment
  is rewritten to name the group-text exception and point at
  `docs/issues/group-text-30003-leg-retry-promise-unverified.md`
  (`twilio.ts:322-341`); that issue exists.
- The terminal ERROR is emitted by whoever observes the terminal state: the JOB
  for gate refusal / enqueue failure / transient cap
  (`relayRetryLeg.ts:492`, `:515`, `:536`, `:545`, `:625`, `:643`, `:683`), the
  CALLBACK for cap exhaustion (`twilio.ts:2759` -> `:3089`).

---

## Part 2 - the twenty test intentions of Sec 7

Coverage was established by reading test bodies, not names. No suite was run.

1. Forward claim + enqueue - COVERED. `app/test/relayRetryClaim.webhook.test.ts:264`.
   Cannot pass on `main` (nothing appends a lineage row there).
2. TWO guards, tested separately - COVERED, and genuinely separate:
   duplicate CALLBACK at `relayRetryClaim.webhook.test.ts:350`, duplicate JOB
   DELIVERY at `app/test/relayRetryLeg.test.ts:287` (re-dispatch of the same
   envelope, asserting `world.sent` stays at 1).
3. Rung 3 and stop, asserting THREE - COVERED.
   `relayRetryClaim.webhook.test.ts:473` asserts three rows with attempts
   `[1,2,3]`; `:488` drives five failures and still asserts three.
4. Announcement claims nothing AND an unreadable source claims nothing -
   COVERED. `:407` and `:422`. WEAK on one word: the announcement case is proven
   through `SYSTEM_SENDER_KEY`, not through a tour-reminder rung specifically
   (finding 9).
5. Gate refusal, all four, with the reason on the ORIGINAL's presentation -
   COVERED. Server: `relayRetryLeg.test.ts:307-374` (table of four, changed-number
   its own row plus `:388` and `:407`). Client: the close code is projected onto
   the ORIGINAL leg (`relayRetryJoin.test.ts:185`) and rendered
   (`Timeline.delivery.test.tsx:987`).
6. Enqueue failure terminal, code distinct from the cap, both as prose -
   COVERED. `relayRetryClaim.webhook.test.ts:575`, `:597`;
   `Timeline.delivery.test.tsx:379`, `:410`.
7. No duplicate send to other members, on every rung - COVERED.
   `relayRetryClaim.webhook.test.ts:499` (whole ladder), `relayRetryLeg.test.ts:457`,
   and the browser proof reads the fake's thread store directly
   (`e2e/tests/dashboard-next/relay-30003-retry.spec.ts:304-319`).
8. A delivered retry cannot be regressed by a late older-attempt callback -
   COVERED structurally and at the join: each rung owns its own row and slot (D1),
   and the join makes delivered win permanently
   (`relayRetryJoin.test.ts:140`, `:154`).
9. Transient re-enqueue, no rung consumed, `transient_cap` at the budget -
   COVERED. `relayRetryLeg.test.ts:655`, `:686`, `:700`, `:717`, `:739`.
10. MMS: re-presign, byte-identical leg copy after a rename, RAW body on the row,
    no gallery rows - COVERED. `relayRetryLeg.test.ts:519`, `:424`;
    `relayRetryClaim.webhook.test.ts:330`;
    `messagesRepoRetryLineage.integration.test.ts:110`, `:142`;
    `twilioWebhookHarnessMediaIndex.test.ts:23`, `:69`.
11. No `retry_of`, original still renders beside a delivered retry - COVERED.
    `relayRetryClaim.webhook.test.ts:304`; `Timeline.test.tsx` "never hides the
    original" and "leaves the existing retry_of collapse untouched".
12. All four states at EVERY position that exists, including
    `inboundRecipientName` - COVERED, and the inbound recital IS its own test:
    `Timeline.delivery.test.tsx:931` ("updates the inbound recital when a
    member-originated leg recovers"). The other three positions at
    `:859`, `:957`, `:987`, `:1026`; the no-retry identity case at `:1059`;
    non-delivered and inbound-original retries render no bubble
    (`Timeline.test.tsx` it.each); shared label and group text unchanged
    (`deliveryStatus.test.ts` "leaves the all-delivered label untouched without a
    retry", "leaves a native group-text leg with no retryState untouched").
13. SSE on the claim; the bump does not write `status` - COVERED.
    `relayRetryClaim.webhook.test.ts:764`, `:777`; `relayRetryLeg.test.ts:469`
    (group closed mid-backoff stays closed);
    `conversationsRepoActivityBump.integration.test.ts:77`. Browser half at
    `relay-30003-retry.spec.ts:187-244`.
14. Severity: WARN while claimed, ERROR when terminal, 21610 carved out, 1:1 and
    native group text unchanged - COVERED.
    `app/test/twilioStatusWebhook.test.ts:214`, `:237`, `:252`, `:384`, `:427`.
15. A stranded claim reaches `unconfirmed` with NO other thread activity and no
    refetch - COVERED, and it is the ticker test that proves the freezing failure
    mode is closed: `Timeline.ticker.test.tsx:770` (arms on a thread whose every
    RENDERED leg is terminal) and `:783` (flips to not confirmed with no refetch
    and no item change).
16. Crash between the slot write and the claim RECOVERED by the redelivery -
    COVERED. `relayRetryClaim.webhook.test.ts:364`.
17. The slot-code-ABSENT clause exercised, not assumed - COVERED.
    `relayRetryClaim.webhook.test.ts:375`.
18. A LEGACY original produces a legacy row and slot and does not take the
    versioned path - COVERED at both ends.
    `relayRetryClaim.webhook.test.ts:510`; `relayRetryLeg.test.ts:543`, `:564`.
19. Every decline path stamps its own `retryClaim`; the unreadable source takes
    its own message; assert the FIELD - COVERED.
    `relayRetryClaim.webhook.test.ts:422`, `:443`, `:460`;
    `app/test/twilioStatusWebhook.test.ts:264`, `:278`, `:289`, `:310`, `:328`,
    `:347`, `:364`. Every assertion is on `retryClaim` as a field.
20. The ticker TERMINATES - COVERED as its own intention, separate from
    `unconfirmed` appearing: `Timeline.ticker.test.tsx:797`, `:819`, `:842`, `:895`.

E2E: the flow, the two moments and the send counts are all present
(`e2e/tests/dashboard-next/relay-30003-retry.spec.ts`). The old file's negative
assertions survive (five `will retry` negatives, plus the `(error 30003)` check
relocated to the recital at `:243`). See finding 6 on the rename.

---

## Part 3 - the fences

All held. Verified by `git diff --name-only main...HEAD`, which contains none of:

- `app/src/services/relayAnnouncements.ts` - UNTOUCHED. Only
  `SYSTEM_SENDER_KEY`, `isMemberSuppressed` and `logSafeMemberKey` are imported,
  all already exported on `main`.
- `app/src/jobs/tourReminders.ts` - UNTOUCHED.
- `app/src/jobs/retrySend.ts` and the 1:1 retry/collapse path - UNTOUCHED.
  `presentLegDelivery` gained a 5th parameter with a default, so every existing
  caller is byte-identical (`deliveryStatus.ts:668-674`).
- Native group-text receipt behavior - FENCED THREE TIMES: the retry-aware
  arithmetic is off unless `retryAware` is passed (`deliveryStatus.ts:457-459`),
  the retry row states are gated on `rosterKind === 'relay'` (`:725`), and the
  thread-level index is roster-gated so a group text cannot even arm the ticker
  (`Timeline.tsx:2036-2039`, proven at `Timeline.ticker.test.tsx:872`).
- `stalenessClockMs` - UNTOUCHED and never called from the join.
- `ALLOWED_PRIOR` and the forward-only status machine - UNTOUCHED.
- The rollup chip's `outbound` gate - UNTOUCHED (`Timeline.tsx:1046-1047` still
  requires `outbound &&`). The inbound source gets the two positions the spec
  says it has, and only those.
- `flagPlacementAttention` itself - UNTOUCHED. Exactly ONE condition added at its
  CALL SITE (`Timeline`-side nothing; `twilio.ts:3129`), which is what the spec
  permitted. It reads the eventually-consistent `source` and fails OPEN on a read
  miss, and is false for every row written before this branch. Proven at
  `relayRetryClaim.webhook.test.ts:793`, `:803`, `:815`.
- `dashboard/src/lib/messageTransport.ts` - in scope per Sec 2 but needed no
  change: `includedRecipientEntries` is already generic over the slot type
  (`:49-57`), so the projected leg passes through it without erasure.

---

## Part 4 - findings

Ordered by severity, then by how far the tree is from the contract.

### 1. [MEDIUM] The chip and the row carry a carrier reason on `retrying` and `unconfirmed` - copy beyond the founder-approved D19 tables

D19's first table specifies the original bubble's chip for `retrying` as
`delivered 3/4 - 1 retrying` and for `unconfirmed` as
`delivered 3/4 - 1 not confirmed`. D19's second table specifies the row and
recital copy for `unconfirmed` as "today's not-confirmed row copy". Sec 5 records
the whole display contract as founder-approved on 2026-09-02.

The build appends a carrier reason at both positions on both states. The
not-confirmed branch of `presentRelayDelivery` now returns a `reason`
(`deliveryStatus.ts:540`, built at `:567-575`), and the visible chip renders
`label - reason` (`Timeline.tsx:1206-1207`), so a live ladder reads
`delivered 1/2 - 1 retrying - Phone unreachable (error 30003)`. The
`unconfirmed` leg presentation attaches the same reason to
`STALE_QUEUED_PRESENTATION` / `STALE_SENT_PRESENTATION`
(`deliveryStatus.ts:761-763`), so the row reads
`Queued - not confirmed - Phone unreachable (error 30003)` where the spec says
today's copy.

This came from code review R2 (W5) and is well reasoned - without it the
stranded-claim state named the carrier failure at no position at all - and R3 (X3)
correctly fenced it to retry legs so a plain stale leg outside this feature is
byte-identical. `Retrying - Phone unreachable (error 30003)` at the ROW is
explicitly in D19's second table, so only the CHIP is new there. But the
`unconfirmed` row copy and both `unconfirmed`/`retrying` chip strings are copy the
founder has not seen. The e2e pins only `toContain('1 retrying')`, so nothing in
the suite would catch a further drift here.

Not blocking on correctness; blocking-adjacent on process, because Sec 5 is the
one section of this spec that carries an approval stamp. Recommend showing the
four resulting strings to the founder at merge, or reverting the chip half.

### 2. [LOW] D23's `retryClaim` vocabulary shipped at thirteen values against the spec's seven

Spec D23 enumerates seven: `claimed`, `cap_exhausted`, `gate_refused`,
`fenced_announcement`, `to_missing`, `to_malformed`, `source_unreadable`. The
union at `app/src/lib/relayRetryClaim.ts:47-90` has thirteen: those seven plus
`already_claimed`, `slot_ineligible`, `slot_settled`, `code_not_retryable`,
`enqueue_failed`, `claim_failed`. `app/test/relayRetryClaim.test.ts:51` pins the
count at thirteen.

Each addition is defensible under D23's own rule ("every relay delivery-failure
log line carries WHY no retry is running") and two of them carry SEVERITY, which
is the part that matters: `slot_settled` and `fenced_announcement` are the WARN
set (`twilio.ts:439-442`). I checked `slot_settled` against the approved set -
"every fan-out or team leg that ends terminally ON 30003" - and it is correctly
outside it, because a `slot_settled` leg by definition ended on `delivered` or on
some other terminal code. The shipped ERROR set is therefore not larger than the
approved one. Recorded as a deviation because the spec's Sec 6 now understates
the vocabulary by six values; the handback names this and it should be corrected
when the docs are stamped historical.

### 3. [LOW] Six lineage values reach the browser, not the four D11 promises

D11 asserts "The four fields that reach the wire are the root id, the member key,
the attempt number and the original's direction." That sentence cannot hold
beside D11's own reasoning that
`GET /api/conversations/:id/messages` returns stored rows AS-IS: the digest
(`relay_retry_dest_digest`) and the composed leg copy (`relay_retry_leg_body`) are
both stored (`app/src/repos/messagesRepo.ts:2229-2237`) and therefore both ride
the JSON on every relay thread load.

The build did NOT hide this - `dashboard/src/api/types.ts:12-16` and `:39-44` and
`useRelayThread.ts:512-518` all say plainly that six arrive and four are
projected, and the distinction drawn ("projected", not "on the wire") is the
honest one. The exposure is bounded to authenticated staff who already see the
roster and the message body, and the leg copy is the body plus a sender name they
can also see. Recorded because the spec text is now false, and because the
handback's "Spec text that trails the tree" section does NOT list it. Open
question Q3 (an unkeyed truncated SHA-256 whose salt travels beside it) is the
same surface and is already flagged for the human.

### 4. [LOW] The backoff seam is an env var read inside the job, not `routes/dev.ts` and not the deps object alone

Sec 2 puts `app/src/routes/dev.ts` and the e2e lane env in scope as "the backoff
injection seam", and Sec 7 says "the backoff is injected through the retry job's
existing deps object with the lane supplying the value" while explicitly noting
"no env override exists".

`app/src/routes/dev.ts` is untouched. The tree ships THREE links:
`deps.backoffMs`, a module-scope store written at registration, and a NEW env
override `E2E_RELAY_RETRY_BACKOFF_MS` read inside the job module
(`app/src/jobs/relayRetryLeg.ts:165`, `:190-196`, `:214-218`), set by
`scripts/e2e-session.mjs:254-271`.

The reason is sound and is documented at length (`relayRetryLeg.ts:132-152`): in
production the app process registers no handlers but IS where every rung is
enqueued, so a deps-only seam would have been silently inert there. The override
is topology-guarded on `JOBS_QUEUE_URL` so it cannot reshape a real ladder
(`:190-192`), and that guard has its own tests
(`app/test/relayRetryLeg.test.ts:1117`, `:1123`, `:1135`, `:1143`). Still a
mechanism the spec did not authorise, and the lint gate cannot see
`scripts/e2e-session.mjs` (a `.mjs` file, unlinted by config).

### 5. [LOW] D16's SSE contract was extended to the job's terminal closes

D16 names exactly one SSE trigger: the CLAIM. The retry job now also emits
`message.persisted` for the ROOT on every terminal close it writes - the four gate
refusals, `transient_cap`, its own `enqueue_failed`, and the
`refused`/`filtered`/`suppressed` slots the extracted unit wrote
(`app/src/jobs/relayRetryLeg.ts:439-446`, called at `:466`, `:479`, `:696`).

This is self-QA finding P1, verified live, and the reasoning mirrors D16's own
("a false state, for minutes, on the surface this feature exists to make
truthful"): without it a refused ladder kept reading `retrying` until an unrelated
SSE arrived. It is an addition rather than a contradiction, it is after the
durable write in all three sites, and it is pinned
(`app/test/relayRetryLeg.test.ts:873`, `:889`, `:906`, `:919`). Recorded because
an unrecorded improvement is still a surprise, and because it adds SSE traffic the
spec's Sec 8 "no post-merge obligations" analysis did not consider.

### 6. [LOW] The e2e spec was renamed, where Sec 7 says "UPDATED, not replaced"

Sec 7: "`relay-30003-no-retry-promise.spec.ts` is UPDATED, not replaced". The
tree deletes that file and adds
`e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (a `git mv` per the
handback, so history follows).

The SUBSTANCE survives, which is what the sentence was protecting: I diffed the
old file's assertions against the new one and all five `will retry` negatives are
present (`relay-30003-retry.spec.ts:235`, `:244`, `:250`, `:261`, `:270`, `:284`,
`:297`), and the `(error 30003)` check is relocated to the recital at `:243` with
a comment saying why. The new file's header names the old one. Recorded only so
that nobody searching for the old filename concludes the checklist was dropped.

### 7. [LOW] D2's seeded slot takes the ORIGINAL SLOT's `requestedTransport`, not a freshly computed intent

D2 specifies the seeded slot on a versioned original as
`{ status: 'queued', requestedTransport: <intent>, transportAggregationState: 'planned' }`.
The claim reads the ORIGINAL SLOT's stored `requestedTransport`
(`twilio.ts:2768`, seeded conditionally at `:2797`) rather than classifying an
intent, and OMITS the field entirely when the original slot carries none - so a
versioned original whose slot has no `requestedTransport` yields a versioned retry
slot with none either.

Arguably more faithful than the spec's wording (it preserves what the failed leg
actually requested), and the retry job classifies its own intent afresh at send
time from the row's attachments (`app/src/jobs/relayRetryLeg.ts:382-390`), with
the mismatch case - media present, no MediaStore - logged as its own ERROR
(`:558-563`). The `planned` half, which is the load-bearing part of D2, is
unconditional and proven (`relayRetryClaim.webhook.test.ts:522`, which also
asserts the send really reaches `attempted`). No test covers the
versioned-original-with-no-slot-transport shape.

### 8. [LOW] D4's duplicate-delivery marker fails OPEN when no `jobId` is in context

`app/src/jobs/relayRetryLeg.ts:350-359`: if `getContext()?.jobId` is absent, the
handler logs a WARN and proceeds WITHOUT the marker. D4 says the marker "defeats
duplicate DELIVERIES" and states both guards are required; it does not describe a
path on which the guard is skipped.

The fan-out and `retrySend` set the marker the same way, so this mirrors the
house pattern rather than inventing one, and a missing `jobId` should not occur on
the real queue path. But the consequence of the fail-open is a duplicate SMS to a
member, which is the exact harm D4 exists to prevent. No test covers the
no-`jobId` branch. Worth a one-line decision from the human: throw, or keep the
WARN.

### 9. [LOW] Intention 4's "including a tour-reminder rung" is proven through the sentinel, not through a rung

Sec 7 intention 4 asks for "an announcement leg claims nothing, INCLUDING a
tour-reminder rung". `app/test/relayRetryClaim.webhook.test.ts:407` seeds a source
carrying `SYSTEM_SENDER_KEY` and asserts no claim plus WARN, and asserts the
literal value `'system'` at `:416`.

That is structurally sufficient - D7 establishes that `SYSTEM_SENDER_KEY` has ONE
writer, the single append behind all four announcement callers including tour
reminders - and `app/src/jobs/tourReminders.ts` is fenced and untouched. Recorded
because the intention named the rung specifically, and because the fence's whole
purpose is to keep this mission's blast radius off the tour-reminder ladder.

### 10. [LOW] D13's stated rationale is false in the current tree; the behavior was built anyway

D13 justifies media-pointer suppression with "a three-rung ladder would triple a
photo in it [the Media from comms gallery]". The gallery's only reader excludes
relay threads BY NAME (`app/src/routes/contacts.ts`, cited by the build's own
comment at `app/src/repos/messagesRepo.ts:2365-2370`), so no photo would be
tripled in any surface today.

The build recorded this in research, built the suppression regardless, and left a
comment explaining that the exclusion is by name and therefore reversible. That is
the right call - the durable garbage is real even if unread. Recorded so the
rationale is corrected rather than inherited when the spec is stamped historical.

### 11. [LOW] A D14 enqueue failure emits two ERROR lines, where R3 made "one line per fault" a property for `claim_failed`

On an enqueue failure the claim path logs its own ERROR
(`twilio.ts:2871-2901`, carrying `retryClaim: 'enqueue_failed'` and the close
code) and then falls through to the failure marker, which ALSO reaches ERROR for
the same callback (`:3089`, since `enqueue_failed` is outside the WARN set). Two
ERROR lines, two `ErrorLogs` datapoints, one of them without an `event` field.

Code review R3 (X1) went to some length to make exactly this a single line for
`claim_failed`, by catching the rethrow at the route and answering the 500 there
(`twilio.ts:3177-3197`). The same reasoning applies to `enqueue_failed` and was
not applied. It interacts with open question Q4 (alarm volume). Cosmetic for
diagnosis - both lines are attributable - but inconsistent with the standard the
build set for itself.

### 12. [LOW] D19's projection runs per bubble, not at thread level

D19: "The projection happens at THREAD level, onto the recipient ENTRIES". The
tree computes the LINEAGE half at thread level and memoizes it on `items`
(`Timeline.tsx:2036`), threads that index down through `StreamItem` to
`MessageBubble` as a required prop (`:1722`, `:912`), and runs
`projectRelayLegs` inside each bubble against that bubble's own clock
(`:1025-1034`).

The plan (rev 5) says exactly this - "Compute `indexRelayRetries` once at thread
level beside `visible`, memoized on `items`; call `projectRelayLegs` per bubble
against `bubbleNowMs`" (plan `:1110-1113`) - so the build follows its approved
plan, not its own preference. Every property D19 was protecting survives: the two
lifetimes are distinct and correct, each message is projected exactly once,
nothing downstream reads a raw slot, and the bubble consumes the thread-level
index rather than re-deriving lineage. Recorded because the spec sentence and the
tree no longer say the same thing, and the next reader of D19 will look for a
thread-level `projectRelayLegs` call that does not exist.

---

## Verdict

**CONFORMS, with twelve recorded deviations - one MEDIUM, eleven LOW. No BLOCKING
or HIGH finding. Merge-ready on spec conformance.**

Every one of D1-D23 is delivered in substance; two (D11, D19) are PARTIAL only
against spec sentences that the tree has outgrown or that were internally
inconsistent to begin with, and both are documented in the code rather than
papered over. All twenty Sec 7 test intentions have real coverage, checked by
reading test bodies: intention 4 is proven one step short of the letter
(finding 9) and everything else is proven as written. Every hard fence held, with
`flagPlacementAttention` modified only at the one call-site condition the spec
permitted.

The four decisions that cost this design the most review rounds are the four the
build got most exactly right. D3/D4 ship both guards, in different files, tested
separately. D8 gates on the slot's post-write state with a genuinely consistent
read and has a crash-recovery test that a transition gate would fail. D18 ships
BOTH halves of `unconfirmed` off one shared budget, with the ticker armed by the
join's own predicates and its termination asserted as its own intention. D19
keeps `retryState` off `status`, moves all four live reason sites onto one derived
set, and keeps the shared `Delivered N/N` label byte-identical behind a
default-off flag.

The single item I would put in front of the human before merge is finding 1: Sec 5
is the one founder-approved section of this spec, and the shipped chip and row
carry four strings its tables do not. It is a good change, arrived at honestly
through R2/W5 and correctly fenced by R3/X3 - it just has not been shown to the
person who approved the tables.
