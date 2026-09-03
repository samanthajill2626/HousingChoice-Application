# Parent final review - PLAN-BLIND adversarial pass

Branch `feat/relay-30003-retry-lineage` @ `9a53af9d`, merge base `main` @ `f82c149c`.

Method: the spec and the plan in `docs/superpowers/` were NOT read. Nor were the
four prior review rounds. Everything below is derived from the code, the tests,
the repo's other consumers, and `docs/issues/`. No test suite was run (the human
is running the gates concurrently).

## What I checked and found sound

Recorded because a clean verdict on these is worth more than a longer list.

- **The atomic claim.** `messages.append` commits the retry row and its
  `sid#relayretry-<digest>-<attempt>` pointer in one `TransactWriteCommand`
  (`app/src/repos/messagesRepo.ts:2288-2360`), and the dedupe is attributed to
  index 1 - the SID pointer - specifically (`:2374-2380`). Two concurrent or
  redelivered callbacks compute the same `providerSid` from the same inputs
  (`app/src/lib/relayRetryClaim.ts:25-35`), so exactly one wins and the loser
  returns `already_claimed` at `app/src/routes/webhooks/twilio.ts:2831-2835`
  without enqueueing. `providerTs` differs between the two racers, so the row
  Put alone would NOT have collided; the pointer is doing the work, and the
  transaction rolls the row back with it.
- **No duplicate SEND path found.** Three independent layers hold: the SID
  pointer (duplicate callbacks), `putJobExecutionMarker` written BEFORE any send
  (`app/src/jobs/relayRetryLeg.ts:350-359`) for duplicate SQS deliveries, and
  `sendOneRelayLeg`'s terminal-slot skip (`app/src/jobs/relayFanOut.ts:1307-1308`)
  reading the CONSISTENT re-read at `relayRetryLeg.ts:364`. I specifically
  chased the two "enqueue succeeded but reported failure" shapes - the claim's
  (`twilio.ts:2846-2891`) and the transient sub-ladder's
  (`relayRetryLeg.ts:637-648`) - and both are caught by the terminal-slot skip
  when the ghost job later runs.
- **No wrong-recipient path found.** The destination is pinned by digest, not by
  member key: `relayRetryDigest(rootTsMsgId, normalizeToE164(member.phone)) !==
  destDigest` refuses (`relayRetryLeg.ts:533-540`), and the digest was minted
  from Twilio's own `To` on the failing leg (`twilio.ts:2720-2723, 2768`). A
  roster row whose phone changed, a `contactId` that collapsed two handsets
  (`docs/issues/relay-member-key-collapses-two-phones-one-contact.md`), and an
  unnormalisable current number all fail CLOSED. This is the strongest part of
  the design.
- **The fence against the neighbouring products holds.** `handleRelayRecipientStatus`
  is reachable only through a `relaysid#` pointer, and only two sites write one -
  `relayFanOut.ts:1449` and `services/relayAnnouncements.ts:354`. Native group
  text writes none (its receipts go through `services/groupReceipts.ts`), so the
  `relay_sender_key: TEAM_SENDER_KEY` written at `services/groupSend.ts:676`
  can never reach the claim's positive fence at `twilio.ts:2709-2713`.
  Announcement legs are excluded by `SYSTEM_SENDER_KEY`
  (`services/relayAnnouncements.ts:47, :239`).
- **App-wide sweep of the new row shape.** A retry row is a real message row in
  a relay conversation. I checked every generic reader I could find:
  `flushQueuedMessages` filters on `delivery_status === 'queued_pending'`
  (`services/relayQueuedMessages.ts:65`) and a retry row is `queued`;
  `relayFanOut`'s source window is bounded ABOVE by the source key
  (`relayFanOut.ts:772-776`) and retry rows sort later; the contact merged
  timeline and the media gallery both exclude `relay_group` BY NAME
  (`routes/contactTimeline.ts:1232`, `routes/contacts.ts:1378`); the dashboard
  fallback assembler does the same (`dashboard/src/routes/contact/useContactTimeline.ts:193`);
  `groupGuardrails.ts:223` reads inbound-only, not `last_activity_at`; the manual
  Retry route refuses on `delivery_status !== 'failed'|'undelivered'`
  (`routes/api.ts:1592`) and a retry row's message-level status is permanently
  `queued`; `incrementUnread` is called by the inbound webhook, never by
  `append`, so a retry row cannot mark a thread unread. The media-pointer
  suppression (`messagesRepo.ts:2363-2373`) is mirrored faithfully in the test
  fake (`app/test/helpers/twilioWebhookHarness.ts:1354-1362`), which is the kind
  of fake-vs-production inversion that usually goes unnoticed.
- **The chip arithmetic is disjoint.** K (`failed`), R (`retrying`) and J
  (`not confirmed`) in `dashboard/src/routes/contact/deliveryStatus.ts:459-489`
  partition correctly: `withDecidingRung` overlays a non-terminal status onto an
  `unconfirmed` leg so it cannot be hard-failed, `isStaleLeg` is false for every
  terminal status, and `retryAware: false` collapses all four counts to the
  pre-existing two. `composed` is never emitted with an empty parts list - every
  branch that uses it has already established a non-zero part.
- **The double `includedRecipientEntries` (raw entries at `Timeline.tsx:985`,
  then projected slots at `deliveryStatus.ts:448`) cannot disagree.** The
  predicate is `state === 'excluded' && !errorCode`
  (`dashboard/src/lib/messageTransport.ts:43-47`), and `withDecidingRung`
  (`relayRetryJoin.ts:261-288`) can drop `transportAggregationState` - but such a
  slot was already filtered out before the projection ran, so the widening is
  unreachable.

## Findings

### 1. MEDIUM - `canRetryRungGoQuiet` has no futurity bound; non-termination class 5 is reintroduced for the retry clause, and the docblock claims otherwise

`dashboard/src/routes/contact/relayRetryJoin.ts:312-315`:

```
export function canRetryRungGoQuiet(row: RelayRetryRow): boolean {
  const clock = rungStalenessClockMs(row);
  return clock !== undefined && Number.isFinite(clock);
}
```

Its leg-level twin, `canEverGoStale` (`deliveryStatus.ts:351-364`), makes the
SAME two checks and then one more:

```
  return clock - nowMs <= STALE_SENT_AFTER_MS;
```

That last line is the FUTURITY BOUND, and its own docblock (`:336-350`) says why
it exists: "A browser clock running slow - a stale VM, no NTP, a dead CMOS
battery - puts every freshly-sent leg in the FUTURE, and a future clock answered
'eligible' and 'not yet stale' at the same time, so the interval stayed armed for
ever". `Timeline.tsx:788-797` enumerates it as shipped-and-caught
non-termination number 5.

The rung-level pair has no such bound. Every rung clock is a SERVER clock
(`leg.sentAt`, else the retry row's own `at`, via `rungStalenessClockMs` at
`relayRetryJoin.ts:190-194`); `nowMs` is `tickNow`, the OPERATOR'S BROWSER clock
(`Timeline.tsx:758-766` - `bubbleNowMs` is `tickNow` unclamped). On a browser
whose clock is more than `STALE_SENT_AFTER_MS` (15 minutes) slow:

- `canRetryRungGoQuiet` -> true (the clock is finite),
- `isQuietSince(clock, nowMs)` -> `nowMs - clock >= 15min` is false for a future
  clock, so `isRetryRungLive` -> true (`relayRetryJoin.ts:217-229`),
- `hasTickableLeg`'s retry clause (`Timeline.tsx:877-883`) returns true on every
  tick, for ever - the 60s interval never disarms,
- `projectOneLeg` step 2 (`relayRetryJoin.ts:355-357`) returns `retrying` for
  ever - the indefinite promise this feature exists to remove, on the exact
  surface it exists to make truthful.

The comment at `Timeline.tsx:806-810` asserts the opposite as a property of the
code: "Closed by the retry clause below, which TERMINATES for the same reason
the leg-level pair does". It does not terminate for the same reason: the
leg-level pair's termination under skew comes entirely from the bound that the
rung-level pair omits. The comment two lines below the clause
(`Timeline.tsx:871-876`) compounds it by calling `canRetryRungGoQuiet`
"REDUNDANT here", which is true of the finiteness half and false of the half
that is missing.

Reachable only with >15 min of clock skew, hence MEDIUM rather than HIGH; no
data is written and no message is sent. The fix is one line in
`canRetryRungGoQuiet` (`clock - nowMs <= STALE_SENT_AFTER_MS`, reading `nowMs`
which the caller already has), or routing the arming half through the shared
bound.

### 2. LOW - a permanently stranded ladder logs WARN for ever, on the one alarm the founder approved to catch exactly that

`isTerminalRelayLegFailure` (`app/src/routes/webhooks/twilio.ts:433-445`)
whitelists `already_claimed` to WARN. The stranded-claim window - filed, openly,
at `docs/issues/relay-retry-stranded-claim-window.md` - makes every subsequent
redelivery of that callback return `already_claimed`
(`twilio.ts:2831-2835`) about a ladder that will never run: the row exists, the
rung was never queued, and no rung-2 callback can ever exist because rung 1 was
never sent.

So the single outcome in which a member permanently never receives the message
is the single outcome the new ERROR alarm cannot see. The issue states the
mechanism and even the WARN, and argues the WARN is "correct" for the value's
meaning - which it is, taken in isolation. What is not recorded anywhere is the
consequence for the alarm the whole D23 severity change was approved for
("ERROR once the chain is a real dead end"). Not a defect inside the delivered
mechanism; recorded so the alarm's blind spot is not rediscovered as a surprise.

### 3. LOW - a retry can carry different sender attribution than the leg it retries

`composeRelayLegCopy` (`twilio.ts:590-616`) re-resolves the sender's display name
from the CURRENT roster at CLAIM time. The fan-out composed the original leg from
the roster read at SEND time (`app/src/jobs/relayFanOut.ts:998-1005`,
`composeRelayBody` at `:194-197`), falling back to `ANONYMOUS_SENDER_LABEL`
("A member") when the sender has no name.

D12's verbatim guarantee starts at rung 1's stored copy, not at the original
send, so the gap is the window between the failing send and its 30003 callback.
A sender removed from the roster, or renamed, in that window yields
`A member: <body>` (or a new name) for a message the other members received as
`<old name>: <body>` - the same logical message, re-sent to one person with a
different attribution. The docblock at `twilio.ts:577-589` claims the copy
"mirrors relayFanOut's own three-arm composition"; it mirrors the SHAPE but not
the INSTANT, and the instant is the whole point of storing the string.

Narrow and low-harm, but it is a content difference on the one path where the
product re-sends something a human already read differently.

### 4. LOW - the module header inverts which transport mode is the ordinary case

`app/src/jobs/relayRetryLeg.ts:17-21`:

> The transport MODE is read off the RETRY ROW, not the root (spec D2). Every
> relay source written before 2026-09-02 is legacy, so a retry of an old message
> is the ordinary case

New relay sources are written VERSIONED, on both writers: the inbound relay
append passes `transportSchemaVersion: TRANSPORT_SCHEMA_VERSION`
(`app/src/routes/webhooks/twilio.ts:868`), and both team-send appends pass
`transportSchemaVersion: 1` (`app/src/routes/api.ts:1724` and the open-group
append below it). So from the day this branch merges, the VERSIONED arm is the
ordinary case and the legacy arm is the tail. The mechanism is right either way
(`relayRetryLeg.ts:381-390` classifies from the row); only the header's guidance
to the next reader is backwards, and it is the sentence that would be used to
decide which arm to test first.

### 5. LOW - the destination digest is a recoverable phone number, and it is logged beside the other half of its own preimage

`relayRetryDigest` (`app/src/lib/relayRetryClaim.ts:25-30`) is an UNSALTED
SHA-256 of `${rootTsMsgId}|${destinationE164}` truncated to 16 hex characters
(64 bits). The digest rides the retry row's sort key
(`relayRetryProviderSid`, `:33-35`), and `retryTsMsgId` is in the base log
context of every `relay_retry_leg` line (`relayRetryLeg.ts:339-344`) while
`rootTsMsgId` is added to the ladder context on the very next lines (`:372`).
The webhook's enqueue-failure line carries both together
(`twilio.ts:2878-2881`).

With one half of the preimage in the same log line, the NANP search space is
about 10^10 candidates - minutes of GPU work - and 64 bits of digest makes a
collision unlikely enough to identify the handset uniquely. The header's PII
claim at `relayRetryLeg.ts:26-27` ("no phone number and no message body ever
reaches a log line") is therefore stronger than the code delivers: no phone
number reaches a log line in PLAINTEXT.

This does not break the stated hard rule (no raw phone in a sort key) and the
audience for both logs and the row is already staff/operator-privileged. Raising
it because the codebase treats phone-in-logs as an absolute, built
`logSafeMemberKey` / `logSafeStoredMemberKey` specifically to honour it, and
would otherwise inherit a hash it believes is opaque. An HMAC keyed on an
existing server secret closes it with no shape change; so does simply not
carrying `rootTsMsgId` on the same lines as `retryTsMsgId`.

Same reasoning, lower weight, for the wire: `relay_retry_dest_digest` reaches the
browser because `GET /api/conversations/:id/messages` returns rows as-is
(`routes/api.ts:2160-2173`), which `dashboard/src/api/types.ts:2300-2307`
correctly and honestly documents.

### 6. LOW - the inbox re-sorts for something the thread does not show, with a stale preview

`relayRetryLeg.ts:600-604` calls
`touchLastActivityPreservingStatus(conversationId, undefined, now)` on every
`sent` rung. The preview argument is deliberately `undefined`
(`repos/conversationsRepo.ts:650-680`), so the stored preview is left alone.

For an INBOUND-origin relay source - a member relaying a message, the dominant
relay traffic - D20 hides the retry row entirely (`Timeline.tsx:1993-2008`
returns false unless `relay_retry_origin_direction === 'outbound'`). So the
observable result for staff is: the thread jumps to the top of the inbox, up to
three times per failed leg at roughly +60s / +180s / +420s, with an unchanged
preview and no new bubble; opening it shows nothing that changed except a chip
counter. On a CLOSED group it re-sorts within the closed partition for the same
invisible reason.

Each individual choice here is deliberate and separately documented. The
composite - bump, no preview change, no visible row - is not, and it is what an
operator experiences.

### 7. LOW - the quiet-hours note claims a bound the code does not enforce

`docs/issues/quiet-hours-ungated-automated-paths.md` (added paragraph) says the
"~7-minute bound still holds exactly" and that the transient sub-ladder "does not
extend the bound".

Both are optimistic. The ladder's wall clock is 60s, then the carrier's own time
to report rung 1 undelivered, then 120s, then that latency again, then 240s -
because rung N+1 is claimed only by rung N's failure callback
(`twilio.ts:2754-2763`), and nothing in the code bounds that latency. On top of
that each rung can burn its own transient sub-ladder (5s then 10s,
`relayFanOut.ts:99-101`, driven from `relayRetryLeg.ts:612-653`), which does
extend it, by up to 15s per rung. "About 7 minutes plus carrier latency" is the
honest form. Low stakes - the decision the issue records is unchanged - but the
word "exactly" is what a future reader would rely on.

### 8. LOW - two throw sites justify themselves with a guarantee the code does not carry on every path

`relayRetryLeg.ts:279-284` justifies throwing on a malformed retry row with
"Throwing is safe here precisely because the execution marker is already set: an
SQS redelivery no-ops instead of looping." The marker is written only when
`getContext()?.jobId` is a non-empty string; the else branch at `:357-359` logs a
WARN and skips the guard entirely. On that path the same throw loops until the
redrive policy gives up. The same reasoning is implicitly relied on by the
row-not-found throw at `:366` and the no-pool-number throw at `:508`.

Very narrow (an absent `jobId` would need a queue-runtime change), but the
comment states an unconditional property of a conditional guard, and it is
exactly the kind of sentence a later reader trusts instead of re-deriving.

## Things I deliberately did not report

- The retry row consuming a slot in the 50-row page, so a relay thread with many
  retries shows fewer visible messages per page and an orphaned ladder (original
  not yet paged in) renders nothing at all for an inbound-origin source. This is
  a real consequence, but `deliveryStatus.ts:388-397` (`retryRow`) and the
  `relay_retry_origin_direction` carry-through show it was reasoned about.
- A `delivered` receipt arriving after a `failed` one is refused by
  `ALLOWED_PRIOR` (`messagesRepo.ts:129-138`) and the rung reads terminal-failed
  for a message that landed. Pre-existing forward-only semantics, unchanged by
  this branch, and it produces no send.
- Up to nine provider sends per failed leg (3 rungs x 3 transient passes). Every
  transient pass is a REJECTED create (429 / 30022), so no handset receives
  anything twice; the token bucket is charged per attempt, which is correct.
- Style, naming and comment length. The comments in this branch are long, but
  they are load-bearing and mostly accurate; where they are not, the specific
  claim is a finding above.

## Verdict

I would merge this, after fixing finding 1 (one line) and correcting the
docblock at `Timeline.tsx:806-810` that asserts the property it does not have.
Findings 2-8 are follow-ups, not blockers.

The core mechanism is the strongest part: the claim is genuinely atomic, the
duplicate-delivery guard and the terminal-slot skip are two independent layers
behind it, and the destination digest makes "the retry goes to a different
handset than the one that failed" structurally impossible rather than merely
unlikely. I could not construct a duplicate send or a cross-member send.
