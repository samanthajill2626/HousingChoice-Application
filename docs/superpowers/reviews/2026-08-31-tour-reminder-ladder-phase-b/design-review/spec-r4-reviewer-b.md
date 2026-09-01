# Spec R4 - adversarial design review (reviewer B, final round)

Spec under review:
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md` @`075b2faa`
Diff reviewed: `81152225..075b2faa`. Repo read at `075b2faa`; base `main` @`ec32170a`.
Prior: R1/R2/R3 reviewer-B reports, `spec-r1-reviewer-a.md`, `adjudications-r3.md`.

**Headline: no BLOCKING findings, and no finding that reverses a decision.** The
design is sound and I could not break it. What follows is one gap that changes
where a line of code goes (finding 1), three internal inconsistencies the last
round's remedies left behind, and one readability problem that is a real risk at
this stage.

I answered all three of the questions asked. Two of them come back clean and I
have recorded the derivations so nobody repeats them.

---

## 1. [HIGH] 6.1a's precedence list omits the two gates that actually run FIRST, and the natural reading of it re-opens ledger item 8 on a routine path

**Spec:** 6.1a - "**PRECEDENCE.** Position is behaviour, and this gate collides
with two existing ones (R3-2). Evaluated in this order, most-specific first:
1. past-tour gate 2. the group-open-pending bound (`beforeStart`, `:956`)
3. the names bound (section 7)."

**What is wrong.** Those are not the first gates in `processReminderRow`. Two
others run above both of them:

`app/src/jobs/tourReminders.ts:888-902` - `supersededInBatch`, then
`:910-916` - `isQuietTime`.

The list names only gates at `:956` and below (the names bound is at compose,
`:1025-1045`). A builder placing the new gate "most-specific first" relative to
THAT list will insert it just above `:952` - which is BELOW `supersededInBatch`.
That is the natural reading and it is the wrong one.

**What breaks.** On a post-tour catch-up batch - the exact scenario 6.1a exists
for - both `morning_of` and `en_route` are due and both are past-tour. Processing
`morning_of` first: `supersededInBatch` sees `en_route` in the batch (higher
`LADDER_ORDER` index, same tourId, no armability or gate check at `:889-894`) and
claim-skips it `quiet_hours_superseded`. Then `en_route` reaches the new gate and
is claim-skipped `tour_already_passed`.

The panel then shows `morning_of` reading **"superseded by a later reminder"**
beside the rung it names reading **"the tour had already happened"**. That is
verbatim the shape section 12 describes when disposing of ledger item 8: "the
panel chip 'superseded by a later reminder' - while the rung it names sits beside
it reading 'booked too late for this reminder'."

Section 12 dropped item 8 on a cost-in-MESSAGES criterion ("for it to cost a
message, the later rung must fail for a reason that would not also have killed
the earlier one"), and that criterion still holds - the past-tour gate is
per-TOUR and kills both identically, so no message is lost. **The disposition
survives; what does not survive is its reachability estimate.** Item 8 was
assessed as needing "worker downtime AND a landlord-led tour AND a live database
read failure, simultaneously". The chip-level instance now needs only worker
downtime, which is the routine case.

Placing the gate ABOVE `supersededInBatch` closes it for free and gives both
rungs the honest token. Placing it above `isQuietTime` too matters for the same
reason in the other direction: a past-tour rung due inside a quiet window
currently defers with no claim and re-lists every tick until quiet-end; above
`:910` it retires at once.

**Implies.** Extend 6.1a's precedence list to all five gates, with the past-tour
gate FIRST - above `supersededInBatch` (`:888`) and `isQuietTime` (`:910`), not
merely above `beforeStart` (`:956`). One sentence, and it is the difference
between the gate improving the panel and the gate putting a new falsehood on it.

---

## 2. [MEDIUM] 6.1a narrowed the gate's predicate; section 4.2 still carries the old one, so the sweep and the runtime now disagree about the same row

**Spec:** 6.1a - "A rung WHOSE OWN dueAt IS BEFORE THE TOUR, on a tour that has
already started". Section 4.2, unchanged - "**Population A** ... Every PENDING
rung of **any kind** on a tour whose `scheduledAt` is in the past at sweep time."

**What is wrong.** 6.1a's whole R3-1 remedy was that "any kind" is wrong because
`no_show_checkin` is due at `scheduledAt + 30m`
(`app/src/jobs/tourReminders.ts:153-154`) and must survive. Population A was not
given the same qualifier, so the ops sweep would retire exactly the row the
runtime gate now protects, stamping it `tour_already_passed`.

6.1a's own closing sentence says the gate "makes the sweep what it should have
been: cleanup of a condition the RUNTIME also enforces". After R3-1 the two
enforce different conditions.

Unreachable today - I re-verified in R3 that no pending `no_show_checkin` row can
exist (`REMINDER_KINDS` excludes it at `:231-240`; the manual send is a composer
prefill with no row, `routes/tourReminders.ts:657-703`; `matrix.ts:884` seeds it
SENT and `listDue` filters `sentAt`). But population A is written as an
all-kinds rule and the planner is a PURE function that will be unit-tested
against its stated rule, so the divergence gets baked in.

This is the same failure shape as R2-8 (population B's rationale left stale when
3.1 changed underneath it). It is the second time a section-4 population has not
been re-read after a section-3/6 ruling.

**Implies.** Give population A the same qualifier, in the same words, and say the
sweep planner and the runtime gate share one predicate.

---

## 3. [MEDIUM] 6.1a's force-send rule hard-codes the kind name that its own poll rule was rewritten to stop hard-coding

**Spec:** 6.1a - "So the principle is **'a rung whose own copy assumes the tour
has not happened yet'**, and the qualifier derives the exemption from the
ladder's own data rather than **from a name in a list**." Then, four paragraphs
later - "**Force-send** on a past-tour rung REFUSES with `tour_already_passed`,
**EXCEPT `no_show_checkin`**."

**What is wrong.** The two rules are stated in incompatible styles for the same
exemption, and the second one is the style the first one explicitly rejects.
Either:

- force-send uses the same derived predicate (dueAt before the tour), in which
  case `no_show_checkin` is exempt automatically and the named exception is dead
  text that will be read as authoritative and copied into the code; or
- force-send uses a bare "tour has started" test, in which case the two gates
  have different shapes and any FUTURE kind with a post-tour dueAt is silently
  refused on the human path while sending fine on the poll.

There is a third problem: the exception cannot fire today. `forceSendReminder`
resolves its row from `listByTour` (`app/src/jobs/tourReminders.ts:1373-1375`),
and no pending `no_show_checkin` row can exist (finding 2's evidence). So the
named exception protects nothing now and mis-shapes the rule later.

**Implies.** State the force-send gate with the SAME derived predicate and delete
"EXCEPT `no_show_checkin`". The intent 6.1a wants to preserve - "a tenant who did
not show is exactly when an operator reaches for that button" - is preserved
automatically, and is worth keeping as the rationale sentence.

---

## 4. [MEDIUM] Site 6 of the six-site inventory has no enforcement, which is the exact trap 4.3's own boxed warning was written about

**Spec:** 4.3 - "**A token that ALSO appears in the force-send refusal union needs
two more sites - six, not four** ... 6. `SEND_NOW_ERROR_COPY` in the dashboard."

**What is wrong.** 4.3's headline lesson (from M6) is that an inventory is only
as good as what enforces it: sites 2 and 3 are enforced by the exhaustive
`Record` type, and "Site 4 is what makes sites 2 and 3 enforceable". Site 6 has
NOTHING.

`SEND_NOW_ERROR_COPY` is `Readonly<Record<string, string>>`
(`dashboard/src/api/types.ts:1294`) - a string key, not a union - so a missing
entry is not a type error. And there is no completeness test: `types.test.ts:33-37`
tests completeness for `suggestionResolutionErrorMessage` (a different map), and
`sendNowErrorMessage` gets one spot-check at `:82-84`
(`expect(sendNowErrorMessage('breaker_open')).toBe(...)`).

So a builder can add `kind_retired` and `tour_already_passed` to the refusal
union, ship, and have both silently fall back to "Couldn't send that just now -
please try again." - which 4.3 itself calls "ACTIVELY WRONG" for these two.

**Implies.** Say site 6 is unenforced and name what to do about it. The cheap
option is a test mirroring `types.test.ts:33-37` over the send-now codes; the
cheaper one is a sentence telling the builder the compiler will not catch this.
Do not leave a six-site list that reads as if all six are enforced when 4.3's own
argument is that this is precisely how tokens get lost.

---

## 5. [MEDIUM] "Discontinued is evaluated ABOVE the shared suppression ladder" is ambiguous at the one spot the file already documents a bug

**Spec:** 3.1a - "**Discontinued is evaluated ABOVE the shared suppression
ladder, not inside it.**"

**What is wrong.** In `routes/tourReminders.ts` the "ladder" is reachable two
ways, and only one of them exists for every tour:

`app/src/routes/tourReminders.ts:590-597`

```
const suppression =
  state !== 'upcoming' ? undefined
  : suppressionOf !== undefined ? suppressionOf(row.dueAt, paused)
  : paused ? ({ reason: 'paused' } as const) : undefined;
```

`suppressionOf` is only built for `tour.tourType === 'self_guided' && hasUpcoming`
(`:506`). The third branch exists specifically because group-routed tours never
get it, and the file spends seven lines saying why (`:576-584`): "Without the
second branch a landlord_led / pm_team panel would keep chipping 'sending
shortly' for a rung the poll will never pick up: the perpetual-'sending shortly'
lie claimSkip exists to prevent."

"Above the ladder" reads equally as "above the `evaluate` call inside the
closure" - which puts it inside `suppressionOf` and loses it for every
group-routed tour, reproducing the documented bug on the discontinued rung.

**Implies.** Say "above the whole ternary, so it is emitted for group-routed
tours too" - and the same for the timeline's `suppressionFor`
(`routes/contactTimeline.ts:845-862`), which has no equivalent fallback branch at
all because its walk returns `[]` for group-routed tours (`:985-990`). One
clause each.

---

## 6. [MEDIUM] The document now argues with its own previous drafts more than it instructs, and two passages quote a withdrawn rule verbatim beside the live one

The coordinator asked whether four rounds have left something correct and
unreadable. Measured: **51 lines carry a review back-reference** ("design review
R1/R2/R3", "R3-n", "an earlier draft", "that reasoning is withdrawn", "Round 1
wrote"), spread across sections 3.1, 3.1a, 4.2, 4.3, 6.1a, 6.2, 7, 8.2, 9.2,
9.3, 9.4, 10, 10a.

Most are harmless provenance. Two are not, because they state the withdrawn rule
in full, in the imperative, adjacent to the live one:

- **6.1a** (`:370-373`): "An earlier draft argued the gate should cover ALL kinds
  because 'a gate that applies to one rung is the kind of asymmetry the next
  reader deletes' - that reasoning is withdrawn". A builder skimming for the rule
  finds "cover ALL kinds" in quotation marks two lines below the RULED sentence.
  This is the same section as finding 3, where the live text already contains two
  incompatible statements of one exemption; the withdrawn quote makes three.
- **3.1** (`:68-80`): the rejected `MANUAL_ONLY_REMINDER_KINDS` remedy is laid out
  as a two-bullet table of behaviours before the real ruling arrives.

This matters more than style at handback: `AGENTS.md` requires the review records
to be committed under `docs/superpowers/reviews/<date>-<branch>/`, and they are -
four reports and three adjudication files. The archaeology is preserved
independently, so the spec does not need to carry it.

**Implies.** Not a rewrite. Cut the two withdrawn-rule quotations to a bare
pointer ("an earlier draft scoped this to all kinds; see
`design-review/adjudications-r3.md` M/R3-1"), and let the rest stand. A builder
who has never seen this conversation should be able to read section 6.1a
top-to-bottom and find exactly one statement of the gate.

---

## 7. [LOW] "Absent `scheduledAt`" should read "absent or unparseable"

6.1a - "**Absent `scheduledAt`:** the gate does NOT apply, and `invalid_schedule`
keeps the rung (R3-11)."

An unparseable-but-present `scheduledAt` is reachable and is an existing test
fixture (`app/test/tourReminders.test.ts:871`,
`tours.patch(tour.tourId, { scheduledAt: 'not-an-instant' })`). The existing
`beforeStart` check compares ISO strings lexicographically
(`app/src/jobs/tourReminders.ts:956`), so a naive `now > tour.scheduledAt` gate
happens to answer false against `'not-an-instant'` (digits sort below letters)
and the rung correctly falls through to `invalid_schedule` at compose. Right
answer, accidental mechanism. Since 6.1a is specifying a NEW gate, say both
cases.

---

## The three questions, answered

### Do 6.1a's five rules cohere?

Four of the five do. The scope qualifier, the absent-`scheduledAt` rule, the
naming rule and the placement-above-the-claim rule are mutually consistent, and
the absent-`scheduledAt` rule is correctly ordered against compose (the gate at
position 1 declines, control reaches `:1029-1035`, `invalid_schedule` is
stamped). The precedence rule is incomplete (finding 1) and the force-send rule
is stated in a style that contradicts the scope rule (finding 3).

One sub-claim I checked and it HOLDS: "the names bound ... for `en_route` lands
at the SAME instant as the past-tour gate (`dueAt + 1h` and `scheduledAt`
coincide for that rung)". With the arm-time exemption, `en_route`'s dueAt is
`scheduledAt - 1h` (`app/src/jobs/tourReminders.ts:145-152`, unclamped), so
`dueAt + 1h === scheduledAt` exactly and both gates trip at `now > scheduledAt`.
Correct, and it is why the precedence ruling was needed.

### Do 6.2's widened predicate and 6.1a's gate ever disagree about the same rung?

**No. I could not construct an input where they conflict, and the structural
reason is clean enough to record so nobody re-derives it.**

At arm time, `supersededBySlot` requires `otherDue < scheduledIso` - the
superseding rung must fire before the tour - and the rung being superseded has
already passed the `past_event` check at `:394-410`, so its own dueAt is also
before the tour. Both rungs in any supersession pair are therefore pre-tour, and
the fire-time gate (which only retires pre-tour-dueAt rungs on a started tour)
never contradicts a decision the arm-time predicate made.

I also checked the sharper question the widening could have re-opened: **does
`otherDue <= dueAt` create a NEW arm-time instance of ledger item 8** (a rung
retired citing a superseder that was itself dropped)? It does not, and section
12's disposition survives unchanged:

- The only rung whose dueAt the exemption moves is `en_route`, so it is the only
  new candidate superseder. `en_route` is never `booked_too_late` (that rule
  covers `day_before` and `morning_of` only, `:368-374`), so its only invisible
  retirement is the silent `dueAt < now` drop at `:390-393`.
- For `morning_of` to be superseded citing a dropped `en_route` you need
  `dueEnRoute < now <= dueMorningOf`. Since `dueEnRoute = scheduledAt - 1h`, that
  forces `now > scheduledAt - 1h`, which makes `morning_of` `booked_too_late`
  (same local date, `now > scheduledAt - 6h`) - UNLESS `now` is on a different
  local date from the tour, which forces the tour into the first hour after local
  midnight. In that window `morning_of`'s raw dueAt is 20:00-21:00 the previous
  evening; for it to be later than `now` it must clamp forward, and clamping
  sends it to the window END on the tour's date, which is `>= scheduledAt` -
  so `past_event` retires it at `:394` before supersession is ever evaluated.
  Every path closes.
- The `day_before`/`morning_of` pair closes on a simpler mutual exclusion:
  `day_before` survives its own booked-too-late rule only while
  `now <= rawDayBefore - 4h` (the day before the tour), and `morning_of` is
  `booked_too_late` only when `localDateOf(now) === tourLocalDate`. Both cannot
  hold.

Where they DO interact is fire-time, and that is finding 1.

### Is the inventory in 3.1/3.1a/4.3 complete?

Complete on sites; findings 4 and 5 are about enforcement and placement, not
missing surfaces. I re-grepped for readers of the two kind-sets and found no
fifth: `MANUAL_ONLY_REMINDER_KINDS` is read at `jobs/tourReminders.ts:602`,
`routes/tourReminders.ts:173`, `routes/contactTimeline.ts:1091`, and injected at
`routes/dev.ts:421` and `routes/api.ts:938` - all four behavioural ones are now in
3.1's table. `ScheduledSuppressionReason`'s consumers are
`services/scheduledSendSuppression.ts:1`, `dashboard/src/api/types.ts:1144`,
`REMINDER_SUPPRESSION_LABELS` (`types.ts:1259`) and `NUDGE_SUPPRESSION_LABELS`
(`DeadlinesNudgesCard.tsx:64`) - 3.1a names the compile-forcing one and the
tour-side map is implied by its own exhaustive `Record`. `relayGroups.ts`
computes no suppression at all (verified in R3).

---

## Verified in passing

All thirteen R3 findings are incorporated; I re-read each edit. Three worth
naming because the remedy is better than the finding asked for: R3-1's derived
qualifier ("a rung whose own copy assumes the tour has not happened yet") is a
stronger rule than the kind-exemption I proposed; R3-3's narrowing of section 13
rather than breaking it is the right call and the "build completeness, not
feature work" framing will stop a builder inventing a workaround; and 3.1's
"Standing hazard for the plan" note about grepping for READERS is the correct
generalization of what this review kept finding.

Findings 2, 3 and 5 above are all cases of question 2 - a remedy that answered
its finding and left an adjacent statement stale. That is now the failure mode
this document has, and it is a cheap one to close.
