# Independent spec-conformance review - feat/tour-reminder-ladder

**Date:** 2026-08-31
**Reviewer:** independent planner-side conformance pass (read-only, no test suites run)
**Branch tip:** `85e78de8`
**Merge base:** `440dc75ef81c42b1d7f8c56dcdd85f7555da2b9f`
**Authority:** `docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md` (read in
full). The implementation plan was NOT treated as a requirement.

Method: `git diff`/`git show` against the merge base, direct file reads, and a
programmatic byte-comparison for the copy table. No `npm test`, `npm run e2e`,
`npx vitest` or `npx playwright` was invoked at any point.

---

## The four things I was asked to verify hardest

### 1. THE PAUSE - CONFORM (verified by byte diff, not by reading)

The builder's claim is TRUE and I verified it mechanically rather than by eye.

Extracted `440dc75e:app/src/jobs/tourReminders.ts` to a scratch file and diffed
the region carrying BOTH declarations - base lines 140-210 against HEAD lines
178-248. `diff -u` reports **no differences**. That window spans the
`MANUAL_ONLY_REMINDER_KINDS` docblock and set literal
(`app/src/jobs/tourReminders.ts:201-206`), the `readQuietHoursWindow` helper
between them, the `no_show_checkin` comment, and the `REMINDER_KINDS` literal
(`:235-240`). Both sets still hold exactly `confirmation`, `day_before`,
`morning_of`, `en_route`.

I also swept every consumer of the set to make sure the pause was not lifted
somewhere other than the declaration:

- `app/src/routes/dev.ts:421` and `:622` pass `manualOnlyKinds: new Set()` - that
  is the documented dev-tick harness trap (spec section 2), and
  `git diff` reports **`app/src/routes/dev.ts` is UNCHANGED on this branch**, so
  the trap is pre-existing, not introduced.
- `app/src/routes/api.ts:933` still forwards `deps.tourReminderManualOnlyKinds`;
  the only change in that file is a comment (7 lines, no code).
- `app/src/routes/tourReminders.ts:173` and
  `app/src/routes/contactTimeline.ts:1091` still default to the real set.

Nothing on this branch auto-sends anything that did not auto-send before.
**Not blocking. The builder did not overstate this one.**

### 2. COPY BYTE-EXACTNESS - CONFORM (all five, character-for-character)

Compared programmatically, not by eye: the five spec-section-5 strings were
written to a fixture file, the catalog `default:` values were extracted from
`app/src/messages/catalog.ts` and `eval`-ed as JS string literals (so quote
style and multi-line wrapping are normalized away), then compared with `===`
plus a length check and a non-ASCII scan.

| Entry | catalog site | verdict | len |
| --- | --- | --- | --- |
| `tour.day_before` | `catalog.ts:148` | MATCH | 93 |
| `tour.morning_of` | `catalog.ts:156-157` | MATCH | 118 |
| `tour.en_route_self_guided` | `catalog.ts:165` | MATCH | 69 |
| `tour.en_route_landlord_led` | `catalog.ts:176` | MATCH | 131 |
| `tour.no_show_checkin` | `catalog.ts:186` | MATCH | 48 |

All five are pure ASCII (no smart quotes survived the Word round-trip - the
apostrophes in "you're" are U+0027, which is why the entries are written with
double-quote delimiters). Zero wording improvements, zero re-punctuation, zero
token renames. **CONFORM.**

### 3. THE `_no_address` TWINS - CONFORM (exactly as ruled, no more, no fewer)

Base `MessageId` union carried four twins; HEAD carries one.

- DROPPED: `tour.day_before_no_address`, `tour.morning_of_no_address`,
  `tour.en_route_no_address` (and the base `tour.en_route` was replaced by the
  two tour-type ids).
- KEPT: `tour.confirmation` / `tour.confirmation_no_address`
  (`catalog.ts:126-145`), with a comment at `:134-137` restating why `{where}`
  must not be declared on the twin (spec 6.5).

`idFor` (`app/src/messages/tourCopy.ts:128-155`) is the total map, and it is the
only place the address fork survives - `case 'confirmation'` branches on
`hasStreet`, every other case does not. This is exactly the spec-9 id table.
**CONFORM.**

### 4. `confirmation` STAYS ARMED - CONFORM

Covered by the byte diff in item 1: `REMINDER_KINDS` (`:235-240`) is untouched
and still contains `confirmation`. No `QUIET_HOURS_EXEMPT_KINDS` was added
either (grep across `app/`, `dashboard/`, `e2e/` returns nothing), so spec 7.3's
"CUT from Phase A" also held. Phase B's work is filed, not done:
`docs/issues/tour-reminder-ladder-phase-b.md` (new, 206 lines).
**CONFORM.**

### 5. TOKEN NAMING - CONFORM

`TOUR_NAME_VARS` (`app/src/messages/catalog.ts:100-103`) is
`['when','time','tenantFirstName','tenantName','propertyContactFirstName','propertyContactName']`.
No `landlord`-named token anywhere on the tour path. The `{landlord}` hits
elsewhere in the repo are the pre-existing placement Now-card tokens
(`dashboard/src/routes/placements/stageDescriptors.ts`,
`PlacementNowCard.tsx:118`), untouched by this branch. **CONFORM.**

---

## Every spec ruling, enumerated, with a verdict

| # | Spec | Ruling | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| R1 | 2 | Pause HOLDS; `MANUAL_ONLY_REMINDER_KINDS` NOT touched | CONFORM | byte-diff of base 140-210 vs HEAD 178-248; `tourReminders.ts:201` |
| R2 | 2 | `confirmation` stays armed; `REMINDER_KINDS` untouched | CONFORM | same byte-diff; `tourReminders.ts:235` |
| R3 | 2 | Force-send is a first-class path, scrutinized like a live send | CONFORM | `tourReminders.ts:1370-1490`; refusal at `:1408`, `:1479` |
| R4 | 3 | Aug 24 file governs; voice prompts OUT of scope | CONFORM | no voice file in the changed-file list |
| R5 | 3 | Registry item `founder-message-template-updates-owed.md` MUST be updated; tour half closes, relay half stays open | CONFORM | that file +20 lines, `status: open` retained, item 3 stamped DONE, items 1/2/4 explicitly untouched |
| R6 | 3 | D2 REVERSED - `no_show_checkin` gets the name | CONFORM | `catalog.ts:186`; comment at `:182-183` records the reversal and its author |
| R7 | 5 | Segment length is NOT a requirement - DELETE the segment assertion | CONFORM | no `segments === 1` remains in `app/test/tourCopy.test.ts`; comment at `:112-113` records the drop |
| R8 | 5 | KEEP the ASCII assertion | CONFORM | `tourCopy.test.ts:115,130,263-273` |
| R9 | 6 | Four name tokens DECLARED and PASSED on every tour entry | CONFORM | `catalog.ts:100-103` spread into all seven entries; `tourCopy.ts:80-85` always passes all four |
| R10 | 6 | `{when}` stays declared even where unused | CONFORM | `TOUR_NAME_VARS` leads with `when` |
| R11 | 6 | Entries stay `editable: true` | CONFORM | all seven tour entries at `catalog.ts:126-191` |
| R12 | 6 | `welcome.sms` keeps `{firstName}`, NOT renamed | CONFORM | entry absent from the catalog diff |
| R13 | 6.1 | Reuse the primary-contact rule; KEEP the empty-string guard, written INLINE (do not export `nonEmpty`) | CONFORM | `app/src/lib/tourContacts.ts:124-129`; `rosterResolution.ts` untouched |
| R14 | 6.1 | Do NOT read `unit.primary_contact` | CONFORM | `tourContacts.ts` reads only `unitContacts()` + `landlordId` |
| R15 | 6.1 | Read the LIVE contact for the name, not the roster's denormalized one | CONFORM | `tourContacts.ts:142` `contactsRepo.getById` |
| R16 | 6.2 | First-name helper in the NEW module, NOT `contactName.ts`; carry a `TODO(consolidate-contact-display-name-helpers)` | CONFORM | `tourContacts.ts:71-77`; `contactName.ts` not in the changed-file list |
| R17 | 6.3 | No tenant first name -> `there` | CONFORM | `tourCopy.ts:81` |
| R18 | 6.3 | No property-contact first name on a landlord-led tour -> compose the SELF-GUIDED entry, never a filler noun | CONFORM | `tourCopy.ts:149-151` |
| R19 | 6.3a | Group-path plumbing IN SCOPE | CONFORM | `composeBodyForRow` reads both contacts when `tenantContact` is absent - `tourReminders.ts:683-712` |
| R20 | 6.3a | Composer stays PURE and SYNCHRONOUS; resolution in each caller | CONFORM | `tourCopy.ts:74` is sync and repo-free; five resolve sites, all outside it |
| R21 | 6.3a | 1:1 route passes `target.contact` through rather than reading twice | CONFORM | `tourReminders.ts:692-696` optional `tenantContact` param, documented at the signature |
| R22 | 6.3a | Previews HOIST the resolve; property contact keyed by `unitId`; tenant resolved once | CONFORM | `contactTimeline.ts:936-959` (`namesOnce` keyed on unitId, `tenantContact: contact` passed in) |
| R23 | 6.3a | Do NOT reuse `unitOnce` as-is - it must carry the failure distinctly | CONFORM | `contactTimeline.ts:910-928` - `UnitRead { unit, failed }` replaces the bare `undefined` |
| R24 | 6.3a | Extend the drift guard, or accept three copies drifting | CONFORM (stronger) | all three preview sites route through `assessNamesReadFailure` (`contactTimeline.ts:752`, `relayGroups.ts:304`, `routes/tourReminders.ts:294`), so the semantics are derived once from the catalog rather than hand-mirrored |
| R25 | 6.3b | READ paths degrade and MUST NOT throw | CONFORM | `resolveTourContactNames` never throws (`tourContacts.ts:111-150` - both reads in try/catch, flags only) |
| R26 | 6.3b | SEND paths leave the rung UNCLAIMED on read failure | CONFORM | `ReminderNamesUnavailableError` thrown from `composeBodyForRow` (`tourReminders.ts:723-727`), above `claimSend` |
| R27 | 6.3b | Force-send returns a REFUSAL with a REASON TOKEN, NOT a fourth outcome | CONFORM | `ForceSendRefusal` gains `'names_unavailable'` (`tourReminders.ts:1328`); `ForceSendResult` still has exactly four shapes, unchanged from base |
| R28 | 6.3b | The reason must reach `SEND_NOW_ERROR_COPY`, and must not change nudge behaviour | CONFORM | `dashboard/src/api/types.ts:1317` adds one key; no existing key altered; nudge codes untouched |
| R29 | 6.4 | `_no_address` dropped for every touched rung; `confirmation` keeps its pair | CONFORM | see item 3 above |
| R30 | 6.4 | Address clause moves into the composer: `Address is <street>.` / empty string, then TRIM | CONFORM | `tourCopy.ts:107` and the `.trim()` at `:92` and `:121` |
| R31 | 6.4 | `{where}` stays declared on the entry | CONFORM | `catalog.ts:152,161,169,180` |
| R32 | 6.5 | Replace the twin test with "morning_of, no address, composes clean" | CONFORM | `app/test/tourCopy.test.ts:35-38` |
| R33 | 7 | `day_before` = 19:30 org-local the evening BEFORE the tour's local date | CONFORM | `tourReminders.ts:133-139` via `shiftLocalDate(localDateOf(...), -1)` + `instantAtLocalTime` |
| R34 | 7 | `morning_of` = `scheduledAt - 4h` | CONFORM | `tourReminders.ts:145` |
| R35 | 7 | `en_route` -1h, `no_show_checkin` +30m, `confirmation` now - all unchanged | CONFORM | `tourReminders.ts:117,152,155` |
| R36 | 7 | Zone via `resolveQuietHoursTimezone`, NEVER `settings.timezone` | CONFORM | the zone arrives as `window.timezone` from `readQuietHoursWindow`, which calls `resolveQuietHoursTimezone` (`tourReminders.ts:216`) |
| R37 | 7 | DST-transition test owed for the 19:30 rung | CONFORM | `app/test/computeDueAt.test.ts:26-33` pins both sides of the 2026-03-08 spring-forward |
| R38 | 7.1 | Do NOT fail, do NOT validate; log a WARN naming the rung | CONFORM | `tourReminders.ts:318-330` - warn only, gated on `isQuietTime(rawDayBefore, window)` so a disabled window never warns |
| R39 | 7.3 | Exemption hook CUT from Phase A | CONFORM | `QUIET_HOURS_EXEMPT_KINDS` absent from the whole tree |
| R40 | 8 | Rule 1: `day_before` skipped when `now > rawDueAt - 4h` | CONFORM | `tourReminders.ts:377-379` |
| R41 | 8 | Rule 2: `morning_of` skipped when `sameDay && now > scheduledAt - 6h`, same zone | CONFORM | `tourReminders.ts:380-382`, `localDateOf(now, window.timezone) === tourLocalDate` |
| R42 | 8 | Both rules compare RAW offsets, before clamping; boundaries strictly `>` | CONFORM | the `raws` map at `:298-307` exists solely for this; both comparisons use `>` |
| R43 | 8.1 | Both new rules write a VISIBLE skipped row | CONFORM | `tourReminders.ts:384-390` `create({ skipped: { at: now, reason: 'booked_too_late' } })` |
| R44 | 8.1 | Evaluate BOTH new rules BEFORE the past-dueAt check; leave that branch untouched for every other rung | CONFORM | the `bookedTooLate` branch precedes `if (dueAt < now)` at `:392`; that branch is byte-unchanged |
| R45 | 8.1 | Precedence 1-2-3-4, and the accepted mis-attribution is NOT to be "fixed" by reordering | CONFORM | encoded and documented at `tourReminders.ts:359-370` |
| R46 | 8.2 | Add `booked_too_late` to the app union | CONFORM | `app/src/repos/tourRemindersRepo.ts:78` |
| R47 | 8.2 | Carry it through the dashboard wire union | CONFORM | `dashboard/src/api/types.ts:1223` |
| R48 | 8.2 | Operator label EXACTLY `booked too late for this reminder` | CONFORM | `dashboard/src/api/types.ts:1283` - byte-exact; pinned at `RemindersPanel.test.tsx:174` |
| R49 | 8.2 | Persist the CLAMPED dueAt on the skipped row | CONFORM | `tourReminders.ts:387` passes `dueAt` (from `dues`), with the spec citation inline |
| R50 | 9 | The id map is TOTAL; `ReminderKind` unchanged; `morning_of` keeps its name | CONFORM | `idFor` is an exhaustive `switch` with no `default`, so a new kind is a compile error |
| R51 | 9.0 | `pm_team` takes the landlord-led wording; branch on `=== 'self_guided'`, never enumerate `landlord_led` | CONFORM | `tourCopy.ts:149` |
| R52 | 9.1 | EXHAUSTIVE compose matrix - every kind x address x tour type | CONFORM | `app/test/tourCopy.test.ts:117` also crosses `{names, none}` |
| R53 | 9.1 | That test closes `tourcopy-messageid-cast-unguarded` | CONFORM | issue front-matter now `status: resolved`, `resolved: 2026-08-26` |
| R54 | 9.2 | Fix BOTH `no_show_checkin` throw sites and the `ALLOWED_DIRECT` whitelist | CONFORM (stronger) | composer path `tourCopy.ts:91-93`; draft route `routes/tourReminders.ts:657-700` now goes through the composer; `ALLOWED_DIRECT` was DELETED entirely - `tourCopyCallSites.test.ts` now allows no exceptions at all |
| R55 | 10 | All five composer call sites plus the no-show draft supply the new args | CONFORM | `tourReminders.ts:729`, `routes/tourReminders.ts:230`+`:668`, `contactTimeline.ts:948`, `relayGroups.ts:248`, `e2e/scenarios/steps.ts` |
| R56 | 10 | Timeline resolves once per request and batches; no per-rung read | CONFORM | `contactTimeline.ts:943-959` memoized promise map |
| R57 | 10 | Move `seedLive.test.ts`'s deliberate `computeDueAt` twin in lockstep | CONFORM | `app/test/seedLive.test.ts:29,65` now uses `shiftLocalDate` + `instantAtLocalTime` |
| R58 | 11 | RELABEL `Morning of` -> `4 hours before` | CONFORM | `dashboard/src/api/types.ts:1249` - byte-exact |
| R59 | 11 | Fix the surrounding aria sentence so it still reads as English | CONFORM | `RemindersPanel.tsx:353` and `:364` now `Send the {label} reminder now` / `{Cancel\|Restore} the {label} reminder` |
| R60 | 11 | Move the pinned accessible-name contract with it | CONFORM | `e2e/support/selectors.md:72` updated, plus a NEW row pinning the Cancel/Restore twin |
| R61 | 11 | The chip wording must not accuse the operator | CONFORM | "booked too late for this reminder" states the reminder, not the person; the revival caveat is recorded at `tourReminders.ts:352-358` |
| R62 | 13 | Non-test readers move with the rule | CONFORM | `documentation/tours-sequence-writeup.md`, `seed/matrix.ts:962-968`, `seed/live.ts:10,507`, `seed/cast.ts:771`, `selectors.md` all updated |
| R63 | 13 | `relayAnnouncements` is NOT affected | CONFORM | absent from the changed-file list |
| R64 | 13 | The seeded-`sentBody` question gets a deliberate decision, not a discovery | CONFORM | recorded as `DECIDED 2026-08-26` at `app/src/lib/seed/cast.ts:774-777` |
| R65 | 13 | New coverage: due times, quiet-start warn, both skip rules incl. boundaries, reschedule, wording by tour type, zero-roster AND zero-primary, read-failure vs absence, the matrix, clean no-address morning_of, a pending confirmation, the skip label | CONFORM | present across `computeDueAt.test.ts`, `tourContacts.test.ts`, `tourCopy.test.ts`, `tourReminders.test.ts:1264-1400`, `toursApi.test.ts` (case 7, reschedule+revival), `RemindersPanel.test.tsx:174`. The one acknowledged residue is filed, not hidden: `docs/issues/tour-reminder-zero-primary-e2e-gap.md` |
| R66 | 13.1 | `day_before` dueAt read BACK from the API, never computed host-side; suite stays time-of-day independent | CONFORM | `e2e/scenarios/steps.ts:2014-2031` `armedReminderDueAt()`; `quiet-hours.spec.ts:342,345,374` drive ticks from it |
| R67 | 13.1 | `TourTimes` gains `morningOf`, loses `dayBefore` | CONFORM | `steps.ts:270,346`; no `dayBefore` field remains |
| R68 | 13.1 | The four dependent specs are REWORKED, not re-baselined | CONFORM | `quiet-hours.spec.ts` (+130/-), `scheduled-visibility.spec.ts` (+90), `tours.spec.ts` (+17) all carry re-derived reasoning in comments |
| R69 | 13.2 | No `confirmation` rework in Phase A | CONFORM | no change to the ~40 unit / ~14 e2e confirmation sites |
| R70 | 13.2 | `tour-comms-pane.spec.ts`, `tour-no-show-checkin.spec.ts` re-derived; names threaded through the context, not hard-coded per spec | CONFORM | both specs changed; `tour-no-show-checkin.spec.ts:82` re-derives against `booked_too_late` |
| R71 | 4 | OUT-of-scope surfaces untouched: relay intro split, `relay.member_added`, tour-copy Settings UI, legacy address cleanup, `welcome.sms`, voice prompts, compliance-locked entries | CONFORM | catalog diff touches ONLY `tour.*` entries; no voice, relay-fanout or settings-route file in the diff |

---

## Things that are in the code but NOT in the spec

Neither is a violation. Both are recorded so nobody later reads them as drift.

1. **Tenant-as-property-contact de-dupe** (`app/src/lib/tourContacts.ts:130-139`,
   added in the tip commit `85e78de8`). Spec 6.1 quotes the resolver as
   `primary?.contactId ?? nonEmpty(unit.landlordId)` and says nothing about the
   degenerate case where that id IS the tour's own tenant. The branch treats it
   as "no property contact", which routes into spec 6.3's documented absence
   fallback (the self-guided entry). The precedent it cites is real - I checked
   `app/src/lib/rosterResolution.ts:278-281` carries the same de-dupe one line
   below the rule the spec told the builder to reuse. Without it a unit whose
   `landlordId` is the tenant composes "Hey Alice, Alice will be headed that way
   shortly." and texts it to Alice. This is a correct extension of a rule the
   spec quoted incompletely, not an invention.

2. **The blank-body sentence** (`RemindersPanel.tsx:378-388`, plus
   `ScheduledCard.tsx` and two CSS files). Spec 6.3a requires the preview to
   withhold a body it cannot honestly render; it does not say what the panel
   should then DISPLAY. The branch renders "Preview unavailable - this message
   cannot be composed right now." rather than an empty paragraph under a live
   Send-now button. This is the minimum UI consequence of a rule the spec DID
   make, and it is confined to files sections 8.2/11 already opened.

3. **Name sanitization** (`tourContacts.ts:60-62`, `inertName`). Strips `{`/`}`
   from resolved names so a contact named `{propertyContactFirstName}` cannot be
   re-expanded by a later interpolation pass. Not in the spec. The general fix is
   filed as `docs/issues/message-interpolate-token-reexpansion.md`, and the
   docblock is honest about the residual address vector it does NOT close. Sound
   defensive work on a genuinely user-supplied value that reaches an SMS.

---

## Result

**VIOLATED count: 0.**

Seventy-one enumerated rulings, all CONFORM. Three of them (R24, R54, and the
`ALLOWED_DIRECT` deletion inside it) are satisfied more strongly than the spec
required. No ruling is CANNOT-VERIFY: every one had a reachable static artifact.

I want to be plain about one thing, because it is the check I was most prepared
to fail the branch on: **the builder did not overstate the pause.** The claim was
that two specific declarations are byte-identical to the merge base. I diffed a
71-line window containing both and got zero differences, then swept every
consumer of the set for a back-door unpause and found none. That claim is exactly
as strong as stated.

### My single biggest worry (not a violation)

**The booked-too-late boundary is decided by a LEXICOGRAPHIC string comparison,
and the spec's strict-`>` boundary rule survives only because production happens
to feed it a canonical timestamp.**

`app/src/jobs/tourReminders.ts:377-382` compares `now > new Date(...).toISOString()`
directly as strings. `toISOString()` always emits milliseconds and a `Z`, but
`now` is whatever the caller passed. In production it is
`new Date().toISOString()` (`app/src/routes/tours.ts:251`), so both sides are the
same shape and the comparison is exact. But `'...T08:00:00Z'` is lexicographically
GREATER than `'...T08:00:00.000Z'` (`Z` = 0x5A beats `.` = 0x2E), so a `now`
supplied without milliseconds - by a test fixture, a seed, a future dev seam, or
an external caller - silently converts the spec's "a tour booked exactly 6h out
still arms `morning_of`" into "it is skipped". The failure is invisible: it
produces a plausible skipped row, not an error.

This is not a spec violation - the shipped production behaviour is correct - and
the surrounding code has always compared ISO strings this way (`dueAt < now` at
`:392` predates this branch). But this branch is the first to hang a
founder-visible skip decision on a strict boundary, and it did so on a comparison
that is only accidentally exact. A `Date.parse()` on both sides would cost
nothing. Worth a follow-up issue, not a block.

Two smaller residues, both already filed by the builder rather than buried:
`docs/issues/tour-reminder-zero-primary-e2e-gap.md` (the zero-primary case has
unit coverage but no e2e) and
`docs/issues/tour-copy-where-token-declared-not-passed.md`.

### Would I sign this off as spec-conformant?

**Yes.** Without reservation on conformance grounds.

This is the closest match between a signed-off spec and shipped code I have
reviewed on this repo. The copy is byte-exact where the founder authored it. The
pause is provably untouched. The two hardest structural rulings - that failure is
not absence (6.3b), and that the previews must never compose a DIFFERENT ENTRY
from the send (6.3a) - are not hand-mirrored across the three duplicated compose
blocks, which is what the spec feared; they are derived once from the catalog
templates themselves by `assessNamesReadFailure`
(`app/src/messages/tourCopy.ts:200-263`), so a future copy edit cannot silently
desync them. That is a better answer than the spec asked for.

Sign-off is conformance only. I ran no gates and no suites, by instruction, so
this verdict says nothing about whether the branch is GREEN - only that what it
ships is what was agreed.
