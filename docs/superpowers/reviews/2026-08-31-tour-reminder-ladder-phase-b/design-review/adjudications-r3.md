# Spec design review - round 3 adjudications

Continues `adjudications.md` (R1) and `adjudications-r2.md` (R2). Reviewer B
continued again.

**13 findings - 13 ACCEPTED, 0 rejected. NO BLOCKING findings.**

## Trajectory, stated before the findings because it governs whether round 4 runs

| round | BLOCKING | HIGH | total | new design directions opened |
|---|---|---|---|---|
| R1 (two reviewers) | 3 | 6 | 19 merged | 2 |
| R2 | 2 | 4 | 14 | 2 |
| R3 | 0 | 4 | 13 | 0 |

Every R3 finding is a CONSEQUENCE of the two mechanisms invented during R2
adjudication - the fire-time past-tour gate (6.1a) and
`DISCONTINUED_REMINDER_KINDS` (3.1). None opens a new direction, none reverses a
locked decision, and all thirteen are resolvable by ruling on a case the spec
left open rather than by redesigning anything. That is convergence.

The lesson, recorded because it is the reusable one: BOTH rounds' worst findings
were in mechanisms added during the previous round's adjudication. Adjudication
writes new, unreviewed design under time pressure, and it is the least-reviewed
text in the whole document. R3 confirms the pattern a third time at lower
severity.

## R3-1. ACCEPT [HIGH] - the past-tour gate is fatal to `no_show_checkin`

The failure I flagged when dispatching this round, confirmed. `no_show_checkin`'s
dueAt is `scheduledAt + 30m` (`app/src/jobs/tourReminders.ts:153-154`), so a gate
on "the tour has started" kills the ONE rung designed to fire after it - the rung
whose entire purpose is asking a no-show whether they need to reschedule.

Worse, 6.1a's own reasoning is what would delete the exemption later: "useless by
construction" and "a gate that applies to one rung is the kind of asymmetry the
next reader deletes" both argue AGAINST the carve-out this rung needs.

**Spec change.** The gate is scoped to rungs whose dueAt is BEFORE the tour -
which is every auto-armed kind and excludes `no_show_checkin` by construction
rather than by a name in a list. 6.1a's anti-asymmetry paragraph is rewritten so
it can no longer be read as an argument against the exemption: the principle is
"a rung whose OWN copy assumes the tour has not happened yet", not "any rung".

## R3-2. ACCEPT [HIGH] - the gate's POSITION is unruled, and it collides twice

6.1a said "with the other pre-claim gates" without saying WHERE, and position is
behaviour here:

- it neuters the group-open-pending bound (`beforeStart`,
  `app/src/jobs/tourReminders.ts:956`) and falsifies that branch's comment about
  a rung never being held past the tour;
- for `en_route` it lands at the same instant as the names bound from section 7
  (dueAt + 1h vs scheduledAt, which for `en_route` are the same moment), so two
  gates claim the same rung with different tokens.

**Spec change.** Explicit ordering, stated as a numbered precedence with its
reasoning: past-tour gate FIRST (it is the most specific and most truthful cause
- the tour happened), then the pending-open bound, then the names bound. The
`beforeStart` comment joins the rewrite list.

## R3-3. ACCEPT [HIGH] - the discontinued chip runs through a SHARED union, and widening it breaks the excluded surface

VERIFIED: `ScheduledSuppressionReason` is declared once
(`app/src/services/scheduledSendSuppression.ts:1`) and mirrored on the wire
(`dashboard/src/api/types.ts:1144`), and `DeadlinesNudgesCard.tsx:64` consumes it
as an EXHAUSTIVE `Record<ScheduledSuppressionReason, string>`. So adding a
`discontinued` reason is a COMPILE ERROR on the placement card - the surface
section 13 excludes.

**Spec change, and the exclusion is narrowed rather than broken.** Widen the
union and add the one label entry the placement card needs to compile. That is
build completeness, not feature work: section 13 excludes BUILDING the overdue
twin on the placement surface, and continues to. The spec now says so explicitly
so a builder does not treat a required one-line map entry as a scope violation
and work around it.

The reviewer's second half - that the shared precedence rationale in
`scheduledSendSuppression.ts` inverts for this reason (a harder reason normally
wins, but "discontinued" is not a suppression that a harder reason should
override; it is terminal) - is accepted. The spec now rules that discontinued is
evaluated ABOVE the shared ladder, not inside it, so the ladder's written
rationale stays true for the reasons it was written about.

## R3-4. ACCEPT [HIGH] - `contactTimeline.ts` is a FOURTH manual-only reader

VERIFIED: `app/src/routes/contactTimeline.ts:84` imports
`MANUAL_ONLY_REMINDER_KINDS` and `:1091` reads it into its own
`manualOnlyReminderKinds`. Emptying the set without giving that surface the
discontinued read reintroduces the perpetual-"sending shortly" lie on a rung that
can never send - the exact defect the 2026-08-20 pause chip exists to end, on the
contact timeline instead of the tour panel.

**Spec change.** 3.1's surface table grows to four rows. This is the third time
this review has caught an unenumerated reader (M3 previews, M5 view builders, now
this); the spec now states that as a standing hazard for the plan rather than
fixing three instances and hoping.

## R3-5. ACCEPT [MEDIUM] - `kind_retired` needs SEND_NOW_ERROR_COPY: six sites, not four

Section 4.3 presents four edit sites per token as complete. A token that also
appears in the force-send REFUSAL union needs the dashboard's send-now copy map
too, and here the generic "please try again shortly" fallback is ACTIVELY WRONG -
retrying will never work.

**Spec change.** 4.3's table gains the two refusal-path sites, marked as applying
only to tokens that span both unions (`kind_retired` does; `tour_already_passed`
does under R3-6; `names_unavailable` already has its deliberate generic
fallback).

## R3-6. ACCEPT [MEDIUM] - force-send on a past-tour rung is unruled

**Spec change - RULED:** force-send REFUSES for a rung whose tour has already
started, with `tour_already_passed`, EXCEPT `no_show_checkin`, which is exactly
the rung an operator wants for a tenant who did not show. This preserves the
standing posture that a human action never RETIRES a rung (refusal, not
claim-skip) while keeping the one late-tour send that is meant to exist.

## R3-7 to R3-13. ACCEPTED - precision and disposition

- **R3-7** section 10's unit vehicle gains an unstated precondition from 6.1a
  (`now < tour.scheduledAt`), against fixtures with hardcoded absolute tour
  dates. Stated, and 10a.1 gains it as a conversion criterion.
- **R3-8** `e2e/tests/scenarios/tours.spec.ts:283-287` ticks past the tour and
  documents that earlier rungs fire. 6.1a changes that behind an ABSENCE
  assertion, so it would change silently. Added to 10a as a fourth category:
  sites whose behaviour changes without their assertions failing - the most
  dangerous kind, because the suite stays green.
- **R3-9** 3.1's "its docblock stays TRUE" holds for one line of about thirty
  (`app/src/jobs/tourReminders.ts:173-206`); the rest still explains
  `confirmation`'s membership and now points at the wrong set. Full rewrite,
  not a one-line edit.
- **R3-10** `kind_retired`'s "dual-union shape" is not quite the
  `roster_unavailable` precedent: the poll EXCLUDES rather than claim-skips, so
  its skip half has no in-app writer (only the sweep script writes it). Accepted
  and stated - it adds a third category to `claimSkipRow`'s docblock taxonomy
  and that docblock joins the rewrite list.
- **R3-11** the gate's behaviour with an absent `scheduledAt` is unstated, where
  firing would steal the more accurate `invalid_schedule` token. Ruled: no
  `scheduledAt` means the gate does not apply and `invalid_schedule` keeps the
  rung.
- **R3-12** "start passed" already names a different, CLIENT-side gate
  (`e2e/tests/tour-no-show-checkin.spec.ts:21-23`) on the very kind R3-1
  concerns. Naming ruled to avoid the collision.
- **R3-13** `ANONYMOUS_JOINED_LABEL`'s disposition is unstated; left unused in a
  file this branch touches, gate 5 attributes the `no-unused-vars` to this
  branch - the exact baseline-attribution trap AGENTS.md warns about. Ruled:
  the constant is REPLACED by the lower-cased totality value, not left beside it.

## Round 4

R3 changed decisions (R3-1, R3-2, R3-3, R3-6 are behavioural rulings), so the
loop is not terminal by the stop rule. Round 4 is the HARD CAP. It runs on a
revision that is entirely rulings-on-open-cases plus precision - no new
mechanism - so if it too returns only precision, that is the terminal round and
the spec goes to the human. If round 4 returns another decision-changing
finding, the cap is reached and the design goes to the human AS A DECISION with
the open findings, per the skill's rule, rather than quietly continuing.
