# Slice G report - plan Tasks 12 and 13 (the claim and the severity taxonomy)

Implementer record for the retry CLAIM inside the Twilio status webhook's relay
branch - its consistent read, its positive fence, its state gate, the retry
row it appends, the SSE on claim, the `enqueue_failed` close and the one
condition on the placement escalation - and for the attempt-aware severity
taxonomy with a `retryClaim` cause on every relay delivery-failure line.

Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `2af362e2` (the main merge).

**This is the slice that starts CREATING retry rows.** Every display task
already landed, so the product stays coherent from the first row.

## Commits

| hash | subject |
| --- | --- |
| `71181d79` | feat(relay): claim a 30003 retry from the relay status callback |
| `c05a25d7` | fix(relay): attempt-aware severity and a retryClaim cause on every failure line |
| (this file) | docs(records): slice G report - the claim and the severity taxonomy |

Bare `git status` was read before each commit and `.git/MERGE_HEAD` was
confirmed absent both times. Explicit paths only; nothing amended.

## Files

- MODIFY `app/src/routes/webhooks/twilio.ts` - the claim helper and its two
  factory-scope helpers, the module-level severity predicate and log-safe key
  helper, the `retryClaim` field on the failure marker, the escalation
  condition, and the shared set's comment. +447 / -5 across both commits.
- MODIFY `app/test/helpers/twilioWebhookHarness.ts` - the six `relayRetry*`
  passthroughs the fake `append` was missing (+20 / -0).
- CREATE `app/test/relayRetryClaim.webhook.test.ts` - 27 tests (+675).
- MODIFY `app/test/twilioStatusWebhook.test.ts` - the severity battery
  (+212 / -1).

`app/test/relayWebhook.test.ts` was NOT touched - see divergence 1.

## Test results, quoted from the runner

Pass glyphs rendered `[ok]` so this file stays ASCII.

```
 [ok] test/relayFanOut.test.ts (81 tests) 99ms
 [ok] test/relayWebhook.test.ts (27 tests) 327ms
 [ok] test/relayRetryClaim.webhook.test.ts (27 tests) 353ms
 [ok] test/twilioStatusWebhook.test.ts (47 tests) 613ms
 [ok] test/relayRetryLeg.test.ts (37 tests) 45ms

 Test Files  5 passed (5)
      Tests  219 passed (219)
```

`twilioStatusWebhook` moved 40 -> **47** (the seven severity cases);
`relayWebhook` is still **27**, `relayRetryLeg` still **37** and `relayFanOut`
still **81** - nothing in this slice is visible to them.

## Gates

| gate | after commit 1 | after commit 2 |
| --- | --- | --- |
| `npm run typecheck` (bare, worktree root) | **exit 0** | **exit 0** |
| `npx eslint` on the touched files | exit 0, no output | exit 0, no output |
| ASCII on added lines (`git diff -U0 \| grep '^+' \| tr -d ... \| wc -c`) | **0** all files | **0** all files |

`npm test`, `npm run smoke`, `npm run e2e` and Playwright were deliberately NOT
run; the orchestrator owns the battery. `AWS_ACCESS_KEY_ID` was never exported.
No background command is running.

## Watched RED first

The suites were written against working code, so both were falsified by
disabling the implementation and re-running, then restoring:

- **Claim disabled** (an unconditional `code_not_retryable` at the top of the
  helper): **24 of 27 failed**. The 3 survivors are the ones that must survive -
  `code_not_retryable` on a 30005 (the early return produces it either way),
  and the two escalation cases, which are about not CHANGING today's behaviour.
- **Escalation condition removed**: both escalation cases failed - "does not
  re-escalate" (4 escalations instead of 1) and "still escalates a different
  member" (3 instead of 2, so it is sensitive to over-escalating too). The
  thread-scoped discriminator the plan warns about is excluded by construction:
  Carol's failure is posted AFTER two retry rows exist, so a "any retry row in
  this conversation" gate would drop it to 1.
- **Severity predicate reverted to the shared `isTerminalDeliveryFailure`**:
  the three ERROR-expecting severity cases failed; the four WARN/unchanged
  cases stayed green, which is exactly the fence they encode.

## The helper's outcome order, as implemented

Each step yields a value; the first that applies wins. The helper NEVER returns
out of `handleRelayRecipientStatus` - control always falls through to the
failure marker, the existing SSE emit and the escalation.

| # | condition | outcome |
| --- | --- | --- |
| 1 | `mapped` is not a failure, or `ErrorCode !== '30003'` | `code_not_retryable` |
| 2 | `getByTsMsgIdConsistent` (post-slot-write) returns nothing | `source_unreadable` |
| 3 | `relay_sender_key` absent/empty, or `=== SYSTEM_SENDER_KEY` | `fenced_announcement` |
| 4a | `params['To']` absent or empty | `to_missing` |
| 4b | `normalizeToE164(To)` is undefined | `to_malformed` |
| 5 | slot missing, not `failed`/`undelivered`, or its `errorCode` is present and not `'30003'` | `slot_ineligible` |
| 6 | `(relay_retry_attempt ?? 0) + 1 > MAX_RELAY_RETRY_ATTEMPTS` | `cap_exhausted` |
| 7 | `append` of the retry row returns `deduped: true` | `already_claimed` |
| 8 | `enqueueRelayRetryLeg` threw (slot closed `enqueue_failed`) | `enqueue_failed` |
| 9 | otherwise | `claimed` |

`gate_refused` is the JOB's value only; between the two writers all eleven
`RelayRetryClaimOutcome` values now have one.

Steps 8 and 9 both emit `message.persisted` for the ROOT (the row exists on
both paths). The root is `source.relay_retry_of ?? ptr.tsMsgId`, so every rung
points at the root; the digest is `relayRetryDigest(root, toE164)` and the
provider SID `relayretry-<digest>-<n>`.

## The severity rule, as implemented

`isTerminalRelayLegFailure(errorCode, outcome)` - the relay branch's ONLY
severity reader. ERROR iff `isTerminalDeliveryFailure(errorCode)` OR
(`errorCode === '30003'` AND the outcome is none of `claimed`,
`already_claimed`, `fenced_announcement`).

| code | outcome | level |
| --- | --- | --- |
| 21610 | `code_not_retryable` | WARN (carve-out kept) |
| 30005 / 30007 / no code | `code_not_retryable` | ERROR (today's rule) |
| 30003 | `claimed`, `already_claimed` | WARN |
| 30003 | `fenced_announcement` | WARN |
| 30003 | `cap_exhausted`, `to_missing`, `to_malformed`, `source_unreadable`, `slot_ineligible`, `enqueue_failed` | ERROR |

`source_unreadable` additionally takes its own `msg`
(`... - source message row unreadable, no retry claimed`) on the SAME line, so
there is exactly one delivery-failure record and it names its own cause. The
1:1 and native-group-text paths still read the shared set and their lines carry
no `retryClaim` at all (asserted).

## The leg copy's sender at rung 1, and what it used

`relayFanOut.ts:1000` is `payload.senderNameOverride ?? senderMember?.name`.
Reading the team-send path: `senderNameOverride` is **never a per-send value**.
Exactly two callers set it - `routes/api.ts:1835` (the dashboard team send) and
`services/relayQueuedMessages.ts:97` (the queued flush) - and BOTH pass the
compile-time constant `TEAM_SENDER_LABEL` (`= SMS_BRAND_NAME`), while both also
stamp `relaySenderKey: TEAM_SENDER_KEY` on the row they enqueue for.

So the SOURCE ROW does reproduce the override exactly, through
`relay_sender_key`, and nothing has to be stored for it. The claim resolves:

- `relay_sender_key === TEAM_SENDER_KEY` -> `TEAM_SENDER_LABEL`;
- otherwise the roster member whose `relayMemberKey` equals that key, `.name`
  (the same `conversations.getById` roster the fan-out reads).

Rungs 2+ never resolve anything - they copy `relay_retry_leg_body` verbatim
(D12), proven by a test that renames the sender between rungs 1 and 2 and
asserts the stored copy and the bytes actually sent are unchanged.

## How the ladder tests ran the job

`failNextLeg()` is one turn of the ladder, and it runs the REAL job rather than
simulating it:

1. `outbound.deliverDelayed(dispatchJob)` + `outbound.settle()` - dispatches
   whatever rung the previous callback scheduled (none on the first call), so
   `relay.retryLeg` runs its marker, its four gates and `sendOneRelayLeg` for
   real, which writes the retry leg's slot AND its `relaysid#` pointer.
2. Find the pointer for the newest retry row and the failed member.
3. Post a signed 30003 status callback for that leg's REAL provider SID.

`registerRelayRetryLegJobHandler` is wired to the SAME world the webhook writes
through, so each rung runs against the row the claim just appended. The source
is seeded DIRECTLY rather than through a real fan-out, which is what makes
"3 sends, all to the failed member, 0 to anyone else" a real assertion rather
than an arithmetic one - `world.sent` starts empty.

## Divergences, and why

1. **The claim tests are a NEW file, `app/test/relayRetryClaim.webhook.test.ts`,
   not an extension of `relayWebhook.test.ts`.** That file is 966 lines and is
   the golden suite for the INBOUND pipeline; 27 more cases with their own
   ladder machinery would have doubled it. The harness idioms are the same ones
   (`makeWebhookHarness`, `signedTwilioPost`, a directly written
   `relaysid#` pointer), except that this file KEEPS the capture handle -
   `relayWebhook.test.ts` discards it at `:85`, which makes log assertions
   impossible. Task 13's tests went into `twilioStatusWebhook.test.ts` as
   briefed.
2. **The attempt-aware severity predicate landed in commit 1, not commit 2.**
   Task 12's own test list asserts ERROR on `source_unreadable`, and the shared
   rule cannot produce it (30003 is a carve-out there), so splitting it out
   would have made commit 1 red. Commit 2 delivers the rest of Task 13 - the
   comment rewrite and the seven-case battery.
3. **The helper returns `{ outcome, attempt? }`, not a bare
   `RelayRetryClaimOutcome`.** The brief also asks the failure line to carry
   `retryAttempt` "where a row was created", and a bare outcome cannot supply
   it. The load-bearing property is unchanged: it returns a value and never
   returns out of the handler.
4. **The rung-1 leg copy mirrors ALL THREE arms of the fan-out's composition,
   not just `composeRelayBody`.** A MEDIA-ONLY relay leg was sent as
   `resolveMessage('relay.media_only', { name })` (`relayFanOut.ts:1006-1007`),
   so composing `"<name>: "` for one would resend a DIFFERENT - effectively
   empty - message than the one that failed, which is precisely what D12 exists
   to prevent. This cost two things: an import of `resolveMessage`, and
   `RELAY_ANONYMOUS_SENDER_LABEL = 'A member'` mirroring
   `relayFanOut.ts:109`'s module-private constant, commented as a mirror on
   both counts. The third arm (no text, no media) is unreachable - such a source
   relays nothing, so no leg exists to fail - and falls through to
   `composeRelayBody` so the field is always a string (the job throws on a
   non-string).
5. **The seeded slot's `requestedTransport` is read from the CONSISTENT
   re-read's slot, not from the value at `:2450`.** Identical path
   (`delivery_recipients[memberKey].requestedTransport`), fresher read, and it
   keeps the whole claim reasoning from one snapshot.
6. **`type` and `direction` are mirrored by NARROWING, not by copying**
   (`src.type === 'mms' ? 'mms' : 'sms'`, likewise inbound/outbound).
   `MessageItem`'s unions admit values a relay leg can never be (`call`,
   `email`), and `assertTransportPersistenceShape` requires a carrier type
   whenever a transport field is present. Every reachable value is preserved.
7. **The retry row carries NO message-level `requestedTransport`.** D2 specifies
   the SLOT's; the job re-classifies the intent itself from the row's own media.
   Setting one would additionally throw on an inbound-mirroring row. A test
   pins that a versioned INBOUND retry row has none while its slot does - the
   easy inversion.
8. **The enqueue failure emits a SECOND, diagnostic ERROR carrying `err` and
   `closeCode`,** beside the `delivery_failed` marker that carries
   `retryClaim: 'enqueue_failed'`. The marker cannot carry an `err` without
   changing a line the DeliveryFailures metric keys on, and an operator reading
   `enqueue_failed` with no reason is exactly the misattribution D23 is about.
   Mirrors the retry job's own `enqueue_failed` line
   (`relayRetryLeg.ts:483-486`). Its member key goes through the new
   `logSafeStoredRelayMemberKey`, and a test asserts no phone reaches it.
9. **`closeRetryLegEnqueueFailed` builds a `RelayTransportMode` whose `intent`
   is never read.** `persistRelayRecipientResult` branches on `kind` alone and
   `setVersionedAggregationState` takes no transport, but the type is a
   discriminated union, so the versioned arm needs one; it carries the seeded
   slot's own requested transport, commented as unread.
10. **The base fixture is a member-originated, INBOUND, LEGACY source**, so
    test 1 asserts `relay_retry_origin_direction: 'inbound'` where the plan's
    sketch wrote `'outbound'`. Legacy is the spec's own "ordinary case" (every
    relay source written before 2026-09-02 is legacy), and inbound is the
    dominant relay source shape. The outbound TEAM shape has its own case
    asserting `'outbound'`, the team leg copy and the mirrored author.
11. **Task 13's cap case seeds a rung-3 row directly** rather than walking a
    ladder inside `twilioStatusWebhook.test.ts`. The ladder walk lives in the
    claim suite, where the job is wired; here the point is the severity rule,
    and a seeded rung 3 reaches `cap_exhausted` in one callback.
12. **The shared set's comment was EXTENDED, not rewritten.** The existing
    policy paragraph is still true for the 1:1 path it now solely governs, so it
    is left byte-identical (which also keeps its pre-existing non-ASCII arrows
    out of the added lines, per the ASCII ratchet). The addition names
    `GroupTextSendNotSupportedError` at `sendMessage.ts:298-300`, points at
    `docs/issues/group-text-30003-leg-retry-promise-unverified.md` as where a
    fix belongs, says explicitly "do not fix it by widening this set", and
    records that the relay branch no longer reads the set for severity.
13. **Three tests beyond the brief's list**: a VERSIONED `enqueue_failed` close
    (asserting `transportAggregationState: 'excluded'` beside the failed slot,
    which is the only proof the transport-aware path was taken rather than the
    legacy whole-slot write); "addresses the ROOT on rung 2, never the retry
    row" (adjudication S4's actual concern, which the rung-1 test cannot see);
    and the SID-shape case folded together with the `providerTs` ordering.
14. **The `tsMsgId` PII assertion is `not.toContain(<phone>)` twice, not a
    digit-run regex.** A `\d{7,}` check over a 16-char hex digest is flaky by
    construction (roughly a 30% chance of a false failure), which would have
    been a genuinely bad test to leave behind.

## For the orchestrator

- **The pinning e2e spec is now expected RED**, as briefed:
  `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` asserts a
  world where nothing retries, and production now claims. It was NOT edited and
  NOT run here; Task 14 rewrites it.
- **Rung 1's backoff comes from module scope, not from a deps object.** The
  webhook calls `enqueueRelayRetryLeg(payload, attempt)` with NO deps, which is
  what makes adjudication E2 work: registration stored the resolved backoff, so
  the lane's `E2E_RELAY_RETRY_BACKOFF_MS` reaches rung 1 too. Verified by
  reading the resolution order and by the 60s assertion in the claim suite; the
  env seam itself is Task 14's.
- **Cost on the hot path is unchanged.** The claim's consistent read happens
  only on a 30003 relay FAILURE that passed the code test; the one extra
  `conversations.getById` (the leg copy's sender name) happens only at rung 1
  and only for a non-team sender. Every other relay status callback pays one
  extra function call that returns `code_not_retryable` immediately.
- **The duplicate `message.persisted` on the ordinary rung-1 path is accepted**
  (adjudication S4): the dashboard consumer is a debounced full-page refetch
  that reads no payload. The claim's emit is the only one that fires in the
  crash-recovery case, which is what its test arranges.
- **The harness fake's `listMediaPointers` DERIVES pointers from stored
  messages**, so it cannot model D13's suppression and this slice does not
  re-prove it. Slice A proved it against real DynamoDB; nothing here changes
  that guarantee, but do not read a green claim suite as evidence for it.
- **No fenced file needed a change and no STOP condition was hit.** The
  consistent read saw the just-written slot in the harness (the fake models one
  array, so both reads are the same lookup - which is why the crash-recovery
  case is the sharper test of the same property); the harness ran the retry job
  in-process for every ladder case; `relayAnnouncements.ts` is imported from
  only (`SYSTEM_SENDER_KEY`, plus the pre-existing two); `relayRetryLeg.ts`,
  `relayFanOut.ts`, `tourReminders.ts`, `ALLOWED_PRIOR`, `getByTsMsgId`'s
  consistency, `flagPlacementAttention`'s body, the 1:1 `case '30003':` arm and
  the native group-text receipts are all untouched.
