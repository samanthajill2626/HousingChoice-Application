# Adversarial code review - feat/participant-snapshot-refresh @8cc3d165

Fresh-eyes review. Inputs: `.superpowers/review/diff-code.md` (full -U8 vs
`f27aabbf`), the worktree, `docs/issues/`, AGENTS.md. Deliberately did NOT read
the spec, plan, or any prior review record.

Read-only on tracked files. Targeted unit run only:
`npx vitest run test/participantNames.test.ts test/rosterDriftTally.test.ts
test/voiceMasking.test.ts test/contactName.test.ts test/rosterResolution.test.ts`
-> 5 files / 87 tests PASSED (1.56s). No throwaway file was left behind.

---

## MUST-FIX

### 1. A `high` issue is closed as `resolved` while the half that made it high is
### unfixed, and nothing else in the registry tracks it

`docs/issues/group-roster-name-snapshot-never-refreshed.md:6` flips to
`status: resolved`, `:9` stamps `resolved: 2026-09-01`. Its own Resolution
paragraph, added by this branch, says the opposite at `:137-149`:

- "Outbound message content, by the spec's decision 6 - and this is the half of
  this issue that is NOT fixed."
- "The `high` severity above was set for that outbound reach; it survives the
  close."

The unfixed half is real and reaches non-staff: `jobs/relayFanOut.ts:774`
(`payload.senderNameOverride ?? senderMember?.name`) still prefixes every
relayed member message with the stored snapshot, and it is read for the life of
the group.

Why this is must-fix rather than a doc nit:

- AGENTS.md makes `docs/issues/` the ONLY engineering tracker.
- `docs/issues/README.md:80` documents the triage query verbatim:
  `rg -l "^status: open$" docs/issues/ -g '!_*' | xargs rg -l "^severity: high$"`.
  I ran the equivalent: 8 files match on this branch, and this one is not among
  them. Before the branch it was.
- No follow-up was filed. `grep -rn "senderNameOverride" docs/issues/*.md`
  returns lines `:55` and `:140` of this file alone.
  `staff-only-roster-name-readers-stale.md` is `severity: low` and covers only
  `groupSend.ts:252`, `relayGroupDuplicates.ts:128`,
  `poolNumbersAdmin.ts:108` - not `relayFanOut.ts`.
- `docs/issues/_CLUSTERS.md:82` still lists this slug as the `high` anchor of
  its bundle, so the two files now contradict each other.

Net effect: when the founder next reports "a relayed message called them by
their old name" - which the Resolution paragraph itself names as the signal to
reopen - the registry will say the issue was resolved a month earlier.

Fix: keep it `open` (or `in-progress`) with a scope note, or file the outbound
follow-up and point the Resolution at it, before merge. No code change needed.

---

## SHOULD-FIX

### 2. `relayThreadLabel`'s stated anti-drift contract is now false, and its
### docblock still asserts it

`app/src/lib/groupTitle.ts:110-113` says the helper is "the EXACT precedence
chain the inbox row uses ... extracted from routes/inbox.ts relayRowFor so the
push title and the inbox row cannot drift."

They now drift:

- `app/src/routes/inbox.ts:1162` - `relayThreadLabel({ ...conv, participants:
  withLiveNames(conv.participants, names) })` (hydrated).
- `app/src/routes/webhooks/twilio.ts:730` - `relayThreadLabel(relay)` (raw
  stored roster).

Scenario: relay group titled from roster name "Ana"; staff rename the contact to
"Anastasia" (PATCH does not touch group rosters); the tenant texts the group.
The push notification title reads `With Ana`; the inbox row the navigator taps
through to reads `With Anastasia`. Same thread, same second.

The same split exists for native group texts: `twilio.ts:1813`
`groupThreadLabel(thread.participants)` (raw) vs `inbox.ts:1205`
`groupThreadLabel(withLiveNames(...))` (hydrated) - and `inboundMessagePush.test.ts`
concedes it ("The TITLE is out of scope ... assert only the body prefix"), so a
single push can now carry a stale TITLE over a fresh BODY prefix
(`twilio.ts:1817` `pushSenderLabel`).

The trade-off (no awaited read on the webhook ack path) is defensible and is
declared in `group-roster-name-snapshot-never-refreshed.md:113-115`. The defect
is that the docblock the next engineer actually reads still promises the
opposite. Update `groupTitle.ts:110-113` (and the mirror note at `:126-137`) to
record which callers hydrate and which do not.

### 3. `filter=unread` issues one serial BatchGet per multi-party candidate

Every other surface on this branch keeps the "one batch per page" promise.
This one does not:

- `app/src/routes/inbox.ts:1485-1486` - `for (const candidate of
  collected.candidates) { const hydrated = await hydrateUnread(candidate); ... }`
  - strictly serial.
- `app/src/routes/inbox.ts:1435` - inside `hydrateUnread`, for every
  `relay_group` / `group_text` candidate: `await resolveRosterNames([fresh],
  contacts, log)`.

So an Unread tab page of N multi-party rows adds N sequential DynamoDB
round trips on top of the N point reads it already pays, bounded by `limit`
(page limit up to `MAX_PAGE_LIMIT`). The in-code comment calls this "same order
as today", which understates it: it roughly doubles the round trips for those
rows, and they are serialized, so the added latency is additive.

The candidates are already materialized as an array at `inbox.ts:1469`
(`collected.candidates`), so one batch per collect wave - the same shape as
`inbox.ts:1250` and `:2315` - is available with no restructuring of the
fill-or-exhaust loop.

### 4. The "non-deleted contact" rung is implemented three times with two
### different rules

`app/src/lib/participantNames.ts:4-11` states the chain as "live contact name
(non-deleted, non-empty) -> the stored snapshot", and `:70` enforces it
(`if (contact === undefined || isDeleted(contact)) return { ...p };`).
`app/src/lib/rosterResolution.ts:541,562` enforces it too (via `removed`).

Two of the sites this branch flipped do not:

- `app/src/routes/webhooks/twilio.ts:313` - `pushSenderLabel` takes
  `contactDisplayName(senderContact)` with no `isDeleted` guard.
- `app/src/routes/webhooks/voice.ts:104` - `maskedPartyLabel` takes
  `contactShortName(contact)` with no `isDeleted` guard.

Both are fed by `contacts.getById`, which returns soft-deleted rows unchanged
(`app/src/repos/contactsRepo.ts:777-784` - a bare `GetCommand`, no filter). So a
soft-deleted contact's CURRENT name now wins over the stored roster name in the
push body prefix, in the persisted `call_party_label`, and in the spoken
whisper, while the same person keeps the stored name on every surface
`withLiveNames` touches. That is the "duplicated precedence rules that will
drift" shape, one commit old.

Low blast radius (both names are the same person's), but the rule should be one
rule. `contactDisplayName` cannot carry it - it has no `deleted_at` in its
parameter shape - so either widen it or guard at the two call sites.

### 5. The e2e spec's Today assertion cannot fail

`e2e/tests/scenarios/participant-names.spec.ts:44-53` is the branch's only
end-to-end coverage of the Today change. It renames through the contact page's
edit form (`steps.ts:726-731` -> `editTenantIdentity` -> PATCH
`/api/contacts/:id`).

That PATCH already propagates the new name onto the linked 1:1 thread:
`app/src/routes/contacts.ts:1735` (`displayNameOf(updated)`), `:1753-1754`
(`findByParticipantPhone`), `:1769-1772` (`applyTriage(..., { displayName })`).

Today's second rung reads exactly that field: `app/src/routes/today.ts:1092-1094`
returns `conv.participant_display_name` when non-empty. Delete the new first
rung at `today.ts:1090-1091` and the spec still passes, because the fallback
already holds "Renata New".

The unit tests are honest - `app/test/todayApi.test.ts` seeds
`participant_display_name: 'Old Name'` directly, bypassing the propagation, so
those go red without the fix. Only the e2e is vacuous. Assertions 2 and 3 of the
same spec are sound (assertion 2 goes through `contacts.ts` `otherMemberNames`,
assertion 3 through the relay header's facts line built from `/members` at
`dashboard/src/routes/conversation/ConversationDetail.tsx:387-392`).

To make it bite, the rename would have to happen on a number that the PATCH
propagation does not reach - `findByParticipantPhone` only looks at the
contact's SCALAR primary phone, so a thread on a SECONDARY number is exactly
the case the new rung exists for.

### 6. `describeRoster`'s flip makes the operator-facing name and the outbound
### name disagree for the same member

`app/src/lib/rosterResolution.ts:562-563` is now contact-first.
`resolveRoster` FACT mode (`rosterResolution.ts:232-243`) still returns
`nonEmpty(p.name)` verbatim, and that is what feeds the message bodies
(`jobs/relayFanOut.ts:774`, `:1020`, `:1085`) and the send-refusal strings
(`app/src/services/groupSend.ts:253`).

Before the flip both halves were consistently STALE. After it, for a member
renamed since the group was built:

- the People card / tour / placement roster panels (`routes/tours.ts:480,642`,
  `routes/placements.ts:901,997`) say "Anastasia Reyes";
- the add-preview recipient list (`services/rosterEdits.ts:598-602` via
  `describeRoster`) says "Anastasia Reyes";
- a relayed message from her is prefixed "Ana Reyes:";
- a group-send refusal names "Ana Reyes".

The outbound half is declared out of scope, and I agree with the reasoning. The
point is that this branch converts a consistent staleness into a visible
contradiction, which is a different (and, for an operator deciding whether two
groups hold the same people, worse) failure mode. It belongs in whatever issue
survives finding 1.

---

## NOTES

7. `app/src/lib/contactName.ts:64-66` widens the parameter to
   `{ contactId: string; firstName?: unknown; lastName?: unknown }`. Any object
   carrying a `contactId: string` now compiles - `UnitContact`, `RelayGroupRow`,
   a `ConversationParticipant` (which has `contactId` and `name`, not
   `firstName`) - and silently returns `undefined` rather than failing to
   compile. The anchor trick is documented at `:52-58`; the cost is that the old
   `ContactItem` parameter was the compile-time guard and now nothing is.

8. `app/src/routes/relayGroups.ts:483` now KEEPS the stored roster name when the
   contact has no name (`relayApi.test.ts` assertion flipped from "drops" to
   "keeps"). Nothing writes relay `participants[].name` after creation - the one
   post-creation writer, `backfillGroupTextRoster` at `app/src/routes/api.ts:2111`,
   is behind a `conversation.type !== 'group_text'` guard at `:2025`. So CLEARING
   a contact's name (a wrong name, a merge, a privacy request) no longer clears
   it from a relay roster, and there is no in-product path that will. Deliberate
   per the recorded 2026-08-31 ruling; worth stating as the cost of that ruling.

9. `app/src/routes/api.ts:2201` - `const [hydrated] = await
   hydrateConversationRosters([conversation], contacts, log);` then
   `res.json({ call, conversation: hydrated })`. Safe today (`convs.map` over a
   1-element array), but if the helper ever returns short, the response drops
   `conversation` entirely instead of the `conversation: null` shape the route
   documents at `:2195-2199` and the client branches on
   (`QuickReply.tsx` `no_conversation`).

10. `app/src/lib/participantNames.ts:84` turns an absent `participants` into
    `[]`. That is a wire-shape change on `GET /api/calls/:callId`. Harmless for
    the one consumer (`dashboard/src/routes/quickReply/QuickReply.tsx:54` uses
    `?.find`), but it is a change no test pins. Related: that same
    `recipientLabel` takes the FIRST NAMED participant, so on a relay roster
    where member[0] previously had no stored name, hydration can change WHICH
    member the quick-reply screen names. Arbitrary before and after, so not a
    regression - but it is a behavior change nobody asked for.

11. `app/src/lib/rosterDriftTally.ts:52-58` - `collectGroupRosters` pages
    `listGroupTexts` in a `do/while (cursor !== undefined)` with no iteration
    cap and accumulates every roster in memory. A cursor that fails to advance
    spins forever; a large table is unbounded memory. Operator-run,
    `--confirm`-gated script only, so low, but every other walk in this repo
    carries a budget.

12. `app/src/routes/today.ts:223-229` `nameFromContact` joins with
    `` `${first} ${last}`.trim() `` (outer trim only), while
    `contactDisplayName` trims each part. A contact whose `firstName` carries a
    trailing space renders "Renata  New" on Today and "Renata New" everywhere
    else. Pre-existing, but this branch promotes that helper to Today's PRIMARY
    rung, so the divergence is now reached far more often. Already tracked as
    `consolidate-contact-display-name-helpers` (which this branch correctly
    re-censused to 13 copies).

13. Housekeeping: `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/code-review-conformance.md`
    was already present and UNTRACKED in the worktree before this review. Not
    mine, not read, not touched - flagging it so it is not mistaken for review
    residue.

---

## HUNTS THAT CAME UP EMPTY

**Security / PII: nothing found.** The only new log line is
`participantNames.ts:57` (`{ err, contactCount }`) - ids and counts, no names,
no phones, per doc section 9. `rosterDriftTally.ts` and the `--audit-denorm`
group pass print counts only (`measure-unread-contact-coverage.ts:601-621`).
No route was added and none had its auth changed; all touched routes
(`/api/inbox`, `/api/today`, `/api/calls/:callId`,
`/api/conversations/:id/members`, `/api/contacts/:id/relay-groups`,
`/api/contacts/:id/group-threads`) already sat behind `requireAuth`. The voice
change strictly REDUCES exposure: `voice.ts:104` now masks a stored roster name
through `shortNameFromFull` before it is persisted as `call_party_label` and
spoken in the whisper, where the previous code emitted the full name verbatim.

**Races and concurrency: nothing found.** Every new batch read happens strictly
AFTER the conversation read it names, and writes only `name`:
- rename between the two reads -> the page shows the NEWER name. Strictly
  fresher than before.
- member add/remove between the two reads -> membership still comes from the
  conversation snapshot, exactly as before; `withLiveNames`
  (`participantNames.ts:66-75`) never adds or drops a row, and preserves
  `contactId`/`phone`, so the downstream `isSelf` filters
  (`contacts.ts:1183-1185`) and `findMemberByKey`
  (`dashboard/src/lib/memberAttribution.ts:60-73`) still resolve.
- soft-delete between the two reads -> `isDeleted` keeps the stored name. No
  new window.
- partial failure -> `contactsRepo.ts:839-851` never throws by default and keeps
  chunks that already succeeded, so a throttle degrades to a SHORT map and every
  unresolved member keeps today's behavior; `resolveRosterNames` also catches a
  hypothetical throw (`participantNames.ts:55-59`). Both are pinned by
  `participantNames.test.ts`.
- The one write-back path that touches `participants[].name`
  (`api.ts:2103-2118`) is conditional on the roster it read, is `group_text`-only,
  and was not modified.
- No await was added to a webhook ACK path: `twilio.ts:313` and `voice.ts:104`
  are pure functions over data already in scope.

**Missed call sites: nothing found.** Every consumer of the changed signatures
is updated - `groupRowFor`/`relayRowFor` (`inbox.ts:1251`, `:1439-1440`,
`:2318`, `:2387`), `whoOfConversation` (`today.ts:780`, the only call site),
`maskedPartyLabel` (`voice.ts:991`, `:992`, `:997`), `pushSenderLabel`
(`twilio.ts:731`, `:1817`), `contactDisplayName` (all 6 sites typecheck against
the wider shape). `resolveRosterNames` passes an unchunked id list, which is
safe: `contactsRepo.ts:822-826` de-dupes and chunks at 100 internally.

---

## RISK CALL

**Low risk on the code; merge-blocked on one registry defect.**

The implementation is careful, the read budget is asserted rather than asserted-
about (`contactRelayGroups.test.ts` and `relayApi.test.ts` both count batches),
the degradation posture is right (short map -> today's behavior, never a phone
number), and the out-of-scope list in
`group-roster-name-snapshot-never-refreshed.md:111-149` is unusually honest -
it names five surfaces it deliberately did not fix, with reasons, which is what
let me verify most of them in minutes rather than hours.

The one thing I would block on is finding 1: this branch fixes the staff-facing
half of a `high` issue and closes the whole issue, and the outbound half - the
half that reaches tenants and landlords, and the half the `high` was assigned
for - ends up in no open registry row anywhere. That is a five-minute fix and it
is the difference between "we scoped it" and "we lost it".

Findings 2, 3 and 5 are worth doing before merge but do not block: 2 is a
docblock that now lies, 3 is a bounded serial-latency regression on one tab, 5
is an e2e assertion that costs runtime and buys nothing. Finding 4 should be
settled while the three copies are still one commit apart.
