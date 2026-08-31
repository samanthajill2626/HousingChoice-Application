# HANDBACK - error-surface-detail (2026-08-25)

MERGE-READY @cdf028a7 on feat/error-surface-detail (W:\tmp\error-surface-detail), 32 ahead,
0 behind main, UNMERGED (human gate). Tree clean. All four gates green ON cdf028a7 exactly.

## POST-MERGE OPS OWED - LOUD, AS REQUESTED TWICE

TERRAFORM PLAN AND APPLY, dev AND prod, BEFORE DEPLOY. T14 added a SCOPED
SystemStatusGetLogRecord statement (infra/modules/ec2/main.tf:311-318). Until applied, the
detail expander fails authorization in deployed envs and degrades to
{ available: false, reason: 'cloudwatch_error' } - the panel works, the "Show all" record
does not. IAM branch note: the plan pinned resources = ["*"], but AWS's machine-readable
service reference (servicereference.us-east-1.amazonaws.com/v1/logs/logs.json, retrieved
2026-08-24) lists GetLogRecord with Resources: log-group, so per the spec's
default-to-scoped rule it shipped SCOPED to /hc/<env>/* (same two ARN forms as StartQuery).
AFTER APPLYING: click "Show all" on a real error row in dev. If it unexpectedly degrades,
the fallback is moving logs:GetLogRecord into the "*" statement - the app-level env scope
check (services/systemStatus.ts rejects foreign @log) is the real boundary either way.
No other infra, secrets, SSM, or deploy actions were taken or are owed by this branch.

## Work map (16/16 shipped)

- T1 job dispatcher message -> `job failed: <jobName>` @512953fb - shipped.
- T2 Express handler 3 distinct messages + routeLabel + PII-refusal test @122aec68 - shipped;
  errors.ts is now WHOLE-FILE ASCII (all five em-dashes, incl. 'uncaughtException - exiting';
  nothing asserted them).
- T3 pollRunId through the envelope @35eeaa86 - shipped; observed LIVE on a worker WARN line
  during self-QA boot.
- T4 widened projection @cd608a63 - shipped; ALSO fixed a 9th fixture the plan missed
  (system.routes.test.ts:134 + exact-match assertion) - without it the tree stayed red.
- T5 dedup on ref @0448676a - shipped (test used deployedConfig(), not the plan's
  nonexistent CONFIG).
- T6 GetLogRecord seam + ERR_ALLOWLIST @b7371d89 - shipped; hardened in review: bare `err`
  now admitted only when NOT a JSON object; enforceBound now GUARANTEES the 64KB bound and
  runs one measure per pass (was quadratic: 16.1s -> 0.5s at 3000 fields, A/B measured).
- T7 detail route + env scope check @e6999215 - shipped.
- T8 trace seam @32173e8c - shipped; disjoint floor/floor+1 second boundary intact (an
  adversarial one-second-hole claim was REFUTED by the planner's real measurement - event at
  ms .554 returned by startTime==endTime==floor - now cited in the code comment).
- T9 trace route @e005b417 - shipped; `at` later tightened to ISO shape (review F9).
- T10 dashboard mirror + client fns @e35b0cdf - shipped.
- T11 detail/trace hooks @f5922e2e - shipped; unmount aborts added in review (F5).
- T12 widened row + expander + ErrorDetail @17928dcd - shipped; row key hardened to
  ref|timestamp|message (OOM-relabel double-match, review F4).
- T13 ErrorTrace @8b4cac96 - shipped; anchor is now PTR-EXACT (review F7: @ptr on trace rows
  end-to-end, anchorRef prop, empty-ptr guarded) - deviation from the plan's
  timestamp-equality marking, planner-directed.
- T14 terraform @86595425 - shipped WRITE-ONLY (fmt-check + validate only; no plan/apply/
  state anywhere); SCOPED branch per the verified service reference (see ops above).
- T15 truth-up @7e83518c + issue @85c1a82b - shipped: 16 PII-posture sites rewritten (incl.
  2 the spec's list missed), RUNBOOK DLQ row gains the panel affordances with the Insights
  technique preserved verbatim, docs/issues/cloudwatch-log-cp1252-mojibake.md filed (refs
  verified still holding real em-dashes), npm run issues run (INDEX gitignored). The perf
  citation ledger half was DEFERRED to post-sync by planner directive and completed
  @cdf028a7: 77-132 -> 86-141 and 124-132 -> 133-141, routes.ts + collect.test.ts updated
  TOGETHER, order pin + '140-155' negative pin + cited() shape re-verified against the
  MERGED files. Endpoint registry untouched - verified the profiler never reaches the new
  endpoints (spec obligation 1's no-op branch).
- T16 e2e degraded assertions @03a3e2ed - shipped below the existing block; the
  toHaveCount(2) pin intact; survived the main merge cleanly.

## Gates on the FINAL commit (cdf028a7, post-sync)

- npm run typecheck: EXIT=0 (all 5 workspaces)
- npm test: EXIT=0 - app 5842 passed / 9 skipped (328f+1s), dashboard 2710 (174f),
  e2e-vitest 492 (19f), fake-twilio 240 (34f), ft-web 111 (13f) = 9,395 passed, 0 failed
- npm run smoke: EXIT=0 - "smoke-dist: OK - 1327 import specifier(s) across 234 emitted
  file(s) resolve under plain Node."
- npm run e2e: EXIT=0 - "254 passed (17.9m)", 0 unexpected, 0 flaky
Pre-sync battery was also fully green at bd1c5a26 (typecheck 0; test 9,264p; smoke 0;
e2e 253 passed / 0 flaky, 986s). No flake re-runs were needed in either battery.
db:start was never run (container already up; post-sync main's db.mjs would force-recreate
the SHARED container - left for a moment no sibling worktree is mid-suite).

## Commits (22 + merge)

Build: 512953fb 122aec68 35eeaa86 cd608a63 0448676a b7371d89 e6999215 32173e8c e005b417
e35b0cdf f5922e2e 8b4cac96 17928dcd 86595425 7e83518c 85c1a82b 03a3e2ed
Review closure: 958b4409 bebe35db 305123e5 bd1c5a26
Sync: 326f26ff (ONE merge of main, CONFLICT-FREE) then cdf028a7 (perf citations)
Feature delta vs main: 32 files, +7737 / -162 (includes the spec/plan/review docs).

## Review record

Round 1 (parallel): SPEC-CONFORMANCE - all 16 tasks CONFORM (one PARTIAL: a spec-named test
missing), global-constraints table verified line-by-line. ADVERSARIAL (plan-blind by
mandate) - 0 MUST-FIX, 4 SHOULD-FIX, 7 CONSIDER, 4 NIT, plus 13 documented refuted-sweeps.
Planner adjudication -> ONE fix wave (F1-F9 + R1-R3 comments + AJ71 record annotation);
notable: F1 enforceBound bound-violation PROVEN with numbers; F7 ptr-exact anchor taken.
REJECTED with grounds: the trace-window one-second-hole (refuted by real measurement,
receipts now in the code comment), non-err passthrough (by design, zero live sites),
dedup capacity semantics (spec-adjudicated).
Re-review (fresh): all FW items CLOSED; found NEW-1 (the fix wave's own enforceBound went
quadratic - 16.1s synchronous block, measured) and NEW-7 (empty-ptr anchor/key collapse) ->
micro-closure @bd1c5a26 with A/B measurements and discrimination-proved tests; I read that
diff personally in lieu of a fourth round.
DEFERRED TO THE HUMAN (planner holds it): adversarial C3 - each trace click = two Insights
StartQuery executions over a 35-min bracket, unmetered, admin-only, sameSite:lax cookie
reachable by top-level cross-site GET (no authz break; /errors was already a 3-query
click). The re-reviewer recommends it land in docs/issues/ before cleanup because the only
current record lives in gitignored .superpowers/ - NOT filed per planner instruction;
decision is the human's.

## Self-QA (lane 4, artifacts in the MAIN checkout's .playwright-mcp/)

Real hermetic backend: degraded state verified end-to-end - exactly 2 "Available in
deployed environments." notices, ZERO row controls (selfqa-degraded.png).
Worst-case walk (fetch-stubbed payloads, MEASURED not eyeballed): 0px horizontal overflow
at every state; err.stack scrolls INTERNALLY (238px viewport over 2,194px content); rawText
container 238/1,042; exactly ONE "this failure" chip across 51 trace lines; both per-side
cut-off notices; both (truncated) markers; host + unknown chips; byte-bound notice;
log-group line; aria-expanded true when open; the id-less host row offers NO trace control
(selfqa-expanded-trace.png, selfqa-host-rawtext.png, selfqa-trace-anchor.png). Visual bar:
chips and detail list sit cleanly in the panel idiom.

## Issues filed / updated

- FILED: docs/issues/cloudwatch-log-cp1252-mojibake.md (spec section 9; pure ASCII).
- UPDATED: fake-twilio-messaging-attach-404.md (new message signature, old form preserved
  for pre-2026-08-24 searches); system-status-errors-oldest-first-scan.md (retired PII
  phrase); design-review AJ71 annotated as superseded by the amended spec.

## Sub-threshold notes (not blocking; your eye)

1. ErrorDetail's degraded copy for NON-local reasons is 'Could not load the full record.'
   (only unavailable_local reuses the pinned panel string) - keeps the page-wide
   toHaveCount(2) pins safe; my call, worklist F6.
2. ErrorTrace renders timestamp+source+message (the plan's pinned component); spec S6
   mentions optional per-row diagnostic fields - plan won per authority order. Additive
   later if wanted.
3. The trace view's source chip shows raw 'system' while the row maps system->'host' -
   unreachable today (trace queries app+worker only).
4. RecentErrors.test.tssx:86 title still says "...correlationId ONLY" - planner deferred
   the rename; assertions are correct.
5. The decision record contradicted the amended spec on errMessage (AJ71) - annotated, not
   rewritten; shipped follows the spec.
6. Recovery tally (auditable in heartbeat.log): ONE infra-tier event - the ENOTFOUND
   transport failure that killed my turn and both round-1 reviewers mid-task; both resumed
   once, successfully. Zero agent-failure-tier recoveries; no child needed recovery twice.

MERGE-READY @cdf028a7 on feat/error-surface-detail (W:\tmp\error-surface-detail), 32 ahead
of main, 0 behind, UNMERGED (human gate). Post-merge ops: TERRAFORM PLAN+APPLY dev AND
prod (above) - the detail expander is BROKEN-DEGRADED in deployed envs until applied.
No cleanup performed; branch left at cdf028a7.
