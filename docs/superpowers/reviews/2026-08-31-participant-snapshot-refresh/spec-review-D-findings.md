# Spec review D (adversarial, post-phase-b) - findings

Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md` (v6)
Tree: `feat/participant-snapshot-refresh` @ `35f2e549`, main merged at `b702a81c`
Method: every citation below was opened in the working tree as it stands now. No
prior review round, adjudication, or brainstorm was read. Anything I could not
prove is marked UNVERIFIED.

Byte-exact quotation was not needed: every finding is carried by `file:line` plus
a short identifying fragment, so no separate reference file was written.

---

## BLOCKING

### D1. Two contradictory sections are both numbered 3.1, and one of them sits above the document title

Spec lines 1-30 are a section headed `### 3.1 One population this branch does not
fix - and one that turned out not to exist`, placed BEFORE the `#` title at line
32. Spec lines 288-310 are a second `### 3.1 Two populations this branch does NOT
fix, and the gap RECURS`. They assert opposite things about the same population:

- Line 3: the merged-stub population "never existed"; line 16: "rung 1 resolves
  it correctly"; line 30: "S5 sizes them" (singular population).
- Line 293: "Population 1 - a roster `contactId` pointing at a merged-away stub";
  line 302: "rung 1 misses again on the next rename, and every rename after
  that"; line 310: "S5 sizes both".

Section 3 (lines 281-286) takes a THIRD position - that the case "stays owned by
the EXISTING converge-on-read write at `routes/api.ts:2102-2125`" - which the
second 3.1 explicitly denies at line 300.

Downstream readers pick different winners. The disposition table (line 48) and
the risk table (line 750) both say "the one real uncovered population", matching
the FIRST 3.1. S5's metric list (lines 625-633) enumerates SIX metrics including
a dangling-id metric, matching the SECOND. S5's deletion paragraph (line 638)
then cites "(3.1)" for a population "that does not exist".

A builder cannot determine: how many metrics S5 ships, what the
`group-roster-name-snapshot-never-refreshed` Resolution stamp must name, or
whether bundle M8 owns anything here.

What is actually true in the tree:
- There is no contact-merge mechanism. `grep -rni` over `app/src/routes` and
  `app/src/services` finds only `mergeContext` and `lib/mergeFields.js`; the only
  "merge" comments are phone/email CRUD headers at `routes/contacts.ts:2330` and
  `:2518`. Triage is an in-place PATCH at `routes/contacts.ts:1391`.
- The write-back at `routes/api.ts:2104-2107` builds `{ ...p, name }` - name
  only, never `contactId`. The second 3.1's mechanical claim is correct even
  though the population it attaches it to is not.

Fix: delete one of the two sections outright and reconcile section 3, S5's metric
count, the disposition table and the risk table to whichever survives.

### D2. Section 5.5's cost ruling rests on a claim the client code contradicts: the header route is NOT refetched on an SSE tick

Spec 5.5 (lines 460-464) forbids hydrating `GET /conversations/:id` because "it
is a zero-read passthrough refetched on a DEBOUNCED SSE TICK for the life of an
open thread (`useGroupThread.ts:16`, `useRelayThread.ts:437`)".

`getConversation` has exactly six call sites in `dashboard/src` (definition at
`dashboard/src/api/endpoints.ts:802`):

- `routes/conversation/ConversationDetail.tsx:87` - a mount effect keyed on
  `conversationId`.
- `routes/placements/PlacementConversation.tsx:286` - same shape.
- `routes/tours/TourConversation.tsx:430` - same shape.
- `routes/placements/PlacementDetail.tsx:370` and `routes/tours/TourDetail.tsx:451`
  - one-shot, user-action triggered.

Neither debounced refetch touches it. `useRelayThread.fetchNow`
(`useRelayThread.ts:313-322`) fetches `getConversationMessages` +
`getConversationScheduled`; `useGroupThread.fetchNow`
(`useGroupThread.ts:174-179`) fetches `getConversationMessages`. The two lines
the spec cites are the docblock/comment for the MESSAGE refetch
(`useGroupThread.ts:16-17`, `useRelayThread.ts:437`), not for the header.

The supporting citation is mischaracterised too: `GroupTextView.tsx:200-206` is
cited as recording "a production symptom from latency on a sibling per-tick
read". Read in place (`:199-208`), it records a best-effort write-back failure
and a FIRST-OPEN re-title flicker. There is no per-tick latency symptom there.

Consequences that all inherit the error: the risk row at line 744 declares the
per-tick risk "ELIMINATED"; 4.2 marks `api.ts:1993-2002` "NOT HYDRATED"; the
KNOWN GAP at lines 480-486 accepts stale names in the close-group dialogs
"rather than paid for", where the price is one read PER MOUNT, not per tick; and
the disposition table (line 48) reports the high issue as not closed for those
two cards on that basis.

5.5's SECOND argument (redundancy - the three thread views also fetch a resolved
roster) is independently true and I verified it: `ConversationDetail.tsx:87` +
`:212`; `PlacementConversation.tsx:286` + `:291`; `TourConversation.tsx:430` +
`:435`. The ruling may survive on redundancy alone. The cost claim must be
deleted or corrected, and the accepted gap re-argued at its real price.

### D3. Section 2.4's "the preview-pin collision does not exist" cites the wrong type; S3 is not a no-op on the preview paths

Spec 2.4 (lines 178-183) withdraws the S3/preview collision on this argument:
"`services/rosterEdits.ts:153` types the preview-open owner as
`Omit<RosterOwner, 'roster' | 'groupThreadId'>`. With no `groupThreadId`,
`resolveRoster` can NEVER take its `participants` branch on those paths."

`rosterEdits.ts:151-159` is `interface RosterPlanEditRequest`. The `Omit` at
`:153` is the PLAN-EDIT request's owner, not a preview owner. The preview
builders take a full `RosterOwner`:

- `rosterEdits.ts:545-547` `buildOpenPreview(deps, owner: RosterOwner, ...)`
- `rosterEdits.ts:719-722` `buildAddPreview(deps, owner: RosterOwner, ...)`

Both call `describeRoster` (`:551`, `:725`). And the add path is guaranteed to
carry a thread: `routes/tours.ts:971-973` and `routes/placements.ts:1289-1291`
refuse `preview-add` with `ROSTER_NO_THREAD` unless `threadIdOf(...)` is defined,
then pass `rosterOwnerOf(...)` (`tours.ts:982`, `placements.ts:1300`), which
copies `groupThreadId` through (`tours.ts:595`). So on every production
`preview-add` call `resolveRoster` takes the participants branch
(`rosterResolution.ts:219-240`) and `describeRoster`'s name at `:564` is the
STORED snapshot - exactly the precedence S3 inverts.

The test suite proves the same for `buildOpenPreview`: `app/test/rosterEdits.test.ts:106-115`
says in so many words that it drives `buildOpenPreview` through the `participants`
resolver source, and `ownerFixture` sets `groupThreadId: THREAD_ID` at `:145`.

So S3 DOES change `RosterPreview.recipients[].name`
(`rosterEdits.ts:600-607` -> `toRecipient` at `:421-431`), on a file 2.2
instructs the builder not to touch, in a surface phase-b just re-baselined
(`app/test/toursApi.test.ts` +201, `placementsApi.test.ts` +45,
`relayGroupPreview.test.ts` +10 in `b702a81c`). Live pins that go through this
path include `toursApi.test.ts:4271-4275` and `:4294-4298`.

Whether those pins break depends on whether each fixture's stored roster name
already equals the contact's name - which is exactly the fragile, undocumented
condition the withdrawn guard existed to protect. The withdrawal, the deleted
ritual and the deleted stop-block all need to be re-decided on the correct type.
(`relayGroupPreview.test.ts:150-153`, `:208-212` are on the STANDALONE preview
route, which S3 does not touch - the conclusion there is right, the reason is
not.)

---

## HIGH

### D4. "Every line number in this spec was re-derived by symbol after the merge" is false, and 2.4 tells the builder to trust them

Spec line 162: "Every line number in this spec was re-derived by symbol after the
merge. They are accurate as of `b702a81c`." Verified wrong, in the spec's own
load-bearing citations:

| spec says | tree says |
|---|---|
| S3: "The contact is already read at `:511`" | `rosterResolution.ts:530` |
| S3: "The `removed` guard at `:522`" | `rosterResolution.ts:541` (`:522` is `firstOnPhone`) |
| 4.2 WRITERS: `jobs/relayFanOut.ts:465-471` | the `name` write is `relayFanOut.ts:838`; `:462-474` is phase-b's variant selector |
| 4.1 READERS: `routes/api.ts:457` | `:460` (`:457` is `participant_phone`) |
| 4.2: `routes/api.ts:1993-2002` | route is `:1995-2004` |
| 2.1/4.2/S2: `routes/api.ts:2020-2128` | route ends at `:2120` |
| 5.2 precedent: `routes/api.ts:2152` | `:2155` |
| 5.3 precedents: `routes/api.ts:2095`, `:2157` | `:2098`, `:2160` |
| 4.2: `routes/api.ts:2190-2198` "sibling passthrough" | the passthrough is `:2201`; `:2188-2200` is the missing-conversation branch |
| S5: "Removing the `:509` skip" | the skip is `measure-unread-contact-coverage.ts:510` |

The S3 pair is the diagnostic case: `:511` and `:522` were CORRECT before the
merge (`rosterResolution.ts` gained +19 lines above them) and the same edit pass
that moved `:545` to `:564` did not touch them. So the re-derivation was partial
and the blanket accuracy claim is what makes it dangerous.

Citations I did verify exact, for the builder's benefit:
`routes/contacts.ts:1391`, `:1213`, `:1295`, `:1738`, `:1753`, `:1871`,
`:1909-1912`, `:1158-1168`; `routes/api.ts:2089`, `:2102-2116`, `:2107`;
`routes/relayGroups.ts:469-505`, `:483`, `:484-487`, `:489`;
`routes/inbox.ts:534-543`, `:1154`, `:1216`, `:1237`, `:1418`, `:2293`, `:2358`;
`routes/today.ts:222-228`, `:606`, `:743`, `:778`, `:1001`, `:1076`;
`webhooks/twilio.ts:307-315`, `:398-402`, `:727`, `:1810`, `:1815`;
`webhooks/voice.ts:116-121`, `:156-162`, `:980-982`, `:990`;
`contactsRepo.ts:296-302`, `:309-311`, `:597`, `:806-808`, `:839-844`,
`:856-865`, `:1011-1016`, `:1031-1035`; `lib/contactName.ts:50-60`;
`lib/rosterResolution.ts:181-200`, `:564`; `services/groupMembers.ts:105-119`;
`services/relayGroupDuplicates.ts:128-132`; `routes/placements.ts:165-171`;
`lib/seed/performance.ts:842`, `:857-858`; `todayApi.test.ts:345-346`;
`rosterPeople.ts:28`; `recipientLabel.ts:95-99`; `memberAttribution.ts:77`,
`:120`; `Timeline.tsx:378`; `QuickReply.tsx:53-61`;
`PlacementDetail.tsx:370-375`; `TourDetail.tsx:451-455`;
`GroupTextView.tsx:74-80`, `:191-211`; `units.ts:118-129`, `:970`, `:1167`,
`:1262`; `broadcasts.ts:231`; `aiRuns.ts:190`; phase-b spec `:653`.

### D5. 2.4's "phase-b touched FOUR of this branch's anchor files" is a substantial undercount

`git diff --stat fa429704 b702a81c` over `app/src`, `app/test`, `dashboard/src`
and `e2e` lists 58 changed files. Beyond 2.4's four, phase-b landed changes in
files this spec names elsewhere:

- `app/src/services/rosterEdits.ts` (+92) - named in 2.2 ("do not touch"), 5.4
  and S3; the file S3 now demonstrably affects (D3).
- `app/src/jobs/relayFanOut.ts` (+523) and
  `app/src/services/relayAnnouncements.ts` (+27) - 2.2's other two "do not touch"
  files; the +523 is what stales 4.2's `:465-471` citation.
- `app/src/services/relayGroupDuplicates.ts` - named in 2.3.
- `app/src/routes/contactTimeline.ts` (+51), `app/src/routes/tours.ts` (+15),
  `app/src/routes/placements.ts` (+6) - named in 2.3 and section 8.
- `app/src/lib/seed/lean.ts`, `live.ts`, `matrix.ts` - the seeds section 10
  declares "verified consistent by both reviewers"; that verification predates
  this merge.
- Tests: `relayApi.test.ts` (+88), `toursApi.test.ts` (+201),
  `placementsApi.test.ts` (+45), `relayGroupPreview.test.ts`, plus nine e2e specs
  including `relay-group-view.spec.ts`, `tour-roster.spec.ts` and
  `contact-create-relay-group.spec.ts`.

2.4's table is presented as the record of what a builder must reason about after
the sync. As written it hides six source files and four test files this spec
depends on.

(I re-verified the lean seed independently and the spec's conclusion holds there:
`lean.ts:249-250` and `:266-267` store names that exactly match the contacts at
`:108-109`, `:136-137`, `:165-166`, so S1/S2 are string-invariant in the lean
lane.)

### D6. Section 2.2 is written in the future tense about a branch that has landed, and two risk rows cite a procedure the spec deleted

2.2 still reads as a pre-merge exclusion: "that branch is not merely editing
these bodies, it is deliberately SPLITTING the relay intro into three variants";
"Its plan Tasks 13 and 14 rewrite exactly these functions"; "Any change made here
would be rewritten by that split"; "it has already LANDED one commit there -
`6328970e`". All of that is now history - `composeNameList` is live at
`jobs/relayFanOut.ts:216`, the owner-routed inputs at `:462-474`. The exclusion
may still be correct on Cameron's outbound-content ruling, but its stated
mechanism no longer exists and a builder cannot tell what "Do not touch those
three files" is now protecting or for how long.

The risk table inherits the same lag, and worse - it cites a procedure the spec
itself removed:

- Line 746: "phase-b merges FIRST (2.4); re-derive line numbers by SYMBOL after
  the sync - they shift ~13 lines". Already done; and D4 shows the re-derivation
  was partial.
- Line 749: "field-by-field re-baseline plus a byte-diff against its merge commit
  (2.4 step 4)". 2.4 step 4 says the opposite - "with the collision withdrawn
  there is nothing to re-baseline against except line numbers" - and 2.4 line 189
  explicitly states "Both the ritual and the stop-block are deleted." The risk
  row points at a mitigation that no longer exists anywhere in the spec.

### D7. Section 5.4's standing requirement is violated by the spec's own slices, S3 included

5.4 (lines 452-454): "Every comment this branch makes wrong is amended in the
same commit that makes it wrong. The list is in each slice, and a slice with no
such comment says so explicitly rather than staying silent."

- S1, S4 and S5 carry NO such statement, in either direction.
- S3 states "COMMENTS THIS SLICE MAKES STALE: **none**". It has at least two:
  - `lib/rosterResolution.ts:557-562`, the six-line comment the edited expression
    belongs to, titled "Display-name backfill" and reasoning that the contact
    rung exists because "a FACT row can carry no name ... while its contactId
    resolves fine". After the flip the contact rung fires unconditionally; it is
    an override, not a backfill.
  - `services/rosterEdits.ts:440-441`, "the DISPLAY name (which may be backfilled
    from the contact and so differ from the body name)" - same word, same
    inversion, on the `PreviewRecipientRow` S3 changes per D3.
- S4 inverts two commented rules without naming either:
  `webhooks/voice.ts:109-115` ("`name` is the roster-cached display name
  (resolved at member-add time)") and `webhooks/twilio.ts:303-305` ("name ->
  formatted phone -> the raw From (spec 3.4 fallback chain)").

S3's justification for "none" is itself downstream of D3: it says "2.4
established that S3 is a structural no-op on the preview paths those comments
describe", and 2.4 did not establish that.

### D8. Section 3's rung-2-freshness guarantee is silently group_text-only

Section 3 (lines 282-286) closes the phone-rung argument with: the triage-stub
case "stays owned by the EXISTING converge-on-read write at
`routes/api.ts:2102-2125`, which resolves by phone and writes the corrected name
back - after which this branch's rung 2 reads a fresh snapshot."

That route type-guards at `routes/api.ts:2024`
(`conversation.type !== 'group_text'` -> 404), which 2.1's table does label
"`group_text` only" - but section 3 makes the guarantee unqualified. There is no
converge-on-read writer for relay groups: `routes/relayGroups.ts:469-505` reads
only, and 4.2's relay-side writers (`services/relayMembers.ts:47-55`,
`services/rosterProvision.ts:117`) run at CREATE time. So on a relay thread rung
2 is whatever was stamped when the member was added, permanently, and the
"converge toward the contact ... they only keep rung 2 fresh" claim at spec lines
365-366 is true for group_text and false for relay_group.

This matters because the branch's own rung 2 becomes load-bearing on exactly the
relay surface where S2 STOPS deleting the stored name
(`routes/relayGroups.ts:489`).

---

## MEDIUM

### D9. Section 10's fixture list misses a third performance-seed roster site, and directs a test update that has no target

Verified accurate: `lib/seed/performance.ts:842`, `:857-858`. Missing:
`lib/seed/performance.ts:887-891`, `buildNativeConversation`, which stamps
`name: 'Synthetic ' + contact.type` onto EVERY native `group_text` roster
(`:890`) against contacts named `Perf<NNNN> Contact` (`:563-564`). Those rows are
read by `groupRowFor`, the contact page's group-texts card and `/group-members` -
three surfaces S2 hydrates. A builder who updates only the two cited lines leaves
`:890`.

Separately, section 10 says "Update the seed or its assertions in the same
change". There are no assertions: `grep -rn "Synthetic participant|Synthetic
tenant|Synthetic landlord"` across `app/test`, `e2e`, `app/src` and
`dashboard/src` returns only the four seed lines themselves. The instruction as
written sends the builder looking for something that does not exist, and does not
say what the actual deliverable is (change the seed, or accept that the labels
change silently).

### D10. Unenumerated server-side readers of `participants[].name` with no disposition

Section 4 disclaims exhaustiveness, which covers omission - but not the fact that
one of these is an operator-facing display surface with no ruling anywhere in the
spec:

- `app/src/services/groupSend.ts:251-254` `memberLabel` - "name, else the raw
  number", feeding two refusal strings a human reads at `:329` and `:344` ("X is
  a deleted contact - restore them...", "X has no recorded SMS consent basis").
  A stale roster name here names the wrong person in a refusal about consent.
- `app/src/services/groupConvert.ts:218`, `app/src/services/relayMembers.ts:73`,
  `app/src/routes/tours.ts:1364-1365` - roster-name readers on write/convert
  paths; probably out of scope, but 4.2 lists neither them nor a reason.

4.1's reader/writer lists also omit the repo primitive that owns the field:
`repos/conversationsRepo.ts:1359` (create-time write) and `:1498` (the
`#dn` update). The spec cites `conversationsRepo.ts:587-594` for
`createOrGetByParticipantEmail`, which is the INTERFACE declaration
(`:590-594`), not the writer.

### D11. 2.3's exclusion of `relayGroupDuplicates` is justified on a mechanism that is not there

2.3 (lines 227-234): "`relayGroupDuplicates` rides the same `RosterPreview`
object `rosterEdits.ts` builds. That is phase-b's file, but phase-b's plan has NO
task for this reader ... **a new issue is filed for it in this branch**".

`services/relayGroupDuplicates.ts:128-132` maps `rosterMembers(conv)` - its own
local helper at `:68`, over the conversation's raw `participants[]` - into a
`DuplicateOpenGroup.memberNames` (`:25`). It never touches `rosterEdits.ts` or
`RosterPreview`. So the stated reason for handing it to a new issue rather than
hydrating it in-branch does not hold: it is an ordinary raw-snapshot reader of
`participants[].name`, structurally identical to `routes/poolNumbersAdmin.ts:109`
(verified, and correctly excluded as staff chrome). Either the "different PAGE"
argument covers both, or neither. The line citations `:129` / `:128-132` are
correct.

### D12. S5's "no phone-keyed name resolution at all ... in offline scripts" is false for the script S5 edits

Spec lines 642-644. `app/scripts/measure-unread-contact-coverage.ts` calls
`contacts.findByPhone` at `:519` (the 1:1 coverage walk, incrementing
`linkViaPhoneOnly`) and at `:789` (the `--audit-denorm` walk). S5 removes
neither. The absolute claim should be scoped to "no NEW phone-keyed resolution",
or the existing two named as pre-existing.

While there: S5 warns that deleting the `continue` alone would ship a pass
reporting zero group rosters. There are TWO identical skips -
`measure-unread-contact-coverage.ts:510` and `:785` - and S5 names only one
(with the wrong number, per D4). The `:785` walk is the `--audit-denorm` pass,
which is the flag the section-1 measurement table was produced with.

---

## LOW

### D13. 2.2 contains a corrupted rename that makes a function become itself

Spec line 114-115: "`jobs/relayFanOut.ts` - `composeNameList` (becomes
`composeNameList`)". The v6 rename pass overwrote the pre-rename symbol on both
sides of the parenthetical. The real rename is
`composeConnectionSentence` -> `composeNameList`, visible in the merge diff at
`lib/groupTitle.ts:60` and `services/relayGroupDuplicates.ts:11`. As it stands
the sentence is uninterpretable.

### D14. Section order is broken and the document opens mid-argument

2.4 (line 142) precedes 2.3 (line 209). The orphan 3.1 block (lines 1-30)
precedes the `#` title (line 32) and the Problem statement (line 55). A builder
reading top-to-bottom meets a withdrawal argument about a population before
learning what the branch is for.

### D15. S4's "nobody loses a label they have today" is not what the mechanism does

S4 (lines 604-608) masks the STORED string with the `contactShortName` transform:
"'First Last' stored becomes 'First L.' rendered". Today
`webhooks/voice.ts:117` returns `member.name` verbatim. So a stored "Tina Tenant"
DOES lose its surname. The spec is right that this is deliberate and right that
the output is persisted (`webhooks/voice.ts:993-1002`, verified) - but it does
not name the consequence that follows from persistence: rows written before this
change keep the full name in `call_party_label` while rows written after carry
the short form, so the timeline renders two formats side by side with no backfill
decision recorded.

### D16. 4.2's `relay_opted_out_members` writer row is a category error as well as a stale citation

4.2 WRITERS lists `jobs/relayFanOut.ts:465-471` "(into `relay_opted_out_members`,
read by `routes/today.ts:606-613`)" among writers of `participants[].name`.
`relay_opted_out_members[].name` is a different field
(`repos/conversationsRepo.ts:252-255`), written at `jobs/relayFanOut.ts:838` via
`conversationsRepo.ts:2194`. Its reader, `routes/today.ts:631-636`, already
implements this spec's exact three-rung chain
(`nameFromContact` -> `entry.name` -> formatted phone) and needs no slice. Listing
it under `participants[].name` writers, with a stale line number, invites a
builder to go looking for a convergence that is not the one the paragraph claims.

---

## Things I checked that are CORRECT, recorded so they are not re-derived

- S1's zero-read claim holds. `whoOfConversation` has exactly one call site
  (`routes/today.ts:778`), inside the unread walk, and it feeds BOTH the
  `needs_you_now` push at `:792` and the `unreplied` push at `:824` - so one
  change closes both founder symptoms. The contact is memoized ahead of it:
  `contactCache` at `:356`, `getContact` at `:358-367`, `isDeletedContact` gate
  at `:743`. Note the gate is conditional on `ownerId !== undefined`, so the
  builder must handle an absent contact (rung 2 covers it).
- `buildToday.ts:106`'s bare `??` does select a stored empty display name, and
  `webhooks/voice.ts:156-162` is the correct in-tree precedent for the guard S1
  adds.
- The relay thread title DOES pick up S2's hydration without a header read:
  `ConversationDetail.tsx:386-393` derives it from `members`, which
  `:212-216` replaces from `/members`. Section 10's e2e assertion (b) is
  achievable.
- `contactsRepo` typing for 5.2 is feasible as described: `ContactDisplayItem`
  declares `firstName?: unknown; lastName?: unknown` (`:296-302`),
  `DISPLAY_PROJECTION` carries `deleted_at` (`:856-865`) so `isDeleted`
  (`:309-311`) works on the display shape, and the short-map-by-default
  contract is at `:786-804` / `:839-844`.
- Section 2.2's claim about phase-b's spec excluding `routes/relayGroups.ts` is
  exact: its spec `:653`.
- Section 8's corrections are accurate: `routes/inbox.ts:534-543` really does
  carry the extra denormalized-`contact.name` rung at `:540-542`;
  `routes/placements.ts:165-171` really is an uncensused copy.
