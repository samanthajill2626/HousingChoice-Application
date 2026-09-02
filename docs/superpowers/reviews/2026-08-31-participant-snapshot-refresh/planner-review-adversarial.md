# Planner's independent adversarial code review - feat/participant-snapshot-refresh

Plan-blind and review-blind by construction: I read the diff
(`git diff main...HEAD -- app/src dashboard/src e2e app/scripts app/test`) and the
live tree only. Nothing under `docs/superpowers/` was opened. No suites were run
(the planner's gate battery owns this worktree); every claim below is from a file
read, cited by `file:line`.

Severity = consequence if merged unfixed.

---

## 1. HIGH - `filter=unread` issues ONE BatchGet PER multi-party row, sequentially, up to 100 per request

`app/src/routes/inbox.ts:1435`

```
const names = await resolveRosterNames([fresh], contacts, log);
```

sits inside `hydrateUnread`, which is awaited one candidate at a time in the
sequential fill loop at `app/src/routes/inbox.ts:1485-1486` (and again in the
lagged-retry loop at `:1556`). Every relay-group or group-text candidate on the
page therefore costs its own BatchGetItem round trip, serialized behind the point
read above it. `limit` is caller-controlled and clamps at
`MAX_INBOX_LIMIT = 100` (`app/src/routes/inbox.ts:217`), so a relay-heavy Unread
page can pay up to 100 sequential extra round trips - on the route the dashboard
refetches on every SSE tick.

The other three arms all hoist the batch out of their loop
(`:1250` for `filter=groups`, `:2315` for the relay merge, `:2386` for the group
merge). This arm is the only one that did not, and the in-code justification
("one batch per multi-party candidate, bounded by the page limit, same order as
today", `:1428-1434`) argues bounded, not cheap: it doubles the round trips for
those rows rather than adding O(1). The candidates are already collected as a
list before hydration (`collected.candidates`, `:1485`), so a two-pass shape -
point-read all, batch once, build rows - is available without changing the
arm's semantics.

This is exactly the pattern `docs/issues/contacts-batchget-amplified-reads.md`
exists to remove, and no test pins a batch count on this arm (the count pins added
are `contactRelayGroups.test.ts:161` and `inboxGroups.test.ts:370`, both on
hoisted arms).

## 2. HIGH - the "a soft-deleted contact supplies no name" guarantee is defeated through an existing write-back

The branch newly asserts and pins this rung in three places:

- `app/src/lib/participantNames.ts:74` (`withLiveNames`, `isDeleted` check)
- `app/src/routes/webhooks/twilio.ts:313-327` (`pushSenderLabel`), with the
  rationale "findByPhone deliberately returns deleted rows ... so the refusal has
  to happen here"
- `app/src/routes/webhooks/voice.ts:121-129` (`maskedPartyLabel`)

All three drop to the STORED roster name when they refuse a deleted contact. But
`GET /api/conversations/:conversationId/group-members` resolves each member's name
with `contacts.findByPhone(m.phone)` and applies NO deleted check to the NAME
(`app/src/routes/api.ts:2062`, `:2085-2090` - `isDeleted` there only sets the
response's `deleted: true` flag at `:2100`), then WRITES the resolved names into
the stored roster:

```
app/src/routes/api.ts:2103-2110
if (rosterNamesAreStale) { ... await conversations.backfillGroupTextRoster(conversationId, refreshed, prior); }
```

So for any native group text a staff member has opened, the stored roster name IS
the soft-deleted contact's current name - and that is precisely the fallback rung
all three new guards land on. The guarantee holds only until someone opens the
thread view. `voiceWebhook.test.ts` and `inboundMessagePush.test.ts` pin the guard
against a stale stored name and never against a converged one, so the hole is
invisible to the suite.

## 3. HIGH - the branch's stated premise is false for native group texts, and it is repeated as fact in five new comments

"`participants[].name` is a write-time snapshot nothing refreshes" appears at
`app/src/lib/participantNames.ts:4-5`, `app/src/routes/contacts.ts:1191-1193`,
`app/src/routes/contacts.ts:1289-1291`, `app/src/routes/inbox.ts:1203-1204` and
`app/src/routes/relayGroups.ts:480-487`. The e2e header
(`e2e/tests/scenarios/participant-names.spec.ts:5-6`) says the same.

`backfillGroupTextRoster` (`app/src/routes/api.ts:2110`) refreshes it, in
product, on every group-text thread open where a name has drifted. The dashboard
side documents the same mechanism at
`dashboard/src/routes/conversation/GroupTextView.tsx:78-81` ("`/group-members`
resolves fresher contact names AND writes them back to the stored snapshot
server-side").

Consequences beyond the comments themselves:

- The `--audit-denorm` group tally the branch adds
  (`app/src/lib/rosterDriftTally.ts`) reports `nameDrift` over group_text rosters
  that this write-back is actively converging, so its numbers measure "threads
  nobody has opened", not drift.
- `app/src/routes/api.ts:2113` still logs `'group members: roster name refresh
  failed - the panel is unaffected, the inbox row stays stale'`. After this branch
  the inbox row hydrates on read, so that operator-facing log line is now false.

## 4. MEDIUM - three different name-resolution rules now run over the same group_text roster, and one of them WRITES

- Read boundary (new): by `contactId`, `contactDisplayName` over the display
  projection, part-wise trim, refuses deleted
  (`app/src/lib/participantNames.ts:64-76`, `app/src/lib/contactName.ts:123-133`).
- `/group-members` write-back: by `phone` via `findByPhone`, `` `${first} ${last}`.trim() ``,
  no delete check (`app/src/routes/api.ts:2062`, `:2085-2088`).
- The 1:1 inbox row: `nameFromContact` with an extra denormalized `contact.name`
  rung (`app/src/routes/inbox.ts:536-545`).

Where a phone has moved between contacts, rule 2 writes contact B's name into a
roster slot whose `contactId` is contact A, and rule 1 then re-resolves it back to
A on read - a persistent write/read disagreement over the same row, with no
reconciliation and no test. The branch declares an intentional inbox-vs-push
divergence but does not mention this read-vs-write one.

## 5. MEDIUM - the display projection cannot see the legacy `contact.name` field, so a whole contact population resolves on one surface and not the other

`DISPLAY_PROJECTION` fetches `contactId, firstName, lastName, phone, deleted_at`
only (`app/src/repos/contactsRepo.ts:856-865`), and `contactDisplayName` has no
`name` rung (`app/src/lib/contactName.ts:126-132`). `app/src/routes/inbox.ts:542-544`
documents that population explicitly - "A name may also live in a single
denormalized field on some records" - and reads it for 1:1 rows.

Net effect on ONE inbox page: an imported/legacy `name`-only contact renders named
in their 1:1 row and as a formatted phone in the group or relay row titled from the
same contact record. The new resolver cannot fix it even in principle, because the
projection does not fetch the field. Population size is UNVERIFIED (no data access
from this review); the asymmetry is verified.

## 6. MEDIUM - the `isDeleted` name guard was added to two label functions and not to the two beside them

`pushSenderLabel` now refuses a deleted contact's name
(`app/src/routes/webhooks/twilio.ts:323-327`). The 1:1 inbound-message push TITLE
in the same file does not: `app/src/routes/webhooks/twilio.ts:1057` and
`app/src/routes/webhooks/twilio.ts:2300` both call
`contactDisplayName(contact)` unguarded, on a `contact` that came from the same
`findByPhone` the new docblock cites as the reason the guard is needed
(`:314-316`). Same file, same read, same push, opposite rule.

## 7. MEDIUM - `resolveRosterNames`'s blanket catch turns a programming error into a routine warn

`app/src/lib/participantNames.ts:57-63` catches everything and returns an empty
map with `'participant names: batch read failed - stored names stand'`. A repo or
test double missing `getDisplaysByIds` throws `TypeError` inside that `try` and is
reported as a throttle-shaped read failure while every surface silently keeps its
stale names.

This is not hypothetical: two existing suites had to have an explicit empty
`getDisplaysByIds` added for exactly this reason, and the added comments say so -
`app/test/inboxFeed.test.ts:291-297` and `app/test/inboxUnreadParity.test.ts:246-452`
("the cast above would let it be MISSING, and the resulting TypeError is swallowed
- so this suite would go green by resolving zero names silently"). The fix
was applied to the test doubles; the swallow that made it possible is still in
production code.

## 8. MEDIUM - `contactName.ts`'s helper census understates the duplication it warns about

`app/src/lib/contactName.ts:110-115` says private copies "still exist in
routes/inbox.ts and routes/today.ts". The pre-branch comment named five. Live tree:

- `app/src/routes/inbox.ts:536`
- `app/src/routes/today.ts:223`
- `app/src/routes/placements.ts:165`
- `app/src/services/relayMembers.ts:37`
- `app/src/lib/rosterResolution.ts:162`
- `app/src/routes/units.ts:118`
- `app/src/services/groupMembers.ts:92`
- `app/src/services/inboundEmail.ts:400`
- inline join at `app/src/routes/api.ts:2162-2166`

A reader of the new comment concludes seven of those were consolidated. None were.

## 9. LOW - the masking helpers return an unmasked single-token name, and the new docblocks claim they never do

`shortNameFromFull('Bob')` returns `'Bob'` and `contactShortName` returns the bare
surname when `firstName` is empty (`app/src/lib/voiceMasking.ts:49-50`,
`:60-66`). The new docblock at `app/src/lib/voiceMasking.ts:55-58` says the mask
"must never carry a full surname, whichever rung supplied it", and
`app/src/routes/webhooks/voice.ts:115-116` says "never an unmasked full name".
For a surname-only contact, and for any one-word stored roster name, both claims
are false. `app/test/voiceMasking.test.ts:865` pins `shortNameFromFull('Bob') ===
'Bob'` - the exception is pinned without being named as one. Label is persisted as
`call_party_label` and spoken in the whisper, so the claim is worth making true or
narrowing.

## 10. LOW - the group_text thread HEADER is still titled from the un-hydrated passthrough, and the e2e covers only the relay header

`dashboard/src/routes/conversation/GroupTextView.tsx:264` titles from
`headerRoster`, derived from `header.participants`
(`:97-105`) - the raw passthrough, which this branch deliberately does not
hydrate. It converges only after the `/group-members` round trip lands. So on a
native group text the inbox row is fresh immediately and the header it opens is
stale for a beat, in the opposite direction from the relay case the e2e pins
(`e2e/tests/scenarios/participant-names.spec.ts:11-13`, `:66-68`, which asserts
the RELAY header via `/members`). Acceptable if intended; it is not stated
anywhere in the diff, and the surviving comment at
`GroupTextView.tsx:80-81` ("once the write-back lands, the inbox row too") now
describes a mechanism the inbox no longer depends on.

## 11. LOW - `GET /api/contacts/:id/relay-groups` batches the SELF contact id it has already read

`app/src/routes/contacts.ts:1208-1212` passes whole rosters to
`resolveRosterNames`, so the requesting contact's own id enters the batch even
though the route already read that contact to 404-guard it. Pinned as correct
behavior at `app/test/contactRelayGroups.test.ts:162`
(`new Set([TENANT, 'c-in-open', 'c-in-closed'])`). One wasted key in one batch -
cheap, but the test now makes it deliberate.

## 12. LOW - the `buildToday` change is in the 404-only client fallback and is untested

`dashboard/src/routes/today/buildToday.ts:103-108` gains a non-empty guard on
`participant_display_name`. `buildTodayFromSources` runs only when
`GET /api/today` returns 404 (`dashboard/src/routes/today/useToday.ts:52-58`),
which no deployed environment does. `dashboard/src/routes/today/buildToday.test.ts`
was not extended for the new branch. Harmless; note it so nobody reads it as part
of the Today fix.

---

## What I checked and found CLEAN

- **No new writes.** No `update`/`put`/`backfill`/`setParticipants` call appears in
  any changed hunk. `withLiveNames` and `hydrateConversationRosters` copy
  (`app/src/lib/participantNames.ts:71-84`) and every consumer uses the copy for
  display only - including the Today close-nag loop
  (`app/src/routes/today.ts:1008-1024`), which I read end to end.
- **Today's "no added reads" claim is TRUE.** `whoOfConversation`'s contact comes
  from `getContact` (`app/src/routes/today.ts:781`), and the deleted-contact gate
  at `:743-745` already called `isDeletedContact` -> `getContact` for the same id
  from the same memo (`:358-381`). Pinned at `app/test/todayApi.test.ts:813-821`.
- **Wire shapes.** `ConversationParticipant` is a closed three-field interface
  (`app/src/repos/conversationsRepo.ts:104-109`), so `{...p}` leaks no new
  attribute onto `GET /conversations/:id/members`, the Today nag rows, or
  `GET /api/calls/:callId`. The `/members` change (stored name now KEPT rather
  than projected away) is a documented ruling, not an accident, and
  `app/test/relayApi.test.ts:589-619` retitles the two prior tests to say so.
- **Read counts on the hoisted arms.** `filter=groups` 1 batch, `filter=all` 2
  (relay + group, stated at `app/src/routes/inbox.ts:2383-2385`), contact card 1,
  group-threads card 1, `/members` 1 (was N `getById`), `/api/calls/:callId` 1.
  All O(1) per page.
- **`describeRoster`'s precedence flip is display-only.** `memberKey` is
  contactId/phone-derived (`app/src/lib/rosterResolution.ts:582`), and every
  `rosterEdits` consumer keys off `memberKey`, never the name
  (`app/src/services/rosterEdits.ts:552`, `:726`, `:751-760`). The removed-contact
  carve-out is preserved (`rosterResolution.ts:563`).
- **PII in logs.** The one new log line carries `{ err, contactCount }`
  (`app/src/lib/participantNames.ts:61`); the audit's new group pass prints counts
  only (`app/scripts/measure-unread-contact-coverage.ts:615-634`). No name or
  phone reaches a log line in this diff.
- **The masked label is now MORE private, not less.** `maskedPartyLabel`
  previously returned `member.name` verbatim - a full stored name persisted as
  `call_party_label` and spoken in the whisper; it now goes through the same
  "First L." mask (`app/src/routes/webhooks/voice.ts:126-133`), pinned at
  `app/test/voiceWebhook.test.ts:924-940`.
- **The tag carve-out is unchanged code with a fresher input**
  (`app/src/lib/groupTitle.ts:195`), and the contact card's hand-rolled twin at
  `app/src/routes/contacts.ts:1225` is equivalent (its missing `labels.length > 0`
  test is redundant - an empty label list yields `[]` either way). Both new
  behaviors are pinned (`inboxGroups.test.ts:405`, `contactRelayGroups.test.ts:107`).
- **`batchGetByIds` de-dupes keys, chunks at 100 and retries UnprocessedKeys**
  (`app/src/repos/contactsRepo.ts:810-853`), so a 100-member relay roster is one
  request and a duplicate id cannot reject the chunk. The audit script's own
  100-chunking on top (`measure-unread-contact-coverage.ts:612-614`) is redundant
  but harmless.
