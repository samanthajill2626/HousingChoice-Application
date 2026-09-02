# Handback - feat/tour-reminder-supersession

**MERGE-READY @ca533ed4 on feat/tour-reminder-supersession
(W:\tmp\tour-reminder-supersession), 51 behind main, UNMERGED (human gate).**
NO infra, NO new dependencies, NO backfill, NO post-merge ops owed.

## Work map - all eleven slices SHIPPED

| slice | state | commits |
| --- | --- | --- |
| S1 repo foundations (ladderId, currentLadderId, claim guards, sweep, both fakes) | shipped | a3f3b256..822a2a08 (5) |
| S2 armer mints one ladderId per call, returns { ladderId, rows } | shipped | d7bb3f2a |
| S3 tour pointer writes (create, re-arm rotation, terminal rotation, CAS, logging) | shipped | 8f1dc077 |
| S4 seeds stamp AND point (live/matrix/cast; 9 terminal seeds rotated, census-pinned) | shipped | fb571be1 1909c018 |
| S5 refusal (poll superseded + bounded conversion deferral; Send-now 409; census x2) | shipped | 4c150e25 6091e3b1 c61b1d24 |
| S6 three preview surfaces agree via shared isSupersededRung | shipped | 1749ac64 |
| S7 earlier[] partition, collapsed disclosure, by-state allowlist, honest 404s | shipped | 935ebfd3 5b30a14d |
| S8 conversion: defer before finalize, rotate INSIDE it, sweep after | shipped | 6be35c19 |
| S9 tours.ts sweeps, cancelTourReminders/cancelForTour deleted, e2e re-pointed | shipped | 25660786 2a2bdda9 d5baa734 |
| S10 Upcoming inside the scroll: sentinel, 3-valued anchor, six writers, RO re-pin | shipped | 35693ab0 9d6de9fc 65c19506 |
| S11 closing sweep | folded into S2-S10 + orchestrator grep (clean) | - |

Deviations of note (all adjudicated on the record): T4.4 closed as
nothing-to-change (performanceSeed writes no reminder rows); S9 sweep-failure
posture = handler rethrow, not log-and-arm (orchestrator ruling); T9.3 proven in
app/test because e2e cannot read DynamoDB; W3/W1 scroll writes are a rect DELTA,
not offsetTop (offsetParent is .streamWrap - the specified formula was wrong).

## Review + fix waves (records committed as produced)

Three rounds, two reviewers (spec-conformance + PLAN-BLIND adversarial,
continued across rounds), two fix waves, one live-QA fix. ~44 findings total.
Round 1: 1 BLOCKING (generation-blind sweep deletes the concurrent winner's
ladder - reproduced) + 3 MAJOR; fixed in wave 1 (9 commits). Round 2 BROKE
wave 1's guard twice (eventually-consistent read; unguarded terminal branch -
both reproduced) -> redesigned to the TRANSACTIONAL sweep (per-row
TransactWrite: ConditionCheck on currentLadderId + conditional Delete), plus
conversionClaimedAt as the grace basis and conversion_in_progress across all
four surfaces (wave 2, 6 commits). Round 3: all closed; adversarial walked the
four interleavings and found the sweep holds; its one MAJOR (decode untested)
REFUTED with cited evidence (real cancellation payloads drive both decode
branches at tourReminders.test.ts:716/:747). IAM ConditionCheckItem verified
already granted - no Terraform.
Files: code-review-{conformance,adversarial}.md (3 rounds each),
code-review-adjudications{,-r2,-r3}.md, slice-reports/, research-findings.md.

## Live self-QA (self-qa.md; every claim a measured number)

Panel walk green (scheduled ladder; live reschedule -> old rung DELETED, fresh
ladder, collapsed "Earlier reminders (1)"; terminal tour -> "No reminders
armed." + disclosure). Phone walk at 360x800 on an overflowing thread: open
pinned (sentinel delta 0, block below fold, no pill); standing-on-block +
REAL inbound -> zero yank (scroll compensated exactly, block pixel-stable), no
pill; scrolled-up + inbound -> pill, no jump; pill click -> newest message,
block hidden, pill gone. **Live QA caught one real regression** (fix-wave-1's
m2 re-derive ate the first-mount pin - pill lit on open); fixed @245f4bfe
(unmount-flip only), RED-proven, re-verified live.

## Gates on the synced base (merge @26e263b0 of main@7be40139; bare, quoted)

- typecheck: `G1_SYNCED_EXIT=0`
- npm test: `G2_SYNCED_EXIT=0` - `351 passed | 1 skipped (352)` app, `184` dashboard, `19`, `34`, `13`
- smoke: `G3_SYNCED_EXIT=0` - `smoke-dist: OK - 1378 import specifier(s) across 242 emitted file(s)`
- e2e: g4b killed by the 1500s cap at ~half (exit 124, run degraded by machine
  load - NOT a test failure); g4c full run `263 passed, 1 failed (32.2m)` - the
  one failure is `relay-number-lifecycle.spec.ts:223` (`conv.status` toBe
  closed), a file THIS BRANCH NEVER TOUCHED, and it is `6 passed (2.6m)`
  IN ISOLATION (`ISOLATE_EXIT=0`). Cameron directed isolate-and-move-on; the
  confirm re-run (g4d) was killed on that direction. Pre-sync full suite was
  `263 passed (19.2m)` EXIT=0 including the new upcoming-in-stream spec.
- eslint (42 branch files): `12 errors, 5 warnings` -> per-finding baseline
  comparison at the merge base: the 12 errors are the IDENTICAL pre-existing
  set (cast.ts x4, live.ts x2, matrix.ts, placements.ts nameFromContact,
  relayGroups.ts resolveMessage, tours.ts TourOutcome, ScheduledCard Date.now,
  Timeline set-state-in-effect); 4 warnings pre-existing (e2e unused
  no-console disables). The ONE branch-introduced warning (exhaustive-deps on
  currentAnchor) was FIXED @ca533ed4, not shipped. The branch also CLEARED one
  pre-existing error (tourRemindersRepo.ts unused GetCommand import).
- Final commit ca533ed4 (3-line dashboard useCallback wrapper) re-ran
  typecheck=0, full npm test=0 (same counts), smoke=0, targeted vitest 2/2,
  eslint clean; the e2e verdict names the merge commit - stated, not hidden.

## Net delta vs merge base

80 files, +16,926 / -467 (about 10k of the insertions are the committed
mission records under docs/superpowers/reviews/).

## Known flakes / open questions / drift

- `relay-number-lifecycle.spec.ts:223`: fails in one degraded full run, green
  in isolation and in the pre-sync run; surface untouched by this branch (the
  merged participant-snapshot-refresh touches relay heavily). If it recurs on
  main, diagnose there - not a supersession regression. Not filed as an issue
  per the move-on direction; say the word and I file it.
- **Main drifted 51 commits AFTER the one sync** (retry-counter-durable and
  quiet-hours-spec-window merges landed mid-battery), with a 4-file
  intersection against this feature's file set. Recommendation: a second
  sync + re-green pass before merging - happy to run it on request (the
  one-sync rule reports drift rather than chasing it).
- Recorded residues (adjudications): unpaginated listByTour feeds the sweep
  (safe-not-complete; spec non-goal); arm-to-CAS crash leaves two generations
  of refused debris; retire-script labels a superseded past-tour survivor
  tour_already_passed (cosmetic); zero-row arm after a sweep leaves an
  unexplained empty panel (narrow); Send-now names names_unavailable for a
  tours-table outage; superseded echo body '' unreachable today.
- Recovery tally: 1 budget-consuming (fix-wave-2 child died on an API session
  limit; resumed with edits intact) + 1 infra-tier free (reviewer connection
  drop, zero work lost).

**MERGE-READY @ca533ed4. Do not merge without the human go. NO infra or
post-merge operator actions owed by this branch.**
