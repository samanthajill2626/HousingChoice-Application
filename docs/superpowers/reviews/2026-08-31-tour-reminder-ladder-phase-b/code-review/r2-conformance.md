# Reviewer A - SPEC CONFORMANCE, ROUND 2 (read-only)

Branch `feat/tour-reminder-ladder-phase-b` @`9b6d972c`. Reviewed: fix wave 1
(`8956118c` code + `adf4feeb` docs) and the mainline sync (`9b6d972c`,
`docs/issues/_CLUSTERS.md` only - no code, nothing to re-verify).

No Playwright run, no suites started. Nothing edited but this file.

| rank | count |
|---|---|
| BLOCKING | 1 |
| MUST-FIX | 1 |
| SHOULD | 4 |
| NOTE | 3 |

R1 closure: **5 of 6 closed**; A-M2 is NOT closed and is this round's BLOCKING
item.

---

## 1. What round 1 missed (across the changed state)

Charge order says this first. Three findings, none of which either reviewer
raised in round 1.

**R2-S2 (SHOULD) - the sweep's population B is the ONE enforcement that did NOT
get the shared-source treatment.** `app/scripts/retire-paused-tour-reminders.ts:78`
hardcodes `if (row.kind === 'confirmation') return 'kind_retired'` while
importing only `retiredByTourStart` (`:50`). Population A was deliberately given
the shared predicate because spec 4.2 rules that "if they disagree about a row,
one of them is wrong" - and the whole Phase B architecture then says a kind that
must never send belongs in `DISCONTINUED_REMINDER_KINDS`
(`app/src/jobs/tourReminders.ts:156`), whose own docblock enumerates five
mandatory readers and warns "if you add a sixth surface... it reads this set
too". The sweep is the ONE writer of `kind_retired`
(`tourRemindersRepo.ts:87`), and it is not one of those readers. Discontinue a
second kind and every runtime surface refuses it while the sweep silently leaves
its rows pending forever - the exact panel-hygiene hole population B exists to
close. Spec 4.2's text does say "every pending `confirmation`", so this
CONFORMS today; the finding is the latent divergence, and the fix is one import
plus `DISCONTINUED_REMINDER_KINDS.has(row.kind)`.

**R2-S3 (SHOULD) - `hasUpcoming` is the second `'upcoming'` equality predicate
spec 8.1 names, and only the first got the discontinued treatment.**
B-MF2 correctly excluded a discontinued rung from the `next` pick
(`app/src/routes/tourReminders.ts:677`). `hasUpcoming`
(`app/src/routes/tourReminders.ts:513`) still counts one, and it gates the whole
suppression-estimate block at `:522`. On a self_guided tour whose ONLY upcoming
rung is a pause-era `confirmation`, the route still resolves tenant suppression -
a contact read and a conversation read per GET - for an answer the discontinued
short-circuit at `:634` then discards. No correctness impact (it cannot produce a
wrong chip), so this is waste, not a defect; recorded because spec 8.1 names the
two predicates together and a later reader will expect them to agree.

**R2-N3 - independent confirmation of the gate-5 attribution.** The fix wave
reports one eslint error, `app/src/repos/tourRemindersRepo.ts:14 'GetCommand' is
defined but never used`, as pre-existing. VERIFIED independently against the
merge base: `git show ec32170a:app/src/repos/tourRemindersRepo.ts` contains
`GetCommand` exactly once, on the import line, with zero uses - identical to HEAD.
So this is NOT AGENTS.md's deleted-last-use trap; it is genuinely inherited, and
the branch's touched lines in that file (`:78-92` union members, `:166-179`
docblock) are clean. It must still be NAMED in the handback, which the fix-wave
report does.

---

## 2. The fix diff, reviewed cold

### BLOCKING

**R2-B1. The new placement e2e cannot pass: it reads a `phone` the roster route
never serves.** `e2e/tests/relay-intro-variants.spec.ts:178-183`, used at `:359-362`.

```
const { members } = (await res.json()) as { members: { phone?: string }[] };
return members.map((m) => m.phone).filter(...)
```

`GET /api/placements/:placementId/roster` (`app/src/routes/placements.ts:889`)
answers `describeRoster` -> `RosterView`, whose rows are `RosterMemberView`
(`app/src/lib/rosterResolution.ts:341-353`). That shape carries **`phoneLast4`,
never `phone`**, for a contact-backed member - the route's own comment at
`app/src/routes/placements.ts:886-888` says so ("the RESPONSE carries names +
phone last4 to the authed client... the full phone never leaves the server"), and
`RosterMemberView`'s docblock at `:334-339` states the rule: only a BARE-PHONE row
exposes digits, via `memberKey`. Both members of this walk (the fresh tenant and
the fresh landlord) are contact-backed.

So `rosterPhones` returns `[]`, and `:360`
`expect(phones.sort()).toEqual([owner.phone, tenant.phone].sort())` fails. The
`for` loop at `:361-363` then has nothing to iterate, so the leg-arrival
assertions - the entire point of A-M2 - never run.

The `as { members: { phone?: string }[] }` cast is why `cd e2e && npx tsc
--noEmit` passed at exit 0: the cast asserts a shape the wire does not have, and
there is no precedent anywhere in `e2e/` for reading phones off a roster route
(`grep` over `e2e/` finds none) - which the fix-wave report itself flags as
worry 4 without identifying the cause.

Mitigation: it fails LOUDLY at `:360`, before the empty loop can prove nothing.
No false green. But `npm run e2e` is a required completion gate and this walk
will be red, so A-M2 is not closed.

Fix, preserving the intent ("the server's own answer, not a list the spec
assembled"): assert over `memberKey`/`contactId` from the roster route (the two
contactIds this walk minted), or compare `phoneLast4` against
`phone.slice(-4)`, and drive `expectExactSentFromPool` off the two known phones.

### MUST-FIX

**R2-M1. The sweep's new per-row isolation traded a loud systemic failure for a
silent one: `failed > 0` still exits 0 and still logs "done" at INFO.**
`app/scripts/retire-paused-tour-reminders.ts:210-249` (per-row catch) and
`:257-270` (the CLI).

Before this wave, any non-conditional row error escaped the paging loop and hit
the top-level `.catch` -> `process.exitCode = 1`. Now every such error is counted
`failed` and stepped over. For the ruled case - one malformed row - that is
exactly right. For a SYSTEMIC one (credentials rotated mid-run, a sustained
throttling episode, a table misconfiguration) every row now fails, and the CLI's
success path at `:259-263` logs `retire-paused-tour-reminders - done` at
`logger.info` and exits **0**. An operator reading an exit code, or skimming for
an error line, sees a clean run that wrote nothing.

RUNBOOK step 2 (`RUNBOOK.md:297`) names `failed` but pulls in the wrong
direction for this case: "a non-zero `failed` is worth investigating before the
apply, **not a reason to stop**". True of one row; false of nine hundred.

The PARTIAL-report wrapper (`:113-127`) does not cover it either - with the
per-row catch swallowing row-level errors, the only things that can still reach
that wrapper are the `Scan` itself and `tableName()`, so the new abort path is
much narrower than the fix-wave report's framing suggests. Neither comment
acknowledges the interaction.

One line: log the success report at `warn` (or set `process.exitCode = 1`) when
`result.failed > 0`. Orchestrator's call which - `exitCode = 1` would also fire
on a dry run over a single corrupt row, which the RUNBOOK deliberately says is
not a stop.

### What is clean in the fix diff

Reviewed cold, and these hold:

| item | verdict | evidence |
|---|---|---|
| **Founder copy still byte-exact** | INTACT | `app/src/messages/catalog.ts` is NOT in the fix-wave diffstat; all six entries unchanged since the R1 byte-compare. |
| **Precedence claims still hold** | INTACT | Past-tour gate still first (`jobs/tourReminders.ts:1029` above `:1057/:1096/:1135/:1155/:1229`); force-send `kind_retired` (`:1603`) before `tour_already_passed` (`:1663`); discontinued still OUTSIDE `suppressionOf` (`routes/tourReminders.ts:634`). The `next` change is a selection filter, not a precedence reorder. |
| **B-MF2 `next`** | CORRECT | `routes/tourReminders.ts:677` filters after the dueAt sort at `:668`. The new `next === undefined` state is safe on the client: `RemindersPanel.tsx:210` reads `page.next?.reminderId` into `nextId` and `:344` compares by id, so no "Next" tag renders and nothing throws. |
| **B-S1/B-S2 client gating** | CORRECT | Button gated at `RemindersPanel.tsx:390`; `nextReminderRefetchDelay` skips at `:79`. The widened parameter type is honest - `nextReminderRefetchDelay` really is imported by `dashboard/src/routes/placements/usePlacementNudges.ts:21` and called at `:109`. |
| **Send-now refusal reaches the client** | CORRECT | `routes/tourReminders.ts:482-487` maps `result.reason` generically to a 409 body, so `kind_retired` / `tour_already_passed` cannot fall through to a 500 - a path R1 did not verify. |
| **B-N1 raced remove** | CORRECT | `relayFanOut.ts:1081` `body: added !== undefined ? newMemberBody : groupBody`; with `added` undefined `bodyFor` matches nobody, so the row equals every leg. |
| **B-N4 held-back counters** | CORRECT | `jobs/tourReminders.ts:733-745`; the two counters now partition `heldBack` exactly (`|manualOnly \ disc| + |disc| = |manualOnly union disc|`). |
| **A-S4 assertion is sound** | CORRECT | At `justAfter(times.enRoute)`, `now < scheduledAt`, so the past-tour gate does not pre-empt supersession and `quiet_hours_superseded` really is the token; `morning_of` is genuinely still pending (the day_before tick at 19:30 D-1 predates morning_of at 10:00 D, and lean-seed quiet hours are OFF so no arm-time clamp collapsed the ladder). |
| **A-M2 supporting refactor** | CORRECT | `driveConnectingGroupToOpen` really returns `RelayConversation` with `pool_number: string` (`e2e/fixtures/relayConnect.ts:134-137`), `FakeThreadMessage.from` really exists (`e2e/fixtures/fakeTwilio.ts:106`), `POST /api/placements` accepts `{tenantId, unitId}` with a defaulted stage (`routes/placements.ts:227-248`) and answers `{placement}` at `:636`, `POST /:placementId/relay` answers `201 {conversation}` carrying `pool_number` (`:1559`), and the default roster really is tenant + landlord-of-record (`rosterResolution.ts:271-301`). Only the phone read (R2-B1) is wrong. |
| **Test honesty (red-first)** | VERIFIED REAL | Every claimed red is in the logs with the RIGHT failure: `fixwave-red-1.log` - `expected 'tour_today' to be 'naked'` (B-MF1), `expected 'rem-disc-next' to be 'rem-live-next'` (B-MF2), `expected "Hey, it's Sam..." to be 'Hey, adding a new member to the group.'` (B-N1), and a raw `ValidationException: The number of conditions on the keys is invalid` escaping the loop (B-S5). `fixwave-red-2.log` - `expected true to be false` (A-S5), `expected 2 to be +0` (B-N4). `fixwave-red-3.log` - `expected document not to contain element, found <button` (B-S1), `expected 20000 to be null` and `expected 20000 to be 32000` (B-S2). Gates re-run and logged: app 6395/347 exit 0, dashboard 2871/183 exit 0, typecheck 0, smoke 0. |

---

## 3. Adjudications challenged

**A-S6's split - I AGREE with the ruling, and flag an inconsistency inside the
same wave.** The revert is right: `DeadlinesNudgesCard.tsx:103-110` now carries
only the sanctioned LABEL entry (`:73`) plus a comment saying why, which is
exactly spec 3.1a's narrowed exclusion, and `ScheduledCard.tsx:125-129` keeps the
muted tone on a surface that genuinely renders the timeline's discontinued read.
Two things to record rather than change:

- With the chip branch gone, a (hypothetical) discontinued nudge would chip a
  fire time while the note under it read "No longer sent - turned off" - a card
  arguing with itself. Unreachable today, which is the ruling's whole basis, and
  the comment at `:103-110` tells the next person to add the branch WITH the
  writer. Consistent; just noting B-N2's "MOOT" leaves that shape latent.
- **R2-S4 (SHOULD): the same wave added unreachable-on-placements behaviour
  through the back door.** B-S2's fix puts `if (r.suppression?.reason ===
  'discontinued') continue` into `nextReminderRefetchDelay`
  (`RemindersPanel.tsx:79`), which `usePlacementNudges.ts:109` calls with
  placement nudges - a branch no placement writer can reach, on the excluded
  surface, added in the same commit that reverted one for being exactly that. It
  is defensible (the function lives on the tour panel, tours need it, and the
  cost is one comparison), and I am not asking for a revert - but the two rulings
  should be reconciled in the record so the principle stays legible.

**B-MF1's strictly-before boundary - R2-S1 (SHOULD), and I would change it.**
`relayFanOut.ts:390` uses `startedAt < Date.parse(nowIso)`, so at `now ===
scheduledAt` the tour variant still composes and the tenant AND the landlord
receive "Please let us know when you're on the way." The comment at `:375-386`
justifies it as "at the start instant the tour is beginning, not past, and the
copy still reads correctly" - while claiming kinship with the ladder gate ("the
same staleness class the ladder's fire-time gate (`retiredByTourStart`) exists
for"). Those two halves contradict each other: `retiredByTourStart`
(`jobs/tourReminders.ts:190`) is `now >= startIso`, INCLUSIVE, and
`app/test/tourReminders.test.ts` pins it with a case named "true: exactly AT the
tour start - **the copy is already stale**". One codebase, one instant, two
opposite answers to "is forward-looking tour copy stale at t=start", with the
newer site citing the older one as its authority.

The practical exposure is near zero (exact millisecond equality; reachable only
if a quiet-end deferral lands precisely on `scheduledAt`), so this is not a
correctness emergency. But the reasoning is what a future reader will use, and it
is wrong as written. Either flip to `<=` - which also makes the relay agree with
spec 6.1a's "AT/AFTER" framing that the ladder already adopted - or keep strict
and rewrite the comment to stop claiming sameness, saying instead that an intro
is a different message class from a reminder. I prefer the flip: the tour entries
close with the same forward-looking sentence the ladder gates on, so the same
boundary is the honest one, and one fewer footgun.

I do NOT challenge any other ruling. A-N7, A-N8 and A-N9 were correctly RECORDed
(A-N7's inversion remains structurally unavoidable - `tour_already_passed` needs
`target.tour`, which a thrown resolution does not have).

---

## 4. Are my round-1 items closed?

| id | closed? | evidence |
|---|---|---|
| **A-M1** | **YES** | `app/test/devGating.test.ts:560` seeds a real pending `confirmation` at `dueAt = FIXED_NOW` through `world.tourRemindersRepo.create`, so the discontinued filter is genuinely what makes the first tick a no-op. All three comments re-derived (`:519-531`, `:565-570`, `:618-622`) and backed by assertions rather than prose: the row is read back and asserted due, unsent and NOT claim-skipped (`:571-578`) - which also pins that the poll holds back rather than stamping `kind_retired`. |
| **A-M2** | **NO** | See R2-B1. The walk exists and is well-designed, but `rosterPhones` cannot return anything, so the leg-arrival assertions the item exists for never execute and the spec is red. The fix-wave report states Playwright was not run, so this was never behaviourally verified. |
| **A-S3** | **YES** | `e2e/scenarios/steps.ts:2085-2092` rewritten and now ACCURATE: it says the panel assertion would fail (not pass) since R12's `/Skipped/` filter, and gives the real reason the helper exists - the panel cannot name `contact_opted_out` vs `tour_already_passed`, and the reason is the content of the assertion. |
| **A-S4** | **YES** | New `expectRungsSuperseded` (`steps.ts:2118-2147`, same empty-list throw, pins `skipped` + `quiet_hours_superseded`), called at `e2e/tests/scenarios/tours.spec.ts:267`. Batch reasoning re-derived independently and holds (see the table above). |
| **A-S5** | **YES** | `jobs/tourReminders.ts:186-190` compares both operands as instants and returns false on an unparseable `dueAt`; two tests, both observed red first (`expected true to be false`). |
| **A-S6** | **YES, as ruled** | Chip branch reverted, label entry kept, `ScheduledCard` tone kept - with R2-S4 recorded above. |

---

## Findings, ranked

**BLOCKING**
- **R2-B1** - the new placement e2e reads `phone` off a roster payload that
  serves `phoneLast4` only; `e2e/tests/relay-intro-variants.spec.ts:181` /
  `:360`. A-M2 is not closed and `npm run e2e` will be red.

**MUST-FIX**
- **R2-M1** - the sweep's per-row isolation makes a systemic failure exit 0 and
  log "done" at INFO; `app/scripts/retire-paused-tour-reminders.ts:240-248`,
  `:259-263`.

**SHOULD**
- **R2-S1** - B-MF1's strictly-before boundary contradicts `retiredByTourStart`'s
  inclusive one while citing it as authority; `relayFanOut.ts:390` vs
  `jobs/tourReminders.ts:190`.
- **R2-S2** - sweep population B hardcodes `'confirmation'` instead of reading
  `DISCONTINUED_REMINDER_KINDS`; `app/scripts/retire-paused-tour-reminders.ts:78`.
- **R2-S3** - `hasUpcoming` still counts a discontinued rung, so the suppression
  estimate is still built (and discarded) for it;
  `app/src/routes/tourReminders.ts:513`, `:522`.
- **R2-S4** - B-S2 added a discontinued branch to a helper shared with the
  placement card in the same commit that reverted one for being unreachable
  there; `RemindersPanel.tsx:79` + `usePlacementNudges.ts:109`.

**NOTE**
- **R2-N1** - `retiredByTourStart` still string-compares `now` against the
  canonical `startIso` while both other operands are instants
  (`jobs/tourReminders.ts:190`). Self-flagged by the wave, correctly scoped, and
  `now` is runtime-produced at all three call sites. Agreed as-is.
- **R2-N2** - `FUTURE_TOUR_AT = '2099-01-10'` (`app/test/toursApi.test.ts:3517`)
  is the wave's one unplanned edit. It is a repair, not a weakening: the resolver
  -equality half of both parity pins is untouched, and the docblock records why a
  past-dated fixture silently rots into asserting the wrong variant. The two
  re-pointed cases pass in `fixwave-toursapi.log` (187/187).
- **R2-N3** - gate-5 attribution independently confirmed pre-existing (see
  section 1).
