# Caseworkers branch B handback

STATUS: DONE.

MERGE-READY @98870155c65eae7d0a28980c47da0396ccc2c98b on feat/caseworkers (W:/tmp/caseworkers), 0 behind main, UNMERGED (human gate). This is the assessed tip before committing this handback record; that final documentation-only commit advances the same branch without changing the reviewed implementation. The final response reports its exact hash.

Implementation source: e0da8da38313e9f494d56bbbc96b8a3def720015.
Branch: feat/caseworkers. Worktree: W:/tmp/caseworkers. UNMERGED.

## Delivery

Caseworkers are partner contacts with the normalized Caseworker role. The branch adds their creation, guarded conversion and refusal preview, Possible caseworkers review, organization fields across both organization lists, the Caseworkers page and partner property shares. Existing recipient filters remain tenant-only. No seed contact was converted or dismissed by mission tests.

The approved 75-task plan is accounted for below. Source/evidence references are in code-review-conformance-r1.md and S1-report.md through S10-report.md; they are not duplicated as code quotations. Task 4.3 was closed by the atomic PATCH classification fix and independent rereview. Task 10.4 is an explicit deviation: the populated shared-picker batch remains 12 passed / 1 baseline failure. Its optional C6 fix is proven and saved, but unapplied pending the user's scope answer. No task is silently skipped. Both checkpoints passed.

| Task | Final disposition |
| --- | --- |
| 1.1 | shipped |
| 1.2 | shipped |
| 1.3 | shipped |
| 1.4 | shipped |
| 2.1 | shipped |
| 2.2 | shipped |
| 2.3 | shipped |
| 2.4 | shipped |
| 2.5 | shipped |
| 3.1 | shipped |
| 3.2 | shipped |
| 3.3 | shipped |
| 3.4 | shipped |
| 3.5 | shipped |
| 3.6 | shipped |
| 3.7 | shipped |
| 3.8 | shipped |
| 4.1 | shipped |
| 4.2 | shipped |
| 4.3 | shipped after CF-1 fix |
| 4.4 | shipped |
| 4.5 | shipped |
| 5.1 | shipped |
| 5.2 | shipped |
| 5.3 | shipped |
| 5.4 | shipped |
| 5.5 | shipped |
| 5.6 | shipped |
| 5.7 | shipped |
| 6.1 | shipped |
| 6.2 | shipped |
| 6.3 | shipped |
| 6.4 | shipped |
| 6.5 | shipped |
| 7.1 | shipped |
| 7.2 | shipped |
| 7.3 | shipped |
| 7.4 | shipped |
| 7.5 | shipped |
| 7.5a | shipped |
| 7.6 | shipped |
| 8.1 | shipped |
| 8.2 | shipped |
| 8.3 | shipped |
| 8.4 | shipped |
| 8.5 | shipped |
| 8.6 | shipped |
| 8.7 | shipped |
| 8.8 | shipped |
| 8.9 | shipped |
| 8.10 | shipped |
| 8.11 | shipped |
| 8.12 | shipped |
| 8.13 | shipped |
| 9.1 | shipped |
| 9.2 | shipped |
| 9.3 | shipped |
| 9.4 | shipped |
| 9.5 | shipped |
| 9.6 | shipped |
| 10.1 | shipped |
| 10.2 | shipped |
| 10.3 | shipped |
| 10.4 | deviated: baseline picker failure; C6 unapplied |
| 10.5 | shipped |
| 10.6 | shipped |
| 10.7 | shipped |
| 10.8 | shipped |
| 10.8a | shipped |
| 10.9 | shipped |
| 10.10 | shipped |
| 10.11 | shipped |
| 10.12 | shipped |
| 10.13 | shipped |
| 10.14 | shipped |

## Review and adjudications

Two independent R1 written reviews are preserved. The conformance report maps all 75 tasks and both checkpoints; the adversarial review traced consumers and mutators outside the diff. Both found CF-1 / R1-ADV-1: overlapping individually permissible PATCH edits could combine into Caseworker and bypass conversion refusals. Source e0da8da3 now atomically guards the raw classification revision on every type/role PATCH and composes staff-note expectations. Both orderings and absent-versus-zero are pinned. Exact-fixture RED was9 failures/77 passes; GREEN was230 passes in5files, including44 real/fake parity cases. The independent original adversarial reviewer completed broad R2 review, cold fix review and a separate challenge of the new adjudication, and closed CF-1.

The conformance reviewer's R2 continuation was immediately platform-blocked. It did not execute and is not counted as complete. Its completed R1 written report remains available; parent checks are not presented as an independent replacement. No altered-language retry or substitute child bypassed the platform result. The human excluded those review platform errors from the local recovery budget; the S6 lifecycle takeover remains recorded.

R2-ADV-1 is a NEW parent-deferred P2/med risk for the human merge decision, supported by a source-derived schedule without an executed reproduction. A previously claimed housing-authority acceptance, or its durable recovery, can add hidden authority after conversion. Claim means durable intent, not a contact write already completed. The conversion's pending-suggestion sweep does not see an already-claimed journal; make-again repair does not clear the restored authority. The reviewer agreed this falls outside this branch's pending-cleanup/PATCH fix contract but retained P2 priority. This risk is neither fixed nor previously human-approved, and is separate from the approved extraction deferral. See docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md.

R1-ADV-2 is the distinct, explicitly approved branch-B in-flight extraction limit. An old extraction snapshot can restore tenant facts/suggestions after conversion; the service-boundary experiment demonstrated it, not a paused whole job. See docs/issues/extraction-in-flight-writes-onto-converted-caseworker.md and RUNBOOK repair guidance.

C1-C5 are documented implementation corrections, including raw organization derivation, self-relationship exclusion, stale dialog completion isolation and phone KindPicker layout. C6 remains unapplied. Generic contact retypes, tour/placement writers, imported unknown thread history and large scans retain their scoped follow-up issues.

## Final verification

The complete evidence is [completion-gates-r2.md](completion-gates-r2.md) and [self-QA.md](self-QA.md). All gates name unchanged implementation e0da8da3; later commits add findings and reports only. The one main sync was5272f85e; main remainsd8749158. No second sync.

Exact final results, quoted:

```text
npm run typecheck: EXIT 0
npm test: EXIT 0
  app: 435 files passed; 9118 tests passed, 1 skipped
  dashboard: 234 files passed; 4371 tests passed
  e2e unit: 22 files passed; 503 tests passed
  fake-twilio: 34 files passed; 275 tests passed
  fake-twilio-web: 13 files passed; 111 tests passed
npm run smoke: EXIT 0
  smoke-dist: OK - 1649 import specifier(s) across 286 emitted file(s) resolve under plain Node.
timeout 2700 npm run e2e:
  first FINAL2 run EXIT 1: 1 failed, 336 passed (23.1m)
  traced unchanged-source rerun EXIT 0: 337 passed (23.2m)
scoped npx eslint: raw EXIT 1; 5 baseline errors, 0 new; attribution EXIT 0
```

Total unit/integration:738 files,14378 passed,one optional built-dashboard identity diagnostic skip because dist was absent. No DynamoDB skips/faults. The lint ratchet passes: four existing react-hooks/set-state-in-effect errors in BroadcastComposer.tsx and one in ContactsList.tsx; full-message baseline comparison normalized only location numbers.

The one browser failure was an entirely white document after landlord contact navigation, before any triage PATCH. The whole file then passed7/7 on feature source and7/7 on detached synced main; feature HEAD restored exactly. The full rerun passed337/337, including that scenario in8.2s. The original failure has screenshot/video/server logs but no browser trace. Cause remains unproven, not a named flake or an established environment fault. [The open issue](../../../issues/e2e-blank-document-after-contact-navigation.md) and [diagnosis](landlord-gate-diagnosis.md) retain all evidence. Rerun enabled E2E_TRACE=1, no child-log piping, no source or timeout edits. Earlier pre-fix full passes337/337 are retained too.

Parent live QA passed the substantive flows personally: new Caseworker, tenant/Unknown conversion, preserved notes/retyped thread, linked refusals, own dismissal Cancel/Hide, organization chip URL, both-kind organization settlement, explicit Kind, distinct usage/delete guard, phone Back, and a fresh consented partner property share. Fake provider received exactly one outbound; final delivery1, thread partner_1to1; both sent cards rendered correctly. At375px, all measured document widths were375; create/edit/dialog/list/Settings/share screenshots were personally viewed. Busy races remain backed by automated tests, not a fabricated manual observation. Nine viewed screenshots and raw measurements are listed in self-QA.md.

Ordinary contact mount made zero preview/Possible requests; preview began only with its dialog and Possible reads on the Caseworkers page. Existing partner detail read paths plus automated pins support the fetch-boundary claim. The conversion request body was exactly {"action":"make"}, omitting untouched carried organization.

The session was stopped with e2e:stop EXIT0 and all four owned ports were free. The deliberately stopped long-lived launcher returned1, which is not a test-gate result. No command remains owned/running. No new product defect was found in this live pass; setup/selector corrections and the existing harmless post-send draft-cleanup409 are disclosed in self-QA.md.


## Scope, files and commits

Against main d8749158, including this handback: 220 files changed, 40140 insertions, 852 deletions (net+39288). The large documentation delta includes the19,662-line approved implementation plan and preserved design/plan/code-review reasoning; it is not all application code.

The change spans150 paths under app/dashboard/e2e (including their local documentation), plus shared documentation, issues and version-controlled mission reasoning. Main implementation areas:

- app/src/lib/caseworkers.ts; app/src/services/{caseworkerConversion,contactClassification,possibleCaseworkers}.ts; caseworker review/contact routes; guarded contact/conversation/unit repo APIs and matching fakes.
- Organization list services, usage/rewrite/resolve routes and dev fixture; partner recipient resolution, broadcast fan-out, listing-send/timeline display metadata.
- Dashboard contact kinds/forms/dialog/files, Caseworkers list/nav/filter chips; organization pickers/Settings; composer, recipient review/results and property sent cards.
- Unit/integration real/fake parity and negative/race regressions; e2e Caseworkers, contact-create, organization and partner-share specs; performance/mutation and selector pins.
- GLOSSARY, RUNBOOK, e2e selector guidance, issue records, reviewed spec/plan and all mission findings/checkpoint/review/QA records. No runtime dependency was added.

Delivery anchors (individual task commit/evidence mapping remains in the linked slice reports):

| Commit | Delivered boundary |
| --- | --- |
| 8261def2 | S1 helper and dashboard mirror evidence |
| 71214970 | S2 conditional repositories and real/fake parity evidence |
| b6f6f304 | S3 conversion/classification/Possible services evidence |
| 789c6e34 | S4 route and importer guard evidence |
| 355fa4de | S5 organization server integration evidence |
| aea202d4 | S6 partner share server evidence |
| f800cd77 | Checkpoint 1 full typecheck and unit gates |
| e32fb777 | S7 organization UI evidence |
| a95686e3 | S8 contact UI and Caseworkers view evidence |
| d3a60076 | S9 share UI evidence |
| ac482f40 | Checkpoint 2 full typecheck and unit gates |
| 73031298 | Fixed phone KindPicker clipping (C5) |
| 2cb94e3b | C6 tested proposal, saved but unapplied |
| 52f4a688 | S10 integration proof, issue and scoped handoff |
| 17783d95 | Whole-browser checkpoint337/337 |
| 5272f85e | One final main sync |
| 76357a5f | First post-sync five gates |
| f74bbfca / d7a38222 | Independent R1 review records |
| e0da8da3 | Atomic classification revision fix and regressions |
| 00c71622 | Exact-fixture RED/GREEN fix evidence |
| 14bbc342 / bdd9293a | Independent R2 review and adjudication challenge |
| d1b47343 | New journal risk filed and adjudicated |
| ba7492f2 / 31ed2fee | Blank-navigation diagnosis and open issue |
| b762dadd | Final five gates and both browser runs |
| 98870155 | Parent live QA and verified teardown |

## Open issues and merge-decision qualifications

- [New journal risk, R2-ADV-1](../../../issues/claimed-suggestion-accept-after-caseworker-conversion.md): parent-deferred P2/med, no executed reproduction; required disclosure above.
- [Approved in-flight extraction limit](../../../issues/extraction-in-flight-writes-onto-converted-caseworker.md).
- [Existing picker below viewport](../../../issues/contact-search-popover-below-viewport.md): Task 10.4 baseline-red; C6 proposal remains unapplied, scope answer pending.
- [Unexplained blank-document navigation](../../../issues/e2e-blank-document-after-contact-navigation.md): both failing and passing runs retained.
- [Generic retypes and refusals](../../../issues/contact-retype-skips-caseworker-refusals.md), [tour/placement writers](../../../issues/tours-placements-no-contact-type-check.md), [imported unknown thread history](../../../issues/imported-unknown-threads-surface-as-unknown-on-today.md), [scan costs](../../../issues/possible-caseworkers-and-roster-refusal-scans.md), and [A2P coverage question](../../../issues/a2p-campaign-covers-caseworker-shares.md) remain scoped follow-ups.
- Conformance R2 platform limitation is explicit above; both complete R1 written reviews and the independent adversarial fix rereview exist. No blocked task was disguised or routed to another agent.

No issue above is silently described as fixed. No merge, push, deployment, infrastructure action or cleanup was performed. Cameron retains the merge decision with these disclosures.

## Operational obligations

NO infra, table, index, environment, secret, migration or backfill action is owed. Ordinary application deployment after human merge is required to expose the feature; the currently deployed release does not acquire it from this branch alone. No deployment was performed. A2P coverage for property shares to caseworkers remains Sam's question; the approved scope ships partner shares with that question open. RUNBOOK documents conversion repair and mistaken-conversion restoration. The branch and worktree are retained for human merge; no cleanup performed.

## Tracker 19 note (suggested text only; Tracker not edited)

Caseworkers now have a dedicated contact view, guarded conversion with refusal previews, organization selection, and direct property shares. Review found and fixed a concurrent contact-classification bypass; remaining scoped risks and operator guidance are recorded with the branch. Final merge and deployment remain human actions.
