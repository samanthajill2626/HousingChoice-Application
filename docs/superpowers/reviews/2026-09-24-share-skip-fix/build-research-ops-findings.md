# Build research (ops area, plan Tasks 1-5) - findings against the live tree

Date: 2026-09-25. Branch `feat/share-skip-fix` at `cf088d22`. The source tree is main@bbaad87d
(every branch commit is docs). Read-only pass: nothing was built, tested or run against any
environment. Two local probes were run: an argument-passing probe (a JSON string handed to a
native exe) and an ESLint baseline on the three pre-existing files Task 3 touches. The worklist
with every anchor resolved is `.superpowers/sdd/build-worklist-ops.md` (gitignored reference).

Everything else the plan relies on in Tasks 1-5 checks out against the live tree:
- the imports and signatures;
- the `../../../scripts/lib/hcAws.mjs` depth;
- tsconfig coverage;
- the direct-invocation idiom;
- the lane key and region;
- the import binding;
- the RUNBOOK anchor;
- the alarm thresholds;
- the breaker log text.

Every expected number in the census test (Task 1 Step 5) holds under the real predicates.
Every expected number in the fix-script test (Task 2 Step 1) holds too.

Four findings: 2 MUST-ADJUST, 2 NOTE.

## F1. MUST-ADJUST - Task 4: the two PowerShell recipes pass JSON inline, which the operator's shell breaks

The new RUNBOOK section (plan Task 4 Step 1) gives two PowerShell commands:
- the read-only audit-partition Query, which spec D9 requires;
- the lost-audit backfill `put-item`, which is the only recovery path for an `auditFailed` row
  (spec I6).

Both build a JSON value with `ConvertTo-Json -Compress` and pass it as a bare argument
(`--expression-attribute-values $v`, `--item $item`).

- The operator machine runs Windows PowerShell 5.1.19041.7548. `pwsh` is not installed. The AWS
  CLI is `C:\Program Files\Amazon\AWSCLIV2\aws.exe`.
- A probe on that machine sent `@{':e'=@{S='conversations#abc'}} | ConvertTo-Json -Compress` to
  a native exe as an argument. It arrived as `{:e:{S:conversations#abc}}`: every double quote
  was stripped.
- aws.exe parses its argv with the same Windows rules. Both commands would therefore hand the
  CLI invalid JSON, and the CLI would refuse. The failure is loud, not silent, but neither
  recipe works as written.
- The RUNBOOK already records this trap for `--parameters` (RUNBOOK.md:2315-2323). Its fix is to
  build the JSON, write it with `[IO.File]::WriteAllText`, which writes no BOM, and pass
  `file://<path>`.
- The plan's justification ("the same `ConvertTo-Json` idiom as the other Query steps in this
  file") rests on a single precedent, RUNBOOK.md:1797. That line is a `scan`, and it carries
  the same latent defect.

Plan change: in the Task 4 section, write each JSON value to a temp file with
`[IO.File]::WriteAllText` and pass it as `"file://$f"`. Do this for both the audit Query and the
backfill `put-item`; `file://` works for `--expression-attribute-values` and for `--item`. Keep
the `attribute_not_exists(entityKey)` condition. Drop the "same idiom as the other Query steps"
wording. RUNBOOK.md:1797 is outside this branch's scope; it is worth a one-line issue or a
separate fix.

## F2. MUST-ADJUST - Tasks 1 and 5: nothing tests the CLI flag parser, and the lane rehearsal performs no write

The CLI's write path is not proven anywhere before the handoff.

- Nothing tests the parser:
  - `parseStageArgs` (plan Task 1 Step 3) is the only code between the flags the operator types
    and `apply`, `includeBreakerTripped` and `conversationId`.
  - The planned `stageClient.test.ts` covers `laneAccessKeyId`, `parseLane` and
    `resolveStageClient` only.
  - The fix-script tests call `enableConversationAutomation` directly.
  - The RUNBOOK section still tells Cameron "Unknown arguments are refused (a mistyped flag must
    never turn a rehearsal into a live apply)". That operator-facing safety claim has no
    automated proof.
- The Task 5 Step 2 rehearsal cannot exercise a write:
  - It runs on the lean world, the session's reseed default (app/src/routes/dev.ts:316-322).
  - Lean's only one-to-one row, the tenant_1to1 at app/src/lib/seed/lean.ts:225-235, carries no
    `ai_mode`, so the census reports it `unset`.
  - The plan's own expectation is therefore planned 0 for the dry run and for both applies.
  - "The second apply reports planned: 0" is true whether or not `--apply` is honored.
  - The first CLI run that writes anything would be Cameron's dev apply.

Plan change:
- (a) Add `parseStageArgs` cases to Task 1's `stageClient.test.ts`:
  - `--env dev --apply` sets the flag.
  - `--conversation <id>` is captured.
  - These return usage: `--dry-run` (the flag every other ops script uses), `--env=dev`, a
    missing `--env`, a value flag with no value, `--lane 0`, `--lane x`, and an unknown flag.
- (b) In Task 5 Step 2, switch one lane conversation to `manual` before the dry run:
  - Change it on the hermetic lane only, for example the lean tenant row `IDS.conversation`.
  - Make the change through a client bound to key `hclane<L>` at the DynamoDB Local endpoint.
  - The rehearsal should then read:
    - dry run: planned 1;
    - apply: enabled 1, with one `mode_changed` event whose reason is `bulk_enable`;
    - second apply: planned 0 and `alreadyOn` counting that row.
  - The next session's clean-slate reseed restores the lane.

## F3. NOTE - Task 5 Step 1: the listed eslint command exits 1 on a correct build

A baseline run on this tree of
`npx eslint app/src/lib/import/apply.ts app/test/importApply.integration.test.ts app/test/importGroupGuards.test.ts`
exits 1 with exactly two errors, both pre-existing. Both are `@typescript-eslint/no-explicit-any`
in `app/test/importApply.integration.test.ts`, at :739:59 and :818:59. Task 3's edit replaces
the one-line `toMatchObject` at :246 with a 7-line block, which moves them to :745:59 and
:824:59. `apply.ts` and `importGroupGuards.test.ts` are clean. The config is not type-aware
(eslint.config.mjs, `tseslint.configs.recommended`, no `parserOptions.project`), so the new
`app/scripts` files cannot hit a "not included in project" error.

Plan change: replace "Expected: exit 0 each" for the eslint line with "exit 1, exactly the two
pre-existing no-explicit-any errors at importApply.integration.test.ts:745:59 and :824:59
(baseline); nothing else". The builder should neither fix unrelated debt nor report a red gate.

## F4. NOTE - an unlisted writer of switched-off one-to-one rows: the performance seed

`app/src/lib/seed/performance.ts:826` puts `ai_mode: 'manual'` in the `common` object. That
object is spread into every generated conversation, including the one-to-one rows
(`:836-845`). Every one-to-one thread in the performance world is therefore switched off.

Spec section 5 lists seed writers only as "the lean world gains one switched-off tenant
conversation ... every other seed world is unchanged". That statement is true (nothing changes),
but it does not say this world already holds hundreds of switched-off one-to-one rows.

Plan change: none for Tasks 1-5. Name it in spec section 5's writer list. Anyone who ever runs
the census or the fix script against a performance-seeded lane will see it plan every
performance one-to-one row.

The other seed writers are group rows only:
- lean.ts:248, :265;
- cast.ts:530, :783, :1404, :1459;
- live.ts:302, :327;
- matrix.ts:1181;
- performance.ts:900.

The rest of the switch's writers and readers match spec section 5:
- repo creation paths at conversationsRepo.ts:1273, :1383, :1941 and :2385;
- setMode, called only by the breaker (sendMessage.ts:352);
- the import;
- the wrapper at sendMessage.ts:349;
- the two scheduled-send previews (routes/tourReminders.ts:1034, routes/contactTimeline.ts:883).

Nudge previews pass `aiMode: undefined` (routes/placementNudges.ts:401).
