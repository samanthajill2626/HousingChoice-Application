# Warn when an open relay group already exists with the same contacts

Date: 2026-08-17 (r3: 2026-08-18)
Branch: `feat/relay-number-reuse` (the name predates a scope change and is kept
deliberately); worktree `W:\tmp\relay-number-reuse`, synced with `main` @014b93a6.
Revision: r3. Two rounds of adversarial review; r3 then DELETED the layer those
reviews were finding blockers in - see 1.1. Adjudications at
`.superpowers/design-review/adjudications.md`.

## 1. The feature, in one paragraph

When an operator is about to open a relay group whose members are exactly the members
of a relay group that is already live, the confirm dialog says so before they press
the button, names the existing group, and links to it. Then they decide. **The
duplicate is created if they proceed. Nothing is refused and nothing needs
overriding.**

### 1.1 What r3 deleted, and why it is recorded here

r1 and r2 also had the SERVER refuse the create with a 409 that the client would
re-submit with an acknowledgement. That was a misreading of "maybe not outright
refused, but definitely a strong warning": a refusal you then override is a refusal
with extra steps, not a warning.

It is recorded because of what it cost. Every BLOCKING finding across two review
rounds - four of them - lived in that refusal layer and none in the warning:
threading an acknowledgement through a zero-argument closure
(`jobs/rosterActions.ts:131`), a new field on the deferral row that nothing wrote, a
reopen route with no dialog to render a warning in, a retried reopen matching itself,
and worst, an ordering rule that would have run the check AFTER `provisionForGroup`
and so after tier-1/2's irreversible `burnClaim` - permanently burning the roster onto
a pool number hosting no group, and burning a second on retry. Deleting the layer
deletes all of it.

**This spec contains no pool-number work.** `app/src/services/poolNumbers.ts` and
`app/src/repos/poolNumbersRepo.ts` are not modified. See 2.2.

## 2. Verified current behavior

### 2.1 Why a duplicate is harmful - and what it does NOT break

Inbound SMS resolves on `(To, From)` - `app/src/routes/webhooks/twilio.ts:1911-1952`.
A duplicate group necessarily gets a SECOND pool number (2.2), so the two groups sit
on two different numbers. Routing is therefore FULLY DETERMINISTIC: a reply to number
1 resolves to group 1 and a reply to number 2 resolves to group 2, every time. Nothing
is delivered to the wrong party and no invariant is violated. **A duplicate is not a
correctness problem.**

The harm is entirely on the human side:

- The tenant or landlord holds TWO indistinguishable masked numbers for what is, to
  them, ONE relationship. Neither identifies itself. They cannot tell which thread
  staff is watching, and a reply to the stale one is delivered perfectly correctly
  into a thread nobody is reading.
- Staff's history of that relationship is SPLIT across two threads, and outbound goes
  from whichever thread they open - so the recipient sees two senders for one
  conversation.

This is the copy's job to convey, and it is why the feature is a warning: a missed
warning costs somebody a confusing week, not a misdelivered message. An earlier draft
said replies "split between the two threads at random"; that is false and was
corrected by Cameron. Copy that overstates the risk will be disbelieved the first time
an operator checks.

### 2.2 Every duplicate ALREADY gets a new number - verified, do not "fix" it

`provisionForGroup` tier 1 skips any active number whose burn overlaps the new roster
AT ALL (`app/src/services/poolNumbers.ts:539-540`, via `rosterOverlapsBurn` at
`:302-309`, true when ANY roster phone is in the set). Tier 2 (`:556`) only
accepts EMPTY-burn spares. `burned_phones` is permanent and never cleared
(`app/src/repos/poolNumbersRepo.ts:15-21, :100-111`). So once A and B are burned on a
number, no later group containing A or B can land on it - open or closed, same set or
merely overlapping.

The warning does not cause this and does not change it.

### 2.3 The three open paths, all of which preview first

- Standalone: `POST /api/relay-groups/preview` then `POST /api/relay-groups`
  (`app/src/routes/relayGroups.ts`), driven by the contact page's create modal.
- Tour: the preview at `app/src/routes/tours.ts:930`, then the open.
- Placement: the preview at `app/src/routes/placements.ts:1260`, then the open.

Scope is all three (Cameron, 2026-08-17). It was proposed to limit this to the
standalone path on the theory that a tenant and landlord touring two properties
legitimately need two groups; that was rejected. From a tenant's or landlord's side
the CONVERSATION is the item, not the tour - they are talking to a person, and it does
not matter what about.

### 2.4 The preview plumbing (now on `main`)

- `RosterPreview` - `app/src/services/rosterEdits.ts:317`, mirrored client-side at
  `dashboard/src/api/types.ts:1032`.
- `buildOpenPreviewFromParts` - the ONE PURE core both builders funnel through.
- `buildOpenPreview` (owner-scoped: tour + placement) and
  `buildStandaloneOpenPreview` (client list).
- `RosterConfirmDialog.tsx` - rendered by four call sites:
  `CreateRelayGroupModal.tsx:419`, `TourDetail.tsx:746`, `PlacementDetail.tsx:741`,
  and `PeopleCard.tsx:443`. **`PeopleCard` is the ADD-member confirm, not an open** -
  it must NOT render this warning.

`RosterPreview`'s header states the rule this design obeys: previews carry names,
never phones (doc section 9).

### 2.5 Detection primitive

`conversations.listRelayGroups(status)` (`app/src/repos/conversationsRepo.ts:758`)
is a DIRECT Query on the SPARSE `byRelayStatus` GSI - relay groups only, never a Scan.
Returns `{ items, truncated }`; `truncated` means a fixed page budget
(100 x 20 = 2000, `:395-396`) stopped the walk. There is NO index for "group by exact
participant set", so exact-set lookup is this Query plus an in-code comparison. Going
via `GET /api/contacts/:id/relay-groups` would be strictly more work - it walks THREE
partitions to answer a different question.

### 2.6 The importer writes into the connecting partition

`app/src/lib/import/apply.ts:1086, :1129-1130` writes `type: 'relay_group'` with
`relay_status = 'relay_group#connecting'` for imported carrier group threads. Those
are unconverted group texts, not relay groups we provisioned. They carry
`imported_from`, which is NOT a declared field on `ConversationItem` - it rides the
`[key: string]: unknown` index signature, so the check is
`typeof conv['imported_from'] === 'string'`, not a property access.

## 3. Decisions

**D1 - EXACT SET EQUALITY of member phones. Nothing else warns.** `{A,B}` and
`{A,B,C}` are DIFFERENT groups existing for different reasons, and two masked numbers
is the correct outcome there. Same for `{A,B}` and `{A,C}`. The problem of 2.1 exists
only when the SAME set has two live threads. Supersets, subsets and partial overlaps
must NOT warn, or the dialog cries wolf on ordinary operation and operators learn to
click through it. (Ruled by Cameron, 2026-08-17, correcting an earlier draft that
proposed warning on containment.)

**D2 - The compared set is the PROVISIONED phone set** - the deduped, phone-bearing
list provisioning will actually put on the thread (`provisionMembersOf`,
`rosterProvision.ts:106-120`).

**D3 - Compare E.164 PHONES, never `relayMemberKey`.** `groupMembers.ts:32` rules
against the contactId-preferring key for roster identity: one contact owning TWO
numbers would collapse into a single slot. Phones are also what routing keys on.
KNOWN GAP: the same humans on different numbers will not match (section 8).

**D4 - OPEN and CONNECTING both count, except imported rows** (2.6). A connecting
group is a real live thread pending its number.

**D5 - WARNING ONLY. The server does not refuse, and there is nothing to override.**
An operator who proceeds gets their group. A caller that skips the preview and POSTs
directly gets no warning and a created group - accepted: the warning is an aid to a
human about to act, not a gate, and per 2.1 nothing breaks when it is missed. This is
what deletes the four blocking findings of 1.1.

**D6 - Detection FAILS OPEN on both failure modes, and never suppresses a real
match.** A `truncated` walk and a THROWN Query error both yield "no warning" plus a
logged WARN - the standalone preview route is deliberately un-caught, so an
uncaught throw would block the dialog from opening at all. And a match found in one
partition is still reported when the OTHER walk truncates; ordering the short-circuit
the other way would discard a duplicate actually found.

**D7 - Detection runs in the PREVIEW ONLY, one call site per builder.** No check at
create, at reopen, in `validateAction`, or in the quiet-hours poller. r2 had five call
sites; r3 has two, both inside `rosterEdits.ts`.

## 4. New module: `app/src/services/relayGroupDuplicates.ts`

```
/** The existing group a proposed roster duplicates. Names only - NEVER phones. */
export interface DuplicateOpenGroup {
  conversationId: string;
  /** The PARTITION it was found in, not the row's own `status` - those can skew
   *  (section 7). */
  partition: 'open' | 'connecting';
  /** Display names of the existing group's members. A participant with no name
   *  contributes the literal 'Unknown' - never the phone. */
  memberNames: string[];
}

/**
 * Scans the OPEN and CONNECTING relay partitions for a group whose participant
 * phone set equals `phones` EXACTLY (D1). Rows carrying `imported_from` are
 * skipped (D4, via the index signature - 2.6). Never throws: a truncated or
 * failed walk yields `undefined` and a logged WARN (D6).
 *
 * MULTIPLE MATCHES: returns the one with the newest `last_activity_at` and logs
 * the count. Several exact duplicates already means something went wrong; the
 * warning names the liveliest.
 */
export function findOpenGroupWithSamePhones(
  deps: { conversations: Pick<ConversationsRepo, 'listRelayGroups'>; log: Logger },
  phones: Set<string>,
): Promise<DuplicateOpenGroup | undefined>;

/** Exact phone-set equality, exported so tests pin D1 directly. */
export function samePhoneSet(a: Set<string>, b: Set<string>): boolean;
```

Because nothing refuses, the return type is a plain optional - r2's
`{ match?, inconclusive }` existed only so an enforcement path could tell "no
duplicate" from "could not tell". A preview treats both as "say nothing".

## 5. Preview and dialog

`RosterPreview` gains one optional field in BOTH declarations - the server's
(`rosterEdits.ts:317`) and the mirrored client one (`dashboard/src/api/types.ts:1032`):

```
  /** An OPEN or CONNECTING relay group with EXACTLY these members already
   *  exists (D1). Absent when there is none AND when detection could not tell. */
  duplicateOf?: DuplicateOpenGroup;
```

`buildOpenPreviewFromParts` stays PURE: the duplicate is computed by the two async
builders and passed in as a new optional part.

- `buildStandaloneOpenPreview` - its deps already carry the full `ConversationsRepo`.
- `buildOpenPreview` - takes `RosterResolutionDeps`, whose `conversations` is
  `Pick<ConversationsRepo, 'getById'>` (`app/src/lib/rosterResolution.ts:129`). Widen
  it to add `listRelayGroups`. NOTE only two sites use the NAMED type
  (`routes/tours.ts:514`, `routes/placements.ts:921`); the deps are also built INLINE
  and structurally elsewhere, e.g. `jobs/rosterActions.ts:321-323`. The plan must
  enumerate every structural site and every test double supplying a partial
  `conversations` BEFORE widening, or typecheck breaks in places the spec never named.

`RosterConfirmDialog` renders a warning block above the recipient list when
`duplicateOf` is present. **`onConfirm` does not change** - there is no
acknowledgement to carry, which is the single largest simplification r3 buys.
`PeopleCard.tsx:443` passes no `duplicateOf` (2.4).

Copy:

- What exists, by name: "Dana Reed and Marcus Bell already have an open relay group."
  (connecting: "... a relay group being connected.")
- Why it matters, one sentence from 2.1: a second group gets its own masked number, so
  these people will have two numbers for one conversation with no way to tell which
  one staff is watching. NOT "messages may go to the wrong thread" - they will not.
- A link to the existing conversation, styled as the primary action.
- The confirm button keeps its existing label and behavior.

In-dashboard UI text, not automated outbound copy - it does NOT go through the message
catalog.

## 6. Cost

One detector call per PREVIEW. It walks two partitions to exhaustion - up to 20 Queries
x 100 items each, so up to 40 Queries and 4,000 items - and the NO-DUPLICATE case, the
common one, always pays the maximum, because a full walk is what proves absence.

r2 paid this TWICE per open (preview + create); r3 pays it once, on a screen the
operator is already waiting on. Acceptable because relay-group opens are a rare,
human-initiated action on sparse relays-only partitions. Stated because it is not
"one bounded query", and because the performance seed already builds up to 1,000 relay
groups, so the ceiling is reachable in a lane today.

## 7. Surfaces swept

| Surface | File | Effect |
|---|---|---|
| Standalone preview | `routes/relayGroups.ts` (`/relay-groups/preview`) | serves `duplicateOf` |
| Tour preview | `routes/tours.ts:930` | serves `duplicateOf` |
| Placement preview | `routes/placements.ts:1260` | serves `duplicateOf` |
| Standalone / tour / placement CREATE | `relayGroups.ts:301`, `rosterProvision.ts:346`, `:646` | UNCHANGED - nothing refuses (D5) |
| Reopen | `routes/relayGroups.ts:541` | UNCHANGED - known gap, section 8 |
| Quiet-hours deferred open | `jobs/rosterActions.ts` | UNCHANGED - no check, nothing to refuse |
| Apply-now | `routes/tours.ts:872`, `placements.ts:1587` | UNCHANGED |
| Add member | `services/relayMembers.ts`; `PeopleCard.tsx:443` | UNCHANGED, and the ADD dialog must not render this warning (2.4) |
| Remove member | `services/relayMembers.ts` | UNCHANGED - known gap, section 8 |
| Connect-when-ready open | `jobs/relayNumberReady.ts` | UNCHANGED - opens a group that already exists |
| Seeds | `lib/seed/{cast,lean,live,matrix,performance}.ts` | WRITERS into both scanned partitions, carrying no `imported_from`; read like any other row, since a seeded duplicate SHOULD warn. `performance.ts` builds up to 1,000 groups (section 6) |
| Importer | `lib/import/apply.ts:1086, :1129-1130` | WRITER into the connecting partition; skipped via `imported_from` (D4) |
| Pool numbers | `services/poolNumbers.ts`, `repos/poolNumbersRepo.ts` | UNCHANGED, deliberately (1.1, 2.2) |

Reader caveat: `touchLastActivity` (`conversationsRepo.ts:1476`) writes
`status = 'open'` onto any non-`group_text` thread, leaving a re-flagged closed group
at `status: 'open'` with `relay_status: 'relay_group#closed'`. Detection scans by
`relay_status`, so such a group is invisible to it. Pre-existing
(`docs/issues/inbound-reflags-closed-relay-group.md`), it only weakens an advisory
warning that already fails open, and it is out of scope. It is why
`DuplicateOpenGroup.partition` records the partition scanned, not the row's `status`.

## 8. Known gaps, to be filed as issues during the build

None of these exist as files yet; they are written as part of the build.

- `relay-single-live-conversation-per-pair.md` - the larger product question: route new
  context INTO the existing group rather than warn about a second. Deliberately not
  built.
- `relay-duplicate-via-reopen.md` - reopening a closed `{A,B}` beside a live `{A,B}`
  creates the duplicate state with no warning, because reopen has no preview and no
  dialog. Warning there means giving that route a confirm flow it has never had.
- `relay-duplicate-via-roster-removal.md` - removing C from a live `{A,B,C}` beside a
  live `{A,B}` lands on an existing set without creating anything. Wants different copy
  and probably a merge, not a warning.
- `relay-duplicate-across-contact-handsets.md` - D3's gap.
- `relay-duplicate-detection-scan-cost.md` - section 6; the answer if it becomes hot is
  an index on a participant-set hash, which is schema work excluded here.

## 9. Test plan

Unit (`app/test/`):

- `relayGroupDuplicates.test.ts` (new) - THE PRODUCT RULE, pinned explicitly: `{A,B}`
  matches `{A,B}`; `{A,B}` does NOT match `{A,B,C}`; `{A,B,C}` does NOT match `{A,B}`;
  `{A,B}` does NOT match `{A,C}` (D1 - these three negatives ARE the rule).
  Order-independent. Matches across OPEN and CONNECTING (D4). SKIPS a connecting row
  carrying `imported_from` (fixture: the lean seed's only connecting row carries it,
  `lib/seed/lean.ts:263` - which is also the one exception to the table's "seeds carry
  no `imported_from`"). Returns undefined and does NOT throw on a truncated walk and on
  a thrown Query (D6). A match in OPEN survives a truncated CONNECTING walk. Multiple
  matches return the newest.
- Preview tests - `duplicateOf` present/absent on both builders; absent when detection
  fails; the serialized payload contains NO phone numbers (assert on the JSON, not the
  object).

Dashboard:

- `RosterConfirmDialog.test.tsx` - the warning renders with names and a link when
  `duplicateOf` is present, absent otherwise; `onConfirm` is called with its existing
  signature either way.
- The ADD path (`PeopleCard`) never renders it.

E2E (`e2e/tests/dashboard-next/`):

- Open a group for a pair, start a second for the SAME pair, assert the dialog warns
  and names the first, proceed, and assert the second IS created on a DIFFERENT pool
  number - which pins both D5 (nothing is refused) and 2.2 (the allocation behavior
  this feature deliberately does not change).
- Start a group for the same pair PLUS a third person and assert NO warning renders -
  D1's negative case. Without it, a regression to containment-matching passes silently.

## 10. Out of scope

- Any pool-number change (1.1, 2.2).
- Any server-side refusal, acknowledgement, or override (D5).
- Warning on supersets, subsets, or partial overlaps (D1).
- Reopen, roster removal, and routing context into an existing group (section 8).
- Any infrastructure, schema migration, or backfill. No table, no index, no new
  persisted field - `duplicateOf` is computed per request and never stored.
