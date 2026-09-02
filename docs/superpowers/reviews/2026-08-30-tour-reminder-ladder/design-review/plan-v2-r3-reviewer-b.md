# Adversarial plan review - tour reminder ladder (plan v2, ROUND 3, reviewer B)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md` (revised, 3146 lines)
Spec: unchanged, frozen at `bb4b0475`

All seven round-2 findings are properly closed - I re-checked each. The new
catalog-derived mechanism is a genuine improvement over the hand-mirrored predicate
and its core derivation is correct. What follows is what the new mechanism gets
wrong, one real regression the containment fix introduces, and a fresh sweep.

---

## 1. [HIGH] The `resolveTenantSuppression` containment silently drops the "Paused"
chip on `self_guided` tours - and Task 5 case 10 PINS the regression

Task 5 Step 3 (plan lines 2066-2074) fixes my r2 finding 2 like this:

> wrap the function's reads in try/catch; on a throw, log ONE warn (ids only) and
> **return an evaluator that always yields `undefined`**.

That is the wrong shape, and it collides with a deliberate fallback three lines away.
`app/src/routes/tourReminders.ts:481-489`:

```ts
const paused = manualOnlyKinds.has(row.kind);
const suppression =
  state !== 'upcoming' ? undefined
  : suppressionOf !== undefined ? suppressionOf(row.dueAt, paused)
  : paused ? ({ reason: 'paused' } as const)
  : undefined;
```

The third branch exists precisely because `paused` is *"a property of the KIND, so it
is known for EVERY tour ... (it needs no recipient IO)"* (the comment at `:480-486`).
An always-`undefined` evaluator keeps `suppressionOf` DEFINED, so branch 2 wins and
branch 3 is never reached - and the chip falls through to
`RemindersPanel.tsx:119-126`, the amber `sends in Nh` / `sending shortly` wording.

That is the exact lie the 2026-08-20 pause exists to end. `RemindersPanel.tsx:110-116`
says so in terms:

> The fire-time wording below is a promise, so it must not be reached here - a chip
> reading "sending shortly" above a line reading "Paused" is precisely the
> perpetual-"sending shortly" lie this feature exists to end.

So: during a transient contacts-table blip on a `self_guided` tour, every upcoming
rung's chip flips from **Paused** to **"sends in 3h"** for a ladder that will never
fire. The blip degrades the body honestly ("Hey there,") and simultaneously replaces
the honest chip with a false promise.

Worse, case 10 (plan lines 1817-1827) **asserts the regression**: *"NO `suppression`
estimate is present on any rung (the estimate is best-effort and its read failed)"*.
A builder writing that test locks the defect in, and the plan's own re-derivation rule
("do not re-baseline a failing row") will protect it afterwards.

**Fix, and it is smaller than what the plan asks for:** on a failed read leave
`suppressionOf` UNASSIGNED (`undefined`) rather than returning a null evaluator. The
existing branch 3 - written for exactly this "no evaluator available" case, which is
how group-routed tours already behave - then supplies `{ reason: 'paused' }` with zero
IO. Case 10's assertion becomes: *every upcoming rung still reads `paused`, and no
rung carries a recipient-derived reason (opt-out / manual mode / quiet hours)*. That
also makes the test prove something, which "no suppression anywhere" does not.

The handback bullet at `:3008-3017` should gain the one line this implies: a
tenant-read failure changes the BODY, never the pause state.

## 2. [MEDIUM] The new `TourDetail.tsx` copy routing reads the wrong ApiError field,
and imports send-shaped copy into a draft-LOAD path

Plan lines 2055-2061:

```ts
setActionError(
  err instanceof ApiError ? sendNowErrorMessage(err.message) : 'Could not load the check-in message',
);
```

Two problems, both verified.

**(a) Wrong field.** `dashboard/src/api/client.ts:68-75` builds the error:

```ts
const code = typeof b['error'] === 'string' ? b['error'] : `http_${status}`;
const detail = typeof b['detail'] === 'string' ? ` (${b['detail']})` : '';
return new ApiError(status, code, `${code}${detail}`, body);
```

`message` is `code` PLUS an optional ` (detail)` suffix - the two diverge the moment
any handler adds a `detail`. `sendNowErrorMessage` is keyed by CODE, and the repo's
only correct call site uses `err.code`:
`RemindersPanel.tsx:279` - `sendNowErrorMessage(err instanceof ApiError ? err.code : '')`.
The plan's version happens to work today only because the new 409 carries no `detail`.
Use `err.code`, matching the precedent.

(The author's underlying finding is CORRECT and I verified it: `TourDetail.tsx:345`
renders `err.message` raw today, and `types.ts`'s `SEND_NOW_ERROR_COPY` docblock
forbids that - *"`ApiError.message` is the RAW machine code, so it must never be
rendered"*. Good catch that both round-1 reviews missed.)

**(b) The map is send-shaped; this is a load.** The draft fetch can fail with
`{ error: 'tour_not_found' }` (`routes/tourReminders.ts:545`). `tour_not_found` is NOT
a key in `SEND_NOW_ERROR_COPY` - the tour key there is `tour_missing` - so it falls to
the generic *"Couldn't send that just now - please try again."* on an operation where
nothing was being sent, replacing today's accurate *"Could not load the check-in
message"*. A 500 or a network error degrades the same way. Nothing catches it:
`TourDetail.test.tsx` pins the draft SUCCESS path (`:611-625`) and has no failure pin.

Narrow it: route only the codes this route can actually mean through the map (or add a
draft-specific branch for `names_unavailable` and keep the existing sentence as the
fallback). Whatever the shape, add a second dashboard case for the 404 so the copy is
pinned rather than incidental.

## 3. [MEDIUM] `reminderNamesUsed` re-introduces a hand-mirror - the exact thing the
restructure removed

Plan lines 1171-1174:

```ts
const ids: MessageId[] =
  kind === 'confirmation'
    ? ['tour.confirmation', 'tour.confirmation_no_address']
    : [idFor(kind, true, true, tourType)];
```

`kind === 'confirmation'` is a hand-maintained list of *which kinds have address
twins*, and the `true` for `hasStreet` on every other kind is the assertion that no
other kind has one. Both are facts about the catalog, hard-coded next to a function
whose entire purpose is to stop hard-coding facts about the catalog. Re-add a
`_no_address` twin for any rung (spec 6.4 is a RULING, not a law of nature) and put a
name token only in the twin, and `reminderNamesUsed` inspects the wrong entry silently.

Fully derived, no name list, same result today:

```ts
const ids = [...new Set([
  idFor(kind, true, true, tourType),
  idFor(kind, false, true, tourType),
])];
```

For `confirmation` that yields both twins automatically; for every other kind it
collapses to one id. Strictly more correct and one line shorter than the special case.

## 4. [MEDIUM] The copy-edit tripwire has a blind spot on the one template no other
row watches

The tenant-token row (plan lines 934-939) is `self_guided`-only:

```ts
for (const kind of ['day_before','morning_of','en_route','no_show_checkin'] as const) {
  expect(assessNamesReadFailure({ kind, tourType: 'self_guided', ...ok, tenantReadFailed: true }), kind)
    .toEqual({ blocksSend: true, withholdPreview: false });
}
```

I worked the tripwire against nine plausible "pure string edits". **Eight trip.**
Removing `{tenantFirstName}` from **`tour.en_route_landlord_led` only** does not:

- the `reminderNamesUsed` row (`:915-925`) checks `en_route`/`landlord_led` for
  `.propertyContact` only, never `.tenantName`;
- the tenant row above never visits `landlord_led` or `pm_team`;
- the property/unit rows (`:942-957`) are driven by `entryCorrupted`, which comes from
  `idFor` divergence and is unaffected by token removal.

`blocksSend` for (`en_route`, non-`self_guided`, `tenantReadFailed`) flips true -> false
with no red. The derived answer is still CORRECT - that is the strength of the
restructure - but the tripwire's stated job is that the change *"announces itself ...
and the failure semantics get re-ruled consciously"* (plan lines 905-910), and here it
does not. Fix: wrap the tenant row in `for (const tourType of TOUR_TYPES)`. Free for
the three kinds that do not fork, and it closes the gap.

**For the record, the eight that DO trip** (so nobody re-derives this): adding
`{tenantFirstName}` or `{tenantName}` to either `confirmation` twin (rows `:917` and
`:927`); removing it from `day_before` (`:919`), `morning_of` (`:934`),
`no_show_checkin` (`:920`), or `en_route_self_guided` (`:934`); adding
`{propertyContactFirstName}` to `morning_of` (`:960` - via the unit-read row),
`day_before` (`:951`), or `en_route_self_guided` (`:922`); removing it from
`en_route_landlord_led` (`:923`).

## 5. [LOW] The assessor's prose says the `en_route` type fork is the only fork. It is
not - `confirmation` forks on `hasStreet`, and a failed UNIT read flips it

Plan line 1191-1193: *"withholdPreview - the failed read would change WHICH ENTRY
composes (the en_route tour-type fork is the only such fork)"*, and line 1211-1214
frames `forksOnPropertyName` as "the ENTRY CHOICE itself".

`idFor`'s `confirmation` branch forks on `hasStreet` (`:1120-1123`), and `hasStreet`
comes from the unit read. A throwing unit read therefore composes
`tour.confirmation_no_address` where a healthy read would have composed
`tour.confirmation` - a different ENTRY, produced by a failed read, on a cell the
assessor deliberately never blocks.

**The behaviour is right** and I am not asking for it to change: spec 6.3b's
never-lost-over-a-missing-street rule is explicit, the plan's carve-out preserves it
knowingly, and preview and send AGREE here because both degrade the address the same
way - so 6.3a's actual concern (a preview showing text the send never produces) does
not arise. What is wrong is the prose: the next person deriving from
"the only such fork" will conclude the address axis cannot flip an entry, and it can.
One sentence in the docblock: the ADDRESS fork is also entry-flipping, and is
deliberately exempt because both sides flip together.

## 6. [LOW] The assessor's second `tokenBlanked` disjunct is unreachable today, and
would render a blank name mid-sentence if it ever fired

```ts
const tokenBlanked =
  (used.tenantName && args.tenantReadFailed) ||
  (used.propertyContact && !forksOnPropertyName && propertyReadLost);
```

`used.propertyContact` is true only for `en_route` x non-`self_guided`, where
`forksOnPropertyName` is also true - so the second disjunct is dead. It is correct
future-proofing, but note what it implies if a future entry ever uses
`{propertyContactFirstName}` WITHOUT forking on it: `blocksSend` becomes true (good)
while `withholdPreview` stays false, so the PREVIEW renders
`names.propertyContactFirstName ?? ''` - a blank mid-sentence, which is precisely the
rendering spec 6.3 forbids (*"Do not invent a filler noun - 'your contact will be
headed that way shortly' reads badly and asserts what we cannot back"*). Worth one
comment saying the composer's fork is what keeps that unreachable, so a future author
who removes the fork knows they also owe a preview rule.

---

## Answers to the four questions asked

**Does the derivation produce the right answer for every cell?** YES. I worked the
full matrix against the new catalog defaults from Task 4 Step 3.
`reminderNamesUsed`: `confirmation` -> `{false,false}` for all three tour types (both
twins are `'Hey, your tour is set for {when}...'`); `day_before`, `morning_of`,
`no_show_checkin` -> `{tenantName: true, propertyContact: false}`;
`en_route`/`self_guided` -> `{true,false}` (idFor short-circuits on `=== 'self_guided'`
before the name test); `en_route`/`landlord_led` and `/pm_team` -> `{true,true}`.
`forksOnPropertyName` is true for exactly `en_route` x {`landlord_led`,`pm_team`} and
false everywhere else, including `confirmation` (both calls pass `hasStreet: true`, so
both return `'tour.confirmation'`). Every row of the truth-table test matches. The
`hasName: true` choice is the right one and the docblock justifies it correctly: the
question is what we MEANT to compose, not what the degraded fallback renders.

**Is "uses the token" vs "forks on it" a correct distinction?** Yes, and it is the
right axis. `blocksSend` asks whether the composed body would be WRONG (either axis
matters); `withholdPreview` asks whether the ENTRY would differ (only the fork
matters). Deriving the fork structurally from `idFor` divergence rather than from token
presence is the better of the two available derivations - the two coincide today but
answer different questions, exactly as the comment says. No cell is misclassified. The
one imprecision is the address axis (finding 5), which is a prose defect, not a
classification defect.

**Overrides.** The claim is VERIFIED and is in fact conservative.
`settingsToOverrides` (`app/src/messages/resolve.ts:74-79`) maps exactly
`welcome.sms` and `missed_call.autotext` and nothing else, so no `tour.*` override can
be produced. Stronger still: no tour compose site passes an `overrides` argument at all
- all five (`jobs/tourReminders.ts:549`, `routes/tourReminders.ts:238`, the new draft
handler, `routes/contactTimeline.ts:725`, `routes/relayGroups.ts:258`) call the
composer without one, and `catalog.ts`'s own token-contract comment already records the
fact. The docblock's forward-looking caveat ("the day a generic override map lands,
widen this to the EFFECTIVE template") is the right hedge and is where it needs to be.

**Does the tripwire trip?** Eight of nine edits, yes - see finding 4 for the ninth and
for the full enumeration.

**Is the withhold cell assignment right?** Yes. `withholdPreview = entryCorrupted =
forksOnPropertyName && (propertyReadFailed || unitReadFailed)` selects exactly
`en_route` x non-`self_guided` x property-or-unit failure, and nothing else. That is
the single cell where the two spec sentences collide, and it is the narrowing my r2
finding 4 asked for. Cases 5, 6 and 10 assign consistently: `en_route` blanks,
`day_before` composes normally under a property failure, and a tenant-read failure on a
self_guided ladder degrades to "Hey there," rather than blanking. SPEC CONCERNS #1 now
states the reading and its consequence honestly, including that a preview can show a
body the send refuses.

**Is the compose-site count now complete?** YES, and this is the third independent
check. `grep -rn "composeTourReminderBody(" app/src e2e/scenarios dashboard/src`
returns exactly five: `jobs/tourReminders.ts:549`, `routes/tourReminders.ts:238`,
`routes/contactTimeline.ts:725`, `routes/relayGroups.ts:258`, plus the harness at
`e2e/scenarios/steps.ts:174`. Task 4 adds a sixth call inside
`routes/tourReminders.ts` (the draft handler, today a bare
`resolveMessage('tour.no_show_checkin')` at `:548`). That gives FIVE failure-semantics
consumers - `composeBodyForRow` for all send paths, three previews, and the draft - and
the harness, which has no failure semantics. This matches spec section 10's own list
(four in `app/src` + the harness, "plus the composer-bypassing no-show draft") exactly.
The enumeration is closed.

**Did the raw `ApiError.message` render check out?** YES - `TourDetail.tsx:345`:
`setActionError(err instanceof ApiError ? err.message : 'Could not load the check-in message')`,
against a contract in `dashboard/src/api/types.ts` that says `message` is the raw
machine code and must never be rendered. Neither round-1 review found it. See finding 2
for what is still wrong with the fix.

---

## Contesting the adjudications

I have no objection to any round-2 adjudication. All seven of my findings were
implemented as specified and, where the implementation went beyond the finding, it went
in the right direction:

- **Draft as the fifth consumer** - implemented with the SEND posture (409
  `names_unavailable`), not the preview posture. That is the correct call: the draft is
  the head of a hand send, and blanking the composer would be a worse failure than
  refusing it.
- **`resolveTenantSuppression`** - the containment is the right idea; only its return
  shape is wrong (finding 1).
- **Per-cell withhold** - implemented exactly as argued, and SPEC CONCERNS #1 now
  names the resulting preview/send split as 6.3b's own posture rather than a defect.
- **The catalog derivation** - a stronger fix than the guard test I asked for. Replacing
  the mechanism rather than testing the mirror was the better move.
- **g3, the shared fixture's preconditions, and the second `bodyFor` widening** - all
  three now carry the missing facts inline, including the "do NOT alter
  `resolveTourContactNames` to report a read it never made" instruction, which is the
  right way to close an over-specified fixture.

One note on the marker adjudication, unchanged from round 2: `"when you're on the way"`
is a verbatim substring of both new `en_route` defaults, so spec 13's every-variant
invariant holds and the tenant-authored-text collision is closed. Still correct.

---

## Does a zero-context builder produce the spec?

Yes, with findings 1 and 2 fixed. Finding 1 is the only one that ships a
behaviour defect, and it ships a PINNED one - which is the dangerous kind, because the
plan's own "re-derive, never re-baseline" discipline will defend it. Findings 3, 4, 5
and 6 are durability and prose: none changes what the branch does on merge day, and all
four are one-to-three-line edits.

The plan is otherwise executable as written. Its arithmetic has now survived three
independent passes without a wrong expected value, the surface enumeration is closed
against both the spec's list and a fresh grep, and the failure semantics are derived
from the catalog rather than mirrored beside it.

---

## What I re-verified this round and found CORRECT (do not redo)

- `assessNamesReadFailure` / `reminderNamesUsed` over the full
  kind x tourType x address matrix (above).
- `settingsToOverrides` (`messages/resolve.ts:74-79`) maps only `welcome.sms` and
  `missed_call.autotext`; no compose site passes `overrides` at all.
- The compose-site enumeration, by grep, against spec section 10.
- `TourDetail.tsx:345` renders `err.message` raw; `ApiError` (`client.ts:11-31`) carries
  both `code` and `message`, and `errorFrom` (`:68-75`) makes them diverge on `detail`.
- `sendNowErrorMessage` is reachable from `TourDetail.tsx` via `../../api/index.js`
  (`api/index.ts:3` re-exports `./types.js`), so the plan's import instruction is valid.
- Task 2's truth-table block is correctly relocated to Task 4 with the reason stated
  ("it cannot be written before the new catalog exists"), and Task 2 Step 4's "8
  resolver tests" matches the eight `it` blocks in that describe.
- `tourCopy.ts` hosting the assessor creates no layering problem: it already reaches
  `MESSAGE_CATALOG` through `resolve.ts` (whose header certifies it AWS-free and
  harness-safe), and the four server consumers value-import from it legitimately.
- The `export type { TourContactNames } from '../lib/tourContacts.js'` re-export still
  resolves and is still fully erased (no `isolatedModules` / `verbatimModuleSyntax` in
  `tsconfig.base.json`; `export type ... from` is erased regardless).
- Case 9's draft fixture is sound: the draft route reads the tenant fresh and passes
  `unit: undefined`, so `tenantReadFailed` is the only flag in play and
  `assessNamesReadFailure({kind:'no_show_checkin', ...})` blocks on it correctly.
- Case 10's non-suppression assertions (200 not 500, "Hey there," bodies, no blank
  bodies) are all correct; only the suppression clause is wrong (finding 1).
- The handback's failure-posture bullet (`:3008-3017`) now states the per-cell rule and
  the preview/send split accurately.
