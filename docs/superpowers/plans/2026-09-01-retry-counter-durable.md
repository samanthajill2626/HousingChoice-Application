# Retry counters and the cap-and-close branch - implementation plan

Spec: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.

Decision IDs (D1..D23) refer to the spec. Where this plan states a line number
it is from `main@5ce9912f`; **verify the anchor by reading, not by trusting the
number.** Several defects in this design's history came from a mechanism
credited by name without tracing it from the call site in question.

TDD throughout: each slice writes its failing test first, and slices 1-4 must
each have a test that **fails on `main`** where the spec says so.

---

## Slice 1 - the claim primitive

**Files:** `app/src/repos/broadcastsRepo.ts`, `app/src/repos/messagesRepo.ts`.

Add to each repo:

```ts
claimFanoutPass(<pk args>, cap: number): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

- `UpdateExpression: 'ADD fanout_attempt :one'`, `:one = 1`.
- `ConditionExpression`: the item exists AND
  `(attribute_not_exists(fanout_attempt) OR fanout_attempt < :cap)`.
- `ReturnValues: 'UPDATED_NEW'` -> `{ fanout_attempt: N }`; return N as
  `attempt`. **Do not re-read the item to learn the result** - that reintroduces
  the race the atomic ADD removes (D5).
- On `ConditionalCheckFailedException`: a **`ConsistentRead: true`** GetItem
  disambiguates `capped` (item present) from `missing` (absent). An eventually
  consistent read here can report `missing` for an item that exists and skip a
  close.

`fanout_attempt` is a **top-level scalar** (D2, D3). ADD creates it from absent,
so there is no seeding step and no creation-site edit (D4).

**Tests (spec 7.1, 7.2, 7.8):**
- claim on an item with no attribute returns `claimed`/1;
- claim at `cap - 1` returns `claimed`; at `cap` returns `capped`;
- claim on a missing item returns `missing`;
- **concurrent claims yield distinct numbers** (fire N in parallel, assert the
  set of returned attempts has no duplicates);
- **the counter survives a status write**: claim, then `setRecipient` /
  `setRecipientDelivery` on the same item, then re-read - `fanout_attempt` is
  intact. **This test fails against a slot-resident counter (D2).**

---

## Slice 2 - broadcastFanOut

**File:** `app/src/jobs/broadcastFanOut.ts`.

### 2a. Insert the claim

Anchor: **immediately after the recipient-set derivation** (`const keys = ...`,
~:250-256) and **immediately before the send loop** (`for (const contactKey of
keys)`, ~:263).

That position is below every existing early return by construction, which is
what satisfies D6's "a job that attempts no send consumes no pass" without
enumerating guards. It also hands close B the exact `keys` this pass would have
attempted.

```ts
const claim = await broadcasts.claimFanoutPass(payload.broadcastId, MAX_BROADCAST_ATTEMPTS);
if (claim.outcome === 'missing') { log.warn(...); return; }
if (claim.outcome === 'capped')  { await closeBroadcast(keys, 'transient_cap'); return; }
```

### 2b. Rework the continuation block (~:478-513)

`claim.attempt` is the current pass number (identical to today's
`payload.attempt ?? 1`). Keep `const nextAttempt = claim.attempt + 1`.

| use | today | after |
|---|---|---|
| cap test | `if (nextAttempt > MAX_BROADCAST_ATTEMPTS)` | **deleted** - replaced by the close-A trigger below |
| backoff | `broadcastBackoffMs(nextAttempt)` | **unchanged** |
| enqueued payload | `attempt: nextAttempt` | **unchanged** (advisory) |

```ts
if (transientRemaining.length > 0) {
  if (claim.attempt >= MAX_BROADCAST_ATTEMPTS) {      // close A
    await closeBroadcast(transientRemaining, 'transient_cap');
    return;
  }
  try {
    await enqueue(BROADCAST_SEND_JOB, {...}, { runAt: ...broadcastBackoffMs(nextAttempt) });
  } catch (err) {                                      // close C (D9)
    log.error({ err, broadcastId: payload.broadcastId }, 'broadcastFanOut: continuation enqueue failed - closing');
    await closeBroadcast(transientRemaining, 'enqueue_failed');
    return;
  }
  return;   // KEEP - main:509 "A continuation is still pending - do NOT finalize yet"
}
await finalize(...);   // unchanged trailing call
```

**All three `return`s are load-bearing.** Dropping the last one finalizes the
broadcast as Sent on pass 1 with a continuation in flight - a false success that
behaves normally afterwards and so hides from most tests (spec 7.6).

### 2c. `closeBroadcast(recipientKeys, code)`

Extract from the existing cap-branch body (~:481-495): for each key,
`recordRecipient(..., { status: 'failed', errorCode: code })`, `bumpStats({
failed: 1, queued: -1 })`, `emitBroadcastProgress`, then `finalize(...)` once
after the loop. Skip keys already terminal.

**Tests (spec 7.3, 7.4, 7.5, 7.6, 7.7):**
- `enqueue` made to throw -> broadcast finalized, no recipient `queued`, row not
  `sending`. **Must fail on `main`.** Seam: `enqueue` is a module import from
  `./jobs.js`, NOT a dep on the handler's deps bag - use `vi.mock`. Confirm the
  mock actually intercepts before trusting a green run.
- close A, close B and close C each leave the same terminal shape; **close B
  driven on a first-pass envelope (no `recipientKeys`)**.
- send count and `runAt` values per pass identical to `main`.
- a pass that enqueues successfully leaves the broadcast `sending`.
- a same-`jobId` redelivery claims nothing; an early return claims nothing.

---

## Slice 3 - relayFanOut

**File:** `app/src/jobs/relayFanOut.ts`. Same shape as slice 2, three differences.

### 3a. Claim anchor

**Immediately after the recipient derivation** (`let recipients = roster.filter(
...)` plus the `recipientKeys` narrowing, ~:434-438), before the send loop.

Close B marks the derived `recipients` mapped through `relayMemberKey`. **Not
the message row's `delivery_recipients`** - on a relay inbound source message
that map is seeded EMPTY, so a row-derived set marks nothing and a test built on
a team-send fixture passes vacuously (spec 7.4).

### 3b. Backoff argument differs from broadcast - preserve it

| use | today | after |
|---|---|---|
| cap test | `if (nextAttempt > MAX_FANOUT_ATTEMPTS)` | deleted |
| backoff | `fanOutBackoffMs(payload.attempt ?? 1)` | `fanOutBackoffMs(claim.attempt)` - **same value** |
| enqueued payload | `attempt: nextAttempt` | unchanged |

Broadcast waits the NEXT step, relay waits the CURRENT one. **Do not normalise
them** (D7, D11). A single "claim.attempt" form for both halves broadcast's
delay.

### 3c. `closeRelay(memberKeys, code)`

`markRecipient(..., { status: 'failed', errorCode: code })` per key, skipping
terminal slots. **No `finalize()`, no `bumpStats`, no progress emit** - none
exist in this file. One helper per file; do not force a shared one.

**Tests:** the slice-2 list, plus **close B on a relay INBOUND source message**
(the empty-`delivery_recipients` shape).

---

## Slice 4 - group rail propagation ladder

**Files:** `app/src/services/groupRail.ts` + three callers.

### 4a. Opt-in flag

Add an optional boolean to `GroupRailRequest` (default off/absent). Pass it from
`jobs/groupRail.ts:59`, `lib/import/convertGroups.ts:598`,
`app/scripts/rail-verify.ts:198`. **Do not touch either `groupSend` call site**
(:381, `healRail` :425) - D16.

### 4b. The ladder

A small helper: given a re-read function and the current `missing` set, re-read
up to **2** more times at **500ms** then **1500ms**, stopping as soon as
`missing` is empty.

Apply at **both** points that can conclude damage (D14):

1. the validation read after create - note the post-create participant list
   arrives INSIDE the adapter's return, so this is a NEW `fetchParticipants`
   call, not an existing one;
2. the existing post-repair `fetchParticipants` (~:538).

**Gate both on the flag AND on the rail having been created in this call** (the
existing `wasAdopted` distinction). The post-repair read is shared with the
adopt path, which must ladder on neither read (D17).

Nothing else changes: the re-read stays authoritative, completeness is still not
derived from the create's failures (D15), and no 50386/50437 handling is added
(D18).

**Tests (spec 7.9):** the four lettered cases - propagation resolves without
repair; a genuinely unbound member still repairs; the post-repair read ladders;
the adopt path ladders on neither. Plus: both `groupSend` callers pass no flag,
and with the flag absent neither read ladders.

---

## Slice 5 - dashboard copy

**Files:** `dashboard/src/routes/contact/deliveryStatus.ts`,
`dashboard/src/routes/contact/Timeline.tsx`.

### 5a. Relay 30003 override (D19-D21)

Add a relay-scoped override consulted before `ERROR_CODE_REASONS`, selected the
way the existing `media` option already selects `MMS_ERROR_CODE_REASONS`.
`presentLegDelivery` already receives `rosterKind`; `presentRelayDelivery` gains
it from its caller.

Relay legs get `Phone unreachable` with no retry promise. **Native group text is
excluded** (D20) - its retry is real.

The six `deliveryReason` call sites and what each gets:

| site | change |
|---|---|
| `deliveryStatus.ts:416` (relay/group rollup) | override when relay |
| `Timeline.tsx:582` (per-leg reason) | override when relay |
| `Timeline.tsx:1045` (per-recipient row) | override when relay |
| `Timeline.tsx:849` (1:1 bubble) | none |
| `Timeline.tsx:1390` (EmailCard) | none |
| `DeliveryBadge.tsx:31` (broadcast badge) | none for 30003; see 5b |

`rosterKind` **DEFAULTS to `'relay'`** (~Timeline.tsx:796), so the group-text
exclusion holds only because one site opts out. Pin it explicitly in the test.

The live 30003 string contains an EM DASH; leave the 1:1 entry byte-identical.

### 5b. Internal code copy (D22, D23)

Register both `transient_cap` and `enqueue_failed` in `INTERNAL_CODE_REASONS`
with plain operator copy and **no `(error <code>)` tail** - that map exists
precisely to stop app-invented codes printing as carrier error numbers.

Copy must read correctly BOTH as an aggregate summary and on one recipient's
row; unlike `contact_opted_out`, these get no per-position interception.
`DeliveryBadge.tsx:31` is where a broadcast's codes surface, so this DOES change
that badge.

**Tests (spec 7.10, 7.11):** relay 30003 copy at all three relay positions;
group-text pinned explicitly; 1:1, email and badge 30003 unchanged; both
internal codes render as prose in all three positions.

---

## Slice 6 - the provider-status sweep

Read-only audit (spec Sec 9). Enumerate every `app/src` site branching on a
provider status string; record `file:line` and whether the unenumerated default
is terminal. Fix in-region findings; file the rest as one issue. The
unknown-error `throw` is the named in-region exception - filed, not fixed (D12).

Output: `docs/superpowers/reviews/2026-08-31-retry-counter-durable/provider-status-sweep.md`.
A nil result is still committed.

---

## Slice 7 - e2e + issue closure

- E2E: a relay leg that failed 30003 shows no retry promise. **Arm it with
  `setDeliveryOutcome` (fake-twilio), not seed data** - no seed profile carries
  a `delivery_recipients` map, so a seeded fixture asserts against an empty list
  and passes while proving nothing.
- Stamp Resolutions on `retry-counter-in-envelope-makes-caps-unreachable` and
  `rail-binding-propagation-retry` (partial - name the two uncovered callers).
- File the follow-ups: adopt-path exposure, refusal log noise.
- Amend `_CLUSTERS.md` M5.
- `npm run issues`.

---

## Gates

From the worktree, bare, after one `main` sync:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Never pipe a gate. A red `npm test` is not a regression until re-run under
`AWS_ACCESS_KEY_ID=hccleanrun001` and compared against the merge base by failing
FILE - three other missions share this machine and one DynamoDB Local container.
Confirm no orphaned listener on the lane's ports before each e2e run.

## Ordering

1 -> 2 -> 3 in order (2 and 3 both depend on 1; 3 reuses 2's shape). 4 and 5 are
independent of 1-3 and of each other. 6 any time. 7 last.
