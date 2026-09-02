# Spec-conformance review - participant names: resolve on read (M1)

Branch `feat/participant-snapshot-refresh`, HEAD `8cc3d165`, merge-base `f27aabbf`.
Worktree `W:\tmp\participant-snapshot-refresh`; tracked tree clean at review time.

Contract: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`
(all 205 lines). Every verdict below was taken from the CURRENT tree, not from the
diff package or from any slice report (slice reports and prior review artifacts
were deliberately not read).

Overall call: **CONFORMANT WITH NOTES**.

---

## 1. Work-map items

| item | verdict | evidence |
|---|---|---|
| T1 `lib/participantNames.ts` + widen `contactDisplayName` | CONFORMS | `app/src/lib/participantNames.ts:32` `collectRosterContactIds`, `:64` `withLiveNames`, `:78` `hydrateConversationRosters` - the three names the spec's section 4 signature block requires, same argument order. `app/src/lib/contactName.ts:72-74` takes `{ contactId; firstName?: unknown; lastName?: unknown }`; the `contactId` anchor is present and the now-orphaned `import type { ContactItem }` is deleted (was `contactName.ts:7`). `app/test/participantNames.test.ts` 9 tests, run green. |
| T2 Today `whoOfConversation(conv, contact)`; close-nag hydrated; `buildToday.ts` guard | CONFORMS | `app/src/routes/today.ts:1089-1095` implements the spec's exact chain; sole call site `:780-783`; the contact comes from the memoized `getContact` (`:358`) that `isDeletedContact` already warmed at `:744`, so zero reads added (pinned). Close-nag: `:1001-1008` filters to due groups then one `hydrateConversationRosters`. Client guard: `dashboard/src/routes/today/buildToday.ts:103-111`. `app/test/todayApi.test.ts:1783-1864` - 6 tests, run green. |
| T3 Inbox `groupRowFor`/`relayRowFor` take a names map; call sites; sibling fakes | CONFORMS | Signatures `app/src/routes/inbox.ts:1156` (`relayRowFor`) and `:1197` (`groupRowFor`). Batches at `:1250` (filter=groups), `:1435` (unread, per multi-party candidate), `:2315` (relay partition), `:2386` (group partition of filter=all). Call sites `:1251`, `:1439`, `:1440`, `:2318`, `:2387` - all pass a map. Sibling fakes gain `getDisplaysByIds`: `app/test/inboxFeed.test.ts:224-230`, `app/test/inboxUnreadParity.test.ts:245-251`; recording fake `app/test/inboxGroups.test.ts:119-132`. |
| T4 Contact cards: batch hoisted out of the 3-status loop; ids after the membership filter | CONFORMS | `app/src/routes/contacts.ts:1190-1207` collects `mine` across all three partitions, ONE batch at `:1208`, render loop at `:1213`. Group-threads card: membership filter `:1294`, batch `:1295`. Pinned by `app/test/contactRelayGroups.test.ts:310-345`, which asserts exactly one batch whose id set excludes a group the contact is not on. |
| T5 Relay members panel batched + stored-name fallback; `GET /calls/:callId` hydrated; ruling reversal named | CONFORMS | `app/src/routes/relayGroups.ts:489-490` - one `resolveRosterNames` + `withLiveNames`; the per-member `getById` `Promise.all` and the `delete memberWithoutStoredName.name` line are gone, and the `nameFromContact` import was dropped. `app/src/routes/api.ts:2205`. Reversal is named in the body of commit `871ebefd` (quotes both old and new titles and says the failure injection moved to `getDisplaysByIds`). Both retitled tests exist: `app/test/relayApi.test.ts:427` and `:451`; new one-batch/no-`getById` pin at `:470`. Ran `-t "GET roster"`: 5 passed. |
| T6 `describeRoster` precedence flip; two `rosterEdits.ts` comments only; preview pins unchanged | CONFORMS (see note N1) | `app/src/lib/rosterResolution.ts:562-563` - contact first, stored second; the `removed` guard at `:541` is byte-unchanged. `app/src/services/rosterEdits.ts` diff is exactly two docblocks (`:440-442`, `:456-457`); no code. No preview pin moved, and that is genuinely correct rather than an omission: `app/test/rosterEdits.test.ts:180-183` stores roster names identical to the contact names, so the flip is invisible to them. New pin `app/test/rosterResolution.test.ts:460-483`. |
| T7 `pushSenderLabel` + `maskedPartyLabel` contact-first; `shortNameFromFull`; whisper pinned | CONFORMS (see F1) | `app/src/routes/webhooks/twilio.ts:308-317`; `app/src/routes/webhooks/voice.ts:120-126`; `app/src/lib/voiceMasking.ts:55-67`. Whisper path verified end to end: `voice.ts:997` builds `callerLabel`, `:1049` puts it on the whisper URL. Pins: `app/test/voiceWebhook.test.ts:124-140` (persisted `call_party_label` prefers the contact), `:141-158` (persisted label AND `callerLabel=Alice+A.` in the TwiML), `:954-964` (calls passthrough), `app/test/inboundMessagePush.test.ts:529-556` (push body prefix). |
| T8 `rosterDriftTally.ts` (tally + sourcing, tested); `--audit-denorm` group pass | PARTIAL (see F2) | Code CONFORMS: `app/src/lib/rosterDriftTally.ts:28` `tallyRosterDrift`, `:54` `collectGroupRosters` (group_text pages + all three relay partitions); wired at `app/scripts/measure-unread-contact-coverage.ts:591`, printed at `:601-630` with every one of the spec's eight counts including the requested-vs-returned delta at `:626`. `app/test/rosterDriftTally.test.ts` 2 tests, run green. What is missing is the spec's own handback obligation: no recorded lane numbers anywhere in the tracked diff. |
| T9 e2e tour -> group -> rename -> Today / owner's Relay card / group facts line | CONFORMS (see N5) | `e2e/tests/scenarios/participant-names.spec.ts:1-67` asserts all three surfaces; helpers `e2e/scenarios/steps.ts:726` and `:3544`. The flow discriminates: `tenantAsksToTour` mints the 1:1 BEFORE the rename, and no inbound path refreshes `participant_display_name` on an existing thread (`app/src/routes/webhooks/twilio.ts:744`, `:957`, `:1836`, `:2096` all call `createOrGetByParticipantPhone`; `applyTriage` appears only on `app/src/routes/contacts.ts:1886`, the start-a-conversation route), so a stale snapshot really is what the assertion has to beat. |
| T10 issue stamps + new issue + `npm run issues` | CONFORMS (see F3) | Resolved with `resolved: 2026-09-01`: `docs/issues/today-shows-phone-instead-of-name.md:6-9`, `docs/issues/group-roster-name-snapshot-never-refreshed.md:6-9`, `docs/issues/relay-stale-participant-phone.md:6-9`. Census corrected 6 -> 13 with per-file line refs and the two non-mechanical cases called out: `docs/issues/consolidate-contact-display-name-helpers.md:2`, `:10`, `:23-48`. Fan-out issue kept open with the harness number recorded: `docs/issues/today-contact-hydration-fan-out.md:68-91`. New issue `docs/issues/staff-only-roster-name-readers-stale.md:1-30`. Index regenerated: `docs/issues/INDEX.md:135` and `:290`. |

---

## 2. Spec section 3 "In" table

| row | verdict | evidence |
|---|---|---|
| S1 Today `who` - 0 reads | CONFORMS | `app/src/routes/today.ts:1089-1095` + `:780-783`; read-count pin `app/test/todayApi.test.ts:1826-1834` asserts exactly ONE `getById` for the thread contact across the whole request. |
| S1 Today relay close-nag member names - 1 batch | CONFORMS (narrower) | `app/src/routes/today.ts:1001-1008`. The batch is taken over `dueGroups` (nag due AND pool number present), not over the whole `listRelayGroups('open')` page the spec named - strictly fewer ids for the same result. Pinned `app/test/todayApi.test.ts:1836-1863`. |
| S2 Inbox group rows - 1 batch per page | CONFORMS | `app/src/routes/inbox.ts:1250`, `:2386`; label call `:1205`. Pin `app/test/inboxGroups.test.ts:471-495` asserts one batch and the exact unique-id set. |
| S2 Inbox relay rows - 1 per page, TWO for `filter=all`, one per multi-party row for `unread` | CONFORMS | `app/src/routes/inbox.ts:2315` (relay partition) and `:2386` (group partition) are the two `filter=all` reads; `:1435` is the per-candidate read inside the unread arm, beside the point read that loop already does. Label call `:1162`. Pin `app/test/inboxGroups.test.ts:497-519`. |
| S2 Contact page group cards - 1 batch per card, ids AFTER the membership filter | CONFORMS | `app/src/routes/contacts.ts:1208` (relay card, after `mine` is built across all three partitions) and `:1295` (group-threads card, after `items.filter(...isSelf)`). Pins `app/test/contactRelayGroups.test.ts:286-345`, `app/test/contactGroupThreads.test.ts:200-227`. |
| S2 Relay members panel - FEWER reads; stops deleting the stored name | CONFORMS | `app/src/routes/relayGroups.ts:481-490`. Both former behaviors are gone and both reversed tests pin the new one. |
| S2 `GET /calls/:callId` passthrough - 1 batch over one roster | CONFORMS | `app/src/routes/api.ts:2202-2206`; pin `app/test/voiceWebhook.test.ts:954-964`. |
| S3 People card `describeRoster` - 0 reads, flip precedence | CONFORMS | `app/src/lib/rosterResolution.ts:562-563`; the per-member `getById` at `:530` is pre-existing and untouched. |
| S4 Push sender label - 0 reads, flip precedence | CONFORMS | `app/src/routes/webhooks/twilio.ts:308-317` - pure, no I/O added. |
| S4 Voice masked party label - 0 reads, stays masked, whisper moves too | CONFORMS | `app/src/routes/webhooks/voice.ts:120-126`; both `getById` calls that feed it (`:987`, `:996`) are pre-existing. Masking of the stored rung is real (`shortNameFromFull`, `voiceMasking.ts:60-67`) and the spoken change is pinned. |
| S5 Drift audit, group rosters | PARTIAL | Code conforms (see T8). The spec's "Run ONCE at handback against a seeded lane and record the numbers" is not evidenced. |

---

## 3. Spec section 3 "Out" bullets - all confirmed untouched

| out bullet | verdict | evidence |
|---|---|---|
| Thread header `GET /conversations/:id` | NOT TOUCHED | Handler at `app/src/routes/api.ts:1997`; the api.ts diff has exactly two hunks (the import near `:165` and the `/calls/:callId` body at `:2205`). |
| Group push titles (`groupThreadLabel` / `relayThreadLabel` in twilio.ts) | NOT TOUCHED | The twilio.ts diff is `pushSenderLabel` and its docblock only. |
| `GET /group-members` | NOT TOUCHED | Handler at `app/src/routes/api.ts:2021`, outside every hunk. |
| Bare-phone relay members | NOT TOUCHED, preserved by construction | `app/src/lib/participantNames.ts:69` returns a copy unchanged when `contactId` is empty; pinned in `participantNames.test.ts:47-50` and `relayApi.test.ts:490`. |
| `groupSend.ts` refusals, `relayGroupDuplicates.ts`, `poolNumbersAdmin.ts` | NOT TOUCHED | None appear in `git diff --name-only f27aabbf..HEAD`. Filed as one issue: `docs/issues/staff-only-roster-name-readers-stale.md`. |
| Client code | NOT TOUCHED beyond the sanctioned exception | The whole non-`app/` diff is `dashboard/src/routes/today/buildToday.ts`, `e2e/scenarios/steps.ts`, `e2e/tests/scenarios/participant-names.spec.ts`. |
| `participants[].contactId` ownership (M8), `lib/unreadFeed.ts` + Unknown-tab walk (M6), `jobs/tourReminders.ts` | NOT TOUCHED | `git diff --name-only f27aabbf..HEAD -- app/src/lib/unreadFeed.ts app/src/jobs/tourReminders.ts` is empty. |
| The existing writers of both fields all stay | CONFIRMED | `app/src/services/relayMembers.ts`, `app/src/repos/conversationsRepo.ts`, `app/src/routes/contacts.ts:1886` all unchanged as writers. |

---

## 4. Binding constraints

| constraint | verdict | evidence |
|---|---|---|
| Chain: live contact name -> stored snapshot -> formatted phone | CONFORMS | `app/src/lib/participantNames.ts:68-74` (rungs 1 and 2; rung 3 is the client's, documented `:10-12`); Today's own copy `app/src/routes/today.ts:1090-1095` carries all three; relay panel comment `relayGroups.ts:481-488`. |
| One `getDisplaysByIds` per page, NEVER per member | CONFORMS | Every batch site sits outside its member loop: `inbox.ts:1250`, `:1435`, `:2315`, `:2386`; `contacts.ts:1208`, `:1295`; `relayGroups.ts:489`; `api.ts:2205`; `today.ts:1008`. `resolveRosterNames` is called once per site (`participantNames.ts:48-61`), and the repo de-dupes ids itself (`contactsRepo.ts:821`). Three tests assert the unique-id set rather than the call count, as the spec asked. |
| No `findByPhone` added to any request path | CONFORMS | `git grep -n findByPhone HEAD -- app/src` vs `git grep -n findByPhone f27aabbf -- app/src` return the same call sites, differing only in line numbers from unrelated shifts. No new site. |
| No `requireComplete` | CONFORMS | The string does not occur anywhere in `git diff f27aabbf..HEAD -- app/src app/scripts dashboard e2e`. |
| `participants[].phone` never written | CONFORMS | `withLiveNames` writes only `name` (`participantNames.ts:73`). The only added `participants:` assignments are in-memory object spreads (`participantNames.ts:84`, `inbox.ts:1162`); no conversation write call was added anywhere in the diff. |
| Do-not-edit files untouched | CONFORMS | `jobs/relayFanOut.ts`, `services/relayAnnouncements.ts`, `lib/unreadFeed.ts`, `jobs/tourReminders.ts`: absent from `git diff --name-only`. `api.ts` `GET /conversations/:id` (`:1997`) and `GET /group-members` (`:2021`): outside every hunk. `rosterEdits.ts`: two docblocks, zero code. |
| A soft-deleted contact supplies no name | PARTIAL | Holds on S1 (deleted rows are dropped at `today.ts:744` before `who` is computed), S2 (`participantNames.ts:71` `isDeleted`, and the projection really carries `deleted_at` - `contactsRepo.ts:857`, `:296-302`), and S3 (`rosterResolution.ts:541` `removed`). Does NOT hold on S4 - see F1. |
| Client code unchanged except the `buildToday` guard and the two e2e files | CONFORMS | See the "Out" table row above; exactly three non-`app/` files. |

---

## 5. Spec section 6 test list

| spec test bullet | verdict | evidence |
|---|---|---|
| `participantNames.test.ts` - all 8 named cases | CONFORMS | live wins / stored on miss / stored on empty live name / bare-phone untouched: `:47-50`; phone untouched + no mutation: `:52-58`; deleted contact ignored: `:60-63`; partial map: `:87-91`. 9 tests, run green. |
| Today - renamed renders new; unreadable renders stored; unlinked renders phone; `getById` count unchanged | CONFORMS | `app/test/todayApi.test.ts:1798-1834`, four tests, one per bullet, plus the close-nag case. Run green (`-t "participant names"`, 6 passed). |
| Inbox / contact cards / relay members / calls passthrough - renamed renders; assert UNIQUE ID count | CONFORMS | `inboxGroups.test.ts:471-519`, `contactRelayGroups.test.ts:286-345`, `contactGroupThreads.test.ts:200-227`, `relayApi.test.ts:470-500`, `voiceWebhook.test.ts:954-964`. Every one asserts a `Set` of ids, not a call count. |
| `describeRoster` - contact beats stale; `removed_contact` keeps stored | CONFORMS | `app/test/rosterResolution.test.ts:460-483` covers both in one assertion (`['Tina Person', 'Gone Person']`). |
| Preview pins - recipient names updated; bodies byte-identical to main | PARTIAL / moot | Bodies are byte-identical (zero changes to `rosterEdits.test.ts`). "Recipient names updated" did not apply - see N1. |
| `pushSenderLabel` / `maskedPartyLabel` - contact first; never a full name; persisted label pinned | CONFORMS | `voiceWebhook.test.ts:124-158`, `inboundMessagePush.test.ts:529-556`, `app/test/voiceMasking.test.ts` (run green). |
| Audit - group pass counts a seeded stale roster from BOTH sources | CONFORMS | `app/test/rosterDriftTally.test.ts:6-31` (every member classified exactly once, deleted and dangling separated) and `:34-53` (group_text paging + all three relay partitions, truncation surfaced). Run green. |
| Fixtures - grep `seed/performance.ts` synthetic names, update dependent assertions or say so | CONFORMS in the tree | `git grep "Synthetic tenant\|Synthetic landlord\|Synthetic participant"` returns only the definitions at `app/src/lib/seed/performance.ts:842`, `:857`, `:858`, `:890` - no assertion anywhere depends on them, so nothing needed updating. See N6 for the behavioral side effect. |
| E2E rename scenario, accessibility-first selectors | CONFORMS with a note | `e2e/tests/scenarios/participant-names.spec.ts`; see N5 on selector choice. |

Tests spot-run for this review (all green, from the worktree):
`npx vitest run test/participantNames.test.ts test/rosterDriftTally.test.ts test/contactName.test.ts test/voiceMasking.test.ts` (58 passed);
`npx vitest run test/todayApi.test.ts -t "participant names"` (6 passed);
`npx vitest run test/relayApi.test.ts -t "GET roster"` (5 passed).

---

## 6. Findings

### Should-fix

**F1. S4 is the one place a soft-deleted contact can still supply a name, and the
flip promoted it.** `app/src/routes/webhooks/twilio.ts:311`
(`contactDisplayName(senderContact)`) and `app/src/routes/webhooks/voice.ts:121`
(`contactShortName(contact)`) have no `deleted_at` check, and neither upstream
read filters one out: `findByPhone` deliberately returns deleted contacts
(`app/src/repos/contactsRepo.ts:177`) and `getById` (`voice.ts:987`, `:996`) does
not filter either. On `main` the deleted contact was a LOWER rung for the push
label and absent entirely from `maskedPartyLabel`; after the flip it OUTRANKS the
stored roster name on both. The spec's section 5 S4 text does not require a
deleted check, so this is a violation of the mission's binding-constraint list
rather than of the spec's own prose, and the blast radius is small (a masked
"First L." on a live bridge, a push body prefix for someone who just texted).
Orchestrator adjudicates: either accept it explicitly, or add an `isDeleted`
guard at those two rungs and pin it.

**F2. The spec's mandated audit RUN and recorded numbers are not in the branch.**
Spec lines 156-158 require the group pass be run once at handback against a
seeded lane and the numbers recorded, and are explicit about why (the branch
changes no stored data, so the audit sizes the population the read path now
masks - there is no before/after to recover later). Nothing in the tracked diff
records them: not `docs/issues/group-roster-name-snapshot-never-refreshed.md`,
not the spec, not the code. The work map says this run belongs to the
orchestrator and is pending; flagging it so it is not lost at merge, because the
number is unrecoverable once the lane is gone.

**F3. `today-contact-hydration-fan-out` was left open where the spec said to close
it.** Spec line 191-193: "record the distinct-`getById` count from the S1 test and
close wontfix if small." The recorded count is N = 1
(`docs/issues/today-contact-hydration-fan-out.md:68-72`) - small by any reading -
but the issue keeps `status: open` (`:5`) on the argument that the harness fixture
cannot stand in for the imported dataset and that this issue's own rule names
`npm run perf:pages` as the sanctioned measurement. That reasoning is sound and
the write-up is honest, but it is a deliberate deviation from the spec's
instruction and it hands Cameron a follow-up run rather than a closed issue. The
orchestrator should confirm the deviation is wanted; the spec text would
otherwise have this issue closed today.

### Notes

**N1. No preview pin exercises a divergent stored-vs-contact name, so the S3
recipient path is unpinned at the `rosterEdits` layer.** The spec (line 135-137,
and section 6) anticipated updating `buildOpenPreview` / `buildAddPreview`
recipient expectations. Zero pins moved, and that is correct rather than skipped:
`app/test/rosterEdits.test.ts:180-183` stores `name: 'Alice Adams'` /
`'Bob Brown'` against contacts named exactly the same, so the precedence flip is
invisible there. The flip itself is covered one layer down
(`rosterResolution.test.ts:460-483`). Worth one added preview case with a stale
stored name if the orchestrator wants the seam pinned where the spec expected it.

**N2. The mechanism exports four functions, not the spec's three.**
`resolveRosterNames` (`app/src/lib/participantNames.ts:48`) is an addition; it is
what the row-level call sites (`inbox.ts`, `contacts.ts`, `relayGroups.ts`) need,
since `hydrateConversationRosters` returns whole conversations and those sites
want the map. Harmless and well-documented; recorded only because section 4 named
three.

**N3. The Today close-nag batch is narrower than the spec's row.** The spec
budgeted "1 batch over `listRelayGroups('open')`"; `app/src/routes/today.ts:1001`
filters to due groups with a pool number FIRST and batches over those. Fewer ids
for identical output.

**N4. Two `as string` assertions replaced the old `continue` narrowing.**
`app/src/routes/today.ts:1009-1010`. The `dueGroups` predicate at `:1001-1005`
does guarantee both, but the guarantee is now spatially separated from the
assertion, so a future edit to the predicate silently un-grounds them. Cosmetic;
a typed filter helper would carry the narrowing.

**N5. The e2e leans on `getByText`, not `getByRole`/`getByLabel`.** Spec line 182
asks for accessibility-first selectors;
`e2e/tests/scenarios/participant-names.spec.ts:52` and `:66` use
`page.getByText(...)` (one with a regex on the `With ...` facts line). The Today
row's `who` and the facts line are plain text without a distinguishing role, so
this is defensible, but `.first()` on a bare name match is the loosest assertion
in the file.

**N6. `seed/performance.ts` bakes synthetic roster names against REAL contact
ids, so perf-lane output changes even though no assertion did.**
`app/src/lib/seed/performance.ts:857-858` and `:890` set `name: 'Synthetic
tenant'` / `'Synthetic landlord'` / `` `Synthetic ${contact.type}` `` on
participants whose `contactId` points at seeded contacts with real names. Under
read-time resolution those surfaces now render the CONTACT names. No test breaks
(grep confirms only the definitions exist), but anyone reading a `perf:pages`
render or a demo-lane group title should expect the synthetic labels to have
disappeared.

**N7. A missing or throwing `getDisplaysByIds` degrades silently to zero names.**
By design (`participantNames.ts:55-60` never rejects, one warn), and the builders
found the sharp edge themselves - the fake-repo comments at
`app/test/inboxFeed.test.ts:224-227` and `app/test/inboxUnreadParity.test.ts:245-248`
say a MISSING method would have made those suites go green by resolving zero
names. Both fakes now stub it explicitly. Recorded because the same swallow makes
a future repo regression invisible outside the warn line.

**N8. The audit script re-chunks at 100 although the repo already does.**
`app/scripts/measure-unread-contact-coverage.ts:606-609` slices `idList` into
100s; `batchGetByIds` (`app/src/repos/contactsRepo.ts:821-824`) already de-dupes
and chunks at 100 with retries. Redundant, offline-only, harmless.

**N9. The spec's inbox row undercounts its own call sites.** Section 3 lists
`groupRowFor` at two call sites and `relayRowFor` at two; the unread arm's
ternary (`app/src/routes/inbox.ts:1439-1440`) calls BOTH builders, so there are
five syntactic calls. All five were updated; only the spec's tally was low.

### Additional confirmations (no action)

- ASCII-only rule holds: no added line in `app/`, `dashboard/`, `e2e/` or
  `docs/issues/` contains a non-ASCII byte.
- `docs/issues/INDEX.md` reflects the new and re-stamped issues, so `npm run
  issues` was run (`:135`, `:290`).
- The tracked tree is clean at `8cc3d165`; nothing uncommitted was relied on for
  any verdict above.
