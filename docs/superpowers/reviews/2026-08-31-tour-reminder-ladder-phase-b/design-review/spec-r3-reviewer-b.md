# Spec R3 - adversarial design review (reviewer B, continued)

Spec under review:
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md` @`81152225`
Diff reviewed: `e272784f..81152225`. Repo read at `81152225`; base `main` @`ec32170a`.
Prior: `spec-r1-reviewer-b.md`, `spec-r2-reviewer-b.md`, `adjudications-r2.md`.

R2 findings verified closed in passing; nothing below re-opens one. This report
is the three newly load-bearing mechanisms plus a cold read of the revision.

**There ARE decision-changing findings** - four of them, all on the two
mechanisms invented in round-2 adjudication. Findings 1 and 2 say the fire-time
past-tour gate is scoped wrongly; 3 and 4 say `DISCONTINUED_REMINDER_KINDS` is
under-enumerated in the same way `MANUAL_ONLY_REMINDER_KINDS` was.

---

## 1. [HIGH] The past-tour gate is fatal by construction to `no_show_checkin`, and 6.1a's own rationale is exactly backwards for it

**Spec:** 6.1a - "**Scoped to ALL kinds, not just `en_route`.** A reminder for a
tour that has already started is useless by construction, and a gate that
applies to one rung is the kind of asymmetry the next reader deletes."

**What is wrong.** One rung's entire purpose is to fire after the tour:

`app/src/jobs/tourReminders.ts:153-154`

```
case 'no_show_checkin':
  return new Date(scheduled + 30 * 60 * 1000).toISOString();
```

`scheduledAt + 30m` is unconditionally past the tour start. So "useless by
construction" is false for it, and a gate keyed on "the tour has STARTED" is a
100% kill for that kind with the chip "the tour had already happened" - true, and
precisely backwards.

**Is it reachable today? No - I checked all four ways.** `REMINDER_KINDS`
excludes it (`:231-240`); the manual send is a composer PREFILL with no row
(`app/src/routes/tourReminders.ts:657-703`); the one seed that writes such a row
writes it SENT (`app/src/lib/seed/matrix.ts:884`, "no_show adds a **sent**
no_show_checkin at scheduledAt + 30m"; `:1044` confirms otherwise none), and
`listDue` filters `sentAt` (`app/src/repos/tourRemindersRepo.ts:220-221`). So the
gate is not a live break.

**It is a latent one, and the spec argues against the fix.** The kind is
deliberately retained everywhere - `computeDueAt`, `LADDER_ORDER`, the catalog,
`REMINDER_KIND_LABELS`, the panel - and it WAS auto-armed until 2026-07-21.
Re-arming it is a live product possibility (the ladder's own comment at `:231-234`
frames the removal as a judgment call, not a permanent one). The day someone does,
every rung dies silently and the reason chip lies. Worse, 6.1a's anti-asymmetry
sentence is the exact argument a future reader would use to delete the exemption
that fixes it.

**Implies.** The gate must be "all kinds whose dueAt is before the tour" - i.e.
exempt `no_show_checkin` explicitly, in the same file that defines its `+30m`
offset - and 6.1a must replace "useless by construction" with the real rule.
This is a one-line change and it costs nothing; leaving it is a trap with a
written justification attached.

---

## 2. [HIGH] The past-tour gate neuters the D7 pending-open bound and falsifies its comment - and 6.1a does not say where the gate sits relative to it

**Spec:** 6.1a - "Placed with the other pre-claim gates, ABOVE the claim."

**What is wrong.** One of those pre-claim gates is already bounded by tour start,
for the OPPOSITE purpose:

`app/src/jobs/tourReminders.ts:950-957`

```
// BOUNDED BY TOUR START: at/after the scheduled time the rung proceeds through
// today's fallback, so a morning_of reminder can never be held past the tour.
if (tour.tourType !== 'self_guided' && deps.pendingRosterActionsRepo !== undefined) {
  ...
  const beforeStart = typeof tour.scheduledAt === 'string' && now < tour.scheduledAt;
  if (pendingOpen?.status === 'pending' && beforeStart) { ... return; }
```

The D7 wait exists so a group-eligible rung held for a pending group open is
RELEASED at tour start and delivered 1:1 rather than waiting forever. Its bound
is a delivery guarantee. Add a gate that retires every rung at tour start and
both branches now end in "not sent": before the tour it waits, at/after the tour
it is claim-skipped. The comment's promise ("can never be held past the tour")
becomes vacuously true and the bound becomes dead code.

That may be an acceptable outcome - a reminder released a minute after the tour
starts is arguably not worth sending - but it is a decision, it silently deletes
a contact-rosters D7 behaviour, and it falsifies a comment the spec does not list
for rewrite (it lists the `LADDER_ORDER` docblock in 6.2 and the
`MANUAL_ONLY_REMINDER_KINDS` docblock in 3.1, so the omission reads as an
oversight rather than a choice).

**Implies.** 6.1a must state the gate's position in the pre-claim sequence
relative to `supersededInBatch` (`:888`), `isQuietTime` (`:910`), the D7 wait
(`:952`), the roster gate (`:976`) and the names bound, and say what happens to
the D7 bound. Order is not cosmetic here: the names bound (section 7) expires one
hour past `dueAt`, and for `en_route` (`dueAt = scheduledAt - 1h`) that is
EXACTLY tour start - so the two new gates fire at the same instant on the same
rung and produce different operator-facing chips (`names_unavailable` vs
`tour_already_passed`). Whichever is listed first wins, and the spec lists
neither.

---

## 3. [HIGH] `DISCONTINUED_REMINDER_KINDS`'s panel surface runs through a SHARED union whose precedence rationale inverts for it - and widening that union reaches the placement surface section 13 excludes

**Spec:** 3.1's table - "the panel chip derivation
(`routes/tourReminders.ts:589-597`) | reads 'no longer sent', never 'Paused'".

**What is wrong.** That derivation does not own its vocabulary. When an estimate
is computed it goes THROUGH the shared evaluator (`:590-597`), and the reason
union is shared with the placement ladder:

`app/src/services/scheduledSendSuppression.ts:1-4`

```
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours' | 'paused';
```

Two consequences, neither addressed:

**(a) The precedence rationale inverts.** `paused` is ranked BELOW kill-switch,
opt-out and manual mode with an explicit written reason
(`scheduledSendSuppression.ts:44-49`):

```
// BELOW every reason above, because all of them refuse a HUMAN send too: a
// paused rung invites "Send now", and telling the operator to send manually
// when the contact has opted out (or the kill switch is off) would send them
// into a refusal we could have named up front.
```

For a DISCONTINUED rung that argument reverses. 3.1's own table says force-send
REFUSES it, so it does not invite Send now - and masking "no longer sent" behind
"contact opted out" tells the operator to go fix an opt-out that will not help.
`discontinued` has to rank FIRST, above the kill switch, because it is the only
reason that is unconditional. The spec picks no position, and the file's whole
design is that "the whole precedence ladder stays in one place".

**(b) Widening the union is a compile error on the placement surface.**
`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:64` declares
`NUDGE_SUPPRESSION_LABELS: Readonly<Record<ScheduledSuppressionReason, string>>`
- exhaustive, so a new member forces an edit there. Section 13 excludes
`routes/placementNudges.ts` "in general". This is the dashboard twin, not the
route, but it is the same surface and the same exclusion's spirit. Either the
spec accepts a one-line label edit on an excluded surface, or the panel gets a
non-suppression path for discontinued. Both are fine; guessing is not.

---

## 4. [HIGH] `contactTimeline.ts` is a FOURTH surface, and emptying `MANUAL_ONLY_REMINDER_KINDS` makes it actively worse than today

**Spec:** 3.1 names three surfaces (poll filter, force-send, panel chip).

**What is wrong.** There is a fourth, with its own read of the set:

`app/src/routes/contactTimeline.ts:84,1091`

```
import { ..., MANUAL_ONLY_REMINDER_KINDS, ... }
const manualOnlyReminderKinds = deps.manualOnlyReminderKinds ?? MANUAL_ONLY_REMINDER_KINDS;
```

fed into the shared evaluator per rung at `:994-1005`
(`suppressionFor(tenantConv, false, row.dueAt, manualOnlyReminderKinds.has(row.kind))`,
helper at `:845-862`).

Trace it through the change. TODAY a pending `confirmation` on a 1:1-routed tour
chips `paused` on the contact page's Upcoming bucket. AFTER 3.1:
`MANUAL_ONLY_REMINDER_KINDS` is "genuinely emptied", the timeline has no
`DISCONTINUED_REMINDER_KINDS` read, so `paused` is false, the evaluator returns
`undefined`, and the rung renders with NO suppression at all - which
`ScheduledCard` presents as a send promise ("sending shortly" / "sends in 6
days", its own header, `dashboard/src/routes/contact/ScheduledCard.tsx:50`).

So this change REINTRODUCES the perpetual-"sending shortly" lie - on a rung the
same change guarantees will never send by any path - on the exact surface the
2026-08-20 pause chip was extended to cover. Today's behaviour is honest; the
spec's is not.

Section 8.2 deliberately excluded this file from `overdue` with a written reason.
Nothing excludes it from suppression, and 3.1's table omits it. An unmentioned
reader is where the rule silently disagrees with itself - 8.2's own words.

**Implies.** Add the timeline as a fourth row in 3.1's table (it needs the same
read and the same chip), or state why a discontinued rung is allowed to promise a
send there. `routes/relayGroups.ts`'s scheduled bucket is NOT affected - I checked,
it computes no suppression at all (no `evaluateScheduledSendSuppression` call in
the file).

---

## 5. [MEDIUM] `kind_retired` needs a FIFTH edit site, and the default behaviour there is actively harmful

**Spec:** 4.3 lists four sites per token; 3.1 adds `kind_retired` to the
force-send refusal union.

**What is wrong.** A force-send refusal reason is rendered to the operator
through a separate map:

`dashboard/src/api/types.ts:1294-1345` (`SEND_NOW_ERROR_COPY`) with
`sendNowErrorMessage(code)` falling back to
`"Couldn't send that just now - please try again."`

That fallback is deliberate and correct for `roster_unavailable` - the map's own
comment says so (`:1327-1330`: "the generic retry sentence is exactly right for a
transient failure"). For `kind_retired` it is the opposite: it tells the operator
to retry a send that will never succeed, forever, on a button that will never
work. So `kind_retired` needs its own sentence there, plus the `ForceSendRefusal`
union member (`app/src/jobs/tourReminders.ts:1299-1329`).

That makes six sites for this token, not four, and 4.3 presents its list as
complete. (Its dual-union claim also needs the qualification in finding 10.)

---

## 6. [MEDIUM] 6.1a does not say what force-send does with a past-tour rung, and both candidate answers are already constrained by other sections

The gate is specified as a claim-skip on the poll. Nothing says whether "Send
now" is blocked. Three sections already have opinions:

- 4.2 implies it IS blocked: "the operator retains Send now on every rung of a
  tour that has NOT happened."
- 7.2 forbids the obvious implementation: "a human action must never retire a
  rung" - so it must be a REFUSAL, which means yet another `ForceSendRefusal`
  member and another `SEND_NOW_ERROR_COPY` entry (finding 5's shape again).
- The live operator case cuts the other way: a tenant is ten minutes late, the
  operator presses Send now on `en_route`. A strict "has started" gate refuses
  the one hand-send most likely to be useful at that moment.

**Implies.** Rule it. This is a human-facing path and a builder cannot infer the
answer from 6.1a as written.

---

## 7. [MEDIUM] Section 10's replacement unit vehicle gains a hidden precondition from 6.1a that nobody stated

**Spec:** 10 - "A test-only helper calling
`tourRemindersRepo.create({tourId, kind, dueAt: now0})` yields an
immediately-due row of any kind with ZERO production code."

**What is wrong.** After 6.1a that is no longer sufficient: the fixture's tour
must ALSO satisfy `now < tour.scheduledAt`, or the poll retires the row instead
of sending it. The vehicle says nothing about `scheduledAt`, and the fixtures it
will be applied to carry hardcoded absolute dates -
`app/test/tourReminders.test.ts:861` (`2026-01-06`), `:915`, `:983`, `:1071`,
`:1123` (`2026-01-15`), `:1024`, `:1117` (`2026-01-16`), `:2505` (`2026-02-11`),
`:802` (`2026-09-10`). Whether each converted site picks a `now0` before its
tour's `scheduledAt` is exactly what a mechanical conversion does not think
about, and the failure mode is a green-looking "the reminder did not send"
assertion for the wrong reason.

Blast radius UNVERIFIED - I did not run the suite. But section 10's instruction
is now incomplete, and 10a.1's "immediate-send rides ... CONVERT per section 10"
inherits the gap.

---

## 8. [MEDIUM] 6.1a changes documented e2e behaviour silently, and 10a has no row for it

`e2e/tests/scenarios/tours.spec.ts:283-287`:

```
// The tenant never shows. The no-show check-in is no longer auto-armed - it is
// a MANUAL send now ..., so ticking past its OLD due time fires the earlier
// rungs (unasserted) but never the check-in body.
await flow.tickTourReminders(justAfter(times.noShowCheckin));
await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.no_show_checkin);
```

`times.noShowCheckin` is `scheduledAt + 30m`, so this tick is PAST the tour.
Under 6.1a those "earlier rungs" are claim-skipped `tour_already_passed` rather
than fired. The assertion is an ABSENCE check, so it still passes - which is
worse than a failure: the documented behaviour changes with nothing going red.
10a.1's category 2 is about `confirmation` arm-time semantics and does not cover
this; 10a needs a fourth category for "sites whose tick crosses the tour start".

For contrast, and recorded so it is not re-derived: `quiet-hours.spec.ts:373-377`
ticks at `dueAt + 5h` where `dueAt` is `day_before` (19:30 the evening before), so
`now` is 00:30 on tour day - still before the tour. That test survives, and it is
the canonical proof that a quiet-hours-deferred rung still fires on a later tick,
which 6.1a deliberately preserves. Verified safe.

---

## 9. [MEDIUM] 3.1's "its docblock stays TRUE" holds for one line out of about thirty

**Spec:** 3.1 - "`MANUAL_ONLY_REMINDER_KINDS` is then genuinely emptied and its
docblock's 'TO RESTORE: empty this set. Nothing else has to change' stays TRUE -
which is the test that the two concepts have been separated properly."

The test is a good one and it passes. But the docblock is
`app/src/jobs/tourReminders.ts:173-206`, and the rest of it does not survive:

- "Tour reminders are MANUAL ONLY. The ladder still ARMS every rung on booking
  ... but the poll never sends one on its own." - false.
- "**`confirmation` is INCLUDED (Cameron's explicit call)** ... its inclusion is
  a deliberate decision, not a side effect of pausing the ladder." - now points
  at the wrong set entirely; `confirmation` is excluded from THIS one and lives
  in the new one for a different reason.
- The header is `do-not-remove-without-reading - FOUNDER DECISION, 2026-08-20,
  TEMPORARY`.

An empty `ReadonlySet` under thirty lines describing a live pause is what the
next reader deletes - taking with it the `manualOnlyKinds` dep seam that
`routes/tourReminders.ts:107-117` and the quiet-hours e2e still use. Say what the
docblock becomes: a historical record of a lifted decision plus a live test seam.

---

## 10. [LOW] `kind_retired` is not the same dual-union shape as its cited precedents

3.1 - "`kind_retired` therefore spans the skip union AND the force-send refusal
union, exactly as `roster_unavailable` and `names_unavailable` already do."

Not quite. Those two are written as skips BY THE POLL
(`claimSkipRow`, `app/src/jobs/tourReminders.ts:989`, and section 7's new bound).
Under 3.1 the poll EXCLUDES discontinued kinds from `dueRows` rather than
skipping them, so `kind_retired`'s skip half has NO in-app writer at all - the
ops sweep is its only producer. That is fine functionally, but `claimSkipRow`'s
docblock (`:640-643`) currently splits reasons into arm-only ("`booked_too_late`
... must NEVER be passed here") and claim-time; this adds a third, sweep-only
category, and the docblock is where a builder checks before passing a token.

---

## 11. [LOW] 6.1a does not say what the gate does when `scheduledAt` is absent

A timeless tour arms nothing (`app/src/jobs/tourReminders.ts:284-288`), but a
row can outlive a later status change, and today such a rung retires as
`invalid_schedule` at compose (`app/src/messages/tourCopy.ts:95-99` via
`claimSkipRow` at `:1034`). The new gate sits ABOVE compose, so it must NOT fire
on an absent or unparseable `scheduledAt` or it steals the more accurate token.
One clause; the existing `beforeStart` at `:956` already shows the shape
(`typeof tour.scheduledAt === 'string' && ...`).

---

## 12. [LOW] "start passed" is already the name of a different gate

`e2e/tests/tour-no-show-checkin.spec.ts:21-23` refers to "the 'start passed'
gate" as something that reads the CLIENT wall clock - the dashboard's
Send-no-show-check-in affordance, not a server rule. 6.1a's server-side gate
keyed on the same phrase will collide with it in every future grep, on the one
kind finding 1 is already about. Name it after its token
(`tour_already_passed`), not after the condition.

---

## 13. [LOW] `ANONYMOUS_JOINED_LABEL`'s disposition is unstated, and gate 5 will notice

9.4 gives `{name}` the fallback `a new member`, "Lower-cased from the existing
constant". The constant is `ANONYMOUS_JOINED_LABEL = 'A new member'`
(`app/src/jobs/relayFanOut.ts:222-224`) and its only consumer is the `{joined}`
build inside `composeMemberAddedBody` (`:250-262`), which 9.4 deletes. Left in
place it becomes an unused module const in a file this branch edits, which gate 5
(`npx eslint <touched files>`) attributes to this branch. Say reuse-lower-cased
or retire.

---

## Verified in passing (R2 findings, and two claims worth not re-deriving)

- R2-1 -> 6.1a exists and correctly states there is no past-tour gate today; I
  re-confirmed the only `scheduledAt` comparison on the send path is `beforeStart`
  at `:956`. Findings 1, 2, 6, 7, 8, 11, 12 are all about the REMEDY, not the
  finding.
- R2-2 -> the separate `DISCONTINUED_REMINDER_KINDS` is the right shape and its
  three-surface diagnosis of the old remedy is exactly right. Findings 3, 4, 5,
  10 are about its enumeration.
- R2-3, R2-5, R2-6, R2-7, R2-8, R2-9, R2-10, R2-11, R2-12, R2-13, R2-14 all
  properly incorporated; I re-read each edit and have nothing to add.
- R2-4 -> 10a.2's tripwire table matches what I found. It correctly labels itself
  a FLOOR.
- 6.2's `undefined` guard is now written as
  `otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso`, with
  the right polarity. Correct.
- The e2e tick's discontinued-bypass ban (section 10) is right and is the
  consistent reading of the DELIBERATE DIVERGENCE comment at
  `app/src/routes/dev.ts:404-421`.
