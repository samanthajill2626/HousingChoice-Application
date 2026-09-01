# T8 - drift audit, group rosters

Commit: `0167f59e` feat(audit): --audit-denorm walks group rosters from their own partitions

Files: created `app/src/lib/rosterDriftTally.ts`, `app/test/rosterDriftTally.test.ts`;
modified `app/scripts/measure-unread-contact-coverage.ts` (import block, `auditGroupRosters()`
added after `auditDenorm`, called as the last line of `auditDenorm` after its `console.log`).
Nothing else in the script changed; the `auditTabVsPartition` skip is untouched.

## RED

`cd W:\tmp\participant-snapshot-refresh\app; npx vitest run test/rosterDriftTally.test.ts`

```
 FAIL  test/rosterDriftTally.test.ts [ test/rosterDriftTally.test.ts ]
Error: Cannot find module '../src/lib/rosterDriftTally.js' imported from
'W:/tmp/participant-snapshot-refresh/app/test/rosterDriftTally.test.ts'
 Test Files  1 failed (1)
      Tests  no tests
EXIT=1
```

## GREEN

`cd W:\tmp\participant-snapshot-refresh\app; npx vitest run test/rosterDriftTally.test.ts`

```
 v test/rosterDriftTally.test.ts (2 tests) 4ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
EXIT=0
```

`cd W:\tmp\participant-snapshot-refresh; npm run typecheck` (bare) -> `EXIT=0`.
Covers the script: the app workspace runs `tsc -p tsconfig.json --noEmit && tsc -p
tsconfig.scripts.json && tsc -p tsconfig.test.json`.

Script parse + refusal, no database touched (the `--confirm` guard at `:41-57` runs
before the `DynamoDBClient` at `:81`):
`cd W:\tmp\participant-snapshot-refresh; npx tsx app/scripts/measure-unread-contact-coverage.ts --audit-denorm`

```
Refusing to run without --confirm.
...
  endpoint:     (AWS default resolution)
  table prefix: (unset)
EXIT=2
```

Gate 5 (not required for a slice, run to avoid a surprise later):
`npx eslint app/src/lib/rosterDriftTally.ts app/test/rosterDriftTally.test.ts app/scripts/measure-unread-contact-coverage.ts` -> `EXIT=0`.

## Lane run (ORCHESTRATOR, self-QA - not run here)

Needs an `e2e:session` lane seeded with the `full` profile. Read `tablePrefix` and
`accessKeyId` from `e2e/.artifacts/lane.json` (`hc-local-<L>-` / `hclane<L>`);
DynamoDB Local is the shared container at `http://localhost:8000`
(`scripts/db.mjs:42`). One line, PowerShell, from the worktree root:

```
cd W:\tmp\participant-snapshot-refresh; $lane = Get-Content e2e\.artifacts\lane.json | ConvertFrom-Json; $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:TABLE_PREFIX=$lane.tablePrefix; $env:AWS_ACCESS_KEY_ID=$lane.accessKeyId; $env:AWS_SECRET_ACCESS_KEY='local'; $env:AWS_REGION='us-east-1'; npx tsx app/scripts/measure-unread-contact-coverage.ts --audit-denorm --confirm
```

`--audit-denorm` prints the 1:1 block first, then the group block, then exits 0.
The access key is what selects the lane's DynamoDB Local database (no `-sharedDb`),
so the default `local` key would read an empty store and print all zeros - if every
count is 0, suspect the key before believing the lane. Record the group block in
`.superpowers/sdd/audit-lane.txt`. Expect `NOT RETURNED 0`. Expect non-zero
`nameDrift` by construction: `app/src/lib/seed/performance.ts:842/:857-858/:890`
bakes synthetic roster names against real contacts on the `full` profile.

## Divergences from the plan

1. `ContactDisplayItem` is imported inline on the existing `contactsRepo.js`
   specifier (`import { createContactsRepo, type ContactDisplayItem } from ...`)
   rather than as the plan's separate `import type` line. Same file already uses
   the inline form for `ConversationItem` (`:35-38`); a second specifier for the
   same module would be a duplicate import. No behavior change.

Nothing else. Module and script code are the plan's, verbatim. All worklist anchors
matched: script imports `:32-38`, repos `:90-91`, `auditDenorm` `:473`, group skip
`:510`, final `console.log` `:554-588`, CLI dispatch `:963-966`;
`listGroupTexts` `:948-951` and `listRelayGroups` `:805-807` match
`collectGroupRosters` as written; `contactDisplayName` (T1) and
`isDeleted(ContactDisplayItem)` compile as the module assumes.

## Open worries

- The tally is only as good as its sourcing: `collectGroupRosters` is tested with
  fakes, so a real-lane run is the only proof the two repo walks return what the
  fakes claim. That is the orchestrator's one lane run.
- `groupTextTruncated` / `relayTruncated` are surfaced inline on the "rosters
  walked" line only. If either says TRUNCATED, every count below it is a floor,
  not a total - do not quote the numbers as a population size.
- No `requireComplete` anywhere (per the constraint). A short `getDisplaysByIds`
  chunk inflates `danglingContactId`, which is why the requested/returned/NOT
  RETURNED line exists. Read it before reading `dangling`.
