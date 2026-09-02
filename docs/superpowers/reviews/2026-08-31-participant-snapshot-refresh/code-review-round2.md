# Code review round 2 - fresh eyes on the branch AND on round 1

Branch `feat/participant-snapshot-refresh`, HEAD `744142f9`, merge-base `f27aabbf`.
Worktree `W:\tmp\participant-snapshot-refresh`; tracked tree clean before and after
this review.

Inputs read: `.superpowers/review/diff-code.md` + `diff-full.md`,
`git show c895f081`, `code-review-conformance.md`, `code-review-adversarial.md`,
`code-review-adjudications.md`, `fix-wave-report.md`, the spec, and the repo.
Slice reports, the plan and the design-review files were deliberately not read.

Verification run from `W:\tmp\participant-snapshot-refresh\app` (targeted only,
never a whole suite): `npx vitest run test/inboundMessagePush.test.ts
test/voiceWebhook.test.ts test/participantNames.test.ts test/rosterDriftTally.test.ts`
-> 77 passed; `... test/founderTriage.test.ts test/voiceOutbound.test.ts
test/inboxFeed.test.ts test/inboxGroups.test.ts test/relayApi.test.ts
test/contactRelayGroups.test.ts test/contactGroupThreads.test.ts
test/rosterResolution.test.ts test/voiceMasking.test.ts test/contactName.test.ts`
-> 332 passed; `... test/todayApi.test.ts` -> 61 passed. One throwaway probe
(`app/test/zz-round2-probe.test.ts`) was written, run, and deleted; `git status`
is clean but for this file.

---

## 1. What round 1 missed

### MUST-FIX

**R2-1. Hydration silently retires the operator `placement_tag` rung - the exact
outcome `groupTitle.ts:74-78` says must never happen, on the inbox row and the
contact card, undeclared anywhere.**

`relayThreadLabel`'s first rung wins only when `anyNamed || tag.length === 0`
(`app/src/lib/groupTitle.ts:157`). `anyNamed` is computed from the roster handed
in (`:96-99`). Before this branch the inbox row passed the STORED roster, so a
group whose members carry no stored name had `anyNamed === false` and fell
through to the operator's tag. `app/src/routes/inbox.ts:1162` now passes
`withLiveNames(...)`, so every member with a resolvable contact name flips
`anyNamed` true and the tag rung is skipped.

Proven, not inferred. A `placement_tag` group whose two members store no name
but resolve to contacts:

```
stored   (push title, twilio.ts:743) -> "Maple St - Dana"
hydrated (inbox row,  inbox.ts:1162) -> "With Ana Reyes & Ben Ortiz"
```

Why this is must-fix rather than a note:

- The carve-out's own docblock states the stake in terms: "Without that
  carve-out the tag rung would be dead code for every group that has
  participants, which would silently retire an operator-facing feature"
  (`app/src/lib/groupTitle.ts:76-78`). Hydration is what makes "has
  participants" and "has names" the same condition.
- The affected population is precisely the one the tag was built for. The
  module header says "after the migration every imported roster is nameless"
  (`app/src/lib/groupTitle.ts:9-11`) - those are the rosters that used to show
  the tag and now will not.
- The same flip hits the contact page's Relay-groups card independently:
  `app/src/routes/contacts.ts:1227` applies the identical
  `others.anyNamed || tag.length === 0` carve-out over
  `withLiveNames(...)` (`:1226`, batch at `:1208`), and the client mirror
  (`GroupTextsCard.groupLabel`, cited at `groupTitle.ts:138-144`) reads the
  emptied `otherMemberNames` array. So the tag vanishes from two surfaces.
- No spec line, issue paragraph, slice report, review finding or test mentions
  it. The spec's In-table row for S2 says only "1 batch per page"; the
  `group-roster-name-snapshot-never-refreshed` "NOT covered" list (`:111-149`)
  is otherwise unusually complete and does not name it.
- It also widens A-2 past what the fix-wave docblock now claims. That docblock
  says "a renamed member can read one way in the push title and another in the
  inbox row" (`app/src/lib/groupTitle.ts:119-121`). The real divergence is not
  a different NAME, it is a different KIND of label: the push title is the
  operator's tag, the inbox row is a member list.

Satisfying this does not require code. An explicit adjudication ("names beat
the tag now, deliberately") plus one pin in `inboxGroups.test.ts` closes it.
What is not acceptable is shipping it invisible.

### SHOULD-FIX

**R2-2. The RELAY arm of `pushSenderLabel` is entirely unpinned - both the
contact-first flip and the new `isDeleted` guard.**

Two call sites: `app/src/routes/webhooks/twilio.ts:744` (relay) and `:1830`
(native group text). Every test that exercises the label is on the group arm
(`app/test/inboundMessagePush.test.ts:529`, `:558`). The relay describe block
(`:352-430`) seeds a roster of `Alice/Bob/Carol` against an EMPTY
`world.contacts`, so `senderContact` is always `undefined` there and those
assertions read identically on `main`, before the flip and after the guard.

The two arms are not interchangeable - they resolve `senderContact` by
different rules:

- relay `:589`: `sender?.contactId ? await contacts.getById(sender.contactId) : undefined`
  - no phone fallback, no `consistentRead`.
- group `:1688-1692`: roster contactId -> `getById(..., { consistentRead: true })`
  `?? findByPhone(From)`, else `findByPhone(From)`.

`findByPhone` deliberately returns soft-deleted rows, so the group arm can reach
the guard through a path the relay arm cannot, and vice versa. The conformance
review's T7 evidence cites only the group-arm test; the adversarial review's
A-4 cites the function, not its call sites. One relay test with a renamed
contact and one with a deleted one would pin both.

**R2-3. The guard changes the push body prefix from a name to a PHONE NUMBER in
one reachable case, and the fix-wave report's justification for it is false.**

`fix-wave-report.md:109-112` claims: "`pushSenderLabel`'s deleted-contact path
now lands on the stored roster name and, for a member with no stored name, on
the formatted phone - which is the pre-flip main behavior for that case, so the
guard restores main's outcome rather than inventing a third one."

Read the two chains at `app/src/routes/webhooks/twilio.ts:318-331`. For a
sender with NO stored roster name whose contact is soft-deleted:

- `main`: roster empty -> `contactDisplayName(senderContact)` -> the deleted
  contact's NAME.
- branch + guard: live rung refused -> roster empty -> `formatPhoneForDisplay(from)`.

That is not main's outcome; it is the third outcome. On the group arm the case
is reachable without any roster contactId at all, because `:1688-1692` falls
back to `findByPhone(From)` and `findByPhone` returns deleted rows on purpose.
The behavior may well be correct under "a soft-deleted contact supplies no
name" - but it is a push notification that now reads
`(555) 010-0001: hello` where it read `Ana Reyes: hello`, it is pinned by no
test, and it was waved through on a rationale that does not hold. Adjudicate it
on its merits or pin it; do not leave the false claim standing as the record.

**R2-4. The drift audit cannot count the one population this branch makes
permanent.**

`app/src/lib/rosterDriftTally.ts:44-47` classifies a member as
`nameMissingButKnown` (`want` set, `have` unset) or `nameDrift` (both set and
different). The inverse - `want === undefined && have !== undefined`, the roster
carries a name the CONTACT no longer has - falls through both branches and is
counted nowhere beyond `withContactId`.

That is exactly the population adversarial note 8 identified as this branch's
one behavior regression: `app/src/routes/relayGroups.ts:489-490` stopped
deleting the stored name, so clearing a contact's name (a wrong name, a merge,
a privacy request) no longer clears it from a relay roster and no in-product
path will. The spec justifies the audit as sizing "the stale population the read
path now masks" (spec `:156-158`); for this population the read path does not
mask staleness, it PRESERVES it - and the audit is blind to it. Conformance
verified the tally implements the spec's eight counts (it does); nobody checked
that the eight counts cover the branch's own cost. One extra counter
(`nameStoredButContactHasNone`) makes the P5 handback numbers actually
answer the question note 8 raised.

### NOTES

**R2-5.** `shortNameFromFull` does not carry the guarantee its docblock claims.
`app/src/lib/voiceMasking.ts:60-66` splits on whitespace and returns a
single-token input verbatim, so a phone-shaped stored roster name comes back as
the raw phone - measured: `shortNameFromFull('+15550100001')` ->
`'+15550100001'`. That value is persisted as `call_party_label` and SPOKEN in
the whisper (`app/src/routes/webhooks/voice.ts:1025`, `:1058`), under a docblock
that says "NEVER the raw phone (PII, doc section 9)" (`voice.ts:114-115`). Not a
regression - `main` returned `member.name` verbatim - but the branch introduced
`shortNameFromFull` AS the guarantee, and it is one `/^\+?\d/` test away from
being true. Reachable only by an API caller supplying an explicit member `name`
(`app/src/services/relayMembers.ts:73`); the dashboard's add path derives the
name from the picked contact (`CreateRelayGroupModal.tsx:289`), so it is
theoretical today. Same helper mangles a company member: `'Acme Property
Management'` -> `'Acme M.'`.

**R2-6.** Two name rules render the same person on the same inbox page.
`app/src/routes/inbox.ts:993` builds the 1:1 row with the file's own
`nameFromContact` (`:536-545`), which has a third rung the canonical helper does
not - a single denormalized `contact.name` field. Group and relay rows now
resolve through `contactDisplayName` over a `ContactDisplayItem` whose
projection is `contactId, firstName, lastName, phone, deleted_at`
(`app/src/repos/contactsRepo.ts:857`) - it cannot carry `name` even if the rung
existed. So a contact named only in that field renders on their 1:1 row and
falls back to the stored snapshot (or the phone) on a group row beside it. The
branch documents the divergence (`app/src/lib/contactName.ts:61-64`) and the
issue re-census names it, but neither reviewer connected it to the projection.
`app/src/routes/inbox.ts:543` is the only reader of that field on a contact in
`app/src`, so the practical population is imported records.

**R2-7.** `resolveMemberName`'s documented precedence is now inverted at read
time without its comment moving. `app/src/services/relayMembers.ts:47` says
"explicit > contact-derived > undefined", and `parseRelayMember` (`:73`) accepts
a caller-supplied `name`. Every hydrated surface now overrides that explicit
value with the contact's name. Unreachable from the dashboard (the modal derives
the name from the contact), so this is a comment that will mislead the next
reader, not a live defect.

**R2-8.** "One batch per card" is `ceil(K/100)` SEQUENTIAL round trips.
`batchGetByIds` (`app/src/repos/contactsRepo.ts:824-846`) chunks at 100 in an
awaited `for` loop. The contact card's batch (`app/src/routes/contacts.ts:1208`)
spans every relay group the contact is on across three partitions, each walked
to `RELAY_LIST_MAX_PAGES` * `RELAY_LIST_PAGE_LIMIT` = 2000
(`app/src/repos/conversationsRepo.ts:429-430`). Bounded and almost always one
chunk in practice; recorded because the spec's cost row reads as a literal 1.

**R2-9.** `relayGroups.ts` GET /members lost its per-member error context. The
deleted `catch` logged `{ err, conversationId, contactId }`; the replacement
warn in `resolveRosterNames` logs `{ err, contactCount }`
(`app/src/lib/participantNames.ts:58`), so a failure on this route no longer
names the conversation. Deliberate PII posture, but it is an observability
regression on a route that previously had it.

**R2-10.** `docs/issues/_CLUSTERS.md:84` still says "six private name-join
copies" after this branch proved the census is thirteen and corrected
`consolidate-contact-display-name-helpers.md`. Same file, same paragraph as the
A-1 contradiction below.

**R2-11.** QuickReply's recipient label gets more likely to name the wrong
person, not less. `dashboard/src/routes/quickReply/QuickReply.tsx:53-57` takes
the FIRST participant with a name and shows it as "where the reply is going",
while the reply posts to the whole `conversationId`. Hydration names more
members, so on a relay roster the first-named member changes more often and is
more often someone other than the caller. Round 1 note 10 called this "arbitrary
before and after"; the sharper statement is that it was arbitrary and is now
arbitrary over a larger set, on a send surface.

**Hunts that came up empty** (recorded so the next reviewer does not repeat
them): the SSE `conversation.updated` path does NOT undo hydration - `useInbox`
schedules a debounced refetch (`dashboard/src/routes/inbox/useInbox.ts:376`) and
`RelayGroupView` re-fetches `/members` on mount
(`ConversationDetail.tsx:204-218`), never patching names off the event.
`GET /api/conversations` ships the raw roster but its only consumers are the
Today and contact-timeline OFFLINE fallbacks
(`dashboard/src/api/endpoints.ts:522`, `useToday.ts:64`,
`useContactTimeline.ts:191`). Both are already named in the resolved issue's
"NOT covered" list (`group-roster-name-snapshot-never-refreshed.md:126-135`),
which is more complete than the spec's own Out list. No write path was added;
`withLiveNames` writes only `name` and every hydrated object dies at
`res.json`.

---

## 2. The fix diff, reviewed cold (c895f081)

### Guard shape - correct

Both guards use the repo's single predicate (`isDeleted`,
`app/src/repos/contactsRepo.ts:309`, `deleted_at` non-empty string) on values
that actually carry `deleted_at` (`getById` / `findByPhone` return whole
`ContactItem`s). Both guard the NAME rung ONLY and fall to the same next rung
`withLiveNames` falls to - the stored snapshot
(`app/src/lib/participantNames.ts:71`). `pushSenderLabel`'s
`senderContact !== undefined &&` is redundant (`contactDisplayName` already
handles `undefined`, `app/src/lib/contactName.ts:75`) but harmless.
No caller signature changed; no I/O added; both functions stay pure.

`maskedPartyLabel`'s role rungs (`voice.ts:132-134`) still read `contact?.type`
on a deleted contact, so a deleted landlord with no stored roster name is
labelled "Landlord". That is unchanged from `main` and the fix report discloses
it (`fix-wave-report.md:95-101`). Correct call.

### SHOULD-FIX

**R2-12. A-2 was repaired on one of two identical docblocks, and the fix report
knew it.** `relayThreadLabel`'s claim was rewritten
(`app/src/lib/groupTitle.ts:114-121`). `groupThreadLabel` has the identical
hydrated-vs-stored split - `app/src/routes/inbox.ts:1205` hydrated vs
`app/src/routes/webhooks/twilio.ts:1826` raw - and the MODULE header at
`app/src/lib/groupTitle.ts:5-16` still argues the one-rule case for "three
surfaces [that] disagreed in public" with no hydration note at all.
`fix-wave-report.md:102-108` names this and stops, on the grounds that the
header "is about the rule, not the input". That distinction does not survive
R2-1: after hydration the two inputs no longer produce the same KIND of label,
so the header's promise is now false in the same way `:113` was. Two sentences
in the header closes it.

### NOTES

**R2-13.** Each new test is discriminating only as HALF of a pair. The push test
(`app/test/inboundMessagePush.test.ts:558`) asserts `'Old Ana: ...'`, which is
also what a broken build that never resolves `senderContact` produces; what
makes it bite is its sibling at `:529`, identical but for `deleted_at`, which
asserts `'Ana Reyes: ...'`. Same for voice: `:141` asserts `'Bob B.'`, pinned
against `:124` asserting `'Robert R.'` from the same contact fields. The pairs
are correct and I verified both halves run green together - recorded so nobody
later deletes the "redundant-looking" non-deleted case and leaves a test that
passes with the guard gone. The voice pair moves TWO variables at once
(`deleted_at` and the stored name `'Bob'` -> `'Bob Builder'`); still
discriminating, deliberately per `fix-wave-report.md:113-117`.

**R2-14.** The deleted case is pinned on the CALLEE label only. The commit
message claims the guard moves "the persisted `call_party_label` AND the spoken
whisper"; the new test asserts only `call.call_party_label`
(`app/test/voiceWebhook.test.ts:166`). The whisper leg goes through the same
`maskedPartyLabel` call and IS pinned for the no-contact case at `:164+`, so
coverage is adequate by construction - but the commit's stated blast radius is
one assertion wider than its test.

**R2-15.** `app/test/voiceMasking.test.ts` is one `it` with five assertions for
the branch's new masking primitive. It omits a whitespace-only input (returns
`undefined`, correct but unpinned) and any phone-shaped input (see R2-5).

**R2-16.** The groupTitle docblock rewrite is comment-only as claimed - I
diffed it; zero code tokens changed, and `git show c895f081` confirms the file's
only hunk is inside `/** ... */`.

---

## 3. Adjudications contested

**R2-17. A-5 accepted-as-a-note: the ADJUDICATION is right and the CONFORMANCE
RECORD it overrides is factually wrong, and nobody corrected it.**

The adversarial reviewer was correct that `PATCH /api/contacts/:id` propagates
the new display name onto the linked 1:1 thread. Verified:
`app/src/routes/contacts.ts:1769` calls
`conversations.applyTriage(conv.conversationId, { displayName })` for every
thread `findByParticipantPhone` returns (`:1754`), with `displayName` from
`displayNameOf(updated)` (`:1734`).

But `code-review-conformance.md:27` (the T9 CONFORMS verdict, which is what
certifies the e2e slice) states as its evidence: "`applyTriage` appears only on
`app/src/routes/contacts.ts:1886`, the start-a-conversation route". That is
false. `git grep applyTriage app/src` returns THREE writers:
`app/src/routes/contacts.ts:1769` (the PATCH), `:1887` (the
start-a-conversation route) and `app/src/jobs/placementNudges.ts:556` (a job).
The adjudication accepted the correction for A-5 without recording that a
CONFORMS verdict elsewhere in the same review round rests on the refuted claim.
Fix the conformance record, or the next reader inherits a wrong fact with a
green stamp on it.

Consequence, and why I move the e2e leg from note to **should-fix**: assertion 1
of `e2e/tests/scenarios/participant-names.spec.ts:53-59` cannot fail. It costs a
`toPass` loop budgeted at 20s with a full page reload each iteration, and the
spec's section 6 explicitly asked e2e to cover "Today's row". Right now Today's
only real coverage is unit (`app/test/todayApi.test.ts`, which seeds
`participant_display_name` directly). Either point the rename at a SECONDARY
phone - `findByParticipantPhone` only walks the contact's scalar primary
(`contacts.ts:1753`), which is precisely the case rung 1 exists for - or delete
the leg and record in the spec that Today's e2e coverage was dropped as
unreachable. Keeping a 20s assertion that cannot fail is the worst of the three.

**R2-18. A-3 rejected: the outcome is defensible, the REASON is not.**

The rejection says a wave-level batch "would read the STALE rosters' ids (a
just-added member would be missed)". That rules out the naive hoist - batching
over `collected.candidates`' index images - and nothing else. The candidates are
already point-read to `fresh` inside `hydrateUnread`
(`app/src/routes/inbox.ts:1415`); a two-phase pass (hydrate all candidates,
collect ids from the FRESH rosters, one batch, then build labels) reads no stale
id at all and is available without touching the fill-or-exhaust loop. The
counter-argument is also nearly empty on its own terms: a just-added member's
stored name was written from the live contact seconds earlier by
`resolveMemberName` (`app/src/services/relayMembers.ts:49-60`), so "missed" here
means "keeps a name that is already current".

I am NOT asking for the restructure. The cost is declared in the spec's own S2
cost row and bounded by `MAX_INBOX_LIMIT = 100`
(`app/src/routes/inbox.ts:217`), and process-wise the adjudication is right to
hold the line at plan review B6. I am asking that the recorded reason be the
real one - "declared, bounded, and not worth reopening the plan for" - rather
than a technical claim that does not survive one read of `hydrateUnread`.

**R2-19. A-1's ruling was honored; its EXECUTION left the contradiction in the
tree.**

The human's ruling (no new issue, carry it in the handback) is not contestable
here and I do not contest it. The execution is. Verified on HEAD `744142f9`:

- `docs/issues/group-roster-name-snapshot-never-refreshed.md:5-9` is
  `severity: high` + `status: resolved`, so the triage query documented verbatim
  at `docs/issues/README.md:80` does not surface it. I ran the equivalent: 30
  files carry `severity: high`; this one is not reachable through the open
  filter.
- `docs/issues/_CLUSTERS.md:82` still lists the slug as a `high` ANCHOR of its
  bundle. The adjudication itself called this "a planning doc to update when M1
  merges" - and then nothing in the branch, the issue, or any tracked artifact
  records that obligation. `_CLUSTERS.md:84` additionally still says "six
  private name-join copies" (R2-10) in the same table this branch corrected to
  thirteen.
- The unfixed outbound half's only description now lives at
  `group-roster-name-snapshot-never-refreshed.md:141-149`, inside the resolved
  file.

So the entire load is carried by a handback document that does not exist in the
tree at review time. Two one-line edits to `_CLUSTERS.md` (drop the anchor claim
or mark it "read the resolved file"; fix "six" to "thirteen") cost nothing and
survive the handback being skimmed. I would make that a merge condition
alongside the handback item, which is exactly the shape the adjudication used
for C-F2's audit block ("if it is missing there, THAT is a blocker").

**Not contested:** C-F1/A-4 (correctly confirmed and correctly fixed), C-F2,
C-F3, A-6, and every note-level call in the adjudications table.

---

## 4. Are the two fixes real?

**Fix 1 (isDeleted guard) - REAL.** Verified four ways: the predicate is the
repo's shared one (`contactsRepo.ts:309`) and matches `withLiveNames`
(`participantNames.ts:71`) rung for rung; both upstream readers really do return
deleted rows unfiltered (`getById` is a bare `GetCommand`; `findByPhone` returns
them by design so inbound routing resolves); each new test is discriminating
against its non-deleted sibling (R2-13); and `npx vitest run
test/inboundMessagePush.test.ts test/voiceWebhook.test.ts` -> 66 passed with
both new cases green. Caveats: the relay call site is unpinned (R2-2) and one
sub-case changes behavior in a way the fix report describes incorrectly (R2-3).

**Fix 2 (groupTitle docblock) - REAL but half-scoped.** The rewritten text is
accurate about `relayThreadLabel` and comment-only as claimed (R2-16). It is
incomplete in two directions: `groupThreadLabel` has the identical split with no
note and the module header still asserts the opposite (R2-12), and the
divergence it describes is understated - after hydration the push title and the
inbox row can differ in label KIND, not just in name freshness (R2-1).

---

## Overall call

**NEEDS ANOTHER WAVE** - one must-fix (R2-1) and four should-fixes (R2-2, R2-3,
R2-4, R2-12), plus the e2e leg promoted in R2-17 and the two `_CLUSTERS.md`
lines in R2-19.

The implementation itself remains careful and I found no correctness defect in
the resolution mechanism: `participantNames.ts` is right, the degradation
posture is right, the read budgets are asserted rather than described, and no
write path was touched. Every must/should above is either an undeclared
behavior change (R2-1, R2-3), a missing pin on a path that exists (R2-2, R2-12),
or a measurement that cannot see the branch's own cost (R2-4). None of them
requires reopening the design.
