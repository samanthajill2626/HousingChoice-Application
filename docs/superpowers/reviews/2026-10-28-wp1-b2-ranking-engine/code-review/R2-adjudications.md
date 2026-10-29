# B2a code review round 2 - orchestrator adjudications

Round 2 = two fresh re-reviewers on the FW1 fix diff and their areas
(R2-server.md, R2-dashboard.md). Totals: R2-server 0 CRITICAL / 0 HIGH /
1 MEDIUM / 2 LOW / 4 INFO; R2-dashboard 0 / 0 / 0 / 7 LOW / 1 INFO.
FW1-1, FW1-2, FW1-3, FW1-11 verified REAL by reverting each fix against its
new tests (R2-server); FW1-4..FW1-12 fix what they were asked (R2-dashboard,
the 7 new hook tests fail on the pre-fix hook), with the gaps below.

LOOP RULE (from round 2 on, so the review loop converges): a defect a fix
wave INTRODUCED, or an R1 finding a fix wave left incomplete, is a
REGRESSION and is fixed in FW2; a defect that was already there and is only
newly found is NOT A REGRESSION and is FILED, unless it is MEDIUM or worse.

## FIX - fix wave FW2

| Id | Finding | Class | Fix |
|---|---|---|---|
| FW2-1 | R2-dashboard-2: a job the page first sees after it finished, with no more finished batches than the previous job, never triggers a full read (the R1 MEDIUM's "stale table under Done" by another path) | R1 fix incomplete | A job view with a different generation than the one on screen counts as a change: read the full ranking. Test. |
| FW2-2 | R2-dashboard-4: one job read that never answers now blocks every later job read (FW1-4's de-dupe) | REGRESSION (FW1-4) | A job read in flight past a deadline (a small multiple of the 5 s poll) no longer blocks: the next request starts a new read; the old one's answer is still ordered by the same rules. Test with a never-resolving read. |
| FW2-3 | R2-dashboard-5: "latest issued wins" drops a full read that is newer than the rows on screen while a later read is still out | REGRESSION (FW1-4) | Apply a full read whose issue number is greater than that of the rows on screen (track it); drop only reads older than the rows shown. Test: three overlapping reads answering 2, 1, 3 -> rows of 2 then 3, never 1. |
| FW2-4 | R2-dashboard-6: the page's re-read after a notes_stale refusal is not ordered against the user's next save; a late answer shows the notes the user just replaced | REGRESSION (FW1-7) | Switch FW1-7 to the other fix R1 named: hand the 409's current contact up to the page (an `onContactUpdated`-style prop wired to ContactDetail's setter, as StaffNotesCard does), without closing the form; no re-read for notes_stale. Keep onStale for contact_type_changed as before. Test: a notes_stale refusal hands the 409 contact up once and does not call onStale. |
| FW2-5 | R2-dashboard-7: job views are ordered by request send time; the full read reads its job after building the pool, so a later-sent job read can carry an older view and pull the status backwards for one poll (part of R1 A2-1 that FW1-4 claimed) | R1 fix incomplete | Within one generation, never replace the view on screen with a less advanced one (status order queued < running < done / failed, then finished-batch count); across generations keep the issue-order rule. Test. |
| FW2-6 | R2-server-6: RUNBOOK (~1844-1846) now says every paid call is a run record or one of two log lines; the same section (~1938-1944) and the lifecycle issue say calls in flight at a worker kill leave neither, and an SDK-retried timed-out attempt may be billed uncounted | REGRESSION (FW1-12 wording) | Make the sentence exact: name the cases that leave neither (killed in flight, SDK-internal retries) and point at the lifecycle issue. Docs only. |
| FW2-7 | R2-server-5: the GLOSSARY fingerprint entry (FW1-12) says only edits move a fingerprint; the recency bucket and an organization-list change also do | REGRESSION (FW1-12 wording) | Correct the entry. Docs only. |

## QUESTION for Cameron (relayed through the planner; the build continues)

- Q1 - R2-server-1 (MEDIUM, CONFIRMED mechanism): the unlawful-flag
  record's `reason` comes from ONE pair's model text (spec D10: "the
  model's against-reason or unknown text naming it"). The rubric forbids
  stating the unlawful rule as a reason against, so a matching
  against-reason is about the pair - a lawful clause or the tenant (e.g.
  "eviction in 2024 fails qualifications", an accessibility need) - and it
  is stored on the PROPERTY's flag record with no TTL and shown on every
  ranking that lists that property. Options: (a) RECOMMENDED - store only
  the fixed sentence "flagged as a requirement fair housing does not
  allow"; the pair's own text stays on its match and run under the 180-day
  TTL; (b) keep spec D10 as written. Either is a one-line change plus its
  test (`rankingFlags.test.ts:67-88` pins today's order). Filed as
  `ranking-unlawful-flag-reason-source` (med) until Cameron answers.

## FILE (not regressions; the FW2 child writes them)

- Append to `ranking-job-lifecycle-robustness`: R2-server-2 (a takeover
  or claim whose write lands but whose call throws starts no job; about
  90 s later the press fails "stopped before it finished" with no model
  call; an ambiguous claimQueued spends the job's one takeover - fix:
  re-read in the catch and start the job if it holds this pass's
  generation) and R2-server-3 (a stale lease is never taken over while
  every pass has a queued job for the free slot).
- New `notes-guard-double-click-overwrite` (low): R2-dashboard-1 - after a
  stale refusal, Save re-enables within a double-click interval and the
  second click overwrites the current notes before the conflict panel is
  seen; the Staff notes card has the same pattern (both cards).
- New `rankings-page-hook-edges` (low): R2-dashboard-3 (a window toggle
  away and back during a press leaves Rank on "Starting..." until another
  change or a reload) and R2-dashboard-8 (the joined mark can outlive the
  job when the press's answer lands after the page saw it finish; a stale
  job view can clear a 409 message while the new job runs).
- New `ranking-unlawful-flag-reason-source` (med, decision for Cameron):
  Q1 above.

## NOTE (no action)

- R2-server-4: every ranking read fetches whole match rows, the unused
  `inputSnapshot` included (the 150-tenant read measured 158-228 ms
  isolated; a projection can come with B3).
- R2-server-7: FW1-3's retry after a first write that landed but threw
  skips the "done" event and log line; the page's 5 s job poll recovers
  (spec D12: the event is a hint).
- R2-server challenge to A1-12 ("no TTL" is worse than noted) is folded into
  Q1: with option (a) the record carries no pair text.
- R2-dashboard upheld both round 1 REJECTs (spec D14.1 + PR28; spec
  section 4) and the A2-6 FILE.
