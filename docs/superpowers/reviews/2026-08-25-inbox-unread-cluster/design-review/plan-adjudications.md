# Plan review - adjudications

Plan: `docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
Spec: `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md` (draft 4, gated)

Three rounds, two adversarial reviewers each, dispatched with the project's PLAN
brief and explicit `model: opus`. Reports:
`W:\tmp\handbacks\plan-review-r{1,2,3}-2026-08-25\`.

| round | reviewer A | reviewer B | outcome |
| --- | --- | --- | --- |
| 1 | 5 blocking, 8 high | 6 blocking, 5 high | Draft 1 REJECTED and discarded |
| 2 | 1 blocking, 4 high | 1 blocking, 4 high | NOT BUILDABLE - Task 9 dropped by ruling |
| 3 | 1 high, 3 med, 4 low | 1 high, 3 med, 2 low | **BUILDABLE**, both |

## Draft 1 was thrown away, not patched

It did not compile (a `TS2352` cast nine times over), broke four existing test
suites, contained three tests that could not fail, and re-created the
precedent's own silent-short-block failure. The pattern matched four spec review
rounds by the same author: writing from a remembered model of the code instead
of re-reading it.

Draft 2 was written by a DIFFERENT author, deliberately denied the rejected
draft, given the spec plus the ten repo facts round 1 established - and told to
verify each rather than trust it. It corrected two of the ten, both verified:

- `inboxApi.test.ts` needs no fake change (its harness implements `listByType`
  at `twilioWebhookHarness.ts:1684`); `inboxDiagnostics.test.ts` never calls
  `aggregateInbox` at all - its single mention is inside a comment.
- The `performanceSeed` pins are contact-backed, not contactless, so they should
  survive the flip.

It also found a fidelity gap nobody had: the webhook harness's `listByType`
applies the deleted filter BEFORE `Limit`, so it cannot produce the
empty-page-with-LEK shape the fill loop guards against.

## Human rulings

1. **`team_member` contacts do not belong in a triage queue** (2026-08-25).
   Confirmed against the code before recording: `team_member` is the
   internal-staff bucket. The contact-side read excludes them by construction,
   so today's tab carries the bug.
2. **Task 9 (spec section 5's all-pager safety net) is OUT of this plan**
   (2026-08-25). It carried three of round 2's worst findings, chief among them
   shipping section 5's own named gate unsolved. Deferred WITH its unsolved gate
   and both traps recorded, so the next builder starts from the findings.

## The blocking finding, and why the stronger fix was taken

`collectUnreadRows` derives `truncated = !capped && !scanExhausted`, so `capped`
MASKS `truncated`: a resurfacing sweep stopping on `maxRows` silently dropped
class-(d) deleted contacts. Both reviewers found it independently.

**This cluster had already established that relationship** in the C1
generator-contract work, and the planner failed to carry it into either the spec
or the plan brief. That is the session's recurring failure - a fact that does
not travel between documents - and it is the reason the plan now records its
own numbers rather than assuming the next reader has them.

Reviewer A proposed detect-and-WARN. REJECTED as treating the symptom: it leaves
those rows UNDELIVERABLE past 100 unread candidates, not merely unreported. The
plan pins `maxRows` to the sweep budget instead, per the spec's own requirement-3
arbitration wording.

## The cost that fix bought, now recorded

Both reviewers independently caught the consequence, and neither the planner nor
the author had recorded it:

- Ceiling: `UNREAD_WALK_LIMIT` (2000) raw items per Unknown page load, one
  contact read per VISIBLE unread 1:1 item.
- **Crossover: ~700 visible unread 1:1 threads** - the point where the sweep's
  contact reads match the ~684 lookups the removed walk paid.
- Worst case ~3x (2000/684).
- Accepted because the OLD cost sat on a partition that never shrinks while the
  new one sits on a quantity triage drains - and the crossover rises as the open
  partition grows. Measured today: 1 unread row in prod, 0 in dev.

Fired the existing `warnUnreadScanned` tripwire (the sweep was the only one of
three byUnread consumers not to), and added an unconditional `sweepScanned` log
field so a sweep that drains 1500 items and completes is not silent.

## Author pushback, upheld

The author disputed three reviewer claims and was right on each. Reviewer B
conceded in round 3: its "every `pagesWalked` pin is one short" generalised from
a single case - "the same move I'd been criticising". Only the residue-fill pin
moved.

## Recorded, not solved

A capped sweep renders the ordinary empty state over a knowingly incomplete
answer. Forced jointly by approved requirements 2 and 5; recorded in the plan's
docs task rather than papered over.
