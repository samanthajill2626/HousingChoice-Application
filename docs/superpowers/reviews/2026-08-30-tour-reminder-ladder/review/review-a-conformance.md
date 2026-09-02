# Review A - SPEC CONFORMANCE

**Reviewer:** spec-conformance pass (independent)
**Worktree:** `W:\tmp\tour-reminder-ladder` (`feat/tour-reminder-ladder`)
**Tree state at review:** clean, tip `268554ef` (merge of `main` @ `440dc75e`)
**Method:** every verdict derived from the LIVE TREE. Slice reports read only as a
map of where to look. One targeted unit run (`app/test/tourCopy.test.ts`, 27/27
green) used as empirical proof of the copy/composer rulings; no e2e, no `npm test`.

---

## 1. WORK MAP - one line per item

| # | Item | Verdict |
| --- | --- | --- |
| T1 | `shiftLocalDate()` calendar-day helper | **CONFORMS** |
| T2 | `resolveTourContactNames()` - new module, never throws, per-read flags | **CONFORMS** |
| T3 | `booked_too_late` skip reason, both unions + operator label | **CONFORMS** |
| T4 | Catalog, composer, and EVERY compose path (absence semantics) | **CONFORMS** |
| T5 | Failure is not absence - scoped deferral, refusal, preview withholding | **CONFORMS** |
| T6 | Retime the ladder - `computeDueAt` (19:30 prior evening; 4h before) | **CONFORMS** |
| T7 | Booked-too-late skip rules and the quiet-window warn | **CONFORMS** |
| T8 | Relabel "Morning of" and the pinned accessible names | **CONFORMS** |
| T9 | e2e ladder mirror and the timing-contract rework | **CONFORMS** |
| T10 | Seeds, prose, issue registry | **PARTIAL** - one broken HTML comment (G1) |
| T11 | Main sync, five gates, handback | **PARTIAL** - gate 4 in flight, no handback file yet (G2) |

---

## 2. THE SEVENTEEN LOAD-BEARING RULINGS

### 1. THE LADDER IS STILL PAUSED - **CONFORMS**

`MANUAL_ONLY_REMINDER_KINDS` is byte-identical to the merge base and still
contains all four auto-armed rungs:

- `app/src/jobs/tourReminders.ts:201-206` - `new Set<ReminderKind>(['confirmation','day_before','morning_of','en_route'])`
- base `440dc75e:app/src/jobs/tourReminders.ts:163-168` - the same five lines.

`REMINDER_KINDS` is unedited and still arms `confirmation`:

- `app/src/jobs/tourReminders.ts:235-240`; base `:197-202`. Identical.

Its 6-line rationale docblock (`:173-199`) is also unedited, so it stays TRUE
rather than becoming dead state, exactly as spec 9.4 requires.

### 2. The founder copy is byte-exact - **CONFORMS**

Machine-compared all five rows of spec section 5's table (lines 163-167) against
the catalog defaults, character by character. All five EXACT:

| id | catalog line |
| --- | --- |
| `tour.day_before` | `app/src/messages/catalog.ts:148` |
| `tour.morning_of` | `app/src/messages/catalog.ts:156-157` |
| `tour.en_route_self_guided` | `app/src/messages/catalog.ts:165` |
| `tour.en_route_landlord_led` | `app/src/messages/catalog.ts:176` |
| `tour.no_show_checkin` | `app/src/messages/catalog.ts:186` |

Nothing was "cleaned up": the two `en_route` entries keep the founder's
double-quoted apostrophe form (`when you're`), and `Hi {tenantFirstName}!` keeps
the exclamation mark. `app/test/tourCopy.test.ts:26,32,46,48,70` re-pins each
string at the composed-body level and passed.

### 3. `tour.confirmation` / `_no_address` keep their `default`s and their twin - **CONFORMS**

`git diff 440dc75e...HEAD -- app/src/messages/catalog.ts` shows the two `default:`
lines UNCHANGED; only their `vars` arrays moved (`['when','time','where']` ->
`[...TOUR_NAME_VARS,'where']`, and `['when','time']` -> `[...TOUR_NAME_VARS]`).

- `app/src/messages/catalog.ts:128` - `'Hey, your tour is set for {when} at {where}.'`
- `app/src/messages/catalog.ts:140` - `'Hey, your tour is set for {when}.'`

The address twin survives, and `idFor` still forks it on `hasStreet`
(`app/src/messages/tourCopy.ts:136-138`). Pinned by
`app/test/tourCopy.test.ts:75-80`.

### 4. `_no_address` twins gone for every OTHER rung; `{addressLine}` in the composer - **CONFORMS**

`MessageId` lost `tour.day_before_no_address`, `tour.morning_of_no_address`,
`tour.en_route`, `tour.en_route_no_address`; only the confirmation pair remains
(`app/src/messages/catalog.ts:34-40`). The clause is computed in code:

- `app/src/messages/tourCopy.ts:107` - `const addressLine = street.length > 0 ? \`Address is ${street}.\` : '';`
- `app/src/messages/tourCopy.ts:121` - the final `.trim()` that removes the space the empty clause leaves.

A unit with no address produces a sentence that simply ends. Pinned four ways at
`app/test/tourCopy.test.ts:35-42` (no `Address is`, no `{`, no double space, no
trailing space) plus the address-shape describe at `:83-108` (empty struct, `null`,
structured, legacy string) - all green.

### 5. Every tour entry declares all four name tokens plus when/time; all still `editable: true` - **CONFORMS**

`TOUR_NAME_VARS` (`app/src/messages/catalog.ts:100-103`) is
`['when','time','tenantFirstName','tenantName','propertyContactFirstName','propertyContactName']`
and every one of the seven `tour.*` entries spreads it (`:132,144,152,161,169,180,190`).
Enforced by `app/test/tourCopy.test.ts:144-162`, which also pins `tourIds.length === 7`,
`editable === true` and `channel === 'sms'` (the last closing worklist A4-4's hole in
the ASCII/GSM guards).

### 6. Property contact resolves by the ESTABLISHED rule, with the empty-string guard, off the LIVE contact - **CONFORMS**

`app/src/lib/tourContacts.ts:88-107`:

```
const primary = unitContacts(args.unit).find((c) => c.primaryContact === true);
const landlordId =
  typeof args.unit.landlordId === 'string' && args.unit.landlordId.length > 0
    ? args.unit.landlordId
    : undefined;
const propertyContactId = primary?.contactId ?? landlordId;
```

The inline guard is present (spec 6.1's correction), `nonEmpty` was NOT exported
from `rosterResolution.ts`, and the name comes from a LIVE `contactsRepo.getById`
(`:98`), never the roster's denormalized `name`. `grep` confirms **zero** reads of
`unit.primary_contact` anywhere in the touched modules. Both fallback legs are
pinned: zero-primary at `app/test/tourContacts.test.ts:47`, zero-roster at `:60`,
empty-string `landlordId` at `:69` (asserts `getById` is never called with `''`).

### 7. First-name helper is NOT in `contactName.ts` and carries the TODO - **CONFORMS**

`app/src/lib/contactName.ts` is not in the branch's changed-file list
(`git diff --name-only 440dc75e...HEAD` - absent). The helper lives beside its
consumer at `app/src/lib/tourContacts.ts:39-43`, under the marker at `:37`:
`// TODO(consolidate-contact-display-name-helpers): fold into the shared helper`.
Both reads are defensive against the index signature (`typeof c['firstName'] === 'string'`).

### 8. `pm_team` takes the landlord-led wording; selection branches on `=== 'self_guided'` - **CONFORMS**

`app/src/messages/tourCopy.ts:149-151`:

```
return tourType === 'self_guided' || !hasPropertyContactFirstName
  ? 'tour.en_route_self_guided'
  : 'tour.en_route_landlord_led';
```

`landlord_led` is never enumerated alone anywhere in the selection path (grep over
`messages/`, `lib/tourContacts.ts`, `jobs/tourReminders.ts`, the three routes -
every other hit is routing prose or the entry id itself). Pinned at
`app/test/tourCopy.test.ts:44-53`, which asserts `pm_team` composes the identical
landlord-led string.

### 9. No property-contact first name degrades landlord-led to the SELF-GUIDED entry - **CONFORMS**

Same expression - the `|| !hasPropertyContactFirstName` disjunct at
`app/src/messages/tourCopy.ts:149`. A blank name can never render mid-sentence
because the entry that contains the token is not selected. Pinned for BOTH
non-self-guided types at `app/test/tourCopy.test.ts:55-61`.

### 10. Absence and read FAILURE are different - **CONFORMS**

`resolveTourContactNames` never throws; a throwing read becomes a flag
(`app/src/lib/tourContacts.ts:79-82`, `:99-105`) and absence becomes undefined
fields with both flags false (`:113-122`). Scope is then derived from the CATALOG,
not hand-mirrored, by `assessNamesReadFailure`
(`app/src/messages/tourCopy.ts:220-263`) via `reminderNamesUsed` (`:176-198`).

- A failure the copy NEEDS blocks: `blocksSend` -> poll leaves the rung UNCLAIMED
  (`app/src/jobs/tourReminders.ts:1032-1038` 1:1, `:1205-1211` group), force-send
  REFUSES with `names_unavailable` (`:1473-1475`), the no-show draft answers 409
  (`app/src/routes/tourReminders.ts:683-689`).
- A failure the copy does NOT render still sends: `used.tenantName` /
  `used.propertyContact` are read off the actual template strings
  (`app/src/messages/tourCopy.ts:190-197`), so e.g. a tenant-read failure on
  `confirmation` (whose copy has no name token) yields `blocksSend: false`.
  Pinned as an exhaustive truth table at `app/test/tourCopy.test.ts:179-259`,
  including a TRIPWIRE row (`:241`) that goes red the day a copy edit activates
  the structurally-dead `tokenBlanked` branch.
- Genuine absence composes fallbacks and still sends: `there` for the tenant
  (`app/src/messages/tourCopy.ts:81`), self-guided entry for the property contact.

### 11. The `no_show_checkin` draft no longer bypasses the composer; `ALLOWED_DIRECT` is gone - **CONFORMS**

`app/src/routes/tourReminders.ts:694-702` now calls `composeTourReminderBody`
directly. `app/test/tourCopyCallSites.test.ts` has no `ALLOWED_DIRECT` symbol at
all - `:32-36` replaces it with "NO EXCEPTIONS ANY MORE" and the walk at `:47-54`
skips only the composer itself (`:48`).

### 12. Segment assertion DELETED, ASCII assertion KEPT - **CONFORMS**

No `.segments` reference survives in `app/test/tourCopy.test.ts` (grep: only
`analyzeSms(body).encoding` at `:284`, which is the UCS-2 boundary test, not a
length rule). The `it` title was renamed per worklist A4-6:
`app/test/tourCopy.test.ts:267` - `'OUR copy is ASCII with the seeded address'`,
with `:264-266` recording why. The ASCII check itself is at `:268-274`, and the
exhaustive matrix adds a second ASCII sweep at `:130`. `analyzeSms` remains a live
import, so no unused-import lint fallout.

### 13. `booked_too_late` rows store the CLAMPED dueAt, evaluated BEFORE past-dueAt - **CONFORMS**

`app/src/jobs/tourReminders.ts:344-388`. `dueAt` comes from the `dues` map
(clamped, built at `:306`), and the write is explicitly annotated:

- `:374` - `dueAt, // the CLAMPED value, like every arm-time skip row (spec 8.2)`

Ordering is correct: the booked-too-late branch `:370-383` `continue`s ahead of the
past-dueAt drop at `:385-388`. The comparison itself uses the RAW map (`raws`,
`:362-369`), which is the spec's split. Precedence is documented at `:357-361`
with an explicit "do NOT fix it by reordering".

### 14. Timing - **CONFORMS**

`app/src/jobs/tourReminders.ts:117-156`:

- `confirmation` -> `now` (`:126`)
- `day_before` -> `instantAtLocalTime(shiftLocalDate(localDateOf(scheduledAt, window.timezone), -1), '19:30', window.timezone)` (`:134-138`) - the DST-converging local-time anchor, not a fixed offset
- `morning_of` -> `scheduled - 4h` (`:144`)
- `en_route` -> `scheduled - 1h` (`:152`), unchanged
- `no_show_checkin` -> `scheduled + 30m` (`:154`), unchanged

The drift-guard twin moved in lockstep: `app/test/seedLive.test.ts:55-85` (same
two changes, window closed over as `QUIET_WINDOW` per worklist C13). Coverage in
`app/test/computeDueAt.test.ts` includes the winter/EST UTC-midnight crossing
(`:20`) and the spring-forward transition (`:25`), which is spec 7's owed DST test.

### 15. Org timezone via the quiet-hours resolver, never `settings.timezone` - **CONFORMS**

`resolveQuietHoursTimezone(settings)` is called exactly once, inside
`readQuietHoursWindow` (`app/src/jobs/tourReminders.ts:223`); every consumer then
reads `window.timezone`. Grep over the six touched runtime modules found no direct
settings-timezone read. `forceSendReminder` reads its own window purely for the
zone and says so (`:1447-1452`).

One note, not a violation: `app/src/lib/seed/matrix.ts:966` uses
`DEFAULT_ORG_SETTINGS.timezone` directly. That is a module CONSTANT in a pure
generator with no settings repo, not a live settings read, and
`resolveQuietHoursTimezone` is the identity on that field
(`app/src/lib/quietHours.ts:39-44`), so behaviour is identical. Recorded in
"SPEC AMBIGUITIES" rather than as a defect.

### 16. `ReminderKind` unchanged as a persisted vocabulary - **CONFORMS**

`app/src/repos/tourRemindersRepo.ts` - the `ReminderKind` union is untouched by the
branch diff; `morning_of` keeps its stored name. Only the staff LABEL moved
(`dashboard/src/api/types.ts:1245` - `morning_of: '4 hours before'`, with the
reason at `:1243-1244`), plus the harness mirror
(`e2e/scenarios/steps.ts:248`). `LADDER_ORDER` (`jobs:165-171`) and the
`computeDueAt` case list still carry all five kinds.

### 17. Phase B ledger issue with all NINE items, including (7) - **CONFORMS**

`docs/issues/tour-reminder-ladder-phase-b.md` - frontmatter `id`/`type`/`severity`/
`status: open`/`area: app/jobs`, title names "the nine things owed". Items are
numbered 1-9 at `:25`, `:41`, `:50`, `:59`, `:64`, `:69`, `:76`, `:92`, `:101`.
Item **(7)** at `:76-90` is the unbounded names-read re-list, correctly framed
("no self-clearing bound ... THAT ACCEPTANCE EXPIRES WITH THE PAUSE") and paired
with the `roster_unavailable` precedent. A code comment references the slug:
`app/src/messages/tourCopy.ts:172` - `TODO(tour-reminder-ladder-phase-b):`. The
jobs-side backstop also points at the ledger in prose
(`app/src/jobs/tourReminders.ts:1199-1204`, "item (7) of the Phase B ledger issue").
Index regenerated, not hand-maintained (`docs/issues/INDEX.md` untracked;
`.superpowers/sdd/issues-regen.log` shows the script ran).

---

## 3. GAPS AND PARTIALS

### G1 (T10, low, actionable now) - a broken HTML comment in `docs/issues/tour-reminders-panel-e2e-flake.md`

Worklist A10-3 asked for the unterminated frontmatter to be closed. It WAS closed
correctly (`:12` now carries `---`, and `scripts/issues.mjs` parses the file
correctly - the regen log is clean). But the new explanatory note was inserted as
its OWN `<!-- ... -->` block placed at the position where the pre-existing comment
already opened, and the new closing `-->` terminated that older comment early:

- `docs/issues/tour-reminders-panel-e2e-flake.md:14` - `<!--` (opens the new note)
- `:21` - `-->` (closes it, and with it the whole comment region)
- `:22-28` - the pre-existing "TITLE CORRECTED 2026-08-21" note, now **rendered as
  visible body prose** because its own `<!--` was consumed
- `:29` - a dangling, orphaned `-->` that also renders

Effect: the issue body now opens with an editorial note that was deliberately
hidden, followed by a stray `-->`. No functional impact on the index or on any
gate; purely a document-integrity regression introduced by this branch, in the very
file the branch was fixing. Fix is one line: re-open a comment before `:22` (or
merge the two notes into a single `<!-- ... -->` block).

Everything else in T10 verified clean: `documentation/tours-sequence-writeup.md:96-155`
(rung table retimed, skip rules described, PAUSED stated, no-show described as
manual), `app/src/lib/seed/matrix.ts:960-970` (19:30 parity, `pm_team` generator
intact at `:933`), `app/src/lib/seed/live.ts:366,501-537` (A10-4's "all 5 rungs"
prose corrected), `app/src/lib/seed/cast.ts:750-806` (A10-5's misleading comment
corrected, ladder instants retimed, the no-`sentBody` recompose consequence recorded
as a DELIBERATE decision per spec 13), `docs/issues/founder-message-template-updates-owed.md`
(tour half closed, D2 reversal recorded, relay items left open - exactly what spec 3
asks for), `docs/issues/tourcopy-messageid-cast-unguarded.md` (status -> resolved,
the twin-based Suggested fix struck and quoted rather than silently left standing),
`docs/issues/scheduled-message-visibility.md:33-46`, and
`docs/research/message-catalog-worklist.md:12` (dated stale banner, artifact not
rewritten). Both new issues exist and `tour-reminder-zero-primary-e2e-gap.md`
carries all three bullets A10-10 required.

### G2 (T11, expected) - gate 4 in flight, handback not written

- Main sync done: `268554ef Merge branch 'main' into feat/tour-reminder-ladder`,
  merge base `440dc75e`. Tree clean, no `MERGE_HEAD`.
- Gate 1 (`typecheck`) - green POST-sync, `.superpowers/sdd/gate1.log` (08:41).
- Gate 2 (`npm test`) - green, `.superpowers/sdd/gate2.log`: `346 passed | 1
  skipped`, `182 passed`, `19 passed`, `34 passed`, `13 passed`;
  `gate2.done` -> `REAL_EXIT=0`.
- Gate 3 (`smoke`) - green: `1356 import specifier(s) across 239 emitted file(s)`.
- Gate 5 (`eslint` over touched files) - **no new errors**. `gate5.log` reports
  11 errors, and `diff gate5.log gate5-baseline.log` differs ONLY in line numbers
  (`live.ts` 128/130 vs 125/127, `matrix.ts` 134 vs 131, `TourDetail.tsx` 269 vs
  268, two e2e warning line numbers). I re-verified the two that could plausibly
  have been introduced by this branch and both are pre-existing at the merge base:
  `app/src/routes/relayGroups.ts:60` imports `resolveMessage` unused at
  `440dc75e` too, and `app/src/repos/tourRemindersRepo.ts:14` `GetCommand` likewise.
  Pre-existing set to NAME in the handback: `seed/cast.ts:45,68,69,393`,
  `seed/live.ts:128,130`, `seed/matrix.ts:134`, `tourRemindersRepo.ts:14`,
  `relayGroups.ts:60`, `ScheduledCard.tsx:63`, `TourDetail.tsx:269`.
- Gate 4 (`npm run e2e`) - RUNNING at review time; not adjudicated here.
- No handback document exists under `.superpowers/`. `progress.md`'s own "Next
  step" still reads "Adjudicate gate 2, run gate 4 (e2e), then Phase 4 review."

T11 is therefore PARTIAL by schedule, not by defect. The worklist's
report-in-the-handback obligations that I can confirm are still OWED (they appear
nowhere in the tree): A3 (nudge aria names deliberately unchanged - verified true,
`e2e/support/selectors.md` keeps `Send <Kind label> nudge now`), A7 (the 7.1 warn
has no dedupe), A9 (PATCH/send-now echoes now pay contact reads - confirmed, three
`composeInputsOf` call sites at `routes/tourReminders.ts:385,450,490`), A10
(`getById` stays eventually-consistent), A4-10 (the new `.trim()` reaches
`confirmation`/`no_show_checkin` with no rendered change), A4-15 and the seven
other OUT-OF-SCOPE finds in worklist section 4, the segment-length cost note
(spec 5 / worklist A2), and the harness trap from spec 2 (the dev tick route passes
an empty manual-only set, so a green e2e proves the machinery, not production
sends).

---

## 4. SPEC AMBIGUITIES ENCOUNTERED

### A. 6.3a and 6.3b give read paths two different instructions where they overlap

Spec 6.3b says READ paths "degrade to the absence fallbacks and MUST NOT throw".
Spec 6.3a says a preview must never render "a different ENTRY" from what the send
would produce. For a landlord-led `en_route` whose property-contact read THREW,
those collide directly: degrading to the absence fallback IS switching to the
self-guided entry.

The build resolved it by splitting the verdict in two - `blocksSend` and
`withholdPreview` (`app/src/messages/tourCopy.ts:220-263`) - and letting 6.3a win
in exactly the overlap: an entry-corrupting failure renders `body: ''`, and a
merely token-blanking failure degrades to the fallbacks per 6.3b. All three preview
copies implement the same rule (`routes/tourReminders.ts:293-303`,
`routes/contactTimeline.ts:745-761`, `routes/relayGroups.ts:297-312`), and the
dashboard gives the blank a sentence rather than an empty row
(`RemindersPanel.tsx:384-386`, `ScheduledCard.tsx:104-107`, with a new CSS class
per worklist C4 rather than reusing `.scheduledSkipMuted`).

I judge this the correct reading and it is documented in the code at the decision
point. Flagged only so nobody re-derives it as a deviation: literally, a preview
returning `''` is not "degrading to the absence fallbacks".

### B. Spec 8.1's cited line anchors are comments, not assertions

Spec 8.1 says the polarity inverts at `tourReminders.test.ts:1211`, `:356` and
`:397`. Worklist C16 already adjudicated these as comment lines (the real
assertions are `:1213`, `:359`, and the `it(` at `:394`) and ruled the PLAN's
numbers correct. The build followed the plan. Not a defect; recorded because the
spec text still carries the wrong anchors.

### C. Spec 10's aside about `relayGroups.ts:258`

The spec calls it "not a tour-reminder route surface". Worklist A6 adjudicated that
as a wording nit - it is in fact the only surface rendering landlord-led GROUP copy
to a client, which is why it gets its own name pin and withhold pin. The build
treated it as first-class (`app/src/routes/relayGroups.ts:224-235` hoists the
resolve above the synchronous IIFE, exactly as 6.3a requires). Correct.

### D. `resolveQuietHoursTimezone` vs a constant in a pure seed generator

Spec D8/section 7 says "NEVER by reading `settings.timezone` directly".
`app/src/lib/seed/matrix.ts:966` reads `DEFAULT_ORG_SETTINGS.timezone`. The rule's
purpose is to keep the per-recipient timezone SEAM
(`app/src/lib/quietHours.ts:39-44`) as the single override point; a pure generator
with no settings repo has no live settings to read, and the resolver is the identity
on that field. Behaviourally identical today. If someone wants literal compliance
it is a one-token change to `resolveQuietHoursTimezone(DEFAULT_ORG_SETTINGS)`; I do
not recommend blocking on it.

### E. Spec 12.1 / 7.3 disagreed on whether the exemption hook is built

7.3 (amended) CUTS it from Phase A; 12.1 as written says "the hook is NOT built
here - see 7.3", which is the corrected form. The build did not add
`QUIET_HOURS_EXEMPT_KINDS` (grep: absent from the tree) and recorded the deferral
as item 4 of the Phase B ledger. Correct per the amended reading.

---

## 5. DEVIATIONS FROM THE PLAN THAT STILL SATISFY THE SPEC

Stated plainly so they are not re-reported as defects:

- **`assessNamesReadFailure` / `reminderNamesUsed` are derived from the catalog
  templates, not hand-listed.** The plan describes the semantics; the build made
  them a function of the copy, plus a tripwire test
  (`app/test/tourCopy.test.ts:241-259`) that fails the day the derivation and the
  copy disagree. Strictly stronger than the spec asked for.
- **`idFor` is an exhaustive `switch`, not a parity test.**
  `docs/issues/tourcopy-messageid-cast-unguarded.md`'s Suggested fix proposed a
  parity test over the `_no_address` twins - which spec 6.4 then deleted. The build
  closed the issue with a compile-time exhaustiveness check
  (`app/src/messages/tourCopy.ts:128-155`) plus the 9.1 matrix, and annotated the
  now-false suggestion rather than deleting it. Better, and spec 9.1's requirement
  ("that test also closes the filed issue") is met.
- **The contact-timeline `unitOnce` memo was widened to carry `failed`
  distinctly** (`routes/contactTimeline.ts:910-927`) instead of the spec's
  either/or, and a second memo `namesOnce` (`:942-958`) sits on top keyed by
  `unitId` with the tenant supplied from the request's own contact. That is 6.3a's
  first option, and the cross-tour-type hazard the key introduces is documented at
  `:936-941` per worklist A5-3.
- **`TourTimes` inverted rather than being patched** - `morningOf` added,
  `dayBefore` removed (`e2e/scenarios/steps.ts:263-272`), and every tick now reads
  the armed instant back from the server (`Scenario.armedReminderDueAt`,
  `:2019-2031`; call sites `quiet-hours.spec.ts:342`,
  `scheduled-visibility.spec.ts:204,288`, `tours.spec.ts:149`). Grep confirms zero
  surviving `times.dayBefore` references. This is spec 13.1's own prescribed
  answer, and the falsified supersession bullet was REWRITTEN with a new argument
  (`quiet-hours.spec.ts:49-60`) rather than re-baselined - worklist A9-1 satisfied.
- **`tour-no-show-checkin.spec.ts` half 1 was re-derived, not re-baselined**
  (`:70-111`): the ladder derivation is spelled out rung by rung and a second
  assertion (`getOutboundTo` count comparison) was added so a wrong derivation
  cannot pass silently. Worklist A9-7 satisfied, and `CHECKIN_PHRASE` is now the
  single literal the exact prefill is built from (`:132-135`).
