# Cameron's D1/D2 runs - 2026-09-25 (the committed record)

Relayed to the planner in chat on 2026-09-25; the orchestrator's copy lives in
the gitignored `.superpowers/sdd/cameron-runs.md`. This file is the record that
survives the worktree (AGENTS.md: mission reasoning is version-controlled).

Run from the pinned ops worktree `W:\tmp\share-skip-fix-ops` at `a0041966`
(source proven at `7ecaf254`; `npm ci` there), dev first and then prod, each on
Cameron's own go: the census, the fix-script dry run, the fix-script apply.

## Prod apply line (verbatim)

```
{"level":30,"time":1790366487748,"pid":34076,"hostname":"ABT-DESKTOP","scanned":1236,"pointerRows":208,"groupRows":190,"alreadyOn":204,"unset":0,"breakerTrippedExcluded":0,"planned":634,"enabled":634,"byType":{"unknown_1to1":621,"tenant_1to1":12,"landlord_1to1":1},"skippedOnCondition":0,"failed":0,"apply":true,"msg":"enable-conversation-automation - done"}
```

Reading: 1236 rows scanned; 634 one-to-one conversations switched on (621
`unknown_1to1`, 12 `tenant_1to1`, 1 `landlord_1to1`); 204 were already on; 190
group rows and 208 pointer rows untouched; 0 breaker-tripped rows excluded; 0
lost conditions; 0 failures. Every switch landed with its `mode_changed` audit
event (reason `bulk_enable`) in one transaction.

## Prod census (D1)

Cameron read the census before applying and reports ZERO pending one-to-one
tour-reminder rungs released by the bulk apply (`rungsReleasedByBulkEnable` 0).
The census's own done line (import claim mismatches, nudges held, breaker list)
scrolled out of his terminal history before it could be pasted, and the dev
runs were not recorded; the row counts above stand in for D1's census numbers.
Re-measuring is safe and cheap (the census is read-only, and
`importClaimMismatches` does not depend on the switch state), and it sizes
`docs/issues/import-conversations-missing-phone-claim.md`; it is offered, not
required.

## Consequences now live

- The import-window rule: between these applies and the merge of
  `feat/share-skip-fix`, no `import:apply` from `main` against dev or prod
  (`main` still creates one-to-one rows `manual` until the merge). Closed for
  good once the branch merges.
- Nothing else is owed: no infra, no deploy, no secrets (spec I7).
