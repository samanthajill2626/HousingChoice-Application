# Reader D - sweep-script precedent + e2e harness mechanics (plan T4, T6, T9-e2e, T15)

Base: worktree `W:\tmp\tour-reminder-ladder-phase-b`, branch `feat/tour-reminder-ladder-phase-b`
(main @ec32170a). Every line number below was re-derived from the live tree.

---

## 0. Drift index (detail in the sections named)

| # | drift | section |
|---|---|---|
| D1 | quiet-hours.spec.ts:368-369,402-403 break at **Task 7**, not Task 10 | 5.3 |
| D2 | `expectReminderRung(k,'upcoming')` cannot see a SKIPPED row | 5.4 |
| D3 | `tour-roster.spec.ts` cat-2 block is **480-523**, not 488-501 | 4.2 |
| D4 | `scheduled-visibility.spec.ts` anchors are 104-167 / 217-260, not 111-165 / 225-259 / 234-259 | 4.3 |
| D5 | steps.ts has **7** `confirmation` sites, not 2 | 4.1 |
| D6 | `tour-no-show-checkin.spec.ts:77-89` is an unlisted confirmation site (a whole derivation block) | 4.1 |
| D7 | worker poll is **30s**, not the 60s three e2e comments claim | 5.1 |
| D8 | spec 8.2's claim that the placement-nudge issue "names both" excluded surfaces is FALSE | 6.3 |
| D9 | plan T3 step 8 range `tours.spec.ts:283-287` -> true block 282-288 | 4.2 |
| D10 | `dev.ts` divergence block is 405-423, not 404-422 | 5.2 |

---

## 1. SWEEP PRECEDENT - `app/scripts/backfill-relay-optout-flag.ts` (177 lines)

### 1.1 Frame, in order

| element | line(s) | shape |
|---|---|---|
| header comment | 1-26 | what/why, idempotence, "no local-only guard, this is an ops script the human runs against dev and prod per the RUNBOOK", `PII: logs COUNTS and conversationIds only.`, then the run line |
| run line | 25-26 | `// Run (from repo root, tsx): \`tsx app/scripts/backfill-relay-optout-flag.ts\`` + `//   --dry-run   scan + report the plan (counts only); write NOTHING.` |
| imports | 27-32 | `ConditionalCheckFailedException` from `@aws-sdk/client-dynamodb`; `ScanCommand, UpdateCommand, type DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb`; `tableName` from `../src/lib/config.js`; `getDocumentClient` from `../src/lib/dynamo.js`; `logger` from `../src/lib/logger.js`; row type from the repo |
| action union | 34 | `export type RelayOptOutBackfillAction = 'stamp' \| 'remove' \| 'skip';` |
| exported planner | 36-50 | docblock states "PURE, so it is unit-testable without DynamoDB" then the three rules |
| result interface | 52-59 | `scanned/stamped/removed/skipped` + `skippedOnCondition: { stamp: number; remove: number }` (docblock: "Writes whose condition failed because the row moved under the run.") |
| runner signature | 61-63 | `export async function backfillRelayOptOutFlag(opts: { dryRun?: boolean; doc?: DynamoDBDocumentClient; env?: NodeJS.ProcessEnv } = {}): Promise<RelayOptOutBackfillResult>` |
| endpoint/table resolution | 64-67 | `const doc = opts.doc ?? getDocumentClient();` / `const env = opts.env ?? process.env;` / `const table = tableName('conversations', env);` / `const dryRun = opts.dryRun === true;` |
| per-action writers | 76-112 | local `stamp` / `remove` closures, each one `UpdateCommand` with a `ConditionExpression` re-stating the state the planner decided from |
| Scan paging | 114-154 | `let exclusiveStartKey: Record<string, unknown> \| undefined; do { ... } while (exclusiveStartKey !== undefined);`, server-side `FilterExpression`, `...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey })`, `exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> \| undefined;` |
| dry-run branch | 134-138 | counts the action, `continue` - never reaches a write |
| conditional catch | 147-151 | `if (!(err instanceof ConditionalCheckFailedException)) throw err; result.skippedOnCondition[action] += 1; logger.info({ conversationId, action }, '... row moved under the run; skipped');` |
| CLI entry | 159-176 | see below |

CLI entry, byte-exact (159-176):

```ts
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-relay-optout-flag.ts');
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:relay-optout-flag - starting');
  backfillRelayOptOutFlag({ dryRun })
    .then((result) => {
      logger.info(
        { ...result, dryRun },
        `backfill:relay-optout-flag - done${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      );
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'backfill:relay-optout-flag - FAILED');
      process.exitCode = 1;
    });
}
```

Arg parsing is exactly `process.argv.includes('--dry-run')`. No npm script exists for any
backfill (RUNBOOK:269 says so deliberately) - they are invoked `npx tsx app/scripts/<f>.ts`.

### 1.2 Its test - `app/test/backfillRelayOptOutFlag.test.ts` (123 lines)

Two describes: a pure planner block (21-44, no DynamoDB) and the integration block.

Reachability probe (46-55) - copy verbatim:

```ts
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}
const reachable = await endpointReachable();
```

Table-setup idiom (57-71) - **this is the helper a new integration test must call**:

```ts
describe.skipIf(!reachable)('backfillRelayOptOutFlag against DynamoDB Local', () => {
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const table = tableName('conversations', env);
  const conversations = createConversationsRepo({ doc, env });

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('conversations'), table);
  }, 120_000);
  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);
```

Imports it needs (`app/test/backfillRelayOptOutFlag.test.ts:7-17`):
`randomUUID` from `node:crypto`; `tableName` from `../src/lib/config.js`;
`createDocumentClient, createDynamoClient` from `../src/lib/dynamo.js`;
`deleteTableIfExists, ensureTable` from `../src/lib/dynamoAdmin.js`;
`getTableSpec` from `../src/lib/tables.js`.

48 files under `app/test/` use `ensureTable`; this `hc-test-<uuid8>-` + `ensureTable` +
`deleteTableIfExists` + `120_000` timeout quartet is the repo-wide idiom. `app/test/
tourReminders.test.ts:131,184-193` is the same shape for THIS feature's two tables:

```ts
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  ...
  beforeAll(async () => {
    await ensureTable(client, getTableSpec('tours'), tableName('tours', testEnv));
    await ensureTable(client, getTableSpec('tourReminders'), tableName('tourReminders', testEnv));
  }, 120_000);
```

Assertion style (107-121): `toMatchObject({ stamped: 1, removed: 1, skipped: 1 })` on the
dry run, re-read the row to prove NOTHING was written, then live run with
`skippedOnCondition: { stamp: 0, remove: 0 }`, then a third run asserting `{ stamped: 0,
removed: 0, skipped: 3 }` for idempotence.

### 1.3 The other four backfills

| file | exported entry | notes |
|---|---|---|
| `app/scripts/backfill-broadcast-list-partition.ts` | `backfillBroadcastListPartition` (:34) | NO exported planner - the simplest frame; stamps `_listPartition` |
| `app/scripts/backfill-unread-flag.ts` | `planUnreadBackfill` (:170), `backfillUnreadFlag` (:342), plus `deletedAtForItem` (:136), `resolveProbe` (:210), `collectContactKeys` (:275) | the RICHEST precedent - multi-rule planner + a pre-scan index pass |
| `app/scripts/backfill-media-pointers.ts` | `backfillMediaPointers` (:40) | deterministic puts, no conditional |
| `app/scripts/backfill-media-content-types.ts` | `backfillMediaContentTypes` (:291) + parsers | vendor-calling; has an env-guard preamble the tour sweep does NOT need |
| `app/scripts/backfillConsentMethod.ts` | `planConsentBackfill` (:47), `backfillConsentMethod` (:84) | camelCase filename - the odd one out; the four `backfill-*.ts` kebab names are the convention |

### 1.4 Reminder-row layout the Scan must use (T4, "do not guess the PK shape")

`app/src/repos/tourRemindersRepo.ts`:

- table base name `'tourReminders'` (`:170` `const table = tableName('tourReminders', deps.env);`)
- PK `reminderId` (`app/src/lib/tables.ts:427` `hashKey: { name: 'reminderId', type: 'S' }`);
  every write uses `Key: { reminderId }` (`:265,304,336,366,402`)
- GSIs: `byTour` (hash `tourId`), `byDueAt` (hash `_reminderPartition` fixed literal
  `'reminders'`, range `dueAt`) - `tables.ts:428-437`
- row fields (`:86-107`): `reminderId, tourId, kind, dueAt, _reminderPartition, sentAt?,
  sentBody?, canceledAt?, skippedAt?, skipReason?, createdAt`
- terminal markers for the idempotence condition: `sentAt`, `canceledAt`, `skippedAt`
- **tours repo method is `get(tourId)`** - `app/src/repos/toursRepo.ts:131`. There is NO
  `getById` on `ToursRepo`. The T4 tour cache must be `Map<string, TourItem | undefined>`
  filled from `toursRepo.get`.
- `ReminderSkipReason` union head at `tourRemindersRepo.ts:36-38`
  (`export type ReminderSkipReason =` at `:38`, first member `| 'no_conversation'` at `:39`,
  last member `| 'booked_too_late'` at `:79`). Plan T2 cites `:38` - correct.

---

## 2. RUNBOOK.md (2695 lines) - structure and the entry to model on

Top-level `##`: `Daily operations` (:21), `Push notifications` (:1310), `Importing the
founder's Quo + Airtable data (M1.6)` (:1405), `Group identity exclusion list` (:1615),
`Native group texting: merge/cutover checklist` (:1649), `Rollback` (:2089), `Reading logs`
(:2108), `Drift` (:2158), `Alarms` (:2182), `Costs` (:2399), `Custom domain & TLS` (:2425),
`Email (SES)` (:2490), `Security / hardening` (:2536), `State & bootstrap` (:2584),
`Cleaning up a merged feature` (:2602).

The backfill/one-time home is under `Daily operations`, in the `###` block
`### DynamoDB schema changes (apply BEFORE deploying code that uses them)` (:85), whose
sub-entries are BOLD LEAD PARAGRAPHS, not headings (e.g. `:222`, `:246`, `:260`), followed by
the standalone `###` entries at `:262` and `:287`.

**Model on `### Media content-type backfill (2026-08-26): NO schema change, ONE backfill,
DEPLOY FIRST` (:262-285)** - it is the only entry for a backfill with no schema change,
which is exactly the tour sweep's shape. Its skeleton:

```
### Media content-type backfill (2026-08-26): NO schema change, ONE backfill, DEPLOY FIRST

**Feature branch `feat/...` - owed on dev AND prod after that environment's deploy; nothing
else is owed (no Terraform, no secrets, no SSM).** <what/why, idempotence, the one
deliberate exception>

Per environment, in this order, and take **dev all the way through before starting prod**:

1. **Deploy the app image built from this `main`** ...
2. **Dry run:** `npx tsx app/scripts/<name>.ts --dry-run`. There is deliberately no npm
   script, matching every other backfill here. ...
3. **Read the report before applying.** ...
4. **Apply:** the same command WITHOUT `--dry-run`. ...
5. **Verify one repaired ... in THAT environment's dashboard** before moving on.

**The operator shell must carry all of this for the TARGET environment.** ...
```

Shorter precedent for the numbered-order-only form: `:203-209` (broadcast list partition,
three numbered steps) and `:246-258` (relay opt-out, "schema, then code, then a one-time
backfill", ending with the local-dataset note and "Disposable e2e lanes bootstrap their own
tables and need nothing").

Spec 3.2's preferred order for the tour sweep is the INVERSE of the media entry's
(sweep-then-deploy vs deploy-then-backfill), so the T4 entry must state its order and WHY,
the way `:268` states the media one's inversion.

---

## 3. E2E VEHICLE - `e2e/scenarios/steps.ts`

### 3.1 `tickTourReminders` - `e2e/scenarios/steps.ts:2033-2046`

Docblock byte-exact (**2033-2038**; the plan's "2034-2038" misses the opening `/**`):

```ts
  /**
   * [App, AUTO — dev seam] One deterministic tour-reminder poll pass. Omitting
   * `now` uses the server wall clock (fires the just-armed 'confirmation' rung);
   * pass `justAfter(times.<rung>)` to fire a future rung. GLOBAL: fires every
   * due row in the DB — callers assert arrival scoped to THEIR OWN phones only.
   */
```

(The em dash on 2034 and 2037 are pre-existing non-ASCII; a rewrite of these lines must be
ASCII per AGENTS.md.)

Body (2039-2046) - how the dev route is called:

```ts
  tickTourReminders(nowIso?: string): Promise<void> {
    return step(`App: reminder poll ticks${nowIso !== undefined ? ` (now=${nowIso})` : ''}`, async () => {
      const res = await this.page.request.post(`${NEXT}/__dev/tour-reminders/tick`, {
        data: nowIso !== undefined ? { now: nowIso } : {},
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    });
  }
```

`NEXT = process.env['E2E_DASHBOARD_URL']` - the tick goes through the Vite proxy, not the app
port. The ONLY other caller of the raw route in e2e is `tour-roster.spec.ts:500-502`.

### 3.2 `armedReminderDueAt` - `steps.ts:2014-2031`

```ts
  /** [App] The ARMED dueAt of one rung, read back from the reminders API.
   *  Since the 2026-08-26 retiming, day_before fires at 19:30 ORG-LOCAL the
   *  night before - a host-local mirror cannot compute it (the same reason
   *  morningOf once left TourTimes), so specs drive ticks from the value the
   *  server actually stored: correct by construction at any wall clock. */
  async armedReminderDueAt(kind: ReminderKind): Promise<string> {
```

It filters `r.kind === kind && r.state === 'upcoming'` (`:2026`) and THROWS
`armedReminderDueAt: no upcoming '<kind>' rung on tour <id>` (`:2028`) otherwise. After T9
a call with `'confirmation'` can only throw; after T8 a `discontinued` rung still has
`state === 'upcoming'`, so the helper would still return its dueAt - a tick on it sends
nothing.

### 3.3 `justAfter` - `steps.ts:366-369`

```ts
/** 1s past an ISO instant — a tick `now` that fires exactly the rungs due ≤ it. */
export function justAfter(iso: string): string {
  return new Date(Date.parse(iso) + 1_000).toISOString();
}
```

### 3.4 `tourSchedule` / `tourScheduleFullLadder` / `timesFor`

| symbol | line | note |
|---|---|---|
| `interface TourTimes` | 262-273 | fields `scheduledAtLocal`, `morningOf`, `enRoute`, `noShowCheckin`. `day_before` deliberately ABSENT (:266-269) |
| `tourSchedule(hoursFromNow = 48)` | 281-306 | docblock :289-290 `\`confirmation\` is not computed — its dueAt is the server's arm-time "now" (tick with no \`now\` fires it immediately).` **This sentence dies with T9.** |
| `tourScheduleFullLadder(daysOut = 2)` | 308-334 | fixes 14:00 local; chain `day_before 19:30 D-1 < morning_of 10:00 D < en_route 13:00 D < start 14:00 D` |
| `timesFor` | 336-352 | `morningOf = t - 4h`, `enRoute = t - 1h`, `noShowCheckin = t + 30m` |
| `pastTourTime(hoursAgo = 3)` | 354-364 | for `teamMarksAlreadyToured` |

### 3.5 ARRIVAL-not-trigger discipline - `steps.ts:1711-1713`

```ts
  //   - The tick seam (POST /__dev/tour-reminders/tick) is GLOBAL — assertions
  //     scope to THIS scenario's phones; the worker's 60s wall-clock poll may
  //     also fire a due rung, so we assert ARRIVAL, never which trigger fired.
```

(Inside the block comment `// ==== Tours verbs ====` at 1701-1715.) **The "60s" is wrong -
see 5.1.** This discipline covers PRESENCE assertions only; it says nothing about a rung a
spec asserts still PENDING, which is precisely T6 step 2a's audit target.

### 3.6 `expectGroupIntros` - `steps.ts:1921-1952` (plan says `:1930-1949`)

```ts
  /** [App→each member, AUTO] The intro message naming everyone connected reached
   *  EVERY member's fake thread FROM the pool number. */
  expectGroupIntros(members: Contact[]): Promise<void> {
```

The matcher (1938-1944): `m.direction === 'outbound' && m.from === pool &&
/You're now connected with/.test(m.body ?? '') && names.every((n) => (m.body ?? '').includes(n))`
where `names = members.map((m) => m.firstName)` (:1930). Comment 1926-1929 records the
2026-08-20 first-name decision. Callers: `tours.spec.ts:112, 190, 386` (all THREE are
tour-owned groups, so all three flip to the tour variant under T14 step 7).

The `:1887` connection sentence is in `teamOpensTourGroup` (dashboard-side, not fake-thread):

```ts
      await expect(this.page.getByText(/You're now connected with/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(this.page.getByText('Automated').first()).toBeVisible();
```

lines 1887-1890, preceded by the 2026-07-14 visibility comment at 1884-1886.

### 3.7 Callers of the four tick/schedule helpers (the T6 blast radius)

| helper | callers |
|---|---|
| `tickTourReminders` | `quiet-hours.spec.ts:345,374`; `scheduled-visibility.spec.ts:163,212,226,258,296`; `tours.spec.ts:130,149,199,243,255,279,287,299`; `tour-no-show-checkin.spec.ts:106` (**16 calls, 4 files**) |
| `armedReminderDueAt` | `quiet-hours.spec.ts:342`; `scheduled-visibility.spec.ts:212,296`; `tours.spec.ts:149` |
| `justAfter` | imports `quiet-hours.spec.ts:71`, `scheduled-visibility.spec.ts:26`, `tours.spec.ts:35`; calls `quiet-hours.spec.ts:345`, `scheduled-visibility.spec.ts:212,296`, `tours.spec.ts:149,255,287` |
| `tourSchedule` | `relay-number-lifecycle.spec.ts:284`; `approval-and-move-in.spec.ts:119`; `post-tour-application.spec.ts:100`; `scheduled-visibility.spec.ts:247`; `tours.spec.ts:128,197,241,277,297,317,331,395` |
| `tourScheduleFullLadder` | `quiet-hours.spec.ts:242`; `scheduled-visibility.spec.ts:99` |
| `expectGroupIntros` | `tours.spec.ts:112,190,386` |

`expectReminderRung` (`steps.ts:3501-3517`), `expectReminderInGroup` (`:2050-2070`),
`expectReminderTo1to1`, `expectReminderVisibleInGroupThread`, `REMINDER_KIND_LABELS`
(`:246-251`), `REMINDER_BODY_MARKERS` (`:214-226`) all key on `ReminderKind`
(`steps.ts:130-136`), which KEEPS `'confirmation'` under spec 5 - no type change.

---

## 4. E2E CONFIRMATION SITES (full grep of `e2e/`)

Non-reminder hits excluded: `e2e/performance/auth*.ts` (`local_confirmation_mismatch`),
`approval-and-move-in.spec.ts:61,230`, `post-tour-application.spec.ts:135,192,224,258,291`
and `scheduled-visibility.spec.ts:315` (the placement stage label `Awaiting receipt
confirmation`), `a2p-compliance.spec.ts:27,561`, `group-text-stop.spec.ts:13`,
`relay-open-stop.spec.ts:19,27,186`, `voice-outbound.spec.ts:727` (Twilio/vendor prose).

### 4.1 `e2e/scenarios/steps.ts` - **7 sites, not 2 (D5)**

| line | quoted | intent | cat |
|---|---|---|---|
| 132 | `  \| 'confirmation'` | `ReminderKind` union member | KEEP (kind stays valid, spec 5) |
| 215 | `  confirmation: 'your tour is set for',` | `REMINDER_BODY_MARKERS` entry | KEEP (catalog entry survives) |
| 246 | `  confirmation: 'Confirmation',` | `REMINDER_KIND_LABELS` mirror of `dashboard/src/api/types.ts` | KEEP (label still renders for in-flight/seeded rows) |
| 289-290 | ``* `confirmation` is not computed — its dueAt is the server's arm-time "now"`` / ``* (tick with no `now` fires it immediately).`` | `tourSchedule` docblock | **cat 2 - FALSE after T9; rewrite** |
| 2035 | ``   * `now` uses the server wall clock (fires the just-armed 'confirmation' rung);`` | `tickTourReminders` docblock | **cat 2 - T6 step 3 target** |
| 2248 | `   *  ladder and RE-ARMS it off the new time (asserted by a fresh confirmation). */` | `teamReschedulesTour` docblock | **cat 2 - unlisted by the plan; the re-arm proof moves to `day_before`, so this sentence must move with it** |
| 3596 | `   *  that body - verified: tours.spec.ts asserts confirmation/day_before` | `requireTourReminderContext` docblock | **cat 2 - unlisted; a "verified" claim about tours.spec.ts that T6 falsifies** |

### 4.2 `e2e/tests/scenarios/tours.spec.ts` - 6 code sites + 2 comments

| line | quoted | intent | cat |
|---|---|---|---|
| 12 | `//     the time) is the moment the confirmation + reminder ladder fire.` | file header | cat 2 (comment) |
| 130-131 | `await flow.tickTourReminders();` / `await flow.expectReminderInGroup('confirmation', [tenant, owner]);` | landlord-led group arrival | **cat 1** |
| 133 | `await flow.expectReminderVisibleInGroupThread('confirmation');` | dashboard group bubble | **cat 1** (same tick) |
| 196 | `// Book → the confirmation lands in the GROUP (pm_team routes like landlord-led).` | comment | cat 2 |
| 199-200 | `await flow.tickTourReminders();` / `await flow.expectReminderInGroup('confirmation', [tenant, pm]);` | pm_team group arrival | **cat 1** |
| 239-244 | `// Book → confirmation arrives 1:1 from the APP number ...` / `await flow.tickTourReminders();` / `await flow.expectReminderTo1to1('confirmation', tenant);` | self-guided 1:1 arrival | **cat 1** |
| 279-280 | `await flow.tickTourReminders();` / `await flow.expectReminderTo1to1('confirmation', tenant);` | no-show setup, 1:1 arrival | **cat 1** |
| 292-300 | `// flip a rung's body carries its tour's TIME, so the fresh confirmation is` ... `await flow.tickTourReminders();` / `await flow.expectReminderTo1to1('confirmation', tenant);` | RESCHEDULE RE-ARM PROOF | **cat 2 redesign** - same proof strategy as `scheduled-visibility.spec.ts` (c); the plan lists only the scheduled-visibility twin |

**cat 4 site (D9):** the true block is **282-288**, not 283-287:

```ts
  // The tenant never shows. The no-show check-in is no longer auto-armed - it is
  // a MANUAL send now (tour-no-show-checkin.spec.ts), so ticking past its OLD due
  // time fires the earlier rungs (unasserted) but never the check-in body. ABSENCE,
  // so this rides the kind-distinctive MARKER: an exact composed string that were
  // ever mis-composed would make "nothing arrived" pass for the wrong reason.
  await flow.tickTourReminders(justAfter(times.noShowCheckin));
  await flow.expectNoOutboxMessageContaining(tenant, REMINDER_BODY_MARKERS.no_show_checkin);
```

`times.noShowCheckin = scheduledAt + 30m`, so the tick's `now` is AFTER the tour start ->
under T3's gate the still-pending pre-tour rungs are claim-skipped `tour_already_passed`
instead of firing. Only the COMMENT at 284 ("fires the earlier rungs") is falsified; the
assertion at 288 still passes. T3 step 8 should rewrite 282-286 and ADD a retirement
assertion (`GET /api/tours/:id/reminders` -> `state === 'skipped'` for morning_of/en_route),
because the existing absence assertion is green either way.

Note `:255` `await flow.tickTourReminders(justAfter(times.enRoute));` is `scheduledAt - 1h`,
BEFORE the tour - the gate does not apply there.

### 4.3 `e2e/tests/scenarios/scheduled-visibility.spec.ts` - 6 code sites

| line | quoted | intent | cat |
|---|---|---|---|
| 114 | `await flow.expectReminderRung('confirmation', 'next');` | Part A: confirmation is the NEXT rung | **cat 2 (redesign)** |
| 163-165 | `await flow.tickTourReminders();` / `await flow.openTourReminders();` / `await flow.expectReminderRung('confirmation', 'sent');` | Part A: fire it, panel reads SENT | **cat 2 (redesign)** |
| 226-229 | `await flow.tickTourReminders();` / `await flow.expectReminderTo1to1('confirmation', tenant);` / ... / `await flow.expectReminderRung('confirmation', 'sent');` | (c) setup: a SENT rung to contrast the fresh ladder | **cat 2 (redesign)** |
| 250 | `await flow.expectReminderRung('confirmation', 'next'); // the fresh armed ladder` | (c): re-arm proof, position | **cat 2 (redesign)** |
| 258-259 | `await flow.tickTourReminders();` / `await flow.expectReminderTo1to1('confirmation', tenant);` | (c): re-arm proof, arrival | **cat 2 (redesign)** |

**True anchors (D4):**

- Plan's "`:111-165` confirmation panel walk" -> the whole test is
  **`test('Part A — the tour Reminders panel renders the armed ladder + NEXT rung on /tours/:id'` at 104-167**. The confirmation-bearing parts are the comment at 111-112, the
  assertion at 114, and the tail at 161-166. The absence check at 124-140 and the body pin
  at 142-159 sit between them and DO NOT mention confirmation, but 127-134's re-derivation
  comment counts "The four rungs asserted upcoming above are the whole panel" - that count
  becomes THREE (day_before / morning_of / en_route) under T9 and must be re-derived.
- Plan's "`:225-259`" / "`:234-259`" -> the whole test is
  **`test('(c) reschedule: tick a rung → panel states → reschedule cancels + re-arms a fresh ladder'` at 217-260**. Redesign-relevant span: comment 224-225, tick+assertions 226-230,
  re-derivation comment 232-246, reschedule+assertions 247-250, re-arm comment 252-257,
  proof 258-259.

The 232-246 comment is the "2026-08-26 re-derivation" the plan tells the builder to imitate.
Its load-bearing sentence for the redesign (243-246):

```
  // `next` is the earliest-dueAt UPCOMING row (routes/tourReminders.ts): the
  // fresh confirmation's dueAt is the re-arm instant, i.e. now, which beats
  // every other fresh rung, and the old confirmation is SENT rather than
  // upcoming - so confirmation is still the NEXT rung.
```

Rebuilding on `day_before`: after the reschedule to `tourSchedule(72)`, the fresh ladder's
earliest UPCOMING rung is `day_before` (19:30 org-local ~2.8 days out) and the OLD
`day_before` is `canceled`, so `expectReminderRung('day_before', 'next')` and
`expectReminderRung('day_before', 'canceled')` would BOTH match label-filtered rows -
`expectReminderRung`'s state filters disambiguate ('Next' vs 'Canceled'), and its docblock
at 3485-3487 explicitly covers this two-rows-one-label case. The setup half (226-230) must
convert to a `justAfter(armedReminderDueAt('day_before'))` tick BEFORE the reschedule, which
then makes the OLD row `sent` not `canceled` - so line 249's `'canceled'` assertion has to
move to a different rung (`morning_of`) or the setup tick has to be dropped.

### 4.4 `e2e/tests/tour-roster.spec.ts` - 1 site, block **480-523** (D3)

The plan's `488-501` covers only the comment + the tick. The block's PAYOFF is 505-523 and
uses `REMINDER_KIND_LABELS.confirmation` at `:519`. Full text needed to redesign:

```ts
    // --- 2b. The LADDER itself shows the pause (spec 9, D11) ----------------
    // The card note above is the ROSTER's statement; this is the reminder
    // ladder's own, and they are different surfaces. An UPCOMING rung says
    // nothing about the roster (tenant_not_on_roster is not a suppression
    // reason), so the only ladder-visible signal is the chip a claim-skip
    // leaves behind - which means the poll has to actually run.
    //
    // TIMING-ROBUST BY CONSTRUCTION: the booking above armed the ladder and the
    // `confirmation` rung's dueAt is the server's ARM-TIME instant, so it is
    // already due - no scheduledAt change is needed (moving the tour near-term
    // would un-arm the other rungs). Rather than tick bare on the wall clock,
    // read the rung's STORED dueAt (which IS the real send time - it is the
    // quiet-hours-clamped instant) and tick 1s past it, the `justAfter` idiom.
    // The tick is global, but at ~now it fires only what the worker's own 60s
    // poll would have fired anyway; a far-future `now` never belongs here.
    const ladder = await req.get(`${NEXT}/api/tours/${tourId}/reminders`);
    expect(ladder.ok(), await ladder.text()).toBeTruthy();
    const { reminders } = (await ladder.json()) as { reminders: { kind: string; dueAt: string }[] };
    const confirmation = reminders.find((r) => r.kind === 'confirmation');
    if (confirmation === undefined) throw new Error('the booking armed no confirmation rung');
    const tick = await req.post(`${NEXT}/__dev/tour-reminders/tick`, {
      data: { now: new Date(Date.parse(confirmation.dueAt) + 1_000).toISOString() },
    });
    expect(tick.ok(), await tick.text()).toBeTruthy();

    await page.goto(`${NEXT}/tours/${tourId}`);
    // The panel is an UNNAMED <section> with a 'Reminders' <h3> (Card), not a
    // region and not behind a disclosure - scope by the heading (the
    // Scenario.remindersCard idiom, inlined for this Scenario-free dialect).
    const remindersCard = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Reminders' }) });
    // `.first()` on the rung is the Scenario.remindersCard idiom too
    // (steps.ts:3277): it resolves to one node today, but it collapses the whole
    // chain, so neither a second matching <section> nor a second matching rung
    // could turn this into a strict-mode violation.
    await expect(
      remindersCard
        .getByRole('listitem')
        .filter({ hasText: REMINDER_KIND_LABELS.confirmation })
        .first(),
    ).toContainText(`Skipped - ${REMINDER_SKIP_REASON_LABELS.tenant_not_on_roster}`, {
      timeout: 20_000,
    });
```

Intent: prove a claim-skip chip (`tenant_not_on_roster`) lands on the panel. It needs ANY
kind that is (a) armed, (b) claim-skippable, (c) drivable. The booking is `now + 5 days`
(`:471-473`), so the redesign is `day_before`: read its stored dueAt from the same
`/reminders` GET and tick `justAfter` it. Note the "far-future `now` never belongs here"
warning at :494 is about the GLOBAL tick - a `day_before` tick 4 days out DOES pull other
scenarios' rows; the tick is already global today and the discipline is arrival-scoping, but
this comment must be re-derived, not just re-pointed. Also `:513`'s cross-reference
`steps.ts:3277` is stale - `remindersCard` is not at 3277 in the current file.

### 4.5 `tour-no-show-checkin.spec.ts:77-89` - UNLISTED site (D6)

```ts
  //   - confirmation: dueAt IS the arm instant, which is 26h AFTER the tour
  //     start, so the at-or-past-start rule fires and it is born a VISIBLE
  //     `past_event` skipped row. It is NOT pending and it does NOT fire.
```

Part of a five-bullet derivation (77-89) whose conclusion at :89 is
`// So NOTHING is pending, and the wall-clock tick in half 1 fires NOTHING.` The conclusion
SURVIVES T9 (confirmation simply no longer exists rather than being born `past_event`), but
the bullet is false and the block's own commentary (:101-104) explains why a wrong
derivation fails silently here. Delete the bullet; keep the count assertion at 108-111.

### 4.6 Count reconciliation

Plan: `scheduled-visibility.spec.ts (6), tours.spec.ts (6), tour-roster.spec.ts (1),
e2e/scenarios/steps.ts (2)` = 15. Live: 6 + 6 + 1 = 13 code sites confirmed, but steps.ts
has **7** mentions (3 KEEP, 4 comment rewrites) and `tour-no-show-checkin.spec.ts` adds a
14th file-level site. True worklist size = 13 code sites + 8 comment/docblock sites.

---

## 5. LIVE-WORKER AUDIT PREP (plan T6 step 2a)

### 5.1 How the worker starts, and its cadence

- `scripts/e2e-session.mjs:381` `spawnNode('worker', ['--import', 'tsx', path.join('app', 'src', 'worker.ts')]);` - a real child process of the launcher, restarted with the app on the
  sentinel (`:579 killChild('worker')`).
- `e2e/playwright.config.ts:189` `command: \`node scripts/e2e-session.mjs\`` - `npm run e2e`
  boots the SAME launcher, so the full suite runs the same live worker as `e2e:session`.
- `scripts/e2e-session.mjs:247-253` (childEnv comment):
  ```
  // Cross-process event bridge: the worker process forwards its bus emits to
  // the app's POST /internal/events so SSE clients see worker-side writes live
  // (the event-bridge e2e spec proves this path). WORKER_POLL_INTERVAL_MS is
  // deliberately NOT lowered here: in-app dev ticks jump their clock past the
  // debounce, the worker polls real time - a fast cadence would let the worker
  // race tick-driven specs for due rows (tick.processed assertions).
  ```
  `WORKER_POLL_INTERVAL_MS` is never SET in childEnv either, so the lane inherits
  `app/src/lib/config.ts:609` `const workerPollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS ?? 30000);`
  -> **30 seconds** (D7). Three e2e comments say "60s": `steps.ts:1712`,
  `tour-roster.spec.ts:493`, and `app/src/routes/dev.ts:429` (placement twin). None is
  load-bearing but all three are wrong and the T6 audit reasons from them.
- The tour-reminder poll is registered at `app/src/worker.ts:349`
  `startPoll('tour reminder', (now) => runDueTourReminders(now, tourReminderDeps));`
  over deps built at `:316-347`.

### 5.2 Is the e2e lane's real poll live for tour reminders today?

**It runs, and it is INERT.** `tourReminderDeps` (`worker.ts:316-347`) supplies NO
`manualOnlyKinds`, so `app/src/jobs/tourReminders.ts:602-603` uses the default:

```ts
  const manualOnly = deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS;
  const dueRows = allDueRows.filter((r) => !manualOnly.has(r.kind));
```

and `MANUAL_ONLY_REMINDER_KINDS` (`:201-206`) holds all four auto-armed kinds
(`confirmation, day_before, morning_of, en_route`). `no_show_checkin` is not in the set but
is also absent from `REMINDER_KINDS` (`:235-240`), so nothing ever arms it. Net: `dueRows`
is always empty, `:611 if (dueRows.length === 0) return;`.

**T7 flips this.** Emptying `MANUAL_ONLY_REMINDER_KINDS` makes the lane's worker a live
wall-clock sender at 30s for the first time since 2026-08-20.

The dev-tick override that hid this (plan says `dev.ts:404-422`; true **405-423**, D10):

```ts
    // DELIBERATE DIVERGENCE FROM PRODUCTION - read before trusting a tick.
    ... (405-419) ...
    await runDueTourReminders(nowIso, {
      ...tourReminderDeps(),
      manualOnlyKinds: new Set(),
    });
```

with the deletion order written into the comment at `:418-419`
(`// leave a permanent dev/prod fork.` / `// Delete this when the hold-back is lifted`).

### 5.3 Specs asserting a rung stays `upcoming` / pending, with fixture offsets

| file:line | assertion | rung dueAt vs run | verdict |
|---|---|---|---|
| `scheduled-visibility.spec.ts:114` | `expectReminderRung('confirmation', 'next')` | dueAt = arm instant (**NOW**) | dies at T9 (no such rung) |
| `scheduled-visibility.spec.ts:115` | `('day_before','upcoming')` | `tourScheduleFullLadder()` = 14:00 D+2, day_before 19:30 D+1 -> ~1.8d out | SAFE |
| `scheduled-visibility.spec.ts:122` | `('morning_of','upcoming')` | 10:00 D+2 -> ~2d out | SAFE |
| `scheduled-visibility.spec.ts:123` | `('en_route','upcoming')` | 13:00 D+2 | SAFE |
| `scheduled-visibility.spec.ts:166` | `('day_before','upcoming')` after a bare tick | ~1.8d out | SAFE |
| `scheduled-visibility.spec.ts:192` | `expectUpcomingItem(tenantId, { bodyContains: dayBefore, source: 'tour_reminder' })` | ~1.8d out | SAFE |
| `scheduled-visibility.spec.ts:230` | `('day_before','upcoming')` | ~1.8d out | SAFE |
| `scheduled-visibility.spec.ts:250` | `('confirmation','next')` on the FRESH ladder | dueAt = re-arm NOW | dies at T9 |
| `scheduled-visibility.spec.ts:279-...` | `(d)` opted-out: "Will be skipped - contact opted out" on the day_before Upcoming card | ~1.8d out | SAFE from the clock; **the note text may change at T8/T12** |
| `quiet-hours.spec.ts:355` | `('day_before','upcoming')` after the DEFER tick | tick `now` is `justAfter(dueAt)`; the row stays pending by design | SAFE from the clock |
| `quiet-hours.spec.ts:368-369` | `expect(dayBeforeRow.getByText(PAUSED_NOTE)).toBeVisible()` + `expect(...QUIET_NOTE).toHaveCount(0)` | - | **BREAKS AT T7** |
| `quiet-hours.spec.ts:402-403` | same pair, test (3) | - | **BREAKS AT T7** |
| `tour-roster.spec.ts:516-523` | `Skipped - <tenant_not_on_roster>` chip | - | breaks at T9 (rung gone) |

**D1 - the plan mis-assigns quiet-hours.spec.ts.** Plan T10 step 4 says "re-read
`quiet-hours.spec.ts` ... and re-baseline any assertion the exemption changes"; T7 mentions
no e2e file at all. But the two failing assertion pairs break on the UNPAUSE (T7), not on the
`en_route` exemption (T10) - `day_before` is not exempt. The constants themselves say so
(`quiet-hours.spec.ts:97-112`):

```ts
/** The deferral note as RENDERED by RemindersPanel: quiet hours is a WAIT, not a
 *  skip - if this ever reverts to "Will be skipped" the promise is broken.
 *
 *  UNREACHABLE ON A TOUR RUNG SINCE 2026-08-20 and kept deliberately: the
 *  manual-only hold-back outranks quiet hours in the shared precedence ladder,
 *  so every auto-armed rung now chips PAUSED_NOTE instead (see below). This
 *  constant stays as the assertion the specs return to the moment
 *  MANUAL_ONLY_REMINDER_KINDS is emptied. ... */
const QUIET_NOTE = `Will wait ${EM_DASH} quiet hours`;

/** What an auto-armed rung actually chips today: the manual-only hold-back
 *  (founder decision 2026-08-20). Neither a skip nor a timed wait - the rung
 *  stays pending and sendable, and only a person releases it. */
const PAUSED_NOTE = `Paused ${EM_DASH} send manually`;
```

The re-baseline is an EXACT INVERSION at both sites (`QUIET_NOTE` visible, `PAUSED_NOTE`
absent) plus deletion of `PAUSED_NOTE` and the precedence prose at `:356-366` and `:398-401`.
**T7 must carry this, or gate 4 goes red two tasks after the cause.**

`quiet-hours.spec.ts` other Phase-B-relevant facts:
- header timing contract 21-61; the `:58` batch sentence, byte-exact:
  ```
  //     is ever in either batch, so nothing supersedes day_before. (confirmation,
  //     whose dueAt is the arm instant, IS in the defer batch - but it is EARLIER
  //     in the ladder, so supersession retires IT and leaves day_before pending,
  //     which is exactly what the "still upcoming" assertion reads.)
  ```
  (lines 57-61). T9 makes the parenthetical vacuous - the defer batch then holds day_before
  ALONE. Rewrite, do not delete: the surrounding argument (55-57, morning_of at 10:00 tour
  day is after both ticks) is what still makes the test deterministic.
- fixtures: `bookedSelfGuidedTour` (226-244) uses `tourScheduleFullLadder(2)` (:242) - fixed
  14:00, two days out. All rungs far-future. `QUIET_AROUND_DAY_BEFORE` anchors the window on
  the RUNG (test 2); `windowAroundNow()` anchors on the CLOCK (test 3, :393).
- `reminderRow(page, kind)` helper at 201-209 (label-filtered listitem in the Reminders
  section) - the T8/T12 chip assertions should reuse it.
- `test.beforeAll`/`afterAll` (249-265) force `QUIET_OFF` around the file.
- test (2) at 325-378, test (3) at 380-412, settings round-trip at 285-323.

### 5.4 The audit hazard the plan's step 2a does not name (D2)

`expectReminderRung(kind,'upcoming')` (`steps.ts:3501-3517`) resolves 'upcoming' as
`rows.filter({ hasNotText: 'Sent' }).filter({ hasNotText: 'Canceled' })` (`:3513`). It does
NOT exclude `Skipped`. So a rung the live worker (or the past-tour gate, or the discontinued
guard) retires with a SKIPPED chip still satisfies every `'upcoming'` assertion in the table
above. The audit therefore cannot be done by "did the spec stay green"; each converted or
retained pending assertion needs either a positive state read from
`GET /api/tours/:id/reminders` or an added `hasNotText: 'Skipped'`.

### 5.5 Net audit verdict per file (for the worklist)

- `scheduled-visibility.spec.ts` - all surviving pending rungs are >= ~1.8 days out
  (`tourScheduleFullLadder()` at `:99`). No live-worker race. Only the two `confirmation`
  now-dueAt sites are at risk and both are being removed anyway.
- `tours.spec.ts` - `tourSchedule()` (now+48h) at `:128,197,241,277`; earliest live rung is
  `day_before` at 19:30 org-local the evening before, ~1 day out at worst. No race. But every
  bare `tickTourReminders()` at `:130,199,243,279,299` becomes a NO-OP after T9 and must be
  converted, not deleted.
- `quiet-hours.spec.ts` - no race (all rungs far future, both ticks are explicit `now`s), but
  see D1.
- `tour-roster.spec.ts` - booking at now+5d; once redesigned onto `day_before` (~4 days out)
  no race.
- `tour-no-show-checkin.spec.ts` - tour is 26h in the PAST; after T3's gate nothing can fire.
  Its assertion strengthens.
- **The only construct that WOULD race is a directly-created near-now due row** (the unit
  vehicle of T5). If any e2e conversion reaches for that shape, the 30s worker can claim it
  before the spec's tick. Keep the e2e vehicle on `justAfter(armedReminderDueAt(...))` of a
  far-future rung, per T6 step 2 - never a near-now `repo.create`.

---

## 6. Task 15 - issues and TODO markers

### 6.1 Frontmatter shape

`docs/issues/_TEMPLATE.md:1-9`:

```
---
id: replace-with-filename-slug
title: One-line summary of the issue
type: bug
severity: med
status: open
area: app
created: 2026-01-01
refs:
---
```

A RESOLVED file adds one key, between `created:` and `refs:` - e.g.
`docs/issues/ai-run-log-decisions-count-miscounts.md:1-11`:

```
status: resolved
area: dashboard
created: 2026-08-09
resolved: 2026-08-09
refs: ...
```

### 6.2 The four files

| file | id | type | severity | status | area | created | resolved | T15 action |
|---|---|---|---|---|---|---|---|---|
| `docs/issues/tour-reminder-ladder-phase-b.md` (13130 B) | `tour-reminder-ladder-phase-b` | improvement | med | **open** | `app/jobs` | 2026-08-26 | - | -> `resolved` + `resolved: 2026-08-31` + the nine-row disposition list (spec 12's table) |
| `docs/issues/message-interpolate-token-reexpansion.md` (4617 B) | `message-interpolate-token-reexpansion` | bug | med | **open** | `app/messages` | 2026-08-31 | - | closed in **T1 step 6**, not T15 |
| `docs/issues/placement-nudge-overdue-invisible-on-card.md` (2572 B) | `placement-nudge-overdue-invisible-on-card` | improvement | med | **open** | `app/routes` | 2026-08-31 | - | **STAYS OPEN** (spec 8.3: "It is FILED, not built"). See D8. |
| `docs/issues/tour-copy-where-token-declared-not-passed.md` (3318 B) | `tour-copy-where-token-declared-not-passed` | debt | low | **open** | `app/messages` | 2026-08-31 | - | **STAYS OPEN** - it is the TODO's new target, not a closure |

`refs:` on the ledger: `app/src/jobs/tourReminders.ts, app/src/messages/tourCopy.ts,
app/src/repos/tourRemindersRepo.ts, docs/superpowers/specs/2026-08-26-tour-reminder-ladder-design.md`
- a resolution should append the Phase B spec/plan paths.

Ledger's nine items are numbered `##`-less bold list entries at
`:25, 41, 50, 59, 64, 69, 76, 92, 178`, with the closing `**Suggested fix.**` at `:199`.

Regeneration: `package.json:38` `"issues": "node scripts/issues.mjs"`. `docs/issues/INDEX.md`
is gitignored - run it, never commit it.

### 6.3 D8 - spec 8.2's claim about the placement-nudge issue is false

Spec `2026-08-31-...-design.md:655-657` says of `routes/contactTimeline.ts` and
`routes/relayGroups.ts`: "Both are named in
`docs/issues/placement-nudge-overdue-invisible-on-card.md` as part of that item's scope."
Grepping that file for `contactTimeline` / `relayGroups` returns **zero hits**; its only
cross-references are `app/src/routes/tourReminders.ts:161` (`refs:` and `:29`) and `:38`
(`routes/tourReminders.ts:497` / `:616`). Either T12 or T15 must ADD the two excluded
surfaces to that issue's body, or the spec's exclusion record does not exist anywhere.

### 6.4 `TODO(tour-reminder-ladder-phase-b)` markers in `app/src`

Exactly **one**, and the plan's anchor is correct:

`app/src/messages/tourCopy.ts:172-175`:

```ts
 *  TODO(tour-reminder-ladder-phase-b): the day a generic override map lands,
 *  widen this to the EFFECTIVE template - ComposeTourReminderInput.overrides
 *  already exists, so activating the hazard is one call-site argument away,
 *  and an override could add a name token the default lacks. */
```

It closes the docblock of `export function reminderNamesUsed(` at `:176` (called once, at
`tourCopy.ts:227`). Spec 12 item 9 (`:1170-1176`) authorizes the re-point to
`TODO(tour-copy-where-token-declared-not-passed)`. There are no `TODO(...)`/`FIXME`/`HACK`
markers for the other three slugs anywhere in `app/src`, `dashboard/src`, or `e2e`, and no
other file in those trees mentions `tour-reminder-ladder-phase-b`.

---

## 7. E2E config and lane selection

`e2e/playwright.config.ts`:

| setting | line | value |
|---|---|---|
| `testDir` | 118 | `'./tests'` |
| `timeout` | 121 | `60_000` (`DEFAULT_TEST_TIMEOUT_MS`, :115), scaled by `E2E_SLOWMO` |
| `expect.timeout` | 135 | `15_000` |
| `globalSetup` | 139 | `'./support/preflight.ts'` (stale-stack guard) |
| **`fullyParallel`** | 140 | `false` |
| **`workers`** | 141 | `1` |
| **`retries`** | 143 | `0` |
| **`trace`** | 167 | `process.env['E2E_TRACE'] === '1' ? 'retain-on-failure' : 'on-first-retry'` - with `retries: 0` the default collects NOTHING; `E2E_TRACE=1` is the opt-in |
| `screenshot` / `video` | 168-169 | `'only-on-failure'` / `'retain-on-failure'` |
| `navigationTimeout` | 170 | `15_000` |
| projects | 177-182 | one, `chromium` |
| `webServer.command` | 189 | `node scripts/e2e-session.mjs` |
| `webServer.reuseExistingServer` | 203 | `!process.env.CI` |
| `webServer.timeout` | 204 | `180_000` |

`workers: 1` + `fullyParallel: false` means only ONE spec runs at a time, so the live-worker
race window per rung is the runtime of a single test (<= 60s, or 90s inside
`tests/scenarios` via `useScenarioBudget`) - not the whole suite.

Lane/port selection (`npm run e2e` -> `npm run e2e -w @housingchoice/e2e` ->
`playwright test`):

1. `liveSessionLane()` (config :26-51) adopts a live `e2e:session`'s lane from
   `e2e/.artifacts/lane.json` when `E2E_LANE` is unset - requires BOTH a live launcher pid
   and a matching lease.
2. Otherwise `execFileSync(process.execPath, [e2e/support/lane.mjs])` (:59-68) resolves lane
   + ports SYNCHRONOUSLY at config load, then exports `E2E_LANE`, `E2E_LANE_TOKEN`,
   `E2E_APP_URL`, `E2E_DASHBOARD_URL`, `E2E_FAKE_URL`, `PUBLIC_BASE_URL`, `FAKE_TWILIO_URL`
   (:77-91). The lane and token are re-exported into `webServer.env` (:190-198) so the
   session ADOPTS rather than re-reserves.

`e2e/README.md`:

- `### Lanes 1-16 - e2e lanes` (:445) with the port table (:447-452):
  App `9001 + L*100 + 0`, Dashboard `+10`, Fake-Twilio `+20`, Public base `+30`
  (lane 1 = 9101 / 9111 / 9121 / 9131).
- `### Lane 0 - dev only` (:439-443): ports `8080 / 5174 / 8889 / 5173`; "**No e2e run ever
  uses lane 0.**"
- `:454-460`: per-lane table prefix `hc-local-<L>-`, bucket `hc-local-media-<L>`, and its own
  DynamoDB Local DATABASE via access key `hclane<L>` (shared container, no `-sharedDb`) - CLI
  inspection needs THAT key.
- `### How a lane is picked` (:462-472): (1) `E2E_LANE`, (2) djb2 hash of
  `git rev-parse --absolute-git-dir` (per-worktree) -> lane `[1..16]`, (3) free-probe of the
  four ports.
- `:491-499` `e2e/.artifacts/lane.json` shape (`lane`, `launcherPid`, `ownerToken`,
  `accessKeyId`).
- Session commands: `:51` `e2e:reseed`, `:53` `e2e:stop`; root `package.json:41-46` maps
  `e2e`, `e2e:session`, `e2e:restart`, `e2e:reseed`, `e2e:stop`, `e2e:report`.
