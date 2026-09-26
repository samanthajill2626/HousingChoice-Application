# Slice 1 - adversarial review (independent, fresh eyes)

- Branch `feat/share-skip-fix`, HEAD 9a8021eb, base main@bbaad87d.
- Input: `.superpowers/review/slice-1-package.txt` plus the repository. Nothing under
  `docs/superpowers/` was read.
- Method: read the diff whole, then every reader/writer of `ai_mode`, every consumer of
  `mode_changed`, the reminder job, the send wrapper, the import, the stage plumbing and the
  RUNBOOK commands. Claims were checked with throwaway probes (listed at the end). Nothing
  was run against local, dev or prod stages. `git status` is clean.
- Result: no MUST-FIX. Four SHOULD-FIX, four NOTE.

## Findings

### 1. SHOULD-FIX - The conditional write cannot lose to the breaker, although the RUNBOOK, the script header and a test all say it does

What the docs claim:
- RUNBOOK.md:347: "a breaker trip that lands mid-run keeps the runtime's outcome
  (`skippedOnCondition`)".
- enable-conversation-automation.ts:22-25: "a re-run and a concurrent runtime write are both
  safe".
- enableConversationAutomation.test.ts:156: "a row the breaker switches OFF again mid-run
  keeps the runtime outcome".

What the code does:
- The only runtime writer of `ai_mode` is the breaker. It calls `conversationsRepo.setMode`
  (conversationsRepo.ts:1832-1842) from sendMessage.ts:352.
- The breaker writes `manual`. The script's condition requires `ai_mode = :manual`
  (enable-conversation-automation.ts:168-170), so a trip always satisfies it.
- The script can see a trip only through the audit event. The breaker writes that event
  SEPARATELY, afterwards (sendMessage.ts:354-358). The script checks for it BEFORE its own
  write (enable-conversation-automation.ts:209-212), with an eventually consistent Query
  (census:106-120).

The interleaving, step by step:
1. Conversation C is `auto` and sending. sendMessage.ts:350-351 counts past the cap.
2. sendMessage.ts:352: `setMode(C, 'manual')` lands.
3. Bulk `--apply`: the Scan page returns C with `ai_mode = manual`.
4. enable:211: `findBreakerTrip(C)` finds no `breaker_trip`. The event is not written yet,
   or not yet visible to a non-ConsistentRead Query.
5. `planRow` returns `enable`. The UpdateItem condition `ai_mode = :manual` is TRUE, so C
   becomes `auto` and `bulk_enable` is appended.
6. sendMessage.ts:354: `breaker_trip` is appended.

Probe result (throwaway vitest file, the breaker's real repo calls around a real run, run
alone, then deleted):
- Counters: `{ enabled: 2, breakerTrippedExcluded: 0, skippedOnCondition: 0 }`.
- C ends `ai_mode = auto`.
- C's audit partition reads `[bulk_enable, breaker_trip]`. The row is ON while its last mode
  event says the breaker turned it OFF.
- Nothing in the counters or the census shows it. The census only examines `manual` rows.

Permanent variant. If the breaker's audit append at sendMessage.ts:354 throws, two things are
lost: the trip event, and the ERROR alarm line at :361-364, which is never reached. The row
then stays `manual` with no trip evidence. The census classifies it `imported`/`other`, and
every bulk run enables it.

The test at enableConversationAutomation.test.ts:156-184 flips the row to `auto`, the
opposite of what the breaker writes. It proves duplicate-run and operator-resume protection,
which the condition does give. It does not prove protection against a trip.

Impact is bounded. The breaker re-trips after up to `SEND_BREAKER_MAX_PER_MINUTE` more
automated texts in a minute (default 10, config.ts:991). The window is milliseconds, unless
the breaker's audit append failed. But the RUNBOOK sentence is a false safety claim in a prod
runbook, so correct it before the prod run whatever else is done.

Fix (atomic, script-only):
- In bulk mode add `attribute_not_exists(outbound_minute_bucket)` to the condition. The
  breaker counter is stamped on the row by the first counted automated send
  (conversationsRepo.ts:1886-1888). A `manual` row can never count a send, because
  sendMessage.ts:349 runs before :350. So "manual AND has a counter" means tripped, whether or
  not the trip was audited.
- Count losses on that clause separately and name each row.
- Have the census report manual one-to-one rows that have a counter but no `breaker_trip`
  event. Those are trips whose audit write was lost.
- Correct RUNBOOK:347, the header at :22-25 and the test title.
- Rebuild the test fixture from the breaker's real two writes.

### 2. SHOULD-FIX - Ambient endpoint variables redirect a `--env prod` run while the target line still says AWS

stageClient.ts:129-141 builds the dev/prod client from region and credentials only. It sets
no endpoint.

Probe (no network: a `finalizeRequest` middleware throws with the target host, so no socket
opens):

| Environment | Request goes to | `describe` says |
| --- | --- | --- |
| no endpoint variable | `https://dynamodb.us-east-1.amazonaws.com` | AWS |
| `AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000` | `http://127.0.0.1:8000` | "AWS us-east-1 account 938565869261 (profile housingchoice)" |
| `AWS_ENDPOINT_URL` | also redirected | AWS |

- `AWS_ENDPOINT_URL` also redirects STS, so there the guard most likely fails.
- A shared-config `endpoint_url` (AWS_PROFILE or `[default]`) should behave the same under
  the SDK's configured-endpoint rules. Not probed.

Effect with the DynamoDB-only variable:
- The guard passes, while the census and the fix script read and write another database
  under a prod label.
- Against DynamoDB Local, that is an empty database named after the real access key. The
  census reports zeros, the apply writes nothing, and the operator is told prod has nothing
  to fix.

This contradicts stageClient.ts:3 ("no ambient env vars decide anything") and RUNBOOK:343.

Related: the guard checks one `fromIni` provider instance (hcAws.mjs:39-40, via
`assertHousingChoiceAccount`), while the client builds a second one (stageClient.ts:131).
They share the profile name, not the provider.

Fix:
- Pass an explicit `endpoint: 'https://dynamodb.us-east-1.amazonaws.com'` for dev/prod. A
  probe confirmed an explicit endpoint outranks `AWS_ENDPOINT_URL_DYNAMODB`. Alternatively,
  refuse to start when any `AWS_ENDPOINT_URL*` is set.
- Print the endpoint in `describe`.
- Resolve the credentials provider once and hand the same one to STS and DynamoDB.
- Pin all of this with a stageClient test using the middleware probe.

The same exposure exists in import-apply.ts:254 and rail-verify.ts:146. That is pre-existing;
file it separately.

### 3. SHOULD-FIX - `parseStageArgs` accepts repeated arguments, and the last one silently wins

stageClient.ts:156-165 uses `values.set` and `flags.add` with no duplicate check.

Probe (pure call):
- `--env dev --apply --env prod` gives `target: prod`.
- `--conversation c-a --conversation c-b` gives `c-b`.

The parser's own rule (stageClient.ts:143-146: "Unknown arguments are REFUSED, never
ignored") stops short exactly where it matters most, the target stage.

Fix: return `{ usage: true }` on any repeated value or flag. Add both cases to the `it.each`
table at stageClient.test.ts:118-130.

### 4. SHOULD-FIX - The switch and its audit event are two writes, and an audit failure keeps switching

enable-conversation-automation.ts:160-202 writes the switch, then the audit event.

The existing test at enableConversationAutomation.test.ts:186-206 already shows the systemic
case: with every audit Put failing, every planned row is switched on (`auditFailed` 2 of 2).
In prod, a systemic audit failure (IAM, table name, throttling) means every planned row ends
up on with no event. Each must then be hand-backfilled, one at a time, with the PowerShell at
RUNBOOK:349-351.

The crash window is worse. A kill between :187 and :190 (Ctrl+C, sleep, network drop) leaves
an ON row with no event and no ERROR line. A re-run reports it `alreadyOn`. The only way to
find it is to pair "switched on" lines with auditRepo's "audit event appended" lines.

The handling is also inconsistent. A SWITCH failure aborts the run ("systemic until proven
otherwise"), but an AUDIT failure is treated as per-row.

Fix:
- Use one `TransactWriteCommand`: the conditional Update plus a Put of the audit item with
  `attribute_not_exists(entityKey)`. This pattern is already used in messagesRepo.ts and
  tourRemindersRepo.ts.
- That removes `auditFailed`, the backfill RUNBOOK block and the crash window.
- Build the item through an exported auditRepo helper rather than re-spelling its shape
  (auditRepo.ts:60-83).
- Map a `TransactionCanceledException` whose first reason is `ConditionalCheckFailed` to
  `skippedOnCondition`.
- Minimum alternative: abort on the first audit failure.

### 5. NOTE - Duplicated rules that will drift

- `POINTER_PREFIXES` (census:61) copies the private `POINTER_PARTITION_PREFIXES`
  (unreadFeed.ts:108).
- The census re-implements the job's tenant one-to-one lookup: census:258-275 against the
  module-private `resolveReminderTarget` (tourReminders.ts:1070-1102). It also hand-copies
  the gate order of `processReminderRow` (tourReminders.ts:1113-1260).
- `{ conversationsRepo } as unknown as RunDueTourRemindersDeps` (census:223) turns off type
  checking for `resolveUsableGroup`'s dependencies. If that function ever reads another
  dependency, the result is a runtime TypeError that fails the whole census.
- The fix script's type clause (enable:169-170) is a textual copy of `isOneToOneBucket`
  (unreadFeed.ts:295-297). That is an accepted pattern here (conversationsRepo.ts:1737), but
  no test checks the two stay equivalent.

Fix: export the pointer list and a pure one-to-one-target helper from the job (or from a lib
module), use them in both places, and add a parity test for the type clause.

### 6. NOTE - Module boundary: the ops scripts import the reminder job

An esbuild closure of the fix script has 47 modules, including
`adapters/twilioMessageTransport.ts`, `twilioHttpClient.ts`, `services/sendMessage.ts` and
`relayAnnouncements.ts`. All of that comes in to reuse three pure helpers. It is the whole
reason the pinned-checkout procedure at RUNBOOK:339 exists.

Load-time effects were verified benign (see the swept list).

Fix: move `DISCONTINUED_REMINDER_KINDS`, `retiredByTourStart`, `resolveUsableGroup` and the
lookup from finding 5 into a leaf lib module that the job re-exports. The scripts then no
longer pull in the send stack.

### 7. NOTE - Tests that prove the fixture, or nothing

- (a) stageClient.test.ts:69-83 asserts only fields of the returned object plus
  `credentialCalls === 1`. A mutant that calls the credentials factory, discards the result
  and builds `new DynamoDBClient({ region })` passes every assertion. So the property the
  header calls load-bearing (stageClient.ts:20-27) is untested. Assert
  `await stage.doc.config.credentials()` returns the injected identity, and assert the
  endpoint (finding 2).
- (b) No test reaches the command-line wiring (enable:285-323, census:301-327). For example,
  `includeBreakerTripped: parsed.flags.has('--apply')`, or swapped exit codes, would survive
  every test. Extract `main(argv, deps)` and test argv to options to exit code.
- (c) The census test never reaches an `unresolvable` branch (tour missing, no phone, no
  one-to-one conversation). It expects `unresolvable: 0`, so a mis-bucketed branch survives.
- (d) The race test: see finding 1.

### 8. NOTE - Messages and loose ends

- When `resolveStageClient` fails (account guard, STS unreachable, or `--lane` with dev/prod
  at stageClient.ts:96-98), the fix script prints "FAILED (see the PARTIAL report above)"
  (enable:320) and exits 1, though no partial report was printed. `--lane` with dev/prod is a
  usage-class error and should exit 2.
- `EnableOpts.now` (enable:99) is never read, yet every test passes it.
- `--include-breaker-tripped` is silently ignored in single mode.
- Imported rows' conversation ids are uuidv5 of a fixed in-repo namespace plus
  `conv1to1:<E.164>` (ids.ts:24, :63-65). That makes the ids logged per row phone-derived
  pseudonyms, recoverable by enumerating the phone-number space. Logging conversation ids is
  normal practice in this codebase, but the header's "never a phone" should not be read as
  "the ids are non-identifying".

## Swept and found clean

- **Credentials.** dev/prod credentials come from `fromIni({ profile })`. That ignores
  `AWS_ACCESS_KEY_ID` and `AWS_PROFILE`. The guard runs before the client is built. `local`
  never calls STS (tested).
- **Table targeting.** Every repo the scripts build honors `deps.env` for table names:
  conversationsRepo.ts:1096, contactsRepo.ts:773, toursRepo.ts:271, tourRemindersRepo.ts:264
  and :268, placementNudgesRepo.ts:130, auditRepo.ts:56. An ambient `TABLE_PREFIX` is
  overridden and `DYNAMODB_ENDPOINT` is ignored.
- **Lane mapping** matches the harness: `hclane<L>` (e2e/support/lane.mjs:167) and
  `hc-local-<L>-` (lane.mjs:306). The local key `local` matches import-apply.ts:242.
- **Load-time side effects.** The bundled closure runs only these at module scope:
  `createLogger`, `getTableSpec`, the event bus, rate-limited-warn constructors and
  `createExpressErrorHandler`. There is no client, no `loadConfig` and no network at import.
  The census's `invokedDirectly` block does not fire when the fix script imports it.
- **`unset` semantics.** The wrapper treats absent as auto (scheduledSendSuppression.ts:36-38),
  so the `unset` buckets are right.
- **Writers of `ai_mode`.** The only runtime writer is the breaker. Runtime creation sets
  one-to-one rows `auto` (conversationsRepo.ts:1273, :1383) and groups `manual` (:1941,
  :2385). The seeds' manual rows are all groups.
- **Readers of `ai_mode`:**
  - sendMessage.ts:349.
  - Suppression display only: routes/tourReminders.ts:1034, contactTimeline.ts:883.
  - placementNudges.ts:401 passes `undefined`.
  - No AI or extraction reader and no dashboard reader.
  - Nothing anywhere consumes `mode_changed` or its payload, so the new reasons
    (`bulk_enable`, `operator_resume`) break nothing.
- **What switches on for imported one-to-one rows.** All of it is intended:
  - Tour rungs. While manual, a rung is claimed and then refused at its due time
    (tourReminders.ts:1413-1453), so enabling releases no backlog burst.
  - The missed-call text, which has its own intake gate that skips landlords and partners.
  - The welcome text, `retrySend`, and broadcast property sends (broadcastFanOut.ts:421).
  - Placement nudges stay held manual-only (placementNudges.ts:123, :336-337).
- **The import change.** `isGroup` is a required boolean (apply.ts:1074). The group
  reduced-expression path keeps `:aiMode` referenced, because it is not in
  `groupUnsafeClauses`, so the pruned bindings stay valid. `if_not_exists` preserves existing
  switches. No other test expects imported one-to-one rows to be `manual`. The two new
  assertions would catch either binding mutating.
- **Reads.** `listDue` for reminders and nudges is paged to exhaustion with no Limit.
  `queryAll` caps at 100 pages with a WARN. The census makes reads only;
  `findByParticipantPhone` is a `queryAll`.
- **Scan paging.** `ExclusiveStartKey` is carried correctly and the `scanLimit` tests exercise
  it. A row the script updates keeps its key, so it is neither repeated nor skipped. Rows
  created mid-scan can be missed; the RUNBOOK's re-run rule covers that.
- **Concurrency among humans.** A duplicate run or an operator resume makes the second writer
  count `skippedOnCondition`, with no double audit event.
- **RUNBOOK PowerShell.** Both JSON constructions were evaluated in Windows PowerShell
  5.1.19041 and produce valid DynamoDB JSON; `from` parses as a hashtable key.
  `WriteAllText` is BOM-free. The audit item shape matches `auditRepo.append` (no `actorId`
  for a system action).
- **Alarm thresholds.** RUNBOOK:357 matches infra/modules/observability/main.tf:150-200. The
  comment at sendMessage.ts:359-360 ("this line IS the alarm") is stale; that is
  pre-existing, not this diff.
- **Gates.**
  - Lint on the touched files is clean apart from 2 pre-existing `no-explicit-any` errors in
    importApply.integration.test.ts (now :745 and :824; :739 and :818 at base).
  - app/scripts is type-checked via app/tsconfig.scripts.json (part of app `typecheck`), and
    eslint's TypeScript block covers it.
  - smoke is not applicable, since the scripts run under tsx and nothing is compiled.
- **Exit codes and posture.** Exit 2 means usage or `UsageError`; exit 1 means a partial run,
  `failed` or `auditFailed`. Writing requires an explicit flag, the same posture as
  import-apply `--yes` and rail-verify `--yes`.
- **No historical unaudited trips.** The breaker and its audit event landed on the same day
  (590c47be, 573a6ff5, 2026-06-12), so no pre-audit trips exist in prod data.

## Probe hygiene

- `app/test/zz-review-adv-breaker-race.test.ts` was run alone (1 passed, 93 ms) and then
  deleted.
- The `parseStageArgs` probe, the endpoint probes and the esbuild closure listing ran from
  the session scratchpad. They made no network calls and touched no database.
- `git status` is clean.
