# Relay pool-number reuse for the same pair, and the duplicate-open-group guard

Date: 2026-08-17
Branch: `feat/relay-number-reuse` (worktree `W:\tmp\relay-number-reuse`, cut from
`main` @263cc789)
Revision: r2, after two independent adversarial reviews. Adjudications at
`.superpowers/design-review/adjudications.md`.

## 1. What this changes, in one paragraph

Today a second relay group for the same two people can never land on the number
their first group used, because the allocation rule refuses any number that has
EVER hosted one of the new members - counting CLOSED groups against it forever.
This spec relaxes that rule in exactly one narrow case: the number's permanent burn
already contains every one of the new roster's phones, some CLOSED group on it had
exactly this phone set, and no live group on it shares a phone with the new roster.
It then adds a guard against reopening a group into a conflicting state, and a
strong overridable refusal when an OPEN group already exists with the same people.

What the pair gets today instead of "their" number is worse than a wasted number.
`provisionForGroup` never buys (2.3). With the deployed spare-buffer target there is
usually no free spare, so the second group falls to tier 3: it is created CONNECTING
and stalls until a newly PURCHASED number completes A2P registration, or - with the
relay kill-switch off - it fails with a 503. So the cost of the current rule is a
purchase plus a wait, not a re-shuffle.

## 2. Verified current behavior

Every claim here was read in the code on `main` @263cc789.

### 2.1 Inbound already resolves many groups per number

`app/src/routes/webhooks/twilio.ts:1911-1972` resolves an inbound SMS on
`(To, From)` via `getAllByPoolNumber(To)`, which returns every relay group the
number has ever fronted (open and closed - `pool_number` is never cleared):

- (a) an OPEN group whose roster contains the sender -> the relay fan-out path;
- (b) else a CLOSED group whose roster contains the sender -> the late text is
  intercepted into that sender's OWN 1:1 thread, with provenance;
- (c) else an unknown sender -> the newest open group if any, otherwise the normal
  1:1 intake.

Branch (b) explicitly anticipates "a person can be in several closed groups on one
number over the years".

### 2.2 The real routing invariant

From 2.1, the property routing depends on is:

> AT MOST ONE OPEN GROUP PER (pool number, member phone).

When more than one open group on a number matches the sender,
`twilio.ts:1918-1927` logs `multiple OPEN relay groups on one pool number match the
sender (burn invariant violated)` at ERROR and routes to the newest.

### 2.3 The current allocation rule is strictly stronger than 2.2

`provisionForGroup` (`app/src/services/poolNumbers.ts:503-591`) runs three tiers:

- TIER 1 (`:532-547`) reuse-prefer-multiplex: the first ACTIVE, same-driver number
  that already hosts a group and whose `burned_phones` does not overlap the new
  roster AT ALL. The preference is deliberate - it packs disjoint groups onto
  existing numbers so the warm buffer is spent last, which means a mature number
  hosts SEVERAL unrelated pairs over time.
- TIER 2 (`:549-564`) fresh spare: ACTIVE, same-driver, EMPTY burn, not earmarked to
  a connecting group.
- TIER 3 (`:566-590`) connect-when-ready: with `relayLiveProvisioning` ON, returns
  `{ kind: 'needs_connecting' }`; with it OFF, THROWS
  `RelayProvisioningDisabledError`. It never buys - buying is solely `warmOneNumber`.

`burned_phones` is a permanent DynamoDB string set of every E.164 ever rostered on
the number (`app/src/repos/poolNumbersRepo.ts:15-21, 108-111`). Because it is never
cleared, a pair's second group can never land on their first group's number.

`repo.burnClaim` (`poolNumbersRepo.ts:515-555`) is the atomic arbiter: ONE
conditional `UpdateItem` that ADDs the roster to `burned_phones` only if the number
is `active` and none of the phones is already present.

### 2.4 The three creation surfaces

All three funnel through `provisionRelayGroup`
(`app/src/services/relayProvisioning.ts:69`):

1. `app/src/routes/relayGroups.ts:278` - `POST /api/relay-groups`, unowned. Its own
   comment (`:273-275`) calls this "the test scaffold"; nothing in `dashboard/src`
   posts to it. This matters for Part B - see D6 and 7.4.
2. `app/src/services/rosterProvision.ts:346` - tour relay open, owner `{type:'tour'}`.
   Holds an ATOMIC one-thread-per-tour claim first
   (`tours.claimGroupThread`, `rosterProvision.ts:333-341`,
   `attribute_not_exists(groupThreadId)`).
3. `app/src/services/rosterProvision.ts:646` - placement relay open, owner
   `{type:'placement'}`. Its one-thread guard is NOT atomic: `:601-610` is a plain
   `getById` read-then-refuse with no conditional write. This is a known open issue,
   `docs/issues/placement-relay-no-atomic-claim.md`. An earlier revision of this spec
   asserted an atomic claim here; that was wrong, and D6 no longer relies on it.

Surfaces 2 and 3 render refusals as `{ ok: false, refusal: { status, body } }`, which
the routes emit verbatim.

### 2.5 Reopen is a pure status flip, and it is not the only one

`PATCH /api/conversations/:id/close` with `{closed:false}`
(`app/src/routes/relayGroups.ts:484-527`) flips `status` back to `open` with no
provisioning and no roster check. Its only guard (AF-3) refuses when the pool
number's record is missing or not `active`.

It is NOT the only closed-to-open writer. `conversationsRepo.touchLastActivity`
(`:1449-1507`) does `SET #s = :open` on ANY conversation that is not a `group_text` -
the comment at `:1456` says "Activity (re)opens the thread" - so an inbound or a
staff send into a CLOSED relay group silently reopens it, with no audit and no
guard. It leaves `relay_status` at `relay_group#closed`, so `status` and
`relay_status` fall out of lockstep. This is a PRE-EXISTING bug, already filed as
`docs/issues/inbound-reflags-closed-relay-group.md`, and it is deliberately NOT fixed
here (8+ call sites across the hottest write path in the app). Section 8 states what
it costs this design.

### 2.6 Roster membership is mutable; burn provenance is not

Roster edits on a CLOSED relay group are legal and silent - `addMemberToRelay` and
`removeMemberFromRelay` refuse only `status === 'connecting'`
(`relayMembers.ts:145-159`, `:309-319`), and the standalone remove has no roster floor
(`refuseLastMember` defaults off, `:325-329`). So `participants` is an
operator-controlled field, not a historical fact, and any safety check keyed on it is
evadable in ordinary clicks.

Worse, the add path SKIPS the burn claim entirely when the phone is already in THIS
group's `ever_member_phones` (`relayMembers.ts:186-192`, rule 2 - the
remove-then-re-add allowance). So a roster can be drained and refilled with no burn
claim anywhere.

The codebase already carries the immutable counterpart:
`ever_member_phones` (`conversationsRepo.ts:238-247`) is the add-only set of phones
this group has burned on its number - "Member REMOVE never touches it - a burn is
forever". It is seeded at `createRelayGroup` (`:1744`) and ADDed on every add
(`:1099-1104`).

**Every membership test in this design therefore uses provenance, never the live
roster:**

```
memberPhoneSet(g) = union( g.ever_member_phones , g.participants[].phone )
```

The union covers legacy pre-W1 groups that carry no `ever_member_phones` at all.

### 2.7 Reverse-lookup primitives

- `conversations.getAllByPoolNumber(n)` (`conversationsRepo.ts:713`, `:1785-1804`) -
  every relay group ever fronted by ONE number, PAGED TO COMPLETION. Complete, but a
  Query on the `byPoolNumber` GSI, so eventually consistent: a GSI admits no
  `ConsistentRead` (the repo says so itself at `poolNumbersAdmin.ts:210-212`, "these
  three Queries are NOT a consistent snapshot"). Paging bounds truncation, not
  staleness.
- `conversations.listRelayGroups(status)` (`:731-733`) - a direct Query on the SPARSE
  `byRelayStatus` GSI, one partition per status, newest-activity-first. Returns
  `{ items, truncated }`; `truncated` means a fixed page budget
  (`RELAY_LIST_PAGE_LIMIT` 100 x `RELAY_LIST_MAX_PAGES` 20 = 2000, `:384-385`) stopped
  the walk, and the caller MUST surface it. Part A does NOT use this (see D2); only
  Part B does.

### 2.8 Stale comments corrected by this change

- `poolNumbers.ts:5-13` (file header) still describes "(c) else PROVISION a fresh one
  through the adapter". `provisionForGroup` has no buy path.
- `relayProvisioning.ts:85-87` says the ladder "NEVER buys and NEVER throws the
  kill-switch error". "NEVER buys" is correct; "NEVER throws the kill-switch error"
  is wrong - `poolNumbers.ts:577-579` throws `RelayProvisioningDisabledError` at a
  tier-3 miss with the flag off, and both callers catch it (`relayGroups.ts:286`,
  `rosterProvision.ts:364`). Fix that half, not the "never buys" half.

## 3. Decisions

**D1 - Reuse breadth is NARROW.** Tier 0 fires only for a number that is already
this exact phone set's. Tiers 1/2/3 are untouched, so allocation for every other
case is byte-identical to today. Rejected: relaxing tier 1 to the true invariant.
That maximizes reuse but lets one number accumulate unrelated households, so a late
texter has no idea whose number it is - a far wider blast radius than the reported
problem.

**D2 - Tier 0 finds candidates from the BURN SET, not from a conversation scan.**
If a number is this pair's, its permanent `burned_phones` necessarily contains every
roster phone. `provisionForGroup` already holds the driver-filtered `actives` list,
so candidate discovery is an in-memory filter costing ZERO additional reads:

```
candidates = actives.filter(rec => roster.every(p => burnSetOf(rec).has(p)))
```

An earlier revision scanned `listRelayGroups('closed')` instead. That was the wrong
lookup direction and both reviewers killed it: it added up to 20 Queries x 100 FULL
conversation items to EVERY relay open, and it silently and permanently disabled the
feature once an org crossed 2000 closed relay groups (the page budget), signalled only
by a WARN. The burn-set filter has neither property, is strictly more precise, and
removes any dependence on ordering.

**D3 - ONE comparator: the E.164 phone set.** Part A, Part B, and the reopen guard
all compare `memberPhoneSet` values (2.6). Rejected: `relayMemberKey`
(contactId-preferring) for Part B's "same people" test. `groupMembers.ts:30-37` rules
explicitly against it for roster identity - "ALWAYS `phone#<E164>`, NEVER
`relayMemberKey` ... one contact owning TWO member numbers would collapse into a
single slot" - and `rosterEdits.ts:144` and `rosterResolution.ts:326` repeat it. It
would have refused a legitimate "add Alice's second handset" group as a duplicate.

**D4 - Tier-0 eligibility is per-phone and set-based, with no notion of "newest".**
Against ONE `getAllByPoolNumber(N)` snapshot:

- (i) NO group on N with `status !== 'closed'` may have a `memberPhoneSet`
  OVERLAPPING the new roster; AND
- (ii) SOME group on N with `status === 'closed'` must have a `memberPhoneSet`
  EXACTLY EQUAL to the new roster.

(i) is the safety condition - it is what keeps 2.2's invariant. (ii) is Cameron's
product rule: this number is demonstrably this pair's.

An earlier revision instead required the NEWEST closed group on N to match. That was
deleted for two reasons a reviewer proved. It defeated the feature: tier 1's
deliberate multiplexing (2.3) means a mature number's newest closed group is usually
somebody ELSE's pair, so the original pair could never get their number back. And it
was justified by a hazard - a stale wider group reopening beside the new one - that
section 6's reopen guard already closes independently, while contradicting D5's own
per-phone reasoning one paragraph later.

**D5 - A disjoint live group on N does NOT veto.** Multiplexing means a number
legitimately fronts concurrent OPEN groups with disjoint rosters. Only a per-phone
OVERLAP matters, which is exactly what D4(i) tests.

**D6 - Part B enforces on UNOWNED creates only.** A tour thread and a placement
thread for the same tenant and landlord are DIFFERENT subjects with legitimately
identical rosters; so are two tours of two properties from the same landlord.
Refusing those would block real work, and the quiet-hours deferred poller has no UI
to confirm through. Note this is argued on subject identity ALONE - an earlier
revision also leaned on "both owner surfaces hold an atomic one-thread-per-owner
claim", which 2.4 shows is false for placements.

**D7 - The reopen guard is a BEST-EFFORT refusal with no override.** No override,
because overriding would knowingly create 2.2's coin-flip state and the remedy (close
the other group first) is a real available action. Best-effort rather than a hard
fence, because its read is an eventually consistent GSI Query (2.7) and because
`touchLastActivity` (2.5) is a second closed-to-open door that does not pass through
it at all.

**D8 - Part B fails OPEN on an inconclusive scan.** `listRelayGroups` can report
`truncated`; when it does, the create is ALLOWED and a WARN is logged. Part B is an
operator-assist guard, not a safety fence, and blocking an operator because a GSI
walk hit its page budget is worse than missing a duplicate. Part A never reads that
primitive at all (D2), so it has no truncation surface.

**D9 - Part B's scan includes CONNECTING groups.** A connect-when-ready group is a
real pending group; a second group for the same people would buy a SECOND number,
the exact waste this feature exists to stop. A reviewer correctly noted this blocks
the escape hatch for a STUCK connecting group (`poolNumbers.ts:485-499`); the
override is that case's recovery, so the 409 copy names the connecting group and says
so.

**D10 - `reuseClaim` clears the retirement clock.** The sweep's re-verify keys on
OPEN groups (`poolNumbers.ts:397-401`) and tier 0's group does not exist yet when the
claim returns, so a concurrent sweep could release a number tier 0 just took - and
tier 0 targets precisely the long-closed numbers that are release-eligible.
`reuseClaim` therefore REMOVEs `last_group_closed_at` in the same conditional write;
`retireEligible` skips any record whose `closedAt === undefined` (`:378`). This is the
correct semantics regardless of the race: the number is back in service and its clock
restarts when its next group closes.

**D11 - No new pool-record attribute, and no atomicity for the tier-0 claim.** An
`open_phones` string set maintained at every open/close/reopen/add/remove would give a
conditional-write mutex. It is not worth its cost here: under D1 and D4, two racing
tier-0 creates can only produce two open groups with IDENTICAL phone sets, so delivery
reaches the same humans either way - a split transcript, not a wrong-party
disclosure. Section 8 states this in full.

## 4. New shared module: `app/src/services/relayGroupIdentity.ts`

Pure predicates, no I/O, so every caller controls its own reads and snapshots.

```
/** Provenance phone set of a group: ever_member_phones UNION current roster (2.6). */
export function memberPhoneSet(conv: ConversationItem): Set<string>

/** Sorted, de-duplicated E.164 key for exact-set comparison. */
export function phoneSetKey(phones: Iterable<string>): string

/** True when the two sets share at least one phone. */
export function phonesOverlap(a: Set<string>, b: Set<string>): boolean

/**
 * Tier 0 (D4) and the reopen guard, over ONE getAllByPoolNumber snapshot.
 * Returns the first non-closed group on the number whose provenance overlaps
 * `roster`, excluding `selfConversationId`. undefined means no conflict.
 */
export function findLiveMemberConflict(
  groups: ConversationItem[],
  roster: Set<string>,
  selfConversationId?: string,
): ConversationItem | undefined

/** Tier 0 (D4)(ii): some CLOSED group on the number owned exactly this phone set. */
export function hasClosedGroupWithExactPhones(
  groups: ConversationItem[],
  roster: Set<string>,
): boolean
```

Part B's scan is a thin async helper in the same module:

```
/**
 * Part B. Scan the OPEN and CONNECTING relay partitions for a group whose
 * memberPhoneSet equals `roster`. `inconclusive` is true when either partition
 * walk reported `truncated` (D8).
 */
export function findOpenGroupWithSamePhones(
  deps: { conversations: ConversationsRepo; log: Logger },
  roster: Set<string>,
): Promise<{ match?: ConversationItem; inconclusive: boolean }>
```

## 5. Part A - tier 0, same-pair reuse

A new tier 0 runs inside `provisionForGroup` BEFORE tier 1. Everything after it is
unchanged.

```
const roster = new Set(rosterPhones);

// TIER 0 - SAME-PAIR REUSE. Candidates cost ZERO extra reads (D2): `actives` is
// already fetched and already filtered to the current driver, so source isolation
// is preserved unchanged.
for (const rec of actives) {
  if (rec.pending_conversation_id !== undefined) continue;   // earmarked - hands off
  const burn = burnSetOf(rec.burned_phones);
  if (![...roster].every((p) => burn.has(p))) continue;      // not this pair's number

  // ONE snapshot; both predicates are evaluated against it (never two reads).
  const groups = await conversations.getAllByPoolNumber(rec.poolNumber);
  if (findLiveMemberConflict(groups, roster) !== undefined) continue;   // D4(i)
  if (!hasClosedGroupWithExactPhones(groups, roster)) continue;         // D4(ii)

  const claimed = await repo.reuseClaim(rec.poolNumber, rosterPhones, tag);
  if (claimed) {
    await refillBufferIfNeeded();
    log.info(
      { provisioned: false, tier: 0, event: 'relay_number_reused_same_pair' },
      'relay pool number acquired (reused - same pair)',
    );
    return { kind: 'assigned', poolNumber: claimed.poolNumber, record: claimed, provisioned: false };
  }
}
// fall through to TIER 1, unchanged
```

D4(i) uses `status !== 'closed'` rather than `status === 'open'` so a CONNECTING
group and a `touchLastActivity`-re-flagged group (2.5) both veto. Cost: zero reads
when no candidate matches (the overwhelmingly common case), one bounded partition
Query per matching candidate - normally zero or one.

### 5.1 New repo primitive: `reuseClaim`

`app/src/repos/poolNumbersRepo.ts` gains:

```
/**
 * The tier-0 SAME-PAIR claim. Unlike burnClaim, the phones are ALREADY burned here
 * - that is the precondition, not the obstacle - so the ADD is a no-op set union
 * and the CONDITION asserts the opposite of burnClaim's: the number is `active` AND
 * every phone is already in burned_phones. Also REMOVEs last_group_closed_at (D10)
 * so a concurrent retirement sweep cannot release a number just taken back into
 * service. Returns the post-update item, or undefined on condition failure (not
 * active, or any phone not burned here) or an empty roster.
 *
 * NOT a mutex: two concurrent identical reuseClaims can both succeed. Accepted by
 * design (spec D11) - both callers are creating groups with the SAME phone set, so
 * the result is a split transcript, never a wrong-party delivery.
 */
reuseClaim(poolNumber: string, phones: string[], tag?: string):
  Promise<PoolNumberItem | undefined>
```

Mirrors `burnClaim`, condition inverted:

```
UpdateExpression:
  (tag !== undefined ? 'SET placement_tag = :tag ' : '') +
  'REMOVE last_group_closed_at ADD #bp :phones'
ConditionExpression:
  'lifecycle_state = :active AND contains(#bp, :p0) AND contains(#bp, :p1) ...'
ReturnValues: 'ALL_NEW'
```

Empty `phones` returns `undefined` without a write, mirroring `burnClaim`. The
`lifecycle_state = :active` clause preserves the W2 retirement fence exactly as
`burnClaim` does: a number claimed for release is `releasing` and is refused here.

### 5.2 What Part A does NOT change

`burnMember`, `burnGroupRoster`, `noteGroupClosed`, `retireEligible`, the release
fence, and the warm/buffer paths are untouched. Tier 0 never buys, so the kill-switch
posture is unchanged: a tier-0 hit resolves with `relayLiveProvisioning` off exactly
as tiers 1 and 2 do.

### 5.3 One consequence that IS user-visible: the add-member wall

The reused number's `burned_phones` is the union of everyone ever rostered there,
including unrelated multiplexed groups. Adding one of THOSE people to the new group
409s at `burnMember`, with copy that today reads "This person already has a relay
group history on this number. Start a new relay group with them instead."
(`relayMembers.ts:206-212`) - a remedy tier 0 now routes straight back to the same
number.

The 409 copy is therefore reworded in this change to name the real remedy (close the
group and start one with a different set, or remove the conflicting person's other
group). The refusal LOGIC is unchanged. The deeper fix - scoping burn per group
rather than per number - is filed as
`docs/issues/relay-tier0-inherits-burn-wall.md`.

## 6. The reopen guard

Part A makes a previously unreachable sequence reachable: close the `{A,B}` group,
create a new `{A,B}` group that reuses the number, then REOPEN the old one. Because
rosters drift, the two open groups can end up with DIFFERENT rosters, which is the
genuine wrong-party state.

In `app/src/routes/relayGroups.ts`, INSIDE the existing
`if (typeof reopenPool === 'string' && reopenPool.length > 0)` block that opens at
`:495` (so `reopenPool` is narrowed to `string`), after the AF-3 released-number
check and before that block closes at `:511`:

```
const onNumber = await conversations.getAllByPoolNumber(reopenPool);
const conflict = findLiveMemberConflict(
  onNumber, memberPhoneSet(conversation), conversationId,
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

A relay group with NO pool number (closed while `connecting`) is EXEMPT - it sits
outside this narrowing, exactly as AF-3 already exempts it, and it has no number on
which a conflict could exist.

Both the guard and tier 0 compare provenance (2.6), not the live roster. That is what
closes the reviewer-proved evasion: drain a closed group's roster, reopen it past an
emptied-roster check, then re-add the members with no burn claim
(`relayMembers.ts:186-192`, rule 2). Under provenance the drained group still carries
`{A,B}` and the reopen is refused.

This guard is unconditional, so it also protects PRE-EXISTING data: any legacy
invariant violation now fails closed at reopen instead of silently routing.

## 7. Part B - duplicate OPEN group refusal

### 7.1 Service

`app/src/services/relayProvisioning.ts` gains:

```
export class DuplicateOpenRelayGroupError extends Error {
  readonly conversationId: string;
  readonly status: 'open' | 'connecting';
}
```

`ProvisionRelayInput` gains `acknowledgeDuplicate?: boolean` (default false).

At the top of `provisionRelayGroup`, BEFORE `provisionForGroup` and before any
conversation is created - matching how the kill-switch error already precedes every
side effect:

- Skip entirely when `resolvedOwner.type !== null` (D6).
- Otherwise ALWAYS run `findOpenGroupWithSamePhones`. `acknowledgeDuplicate` controls
  only refuse-versus-proceed, never whether the check happens - so an override is
  always audited with the id it overrode.
- `inconclusive` -> log a WARN and proceed (D8).
- Match and NOT acknowledged -> throw `DuplicateOpenRelayGroupError`.
- Match and acknowledged -> log `{ event: 'relay_duplicate_open_group_overridden' }`
  and add `duplicateAcknowledged: true` plus `duplicateOfConversationId` to the
  existing `relay_group_created` audit entry.

### 7.2 Route

`app/src/routes/relayGroups.ts`, `POST /api/relay-groups`: read
`acknowledgeDuplicate` from the body (boolean, default false), pass it through, and
add ONE arm to the EXISTING catch block beside the `RelayProvisioningDisabledError`
arm:

```
if (err instanceof DuplicateOpenRelayGroupError) {
  await audit.append('relay#provisioning', 'relay_duplicate_open_group_refused', {
    actor, conversationId: err.conversationId,
  });
  res.status(409).json({
    error: 'duplicate_open_group',
    conversationId: err.conversationId,
    groupStatus: err.status,
    message: err.status === 'connecting'
      ? 'A relay group with these same people is already being connected. Open it ' +
        'instead, or - if it is stuck - resubmit with acknowledgeDuplicate to create ' +
        'a new one.'
      : 'An open relay group with these same people already exists. Open it instead, ' +
        'or resubmit with acknowledgeDuplicate to create a second one anyway.',
  });
  return;
}
```

`conversationId` and `groupStatus` are NEW response fields, not a mirror of the
existing `pool_number_released` 409 (which carries only `error` and `message`).

### 7.3 Not in this change

The dashboard confirm-dialog wiring. `feat/contact-create-relay-group` is sequenced
first and owns `RosterConfirmDialog.tsx`, `dashboard/src/api/endpoints.ts`, a new
`POST /api/relay-groups/preview`, and `e2e/fixtures/relayConnect.ts`. Filed as
`docs/issues/relay-duplicate-group-dialog-wiring.md`.

### 7.4 Part B ships DORMANT on main, and that is deliberate

There is today no operator path that Part B refuses. `POST /api/relay-groups` is the
test scaffold (2.4) with no dashboard client, and D6 exempts both owner-scoped
surfaces. Part B is enforced in `provisionRelayGroup` precisely because that is the
single choke point EVERY creator funnels through, so it activates automatically the
moment the freehand contact-file create lands - with no rework and no chance of the
new surface forgetting the guard. Ruled by Cameron 2026-08-17 after both reviewers
raised it. Acceptance for this branch is therefore the unit and integration tests,
not an observable dashboard behavior.

## 8. Residual risk, stated plainly

**Concurrent creates.** Two concurrent creates of the same roster can both pass Part
B's read check and both pass tier 0's checks, producing two OPEN groups with
IDENTICAL phone sets on one number. Inbound from a member matches both;
`twilio.ts:1918-1927` logs at ERROR and routes to the newest. Delivery reaches the
same humans either way. The visible harm is a split transcript. Accepted (D11). Note
this is reachable on the placement surface too, whose one-thread guard is
check-then-act (2.4) - and tier 0 makes that pre-existing race land both groups on
the SAME number rather than two different ones.

**Detection is not guaranteed.** That ERROR fires only on inbound SMS. A duplicated
pair whose thread is staff-outbound-only never trips it. Filed as
`docs/issues/relay-duplicate-open-group-not-detected-at-rest.md`.

**Eventual consistency.** Every read here is a GSI Query (2.7). A stale index read
that misses a just-opened group can GRANT a reuse or let a conflicting reopen
through. This does not change the class of outcome - it widens the same window D11
already accepts - but it is why D7 says best-effort.

**`touchLastActivity`.** It reopens a closed relay group with no guard (2.5), so the
reopen fence can be bypassed. Every check in this design keys on the group's
`status`, and a re-flagged group reads as `open`, so it still VETOES tier 0 and still
blocks a conflicting reopen - the design is safe against it, just unable to prevent
it. Left to `docs/issues/inbound-reflags-closed-relay-group.md` by Cameron's ruling.

## 9. Surfaces swept

| Surface | File | Effect |
|---|---|---|
| Standalone create | `routes/relayGroups.ts:278` | Part A via service; Part B enforced; 409 arm added |
| Tour open | `rosterProvision.ts:346` | Part A via service; Part B skipped (D6) |
| Placement open | `rosterProvision.ts:646` | Part A via service; Part B skipped (D6) |
| Quiet-hours deferred open | `jobs/rosterActions.ts` | unchanged - reaches provisioning through rosterProvision; D6 exempts it |
| Connect-when-ready assign | `jobs/relayNumberReady.ts:136` | unchanged - burns onto a fresh warm number; tier 0 skips earmarked records |
| Add member | `relayMembers.ts:193` | logic unchanged; 409 COPY reworded (5.3) |
| Add member, re-add rule 2 | `relayMembers.ts:186-192` | no code change - neutralized by provenance tests (2.6, section 6) |
| Remove member | `relayMembers.ts` | unchanged - removal never touches `ever_member_phones` |
| Roster edits on CLOSED groups | `relayMembers.ts:145-159`, `:309-319` | unchanged - deliberately no longer load-bearing (2.6) |
| Close | `routes/relayGroups.ts:448-474` | unchanged |
| Reopen (PATCH) | `routes/relayGroups.ts:484-527` | NEW member-conflict guard (section 6) |
| Reopen (implicit) | `conversationsRepo.ts:1449-1507` | UNGUARDED, pre-existing, out of scope (2.5, section 8) |
| Retirement sweep | `poolNumbers.ts:358-438` | unchanged; `reuseClaim` clears the clock so the sweep cannot release a just-reused number (D10) |
| Seeds | `lib/seed/matrix.ts:1135` | one relay group, and it is OPEN - no seeded CLOSED group exists, so tier 0 has nothing seeded to match |
| Inbound routing | `webhooks/twilio.ts:1911-1972` | READER, unchanged - already handles many groups per number |
| Voice masked inbound | `webhooks/voice.ts` via `getByPoolNumber` | READER, pre-existing lossy one-group view (`docs/issues/voice-relay-multiplexing-ambiguity.md`). Not widened: `getByPoolNumber` prefers the OPEN match (`conversationsRepo.ts:1782`) and tier 0's groups have identical phone sets |
| Contact relay-groups card | `routes/contacts.ts:1128` | READER, unchanged |
| Pool numbers admin | `routes/poolNumbersAdmin.ts` | READER, unchanged |

## 10. Test plan

Unit (`app/test/`):

- `poolNumbersRepo.test.ts` - `reuseClaim` succeeds when active and all phones
  burned; REMOVEs `last_group_closed_at` (D10); returns undefined when not active,
  when any phone is not burned, and on an empty roster; stamps `placement_tag`.
- `poolNumbers.test.ts` - tier 0 reuses the pair's number; SKIPPED when a live group
  on it overlaps by provenance; SKIPPED when no closed group has the exact set;
  SKIPPED when the record is earmarked, not active, or another driver; NOT skipped
  when a DISJOINT open group is on the number (D5); reuses even when the newest
  closed group on the number belongs to a DIFFERENT pair (the D4 deletion - this is
  the multiplexing case that made the old rule useless); a group whose `participants`
  were drained still vetoes via `ever_member_phones` (2.6); a
  `touchLastActivity`-re-flagged closed group vetoes (2.5). Every existing tier-1/2/3
  test must stay green untouched - that is the regression proof that D1 held.
- `relayGroupIdentity.test.ts` (new) - `memberPhoneSet` unions provenance and roster
  and tolerates both the `Set` and `string[]` shapes and a missing field;
  `findLiveMemberConflict` excludes self, ignores closed groups, catches connecting;
  `hasClosedGroupWithExactPhones` requires exact equality, not superset;
  `findOpenGroupWithSamePhones` matches across OPEN and CONNECTING (D9) and reports
  `inconclusive` on truncation.
- `relayProvisioning.test.ts` - throws for an unowned duplicate; does NOT throw for a
  tour- or placement-owned create with the same roster (D6); with
  `acknowledgeDuplicate` the scan STILL runs and the audit records
  `duplicateAcknowledged` plus the id (AC-6).
- `relayApi.test.ts` - `POST /api/relay-groups` 409 `duplicate_open_group` carrying
  `conversationId` and `groupStatus`; the same POST with `acknowledgeDuplicate: true`
  returns 201; reopen 409 `relay_member_in_open_group` on a provenance conflict;
  reopen still succeeds with no conflict; reopen of a group with NO pool number is
  unaffected.

E2E (`e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts`, extended):

- Create a relay group for a pair, close it, create a second group for the same pair,
  assert the SAME pool number. Use the EXISTING `createGroupOpen` helper from
  `e2e/fixtures/relayConnect.ts` - in the hermetic lane a fresh pair lands CONNECTING
  (twilio driver, K=0, console-tagged seed numbers), and that helper already drives
  the fake's register-number seam. CONSUME IT READ-ONLY: that fixture is on
  `feat/contact-create-relay-group`'s edit list.
- Confirm the existing `relay-number-lifecycle.spec.ts:191-207` overlap proof still
  passes untouched (its first group is OPEN, so tier 0 cannot fire).

## 11. Follow-ups filed

- `docs/issues/relay-duplicate-group-dialog-wiring.md`
- `docs/issues/relay-duplicate-open-group-create-race.md` - section 8, with the
  `open_phones` conditional-write design as the fix if observed.
- `docs/issues/relay-duplicate-open-group-not-detected-at-rest.md`
- `docs/issues/relay-tier0-inherits-burn-wall.md` - 5.3.

NOT filed: a voice-routing issue. `docs/issues/voice-relay-multiplexing-ambiguity.md`
already covers it.

## 12. Out of scope

- Relaxing tier 1 to the true invariant (D1, rejected).
- Any dashboard change (7.3).
- Fixing `touchLastActivity`'s unguarded reopen (2.5) or the placement atomic-claim
  gap (2.4) - both pre-existing, both already filed.
- Changing add-member's burn REFUSAL logic. Its refusal COPY does change (5.3).
- Any infrastructure, schema migration, or backfill. This design adds no attribute
  and no index, so nothing is owed at deploy beyond the normal app release.
