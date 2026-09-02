# Research D - findings

Read-only sweep of every reader and writer of `participants[].name`,
`participants[].phone` and `participant_display_name` across `app/src`,
`app/scripts`, `dashboard/src` and `e2e`, at `e6599b4f`.

This file carries ONLY (i) readers/writers that neither the spec's section 3
"In" table nor its "Out, and why" list names, and (ii) repo facts that
contradict or mis-cite the plan. The full sweep table and the byte-exact
quotations are separate reference, at
`.superpowers/sdd/research-D-reference.md`.

Nothing here is STOP-worthy. Every load-bearing repo fact the plan asserts is
CONFIRMED: `ContactDisplayItem` types `firstName`/`lastName` as `unknown`,
`isDeleted` accepts that projection, the display projection includes
`deleted_at`, the shared fake world implements `getDisplaysByIds` with a
`deleted_at`-carrying projection and reassignable methods, `createRelayGroup`
keeps a `contactId: ''` member, the fake `listRelayGroups` filters on
`relay_status`, `ConversationParticipant.contactId` is a required `string`, and
every `ConversationItem` field the plan's test literals use is declared.

No plan task touches ANY writer of either field. Confirmed against the full
writer list in the reference: `conversationsRepo` (`setParticipantsIfAbsent`,
`createRelayGroup`, `addMember`/`removeMember`, `createGroupTextThread`,
`convertToGroupText`, `backfillGroupTextRoster`, `applyTriage`,
`createOrGetByParticipantEmail`), `services/relayMembers`,
`services/rosterProvision`, `services/groupConvert`, `services/groupMembers`,
`services/contactCapture`, `routes/public`, `routes/tours`,
`routes/contacts` (`:1753`, `:1871`), `jobs/placementNudges` (`:556`),
`jobs/relayFanOut` (`:834-840`), `lib/import/apply`, and the four seed
profiles. The only write-adjacent line any task edits is the READ-path
`delete memberWithoutStoredName.name` at `app/src/routes/relayGroups.ts:489`,
which mutates a copy and persists nothing.

---

## F1 - UNLISTED reader: `GET /api/conversations` ships the un-hydrated snapshot, and the Today offline fallback renders it

Severity: medium (the spec's stated reason is wrong; user impact is
fallback-only)

`app/src/routes/api.ts:453-465` (`toConversationSummary`) reads BOTH protected
fields - the whole stored roster at `:458` and `participant_display_name` at
`:460` - and `app/src/routes/api.ts:1989` serves it as the
`GET /api/conversations` page. Neither the section 3 "In" table nor the "Out"
list names this route. The "Out" list names only the two OTHER `api.ts` routes
(`:2004` thread header, `:2020` group-members).

The spec's client bullet says: "Client code. Nothing changes. Every dashboard
reader consumes server-computed values or a hydrated passthrough." That is not
true of this route. `dashboard/src/routes/today/buildToday.ts:103-107`
(`conversationWho`) renders `participant_display_name` directly from it, via
`dashboard/src/api/endpoints.ts:522` (`getAllConversations`) and
`dashboard/src/routes/today/useToday.ts:64`. `buildToday.ts` is the offline
fallback Today uses when `GET /api/today` fails - which is the one path where
the server-side S1 fix cannot help.

What a staff user sees: `GET /api/today` errors, Today falls back to the
client build, and a contact renamed an hour ago still reads under the OLD
stored name (or a phone) - the exact founder symptom S1 exists to close,
surviving on the fallback. The plan's Task 2 Step 4 changes the bare `??` at
`buildToday.ts:106` into a non-empty check, which converts a stored EMPTY
string into the phone; it does not touch staleness.

Suggested resolution (no code): add a section 3 "Out" bullet naming
`routes/api.ts:453` / `GET /api/conversations` with the honest reason - the
client fallback holds no contact and hydrating a whole-inbox list read is out
of proportion - and stop the blanket "every dashboard reader consumes a
hydrated passthrough" claim from covering it. The same route's roster is also
read at `buildToday.ts:114-117`, but for `contactId` only, so nothing is stale
there.

## F2 - UNLISTED reader: the `conversation.updated` SSE payload carries the raw roster

Severity: low (inert today; the documented contract invites a regression)

`app/src/lib/events.ts:103` ships `participant_display_name` and `:110`/`:117`
ship `members: item.participants ?? []` - the stored snapshot - on every
`conversation.updated` event. Named by neither list.

It is inert today: every dashboard consumer treats the event purely as a
refetch trigger and reads no field off it
(`dashboard/src/api/EventStreamProvider.tsx:176`,
`dashboard/src/routes/inbox/useInbox.ts:96`,
`dashboard/src/routes/shared/useRoster.ts:114`,
`dashboard/src/routes/conversation/useRelayThread.ts:437`,
`dashboard/src/routes/tours/useTourChannels.ts:258`,
`dashboard/src/routes/placements/usePlacementChannels.ts:266`,
`dashboard/src/routes/today/useToday.ts`). No `event.members` read exists.

The risk is the documented contract, not today's code:
`dashboard/src/api/types.ts:1681-1686` describes `members` as "the live member
roster ... so the relay UI updates rosters in place on add/remove WITHOUT a
refetch", and `app/src/lib/events.ts:64-70` says the same. A client that takes
that invitation would overwrite a Task-5-hydrated roster with the stored
snapshot on the next event, silently undoing the branch on the relay thread
view.

Suggested resolution: one line in the new
`docs/issues/staff-only-roster-name-readers-stale.md`, or in the
`group-roster-name-snapshot-never-refreshed` resolution stamp, saying the SSE
`members` field is deliberately NOT hydrated and must not be used to populate a
rendered roster in place.

## F3 - UNLISTED third stored-name field: `relay_opted_out_members[].name`

Severity: low (correct today by precedence, not by design)

There is a THIRD write-time name snapshot the spec's problem statement does not
mention. `app/src/jobs/relayFanOut.ts:834-840` copies `member.name` - itself a
`participants[].name` snapshot - into the conversation's
`relay_opted_out_members` map (declared at
`app/src/repos/conversationsRepo.ts:252`). `app/src/routes/today.ts:631-636`
reads it back for the Today "Opted out of a relay group" row.

No staff-visible staleness today: that read is already contact-first
(`nameFromContact(memberContact) ?? entry.name ?? formatPhoneForDisplay(...)`),
so the chain the branch is installing everywhere else is already in force here
by accident of ordering. But it is a snapshot of a snapshot with no documented
contract, and Task 8's drift audit will not count it, so the handback's
measured stale population understates the true one.

Suggested resolution: name it in the `group-roster-name-snapshot-never-refreshed`
resolution stamp as a third field that is already correct at its only reader,
so a future writer of a second reader does not have to rediscover it.

## F4 - Spec wording: the `GET /conversations/:id` OUT reason is "converges a beat later", not "Redundant"

Severity: low (accepted residue either way; the stated reason is what is wrong)

The OUT bullet says every view that fetches the thread header also fetches
`/members` or `/group-members` on the same mount, "which already resolve names.
Redundant." That holds only AFTER the second fetch resolves.
`dashboard/src/routes/conversation/ConversationDetail.tsx:180` SEEDS its member
state from `header.participants`, and `:386-393` derives the visible
`With ...` identity line from that state, so a renamed member's OLD name is
painted first and swaps when `GET /conversations/:id/members` lands.
`dashboard/src/routes/conversation/GroupTextView.tsx:98-105` and `:264` have the
same shape - but that one documents the behavior deliberately at `:207-221`
(the converge-not-retitle ruling), so it is honest as written; ConversationDetail
is not.

Nothing to fix on this branch (the fix would be hydrating the header, which the
spec rules out for a stated reason). Suggested resolution: change "Redundant"
to something like "resolved a beat later, so a rename flips in place on mount"
in section 3, and list the ConversationDetail first-paint alongside the
`PlacementDetail.tsx:370` / `TourDetail.tsx:451` residue in the
`group-roster-name-snapshot-never-refreshed` stamp Task 10 writes.

## F5 - Plan/spec mis-citation: `contactsRepo.ts:597`, and the real batch read cannot reject

Severity: low (nit; the plan's code is right, its citation and one test's
premise are not)

Spec section 4 and the plan's Task 1 docblock both cite
`app/src/repos/contactsRepo.ts:597` for "returns a SHORT map on throttle".
`:597` is the `ContactsRepo` INTERFACE declaration of `getDisplaysByIds`. The
short-map contract is documented at `app/src/repos/contactsRepo.ts:786-809` and
implemented in `batchGetByIds` at `:824-852` (chunk 100, de-dupe, four attempts,
unprocessed keys counted and dropped, a thrown chunk caught and logged). The
projection citation (`:856`) is right - it is `:855-865`.

Related, and worth a comment rather than a change: the REAL
`getDisplaysByIds` (`app/src/repos/contactsRepo.ts:1077-1079`) passes no
`requireComplete`, and `:839-844` swallows a thrown chunk, so it CANNOT reject.
The plan's `resolveRosterNames` try/catch and its "a throwing batch yields an
empty map ... never a rejection" test therefore guard a path production never
takes. Keep both - they are load-bearing against the FAKES, since
`app/test/inboxGroups.test.ts:102-117` has no `getDisplaysByIds` member at all
(the object is cast through `as unknown as`, so the missing method is a runtime
`TypeError`, not a compile error). One line in the module docblock saying "the
real repo never rejects; this catch is for a repo double and for a future
implementation that does" would keep the next reader from deleting it as dead.

---

## Checked and clean (no finding)

- Every 1:1 and Unknown-tab inbox row already names from the CONTACT
  (`app/src/routes/inbox.ts:991`, `nameFromContact(contact) ?? fallbackLabel`),
  so M6's walk carries no stale-name exposure.
- `app/src/lib/unreadFeed.ts` reads no `name` at all.
- `app/src/jobs/tourReminders.ts:1380`, `app/src/services/relayAnnouncements.ts:180`,
  `app/src/jobs/relayNumberReady.ts:132`, `app/src/services/emailEvents.ts:138`,
  `app/src/jobs/rosterActions.ts:422`, `app/src/services/sendEmailMessage.ts:369`,
  `app/src/services/relayInboundResolution.ts:75` all read a roster for phone,
  contactId or count only.
- `app/src/routes/broadcasts.ts` never reads a roster (audience is tenant 1:1
  contacts by construction, `:12`).
- All four `e2e` roster assertions read server-computed labels
  (`e2e/scenarios/steps.ts:1926-1940` reads the contact card's accessible name),
  so no e2e fixture pins a stored snapshot the branch will move.
- Every plan-cited scope const is where the plan says: `aggregateInbox` at
  `app/src/routes/inbox.ts:709` with `log` `:713` and `contacts` `:715`;
  `app/src/routes/api.ts` `log` `:558`, `contacts` `:635`. One trivial drift:
  the plan says `contacts`/`log` are at `app/src/routes/contacts.ts:918-919`;
  they are `log` `:917`, `contacts` `:918`.
