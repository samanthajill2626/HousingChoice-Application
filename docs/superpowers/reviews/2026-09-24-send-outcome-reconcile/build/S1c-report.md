# S1c report - Task 6 (Slice A, part 3)

Dispatch S1c of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
started at 01bbd0a5. Scope: plan rev 4 Task 6 with the worklist's S1b/T6
bullet (T6-1..T6-7, T14-7, the harness half of T8-3), the orchestrator's
row-shape and parity-test requirements. Inputs: AGENTS.md, the plan (Global
Constraints, Shared interfaces, Task 6), worklist section 0 (G1-G10) and the
T6 bullet, foundations findings T6-1..T6-7 and INV-1, dashboard finding
T14-7, send-sites finding T8-3, the foundations reference sections 1, 4, 5,
8, 8.1, 9, 10, 10.1, the S1a and S1b reports, spec D8, D11, D13, D15, D16a,
D22.

Method: strict TDD (every new test seen failing before its code existed),
three commits before this report, then one-line mutant spot-checks on every
decision-bearing condition in the two real repos and in the harness fakes.
Each mutant was an exact textual edit applied by a scratch runner, run,
written back from the ORIGINAL BYTES, and proven byte-identical to a
pristine copy with `cmp` (no git checkout / restore / stash).

## Commits

- `4497c602 feat(repos): conditional relay closes, forward-only adoptions, the attempt clock, a reporting SID claim, consistent reads and the append's conversation (D8, D8a, D11, D13, D15)`
- `d7b1f6f2 feat(repos): one conditional write per broadcast recipient outcome, the queued close, an idempotent finalize flip and the unconfirmed bucket (D8, D16a, D22)`
- `0b303ad4 test(repos): pin ConsistentRead on every consistent twin and read-back, the harness twins' delegation, and a refused adoption's persisted seed (D11, T8-3)`
- this report (last commit).

## What was built

`app/src/repos/messagesRepo.ts`:
- `RelayRecipientDelivery.attemptedAt?: string` (:170) with the plan's doc line.
- `AppendResult.conversationId: string` (:1272) on all THREE return sites
  (T6-3): the SID-pointer dedupe returns `ptr.ref_conversationId`; the
  email-pointer dedupe widens its cast and returns
  `ptr.ref_conversationId ?? message.conversationId`; fresh returns
  `message.conversationId`.
- Consistent twins: `getByProviderSidConsistent` (both Gets consistent),
  `listByConversationConsistent`, `getRelaySidPointerConsistent`,
  `getSystemSidMarkerConsistent`. Each twin and its eventual read share ONE
  private helper with a `consistent` flag (:2147, :2165, :2188, :2230); the
  eventual requests are byte-identical to before (no ConsistentRead key).
- `claimRelaySidPointer` (:4147): created / mine / other.
- `closeRelayRecipientIfUnsent` (:3949), `adoptRelayRecipientIfUnsent`
  (:4016), `setRelayRecipientAttemptedAt` (:4069), with the shared
  `seedRelaySlot` statement (:2210).
- `createMessagesRepo` now builds a named `repo` object and returns it
  (:2455, :4803) so adoption can delegate to `applyRecipientSendResult`
  without moving that method's body.

`app/src/repos/broadcastsRepo.ts`:
- `BroadcastStats.unconfirmed?: number` (:101); `deriveBroadcastStats`
  routes a `failed` slot carrying `send_unconfirmed` there and always returns
  the key for a non-empty map (:264); `zeroStats` carries `unconfirmed: 0`
  (:322), so `create` persists it.
- `getByIdConsistent` (:644, shared `readById` :514),
  `recordRecipientOutcome` (`recordOutcome` :531), `closeRecipientIfQueued`
  (:925), `finalizeStatus` (:931).

Harness (`app/test/helpers/twilioWebhookHarness.ts`): every new method on
both fakes (messages :1295, :1427, :1688, :1705, :1730, :1770, :1790, :1803;
broadcasts :3067, :3127, :3216-:3223); the dedupe returns the STORED row's
conversation (T6-5, :1159).

Typed fakes: `sendMessage.test.ts`, `scheduledSendSuppression.test.ts`
(type-complete stubs), `groupSend.test.ts:257` (T6-4).

Tests:
- `app/test/broadcastsRepo.integration.test.ts` (T6-1 host): describe
  "SOR send-outcome additions: broadcast slots, stats and finalize" (8 cases)
  and "SOR send-outcome additions: relay pointers and slots" (9 cases), inline
  legacy/versioned sources, per-case ids and SIDs, `create` + `markSending`
  per case (T6-2), the legacy stats map via `REMOVE stats.unconfirmed`,
  `updateRecipientDeliveryStatus(conv, ts, 'c-9', 'delivered')` (T6-6).
  `-t "send-outcome additions"` still selects both describes.
- `app/test/messaging.integration.test.ts`: "append reports the conversation
  of a deduped row" (its `outbound(...)` helper) and "an email deduped on its
  RFC Message-ID pointer reports the first row's conversation" (the second
  return site, which no test covered); the four exact-shape pins gain
  `conversationId: convId`.
- `app/test/groupSendRepo.integration.test.ts:240` gains `conversationId`.
- `app/test/deriveBroadcastStats.test.ts`: the full `toEqual` gains
  `unconfirmed: 0`; the D22 routing case; `zeroStats` carries the bucket; the
  50-slot invariant now makes half the failed slots `send_unconfirmed`,
  asserts the bucket is non-zero, and sums it.
- `app/test/broadcastApi.test.ts`: the results `toEqual` gains
  `unconfirmed: 0`; the S4 sum adds `(stats.unconfirmed ?? 0)` (T14-7).
- `app/test/broadcastFanOut.test.ts`: `bucketsSumToAudience` adds
  `(s.unconfirmed ?? 0)` (T6-7).
- NEW `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`
  (16 tests), on the S1b parity idiom: 10 messages scripts and 5 broadcast
  scripts run step by step through the real repos (DynamoDB Local) and a fresh
  fake world; after EVERY step it requires the identical result, identical
  `delivery_recipients` for every watched row (`deliveredAt` reduced to
  presence - it is a wall clock), identical relay SID pointers, and the
  identical broadcast item minus `created_at` / `updated_at`. Script
  expectations are asserted on the REAL answer. Coverage: claim created /
  mine / other on each ref field and over a plain-put pointer; close on a
  legacy row (absent, queued no-sid keeping attemptedAt, queued with sid,
  sent, re-close, missing row), close over every status x sid presence (12
  slots), close on a versioned row; legacy adoption (seed-then-adopt, first
  write wins, same-status idempotence, regression refused, a receipt that
  raced ahead, an error code, a refused queued_pending move that keeps its
  seed, missing row), legacy adoption over every prior x every adopted status
  (30 slots, expectation from `allowedPriorStatuses` written independently),
  versioned adoption (adopt then skip, a sid-holding slot over every prior,
  no slot = missing); the attempt clock (seed, never touches other fields, a
  versioned slot, missing row); a map-less row; the append dedupe and the four
  consistent twins; recordRecipientOutcome (single / multi / empty / zero
  deltas, priors, missing slot, missing broadcast, empty prior list), the
  same over every status x four prior sets (20 slots); closeRecipientIfQueued
  (both buckets, a legacy stats map, re-close, a sent slot, absent key);
  finalizeStatus (wins once, loser gets the item, a draft, missing throws);
  returned items are snapshots. Plus one fake-only case: a spy on each
  eventual read observes its harness twin (T8-3).

## Deviations from the plan / worklist, and why

1. Row-shape guard (the orchestrator's instruction; see the finding below).
   Every nested slot write that could meet a row without a
   `delivery_recipients` map carries `attribute_exists(#dr)`: the close's
   absent-slot create (plan: `attribute_exists(tsMsgId) AND
   attribute_not_exists(#dr.#mk)`) and the seed statement shared by the
   legacy adoption and the attempt clock (plan: `attribute_exists(tsMsgId)`).
   A map-less row therefore answers `missing` (close, with a WARN from its
   read-back; adoption) or WARNs and resolves (attempt clock) - never a
   ValidationException. Chosen over seeding the map with `if_not_exists`
   because that needs an extra statement on every call (a map and its child
   cannot be SET in one expression) for a shape no production path writes,
   and because it is the file's own precedent (`initializeRecipientDelivery`
   answers `missing` for a map-less row).
2. `recordRecipientOutcome` with an EMPTY prior list throws a TypeError before
   any write (plan silent; `IN ()` would be a ValidationException). Mirrored
   by the fake and pinned in both.
3. `claimRelaySidPointer` throws when a pointer whose conditional put just
   failed cannot be read back (plan silent; the append's "refuse to guess"
   rule). It duplicates `putRelaySidPointer`'s PutCommand instead of
   refactoring it, because `putRelaySidPointer` "stays as it is".
4. Read helpers shared between each twin and its eventual read (not a
   behavior change: the eventual requests are byte-identical). The named
   `repo` object in `createMessagesRepo` exists so adoption calls
   `applyRecipientSendResult` without moving its 140-line body.
5. The attempt clock's first statement and the legacy adoption's seed are one
   helper (`seedRelaySlot`); the plan listed them separately with identical
   text.
6. Extra tests beyond the plan: the map-less row (real and parity); a
   ConsistentRead recording test (DynamoDB Local answers every read
   consistently, so only the request shows which read a method asked for -
   without it the consistency mutants R23-R27, B10, B11 survive); the
   email-pointer dedupe site; the fake-only delegation pin (without it F25 and
   F26 survive); `create` persists `unconfirmed: 0`; a finalize on a draft and
   on a missing broadcast.
7. The relay-side cases use their own capture-bearing messages repo over the
   file's table (`relayMessages`) so the attempt clock's WARN is asserted.
8. Not changed, by choice: the harness's PRE-EXISTING `getByTsMsgIdConsistent`
   still reads the array itself (it does not delegate through
   `getByTsMsgId`). T8-3 names that read for Task 8; switching it here could
   change existing spy-based tests. S2b decides (concern 2).

No plan/worklist contradiction with the live code was found beyond these; no
unexpected importer or cycle appeared (broadcastsRepo now imports
`SEND_UNCONFIRMED_CODE` from `lib/sendOutcome.js`, which imports only the
`messagingErrors` leaf; the constant is used inside a function body); no test
outside the touched files went red.

## Row-shape finding (does every relay row carry `delivery_recipients`?)

Every relay row a production path writes DOES carry the map, as a map
attribute (an empty `{}` is stored as an empty map, on which a nested SET
works - the "absent legacy slot" case proves it on DynamoDB Local):
- relay inbound source: `deliveryRecipients: {}` (`routes/webhooks/twilio.ts:907`;
  versioned since 2026-09-02, legacy - no `transport_schema_version` - before);
- team send: per-member `queued` slots (`routes/api.ts:1853`, versioned);
- held send on a connecting group: per-member `queued` slots on a
  `queued_pending` message (`routes/api.ts:1761`, versioned);
- relay announcements: per-member `queued` slots (`services/relayAnnouncements.ts:240`);
- the 30003 rung row: `{ [memberKey]: rungSlot }` (`routes/webhooks/twilio.ts:2959`),
  legacy or versioned following its original.

Rows WITHOUT the attribute: 1:1 messages, inbound native-group messages
(`twilio.ts:2005`), dev extraction fixtures planted without
`transport.recipients` (`routes/dev.ts:870-1047`), and seeded messages
without declared recipients (`lib/seed/messageTransport.ts:61`). None is a
fan-out, rung or reconcile target (no `relaysid#` pointer is written for
them; the seeds write none). On DynamoDB Local an unguarded nested SET on
such a row is a ValidationException - the new test asserts it through the
existing `setRecipientDelivery` - so the guard in deviation 1 is
load-bearing, not cosmetic. The existing fan-out's `markRecipient` already
assumes the map (it would throw on such a row today).

## Red -> green evidence

- Relay side (2 files): RED `Tests 10 failed | 45 passed (55)`, e.g.
  `TypeError: relayMessages.closeRelayRecipientIfUnsent is not a function`
  and, for the dedupe cases,
  `AssertionError: expected { deduped: true, ...(1) } to deeply equal { deduped: true, ...(2) }`.
  GREEN after the repo code: 53 passed with the two predicted pin failures
  (`expected { deduped: false, ...(2) } to deeply equal { deduped: false, ...(1) }`),
  then all green once the pins gained `conversationId`.
- Parity, messages: RED 10/10 failed at step 0
  (`append legacy row src: result: expected { deduped: false, ...(1) } to strictly equal { deduped: false, ...(2) }`).
  GREEN 9/10 after the fake; the tenth differed only in `deliveredAt`
  (`...855Z` vs `...857Z`, each implementation's wall clock), normalized to
  presence -> 10/10.
- Broadcast side (3 files): RED `Tests 12 failed | 99 passed (111)`, e.g.
  `TypeError: broadcasts.recordRecipientOutcome is not a function` and
  `expected { audience: 6, queued: 1, ...(7) } to deeply equal { audience: 6, queued: 1, ...(8) }`.
  GREEN 110 with the predicted `broadcastApi.test.ts` pin failure
  (`expected { audience: 4, queued: +0, ...(8) } to deeply equal { audience: 4, delivered: 1, ...(7) }`),
  then all green once it gained `unconfirmed: 0`.
- Parity, broadcasts: RED 5/5 failed
  (`TypeError: world.broadcastsRepo.getByIdConsistent is not a function`);
  GREEN 15/15.
- The ConsistentRead recording case and the delegation pin passed on their
  first run: they pin behavior already built; their teeth are the killed
  mutants R23-R27, B10, B11, F25, F26. No other case can see R23-R27, B10,
  B11 or F26 (DynamoDB Local reads consistently whatever is asked, and a
  non-delegating twin returns the same data); F25 was also caught by a parity
  case only because that mutant happened to drop `before`.

## Mutants (all 64 KILLED; every file restored byte-identical, `cmp` clean)

Real repos, run against `broadcastsRepo.integration`, `messaging.integration`
(messages) or `deriveBroadcastStats` (broadcasts), plus the parity file. The
killing test named is the first failure reported.

| id | mutant | killed by |
|---|---|---|
| R01 | close: `attribute_not_exists(#dr.#mk.#sid)` made always true | "closeRelayRecipientIfUnsent closes an absent legacy slot ..." |
| R02 | close: `#dr.#mk.#st = :queued` made always true | same |
| R03 | close: absent-slot create without `attribute_exists(#dr)` | "a row with NO delivery map ..." |
| R04 | close: absent-slot create without `attribute_not_exists(#dr.#mk)` | "closeRelayRecipientIfUnsent closes an absent legacy slot ..." |
| R05 | close read-back: map-less row -> skipped_sent | "a row with NO delivery map ..." |
| R06 | close read-back: missing row -> skipped_sent | "closeRelayRecipientIfUnsent closes an absent legacy slot ..." |
| R07 | adopt: updated -> skipped | "adoptRelayRecipientIfUnsent on a versioned row ..." |
| R08 | adopt: idempotent/stale/conflict -> adopted | same |
| R09 | adopt: legacy_noop -> missing | "adoptRelayRecipientIfUnsent on a legacy row ..." |
| R10 | adopt legacy: same-status idempotence dropped | same |
| R11 | adopt legacy: forward-only dropped (every prior allowed) | same |
| R12 | adopt legacy: sid overwritten (no if_not_exists) | same |
| R13 | adopt legacy: sentAt overwritten (no if_not_exists) | same |
| R14 | adopt legacy: a refused seed proceeds | "a row with NO delivery map ..." |
| R15 | seed: `attribute_exists(#dr)` dropped | same |
| R16 | seed: a refused seed throws (clock not best-effort) | same |
| R17 | clock: no seed of an absent slot | "setRelayRecipientAttemptedAt seeds an absent slot ..." |
| R18 | claim: tsMsgId not compared | "claimRelaySidPointer reports created / mine / other ..." |
| R19 | claim: conversationId not compared | same |
| R20 | claim: a lost claim is always mine | same |
| R21 | append: SID dedupe echoes the input conversation | "append reports the conversation of a deduped row" |
| R22 | append: email dedupe echoes the input conversation | "an email deduped on its RFC Message-ID pointer ..." |
| R23-R26 | each consistent twin reads eventually | "every read a consistent twin makes carries ConsistentRead ..." |
| R27 | the claim's read-back is eventual | same |
| B01 | outcome: priors ignored | "recordRecipientOutcome writes the slot and bumps stats in ONE conditional write" |
| B02 | outcome: an empty delta emits ADD | "recordRecipientOutcome with an EMPTY delta ..." |
| B03 | outcome: empty-prior guard dropped | "recordRecipientOutcome refuses a missing slot ..." |
| B04 | queued close: prior widened to `['queued', 'sent']` | parity "closeRecipientIfQueued: ... a second close refused" (the real answer) |
| B05 | queued close: `queued` not decremented | "closeRecipientIfQueued bumps the unconfirmed bucket ..." |
| B06 | finalize: `#s = :sending` made always true | "finalizeStatus wins once from sending ..." |
| B07 | finalize: a missing broadcast reads as lost | same |
| B08 | derive: send_unconfirmed not routed | "routes a failed slot carrying send_unconfirmed ..." |
| B09 | zeroStats: `unconfirmed` missing | "create persists the unconfirmed bucket at zero" |
| B10 | getByIdConsistent reads eventually | "every read a consistent twin makes carries ConsistentRead ..." |
| B11 | the finalize loser's read-back is eventual | same |

Harness fakes, run against the parity file:

| id | mutant | killed by |
|---|---|---|
| F01 | close: sid check dropped | "closeRelayRecipientIfUnsent on a LEGACY row ..." |
| F02 | close: queued check dropped | same |
| F03 | close: a map-less row reads skipped_sent | "a row with NO delivery map ..." |
| F04 | close: an existing slot loses its other fields | "closeRelayRecipientIfUnsent on a LEGACY row ..." |
| F05 | adopt: legacy_noop -> missing | "adoptRelayRecipientIfUnsent on a LEGACY row: seed-then-adopt ..." |
| F06 | adopt: same-status idempotence dropped | same |
| F07 | adopt: forward-only dropped | same |
| F08 | adopt: sid overwritten | same |
| F09 | adopt: sentAt overwritten | same |
| F10 | adopt: a refused move does not keep its seed | same (the queued_pending step) |
| F11 | adopt: errorCode dropped | same |
| F12 | clock: no seed of an absent slot | "closeRelayRecipientIfUnsent on a LEGACY row ..." |
| F13 | clock: the slot rewritten wholesale | "setRelayRecipientAttemptedAt: seeds an absent slot ..." |
| F14 | claim: conversationId not compared | "claimRelaySidPointer: created, mine, other ..." |
| F15 | claim: an existing pointer rewritten | same |
| F16 | append: dedupe echoes the input conversation | "append reports the STORED row's conversation ..." |
| F17 | outcome: priors ignored | "recordRecipientOutcome: single- and multi-bucket deltas ..." |
| F18 | outcome: a returned item aliases the store | "returned items are snapshots ..." |
| F19 | outcome: empty-prior guard dropped | "recordRecipientOutcome: single- and multi-bucket deltas ..." |
| F20 | outcome: a missing slot is created | same |
| F21 | queued close: prior widened to sent | "closeRecipientIfQueued: ..." |
| F22 | finalize: sending condition dropped | "finalizeStatus: wins once ..." |
| F23 | finalize: a missing broadcast reads as lost | same |
| F24 | finalize: last_error not written | same |
| F25 | twin: listByConversationConsistent not delegating | "a spy on each eventual read observes its consistent twin ..." |
| F26 | twin: getByIdConsistent not delegating | same |

Not run, recorded as equivalent: dropping the zero-delta skip (real and
fake) - `ADD stats.x 0` changes nothing on an existing counter and only
creates an absent bucket at 0; the attempt clock's own CCF catch - the slot
cannot vanish between the seed and the stamp. No `[dynamoAdmin]` line
appeared in any of the 64 mutant runs.

## Gates (exit codes)

- Fast gates, the dispatch's list
  (`npx vitest run test/broadcastsRepo.integration.test.ts test/messaging.integration.test.ts test/deriveBroadcastStats.test.ts test/broadcastApi.test.ts test/groupSendRepo.integration.test.ts test/groupSend.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts`)
  -> exit 0, `Test Files 7 passed (7)`, `Tests 210 passed (210)`.
- `npm run typecheck` (root) -> exit 0 (also after each code commit).
- Whole app workspace, foreground,
  `timeout 900 npx vitest run` -> EXIT=0, `Test Files 381 passed (381)`,
  `Tests 7319 passed | 1 skipped (7320)`, `Duration 135.25s`. The skip is the
  environmental `staticSmoke` case (no dashboard build). No `[dynamoAdmin]`
  line in the log (the ERROR lines in it are tests' own injected
  `ProvisionedThroughputExceededException` / `boom` stubs).
- Neighbour check before commit 1 (relayFanOut, relayRetryLeg,
  twilioStatusWebhook, broadcastFanOut, relayWebhook, messagesRepo.transport,
  messagesRepo.email, repos, messagesRepoRetryLineage) -> exit 0, 354 passed.
- Lint preview (gate 5 is the orchestrator's): `npx eslint` on the 13 touched
  .ts files -> exit 0, nothing reported.

## Contract for downstream

`AppendResult` (messagesRepo) is now
`{ deduped: boolean; tsMsgId: string; conversationId: string }`: fresh = this
call's conversation; dedupe = the conversation of the row the provider SID
already lives in (the email-pointer dedupe falls back to the input only if
the pointer lacks it).

messagesRepo, new members (every one resolves as stated; any error other than
a conditional-check failure throws):

- `getByProviderSidConsistent(sid: string): Promise<MessageItem | undefined>`
  - the sid# pointer and the row, both ConsistentRead.
- `listByConversationConsistent(conversationId: string, opts?: ListByConversationOptions): Promise<MessageItem[]>`
  - `listByConversation` with ConsistentRead (same `limit` default 50 and
  exclusive `before`).
- `getRelaySidPointerConsistent(providerSid: string): Promise<{ conversationId: string; tsMsgId: string; memberKey: string } | undefined>`
- `getSystemSidMarkerConsistent(providerSid: string): Promise<{ kind: string } | undefined>`
- `claimRelaySidPointer(providerSid: string, ref: { conversationId: string; tsMsgId: string; memberKey: string }): Promise<'created' | 'mine' | 'other'>`
  - `created`: this call wrote it. `mine`: the existing pointer's three
  fields all equal `ref`. `other`: anything else. Never rewrites an existing
  pointer. Throws if a pointer whose put just failed cannot be read back.
- `closeRelayRecipientIfUnsent(conversationId: string, tsMsgId: string, memberKey: string, delivery: { status: 'failed'; errorCode: string }): Promise<'closed' | 'skipped_sent' | 'missing'>`
  - `closed`: an existing `queued` slot with no `sid` got `status` +
  `errorCode` (every other field kept), or an ABSENT slot was created
  `{ status, errorCode }` (legacy and versioned rows alike).
  `skipped_sent`: the slot has a sid, any other status (incl. already
  `failed`), or `queued_pending`. `missing`: no row, or a row with no
  `delivery_recipients` map (WARN).
- `adoptRelayRecipientIfUnsent(conversationId: string, tsMsgId: string, memberKey: string, patch: { status: DeliveryStatus; sid: string; sentAt: string; errorCode?: string }): Promise<'adopted' | 'skipped' | 'missing'>`
  - VERSIONED row: through `applyRecipientSendResult` (`updated` -> adopted;
  `idempotent` / `stale` / `conflict` -> skipped; `missing` -> missing). So a
  re-run is `skipped`, and a stale status that still fills an absent sid or
  sentAt is `adopted` (the status never regresses). An absent versioned slot is
  `missing`.
  LEGACY row: an absent slot is first seeded `{ status: 'queued' }` (the seed
  persists even if the move is refused), then the status moves only from
  `allowedPriorStatuses(patch.status)` or from the SAME status - a same-status
  re-run is `adopted` (idempotent write) - keeping an existing `sid` and
  `sentAt` (first write wins) and writing `errorCode` when given. A refused
  move (a raced receipt) is `skipped`. `missing`: no row or no map.
- `setRelayRecipientAttemptedAt(conversationId: string, tsMsgId: string, memberKey: string, attemptedAt: string): Promise<void>`
  - seeds an absent slot `{ status: 'queued' }`, then sets `attemptedAt`
  (overwriting an older one; nothing else touched). A missing row, map or
  slot WARNs and resolves.
- `RelayRecipientDelivery.attemptedAt?: string` - OUR attempt clock; a
  wholesale slot write (legacy `markRecipient`) drops it.

broadcastsRepo, new members:

- `getByIdConsistent(broadcastId: string): Promise<BroadcastItem | undefined>`
- `recordRecipientOutcome(broadcastId: string, contactKey: string, recipient: BroadcastRecipient, statsDelta: Partial<BroadcastStats>, allowedPriorStatuses: ReadonlyArray<BroadcastRecipient['status']>): Promise<{ moved: boolean; item?: BroadcastItem }>`
  - ONE write: the slot set wholesale to `recipient`, `updated_at`, and an
  ADD for each bucket whose delta is a non-zero number, only while the slot's
  status is one of the priors. `{ moved: true, item }` (ALL_NEW) or
  `{ moved: false }` (slot absent, another status, or broadcast missing - not
  distinguished). An EMPTY delta writes the slot only. An empty prior list is
  a TypeError. An ADD creates a bucket missing from a legacy stats map.
- `closeRecipientIfQueued(broadcastId: string, contactKey: string, errorCode: string, statsBucket: 'failed' | 'unconfirmed'): Promise<{ moved: boolean; item?: BroadcastItem }>`
  - `recordRecipientOutcome(id, key, { status: 'failed', errorCode }, { [statsBucket]: 1, queued: -1 }, ['queued'])`.
- `finalizeStatus(broadcastId: string, status: 'sent' | 'failed', lastError?: string): Promise<{ won: boolean; item: BroadcastItem }>`
  - flips only from `sending` (sets `last_error` only when given and only on
  the winning write). The loser gets a consistent read of the item (a draft
  or an already-terminal broadcast). Throws `finalizeStatus: broadcast <id> not found`.
- `BroadcastStats.unconfirmed?: number` - read it `?? 0`. `zeroStats()`
  includes `unconfirmed: 0` (so `create` persists it). `deriveBroadcastStats`
  counts a `failed` slot with `errorCode === 'send_unconfirmed'` in
  `unconfirmed` and in no other bucket, and always returns `unconfirmed` for a
  non-empty map; an empty map still returns the persisted stats unchanged
  (which may lack the key).

Harness (`createFakeWorld()`), how a test seeds, inspects and fails each:

- Relay rows: append through `world.messagesRepo.append({ ..., deliveryRecipients })`
  (the fake stores the map object BY REFERENCE - pass a fresh literal) or
  push to `world.messages`; set a slot with
  `world.messagesRepo.setRecipientDelivery` (NOTE: unlike the real repo, the
  fake creates a missing map there). Inspect
  `world.messages.find(...)!.delivery_recipients` or
  `await world.messagesRepo.getByTsMsgIdConsistent(conv, ts)`. The new
  writes replace the map copy-on-write, so a previously read map object is a
  stale snapshot.
- Pointers: `world.relaySidPointers.set(sid, { conversationId, tsMsgId, memberKey })`;
  the claim reads the map live. System markers: `world.systemSidMarkers.set(sid, kind)`.
- Broadcasts: `world.broadcasts.set(id, item)` or `create` + `markSending`;
  inspect `world.broadcasts.get(id)`. The new broadcast methods return DEEP
  snapshots; the pre-existing `getById` (and so `getByIdConsistent`) returns a
  SHALLOW copy whose `stats` / `recipients` are the stored objects - do not
  mutate them.
- Fail one call: `vi.spyOn(world.messagesRepo, 'closeRelayRecipientIfUnsent').mockRejectedValueOnce(new Error('dynamo blip'))`
  (plain literal objects; the code under test must call through the object).
- Spy interactions, deliberate: each consistent twin in the HARNESS calls its
  eventual read THROUGH THE OBJECT (`getByProviderSidConsistent` ->
  `getByProviderSid`, `listByConversationConsistent` -> `listByConversation`,
  `getRelaySidPointerConsistent` -> `getRelaySidPointer`,
  `getSystemSidMarkerConsistent` -> `getSystemSidMarker`,
  `getByIdConsistent` -> `getById`): a spy on the eventual read observes and
  can fail the consistent one too; to fail ONLY the consistent read, spy on
  the twin. `adoptRelayRecipientIfUnsent` calls `applyRecipientSendResult`
  through the object in BOTH the real repo and the fake.
  `closeRecipientIfQueued` does NOT go through the object in either (a spy on
  `recordRecipientOutcome` does not see it). `claimRelaySidPointer` reads the
  pointer map directly (a spy on `getRelaySidPointer` does not see it).
- The fake's `setRelayRecipientAttemptedAt` has no logger (the real one
  WARNs). No fake clock: `updated_at` and `deliveredAt` come from the wall
  clock.

## Concerns for the orchestrator

1. A LEGACY adoption that succeeds (`queued` / `sent` / `delivered`) keeps a
   stale transient `errorCode` on the slot (e.g. `send_retryable`), because
   the plan's statement only SETs `errorCode` when the patch carries one; a
   versioned adoption clears it (`applyRecipientSendResult`), and the legacy
   success path it stands in for (`markRecipient`'s wholesale write) never
   leaves one. Built as the plan wrote it; if the dashboard renders a code on a
   sent legacy leg, Task 10 (or a follow-up) should add
   `REMOVE #dr.#mk.#ec` for a successful status without a code.
2. For S2b (T8-3): the harness's pre-existing `getByTsMsgIdConsistent` does
   NOT delegate through `getByTsMsgId`. If Task 8 moves `readVersionedSource`
   to the consistent read, check whether any test spies `getByTsMsgId`.
3. Pre-existing fake divergences left alone: the fake `setRecipientDelivery`
   creates a missing map (the real throws a ValidationException); the fake
   stores an appended `deliveryRecipients` object by reference; `getById`
   returns a shallow copy.
4. `closeRelayRecipientIfUnsent` on a VERSIONED row creates an absent
   member's slot `{ status: 'failed', errorCode }` with no transport fields
   ("legacy and versioned alike"); the presenters should tolerate that shape.
5. `recordRecipientOutcome` answers `{ moved: false }` for a missing broadcast
   exactly as for a prior mismatch; a caller that must tell them apart reads.
6. A versioned adoption whose status is stale but which fills an absent sid
   or sentAt answers `adopted` (see the contract); a caller that gates an
   emit on `adopted` would emit for a status that did not move.
7. No background process is left running. Mutant runner, definitions, logs
   and pristine copies live only in the session scratchpad
   (`...\scratchpad\S1c\`). The byte-exact statements as built are in the
   gitignored `.superpowers/sdd/S1c-reference.md`.
