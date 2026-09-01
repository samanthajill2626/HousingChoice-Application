### 3.1 One population this branch does not fix - and one that turned out not to exist

**WITHDRAWN: the "merged stub" population never existed.** Rounds 1 (A1) and 3
(T6) both asserted that a roster `contactId` can point at a stub staff later
merged away, leaving rung 1 permanently missing. Round 4 (U1) withdrew it and
the planner verified the withdrawal:

- **There is no contact merge mechanism in the tree at all** - no merge route,
  service, or repo method.
- Triage is an IN-PLACE `PATCH /api/contacts/:contactId`
  (`routes/contacts.ts:1391`). The stub keeps its `contactId` and GAINS a name.
- `routes/api.ts:2029-2041` says only that "the SNAPSHOT goes stale" when a stub
  is triaged - the snapshot, never the id.

So the roster's `contactId` keeps pointing at the same contact, which now has a
name, and **rung 1 resolves it correctly**. There is no recurring gap, no
dangling-id population, and the branch is more complete than v3 and v4 claimed.
Recorded at length so nobody re-derives the phantom a third time: it survived
two review rounds and one planner acceptance before anyone checked whether the
mechanism it named exists.

This also retires round 1's A1 on its merits. The phone-resolution rung it
motivated was already dropped for independent reasons (unbatchable; up to two
round trips each; returns an arbitrary contact for duplicate phones), and those
reasons still stand.

**The one real uncovered population: bare-phone RELAY members.** Skipped at
`routes/relayGroups.ts:470` (`if (!member.contactId) return member;`), with no
phone resolver in this branch and no writer anywhere that refreshes them. They
keep today's behavior exactly - nothing regresses - and S5 sizes them.

# Participant name snapshots: resolve on read, display surfaces

Branch: `feat/participant-snapshot-refresh`
Worktree: `W:\tmp\participant-snapshot-refresh`
Bundle: M1 (docs/issues/_CLUSTERS.md, re-derived 2026-08-31 @5ce9912f)
Date: 2026-08-31
Revision: **v5**, after design review rounds 1-4 and four rulings from Cameron
(resolve-on-read; the three-rung chain; outbound content out; phase-b merges
first - 2.4).
Adjudications: `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/design-review/`
(`adjudications.md`, `-round2.md`, `-round3.md`, `-round4.md`).

| sev | issue | disposition |
|---|---|---|
| high | today-shows-phone-instead-of-name | CLOSED |
| high | group-roster-name-snapshot-never-refreshed | CLOSED for the operator-facing surfaces (titles, chips, cards, panels). NOT closed for the two group PUSH TITLES (2.3), the bare-phone relay members (3.1), or the close-group prompt cards at `PlacementDetail.tsx:370-375` / `TourDetail.tsx:453-455`, which 5.5 leaves unhydrated with no sibling roster fetch (round 4, U6). Outbound-content half is OWNED BY ANOTHER BRANCH (2.2). The Resolution stamp names all four. |
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

The work is to **put the surfaces this branch hydrates onto one rule, and
extend that rule to the display surfaces that have none.**

NOT a full reconciliation, deliberately: `routes/api.ts:2017-2117` keeps its own
three rules (resolve by phone, prefer contact, write back) untouched. Changing a
shipped converge mechanism is its own change with its own blast radius; this
branch reads AROUND it and says so rather than claiming a unification it does
not perform (round 3, T11).

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

CO-EDIT, precisely stated (round 3, T5 - the reviewer checked phase-b's PLAN
and not its commits, the mirror of the planner's own earlier error; both halves
verified):

- phase-b's PLAN has zero `relayGroups.ts` entries and its SPEC explicitly
  EXCLUDES that file (its `:653` table: "renders a group's scheduled sends, not
  the tour ladder").
- But it has already LANDED one commit there - `6328970e`, "discontinued reads
  on all read surfaces", in the scheduled-reminder block around `:333` -
  exceeding its own stated exclusion.

So: one landed edit, no further planned work, in a different function from this
branch's `:456-492`. A one-time textual merge, not ongoing contention.

### 2.4 MERGE ORDER: phase-b lands FIRST; this branch re-baselines against it

**Cameron, 2026-08-31.** A build instruction, not a note. It stands on its own;
what follows is the corrected account of what re-baselining actually involves.

**WITHDRAWN: the preview-pin collision does not exist.** v4 claimed S3's
`describeRoster` flip would fight phase-b's Task 14 re-baseline at
`relayGroupPreview.test.ts:151,208`, `toursApi.test.ts:3989-3998,4096` and
`placementsApi.test.ts:989,1007`, and built a field-by-field ritual and a
handback stop-block around it. Round 4 (U4/U5) withdrew it and the planner
verified the withdrawal - it is enforced by the TYPE:

- `services/rosterEdits.ts:138` types the preview-open owner as
  `Omit<RosterOwner, 'roster' | 'groupThreadId'>`. With no `groupThreadId`,
  `resolveRoster` can NEVER take its `participants` branch on those paths.
- It therefore always takes plan/default, where `memberFromContact`
  (`lib/rosterResolution.ts:172-180`) already builds the name from the CONTACT.
- S3 only reorders stored-vs-contact precedence, so on a path whose names are
  already contact-derived it is a structural no-op.

v4's trap warning was also wrong on its own terms (U5): those pins are separate
`expect` statements whose expected values are composer CALLS at assert time, not
literal strings in a shared fixture, and `rosterEdits.ts:425-441` is an
interface declaration, not a fixture. There is no green-but-wrong whole-fixture
rewrite to guard against. Both the ritual and the stop-block are deleted.

**What re-baselining DOES involve, verified:**

1. **phase-b merges first.** This branch takes it at the single pre-handback
   `main` sync.
2. **Every `routes/relayGroups.ts` line number in this spec will be stale**
   (round 4, U7). phase-b's landed `6328970e` inserts ~13 lines above this
   branch's edit site, so `:456-492` and `:470` shift by roughly that much.
   **Re-derive them after the sync by symbol name** (`GET /conversations/:id/members`,
   `memberWithoutStoredName`) rather than trusting any number written here.
3. **`app/test/relayApi.test.ts` is a genuine test co-edit** (round 4, U12):
   `6328970e` touches it around `:1505`, which is where this branch's
   members-route tests land. Expect a textual merge there; there is no semantic
   interaction.
4. If phase-b has NOT merged at handback time, say so in the handback and
   report the branch as sequenced-behind-it. Do not block on it - with the
   collision withdrawn there is nothing to re-baseline against except line
   numbers.

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
  rides the same `RosterPreview` object `rosterEdits.ts` builds. That is
  phase-b's file, but phase-b's plan has NO task for this reader (round 3,
  T12), so it must not be handed to that branch by assumption: **a new issue is
  filed for it in this branch**, naming the shared `RosterPreview` and the
  stale `memberNames` at `:128-132`.

## 3. The rule

**Cameron, 2026-08-31**, refined across two exchanges:

```
1. the live contact's name, when it is readable and non-empty
2. else the STORED snapshot name, when there is one
3. else the formatted phone number
```

Rung 3 is the COMMON client fallback, not a universal one
(`dashboard/src/lib/groupThread.ts` `groupMemberLabel`: "full name, else
formatted number"), so on most surfaces a server that returns no name still
renders a number rather than a blank. TWO EXCEPTIONS, named because v3 claimed
otherwise (round 3, T10): `dashboard/src/routes/shared/rosterPeople.ts:28`
falls back to a contact ID, and the relay `senderLabel` renders nothing at all
by design (the outbound rule: names, never a number). Neither is changed here. That preserves the
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

### 3.1 Two populations this branch does NOT fix, and the gap RECURS

Stated plainly because v3 got this wrong in the direction that flatters the
branch (round 3, T6/T7; the first was planner-verified in the code).

**Population 1 - a roster `contactId` pointing at a merged-away stub.**
Detection mints a REAL contact row for an unseen member
(`services/groupMembers.ts:105-119`); when staff later triage that stub into a
real contact, the roster keeps pointing at the stub. Rung 1 then resolves to a
NAMELESS contact and falls to rung 2.

v3 claimed the existing converge-on-read write owns this case. **It does not.**
`routes/api.ts:2099-2114` writes `{ ...p, name }` - `name` ONLY, never
`contactId`. So the dead id survives every write-back, and **rung 1 misses
again on the next rename, and every rename after that.** The gap RECURS per
rename; it does not heal. Its owner is bundle M8
(`participants[].contactId` ownership), which is fenced (2.3).

**Population 2 - bare-phone RELAY members.** Skipped at
`routes/relayGroups.ts:470` (`if (!member.contactId) return member;`), with no
phone resolver in this branch and no writer anywhere that refreshes them.

Both keep today's behavior exactly - nothing regresses - and S5 sizes both.

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

**Rung 1** never serves a soft-deleted contact's name; such a member falls to
rung 2. Matches `lib/rosterResolution.ts:522`, `routes/api.ts:2095` and
`routes/api.ts:2157`. `isDeleted` accepts the display shape
(`contactsRepo.ts:309-311`).

**Rung 2 MAY still serve one, and that is a stated limitation** (round 3, T2):
`routes/api.ts:2086` derives its name with no deleted check and `:2099-2114`
writes it into the stored snapshot, which IS rung 2. Adding a deleted check
there means changing a shipped converge mechanism this branch deliberately does
not touch (2.1). So the posture is: rung 1 is clean, rung 2 inherits whatever
that write seeded.

### 5.4 Any spec that inverts a commented rule must NAME the comment

Standing requirement, added because this happened three times across two review
rounds (`contactName.ts:50-60`, `relayGroups.ts:471-474`,
`rosterEdits.ts:437-441`) - and then a FOURTH time in the very commit that
wrote the rule (round 3, T13): S3 makes `rosterEdits.ts:425-426` and `:437-441`
stale and v3 did not list them. They are listed in S3 now.

Every comment this branch makes wrong is amended in the same commit that makes
it wrong. The list is in each slice, and a slice with no such comment says so
explicitly rather than staying silent.

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

**`GroupTextView.tsx:191-211`** reasons about served-vs-stored inequality and a
first-open re-title flicker. v2 and v3 both said this branch makes its `changed`
flag permanently false and required amending the comment to say so. **That
requirement is withdrawn** (round 3 T8, round 4 U1): 5.5 dropped header
hydration entirely, so the premise is gone, and the contactId-vs-phone
divergence T8 offered as a second reason rested on the merged-stub population
3.1 retires.

**No amendment is needed here.** The comment describes behavior that continues
unchanged, because this branch does not touch that route or the header it
titles from. Recorded explicitly per 5.4's rule that a slice with no stale
comment says so rather than staying silent.

(v3's COST NOTE about hydrating `api.ts:1993-2002` is DELETED - 5.5 forbids
that hydration and 4.2 marks the route NOT HYDRATED, so the note contradicted
both. Round 4, U11.)

### S3 - `describeRoster` precedence flip (zero new reads)

`lib/rosterResolution.ts:544-545`, invert so the contact wins:

```
- nonEmpty(member.name) ?? (!removed && contact ? displayName(contact) : undefined)
+ (!removed && contact ? displayName(contact) : undefined) ?? nonEmpty(member.name)
```

The contact is already read at `:511`. The `removed` guard at `:522` is
unchanged.

COMMENTS THIS SLICE MAKES STALE: **none** (round 4, U9 + U4). v4 required
amending `services/rosterEdits.ts:425-426` and `:437-441`, which was
unreachable - 2.2 forbids touching that file - and is now also unnecessary: 2.4
established that S3 is a structural no-op on the preview paths those comments
describe, so they stay true. 5.4 requires a slice with no stale comment to say
so explicitly rather than stay silent; this is that statement.

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

Its rung 2 is **MASKED, not dropped** - v4 said "no rung 2" and that was a
REGRESSION (round 4, U3). `maskedPartyLabel` (`webhooks/voice.ts:116-121`) is
total by construction: `member.name` -> role -> `'the other party'`. Dropping
rung 2 would send a bare-phone member - 3.1's real uncovered population, who
has no contact and therefore no role - from their stored name straight to
"the other party", in a PERSISTED `call_party_label`. That is a regression on
exactly the people the spec says nothing regresses for.

T9's underlying point still holds and is honoured a different way: a privacy
posture cannot be contingent on a read succeeding. So rung 2 applies the SAME
short-name transform to the stored string that `contactShortName` applies to a
contact - "First Last" stored becomes "First L." rendered. Masked either way,
and nobody loses a label they have today. The chain: masked contact name, else
masked stored name, else the existing role / "the other party" rungs untouched.
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
and `closed`. Report, counts only, never names:

1. rosters walked;
2. members carrying a contactId;
3. members whose stored name is MISSING while the contact has one;
4. members whose stored name DIFFERS from the contact's;
5. members whose `contactId` resolves to NOTHING (a dangling id);
6. members carrying NO `contactId` at all - the bare-phone population 3.1
   names as the one this branch does not reach.

**The metric v4 called "metric 6" is DELETED** (round 4, U1/U2). It was added
in round 3 to size a merged-stub population that does not exist (3.1), and
round 4 showed that even for its imagined target it had no discriminating
power: it would false-POSITIVE on the modeled shared-handset and phone-pointer
states, and false-NEGATIVE arbitrarily via `contactsRepo.ts:1011-1016`, which
returns the first GSI item for a duplicate phone in arbitrary order.

Deleting it also removes the only `findByPhone` the spec had left anywhere.
**This branch now contains no phone-keyed name resolution at all**, in request
paths or offline scripts.

**RUN IT TWICE** (round 3, T14): once at the branch's merge base, once at
handback. Both numbers go in the handback, because "measured, then resolved"
needs a before as well as an after.

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
| Merge conflict in `routes/relayGroups.ts` and `app/test/relayApi.test.ts` | phase-b merges FIRST (2.4); re-derive line numbers by SYMBOL after the sync - they shift ~13 lines |
| A deliberately CLEARED name never disappears | stated limitation (3); deferred |
| ONE push carries two name sources: a FRESH body sender (S4) and a STALE title (2.3) - a disagreement `main` does not have | ACCEPTED, not mitigated (round 3, T4). The only in-scope way to remove it is to drop S4's free flip, which buys consistency by keeping a known-wrong name. A fresh sender beside a stale title is strictly better than both stale. Restored to this table because v3 deleted the row rather than arguing it. |
| Re-baselining silently reverts phase-b's landed body strings | field-by-field re-baseline plus a byte-diff against its merge commit (2.4 step 4) - all tests stay GREEN either way, so the test suite cannot catch this one |
| Bare-phone relay members are never refreshed | the one real uncovered population (3.1); no regression, and S5 sizes it before and after |
| Rung 2 may serve a SOFT-DELETED contact's name | stated limitation (5.3), seeded by a write-back this branch does not own. Test pins the current behavior so a future change to that route is a visible diff, not a surprise (round 4, U10) |
| Un-masking a persisted voice label | S4 pins `contactShortName`, takes no rung 2, and pins the stored `call_party_label` |
| A padded name renders two ways inside one `group_text` thread | COSMETIC residue, accepted (round 3, T15): `routes/api.ts:2083` trims the outer join, `contactDisplayName` trims part-wise. Fixing it means editing that route's derivation, which 2.1 excludes. |

## 12. Gates

All five, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.

Close the issue files per the dispositions at the top, file the deferrals named
in the two adjudication records, then run `npm run issues`.
