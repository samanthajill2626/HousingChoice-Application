# Code review round 1 - orchestrator adjudications

Reviews of 53a13055 (all five gates green on that commit, run `p3`):
`r1-conformance.md` (spec-conformance: 204 CONFORMS, 0 blocking/high/medium,
CONF-1..6) and `r1-adversarial.md` (plan-blind: 0 blocking/high, ADV-1..9).
Rulings: FIX (fix wave 1, with a regression test that fails without the fix),
FILE (an issue under `docs/issues/`, not fixed here), ORCH (the orchestrator's
own remaining step), REJECT (why), NOTE (no action).

| Finding | Sev | Ruling | Why |
|---|---|---|---|
| ADV-1 pre-deploy tab ignores the server default-check rule | MED | FILE + post-merge note | Real, but it is the generic already-loaded-bundle window (precedent: `optional-call-outcome-breaks-already-loaded-bundles`): the old tab behaves exactly like the pre-deploy product (old UI, old local rule), so it is not a regression; a reload ends it. A version handshake (409 `reload_required` marker or build-id check) is a new cross-cutting protocol beyond this spec. File `matching-default-check-stale-bundle-window` (med) and put "reload open dashboard tabs after the deploy" in the handback's post-merge notes. |
| ADV-2 failed org-list read fails the authority prefill open | MED | FILE (Cameron's call) | The APPROVED spec decides this path explicitly (D3: "A failed list read counts as settled: nothing is prefilled and the filters show 'Couldn't load the organization list, so housing authorities were not filled in from the property.'"), and the test at `BroadcastComposer.test.tsx` (failed list read settles with its notice) pins it. Changing it (hold + Try again, or a verbatim prefill) would silently deviate from the contract. The state is visible (notice, reach count, the review list shows each row's authority). File `matching-prefill-org-list-failure-fails-open` (med) with both options and surface it in the handback as a "your eye" item. |
| ADV-3 rollback tab crashes the review on `preview.tourHolds.map` | LOW | FIX | Cheap and contained: guard `tourHolds` and never check a row whose `checkedByDefault` is not `true` (fail safe, no client rule reintroduced). Regression test renders an old-server payload (no `tourHolds`, no `checkedByDefault`): no crash, no row starts checked. |
| ADV-4 / CONF-4 a 422 naming no on-screen member empties the filter | LOW | FILE | Designed fallback (plan S3 design note) so a stored-name mismatch cannot leave the draft refusing every Preview; the trigger needs the org list to change twice while one composer stays open, and the cleared chips, notice and reach are visible. Not widening the audience needs new recreate machinery. File `matching-composer-422-unmatched-member-clears-filter` (low) with the reviewer's alternatives. |
| ADV-5 a tenant moved between the two partition reads resolves twice | LOW | FIX | Contained: de-duplicate by contactId in the resolver (first row wins, the searching one); reword the `audienceResolution.ts` belt comment (the walk is not a snapshot; a tenant moved INTO searching mid-walk can be missed - add by hand). Regression test: the reviewer's ADV-dup shape. |
| ADV-6 caption "not on the organization list" | LOW | REJECT | The caption is Cameron's verbatim D8 copy (spec D8, "Cameron 2026-10-14"; plan 1.1). It is accurate about the non-obvious exclusion it exists to explain (missing or unlisted authorities); tenants of another listed authority are left out by the selection itself, which the picker shows. |
| ADV-7 `truncated` at the exact page bound with no onboarding rows | INFO | NOTE | Documented, conservative, reachable only at 10,000 searching tenants (S1 report N1). |
| ADV-8 rules reads on every draft create, sequential; "0/0 delivered" | INFO | NOTE | Spec D8 accepts the per-create reads and the 0 estimate on a failed read; the row's `delivered/audience` text is the list's existing shape for every row. Parallelizing is a later optimization, not needed at today's volume. |
| ADV-9 stale "still open" cross-reference | INFO | FIX | One historical line in `docs/issues/unknown-queue-cap-starves-needs-review.md:27` noting the truncation issue was resolved by this branch. |
| CONF-1 lint-backlog record missing | LOW | ORCH | AR38/AR42's record is the last step after the FINAL gate run (measured on the final tree, so a fix wave cannot stale it). |
| CONF-2 path (c) precedence (AR12) unpinned | LOW | FIX | Tests only: empty resolution + throwing tours read -> 503 (still a draft, no markSending); truncated resolution + throwing tours read -> 503, not 400. Kills mutant M8. |
| CONF-3 paging of the unbounded tour partitions unpinned | LOW | FIX | Test only: `listByStatus('scheduled')` without options walks a second page (ExclusiveStartKey on the second Query, the unbounded key condition). Kills mutant M9. |
| CONF-5 A -> B -> A late 422 applies to A | INFO | NOTE | Benign (the member did leave the list; A is on screen); AR39's mechanism as ruled. |
| CONF-6 `ReviewRowsResult.rows` comment order | INFO | FIX | Comment-only correction at `broadcasts.ts` (seeds appended after the audience rows minus seeded contacts). |

Fix wave 1 scope: ADV-3, ADV-5, ADV-9, CONF-2, CONF-3, CONF-6, plus filing
the three issues (ADV-1, ADV-2, ADV-4). Out of the fix wave: CONF-1 (orchestrator,
after the final gates).
