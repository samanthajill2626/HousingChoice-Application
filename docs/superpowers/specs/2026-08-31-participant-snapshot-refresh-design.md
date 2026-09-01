# Participant name snapshots: resolve on read, display surfaces

Branch: `feat/participant-snapshot-refresh`
Worktree: `W:\tmp\participant-snapshot-refresh`
Bundle: M1 (docs/issues/_CLUSTERS.md, re-derived 2026-08-31 @5ce9912f)
Date: 2026-08-31
Revision: **v3**, after design review rounds 1 and 2 and two scope rulings.
Adjudications: `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/design-review/adjudications.md`
and `.../adjudications-round2.md`.

| sev | issue | disposition |
|---|---|---|
| high | today-shows-phone-instead-of-name | CLOSED |
| high | group-roster-name-snapshot-never-refreshed | CLOSED for every staff-facing surface; its outbound-content half is OWNED BY ANOTHER BRANCH (see 2.2) |
| med | relay-stale-participant-phone | CLOSED as documented behavior, no code change (see 7) |
| low | consolidate-contact-display-name-helpers | census CORRECTED, stays OPEN (see 8) |
| low | today-contact-hydration-fan-out | measured, then resolved (see 9) |

---

## 1. Problem

A conversation row stores a COPY of each participant's name, taken when the
row was written: `participant_display_name` (the 1:1 copy) and
`participants[].name` (one per group-roster member). Nothing keeps either
current.

Measured 2026-08-25 with
`app/scripts/measure-unread-contact-coverage.ts --confirm --audit-denorm`
(script output against live tables; not reproducible from the tree):

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| contact HAS a name, thread carries none | 592 | 579 |
| thread name differs from the contact's | 0 | 2 |

Two founder-observed symptoms, and both are what this branch closes:

1. Today's Needs-you-now and Unreplied rows render a phone number where the
   operator should see a person (~85% of open threads).
2. Renaming a contact does not change group conversation titles or member
   chips.

## 2. Scope

### 2.1 What this is

**Not "add resolve-on-read". Resolve-on-read for rosters ALREADY SHIPS, in
three inconsistent forms, and one of them writes back** (round 1, A2/B1,
BLOCKING, found independently by both reviewers and verified by the planner):

| site | today |
|---|---|
| `routes/api.ts:2017-2117` `GET /conversations/:id/group-members` | resolves by PHONE, prefers the contact name, WRITES the roster back via `backfillGroupTextRoster` (`:2099-2114`). `group_text` only. |
| `routes/relayGroups.ts:456-492` `GET /conversations/:id/members` | resolves by contactId and DELETES the stored name. `relay_group` only. |
| `lib/rosterResolution.ts:544-545` `describeRoster` | resolves the contact but lets the STORED name win. |
| everything else | reads the raw snapshot. |

The work is to **reconcile these onto one rule and extend it to the display
surfaces that have none.**

### 2.2 What is OUT, and why it is not a deferral

**Every outbound-message-content path is out of scope and NO issue is filed
for it** (Cameron, 2026-08-31). It is not deferred - it is **owned by
`feat/tour-reminder-ladder-phase-b`**, and that branch is not merely editing
these bodies, it is deliberately SPLITTING the relay intro into three variants
- naked, tour and placement - routed on the conversation's owner (its spec
section 9.1, via `getOwner`, `repos/conversationsRepo.ts:385`). Any change made
here would be rewritten by that split.

Its plan Tasks 13 and 14 rewrite exactly these functions:

- `jobs/relayFanOut.ts` - `composeConnectionSentence` (becomes
  `composeNameList`), `composeIntroBody`, `composeMemberAddedBody`, both job
  handlers, plus a new shared owner-keyed resolver;
- `services/rosterEdits.ts` - `buildOpenPreview`, `buildAddPreview`,
  `buildOpenPreviewFromParts` (preview parity);
- `services/relayAnnouncements.ts` - the `bodyFor` selector.

That branch's spec has independently identified the same hazard this branch's
round-2 review found - a throw after `putJobExecutionMarker` loses the
announcement rather than retrying it (its spec, section 9.4). Editing these
functions here would collide on the same lines and duplicate reasoning already
done. **Do not touch those three files.**

CO-EDIT WARNING, not a collision: `feat/tour-reminder-ladder-phase-b` also
edits `routes/relayGroups.ts`, in the scheduled-tour-reminder block around
`:333`. This branch edits `:456-492`. Different functions, one file - a
textual merge for whoever lands second, with no semantic interaction.

### 2.3 Also out

- `lib/unreadFeed.ts`, the Unknown-tab walk in `routes/inbox.ts` (M6,
  T-UNREAD-GEN); `participants[].contactId` ownership (M8).
- `jobs/tourReminders.ts`, `routes/contactTimeline.ts` (phase-b). Verified
  twice: `tourReminders.ts:1151-1162` reads `members.length` and `pool_number`
  only, never `.name`.
- The two group PUSH TITLE sites (`webhooks/twilio.ts:727, :1810`).
  `webhooks/twilio.ts:398-402` states the push promise is deliberately NOT
  awaited so a slow push can never delay the webhook ack; the title is computed
  synchronously OUTSIDE that boundary, so hydrating it would put an awaited
  batch read ON the ack path (round 2, R3). Recorded in the
  `group-roster-name-snapshot-never-refreshed` Resolution stamp as a known
  remaining gap - not a new issue.
- `services/rosterProvision.ts:106-121` `provisionMembersOf`, which WRITES
  `member.name` into a new thread's roster from `resolveRoster` (round 2, R8).
  On the create path that source is the plan/default branch, which already
  resolves from contacts, so the written names are fresh. Left alone.
- `routes/poolNumbersAdmin.ts:109` and `services/relayGroupDuplicates.ts:129`.
  Both are staff-admin surfaces. The round-2 correction (R7) stands: the honest
  basis is "a different PAGE", not "a different thread". `relayGroupDuplicates`
  rides the same `RosterPreview` object `rosterEdits.ts` builds, which is
  phase-b's file - so it follows that branch, not this one. Filed, not fixed.

## 3. The rule

**Cameron, 2026-08-31**, refined across two exchanges:

```
1. the live contact's name, when it is readable and non-empty
2. else the STORED snapshot name, when there is one
3. else the formatted phone number
```

Rung 3 already exists client-side (`dashboard/src/lib/groupThread.ts`
`groupMemberLabel`: "full name, else formatted number"), so a server that
returns no name still renders a number rather than a blank. That preserves the
invariant at `dashboard/src/lib/recipientLabel.ts:95-99` - "a nameless relay
member ... is shown by number as a RECIPIENT, because a blank row is useless.
That split is intended and must not be 'fixed' in either direction."

**Correction of record:** v2 justified overriding
`routes/relayGroups.ts:471-474` by claiming its comment "only argues about
precedence". Round 2 (R4) showed that is a misreading - its second clause,
"otherwise the dashboard uses this current roster phone as its fallback", IS
the read-failure branch, implemented at `:482-489` and in two client files. The
three-rung rule above resolves it without a reversal: rung 1 keeps the comment's
precedence intact, rung 2 adds the stored name the route currently deletes, and
rung 3 preserves the number fallback the comment protects. All three comments
are amended to state the new middle rung.

**Batch the lookups** - one batch read per page, never one per member.

**What the mechanism does NOT deliver** (round 1, B10): it cannot distinguish a
failed read from an absent contact from a contact whose name was deliberately
CLEARED, so clearing a wrongly-auto-captured name leaves the stored one
rendering. Stated, not fixed; the primitive change it needs is deferred to
`contacts-batchget-amplified-reads`.

**There is NO phone-based resolution rung in new code.** v2 had one, and round
2 killed it on three independent grounds: `findByPhone` cannot be batched
(`contactsRepo.ts:806-808`, BatchGetItem cannot read a GSI); each call can cost
TWO round trips via the phone-pointer hop (`:1031-1035`), so v2's cap of 25
authorised ~50 sequential reads on `GET /api/inbox`; and it returns the FIRST
GSI item for duplicate phones in arbitrary order (`:1011-1016`), so it can
attach the WRONG person's name. The triage-stub case it was meant to cover
(a roster `contactId` still pointing at a stub that staff merged away) stays
owned by the EXISTING converge-on-read write at `routes/api.ts:2099-2114`,
which resolves by phone and writes the corrected name back - after which this
branch's rung 2 reads a fresh snapshot. Using that mechanism beats duplicating
it.

**Known gap from that choice, stated rather than hidden:** a `group_text`
roster whose member panel is never opened keeps its stale stored name on every
surface. That is today's behavior, unchanged; S5's audit will size it.

## 4. Surfaces

Every line below was opened by a reviewer or the planner. **These tables are
not asserted exhaustive** - round 2 (R6) showed v2's completeness claim was
false on its own first row, and a table that claims completeness and is short
is worse than one that does not, because the next reviewer stops looking.

### 4.1 `participant_display_name`

READERS: `routes/today.ts:1076` (the anchor bug); `webhooks/twilio.ts:1043`,
`:2285` and `webhooks/voice.ts:159` (push titles and caller ID - all three
already do contact-first); `routes/api.ts:457`; `lib/events.ts:103`;
`dashboard/src/routes/today/buildToday.ts:106`;
`scripts/measure-unread-contact-coverage.ts:545-546`.

WRITERS: `routes/contacts.ts:1753` (the identity fan-out, which finds threads
by the contact's CURRENT phone at `:1738`, so correcting a number orphans the
old thread); `routes/contacts.ts:1871`; `jobs/placementNudges.ts:554`; and two
that a literal grep misses because they pass `opts.displayName` through
`createOrGetByParticipantEmail` (`conversationsRepo.ts:587-594`) -
`routes/contacts.ts:1909-1912` and `services/inboundEmail.ts:909-917`.

### 4.2 `participants[].name`

IN SCOPE:

| site | surface | slice |
|---|---|---|
| `routes/api.ts:1993-2002` | `GET /conversations/:id` - raw passthrough | **NOT HYDRATED - see 5.5** |
| `routes/api.ts:2190-2198` | `GET /calls/:callId` - sibling passthrough feeding QuickReply | S2 |
| `routes/api.ts:2017-2117` | group-members panel - already resolves; reconcile, keep its write-back | S2 |
| `routes/relayGroups.ts:456-492` | relay members panel - add rung 2; batch it | S2 |
| `routes/inbox.ts:1237, 2358` | `groupRowFor` - SYNCHRONOUS, zero reads today | S2 |
| `routes/inbox.ts:1154, 2293, 1418` | `relayRowFor` | S2 |
| `routes/contacts.ts:1213, 1295` | relay-groups + group-texts cards | S2 |
| `routes/today.ts:1001` | relay close-nag `memberNames` | S1 |
| `lib/rosterResolution.ts:544-545` | `describeRoster` - precedence inverted | S3 |
| `webhooks/twilio.ts:307-315` | `pushSenderLabel` - snapshot FIRST | S4 |
| `webhooks/voice.ts:112-121` | `maskedPartyLabel` - snapshot FIRST | S4 |

CLIENT readers, all fixed by hydrating the passthroughs above with NO client
edit: `dashboard/src/lib/groupThread.ts`, `lib/recipientLabel.ts:101-139`,
`lib/memberAttribution.ts:77, 120`, `routes/conversation/GroupTextView.tsx`,
`routes/conversation/ConversationDetail.tsx`,
`routes/contact/GroupTextsCard.tsx`, `routes/contact/Timeline.tsx:378`,
`routes/placements/PlacementDetail.tsx:372-375`,
`routes/tours/TourDetail.tsx:453-455`, `routes/quickReply/QuickReply.tsx:53-61`,
`routes/shared/rosterPeople.ts:28`.

WRITERS: `routes/api.ts:2107`, `services/groupConvert.ts:428, :504`,
`services/relayMembers.ts:47-49`, `services/rosterProvision.ts:117`,
`jobs/relayFanOut.ts:465-471` (into `relay_opted_out_members`, read by
`routes/today.ts:606-613`). **All are left running** - they converge the
snapshot toward the contact, the same direction this branch reads, so they
cannot fight it; they only keep rung 2 fresh.

## 5. Mechanism

Replace the roster name with the live contact name IN MEMORY at each read
boundary, then hand the existing label functions the fresher array unchanged.
`groupThreadLabel`, `relayThreadLabel`, `relayMemberLabels` and
`describeRoster` keep their signatures and their tests.

### 5.1 New module: `app/src/lib/participantNames.ts`

```
/** Contact ids worth resolving, across any number of conversations. */
export function collectRosterContactIds(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): string[]

/** PURE. A roster with each name resolved per section 3's rungs 1-2. */
export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  resolved: ReadonlyMap<string, ContactDisplayItem>,
): ConversationParticipant[]

/** One batched resolve for a page, then withLiveNames per row. Never
 *  rejects: a degraded read yields a PARTIAL map and those members keep
 *  their stored names. */
export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: Pick<ContactsRepo, 'getDisplaysByIds'>,
  log: Logger,
): Promise<T[]>
```

Per member: `contactDisplayName(resolved.get(p.contactId))` if non-empty, else
`p.name`. A member with no `contactId` (bare phone, `''`) keeps its stored
name - there is no contact to resolve, and rung 3 is the client's job.
`phone` is never touched. Inputs are not mutated.

`resolved` is `ReadonlyMap<string, ContactDisplayItem>` with no `undefined`
values, matching the primitive (`contactsRepo.ts:597`) - round 2, R21.

### 5.2 Primitive: `getDisplaysByIds`

`contactsRepo.ts:600-605` states the rule: "Prefer `getDisplaysByIds` when only
a label is needed: same round trips, far less data." `DISPLAY_PROJECTION`
(`:856-865`) carries `contactId`, `firstName`, `lastName`, `phone`,
`deleted_at`. Six in-tree precedents: `routes/api.ts:2152`,
`routes/units.ts:970, :1167, :1262`, `routes/broadcasts.ts:231`,
`routes/aiRuns.ts:190`.

`contactDisplayName` is widened to accept both `ContactItem` and
`ContactDisplayItem`. Verified feasible: `ContactDisplayItem` declares
`firstName?: unknown; lastName?: unknown` (`contactsRepo.ts:296-302`), so the
existing bracket reads work unchanged. `routes/units.ts:118-129` is the worked
precedent for that typing. Its docblock at `lib/contactName.ts:50-60` -
currently "consumed by PUSH-COPY sites only" and "do not re-point them here as
a drive-by" - is amended in the same change.

`requireComplete` is NOT used anywhere in this branch. It exists on
`getManyByIds` only, and every consumer here is a label read, which is exactly
the case the repo's own guidance (`contactsRepo.ts:790-804`) assigns to the
short-map default. The one class that needed it - once-only outbound bodies -
is out of scope (2.2).

### 5.3 Soft-delete

A soft-deleted contact supplies NO name; such a member falls to rung 2. Matches
`lib/rosterResolution.ts:522`, `routes/api.ts:2095` and `routes/api.ts:2157`.
`isDeleted` accepts the display shape (`contactsRepo.ts:309-311`).

### 5.4 Any spec that inverts a commented rule must NAME the comment

Standing requirement, added because this happened three times across two review
rounds (`contactName.ts:50-60`, `relayGroups.ts:471-474`,
`rosterEdits.ts:437-441`). Every comment this branch makes wrong is amended in
the same commit that makes it wrong. The list is in each slice.

### 5.5 The thread-header route is NOT hydrated (read-cost ruling)

**Cameron, 2026-08-31: do not add reads unnecessarily, especially on
already-busy pages.** v3's first draft hydrated
`routes/api.ts:1993-2002` `GET /conversations/:id`. That is the worst place to
add a read - it is a zero-read passthrough refetched on a DEBOUNCED SSE TICK
for the life of an open thread (`useGroupThread.ts:16`,
`useRelayThread.ts:437`), and `GroupTextView.tsx:200-206` records a production
symptom from latency on a sibling per-tick read.

**It is also redundant.** Every view that fetches the header ALSO fetches a
dedicated contact-resolved roster route on the same mount:

| view | header | resolved roster |
|---|---|---|
| `ConversationDetail.tsx` | `:87` | `:212`, `:237` `/members` |
| `PlacementConversation.tsx` | `:286` | `:291` `/members` |
| `TourConversation.tsx` | `:430` | `:435` `/members` |
| `GroupTextView.tsx` | via parent | `/group-members`, and its `:74-80` docblock says that read "carries the roster-name CONVERGENCE ... so the header has to adopt them" |

So the thread views already receive fresh names through routes S2 hydrates
(`/members`) or that already resolve (`/group-members`). Hydrating the header
would pay a per-tick read for names the client already has.

KNOWN GAP, accepted rather than paid for: `PlacementDetail.tsx:370-375` and
`TourDetail.tsx:451-455` call `getConversation` WITHOUT a members call, to
build a `memberSummary` string for a close-the-group confirmation dialog. Those
names can be stale. It is a one-shot, user-action-triggered read on two pages
whose every other name comes from `useRoster` (hydrated free by S3), and a
possibly-stale name in a confirm dialog does not justify a per-tick read on
every open thread.

## 6. Slices

### S1 - Today (zero new reads)

`whoOfConversation` takes the conversation AND the already-memoized contact:

```
nameFromContact(contact) (non-empty)
  ?? conv.participant_display_name (non-empty)
  ?? formatPhoneForDisplay(conv.participant_phone)
  ?? ''
```

**It uses `nameFromContact` (`today.ts:222-228`), the file's own helper, NOT
`contactDisplayName`** (round 2, R15). The two differ - the canonical helper
trims each part before joining, `today.ts` joins first and trims the outside -
and `today.ts:224` is deliberately not re-pointed (round 1, A15) because it
also serves placement, tour and AI-suggestion rows outside this scope. Using
the canonical helper for Unreplied while Follow-ups kept the local one would
render a padded first name two ways ON THE SAME PAGE.

The contact is already in `contactCache`: `:743` gates every walked 1:1 on
`isDeletedContact(ownerId)` -> `getContact`, ahead of the cap, and
`whoOfConversation` runs at `:778`. Both reviewers verified this. No new read;
the `no lookup bound` rule at `:733` is preserved absolutely.

Also hydrate the relay close-nag `memberNames` (`:1001`) over the bounded
`listRelayGroups('open')` list.

CLIENT: `dashboard/src/routes/today/buildToday.ts` is the LIVE client-side
fallback, used only when `GET /api/today` fails (`useToday.ts:54-75`). On that
path there is no server `who` to prefer, so **it stays degraded by design** and
this spec says so. One fix ships there: `:106`'s bare `??` selects a stored
EMPTY display name; add the non-empty guard already used at
`webhooks/voice.ts:156-162`.

### S2 - Roster read boundaries

Every IN-SCOPE row in 4.2 outside S1/S3/S4. Each becomes: collect contactIds ->
one `getDisplaysByIds` -> map with `withLiveNames`. `groupRowFor` takes the
resolved map as a second argument rather than becoming async.

Two reconciliations:

- **`routes/api.ts:2017-2117`** keeps its converge-on-read write untouched. The
  new in-memory hydration is applied to the OTHER boundaries so they agree with
  it without adding a second writer. State the precedence in its comment.
- **`routes/relayGroups.ts:456-492`** stops deleting the stored name (rung 2)
  and is BATCHED with `getDisplaysByIds` (round 2, R5 - it is a `Promise.all`
  of per-member `getById` today, which violates section 3's own batching rule).
  Amend `:471-474`, and the two client notes at `recipientLabel.ts:95-99` and
  `groupThread.ts`, to state the three-rung chain.

**`GroupTextView.tsx:191-211`** reasons explicitly about served-vs-stored
inequality and a first-open re-title flicker. Once the header is hydrated its
`changed` flag goes permanently false. That is fine, but the comment stops
describing reality and is amended (round 1 A2's implication; round 2 R17 caught
that v2 dropped it).

COST NOTE: `api.ts:1993-2002` is a zero-read passthrough today, refetched on a
debounce per SSE tick (`useGroupThread.ts:16`, `useRelayThread.ts:437`), and
`GroupTextView.tsx:200-206` records a production symptom from latency on a
sibling per-tick read. Hydration there is one batch over ONE roster.

### S3 - `describeRoster` precedence flip (zero new reads)

`lib/rosterResolution.ts:544-545`, invert so the contact wins:

```
- nonEmpty(member.name) ?? (!removed && contact ? displayName(contact) : undefined)
+ (!removed && contact ? displayName(contact) : undefined) ?? nonEmpty(member.name)
```

The contact is already read at `:511`. The `removed` guard at `:522` is
unchanged.

`resolveRoster` (`:219-228`) itself is NOT changed (round 2, R8 - v2's table
and text contradicted each other here). Its non-preview callers read phones and
counts only, verified: `placementNudges.ts:505-506` uses `isOnRoster`,
`rosterActions.ts:322-326` checks `source`. Its preview callers are phase-b's
(2.2).

### S4 - The two free precedence flips

Both already hold the contact, so both cost ZERO reads (round 2, R3):

- `webhooks/twilio.ts:307-315` `pushSenderLabel` - handed `senderContact` at
  `:728` and `:1814-1818`.
- `webhooks/voice.ts:112-121` `maskedPartyLabel` - handed the matching contact
  at `:980-982` and `:990`.

**`maskedPartyLabel` adopts `contactShortName` ("First L.",
`lib/voiceMasking.ts:46-53`), NOT `contactDisplayName`** (round 2, R16).
`webhooks/voice.ts:144-146` states that the stored `call_party_label`, the
spoken whisper, thread rendering and the originate path all keep the MASKED
posture, and this output is PERSISTED into the message record at `:993-1002`.
This is a data change, not a render change, and it must not un-mask.

### S5 - Extend the drift audit to group rosters

`app/scripts/measure-unread-contact-coverage.ts`. **Removing the `:509` skip is
not sufficient** (round 2, B7): the walk is
`listByLastActivity({status:'open'})`, a native group thread's status is
`group_open` (`routes/inbox.ts:1216` `listGroupTexts`), and closed relay groups
live in the relay status partitions (`routes/contacts.ts:1158-1168`). A builder
who only deleted the `continue` would ship a pass reporting zero group rosters
and call the fix proven.

New sources: `listGroupTexts` plus `listRelayGroups` for `open`, `connecting`
and `closed`. Report, counts only, never names: rosters walked, members
carrying a contactId, members whose stored name is MISSING while the contact
has one, members whose stored name DIFFERS, and - sizing section 3's stated gap
- members whose `contactId` resolves to nothing.

## 7. The phone half stays as it is

**Cameron, 2026-08-31: document remove-and-re-add; change no code.**

`withLiveNames` touches `name` only. `lib/rosterResolution.ts:222-224` returns
the STORED phone verbatim because the fan-out sends to that number, so
deliverability and recipient counts derive from it; the live-remove path
follows it so removal works when the number is wrong.

`relay-stale-participant-phone` closes as documented behavior with the operator
procedure recorded.

**Note for bundle M3:** M1 changes NO phone source. Roster notification sends
continue to address `participants[].phone`, the stored row value.

## 8. `consolidate-contact-display-name-helpers`: corrected, stays open

The census was wrong in both directions and is rebuilt in the issue file:

- **`routes/inbox.ts:534-543` is NOT a trim variant** (round 1, A6/B2,
  BLOCKING). It has an extra rung the canonical helper lacks - a single
  denormalized `contact.name` field (`:540-542`). Re-pointing it would render
  those contacts NAMELESS: this branch's own bug on another surface.
- **`lib/voiceMasking.ts:46-53` is not a copy at all** - `contactShortName`
  returns "First L.", a deliberate privacy rule (`:42-44`).
- **Missing from the census:** `services/inboundEmail.ts:400-405` (named in
  `contactName.ts`'s own scope guard), `routes/placements.ts:165-171`, and the
  two email-path writers from 4.1.

**This branch re-points NOTHING as a drive-by.** The only `contactName.ts`
change is the widening in 5.2, with its docblock amended.

## 9. `today-contact-hydration-fan-out`: measure, then resolve

**`npm run perf:pages` cannot produce the number** (round 1, A5): it is a
Playwright browser-side network profiler (`e2e/performance/collect.ts`,
`routes.ts:240-320`) and instruments no repo call. The instrument is a
**repo-call counter in a test**, counting DISTINCT `contacts.getById` calls in
one `GET /api/today` against a representative seeded world.

This branch does not batch Today's memo; S1 adds zero reads to it. Recording
the number, and closing the issue wontfix if it is small, is the deliverable.

## 10. Tests

TDD, red before green.

- `participantNames.test.ts` (new): live name wins; stored name when the
  contact is absent from the map; stored name when the live name is empty;
  SOFT-DELETED contact supplies no name; **bare-phone member untouched** (now
  consistent - there is no phone rung, so this test and the mechanism agree,
  which round 2's R12 caught them not doing); `phone` never modified; input not
  mutated; **a PARTIAL map leaves unresolved members on their stored names**
  (not "a throwing batch" - `batchGetByIds` swallows and returns short,
  `contactsRepo.ts:839-844`).
- Today: stale snapshot + renamed contact renders the NEW name; unreadable
  contact renders the stored name; unlinked thread renders the formatted phone;
  **`contacts.getById` call count UNCHANGED** against the pre-change baseline.
  Note `app/test/todayApi.test.ts:345-346` pins a formatted phone for
  contactIds never seeded, so it does not break - and the suite has ZERO
  coverage of the rung S1 changes.
- Roster: `describeRoster` prefers the contact name; a `removed_contact` row
  keeps its stored name.
- Inbox + relay members: a group row's title and a member chip reflect a
  renamed contact; **assert UNIQUE ID COUNT, not method-call count** (rounds 1
  and 2, A9/B13 - `batchGetByIds` chunks at 100 with up to 4 attempts per
  chunk); ids collected AFTER the contact filter at `routes/contacts.ts:1265-1267`.
- `relayGroups.ts` members route: contact name wins; stored name on a read
  failure (the behavior change); no name at all when neither exists, so the
  client renders the number.
- Push/voice: `pushSenderLabel` prefers the contact; `maskedPartyLabel` prefers
  the contact AND stays masked ("First L."), with the persisted
  `call_party_label` pinned.
- Audit script: the group pass counts a seeded stale roster from BOTH
  `listGroupTexts` and `listRelayGroups`.

**Fixtures:** `lib/seed/performance.ts:842, 857-858` bake
`'Synthetic participant NNNN'` / `'Synthetic tenant'` / `'Synthetic landlord'`
against real contact ids, so those labels change under S1/S2 in the performance
lane. Update the seed or its assertions in the same change. `lean` and `cast`
were verified consistent by both reviewers, so e2e strings are safe - the
corollary being that lean cannot exercise this fix without a runtime rename,
which is what the e2e does.

**E2E:** rename a contact who is on a relay group and on an unread 1:1, then
assert (a) Today's row shows the new name, (b) the group thread header shows it
after a reload, (c) the contact page's relay-groups card shows it.
Accessibility-first selectors per `e2e/support/selectors.md`.

## 11. Risks

| risk | mitigation |
|---|---|
| Inbox read amplification | `getDisplaysByIds` projection; ids collected after filtering; test pins UNIQUE ID COUNT |
| Thread-header route gains a read on a per-tick SSE path | ELIMINATED - the header is not hydrated (5.5); the thread views already fetch a resolved roster |
| A degraded batch blanks names | short-map default; unresolved members keep stored names - today's behavior exactly |
| Merge conflict in `routes/relayGroups.ts` | phase-b co-edits a different function (2.2); sequence at merge time |
| A `group_text` roster whose panel is never opened stays stale | stated gap (3); S5 sizes it |
| A deliberately CLEARED name never disappears | stated limitation (3); deferred |
| Un-masking a persisted voice label | S4 pins `contactShortName` and the stored `call_party_label` |

## 12. Gates

All five, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.

Close the issue files per the dispositions at the top, file the deferrals named
in the two adjudication records, then run `npm run issues`.
