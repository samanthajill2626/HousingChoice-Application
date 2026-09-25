# Planner verdict - share-skip-fix (Branch A)

Date: 2026-09-25. Planner: Claude Fable 5.1 (the feature-mission planner; the
build ran in AUTO mode under `abt:build-orchestrator`). Branch
`feat/share-skip-fix`, worktree `W:\tmp\share-skip-fix`, base `main@bbaad87d`,
`main` merged once at `813c0c44` (0 behind `main@cd8e8ddd`).

## MERGE-READY @e5f26c26, UNMERGED - Cameron merges

The orchestrator handed back MERGE-READY @813c0c44 (handback `3abc9796`).
The planner then ran its own gates on that tip, dispatched two independent
reviewers (spec-conformance, plan-blind adversarial), applied one fix wave,
re-ran every gate, and drove the dashboard on a hermetic lane. The verdict
covers the fix-wave tip `e5f26c26` (`ff380245` code, `e5f26c26` records);
this verdict file is a docs-only commit on top of it.

## Gates (planner's own runs, bare, logs under `.superpowers/planner-gates/`)

On `3abc9796` (the orchestrator's tip) and again on `e5f26c26` (after the fix
wave) - identical results:

- `npm run typecheck` -> exit 0
- `npm run smoke` -> exit 0 ("1413 import specifier(s) across 248 emitted file(s) resolve under plain Node")
- `npm test` -> exit 0; Test Files 369 passed (369) / 191 (191) / 21 (21) / 34 (34) / 13 (13); `[dynamoAdmin]` lines: 0
- `timeout 1500 npm run e2e` (Git Bash) -> exit 0; "278 passed" (20.0m on `3abc9796`, 20.2m on `e5f26c26`); 0 failed, 0 flaky
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` -> exit 1 with exactly the 14 PRE-EXISTING errors in the same five files the handback baselines at the merge base (`cast.ts`, `matrix.ts`, `importApply.integration.test.ts`, `BroadcastComposer.tsx`, `BroadcastComposer.test.tsx`); no new error -> gate 5 PASS

Tree clean after both chains; no `MERGE_HEAD`; 50 commits ahead of `main`,
0 behind.

## Independent reviews (planner-dispatched, read-only)

- Spec conformance (`planner-review-conformance.md`): 17 of 18 items
  DELIVERED (I3 PARTIAL by D6's stated scope), 0 blocking, 1 medium, 5 low.
- Plan-blind adversarial (`planner-review-adversarial.md`): 0 blocking,
  2 medium, 12 low.
- Every finding adjudicated in `planner-review-adjudications.md`: accepted
  ones became the fix wave (`ff380245`) and the record/issue edits
  (`e5f26c26`); the two mediums are the spec's recorded interim-rule
  tradeoffs and the RSW-owned retry path, kept as records and relays.

## Live UI eyeball (hermetic lane 15, built-in browser, 2026-09-25 18:50-18:53)

The orchestrator's MCP browser build was missing, so the planner drove the
dashboard itself on `npm run e2e:session` lane 15 (dashboard
`http://127.0.0.1:10511`, fake carrier `:10521`), dev-login as the seeded VA:

- D6 + D7: a one-recipient send to a tenant with no recorded consent (created
  and sent through the API, the only route that reaches the fan-out's consent
  fence) -> results header pill **Not sent**, chips Recipients 1 / Skipped 1 /
  everything else 0, row "Skipped - No texting consent recorded".
- D8: `/broadcasts/new?unitId=<fresh available unit>&contactId=contact-tenant-0002`
  pre-filled the message with exactly `695256 Planner QA Ave, Atlanta, GA
  30314 http://127.0.0.1:10531/p/<unitId>?cta=text`; the empty-textarea
  placeholder reads `[Address] [FlyerLink]`; no merge chips in one-recipient
  mode; banner "Sending to: Dario Reyes".
- D5 (review list): Preview showed one row, "Dario Reyes", checked and
  enabled, the note "Flagged tenants you picked stay checked; "Select all"
  skips the others.", button "Send to 1 tenant".
- D4: Send -> `/broadcasts/<id>` read **Sent**, Delivered 1, row "Dario Reyes
  (555) 010-0004 Delivered" - into `conv-0002`, the lean seed's switched-off
  (`ai_mode: manual`) conversation. The fake carrier's thread for
  +15550100004 holds exactly one outbound message, body identical to the
  composer text, state `delivered`.
- D5 (already sent): a second compose of the same property to Dario ->
  Preview row aria-label "Dario Reyes - already sent", tag "Already sent",
  checkbox CHECKED (seeded rows stay checked).
- Matching list: rows "Not sent - To 1 tenant - 0/1 delivered" (the no-consent
  send) and "Sent - To 1 tenant - 1/1 delivered" (Dario), plus the untouched
  second draft.

The lane was stopped with `npm run e2e:stop` (lane 15 tables dropped, lease
released); all four lane ports verified free afterwards.

## What Cameron already did

D1 census + D2 dry run + D2 apply on dev AND prod, 2026-09-25, from the pinned
ops worktree `W:\tmp\share-skip-fix-ops` @a0041966: prod switched on 634
one-to-one conversations (0 breaker-tripped, 0 lost conditions, 0 failures),
released 0 pending tour-reminder rungs. Record: `cameron-runs-2026-09-25.md`.
The import-window rule is live until this branch merges.

## Merge

From the shared `main` checkout (never from a worktree):

```
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/share-skip-fix
```

Post-merge: nothing owed (no infra, deploy, secrets, flags, migration or
dependency change; spec I7 held). Cleanup of `W:\tmp\share-skip-fix` and
`W:\tmp\share-skip-fix-ops` only on an explicit ask; `.superpowers/` in the
build worktree holds run state only (every review, adjudication, report and
Cameron's run record is committed under this folder).

## Watch items after deploy (not blocking)

- The 30007 (carrier filtering) rate on one-to-one property sends: the new
  default text is an address and a bare link (Sam's #4 asks for exactly
  that); a 30007 is never retried and, under the interim D5 rule, still flags
  the tenant "Already sent".
- A person-sent share that fails 30003 into a still-switched-off (breaker-
  tripped) thread is retried as an automated text and refused `manual_mode`
  while the row reads "will retry" - `feat/retry-send-window`'s domain, relayed.

## Relays for the sibling branches (Cameron passes these on when A merges)

- RSW (`W:\tmp\retry-send-window`, next in line): A touched NO 30003 wording,
  none of `deliveryReason`'s options or check order, and no retry code.
  Reading `retry_due_at` on the share results row is Branch B's (RSW's spec
  assigns it to share-skip-fix; it moved to B in the split record). The
  automatic 30003 retry re-sends `automated: true` AND without A's
  `recipient` item, so for a staff share it loses both of A's guarantees
  (person's send; the fenced recipient) - RSW's retry window + WP2 item 3
  ("a retry follows the original sender") own the fix.
- SOR (`W:\tmp\send-outcome-reconcile`, after RSW): its adoption must read
  A's `created_via` record to stamp the audit row's `automated` flag; A's
  merge points are spec section 6 item 3 - the derived stats buckets and
  `skippedTotal`, the results-row reason gate `shareRecipientReason`
  (`dashboard/src/routes/broadcasts/broadcastFormat.ts`) over the share-skip
  map beside `INTERNAL_CODE_REASONS`, the fan-out's fences / send call /
  finalize log, `sendMessage.ts`'s gates, and the seed broadcast fixtures.
  Any NEW failed-slot code (`send_unconfirmed`) needs its own arm in
  `shareRecipientReason` or it falls through to `deliveryReason`. SOR files
  the broadcast-30003 slot-update issue itself (it is B's).
