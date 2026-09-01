# Fix wave 1 - round-1 adjudications (15 items)

Every row ruled FIX / REVERT / DOC is implemented. Nothing ruled RECORD or MOOT
was touched. `git status` was read before the commit and `.git/MERGE_HEAD` was
absent.

## Red-first evidence

Logs under `.superpowers/sdd/logs/`.

| log | what it proves |
|---|---|
| `fixwave-red-1.log` | exit 1, **4 failed** / 164 passed - B-MF1, B-MF2, B-N1, B-S5 |
| `fixwave-red-2.log` | exit 1, **2 failed** / 107 passed - A-S5, B-N4 |
| `fixwave-red-3.log` | exit 1, **3 failed** / 40 passed - B-S1, B-S2 (x2) |
| `fixwave-green-1.log` | exit 0, 277 passed (the five app files) |
| `fixwave-green-2.log` | exit 0, 302 passed (the dashboard files) |

Each behavioural fix was written test-first and observed failing for the RIGHT
reason before the implementation landed (the failure messages are in the logs -
e.g. B-MF1 `expected 'tour_today' to be 'naked'`, B-MF2 `expected
'rem-disc-next' to be 'rem-live-next'`, B-S5 the raw `ValidationException`
escaping the paging loop).

## Per item

### MUST-FIX

**B-MF1 - past-tour guard on the relay intro. FIXED.**
`app/src/jobs/relayFanOut.ts` - `nowIso` hoisted to the top of
`resolveRelayComposeInputs`; in the tour branch a `scheduledAt` STRICTLY before
`nowIso` is dropped to `undefined`, which the existing spec-9.5 path already
routes to `variant:'naked'`. Strictly-before per the adjudication's test
sentence ("at/after nowIso -> tour variant"). An unparseable `scheduledAt` is
deliberately NOT dropped here - `Number.isFinite` is false, so it still falls
through to the formatter's own try/catch, which already degrades it.
Tests: `app/test/relayFanOut.test.ts` "a tour that has ALREADY STARTED is naked,
exactly as an absent time is" (both the same-local-day case the "is it today"
test cannot catch, and the dated case) + "the past-tour boundary is STRICT".
Also `app/test/toursApi.test.ts` "preview-open on a tour that ALREADY HAPPENED
shows the NAKED intro, not the tour copy" - the same defect through the REAL
route, since `tourOpenGuard` refuses only canceled/closed tours and preview-open
has no time guard of its own.

**B-MF2 - `next` excludes a discontinued rung. FIXED.**
`app/src/routes/tourReminders.ts` - the `next` find now also requires
`suppression?.reason !== 'discontinued'`.
Test: `app/test/tourRemindersApi.test.ts` "is NEVER handed `next`". Carries an
anti-vacuity block: the excluded rung is asserted still `upcoming`, still
chipped `discontinued`, and still `reminders[0]` (the earliest).

**A-M1 - `devGating.test.ts` vacuous discontinued claim. FIXED, claim made REAL.**
`armTourViaRoute` now seeds a pending `confirmation` at `dueAt = FIXED_NOW`
directly through `world.tourRemindersRepo.create` (the adjudication's first
option; the claim was NOT dropped). All three comments re-derived. The first
tick's no-op is now backed by an assertion, not a comment: the seeded row is
read back and asserted `dueAt === FIXED_NOW`, `sentAt` undefined, `skippedAt`
undefined - i.e. genuinely due, genuinely held back, and NOT claim-skipped
(the poll has no in-app writer for `kind_retired`). The ms-less test's claim
that the confirmation is due in the same catch-up window and still never enters
the batch is now also true rather than vacuous.

**A-M2 - placement relay intro e2e. FIXED.**
`e2e/tests/relay-intro-variants.spec.ts` gains a placement-owned walk mirroring
the tour one: fresh landlord + AVAILABLE property with a street + fresh tenant,
`POST /api/placements`, `GET .../roster/preview-open` asserting the body starts
`Hey <tenant first>!`, contains `Excited to have you move into <line1>` and
`<owner first> will share updates`, and contains NEITHER `to tour ` nor
`on the way`. Then `POST .../relay` (driving the connect handshake), and every
member of the SERVER's own roster (`GET .../roster`, read back after the open -
not a list the spec assembled) receives that byte-exact body FROM the group's
pool number. Finally the dashboard thread shows the same bubble.
Supporting refactors, all behaviour-preserving: `openRelay` now takes an owner
PATH and returns `{conversationId, poolNumber}`; new `createPlacement`,
`rosterPhones`, `expectExactSentFromPool` helpers. Accessibility-first locators
throughout; no near-now rows (a placement carries no time at all, which the
header docblock now records as the point of this walk).
Playwright was NOT run. `cd e2e && npx tsc --noEmit -p .` -> exit 0.

### SHOULD

**B-S1 - discontinued rung renders no "Send now". FIXED.**
`dashboard/src/routes/tours/RemindersPanel.tsx` - the button is gated on
`state === 'upcoming' && suppression?.reason !== 'discontinued'`. Cancel/Restore
deliberately kept (still a pending row an operator may want off the ladder).
Test: the existing discontinued panel test extended with
`queryByRole('button', {name:/Send the/})` -> null AND `getByRole` for Cancel;
plus a new ANTI-VACUITY case proving a plain upcoming rung DOES offer Send now.

**B-S2 - the 20s refetch skips a discontinued rung. FIXED.**
`nextReminderRefetchDelay` skips `suppression?.reason === 'discontinued'`. Its
parameter type gained a structural `suppression?: {reason: string}` (it is
shared with `usePlacementNudges`, whose `PlacementNudgeView` carries the same
shape). Tests: two new pure cases - a lone discontinued rung yields `null`, and
a discontinued rung does not SHADOW a live one behind it. The second case also
pins that a `paused` rung is NOT skipped (a human can still send it).

**B-S3 - `uncancel` docblock. FIXED (comment).** Names both gates explicitly
(`DISCONTINUED_REMINDER_KINDS`, and the past-tour claim-skip), and says the
"Restore" button is offered on rows that clear neither.

**B-S4 - preview/send parity comments. FIXED (comment), two sites.**
`app/src/services/rosterEdits.ts` header block and the `buildOpenPreview`
comment now say "the same ENTRY SET, resolved at SEND time", name the two
ordinary gaps (quiet-hours deferral, a `connecting` group awaiting
`relay.numberReady`), give the concrete 23:00-preview / 08:00-send example, and
record that threading the preview clock into the job is the WRONG fix. The
preview clock was NOT threaded.

**B-S5 - sweep partial report + per-row isolation. FIXED.**
`app/scripts/retire-paused-tour-reminders.ts`:
- `ReminderRetirementResult` gains `failed`.
- The per-row body is wrapped in try/catch -> `failed += 1`, logs
  `{err, reminderId, tourId}` (no name/phone/body) and continues. The inner
  conditional-write catch is unchanged and still nested inside it.
- The exported function is now a WRAPPER owning `result` and delegating to
  `scanAndRetire(opts, result)`; its catch logs the PARTIAL report (the counters
  as of the abort) and re-throws. This mirrors `backfill-media-content-types.ts`
  exactly, which is the sibling `RUNBOOK.md:95` describes.
- The top-level `.catch` logs `FAILED (see the PARTIAL report above)` before
  `process.exitCode = 1`, so the counters are on the line above the exit.
- RUNBOOK step 2 gained the `failed` counter and the PARTIAL sentence.
Test: `app/test/retirePausedTourReminders.test.ts` "one CORRUPT row is counted
`failed` and does not abort the rest of the run" - a raw `PutCommand` row with
NO `tourId` (the real ValidationException path), asserting `failed === 1`,
`scanned === 6`, and that BOTH healthy planned rows still got their tokens.

**B-S6 - landlord reads the tenant-addressed intro. DONE (DOC).**
`founder-handback-items.md` item 9 under "Added during the build". States that
one body goes to the whole group, quotes the "Hey Alicia! ... meeting Marcus!"
read-by-Marcus example, records that the old naked intro was audience-neutral
(which is why it never came up), and puts the call to her: keep as-is or supply
a landlord-facing line - noting the send path already supports per-recipient
bodies because member_added uses it. ASCII.

**A-S3 - `expectRungsRetiredPastTour` docblock. FIXED (comment).**
Rewritten: the panel assertion now FAILS here (R12's `/Skipped/` filter) rather
than passing either way - but failing is all it does. It cannot name the reason,
and `contact_opted_out` vs `tour_already_passed` is the whole content of the
assertion. That is why the helper reads `skipReason` from the API.

**A-S4 - assert the enRoute-tick retirement. FIXED.**
New sibling helper `expectRungsSuperseded(kinds)` in `e2e/scenarios/steps.ts`
(same shape and same empty-list throw as `expectRungsRetiredPastTour`, pinning
`state === 'skipped'` and `skipReason === 'quiet_hours_superseded'`), called
from `e2e/tests/scenarios/tours.spec.ts` right after the
`justAfter(times.enRoute)` tick: `expectRungsSuperseded(['morning_of'])`.

**A-S6 - SPLIT, as ruled.**
REVERTED: `DeadlinesNudgesCard.tsx`'s `discontinued` StateChip branch is gone,
replaced by a comment saying why the surface is excluded and that only the LABEL
entry (still present, unchanged) is sanctioned. No test asserted that branch, so
nothing was deleted alongside it. This also moots B-N2.
KEPT: `ScheduledCard.tsx`'s muted tone for `discontinued` - untouched.

### NOTE

**B-N1 - the persisted member_added body. FIXED (one line).**
`body: added !== undefined ? newMemberBody : groupBody`, with a comment tying it
to the raced remove the docblock above already anticipates.
Test: the existing raced-remove fixture extended - ONE row, and its body is the
group body every leg actually received.

**B-N4 - held-back log double-count. FIXED (one line).**
`heldBackManualOnly` is now `manualOnly.has(k) && !DISCONTINUED.has(k)`.
Test: injects `manualOnlyKinds: new Set(['confirmation'])` (a kind in BOTH sets),
captures the poll log and asserts `heldBackManualOnly === 0` and that
`heldBackManualOnly + heldBackDiscontinued === heldBack`. Under the bug the sum
was 2x `heldBack`.

## Collateral, and why

**`app/test/toursApi.test.ts` - two preview-open tests were repaired, not
weakened.** `BASE_CREATE_BODY.scheduledAt` is `2026-07-15`, judged against the
REAL wall clock, so once B-MF1 landed both "the tour variant" preview tests
correctly resolved NAKED and went red. The local `createTour` helper now accepts
an override and those two cases pass `FUTURE_TOUR_AT = '2099-01-10'`, with a
docblock recording that a tour-variant assertion built on a past fixture is a
test that silently rots into asserting the wrong variant. The equality half of
the parity assertion (preview == resolver) is untouched. This is the fix wave's
one unplanned edit and it is worth an eye in re-review.

## Gates (from the worktree, bare, unpiped - logs redirected only)

| gate | command | exit | counts |
|---|---|---|---|
| app unit | `cd app && npx vitest run` | **0** | 347 files passed, 1 skipped; 6395 tests passed, 9 skipped |
| dashboard unit | `cd dashboard && npx vitest run` | **0** | 183 files, 2871 tests passed |
| typecheck | `npm run typecheck` (root) | **0** | all five workspaces |
| smoke | `npm run smoke` | **0** | 1365 specifiers across 239 files resolve |
| e2e tsc | `cd e2e && npx tsc --noEmit -p .` | **0** | - |
| eslint | `npx eslint $(git diff --name-only --diff-filter=d -- '*.ts' '*.tsx')` | 1 | **0 NEW**; see below |

Full app suite log: `.superpowers/sdd/logs/fixwave-app-full-2.log`; dashboard:
`fixwave-dash-full.log`; typecheck: `fixwave-typecheck.log`; smoke:
`fixwave-smoke.log`; eslint: `fixwave-eslint-now.log`.

**Lint attribution.** One error and two warnings, all PRE-EXISTING, none in a
line this wave wrote:
- `app/src/repos/tourRemindersRepo.ts:14` `'GetCommand' is defined but never
  used`. Verified NOT the gate-5 deleted-last-use trap: `git show
  HEAD:app/src/repos/tourRemindersRepo.ts` carries the same import at the same
  line 14, and this wave's only hunk in that file is the docblock at 168+.
- `e2e/tests/scenarios/tours.spec.ts:57,61` unused `eslint-disable` directives
  (warnings). This wave's only hunk in that file is at 267.
Consistent with round 1's recorded baseline ("eslint 0 new, 9 pre-existing").

ASCII: `git diff -- '*.ts' '*.tsx' '*.md' | grep '^+' | LC_ALL=C grep
'[^ -~\t]'` -> empty.

Playwright was NOT run (the orchestrator owns `npm run e2e`). The sweep script
was NOT executed against anything - only its unit/integration suite ran, against
per-case hermetic `hc-test-*` tables.

## Open worries - not blocking, your eye

1. **The toursApi fixture repair is the wave's only unplanned edit.** It is a
   fixture correction, but it does mean two spec-9.0 parity tests now run
   against a 2099 tour rather than a 2026 one. The resolver equality half is
   unchanged, so drift there would still be caught.
2. **`retiredByTourStart` still compares `now` as a STRING** against the
   canonical `startIso`, while both other operands are now instants. Scoped that
   way deliberately - the adjudication ruled only on `row.dueAt`, and `now` is
   runtime-produced rather than read out of a stored row. Recorded in the
   docblock so it is not re-derived as an oversight.
3. **B-MF1's boundary is STRICTLY before.** A tour at exactly `nowIso` still
   composes the tour variant. That follows the adjudication's test sentence, and
   it differs from `retiredByTourStart`'s `now >= startIso` half - two gates,
   two questions, but a reader comparing them may pause. Both are commented.
4. **The placement e2e is unexecuted.** It typechecks and mirrors a walk that is
   green, but the full suite is the first thing that will actually run it - in
   particular the pool-number assertion (`m.from === poolNumber`) and the
   `rosterPhones` equality, neither of which has a precedent in this file.
