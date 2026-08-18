# Relay pool-number reuse for the same pair, and the duplicate-open-group guard

Date: 2026-08-17
Branch: `feat/relay-number-reuse` (worktree `W:\tmp\relay-number-reuse`, cut from
`main` @263cc789)

## 1. What this changes, in one paragraph

Today a second relay group for the same two people always burns a fresh pool
number, because the allocation rule refuses any number that has EVER hosted one
of the new members. This spec relaxes that rule in exactly one narrow case - the
new roster's phone set is identical to the phone set of the newest CLOSED group
on that number - so a pair keeps "their" number across groups. It then adds two
guards that the relaxation makes necessary or that Cameron asked for: a strong,
overridable refusal when an OPEN group already exists with the same people, and a
hard refusal to REOPEN a group when doing so would put two overlapping open
rosters on one pool number.

## 2. Verified current behavior

Every claim in this section was read in the code on `main` @263cc789. Line
references are to that commit.

### 2.1 Inbound already resolves many groups per number

`app/src/routes/webhooks/twilio.ts:1911-1972` resolves an inbound SMS on
`(To, From)` via `getAllByPoolNumber(To)`, which returns every relay group the
number has ever fronted (open and closed - `pool_number` is never cleared):

- (a) an OPEN group whose roster contains the sender -> the relay fan-out path;
- (b) else a CLOSED group whose roster contains the sender -> the late text is
  intercepted into that sender's OWN 1:1 thread, with provenance;
- (c) else an unknown sender -> the newest open group if any, otherwise fall
  through to the normal 1:1 intake.

Branch (b) explicitly anticipates "a person can be in several closed groups on
one number over the years".

### 2.2 The real routing invariant

From 2.1 it follows that the property routing actually depends on is:

> AT MOST ONE OPEN GROUP PER (pool number, member phone).

When more than one open group on a number matches the sender,
`twilio.ts:1918-1927` logs `multiple OPEN relay groups on one pool number match
the sender (burn invariant violated)` at ERROR and routes to the newest. That log
line is an ERROR, so the `error-logs-sustained` alarm surfaces it.

### 2.3 The current allocation rule is strictly stronger than 2.2

`provisionForGroup` (`app/src/services/poolNumbers.ts:503-591`) runs three tiers:

- TIER 1 (`:532-547`) reuse-prefer-multiplex: the first ACTIVE, same-driver
  number that already hosts a group and whose `burned_phones` does not overlap
  the new roster AT ALL.
- TIER 2 (`:549-564`) fresh spare: an ACTIVE, same-driver, EMPTY-burn number that
  is not earmarked to a connecting group.
- TIER 3 (`:566-590`) connect-when-ready: with `relayLiveProvisioning` ON,
  returns `{ kind: 'needs_connecting' }`; with it OFF, THROWS
  `RelayProvisioningDisabledError`. `provisionForGroup` never buys a number -
  buying is solely `warmOneNumber`.

`burned_phones` is a permanent DynamoDB string set of every E.164 ever rostered
on the number (`app/src/repos/poolNumbersRepo.ts:15-21, 108-111`). Because it is
never cleared, a pair's second group can never land on their first group's
number. That over-restriction - counting CLOSED groups against a number - is the
sole cause of the behavior Cameron reported.

`repo.burnClaim` (`poolNumbersRepo.ts:515-555`) is the atomic arbiter: ONE
conditional `UpdateItem` that ADDs the roster to `burned_phones` only if the
number is `active` and none of the phones is already present.

### 2.4 The three creation surfaces

All three funnel through `provisionRelayGroup`
(`app/src/services/relayProvisioning.ts:69`):

1. `app/src/routes/relayGroups.ts:278` - `POST /api/relay-groups` (standalone,
   unowned).
2. `app/src/services/rosterProvision.ts:346` - tour relay open
   (`openTourGroup`), owner `{type:'tour'}`.
3. `app/src/services/rosterProvision.ts:646` - placement relay open
   (`openPlacementGroup`), owner `{type:'placement'}`.

Surfaces 2 and 3 each hold an ATOMIC one-thread-per-owner claim before
provisioning (`tours.claimGroupThread`, `rosterProvision.ts:325-341`, and the
placement equivalent), so neither can create a second thread for the same owner.
Both render refusals as `{ ok: false, refusal: { status, body } }` which the
routes emit verbatim.

### 2.5 Reopen is a pure status flip

`PATCH /api/conversations/:id/close` with `{closed:false}`
(`app/src/routes/relayGroups.ts:484-527`) flips `status` back to `open` with no
provisioning and no roster check. Its ONLY guard (AF-3) refuses when the pool
number's record is missing or not `active`, i.e. retirement released it.

### 2.6 Reverse lookup primitives that exist

- `conversations.listRelayGroups(status)` (`conversationsRepo.ts:731-733`) - a
  DIRECT Query on the SPARSE `byRelayStatus` GSI, one partition per status
  (`open` | `closed` | `connecting`), newest-activity-first. Returns
  `{ items, truncated }`; `truncated` is true when a fixed page budget (2000
  groups) stopped the walk early, and the contract says the caller MUST surface
  it. There is no index for "group by exact participant set" - rosters live in
  the un-indexed `participants` list - so an exact-set lookup is this Query plus
  an in-code match. This is the same primitive
  `GET /api/contacts/:id/relay-groups` (`routes/contacts.ts:1128-1184`) already
  uses, and reading it directly is strictly cheaper than going through that
  endpoint, which walks all three partitions to answer a different question.
- `conversations.getAllByPoolNumber(n)` (`conversationsRepo.ts:713`) - every
  relay group ever fronted by ONE number, PAGED TO COMPLETION and never
  truncated. This is the authoritative per-number read.

### 2.7 Stale comments (fixed by this change)

`poolNumbers.ts:5-13` (the file header) and `relayProvisioning.ts:87` both
describe a "provision a fresh one through the adapter" buy path that
`provisionForGroup` no longer has. They contradict the code and are corrected in
this change.

## 3. Decisions

**D1 - Reuse breadth is NARROW.** Tier 0 fires only when the new roster's phone
set exactly equals the phone set of the newest CLOSED group on the candidate
number. Tiers 1/2/3 are untouched, so allocation for every other case is
byte-identical to today. Rejected: relaxing tier 1 to the true invariant (reuse
any number with no OPEN overlap). That maximizes reuse but lets one number
accumulate unrelated households over years, so a late texter has no idea whose
number it is, and it is a far wider blast radius than the reported problem.

**D2 - No new pool-record attribute, and no atomicity for the tier-0 claim.**
An earlier draft added an `open_phones` string set maintained at every open,
close, reopen, add-member and remove-member surface, giving a conditional-write
mutex. It is not worth its cost HERE, because of D1: tier 0 only ever lands a
group on a number whose newest closed group has the IDENTICAL phone set, so the
worst state two racing creates can produce is two open groups with IDENTICAL
rosters. Routing to the "wrong" one of those still delivers to the same humans -
a split transcript, not a wrong-party disclosure - and it is already logged at
ERROR (2.2) and therefore alarmed. The wrong-party failure mode needs two open
groups with DIFFERENT rosters on one number; tier 1 still refuses any burn
overlap, so tier 0 cannot create that by itself. See section 8 for the residual
risk this accepts and section 6 for the one path that CAN produce differing
rosters, which is guarded.

**D3 - Two different comparators, deliberately.**

- Part A (tier 0) compares the sorted set of E.164 PHONES. Routing, burn, and
  masking are all phone-keyed, so phone identity is the only identity that makes
  a number "theirs".
- Part B (duplicate warning) compares the sorted set of `relayMemberKey` values
  (`app/src/repos/messagesRepo.ts:156` - `contactId` when non-empty, else
  `phone#<E164>`). This catches the same human added under a different number,
  which is a real operator duplicate that a phone comparison would miss.

**D4 - Tier 0 requires the NEWEST closed group on the number to match, not
merely SOME closed group.** Suppose a number hosted `{A,B}` (closed), then a
reused group that gained C via add-member and closed as `{A,B,C}`. Under a looser
"some closed group matched" rule, a new `{A,B}` group would take that number; if
the `{A,B,C}` group were later reopened, the number would carry two open groups
with DIFFERENT rosters sharing A and B - exactly the wrong-party state. Requiring
the newest closed group to match keeps the number's current meaning single.

**D5 - "Newest CLOSED", not "newest of any status".** Multiplexing means a
number legitimately hosts concurrent OPEN groups with disjoint rosters. Vetoing
on the newest group overall would block an unrelated pair's legitimate reuse
because someone else's disjoint group is open on the same number. The open-group
check is a separate, per-phone OVERLAP test (section 5, step 3i), which is the
condition that actually matters.

**D6 - Part B enforces on UNOWNED creates only.** Tour and placement opens
already hold an atomic one-thread-per-owner claim (2.4), which is the correct
dedup for them. A tour thread and a placement thread for the same tenant and
landlord are DIFFERENT subjects with legitimately identical rosters; refusing the
second would block real work with no override path (the quiet-hours deferred
poller has no UI to confirm through). So owner-scoped opens skip the check
entirely. The check itself still SCANS groups of every ownership, so a freehand
create that duplicates an existing tour thread is still caught - the operator
just gets an override.

**D7 - The reopen guard is a HARD refusal with no override.** Overriding it
would knowingly create the coin-flip state of 2.2. The remedy is to close the
other group first, which is a real, available action.

**D8 - Part B fails OPEN on an inconclusive scan; the reopen guard cannot be
inconclusive.** Part B reads `listRelayGroups`, which can report `truncated`.
When it does, the create is ALLOWED and a warning is logged - blocking an
operator because a GSI walk hit its page budget is worse than missing a
duplicate, and Part B is an operator-assist guard, not a safety fence. The reopen
guard is a safety fence, and it reads `getAllByPoolNumber`, which is paged to
completion and never truncates, so it always has a definite answer.

**D9 - The duplicate scan includes CONNECTING groups.** A connect-when-ready
group is a real pending group with a real roster; creating a second group for the
same people while one is waiting for its number is the same operator error.

## 4. New shared module: `app/src/services/relayGroupIdentity.ts`

One module, three exported predicates, so Part A's guard and Part B's warning are
the same underlying check built once.

```
/** Sorted, de-duplicated E.164 phone set - the routing identity of a roster. */
export function phoneSetKey(members: { phone: string }[]): string

/** Sorted, de-duplicated relayMemberKey set - the PEOPLE identity of a roster. */
export function peopleSetKey(members: { contactId?: string; phone: string }[]): string

/**
 * Part B. Scan the OPEN and CONNECTING relay partitions for a group whose
 * peopleSetKey equals this roster's. Returns the newest match, plus
 * `inconclusive: true` when either partition walk reported `truncated`.
 */
export function findOpenGroupWithSamePeople(
  deps: { conversations: ConversationsRepo; log: Logger },
  members: ConversationParticipant[],
): Promise<{ match?: ConversationItem; inconclusive: boolean }>

/**
 * The reopen guard AND tier 0's step-3i check. Authoritative
 * (getAllByPoolNumber, never truncated): the newest OPEN group on this pool
 * number, other than `selfConversationId`, that shares ANY phone with `roster`.
 */
export function findOpenMemberConflictOnNumber(
  deps: { conversations: ConversationsRepo },
  poolNumber: string,
  roster: { phone: string }[],
  selfConversationId?: string,
): Promise<ConversationItem | undefined>
```

`peopleSetKey` uses `relayMemberKey` from `app/src/repos/messagesRepo.ts` rather
than re-deriving the rule.

## 5. Part A - tier 0, same-pair reuse

A new tier 0 runs inside `provisionForGroup`
(`app/src/services/poolNumbers.ts`) BEFORE tier 1. Everything after it is
unchanged.

1. `want = phoneSetKey(rosterPhones)`.
2. `const { items, truncated } = await conversations.listRelayGroups('closed')`.
   If `truncated`, log a WARN naming the truncation and SKIP tier 0 entirely
   (falling through to today's behavior - a fresh number - which is never worse
   than today). Otherwise take every closed group that has a non-empty
   `pool_number` and whose `phoneSetKey(participants)` equals `want`, newest
   `created_at` first.
3. For each candidate number N, in order:
   - N must appear in the already-fetched `actives` list, which is ACTIVE and
     filtered to `provisioned_via === currentVia` (source isolation is
     preserved unchanged). Otherwise skip.
   - Re-read authoritatively: `groups = getAllByPoolNumber(N)`.
     - (i) `findOpenMemberConflictOnNumber` must find NOTHING: no OPEN group on
       N may share any phone with the new roster. (D5 - a disjoint open group on
       N is fine and must not veto.)
     - (ii) the newest CLOSED group on N must have `phoneSetKey === want` (D4).
   - `claimed = await repo.reuseClaim(N, rosterPhones, tag)`. On success:
     `await refillBufferIfNeeded()`, log
     `{ provisioned: false, tier: 0, event: 'relay_number_reused_same_pair' }`,
     and return `{ kind:'assigned', poolNumber: claimed.poolNumber, record:
     claimed, provisioned: false }`. On `undefined`, continue to the next
     candidate.
4. If no candidate claims, fall through to tier 1 exactly as today.

Step 3's authoritative re-read is what makes step 2's bounded, eventually
consistent GSI read safe: a stale or partial index result can only cost a reuse
opportunity, never grant an unsafe one.

### 5.1 New repo primitive: `reuseClaim`

`app/src/repos/poolNumbersRepo.ts` gains:

```
/**
 * The tier-0 SAME-PAIR claim. Unlike burnClaim, the phones are ALREADY burned
 * here - that is the precondition, not the obstacle - so the ADD is a no-op set
 * union and the CONDITION asserts the opposite of burnClaim's: the number is
 * `active` AND every phone is already in burned_phones (this number really is
 * this roster's). Returns the post-update item, or undefined on condition
 * failure (not active, or any phone not burned here) or an empty roster.
 *
 * NOT a mutex: two concurrent identical reuseClaims can both succeed. That is
 * accepted by design (spec D2) - both would be creating groups with the same
 * roster, so the result is a split transcript that the twilio.ts open-match
 * ERROR log surfaces, never a wrong-party delivery.
 */
reuseClaim(poolNumber: string, phones: string[], tag?: string):
  Promise<PoolNumberItem | undefined>
```

Implementation mirrors `burnClaim` exactly, with the condition inverted:

```
UpdateExpression: 'ADD #bp :phones' + (tag !== undefined ? ' SET placement_tag = :tag' : '')
ConditionExpression: 'lifecycle_state = :active AND contains(#bp, :p0) AND contains(#bp, :p1) ...'
ReturnValues: 'ALL_NEW'
```

Empty `phones` returns `undefined` without a write, mirroring `burnClaim`. The
`lifecycle_state = :active` clause preserves the W2 retirement fence: a number
claimed for release is `releasing` and is refused here exactly as it is by
`burnClaim`.

### 5.2 What Part A does NOT change

`burnMember` (add member), `burnGroupRoster` (connect-when-ready assign),
`noteGroupClosed`, `retireEligible`, the release fence, and the warm/buffer paths
are untouched. Tier 0 never buys, so the kill-switch posture is unchanged: a
tier-0 hit resolves with `relayLiveProvisioning` off exactly as tiers 1 and 2 do.

## 6. The reopen guard (new, and load-bearing)

Part A makes a previously unreachable sequence reachable: close the `{A,B}`
group, create a new `{A,B}` group that reuses the number, then REOPEN the old
one. That is not a race - it is two clicks - and because rosters can drift via
add/remove member between the two groups, it is the one path that CAN put two
open groups with DIFFERENT rosters on one number, which is the genuine
wrong-party state.

In `app/src/routes/relayGroups.ts`, the REOPEN branch gains one check after the
existing AF-3 released-number guard and before the status flip:

```
const conflict = await findOpenMemberConflictOnNumber(
  { conversations }, reopenPool, conversation.participants ?? [], conversationId,
);
if (conflict !== undefined) {
  await audit.append(`conversations#${conversationId}`, 'relay_group_reopen_refused', {
    actor, reason: 'member_in_open_group', conflictConversationId: conflict.conversationId,
  });
  log.info({ conversationId, event: 'relay_reopen_refused_member_conflict' },
    'relay reopen refused - a member is already in another open group on this number');
  res.status(409).json({
    error: 'relay_member_in_open_group',
    conversationId: conflict.conversationId,
    message:
      'This relay group cannot be reopened: someone on it is already in another ' +
      'open group on the same number. Close that group first, then reopen this one.',
  });
  return;
}
```

This reuses the existing `relay_group_reopen_refused` audit action with a new
`reason`, matching the `pool_number_released` precedent immediately above it. The
guard is unconditional - it also protects PRE-EXISTING data, so any legacy
invariant violation now fails closed at reopen instead of silently routing.

## 7. Part B - duplicate OPEN group refusal

### 7.1 Service

`app/src/services/relayProvisioning.ts` gains:

```
export class DuplicateOpenRelayGroupError extends Error {
  readonly conversationId: string;
  constructor(conversationId: string, message: string) { ... }
}

export const DUPLICATE_OPEN_RELAY_GROUP_MESSAGE =
  'an open relay group with these same people already exists - open it instead, ' +
  'or resubmit with acknowledgeDuplicate to create a second one anyway';
```

`ProvisionRelayInput` gains `acknowledgeDuplicate?: boolean` (default false).

At the top of `provisionRelayGroup`, BEFORE `provisionForGroup` and before any
conversation is created - matching how the kill-switch error already precedes
every side effect:

- Skip the check entirely when `resolvedOwner.type !== null` (D6) or when
  `acknowledgeDuplicate === true`.
- Otherwise call `findOpenGroupWithSamePeople`. On `inconclusive`, log a WARN and
  PROCEED (D8). On a match, throw `DuplicateOpenRelayGroupError(match.conversationId, ...)`.
- When `acknowledgeDuplicate === true` AND a match exists, log
  `{ event: 'relay_duplicate_open_group_overridden' }` and record
  `duplicateAcknowledged: true` on the existing `relay_group_created` audit entry,
  so a deliberate duplicate is visible after the fact.

### 7.2 Route

`app/src/routes/relayGroups.ts`, `POST /api/relay-groups`:

- Read `acknowledgeDuplicate` from the request body (boolean, default false) and
  pass it into `provisionRelayGroup`.
- Add one arm to the EXISTING catch block, alongside the
  `RelayProvisioningDisabledError` arm:

```
if (err instanceof DuplicateOpenRelayGroupError) {
  await audit.append('relay#provisioning', 'relay_duplicate_open_group_refused', {
    actor, conversationId: err.conversationId,
  });
  log.info({ actor, event: 'relay_duplicate_open_group_refused' },
    'relay group create refused - an open group with these people already exists');
  res.status(409).json({
    error: 'duplicate_open_group',
    conversationId: err.conversationId,
    message: err.message,
  });
  return;
}
```

409 body shape deliberately mirrors the existing `pool_number_released` 409 in
the same file: `{ error, message }` plus the id the client needs to link to.

### 7.3 Not in this change

The dashboard confirm-dialog wiring. `feat/contact-create-relay-group` is
sequenced first and owns `RosterConfirmDialog.tsx`, `dashboard/src/api/endpoints.ts`,
and a new `POST /api/relay-groups/preview`. Wiring the 409 into that dialog is
filed as `docs/issues/relay-duplicate-group-dialog-wiring.md` for after it merges.
Until then the guard is live at the API for every client, which is the point of
enforcing it server-side (D6 rationale).

## 8. Residual risk, stated plainly

Two concurrent creates of the same unowned roster can both pass Part B's read
check and both pass tier 0's read checks, producing two OPEN groups with
IDENTICAL rosters on one number. Consequences, in full:

- Inbound from a member matches both; `twilio.ts:1918-1927` logs at ERROR
  (surfaced by `error-logs-sustained`) and routes to the newest.
- Delivery goes to the same set of humans either way. No message reaches anyone
  who was not already on both rosters.
- The visible harm is a split transcript: some inbound lands in one thread, the
  other thread looks quiet.

This is accepted (D2). It is filed as
`docs/issues/relay-duplicate-open-group-create-race.md` with the `open_phones`
conditional-write design written up as the fix if it is ever observed. The
sequential path that produces the WORSE state (differing rosters) is the reopen
path, and that one is closed by section 6.

## 9. Surfaces swept

Every mutator and reader of the state this design depends on:

| Surface | File | Effect |
|---|---|---|
| Standalone create | `routes/relayGroups.ts:278` | Part A via service; Part B enforced; 409 arm added |
| Tour open | `services/rosterProvision.ts:346` | Part A via service; Part B skipped (D6) |
| Placement open | `services/rosterProvision.ts:646` | Part A via service; Part B skipped (D6) |
| Quiet-hours deferred open | `jobs/rosterActions.ts` | unchanged - reaches provisioning through rosterProvision, and D6 exempts it |
| Connect-when-ready assign | `jobs/relayNumberReady.ts:136` | unchanged - burns onto a fresh warm number; tier 0 never targets an earmarked or warming record |
| Add member | `services/relayMembers.ts:193` | unchanged - `burnMember` semantics identical |
| Remove member | `services/relayMembers.ts` | unchanged - removal never unburns |
| Close | `routes/relayGroups.ts:448-474` | unchanged - keeps the number, stamps the retirement clock |
| Reopen | `routes/relayGroups.ts:484-527` | NEW member-conflict guard (section 6) |
| Retirement sweep | `services/poolNumbers.ts:358-438` | unchanged - `reuseClaim` respects `lifecycle_state = active`, so the W2 fence still holds |
| Inbound routing | `webhooks/twilio.ts:1911-1972` | READER, unchanged - it already handles many groups per number, which is why the relaxation is safe |
| Voice masked inbound | `webhooks/voice.ts` via `getByPoolNumber` | READER, pre-existing lossy one-group view; tier 0 does not change its exposure (a number could already host many groups via multiplexing). Noted as a pre-existing gap, not introduced here |
| Contact relay-groups card | `routes/contacts.ts:1128` | READER, unchanged |
| Pool numbers admin | `routes/poolNumbersAdmin.ts` | READER, unchanged |

## 10. Test plan

Unit (`app/test/`):

- `poolNumbersRepo.test.ts` - `reuseClaim` succeeds when active and all phones
  burned; returns undefined when not active, when any phone is not burned, and
  on an empty roster; stamps `placement_tag` when given.
- `poolNumbers.test.ts` - tier 0 reuses the pair's number; tier 0 skipped when an
  OPEN group on the number shares a phone; skipped when the newest closed group
  on the number differs (D4); NOT skipped when a DISJOINT open group is on the
  number (D5); skipped when the record is not active, when the driver differs,
  and when the closed-partition walk truncated. Every existing tier-1/2/3 test
  must stay green untouched - that is the regression proof that D1 held.
- `relayGroupIdentity.test.ts` (new) - `phoneSetKey` / `peopleSetKey` ordering and
  de-duplication; `findOpenGroupWithSamePeople` matches across OPEN and
  CONNECTING (D9), reports `inconclusive` on truncation; `findOpenMemberConflictOnNumber`
  excludes self and ignores closed groups.
- `relayProvisioning.test.ts` - throws for an unowned duplicate; does NOT throw
  for a tour- or placement-owned create with the same roster (D6); does not throw
  with `acknowledgeDuplicate: true`, and audits `duplicateAcknowledged`.
- `relayApi.test.ts` - `POST /api/relay-groups` returns 409 `duplicate_open_group`
  with the existing `conversationId`; the same POST with
  `acknowledgeDuplicate: true` returns 201; reopen returns 409
  `relay_member_in_open_group` when a member is in another open group on the
  number, and still reopens normally when there is no conflict.

E2E (`e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts`, extended):

- Create a relay group for a pair, capture its pool number, close it, create a
  second group for the same pair, and assert the SAME pool number is assigned.
  This is the feature's headline claim and belongs in the harness permanently.
- Assert the duplicate-create refusal at the API level from the same spec.

## 11. Follow-ups filed

- `docs/issues/relay-duplicate-group-dialog-wiring.md` - wire the 409 into the
  contact-file confirm dialog after `feat/contact-create-relay-group` merges.
- `docs/issues/relay-duplicate-open-group-create-race.md` - the accepted
  concurrent-create race of section 8, with the `open_phones` fix design.
- `docs/issues/relay-voice-inbound-single-group-view.md` - `webhooks/voice.ts`
  resolves a pool number through the lossy `getByPoolNumber`; pre-existing under
  multiplexing, recorded because this change touches the neighborhood.

## 12. Out of scope

- Relaxing tier 1 to the true invariant (D1, rejected).
- Any dashboard change (section 7.3).
- Any change to add-member's burn refusal.
- Any infrastructure, schema migration, or backfill. This design adds no
  attribute and no index, so there is nothing to apply and nothing owed at deploy
  beyond the normal app release.
