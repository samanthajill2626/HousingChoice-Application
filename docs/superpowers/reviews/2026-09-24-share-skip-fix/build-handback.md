# Build handback - share-skip-fix (Branch A)

Date: 2026-09-25. Orchestrator: Claude Fable 5.1 (AUTO mode). Branch
`feat/share-skip-fix`, worktree `W:\tmp\share-skip-fix`, base main@bbaad87d,
synced to main@cd8e8ddd.

Sam's improvements #5 (a one-to-one property share ends "Skipped" on every retry
for particular tenants, then the review marks them "Already sent") and #4
(mid-conversation the share should be just the address and the link). Spec
`docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A, v10);
plan `docs/superpowers/plans/2026-09-25-share-skip-fix.md` (v3).

## MERGE-READY @813c0c44 on feat/share-skip-fix (W:\tmp\share-skip-fix), 0 behind main, UNMERGED (human gate)

All five completion gates green on the synced merge commit 813c0c44 (one commit;
the merge added no code to this branch's files, so the review/self-QA on
d23a2d23 hold verbatim). Never merged to main - the human owns that.

## Work map (spec decisions and invariants)

- D1 census (read-only) - SHIPPED. `app/scripts/conversation-automation-census.ts`;
  counts by type/switch state, switched-off by cause (with the breaker-tripped
  list and its evidence: audit event or the send counter), pending tour rungs
  replayed through the reminder job's own routing (an upper bound), held nudges,
  import claim mismatches.
- D2 fix script (dry-run-first) - SHIPPED. `app/scripts/enable-conversation-automation.ts`;
  bulk + single (breaker-resume) modes; one-to-one manual rows only (typeless
  included, group/pointer never); breaker-tripped excluded unless asked; switch +
  audit event in ONE transaction; every write conditional.
- D3 import default - SHIPPED. `app/src/lib/import/apply.ts`: one-to-one rows
  import `auto`, group rows `manual`, `if_not_exists` unchanged.
- D4 / I1 / I2 / I8 staff shares are person's sends - SHIPPED. The draft route
  records `created_via: 'dashboard'` (`app/src/routes/broadcasts.ts`); the fan-out
  sends those `automated: false` and hands the wrapper the fenced recipient
  (`app/src/jobs/broadcastFanOut.ts`, `app/src/services/sendMessage.ts`); kill
  switch, opt-out (either contact's flag), deleted and consent still refuse; a
  deleted fence sits after opt-out/unreachable, before consent; phone#-keyed
  recipients send.
- D5 / I3 / I4 "Already sent" + review list - SHIPPED. `priorRecipientContactIds`
  excludes `skipped` slots (repo + harness double); `failed` still counts (interim
  rule); seeded rows (preview seed, hand-add, or an already-listed row a staffer
  picks) start checked and survive "Select all"; the note reads
  `Flagged tenants you picked stay checked; "Select all" skips the others.`
- D6 "Not sent" - SHIPPED. `presentShareLabel` labels an all-skipped finished
  share "Not sent" on the results header and the list row; presentation only.
- D7 reasons + honest counts - SHIPPED. Every skipped/failed row shows its
  plain-word reason (`SHARE_SKIP_REASONS` in `deliveryStatus.ts`,
  `shareRecipientReason` in `broadcastFormat.ts`); the `skipped_other` bucket
  (derived AND persisted); the Skipped chip sums all three; the finalize log reads
  the derived stats. 30003 wording and `deliveryReason` options/order untouched.
- D8 one-to-one default text - SHIPPED. `ONE_TO_ONE_SEND_TEMPLATE = '[Address]
  [FlyerLink]'`; blasts keep `DEFAULT_SEND_TEMPLATE`.
- D9 RUNBOOK - SHIPPED. "One-to-one conversation automation switch (2026-09-25)":
  census/dry-run/apply (dev then prod, from the pinned ops checkout), the
  per-environment import-window rule, and "a conversation tripped the breaker".
- D10 issues - SHIPPED/present: `ai-mode-switch-gates-all-automation` (WP2, item
  8), `import-conversations-missing-phone-claim`,
  `tenant-timeline-property-sent-milestone-after-failed-delivery`.
- I5 (nothing turns a switch off), I6 (D2 only on, only one-to-one, every change
  audited via the transaction), I7 (prod written only by the Cameron-run script;
  no infra/index/dependency change) - HELD.

DEVIATED: none of substance. Adjudicated spec-vs-tree calls, all recorded:
I3's second clause read as D6's scope (a share in which every recipient was
skipped never reads "Sent"); the census/fix-script treat the breaker's send
counter as trip evidence (a mid-run trip cannot lose the conditional write, since
the trip writes `manual`); the dev/prod client pins the regional endpoint and
refuses `AWS_ENDPOINT_URL*`. SKIPPED: nothing in the work map.

## Gates on the FINAL commit 813c0c44 (bare, from the worktree; logs under .superpowers/sdd/gates-synced/)

- `npm run typecheck` -> EXIT 0.
- `npm test` -> EXIT 0. Test Files: app 369 passed (369); dashboard 191 (191);
  e2e-unit 21 (21); fake-twilio 34 (34); fake-twilio-web 13 (13). `[dynamoAdmin]`
  lines: 0. (`npm run db:start` up.)
- `npm run smoke` -> EXIT 0 ("1413 import specifier(s) across 248 emitted file(s)
  resolve under plain Node").
- `npm run e2e` (Git Bash, `timeout 1500`) -> E2E-EXIT=0, "278 passed (20.2m)",
  0 failed, 0 flaky, 0 `[dynamoAdmin]` lines. (The pre-sync run on 34dc2bea was
  also 278 passed, EXIT 0.)
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx'
  '*.js' '*.mjs' '*.cjs')` -> EXIT 1, exactly the 14 PRE-EXISTING errors on 5
  files (baseline-confirmed at bbaad87d): cast.ts (4), BroadcastComposer.tsx (4
  react-hooks/set-state-in-effect), BroadcastComposer.test.tsx (3 no-unused-vars),
  matrix.ts (1 DEADLINE_TYPES), importApply.integration.test.ts (2 no-explicit-any).
  NO new errors in touched files. Gate 5 = no new errors -> PASS.

## Commits, files, delta

49 commits on main..HEAD. Source commits (feat/fix): 524fcf41, c942ce20,
cd91837e (slice 1); f0a6fbc0, 1ba49fc0, 9405d678, cff2f11c (slice-1 fixes);
d9f9925c, 871bb3a8 (S2); f199dc4c, ea0f5318 (S3); e4fb6085, 3d644264 (S4);
3993b5f7 (S5); 38f13413, 34dc2bea (S6); 7f80905b, d23a2d23 (whole-branch fix
wave); 813c0c44 (merge main). The rest are docs (spec v1-v10 over 5 review
rounds; plan v1-v3 over 2 rounds; build research; slice-1 + whole-branch review
reports and adjudications; RUNBOOK; issue filings). Net vs base, this branch's
own files (main...HEAD): 51 files, +3289/-188 non-docs. Files touched: the two
ops scripts + `stageClient.ts`, `import/apply.ts`, `broadcastsRepo.ts`,
`broadcastFanOut.ts`, `sendMessage.ts`, `routes/broadcasts.ts`, `auditRepo.ts`,
`unreadFeed.ts`, the seed files (`lean.ts`, `matrix.ts`, `performance.ts`), the
dashboard broadcast components (`broadcastFormat.ts`, `deliveryStatus.ts`,
`RecipientPreview.tsx`, `DeliveryBadge.tsx`, `BroadcastStatusPill.tsx`,
`BroadcastsList.tsx`, `BroadcastResults.tsx`, `StatChips.tsx`,
`resolveTemplate.ts`, `BroadcastComposer.tsx`, `MessageEditor.tsx`,
`api/types.ts`), the harness double, RUNBOOK.md, and the e2e specs, each with
its tests.

## Review + adjudications

- Live-tree drift check (3 readers): 2 MUST-ADJUST (RUNBOOK JSON via `file://`;
  CLI parser tests + a rehearsal that writes) + 11 NOTES, all accepted.
- Slice 1 (ops, reviewed on its own before Cameron's runs): round 1
  (conformance + plan-blind adversarial) 0 MUST-FIX / 9 SHOULD-FIX -> 14-item fix
  wave; round 2 (fresh reviewer) 0 MUST-FIX / 2 SHOULD-FIX -> 7-item wave 2.
  Both converged on two mechanisms, both fixed: a mid-run breaker trip cannot
  lose the conditional write (the send counter is now trip evidence), and the
  switch + audit are one transaction.
- Whole branch (slices 2-6): conformance 0 MUST-FIX / 2 SHOULD-FIX / 5 NOTE;
  plan-blind adversarial 0 MUST-FIX / 2 SHOULD-FIX / 8 NOTE. Fix wave: one
  behavior fix (Add-a-tenant silently dropped an already-listed flagged row -
  contradicted the shipped note) + test hardening (I8 phone-side, fence order,
  kill switch, finalize-log-reads-derived, bucket-sum) + comment fixes. Every new
  test mutation-proven. Out of scope, filed/recorded: "Sent to N tenants" counts
  skipped (Branch B, confirmed in the B stub); a skipped+failed share reading
  "Sent" (interim D6, working as specified - spec R5-3 rejected widening D6); the
  skip-code drift guard (filed `broadcast-skip-code-drift-guard`, deferred behind
  SOR/RSW); pre-deploy drafts sending automated (by design D4, moot after the
  bulk enable). Adjudications:
  `docs/superpowers/reviews/2026-09-24-share-skip-fix/*-adjudications.md`.

## Self-QA (artifacts under .superpowers/sdd/)

The Playwright MCP browser build (chrome-for-testing) is absent in this
environment, so the UI EYEBALL was not run; verification was taken at the
data + presentation-logic boundary on the live lane (appCommit d23a2d23) and the
live-UI DOM layer is the passing e2e suite. Sam #5 measured live: a no-consent
one-to-one share -> the recipient slot `skipped`/`no_consent`, ZERO outbound
texts (the consent fence held), all-skipped stats, `presentShareLabel` -> "Not
sent" (D6), reason "No texting consent recorded" (D7). Sam #4: covered by
`resolveTemplate.test.ts` + the e2e DOM assertions. Note:
`.superpowers/sdd/self-qa-note.md`.

## Cameron's D1/D2 runs (relayed by the planner; verbatim in .superpowers/sdd/cameron-runs.md)

D2 outcome - NOT PENDING. Cameron ran census/dry-run/apply on dev AND PROD from
the pinned ops worktree (`W:\tmp\share-skip-fix-ops` @a0041966). Prod apply:
scanned 1236, planned/enabled 634 (621 unknown_1to1, 12 tenant_1to1, 1
landlord_1to1), 0 breaker-tripped, 0 skippedOnCondition, 0 failed, 204 already
on, 190 group + 208 pointer untouched. D1 prod census: 0 pending one-to-one tour
rungs released by the bulk apply (`rungsReleasedByBulkEnable` 0); full census
line no longer in his terminal, row counts per the apply line. The
import-window rule is now LIVE in prod: no `import:apply` from main until this
branch merges.

## Post-merge ops owed

- NO infra/deploy/secrets/SSM. I7 held: production was written ONLY by the
  Cameron-run D2 script, already done (above). Nothing terraform-side.
- BEFORE the merge, the import-window rule is live in prod (Cameron applied D2):
  do not run `import:apply` from main until this branch lands. It merges cleanly
  now (0 behind main).
- After merge: nothing. No new dependency, no migration, no flag.

## Relays for the sibling branches (idle until A merges)

- feat/retry-send-window (RSW): A touched NO 30003 wording or `deliveryReason`.
  A person-sent share that fails 30003 into a still-switched-off thread gets an
  automated retry (refused `manual_mode`) and shows "Phone unreachable - will
  retry"; that wording + the retry window are RSW's. Reading `retry_due_at` on
  the share results row is Branch B's (RSW's spec assigns it to share-skip-fix -
  it moved to B; recorded in the split record).
- feat/send-outcome-reconcile (SOR): SOR's adoption must read A's
  `created_via` record to stamp the audit row's `automated` flag. A's textual
  merge points are spec section 6 item 3; the results-row reason gate is
  `shareRecipientReason` in `broadcastFormat.ts`. MERGE-POINT HAZARD: any NEW app
  code on a FAILED share slot (SOR's `send_unconfirmed`, an RSW code) needs its
  own arm in `shareRecipientReason`, or it falls through to `deliveryReason`,
  whose internal map holds a whole-group sentence for `contact_opted_out`. File
  the broadcast-30003 slot-update issue in SOR itself (it is B's, not A's).

## Issues filed by this build

- `broadcast-skip-code-drift-guard` (debt; do after SOR/RSW).
- `ops-scripts-unpinned-dynamodb-endpoint`, `backfill-unread-flag-pointer-prefix-copy`,
  `runbook-inline-json-args-ps51` (pre-existing, out of scope; filed from slice 1).

## Known flakes / open questions

- No named flakes hit; 0 `[dynamoAdmin]` lines across every npm test run.
- Sub-threshold, your eye (not blocking): an unreachable+deleted recipient reads
  "Number can't receive texts" not "Contact was deleted" (both land in
  skipped_other; fence order matches the plan); the one-to-one default is
  " <link>" (leading space) on a property with no address (cosmetic; an available
  listed unit has one); the fan-out breaker-metering pin cannot be observed in the
  harness (its counter is a constant) - the e2e proves delivery into a switched-off
  conversation instead.
