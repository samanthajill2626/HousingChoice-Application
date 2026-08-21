<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-21).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Warn when an open relay group already exists with the same contacts

Date: 2026-08-17 (r5: 2026-08-18)
Branch: `feat/relay-number-reuse` (the name predates a scope change and is kept
deliberately); worktree `W:\tmp\relay-number-reuse`, synced with `main` @014b93a6.
Revision: r5. Four rounds of adversarial review. An earlier revision DELETED the
server-refusal layer the first two rounds kept finding blockers in (see 1.1); r4 and
r5 fold in the findings against that deletion, including two BLOCKING ones - a
self-contradiction in D6, and a preview parameter shape that could not be supplied. Adjudications at
`.superpowers/design-review/adjudications.md`.

## Amendment 2026-08-19: outbound content vs staff-only chrome

This document states the PII rule in its blunt form - "a preview carries names,
never phones" - and section 4 mandates the literal `'Unknown'` for a nameless
participant. The founder corrected the line after the branch went green. The rule
is NOT "preview vs not-preview":

- OUTBOUND MESSAGE CONTENT - anything a tenant or landlord actually receives -
  carries names and NEVER a phone. That is the intro body
  (`jobs/relayFanOut.ts` `composeConnectionSentence` / `composeIntroBody`), which
  drops a nameless member and falls back to a neutral count. UNCHANGED, and it
  must stay unchanged.
- STAFF-ONLY CHROME - a label or sentence only a navigator ever sees - falls back
  to the member's FORMATTED phone. A navigator cannot act on "Unknown", and
  silently dropping a nameless member loses a person from a staff-facing list.
  This is already the app's convention elsewhere (`contactDisplayName`,
  `dashboard/src/routes/contact/format.ts`).

The relay chains avoided the fallback wholesale only because ONE resolved name fed
BOTH consumers. They are now split: `lib/groupTitle.ts` `relayMemberLabels` serves
the staff half for `relayThreadLabel`, `routes/contacts.ts` `otherMemberNames`, and
`routes/poolNumbersAdmin.ts` `serverLabel`; `relayGroupDuplicates.toDuplicate`
applies the same fallback. `'Unknown'` is GONE from that path, not merely unused:
`rosterMembers` already keeps only phone-bearing participants, so every entry has a
name or a number and the branch was unreachable.

One rule rides along with the fallback: where a chain has a `placement_tag` rung,
the TAG STILL WINS when NOBODY on the roster has a real name. An operator's
deliberate label beats a list of raw digits, and without the carve-out the tag rung
would be dead code for every group that has participants.

Out of scope of the amendment, deliberately: `preview.recipients[].name` and
`RosterPreviewRecipient` keep withholding the phone (`RosterMemberView` exposes only
`phoneLast4`), because widening that roster wire type is a separate decision.

Read sections 4, 5, and 9 below with this amendment in front of them.

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
retried reopen matching itself, and worst, an ordering rule that would have run the
check AFTER `provisionForGroup` and so after tier-1/2's irreversible `burnClaim` -
permanently burning the roster onto a pool number hosting no group, and burning a
second on retry. Deleting the layer deletes all of it.

One of those four was also argued on a FALSE premise, and it is corrected here rather
than left to flatter the decision: the reopen blocker said reopen had no dialog to
render a warning in. It has one (section 8). The blocker still stood on its other
grounds - an unreachable override and a retried reopen matching itself - and the
deletion rests on the human's ruling that this is a warning, not on any of these
findings. But the premise was wrong and is not load-bearing for the outcome.

**This spec contains no pool-number work.** `app/src/services/poolNumbers.ts` and
`app/src/repos/poolNumbersRepo.ts` are not modified. See 2.2.

## 2. Verified current behavior

### 2.1 Why a duplicate is harmful - and what it does NOT break

Inbound SMS resolves on `(To, From)` - `app/src/routes/webhooks/twilio.ts:1911-1952`.
A duplicate group gets a SECOND pool number (2.2), so the two groups sit on two
different numbers. Routing is therefore FULLY DETERMINISTIC: a reply to number 1
resolves to group 1 and a reply to number 2 resolves to group 2, every time. Nothing
is delivered to the wrong party and no invariant is violated. **A duplicate is not a
correctness problem.**

CONNECTING GROUPS ARE THE EXCEPTION TO THE TENSE, NOT TO THE HARM. A connecting group
has NO `pool_number` yet (`conversationsRepo.ts:696`, `:1803`) - it is waiting on a
number being provisioned for it. So when either side of the pair is connecting there
is not yet a second number; there is a second number ON ITS WAY. D4 makes connecting
groups first-class matches, so the copy must not assert a present-tense second number
that does not exist yet (see 5). The underlying harm is identical once it lands.

A connecting match can also flip to OPEN between the preview and the confirm, which
makes the rendered variant one tense stale. Harmless - both variants describe the same
outcome and neither gates anything - but do not build a check that assumes the status
held.

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

### 2.2 Every duplicate ALREADY gets a DIFFERENT number - verified, do not "fix" it

`provisionForGroup` tier 1 skips any active number whose burn overlaps the new roster
AT ALL (`app/src/services/poolNumbers.ts:539-540`, via `rosterOverlapsBurn` at
`:302-309`, true when ANY roster phone is in the set). Tier 2 (`:556`) only
accepts EMPTY-burn spares. `burned_phones` is permanent and never cleared
(`app/src/repos/poolNumbersRepo.ts:15-21, :100-111`). So once A and B are burned on a
number, no later group containing A or B can land on it - open or closed, same set or
merely overlapping.

DIFFERENT, not NEW: tier 1 can multiplex the duplicate onto an existing number that
hosts unrelated groups, in which case nothing is bought and nothing is consumed. The
guarantee is separation, not novelty - which is why the copy makes no pool-accounting
claim (5).

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
  and `PeopleCard.tsx:443`. **`PeopleCard` is the ADD-member confirm, not an open.**
  It renders the same component over the ADD preview, so the no-warning-on-add
  guarantee is enforced at the producer (`buildAddPreview`), not here - see 5.

`RosterPreview`'s header states the rule this design obeys: previews carry names,
never phones (doc section 9). AMENDED 2026-08-19 - see the amendment at the top:
the rule binds the preview's OUTBOUND BODY, not every field of the payload. The
staff-only chrome beside it (`duplicateOf.memberNames`) falls back to a formatted
phone.

### 2.5 Detection primitive

`conversations.listRelayGroups(status)` (`app/src/repos/conversationsRepo.ts:778`)
is a DIRECT Query on the SPARSE `byRelayStatus` GSI - relay groups only, never a Scan.
Returns `{ items, truncated }`; `truncated` means a fixed page budget
(100 x 20 = 2000, `:415-416`) stopped the walk. There is NO index for "group by exact
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

**D2 - The PROPOSED side is the deduped, phone-bearing member list.** That is what
provisioning will actually put on the thread. `provisionMembersOf`
(`rosterProvision.ts:106`) implements that rule for the OPEN path, but NEITHER preview
builder calls it - both re-derive the same de-duplication inline
(`buildOpenPreview` filters `resolved.members` on a `seenPhones` set;
`buildStandaloneOpenPreview` does the same over the client list). Cite it as the rule,
not as the function to call, and take the set from whichever list each builder has
already deduped, so the preview compares exactly the roster it is previewing.

**D2a - The EXISTING side is `participants[].phone`, and NOTHING else.** Say it
explicitly, because `ever_member_phones` sits directly beside `participants` on
`ConversationItem` with OPPOSITE semantics: it is add-only burn provenance that a
member REMOVE never clears (`conversationsRepo.ts:250-258`), so it answers "who was
ever here", not "who is on this thread". Comparing it would warn about groups whose
current roster does not match at all. The live roster is the only correct input, and a
builder reaching for the adjacent field is the likeliest way this feature goes wrong.

**D3 - Compare E.164 PHONES, never `relayMemberKey`.** `app/src/services/groupMembers.ts:32` rules against the contactId-preferring key for
roster identity - one contact owning TWO numbers would collapse into a single slot.
That rule is stated there for group-text delivery slots; it applies here for the
stronger reason that PHONES are what `(To, From)` routing keys on (2.1), which is the
relay-side authority for the same conclusion.
KNOWN GAP: the same humans on different numbers will not match (section 8).

**D4 - OPEN and CONNECTING both count, except imported rows** (2.6). A connecting
group is a real live thread pending its number.

**D5 - WARNING ONLY. The server does not refuse, and there is nothing to override.**
An operator who proceeds gets their group. A caller that skips the preview and POSTs
directly gets no warning and a created group - accepted: the warning is an aid to a
human about to act, not a gate, and per 2.1 nothing breaks when it is missed. This is
what deletes the four blocking findings of 1.1.

**D6 - A MATCH ALWAYS WINS; incompleteness only ever means "say nothing".** State it
as one rule, in this order, because r3 stated it as two and they contradicted each
other:

1. If a matching group was FOUND - in either partition, on any page, including a page
   of a walk that later truncated or threw - it is returned and the warning renders.
   A duplicate we actually saw is not made less true by failing to finish looking.
2. Only when NO match was found does incompleteness matter, and then the answer is
   `undefined`: no warning, one logged WARN. That covers both a `truncated` walk and
   a THROWN Query error.

r3's section 4 and test plan encoded "a truncated or failed walk yields `undefined`"
unconditionally, which discards a match found before the truncation - the exact
suppression the same decision forbade two sentences earlier. Rule 1 is the correct
half.

The failure mode this must not have: the detector is called from inside preview
builders whose route deliberately does NOT catch (`routes/relayGroups.ts:264-297`
says so outright - "a preview that cannot determine who is suppressed must not render
as though it could"). That route's fail-CLOSED posture is about SUPPRESSION, which
changes who receives a message; a missing duplicate warning changes nobody's
delivery. So the detector swallows its own errors rather than inheriting that
posture - but it must swallow them itself, or an uncaught throw takes the whole
dialog down.

**D7 - Detection runs in the PREVIEW ONLY.** No check at create, at reopen, in
`validateAction`, or in the quiet-hours poller - an earlier revision had five call
sites across all of those.

Precisely, because the injected-callback shape (section 5) splits the two halves: the
detector is CONSTRUCTED in the three preview ROUTES, which hold the repo and the
logger, and INVOKED from the two open preview BUILDERS in `rosterEdits.ts`, which hold
the phone set. Neither builder imports the detector and neither route computes a
duplicate.

## 4. New module: `app/src/services/relayGroupDuplicates.ts`

```
/** The existing group a proposed roster duplicates. Staff-facing labels only -
 *  see the 2026-08-19 amendment at the top of this document. */
export interface DuplicateOpenGroup {
  conversationId: string;
  /** The PARTITION it was found in, not the row's own `status` - those can skew
   *  (section 7). */
  partition: 'open' | 'connecting';
  /** The existing group's members, for the warning copy: each one's display
   *  name, else their FORMATTED phone. This is staff chrome - it renders only in
   *  the navigator's confirm dialog and is transmitted to nobody. (r5 mandated
   *  the literal 'Unknown' here; amended 2026-08-19.) */
  memberNames: string[];
}

/**
 * Scans the OPEN and CONNECTING relay partitions for a group whose PARTICIPANT
 * phone set equals `phones` EXACTLY (D1, D2a). Rows carrying `imported_from` are
 * skipped (D4, via the index signature - 2.6).
 *
 * Never throws. A match found before a walk truncated or threw is still
 * RETURNED; `undefined` means "no match was found", and when the search was also
 * incomplete that fact is logged as a WARN rather than changing the answer (D6).
 *
 * MULTIPLE MATCHES: prefer an OPEN match over a CONNECTING one, and only then
 * take the newest `last_activity_at`; log the count. Ranking purely by activity
 * hands the warning to a just-created CONNECTING shell - whose stamp is `now` and
 * which nobody has ever texted - over a real OPEN thread that happens to be quiet,
 * which is the opposite of naming the liveliest.
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

`buildOpenPreviewFromParts` stays PURE: the two async builders resolve the duplicate
through the injected callback below and pass the result into the core as a new
optional part. They do not compute it themselves and do not know how it is found.

BOTH open builders take the SAME new optional parameter, and it is a function that
RECEIVES the phone set:

```
findDuplicate?: (phones: Set<string>) => Promise<DuplicateOpenGroup | undefined>
```

It is a TRAILING OPTIONAL PARAMETER on both builders - the same position and the same
name in each, so the two cannot drift - not a new field on either deps object.

Each builder derives its deduped phone set (D2), and if `findDuplicate` was supplied,
awaits it and puts the result on the preview. Omitted, the preview simply carries no
`duplicateOf` and nothing warns - which is the correct degradation for a feature that
never refuses.

The builders do NOT wrap the call in a try/catch. Error swallowing belongs to
`findOpenGroupWithSamePhones` (D6), which is the only thing that knows a failed lookup
means silence rather than a broken preview; a second catch in the builder would make
it ambiguous which layer is responsible and would also swallow a genuine bug in an
injected stub during tests.

The THREE preview routes supply it, one line each, closing over the full repo and
logger they already hold:

```
findDuplicate: (phones) => findOpenGroupWithSamePhones({ conversations, log }, phones)
```

Why this shape and not the two earlier ones, both of which were wrong:

- r3 said to WIDEN `RosterResolutionDeps.conversations` to add `listRelayGroups`. That
  type is the deps of the whole roster RESOLVER, threaded through `describeRoster`,
  `resolveRoster`, `applyRosterPlanEdit` and the roster-actions job, none of which has
  any business knowing about duplicate detection - and widening forces every
  structural construction site plus every partial test double to supply the method.
  A grep for the NAMED type finds only two sites (`routes/tours.ts:514`,
  `routes/placements.ts:921`) while the deps are also built INLINE elsewhere, e.g.
  `jobs/rosterActions.ts:321-323`.
- r4 first offered a parameter carrying EITHER a resolved `DuplicateOpenGroup` or a
  ZERO-ARGUMENT closure. Neither is suppliable: the phone set does not exist until
  `buildOpenPreview` has resolved the roster and deduped it INTERNALLY, so a caller
  has nothing to compute the duplicate from and a zero-argument closure has nothing to
  close over. That is the same zero-argument-closure mistake 1.1 records as a deleted
  blocker, made a second time in a different place. Passing the phones INTO the
  callback is what makes it constructible.

This shape also settles where the logger comes from.
`buildStandaloneOpenPreview`'s deps are `{ contacts, conversations }`
(`rosterEdits.ts:495-499`) with NO `Logger`, so it could not have emitted D6's
mandated WARN itself. The closure carries its route's logger, so neither builder needs
one and neither needs `listRelayGroups`.

`RosterConfirmDialog` renders a warning block above the recipient list when
`duplicateOf` is present. **`onConfirm` does not change** - there is no
acknowledgement to carry, which is the single largest simplification this design buys.

THE ADD PATH MUST NOT WARN, AND THE GUARANTEE BELONGS ON THE PRODUCER. `RosterPreview`
is also the shape returned by the ADD preview, which `PeopleCard.tsx:443` renders
through the same dialog. r3 put the "must not render this warning" rule on
`PeopleCard`, which cannot enforce it - a renderer shows whatever the field contains.
The rule is therefore: `buildAddPreview` NEVER populates `duplicateOf`, so the add
dialog has nothing to render. Adding a member changes a set rather than creating a
second thread for one, so the question is not merely unhelpful there, it is
meaningless. Pin it with a test on the builder, not on the component.

Copy - two variants, because the connecting case has no second number YET (2.1):

- OPEN match. What exists: "Dana Reed and Marcus Bell already have an open relay
  group." Why it matters: this group will get its own separate number, so they will
  have two numbers for one conversation with no way to tell which one staff is
  watching.
- CONNECTING match. "Dana Reed and Marcus Bell already have a relay group being
  connected." Why: that group is still waiting on a number, and this one will get a
  second - the same two-numbers-one-conversation outcome. Make NO claim about pool
  accounting in either variant. What a duplicate costs the pool is genuinely variable:
  tier 1 may multiplex it onto an existing number at no cost, tier 2 consumes a warm
  spare, and only tier 3 purchases. An earlier draft said "buys" (wrong for tiers 1-2)
  and its correction said "consumes another number" (wrong for tier 1). The harm that
  is ALWAYS true is the two numbers between the same people; say that and stop.
- Neither variant may say "messages may go to the wrong thread". They will not (2.1),
  and an operator who checks and finds it false will discount the next warning too.
- A link to the existing conversation, opening in a NEW TAB. It is deliberately not
  the dialog's primary action: navigating the current tab away would discard the
  half-built group the operator is standing in, which is a worse outcome than the
  duplicate. The dialog's own buttons - including the quiet-hours defer/send-now pair
  - keep their existing labels, positions and behavior; the warning adds a block above
  the recipient list and changes nothing below it.

In-dashboard UI text, not automated outbound copy - it does NOT go through the message
catalog.

## 6. Cost

One detector call per PREVIEW. It walks two partitions to exhaustion - up to 20 Queries
x 100 items each, so up to 40 Queries and 4,000 items - and the NO-DUPLICATE case, the
common one, always pays the maximum, because a full walk is what proves absence.

An earlier revision paid this TWICE per open (preview + create); this one pays it
once, on a screen the
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
| Seeds | `lib/seed/{cast,lean,live,matrix,performance}.ts` | WRITERS into the scanned partitions. Read like any other row, since a seeded duplicate SHOULD warn - EXCEPT that lean's only relay row carries `imported_from` (`lean.ts:263`) and is therefore skipped, which is what makes it the D4 test fixture rather than a live match. `performance.ts` builds up to 1,000 groups (section 6) |
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
  creates the duplicate state with no warning. CORRECTION: r3 justified deferring this
  by saying reopen "has no preview and no dialog". The dialog part is FALSE - there is
  a "Reopen group?" confirm modal at
  `dashboard/src/routes/conversation/ConversationDetail.tsx:680-710`, with body copy
  about keeping the same number. What reopen lacks is a PREVIEW endpoint: nothing on
  that path builds a `RosterPreview` or calls the detector, so wiring a warning means
  giving the reopen route a server-side preview call it has never had, then rendering
  into the modal that does exist. Still deferred - but on the true ground, which is
  smaller than the one r3 claimed, so this is a better candidate for a follow-up than
  it looked.
- `relay-duplicate-via-roster-removal.md` - removing C from a live `{A,B,C}` beside a
  live `{A,B}` lands on an existing set without creating anything. Wants different copy
  and probably a merge, not a warning.
- `relay-duplicate-across-contact-handsets.md` - D3's gap.
- `relay-duplicate-detection-scan-cost.md` - section 6; the answer if it becomes hot is
  an index on a participant-set hash, which is schema work excluded here. Note the
  performance workload already drives both affected preview endpoints against the
  1,000-group seed, so this is measurable today rather than hypothetical.
- `relay-duplicate-warning-stale-after-defer.md` - a quiet-hours DEFERRED open applies
  at quiet-end, hours after the dialog rendered. A duplicate created in between is
  never warned about, and a duplicate that WAS warned about may have closed by then.
  Nothing refuses (D5), so this is staleness rather than a wrong refusal, but it is a
  real limit of a preview-time-only check and r3 did not record it at all.

## 9. Test plan

Unit (`app/test/`):

- `relayGroupDuplicates.test.ts` (new) - THE PRODUCT RULE, pinned explicitly: `{A,B}`
  matches `{A,B}`; `{A,B}` does NOT match `{A,B,C}`; `{A,B,C}` does NOT match `{A,B}`;
  `{A,B}` does NOT match `{A,C}` (D1 - these three negatives ARE the rule).
  Order-independent. Matches across OPEN and CONNECTING (D4). SKIPS a connecting row
  carrying `imported_from` (fixture: the lean seed's only connecting row carries it,
  `lib/seed/lean.ts:263`). D6, all four cases, since an earlier revision encoded this
  backwards: a match found BEFORE a truncation in the SAME partition is still returned;
  a match in OPEN survives a truncated CONNECTING walk; NO match plus a truncated walk
  returns undefined with a WARN; and a thrown Query returns undefined rather than
  propagating. TIE-BREAK, and this is the ONLY place it is pinned: given one OPEN and
  one CONNECTING exact match, the OPEN one is returned EVEN WHEN the connecting row has
  the newer `last_activity_at` - a fresh connecting shell must not outrank a live
  thread; newest wins only WITHIN a status. D2a: a group whose `ever_member_phones`
  matches but whose `participants` do NOT is NOT a match - the adjacent-field trap.
- Preview tests, in CALLBACK terms (section 5's split) - for EACH open builder: given a
  stub `findDuplicate`, `duplicateOf` is present when it resolves a group and absent
  when it resolves undefined; the builder passes the callback the DEDUPED phone set it
  actually previews (D2 - assert on the argument, since nothing else pins what is
  compared); and OMITTING the callback entirely yields a preview with no `duplicateOf`
  and no throw, which is the degradation contract that lets a caller opt out. Plus the
  PII guard - AMENDED 2026-08-19: assert on `preview.body`, the outbound half, NOT on
  the serialized payload, whose staff chrome may legitimately carry a formatted phone.
  The narrowed assertion is paired with a case where EVERY member is nameless, since
  that is the only world in which the body could acquire a number; without it, the
  narrowing silently retires the guard.
- `buildAddPreview` never sets `duplicateOf`, whatever it is given (5).

Dashboard:

- `RosterConfirmDialog.test.tsx` - the warning renders with names and a link when
  `duplicateOf` is present, absent otherwise; `onConfirm` is called with its existing
  signature either way.
- The ADD path (`PeopleCard`) never renders it.

E2E (`e2e/tests/dashboard-next/`):

- Open a group for a pair, start a second for the SAME pair, assert the dialog warns
  and names the first, then proceed and assert the second IS created - which pins D5
  (nothing is refused). Use the existing `createGroupOpen` helper
  (`e2e/fixtures/relayConnect.ts`) to reach an OPEN, numbered first group: in the
  hermetic lane a fresh pair lands CONNECTING with no pool number (twilio driver, K=0,
  console-tagged seed numbers), and that helper drives the fake's register-number seam.
  Assert the second group is created; assert a DIFFERENT pool number ONLY once it too
  has been driven to open, since a just-created second group has no number to compare.
  An earlier draft asserted the number difference directly, which is unrunnable there.
- Start a group for the same pair PLUS a third person and assert NO warning renders -
  D1's negative case. Without it, a regression to containment-matching passes silently.

## 10. Out of scope

- Any pool-number change (1.1, 2.2).
- Any server-side refusal, acknowledgement, or override (D5).
- Warning on supersets, subsets, or partial overlaps (D1).
- Reopen, roster removal, and routing context into an existing group (section 8).
- Any infrastructure, schema migration, or backfill. No table, no index, no new
  persisted field - `duplicateOf` is computed per request and never stored.
