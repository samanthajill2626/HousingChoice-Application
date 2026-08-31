# Handback - AI contact-kind suggestions

## Controller final addendum - 2026-08-27

`MERGE-READY WITH REPORTED MAIN DRIFT` on
`daea43a461d2536d999b7f753cb609e840e65a57`.

This addendum supersedes the builder result below. The controller restored the
hermetic browser path and completed live Partner and Property Manager QA. A
fresh plan-blind adversarial review then found that successful human-edit
suggestion cleanup did not broadcast `suggestion.updated`, leaving other tabs
and Today stale. The controller proved the defect red (2 failed / 72 passed),
implemented one coalesced post-delete event, and proved it green (74 / 74).
Fresh plan-blind and spec-conformance rereviews both passed with no findings.

Final required gates on `daea43a4`:

- `npm run typecheck` -> EXIT 0.
- `npm test` -> EXIT 0.
- `npm run smoke` -> EXIT 0: 1,343 import specifiers across 236 emitted files.
- `npm run e2e` -> EXIT 0: 256 / 256 passed in 18.6 minutes.
- Touched-file ESLint -> raw EXIT 1 for the same four merge-base diagnostics
  already listed below; merge-base stdin lint reproduced each diagnostic
  verbatim, so the branch introduces zero lint errors under the repository
  ratchet.
- `git diff --check main...HEAD` -> EXIT 0.

Hermetic live QA proved both exact suggestion labels and all four actions at
desktop and 390x844 without horizontal overflow. Partner persisted as
`type=partner`, `status=active`, no role, and `partner_1to1`; Property Manager
persisted as `type=landlord`, exact role `Property Manager`,
`status=interested`, and `landlord_1to1`. Both retained the automatic note and
left the Needs-triage and Today AI-review surfaces after classification.

The worktree is clean, no merge is in progress, and the isolated E2E ports are
clear. The branch is unmerged and undeployed; no backfill, production access,
infrastructure mutation, or feature-flag change occurred. Per the repository's
single-final-sync rule, later main drift was reported rather than silently
chased: at final audit the branch was 30 commits ahead and 40 behind local
`main` (`1467832bbffceabf8cc279b686d1156411c6ff03`). Human integration remains
responsible for that drift and the merged-result verification.

The builder handback below is retained as historical evidence from the earlier
`49146fba` handoff and its then-current browser blocker.

## Result

`NOT MERGE-READY`: all implementation, focused proof, required gates, and independent reviews pass on `49146fbad1b8190faf0e991f8cc2c812ca3d44fa`, but controller-owned visual self-QA could not navigate the hermetic session. The Browser bridge stopped before navigation with `Trusted RPC dependency must resolve within a configured trusted code path: file:///C:/Users/Cameron/.codex/plugins/cache/openai-bundled/browser/26.814.41407/scripts/browser-service.mjs`. A repeat would be a third budget-consuming recovery after the two recorded Vite EPERM recoveries, so it was not retried. The owned lane was stopped and its tables/lease were cleaned up.

## Work map

- S1 canonical kind type: shipped. Four exact kinds are `tenant`, `landlord`, `property_manager`, and `partner`.
- S2 revision-fenced persistence: shipped. Classification revisions prevent older pending type-run verdicts from overwriting newer contact-kind mutations.
- S3 extraction reconciliation: shipped. Stale type suggestions are retracted after extraction reconciliation; cleanup is bounded best-effort and raw forensic output remains retained.
- S4 full-kind PATCH reconciliation: shipped. Every kind is reconciled, including empty pre/post-write insertion and sequential older-revision replacement races.
- S5 four-kind dashboard: shipped. The dashboard provides accessible actions for Tenant, Landlord, Property Manager, and Partner.
- S6 runtime extraction activation: shipped. Runtime activation follows all consumers; D3 prompt examples avoid Tenant bias and make represented-client/caseworker meaning conditional.
- S7 Partner/Property Manager e2e: shipped. The focused flow proves both classifications through the full user path.
- S8 final sync, gates, review, and live QA: sync, proof matrix, gates, and review completed; visual QA blocked as stated above.

## Focused proof matrix on synced final commit

- `npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts test/extractionApply.test.ts test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts` -> EXIT 0, 7 files / 224 tests.
- `npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/extractionRepo.test.ts test/extractionRepo.integration.test.ts test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts` -> EXIT 0, 8 files / 266 tests.
- `npm run test -w @housingchoice/dashboard -- src/routes/contact/contactProfile.test.ts src/routes/unknown/UnknownFile.test.tsx src/routes/contact/ContactDetail.test.tsx src/routes/contact/ContactEditForm.test.tsx src/routes/contact/KindPicker.test.tsx src/routes/ai/AiRunsSection.test.tsx` -> EXIT 0, 6 files / 205 tests (existing React `act` warnings only).
- `npm run e2e -w @housingchoice/e2e -- tests/flows/conversation-fact-extraction.spec.ts` -> EXIT 0, 12 passed in 31.0s.

Artifacts: `final-proof-app-extraction.log`, `final-proof-app-contact.log`, `final-proof-dashboard.log`, and `final-proof-e2e-extraction.log` under this directory.

## Final required gates on `49146fba`

- `npm run typecheck` -> EXIT 0.
- `npm test` -> EXIT 0: app 337 passed / 1 skipped files and 6038 passed / 9 skipped tests; dashboard 175 files / 2732 tests; e2e workspace 19 files / 492 tests; fake-twilio 34 files / 240 tests; fake-twilio-web 13 files / 111 tests.
- `npm run smoke` -> EXIT 0: `smoke-dist: OK - 1343 import specifier(s) across 236 emitted file(s) resolve under plain Node.`
- `npm run e2e` -> EXIT 0: 256 passed in 17.5m.
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` -> EXIT 1 only for four merge-base-equivalent existing unused imports: `beforeEach` in `app/test/extractionApply.test.ts`, `WINDOW_CHAR_BUDGET` in `app/test/extractionJob.test.ts`, and `PlacementsPage` / `UnitsPage` in `dashboard/src/routes/contact/ContactDetail.test.tsx`. No branch-introduced lint error; this is non-blocking under the repository lint-ratchet policy.

Gate artifacts: `final-gate-typecheck.log`, `final-gate-npm-test.log`, `final-gate-smoke.log`, `final-gate-e2e.log`, and their exit markers under this directory.

## Review

- Spec-conformance review: PASS / S1-S7 CONFORMS, no findings. `sdd/2026-08-26-ai-contact-kind-suggestions/final-spec-review.md`.
- Plan-blind adversarial review raised M1 (durable reader suppression after an unrecoverable cleanup error), M2 (reconcile direct import mutation), and P1 (fake revision fidelity). Controller adjudicated M1 as beyond D11's explicit bounded best-effort/log-and-continue contract; M2 as outside the approved forward-only, no-import-change scope; P1 as non-blocking test-double hardening. `sdd/2026-08-26-ai-contact-kind-suggestions/final-review-adjudication.md`.
- Fresh adjudication rereview: PASS / CONCUR. It confirmed the M1 and M2 scope decisions and found no defect in the final test type-contract correction. `sdd/2026-08-26-ai-contact-kind-suggestions/final-adjudication-rereview.md`.

## QA and blocker

The controller launched only the isolated lane 2 (`:9201`, `:9211`, `:9221`) after confirming no listeners on prohibited live ports `:5174` / `:8080`. The session reached ready state and received only initial unauthenticated browser requests. Browser-controller setup failed before dev login or any visual action. `npm run e2e:stop` then reported `stopped session launcher`, `dropped lane 2 tables`, and `released lane 2 lease`; a final port check found no listener on either the live or lane ports. No production/live dashboard was accessed.

Automated e2e proof is green, including the Partner/Property Manager focused flow, but it does not replace the required controller visual QA. Restore the Browser trusted-code configuration or explicitly authorize a different QA method, then repeat the hermetic visual walk before declaring merge-ready.

## Branch and changes

Commits (newest first): `49146fba test: preserve extraction suggestion stub types`; `6edd776e docs: clarify resolved caseworker classification history`; `94caf95c test: prove AI partner and property manager triage`; `d3cef9ad fix: qualify represented contact AI example`; `4072e978 fix: neutralize AI contact kind prompt`; `cddac44d feat: activate four AI contact kinds`; `d4fb6f2c feat: offer four AI contact kind actions`; `42313627 test: pin pending type run proposals`; `fdd46af1 test: preserve retry replacement run fidelity`; `5c17222b test: cover contact kind reconciliation races`; `20638a46 feat: resolve AI suggestions by full contact kind`; `faa995f0 test: make AI finalization handoff causal`; `fd65d9ce test: cover AI type reconciliation handoff`; `3f96cfa5 feat: retract stale AI type suggestions`; `3fe5dde7 test: cover legacy run identity guard`; `66db467d test: cover classification fence legacy guards`; `fcf65dda feat: fence contact kind revisions`; `e8100f3e refactor: define AI contact kind union` plus approved spec/plan history.

Net versus `3c2962a4`: 39 files changed, 4810 insertions, 165 deletions. `git diff --check 3c2962a4..49146fba` -> EXIT 0. Branch is clean and `0` commits behind local `main`.

No infrastructure, deployment, or post-merge operation was performed. Human ownership remains: merge the branch; choose and perform the rollout of `AI_EXTRACTION_ENABLED` after the QA blocker is resolved.
