# FW3-A report - code review round 3, backend fix wave (A11-A13)

- Implementer: FW3-A (Claude Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  branch `feat/clean-org-names`.
- Range: after 284d7a71 (R3 records) through 0d278206 - 3 commits, one per item. Tree
  clean after the last commit (this report is the only untracked file). Nothing left
  running. `dashboard/` and `e2e/` untouched.
- Every fix item test-first: each new test ran RED on the pre-fix code, failing for the
  reason the finding states, then GREEN. Logs: `.superpowers/sdd/fw3a-*.log`.
- Commit checks every time: bare `git status` as its own command, no MERGE_HEAD, explicit
  paths only, ASCII message via `git commit -F` with the `Co-Authored-By: Claude Opus 5.5`
  trailer; added diff lines 0 non-ASCII; new files `tr` count 0. DynamoDB Local up
  throughout (never started, stopped or restarted).
- Baseline before any edit: orgRecords, orgRewriteJob, orgRewriteService, cleanOrgNames,
  organizationsApi - 122/122 (exit 0).

## Per item

| item | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| A11 | d255f963 fix(org-names): a rewrite pass checks its lock before each record and stops once a failing heartbeat outlives its lease | job (a) stall before a write: `expected undefined to be 'Metro HA'` (t-new cleared); job (b) every heartbeat throwing: `expected undefined to be 'Metro HA'` (pass ran to done); pass unit test: `expected 'Step Up' to be 'Steps'` (written after a stalled read); cleanup lease: `expected [ 900000, 1500000, 2400000, ...(5) ] to deeply equal []` (writes past the lease). 4 failed / 68 passed | 3 files 72/72 | fallout 5 files 193/193 (0); all 8 affected 265/265 (0); typecheck 0; eslint 0 |
| A12 | f931c447 fix(org-names): the cleanup's leftover preview counts a property once for a repeated member | planUnit: `expected [ {...}, {...} ] to deeply equal [ {...} ]` (two leftovers, one property); dry run: Smyrna `count` 2 not 1, Step Up 3 not 2. 2 failed / 36 passed | cleanOrgNames 38/38 | typecheck 0; eslint 0 |
| A13 | 0d278206 docs(issues): file the four org-name races and layout residuals code review round 3 ruled to file | n/a (docs) | `npm run issues` exit 0 (374 open / 197 closed / 571; no warnings; all four indexed) | `tr` count 0 on each file |

## Final gates (after the last commit)

- `cd app; npx vitest run` on the 8 files touched or importing a changed module:
  orgRecords, orgRewriteJob, orgRewriteService, cleanOrgNames, organizationsApi,
  registerHandlers, relayRetryLeg, mmsSendGuard (via routes/api.ts) - 267/267, exit 0, no
  skips, no `[dynamoAdmin]` line.
- `npm run typecheck`: exit 0. `npm run issues`: exit 0.
- Lint preview: `npx eslint` on the 7 `.ts` files the three commits touched - exit 0.

## A11 - what changed

- `services/orgRecords.ts`: `beat()` moved from the END to the TOP of each record
  iteration in both loops (units, contacts) - before matching and writing.
- `services/orgRewrite.ts:87`: `ORG_REWRITE_LEASE_MS = ORG_REWRITE_STALE_MS - 60_000`,
  exported beside the lock.
- `jobs/orgRewrite.ts:95`: `leasedHeartbeat` wraps `orgRewrite.heartbeat`; the lease starts
  at the claim (`:128`, read before the claim is sent) and moves on each heartbeat that
  answers true. Inside the lease a throw is rethrown (the pass logs it and goes on); past
  it the wrapper answers false, so the pass throws OrgRewriteLockLostError and the job
  returns `lock_lost` without finish. ONE lease across every pass of the rewrite.
- `scripts/clean-org-names.ts`: `lockedAt` (`:574`, read on the `opts.now` seam before
  `acquireForCleanup`) passed to `run()`; `beat()` keeps `leaseFrom` (`:680`) and throws
  CleanupLockLostError for a throw past the lease (PARTIAL, lock not released).
- Docs: the job header ("so no record is written under a lapsed lock" -> the pass STARTS
  under a fresh lock; the beat before each record; the lease; the in-flight write no check
  covers), the RUNBOOK cleanup lock paragraph (the next heartbeat that reaches the list
  sees a lapse; failing heartbeats stop the apply at 14 minutes).
- A6: its tests and the claim are untouched and green (orgRewriteJob's R2-BE-1 block,
  orgRewriteService's claim/heartbeat cases).

## Divergences and decisions

1. Lease timing: each start of the lease (claim, acquire, a heartbeat that answered true)
   is the time the call was SENT, never when its answer arrived - the stored heartbeatAt
   is computed after the send, so the lease can never outlive it by the call's latency.
   The age of a THROWN heartbeat is judged when it throws (a call that hung, then threw,
   is judged at its end). Boundary `>=` (age >= lease = lost), as the 15-minute staleness.
2. A third overclaiming line, same claim as the job header, fixed beyond the two named:
   the claim's `(c)` comment in `services/orgRewrite.ts` ("so no record is written under a
   lapsed lock" -> "the pass STARTS under a fresh lock").
3. The cleanup's lost-lock MESSAGE changed: it said "it lapsed (15 minutes without a
   heartbeat) or another rewrite took it over", untrue for the lease path; now "another
   rewrite took it over, or it went 14 minutes without a refreshed heartbeat (it lapses at
   15)". The RUNBOOK's quoted `lost the organization-list rewrite lock` is unchanged; no
   test asserts the message. Comment-only updates beside it: orgRecords header, rewrite()
   doc, OrgRewriteLockLostError doc and the beat's comments; the cleanup header,
   CleanupLockLostError doc and `CleanupOpts.now` doc.
4. Existing test changed: orgRecords "heartbeats at most every 20 seconds, and a failed
   heartbeat does not stop the pass" runs 7 records instead of 6 (beats stay 2, counts
   `agency: 7`), so it means the same under either placement - it passed on the pre-fix
   code too (in the RED run). orgRewriteJob's takeover test: comment only ("heartbeats
   before every record after the first").
5. Tests beyond the two interleavings: the pass-level pin of the beat placement in BOTH
   loops (contacts and accepted_authorities), and the cleanup's lease (DynamoDB Local,
   `scanLimit: 1`, a doc wrapper advancing the seam clock 5 minutes per Scan page; beats
   at 5 and 10 minutes throw and continue, the one at 15 stops it).
6. Job test (b) lets the VA act at 12:15 "whether or not the pass still runs": inside the
   write hook on the old code (mid-pass), after the run on the fixed code (the pass
   stopped at 12:14:10, 34 records written, all before the lapse). It also asserts the
   lock is left unfinished and Run again then refuses 409 `org_rewrite_target_gone`.

## A12 - what changed

- `planUnit` leaves ONE leftover per value per property (a `leave()` helper used by both
  the unresolved-member and the kept-agency paths), and bumps `unitAgencyMembersKept` only
  for the first occurrence of a kept agency (the repeat is the duplicate the list drops,
  counted in `unitDuplicatesRemoved` as before). De-duped in the plan itself, so
  `RecordPlan.leftovers` and the tally agree. `unitAgencyMembersKept`'s doc says so.
- Not changed: `unitAgencyMembersDropped` (`clean-org-names.ts:308`) still counts each
  dropped member - each is a real removal from the list; not in the ruling.

## A13 - files

`docs/issues/org-list-write-retry-reads-as-lost-race.md` (R3-BE-2),
`org-provisional-entry-concurrent-rename.md` (R3-FE-2),
`org-settings-details-read-no-age-cap.md` (R3-FE-4), `org-picker-note-wrap-reflow.md`
(R3-FE-7; says live self-QA checks it at 360 px). All type bug, severity low, status open,
created 2026-10-07. Refs re-pointed to the CURRENT lines (the reviewer's
`services/orgRewrite.ts` lines moved after A11's constant); dashboard refs verified at this
tree - FW3-B may shift them.

## Out of scope, noticed (no change made)

1. Pass-boundary pacing: each pass resets its 20-second pacing at its start
   (`app/src/services/orgRecords.ts:501`), so a rename's second pass can write its first
   records up to about 20 s after it starts without a beat - about 40 s after the
   previous pass's last attempt. Inside the lease's 60-second margin; a stalled read at
   pass start is still caught (the pacing clock is set before the first page read).
2. A record write already in flight when the lock lapses is covered by no client-side
   check (the conditional write tests the record, not the lock); now stated in the job
   header.
3. `finish()` (`app/src/services/orgRewrite.ts:296`) still checks id and status only, not
   freshness. After A11 a run reaches it on a lapsed lock only when the end of its last
   pass plus the finish call outlast the lease's margin.
