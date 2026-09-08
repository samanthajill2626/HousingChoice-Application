# Slice F report - plan Task 11 (the retry job)

Implementer record for `relay.retryLeg`: the execution marker, the four send
gates, the per-leg send through the extracted unit, the status-preserving bump,
the transient sub-ladder, the terminal closes, the injectable backoffs and the
registration seam. Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `316d6c2e` (slice E2's report commit).

SERVER only. Nothing enqueues this job yet (the webhook claim is Task 12), so
nothing here changes production behaviour until that lands.

## Commits

| hash | subject |
| --- | --- |
| `64773ab3` | feat(relay): the 30003 retry job - gates, ladder and terminal closes |
| (this file) | docs(records): slice F report - the retry job |

`git status` was read bare before the commit and `.git/MERGE_HEAD` was confirmed
absent. Explicit paths only; nothing amended. 5 files, +1454 / -3.

## Files

- CREATE `app/src/jobs/relayRetryLeg.ts` - the job.
- CREATE `app/test/relayRetryLeg.test.ts` - 37 tests.
- MODIFY `app/src/jobs/registerHandlers.ts` - registration + the
  `E2E_RELAY_RETRY_BACKOFF_MS` read + the docblock's job-name list.
- MODIFY `app/src/jobs/relayFanOut.ts` - `export` added to
  `persistRelayRecipientResult` and `setVersionedAggregationState`. No logic
  change (the two `async function` keywords gained a preceding `export` and a
  docblock each). `mediaAttachmentsOf` needed nothing: it was already exported
  from `messagesRepo.ts:1179`, so the scope note's "if it is private" did not
  apply.
- MODIFY `app/test/registerHandlers.test.ts` - the complete-handler-set guard.
  See divergence 1.

## Test results, quoted from the runner

Pass glyphs rendered `[ok]` so this file stays ASCII.

```
 [ok] test/registerHandlers.test.ts (1 test) 4ms
 [ok] test/relayRetryLeg.test.ts (37 tests) 61ms
 [ok] test/relayFanOut.test.ts (81 tests) 107ms
 [ok] test/relayWebhook.test.ts (27 tests) 403ms

 Test Files  4 passed (4)
      Tests  146 passed (146)
```

relayFanOut is still **81** and relayWebhook still **27** - the mechanical
exports changed nothing either suite can see.

## Gates

| gate | result |
| --- | --- |
| `npm run typecheck` (bare, worktree root) | **exit 0** |
| `npx eslint` on the five touched files | **exit 0**, no output, no baseline needed |
| ASCII on added lines (`git diff -U0 \| grep '^+' \| tr -d ... \| wc -c`) | **0** for all five |

`npm test`, `npm run smoke`, `npm run e2e` and Playwright were deliberately NOT
run; the orchestrator owns the battery. `AWS_ACCESS_KEY_ID` was never exported.
No background command is running.

## The exported contract - Task 12 builds against this

`app/src/jobs/relayRetryLeg.ts`:

```ts
export const RELAY_RETRY_LEG_JOB = 'relay.retryLeg';

export interface RelayRetryLegPayload {
  relayConversationId: string;
  /** The RETRY row's own key (NOT the root's). */
  retryTsMsgId: string;
}

export type RelayRetryCloseCode =
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out'
  | 'enqueue_failed'
  | 'transient_cap';

export interface RelayRetryLegJobDeps {
  adapter?: MessagingAdapter & CarrierMessageSender;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  mediaStore?: MediaStore;
  tokenBucket?: TokenBucket;
  logger?: Logger;
  backoffMs?: (attempt: number) => number;
  transientBackoffMs?: (pass: number) => number;
}

export function _resetRelayRetryLegForTests(): void;
export function registerRelayRetryLegJobHandler(deps?: RelayRetryLegJobDeps): void;
export async function enqueueRelayRetryLeg(
  payload: RelayRetryLegPayload,
  attempt: number,
  deps?: Pick<RelayRetryLegJobDeps, 'backoffMs'>,
): Promise<void>;
```

**Backoff resolution order**, in `enqueueRelayRetryLeg`:

```
deps?.backoffMs  ??  <the value registration stored>  ??  relayRetryBackoffMs
```

`registerRelayRetryLegJobHandler` stores the RESOLVED
`deps.backoffMs ?? relayRetryBackoffMs` and
`deps.transientBackoffMs ?? fanOutBackoffMs` at module scope (adjudication E2),
which is the whole reason the webhook's rung-1 enqueue gets the lane override
without being handed a deps object. `_resetRelayRetryLegForTests()` clears both;
call it beside `jobs.ts`'s `_resetForTests()` between registrations, because
`defineJobHandler` throws on a second registration of the same name.

The enqueue is `enqueue(RELAY_RETRY_LEG_JOB, payload, { runAt: new Date(...) })`
- a **Date**, per adjudication S10.

**What the handler expects a seeded retry row to carry.** The claim path MUST
write all of this or the job cannot run:

| field | required | consumed as |
| --- | --- | --- |
| `relay_retry_of` | YES - throws without it | a STRING only: the digest's first component. The ROOT ROW IS NEVER READ. |
| `relay_retry_member_key` | YES - throws | the roster lookup key AND the `delivery_recipients` slot key |
| `relay_retry_dest_digest` | YES - throws | compared against `relayRetryDigest(relay_retry_of, normalizeToE164(member.phone))` |
| `relay_retry_leg_body` | YES - throws (`typeof !== 'string'`; empty string is legal) | passed to `sendOneRelayLeg` as `legBody`, verbatim |
| `relay_retry_attempt` | not enforced | logged as `attempt` on every line |
| `relay_retry_origin_direction` | not read here | display only (D20) |
| `delivery_recipients[<member key>]` | YES in practice | versioned: `{status:'queued', requestedTransport, transportAggregationState:'planned'}`; legacy: `{status:'queued'}`. A versioned slot WITHOUT `planned` throws inside `setVersionedAggregationState` on the first send. |
| `transport_schema_version` | mirrors the ORIGINAL | `=== TRANSPORT_SCHEMA_VERSION` selects the versioned mode; anything else is legacy |
| `media_attachments` | optional | re-presigned every attempt; also the ONLY input to the versioned intent |
| `fanout_attempt` | absent on a fresh row | the transient sub-ladder's own budget |

A missing row, or a row missing one of the four required fields, **throws a
descriptive Error**. That is safe precisely because the execution marker is
already set: an SQS redelivery no-ops rather than looping.

**Log contract.** One event name on every line: `event: 'relay_retry_leg'`, plus
`relay: true`, `conversationId`, `retryTsMsgId`, and (once the lineage is read)
`rootTsMsgId` and `attempt` (= `relay_retry_attempt`). `memberKey` is
`logSafeMemberKey(member)` once the member is resolved, and
`logSafeStoredMemberKey(<stored key>)` on the one line that fires before it
(`phone#<E164>` renders as `phone-only-member`). Terminal ERRORs carry
`retryClaim` and, where the job wrote a slot, `closeCode`:

| situation | level | `retryClaim` | `closeCode` |
| --- | --- | --- | --- |
| group not open / absent | error | `gate_refused` | `retry_group_closed` |
| member off the roster | error | `gate_refused` | `retry_member_removed` |
| digest mismatch / unnormalisable phone | error | `gate_refused` | `retry_number_changed` |
| suppressed / opted out | error | `gate_refused` | `retry_opted_out` |
| outcome `refused` or `suppressed` | error | `gate_refused` | none (S2: the extraction wrote it) |
| outcome `filtered` | error | `code_not_retryable` | none (S2) |
| transient pass budget spent | error | `cap_exhausted` | `transient_cap` |
| transient re-enqueue threw | error | `enqueue_failed` | `enqueue_failed` |
| transient re-enqueued | warn | - | - |
| sent | info | - | - |
| duplicate delivery / already terminal | info | - | - |

## How the three named resolutions were made

- **`poolNumber`**: `conversation.pool_number` off the same
  `conversations.getById` the gate reads, exactly as the fan-out resolves it
  (`relayFanOut.ts:765-769`). See divergence 3 for the no-pool-number case.
- **`attempt`** (the `RelayLegPayload` field): the fan-out's convention for that
  field is the TRANSIENT PASS number of this execution (it is read at exactly one
  place, the extracted unit's transient WARN line). The retry job claims its pass
  only AFTER a transient outcome, so the pass number for the current execution is
  `(row.fanout_attempt ?? 0) + 1`. The retry RUNG is `relay_retry_attempt` and is
  logged separately - the two numbers are never conflated.
- **The closed-group check**: `conversation.status !== 'open'`, the authoritative
  gate the fan-out uses at `relayFanOut.ts:758` - status, never `pool_number`
  presence, because a pool number is KEPT on close for burn-multiplexing.

## Test coverage (37)

Marker (1); the four gates as `it.each` asserting no send, no `sendOneRelayLeg`
call, the close code on the RETRY row's own slot, nothing scheduled, and an ERROR
line carrying `retryClaim: 'gate_refused'` + `event` + `relay` + `rootTsMsgId` +
`attempt` (4); `contact_opted_out` is never stamped (1); the digest-not-phone
changed-number case, with the member KEY deliberately unchanged so only the
digest can catch it (1); an unnormalisable current number (1); one send, the
stored leg copy verbatim after a sender rename, the raw body still on the row,
one slot write and exactly one pointer (1); the failed member only (1); the
status-preserving bump - closed group stays closed, `touchLastActivity` never
called, `world.touches` empty, `last_activity_at` advanced, `preview` recorded
as `undefined`, the newer preview untouched (1); no bump when nothing sent (1);
re-presign across two rungs with two distinct grants on the same durable key (1);
legacy row -> `transport.kind === 'legacy'` AND mechanically free of every
transport hook (1); versioned row -> `'versioned'`, `planned -> attempted` for
real (1); MMS classification from the row's own attachments (1); the leg payload
addresses the RETRY row and carries the transient pass number (1); transient
re-enqueue - same payload, 5s, `relay_retry_attempt` unchanged, `fanout_attempt`
1, slot still queued, no ERROR, a WARN (1); the injected transient backoff (1);
the retry backoff and the transient backoff are independent knobs (1);
`transient_cap` from an already-spent budget (1) and from the last claimable pass
(1); `refused` and `filtered` leave the extraction's code and write no slot (2);
already-terminal slot (1); a malformed row throws (1); the payload and the logs
carry no body and no phone (1); a contact-less member key is redacted (1); the
env seam - absent, `'abc'`, `'0'`, `'-5'`, `''`, `'  '`, a valid value, no
registration at all, and explicit deps winning (9).

Every retry row is seeded the way the claim will write it: a wall-clock
`providerTs`, the deterministic `relayretry-<digest>-<n>` SID, the six lineage
fields, and the mode-appropriate slot.

## Divergences, and why

1. **`app/test/registerHandlers.test.ts` was edited - one line beyond the
   scope list.** It asserts the COMPLETE registered job-name set as a
   two-entrypoint drift guard, so registering `relay.retryLeg` turns it red.
   Adding the name is that test's designed maintenance point; leaving it red
   would fail gate 2 on the branch's own change.
2. **Retry rows are seeded by pushing onto `world.messages`, not through
   `messages.append`.** The harness fake's `append`
   (`test/helpers/twilioWebhookHarness.ts:1081`) has **zero** `relayRetry*`
   passthrough - it preserves `retryOf` and about thirty other fields, but not
   the six lineage ones, so an `append`-seeded retry row reads back with no
   lineage at all. Direct seeding is the established idiom of the very file the
   worklist points at (`relayFanOut.test.ts`'s `seedSource` / `seedTeamSource`,
   the latter seeding `planned` slots the same way), and it keeps the shared
   harness out of this slice's diff. **Task 12 will need those six passthroughs
   added to the fake** - see the orchestrator notes.
3. **An OPEN relay group with no pool number THROWS; it does not close a gate.**
   The four gate codes are a closed set and none of them describes "we have
   nowhere to send from". `pool_number` is kept even on close
   (burn-multiplexing), so an open group without one is a genuine anomaly and a
   loud throw is the honest answer. A MISSING conversation, by contrast, refuses
   with `retry_group_closed` - it is not open, and that is the truthful member of
   the set.
4. **`enqueue_failed` is written by the JOB, not only by the webhook.** The
   brief called it "webhook side, D14". The job's transient re-enqueue can throw
   for exactly the same reason the fan-out continuation's can, and the fan-out
   closes `enqueue_failed` there (`relayFanOut.ts:1186-1188`). Mirroring it costs
   one try/catch and is why the code is in `RelayRetryCloseCode` at all. D14's
   distinction (retries ran vs. retries did not) is preserved.
5. **The transient cap closes on `claim.attempt >= MAX_FANOUT_ATTEMPTS` as well
   as on `capped`.** The brief listed only `capped`/`missing`. Mirroring the
   fan-out's second cap branch (`relayFanOut.ts:1166-1169`) is what keeps
   `fanOutBackoffMs`'s documented "5s then 10s ONLY" true - without it the job
   would schedule a third pass at a 20s rung the fan-out deliberately leaves
   unreachable. Both branches are tested.
6. **The plan's "previews the raw body" test was NOT written.** Adjudication S3
   wins: the preview argument is `undefined` and the test asserts that, plus that
   a newer preview already on the thread survives.
7. **`sendOneRelayLegSpy` is a partial `vi.mock` of `relayFanOut.js` that
   DELEGATES by default.** The plan's mocking boundary is preserved exactly - the
   adapter is the seam for the gate/bump/send/ladder tests and the real unit
   writes the slot and the pointer - while the same hook records every argument
   bag (so `transport.kind`, `legBody`, `payload` and `poolNumber` are observable)
   and can be overridden for the two transient tests. A plain `vi.spyOn` cannot
   reach a function another module imported.
8. **`MAX_RELAY_RETRY_ATTEMPTS` is not imported.** The plan's Interfaces block
   lists it as consumed, but the job never claims a rung - the webhook does - so
   importing it would be an unused symbol.
9. **The transient sub-ladder has no env override**, as the brief instructed:
   neither the spec nor the plan asks for one, and 5s/10s is already short enough
   for a hermetic lane. It stays injectable through `deps.transientBackoffMs`, and
   a test pins that shortening the RETRY rung does not touch it.
10. **`registerRelayRetryLegJobHandler` also takes the shared `tokenBucket`** in
    `registerHandlers.ts`. A retry rung is a real outbound SMS and must draw from
    the same A2P meter as every other relay leg; the extracted unit already calls
    `tokenBucket?.acquire(1)`.
11. **The gate/close helpers use two different shapes on purpose.** A PRE-send
    gate refusal mirrors the extraction's `suppressed` arm (aggregation
    `excluded`, then the failed slot); a POST-send close mirrors the fan-out's
    `closeRelay` (the failed slot only, no aggregation write, because the slot is
    already `attempted`).

## For the orchestrator

- **Task 12 must add the six `relayRetry*` passthroughs to the harness fake's
  `append`** (`app/test/helpers/twilioWebhookHarness.ts:1081`), or the claim it
  writes will read back with no lineage and this job will throw. That edit was
  left out of this slice because the harness is outside its scope list; it is a
  mechanical addition beside the existing `retry_of` spread. The real repo
  already persists them (`messagesRepo.ts:2218-2233`).
- **Adjudication E6 stands, unchanged**: the marker is UNIT-proven only. The
  in-process lane adapter runs a job once and swallows a throw, so a green e2e is
  not evidence for the duplicate-delivery guard, and a thrown retry handler in the
  lane shows up as an ERROR line plus a lost rung, not a crash. Divergence 3's
  throw and the malformed-row throw inherit that behaviour.
- **Nothing enqueues `relay.retryLeg` yet.** The handler is registered and
  reachable but dead until Task 12's claim - intended, and why gate 4 cannot
  exercise any of this in this slice.
- **`sendOneRelayLeg`'s contract fit perfectly.** No STOP condition was hit: the
  versioned `planned` precondition did not throw on a row seeded as D2 specifies
  (proven by the `planned -> attempted` assertion), and no fenced file needed a
  change. `relayAnnouncements.ts` is imported from only (`isMemberSuppressed`,
  `logSafeMemberKey`); `retrySend.ts`, `tourReminders.ts`, `ALLOWED_PRIOR`,
  `touchLastActivity` and the extraction's logic are untouched.
- **Task 13's severity work needs the `retryClaim` table above.** The job emits
  `gate_refused`, `code_not_retryable`, `cap_exhausted` and `enqueue_failed`; the
  webhook owns `claimed`, `already_claimed`, `fenced_announcement`, `to_missing`,
  `to_malformed`, `source_unreadable` and `slot_ineligible`. Between the two,
  all eleven `RelayRetryClaimOutcome` values now have a writer.
- **Task 14 needs no further seam work.** `E2E_RELAY_RETRY_BACKOFF_MS` is read in
  `registerHandlers.ts` and unit-proven on nine cases; only the lane's env value
  (`scripts/e2e-session.mjs`'s `childEnv`) remains.
