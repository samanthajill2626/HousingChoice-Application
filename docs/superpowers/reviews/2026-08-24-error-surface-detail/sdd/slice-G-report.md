# SLICE G report - T14 terraform, T15 truth-up (minus perf ledger), T16 e2e (2026-08-24)

Branch feat/error-surface-detail. Started at `17928dcd`, ends at `03a3e2ed`.
Tree CLEAN (`git status --porcelain` empty). Four commits, all carrying
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Bare `git status` before every commit; explicit paths only; no `-A`; no
`MERGE_HEAD`; `docs/issues/INDEX.md` NEVER staged (it is gitignored and did not
even appear in `git status`).

## Commits

| SHA | Message | Files |
|---|---|---|
| `86595425` | feat(infra): grant logs:GetLogRecord for the error detail route | `infra/modules/ec2/main.tf` (+18) |
| `7e83518c` | docs(observability): retire the PII-safe projection guarantee | 12 files, +107 / -38 |
| `85c1a82b` | docs(issues): file the CloudWatch CP1252 mojibake defect | `docs/issues/cloudwatch-log-cp1252-mojibake.md` (NEW, +53) |
| `03a3e2ed` | test(e2e): cover the widened System Status errors block | `e2e/tests/dashboard-next/settings.spec.ts` (+8) |

Commit messages 1, 2 and 4 are the plan's pinned strings verbatim. Commit 3 is
the issue file split out of Task 15 (the brief allowed either shape); its
message is mine, since the plan pinned only one Task 15 message and it does not
describe an encoding-bug filing.

## Verification (every run bare, absolute cwd, nothing piped)

| Before | Command | Result |
|---|---|---|
| c1 | `infra> terraform fmt -check` | PASS (no output, exit 0) |
| c1 | `infra> terraform validate` | `Success! The configuration is valid.` |
| c1 | `npm run typecheck` (root) | PASS - all 5 workspaces |
| c2 | `npm run typecheck` (root) | PASS - all 5 workspaces |
| c2 | `app> npx vitest run test/cloudwatch.adapter.test.ts` | 1 file / **37 tests PASS** |
| c2 | `dashboard> npx vitest run src/routes/settings/RecentErrors.test.tsx` | 1 file / **24 tests PASS** |
| c3 | `npm run issues` | `246 open, 138 closed, 384 total`; the new row is indexed (INDEX.md:114) |
| c4 | `npm run typecheck` (root) | PASS - all 5 workspaces |

ASCII, every commit: `git diff -U0 | grep '^+' | LC_ALL=C grep '[^ -~]'` returned
NO matches (exit 1) each time. The new issue file was additionally scanned whole
(`LC_ALL=C grep '[^ -~]' <file>` -> no match): it is pure ASCII, not just its
added lines.

NEVER run, per the brief: `terraform plan` / `apply`, deploys, secrets, SSM,
docker, `npm run e2e`, full `npm test`, `npm run smoke`, `db:start`.

## T14 - the terraform statement AS COMMITTED

`infra/modules/ec2/main.tf`. `SystemStatusInsightsResults` (:296-300) is
BYTE-UNCHANGED - GetQueryResults + StopQuery stay `"*"`. The new block follows
it immediately, reusing StartQuery's two ARN forms verbatim:

```hcl
  # System Status "error detail" resolves one Insights @ptr with GetLogRecord.
  # AWS's machine-readable service reference
  # (https://servicereference.us-east-1.amazonaws.com/v1/logs/logs.json,
  # retrieved 2026-08-24) lists GetLogRecord with a "log-group" resource, so it
  # DOES support resource-level permissions and is scoped to this env's groups
  # exactly like StartQuery above. The request carries only an opaque pointer;
  # the pointer resolves server-side to its log group for IAM to match on.
  # Env scoping is ALSO enforced in the app (services/systemStatus.ts rejects
  # any record whose @log is not one of this env's three groups), so neither
  # layer is the sole boundary.
  statement {
    sid     = "SystemStatusGetLogRecord"
    actions = ["logs:GetLogRecord"]
    resources = [
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*",
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*:*",
    ]
  }
```

This follows worklist G1 (the adjudicated IAM answer), NOT the plan's pinned
`"*"` block. `terraform fmt -check` accepts the mixed alignment because the
multi-line `resources` breaks the alignment group - identical to
`SystemStatusInsightsStart`.

**HANDBACK (carry to the top):** the human must `terraform plan` + `apply` in
dev AND prod before deploy; until then the detail expander 403s and degrades to
`{ available: false }`. After applying, verify the expander against real data.
If enforcement unexpectedly rejects the scoped form, the fallback is moving
`logs:GetLogRecord` into the `"*"` statement - the app-level env scope check
(S4) is the real boundary either way.

## T15 - every truth-up site touched (before -> after)

All in `7e83518c` unless noted. "Rewritten, not deleted" everywhere.

| Site (NEW line) | Before | After |
|---|---|---|
| `app/src/adapters/cloudwatch.ts:14-22` | "the error projection is PII-SAFE - timestamp, level, msg, correlationId ONLY ... NEVER projected" | admin-only + server-enforced; MAY carry contact PII and host data, deliberate; display control not storage control; credentials excluded by ERR_ALLOWLIST |
| `app/src/adapters/cloudwatch.ts:2,7-8` (see divergence 1) | "exposes exactly the TWO narrow reads"; 2-line read list | "exactly the narrow reads"; list now names `getLogRecord` and `queryTrace` too |
| `app/src/services/systemStatus.ts:2` | "Three reads" | "FIVE reads, all scoped to this env" |
| `app/src/services/systemStatus.ts:7-10` | list named getFlags/getAlarms/getErrors only | adds `getErrorDetail(ref)` (+ "the env scope check lives HERE") and `getTrace(kind, id, atMs)` |
| `app/src/services/systemStatus.ts:25-32` (was the :21-22 tail) | "Errors are projected to message + correlationId (+ timestamp/level) by the adapter" | the three CloudWatch reads are a DIFFERENT posture: admin-only, server-enforced, MAY hand back contact PII + host data; credentials excluded by ERR_ALLOWLIST; the SERVICE still logs counts/reasons only |
| `app/src/routes/system.ts:20-26` (was the :20 claim) | "The errors projection is message + correlationId (+ timestamp/level) only." | what the routes RETURN is a separate question: `/errors`, `/errors/detail`, `/trace` are admin-only and MAY carry contact PII + host data; credentials excluded by the detail path's `err` allowlist |
| `app/src/routes/system.ts:71` (was :65) | "recent error events (PII-safe)" | "recent error events (admin-only; a row may carry PII)" |
| `dashboard/src/api/endpoints.ts:2097-2104` | "recent error events (PII-safe)" | posture paragraph added to the `getSystemErrors` docblock; the `level>=40 firehose` line kept byte-unchanged (it holds a non-ASCII glyph) |
| `dashboard/src/api/types.ts:336-341` | "GET /api/system/errors -> one error event (PII-safe projection ONLY)." | multi-line docblock: admin-only, server-enforced, a row MAY carry PII, "DISPLAY control, not a redaction boundary", credentials excluded by the detail allowlist |
| `dashboard/src/routes/settings/RecentErrors.tsx:1-24` | 10-line header claiming "the PII-SAFE projection ONLY (never bodies/numbers/names/emails)" and describing 4 rendered fields | whole block rewritten: the REAL row content (source, job/event, err type + code, message, errMessage, correlationId, TEXT truncation markers), the two new controls by their ACCESSIBLE NAMES ("Show all" record expander, "Trace" pivot), the new PII posture, the degraded state's "no rows -> no row controls", and an a11y line that now mentions `aria-expanded` |
| `RecentErrors.test.tsx:2-8` | "available:true renders the PII-SAFE projection ONLY (timestamp + level + message + correlationId)" | describes the widened row + both controls; says the panel is admin-only and a row MAY carry PII, so nothing here asserts a redaction; names all three mocked endpoints |
| `RecentErrors.test.tsx:85` (was :82; brief said :63) | `describe('RecentErrors - available:true rendering (PII-safe)')` | `describe('RecentErrors - available:true rendering')` - suite re-run green (24/24) |
| `app/test/cloudwatch.adapter.test.ts:2` | "Exercises BOTH narrow reads" | "Exercises EVERY narrow read" |
| `app/test/cloudwatch.adapter.test.ts:7-19` (was :7-9) | "queryInsights ... -> PII-SAFE projection (timestamp, level, message, correlationId ONLY)" | EXTENDED per the spec's "not a correction" rule: the LIST path's widened field set AND "still never surfaces RAW log text"; new `getLogRecord` entry saying that path DOES hand back raw text and MAY carry PII (deliberate, admin-only); new `queryTrace` entry |
| `app/test/cloudwatch.adapter.test.ts:148` | "// Non-JSON -> placeholder message (PII-safety: raw text never surfaced)" | **UNTOUCHED - verified still true as written.** It sits inside the `queryInsights` (LIST) describe, and `'(unparseable log line)'` is still asserted at :149 |
| `app/src/adapters/messaging.ts:700` | "...the ZIP would land in CloudWatch through 'job failed'." | "...through 'job failed: <jobName>'." (the following two comment lines were re-wrapped only to keep the 80-col block tidy; wording preserved, incl. "deliberately no `cause`") |
| `docs/issues/fake-twilio-messaging-attach-404.md:45-47` | quoted signature `"msg":"job failed"` | `"msg":"job failed: relay.warmNumber"`, with a parenthetical that the dispatcher names the job as of 2026-08-24 and that OLDER STORED EVENTS still read `"msg":"job failed"` - so the doc stays usable as a live Insights search signature for both eras. Job name verified against `RELAY_WARM_JOB` (`app/src/services/poolNumbers.ts:152`) |
| `docs/issues/system-status-errors-oldest-first-scan.md:35-40` | "...epoch **seconds**; PII-safe projection via the unchanged `projectErrorEvent`..." | historical claim preserved as "the then-PII-safe projection", plus a dated NOTE (2026-08-24) that the PII-safe half is RETIRED by `error-surface-detail` for this admin-only panel, credentials still out via the `err` allowlist |
| `RUNBOOK.md:2169` (DLQ row) | "Insights query (b) - the `job failed` lines carry `jobName`, stack, and the originating request's correlation IDs." + peek/redrive text | Insights technique PRESERVED WORD-FOR-WORD (plus the new literal `job failed: <jobName>` and a note that pre-2026-08-24 events read `job failed`); ADDS "The same data without the CLI: **Settings -> System status -> Recent errors** (admin-only), where a row's **Show all** expands the COMPLETE log record behind it - every field, including `err.message` and the stack - and **Trace** pivots to the surrounding lines that share that row's `requestId`, `pollRunId` or `correlationId`." The row's 3 em-dashes and 1 section mark were ASCII-ised because the whole line counts as added. `:2167` (error-logs row) untouched |

**Deliberately LEFT AS-IS**, as instructed: `systemStatus.ts` OOM labels (now
:56 and :245 after the +10 shift - still synthesized and PII-safe); every
out-of-surface PII-safe site (broadcastFanOut, contactTimeline, tours, voice
webhooks, extraction, statusTransition, messaging.test); `e2e/performance/*`
(G2 defers the perf citation ledger to post-sync); `templates.ts`,
`SYSTEM_GETS`, `routes.test.ts:106-109` (G3); `SystemStatusSection.*`.

## T15 - the new issue file

`docs/issues/cloudwatch-log-cp1252-mojibake.md`, PURE ASCII (the template's
em-dashes were NOT copied). Frontmatter: `id: cloudwatch-log-cp1252-mojibake`
(= filename), `type: bug`, `severity: low`, `status: open`, `area: app`,
`created: 2026-08-24`, `refs: app/src/index.ts:162, app/src/worker.ts:530`.
Body: UTF-8 em-dash (`E2 80 94`) in source arrives as a lone `0x97` (CP1252),
invalid UTF-8, replacement char in every UTF-8 consumer including this panel;
isolated past BOTH the PowerShell console encoding and the AWS CLI's stdout
encoding (`PYTHONIOENCODING=utf-8` reproduced it); a genuine AT-REST defect in
the build/runtime/ingest path; suggested fix is to find the converting layer
first; origin credited to section 9 of the design spec, with the general fix
noted as out of scope and S1's specific lines already ASCII-ised.

**Both refs re-verified, NOT drifted:** `app/src/index.ts:162` and
`app/src/worker.ts:530` still hold a real U+2014 (checked with
`LC_ALL=C grep $'\xe2\x80\x94'`) - they are the shutdown-signal log strings, and
S1 did not touch them. The issue DESCRIBES the character rather than quoting it,
because the file must be ASCII; it says so inline so a reader is not confused by
an ASCII hyphen standing in for the defect.

`npm run issues` run; INDEX.md regenerated and NOT staged (gitignored - it never
appeared in `git status`).

## T16 - the e2e assertions

`e2e/tests/dashboard-next/settings.spec.ts`, +8 lines and ZERO deletions.
Inserted AFTER the existing `Refresh alarms` assertion (old :159), so
`:114-152` is untouched, the `toHaveCount(2)` degraded-string pin at old :156 is
untouched, and main's pending comment edits at `:114-120` / `:158-162` have a
clean merge surface. The block now sits at :160-167:

```ts
    await expect(page.getByRole('button', { name: 'Show all' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Trace', exact: true })).toHaveCount(0);
```

above a 6-line ASCII comment explaining that both controls render only INSIDE a
row and the degraded state has none, and why `exact` is on `Trace`. The names
match Slice F's shipped accessible names exactly ("Show all" / "Trace").
Verified by `npm run typecheck` only - `npm run e2e` deliberately NOT run
(orchestrator's gates phase).

## Divergences (3, all deliberate, all reported)

1. **`cloudwatch.ts` header: I also updated the seam's READ LIST (:2, :7-8).**
   Not in the brief's site list. The line directly above the block I rewrote
   said the seam "exposes exactly the TWO narrow reads" and listed two, which
   is now false (four) - and my new text right below it discusses the detail
   path, so leaving it would have made the header self-contradicting. Same
   coherence argument the brief applies to `RecentErrors.tsx`. 3 lines changed,
   ASCII, no behavior. Slices C and D made the equivalent call for
   `systemStatus.ts` and handed it to me; nobody had flagged this one.
2. **`app/test/cloudwatch.adapter.test.ts:7-9` was REWRITTEN, not merely
   appended to.** The old text claimed the list projection is "timestamp,
   level, message, correlationId ONLY", which T4 made false. The spec's
   "NOT a correction" note protects the RAW-TEXT claim (which I preserved and
   restated), not the four-field claim. The `(unparseable log line)` comment at
   :148 is untouched and still true.
3. **Task 15 split into TWO commits** (truth-up, then the issue file) instead of
   the plan's single Step 5 commit. The brief sanctions either; the pinned
   message "retire the PII-safe projection guarantee" does not describe an
   encoding-bug filing.

## Line-count shifts for the post-sync phase

| File | Before -> after |
|---|---|
| `app/src/adapters/cloudwatch.ts` | 686 -> **694** (+8; everything below :14 shifts +8) |
| `app/src/services/systemStatus.ts` | 367 -> **377** (+10) |
| `app/src/routes/system.ts` | 124 -> **131** (+7) |
| `app/test/cloudwatch.adapter.test.ts` | 663 -> **675** (+12; append point now after :675) |
| `dashboard/src/routes/settings/RecentErrors.tsx` | 278 -> **292** (+14) |
| `dashboard/src/routes/settings/RecentErrors.test.tsx` | +3 net (describe now :85) |
| `e2e/tests/dashboard-next/settings.spec.ts` | 226 -> **234** (+8) |
| `infra/modules/ec2/main.tf` | +18 |

## Still owed / next steps (NOT mine)

1. **The perf source-citation ledger (T15 Step 1) is UNDONE by design** - G2
   defers it to post-sync. After the ONE main sync, re-derive the
   `useSystemStatus.ts` citations from the MERGED `e2e/performance/routes.ts` +
   `collect.test.ts`; `routes.ts` and the `collect.test.ts` pinned literal must
   change TOGETHER, keep `systemAlarms` first if the order-sensitive `toEqual`
   survived, and re-check the `140-155` negative pin and `cited()`'s shape.
   Then `cd e2e && npx vitest run performance/collect.test.ts performance/routes.test.ts`.
2. **`npm run e2e`** has not been run on the new assertions (gates phase).
3. **terraform plan + apply, dev AND prod** - the human's, before deploy.
4. Post-sync, grep the touched files for `recordOutbox` (deleted on main) and
   re-check `RUNBOOK.md:2169`, `settings.spec.ts:114-120`/`:158-162`, and
   `messaging.ts`'s comment region for conflicts - all three are in main's
   overlapping set.

No pre-existing red encountered anywhere. No `.superpowers` edits other than
this report.
