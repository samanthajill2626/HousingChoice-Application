# Planner independent SPEC-CONFORMANCE review

Reviewer: planner-side independent conformance reviewer (read-only).
Branch `feat/participant-snapshot-refresh`, final code commit `16df7dfa`
(HEAD at review time `19a1bff0`, docs-only above the code commit).
Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`.
Work map: `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/handback.md`.
Method: walked every spec section to the shipped code and tests via
`git diff main...HEAD` plus direct reads. No suites run (the planner's gate
battery owns this worktree); no file edited except this one.

**VERDICT: CONFORMANT-WITH-NOTES.**

Every decision in section 2, every row of the section 3 In table, every
exclusion in the Out list, every slice requirement in section 5 and every
disposition in section 7 is delivered as specified. One low-severity gap
against section 6's literal test wording (F1) and one low-severity
documentation gap (F2) are the only findings. All other divergences are
declared and justified in the handback.

---

## 1. Section 2 - the six decisions

### D1 "Resolve on read" - CONFORMS

Every named display surface takes the name from the contact at render time:
`app/src/routes/today.ts:780` and `:1008`, `app/src/routes/inbox.ts:1250`,
`:1435`, `:2315`, `:2386`, `app/src/routes/contacts.ts:1208` and `:1295`,
`app/src/routes/relayGroups.ts:489`, `app/src/routes/api.ts:2205`,
`app/src/lib/rosterResolution.ts:563`,
`app/src/routes/webhooks/twilio.ts:318`,
`app/src/routes/webhooks/voice.ts:126`.

### D2 "The chain: live contact name -> stored snapshot -> formatted phone" - CONFORMS at every surface

- Module rung order: `app/src/lib/participantNames.ts:64-75` (live, then stored;
  `isDeleted` and empty-name both fall through to stored).
- Today `who`: `app/src/routes/today.ts:1089-1099` - `nameFromContact(contact)`
  -> non-empty `participant_display_name` -> `formatPhoneForDisplay`.
- Inbox rows: `withLiveNames` feeds the unchanged `relayThreadLabel` /
  `groupThreadLabel` chains (`inbox.ts:1160`, `:1203`), whose own last rung is
  the formatted phone (`app/src/lib/groupTitle.ts`).
- Contact cards: `contacts.ts:1213` and `:1297` feed `relayMemberLabels` /
  `groupThreadLabel`, same last rung.
- Relay members panel: `relayGroups.ts:489-490` - live -> stored -> field
  absent, and the client renders the stored phone (documented at `:481-488`).
- People card: `rosterResolution.ts:563` - contact `displayName` -> stored
  `member.name`.
- Push sender label: `twilio.ts:322-329` - non-deleted contact ->
  roster name -> `formatPhoneForDisplay(from)` -> raw From.
- Voice masked label: `voice.ts:126-134` - masked contact -> masked stored name
  -> role -> "the other party". No phone rung, exactly as spec S4 prescribes
  (PII); this is the spec's own stated exception to D2's third rung, not a
  deviation.

### D3 "Batch. One getDisplaysByIds per page. Never one read per member. Never a findByPhone on a request path." - CONFORMS

- One batch per page at each boundary; per-page cost matches the amended costs
  exactly (see section 3 below).
- No per-member read survives anywhere: the old `Promise.all` of `getById` in
  `relayGroups.ts` is gone, pinned by `app/test/relayApi.test.ts:472`
  (`expect(getByIdSpy).not.toHaveBeenCalled()`).
- No `findByPhone` added on any path. The only `findByPhone` token in the whole
  diff is inside a comment at `twilio.ts:314`.
- Verified by scanning every added line of the diff.

### D4 "No unnecessary reads" - CONFORMS

- Today `who` adds ZERO reads: `getContact` is the memoized cache at
  `today.ts:357-370`, already populated for the same `ownerId` by the
  deleted-contact gate at `today.ts:743-747`. Pinned at
  `app/test/todayApi.test.ts:1829` (`reads.filter(id === 't-renamed')` has
  length 1).
- People card, push, voice: precedence flips only. `voice.ts:993-1005` is
  byte-identical to `main` in its read posture (compared directly against
  `git show main:app/src/routes/webhooks/voice.ts`); `twilio.ts` adds no repo
  call; `rosterResolution.ts` reuses the contact read two paragraphs above.
- Client-hydrated surfaces not hydrated again: `GET /conversations/:id`
  (`api.ts` thread header) is untouched; the whole `api.ts` delta is 7 lines,
  the import plus `:2201-2206`.

### D5 "Phone numbers: no code change; participants[].phone is never touched" - CONFORMS

`withLiveNames` only ever rewrites `name` (`participantNames.ts:68-74`).
No added line in `app/src` assigns to a `.phone`. Pinned at
`app/test/participantNames.test.ts:52` (phones equal, input unmutated) and
`app/test/relayApi.test.ts:472` (the stored phone survives beside the resolved
name).

### D6 "Outbound message content is out" - CONFORMS

No file under `app/src/messages/`, `app/src/jobs/relayFanOut.ts` or
`app/src/services/relayAnnouncements.ts` appears in the branch's 32 code files.
The unfixed outbound half is written up in the resolved issue's stamp
(`docs/issues/group-roster-name-snapshot-never-refreshed.md`, "Outbound message
content, by the spec's decision 6").

---

## 2. Section 3 - the In table (eleven surfaces)

| # | surface | verdict | evidence |
|---|---|---|---|
| S1 | Today `who` | CONFORMS, 0 reads | `today.ts:779-783`, `:1089`; memo at `:357`, prior populate at `:743`; pin `todayApi.test.ts:1829` |
| S1 | Today relay close-nag member names | CONFORMS, 1 batch | `today.ts:999-1008` (`hydrateConversationRosters(dueGroups, ...)`); pin `todayApi.test.ts:1839` |
| S2 | Inbox group rows (`groupRowFor`) | CONFORMS, 1 batch per page | builder `inbox.ts:1197-1206`; call sites `:1251`, `:2387`; batches `:1250`, `:2386` |
| S2 | Inbox relay rows (`relayRowFor`) | CONFORMS, costs exactly as amended | builder `inbox.ts:1156-1163`; `filter=groups` 1 batch (`:1250`); `filter=all` TWO (`:2315` relay partition + `:2386` group partition); `filter=unread` one batch per multi-party candidate (`:1435`, guarded by `candidate.kind !== 'unknown'` at `:1426`); `filter=unknown` 0 (the arm returns before the relay merge, documented `:2323-2328`) |
| S2 | Contact page group cards | CONFORMS, 1 batch per card, ids post-filter | relay card `contacts.ts:1190-1212` (partitions read, `mine` filtered, THEN `:1208` batch); group card `:1291-1296`; pin `contactRelayGroups.test.ts:346` asserts ONE batch whose id set excludes the group this contact is not on |
| S2 | Relay members panel | CONFORMS, strictly FEWER reads | `relayGroups.ts:489-490`; the `delete memberWithoutStoredName.name` line is gone; pins `relayApi.test.ts:427`, `:452`, `:472` |
| S2 | `GET /calls/:callId` passthrough | CONFORMS, 1 batch over one roster | `api.ts:2201-2206`; pin `voiceWebhook.test.ts:981` (see F1 for the batch-pin gap) |
| S3 | People card (`describeRoster`) | CONFORMS, 0 reads | `rosterResolution.ts:563`; `removed` guard at `:541` untouched; pin `rosterResolution.test.ts:464` |
| S4 | Push sender label | CONFORMS, 0 reads | `twilio.ts:318-329`; pins `inboundMessagePush.test.ts:442`, `:564`, `:593` |
| S4 | Voice masked party label + whisper | CONFORMS, 0 reads | `voice.ts:126-134`; whisper carries the same label `voice.ts:1005` -> `:1058`; pins `voiceWebhook.test.ts:124`, `:142`, `:169` (the last asserts `callerLabel=Alice%20A.` on the wire) |
| S5 | Drift audit, group rosters | CONFORMS | `app/scripts/measure-unread-contact-coverage.ts:590-637` + new `app/src/lib/rosterDriftTally.ts`; every count the spec lists is present, plus the requested-vs-returned delta at `:626-633` |

Net request-path cost matches the spec's own summary line: one batch per contact
card, one on inbox `groups`, two on `all`, one per multi-party row on `unread`,
zero on `unknown`, and `GET /members` got cheaper.

---

## 3. Section 3 - the Out list (each exclusion actually excluded)

| exclusion | verdict | evidence |
|---|---|---|
| Thread header `GET /conversations/:id` (`api.ts:2004`) | CONFORMS - untouched | `api.ts` diff is import + `:2201-2206` only |
| Group push titles (`groupThreadLabel` / `relayThreadLabel` in `twilio.ts`) | CONFORMS - still pass the STORED roster | no call-site change in the `twilio.ts` diff; the divergence is documented at `groupTitle.ts:13-19`, `:35-39`, `:123-135` and pinned at `inboxGroups.test.ts:531` / `contactRelayGroups.test.ts:318` |
| `GET /group-members` (`api.ts:2020`) | CONFORMS - left exactly as is | not in the diff |
| Bare-phone relay members (`relayGroups.ts:483`) | CONFORMS | `participantNames.ts:69` returns them as-is; pin `relayApi.test.ts:472` (the `contactId: ''` member is unchanged) |
| `groupSend.ts:253`, `relayGroupDuplicates.ts:68`, `poolNumbersAdmin.ts` | CONFORMS - none touched; filed as one issue | `docs/issues/staff-only-roster-name-readers-stale.md` |
| Client code except `buildToday.ts` | CONFORMS | the only `dashboard/src` file in the diff is `dashboard/src/routes/today/buildToday.ts` |
| `participants[].contactId` ownership, `lib/unreadFeed.ts`, Unknown-tab walk, `jobs/tourReminders.ts` | CONFORMS - none touched | absent from the 32-file list |
| The existing writers of both fields | CONFORMS - all stay | no writer removed anywhere in the diff |

No scope creep found. The branch's non-doc footprint is 32 files, and every one
is either named by the spec or a spec-implied helper (`lib/participantNames.ts`,
`lib/rosterDriftTally.ts`, `lib/voiceMasking.ts` `shortNameFromFull`,
`lib/groupTitle.ts` comments-only).

---

## 4. Section 4 - the mechanism

- Module exists at `app/src/lib/participantNames.ts` with the three specified
  exports at `:32`, `:64`, `:78`, with the specified signatures
  (`hydrateConversationRosters(convs, contacts: Pick<ContactsRepo,'getDisplaysByIds'>, log)`
  at `:78-84`). NOTE N1: a fourth export `resolveRosterNames` (`:48`) was added -
  purely additive, and it is what the non-`ConversationItem` call sites need.
- `withLiveNames` per-member rule matches word for word: non-empty `contactId`,
  non-deleted, non-empty `contactDisplayName`, else keep `p.name`; phone
  untouched; input not mutated; bare-phone as-is (`:64-75`, pinned
  `participantNames.test.ts:47-67`).
- Never rejects: `resolveRosterNames` try/catch at `:54-60` warns and returns an
  empty map. Pinned `participantNames.test.ts:96`.
- `requireComplete` appears NOWHERE in the diff (scanned).
- `contactDisplayName` widened (`contactName.ts:72-80`) and its
  "push-copy sites only / do not re-point" docblock rewritten to the new
  contract (`contactName.ts:49-70`). NOTE N2: widened via a structural
  `{ contactId; firstName?: unknown; lastName?: unknown }` parameter rather
  than a `ContactItem | ContactDisplayItem` union. Functionally identical, and
  `ContactDisplayItem` acceptance is pinned at `contactName.test.ts:115-117`.
- No other private helper re-pointed: `inbox.ts:538` and `today.ts:225` keep
  their own copies, untouched by the diff, and the census issue records why.
- The "cannot tell read-failed from name-cleared" limit is carried in the
  module header and in the audit's `nameOnlyStored` counter
  (`rosterDriftTally.ts:22-33`).

---

## 5. Section 5 - the slice requirements

- **S1 Today.** `whoOfConversation(conv, contact)` implements the exact stated
  chain (`today.ts:1089-1099`) using the file's own `nameFromContact` (`:223`).
  `getById` count pinned unchanged (`todayApi.test.ts:1829`). Client guard
  landed at `buildToday.ts:106-112` - a non-empty guard on the bare `??`,
  nothing else. CONFORMS.
  NOTE N3: the close-nag batches over `dueGroups` (the due-filtered subset,
  `today.ts:1000-1007`) rather than the whole `listRelayGroups('open')` page.
  Still exactly one batch, over strictly fewer ids - better than the spec's
  stated cost, not worse.
- **S2 Rosters.** Ids -> one batch -> `withLiveNames` -> unchanged label
  functions. `groupRowFor` takes the map as its second argument
  (`inbox.ts:1197-1200`). `relayGroups.ts` replaced the `Promise.all` with the
  batch, deleted the `delete ...name` line, and rewrote its comment to state the
  three-rung chain (`:481-490`). `contacts.ts` filters to this contact's groups
  first, then collects ids, in BOTH routes (`:1204-1212`, `:1294-1296`).
  CONFORMS.
- **S3 People card.** Precedence flipped at `rosterResolution.ts:563`; the
  `removed` guard at `:541` is untouched (it still short-circuits the contact
  rung). `rosterEdits.ts` is COMMENT-ONLY: the whole 9-line delta is the two
  docblocks at `:440-442` and `:453-457`; no executable line changed. CONFORMS
  to the comment-only rule.
  DECLARED DEVIATION D-a: the spec expected the preview pins' recipient
  expectations to need updating; none did. `app/test/rosterEdits.test.ts` is
  absent from the diff, so the body strings phase-b landed are byte-identical to
  `main` by construction, and the recipient-name assertions at `:306`, `:311`,
  `:335`, `:346`, `:358` still stand green. Declared in the handback (T6,
  "ZERO preview expectations re-baselined").
- **S4 Push and voice.** `pushSenderLabel` contact-first with the docblock
  rewritten (`twilio.ts:306-317`). `maskedPartyLabel` is
  `contactShortName(contact)` -> stored name through the same "First L."
  transform (`shortNameFromFull`, `voiceMasking.ts:60-68`) -> role -> "the other
  party", docblock rewritten (`voice.ts:110-125`). The whisper moved with it -
  `voice.ts:1005` feeds `:1058`'s `callerLabel`. BOTH pinned: persisted
  `call_party_label` at `voiceWebhook.test.ts:124`/`:142`/`:169`, and the spoken
  whisper at `voiceWebhook.test.ts:184` asserting `callerLabel=Alice%20A.` -
  the masked-label whisper pin the spec demanded. CONFORMS.
  DECLARED DEVIATION D-b: both labels gained an `isDeleted` guard the spec's S4
  text did not name (`twilio.ts:322-325`, `voice.ts:128-129`). It enforces
  section 4's own non-deleted rung and was raised by both round-1 reviewers;
  declared in the handback (wave 1, and adjudication R2-3 for the resulting
  "deleted contact -> formatted phone" change on the push arm).
- **S5 Audit.** Group pass added, sourced from `listGroupTexts` +
  `listRelayGroups('open'|'connecting'|'closed')`
  (`rosterDriftTally.ts:66-85`), counts only, with the requested-vs-returned
  delta reported separately from dangling ids
  (`measure-unread-contact-coverage.ts:626-633`) and a same-predicate id guard
  at `:606-611`. Run ONCE at handback against a seeded lane with the numbers
  recorded (handback "Live self-QA": 10 rosters / 22 members, `NOT RETURNED 0`,
  `name DIFFERS 0` fresh and 2 after the rename). CONFORMS.
  NOTE N4: one counter beyond the spec's list, `nameOnlyStored`
  (`rosterDriftTally.ts:22-33`) - added in wave 2 and declared.

---

## 6. Section 6 - the test list

| spec bullet | verdict | evidence |
|---|---|---|
| `participantNames.test.ts`: live wins / stored on map miss / stored on empty live name / deleted ignored / bare-phone untouched / phone untouched / input not mutated / partial map | CONFORMS, all eight | `app/test/participantNames.test.ts:47` (live wins, empty live name -> `Stays Stored`, bare-phone), `:52` (phone + no mutation), `:60` (deleted), `:87` (partial map / map miss) |
| Today: renamed renders new / unreadable renders stored / unlinked renders phone / `getById` count unchanged | CONFORMS, all four | `todayApi.test.ts:1798`, `:1805`, `:1812`, `:1823`, `:1829` |
| Inbox / contact cards / relay members / calls passthrough: renamed renders + assert UNIQUE ID count | CONFORMS on the renders; PARTIAL on the id-count pin (see F1) | renders: `inboxGroups.test.ts:476`, `:500`; `contactGroupThreads.test.ts:208`; `contactRelayGroups.test.ts:290`; `relayApi.test.ts:472`; `voiceWebhook.test.ts:981`. Unique-id sets asserted at `inboxGroups.test.ts:496-497`, `contactRelayGroups.test.ts:372-373`, `relayApi.test.ts:497-498` |
| `describeRoster`: contact beats stale stored; `removed_contact` keeps stored | CONFORMS | `rosterResolution.test.ts:464-483` - one test, both assertions in the single expectation at `:482` |
| Preview pins: recipients updated, bodies byte-identical | CONFORMS (vacuously) | no change needed; see D-a |
| `pushSenderLabel` / `maskedPartyLabel`: contact first; masked never a full name; persisted label pinned | CONFORMS | `inboundMessagePush.test.ts:442`/`:564`/`:593`; `voiceWebhook.test.ts:124`/`:142`/`:169`; `voiceMasking.test.ts:8` |
| Audit: group pass counts a seeded stale roster from both sources | CONFORMS | `rosterDriftTally.test.ts:6` (classification, every bucket exactly once) + `:42` (both sources walked, all three relay partitions, truncation surfaced) |
| Fixtures: `seed/performance.ts` synthetic names - update dependents or say so | CONFORMS | grep confirms zero dependents outside the seed itself; recorded in `research-C-findings.md:282-283`, including the correct path `app/src/lib/seed/performance.ts` and the template-literal trap at `:890` |
| E2E rename scenario, accessibility-first | CONFORMS | `e2e/tests/scenarios/participant-names.spec.ts` - one flow renaming a contact who is both on a tour relay group and the sender of an unread 1:1, asserting Today (`:53-60`), the owner's contact-file group card (`:62`), and the group thread header after a fresh load (`:65-66`); step helpers at `e2e/scenarios/steps.ts:723`, `:3543` |

TDD red-before-green: every new behavioural test is named `RED:` or `PIN:` and
the slice reports record the red runs. Not independently re-run here (suites are
off-limits during the planner battery).

---

## 7. Section 7 - issue dispositions

| spec instruction | verdict | evidence |
|---|---|---|
| Close `today-shows-phone-instead-of-name` | CONFORMS (`status: resolved`, `resolved: 2026-09-01`) | `docs/issues/today-shows-phone-instead-of-name.md:7-9` |
| Close `group-roster-name-snapshot-never-refreshed`, stamp naming the push-title AND close-dialog residue | CONFORMS, and exceeds it | `docs/issues/group-roster-name-snapshot-never-refreshed.md:6-10` plus the resolution block: push titles named with call sites, close dialogs named with `PlacementDetail.tsx:373` / `TourDetail.tsx:454`, and four further residues (GET /api/conversations, SSE roster, bare-phone members, staff-only readers) plus the UNFIXED outbound half |
| Close `relay-stale-participant-phone` (documented remove-and-re-add) | CONFORMS | `docs/issues/relay-stale-participant-phone.md:6-9` |
| Update `consolidate-contact-display-name-helpers` with the corrected census (13, not 6; inbox extra rung; `voiceMasking.ts` different rule) and leave OPEN | CONFORMS | `docs/issues/consolidate-contact-display-name-helpers.md:2-11` - title says thirteen, `status: open`, `refs` lists all 13 sites |
| `today-contact-hydration-fan-out`: record the distinct-`getById` count, close wontfix if small | DECLARED DEVIATION D-c - stamped with harness N = 1 but left OPEN | `docs/issues/today-contact-hydration-fan-out.md:6-8`; handback declares it pre-ratified by Cameron via the planner, on the ground that a 1-contact harness number is exactly what the issue's own "measure first" rule rejects. Sound; agreed |
| File one issue for the staff-only stale readers | CONFORMS | `docs/issues/staff-only-roster-name-readers-stale.md` (created 2026-09-01, `status: open`, three named sites) |
| Run `npm run issues` | Handback reports exit 0 with one pre-existing warning in an untouched file. Not re-verified (INDEX.md is gitignored) |
| Note for M3: no phone source changed | CONFORMS | handback "Note for bundle M3"; independently confirmed - no `.phone` assignment in the diff |

The build used `status: resolved` + `resolved:` rather than the spec's word
"closed". Per the review brief this is the registry's actual vocabulary; intent
matches. Not a finding.

---

## 8. Findings

**F1 (LOW, undeclared) - two batched boundaries have no read-budget pin at the
route.** Spec section 6 asks the four batched surfaces to "assert UNIQUE ID
count passed to `getDisplaysByIds`". Three do:
`app/test/inboxGroups.test.ts:496-497`,
`app/test/contactRelayGroups.test.ts:372-373`,
`app/test/relayApi.test.ts:497-498`. Two do not:

- `GET /calls/:callId` - `app/test/voiceWebhook.test.ts:981-990` asserts the
  resolved name only.
- the contact card's group-threads half -
  `app/test/contactGroupThreads.test.ts:208-227` asserts title and
  `otherMemberNames` only (its relay sibling IS pinned).

Both are one batch BY CONSTRUCTION - each calls a single
`resolveRosterNames`/`hydrateConversationRosters` whose one-batch-unique-ids
behaviour is pinned at `app/test/participantNames.test.ts:74-86` - so the risk
is a future refactor moving a call inside a loop without a red test, not a
present defect. The handback's sub-threshold list names the analogous close-nag
gap but not these two, so the omission is undeclared. Not merge-blocking.

**F2 (LOW, undeclared) - the S1 close-nag cost row in the spec is now stale
against the code.** `today.ts:1000-1008` batches over `dueGroups`, not over
`listRelayGroups('open')` as the In table says. The shipped form is strictly
cheaper and equally one batch, so this is a spec-text drift worth one line in
the merge record rather than a code change. (Listed as a finding only because
nothing in the handback reconciles the two statements.)

## 9. Declared deviations accepted as notes (not findings)

- **D-a** rosterEdits preview pins needed no re-baseline (handback T6).
- **D-b** `isDeleted` guards added to `pushSenderLabel` / `maskedPartyLabel`
  beyond the spec's S4 text (handback wave 1; adjudication R2-3).
- **D-c** `today-contact-hydration-fan-out` left open rather than closed wontfix
  (handback, pre-ratified by Cameron).
- **D-d** `GET /api/conversations` left unhydrated on decision 4, recorded as
  residue in the resolved issue's stamp (handback).
- **D-e** the `relayApi.test.ts` retitles at `:427` and `:452` REVERSE a 2026-07
  ruling. The spec directs it ("stops deleting the stored name at `:489`");
  named in the commit body and in handback T5.
- **D-f** T7's third RED test redesigned (two posts, distinct MessageSid) -
  `inboundMessagePush.test.ts:564`, `:593`. Declared.
- **D-g** the e2e Today leg is not fully discriminating for rung 1 (the
  product's own PATCH write-through refreshes the 1:1 snapshot), so unit pins
  carry that rung. Declared, adjudication R2-17/A-5.
- **N1** extra module export `resolveRosterNames`; **N2** `contactDisplayName`
  widened structurally rather than as a union; **N3** close-nag batch over
  `dueGroups`; **N4** extra audit counter `nameOnlyStored`.

## 10. Repo-rule spot checks

- Added lines are ASCII-only across `app/src`, `app/test`, `app/scripts`,
  `dashboard/src`, `e2e`, `docs/issues` (scanned).
- `relayGroups.ts` removed the `nameFromContact` import along with its last use;
  `resolveMemberName` is still used at `:422`, so no new unused-import error.
  The handback's "sole eslint error `resolveMessage` at `relayGroups.ts:60`"
  is confirmed pre-existing: that import line is byte-identical on `main`.
  Gate 5 itself not re-run (planner battery owns the worktree).
- Mission reasoning is committed under
  `docs/superpowers/reviews/2026-08-31-participant-snapshot-refresh/`, not left
  in the gitignored `.superpowers/`.
