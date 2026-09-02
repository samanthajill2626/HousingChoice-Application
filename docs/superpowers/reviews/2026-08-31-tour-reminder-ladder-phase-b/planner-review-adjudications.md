# Planner's independent review - adjudications

Date: 2026-09-01. Branch @fa2fdd29 (handback commit), 0 behind main.
Reviewers: spec-conformance (spec + plan + handback) and plan-blind adversarial
(diff + repo only), both `opus`, both fresh - neither saw the orchestrator's own
review rounds. Reports: `planner-review-conformance.md`,
`planner-review-adversarial.md`.

**Conformance: 92 delivered / 4 deviated / 0 missing, no BLOCKING.**
**Adversarial: 17 findings, no BLOCKING, 3 HIGH.**

Both reviewers independently converged on the same top item (C1 = A1 = founder
item 9), which is a PRODUCT question, not a code defect - the copy is byte-exact
to what Sam wrote. It is the headline of the founder handback, not of the merge
verdict.

## Conformance findings

| # | sev | ruling |
|---|---|---|
| C1 tour intro rarely fires in the primary flow (groups open before booking) | HIGH | DEFER to founder item 7 - the spec's owner-routing produces exactly this; whether Sam wants "book, then open" is her workflow call |
| C2 `tour_missing` hoisted above supersession + quiet hours | MEDIUM | ACCEPT as already-ruled: plan P11 stated and pinned it; the spec's precedence table omits it. Handback names it |
| C3 relay intro carries a past-tour guard spec 9.1/9.5 never describes | LOW | ACCEPT the deviation as CORRECT: both tour entries end "let us know when you're on the way", the same staleness class the ladder gate exists for, and the orchestrator's R1 caught the concrete failure (a quiet-hours-deferred open texting it after the tour). Inclusive boundary matches `retiredByTourStart` |
| C4 persisted member_added body is the GROUP copy in the raced-remove case | LOW | ACCEPT, harmless: two conversation reads can straddle a remove; the row then carries copy no leg got. Handback discloses it |
| C5 site-6 test narrower than the label-test shape | LOW | ACCEPT as adequate: it pins exactly the two codes whose generic fallback is a lie, which is the property spec 4.3 cares about |
| C6 sweep population-A boundary inclusive where 4.2 reads exclusive | LOW | REJECT: spec 6.1a's predicate is `now >= start` ("has already started" includes t = start) and 4.2 mandates the SAME predicate; the sweep is right, 4.2's prose is loose |
| C7 spec 8.2's claim about the placement issue was false; branch corrected it | LOW | ACCEPT - the spec was wrong, the branch fixed the issue file |
| C8 `overdue` has no e2e proof | LOW | ACCEPT the disclosed deviation: the tick is time-injected and `overdue` is wall-clock; the live worker sends a past-due pending rung within one poll, so the state is not holdable in a spec. Route + component pins stand |
| C9 `viewOf`'s `overdue` read by nobody | LOW | ACCEPT as spec-mandated (8.2: both builders, so the view cannot disagree with itself); dead-in-practice today is fine |

## Adversarial findings

| # | sev | ruling |
|---|---|---|
| A1 tenant-addressed intro reaches the landlord verbatim | HIGH | DEFER to founder item 9 (product; her copy). The `bodyFor` seam makes a landlord-facing line cheap IF she supplies one |
| A2 discontinued rows re-list every tick until the sweep, RUNBOOK calls the sweep a preference | HIGH | ACCEPT IN PART - fix wave. By spec 3.1 the poll EXCLUDES rather than skips (a design ruling, R3-10), so pause-era rows DO re-list (one INFO count line per tick) until the human runs the sweep. Correctness is unaffected; the RUNBOOK must say the sweep is REQUIRED to end the churn, not preferred |
| A3 `en_route` has no quiet-hours floor; surfaces hide "Will wait" | HIGH | REJECT as a code finding: the floor's absence is the founder's decision (spec 6.1, founder item 1, and the reviewer was plan-blind); hiding "Will wait" on a rung that SENDS is the correction of a lie, not the concealment of one (plan P5) |
| A4 sweep header says "default DynamoDB Local"; unset endpoint = REAL AWS; resolved target never logged | MEDIUM | ACCEPT - fix wave. VERIFIED against `dynamo.ts:3`. Wrong in the dangerous direction, on the one script the human runs against prod. Header corrected; the run logs its resolved endpoint + table at start |
| A5 group-side copy stored nowhere | MEDIUM | REJECT: spec 9.6's named, dated exception; a body log line would be PII |
| A6 no sender identity on first contact | MEDIUM | DEFER to founder item 2 (already sequenced before the deploy) |
| A7 + A15 issue-registry drift (`{members}`, role token, `composeMemberAddedBody`) | MEDIUM | ACCEPT - fix wave: `automated-sms-length-guard` re-pointed to `{names}`; `founder-message-template-updates-owed` updated - its relay item (2) is now DELIVERED |
| A8 `relayGroups.ts` reads discontinued but not manual-only; "nothing else has to change" overstated | MEDIUM | ACCEPT as docblock precision - fix wave. VERIFIED: that view NEVER read the manual-only set (0 hits at the base), so no regression; the docblock now names it as the one scheduled surface without a paused chip |
| A9 poll has no re-entrancy guard, `listDue` no batch cap; this diff makes the batch non-empty | MEDIUM | ACCEPT - FILE (pre-existing; handback disclosed). All writes are conditional and the A2P bucket paces sends, so overlap is safe; the missing cap is a latent issue worth its own entry |
| A10 echo `overdue` dead code | LOW | REJECT - see C9 |
| A11 lexicographic compare | LOW | REJECT: stored `dueAt` is repo-normalized ISO, the file's standing convention; the docblock's argument is about UNnormalized `scheduledAt` |
| A12 `RemindersPanel.tsx:48` still says 60s poll | LOW | ACCEPT - fix wave (comment) |
| A13 `resolveMemberRole` not tied to `UNIT_CONTACT_ROLES` | LOW | REJECT: a role outside the table takes the no-role entry BY the spec's rule (9.4 table, last row) |
| A14 `composeNameList` zero-others row | LOW | REJECT: spec 9.2's table rules it deliberately |
| A16 quiet-hours e2e (3) traded a positive for negatives | LOW | ACCEPT the handback's disclosed reasoning (wall-clock window vs fixed 19:30 rung is a coin flip); no change |
| A17 `full`-profile demo seed's ladder now fires against `+1555` fixtures in a LIVE-comms dev loop | LOW | ACCEPT - DISCLOSE in the verdict and FILE: Twilio rejects `+1555` numbers (no cost), but a live `npm run dev` on the demo seed now produces failed-send noise it did not before. Same class as the standing live-mode seed foot-gun |

## Fix wave (planner-executed, docs + comments + one log line; no behaviour change)

1. `app/scripts/retire-paused-tour-reminders.ts` - header target statement
   corrected; start log carries the resolved endpoint + table name.
2. `RUNBOOK.md` - the sweep is REQUIRED to end the per-tick re-list; not a
   preference.
3. `app/src/jobs/tourReminders.ts` - `MANUAL_ONLY_REMINDER_KINDS` docblock names
   `routes/relayGroups.ts`'s scheduled view as the one surface with no paused
   chip (never had one).
4. `dashboard/src/routes/tours/RemindersPanel.tsx:48` - 60s -> the configured
   interval.
5. `docs/issues/automated-sms-length-guard.md`, `founder-message-template-updates-owed.md`
   - drift corrected.
6. FILED: `tour-reminder-poll-overlap-and-batch-cap.md`,
   `full-seed-ladder-fires-in-live-dev.md`.

Re-verification after the wave: `npm run typecheck`, the sweep script's test
file, the dashboard suite. NOT re-run: e2e (no runtime behaviour changed - a log
line, comments, docs).
