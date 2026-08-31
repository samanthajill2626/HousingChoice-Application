# Task 7 report - Partner and Property Manager hermetic proof

## Commit and scope

- Commit: `94caf95c8d98c461ac8b366b7e4820a36dcfb6a1` - `test: prove AI partner and property manager triage`
- Files committed:
  - `e2e/tests/flows/conversation-fact-extraction.spec.ts`
  - `docs/issues/caseworker-contact-type.md`
- No production, seed, import, backfill, dependency, environment, flag, infra, or deploy file changed.
- `git diff --check HEAD^ HEAD`: exit 0.
- Final worktree status: clean. `docs/issues/INDEX.md` is ignored and was not staged.

## E2E proof

Final command, through the e2e workspace and hermetic lane 2:

```text
npm run e2e -w @housingchoice/e2e -- tests/flows/conversation-fact-extraction.spec.ts
exit 0
12 passed (31.2s)
```

Final structured artifact: `e2e/.artifacts/results.json` records `expected=12`,
`unexpected=0`, `flaky=0`, `skipped=0`, `duration=31200.974ms`.

The preceding green acceptance run before issue closure also exited 0 with `12
passed (30.9s)`. Two initial assertion-only test authoring failures were diagnosed
and corrected without a product change: the suggestion paragraph includes its
reason after the exact label, and the valid post-triage Property Manager label is
rendered both in the header and Details row. Their browser artifacts were preserved
under `e2e/.artifacts/test-results/` before the green reruns.

## Semantic coverage added

- Partner fake inbound payload proposes `partner`, writes the stated caseworker
  note, displays the Partner suggestion and all four canonical triage actions,
  then uses the real Unknown-card `Mark as Partner` action. The test proves
  `type=partner`, `status=active`, absent role, `partner_1to1`, and absence of the
  formatted phone from Today's `AI suggestions to review` group.
- Property Manager fake inbound payload proposes `property_manager`, writes the
  stated manager note, displays the exact Property Manager label, then uses the
  real Unknown-card `Mark as Property Manager` action. The test proves
  `type=landlord`, exact role `Property Manager`, `status=interested`,
  `landlord_1to1`, and Today suggestion cleanup.
- The helper assertions use authenticated contact and conversation APIs; UI actions
  use accessibility-first role/text locators only.

## Issue closure

- `docs/issues/caseworker-contact-type.md` now has `status: resolved`,
  `updated: 2026-08-26`, and `resolved: 2026-08-26`, with the prescribed
  forward-only resolution record.
- `npm run issues`: exit 0; output `254 open, 153 closed, 407 total` and
  `caseworker-contact-type` appears as `med | decision | resolved` in the generated
  ignored `docs/issues/INDEX.md`. The command reported the pre-existing unrelated
  warning `perf-selfqa-route-contract-drift.md: unknown severity "medium"`.

## Unresolved items

None in Task 7 scope.
