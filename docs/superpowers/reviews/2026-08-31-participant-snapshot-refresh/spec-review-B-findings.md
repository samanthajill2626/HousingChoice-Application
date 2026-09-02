# Adversarial spec review B - participant name snapshots: resolve on read

Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`
Tree: `W:\tmp\participant-snapshot-refresh` (read-only), branch `main`-based.
Reviewer had the spec and the repo only - no brainstorm, no rationale.

Every claim below cites a file:line I opened. Anything I could not settle is
marked UNVERIFIED.

---

## B1. BLOCKING - the group-text roster ALREADY resolves on read, and writes back

Spec section 2 says refresh-on-write "was considered and NOT chosen", section
3.2 enumerates three writers, and section 6.1 says "Nothing in this spec removes
or changes a writer". S2 then says of `routes/api.ts`: "the group thread HEADER
is a raw passthrough and the dashboard computes the title client-side from
`header.participants`, so hydrating that passthrough is what makes 'renaming
shows in group conversations' true."

`app/src/routes/api.ts:2017-2117` is `GET /api/conversations/:id/group-members`.
It reads every member's contact (`:2043-2072`), derives the contact name
(`:2081-2083`), prefers it over the roster snapshot with the comment "The
CONTACT's name is fresher than the roster snapshot taken at creation"
(`:2085-2086`), sets `rosterNamesAreStale` (`:2087`), and then WRITES THE ROSTER
BACK through `conversations.backfillGroupTextRoster` (`:2099-2114`).

Consequences the spec does not account for:

- Resolve-on-read for native `group_text` rosters is not new. It ships, and it
  is coupled to a converge-on-read WRITE. That write is a fourth writer of
  `participants[].name` and section 3.2's writer enumeration misses it.
- `dashboard/src/routes/conversation/GroupTextView.tsx:190-221` mirrors the same
  convergence client-side and documents the resulting behaviour precisely
  ("on the FIRST open after a nameless stub is triaged into a real contact, the
  header renders the snapshot's numbers and then re-titles a beat later").
  The spec's stated symptom - "renaming a contact does not change group
  conversation titles" - is therefore already addressed for `group_text`
  threads that get opened.
- The route 404s for anything that is not `group_text` (`api.ts:2021-2026`), so
  the surface that genuinely has NO convergence is the RELAY group. The spec
  never separates the two, so a builder cannot tell which symptom S2 is fixing
  or which existing mechanism it must not fight.

A builder must reconcile the new in-memory hydration with this existing
read-triggered write before touching S2, or the two will race on the same rows.

## B2. BLOCKING - section 8 re-points a helper that is NOT a trim variant

Section 8's whole framing is "trims before joining" vs "does NOT trim", and it
scopes the branch to re-pointing four copies onto `contactDisplayName`, one of
which is `routes/inbox.ts:536`.

`app/src/routes/inbox.ts:534-543` is not a trim variant. After the
firstName/lastName join fails it has an EXTRA rung:

- `:540-542` falls back to a single denormalized `contact.name` field.

`app/src/lib/contactName.ts:67-73` has no such rung. Re-pointing inbox's
`nameFromContact` onto `contactDisplayName` makes every contact whose only name
lives in `name` render NAMELESS in the inbox. Section 8 states the change is
"a behavior change on four surfaces" and characterises that change purely as
trimming; the mandated test ("a test asserting the trimmed result") would pass
while the regression ships.

## B3. BLOCKING - unenumerated readers of `participants[].name`

Section 11's risk table asserts "the reader table in 3.1 plus the boundary table
in S2 are the enumeration". A tree-wide grep of `app/src` and `dashboard/src`
finds these readers, none named anywhere in the spec:

Server, user-facing or outbound:

| site | what it renders |
|---|---|
| `app/src/routes/webhooks/twilio.ts:1810` | `groupThreadLabel(thread.participants)` - group inbound PUSH TITLE (phone lock screen) |
| `app/src/routes/webhooks/twilio.ts:1814-1818` | roster name as the push BODY sender prefix |
| `app/src/routes/webhooks/twilio.ts:727` | `relayThreadLabel(relay)` - relay inbound push title |
| `app/src/routes/webhooks/voice.ts:116-121` | `maskedPartyLabel` - spoken/stored relay party label |
| `app/src/routes/poolNumbersAdmin.ts:109` | `relayMemberLabels(conv.participants)` - admin serverLabel |
| `app/src/routes/tours.ts:1351-1354` | member name on the tour group-open path |
| `app/src/services/relayGroupDuplicates.ts:129-130` | duplicate-group warning names |
| `app/src/services/groupSend.ts:253` | `member.name?.trim()` |
| `app/src/services/rosterEdits.ts:399-404, 473, 543-547, 672` | roster preview + announcement bodies |
| `app/src/lib/rosterResolution.ts:219-228` | `resolveRoster` - the OTHER roster path, untouched by S3 |
| `app/src/routes/today.ts:1001` | relay close-nag `memberNames` (S1 names this one) |

Client, reading a raw passthrough the S2 table does not list:

| site | fed by |
|---|---|
| `dashboard/src/routes/quickReply/QuickReply.tsx:53-61` | `GET /api/calls/:callId` (`app/src/routes/api.ts:2190-2198`) - a THIRD raw `conversation` passthrough |
| `dashboard/src/routes/placements/PlacementDetail.tsx:372-375` | `getConversation` -> `app/src/routes/api.ts:1993-2002` |
| `dashboard/src/routes/tours/TourDetail.tsx:453-455` | same route |
| `dashboard/src/lib/memberAttribution.ts:77, 120` | `header.participants` |
| `dashboard/src/routes/conversation/GroupTextView.tsx:98-105, 313, 505` | `header.participants` |
| `dashboard/src/routes/contact/Timeline.tsx:378` | timeline roster |
| `dashboard/src/routes/shared/rosterPeople.ts:28` | `roster.members` (describeRoster - covered by S3) |

S2's table gives a line number for every entry except "routes/api.ts
conversation detail", which is the one that actually feeds four of the client
readers above. It is `app/src/routes/api.ts:1993-2002` (a bare
`res.json({ conversation })`), and `:2190-2198` is its sibling for calls.

## B4. BLOCKING - 4.2's ruling is applied to a once-only OUTBOUND body

Section 4.2 says the missing-key-means-fallback ruling is safe because "a
partial batch degrades to exactly today's behavior - stale but present", and
that "Nothing in this spec uses a hydrated name to decide WHO receives a
message; hydration is display and message-body copy only."

Test that against the mechanism. `app/src/jobs/relayFanOut.ts:189-206`
(`composeConnectionSentence`) DROPS every member with no name and substitutes a
count: "You're now connected with 2 other people on this number."
`composeIntroBody` (`:217-221`) and `composeMemberAddedBody` (`:238-250`) both
route through it, and S4 changes exactly those two.

For a member with a `contactId` and a LIVE contact name but NO stored roster
name - the majority shape the spec's own measurement describes - the outcome is
now a function of whether the BatchGet chunk succeeded:

- batch OK: "connected with Alice, Bob, and Carol"
- batch throttled: "connected with 2 other people"

That is not "today's behavior"; it is a NEW nondeterminism in delivered SMS
content. And it is unrecoverable: the intro is idempotent behind a job execution
marker (`relayFanOut.ts:615-622`), so the message is sent once and never
recomposed. The spec explicitly frames 4.2 as "the opposite ruling from a SEND
path" while S4 applies it to a send path's body. Either S4's two body sites take
`requireComplete` (and fail the job so redelivery retries), or the spec must
argue why a permanently-wrong announcement is acceptable. It does neither.

## B5. HIGH - 3.1's "blessed pattern" claim is false for group pushes

Section 3.1: "The three push sites already read `contactDisplayName(contact) ??
snapshot ?? phone` - live contact first, stored copy as fallback. That
precedence is already this repo's blessed pattern."

True for the 1:1 title chain (`twilio.ts:1042-1046`, `:2284-2288`,
`voice.ts:154-168`). False for the group/relay push chain, which is the
precedence the spec calls "BACKWARDS" when it finds it in `describeRoster`:

- `app/src/routes/webhooks/twilio.ts:307-315` - `pushSenderLabel` returns the
  ROSTER SNAPSHOT name first (`:312-313`) and only then `contactDisplayName`.
- `app/src/routes/webhooks/voice.ts:116-121` - `maskedPartyLabel` returns
  `member.name` first (`:117`) and only then the contact-derived role.

So the repo has two contradictory precedences shipping side by side, and the
"blessed pattern" the spec leans on for authority does not exist as stated. The
S3 flip is correct in isolation but leaves two lock-screen surfaces on the
opposite rule.

## B6. HIGH - partial hydration reintroduces the divergence groupTitle exists to prevent

`app/src/lib/groupTitle.ts:1-16` is explicit: "it must be ONE rule. Three
surfaces name the same thread ... When they each derived their own title they
disagreed in public". `GroupTextView.tsx:190-208` records the same failure mode
in the client, including the specific "numbers, then names, a beat later"
flicker that fix wave 5 rejected.

S2 hydrates the inbox row, the single-row refresh, the api passthrough and the
two contacts cards. It does NOT hydrate `twilio.ts:727` / `:1810` (push titles),
`poolNumbersAdmin.ts:109`, or `relayGroupDuplicates.ts:129`, all of which call
the SAME `groupThreadLabel` / `relayMemberLabels` helpers over the same roster.
After this branch, one thread will be named "With Alice & Bob" in the inbox and
"With (555) 010-0002 & (555) 010-0003" in the push for the same event. That is
the exact regression the one-rule invariant was built to stop, and the spec
neither names it nor argues it is acceptable.

## B7. HIGH - S5's audit extension cannot be built as described

S5: "`auditDenorm` skips group rows outright at `:510`. Add a group-roster pass
reporting, over `relay_group` + `group_text` rows..."

`app/scripts/measure-unread-contact-coverage.ts:504-509` walks
`conversations.listByLastActivity({ status: 'open', limit: 100 })`. The skip is
at `:509`, and removing it is NOT sufficient:

- A native group thread's status is `group_open`, not `open` - see
  `app/src/lib/seed/lean.ts:242` and the dedicated `listGroupTexts` reader at
  `app/src/routes/inbox.ts:1216`. `group_text` rows are in a different
  partition and the current query can never return one.
- Closed relay groups live in the relay status partitions
  (`app/src/routes/contacts.ts:1160-1167` documents the two-partition read).

So S5 requires a new SOURCE (`listGroupTexts` plus `listRelayGroups` for both
statuses), not a removed `continue`. As written a builder would ship a group
pass that reports zero group_text rosters and call the fix proven.

## B8. HIGH - "No client change is needed anywhere" is asserted, not established

Section 4 states it flatly. It is only true if EVERY route feeding a client that
computes from `participants[].name` is hydrated. Per B3 that set includes
`api.ts:1993-2002` and `api.ts:2190-2198`; neither carries a line number in S2's
table, and the calls route is absent entirely. `QuickReply.tsx:53-61` renders a
recipient name to the founder's phone from `/api/calls/:callId`.

Either S2's boundary table grows to include both routes, or the claim must be
narrowed to the surfaces it actually covers.

## B9. HIGH - S1's client note contradicts itself

S1: "Today's rows are built SERVER-side ... so this file's `conversationWho` is
dead for the M1 surfaces; the build must CONFIRM that with a test rather than
assume it, and if it is live, the client falls back to the server `who`."

`dashboard/src/routes/today/buildToday.ts:1` and `:22` say it plainly: this is
"the CLIENT-SIDE FALLBACK assembly", "used only when GET /api/today" is
unavailable. It is wired live at `dashboard/src/routes/today/useToday.ts:67`.
So the file is not dead - and the proposed remedy is incoherent, because the
only path that reaches `conversationWho` is precisely the path on which the
server `who` does not exist. The correct disposition is either "accept the
degraded fallback and say so" or "resolve client-side from `participants[0]`",
not "fall back to the server value".

## B10. HIGH - resolve-on-read does not deliver name DELETION or correction-to-blank

Section 2's decision is "resolve on read, everywhere" and section 4.1's rule is
`contactDisplayName(contactsById.get(p.contactId)) ?? p.name`.

That expression cannot tell three cases apart: contact read failed, contact
absent, contact present with an EMPTY name. All three fall to the stored copy.
So clearing a contact's name - a legitimate correction, e.g. an auto-captured
wrong name - leaves the stale stored name rendering forever on every surface,
which is the original bug with the sign flipped. Section 2's stated guarantee
("Every surface resolves the name from the contact record at the moment it
renders") is not what the mechanism delivers. It delivers "resolve a NON-EMPTY
live name, else the snapshot".

State the limitation, or make the map's key-presence meaningful.

## B11. MEDIUM - `withLiveNames` has no soft-delete guard; every comparable site does

`getManyByIds` does not filter soft-deleted contacts (`app/src/repos/contactsRepo.ts:1081-1083`
-> `batchGetByIds:810-853`; no `deleted_at` filter). Section 4.1's rule reads the
map and calls `contactDisplayName` unconditionally.

Every existing analogue in the tree guards:

- `app/src/lib/rosterResolution.ts:522` computes `removed` and 544-545 respects it.
- `app/src/routes/api.ts:2095` marks a deleted member.
- `app/src/routes/api.ts:2157` refuses to hydrate a display name from a deleted
  contact outright.

S3 keeps the `removed` guard for `describeRoster` and correctly says so, but the
NEW helper that S2 and S4 both use has none. Decide and state it.

## B12. MEDIUM - the spec picks the wrong batch primitive

The repo already has a projected display-name batch read built for exactly this:
`app/src/repos/contactsRepo.ts:856-865` (`DISPLAY_PROJECTION`:
contactId/firstName/lastName/phone/deleted_at) exposed as `getDisplaysByIds`
(`:1077-1079`), and it is used for precisely this job at
`app/src/routes/api.ts:2152`. It also projects `deleted_at`, which is what B11
needs.

Section 2 mandates `getManyByIds` (full item) instead, without mentioning
`getDisplaysByIds` exists. On an inbox page that is a whole-item read per member
where a four-attribute projection would do.

## B13. MEDIUM - the "ONE getManyByIds per page" pin does not bound round trips

Section 11 mitigates read amplification with "ONE `getManyByIds` per page,
pinned by a call-count test", and section 10 repeats it.

`batchGetByIds` chunks at 100 keys (`app/src/repos/contactsRepo.ts:824`) and
retries `UnprocessedKeys` up to four times per chunk (`:827-838`). A call-count
assertion on `getManyByIds` therefore reads 1 whether the page issued one
BatchGet or twelve. The pin measures the wrong quantity. The contacts group-
threads card is the worst case: `app/src/routes/contacts.ts:1265-1267` reads
`CONTACT_GROUP_THREADS_LIMIT` threads BEFORE filtering to the ones this contact
is in, so a naive "collect ids across the page" hydrates rosters that will be
discarded.

## B14. MEDIUM - no failure posture for S4's per-message single read

Section 4.1 gives `hydrateConversationRosters` an explicit "Never throws"
contract. S4's sender-prefix change is a bare
`contacts.getById(senderMember.contactId)` on `app/src/jobs/relayFanOut.ts:405`,
the per-message relay delivery hot path, and no such contract is stated. An
unguarded throw there fails the fan-out job for a message that would otherwise
have been delivered with a stale prefix. Also unstated: `senderMember` is found
by member key (`:401`) and may be a bare-phone member whose `contactId` is `''`
(`app/src/services/relayMembers.ts:76`), so the read needs the same
bare-phone guard 4.1 gives the batch path.

## B15. MEDIUM - the writer enumeration in 3.2 is short by at least four

Section 3.2 names `routes/contacts.ts:1753`, `jobs/placementNudges.ts:554`,
`routes/contacts.ts:1871`. Also writing a name snapshot:

- `app/src/routes/api.ts:2107` `backfillGroupTextRoster` (see B1).
- `app/src/services/relayMembers.ts:50-61` `resolveMemberName` - explicit >
  contact-derived, at member-add time.
- `app/src/services/groupConvert.ts:218-229` - resolves and stores a member name
  during conversion.
- `app/src/jobs/relayFanOut.ts:465-471` - stores `name` into
  `relay_opted_out_members`, which `app/src/routes/today.ts:606-613` then reads.

Since 3.2's stated purpose is "evidence against refresh-on-write", an
enumeration that misses the one writer already doing refresh-on-read weakens the
argument it is offered for.

## B16. MEDIUM - S4 creates a preview/send divergence

The operator-facing previews compose from the STORED roster, not the hydrated
one:

- `app/src/services/rosterEdits.ts:472-473` - `composeIntroBody(parts.bodyMembers.map(m => m.name))`
- `app/src/services/rosterEdits.ts:672-676` - `composeMemberAddedBody(...)` over
  `resolveRoster` members, i.e. `app/src/lib/rosterResolution.ts:221` raw `p.name`.

S4 hydrates only the JOB bodies (`relayFanOut.ts:634`, `:684`). After this
branch the text an operator confirms and the text the group receives can differ
by name. Worse, `relayFanOut.ts:633` honours a persisted operator-EDITED
`intro_body` verbatim, so an operator who edits a stale-named preview pins the
stale names past the fix.

## B17. MEDIUM - section 8's helper census is wrong in both directions

Claimed: "The issue says six private copies. There are thirteen."

Missing from the table (both are real private copies of the same derivation):

- `app/src/routes/placements.ts:165-171`
- `app/src/services/inboundEmail.ts:399-405` - and `app/src/lib/contactName.ts:54`
  names this file as one of the five it knows about, so the omission is visible
  from the canonical helper's own docblock.

Miscategorised: `app/src/lib/voiceMasking.ts:46-53` is `contactShortName`, which
returns "First L." - an initial-only surname, described at `:42-44` as a
deliberate privacy posture. It is not a trim variant of `contactDisplayName` and
must not sit in a "trims before joining" column of interchangeable copies.

Since section 8's deliverable is "the issue file is updated with the true count
of thirteen, the trim/no-trim split", shipping this table writes a new wrong
count over the old wrong count.

## B18. MEDIUM - section 8 contradicts an in-code scope guard without saying so

`app/src/lib/contactName.ts:52-60` is a SCOPE GUARD comment naming five private
copies and instructing: "consolidating the older copies is tracked in
docs/issues/consolidate-contact-display-name-helpers.md - do not re-point them
here as a drive-by."

Section 8 re-points four copies. That may well be right, but the spec neither
quotes the guard nor says it is being lifted, so a builder following the code
comment and a builder following the spec will do opposite things. The comment
must be amended in the same change.

## B19. LOW - 4.1's error contract does not match the primitive

"Never throws: a failed batch yields the input unchanged (stored names)", and
section 10 tests "a throwing batch yields input unchanged".

Without `requireComplete`, `batchGetByIds` swallows a failed chunk
(`app/src/repos/contactsRepo.ts:839-844`) and logs unprocessed keys
(`:847-851`); it returns a PARTIAL map and does not throw. So the realistic
degraded case is a partially hydrated page, not an unchanged one, and the
section-10 test exercises a path that only `requireComplete` can produce. Write
the test for the partial map.

## B20. LOW - citation errors

- 3.2: "The fan-out also finds threads by the contact's CURRENT phone
  (`routes/contacts.ts:1741`)". `app/src/routes/contacts.ts:1741` is the EMAIL
  loop (`findByParticipantEmail`); the phone lookup is `:1738`.
- 3.1: prose says "Four more readers exist" above a SEVEN-row table.
- S3 quotes `lib/rosterResolution.ts:544`; the expression spans `:544-545`.
- S5 cites `:510` for the group skip; it is `:509`.
- 3.3 says the People card "already backfills a name at `:544`" - correct - but
  also that `describeRoster` "already reads every member's contact inside
  `describeRoster`" at `:511`, which is inside the payload loop starting `:506`.
  Verified, no correction; noted only because the surrounding cites drift.

## B21. LOW - the client Today mirror keeps the empty-string bug S1 hardens

S1's server rung is "`conv.participant_display_name` (non-empty)".
`dashboard/src/routes/today/buildToday.ts:106` uses a bare `??`, so a stored
EMPTY display name is SELECTED - the exact defect called out and guarded at
`app/src/routes/webhooks/voice.ts:156-162` and pinned by
`app/test/founderTriage.test.ts:144`. Given B9 says this path is live, the
branch hardens the server and leaves its mirror soft.

## B22. LOW - `contactDisplayName`'s stated contract is being widened silently

`app/src/lib/contactName.ts:50-60` documents the export as "consumed by
PUSH-COPY sites only". Section 4.1 makes it the universal name resolver for
inbox rows, group titles, Today and relay message bodies. The contract note
needs updating in the same change or it becomes actively misleading.

---

## Verified as stated (no finding)

Recorded so the next reviewer does not re-derive them:

- 3.3's zero-new-reads claim for Today. The `getContact` memo is
  `app/src/routes/today.ts:356-369`; `isDeletedContact` (`:377-380`) populates it
  for every walked 1:1 at `:742-746`, ahead of the cap, and `whoOfConversation`
  runs at `:778`. `whoOfConversation` (`:1075-1080`) has exactly one call site.
- 6.3. `toConversationUpdatedEvent` (`app/src/lib/events.ts:91-...`) is a pure
  sync builder, and no non-test dashboard file patches a row from the event's
  `members` / `participant_display_name`; consumers refetch
  (`dashboard/src/routes/conversation/useGroupThread.ts:16`,
  `useRelayThread.ts:9`).
- 6.4's tourReminders claim. `app/src/jobs/tourReminders.ts:1151-1157` reads
  `members.length` and `pool_number` only, and returns `members` for phones. No
  `.name` read.
- 6.2's justification. `app/src/routes/contacts.ts:1160-1167` does document the
  absent member->conversation index.
- S2's synchronous-`groupRowFor` claim (`app/src/routes/inbox.ts:1190-1200`,
  called at `:1237` and `:2358`), and the async `relayRowFor` (`:1154`) at
  `:1418` and `:2293`.
- The lean seed's roster names match its contacts
  (`app/src/lib/seed/lean.ts:108-109, 136-137, 165-166` vs `:249-250, 266-267`),
  so hydration is a no-op there and existing e2e strings are safe. Note the
  corollary: the lean world cannot exercise this fix without a runtime rename,
  which is what section 10's e2e does.
- The existing Today unit tests that pin a formatted phone as `who`
  (`app/test/todayApi.test.ts:345-346`) reference contactIds that are never
  seeded into `world.contacts`, so S1 does not break them - and equally, the
  suite has ZERO coverage of the rung S1 changes today.
