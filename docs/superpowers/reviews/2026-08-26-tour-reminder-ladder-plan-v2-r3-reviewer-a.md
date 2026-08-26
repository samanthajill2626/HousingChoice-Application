# Adversarial plan review - tour reminder ladder (plan v2, ROUND 3, reviewer A)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md` (revised twice
since I saw it)
Spec: frozen, `bb4b0475`
Also read: `.superpowers/design-review/plan-v2-r2-reviewer-b.md`
My round 1: `.superpowers/design-review/plan-v2-r1-reviewer-a.md` (all 15 closed)

I reviewed the new failure-semantics material as if it arrived cold, then swept
for surfaces. Bottom line first, because it is the coordinator's question:

**The compose-site enumeration is now RIGHT at five.** I re-grepped
independently: after Task 4, `composeTourReminderBody` has exactly five `app/src`
call sites - `jobs/tourReminders.ts:549` (`composeBodyForRow`, serving all three
send paths), `routes/tourReminders.ts:238` (`bodyFor`), the no-show draft handler
in the same file, `routes/contactTimeline.ts:725`, `routes/relayGroups.ts:258` -
plus `e2e/scenarios/steps.ts:174`, which needs no failure semantics because it
touches no repo. `routes/tours.ts` composes nothing (it only arms and cancels).
Five consumers of `assessNamesReadFailure` is the correct count.

**But the enumeration was never the whole problem.** The two surfaces still
uncovered are not compose sites - they are BARE REPO READS that fail before any
compose site is reached, and a rendering surface with no copy for the new blank
state. Reviewer B found one of the two bare reads (`resolveTenantSuppression`,
now fixed). The other one is still open and is finding 1.

**The derived predicate is sound and is a real advance** - I traced every cell.
It has one hand-mirrored hole (finding 5) and one structurally dead branch
(finding 4), neither fatal.

---

## 1. [HIGH] Force-send still answers 500 - not `names_unavailable` - on the DOMINANT failure cell, and the plan dismisses as "pre-existing" the exact shape it accepted a fix for 200 lines earlier

Plan lines 1860-1863, inside g3's parenthetical:

> (Do not throw the TENANT read in either: on the 1:1 route that read happens
> inside `resolveReminderTarget` BEFORE compose and escapes as a 500 today -
> pre-existing, out of scope.)

Verified in the code, three links:

- `app/src/jobs/tourReminders.ts:647` - `const contact = await deps.contactsRepo.getById(tour.tenantId);`, bare, no try/catch, inside `resolveReminderTarget`.
- `:1172` - `const target = await resolveReminderTarget(row, deps, log);` inside `forceSendReminder`, unwrapped.
- `app/src/routes/tourReminders.ts:365` - `const result = await forceSendReminder(...)` in a plain `async (req, res)` handler on Express `^5.2.1`, so the rejection goes to the error middleware.

So: **a `self_guided` tour + a throwing contacts read + the founder pressing
"Send now" = HTTP 500.** Not a refusal, not `names_unavailable`, not a rendered
sentence.

Why this is not "out of scope":

- Spec 6.3b says it in terms: *"'Leave unclaimed' is the poll's vocabulary and
  does not translate: a human pressing Send now needs an answer, so force-send
  returns a REFUSAL the route can render, not silence."* A 500 is silence with a
  stack trace. The plan builds `names_unavailable` for precisely this sentence
  and then leaves the most reachable cell uncovered.
- `self_guided` is the dominant tour type and the tenant contacts read is the
  most likely of the three reads to fail (it happens on every rung of every
  tour). Under the pause, force-send is the ONLY send path (spec section 2). The
  feature therefore misses its single highest-traffic failure.
- **The consistency argument is decisive.** Task 5 Step 3 already accepts
  containing `resolveTenantSuppression` - equally pre-existing, equally bare,
  same file, same tenant id, same route pair - on the grounds that "this is what
  makes `composeInputsOf`'s 'read paths must never 500 the ladder over a name'
  docblock TRUE rather than aspirational" (plan lines 2066-2074). Fixing the GET
  and refusing the POST leaves the operator with a panel that degrades gracefully
  and a Send-now button that 500s on the same outage, on the same page, in the
  same second.
- It is ~4 lines and invents nothing:

```ts
  let target: ReminderTarget;
  try {
    target = await resolveReminderTarget(row, deps, log);
  } catch (err) {
    log.warn({ err, reminderId, tourId, kind: row.kind }, 'tour reminder force-send: target resolution read failed - row left pending');
    return refuse('names_unavailable');
  }
```

  (`refuse` is declared at `:1183`, below this point - hoist it or inline the
  return object.)

I am contesting the adjudication, not the analysis: the plan's *description* of
the behaviour is accurate. Either close it here or file it, but do not close
`resolveTenantSuppression` and leave this one on a "pre-existing" line inside a
test-fixture parenthetical, which is where obligations go to die.

If it is deliberately deferred, note that the POLL side of the same read is
already benign (the throw lands in the per-row catch at `:490-497`, logging
`'unexpected error processing row'` and leaving the rung unclaimed - the right
net outcome under a wrong log line). It is only the HUMAN path that is broken.

## 2. [MEDIUM] The `TourDetail` fix reads the wrong field off `ApiError` - `message`, where the repo's contract and its one working consumer use `code`

Plan Task 5 Step 3, the dashboard half:

```ts
        setActionError(
          err instanceof ApiError
            ? sendNowErrorMessage(err.message)
            : 'Could not load the check-in message',
        );
```

`dashboard/src/api/client.ts:68-76`:

```ts
    const code = typeof b['error'] === 'string' ? b['error'] : `http_${status}`;
    const detail = typeof b['detail'] === 'string' ? ` (${b['detail']})` : '';
    return new ApiError(status, code, `${code}${detail}`, body);
```

`message` equals the code **only when the response carries no `detail`**. With a
`detail` present it is `"names_unavailable (whatever)"`, which is not a
`SEND_NOW_ERROR_COPY` key and silently falls through to the generic sentence.

The canonical consumer, 60 lines away in the same directory, gets it right and
says so:

- `dashboard/src/routes/tours/RemindersPanel.tsx:278-279` -
  `// NEVER err.message - that is the raw machine code.` /
  `message: sendNowErrorMessage(err instanceof ApiError ? err.code : ''),`
- `dashboard/src/routes/placements/usePlacementNudges.ts:166` - identical.
- `dashboard/src/api/types.ts` (SEND_NOW_ERROR_COPY header) - "`ApiError.message`
  is the RAW machine code, so it must never be rendered".

It works today by coincidence, because the plan's draft handler answers
`res.status(409).json({ error: 'names_unavailable' })` with no `detail`. It
breaks the day anyone adds one - and it teaches the next reader that `.message`
is an acceptable input to `sendNowErrorMessage`.

The test inherits the error: case 11 says "*an `ApiError` whose message is
`'names_unavailable'`*" (plan line 1832). Written that way it passes with the
wrong field. Fix both: use `err.code`, and construct the fixture with
`new ApiError(409, 'names_unavailable', 'names_unavailable')` so the assertion is
field-agnostic.

(Verified in passing, so it is not a second finding: `sendNowErrorMessage` IS on
the `../../api/index.js` barrel - `RemindersPanel.tsx:27-40` imports it from
there alongside `ApiError`, and `TourDetail.tsx:27-43` already imports `ApiError`
from the same barrel. The plan's import claim is correct.)

## 3. [MEDIUM] The `withholdPreview` blank has no operator-visible explanation on either surface that renders it

`withholdPreview` returns `body: ''`. Both readers render it bare:

- `dashboard/src/routes/tours/RemindersPanel.tsx` - `<p className={styles.body}>{rung.body}</p>` (the rung row, ~`:352`).
- `dashboard/src/routes/contact/ScheduledCard.tsx:98` - `<div className={styles.scheduledBody}>{item.body}</div>`.

Neither has an empty-state branch. On a transient contacts/units outage the
operator sees an `en_route` row with a kind label, a state chip reading
"upcoming", a "Send now" button - and **no text at all**, with nothing saying
why. Task 5 adds copy for the send refusal (`SEND_NOW_ERROR_COPY`) and adds
nothing for the preview blank.

It gets worse on the send-now round trip: the 409 echo runs `bodyFor(after, ...)`
(`routes/tourReminders.ts:379`) through the same withhold, so the operator's
click returns an error banner *and* blanks the row it points at.

Yes, `body: ''` is pre-existing (the `UncomposableReminderError` catch). But that
one fires only on an unusable `scheduledAt` - a data state, rare, and permanent
enough that the missing explanation is the smaller problem. This one fires on a
repo blip, transiently, on the rung the founder is most likely to be looking at.

The spec does not mandate copy, so this is not a spec-coverage failure - it is a
finished-feature question the plan should answer rather than discover. Cheapest
honest answer: render the existing "Skipped -"-style muted note with something
like `Preview unavailable - could not look up who is showing the property`,
gated on `body === '' && state === 'upcoming'`. That is one branch in
`RemindersPanel` and one in `ScheduledCard`, and it is the difference between
"degraded" and "broken".

## 4. [MEDIUM] `assessNamesReadFailure`'s property half of `tokenBlanked` is structurally dead today, and it is the one branch the tripwire test never exercises

```ts
  const tokenBlanked =
    (used.tenantName && args.tenantReadFailed) ||
    (used.propertyContact && !forksOnPropertyName && propertyReadLost);
```

I enumerated `used.propertyContact` over the whole space:

| kind | tourType | `used.propertyContact` | `forksOnPropertyName` |
| --- | --- | --- | --- |
| confirmation | any | false | false |
| day_before / morning_of / no_show_checkin | any | false | false |
| en_route | self_guided | false | false |
| en_route | landlord_led / pm_team | **true** | **true** |

`used.propertyContact` is true in exactly the cells where `forksOnPropertyName`
is also true, so `!forksOnPropertyName && ...` can never fire. The clause is
correct future-proofing (a future entry could USE the property token without
FORKING on it) and the docblock says so - but it is the branch a "pure string
edit" would activate for the first time, and the derived-table test
(plan `:911-965`) never touches it. Every other row of that table is pinned.

This is exactly the class the predicate exists to defend: the tripwire covers the
cells that exist and leaves uncovered the cell that a copy edit creates. Either
add a row that forces it (e.g. temporarily assert against a constructed
`reminderNamesUsed`-shaped input, or restructure the two helpers so the
needs-table can be injected in test), or state in the code comment that the
clause is deliberately unreachable under the current catalog so the next reader
does not mistake green coverage for exercised coverage.

## 5. [MEDIUM] The "derived, never hand-mirrored" claim has a hand-mirrored hole exactly where address twins live

```ts
  const ids: MessageId[] =
    kind === 'confirmation'
      ? ['tour.confirmation', 'tour.confirmation_no_address']
      : [idFor(kind, true, true, tourType)];
```

For every non-`confirmation` kind this inspects **only the `hasStreet === true`
entry**, and the twin case is handled by a literal, hand-written two-element
array keyed on `kind === 'confirmation'`.

Today that is complete: `confirmation` is the only kind that keeps a twin after
Task 4 (plan Step 3 deletes the other three). But the whole argument for
deriving this predicate is that it must survive an edit nobody remembers to
re-check - and the change most likely to reintroduce a twin is Phase B, which the
plan's own ledger says will rework `confirmation` and may add entries. If any
kind ever gains a `_no_address` twin whose two halves differ in name tokens, this
returns the wrong answer for the no-address half, and nothing catches it: the
truth-table test asserts the same hardcoded shape.

Fully derived and shorter:

```ts
  const ids = [...new Set([
    idFor(kind, true, true, tourType),
    idFor(kind, false, true, tourType),
  ])];
```

That collapses the `confirmation` special case into the general rule (it yields
both twins for confirmation and one entry everywhere else) and removes the last
hand-mirror from a function whose entire justification is that it has none.

Same note for `assessNamesReadFailure`'s `forksOnPropertyName`, which also
hardcodes `hasStreet: true`; with the union above it should compare across the
same id set rather than one arbitrary address branch. Today both answers are
identical, so this is a robustness fix, not a bug.

## 6. [LOW] `bodyFor` has FOUR call sites, not five - and the inflated count is already propagating

`grep -n "bodyFor(" app/src/routes/tourReminders.ts` returns exactly `:323`,
`:335`, `:379`, `:495`. Reviewer B's r2 finding 7 lists "`:323`, `:335`, `:379`,
`:496`, and the PATCH 409 path" - `:323` **is** the PATCH 409 path, counted
twice.

The plan's own Task 5 text is CORRECT ("the two PATCH echoes (the 409 branch at
`:323` and the success echo at `:335`), the send-now echo (`:379`), and the GET
list map (`:496`)") - four, correctly named. Only the summary count is wrong, and
it has already reached the round-3 brief ("`bodyFor` now carries three flag
params across five call sites"). Worth correcting because on a feature whose
signature failure is "landed in four of five copies", an off-by-one in the
checklist is the thing that makes a builder hunt for a fifth site that does not
exist - or, worse, conclude the checklist is unreliable.

## 7. [LOW] The GET reminders route now reads the same tenant contact twice per request

After Task 4, `composeInputsOf(tour)` (`:417-418`) calls
`resolveTourContactNames({ tenantId: tour.tenantId, ... })`, which does
`contactsRepo.getById(tour.tenantId)`. Then at `:458`
`resolveTenantSuppression(tour, config, contacts, conversations)` does
`await contacts.getById(tour.tenantId)` again (`:572`).

Spec section 10: *"Resolve contacts once per request and batch; do not read per
rung."* The spirit is per-rung, not per-function, so this is not a violation -
but the plan is opening `resolveTenantSuppression` anyway (to contain it), and
threading the already-resolved contact in is a small change on the tour page's
hot path. Either do it or say why not; do not leave a doubled read on the route
whose read-count the plan otherwise carefully manages.

## 8. [LOW] The override carve-out is a docblock promise with no tier-1 marker

`reminderNamesUsed`'s docblock: *"DEFAULTS only ... the day a generic override
map lands, widen this to the EFFECTIVE template, because an override could add a
name token the default lacks."*

I re-verified the premise holds today: `settingsToOverrides`
(`app/src/messages/resolve.ts:74-79`) maps only `welcome.sms` and
`missed_call.autotext`, and no call site passes `overrides` to
`composeTourReminderBody`. So the carve-out is sound.

But `ComposeTourReminderInput.overrides` already EXISTS on the signature, so
activating the hazard is one call-site argument away, not one feature away. Per
AGENTS.md's tier-1 rule this deserves a `TODO(<issue-slug>):` marker, not only a
prose sentence - or an item in the Phase B ledger Task 10 creates, which is where
the plan correctly routed the other deferred acceptances this round.

---

## The two things the coordinator asked me to judge

### SPEC CONCERNS #1 / the per-cell withhold - the current resolution is RIGHT, and better than both earlier ones

I raised this tension in r1 and I am satisfied it is now correctly resolved.
Reviewer B's r2#4 is the right reading and the plan adopted it well:

- **6.3b explicitly gives read and send different postures** ("READ paths degrade
  ... SEND paths leave the rung UNCLAIMED"). A preview that renders `Hey there,`
  beside a send that is waiting is therefore sanctioned by the spec, not a defect
  - which retires my r1 objection that the split "manufactures a preview/send
  disagreement". The spec already owned that disagreement.
- **6.3a's "never a different ENTRY" is a constraint on WHICH TEXT, not on
  fidelity.** A blanked token yields the same entry, the same sentence shape, the
  same information about what the tenant will eventually get. An entry flip
  yields text the send would never produce. Those are different failures and
  deserve different answers. Round 1's uniform `''` conflated them.
- **The cost asymmetry is decisive.** `composeInputsOf` sets `tenantReadFailed`
  once per request, so the uniform version blanked every rung except
  `confirmation` on a single blip. A ladder of empty rows reads as broken
  software; `Hey there, confirming your tour tomorrow at 3:00 PM` reads as
  degraded, which is what it is.
- **It is now derived rather than listed**, so the per-cell decision cannot rot
  independently of the copy.

Endorsed without reservation, with the single residual in finding 3: the cell
where withholding IS right still has no operator-facing explanation.

### The `en_route` marker - no separate objection

The adopted fragment is `when you're on the way`. I checked both new defaults as
the plan writes them (lines 1034 and 1037): `...can you please text me when
you're on the way?` and `...Can you please text here when you're on the way?`.
Verbatim substring of both, so spec 13's every-variant invariant holds. The
coordinator's concession is correct and the author was right.

My r1 reasoning was only ever about ABSENCE assertions colliding with
tenant-authored text (`tours.spec.ts:139` relays an on-my-way message), and the
longer fragment closes that. **No further objection.**

---

## Does a zero-context builder produce the spec?

Yes, with findings 1-3 addressed. This plan is now unusually well-instrumented
for a literal executor: every derivation is stated with its fixture, every
red-state has a "why it is red" note, the two docblock carve-outs are named with
line numbers, the shared fixture's two non-obvious preconditions are spelled out,
and the guards are labelled exempt from the red check.

The remaining risk is not comprehension - it is that finding 1 leaves the
feature's headline promise ("a human pressing Send now needs an answer")
unmet on its most reachable path, and finding 3 leaves the withhold cell
looking like a bug to the person it was built for.

---

## Swept this round and found CLEAN (bank it; do not redo)

- **No sixth compose site.** `composeTourReminderBody` across the whole repo:
  `jobs/tourReminders.ts:549`, `routes/tourReminders.ts:238` + the new draft
  handler, `routes/contactTimeline.ts:725`, `routes/relayGroups.ts:258`,
  `e2e/scenarios/steps.ts:174`. `routes/tours.ts` imports only
  `armTourReminders` / `cancelTourReminders` (`:63-66`) and composes nothing.
  `app/scripts`, `scripts/`, `worker.ts`: zero hits.
- **`e2e/performance/templates.ts:55`** lists `/api/tours/:tourId/no-show-checkin-draft`,
  but that file is a URL-template normalizer for the perf profiler - no budget,
  no status assertion, so the new 409 needs nothing there.
- **Adding a `SEND_NOW_ERROR_COPY` key is safe.** `dashboard/src/api/types.test.ts`
  has no exhaustive-key test over the map; `:78-80` pins a single code
  (`breaker_open`). Nothing enumerates the union against the map.
- **`ForceSendRefusal` has no second consumer.** The nudge ladder carries its own
  `NudgeForceSendRefusal` (`app/src/jobs/placementNudges.ts:724`), so widening the
  tour union cannot reach it - spec 6.3b's shared-map constraint is satisfied
  structurally, not just by the new-key argument.
- **Readers of a reminder `body`** are exactly two components: `RemindersPanel.tsx`
  and `ScheduledCard.tsx:98` (which serves both the contact timeline and the
  group thread buckets). Both take it bare - see finding 3.
- **Task 2's flag split is clean**: `tenantReadFailed` / `propertyReadFailed`
  each set only by their own catch, and supplying `tenantContact` skips the read
  entirely - so on the contact timeline (which passes `contact` in hand)
  `tenantReadFailed` is structurally false, which is correct and costs nothing.
- **The no-show draft's assess call is right, not redundant.** It passes
  `unit: undefined`, so `propertyReadFailed` is structurally false and
  `unitReadFailed` is hardcoded false - the call reduces to `tenantReadFailed`.
  Going through the assessor anyway is what keeps it catalog-derived if the
  no-show copy ever loses its name token. A builder must not "simplify" it to a
  bare flag check.
- **`reminderNamesUsed` truth table** verified cell by cell against the new
  catalog strings for all 5 kinds x 3 tour types; every assertion in the plan's
  derived-table describe (`:911-965`) is arithmetically right, including the
  `morning_of` + `landlord_led` + `unitReadFailed` -> `NONE` row that pins my r1
  finding A8.
- **`idFor`'s `forksOnPropertyName` derivation** is correct for every kind:
  `en_route` x non-`self_guided` is the only pair where
  `idFor(k,true,true,tt) !== idFor(k,true,false,tt)`.
- **No layering regression from the two new helpers.** `tourCopy.ts` already
  reaches `MESSAGE_CATALOG` transitively through `resolve.ts`, so the new value
  use adds nothing to the e2e bundle; `assessNamesReadFailure` is imported as a
  value only by `jobs/` and `routes/`. The `export type { TourContactNames }`
  re-export is present in Task 4 Step 4 and closes my r1 finding A4.
