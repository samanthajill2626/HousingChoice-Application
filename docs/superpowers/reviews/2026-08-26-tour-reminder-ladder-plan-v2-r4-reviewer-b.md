# Adversarial plan review - tour reminder ladder (plan v2, ROUND 4, reviewer B)

Plan: `docs/superpowers/plans/2026-08-26-tour-reminder-ladder.md` (3348 lines)
Spec: unchanged, frozen at `bb4b0475`
Also read: `.superpowers/design-review/plan-v2-r3-reviewer-a.md`

I tested the coordinator's hypothesis directly: for each of the five round-4 changes,
what did the fix break? Two of the five carry a new (small) defect; three are clean.
All six of my round-3 findings are closed, and I re-verified each closure rather than
taking it on trust.

---

## 1. [MEDIUM] The force-send blanket refuses with NAMES-specific copy for reads that
are not name reads - and for `confirmation`, which the plan's own headline rule and
handback promise will still send

The new wrapper (plan lines 2245-2256) is right to exist and its placement is correct
- I verified `const target = await resolveReminderTarget(row, deps, log);` is at
`jobs/tourReminders.ts:1172`, that `refuse` is declared BELOW it at `:1183` (so the
plan's "inline the return" instruction is necessary and correct), that `reminderId` /
`tourId` / `row` are all in scope, and that `ReminderTarget` is a module-local type
declared above, so `let target: ReminderTarget;` compiles.

What the blanket swallows is four different reads inside `resolveReminderTarget`:

| line | read | is it a "name" read? |
| --- | --- | --- |
| `:625` | `deps.toursRepo.get(row.tourId)` | no |
| `:642` | `resolveUsableGroup(...)` -> conversations | no |
| `:647` | `deps.contactsRepo.getById(tour.tenantId)` | yes - and also the RECIPIENT |
| `:665` | `deps.conversationsRepo.findByParticipantPhone(phone)` | no |

All four now answer `names_unavailable`, whose operator copy is
`'Could not look up the names this message uses, so nothing was sent - please try again.'`
(plan line 1985). For three of the four that sentence names the wrong cause. An
operator told "could not look up the names" during a tours-table or conversations
outage has a plausible and wrong next action: go look at the contact's name fields.

Worse, it collides with the plan's own stated rule in two places:

- Task 5's rule header (plan lines 1795-1797): *"EVERYWHERE ELSE a failure degrades
  exactly like absence and the message still goes out."*
- The handback (plan lines 3212-3215): *"rungs whose copy does not use the failed read
  (a day_before during a landlord-row outage, **any confirmation**) still preview and
  send normally."*

A `confirmation` force-send on a `self_guided` tour whose tenant read throws now
REFUSES - because target resolution fails before compose - even though
`assessNamesReadFailure` says `blocksSend: false` for that cell and g3 exists
specifically to pin that it sends. The refusal is CORRECT (the tenant read resolves the
recipient, not just the name, so there is nobody to send to). The rule statement and
the handback sentence are what is now false, and the copy is what misattributes it.

Two cheap fixes, both needed:

- **One word in the copy.** `'Could not look up everything this message needs, so
  nothing was sent - please try again.'` That sentence is true for all four
  target-resolution reads, for the compose-gate refusal, and for the draft's 409
  (where "nothing was sent" is also literally true - the prefill was refused). It
  costs the compose-gate case a little precision and buys correctness everywhere else.
- **One sentence in the rule header and the handback:** target-resolution failures on
  the 1:1 route refuse for EVERY kind, because the failed read is the recipient
  lookup, not the name lookup - the copy-scoped rule governs the COMPOSE gate only.

Without the second edit, the next reviewer or builder reading "any confirmation still
previews and sends normally" against case 13's containment will file it as a
contradiction, which is how the last three rounds each started.

## 2. [MEDIUM] Case 12 is labelled a green-before pin. It is RED before Step 3, and
"fixing" it as a pin would lock in the exact contract violation being repaired

Plan lines 1920-1927:

> 12. The draft 404 KEEPS the load-shaped fallback: `getNoShowCheckinDraft` rejects
> with `new ApiError(404, 'tour_not_found', 'tour_not_found')` - the action error shows
> `'Could not load the check-in message'` ... **Expected GREEN both before and after
> Step 3** (the raw code and the fallback happen to differ visibly only via case 11) -
> it is a pin, label it so.

Today's code (`dashboard/src/routes/tours/TourDetail.tsx:345`):

```ts
setActionError(err instanceof ApiError ? err.message : 'Could not load the check-in message');
```

`new ApiError(404, 'tour_not_found', 'tour_not_found')` IS an `ApiError`, so the
ternary takes the first branch and renders `'tour_not_found'` - the raw code. The
fallback string is unreachable for any `ApiError`. Case 12 therefore FAILS before
Step 3, and it is absent from Step 2's red list (plan lines 1994-1999, which names
1, 2, 4, 5, 6, 9, 10, 11, 13, 14).

The failure mode this creates is the dangerous one. Step 2 tells the builder that
anything outside the red list which comes back red is a broken fixture, and the plan's
standing rule is "do not re-baseline a failing row". A builder who instead re-baselines
case 12 to `expect(...).toHaveTextContent('tour_not_found')` has just PINNED the raw
machine code in front of staff - the precise defect reviewer A's finding 2 exists to
fix, now protected by a test.

Fix: move 12 into the red list and restate it as "RED before Step 3: the catch renders
the raw code `tour_not_found`; after Step 3 the narrow routing sends every non-
`names_unavailable` failure to the load-shaped fallback." That also makes case 12 prove
something on its own rather than depending on case 11 for visibility.

## 3. [LOW] Case 10's fixture must dodge `previewHarness()`, the file's own helper for
GET-reminders tests, and the plan does not name it

Case 10 requires "the router's DEFAULT manual-only set (do not inject an empty one)".
That is achievable - `makeWebhookHarness()` with no `tourReminderManualOnlyKinds`
threads `undefined` into `createTourRemindersRouter`, which falls back to
`MANUAL_ONLY_REMINDER_KINDS` (`app/src/routes/tourReminders.ts:165`,
`app/src/routes/api.ts:932`). But `app/test/tourRemindersApi.test.ts:164-165` defines

```ts
function previewHarness(): ReturnType<typeof makeWebhookHarness> {
  return makeWebhookHarness({ tourReminderManualOnlyKinds: NO_MANUAL_HOLD_BACK });
}
```

which exists precisely because the hold-back masks the suppression estimates the
file's other GET-reminders tests assert. A builder writing a new GET-reminders test
reaches for it by name. With it, `paused` is false, `suppressionOf` is unassigned
after the containment, and the third branch yields `undefined` - so case 10's
"every upcoming rung STILL carries `{ reason: 'paused' }`" fails.

It fails LOUDLY, which is why this is LOW rather than higher: the builder gets a red
assertion, re-reads "do not inject an empty one", and switches. Naming the helper
("use plain `makeWebhookHarness()`, NOT this file's `previewHarness()`") costs four
words and removes the guess.

## 4. [LOW] The blank-preview note is gated on `state === 'upcoming'`, so the other
states that can carry an empty body still render bare - and `ScheduledCard` gets no
styling hook

Plan lines 2147-2153 gate the panel's note on
`rung.body === '' && rung.state === 'upcoming'`. That is the right primary case
(blank text beside a live Send-now button). But `bodyFor` withholds and the
pre-existing `UncomposableReminderError` catch empties on EVERY state, so:

- a `canceled` rung with an empty body renders a bare struck-through empty `<p>`;
- a `skipped` rung (now common - `booked_too_late` writes visible rows) with an
  entry-fork withhold, or with an unusable `scheduledAt`, renders a bare empty `<p>`
  under its "Skipped - ..." chip.

Neither is alarming the way the upcoming case is, so the narrow gate is defensible -
but it should be a stated choice rather than an artefact, because the same note would
read correctly on all three ("Preview unavailable" is cause- AND state-agnostic).

Separately: the plan tells the builder to "reuse the panel's existing muted-note
styling" and I confirmed `RemindersPanel.module.css` has `.muted` (`:16`) plus the
suppression-note block (`:149-159`), so that instruction lands. It gives
`ScheduledCard.tsx:98` no equivalent hook, and that file's `styles.scheduledBody`
does not resolve to a `ScheduledCard.module.css` in the same directory - the builder
has to go find the sheet. One clause would fix it.

---

## The five changes, tested for what they broke

**1. The containment rewrite (my r3 finding 1) - CLEAN, and the fix is correct.**
Containing at the CALL SITE (`:458`) and leaving `suppressionOf` unassigned is the
right shape, and it is strictly better than containing inside
`resolveTenantSuppression`, because the call-site try/catch also covers the
`conversations.findByParticipantPhone` read the function makes after the contact read.
I traced `suppressionOf`'s consumers: it is used at exactly one place, the chip ternary
at `routes/tourReminders.ts:481-489`, so leaving it unassigned has no other
consequence on the route. With the DEFAULT manual-only set every armed kind is in
`MANUAL_ONLY_REMINDER_KINDS` (`jobs/tourReminders.ts:163-168`), so the third branch
yields `{ reason: 'paused' }` for every upcoming rung - case 10's rewritten assertion
is exactly right, including its "NO recipient-derived reason" half, since the fallback
can only ever produce `paused`. The `nowIso` / `wallClockQuiet` computations above the
await are pure, so their position relative to the try block is immaterial. The
degradation "Paused" instead of a possibly-harder "contact opted out" is honest: the
harder reason's inputs are the thing that failed, and `paused` is true regardless.
The doubled tenant read is acknowledged in the plan with a reason and a
do-not-optimize instruction, which is the right disposition. Residual: finding 3.

**2. The force-send containment - CORRECT BEHAVIOUR, wrong explanation.** Finding 1.
The escape chain IS closed: `resolveReminderTarget:647` -> `forceSendReminder:1172`
-> the unwrapped handler at `routes/tourReminders.ts:365` on Express `^5.2.1` was the
whole chain, and wrapping the middle link closes it. The poll side is correctly left
alone (its throw lands in the per-row catch at `:490-497`). Note the boundary the plan
does not state: `forceSendReminder`'s own first read
(`deps.tourRemindersRepo.listByTour(tourId)`, `:1165`) and the route's two
`reminders.listByTour` calls (`:359`, `:374`) remain bare, so a reminders-table outage
still 500s send-now. That is consistent - those are row lookups, not name reads, and
spec 6.3b's obligation is scoped to names - so I am not raising it; it is recorded here
so the next reviewer does not re-derive it as a gap.

**3. The Set-union derivation - CLEAN. I re-ran the full matrix.** `reminderNamesUsed`
now yields, for all 15 (kind x tourType) cells, exactly what it yielded in round 3:
`confirmation` -> `{false,false}` (the union produces BOTH twins automatically, which
is the point); `day_before` / `morning_of` / `no_show_checkin` -> `{true,false}` (the
Set collapses the two identical ids); `en_route`/`self_guided` -> `{true,false}`;
`en_route`/`landlord_led` and `/pm_team` -> `{true,true}`. No regression, and the
last hand-mirror is gone.

The `forksOnPropertyName` change is the one place this could have gone wrong, and it
does not: the OR compares `idFor(k,true,true,tt) !== idFor(k,true,false,tt)` and
`idFor(k,false,true,tt) !== idFor(k,false,false,tt)` - **hasStreet is held CONSTANT
within each comparison and only hasName varies**, so the address fork cannot leak into
a name-fork answer. For `confirmation` both comparisons are equal-to-equal
(`tour.confirmation` vs itself, then the twin vs itself) -> `false`, correctly leaving
the deliberately-exempt address fork exempt. `en_route` x non-`self_guided` is still
the only `true`. Had the author written the union as a comparison across the address
axis instead, `confirmation` would have flipped to `true` and every confirmation
preview would blank on a unit-read blip - that is the trap, and it was avoided.

**4. The new tripwire row - IT FIRES.** I ran it against four activating edits:
adding `{propertyContactFirstName}` to `tour.morning_of`, to `tour.day_before`, to
`tour.confirmation_no_address` alone, and REMOVING it from
`tour.en_route_landlord_led` while keeping both entries. In the first three
`used.propertyContact` goes true while `forksOnPropertyName` stays false, so
`withholdPreview` stays false and `expect(impact.withholdPreview).toBe(used.propertyContact)`
FAILS. In the fourth `used.propertyContact` goes false while `entryCorrupted` stays
true, so `expect(impact.blocksSend).toBe(used.propertyContact)` FAILS. It also catches
a mistyped token constant (`{propertyContactFirstname}`), because the oracle and the
assessor would then disagree. And it is green on all 15 cells today - I checked each.
The tenant row now sweeping `TOUR_TYPES` closes my r3 finding 4: removing
`{tenantFirstName}` from `tour.en_route_landlord_led` alone now fails at line 945 for
`en_route/landlord_led`, which was the ninth of nine edits that previously escaped.

**5. The renderer copy and cases 11-14 - CLEAN apart from finding 4.** The blast-radius
check that mattered: `RemindersPanel.test.tsx`'s `rung()` helper defaults
`body: 'Your tour is tomorrow at 2pm.'` (`:35-44`), NOT `''`, so adding an empty-body
branch cannot silently reroute ~30 existing tests; and no existing dashboard test stubs
`body: ''` anywhere. The two-renderer sweep IS complete: `ScheduledCard` is imported by
exactly one non-test file (`dashboard/src/routes/contact/Timeline.tsx:26,2069`), and
the group thread renders scheduled cards through that same `Timeline`
(`ConversationDetail.test.tsx:241-244` states the path explicitly: "the GROUP thread
renders the SAME ScheduledCard as the contact timeline ... endpoint -> useRelayThread
-> Timeline -> card"). So `RemindersPanel` + `ScheduledCard` really are the only two
`body` readers, and all three withhold surfaces are covered by two renderer edits -
reviewer A's parenthetical was right and I nearly filed a false finding against it.
Case 11's field-agnostic fixture (`new ApiError(409, 'names_unavailable',
'names_unavailable')`) plus the `err.code` rule closes reviewer A's finding 2
correctly. Case 13's trace is right: self_guided -> no group branch -> the tenant read
throws -> the new catch -> refuse, row pending.

---

## Contesting the adjudications

Nothing to contest. Every round-3 adjudication produced the fix I would have asked for,
and two produced better ones than I proposed: the `reminderNamesUsed` union is cleaner
than my suggested version because it also generalises `forksOnPropertyName` across both
address branches, and the "give the blank a sentence" work (reviewer A's finding 3,
which I missed entirely in round 3) is the difference between a degraded panel and one
that reads as broken.

On the coordinator's overrule of the author's "out of scope" call for force-send
containment: the overrule was right, and reviewer A's consistency argument is the
decisive one - containing the GET and leaving the POST to 500 on the same outage, on
the same page, would have been indefensible. Finding 1 is about the copy the fix
reaches for, not about whether to fix it.

One correction to reviewer A's r3 finding 6, for the record: A is right that `bodyFor`
has FOUR call sites (`:323`, `:335`, `:379`, `:495`) and that my r2 finding 7 counted
`:323` twice. The plan's Task 5 text names four correctly; my summary count was wrong.

---

## Does a zero-context builder produce the spec?

Yes. Findings 1 and 2 are the two that would cost a builder something real - finding 2
because it can turn a mislabeled pin into a protected defect, finding 1 because it
leaves two statements in the plan contradicting a behaviour the plan itself
introduces. Both are text edits; neither changes a line of shipped logic beyond one
copy string. Findings 3 and 4 are polish.

This plan is now the most heavily instrumented one I have reviewed in this repo: every
derivation carries its fixture, every red state carries a "why it is red" note, both
docblock carve-outs are named by line, the two non-obvious preconditions on the shared
fixture are written out, the guards are labelled exempt from the red check, and the
tripwire explains what a red row means. The arithmetic has now survived four
independent passes without a single wrong expected value.

---

## Swept this round and found CLEAN (bank it)

- `reminderNamesUsed` and `forksOnPropertyName` across all 15 cells under the NEW
  Set-union derivation (above) - identical answers to round 3, address fork correctly
  not conflated.
- The new tripwire row is green on all 15 cells today and red on four distinct
  activating edits (above).
- `suppressionOf` has exactly one consumer (`routes/tourReminders.ts:485-488`), so the
  unassigned-on-failure shape has no other route consequence.
- `makeWebhookHarness()` with no `tourReminderManualOnlyKinds` reaches the router
  default (`routes/api.ts:932` -> `routes/tourReminders.ts:165`), so case 10's fixture
  requirement is satisfiable in `tourRemindersApi.test.ts` today.
- `refuse` is declared at `jobs/tourReminders.ts:1183`, BELOW the wrapper's insertion
  point - the plan's "inline the return" instruction is required, not stylistic.
- `RemindersPanel.module.css` has `.muted` (`:16`) and a suppression-note block
  (`:149-159`), so "reuse the panel's existing muted-note styling" resolves.
- No existing dashboard test stubs `body: ''`; `rung()` defaults a non-empty body.
- `ScheduledCard` has one non-test importer (`Timeline.tsx`), which serves both the
  contact timeline and the group thread - the two-renderer sweep covers all three
  withhold surfaces.
- The new operator copy is ASCII with plain hyphens and matches the existing
  `'Skipped - '` house style; staff-facing dashboard strings correctly stay inline
  rather than going through `MESSAGE_CATALOG` (which is for outbound tenant/landlord
  copy).
- Task 5's Files list, Interfaces block, Step 2 red list (with the case-12 exception in
  finding 2), Step 4 verification commands and Step 5 commit paths now all name the
  same set of files, including `RemindersPanel.tsx` and `ScheduledCard.tsx`.
