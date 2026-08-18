# Warn when an open relay group already exists with the same contacts

Date: 2026-08-17
Branch: `feat/relay-number-reuse` (worktree `W:\tmp\relay-number-reuse`; the branch
name predates a change of scope and is kept deliberately)
Revision: r2, after two independent adversarial reviews (37 findings, 13 found by
both). Adjudications at `.superpowers/design-review/adjudications.md`.
Status: design only. The BUILD is held until `feat/contact-create-relay-group` merges
to `main` - see section 12.

## 1. What this is, and what it is not

When an operator is about to open a relay group whose members are exactly the members
of a relay group that is ALREADY live, warn them in the confirm dialog before it
happens, with a link to the group that already exists and a deliberate override if
they mean it.

**This spec contains no pool-number work.** An earlier version proposed relaxing
pool-number allocation so a repeat pair could reuse their old number. That is
cancelled. The allocation behavior we want - every duplicate gets a completely new
number - is already what the code does, and 2.2 verifies it.
`app/src/services/poolNumbers.ts` and `app/src/repos/poolNumbersRepo.ts` are not
modified.

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

- The tenant or landlord holds TWO indistinguishable masked numbers for what is, to
  them, ONE relationship. Neither number identifies itself. They cannot tell which
  thread staff is watching, and a reply to the stale one is delivered perfectly
  correctly into a thread nobody is reading.
- Staff's history of that relationship is SPLIT across two threads, and outbound goes
  from whichever thread they open - so the recipient sees two senders for one
  conversation.

That is what the warning copy must convey, and it is the whole justification for the
feature. It is also why D5 warns rather than refuses, why D7 fails open, and why D9
accepts a race: a missed detection costs somebody a confusing week, not a misdelivered
message. A design that treated this as a safety fence would be mis-priced, and would
justify machinery (conditional writes, claims) that the harm does not earn.

### 2.2 Every duplicate ALREADY gets a new number - verified, do not "fix" it

`provisionForGroup` tier 1 skips any active number whose burn overlaps the new roster
AT ALL (`app/src/services/poolNumbers.ts:539-540`, via `rosterOverlapsBurn` at
`:302-309`, true when ANY roster phone is in the set). Tier 2 (`:555-557`) only
accepts EMPTY-burn spares. `burned_phones` is permanent
(`app/src/repos/poolNumbersRepo.ts:15-21, :108-111`). So once A and B are burned on a
number, no later group containing A or B can land on it. A duplicate is guaranteed a
different number.

### 2.3 The creation surfaces

- Standalone create: `POST /api/relay-groups`, `app/src/routes/relayGroups.ts:278`.
- Tour open: `openTourGroup`, `app/src/services/rosterProvision.ts:346`. Holds an
  ATOMIC one-thread-per-tour claim first (`tours.claimGroupThread`, `:333-341`).
- Placement open: `openPlacementGroup`, `:646`. Its one-thread guard is a plain
  read-then-refuse (`:601-610`), NOT a claim - `docs/issues/placement-relay-no-atomic-claim.md`.
  There is no placement claim to release on a refusal.
- Deferred (quiet-hours) open: `app/src/jobs/rosterActions.ts`, the poller applying a
  confirmed open at quiet-end.

The first three funnel through `provisionRelayGroup`
(`app/src/services/relayProvisioning.ts:69`). The deferred path reaches it too, but
its refusal handling is structurally different - see D6.

### 2.4 The preview plumbing

Already on `main`: `RosterPreview` (`app/src/services/rosterEdits.ts:312`),
`buildOpenPreview` (`:371`, the OWNER-scoped preview used by `routes/tours.ts:930`
and `routes/placements.ts:1260`), and the mirrored client-side `RosterPreview`
(`dashboard/src/api/types.ts:1019`).

Added by `feat/contact-create-relay-group`: `buildOpenPreviewFromParts` (the
extracted PURE core both builders funnel through), `buildStandaloneOpenPreview`,
`POST /api/relay-groups/preview` (`routes/relayGroups.ts:264-297`), and an
`allowDefer` prop on `RosterConfirmDialog`.

`RosterPreview`'s header states the rule this design must obey: **previews carry
names, never phones** (doc section 9).

### 2.5 Detection primitive

`conversations.listRelayGroups(status)` (`app/src/repos/conversationsRepo.ts:731-733`)
is a DIRECT Query on the SPARSE `byRelayStatus` GSI - relay groups only, never a Scan.
It returns `{ items, truncated }`; `truncated` means a fixed page budget
(`RELAY_LIST_PAGE_LIMIT` 100 x `RELAY_LIST_MAX_PAGES` 20 = 2000, `:384-385`) stopped
the walk. There is NO index for "group by exact participant set", so exact-set lookup
is this Query plus an in-code comparison.

### 2.6 The importer writes into the connecting partition

`app/src/lib/import/apply.ts:1086, :1129-1130` writes `type: 'relay_group'` with
`relay_status = 'relay_group#connecting'` for imported carrier group threads (the
comment at `:1146-1154` documents the shape deliberately). Those are unconverted group
texts, not relay groups we provisioned. They carry `imported_from`, which is NOT a
declared field on `ConversationItem` - it is read through the item's
`[key: string]: unknown` index signature, so the check must be written
`typeof conv['imported_from'] === 'string'` rather than a property access.

## 3. Decisions

**D1 - The match is EXACT SET EQUALITY of member phones. Nothing else warns.**
`{A,B}` and `{A,B,C}` are DIFFERENT groups existing for different reasons, and two
masked numbers is the correct outcome there. Same for `{A,B}` and `{A,C}`. The problem
of 2.1 - two indistinguishable numbers for ONE relationship - exists only when the
SAME set has two live threads. Supersets, subsets and partial overlaps must NOT warn,
or the dialog cries wolf on ordinary operation and operators learn to click through
it. (Ruled by Cameron, 2026-08-17, correcting an earlier draft that proposed warning
on containment.)

**D2 - The compared set is the PROVISIONED phone set** - the deduped, phone-bearing
list provisioning will actually put on the thread, the same filter
`provisionMembersOf` (`rosterProvision.ts:106-120`) and the standalone create route
apply.

**D3 - Compare E.164 PHONES, never `relayMemberKey`.** `groupMembers.ts:30-37` rules
explicitly against the contactId-preferring key for roster identity: "ALWAYS
`phone#<E164>`, NEVER `relayMemberKey` ... one contact owning TWO member numbers would
collapse into a single slot". Phones are also what routing keys on.

KNOWN GAP, deliberate: the same two humans on DIFFERENT numbers will not match. To
file as `docs/issues/relay-duplicate-across-contact-handsets.md`.

**D4 - OPEN and CONNECTING both count, except imported rows** (2.6). A connecting
group is a real live thread pending its number; a second one buys a second number.

**D5 - Warn, do not refuse; the override is explicit; the server applies the same
check on a BEST-EFFORT basis.** The dialog names the existing group, links to it, and
its confirm becomes a deliberate "Create anyway". The server applies the same check so
the warning cannot be lost by a surface that forgets to render it.

It is a CHECK, not a guarantee. Detection is a read over an eventually consistent GSI
with no conditional write and no claim, so two simultaneous opens can both pass. That
is accepted, not overlooked: per 2.1 the outcome is a duplicate - the very thing being
warned about, missed - and it costs a confusing week, not a misdelivery. Buying
atomicity here would mean a claim or a conditional write on a state that has no
natural key, which the harm does not earn. An earlier revision of this spec said the
server "enforces" the rule; that overclaimed and is corrected.

**D6 - TWO enforcement points, because the deferred path cannot use the first.**
Interactive opens (standalone, tour, placement) are checked inside
`provisionRelayGroup` - one function all three funnel through, so a fourth surface
added later inherits it.

The DEFERRED open cannot be. `jobs/rosterActions.ts` claims APPLY before calling
`openGroup()` (`:497` then `:540`), `claimSkip` is reachable only pre-claim (`:483`),
and the claim is one-way. A refusal raised from inside provisioning would land on an
`applied` row that appears in neither `pending[]` nor `skipped[]` - the operator's
deferred open would evaporate at quiet-end with nothing to show. The file already
solves exactly this for two other refusals, with the reasoning written out at
`:353-364`: `roster_too_thin` and `provisioning_unavailable` are both PRE-CLAIM skips
in `validateAction`. The duplicate check is a third, placed beside them.

So the detector has two call sites. That is not a violation of "one choke point"; it
is what the claim protocol requires, and the precedent is two lines above.

**D7 - Detection FAILS OPEN on BOTH failure modes, and never suppresses a real
match.**

- `truncated` on a partition walk -> `inconclusive`.
- A THROWN Query error -> caught inside the detector, logged, `inconclusive`. An
  earlier revision handled only truncation, which would have 500'd every preview and
  every create on a transient DynamoDB error - and the standalone preview route is
  deliberately un-caught ("the confirm dialog never opens"), so the operator would
  have been blocked entirely. That is the opposite of failing open.
- `inconclusive` is reported ALONGSIDE any match, never instead of it. If the OPEN
  partition yields a match and the CONNECTING walk truncates, the match still warns.
  Ordering the short-circuit the other way would discard a duplicate actually found.

Inconclusive never blocks and never warns. This is an operator-assist guard; nothing
routes incorrectly if it misses.

**D8 - The acknowledgement RIDES the deferral. (Reversed from r1.)** r1 skipped a
deferred open that had become a duplicate, on the reasoning that "they said yes hours
ago" is weak evidence. Both reviewers showed that is untenable: INSIDE QUIET HOURS the
dialog's default confirm IS a deferral, so an operator who sees the warning and
deliberately overrides it gets a deferral - and if the acknowledgement does not
survive, their override is unreachable every evening except by forcing an 11pm send.
D5's "warn, do not refuse" would become a refusal on the normal path.

So: `PendingRosterActionItem` gains `acknowledgedDuplicateOf?: string` (the
conversationId the operator was shown). `validateAction` runs the detector pre-claim;
a match whose conversationId equals the stored acknowledgement PROCEEDS, any other
match skips with a new `duplicate_open_group` reason. The row is a flexible document
(`repos/pendingRosterActionsRepo.ts:98-120`), so this is an additive optional field -
no migration.

**D9 - The acknowledgement is SCOPED to a conversation id, not a boolean.**
`acknowledgeDuplicateOf: '<conversationId>'`, everywhere - the API bodies, the
deferral row, the dialog callback. A bare boolean would let an operator's "yes I know
about group X" silently accept a create that duplicates group Y, and would record an
audit line naming a group they were never shown. If the duplicate found at create time
is not the one acknowledged, the refusal fires again carrying the NEW group.

**D10 - REOPEN is in scope.** Reopening a closed `{A,B}` group while another `{A,B}`
group is live produces exactly 2.1: two live threads for one set, on two numbers. An
earlier revision dismissed this by citing the burn rule, which was a non-sequitur -
the burn rule guarantees the two groups are on DIFFERENT numbers, which is the
condition, not a defence against it. `PATCH /api/conversations/:id/close` with
`{closed:false}` (`routes/relayGroups.ts:484-527`) therefore runs the same check and
returns the same 409 with the same scoped override.

**D11 - Roster REMOVAL is a known gap, filed, not built.** Removing C from a live
`{A,B,C}` beside a live `{A,B}` manufactures the duplicate condition without creating
anything. It is a real hole and the r1 table dismissed it with a slogan about adds
that did not address removes. It is NOT built here: the interaction is "you have just
converged two conversations", not "you are about to create a second one", so it wants
different copy and a different remedy (probably merge, not warn). To file as
`docs/issues/relay-duplicate-via-roster-removal.md`.

**D12 - Order the duplicate check AFTER the provisioning kill-switch refusal.** The
kill-switch throws from inside `provisionForGroup` at a tier-3 miss
(`poolNumbers.ts:577`), so a naive "check duplicates first" flips today's pre-A2P 503
`relay_provisioning_disabled` into a 409 `duplicate_open_group` - a wire-contract
change nobody asked for, on the path that is dormant precisely because provisioning is
off. The duplicate check runs where it cannot do that: the environmental refusal keeps
priority.

## 4. New module: `app/src/services/relayGroupDuplicates.ts`

```
/** The existing group a proposed roster duplicates. Names only - NEVER phones
 *  (doc section 9). */
export interface DuplicateOpenGroup {
  conversationId: string;
  /** The PARTITION it was found in, not the row's own `status` - those can skew
   *  (section 10). */
  partition: 'open' | 'connecting';
  /** Display names of the existing group's members. A participant with no name
   *  contributes the literal 'Unknown' - never the phone, which section 2.4's
   *  rule forbids on the wire. */
  memberNames: string[];
}

/**
 * The ONE detector, two call sites (D6). Scans the OPEN and CONNECTING relay
 * partitions for a group whose participant phone set equals `phones` EXACTLY
 * (D1). Rows carrying `imported_from` are skipped (D4, read via the index
 * signature - 2.6).
 *
 * MULTIPLE MATCHES: returns the one with the newest `last_activity_at`, which is
 * the partition read's own order, and logs the count. Several exact duplicates
 * already means something went wrong; the warning names the liveliest.
 *
 * `inconclusive` is true when either walk truncated OR threw (D7). It is
 * reported ALONGSIDE `match`, never instead of it.
 */
export function findOpenGroupWithSamePhones(
  deps: { conversations: Pick<ConversationsRepo, 'listRelayGroups'>; log: Logger },
  phones: Set<string>,
): Promise<{ match?: DuplicateOpenGroup; inconclusive: boolean }>;

/** Exact phone-set equality, exported so tests pin D1 directly. */
export function samePhoneSet(a: Set<string>, b: Set<string>): boolean;
```

## 5. Preview

`RosterPreview` gains one optional field, in BOTH declarations - the server's
(`app/src/services/rosterEdits.ts:312`) and the mirrored client one
(`dashboard/src/api/types.ts:1019`):

```
  /** An OPEN or CONNECTING relay group with EXACTLY these members already
   *  exists (D1). Absent when there is none, and absent when detection was
   *  inconclusive (D7) - the dialog cannot distinguish those, by design. */
  duplicateOf?: DuplicateOpenGroup;
```

`buildOpenPreviewFromParts` stays PURE: the duplicate is computed by the two async
builders and passed in as a new optional part.

`buildStandaloneOpenPreview`'s deps already carry the full `ConversationsRepo`.
`buildOpenPreview` takes `RosterResolutionDeps`, whose `conversations` is
`Pick<ConversationsRepo, 'getById'>` (`app/src/lib/rosterResolution.ts:129`); widen it
to add `listRelayGroups`.

An earlier revision claimed `rosterDeps` is "constructed in exactly TWO places". That
is wrong and a reviewer caught it: only two sites use the NAMED type
(`routes/tours.ts:514`, `routes/placements.ts:921`), but the deps are also built
INLINE and structurally elsewhere - notably `jobs/rosterActions.ts:321-323`, which is
precisely where D6's pre-claim check must go. The plan must enumerate every
structural construction site plus the job dep interfaces, and every test double that
supplies a partial `conversations`, before widening the type.

## 6. Dashboard surfaces

Enumerated, because r1 listed none:

- `dashboard/src/api/types.ts:1019` - the mirrored `RosterPreview` gains
  `duplicateOf`, and a mirrored `DuplicateOpenGroup`.
- `dashboard/src/api/types.ts:933` - the roster-action skip-reason union gains
  `duplicate_open_group`.
- `dashboard/src/routes/shared/rosterWrites.ts:162` - the EXHAUSTIVE switch that
  renders skip reasons gains a case. Without it the new reason renders as the vague
  fallback, so r1's claim that the card "already surfaces it" was false.
- `dashboard/src/routes/shared/RosterConfirmDialog.tsx` - renders the warning block,
  and its callback changes shape.
- The three call sites that pass `onConfirm`: `routes/tours/TourDetail.tsx`,
  `routes/placements/PlacementDetail.tsx`, `routes/shared/PeopleCard.tsx`, plus the
  dependency branch's `CreateRelayGroupModal.tsx`.
- `dashboard/src/api/endpoints.ts` - the open/create functions gain the
  acknowledgement argument.

### 6.1 The confirm callback must carry TWO independent decisions

Today `onConfirm: (force: boolean) => Promise<void>`
(`RosterConfirmDialog.tsx:55`), where `force` means "send now, ignoring quiet hours".
The duplicate acknowledgement is an ORTHOGONAL decision - overloading `force` would
tie "I know about the duplicate" to "send at 11pm", which is the trap D8 describes.
The callback becomes:

```
onConfirm: (opts: { force: boolean; acknowledgeDuplicateOf?: string }) => Promise<void>
```

Inside quiet hours the dialog therefore keeps BOTH of its existing buttons - defer
(the default) and send-now - and the duplicate warning changes their LABELS and adds
the acknowledgement to whichever is pressed. It does not add a third button and does
not disable the deferral. Deferring with an acknowledgement is the normal evening
path, which is exactly what D8 makes work.

### 6.2 Copy

- What exists, by name: "Dana Reed and Marcus Bell already have an open relay group."
  (connecting: "... a relay group being connected.")
- Why it matters, in one sentence from 2.1: a second group gets its own masked number,
  so these people will have two numbers for one conversation with no way to tell which
  one staff is watching. NOT "messages may go to the wrong thread" - they will not,
  and copy that overstates the risk will be disbelieved the first time an operator
  checks.
- A link to the existing conversation.
- Confirm reads "Create anyway"; the link is visually the primary action.

In-dashboard UI text, not automated outbound copy, so it does NOT go through the
message catalog.

## 7. Enforcement

`app/src/services/relayProvisioning.ts` gains
`DuplicateOpenRelayGroupError` carrying the `DuplicateOpenGroup`.
`ProvisionRelayInput` gains `acknowledgeDuplicateOf?: string` (D9).

In `provisionRelayGroup`, positioned per D12 so the kill-switch refusal keeps
priority, and before any conversation is created:

- Run the detector ALWAYS (never skipped by the acknowledgement, so an override is
  always audited with the id it overrode).
- `inconclusive` and no match -> log WARN, proceed (D7).
- match, and `acknowledgeDuplicateOf` equals its conversationId -> log
  `relay_duplicate_open_group_overridden` and proceed.
- match otherwise -> throw.

The override is audited on the `relay_group_created` entry. NOTE there are TWO such
appends - `relayProvisioning.ts:107` (connect-when-ready) and `:161` (assigned) - and
BOTH must carry `duplicateAcknowledgedOf`, or an override on the connecting path goes
unaudited.

Route mapping, one arm each beside the existing `RelayProvisioningDisabledError` arm:

- `routes/relayGroups.ts:282` catch -> 409 `{ error: 'duplicate_open_group',
  duplicate: {...} }`, audited `relay_duplicate_open_group_refused`.
- `rosterProvision.ts` `openTourGroup` (`:361`) -> the same 409 in the existing
  `{ ok:false, refusal:{status,body} }` shape. The arm goes INSIDE the existing catch,
  AFTER `releaseGroupThreadClaim`, or a refused tour open strands its sentinel
  (`docs/issues/relay-provisioning-sentinel-leak.md`). `openPlacementGroup` gets the
  same arm but has NO claim to release (2.3) - r1 said "both", which was wrong.
- `PATCH /api/conversations/:id/close` reopen branch -> the same 409 (D10).
- `jobs/rosterActions.ts` `validateAction` -> pre-claim skip (D6/D8).

### 7.1 When the preview and the create disagree

The preview is a read; a duplicate can appear between it and the confirm. The 409 body
therefore carries the FULL `DuplicateOpenGroup`, not just an id, and the client renders
it as the SAME warning block the dialog would have shown, with the same "Create
anyway" that retries carrying `acknowledgeDuplicateOf`. Without that, the operator
gets the generic "Couldn't save that change - please try again" from
`rosterWrites.ts`, which is unactionable and turns D5's warning into a bare refusal on
the ordinary race.

## 8. Cost

Honest numbers, because r1 said "one extra bounded Query" and that was wrong by more
than an order of magnitude.

Each detector call walks TWO partitions to exhaustion: up to 20 Queries x 100 items
each, per partition - so up to 40 Queries and 4,000 items. The NO-DUPLICATE case, which
is the common one, always pays the maximum, because a full walk is what proves absence.
An operator open pays this TWICE: once for the preview, once for the create.

Acceptable because relay-group opens are a rare, human-initiated action, and the walk
is on sparse relays-only partitions. Not acceptable to leave unstated: the performance
seed already builds up to 1,000 relay groups, so the ceiling is reachable in a test
lane today, and this cost grows with the org's lifetime group count. If it becomes hot
the answer is an index on a participant-set hash, which is schema work deliberately
excluded here. To file as `docs/issues/relay-duplicate-detection-scan-cost.md`.

## 9. Surfaces swept

| Surface | File | Effect |
|---|---|---|
| Standalone preview | `routes/relayGroups.ts:264-297` (dep branch) | serves `duplicateOf` |
| Tour preview | `routes/tours.ts:930` | serves `duplicateOf` |
| Placement preview | `routes/placements.ts:1260` | serves `duplicateOf` |
| Standalone create | `routes/relayGroups.ts:278` | enforced; 409 arm |
| Tour open | `rosterProvision.ts:346` | enforced; arm inside the catch, AFTER the claim release |
| Placement open | `rosterProvision.ts:646` | enforced; arm added - no claim to release |
| Deferred open | `jobs/rosterActions.ts` `validateAction` | PRE-CLAIM check + `duplicate_open_group` skip (D6, D8) |
| Reopen | `routes/relayGroups.ts:484-527` | NEW - enforced (D10) |
| Connect-when-ready open | `jobs/relayNumberReady.ts` | UNCHANGED - opens a group that already exists; nothing is created |
| Add member | `services/relayMembers.ts` | UNCHANGED - an add moves a set AWAY from an existing set, it cannot land on one |
| Remove member | `services/relayMembers.ts` | KNOWN GAP - a remove CAN land on an existing set (D11). Filed, not built |
| Seeds | `lib/seed/{cast,lean,live,matrix,performance}.ts` | WRITERS into both scanned partitions, carrying NO `imported_from`. They are read by the detector like any other row - deliberate, since a seeded duplicate SHOULD warn. `performance.ts` builds up to 1,000 groups, which is what makes section 8's ceiling reachable in a lane |
| Importer | `lib/import/apply.ts:1086, :1129-1130` | WRITER into the connecting partition; skipped via `imported_from` (D4, 2.6) |
| Pool numbers | `services/poolNumbers.ts`, `repos/poolNumbersRepo.ts` | UNCHANGED, deliberately (1, 2.2) |

## 10. A reader-level caveat

`touchLastActivity` (`conversationsRepo.ts:1449-1507`) writes `status = 'open'` onto
any non-`group_text` thread, leaving a re-flagged closed group at `status: 'open'` with
`relay_status: 'relay_group#closed'`. Detection scans by `relay_status`, so such a
group is invisible to it. Pre-existing
(`docs/issues/inbound-reflags-closed-relay-group.md`), it only weakens an advisory
warning that already fails open (D7), and it is out of scope. It is why
`DuplicateOpenGroup.partition` records the partition scanned rather than the row's own
`status`.

## 11. Test plan

Unit (`app/test/`):

- `relayGroupDuplicates.test.ts` (new) - THE PRODUCT RULE, pinned explicitly: `{A,B}`
  matches `{A,B}`; `{A,B}` does NOT match `{A,B,C}`; `{A,B,C}` does NOT match `{A,B}`;
  `{A,B}` does NOT match `{A,C}` (D1 - these three negatives are the whole rule).
  Order-independent. Matches across OPEN and CONNECTING (D4). SKIPS a connecting row
  carrying `imported_from` (fixture: the lean seed's only connecting row carries it,
  `lib/seed/lean.ts:262`). `inconclusive` on truncation AND on a thrown Query, with NO
  500 escaping. A match in OPEN is still returned when the CONNECTING walk truncates
  (D7's ordering rule). Multiple exact matches return the newest.
- Preview tests - `duplicateOf` present/absent/absent-when-inconclusive on both
  builders; the serialized payload contains NO phone numbers (assert on the JSON).
- `relayProvisioning.test.ts` - throws on ALL THREE owner shapes (unowned, tour,
  placement); proceeds when `acknowledgeDuplicateOf` matches; STILL THROWS when it
  names a DIFFERENT group (D9); proceeds when inconclusive; BOTH audit appends carry
  the override.
- Route tests - the 409 body carries the full duplicate; the tour refusal RELEASES the
  claim; reopen 409s (D10) and still reopens with a matching acknowledgement.
- `rosterActions` job test - a deferred open that became a duplicate is skipped
  PRE-CLAIM with `duplicate_open_group` and the row lands in `skipped[]` (not
  `applied[]`); a deferral carrying a matching `acknowledgedDuplicateOf` APPLIES (D8 -
  this is the quiet-hours override, the case r1 got wrong).

Dashboard (`dashboard/src/`):

- `RosterConfirmDialog.test.tsx` - the warning renders with names and a link; absent
  otherwise; inside quiet hours BOTH buttons remain and each carries the
  acknowledgement (6.1); confirm submits `acknowledgeDuplicateOf`.
- `rosterWrites` - `duplicate_open_group` renders its own text, not the fallback.

E2E (`e2e/tests/dashboard-next/`):

- Open a group for a pair, start a second for the SAME pair, assert the dialog warns
  and names the first; override and assert the second is created on a DIFFERENT pool
  number (which also pins 2.2, the behavior this feature deliberately does not change).
- Start a group for the same pair PLUS a third person and assert NO warning renders -
  D1's negative case. Without it a regression to containment-matching passes silently.

## 12. Sequencing

The BUILD is held until `feat/contact-create-relay-group` merges to `main`. It is
fully built and unmerged (25 files, ~3,600 insertions) and owns `rosterEdits.ts`,
`routes/relayGroups.ts`, `RosterConfirmDialog.tsx`, `dashboard/src/api/endpoints.ts`
and `dashboard/src/api/types.ts` - all of which this change also touches. Confirmed
with Cameron 2026-08-17: design now, merge that branch, rebase, then build. Never edit
`W:\tmp\contact-create-relay-group`.

## 13. Follow-ups TO FILE (none exist yet)

r1 claimed these were "filed" when no file existed. They are written as part of the
build, not before it.

- `docs/issues/relay-single-live-conversation-per-pair.md` - the larger product
  question: route new context INTO the existing group rather than warn about a second
  one. Deliberately not built.
- `docs/issues/relay-duplicate-across-contact-handsets.md` - D3's gap.
- `docs/issues/relay-duplicate-via-roster-removal.md` - D11's gap.
- `docs/issues/relay-duplicate-detection-scan-cost.md` - section 8.

## 14. Out of scope

- Any pool-number change (1, 2.2).
- Warning on supersets, subsets, or partial overlaps (D1).
- Roster removal (D11), routing context into an existing group (13).
- Atomicity for the check (D5).
- Fixing `touchLastActivity`'s unguarded reopen (10) or the placement atomic-claim gap
  (2.3) - both pre-existing, both filed.
- Any infrastructure, schema migration, or backfill. No table, no index; the one new
  persisted field is an optional attribute on a flexible document (D8).
