# Participant name snapshots: resolve on read

Branch: `feat/participant-snapshot-refresh`
Worktree: `W:\tmp\participant-snapshot-refresh`
Bundle: M1 (docs/issues/_CLUSTERS.md, re-derived 2026-08-31 @5ce9912f)
Date: 2026-08-31

Closes five issues:

| sev | issue |
|---|---|
| high | today-shows-phone-instead-of-name |
| high | group-roster-name-snapshot-never-refreshed |
| med | relay-stale-participant-phone (documented, no code change - see 7) |
| low | consolidate-contact-display-name-helpers (scoped - see 8) |
| low | today-contact-hydration-fan-out (measured, then resolved - see 9) |

---

## 1. Problem

A conversation row stores a COPY of each participant's name, taken when the
row was written:

- `participant_display_name` - the 1:1 thread's copy.
- `participants[].name` - one copy per member of a group roster.

Nothing keeps either copy current. Measured 2026-08-25 with
`app/scripts/measure-unread-contact-coverage.ts --confirm --audit-denorm`:

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| contact HAS a name, thread carries none | 592 | 579 |
| thread name differs from the contact's | 0 | 2 |

Two founder-observed symptoms follow:

1. Today's Needs-you-now and Unreplied rows render a phone number where the
   operator should see a person (~85% of open threads).
2. Renaming a contact does not change group conversation titles or member
   chips, and the OLD name can reach outbound message content.

## 2. The decision

**Cameron, 2026-08-31: resolve on read, everywhere.** Every surface resolves
the name from the contact record at the moment it renders. Two follow-ups
confirmed in the same exchange:

- **Batch the lookups.** Where a surface reads no contacts today, use the
  existing `contactsRepo.getManyByIds` batch primitive - one call per page,
  never one call per member.
- **Keep the stored copy as a last-resort fallback.** When a contact record
  cannot be read at that instant, fall back to the stored name rather than
  rendering a blank or a phone number.

Refresh-on-write (extending the fan-out to group rosters) was considered and
NOT chosen. It needs a backfill for ~580 rows, makes the stored copy
authoritative forever, and adds a write surface to a denormalization with a
proven drift record.

## 3. What the tree actually holds

The issue files are wrong in three places that change the work. All three are
verified against `main` @5ce9912f.

### 3.1 `participant_display_name` IS rendered

`group-roster-name-snapshot-never-refreshed` states the 1:1 field is not
rendered ("NO - the inbox row uses the hydrated contact"). Four more readers
exist, two of which reach a phone's lock screen:

| site | surface |
|---|---|
| `routes/today.ts:1076` | Today's `who` label - THE anchor bug |
| `routes/webhooks/twilio.ts:1043` | inbound-message push title (closed-group intercept) |
| `routes/webhooks/twilio.ts:2285` | inbound-message push title (main path) |
| `routes/webhooks/voice.ts:159` | `pushCallerIdentity` - caller ID on a ringing phone |
| `routes/api.ts:457` | conversation-summary passthrough to the client |
| `lib/events.ts:103` | SSE `conversation.updated` payload |
| `dashboard/src/routes/today/buildToday.ts:106` | client-side copy of the same rule |

The three push sites already read `contactDisplayName(contact) ?? snapshot ??
phone` - live contact first, stored copy as fallback. **That precedence is
already this repo's blessed pattern.** Today is the outlier that skipped it,
and this spec makes Today match rather than inventing anything.

### 3.2 There is a second writer

`routes/contacts.ts:1753` (the identity fan-out) is not the only writer.
`jobs/placementNudges.ts:554` also writes `participant_display_name` via
`applyTriage`, and `routes/contacts.ts:1871` (the create-conversation route)
writes it a third time. The fan-out also finds threads by the contact's
CURRENT phone (`routes/contacts.ts:1741`), so correcting a number orphans the
old thread from every future fan-out.

This matters only as evidence against refresh-on-write. Under resolve-on-read
the writers are left alone (see 6.1).

### 3.3 Two of the three broken surfaces are already free

- **Today.** `routes/today.ts:743` already calls `isDeletedContact(ownerId)`
  -> `getContact` for every unread 1:1 the walk keeps - memoized, ahead of the
  cap, deliberately unbounded. By the time `whoOfConversation(conv)` runs at
  `:778`, that contact is already in `contactCache`. Rows where hydration is
  impossible (`ownerId === undefined`, the auto-capture race) are exactly the
  rows with no contactId to hydrate from.
- **The People card.** `lib/rosterResolution.ts:511` already reads every
  member's contact inside `describeRoster`, and already backfills a name at
  `:544` - but with the precedence BACKWARDS
  (`nonEmpty(member.name) ?? contact`), so a stale stored copy beats the live
  record.

Only the inbox group rows and the relay outbound path pay new reads.

## 4. Design: hydrate the roster at the read boundary

**The whole design in one sentence: replace `participants[].name` with the
live contact name IN MEMORY at each read boundary, then hand the existing
label functions the fresher array unchanged.**

Every downstream label function - `groupThreadLabel`, `relayThreadLabel`,
`relayMemberLabels`, `describeRoster`, `composeIntroBody` - keeps its exact
signature and its exact tests. They simply receive correct data. **No client
change is needed anywhere**: the dashboard mirrors
(`dashboard/src/lib/groupThread.ts`, `GroupTextsCard.tsx`,
`PlacementDetail.tsx`, `TourDetail.tsx`) read server-computed values and
inherit the fix for free.

### 4.1 New module: `app/src/lib/participantNames.ts`

Three exports. The first two are pure (no I/O, trivially testable); only the
third touches a repo.

```
/** Contact ids worth batching, across any number of conversations. */
export function collectParticipantContactIds(
  convs: readonly Pick<ConversationItem, 'participants'>[],
): string[]

/** PURE. A roster with each name replaced by the live contact's, falling back
 *  to the stored name when the contact is absent from the map. */
export function withLiveNames(
  participants: readonly ConversationParticipant[] | undefined,
  contactsById: ReadonlyMap<string, ContactItem | undefined>,
): ConversationParticipant[]

/** One batch read for a page of conversations, then withLiveNames per row.
 *  Never throws: a failed batch yields the input unchanged (stored names). */
export async function hydrateConversationRosters<T extends ConversationItem>(
  convs: readonly T[],
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  log: Logger,
): Promise<T[]>
```

`withLiveNames` resolves each member as:

```
contactDisplayName(contactsById.get(p.contactId)) ?? p.name
```

- A bare-phone member (`contactId` absent or `''`) keeps its stored name -
  there is no contact to resolve.
- `phone` is NEVER touched. See 7.
- The returned objects are new; the input array is not mutated.

### 4.2 THE ABSENCE-AMBIGUITY RULING (argued, not inherited)

`getManyByIds` returns a Map. A missing key means EITHER "no such contact" OR
"the read failed / was throttled" - the same signal, which is the class a
2026-08-21 adversarial review caught on the broadcast send path.

**We deliberately do NOT use `requireComplete`.** For NAME resolution the
ambiguity is safe in one direction only, and that is the direction we take: a
missing key falls back to the stored name, so a partial batch degrades to
exactly today's behavior - stale but present. `requireComplete` would throw,
and dropping a whole inbox page or a whole group title because one contact
read was throttled is strictly worse than one stale name.

This is the opposite ruling from a SEND path, and deliberately so. Nothing in
this spec uses a hydrated name to decide WHO receives a message; hydration is
display and message-body copy only. Routing continues to read
`participants[].phone`, untouched.

## 5. Per-surface work

### S1 - Today's `who` (high; zero new reads)

`routes/today.ts`. `whoOfConversation` becomes a function of the conversation
AND the already-memoized contact:

```
who = contactDisplayName(contact)
   ?? conv.participant_display_name (non-empty)
   ?? formatPhoneForDisplay(conv.participant_phone)
   ?? ''
```

The contact comes from the existing `getContact(oneToOneContactId(conv))`
memo, which the deleted-contact gate at `:743` has already populated for every
row that reaches `:778`. No new read, no new bound, no walk change.

Also hydrate the relay close-nag card's `memberNames` (`routes/today.ts:~1000`),
which reads `conv.participants` raw. Its groups come from
`listRelayGroups('open')`, a bounded list - one `hydrateConversationRosters`
call over that list.

**Client note.** `dashboard/src/routes/today/buildToday.ts:106` computes its
own `who` from the raw summary and would keep rendering the stale copy. Today's
rows are built SERVER-side (`TodayResponse.items` carry `who`), so this file's
`conversationWho` is dead for the M1 surfaces; the build must CONFIRM that with
a test rather than assume it, and if it is live, the client falls back to the
server `who`.

### S2 - Group titles and member chips (high)

Five read boundaries, all server-side:

| file | boundary | cost today |
|---|---|---|
| `routes/inbox.ts:1237, 2358` | `page.items.map(groupRowFor)` | zero - `groupRowFor` is SYNCHRONOUS |
| `routes/inbox.ts:1154, 2293` | `relayRowFor(conv)` | already async |
| `routes/inbox.ts:1418` | single-row refresh | already async |
| `routes/api.ts` conversation detail | raw `participants` passthrough | zero |
| `routes/contacts.ts:1213, 1295` | relay-groups + group-texts cards | zero |

Each becomes: collect ids across the page -> ONE `getManyByIds` -> map rows
with `withLiveNames`. `groupRowFor` becomes async or takes the map as a second
argument; the latter is preferred (it keeps the function pure and testable).

`routes/api.ts` is the surface the founder actually reported: the group thread
HEADER is a raw passthrough and the dashboard computes the title client-side
from `header.participants`, so hydrating that passthrough is what makes
"renaming shows in group conversations" true.

### S3 - The People card precedence flip (high; zero new reads)

`lib/rosterResolution.ts:544`. Invert:

```
- nonEmpty(member.name) ?? (!removed && contact ? displayName(contact) : undefined)
+ (!removed && contact ? displayName(contact) : undefined) ?? nonEmpty(member.name)
```

The contact is already read at `:511`. The `removed` guard stays exactly as
it is: a soft-deleted or dangling contact keeps whatever the row itself said,
which is the spec-5.2 DANGLING IDS rule and is not ours to change.

### S4 - Relay outbound content (high; the blast-radius half)

`jobs/relayFanOut.ts`. Three sites, two different costs:

- `:405` sender prefix - ONE contact, not the roster. A single
  `contacts.getById(senderMember.contactId)`, falling back to
  `senderMember?.name`. One read per relayed message.
- `:634` intro body - the whole roster, once per group creation. One
  `getManyByIds`.
- `:684` member-added body - the whole roster, once per add. One
  `getManyByIds`.

The founder ruling in `lib/groupTitle.ts` holds unchanged: outbound content
carries names and NEVER a phone. A member with neither a live name nor a
stored name is still nameless and is still dropped by
`composeConnectionSentence`. Behavior on that path is identical; only the
name's freshness changes.

`payload.senderNameOverride` continues to win outright - a team message's
explicit label is not a participant name.

### S5 - Extend the drift audit to group rosters

`app/scripts/measure-unread-contact-coverage.ts`. `auditDenorm` skips group
rows outright at `:510`. Add a group-roster pass reporting, over
`relay_group` + `group_text` rows: rosters walked, members with a contactId,
members whose stored name is MISSING while the contact has one, and members
whose stored name DIFFERS. Counts only, never names - the existing PII rule.

This is the proof the fix worked, and it is in scope per the mission intake,
not a follow-up.

## 6. Non-goals, stated so a reviewer can contest them

### 6.1 The writers stay

Nothing in this spec removes or changes a writer of `participant_display_name`
or `participants[].name`. The stored copy remains, now as the documented
fallback rung. Ripping out writers is a separate change with its own blast
radius, and `participants[].contactId` ownership belongs to bundle M8.

### 6.2 A rename does not live-update an open thread

Under resolve-on-read there is no write on rename, so no
`conversation.updated` fires for group threads, so an already-open thread view
does not refresh until its next fetch. Names are correct on next load.

Emitting a notification-only event was considered and rejected on cost:
`routes/contacts.ts:1170` documents that there is NO member->conversation
index, so finding a contact's group threads requires walking three relay
status partitions. Paying three partition walks on every contact PATCH to
make a rare rename animate is a bad trade.

**If a reviewer or Cameron disagrees, this is the item to change** - it is the
one place the fix is less than instantaneous.

### 6.3 The SSE payload is not hydrated

`lib/events.ts` `toConversationUpdatedEvent` is a pure sync builder with
byte-identical pinned tests, called on the message hot path. Hydrating it
would put a contact read on every event emit. Consumers debounce-REFETCH on
this event rather than patching from its payload, so the refetch gets
hydrated data from the API anyway.

### 6.4 Fenced files

Untouched, per the mission intake: `lib/unreadFeed.ts` and the Unknown-tab
walk in `routes/inbox.ts` (M6, T-UNREAD-GEN); `participants[].contactId`
ownership (M8); `jobs/tourReminders.ts` and `routes/contactTimeline.ts` (the
live `tour-reminder-ladder-phase-b` worktree). Verified: `tourReminders.ts`
reads `members.length` and phones only, never `.name`, so it needs no edit.

## 7. The phone half stays as it is

**Cameron, 2026-08-31: document remove-and-re-add; change no code.**

`participants[].phone` is NOT hydrated by anything in this spec.
`withLiveNames` touches `name` only. The reasons are load-bearing and
pre-existing:

- `lib/rosterResolution.ts` header: participants are returned with the phone
  STORED ON THE ROW because in fact mode the fan-out sends to that number, so
  deliverability and recipient counts must derive from it.
- The live-remove path deliberately follows the stored row phone so removal
  still works when the number is wrong.

`relay-stale-participant-phone` closes as documented behavior: to correct a
number, remove the member and re-add them, which re-announces them to the
group - arguably correct, since their number really did change. The issue file
gets a Resolution stamp recording the ruling and the operator procedure.

**Note for bundle M3** (relay roster change notification texts): M1 changes
NO phone source. Roster notification sends continue to address
`participants[].phone`, the stored row value. M3 may proceed on that basis.

## 8. `consolidate-contact-display-name-helpers`: scoped down

The issue says six private copies. There are thirteen, and **they disagree**:

| trims before joining | does NOT trim |
|---|---|
| `routes/contacts.ts:480` | `routes/inbox.ts:536` |
| `lib/rosterResolution.ts:145` | `routes/today.ts:224` |
| `routes/units.ts:125` | `jobs/placementNudges.ts:147` |
| `services/groupMembers.ts:93` | `routes/api.ts:2081` |
| `services/relayMembers.ts:41` | |
| `routes/api.ts:2158`, `services/groupConvert.ts:226`, `lib/voiceMasking.ts:47` | |

A whitespace-padded name therefore renders differently by surface TODAY. A
blind sweep onto `contactDisplayName` (which trims) is a behavior change on
four surfaces, not debt cleanup.

**Scope for this branch:** re-point ONLY the copies in files this spec already
edits - `routes/today.ts:224`, `lib/rosterResolution.ts:145`,
`routes/inbox.ts:536`, `routes/contacts.ts:480`. Each re-point ships with a
test asserting the trimmed result, so the two non-trimming copies among them
surface their change explicitly. The remaining copies stay, and the issue file
is updated with the true count of thirteen, the trim/no-trim split, and the
reduced remainder - it does NOT close.

## 9. `today-contact-hydration-fan-out`: measure, then resolve

Its own text says: "Measure before building. This is the first task, not a
preamble... If N is small, CLOSE THIS as wontfix and say so - that outcome is
a success."

**Task:** run `npm run perf:pages` against the hermetic lane and record N, the
number of DISTINCT contacts one `GET /api/today` resolves. Then either close
it wontfix with the number, or leave it open with the number recorded.

This spec does NOT batch Today's contact memo. S1 adds zero reads to that
path, so the two questions are independent and the batching restructure - a
two-pass assembly with a documented absence-ambiguity direction - is its own
change. Recording the number is the deliverable here.

The `no lookup bound` rule at `routes/today.ts:733` is preserved absolutely.
Every bound tried there was wrong at some threshold; this branch introduces
none.

## 10. Tests

TDD, red before green, per task.

**Unit, `app/test/`:**

- `participantNames.test.ts` (new): live name wins; stored name when the
  contact is absent from the map; stored name when the contact has no name;
  bare-phone member untouched; `phone` never modified; input not mutated; a
  throwing batch yields input unchanged.
- Today: a thread with a stale `participant_display_name` and a renamed
  contact renders the NEW name; a thread whose contact is unreadable renders
  the stored name; an unlinked thread still renders the formatted phone; NO
  increase in `contacts.getById` calls (assert the call count - this is the
  zero-new-reads claim, and it must be pinned, not asserted in prose).
- Roster: `describeRoster` prefers the contact name over a stale stored one; a
  `removed_contact` row still keeps its stored name.
- Inbox: a group row's title reflects a renamed contact; ONE `getManyByIds`
  per page regardless of member count (assert the call count).
- relayFanOut: intro body and member-added body compose from live names; the
  sender prefix uses the live name; `senderNameOverride` still wins; a
  nameless member is still dropped from the connection sentence.
- Audit script: the new group pass counts a seeded stale roster correctly.

**E2E, `e2e/`:** rename a contact who is on a relay group and on an unread
1:1, then assert (a) Today's row shows the new name, (b) the group thread
header shows the new name after a reload, (c) the contact page's relay-groups
card shows the new name. Accessibility-first selectors per
`e2e/support/selectors.md`.

## 11. Risks

| risk | mitigation |
|---|---|
| Inbox page read amplification | ONE `getManyByIds` per page, pinned by a call-count test |
| A throttled batch blanks names | fallback to stored name; no `requireComplete` (4.2) |
| Relay hot path slowdown | sender prefix is ONE contact read per message, not N |
| A stale name reaching a tenant's phone | S4 fixes the intro + member-added bodies, the two paths that carry names into delivered messages |
| Hidden reader we did not sweep | the reader table in 3.1 plus the boundary table in S2 are the enumeration; the adversarial doc review is briefed to widen it |

## 12. Gates

All five, bare, from the worktree, per AGENTS.md: `npm run typecheck`,
`npm test`, `npm run smoke`, `npm run e2e`, and
`npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`.

Close all five issue files with a Resolution stamp in this branch, then run
`npm run issues`.
