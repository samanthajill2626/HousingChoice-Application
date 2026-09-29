> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/slice-2-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Slice 2 report (Tasks 6-7) - share-skip-fix

Run state (git-ignored). Worktree W:\tmp\share-skip-fix, branch feat/share-skip-fix,
start HEAD a0041966 (base main@bbaad87d).

## Task 6 - reasons on every skip, skipped_other bucket, finalize log (commit d9f9925c)

### Red seen (Step 5), one file per run
- app/test/deriveBroadcastStats.test.ts: EXIT=1, 2 failed | 3 passed
  - "computes every bucket from the map (disjoint), audience = map size":
    `expected { audience: 6, queued: 1, ...(6) } to deeply equal { audience: 6, queued: 1, ...(7) }`
  - "skipped split (share-skip-fix D7): ...": `expected 1 to be 2 // Object.is equality`
  - INVARIANT test stayed green (a pin: `?? 0` on an absent field, old split still sums).
- app/test/broadcastFanOut.test.ts: EXIT=1, 3 failed | 28 passed
  - "skips an opted-out recipient ...": `expected undefined to be 'opted_out'`
  - "share-skip-fix D7: an UNREACHABLE recipient ...": `expected { status: 'skipped' } to deeply equal { status: 'skipped', ...(1) }`
  - "share-skip-fix D7: a manual-mode refusal ...": `expected undefined to be 1` (stats.skipped_other)
- dashboard StatChips.test.tsx: EXIT=1, 1 failed | 11 passed
  - "share-skip-fix D7: the Skipped chip also sums skipped_other ...": `expected 'Skipped5' to contain '9'`

### Step 3 bumpStats verification (watch item) - GREEN, before any code change
- Run: `npx vitest run test/broadcastsRepo.integration.test.ts` -> EXIT=0, 20 passed.
- Verbose, quoted:
  `PASS ... > share-skip-fix D7: bumpStats ADDs skipped_other onto a persisted stats map that predates the field (a share mid-send at deploy) 18ms`
- Re-run after adding a precondition read (see deviations) -> still GREEN (20ms), and
  GREEN again after the Task 6 code (where create() now seeds skipped_other: 0 and the
  REMOVE does real work). DynamoDB Local creates the absent nested counter with
  `ADD stats.#sk<i> :sv<i>` under an existing map. bumpStats NOT changed (no SET idiom).

### Green (Step 7), one file per run
- app: deriveBroadcastStats 5/5 EXIT=0; broadcastFanOut 31/31 EXIT=0;
  broadcastsRepo.integration 20/20 EXIT=0; broadcastApi 65/65 EXIT=0;
  twilioStatusWebhook 52/52 EXIT=0 (plan's neighbour); seedMatrix 51/51 EXIT=0;
  performanceSeed 134/134 EXIT=0 (N2).
- dashboard: StatChips 12/12 EXIT=0; neighbours that read BroadcastStats, one per run:
  BroadcastResults 11/11, BroadcastsList 11/11, useBroadcastResults 5/5,
  broadcastFormat 12/12 (all EXIT=0).
- npm run typecheck (after Task 6): EXIT=0, 0 `error TS`.
- ASCII (added lines, all 11 files): 0 bytes each.

### Deviations (Task 6)
- broadcastsRepo.integration.test.ts Step 3 case: added a precondition GetCommand
  (ConsistentRead) asserting the stored stats map has NO skipped_other and queued 1
  before the bump, so the pin provably exercises the absent-key path (after Task 6,
  create() seeds skipped_other: 0 and the REMOVE must actually remove it). GetCommand
  was already imported.
- broadcastsRepo.ts `BroadcastStats.skipped_opted_out` field doc reworded (ASCII): it
  said "opt-out/unreachable", wrong once unreachable goes to skipped_other. Not in the
  plan's list; same class as N1.
- finalize: a 3-line comment above the new derived log (the plan's rationale text).
- Header (N1): `:9-10` rewritten (kept the original "TCPA second fence" wording, only the
  bucket/reason facts changed); SendRefusedError bullet at `:25-26` rewritten. Both ASCII.
- Commit message: plan's text plus a paragraph recording the GREEN bumpStats outcome.

## Task 7 - dashboard-created shares send as a person's send (commit 871bb3a8)

### Red seen (Step 4), one file per run
- app/test/broadcastApi.test.ts: EXIT=1, 1 failed | 65 passed
  - "share-skip-fix D4: a draft created through the dashboard route records created_via dashboard":
    `expected undefined to be 'dashboard' // Object.is equality`
- app/test/broadcastFanOut.test.ts: EXIT=1, 1 failed | 35 passed
  - "share-skip-fix D4: a DASHBOARD share reaches a switched-off (manual) conversation ...":
    `expected [] to deeply equal [ '+15550100001' ]`
- app/test/sendMessage.test.ts: EXIT=1, 1 failed | 33 passed
  - "share-skip-fix I8: a `recipient` item makes the consent + deleted gates judge THAT contact ...":
    `promise rejected "ContactNoConsentError: contact for conver... { code: '...' }" instead of resolving`
- PINS, already green before the Task 7 code (verbose run, `-t share-skip-fix`): I1 (opt-out,
  no-consent, soft-deleted, both), I8 duplicate-consent, I8 phone#-keyed, I2 (no created_via
  still refused manual_mode). Reported as pins, not reds.

### Green (Step 6), one file per run
- broadcastApi 66/66, broadcastFanOut 36/36, sendMessage 34/34, contactsBatchReads 10/10,
  contactsBatchIncomplete 6/6, seedMatrix 51/51, performanceSeed 134/134 - all EXIT=0 (N2 list).
- Extra neighbour (only other app test that hits /api/broadcasts): rateLimit 16/16 EXIT=0.
- npm run typecheck: EXIT=0, 0 `error TS`.

### Deviations (Task 7)
- broadcastFanOut.ts header: besides the plan's two bullets (token bullet, SendRefusedError
  bullet), the first-fence bullet gains the deleted fence and the sendMessage bullet gains
  "a dashboard share is a PERSON'S send ... recipient rides along (I8)". ASCII.
- N1: refusal-branch comment (formerly :492-494) rewritten in ASCII.
- NOT in the plan or N1: the comment directly above the send call (formerly :414-416,
  "conversation-level opt-out / breaker / manual", em dash) rewritten in ASCII to list
  opt-out / deleted / consent, or manual / breaker on an automated share - the new D4 lines
  beneath it would otherwise read as contradicting it.
- Seeds: a short ASCII comment above each new `created_via: 'dashboard'` line.
- Route comment taken verbatim from the plan; its "sessionMiddleware + requireAuth on /api"
  claim checked against app/src/app.ts:217-223 and routes/api.ts:5.

## Final verification at HEAD 871bb3a8 (one file per run)
- app: deriveBroadcastStats 5/5, broadcastFanOut 36/36, broadcastsRepo.integration 20/20
  (not skipped), broadcastApi 66/66, sendMessage 34/34, contactsBatchReads 10/10,
  contactsBatchIncomplete 6/6, seedMatrix 51/51, performanceSeed 134/134 - every EXIT=0.
- dashboard: StatChips 12/12 EXIT=0.
- `[dynamoAdmin]` lines across every captured run log: 0.
- `npm run typecheck` -> EXIT=0 (0 `error TS`).
- `npm run smoke` -> EXIT=0 ("smoke-dist: OK - 1413 import specifier(s) across 248 emitted
  file(s) resolve under plain Node.").
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` (26 files, merge base
  bbaad87d) -> EXIT=1, 3 errors, ALL pre-existing at the merge base:
  ```
  W:\tmp\share-skip-fix\app\src\lib\seed\matrix.ts
    134:7  error  'DEADLINE_TYPES' is assigned a value but only used as a type. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars
  W:\tmp\share-skip-fix\app\test\importApply.integration.test.ts
    745:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
    824:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  ```
  Baseline proof: `git show bbaad87d:<file> | npx eslint --stdin --stdin-filename <file>`:
  matrix.ts -> the identical 134:7 error (EXIT=1); importApply.integration.test.ts -> 739:59 and
  818:59 (the slice-1 baseline; shifted +6 by slice 1's edits). matrix.ts is NEW to the gate
  list in slice 2 (slice 1 never touched it) - name it in the handback's gate-5 baseline.
- ASCII, `git diff -U0 bbaad87d..HEAD -- <file>` added lines, all 15 slice-2 files: 0 bytes each.
- Working tree clean after both commits (git status --short empty).

## Noticed, not changed (whole-branch review candidates)
1. broadcastsRepo.ts bumpStats comment still says "stats fields pre-exist (create/markSending
   seed them), so ADD on a nested numeric attribute is safe" - the premise is false for a legacy
   row without skipped_other; the conclusion holds (Step 3 pin GREEN). Left per "nothing more to do".
2. deriveBroadcastStats.test.ts INVARIANT test NAME still lists six buckets; its sum now adds
   skipped_other (the plan changed only the sum).
3. The finalize log dropped its old `skipped` field (was the PERSISTED skipped_opted_out) for the
   derived bucket fields. No reader in app/test, e2e, RUNBOOK, infra; an external saved Logs
   Insights query (not in the repo) cannot be ruled out.
4. retrySend.ts:105 (the 30003 auto-retry) still sends `automated: true` with no recipient, so a
   retry of a DASHBOARD share into a switched-off conversation is refused manual_mode. Spec I8
   says retries keep today's gates - correct per spec; flag for RSW, which owns that path.
5. sendMessage.ts opt-out log: `contactId: contact?.contactId` names the RECIPIENT even when the
   refusal came from the phone-matched duplicate's flag (plan's code verbatim; rare case).
6. broadcastFanOut.ts: the code comment calls the opt-out check the "TCPA first fence" while the
   header calls it "the TCPA second fence" (pre-existing; header wording kept).
7. phone#-keyed recipients are judged on whichever contact findByPhone returns first (it ignores
   deleted_at), so a soft-deleted first match is skipped contact_deleted even if a live duplicate
   exists - the same outcome as before (the wrapper refused it), now earlier and without creating
   a conversation.
8. matrix.ts broadcast-mx-sent-01 (a SENT seeded share) carries no created_via - per the plan
   (only the draft); harmless because it is never re-sent.

## Blockers
None. No helper/signature mismatch; seedBroadcast's third arg exists; no test outside the
slice's files failed; bumpStats verification GREEN (no SET idiom).
