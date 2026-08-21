---
id: ai-run-log-recovery-hook-unbounded
title: Abandoned-resolution recovery on the suggestions GET has no cap or deadline
type: debt
severity: med
status: resolved
area: app
created: 2026-08-09
resolved: 2026-08-09
refs: app/src/routes/suggestions.ts, app/src/repos/suggestionResolutionRepo.ts, app/src/services/suggestionResolution.ts
---

**Problem.** `GET /api/contacts/:contactId/suggestions` awaits `recoverAbandoned`
before `res.json`. That hook enumerates the contact's bounded set of twelve
`resolve#` journals and helps every EXPIRED one to completion, each with its own
nested bounded retries, serially, with no wall-clock deadline and no per-read cap
on how many journals it will drive. The contact page issues this read on every
open, so a contact carrying several abandoned journals pays the full cost before
any suggestion renders.

**Why it is shaped this way.** The recovery had to be reachable WITHOUT the
`sugg#` row, because `claim()` deletes that row before the domain effect - so
after a crash the UI has no identity left to resume with, and the operator's
accept plus its PII would be stranded forever (the blocking F1 finding all three
independent reviews converged on). The planner's adjudicated worklist prescribed
"a lazy recovery hook on the contact's suggestion list read" and did not bound
it. This issue is that missing bound, not the hook itself.

**Also considered and deliberately NOT filed as a defect:** the hook makes a GET
perform durable writes, and GETs are exempt from the CSRF origin check while
SameSite=Lax still attaches the session cookie to a top-level cross-site GET.
Independently assessed by the final conformance reviewer: unauthenticated abuse
is impossible (`requireAuth` precedes the router), and an authenticated
cross-site navigation only causes the organization's own operator's
already-clicked resolution to finish sooner, from a stored snapshot, attributed
to the original `actorId`, idempotently. Not a capability worth defending
against. The exposure here is latency, not authorization.

**Fix direction.** Cap the work per read (one or two journals), or impose a
wall-clock deadline checked between journals, and let the remainder be picked up
by the next read. Both keep the entire recovery benefit; neither needs new
infrastructure. Prove it with a test that plants more expired journals than the
cap and asserts the response is served within the budget with the remainder
still recoverable on a subsequent read.

**Evidence.** `.superpowers/design-review/final-conformance.md` (P2-1),
`.superpowers/design-review/final-adversarial.md` (P2-2).

**Resolution (2026-08-09, follow-up wave).** A per-read cap now bounds the hook:
`MAX_RECOVERIES_PER_READ = 2` in `app/src/services/suggestionResolution.ts`,
counting ATTEMPTS (not successes) and placed after the two free in-memory
filters so cheap skips never consume the budget. A wall-clock deadline was
deliberately rejected: the service clock is injectable and pinned by the suite,
so a deadline is untestable or flaky. The GET-performs-writes shape is
unchanged, per the assessment above. Pinned by a three-journal test in
`app/test/aiRunVerdicts.test.ts` asserting the first read completes exactly two,
leaves one active, and a later read completes the remainder. Known residual: the
cap walks `listJournals` from the head, so journals that fail recovery
PERSISTENTLY could starve the tail - no producer of a persistently failing
journal is known; tracked as item 29 of
`docs/issues/ai-run-log-final-review-followups.md`.
