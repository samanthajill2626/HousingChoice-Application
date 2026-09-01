# Reviewer A - SPEC CONFORMANCE (read-only)

Branch `feat/tour-reminder-ladder-phase-b` @`7345dd36`, merge-base `ec32170a`.
Verified against the LIVE tree, not the slice reports. Line numbers are true at
`7345dd36`. Nothing was edited except this file; working tree left clean.

## Verdict summary

| rank | count |
|---|---|
| BLOCKING | 0 |
| MUST-FIX | 2 |
| SHOULD | 4 |
| NOTE | 3 |

The spec is implemented. Every numbered requirement of T1-T15 CONFORMS except
the items listed below, none of which is a behaviour defect: both MUST-FIX items
are coverage/comment drift left by the slice ordering (T7 wrote comments that T9
then falsified) and one spec-enumerated e2e that was never written.

---

## 1. Work map verdicts

| task | spec | verdict | key evidence |
|---|---|---|---|
| T1 single-pass interpolate | 11 | CONFORMS | `app/src/messages/resolve.ts:42` - one `template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, cb)` over the ORIGINAL template; replacement is a CALLBACK (`:42-52`), so `$&`/`$1` in a VALUE are inert. Three preserved behaviours intact: undeclared -> literal (`:43`), strict throw vs override empty (`:45-50`), declared-but-absent needs no value (regex only visits present tokens). Structural charset guard over `MESSAGE_CATALOG` at `app/test/messages/resolve.test.ts` ("every declared var of every entry matches the interpolate token charset"). |
| T2 three tokens x six sites | 4.3, 7.2 | CONFORMS | see section 2 |
| T3 predicate + gate + refusal | 4.2, 6.1a | CONFORMS | see section 3 |
| T4 sweep + RUNBOOK | 4 | CONFORMS | see section 5 |
| T5 unit vehicle | 10 | CONFORMS | `tourRemindersRepo.create({dueAt: now0})` rides everywhere; `app/test/tourReminders.test.ts` converted sites are green in the full suite (6387). |
| T6 e2e vehicle + audit | 10 | CONFORMS | `justAfter(await flow.armedReminderDueAt('day_before'))` at `e2e/tests/scenarios/tours.spec.ts:154,207,251,290,326`; `e2e/tests/scenarios/scheduled-visibility.spec.ts:172,238,275`. R12 filter at `e2e/scenarios/steps.ts:3623`. |
| T7 DISCONTINUED + unpause | 3.1, 5 | CONFORMS (see MUST-FIX 1 for a stale comment) | `app/src/jobs/tourReminders.ts:121` (MANUAL_ONLY empty), `:156` (DISCONTINUED holds `confirmation`), `:283-285` (poll filter), `:1603-1608` (force-send refusal), `app/src/routes/dev.ts:405-412` (divergence deleted). |
| T8 discontinued read surfaces | 3.1, 3.1a + R3 | CONFORMS | see section 4 |
| T9 confirmation stops arming | 5, 10a | CONFORMS | `app/src/jobs/tourReminders.ts:183` `REMINDER_KINDS = ['day_before','morning_of','en_route']`; catalog entries `tour.confirmation` / `tour.confirmation_no_address` KEPT (`app/src/messages/catalog.ts:34-35` union, entries below); `LADDER_ORDER` keeps `confirmation` (`:61-62`); `computeDueAt` case kept. |
| T10 en_route exempt x3 + widening | 6, 6.2 | CONFORMS | see section 6 |
| T11 names bound, both sites | 7 | CONFORMS | `app/src/jobs/tourReminders.ts:1229-1235` (1:1) and `:1413-1419` (GROUP), both `rosterWaitExpired(row.dueAt, now)` = `ROSTER_UNAVAILABLE_GRACE_MS` (1h, `app/src/lib/rosterResolution.ts:103`). Force-send unchanged - `:1718` still `refuse('names_unavailable')`. |
| T12 overdue on BOTH builders + chip | 8 | CONFORMS | `app/src/routes/tourReminders.ts:349-350` (`viewOf`, own `nowIso`), `:604` + `:646` (list projection, own `listNowIso`); union NOT widened; chip `dashboard/src/routes/tours/RemindersPanel.tsx:129-131`. |
| T13 relay catalog | 9.1, 9.2, 9.2a | CONFORMS | see section 7 |
| T14 resolver + split | 9.0-9.6 | CONFORMS | see section 8 |
| T15 docs closure | 12, 15 | CONFORMS | see section 9 |

---

## 2. Every "N sites" claim, counted in the live tree

### Three tokens x SIX sites (spec 4.3)

| site | `tour_already_passed` | `kind_retired` | `names_unavailable` |
|---|---|---|---|
| 1 `ReminderSkipReason` | `app/src/repos/tourRemindersRepo.ts:82` | `:87` | `:92` |
| 2 dashboard wire union | `dashboard/src/api/types.ts:1240` | `:1243` | `:1246` |
| 3 `REMINDER_SKIP_REASON_LABELS` | `:1314` | `:1315` | `:1316` |
| 4 `SKIP_REASONS` test | `dashboard/src/api/types.test.ts:109` | `:110` | `:111` |
| 5 `ForceSendRefusal` | `app/src/jobs/tourReminders.ts:1541` | `:1544` | `:1538` (pre-existing) |
| 6 `SEND_NOW_ERROR_COPY` | `dashboard/src/api/types.ts:1366` | `:1367` | generic fallback KEPT (R13 honoured - no key added) |

Labels are byte-exact against the spec 4.3 table: `the tour had already happened`
/ `this reminder is no longer sent` / `couldn't look up the names`.

Site 6's missing completeness test is BUILT as spec 4.3 requires:
`dashboard/src/api/types.test.ts:136-148` (`PERMANENT_REFUSALS` asserted not to
fall through to the generic retry sentence), plus a new
`SUPPRESSION_REASONS` completeness list at `:153-161`.

### The other counts

- **`en_route` exempt at THREE sites** (spec 6 + the P5 addendum): arm-time
  `app/src/jobs/tourReminders.ts:203`; fire-time `:1096`; panel estimate
  `app/src/routes/tourReminders.ts:590-593` threaded from `:637`. Plus the
  addendum's mirrored tour surface: `app/src/routes/contactTimeline.ts:875` +
  `:1036`. `clampOutOfQuietHours` itself untouched; `placementNudges.ts`
  untouched. `app/test/seedLive.test.ts:83` mirrors the exemption (R14).
- **Names bound at TWO sites** - `:1229` and `:1413`. CONFORMS.
- **Overdue on TWO builders** - `routes/tourReminders.ts:350` and `:646`.
  CONFORMS. Excluded surfaces (`contactTimeline`, `relayGroups`) carry no
  `overdue`, as spec 8.2 requires.
- **DISCONTINUED read at FOUR (+1) surfaces** - poll `jobs/tourReminders.ts:284`;
  `forceSendReminder` `:1603`; tour panel `routes/tourReminders.ts:630`;
  contact timeline `routes/contactTimeline.ts:1030`; R3's fifth,
  `routes/relayGroups.ts:342-344`. CONFORMS.
- **`{where}` declared LAST in every new entry** - `catalog.ts:355`, `:366`,
  `:386`. CONFORMS.
- **`MessageId` union has the four new ids** - `catalog.ts:51,53,55,61`.
  CONFORMS.

---

## 3. Precedence claims

| claim | verdict | evidence |
|---|---|---|
| past-tour gate FIRST in `processReminderRow` | CONFORMS | `app/src/jobs/tourReminders.ts:1029` sits above `supersededInBatch` (`:1057`), `isQuietTime` (`:1096`), `beforeStart` (`:1135`), roster (`:1155`), names (`:1229`). The tour read is a HOIST (`:1015`), threaded into `resolveReminderTarget(row, deps, log, tour)` at `:1099`. |
| force-send `kind_retired` > `tour_already_passed` > `names_unavailable` | CONFORMS with one structural caveat (NOTE 1) | `kind_retired` `:1603` (inline return, pre-read, R4 honoured - `refuse` not hoisted); `tour_already_passed` `:1663`; compose-time `names_unavailable` `:1718`. |
| discontinued evaluated OUTSIDE `suppressionOf` on both tour surfaces | CONFORMS | `routes/tourReminders.ts:634-636` is a branch AHEAD of the `suppressionOf !== undefined` test, not an argument to it; `routes/contactTimeline.ts:1030-1031` short-circuits ahead of `suppressionFor`. `scheduledSendSuppression.ts:1-8` records that the evaluator deliberately never PRODUCES `discontinued`. |
| widened predicate's `undefined` guard polarity | CONFORMS | `jobs/tourReminders.ts:222`: `otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso` - exactly spec 6.2's wording. `LADDER_ORDER` docblock rewritten at `:38-60` and now states WHY it is an inequality. |
| R15 chip order (discontinued > overdue > paused) | CONFORMS | `RemindersPanel.tsx:116` (discontinued), `:129` (overdue), `:135`ff (paused); pinned by `RemindersPanel.test.tsx` ("a discontinued rung that is ALSO overdue still reads No longer sent"). |
| R2 discontinued outranks `contact_opted_out` | CONFORMS | tests on both tour surfaces ("OUTRANKS an opted-out contact"). |

---

## 4. Read surfaces + the excluded placement card

- `routes/tourReminders.ts:630-644` - discontinued chip, ahead of everything.
- `routes/contactTimeline.ts:1030-1036` - its OWN read of the set (spec 3.1's
  "fourth row").
- `routes/relayGroups.ts:342-344` - R3's fifth surface, ONLY the discontinued
  suppression added, no other evaluation. CONFORMS to the ruling exactly.
- Union widened once (`services/scheduledSendSuppression.ts:9-11`), mirrored on
  the wire (`dashboard/src/api/types.ts:1157`), and the three exhaustive Records
  each got the entry: `types.ts:1297`, `ScheduledCard.tsx:33`,
  `DeadlinesNudgesCard.tsx:73`.

---

## 5. The sweep (spec 4.4)

| requirement | verdict | evidence |
|---|---|---|
| pure planner returning the 3-value union | CONFORMS | `app/scripts/retire-paused-tour-reminders.ts:65-76` |
| uses the SHARED predicate | CONFORMS | `:73` calls `retiredByTourStart` imported from `jobs/tourReminders.js` (`:46`) - the identical function the fire-time gate uses. |
| population A before B; a row in both takes A | CONFORMS | `:73` before `:74`; test `retirePausedTourReminders.test.ts:48`. |
| terminal rows never touched (idempotency) | CONFORMS | `:70-72`, test `:71`. |
| conditional writes | CONFORMS | `:139-141` - `attribute_exists(reminderId) AND attribute_not_exists(sentAt/canceledAt/skippedAt)`; `ConditionalCheckFailedException` counted, not swallowed (`:183-190`); test `:259`. |
| `--dry-run` writes nothing | CONFORMS | `:174-178` returns before `retire()`; test `:192`. |
| PII-safe logging | CONFORMS | only `reminderId`, `tourId`, `action`, counts (`:186-189`, `:203-209`). |
| `DYNAMODB_ENDPOINT` + `lib/config.tableName`, no local guard | CONFORMS | `:101-103`. |
| RUNBOOK entry stating the order | CONFORMS | `RUNBOOK.md:287-306`; states dry-run-first, per-environment, dev-before-prod, "SWEEP FIRST is the PREFERENCE, not a deadline" with the reason (both runtime guards), the between-states chip degradation, and "No agent runs this against dev or prod." |

Spec 4.2's knowing reversal (operator-restored past-tour rungs are swept) is
pinned: `retirePausedTourReminders.test.ts:79`.

---

## 6. `en_route` + supersession

- Arm-time: `jobs/tourReminders.ts:203` `kind === 'en_route' ? raw : clamp(...)`.
- Fire-time: `:1096` `row.kind !== 'en_route' && isQuietTime(...)`.
- Panel estimate: `routes/tourReminders.ts:637` passes `row.kind === 'en_route'`
  as `quietExempt`; `:590-593` forces the QUIET operand ONLY - opt-out, kill
  switch and manual mode still ride the shared evaluator. Same shape on the
  timeline (`contactTimeline.ts:875`), and `quietFor`/`suppressionFor` stay
  kind-blind so the placement walk is unaffected.
- Widening + its regression pair both exist:
  `tourReminders.test.ts` "REGRESSION (the 08:30 double-send)" and
  "widened predicate is a NO-OP on an unclamped ladder".
- `supersededInBatch` left ALONE, as spec 6.2 directs.

---

## 7. Founder copy - byte-exact diff against spec 9.1 / 9.2 / 9.4

Every fenced block compared character by character against the joined string
literal.

| entry | spec block | catalog | verdict |
|---|---|---|---|
| `relay.intro_tour_today` | 9.1 today form | `catalog.ts:348-351` | BYTE-EXACT |
| `relay.intro_tour` | 9.1 dated form ("on {when}") | `:359-362` | BYTE-EXACT - "on {when}", not "at" |
| `relay.intro_placement` | 9.1 | `:377-382` | BYTE-EXACT |
| `relay.intro` (naked) | 9.2 | `:304-307` | BYTE-EXACT |
| `relay.member_added_role` | 9.4 role form | `:451` | BYTE-EXACT |
| `relay.member_added` | 9.4 no-role form | `:420` | BYTE-EXACT |

Metadata against the 9.2a table (id / vars in order / class / channel /
editable): all six rows CONFORM, `{where}` last in each, `editable:false`
throughout, `catalog.test.ts` "the Phase B relay entries declare exactly the spec
9.2a vars, with {where} LAST" pins it.

`{names}` totality table (9.2) - `composeNameList` at
`app/src/jobs/relayFanOut.ts:216-229`: named -> Oxford first-name list; no names
& 2+ others -> `N other people`; no names & 1 other -> `1 other person`; no
names & 0 others -> `1 other person`. All four rows CONFORM. Never empty, never
a phone.

Byte-identity to the pre-change body VERIFIED independently against
`ec32170a:app/src/jobs/relayFanOut.ts` `composeConnectionSentence` - the old
sentence was `You're now connected with <list> on this number. Reply here and
everyone in the group sees it.`, which the new template reproduces exactly.
Pinned by three cases in `relayFanOut.test.ts`, including the ONE deliberate
change (zero-others).

`{name}` totality (9.4): `joinedName` `:243-245` -> first name else
`a new member`, lower-cased. `ANONYMOUS_JOINED_LABEL` DELETED (R3-13);
`composeConnectionSentence` and `composeMemberAddedBody` have zero remaining
references anywhere in `app/`, `e2e/`, `dashboard/`; the four prose mentions were
re-pointed (`groupTitle.ts:60`, `relayGroupDuplicates.ts:11`, and both test
twins).

---

## 8. Resolver, the split, and preview parity

- Keyed on the OWNER, not the conversation:
  `resolveRelayComposeInputs(owner, deps, addedContactId?)`
  (`relayFanOut.ts:349`). CONFORMS to 9.3's uncallable-from-`buildOpenPreview`
  argument.
- Three intro variants + precedence: operator-edited `intro_body` FIRST and
  verbatim (`relayFanOut.ts:963-972`, the four owner reads not even made), then
  tour/placement/naked (`composeIntroBody:472-506`).
- Never throws: per-read try/catch at `:361-380`, `:383-387`, `:399-411`,
  `:431-440`, `:442-455`, plus repo-CONSTRUCTION containment at `:631-643`.
  Every failure lands on `variant:'naked'` (9.5). The tenant-name exception
  degrades in-sentence (`'there'`, `:476`).
- Role table (9.4): `resolveMemberRole:303-321` - `pm`->`property manager`,
  `landlord|owner`->`landlord`, owning tenant->`tenant` (checked FIRST), anything
  else->no role->the no-role entry. Source is `UnitContact.role`. CONFORMS.
  Role resolves even when the intro degrades (`:391`, pinned by a test).
- `member_added` split + ONE persisted row: handler `:1043-1067` - `groupBody`
  to everyone, `newMemberBody` (naked intro, post-add roster) to the joiner,
  `body: newMemberBody` persisted, `bodyFor` selecting per member key.
  `addedMemberKey` correctly resolved to a `contactId` via the roster
  (`:1029-1034`).
- `sendRelayAnnouncement` default byte-identical: `relayAnnouncements.ts:279`
  `input.bodyFor?.(member) ?? body`; persistence, delivery slots and
  `touchLastActivity` (`:235-239`) all keep `body`. Pinned three ways in
  `relayAnnouncements.test.ts`, including `persist:false` legs-only.

### Preview parity, all five production call sites

| call site | wiring | pin |
|---|---|---|
| `routes/tours.ts:526-534` -> `buildOpenPreview` | `tours` + `settings` wired | `toursApi.test.ts` preview-open asserts resolved tour copy AND equality with the resolver, through the REAL route |
| `routes/tours.ts` -> `buildAddPreview` | same deps | `toursApi.test.ts` preview-add == `Hey, adding Casey to the group.`; the PM case pins the role clause |
| `routes/placements.ts:929-934` -> `buildOpenPreview` | `tours`+`placements`+`settings` | `placementsApi.test.ts` asserts `Excited to have you move into 52 Edgewood Ave.` + equality |
| `routes/placements.ts` -> `buildAddPreview` | same | `placementsApi.test.ts` group body pinned |
| `routes/relayGroups.ts` standalone | no owner -> `buildOpenPreviewFromParts` with no `inputs` -> `{variant:'naked'}` | `relayGroupPreview.test.ts:157,214` re-verify UNCHANGED |

R11 honoured: `RosterResolutionDeps.tours/placements/settings` are OPTIONAL
(`lib/rosterResolution.ts:155-157`), absence degrades to naked.
`buildAddPreview`'s docblock amended per 9.0 (`services/rosterEdits.ts:689-703`).

---

## 9. Docs, hygiene, rulings

- Ledger `docs/issues/tour-reminder-ladder-phase-b.md` -> `status: resolved`,
  `resolved: 2026-08-31`, with all NINE rows and their dispositions matching
  spec 12 (incl. item 8 DROPPED-not-filed and item 9 RE-DEFERRED).
- `founder-handback-items.md` carries spec s15 items 1-5 VERBATIM (compared
  line by line) plus three build-found items. CONFORMS.
- `TODO(tour-reminder-ladder-phase-b)` gone from the whole repo; re-pointed at
  `tour-copy-where-token-declared-not-passed` (`app/src/messages/tourCopy.ts:172`),
  and that issue file exists.
- R3's issue-body addition landed in
  `docs/issues/placement-nudge-overdue-invisible-on-card.md` naming BOTH excluded
  surfaces and stating that the spec's claim they were already named was false.
- `message-interpolate-token-reexpansion` closed with a resolution block.
- ASCII: zero non-ASCII characters on any ADDED line across the whole branch
  (`git diff ec32170a...HEAD | grep '^+' | LC_ALL=C grep '[^ -~\t]'` -> empty).
- Committed paths: only `docs/superpowers/**`. No `.superpowers/` and no
  `INDEX.md`. CONFORMS.

**Rulings R1-R15: all fifteen implemented as ruled.** None contradicts the spec.
R1 (`beforeStart` kept, test flipped and renamed - "AT/AFTER tour start the wait
is MOOT"), R4 (inline return, `refuse` not hoisted), R5 (tour
`NO_MANUAL_HOLD_BACK` wrappers deleted; only the PLACEMENT ladder's remain, which
is correct), R6 (matrix confirmation row KEPT, comments rewritten), R7 (g3/g3b
retargeted to a LIVE kind with the derivation recorded at
`tourReminders.test.ts:4183-4187`), R8, R9, R10, R12 (as a regexp, see SHOULD 3),
R13, R14, R15 all verified in the tree.

---

## Findings

### MUST-FIX

**M1. `devGating.test.ts` asserts a `confirmation` row that no longer exists, and
the discontinued-guard coverage it claims is vacuous.**
`app/test/devGating.test.ts:520-522`, `:557-561`, `:596-600`.

Three comments state that the ladder "still ARMS a confirmation rung (dueAt =
FIXED_NOW)" and that the first tick is a no-op because "that kind is
discontinued" / "discontinued kinds are filtered out of the poll's due rows".
`armTourViaRoute` (`:523-551`) arms ONLY through `POST /api/tours`, and
`REMINDER_KINDS` (`app/src/jobs/tourReminders.ts:183`) no longer contains
`confirmation`, so no confirmation row exists in that world at all. Nothing is
due at `FIXED_NOW`, so `expect(world.sent).toHaveLength(0)` (`:565`) proves
nothing about `DISCONTINUED_REMINDER_KINDS` - contradicting the comment's own
claim that this is "exactly what makes this assertion meaningful". The comments
were TRUE when slice 4 (T7) wrote them and were falsified by slice 5 (T9,
`ab0459af`), which did not revisit the file. Fix: re-derive the three comments
(the tick is a no-op because nothing is due), and either drop the
discontinued-guard claim or seed a confirmation row directly via
`world.tourRemindersRepo.create` to make it real. The poll-exclusion behaviour
itself IS covered elsewhere (`tourReminders.test.ts` "the poll EXCLUDES a due
discontinued row").

**M2. Spec 14's PLACEMENT relay intro e2e does not exist.**
`e2e/tests/relay-intro-variants.spec.ts:163-253`.

Spec 14 E2E: "A tour relay intro **and a placement relay intro** landing in every
member's fake thread with resolved names, AND the operator PREVIEW showing the
same variant." The only e2e walk is the TOUR one; there is no placement-owned
relay open anywhere in `e2e/`. Mitigation, which is why this is not BLOCKING: the
placement variant is pinned at API level through the REAL route
(`app/test/placementsApi.test.ts` preview-open asserting `Excited to have you
move into 52 Edgewood Ave.` plus resolver equality) and at unit level
(`relayFanOut.test.ts` "a placement owner resolves the placement variant"). What
is missing is the end-to-end leg-arrival half.

### SHOULD

**S3. `expectRungsRetiredPastTour`'s docblock rationale is now false.**
`e2e/scenarios/steps.ts:2085-2087` says `expectReminderRung(k,'upcoming')`
"cannot tell a pending rung from a Skipped one and would pass either way here".
R12's own change (`:3623`, `.filter({ hasNotText: /Skipped/ })`) made that false
in the same branch. The helper is still worth having (it asserts `skipReason`),
but the stated reason is wrong and is exactly the kind of line a later reader
acts on.

**S4. A converted clock-travel tick causes a retirement that is documented but
not asserted.** `e2e/tests/scenarios/tours.spec.ts:261-264`. Spec 10 requires
"the converted specs ASSERT the retirement rather than being surprised by it",
and spec 14 repeats it ("each asserting the same-tour retirements a clock-travel
tick causes"). The self-guided walk's `tickTourReminders(justAfter(times.enRoute))`
sweeps the still-pending `morning_of` into the batch, where release supersession
retires it - the comment says so, but nothing asserts it. (The other converted
sites tick the EARLIEST live rung and genuinely cause no retirement, so they are
correctly silent; the no-show site does assert, via `expectRungsRetiredPastTour`.)
One `expectRungsRetiredPastTour`-style read closes it.

**S5. `retiredByTourStart` canonicalizes `scheduledAt` but not `row.dueAt`.**
`app/src/jobs/tourReminders.ts:172-185`. The docblock explains why `start` is
normalized (`'...T15:00:00Z'` sorting before `'...T14:00:00.000Z'`), but the
left operand of `row.dueAt < startIso` gets no such treatment. Every row
`computeDueAt` writes is canonical, so this is unreachable through the product;
it is reachable for a hand-seeded or imported row, and the sweep scans the whole
table. Cheap hardening: compare `Date.parse(row.dueAt)` against `start`.

**S6. `DeadlinesNudgesCard` gained more than spec 3.1a sanctioned.**
`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:103-109`. Spec 3.1a
narrows the section-13 exclusion to "the ONE label entry the placement card needs
to compile". The label entry (`:73`) is that entry; the added `StateChip` branch
is not needed to compile (it is an equality test, not an exhaustive Record) and
is a small, self-declared widening onto an EXCLUDED surface. It is defensible and
documented in place; flagging it so the human rules rather than discovering it.
Same class: `ScheduledCard.tsx:125-129` adds `discontinued` to the muted-tone
fork, which the plan did not ask for (slice 4 self-reports it as a one-line
revert).

### NOTE

**N7. Force-send refusal ordering has one structurally unavoidable inversion.**
`app/src/jobs/tourReminders.ts:1639` returns `names_unavailable` for a THROWN
target-resolution read, before the `tour_already_passed` gate at `:1663`. That
gate needs `target.tour.scheduledAt`, which does not exist when resolution
threw, so the order cannot be otherwise. The spec's stated precedence holds
everywhere it can: `kind_retired` is first (`:1603`, pre-read) and the
compose-time `names_unavailable` (`:1718`) is correctly last. Recorded because
the brief asked the ordering be checked, not because anything should change.

**N8. `interpolate`'s regex charset is narrower than the old
`split/join`.** `resolve.ts:42` only matches `[A-Za-z][A-Za-z0-9_]*`, so a var
outside that charset would silently never substitute where it previously would.
Spec 11 does not require the old charset and the structural
`MESSAGE_CATALOG` test closes the hole; noted only so the constraint is visible.
`catalog.test.ts:23`'s broader `\w` `tokensIn` is left alone per the worklist.

**N9. Sub-threshold, already in the worklist's own handback list:**
`routes/contactTimeline.ts` still does not project `skipReason`, so a
`tour_already_passed` retirement simply leaves the Upcoming bucket. Consistent
with that bucket's contract and out of this spec's scope.
