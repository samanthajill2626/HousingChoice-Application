# Code re-review r2 - feat/tour-auto-close (fix wave 1, HEAD 0278e8ea)

- Reviewer: fresh round-2 reviewer (Claude Opus 5.5), 2026-10-04, worktree
  `W:\tmp\tour-auto-close`. Read-only on the repository: four throwaway probe
  files were created, run and deleted (section 6). Raw probe output and the
  line-ref worksheet: `.superpowers/review/re-review-r2-ref.md` (gitignored).
- Order of work, as charged: the fix diff and the feature's code paths first,
  cold (app/src, the harness fake, dashboard mirrors, e2e, seeds, worker and
  infra wiring); the round-1 records, the spec and the fix-wave report only
  after that.

## 1. Verdict

FIX WAVE 2 NEEDED - small, test-only plus two doc sentences. No runtime defect
found at HEAD; ruling A-1 is sound and every fix is real, but FW-1's new
`updatedAt` term silently disarmed the store-level race table: six of the seven
real-repo `autoCloseIf` mutants the S1-S2 slice recorded as killed now survive
the whole app suite (R2-1, MEDIUM).

## 2. New findings

| id | severity | title | file:line |
|---|---|---|---|
| R2-1 | MEDIUM | The A-1 `updatedAt` term masks 7 of the 8 store race rows: the status, outcome, conversion, convertible, scheduledAt and first-mark terms are no longer pinned against DynamoDB Local | `app/test/toursRepo.integration.test.ts:707-758` (term `app/src/repos/toursRepo.ts:735-740`) |
| R2-2 | NOTE | Spec 6.6 and 11 still state the pre-A-1 condition | `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md:357-358`, `:595-602` |
| R2-3 | NOTE | The new issue says only reopen clears a close-nag; the group close and the defer write it too | `docs/issues/tour-reopen-edge-states.md:35` |
| R2-4 | NOTE | The unreachable-shape branches added by FW-4 and FW-1 are pinned by no committed test | `app/test/helpers/twilioWebhookHarness.ts:3468-3469`, `:3646-3648`; `app/src/repos/toursRepo.ts:738-740` |

### R2-1 (MEDIUM) - the updatedAt term masks the store race table

**Evidence.** The integration race table (`toursRepo.integration.test.ts:707-758`)
says "One row per condition term" (`:708`). Each row creates a tour, reads it,
applies one change through the repo and expects the close to lose. Seven of the
eight rows read a NEVER-marked tour (only "a person marked it again" carries
`lastMarkedAt`), and every change they apply also stamps `updatedAt` (`patch`,
`toursRepo.ts:462-464`; `claimConversion`, `:542`). Since FW-1 a never-marked read
conditions on `updatedAt` (`toursRepo.ts:735-740`), and on DynamoDB Local the
change always lands in a later millisecond than the create, so each row now
loses on the `updatedAt` term whatever term it names. Before FW-1 a row could
lose only on its own term, which is how the S1-S2 slice killed the real-repo
mutants A2 (status), A3 (conversion), A4 (scheduledAt), A5 (first mark), A6b
(convertible) and A7 (outcome) with exactly these rows
(`slices/s1-s2-report.md:175-187`). The fix-wave report's mutation check
(`fix-wave-1-report.md:73-78`) covered only the over-correction of the new
term, so the masking went unseen. No other app test calls the real
`autoCloseIf` under a race: the other integration cases are wins, refusals and
the A-1 pair; the job, route and tick suites run on the harness fake.

**Reproduction** (probe `zz-review-r2-3`, deleted; output in the ref file). The
real repo on DynamoDB Local, with ONE term stripped from `autoCloseIf`'s
UpdateCommand by a wrapping doc client (no source edit), driven through the
committed row shape:

- unmutated: loses on a never-marked read and on a marked read;
- each of the six mutants: ALSO loses on the never-marked read (`sameMs: false`
  on every run), so the committed row passes with the term gone;
- the five that apply to a MARKED read (the first-mark term exists only on a
  never-marked one): the close LANDS - without the outcome term
  it overwrites a stored `not_a_fit` with `no_outcome` and closes the tour;
  without the conversion term it closes a tour holding a `pending:` claim; the
  status, convertible and scheduledAt mutants close as well.

The fake's rows are unaffected in practice: create, get and patch on the fake
cross a millisecond in 2 of 2000 runs (probe `zz-review-r2-4`), so fake mutants
are still killed. The store's are not.

**Blast radius.** No runtime defect at HEAD - every term is present and the
unmutated baseline refuses. What is gone is the only store-level net under the
sweep's one write, for the population that grows from the deploy on (every tour
a person marks or reopens is marked). On a marked tour the outcome term is the
sole guard against the sweep overwriting a decision recorded without a status
change (an exit gate without `status`, `routes/tours.ts:1150-1155`, which stamps
no mark, `:1161-1166`), and the convertible term the sole guard against
`{ moveForward: true }` alone. A later refactor that drops a term - tempting,
since the new comments say the `updatedAt` term catches any write on a
never-marked tour - passes every gate. It also voids the mutation evidence the
round-1 CONFORMS verdict cites (`spec-conformance-r1.md:286-294`). MEDIUM
because the fix wave introduced it, it is invisible (every row stays green) and
the repair is cheap enough to land before merge; LOW is defensible only if the
orchestrator decides the store-level net may go.

**Smallest fix.** Run each race row on a MARKED read as well (create with
`lastMarkedAt: '2026-09-10T00:00:00.000Z'`), skipping the first-mark row, which
is never-marked by definition - in `toursRepo.integration.test.ts` and, to keep
the two lists in step, `toursRepoFakeConditions.test.ts:156-205`. Pin the
first-mark term with one never-marked row whose change sets `lastMarkedAt`
through a raw UpdateCommand that leaves `updatedAt` alone: the same-millisecond
residual is now the only case where that term decides. Correct the comment at
`:707-708` and spec 11's Repo bullet (R2-2).

### R2-2 (NOTE) - the spec amendment stops at 6.3

The A-1 paragraph (`spec:301-318`) says it "amends the CONDITION bullet above".
Two other places still describe the old condition: 6.6's second bullet
(`:357-358`) lists what makes the close lose - "status, outcome, date, mark or
conversion changed" - without "or, for a never-marked tour, any write"; 11's
Repo bullet (`:595-602`) lists the losing cases without the `updatedAt` case and,
read with R2-1, should require the per-term cases on a marked read. Two
sentences.

### R2-3 (NOTE) - "Only reopen clears a group's pending relay close-nag"

`docs/issues/tour-reopen-edge-states.md:35` opens the AD-7 paragraph that way.
At HEAD closing the group clears it too (`app/src/routes/relayGroups.ts:687`)
and "Keep it open" rewrites it (`:772`). The intended claim is narrower - of the
TOUR transitions only reopen clears it - and the paragraph's argument holds with
that wording. Every file:line ref in this file and in
`tours-patch-status-precondition.md` was checked at HEAD and is accurate.

### R2-4 (NOTE) - unreachable-shape branches unpinned

FW-4 changed the fake for non-string reads (`storedAsRead`,
`twilioWebhookHarness.ts:3468-3469`, used at `:3646-3648` and in `reopenIf`), and
FW-1 added an `attribute_not_exists(#ua)` branch (`toursRepo.ts:738-740`). No
committed test exercises either; reverting them passes every suite. The shapes
are unreachable from the sweep and the reopen route (the clock refuses
non-string dates and marks, `app/src/lib/toursModel.ts:188-224`), so this is
hardening, not a gap. Probe `zz-review-r2-2` (deleted) confirmed the fake now
answers what DynamoDB does for a `null` scheduledAt read (closes), a stored NULL
outcome (refuses) and a read without `updatedAt` (refuses). No action needed.

## 3. The fix diff reviewed cold

**FW-1 (e95622a6) - sound code; one defect (R2-1).**
- Branch: the term sits in the else of `typeof tour.lastMarkedAt === 'string'`
  (`toursRepo.ts:723-741`), the split the clock makes (`toursModel.ts:218`; a
  present non-string mark returns null there, so no due tour reaches the write
  with such a read). The fake applies it under the identical test
  (`twilioWebhookHarness.ts:3648`). `#ua` is shared by the condition and the SET,
  which DynamoDB accepts (the integration pair runs it).
- `storedAsRead` vs the store: a string read requires that exact stored string
  (`#x = :x`; absent or another type is false in both); a non-string read
  requires the attribute absent (`attribute_not_exists`; a stored NULL exists in
  DynamoDB and is not `undefined` in the fake). Equal for every shape.
- Permanent skip: none possible at HEAD. The read is the byStatus GSI item with
  projection ALL (`infra/modules/dynamodb/main.tf:57`, `app/src/lib/tables.ts:14`)
  or a consistent get; the index converges; no app writer runs on the sweep's
  cadence (tour writes come only from person-triggered routes, create, the
  conversion claim and release, and the person-confirmed deferred group open);
  a lost tour is re-read next run. Caveat for later: a ProjectionExpression on
  `listByStatus` that omitted `updatedAt` would make every never-marked close
  lose forever, and silently, since a lost-only run logs nothing
  (`app/src/jobs/tourAutoClose.ts:113`) - the exposure `scheduledAt` and
  `lastMarkedAt` already had.
- Tests: they fail without the fix (RED recorded; and `clearRoster` changes no
  other conditioned field, so only the new term can refuse). Flake: none -
  `afterMillisecond` (integration `:763-766`, fake `:210-213`) guarantees a new
  stamp from the same process clock, neither file uses fake timers, each
  integration file owns a throwaway table, tourIds are random, and the job case
  seeds a fixed historical `updatedAt`, so the wall-clock write always differs.
  The assertions pin the rule (lost, row unchanged, no side effect), not the
  implementation. Re-run here: integration 56/56, fake 30/30, job 19/19.
- Comments: the interface doc (`toursRepo.ts:287-304`) and the job header
  (`tourAutoClose.ts:10-21`) are accurate; the race-table comment at integration
  `:707-708` is now false (R2-1).

**FW-2 (e2501b09) - sound.** `log.child({ tourId })` at `tourAutoClose.ts:134`
and `routes/tours.ts:1518`; pino children keep the mixin's correlation fields;
`child()` runs outside the helpers' try/catch but cannot throw for a plain
bindings object; no test stub logger reaches either call. The job test
(`tourAutoClose.test.ts:353`) pins the ERROR line; probe `zz-review-r2-1`
(deleted) confirmed the route's ERROR and INFO clear lines both carry `tourId`.

**FW-3 (9a444d07) - sound.** Two (PIN) cases (`tourAutoClose.test.ts:328`,
`:340`) and case 9 extended to `scheduled`; deterministic; they pin rules.

**FW-4 (02b13963) - sound; unpinned (R2-4).**

**FW-5 (b1018603) - sound.** The precondition comment
(`routes/tours.ts:1228-1233`) and the issue's update block are accurate, refs
re-checked (`:1034`, `:1234`, `:1235-1249`, `:1443`, `toursRepo.ts:469-474`).

**FW-6 (a83417a5, 78be74c4) - sound, with R2-2 and R2-3.** The A-1 paragraph is
correct, including "can only turn a close into a skip". The new issue's
frontmatter is valid and all eleven refs are correct at HEAD. Known and still
open (`fix-wave-1-report.md:226-232`): `docs/issues/tour-relay-open-vs-auto-close-race.md`
cites `toursRepo.ts:496`, `:540`, `:679` and `routes/tours.ts:1544`, `:1550`,
`:1559`, `:1644` - now `:502`, `:546`, `:685` and `:1552`, `:1558`, `:1567`,
`:1652`. Every added line of the fix diff is ASCII.

Flake risk across the fix diff: none found.

## 4. Adjudication challenges

**Disputed - the test-gap ruling "Worker wiring has no automated pin: ruling F12
stands" (`adjudications-r1.md:81-84`), LOW.** The premise that the entrypoint
cannot be pinned is answered by the repo's own idiom:
`app/test/jobQueueWiring.test.ts:129-139` asserts `worker.ts`'s SOURCE because
"these modules self-execute on import", written after the 2026-08-16 regression
where one entrypoint was left unwired. The auto-close poll block
(`app/src/worker.ts:526-570`) is the feature's only production trigger;
deleting it, or re-binding it to `WORKER_POLL_INTERVAL_MS`, keeps all five
gates green (the e2e drives the dev tick only). Instead: a three-line source
assertion that `worker.ts` calls `startPollLoop('tour auto-close', ...)` with
`runTourAutoClose` and `TOUR_AUTO_CLOSE_INTERVAL_MS`.

**Accepted:**
- A-1 (AD-1 FIX): the right boundary - it conditions exactly the reads whose
  clock is `updatedAt` (`toursModel.ts:218`). No writer of a never-marked tour's
  `updatedAt` postpones against the spec: 5.3 makes every write that tour's mark
  (even a failed group open's claim and release - 5.3's accepted rule, not
  A-1's), and the term cannot turn a due close into a permanent skip (section
  3). Its cost is R2-1, which the ruling's "cost: none beyond the skip" missed.
- AD-2 ACCEPT-BY-SPEC: spec 7.5 states it; the reopen-into-toured path opens
  Record outcome at once.
- AD-3 FIX (comments): accurate now.
- AD-4 ACCEPT-BY-SPEC: the intro sentence is section 2's accepted default copy.
- AD-5 FILE: API-only (the dashboard never moves a decided tour out of toured).
- AD-6 ACCEPT (F7, spec 8.3): the tour page refetches on the bridged
  `tour.updated` (EVENT_BRIDGE_URL is set for the deployed worker,
  `docker-compose.yml:56`), so the stale-page window is about a second.
- AD-7 FILE: pre-existing asymmetry (wording fix R2-3).
- AD-8 FILE: needs a stale request to outlive a full reopen, decide and close
  cycle; the suggested `lastMarkedAt` term would close it.
- AD-9 ACCEPT (spec 13): RUNBOOK `:405-419` carries the first-run effects.
- SC-1 FIX, SC-2 FIX, SC-3 FIX, SC-4 orchestrator, SC-6 ACCEPT: agreed.
- SC-5 FIX (hardening): agreed, unpinned (R2-4).
- Other test-gap rulings (unscoped candidate path, the e2e nothing-sent read,
  no cross-codebase link for Today's no-shows): agreed.

## 5. Fix realness

| fix | verdict | revert reasoning |
|---|---|---|
| FW-1 | REAL | Dropping `toursRepo.ts:735-740` lets integration `:771` close its stale read (only `updatedAt` differs); dropping `twilioWebhookHarness.ts:3648` fails parity `:217` and job `:261`; extending the term to marked reads fails the PINs `:790` / `:237` (report `:73-78`). Side effect: R2-1. |
| FW-2 | REAL | Job: reverting `tourAutoClose.ts:134` fails `:353` (the ERROR line loses `tourId`). Route: unpinned, verified by probe. The missing route test barely matters - the clear's lines share the request's correlationId with "tour reopened via api", which carries the tourId, unlike the sweep, where one pollRunId spans many tours (why SC-1 mattered there). A one-case test is optional. |
| FW-3 | REAL (pins) | Pass on unchanged code by design; the report's `vi.mock` mutant of the arm helper failed both nag pins (report `:119-123`). |
| FW-4 | PLAUSIBLE | Behavior verified by probe; a revert passes every committed test (R2-4). Acceptable for unreachable shapes. |
| FW-5 | REAL | The comment and the issue now match `toursRepo.ts:469-474`. |
| FW-6 | REAL | Spec and issues say what the code does, with R2-2 and R2-3. |

## 6. What I could not verify

- Gates 2-4 on 0278e8ea (`npm test`, smoke, e2e - forbidden here). The fix wave
  ran typecheck, eslint on its 8 files and 7 test files; the full gates on the
  post-sync HEAD are still owed (SC-4).
- Real byStatus GSI lag and the production first-run volume.
- Dashboard behavior in a browser (no e2e lane, no Playwright).
- Method note: one vitest invocation ran three fake-only or pure files together
  (`tourAutoClose`, `toursRepoFakeConditions`, `toursModel`); every other run was
  one file. Single-file runs: `toursRepo.integration` 56/56,
  `toursReopenApi` 18/18, `devTourAutoCloseTick` 7/7.
- Throwaway files: `app/test/zz-review-r2-1.test.ts` .. `zz-review-r2-4.test.ts`,
  created, run alone and deleted; the probes' DynamoDB use was one throwaway
  prefix table, dropped by the probe. `git status` shows only this file.
