# Warn when an open relay group already exists with the same contacts

Date: 2026-08-17
Branch: `feat/relay-number-reuse` (worktree `W:\tmp\relay-number-reuse`; the branch
name predates a change of scope and is kept deliberately)
Status: design only. The BUILD is held until `feat/contact-create-relay-group` merges
to `main` - see section 11.

## 1. What this is, and what it is not

When an operator is about to open a relay group whose members are exactly the members
of a relay group that is ALREADY live, warn them loudly in the confirm dialog before
it happens, with a link to the group that already exists and a deliberate override if
they mean it.

**This spec contains no pool-number work.** An earlier version of this feature
proposed relaxing pool-number allocation so a repeat pair could reuse their old
number. That is cancelled. The allocation behavior we want - every duplicate gets a
completely new number - is already what the code does, and section 2.2 verifies it.
`app/src/services/poolNumbers.ts` and `app/src/repos/poolNumbersRepo.ts` are not
modified by this change.

## 2. Verified current behavior

### 2.1 Why a duplicate is harmful - and what it does NOT break

State the routing correctly first, because the warning copy is built from it and an
overstated version of this was the first draft's error.

Inbound SMS resolves on `(To, From)` - `app/src/routes/webhooks/twilio.ts:1911-1952`.
A duplicate group necessarily gets a SECOND pool number (2.2), so the two groups sit
on two different numbers. Routing is therefore FULLY DETERMINISTIC: a reply sent to
number 1 resolves to group 1 and a reply to number 2 resolves to group 2, every time.
Nothing is delivered to the wrong party, nothing lands in an arbitrary thread, and no
invariant is violated. **A duplicate is not a correctness problem.**

The harm is entirely on the human side:

- The tenant or landlord now holds TWO indistinguishable masked numbers for what is,
  to them, ONE relationship. Neither number identifies itself; both are just "the
  number I text about this". They have no way to tell which thread staff is actually
  watching, and a reply to the stale one is delivered perfectly correctly into a
  thread nobody is reading.
- Staff's history of that relationship is SPLIT across two threads, and outbound goes
  from whichever thread they happen to open - so the recipient sees two different
  senders for one conversation.

That is what the warning copy has to convey, and it is the whole justification for
the feature. "A group with these people already exists" states a fact without saying
why the operator should care.

It is also why D5 warns rather than refuses and why D7 fails open: a missed detection
costs somebody a confusing week, not a misdelivered message. A design that treated
this as a safety fence would be mis-priced.

### 2.2 Every duplicate ALREADY gets a new number - verified, do not "fix" it

`provisionForGroup`'s tier 1 skips any active number whose burn overlaps the new
roster AT ALL:

```
app/src/services/poolNumbers.ts:539-540
  if (!hasBurn(candidate.burned_phones)) continue;   // empty-burn spares are tier 2
  if (rosterOverlapsBurn(rosterPhones, candidate.burned_phones)) continue;
```

and `rosterOverlapsBurn` (`:302-309`) is true when ANY roster phone is in the set.
Tier 2 (`:555-557`) only accepts EMPTY-burn spares. `burned_phones` is permanent and
never cleared (`app/src/repos/poolNumbersRepo.ts:15-21, :108-111`).

So once A and B are burned on a number, no later group containing A or B can ever land
on it - open or closed, same set or merely overlapping. A duplicate is guaranteed a
different number. No change is needed and none is made.

### 2.3 The three open paths, and the one choke point

Scope is ALL THREE (Cameron, 2026-08-17): the standalone create
(`POST /api/relay-groups`, `app/src/routes/relayGroups.ts:278`), the tour open
(`POST /api/tours/:tourId/relay` -> `openTourGroup`,
`app/src/services/rosterProvision.ts:346`), and the placement open
(`POST /api/placements/:placementId/relay` -> `openPlacementGroup`, `:646`).

All three funnel through `provisionRelayGroup`
(`app/src/services/relayProvisioning.ts:69`). That single function is where
enforcement goes (section 7).

### 2.4 The preview plumbing this rides on (from the dependency branch)

`feat/contact-create-relay-group` introduces the shared core all three previews funnel
through. Read from that branch:

- `RosterPreview` (`app/src/services/rosterEdits.ts:317-328`): `body`, `recipients`,
  `recipientCount`, `deferred`, `quietEndsAt?`. Small, server-composed, and its
  header states the rule this design must obey - **previews carry names, never phones**
  (doc section 9).
- `buildOpenPreviewFromParts(parts, quiet)` (`:405`) - PURE, no I/O.
- `buildOpenPreview(deps, owner, quiet)` (`:433`) - the OWNER-scoped preview, used by
  the tour route (`routes/tours.ts:930`) and the placement route
  (`routes/placements.ts:1260`). It resolves the roster server-side and computes the
  deduped, phone-bearing `provisioned` list internally.
- `buildStandaloneOpenPreview(deps, members, quiet)` (`:497`) - the client-list
  preview behind the new `POST /api/relay-groups/preview`
  (`routes/relayGroups.ts:264-297`). Its deps already carry the full
  `ConversationsRepo`.
- `RosterConfirmDialog.tsx` - the one dialog all three surfaces render.

### 2.5 Detection primitive

`conversations.listRelayGroups(status)` (`app/src/repos/conversationsRepo.ts:731-733`)
is a DIRECT Query on the SPARSE `byRelayStatus` GSI - one partition per status, relay
groups only, never a Scan. It returns `{ items, truncated }`, where `truncated` means a
fixed page budget (`RELAY_LIST_PAGE_LIMIT` 100 x `RELAY_LIST_MAX_PAGES` 20 = 2000,
`:384-385`) stopped the walk, and the contract says the caller MUST surface that.

There is NO index for "group by exact participant set" - rosters live in the
un-indexed `participants` list - so exact-set lookup is this Query plus an in-code
comparison. This is the same primitive `GET /api/contacts/:id/relay-groups`
(`routes/contacts.ts:1128-1184`) uses, and reading it directly is strictly cheaper
than routing through that endpoint, which walks THREE partitions to answer a
different question.

### 2.6 The importer writes rows into the connecting partition

`app/src/lib/import/apply.ts:1086, :1129-1130` writes `type: 'relay_group'` with
`relay_status = 'relay_group#connecting'` for imported carrier group threads, and the
comment at `:1146-1154` documents that row shape deliberately. Those are unconverted
group texts, not relay groups we provisioned. They carry `imported_from`.

## 3. Decisions

**D1 - The match is EXACT SET EQUALITY of member phones. Nothing else warns.**
`{A,B}` and `{A,B,C}` are DIFFERENT groups, existing for different reasons, and two
masked numbers is the correct outcome there - the second conversation genuinely has a
third party in it, so a reply to either number has an unambiguous destination. Same
for `{A,B}` and `{A,C}`. The ambiguity of 2.1 exists only when the SAME set has two
live threads, because then nothing distinguishes which thread a reply belongs to.
Supersets, subsets, and partial overlaps are NOT warned about and must not be, or the
dialog cries wolf on ordinary operation. (Ruled by Cameron, 2026-08-17, correcting an
earlier draft of this spec that proposed warning on containment.)

**D2 - The compared set is the PROVISIONED phone set.** That is the deduped,
phone-bearing member list provisioning will actually put on the thread - the same
filter `provisionMembersOf` (`rosterProvision.ts:106-120`) and the standalone create
route both apply. Comparing anything else would warn about a group different from the
one that is about to exist.

**D3 - Compare E.164 PHONES, never `relayMemberKey`.** `groupMembers.ts:30-37` rules
explicitly against the contactId-preferring key for roster identity: "ALWAYS
`phone#<E164>`, NEVER `relayMemberKey` ... one contact owning TWO member numbers would
collapse into a single slot", and `rosterEdits.ts:144` and `rosterResolution.ts:326`
repeat it. Phones are also what routing keys on, which is what makes the duplicate
harmful in the first place.

KNOWN LIMITATION, deliberate: the same two humans reached on DIFFERENT numbers (Alice's
work phone in one group, her cell in the other) will not match, so that duplicate is
not warned about. Detecting it needs contact-level identity, which is exactly the
collapse D3 refuses. Filed as `docs/issues/relay-duplicate-across-contact-handsets.md`.

**D4 - OPEN and CONNECTING both count as "already exists", except imported rows.** A
connect-when-ready group is a real live thread pending its number, and a second one
would buy a second number - the precise harm of 2.1. Imported rows (2.6) are skipped:
they are unconverted carrier group texts, and warning "an open relay group already
exists" about one would be false in every clause.

**D5 - Warn, do not refuse; the override is explicit.** Cameron's lean, and correct:
the check is a heuristic about operator intent, and there are legitimate reasons to
want a second thread that the server cannot see. The dialog names the existing group,
links to it, and turns its confirm button into a deliberate "Create anyway". The
server enforces the SAME rule and requires `acknowledgeDuplicate: true` to proceed,
so the warning cannot be lost by a surface that forgets to render it.

**D6 - Enforcement lives in `provisionRelayGroup`, not in the routes.** It is the
single function all three paths funnel through (2.3), so all three are covered by one
check and a fourth creation surface added later inherits it automatically.

**D7 - Detection FAILS OPEN.** `listRelayGroups` can report `truncated`; when it does,
the result is `inconclusive`, no warning renders, and the create proceeds with a WARN
logged. Blocking an operator because a GSI walk hit its page budget is worse than
missing a duplicate. This is an operator-assist guard, not a safety fence - nothing
routes incorrectly if it misses.

**D8 - A quiet-hours DEFERRED open that has become a duplicate is SKIPPED, not
forced.** The poller (`jobs/rosterActions.ts`) applies a confirmed open hours later,
with no operator present to acknowledge anything. It runs the same check and, on a
match, skips with a new `duplicate_open_group` reason that the roster-actions card
already surfaces. Rejected: carrying the operator's acknowledgement forward on the
pending row. It would need a new field on `PendingRosterActionItem`
(`repos/pendingRosterActionsRepo.ts:98-120`), and the quiet-hours window is long
enough that "they said yes hours ago" is weak evidence they still mean it. The cost is
that a deliberately-duplicated deferred open must be re-confirmed; the skip is
visible, not silent. FLAGGED FOR CAMERON - this is the one place D5's "warn, do not
refuse" becomes a refusal, and it is a product call.

## 4. New module: `app/src/services/relayGroupDuplicates.ts`

```
/** The existing group a proposed roster duplicates. Names only - NEVER phones
 *  (doc section 9: previews carry names, never phones). */
export interface DuplicateOpenGroup {
  conversationId: string;
  /** 'open' | 'connecting' - the PARTITION it was found in, not the row's own
   *  `status` field; those can skew (see section 9). */
  partition: 'open' | 'connecting';
  /** Display names of the existing group's members, for the warning copy. */
  memberNames: string[];
}

/**
 * The ONE detector. Scans the OPEN and CONNECTING relay partitions for a group
 * whose participant phone set equals `phones` EXACTLY (D1). Rows carrying
 * `imported_from` are skipped (D4). `inconclusive` is true when either partition
 * walk reported `truncated` (D7) - callers must then neither warn nor refuse.
 */
export function findOpenGroupWithSamePhones(
  deps: { conversations: Pick<ConversationsRepo, 'listRelayGroups'>; log: Logger },
  phones: Set<string>,
): Promise<{ match?: DuplicateOpenGroup; inconclusive: boolean }>;

/** Exact phone-set equality helper, exported so the tests can pin D1 directly. */
export function samePhoneSet(a: Set<string>, b: Set<string>): boolean;
```

`excludeConversationId` is NOT a parameter: every caller is about to CREATE a group,
so there is no self to exclude.

## 5. Preview - where the warning is composed

`RosterPreview` gains one optional field:

```
  /** An OPEN or CONNECTING relay group with EXACTLY these members already
   *  exists (D1). Absent when there is none, and also absent when detection was
   *  inconclusive (D7) - the dialog cannot distinguish those, by design. */
  duplicateOf?: DuplicateOpenGroup;
```

`buildOpenPreviewFromParts` stays PURE: the duplicate is computed by the two async
builders and passed in as a new optional part, which the core copies onto the result.

- `buildStandaloneOpenPreview` - its deps already carry the full `ConversationsRepo`,
  and it already computes the deduped list. One call, no signature change.
- `buildOpenPreview` - its deps are `RosterResolutionDeps`, whose `conversations` is
  narrowed to `Pick<ConversationsRepo, 'getById'>`
  (`app/src/lib/rosterResolution.ts:129`). Widen that to
  `Pick<ConversationsRepo, 'getById' | 'listRelayGroups'>`. Cheap: `rosterDeps` is
  constructed in exactly TWO places in `app/src`, both from the router's real repo
  (`routes/tours.ts:514`, `routes/placements.ts:921`). Test doubles that supply a
  partial `conversations` need `listRelayGroups` added - the plan enumerates them.

All three preview routes then serve `duplicateOf` with no route-level change:
`POST /api/relay-groups/preview`, `routes/tours.ts:930`, `routes/placements.ts:1260`.

## 6. Dashboard

`RosterConfirmDialog.tsx` renders a prominent warning block when `duplicateOf` is
present, ABOVE the recipient list:

- What already exists, by name: "Dana Reed and Marcus Bell already have an open relay
  group." (Connecting: "... already have a relay group being connected.")
- Why it matters, in one sentence carrying 2.1: a second group gets its own masked
  number, so these people will have two numbers for one conversation with no way to
  tell which one staff is watching. NOT "messages may go to the wrong thread" - they
  will not, and copy that overstates the risk will be disbelieved the first time an
  operator checks (2.1).
- A link to the existing conversation.
- The confirm button becomes "Create anyway"; the dialog's primary action visually
  de-emphasises relative to the link.

This is in-dashboard UI text, not automated outbound copy, so it does NOT go through
the message catalog.

The submit sends `acknowledgeDuplicate: true` whenever `duplicateOf` was rendered.

## 7. Enforcement

`app/src/services/relayProvisioning.ts` gains:

```
export class DuplicateOpenRelayGroupError extends Error {
  readonly duplicate: DuplicateOpenGroup;
}
```

`ProvisionRelayInput` gains `acknowledgeDuplicate?: boolean` (default false). At the
top of `provisionRelayGroup`, BEFORE `provisionForGroup` and before any conversation
is created - the position the kill-switch refusal already occupies, so no partial
state can exist:

- Run `findOpenGroupWithSamePhones` over `members`' phones ALWAYS (never skipped by the
  acknowledgement, so an override is always audited with the id it overrode).
- `inconclusive` -> log WARN, proceed (D7).
- match and NOT acknowledged -> throw.
- match and acknowledged -> log `relay_duplicate_open_group_overridden` and record
  `duplicateAcknowledged: true` plus `duplicateOfConversationId` on the existing
  `relay_group_created` audit entry.

Route mapping, one arm each, beside the existing `RelayProvisioningDisabledError` arm:

- `routes/relayGroups.ts:282` catch -> 409 `{ error: 'duplicate_open_group',
  conversationId, message }`, audited as `relay_duplicate_open_group_refused`.
- `rosterProvision.ts` `openTourGroup` (`:361`) and `openPlacementGroup` -> the same
  409 in their existing `{ ok:false, refusal:{ status, body } }` shape, which the tour
  and placement routes already render verbatim. NOTE both must add the arm INSIDE the
  existing catch, AFTER the claim release (`releaseGroupThreadClaim`), or a refused
  tour open strands its `groupThreadId` sentinel - the failure mode
  `docs/issues/relay-provisioning-sentinel-leak.md` already records.
- `openTourGroup` / `openPlacementGroup` gain `acknowledgeDuplicate` on their `opts`,
  threaded from the route bodies.
- `jobs/rosterActions.ts` maps the refusal to the new `duplicate_open_group` skip
  reason (D8) - it never sets `acknowledgeDuplicate`.

## 8. Cost

One extra bounded Query per relay-group preview and one per relay-group open, on a
relays-only sparse GSI partition. Group opens are a rare, human-initiated action.
Nothing is added to any message, webhook, or job hot path.

## 9. Surfaces swept

| Surface | File | Effect |
|---|---|---|
| Standalone preview | `routes/relayGroups.ts:264-297` (dep branch) | serves `duplicateOf` via `buildStandaloneOpenPreview` |
| Tour preview | `routes/tours.ts:930` | serves `duplicateOf` via `buildOpenPreview` |
| Placement preview | `routes/placements.ts:1260` | serves `duplicateOf` via `buildOpenPreview` |
| Standalone create | `routes/relayGroups.ts:278` | enforced; 409 arm added |
| Tour open | `rosterProvision.ts:346` | enforced; refusal arm added inside the existing catch, after the claim release |
| Placement open | `rosterProvision.ts:646` | enforced; refusal arm added |
| Quiet-hours deferred open | `jobs/rosterActions.ts` | new `duplicate_open_group` skip reason (D8) |
| Connect-when-ready open | `jobs/relayNumberReady.ts` | UNCHANGED - it opens a group that already exists; there is nothing to duplicate |
| Reopen | `routes/relayGroups.ts:484-527` | UNCHANGED - reopening creates no group and no number. The burn rule (2.2) means no other group sharing a member can be on that number, so reopening cannot create the 2.1 ambiguity |
| Add member | `services/relayMembers.ts` | UNCHANGED - an add changes a set, it does not create a second thread for the same set |
| Importer | `lib/import/apply.ts:1086, :1129-1130` | WRITER into the connecting partition; skipped by `imported_from` (D4) |
| Pool numbers | `services/poolNumbers.ts`, `repos/poolNumbersRepo.ts` | UNCHANGED, deliberately (section 1, 2.2) |
| Contact relay-groups card | `routes/contacts.ts:1128` | READER, unchanged |

One reader-level caveat worth stating: `touchLastActivity`
(`conversationsRepo.ts:1449-1507`) writes `status = 'open'` onto any non-`group_text`
thread, leaving a re-flagged closed group at `status: 'open'` with
`relay_status: 'relay_group#closed'`. Detection scans by `relay_status`, so such a
group is invisible to it and a duplicate of one would not be warned about. That is a
pre-existing bug (`docs/issues/inbound-reflags-closed-relay-group.md`), it only
weakens an advisory warning that already fails open (D7), and it is out of scope here.
It is why `DuplicateOpenGroup.partition` records the partition scanned rather than the
row's own `status`.

## 10. Test plan

Unit (`app/test/`):

- `relayGroupDuplicates.test.ts` (new) - exact equality only: `{A,B}` matches `{A,B}`;
  `{A,B}` does NOT match `{A,B,C}`, `{A,B,C}` does NOT match `{A,B}`, `{A,B}` does NOT
  match `{A,C}` (D1 - these three are the spec's whole product rule, pin them
  explicitly); order-independent; matches across OPEN and CONNECTING (D4); SKIPS a
  connecting row carrying `imported_from` (fixture ready - the lean seed's only
  connecting row carries it, `lib/seed/lean.ts:262`); reports `inconclusive` when
  either walk reports `truncated`, and reports NO match in that case.
- `rosterEdits.test.ts` / `relayGroupPreview.test.ts` - `duplicateOf` present on the
  standalone and owner previews when a duplicate exists, absent when none does, absent
  when inconclusive; the preview payload contains NO phone numbers (doc section 9 -
  assert on the serialized JSON, not on the object).
- `relayProvisioning.test.ts` - throws for a duplicate on ALL THREE owner shapes
  (unowned, tour, placement - D6 is the point, so an owner-scoped test is not
  optional); proceeds with `acknowledgeDuplicate`, and the scan still runs so the audit
  records `duplicateAcknowledged` and the id; proceeds when inconclusive.
- `relayApi.test.ts` - `POST /api/relay-groups` 409 `duplicate_open_group`; the same
  POST with `acknowledgeDuplicate: true` returns 201.
- Tour and placement route tests - the 409 renders, AND the `groupThreadId` claim is
  RELEASED on the refusal (the sentinel-leak regression).
- `rosterActions` job test - a deferred open whose roster became a duplicate is skipped
  with `duplicate_open_group`, not applied (D8).

Dashboard (`dashboard/src/`):

- `RosterConfirmDialog.test.tsx` - the warning block renders with the existing group's
  member names and a link when `duplicateOf` is present; absent otherwise; confirm
  reads "Create anyway" and submits `acknowledgeDuplicate: true`.

E2E (`e2e/tests/dashboard-next/`):

- Open a relay group for a pair, then start a second one for the SAME pair and assert
  the dialog shows the duplicate warning naming the first group; override and assert
  the second group is created with a DIFFERENT pool number (which also pins 2.2 - the
  behavior this feature deliberately does not change).
- Start a group for the same pair PLUS a third person and assert NO warning renders
  (D1's negative case; without it a regression to containment-matching would pass).

## 11. Sequencing and coordination

The BUILD is held until `feat/contact-create-relay-group` merges to `main`. That
branch is fully built and unmerged (25 files, ~3,600 insertions) and owns
`rosterEdits.ts`, `routes/relayGroups.ts`, `RosterConfirmDialog.tsx`,
`dashboard/src/api/endpoints.ts`, and `dashboard/src/api/types.ts` - every one of
which this change also touches. Building alongside it means conflicts in all five.
Confirmed with Cameron 2026-08-17: design now, merge that branch, then rebase this
onto the merged `main` and build.

Never edit `W:\tmp\contact-create-relay-group`.

Files this change touches that are NOT on that branch, and so carry no conflict risk:
`services/relayProvisioning.ts`, `services/rosterProvision.ts`, `lib/rosterResolution.ts`,
`routes/tours.ts`, `routes/placements.ts`, `jobs/rosterActions.ts`, and the new
`services/relayGroupDuplicates.ts`.

## 12. Follow-ups filed

- `docs/issues/relay-single-live-conversation-per-pair.md` - the larger product
  question: if a pair should only ever have one live conversation, the eventual right
  behavior is to route new context INTO the existing group rather than warn about a
  second one. Deliberately NOT built here.
- `docs/issues/relay-duplicate-across-contact-handsets.md` - D3's limitation.

## 13. Out of scope

- Any pool-number change (section 1, 2.2).
- Warning on supersets, subsets, or partial overlaps (D1).
- Routing new context into an existing group (section 12).
- Fixing `touchLastActivity`'s unguarded reopen (section 9) - pre-existing, filed.
- Any infrastructure, schema migration, or backfill. This design adds no table, no
  index, and no persisted field, so nothing is owed at deploy beyond the app release.
