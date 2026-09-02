# Spec review C - adversarial, pre-build

Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` (v6)
Tree: `W:\tmp\participant-snapshot-refresh` @ `35f2e549` (post `b702a81c` main merge)
Method: every claim below was checked against the working tree as it stands now.
Spec line numbers are quoted as `spec:N`; code as `path:N`.

---

## 1. BLOCKING - the spec contains two mutually exclusive section 3.1s

The file OPENS mid-section: `spec:1` is `### 3.1 One population this branch does
not fix - and one that turned out not to exist`, and the document's `# ` title
does not appear until `spec:32`. A second `### 3.1` appears at `spec:288`:
`Two populations this branch does NOT fix, and the gap RECURS`.

They contradict each other on the same population, and both are asserted as
planner-verified:

- `spec:3-20` - the merged-stub population "never existed"; "There is no contact
  merge mechanism in the tree at all"; "rung 1 resolves it correctly"; "There is
  no recurring gap, no dangling-id population."
- `spec:293-304` - "Population 1 - a roster `contactId` pointing at a
  merged-away stub" is real, "rung 1 misses again on the next rename, and every
  rename after that. The gap RECURS per rename; it does not heal."

The top block is the one the code supports: triage is an in-place
`router.patch('/:contactId', ...)` at `routes/contacts.ts:1391`, and a
tree-wide search for a merge route/service/repo method finds none. But that does
not make the contradiction harmless, because downstream text is wired to BOTH:

- The issue disposition table (`spec:48`) sends the reader to "3.1" for the
  bare-phone relay members - ambiguous between two sections.
- S5's metric 5 (`spec:631`, "members whose `contactId` resolves to NOTHING (a
  dangling id)") exists to SIZE the population `spec:16` says does not exist.
- `spec:634` states "The metric v4 called 'metric 6' is DELETED" immediately
  after a list whose item 6 is present at `spec:632-633`. A builder cannot tell
  whether to implement five metrics or six, or which six.
- `spec:30` says "S5 sizes them" (one population); `spec:310` says "S5 sizes
  both" (two).

A builder cannot resolve this from the spec. Delete one section, renumber S5's
metrics explicitly, and make `spec:48` point at a heading that is unique.

## 2. BLOCKING - 5.5's read-cost ruling rests on a refetch that does not exist

`spec:461-463`: `GET /conversations/:id` "is a zero-read passthrough refetched
on a DEBOUNCED SSE TICK for the life of an open thread (`useGroupThread.ts:16`,
`useRelayThread.ts:437`)".

Every header fetch in the tree is a MOUNT-scoped effect keyed on
`[conversationId]`:

- `dashboard/src/routes/conversation/ConversationDetail.tsx:82-105` (dep array
  at `:105`)
- `dashboard/src/routes/placements/PlacementConversation.tsx:284-297` (dep array
  at `:297`)
- `dashboard/src/routes/tours/TourConversation.tsx:428-441` (dep array at `:441`)
- `dashboard/src/routes/placements/PlacementDetail.tsx:370` and
  `dashboard/src/routes/tours/TourDetail.tsx:451` - one-shot, user-action

Neither cited hook fetches the header. `useGroupThread.ts` imports only
`getConversationMessages` (`:19-25`); its `:16` comment is about the TIMELINE
refetch. `useRelayThread.ts:437-445` is the debounced `fetchNow` for messages.
`grep "getConversation("` across `dashboard/src` returns exactly the five call
sites above plus the endpoint definition at `dashboard/src/api/endpoints.ts:802`.

Consequence: hydrating the header costs ONE batched read per thread OPEN, not
one per SSE tick. That is the premise for this branch's largest scope decision -
`spec:340` marks the route NOT HYDRATED, `spec:48` records the resulting hole as
an unclosed half of a `high` issue, and `spec:480-486` accepts the
PlacementDetail/TourDetail gap on the same cost argument. The whole chain is
argued from a mechanism that is not in the codebase, which is the exact failure
mode `spec:18-20` says nobody should re-derive a third time.

Re-decide 5.5 on the real cost. Whatever the answer, the section must stop
citing a per-tick refetch.

## 3. HIGH - the corroborating citation for 5.5 points at the wrong comment

`spec:463-464`: "`GroupTextView.tsx:200-206` records a production symptom from
latency on a sibling per-tick read."

`dashboard/src/routes/conversation/GroupTextView.tsx:186-212` is the
write-back-failure and first-open re-title record - it says nothing about
latency. The latency note is at `:108-119`, and it is about the MEMBER PANEL's
per-tick `setMembersStatus('loading')` making an alert a false negative "once
latency exceeded the inter-tick gap". Different read, different symptom,
different conclusion. With finding 2 this leaves 5.5 with no standing evidence.

## 4. HIGH - "every line number was re-derived by symbol" is false, and two of
the stale ones are edit instructions

`spec:162-163` claims all citations are accurate as of `b702a81c`. At least six
are not, and they fail in exactly the way `spec:196-199` warned about and then
did not apply.

- **`relayGroups.ts:471-474` (twice, and both are instructions).** `spec:538`
  ("Amend `:471-474` ... to state the three-rung chain") and `spec:448` (5.4's
  census of inverted comments). `routes/relayGroups.ts:473-476` is the POSITIVE
  type-guard 404 comment. The precedence comment S2 actually falsifies - "current
  name wins, otherwise the dashboard uses this current roster phone as its
  fallback" - is at `:484-487`, which is 471-474 plus the ~13-line shift
  `spec:197` predicted. Following the instruction literally rewrites an
  unrelated comment and leaves the wrong one standing, which is precisely the
  failure 5.4 exists to prevent. (`spec:256-265` cites `:484-487` and `:482-489`
  correctly, so the spec disagrees with itself.)
- **S3's two supporting reads.** `spec:567`: "The contact is already read at
  `:511`" - the read is `lib/rosterResolution.ts:528`. "The `removed` guard at
  `:522`" - it is `:541`. Both are exactly +19, the phase-b shift `spec:157`
  documents. Only `:564`, the line S3 edits, was re-derived.
- **`jobs/relayFanOut.ts:465-471`** (`spec:363`, in the WRITERS list). That range
  is phase-b's owner-routed intro-variant composer (`:460-475`). The
  `relay_opted_out_members` write is around `:834-839`.
- **`tourReminders.ts:1151-1162`** (`spec:214-215`, "Verified twice ... reads
  `members.length` and `pool_number` only, never `.name`"). `jobs/tourReminders.ts:1145-1165`
  is the D7 REMINDER COUPLING comment block; it contains no roster read at all.
  The conclusion may still hold at `:1380`; the cited evidence does not exist.
  UNVERIFIED as stated.
- **`routes/api.ts:457`** (`spec:323`) is `participant_phone`; the
  `participant_display_name` read is `:460`. **`routes/api.ts:1993-2002`**
  (`spec:340`) - the route is `:1996-2005`.
- **`scripts/measure-unread-contact-coverage.ts:509`** (`spec:615`) - the
  `continue` skip is `:510`.

Implication for the build: no citation in this spec is trustworthy. Say so in
the spec, or re-derive all of them. The two instruction sites above must be
fixed before anyone edits.

## 5. HIGH - S1 is titled "zero new reads" and adds a read in its own last
paragraph, and the test that should catch it cannot

`spec:490` heads the slice "S1 - Today (zero new reads)". `spec:515` then says
"Also hydrate the relay close-nag `memberNames` (`:1001`) over the bounded
`listRelayGroups('open')` list."

Those are relay ROSTER member contactIds (`routes/today.ts:1000-1002`). The
memo the zero-read argument depends on is seeded only by the walked 1:1 owner
check - `contactCache`/`getContact` at `routes/today.ts:356-368`, reached via
`isDeletedContact` at the `:743` gate. Relay members are not walked 1:1 owners,
so they are not in that map, and hydrating them requires a `getDisplaysByIds`
call `GET /api/today` does not make today.

The section-10 test cannot catch this: `spec:707` pins "`contacts.getById` call
count UNCHANGED", and a `getDisplaysByIds` addition passes that trivially. The
mitigation in risk row 1 (`spec:743`) is likewise about `getDisplaysByIds`
projection size, not about whether a new call appears on a route that had none.

Either restate S1 as "one new batch read on the close-nag list" and pin THAT, or
move the close-nag hydration into S2 where the read budget is argued.

## 6. HIGH - S2's "one batch per page" does not fit two of the sites it owns

`spec:527-528`: "Each becomes: collect contactIds -> one `getDisplaysByIds` ->
map with `withLiveNames`. `groupRowFor` takes the resolved map as a second
argument rather than becoming async."

Two of the cited sites are single-row paths where no page-wide roster is known
before the row is built:

- `routes/inbox.ts:1418` - inside a per-candidate builder that does its OWN point
  read at `:1401` and then builds one row
  (`candidate.kind === 'relay_group' ? await relayRowFor(fresh) : groupRowFor(fresh)`).
- `routes/inbox.ts:2293` - `const row = await relayRowFor(conv);` inside
  `for (const conv of relayItems)` at `:2291`.

At both, the choice is one batch read PER ROW - the amplification risk row 1
claims to have mitigated - or an unhydrated reader, which is where the fix
silently fails to land. The spec addresses neither.

Related mis-filing in the same table: `spec:344-345` puts `:1418` in the
`relayRowFor` row, but that line calls `groupRowFor` too. So the `groupRowFor`
row's site list (`:1237, :2358`) is short by the one site whose signature S2
changes, and the definition at `routes/inbox.ts:1190` - the line that actually
gains the parameter - is never cited anywhere in the spec.

## 7. MEDIUM - 5.1's contract for `withLiveNames` omits the soft-delete rung 5.3
declares mandatory

`spec:399-401`: "Per member: `contactDisplayName(resolved.get(p.contactId))` if
non-empty, else `p.name`." No `isDeleted` test.

`spec:432`: "**Rung 1** never serves a soft-deleted contact's name; such a member
falls to rung 2", and `spec:701` asks for a test proving it.

5.1 is the function's spec of record. A builder implementing it literally ships
the leak. It is feasible to fix - `DISPLAY_PROJECTION`
(`repos/contactsRepo.ts:856-865`) carries `deleted_at`, and `isDeleted`
(`:309-311`) takes `Pick<ContactItem, 'deleted_at'>` so the display shape
satisfies it - the contract just does not say to.

## 8. MEDIUM - S4 breaks 5.4, the spec's own standing rule, in the one slice that
inverts two commented rules

5.4 (`spec:444-454`) requires that any spec inverting a commented rule NAME the
comment, and that a slice with no such comment say so explicitly. S4
(`spec:584-612`) does neither, and there are two:

- `routes/webhooks/twilio.ts:301-306` - `pushSenderLabel`'s docblock states the
  chain S4 inverts, in order: "roster name -> contact display name -> formatted
  phone -> the raw From (spec 3.4 fallback chain)".
- `routes/webhooks/voice.ts:109-115` - `maskedPartyLabel`'s docblock: "the
  resolved display name when one is known, else the role ... `name` is the
  roster-cached display name (resolved at member-add time)".

5.4's own census at `spec:448` lists three comments and misses both. S3, by
contrast, does carry the required "none" statement (`spec:570-575`); S4 is
simply silent.

## 9. MEDIUM - S4's rung 2 names a transform that does not exist

`spec:605-607`: "rung 2 applies the SAME short-name transform to the stored
string that `contactShortName` applies to a contact - 'First Last' stored becomes
'First L.' rendered."

`contactShortName` (`lib/voiceMasking.ts:46-53`) takes
`ContactItem | undefined` and reads `firstName`/`lastName`. There is no
string-shaped variant in the tree. So S4 requires a new split-and-abbreviate
helper over free text, and the spec does not say where it lives or how it
behaves on a stored name that is not "First Last" - one token, three tokens, or
an already-abbreviated "First L.". This matters more than usual because the
output is PERSISTED (`routes/webhooks/voice.ts:993-1002`, acknowledged at
`spec:611-612`): a wrong transform writes a wrong label into the message record.

It also mints a sixth private copy of a display-name derivation while section 8
(`spec:679-680`) keeps `consolidate-contact-display-name-helpers` open and says
this branch "re-points NOTHING as a drive-by". Adding a copy is the same debt in
the other direction, and the issue's census should record it.

## 10. MEDIUM - the risk table contradicts S4 on whether rung 2 exists

`spec:752`: "Un-masking a persisted voice label | S4 pins `contactShortName`,
**takes no rung 2**, and pins the stored `call_party_label`."

`spec:596-601` calls "no rung 2" a REGRESSION introduced by v4 and restores a
masked rung 2, on the grounds that dropping it would send a bare-phone member
from their stored name straight to "the other party". The risk table still
carries the v4 language. Two decisions that cannot both hold, in one document,
and the table is the part a builder skims.

## 11. MEDIUM - `lib/events.ts` is an unenumerated reader of `participants[].name`

`toConversationUpdatedEvent` puts the RAW roster on the `conversation.updated`
SSE payload for both relay and native groups: `lib/events.ts:110`
(`members: item.participants ?? []`, relay arm) and `:117` (group arm). It is
emitted from ~15 sites, including the identity fan-out that performs the rename
this branch exists to propagate - `routes/contacts.ts:1758`.

Section 4.1 cites `lib/events.ts:103` for `participant_display_name`; section
4.2 omits the file entirely, and its client-reader list (`spec:352-359`) claims
every client reader is "all fixed by hydrating the passthroughs above with NO
client edit". The SSE payload is not one of those passthroughs.

Severity is MEDIUM rather than HIGH because I found no dashboard code that reads
`members` off the event - consumers treat `conversation.updated` as a refetch
trigger (`useInbox.ts:96`, `useRoster.ts:5-10`, `useGroupThread.ts:16`) - so
this is a wire-contract gap today, not a live render bug. But the field is
declared on the client DTO (`dashboard/src/api/types.ts:1686`), and
`lib/events.ts:96` records that the payload shape is "pinned by exact-equality
tests", so it is not a cheap later fix. 4.2's "not asserted exhaustive" caveat
(`spec:315-317`) is a fair posture; it should not be used to omit the one
payload the RENAME path emits.

## 12. MEDIUM - a registry-tracked writer that BLANKS `participants[].contactId`
is missing from both population analyses

`docs/issues/import-blanks-conversation-participant-contactid.md` is open,
severity `med`, and its front-matter refs `app/src/lib/import/apply.ts:389-392`.
That code writes `contactId: contactIdByPhone.get(phone) ?? ''` with no `name`,
and the issue title is "A re-import unconditionally overwrites a 1:1
conversation's participants and can blank an established contactId".

That is a live, tracked producer of exactly the two populations 3.1 argues
about - rows whose `contactId` cannot serve rung 1, and rows with no usable
`contactId` at all - and neither 3.1 mentions it. `spec:211-212` fences
`participants[].contactId` ownership to bundle M8 without naming this issue,
and `spec:761-762` tells the builder to file deferrals; naming the existing
issue avoids a duplicate and gives S5's metrics 5 and 6 a known source to
compare against.

## 13. MEDIUM - the seed/fixture claim is under-evidenced and short by one site

`spec:730-732`: "`lean` and `cast` were verified consistent by both reviewers, so
e2e strings are safe."

The only regression guard behind that is `app/test/seedRosterShape.test.ts`,
whose name pin at `:83-104` covers `relay_group` rosters ONLY, across profiles
`lean`, `cast`, `matrix` (`:27-31`). It does not cover:

- the `group_text` rosters at `lib/seed/cast.ts:1353-1356` and `:1408-1412` and
  `lib/seed/lean.ts:248-251`, which are what the group-title e2e assertions read
  (`e2e/tests/dashboard-next/group-text-detection.spec.ts:61,72-73`;
  `group-text-conversion.spec.ts:77,90-91`);
- the `live` profile (`lib/seed/live.ts:303-310`, `:328-332`);
- the `performance` profile.

So the claim is a manual inspection with no guard on the exact rows S2 changes.
I spot-checked `cast.ts:1353-1356` and `lean.ts:248-251` and they look
consistent, so this is a coverage gap rather than a known break - but the spec
should say which of the two it is.

Separately, the performance-fixture list is short: `spec:726-728` names
`performance.ts:842` and `:857-858` and misses `lib/seed/performance.ts:887-890`,
which bakes `Synthetic ${contact.type}` into the NATIVE GROUP rosters that S2
also hydrates.

## 14. LOW - 2.2 carries a self-referential instruction from a blanket rename

`spec:114-115`: "`jobs/relayFanOut.ts` - `composeNameList` (becomes
`composeNameList`)". The tree has `composeNameList` at `jobs/relayFanOut.ts:216`
and no `composeConnectionSentence` anywhere, so the parenthetical now instructs
nothing. Artifact of the v6 rename recorded at `spec:160`.

## 15. LOW - the two webhook files are cited under the wrong path prefix

Every other citation is relative to `app/src/` (`routes/`, `lib/`, `services/`,
`jobs/`). The spec writes `webhooks/twilio.ts` and `webhooks/voice.ts` about a
dozen times (`spec:216, 321, 350, 433, 522, 587, 589, 596, 609, 611, ...`). The
files are `app/src/routes/webhooks/twilio.ts` and
`app/src/routes/webhooks/voice.ts`.

## 16. LOW - "It is also redundant" (5.5) overstates: the header is the
first-paint roster source

`dashboard/src/routes/conversation/ConversationDetail.tsx:180` initialises its
`members` state from `header.participants` and only replaces it when `/members`
resolves at `:212`; the title is derived from that state at `:387`. So the
header's stale names ARE rendered, then re-titled a beat later - the same
flicker `GroupTextView.tsx:205-209` records. `spec:476-478` ("the thread views
already receive fresh names ... Hydrating the header would pay a per-tick read
for names the client already has") is true only after the second fetch.

The KNOWN GAP paragraph (`spec:480-486`) names only the two close-group dialogs.
This one is an inherited symptom on relay threads today, not a new regression, so
it is LOW - but 5.5 should name it rather than claim redundancy.

## 17. LOW - internal numbering and cross-reference drift

- Section order runs 2.1, 2.2, 2.4 (`spec:142`), then 2.3 (`spec:209`).
- Two headings numbered 3.1 (finding 1).
- `TourDetail.tsx` is cited as `:453-455` at `spec:48` and `spec:358` but
  `:451-455` at `spec:481`. The names block is `:453-456`; `:451` is the
  `getConversation` call.
- `PlacementDetail.tsx` is `:370-375` at `spec:48` and `spec:480`, `:372-375` at
  `spec:358`. The names block is `:372-375`.
- `spec:716` cites `routes/contacts.ts:1265-1267` as "the contact filter"; that
  range is the `listGroupTexts` call. The `isSelf` filter is `:1262-1263`.

---

## Verified as correct (recorded so the next reviewer does not re-check)

- `routes/api.ts:2020-2128` does resolve by `findByPhone`, prefer the contact
  name, and write back via `backfillGroupTextRoster` (`:2081`, `:2089`, `:2102-2114`).
  The write is `{ ...p, name }` only - `spec:300` is right that `contactId` is
  never rewritten.
- `routes/api.ts:2032-2044` says "the snapshot goes stale", never the id.
- `routes/relayGroups.ts:483` is `if (!member.contactId) return member;`, and
  `:488-489` deletes the stored name. The route is a `Promise.all` of per-member
  `getById` (`:481-504`), so S2's batching complaint stands.
- `routes/contacts.ts:1391` is the in-place triage PATCH; no merge route,
  service, or repo method exists in the tree.
- `lib/rosterResolution.ts:564` is the `describeRoster` precedence line and S3's
  diff matches it.
- `routes/today.ts:743` gates every walked 1:1 through `isDeletedContact` ->
  `getContact` ahead of the cap, and `whoOfConversation` runs at `:778` over that
  same array - so S1's memo claim is correct FOR THE 1:1 ROWS. Both needs-you-now
  and unreplied rows are built from that one call (`:797`, `:829`), so S1 covers
  both symptoms in `spec:74-77`.
- `routes/inbox.ts:534-543` really does have the extra denormalized `contact.name`
  rung (`:540-542`) - section 8's correction is right.
- `contactsRepo.ts:296-302` (`firstName?: unknown`), `:309-311` (`isDeleted`),
  `:597`, `:856-865` (`DISPLAY_PROJECTION`), and the swallow-and-return-short at
  `:839-849` all match the spec. `requireComplete` is on `getManyByIds` only;
  `getDisplaysByIds` (`:1077-1079`) never passes it.
- `lib/contactName.ts:50-60` is the scope guard the spec quotes.
- `dashboard/src/routes/shared/rosterPeople.ts:28` falls back to a contact ID,
  and `dashboard/src/lib/recipientLabel.ts:95-99` carries the quoted invariant -
  both exceptions in `spec:250-255` are real.
- `dashboard/src/routes/today/buildToday.ts:106` does use a bare `??` that would
  select a stored empty display name; `routes/webhooks/voice.ts:155-162` is the
  guarded precedent.
- `app/test/todayApi.test.ts:345-346` pins formatted phones on rows built by the
  contacts-triage pass (`routes/today.ts:927`), not by `whoOfConversation`, so
  S1 does not break them - the conclusion in `spec:708-710` holds even though its
  stated reason is not the operative one.
- The 5.5 view/route table (`spec:469-474`) is accurate about WHICH routes each
  view calls; only the per-tick claim above it is wrong.
- All five issue slugs in the disposition table exist under `docs/issues/`.
