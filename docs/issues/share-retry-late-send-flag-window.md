---
id: share-retry-late-send-flag-window
title: Between a share text's lapsed 30003 promise and a LATE retry's first receipt, the tenant reads as a final failure - unflagged in the composer, a double-text window
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-28
refs: app/src/jobs/retrySend.ts:604, app/src/lib/retrySendWindow.ts:107, app/src/adapters/sqsJobConsumer.ts:129, app/src/services/shareRecipientState.ts:78, app/src/routes/broadcasts.ts:602, app/src/routes/api.ts:1653, dashboard/src/routes/broadcasts/RecipientPreview.tsx:91
---

**Found by.** The plan-blind adversarial code review of `feat/share-sent-outcome`
(round 1, ADV-2 (a), reproduced; `docs/superpowers/reviews/2026-09-27-share-sent-outcome/code-review/adversarial-r1.md`),
ACCEPTED in `r1-adjudications.md`. Anchors at the branch's fix wave 1.

**Problem.** A share recipient's slot learns a retry only from the retry
row's own callbacks (or the reconcile's adoption): the retry job's success
path closes its attempt record and writes nothing else
(`app/src/jobs/retrySend.ts:604-610`; spec D2, "a retry's mere acceptance is
not written by anyone"). Until the retry's FIRST callback the slot is the
original's `failed 30003`, judged by the original row's promise, which lapses
at its due instant plus two minutes whatever became of the retry
(`isRetryPromiseLive`, `app/src/lib/retrySendWindow.ts:107`). A retry job that
runs LATE - the jobs consumer receives again only after its whole batch
finishes (`app/src/adapters/sqsJobConsumer.ts:129`) - sends after that lapse,
and between the lapse and its first callback the recipient's D1 state is
`failed` (`app/src/services/shareRecipientState.ts:78-86`):

- the composer's "Already sent" flag (`app/src/routes/broadcasts.ts:602`) does
  NOT flag the tenant, so a second share of the property in that window
  starts them pre-checked and "Select all" re-includes them
  (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:91`) - a double text
  if the late retry delivers;
- the results row reads the plain failure with the "open conversation to
  retry" hint, and a share with no other reached recipient reads "Not sent"
  and "No tenants reached".

The thread itself is safe: the manual Retry route refuses a row that already
has a child (`app/src/routes/api.ts:1653-1657`). The first callback of the
retry (its carrier `sent`, typically seconds after the send) moves the slot and
corrects every surface.

**Why accepted.** Spec section 8 names this interval ("a lapsed promise before
the retry's first receipt - RSW's gap") and accepts it. The adversarial review
adds the composer-flag angle: a double text needs a late job AND a second
share of the same property inside the gap, and the flag is a hint, not a
block (a double text is at most HIGH on the standing scale; this is LOW).

**Directions (not taken).** Record the retry's ACCEPTANCE on the slot from the
retry job's success path (the pass does the equivalent for originals at
dispatch) - a new writer inside Stage 1b's job, fenced for this branch (I7);
or let the composer's SAFE reading consult the original row's retry children
(its `retrychild#` pointers) - which pre-1b rows lack, so it narrows the gap
for new chains only.

**Related.** [broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md)
(resolved by the branch), [manual-retry-double-send-residual-windows](./manual-retry-double-send-residual-windows.md),
[share-results-promise-refresh-not-emitted](./share-results-promise-refresh-not-emitted.md).
