# Participant name snapshots: reconcile on read

Branch: `feat/participant-snapshot-refresh`
Worktree: `W:\tmp\participant-snapshot-refresh`
Bundle: M1 (docs/issues/_CLUSTERS.md, re-derived 2026-08-31 @5ce9912f)
Date: 2026-08-31
Revision: v2, after design review round 1 (adjudications at
`docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/design-review/adjudications.md`)

Closes five issues:

| sev | issue |
|---|---|
| high | today-shows-phone-instead-of-name |
| high | group-roster-name-snapshot-never-refreshed |
| med | relay-stale-participant-phone (documented, no code change - see 8) |
| low | consolidate-contact-display-name-helpers (corrected, NOT closed - see 9) |
| low | today-contact-hydration-fan-out (measured, then resolved - see 10) |

---

## 1. Problem

A conversation row stores a COPY of each participant's name, taken when the
row was written:

- `participant_display_name` - the 1:1 thread's copy.
- `participants[].name` - one copy per member of a group roster.

Measured 2026-08-25 with
`app/scripts/measure-unread-contact-coverage.ts --confirm --audit-denorm`
(script output against live tables; not reproducible from the tree):

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| contact HAS a name, thread carries none | 592 | 579 |
| thread name differs from the contact's | 0 | 2 |

Two founder-observed symptoms:

1. Today's Needs-you-now and Unreplied rows render a phone number where the
   operator should see a person (~85% of open threads).
2. Renaming a contact does not change group conversation titles or member
   chips, and the OLD name can reach outbound message content.

## 2. What this actually is

**Not "add resolve-on-read". Resolve-on-read for rosters ALREADY SHIPS, in
three inconsistent forms, and one of them writes back.** This was the largest
finding of design review round 1 (A2/B1, BLOCKING, found independently by both
reviewers and verified by the planner against the code).

| site | what it does today |
|---|---|
| `routes/api.ts:2017-2117` `GET /conversations/:id/group-members` | resolves by PHONE, prefers the contact name, and WRITES the roster back via `backfillGroupTextRoster` (`:2099-2114`). `group_text` only; 404s otherwise. |
| `routes/relayGroups.ts:456-492` `GET /conversations/:id/members` | resolves by contactId, and DELETES the stored name - no fallback. `relay_group` only. |
| `lib/rosterResolution.ts:544-545` `describeRoster` | resolves the contact but lets the STORED name win - the precedence inverted. |
| everything else | reads the raw snapshot. |

So the work is: **reconcile these into one rule, extend it to the surfaces
that have none, and stop the 1:1 field being trusted where a contact is
already in hand.**

## 3. The decisions

**Cameron, 2026-08-31.**

1. **Resolve on read, everywhere.** Every surface resolves the name from the
   contact record when it renders.
2. **Batch the lookups.** One batch read per page, never one per member.
3. **On a read failure, fall back to the stored name.** Confirmed a second
   time on 2026-08-31 after review round 1 surfaced that
   `routes/relayGroups.ts:474-476` deliberately does the opposite.
   **That route changes to match**: the live contact still outranks the
   snapshot whenever it is readable - which is all its comment at `:471-473`
   actually argues - and the snapshot is used only when the contact cannot be
   read at all. One rule in the tree.

Refresh-on-write was NOT chosen as the primary strategy. The existing
write-side mechanisms are not removed (see 7.1), but nothing new is added:
the tree already demonstrates that a write-side approach drifts into
inconsistent implementations, which is the state this spec is repairing.

**What the mechanism actually guarantees** (narrowed per B10): "resolve a
NON-EMPTY live name, else the stored snapshot". It cannot distinguish a failed
read from an absent contact from a contact whose name was deliberately
CLEARED, so clearing a wrongly-auto-captured name leaves the stored one
rendering. That limitation is stated, not fixed here; the primitive change it
needs is deferred to `contacts-batchget-amplified-reads`.

## 4. Complete surface enumeration

The round-1 risk table claimed the section-3 tables were "the enumeration" and
was wrong on both fields. These tables are the enumeration; every line was
opened by a reviewer or the planner.

### 4.1 `participant_display_name` (the 1:1 copy)

READERS:

| site | surface |
|---|---|
| `routes/today.ts:1076` | Today's `who` - THE anchor bug |
| `routes/webhooks/twilio.ts:1043` | inbound push title (closed-group intercept) |
| `routes/webhooks/twilio.ts:2285` | inbound push title (main path) |
| `routes/webhooks/voice.ts:159` | `pushCallerIdentity` - caller ID on a ringing phone |
| `routes/api.ts:457` | `toConversationSummary` passthrough |
| `lib/events.ts:103` | SSE `conversation.updated` payload |
| `dashboard/src/routes/today/buildToday.ts:106` | client-side fallback assembly |

The three push sites already read
`contactDisplayName(contact) ?? non-empty snapshot ?? phone`. **That is the
blessed pattern for the 1:1 chain only** - round 1 (B5) established it is
FALSE for the group/relay chain, see 4.2.

WRITERS: `routes/contacts.ts:1753` (the identity fan-out),
`routes/contacts.ts:1871` (create-conversation), `jobs/placementNudges.ts:554`.
The fan-out finds threads by the contact's CURRENT phone
(`routes/contacts.ts:1738`), so correcting a number orphans the old thread
from every future fan-out.

### 4.2 `participants[].name` (the roster copy)

READERS - server, operator- or recipient-facing:

| site | surface | in scope |
|---|---|---|
| `routes/api.ts:1993-2002` | `GET /conversations/:id` - raw passthrough feeding four client readers | YES (S2) |
| `routes/api.ts:2190-2198` | `GET /calls/:callId` - sibling raw passthrough | YES (S2) |
| `routes/api.ts:2017-2117` | group-members panel (already resolves; reconcile) | YES (S2) |
| `routes/relayGroups.ts:456-492` | relay members panel (already resolves; add fallback) | YES (S2) |
| `routes/inbox.ts:1237, 2358` | `groupRowFor` - SYNCHRONOUS, zero reads today | YES (S2) |
| `routes/inbox.ts:1154, 2293, 1418` | `relayRowFor` | YES (S2) |
| `routes/contacts.ts:1213, 1295` | relay-groups + group-texts cards | YES (S2) |
| `routes/today.ts:1001` | relay close-nag `memberNames` | YES (S1) |
| `routes/webhooks/twilio.ts:1810` | group inbound PUSH TITLE (`groupThreadLabel`) | YES (S6) |
| `routes/webhooks/twilio.ts:1815` | push SENDER label | YES (S6) |
| `routes/webhooks/twilio.ts:727` | relay inbound push title (`relayThreadLabel`) | YES (S6) |
| `routes/webhooks/twilio.ts:307-315` | `pushSenderLabel` - snapshot FIRST, backwards | YES (S6) |
| `routes/webhooks/voice.ts:112-121` | `maskedPartyLabel` - snapshot FIRST, backwards; relay caller identity | YES (S6) |
| `jobs/relayFanOut.ts:405` | sender prefix on every relayed message | YES (S4) |
| `jobs/relayFanOut.ts:634` | group INTRO body (delivered SMS) | YES (S4) |
| `jobs/relayFanOut.ts:685` | member-added body (delivered SMS) | YES (S4) |
| `services/rosterEdits.ts:472-473, 672-676` | the operator PREVIEW of those two bodies | YES (S4) |
| `lib/rosterResolution.ts:219-228` | `resolveRoster` copies `p.name` verbatim to every caller | YES (S3) |
| `routes/poolNumbersAdmin.ts:109` | admin `serverLabel` | NO - deferred, staff-admin only |
| `services/relayGroupDuplicates.ts:129-130` | duplicate-group warning | NO - deferred |
| `services/groupSend.ts:253`, `routes/tours.ts:1351-1354` | send-path member name | NO - reads a roster written seconds earlier |

READERS - client, all fed by the passthroughs above and therefore fixed by
hydrating them, with NO client edit:
`dashboard/src/lib/groupThread.ts` (computes the title client-side from
`header.participants`), `routes/conversation/GroupTextView.tsx:98-105, 313,
505`, `routes/conversation/ConversationDetail.tsx:159, 180`,
`lib/memberAttribution.ts:77, 120`, `routes/contact/GroupTextsCard.tsx`,
`routes/placements/PlacementDetail.tsx:372-375`,
`routes/tours/TourDetail.tsx:453-455`, `routes/contact/Timeline.tsx:378`,
`routes/quickReply/QuickReply.tsx:53-61`, `routes/shared/rosterPeople.ts:28`.

WRITERS: `routes/api.ts:2107` (`backfillGroupTextRoster`),
`services/groupConvert.ts:428, :504` (`backfillRosterNames`),
`services/relayMembers.ts:47-49` (`resolveMemberName`, at member-add),
`jobs/relayFanOut.ts:465-471` (stores `name` into `relay_opted_out_members`,
read by `routes/today.ts:606-613`).

## 5. Mechanism

**Replace the roster name with the live contact name IN MEMORY at each read
boundary, then hand the existing label functions the fresher array
unchanged.** `groupThreadLabel`, `relayThreadLabel`, `relayMemberLabels`,
`describeRoster` and `composeIntroBody` keep their signatures and their tests.

This is true only of boundaries this spec hydrates. Two known readers are
deliberately left on stale data (`poolNumbersAdmin.ts:109`,
`relayGroupDuplicates.ts:129`); both are staff-admin surfaces, both are
deferred to the registry, and neither shares a rendered thread with a
hydrated surface.

### 5.1 New module: `app/src/lib/participantNames.ts`

```
/** Ids and phones worth resolving, across any number of conversations. */
export function collectRosterKeys(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): { contactIds: string[]; phones: string[] }

/** PURE. A roster with each name replaced by the live contact's. */
export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  resolved: ReadonlyMap<string, ContactDisplayItem | undefined>,
  byPhone?: ReadonlyMap<string, ContactDisplayItem | undefined>,
): ConversationParticipant[]

/** One batched resolve for a page of conversations, then withLiveNames per
 *  row. Never rejects: a degraded read yields a PARTIAL map and the
 *  unresolved members keep their stored names. */
export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: Pick<ContactsRepo, 'getDisplaysByIds' | 'findByPhone'>,
  log: Logger,
  opts?: { phoneFallbackCap?: number },
): Promise<T[]>
```

Resolution order per member:

```
1. resolved.get(p.contactId)      -> contactDisplayName, if non-empty
2. byPhone.get(p.phone)           -> contactDisplayName, if non-empty
3. p.name                         -> the stored snapshot
```

**Rung 2 is not optional** (A1, BLOCKING). `services/groupConvert.ts:189-200`
fills a missing `contactId` with `contactIdForPhone(member.phone)`, a DERIVED
id, and the decisive case is the one `routes/api.ts:2029-2041` names: staff
triage a nameless stub into a REAL contact, and the roster's `contactId` keeps
pointing at the stub. Phone-keyed resolution survives that; id-keyed does not.
The shipped fix at `api.ts:2058` resolves by phone for exactly this reason.

**`BatchGetItem` cannot read the `byPhone` GSI** (`repos/contactsRepo.ts:806-808`),
so rung 2 cannot be batched. It is therefore:

- attempted ONLY for members whose contactId rung missed,
- issued as serial `findByPhone` calls,
- **capped** at `phoneFallbackCap` (default 25 per hydration call). Past the
  cap the remaining members keep their stored names and a
  `warnIfCapped`-style WARN fires. Without the cap, a page of fully-stale
  rosters would fan out unboundedly on the inbox route - the amplification
  class this repo has been burned by twice.

### 5.2 Batch primitive: `getDisplaysByIds`, not `getManyByIds`

`repos/contactsRepo.ts:600-605` states the rule: "Prefer `getDisplaysByIds`
when only a label is needed: same round trips, far less data."
`DISPLAY_PROJECTION` (`:856-865`) carries `contactId`, `firstName`,
`lastName`, `phone`, `deleted_at` - everything needed, `deleted_at` included.
Six in-tree precedents: `routes/api.ts:2152`, `routes/units.ts:970, :1167,
:1262`, `routes/broadcasts.ts:231`, `routes/aiRuns.ts:190`.

`contactDisplayName` must therefore accept BOTH shapes. `routes/units.ts:118-129`
is the worked precedent for that typing.

### 5.3 Soft-delete posture (B11)

`getDisplaysByIds` does not filter soft-deleted contacts. **A soft-deleted
contact's name is NOT used**; such a member falls through to the stored
snapshot. This matches `lib/rosterResolution.ts:522` (`removed`),
`routes/api.ts:2095` and `routes/api.ts:2157`, which all refuse to hydrate a
display name from a deleted contact.

### 5.4 Absence handling, per consumer class

`getDisplaysByIds` returns a SHORT map on a throttle or a chunk failure - it
does not throw (`repos/contactsRepo.ts:839-844`). That is the repo's
documented default for label reads, and it is correct for every DISPLAY
surface here: an unresolved member keeps its stored name, which is exactly
today's behavior.

**It is NOT correct for the two once-only outbound bodies** (B4, BLOCKING).
`composeConnectionSentence` (`jobs/relayFanOut.ts:189-206`) DROPS every
nameless member and substitutes a count, `composeIntroBody` (`:217-221`) and
`composeMemberAddedBody` (`:238-250`) both route through it, and the intro is
idempotent behind a job execution marker (`:615-622`) - sent once, never
recomposed. A throttled batch would therefore turn "connected with Alice, Bob
and Carol" into "connected with 2 other people" **permanently**, in delivered
SMS.

So those two sites use `getManyByIds({ requireComplete: true })` and let
`IncompleteBatchReadError` fail the job, so redelivery retries. This is the
repo's own documented split: "an absent key changes an OUTCOME rather than a
label".

## 6. Per-surface work

### S1 - Today (high; zero new reads)

`routes/today.ts`. `whoOfConversation` takes the conversation AND the
already-memoized contact:

```
contactDisplayName(contact) (non-empty)
  ?? conv.participant_display_name (non-empty)
  ?? formatPhoneForDisplay(conv.participant_phone)
  ?? ''
```

The contact is already in `contactCache`: `:743` gates every walked 1:1 on
`isDeletedContact(ownerId)` -> `getContact`, ahead of the cap, and
`whoOfConversation` runs at `:778`. Both reviewers verified this
independently. No new read, no new bound; the `no lookup bound` rule at
`:733` is preserved absolutely.

Also hydrate the relay close-nag `memberNames` (`:1001`) over the bounded
`listRelayGroups('open')` list.

**`routes/today.ts:224` `nameFromContact` is NOT re-pointed** (A15): it feeds
`resolveContactLabel` (`:370-373`), which produces `who` for placement
(`:448, :497, :522`), tour (`:554`) and AI-suggestion (`:961`) rows this spec
does not touch.

**Client (A12/B9):** `dashboard/src/routes/today/buildToday.ts` is the LIVE
client-side fallback, used only when `GET /api/today` fails
(`useToday.ts:54-75`). On that path there is no server `who` to prefer, so the
fallback stays degraded BY DESIGN and this spec says so rather than pretending
otherwise. One fix does ship there: `:106`'s bare `??` selects a stored EMPTY
display name, the defect already guarded at `webhooks/voice.ts:156-162`. Add
the non-empty guard.

### S2 - Roster read boundaries (high)

Every YES row in 4.2's server table outside S1/S4/S6. Each becomes: collect
keys -> one `getDisplaysByIds` (+ capped phone fallback) -> map with
`withLiveNames`. `groupRowFor` takes the resolved map as a second argument
rather than becoming async, keeping it pure and testable.

Two reconciliations, both required:

- **`routes/api.ts:2017-2117`** already resolves and WRITES BACK. Hydration
  must not race that write. The route keeps its converge-on-read write
  (removing it is out of scope, 7.1); the new in-memory hydration is applied
  to the OTHER boundaries so they agree with this one without a second
  writer. State the precedence explicitly in the code comment.
- **`routes/relayGroups.ts:474-476`** stops deleting the stored name and
  falls back to it on a read failure, per the 2026-08-31 ruling in section 3.
  Its comment at `:471-473` is amended to say what now holds: the contact
  outranks the snapshot whenever readable; the snapshot serves the
  unreadable case.

`GET /conversations/:id` (`api.ts:1993-2002`) and `GET /calls/:callId`
(`:2190-2198`) are the passthroughs feeding the client readers, including
`QuickReply.tsx`, which renders a recipient name to the founder's phone.

**Cost note (A10):** `api.ts:1993-2002` is a zero-read passthrough today and
is refetched on a debounce per SSE tick (`useGroupThread.ts:16`,
`useRelayThread.ts:437`). `GroupTextView.tsx:200-206` records a production
symptom from latency on a sibling per-tick read. Hydration there is one
batch over ONE conversation's roster - small, but it is a new read on a
per-tick path and it is in the risk table.

### S3 - `describeRoster` precedence flip (high; zero new reads)

`lib/rosterResolution.ts:544-545`. Invert so the contact wins:

```
- nonEmpty(member.name) ?? (!removed && contact ? displayName(contact) : undefined)
+ (!removed && contact ? displayName(contact) : undefined) ?? nonEmpty(member.name)
```

The contact is already read at `:511`. The `removed` guard at `:522` stays
exactly as it is (spec 5.2 DANGLING IDS).

`resolveRoster` (`:219-228`) copies `p.name` verbatim to callers beyond
`describeRoster`. Those callers read phones and counts
(`jobs/tourReminders.ts:1152-1162`, verified by both reviewers to read no
name), except the roster-edit previews - which S4 covers.

### S4 - Relay outbound content and its previews (high)

| site | change | absence rule |
|---|---|---|
| `jobs/relayFanOut.ts:405` sender prefix | ONE `getDisplayById` for the sender, gated on `payload.senderNameOverride` being ABSENT and `senderMember.contactId` being non-empty (A18, B14). Wrapped: a throw must not fail delivery of a message that would otherwise send with a stale prefix. | fallback |
| `jobs/relayFanOut.ts:634` intro body | roster batch | `requireComplete` (5.4) |
| `jobs/relayFanOut.ts:685` member-added body | roster batch | `requireComplete` (5.4) |
| `services/rosterEdits.ts:472-473` intro PREVIEW | same batch, same rule | `requireComplete` |
| `services/rosterEdits.ts:672-676` member-added PREVIEW | same batch, same rule | `requireComplete` |

**The previews are not optional** (B16). They compose from the stored roster
while S4 hydrates the job bodies, so without them the text an operator
CONFIRMS and the text the group RECEIVES can differ by name - and
`relayFanOut.ts:633` honours a persisted operator-edited `intro_body`
verbatim, so an operator who edits a stale-named preview pins the stale names
past this fix.

**Honest cost/benefit** (A11): the intro and member-added rosters were written
by `resolveMemberName` (`services/relayMembers.ts:47-49`) on the create/add
path itself, so their stored names are often seconds old. The drift these two
sites catch is narrow: a rename between provisioning and the job firing, or a
group whose intro was deferred by quiet hours. The genuinely stale site is the
sender prefix, which is read for the LIFE of the group - and it is the one
that adds a per-message read.

The founder ruling in `lib/groupTitle.ts` holds unchanged: outbound content
carries names and NEVER a phone.

### S5 - Push and voice labels (high)

`routes/webhooks/twilio.ts:307-315` (`pushSenderLabel`) and
`routes/webhooks/voice.ts:112-121` (`maskedPartyLabel`) put the roster
SNAPSHOT first and the contact second - the precedence S3 calls backwards.
`twilio.ts:727, :1810, :1815` render `groupThreadLabel` / `relayThreadLabel`
/ a raw roster name straight to a lock screen.

All five adopt the section-3 rule. Without them, the same thread is titled
"With Alice & Bob" in the inbox and "With (555) 010-0002" in the push for the
same event - the exact one-thread-many-names divergence
`lib/groupTitle.ts:1-16` exists to prevent (B6).

### S6 - Extend the drift audit to group rosters

`app/scripts/measure-unread-contact-coverage.ts`. **Removing the `:509` skip
is not sufficient** (B7): the query walks
`listByLastActivity({ status: 'open' })`, a native group thread's status is
`group_open` (`lib/seed/lean.ts:242`, `routes/inbox.ts:1216` `listGroupTexts`),
and closed relay groups live in the relay status partitions
(`routes/contacts.ts:1158-1168`). A builder who only deleted the `continue`
would ship a pass reporting zero group rosters and call the fix proven.

The group pass needs NEW SOURCES: `listGroupTexts` plus `listRelayGroups` for
`open`, `connecting` and `closed`. Report, counts only, never names: rosters
walked, members carrying a contactId, members whose stored name is MISSING
while the contact has one, members whose stored name DIFFERS.

## 7. Non-goals, stated so a reviewer can contest them

### 7.1 The existing writers stay

`backfillGroupTextRoster`, `backfillRosterNames` and `resolveMemberName` are
left running. They converge the snapshot toward the contact, which is the
same direction this spec reads in, so they cannot fight it - they only make
the fallback rung fresher. Removing them is a separate change;
`participants[].contactId` ownership is bundle M8.

### 7.2 A rename does not live-update an open thread

No write happens on rename, so no `conversation.updated` fires for group
threads and an open thread view does not refresh until its next fetch. Names
are correct on next load.

A notification-only event was rejected on cost: `routes/contacts.ts:1158-1168`
documents that there is NO member->conversation index, so finding a contact's
group threads requires walking TWO relay status partitions plus the group-text
partition. Paying that on every contact PATCH to animate a rare rename is a
bad trade.

**This remains the item to change if Cameron disagrees.**

### 7.3 The SSE payload is not hydrated

`lib/events.ts` `toConversationUpdatedEvent` is a pure sync builder with
byte-identical pinned tests, on the message hot path. Both reviewers confirmed
no dashboard consumer patches a name from its payload; they debounce-REFETCH
(`EventStreamProvider.tsx:176-178`, `useGroupThread.ts:16`,
`useRelayThread.ts:9`), and the refetch gets hydrated data.

### 7.4 Fenced files

`lib/unreadFeed.ts` and the Unknown-tab walk in `routes/inbox.ts` (M6,
T-UNREAD-GEN); `participants[].contactId` ownership (M8);
`jobs/tourReminders.ts` and `routes/contactTimeline.ts` (the live
`tour-reminder-ladder-phase-b` worktree). Verified: `tourReminders.ts:1151-1162`
reads `members.length` and `pool_number` only, never `.name`.

## 8. The phone half stays as it is

**Cameron, 2026-08-31: document remove-and-re-add; change no code.**

`participants[].phone` is not hydrated by anything here; `withLiveNames`
touches `name` only. `lib/rosterResolution.ts:222-224` returns the STORED
phone verbatim because the fan-out sends to that number, so deliverability and
recipient counts derive from it; the live-remove path follows it so removal
works when the number is wrong.

`relay-stale-participant-phone` closes as documented behavior with the
operator procedure recorded.

**Note for bundle M3:** M1 changes NO phone source. Roster notification sends
continue to address `participants[].phone`, the stored row value.

## 9. `consolidate-contact-display-name-helpers`: corrected, barely touched

Round 1 found the round-0 census wrong in both directions.

- **`routes/inbox.ts:534-543` is NOT a trim variant** (A6/B2, BLOCKING). It
  has an extra rung the canonical helper lacks: after the first/last join
  fails it reads a single denormalized `contact.name` field (`:540-542`).
  Re-pointing it onto `contactDisplayName` would render every such contact
  NAMELESS - this branch's own bug, reintroduced on another surface. **It is
  not re-pointed.**
- **`routes/today.ts:224` is not re-pointed** either (A15, S1).
- **`lib/voiceMasking.ts:46-53` is not a copy at all**: `contactShortName`
  returns "First L.", a deliberate privacy rule (`:42-44`).
- **Two copies were missing** from the census: `services/inboundEmail.ts:400-405`
  (named in `lib/contactName.ts`'s own scope guard) and
  `routes/placements.ts:165-171`.

**Scope for this branch:** re-point NOTHING as a drive-by. The only
`contactName.ts` change is the one this spec forces - widening
`contactDisplayName` to accept the display projection (5.2) - and its docblock
at `:50-60` is amended in the same change, because that comment currently says
"consumed by PUSH-COPY sites only" and "do not re-point them here as a
drive-by", and a builder following the code and a builder following this spec
would otherwise do opposite things (A20/B18/B22).

The issue file is updated with the corrected census and the trim/no-trim
split, and **stays open**.

## 10. `today-contact-hydration-fan-out`: measure, then resolve

Its own text: "If N is small, CLOSE THIS as wontfix and say so - that outcome
is a success."

**`npm run perf:pages` cannot produce N** (A5): it is a Playwright
browser-side network profiler (`e2e/performance/collect.ts`,
`routes.ts:240-320`) and instruments no repo call. The instrument is a
**repo-call counter in a test** - the same mechanism section 11 uses to pin
S1's zero-new-reads claim - counting DISTINCT `contacts.getById` calls in one
`GET /api/today` against a representative seeded world.

This spec does NOT batch Today's contact memo; S1 adds zero reads to that
path, so the questions are independent. Recording the number is the
deliverable.

## 11. Tests

TDD, red before green, per task.

**Unit, `app/test/`:**

- `participantNames.test.ts` (new): live name wins; PHONE rung resolves a
  member whose contactId misses; stored name when both rungs miss; stored name
  when the contact has an empty name; SOFT-DELETED contact does not supply a
  name; bare-phone member untouched; `phone` never modified; input not
  mutated; **a PARTIAL map leaves unresolved members on their stored names**
  (not "a throwing batch" - `batchGetByIds` swallows and returns short,
  `contactsRepo.ts:839-844`); the phone-fallback cap stops issuing reads and
  WARNs.
- Today: a stale `participant_display_name` plus a renamed contact renders the
  NEW name; unreadable contact renders the stored name; unlinked thread
  renders the formatted phone; **`contacts.getById` call count is UNCHANGED**
  against the pre-change baseline. Note `app/test/todayApi.test.ts:345-346`
  pins a formatted phone for contactIds never seeded, so it does not break -
  and equally the suite has ZERO coverage of the rung S1 changes.
- Roster: `describeRoster` prefers the contact name; a `removed_contact` row
  keeps its stored name.
- Inbox: a group row's title reflects a renamed contact; **assert UNIQUE ID
  COUNT, not method-call count** (A9/B13 - `batchGetByIds` chunks at 100 with
  up to 4 attempts per chunk, so a call-count pin measures the wrong
  quantity); ids are collected AFTER the contact filter at
  `routes/contacts.ts:1265-1267`, not before.
- relayFanOut: intro and member-added bodies compose from live names; an
  INCOMPLETE batch throws and the job fails rather than sending a shortened
  connection sentence; the sender prefix uses the live name;
  `senderNameOverride` still wins and issues NO read; a bare-phone sender
  issues no read; a nameless member is still dropped from the connection
  sentence.
- rosterEdits: the preview body matches the body the job would send, for a
  roster whose stored names are stale.
- Push/voice: `pushSenderLabel` and `maskedPartyLabel` prefer the contact.
- Audit script: the new group pass counts a seeded stale roster from BOTH
  `listGroupTexts` and `listRelayGroups`.

**Fixtures (A19):** `lib/seed/performance.ts:842, 857-858` bake
`'Synthetic participant NNNN'` / `'Synthetic tenant'` / `'Synthetic landlord'`
against real contact ids, so every one of those labels changes under S1/S2 in
the performance lane. Update the seed or the assertions in the same change.
`lean` and `cast` were verified consistent by both reviewers, so e2e strings
are safe - but note the corollary: the lean world cannot exercise this fix
without a runtime rename, which is what the e2e below does.

**E2E, `e2e/`:** rename a contact who is on a relay group and on an unread
1:1, then assert (a) Today's row shows the new name, (b) the group thread
header shows the new name after a reload, (c) the contact page's relay-groups
card shows the new name. Accessibility-first selectors per
`e2e/support/selectors.md`.

## 12. Risks

| risk | mitigation |
|---|---|
| Inbox read amplification | `getDisplaysByIds` projection; ids collected after filtering; test pins UNIQUE ID COUNT; phone fallback capped at 25 per call |
| Unbounded phone fallback | hard cap + WARN; past it, stored names stand (5.1) |
| Thread-header route gains a read on a per-tick SSE path | one batch over ONE roster; `GroupTextView.tsx:200-206` records the latency symptom to watch for |
| A throttled batch shortens a delivered SMS | `requireComplete` on the two once-only bodies and their previews; job fails and redelivers (5.4) |
| Relay hot path slowdown | sender prefix is ONE read, gated on no-override and non-empty contactId |
| Preview and send disagree | S4 hydrates both composers |
| One thread, two names across surfaces | S5 brings the push/voice labels onto the same rule; the two deferred admin readers share no thread with a hydrated surface |
| A stale name reaching a tenant's phone | S4 fixes all three delivered-content paths: intro, member-added, and the per-message sender prefix |
| A deliberately CLEARED name never disappears | stated limitation (3); deferred |

## 13. Gates

All five, bare, from the worktree: `npm run typecheck`, `npm test`,
`npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.

Close the five issue files with a Resolution stamp
(`consolidate-contact-display-name-helpers` is CORRECTED, not closed - see 9),
file the three deferrals from the round-1 adjudications, then run
`npm run issues`.
