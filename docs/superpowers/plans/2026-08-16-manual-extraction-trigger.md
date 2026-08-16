# Manual Extraction Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff user presses one action on a contact and the AI extraction layer runs over that contact's stored conversation history with no 30-day age floor, showing a running indicator that resolves to the run's real outcome.

**Architecture:** A press writes a sticky `manualRequested` flag plus a per-press `requestId` onto the conversation's existing due row and arms it for `now`. The worker's existing poll claims and runs it; the job keys two gate waivers off the flag. A new `ai_run.completed` event carries the run's outcome back to the waiting page over the existing SSE bridge. No new runner, no new process, no lease.

**Tech Stack:** TypeScript, Express, DynamoDB (single-table with sparse GSIs), Vitest, React 18, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md`

## Global Constraints

- **ASCII only** on every new or touched line in specs, plans, prompts, issues, labels, comments, seed strings, and test names.
- **Never rewrite source with PowerShell pipelines** (`Get-Content | -replace | Set-Content`) - they mojibake BOM-less UTF-8. Use an edit tool.
- **Read bare `git status` before every commit**; stage explicit paths only, never `git add -A`.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **PII rule:** extraction code logs and emits ids and counts only - never message bodies, phone numbers, or field values.
- **Gates before handback:** `npm run typecheck`, `npm test`, `npm run e2e`, each run bare from the feature worktree. Never pipe a gate command.
- **Vendor SDK imports live in `app/src/adapters`** - services, jobs, and repos depend on interfaces.
- **All job traffic goes through `jobs.enqueue()` / `defineJobHandler()`** - not applicable to this feature (it uses the existing poll), but do not introduce a new path.
- **New user-facing automated copy goes through the message catalog.** UI strings rendered in the dashboard are not catalog items; SMS/email copy is. This feature adds no outbound copy.
- Worktree: `W:\tmp\manual-extraction-trigger`, branch `feat/manual-extraction-trigger`. Run everything from there.

---

## File Structure

**Backend - repo layer**
- `app/src/repos/extractionRepo.ts` - `DueExtractionItem` gains `manualRequested` and `requestId`; `channel` becomes optional. New `requestManualExtraction`. `claim` clears both new attributes. `fail` becomes conditional and gains two parameters.

**Backend - job layer**
- `app/src/jobs/extraction.ts` - derives `manual` from the row, waives two gates, threads `requestId` and two counts into the draft, emits the completion event.
- `app/src/services/extraction/runWindow.ts`, `runTypes.ts` - `maxTranscriptAgeDays` becomes nullable so the record does not misreport a waived floor.

**Backend - event layer**
- `app/src/lib/events.ts` - ninth event name, payload type, exhaustive map entry.
- `app/src/routes/api.ts` - SSE writer registration and cleanup.

**Backend - route layer**
- `app/src/routes/contacts.ts` - `POST /:contactId/extraction-run`.

**Backend - dev seam (hermetic only)**
- `app/src/routes/dev.ts` - a seam that plants a message with a caller-supplied `created_at`, so the e2e can exercise the age waiver at all.

**Dashboard**
- `dashboard/src/api/types.ts` - trigger union, nullable window param, new event payload.
- `dashboard/src/api/endpoints.ts` - the client call.
- `dashboard/src/api/EventStreamProvider.tsx` - dispatch the new event.
- `dashboard/src/routes/contact/ContactActionsMenu.tsx` - the menu item (presentational only).
- `dashboard/src/routes/contact/ContactDetail.tsx` - owns the request, the indicator state machine, and the status region.

**E2E**
- `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`

---

### Task 1: The due row carries a manual flag and a press id

**Files:**
- Modify: `app/src/repos/extractionRepo.ts`
- Test: `app/test/extractionRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `requestManualExtraction(conversationId: string, dueAt: string, requestId: string): Promise<void>` on `ExtractionRepo`; `DueExtractionItem.manualRequested?: true`; `DueExtractionItem.requestId?: string`; `DueExtractionItem.channel?: 'sms' | 'voice' | 'triage' | 'email'` (now optional).

- [ ] **Step 1: Write the failing tests**

Add to `app/test/extractionRepo.test.ts`:

```ts
describe('extractionRepo.requestManualExtraction', () => {
  it('arms the row with the manual flag and the request id, and never writes channel', async () => {
    const repo = createExtractionRepo(deps());
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T1);
    expect(item!._duePartition).toBe('due');
    expect(item!.manualRequested).toBe(true);
    expect(item!.requestId).toBe('req-abc');
    expect(item!.channel).toBeUndefined();
  });

  it('leaves an existing channel untouched when a press lands on a scheduled row', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    const item = await repo.getDue('conv-1');
    expect(item!.channel).toBe('sms');
    expect(item!.manualRequested).toBe(true);
    expect(item!.dueAt).toBe(T2);
  });

  it('scheduleExtraction never sets the manual flag or a request id', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
    expect(item!.requestId).toBeUndefined();
  });

  it('claim removes the flag and the request id with the index keys', async () => {
    const repo = createExtractionRepo(deps());
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    expect(await repo.claim('conv-1', T2, T1)).toBe(true);
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
    expect(item!.requestId).toBeUndefined();
    expect(item!._duePartition).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: FAIL - `repo.requestManualExtraction is not a function`.

- [ ] **Step 3: Widen the item type**

In `app/src/repos/extractionRepo.ts`, in `DueExtractionItem`, make `channel` optional and add the two attributes. Replace the existing `channel` declaration and its comment:

```ts
  /** What scheduled the run through an INBOUND path: an inbound text (sms), an
   *  inbound email (email), a fresh call transcript (voice), or a human triage
   *  flip to tenant (triage). voice/triage runs bypass the job's
   *  client-freshness gate. OPTIONAL because a manual press can create a row
   *  that has never been scheduled by any inbound path - see
   *  requestManualExtraction, which deliberately does not write it. */
  channel?: 'sms' | 'voice' | 'triage' | 'email';
  /** Sticky manual marker (sparse). Set by requestManualExtraction, REMOVEd by
   *  claim. The single source of truth for the job's gate waivers and the
   *  recorded trigger - an inbound sliding dueAt forward cannot erase it. */
  manualRequested?: true;
  /** Correlates one press to the one run it produces (sparse). REMOVEd by claim
   *  alongside manualRequested, so it belongs to exactly one run. */
  requestId?: string;
```

- [ ] **Step 4: Add the interface method**

In the `ExtractionRepo` interface, directly after `scheduleExtraction`:

```ts
  /**
   * Arm a row for an IMMEDIATE manual run. Same sliding upsert as
   * scheduleExtraction - SET dueAt / _duePartition / conversationId /
   * updatedAt, createdAt via if_not_exists - plus manualRequested and the
   * caller's requestId, and deliberately WITHOUT touching `channel`.
   *
   * Not writing `channel` is load-bearing: `channel` has no clearing site, so
   * a 'manual' value stored there would outlive the flag and could later label
   * an automatic run as manual in the run log.
   */
  requestManualExtraction(conversationId: string, dueAt: string, requestId: string): Promise<void>;
```

- [ ] **Step 5: Implement the method**

In the factory, directly after `scheduleExtraction`:

```ts
    async requestManualExtraction(conversationId, dueAt, requestId) {
      const now = new Date().toISOString();
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { itemId: dueId(conversationId) },
          UpdateExpression:
            'SET #dueAt = :dueAt, #dp = :dp, #manual = :manual, #requestId = :requestId, #conversationId = :conversationId, #updatedAt = :updatedAt, #createdAt = if_not_exists(#createdAt, :now)',
          ExpressionAttributeNames: {
            '#dueAt': 'dueAt',
            '#dp': '_duePartition',
            '#manual': 'manualRequested',
            '#requestId': 'requestId',
            '#conversationId': 'conversationId',
            '#updatedAt': 'updatedAt',
            '#createdAt': 'createdAt',
          },
          ExpressionAttributeValues: {
            ':dueAt': dueAt,
            ':dp': 'due',
            ':manual': true,
            ':requestId': requestId,
            ':conversationId': conversationId,
            ':updatedAt': now,
            ':now': now,
          },
        }),
      );
      log.debug({ conversationId, requestId }, 'manual extraction requested');
    },
```

- [ ] **Step 6: Clear both attributes on claim**

In `claim`, extend the REMOVE clause and the name map:

```ts
            UpdateExpression: 'SET #claimedAt = :claimedAt REMOVE #dp, #dueAt, #manual, #requestId',
```

and add to `ExpressionAttributeNames`:

```ts
              '#manual': 'manualRequested',
              '#requestId': 'requestId',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: PASS.

- [ ] **Step 8: Run typecheck to find every full repo literal**

Run: `npm run typecheck`
Expected: FAIL, listing every object literal that implements `ExtractionRepo` in full and now lacks `requestManualExtraction`. Known sites: `app/test/helpers/twilioWebhookHarness.ts:2886`, `app/test/extractionJob.test.ts:164`, `app/test/extractionJobDraftGuard.test.ts:108`, `app/test/twilioSmsWebhook.test.ts:1135`. Treat typecheck as the enumerator of record - the list may be incomplete. Add a stub to each:

```ts
    async requestManualExtraction() {},
```

except in `twilioWebhookHarness.ts`, where the fake maintains real state - mirror its `scheduleExtraction` implementation, setting `manualRequested: true` and the `requestId` and leaving `channel` alone.

- [ ] **Step 9: Run typecheck and tests**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm test`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git status
git add app/src/repos/extractionRepo.ts app/test/extractionRepo.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/extractionJob.test.ts app/test/extractionJobDraftGuard.test.ts app/test/twilioSmsWebhook.test.ts
git commit -m "feat(extraction): arm a due row manually with a sticky flag and a press id

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `fail` stops destroying a re-arm that landed during the run

**Files:**
- Modify: `app/src/repos/extractionRepo.ts`
- Modify: `app/src/jobs/extraction.ts:654-668` (the single production caller)
- Test: `app/test/extractionRepo.test.ts`

**Interfaces:**
- Consumes: Task 1's `DueExtractionItem` shape.
- Produces: `fail(conversationId: string, error: string, nextDueAt: string | null, opts: { listedDueAt?: string; manual: boolean }): Promise<void>`.

**Why:** `fail` writes `dueAt` unconditionally today. The re-arm branch SETs it to `now + backoff`; the park branch REMOVEs it with `_duePartition`. Either destroys a press or an inbound that landed while the run was failing - the park branch permanently, since the row leaves the due index with nothing left to re-arm it.

- [ ] **Step 1: Write the failing tests - all four quadrants**

Add to `app/test/extractionRepo.test.ts`:

```ts
describe('extractionRepo.fail - re-arm survival', () => {
  it('claimed, nobody re-armed: backs off normally', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', T3, { listedDueAt: T1, manual: false });
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T3);
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toBe('boom');
  });

  it('claimed, a press re-armed: the press survives and the error is still recorded', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    await repo.fail('conv-1', 'boom', T3, { listedDueAt: T1, manual: false });
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2);
    expect(item!.manualRequested).toBe(true);
    expect(item!.requestId).toBe('req-abc');
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toBe('boom');
  });

  it('claimed, a press re-armed, and the run PARKS: the press is not deleted', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    await repo.fail('conv-1', 'boom', null, { listedDueAt: T1, manual: false });
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2);
    expect(item!._duePartition).toBe('due');
    expect(item!.attempts).toBe(1);
  });

  it('claim THREW so the row is still armed at the listed dueAt: backs off and can park', async () => {
    const repo = createExtractionRepo(deps());
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.fail('conv-1', 'boom', T3, { listedDueAt: T1, manual: false });
    const armed = await repo.getDue('conv-1');
    expect(armed!.dueAt).toBe(T3);
    await repo.fail('conv-1', 'boom', null, { listedDueAt: T3, manual: false });
    const parked = await repo.getDue('conv-1');
    expect(parked!._duePartition).toBeUndefined();
    expect(parked!.dueAt).toBeUndefined();
  });

  it('a manual run re-arms WITH the flag; an automatic one does not', async () => {
    const repo = createExtractionRepo(deps());
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', T3, { listedDueAt: T1, manual: true });
    expect((await repo.getDue('conv-1'))!.manualRequested).toBe(true);

    await repo.scheduleExtraction('conv-2', 'sms', T1);
    await repo.claim('conv-2', T2, T1);
    await repo.fail('conv-2', 'boom', T3, { listedDueAt: T1, manual: false });
    expect((await repo.getDue('conv-2'))!.manualRequested).toBeUndefined();
  });

  it('parking REMOVEs the manual flag so a later automatic run does not inherit it', async () => {
    const repo = createExtractionRepo(deps());
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', null, { listedDueAt: T1, manual: true });
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: FAIL - `fail` takes three arguments, and the re-arm-survival cases clobber `dueAt`.

- [ ] **Step 3: Change the interface signature**

In `ExtractionRepo`, replace the `fail` declaration:

```ts
  /**
   * Record a failed run. `nextDueAt` non-null re-arms with backoff; null parks.
   *
   * BOTH branches are CONDITIONAL on nobody having re-armed the row since the
   * run was listed. Unconditional writes destroyed a press or an inbound that
   * landed during the failing run - the park branch permanently, since the row
   * then leaves the due index with nothing left to re-arm it.
   *
   * The condition is `attribute_not_exists(_duePartition) OR dueAt = listedDueAt`.
   * The first disjunct is the normal post-claim state. The second covers a
   * THROWN claim, where the row was never un-armed: without it, fail would
   * always take the fallback branch, never back off, never park, and the poll
   * would retry the row every interval forever.
   *
   * When the condition fails, a second scheduling-free update records only
   * lastError and attempts, leaving the fresh dueAt and manual marker alone.
   *
   * `opts.manual` re-sets manualRequested on a re-arm so backoff retries of a
   * manual run stay manual; the park branch REMOVEs it either way.
   */
  fail(
    conversationId: string,
    error: string,
    nextDueAt: string | null,
    opts: { listedDueAt?: string; manual: boolean },
  ): Promise<void>;
```

- [ ] **Step 4: Implement it**

Replace the whole `async fail(...)` body in the factory:

```ts
    async fail(conversationId, error, nextDueAt, opts) {
      const common = { TableName: table, Key: { itemId: dueId(conversationId) } };
      // `listedDueAt` is optional because the job's call site reads it from an
      // optional field; when it is absent we cannot prove the row was not
      // re-armed, so we keep today's unconditional behavior rather than
      // silently skipping the backoff.
      const condition = opts.listedDueAt === undefined
        ? undefined
        : 'attribute_not_exists(#dp) OR #dueAt = :listedDueAt';

      const attempt = async (): Promise<void> => {
        if (nextDueAt !== null) {
          await doc.send(new UpdateCommand({
            ...common,
            UpdateExpression: opts.manual
              ? 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp, #manual = :manual ADD #attempts :one'
              : 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp ADD #attempts :one',
            ...(condition !== undefined && { ConditionExpression: condition }),
            ExpressionAttributeNames: {
              '#lastError': 'lastError',
              '#dueAt': 'dueAt',
              '#dp': '_duePartition',
              '#attempts': 'attempts',
              ...(opts.manual && { '#manual': 'manualRequested' }),
            },
            ExpressionAttributeValues: {
              ':error': error,
              ':dueAt': nextDueAt,
              ':dp': 'due',
              ':one': 1,
              ...(opts.manual && { ':manual': true }),
              ...(opts.listedDueAt !== undefined && { ':listedDueAt': opts.listedDueAt }),
            },
          }));
          log.debug({ conversationId, nextDueAt }, 'extraction failed - re-armed');
          return;
        }
        await doc.send(new UpdateCommand({
          ...common,
          UpdateExpression: 'SET #lastError = :error REMOVE #dp, #dueAt, #manual ADD #attempts :one',
          ...(condition !== undefined && { ConditionExpression: condition }),
          ExpressionAttributeNames: {
            '#lastError': 'lastError',
            '#dp': '_duePartition',
            '#dueAt': 'dueAt',
            '#manual': 'manualRequested',
            '#attempts': 'attempts',
          },
          ExpressionAttributeValues: {
            ':error': error,
            ':one': 1,
            ...(opts.listedDueAt !== undefined && { ':listedDueAt': opts.listedDueAt }),
          },
        }));
        log.warn({ conversationId }, 'extraction failed - parked (max attempts)');
      };

      try {
        await attempt();
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Somebody re-armed the row while this run was failing. Record the
        // error and the attempt ONLY; their dueAt and manual marker stand.
        await doc.send(new UpdateCommand({
          ...common,
          UpdateExpression: 'SET #lastError = :error ADD #attempts :one',
          ExpressionAttributeNames: { '#lastError': 'lastError', '#attempts': 'attempts' },
          ExpressionAttributeValues: { ':error': error, ':one': 1 },
        }));
        log.debug({ conversationId }, 'extraction failed - row re-armed by someone else, schedule left alone');
      }
    },
```

- [ ] **Step 5: Update the one production call site**

In `app/src/jobs/extraction.ts`, in `runDueExtractions`, replace the `repo.fail(...)` call. Note `row.dueAt` is optional on `DueExtractionItem` and `processRow`'s guard does not reach here:

```ts
      try {
        await repo.fail(row.conversationId, draft.error?.message ?? 'unknown', nextDueAt, {
          ...(row.dueAt !== undefined && { listedDueAt: row.dueAt }),
          manual: row.manualRequested === true,
        });
      } catch (failErr) {
```

- [ ] **Step 6: Run the tests**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit 0 (fake repos take `fail` via `Pick` or implement it; fix any full literal the compiler names).

- [ ] **Step 7: Commit**

```bash
git status
git add app/src/repos/extractionRepo.ts app/src/jobs/extraction.ts app/test/extractionRepo.test.ts
git commit -m "fix(extraction): stop fail() destroying a re-arm that landed during the run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The job waives both gates for a manual run

**Files:**
- Modify: `app/src/jobs/extraction.ts`
- Modify: `app/src/services/extraction/runTypes.ts`
- Modify: `app/src/services/extraction/runWindow.ts`
- Modify: `app/src/repos/aiRunsRepo.ts:23`
- Test: `app/test/extractionJob.test.ts`

**Interfaces:**
- Consumes: `DueExtractionItem.manualRequested`, `.requestId` (Task 1).
- Produces: `RunTrigger` includes `'manual'`; `RunDraft.requestId?: string`; `RunDraft.wrote?: number`; `RunDraft.suggested?: number`; `RunWindowParams.maxTranscriptAgeDays: number | null`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/extractionJob.test.ts`:

```ts
describe('manual runs waive both gates', () => {
  it('reaches the driver when every message predates the 30-day cutoff', async () => {
    const world = makeWorld();
    world.seedConversationWithAgedMessages('conv-1'); // all created_at 90 days old
    world.seedDueRow('conv-1', { manualRequested: true, requestId: 'req-abc' });
    await runDueExtractions(NOW, world.deps);
    expect(world.driver.extract).toHaveBeenCalledTimes(1);
  });

  it('the SAME fixture without the flag skips no_new_client, not empty_window', async () => {
    const world = makeWorld();
    world.seedConversationWithAgedMessages('conv-1');
    world.seedDueRow('conv-1', { channel: 'sms' });
    await runDueExtractions(NOW, world.deps);
    expect(world.driver.extract).not.toHaveBeenCalled();
    expect(world.aiRuns.putRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', skipReason: 'no_new_client' }),
    );
  });

  it('waives no_new_client when the cursor is already past every message', async () => {
    const world = makeWorld();
    world.seedConversationWithFreshMessages('conv-1');
    world.seedDueRow('conv-1', { manualRequested: true, cursor: LATEST_TS_MSG_ID });
    await runDueExtractions(NOW, world.deps);
    expect(world.driver.extract).toHaveBeenCalledTimes(1);
  });

  it('records trigger manual from the flag, and the requestId', async () => {
    const world = makeWorld();
    world.seedConversationWithFreshMessages('conv-1');
    world.seedDueRow('conv-1', { channel: 'sms', manualRequested: true, requestId: 'req-abc' });
    await runDueExtractions(NOW, world.deps);
    expect(world.aiRuns.putRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual' }),
    );
  });

  it('records a defined trigger for a row with no channel at all', async () => {
    const world = makeWorld();
    world.seedConversationWithFreshMessages('conv-1');
    world.seedDueRow('conv-1', { manualRequested: true });
    await runDueExtractions(NOW, world.deps);
    expect(world.aiRuns.putRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual' }),
    );
  });

  it('windowParams.maxTranscriptAgeDays is null on a manual run and 30 otherwise', async () => {
    const manual = makeWorld();
    manual.seedConversationWithFreshMessages('conv-1');
    manual.seedDueRow('conv-1', { manualRequested: true });
    await runDueExtractions(NOW, manual.deps);
    expect(manual.aiRuns.putRun.mock.calls[0][0].window.windowParams.maxTranscriptAgeDays).toBeNull();

    const auto = makeWorld();
    auto.seedConversationWithFreshMessages('conv-1');
    auto.seedDueRow('conv-1', { channel: 'sms' });
    await runDueExtractions(NOW, auto.deps);
    expect(auto.aiRuns.putRun.mock.calls[0][0].window.windowParams.maxTranscriptAgeDays).toBe(30);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionJob.test.ts`
Expected: FAIL - the driver is not called for aged messages.

- [ ] **Step 3: Widen `RunTrigger`**

`app/src/repos/aiRunsRepo.ts:23`:

```ts
export type RunTrigger = 'sms' | 'voice' | 'triage' | 'email' | 'manual';
```

- [ ] **Step 4: Make the recorded age floor nullable**

`app/src/services/extraction/runTypes.ts`, in `RunWindowParams`:

```ts
  /** null when the run waived the age floor (a manual run). A number is the
   *  floor that was actually applied. Legacy records always carry a number. */
  maxTranscriptAgeDays: number | null;
```

`app/src/services/extraction/runWindow.ts` - add `maxTranscriptAgeDays` to `BuildFullRunWindowInput` and use it instead of the imported constant:

```ts
export interface BuildFullRunWindowInput extends Omit<BuildLightRunWindowInput, 'messages'> {
  perMessage: WindowMessagePieces[];
  included: Set<string>;
  hasInferredRoleContent: boolean;
  /** The floor this run actually applied; null when waived. */
  maxTranscriptAgeDays: number | null;
}
```

and in `buildFullRunWindow`'s `windowParams`:

```ts
      maxTranscriptAgeDays: input.maxTranscriptAgeDays,
```

- [ ] **Step 5: Derive `manual` and waive the two gates**

In `app/src/jobs/extraction.ts`, in `processRow`, immediately after `const cursor = row.cursor ?? '';`:

```ts
  // The single source of truth for both waivers and the recorded trigger. Read
  // from the row listDue returned, which is BEFORE claim clears it.
  const manual = row.manualRequested === true;
```

Replace the cutoff block (currently lines 433-436) so a manual run keeps every fetched message:

```ts
  const cutoff = new Date(Date.parse(nowIso) - MAX_TRANSCRIPT_AGE_DAYS * DAY_MS).toISOString();
  const chronological = [...newestFirst].reverse();
  // A manual run waives the age floor: the imported history this feature exists
  // to reach is historical by definition. The newest-50 page and the 60k char
  // budget still bound the window.
  const fresh = manual ? chronological : chronological.filter((m) => m.created_at >= cutoff);
  const agedOutTsMsgIds = manual
    ? []
    : chronological.filter((m) => m.created_at < cutoff).map((m) => m.tsMsgId);
```

Replace the `hasNewClient` expression so manual joins the existing bypasses:

```ts
  const hasNewClient = manual || row.channel === 'voice' || row.channel === 'triage' || fresh.some(
```

- [ ] **Step 6: Pass the effective floor to the window builder**

In the `buildFullRunWindow` call:

```ts
  const fullWindow = draftPiece(logger, draft, () => buildFullRunWindow({
    cursor, fetchedCount, agedOutTsMsgIds, perMessage, included, hasInferredRoleContent,
    maxTranscriptAgeDays: manual ? null : MAX_TRANSCRIPT_AGE_DAYS,
    ...(newestTsMsgId !== undefined && { newestTsMsgId }),
  }));
```

- [ ] **Step 7: Carry the trigger, the press id and the counts on the draft**

In `RunDraft`, add:

```ts
  /** Correlates this run to the press that asked for it (4.4b). */
  requestId?: string;
  /** Counts for the completion event. Sourced from applyOutcome, which is where
   *  they exist - NOT re-derived from `decisions`, which is best-effort. */
  wrote?: number;
  suggested?: number;
```

Replace `newRunDraft`:

```ts
export function newRunDraft(row: DueExtractionItem, startedAt: string): RunDraft {
  const manual = row.manualRequested === true;
  // The `?? 'manual'` arm is a totality device, not a second labelling rule.
  // A row with no `channel` can only have been created by
  // requestManualExtraction, which always sets the flag - and both flag-clearing
  // sites (claim, fail's park branch) also de-arm the row, so listDue can never
  // return a channel-less row without the flag.
  const trigger: RunTrigger = manual ? 'manual' : (row.channel ?? 'manual');
  return {
    runId: randomUUID(),
    startedAt,
    conversationId: row.conversationId,
    trigger,
    ...(row.requestId !== undefined && { requestId: row.requestId }),
    displaced: [],
  };
}
```

Where `draft.notedLines` is set after `applyExtraction`, add the two counts:

```ts
  draft.notedLines = applyOutcome.notedLines;
  draft.wrote = applyOutcome.wrote.length;
  draft.suggested = applyOutcome.suggested.length;
```

- [ ] **Step 8: Run the tests**

Run: `npm test --workspace app -- extractionJob.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git status
git add app/src/jobs/extraction.ts app/src/services/extraction/runTypes.ts app/src/services/extraction/runWindow.ts app/src/repos/aiRunsRepo.ts app/test/extractionJob.test.ts
git commit -m "feat(extraction): waive the age and freshness gates for a manual run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ai_run.completed` reaches the page

**Files:**
- Modify: `app/src/lib/events.ts`
- Modify: `app/test/eventBridge.test.ts:43`
- Modify: `app/src/jobs/extraction.ts`
- Modify: `app/src/worker.ts` (extraction deps)
- Modify: `app/src/routes/dev.ts` (extraction tick deps)
- Modify: `app/src/routes/api.ts` (SSE on/off)
- Test: `app/test/extractionJob.test.ts`

**Interfaces:**
- Consumes: `RunDraft.requestId`, `.wrote`, `.suggested` (Task 3).
- Produces: event name `'ai_run.completed'` with payload `AiRunCompletedEvent`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/extractionJob.test.ts`:

```ts
describe('ai_run.completed', () => {
  it.each(['applied', 'no_op', 'skipped', 'failed'] as const)(
    'emits once for a %s run', async (outcome) => {
      const world = makeWorld();
      world.arrangeOutcome(outcome, 'conv-1');
      await runDueExtractions(NOW, world.deps);
      const emits = world.emitted.filter((e) => e.event === 'ai_run.completed');
      expect(emits).toHaveLength(1);
      expect(emits[0].payload.outcome).toBe(outcome);
    });

  it('still emits when the run-log write fails', async () => {
    const world = makeWorld();
    world.aiRuns.putRun.mockRejectedValue(new Error('dynamo down'));
    world.arrangeOutcome('applied', 'conv-1');
    await runDueExtractions(NOW, world.deps);
    expect(world.emitted.filter((e) => e.event === 'ai_run.completed')).toHaveLength(1);
  });

  it('carries the requestId of the press that started it, and none for an automatic run', async () => {
    const manual = makeWorld();
    manual.arrangeOutcome('applied', 'conv-1', { manualRequested: true, requestId: 'req-abc' });
    await runDueExtractions(NOW, manual.deps);
    expect(manual.emitted.find((e) => e.event === 'ai_run.completed')!.payload.requestId).toBe('req-abc');

    const auto = makeWorld();
    auto.arrangeOutcome('applied', 'conv-1', { channel: 'sms' });
    await runDueExtractions(NOW, auto.deps);
    expect(auto.emitted.find((e) => e.event === 'ai_run.completed')!.payload.requestId).toBeUndefined();
  });

  it('a no_contact run emits with conversationId and no contactId', async () => {
    const world = makeWorld();
    world.arrangeNoContact('conv-1');
    await runDueExtractions(NOW, world.deps);
    const payload = world.emitted.find((e) => e.event === 'ai_run.completed')!.payload;
    expect(payload.conversationId).toBe('conv-1');
    expect(payload.contactId).toBeUndefined();
  });

  it('carries ids and counts only - never a body, phone or field value', async () => {
    const world = makeWorld();
    world.arrangeOutcome('applied', 'conv-1');
    await runDueExtractions(NOW, world.deps);
    const serialized = JSON.stringify(world.emitted.find((e) => e.event === 'ai_run.completed')!.payload);
    expect(serialized).not.toContain(world.secretBody);
    expect(serialized).not.toContain(world.contactPhone);
    expect(serialized).not.toContain(world.suggestedValue);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionJob.test.ts`
Expected: FAIL - no such event.

- [ ] **Step 3: Add the event to the bus**

`app/src/lib/events.ts`, beside `SuggestionUpdatedEvent`:

```ts
/**
 * One extraction run finished (manual-extraction-trigger 4.4b). Emitted by the
 * job for EVERY run - applied, no_op, skipped and failed - because the skip and
 * failure cases are exactly what the contact page's running indicator has to
 * explain. `requestId` is present only when a human press started this run and
 * is what correlates that press to THIS run; conversationId identifies the
 * thread, not the run, so it cannot do that job on its own.
 *
 * PII: ids and counts only. Never a body, a phone number, or a field value.
 */
export interface AiRunCompletedEvent {
  conversationId: string;
  runId: string;
  requestId?: string;
  contactId?: string;
  outcome: 'applied' | 'no_op' | 'skipped' | 'failed';
  skipReason?: string;
  errorKind?: string;
  wrote: number;
  suggested: number;
  notedLines: number;
}
```

Add to `AppEventMap`:

```ts
  'ai_run.completed': AiRunCompletedEvent;
```

Add to `ALL_APP_EVENTS`:

```ts
  'ai_run.completed': true,
```

- [ ] **Step 4: Update the hardcoded bridge count**

`app/test/eventBridge.test.ts:43` - the typecheck cannot see this, only the test run can:

```ts
    expect(APP_EVENT_NAMES).toHaveLength(9);
```

- [ ] **Step 5: Add a REQUIRED emitter to the job deps**

`app/src/jobs/extraction.ts`, in `ExtractionJobDeps`:

```ts
  /**
   * The completion emitter. REQUIRED so a missed construction site is a
   * typecheck failure rather than a silently dead indicator - the same reasoning
   * as `aiRuns` above. All three sites must supply it: worker.ts (the poll),
   * routes/dev.ts (the deterministic tick), and the unit-test harness.
   */
  events: Pick<EventBus, 'emit'>;
```

Import the type at the top: `import type { EventBus } from '../lib/events.js';`

- [ ] **Step 6: Emit after `recordRun`**

In `runDueExtractions`, directly after `await recordRun(deps, outcome, draft);`:

```ts
    // AFTER recordRun but NOT dependent on it: recordRun is best-effort and
    // swallows its own failures, and the indicator's correctness must not hinge
    // on an observability write.
    try {
      deps.events.emit('ai_run.completed', {
        conversationId: draft.conversationId,
        runId: draft.runId,
        ...(draft.requestId !== undefined && { requestId: draft.requestId }),
        ...(draft.contactId !== undefined && { contactId: draft.contactId }),
        outcome,
        ...(draft.skipReason !== undefined && { skipReason: draft.skipReason }),
        ...(draft.error !== undefined && { errorKind: draft.error.kind }),
        wrote: draft.wrote ?? 0,
        suggested: draft.suggested ?? 0,
        notedLines: draft.notedLines ?? 0,
      });
    } catch (err) {
      deps.logger.warn({ conversationId: draft.conversationId, err }, 'ai run completed emit failed');
    }
```

- [ ] **Step 7: Supply it at all three construction sites**

`app/src/worker.ts` - the extraction deps object already has `appEvents` in scope (the placement-nudge deps use it); add:

```ts
    events: appEvents,
```

`app/src/routes/dev.ts` - in the lazily-built `extractionTickDeps`, add:

```ts
        events,
```

using the same `events` the router already receives. If the dev router does not already destructure it, take it from `deps`.

The unit-test harness gains a recording emitter:

```ts
    events: { emit: (event, payload) => { world.emitted.push({ event, payload }); } },
```

- [ ] **Step 8: Write and clean up the SSE listener**

`app/src/routes/api.ts` - beside `onSuggestionUpdated`:

```ts
    const onAiRunCompleted = (payload: AiRunCompletedEvent): void => {
      writeEvent('ai_run.completed', payload);
    };
```

Register it with the others:

```ts
    events.on('ai_run.completed', onAiRunCompleted);
```

And - this half is easy to forget and leaks a listener per connection - in the disconnect cleanup:

```ts
      events.off('ai_run.completed', onAiRunCompleted);
```

Import `AiRunCompletedEvent` alongside the other event types.

- [ ] **Step 9: Run the tests**

Run: `npm test --workspace app`
Expected: PASS, including `eventBridge.test.ts`.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git status
git add app/src/lib/events.ts app/test/eventBridge.test.ts app/src/jobs/extraction.ts app/src/worker.ts app/src/routes/dev.ts app/src/routes/api.ts app/test/extractionJob.test.ts
git commit -m "feat(extraction): emit ai_run.completed for every run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/contacts/:contactId/extraction-run`

**Files:**
- Modify: `app/src/routes/contacts.ts`
- Test: `app/test/contactsExtractionRun.test.ts` (create)

**Interfaces:**
- Consumes: `requestManualExtraction` (Task 1), `conversationsForContact` (`app/src/lib/contactThreads.ts:38`).
- Produces: `200 { requestId: string, scheduled: string[], failed: string[] }`, or a refusal `{ error: string }`.

- [ ] **Step 1: Write the failing tests**

Create `app/test/contactsExtractionRun.test.ts`:

```ts
describe('POST /api/contacts/:contactId/extraction-run', () => {
  it('schedules every eligible 1:1 thread and returns their ids', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-sms', 'tenant_1to1');
    world.seedThread('c-1', 'conv-email', 'unknown_1to1');
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(200);
    expect(res.body.scheduled.sort()).toEqual(['conv-email', 'conv-sms']);
    expect(res.body.failed).toEqual([]);
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(world.extraction.requestManualExtraction).toHaveBeenCalledTimes(2);
  });

  it('EXCLUDES relay_group and landlord_1to1 threads', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-ok', 'tenant_1to1');
    world.seedThread('c-1', 'conv-relay', 'relay_group');
    world.seedThread('c-1', 'conv-ll', 'landlord_1to1');
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.body.scheduled).toEqual(['conv-ok']);
  });

  it('is a 200 with a partial list when one write fails, never a 500', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    world.seedThread('c-1', 'conv-b', 'tenant_1to1');
    world.extraction.requestManualExtraction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('dynamo down'));
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toEqual(['conv-a']);
    expect(res.body.failed).toEqual(['conv-b']);
  });

  it('is a 500 only when NOTHING was scheduled', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    world.extraction.requestManualExtraction.mockRejectedValue(new Error('dynamo down'));
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('schedule_failed');
  });

  it.each([
    ['unknown contact', 'nope', 404, 'contact_not_found'],
    ['phone-pointer id', 'phone#+15550100001', 404, 'contact_not_found'],
  ])('refuses %s', async (_label, id, status, error) => {
    const world = makeContactsWorld();
    const res = await world.post(`/api/contacts/${encodeURIComponent(id)}/extraction-run`);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(error);
  });

  it('refuses a soft-deleted contact', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant', deleted_at: '2026-08-01T00:00:00.000Z' });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_deleted');
  });

  it('refuses when the kill switch is off', async () => {
    const world = makeContactsWorld({ aiExtractionEnabled: false });
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('extraction_disabled');
  });

  it.each(['landlord', 'partner', 'team_member'] as const)('refuses a %s contact', async (type) => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    const res = await world.post('/api/contacts/c-1/extraction-run');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ineligible_contact_type');
  });

  it('distinguishes no threads at all from no ELIGIBLE threads', async () => {
    const none = makeContactsWorld();
    none.seedContact('c-1', { type: 'tenant' });
    expect((await none.post('/api/contacts/c-1/extraction-run')).body.error).toBe('no_conversations');

    const filtered = makeContactsWorld();
    filtered.seedContact('c-2', { type: 'tenant' });
    filtered.seedThread('c-2', 'conv-relay', 'relay_group');
    expect((await filtered.post('/api/contacts/c-2/extraction-run')).body.error)
      .toBe('no_eligible_conversations');
  });

  it('appends an audit entry with the counts', async () => {
    const world = makeContactsWorld();
    world.seedContact('c-1', { type: 'tenant' });
    world.seedThread('c-1', 'conv-a', 'tenant_1to1');
    await world.post('/api/contacts/c-1/extraction-run');
    expect(world.audit.append).toHaveBeenCalledWith(
      'contacts#c-1',
      'extraction_run_requested',
      expect.objectContaining({ scheduled: 1, failed: 0, requestId: expect.any(String) }),
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- contactsExtractionRun.test.ts`
Expected: FAIL - 404 on an unregistered route.

- [ ] **Step 3: Implement the route**

In `app/src/routes/contacts.ts`, alongside the other per-contact actions. `randomUUID` is already imported in this file's dependencies; if not, import it from `node:crypto`:

```ts
  // Manual extraction trigger. Arms each of the contact's eligible 1:1 threads
  // for an IMMEDIATE run (dueAt = now, no debounce) and returns; the worker
  // poll does the work. See the design doc section 4.5.
  router.post('/:contactId/extraction-run', json(), async (req, res) => {
    const contactId = req.params.contactId;
    if (contactId.startsWith(PHONE_REF_PREFIX)) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    if (contact.deleted_at !== undefined) {
      // Deliberate divergence from the job, which has no soft-delete check:
      // spending money to write facts onto a record staff have removed from
      // view is not something to do on a human's button press.
      res.status(409).json({ error: 'contact_deleted' });
      return;
    }
    if (!aiExtractionEnabled) {
      res.status(409).json({ error: 'extraction_disabled' });
      return;
    }
    if (contact.type === 'landlord' || contact.type === 'partner' || contact.type === 'team_member') {
      res.status(409).json({ error: 'ineligible_contact_type' });
      return;
    }

    const all = await conversationsForContact(contact, conversations);
    if (all.length === 0) {
      res.status(409).json({ error: 'no_conversations' });
      return;
    }
    // The SAME predicate the inbound sites apply (webhooks/twilio.ts:2155-2158,
    // services/inboundEmail.ts:741-746). Mandatory here because this fans out
    // across a contact's threads: conversationsForContact returns the raw
    // phone+email union, and a phone query can return relay_group threads.
    const eligible = all.filter((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
    if (eligible.length === 0) {
      res.status(409).json({ error: 'no_eligible_conversations' });
      return;
    }

    const requestId = randomUUID();
    const nowIso = new Date().toISOString();
    const scheduled: string[] = [];
    const failed: string[] = [];
    for (const conv of eligible) {
      try {
        await extraction.requestManualExtraction(conv.conversationId, nowIso, requestId);
        scheduled.push(conv.conversationId);
      } catch (err) {
        // Partial failure is NOT a total one: a queued run will bill, so
        // reporting 500 here would tell the operator nothing happened when
        // something did.
        log.error({ err, contactId, conversationId: conv.conversationId }, 'manual extraction schedule failed');
        failed.push(conv.conversationId);
      }
    }
    if (scheduled.length === 0) {
      res.status(500).json({ error: 'schedule_failed' });
      return;
    }

    await audit.append(`contacts#${contactId}`, 'extraction_run_requested', {
      actor: req.user?.userId,
      requestId,
      scheduled: scheduled.length,
      failed: failed.length,
    });
    res.json({ requestId, scheduled, failed });
  });
```

- [ ] **Step 4: Run the tests**

Run: `npm test --workspace app -- contactsExtractionRun.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/contacts.ts app/test/contactsExtractionRun.test.ts
git commit -m "feat(contacts): add the manual extraction-run endpoint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The contact page action and its running indicator

**Files:**
- Modify: `dashboard/src/api/types.ts`
- Modify: `dashboard/src/api/endpoints.ts`
- Modify: `dashboard/src/api/EventStreamProvider.tsx:208`
- Modify: `dashboard/src/routes/contact/ContactActionsMenu.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx`
- Test: `dashboard/src/routes/contact/ContactDetail.test.tsx`

**Interfaces:**
- Consumes: the endpoint (Task 5), `ai_run.completed` (Task 4).
- Produces: `runExtraction(contactId: string): Promise<{ requestId: string; scheduled: string[]; failed: string[] }>`.

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/src/routes/contact/ContactDetail.test.tsx`:

```tsx
describe('Run AI extraction', () => {
  it('enters a running state on press and disables a second press', async () => {
    renderContact({ contactId: 'c-1' });
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /run ai extraction/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/running ai extraction/i);
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /run ai extraction/i })).toBeDisabled();
  });

  it('resolves to the applied copy when the run reports back', async () => {
    const { emit } = renderContact({ contactId: 'c-1' });
    await pressRunExtraction();
    emit('ai_run.completed', {
      conversationId: 'conv-a', runId: 'r1', requestId: lastRequestId(),
      outcome: 'applied', wrote: 2, suggested: 1, notedLines: 0,
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/updated 2 fields, 1 suggestion/i);
  });

  it('says nothing-new for a skipped run', async () => {
    const { emit } = renderContact({ contactId: 'c-1' });
    await pressRunExtraction();
    emit('ai_run.completed', {
      conversationId: 'conv-a', runId: 'r1', requestId: lastRequestId(),
      outcome: 'skipped', skipReason: 'no_new_client', wrote: 0, suggested: 0, notedLines: 0,
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/nothing new to extract/i);
  });

  it('gives a truncated failure its own actionable copy', async () => {
    const { emit } = renderContact({ contactId: 'c-1' });
    await pressRunExtraction();
    emit('ai_run.completed', {
      conversationId: 'conv-a', runId: 'r1', requestId: lastRequestId(),
      outcome: 'failed', errorKind: 'truncated', wrote: 0, suggested: 0, notedLines: 0,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/ran out of room/i);
  });

  it('waits for EVERY scheduled thread before resolving', async () => {
    const { emit } = renderContact({ contactId: 'c-1', scheduled: ['conv-a', 'conv-b'] });
    await pressRunExtraction();
    emit('ai_run.completed', { conversationId: 'conv-a', runId: 'r1', requestId: lastRequestId(), outcome: 'applied', wrote: 1, suggested: 0, notedLines: 0 });
    expect(screen.getByRole('status')).toHaveTextContent(/running ai extraction/i);
    emit('ai_run.completed', { conversationId: 'conv-b', runId: 'r2', requestId: lastRequestId(), outcome: 'applied', wrote: 1, suggested: 0, notedLines: 0 });
    expect(await screen.findByRole('status')).toHaveTextContent(/updated 2 fields/i);
  });

  it('IGNORES an event carrying a different requestId', async () => {
    const { emit } = renderContact({ contactId: 'c-1' });
    await pressRunExtraction();
    emit('ai_run.completed', {
      conversationId: 'conv-a', runId: 'r1', requestId: 'someone-elses-press',
      outcome: 'applied', wrote: 9, suggested: 9, notedLines: 0,
    });
    expect(screen.getByRole('status')).toHaveTextContent(/running ai extraction/i);
  });

  it('times out to the still-running copy when no event ever arrives', async () => {
    vi.useFakeTimers();
    renderContact({ contactId: 'c-1' });
    await pressRunExtraction();
    act(() => { vi.advanceTimersByTime(RUN_INDICATOR_TIMEOUT_MS + 1); });
    expect(screen.getByRole('status')).toHaveTextContent(/still running/i);
    vi.useRealTimers();
  });

  it('reports threads that could not be queued', async () => {
    renderContact({ contactId: 'c-1', scheduled: ['conv-a'], failed: ['conv-b'] });
    await pressRunExtraction();
    expect(screen.getByRole('status')).toHaveTextContent(/1 thread could not be queued/i);
  });

  it.each([
    ['extraction_disabled', /ai extraction is turned off/i],
    ['ineligible_contact_type', /only tenants and untriaged contacts/i],
    ['contact_deleted', /deleted contact/i],
    ['no_conversations', /no conversations/i],
    ['no_eligible_conversations', /no eligible conversations/i],
    ['schedule_failed', /could not be started/i],
  ])('renders its own copy for %s', async (error, copy) => {
    renderContact({ contactId: 'c-1', postError: { status: 409, body: { error } } });
    await pressRunExtraction();
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace dashboard -- ContactDetail.test.tsx`
Expected: FAIL - no such menu item.

- [ ] **Step 3: Add the types**

`dashboard/src/api/types.ts`:
- Widen `AiRunTrigger` with `'manual'`.
- Widen `windowParams.maxTranscriptAgeDays` to `number | null` (line 292).
- Add the event payload:

```ts
export interface AiRunCompletedEvent {
  conversationId: string;
  runId: string;
  requestId?: string;
  contactId?: string;
  outcome: 'applied' | 'no_op' | 'skipped' | 'failed';
  skipReason?: string;
  errorKind?: string;
  wrote: number;
  suggested: number;
  notedLines: number;
}
```

- [ ] **Step 4: Add the client call**

`dashboard/src/api/endpoints.ts`:

```ts
export async function runExtraction(
  contactId: string,
): Promise<{ requestId: string; scheduled: string[]; failed: string[] }> {
  return postJson(`/api/contacts/${encodeURIComponent(contactId)}/extraction-run`, {});
}
```

Follow the file's existing helper (`postJson` or equivalent) so errors surface as the shared `ApiError` with `status` and `body`.

- [ ] **Step 5: Dispatch the event**

`dashboard/src/api/EventStreamProvider.tsx`, beside the `suggestion.updated` listener at `:208`:

```tsx
      source.addEventListener('ai_run.completed', (ev) => {
        handlers.current.onAiRunCompleted?.(JSON.parse((ev as MessageEvent).data) as AiRunCompletedEvent);
      });
```

Add `onAiRunCompleted?: (e: AiRunCompletedEvent) => void` to the handler map type.

- [ ] **Step 6: Add the presentational menu item**

`ContactActionsMenu.tsx` - this component stays presentational; the parent owns the request:

```tsx
  /** Start a manual AI extraction run; the parent does the request. */
  onRunExtraction: () => void;
  /** True while a run requested from this page is in flight (disables the item). */
  extractionBusy?: boolean;
```

and in the menu body, following the existing item pattern:

```tsx
          <button type="button" role="menuitem" disabled={extractionBusy} onClick={onRunExtraction}>
            Run AI extraction
          </button>
```

- [ ] **Step 7: Own the state machine in `ContactDetail`**

Add near the other constants:

```tsx
/** How long the indicator waits before it stops claiming to know. Comfortably
 *  above the observed 5-40s (a 30s worker poll plus the run), because the poll
 *  can be delayed by a long-running row ahead of this one in the same pass. */
export const RUN_INDICATOR_TIMEOUT_MS = 180_000;
```

State and handler:

```tsx
  const [extraction, setExtraction] = useState<
    | { phase: 'idle' }
    | { phase: 'running'; requestId: string; pending: Set<string>; wrote: number; suggested: number; failed: number }
    | { phase: 'done'; tone: 'status' | 'alert'; message: string }
  >({ phase: 'idle' });

  const onRunExtraction = useCallback(async () => {
    try {
      const res = await runExtraction(contactId);
      setExtraction({
        phase: 'running',
        requestId: res.requestId,
        pending: new Set(res.scheduled),
        wrote: 0,
        suggested: 0,
        failed: res.failed.length,
      });
    } catch (err) {
      setExtraction({ phase: 'done', tone: 'alert', message: extractionRefusalCopy(err) });
    }
  }, [contactId]);
```

Resolution, keyed on `requestId` so an unrelated automatic run on the same thread cannot resolve it:

```tsx
  useEventStream({
    onAiRunCompleted: (e) => {
      setExtraction((prev) => {
        if (prev.phase !== 'running' || e.requestId !== prev.requestId) return prev;
        const pending = new Set(prev.pending);
        pending.delete(e.conversationId);
        const wrote = prev.wrote + e.wrote;
        const suggested = prev.suggested + e.suggested;
        if (e.outcome === 'failed') {
          return { phase: 'done', tone: 'alert', message: extractionFailureCopy(e.errorKind) };
        }
        if (pending.size > 0) return { ...prev, pending, wrote, suggested };
        return {
          phase: 'done',
          tone: 'status',
          message: wrote + suggested === 0
            ? 'Ran - nothing new to extract.'
            : `Updated ${wrote} fields, ${suggested} suggestion${suggested === 1 ? '' : 's'}.`,
        };
      });
    },
  });

  useEffect(() => {
    if (extraction.phase !== 'running') return undefined;
    const t = setTimeout(() => {
      setExtraction({
        phase: 'done',
        tone: 'status',
        message: 'Still running - check Settings > AI runs.',
      });
    }, RUN_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [extraction.phase]);
```

Copy helpers, beside the component:

```tsx
function extractionFailureCopy(errorKind?: string): string {
  return errorKind === 'truncated'
    ? 'Extraction ran out of room - the transcript may be too long.'
    : 'Extraction failed - see Settings > AI runs.';
}

function extractionRefusalCopy(err: unknown): string {
  const reason = err instanceof ApiError ? (err.body as { error?: string } | undefined)?.error : undefined;
  switch (reason) {
    case 'extraction_disabled': return 'AI extraction is turned off for this environment.';
    case 'ineligible_contact_type': return 'Only tenants and untriaged contacts can be extracted.';
    case 'contact_deleted': return 'This is a deleted contact.';
    case 'no_conversations': return 'This contact has no conversations to extract.';
    case 'no_eligible_conversations': return 'This contact has no eligible conversations to extract.';
    case 'schedule_failed': return 'Extraction could not be started - try again.';
    default: return 'Extraction could not be started - try again.';
  }
}
```

Render the region beside the existing `deletedBanner`, following that pattern. Success announces politely, failure announces assertively:

```tsx
        {extraction.phase === 'running' ? (
          <div className={styles.extractionBanner} role="status">
            {`Running AI extraction${extraction.pending.size > 1 ? ` on ${extraction.pending.size} threads` : ''}...`}
            {extraction.failed > 0
              ? ` ${extraction.failed} thread${extraction.failed === 1 ? '' : 's'} could not be queued.`
              : ''}
          </div>
        ) : null}
        {extraction.phase === 'done' ? (
          <div className={styles.extractionBanner} role={extraction.tone}>{extraction.message}</div>
        ) : null}
```

Pass `onRunExtraction` and `extractionBusy={extraction.phase === 'running'}` to `ContactActionsMenu`.

- [ ] **Step 8: Run the tests**

Run: `npm test --workspace dashboard -- ContactDetail.test.tsx`
Expected: PASS.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/EventStreamProvider.tsx dashboard/src/routes/contact/ContactActionsMenu.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.test.tsx
git commit -m "feat(contact): add the Run AI extraction action and its running indicator

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: A dev seam that can actually age a message, and the e2e

**Files:**
- Modify: `app/src/routes/dev.ts`
- Create: `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /__dev/extraction/message-fixture` taking `{ conversationId, body, createdAt, direction? }`.

**Why a seam rather than seed rows:** the lean world cannot exercise this feature as-is. Its message rows carry `ts` and `tsMsgId` but **no `created_at`** (`app/src/lib/seed/lean.ts:274-300`), and `created_at` is the field the cutoff reads (`app/src/jobs/extraction.ts:433-436`) - so the fixed `2026-06-01` timestamps are not aging anything. Separately the hermetic lane runs the fake driver, whose protocol is an `EXTRACT:` marker in a message body, which no lean message carries. Adding rows to lean would risk its byte stability; a hermetic-only seam mirrors `POST /__dev/voice/transcript-fixture` (`app/src/routes/dev.ts:759`) and is structurally absent in deployed environments.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { devLogin, planted, seedLean } from '../../support/steps.js';

const AGED = '2026-01-05T10:00:00.000Z'; // far outside any 30-day window

test('a manual run extracts aged history that an automatic run skips', async ({ page, request }) => {
  await seedLean(request);
  await devLogin(page);

  // An aged message the automatic window cannot see, carrying the fake
  // driver's EXTRACT: marker so the run produces a real suggestion.
  await request.post('/__dev/extraction/message-fixture', {
    data: {
      conversationId: planted.lean.tenantConversationId,
      body: 'I have two cats. EXTRACT: pets=Two cats',
      createdAt: AGED,
      direction: 'inbound',
    },
  });

  // NEGATIVE first: without a manual press, the aged message is outside the
  // window, so a tick produces no run that reaches the driver.
  await request.post('/__dev/extraction/tick');
  await page.goto(`/contacts/${planted.lean.tenantContactId}`);
  await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);

  // Press, tick, and the run reaches the model.
  await page.getByRole('button', { name: /more actions/i }).click();
  await page.getByRole('menuitem', { name: /run ai extraction/i }).click();
  await expect(page.getByRole('status')).toContainText(/running ai extraction/i);

  await request.post('/__dev/extraction/tick');

  // The chip arrives with no reload.
  await expect(page.getByText(/two cats/i)).toBeVisible({ timeout: 15_000 });

  // And the run is recorded as manual.
  await page.goto('/settings');
  await page.getByRole('tab', { name: /ai runs/i }).click();
  const row = page.getByRole('listitem').filter({ hasText: /manual/i }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(/skipped/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run e2e -- --grep "manual run extracts aged history"`
Expected: FAIL - 404 on `/__dev/extraction/message-fixture`.
Note: `npm run e2e -- --flag` does not forward flags through npm. Use the e2e workspace's own runner, or run the full suite.

- [ ] **Step 3: Implement the seam**

In `app/src/routes/dev.ts`, beside the transcript fixture:

```ts
  // POST /__dev/extraction/message-fixture - plant one message with an
  // ARBITRARY created_at. Hermetic-only, like every /__dev route: the lean seed
  // writes `ts` but no `created_at`, which is the field the extraction age
  // cutoff reads, so there is otherwise no way to exercise an aged window.
  router.post('/__dev/extraction/message-fixture', json(), async (req, res) => {
    const { conversationId, body, createdAt, direction } = req.body as {
      conversationId?: string; body?: string; createdAt?: string; direction?: 'inbound' | 'outbound';
    };
    if (!conversationId || !body || !createdAt) {
      res.status(400).json({ error: 'conversationId, body and createdAt are required' });
      return;
    }
    const messages = createMessagesRepo({ logger: log });
    const tsMsgId = `${createdAt}#dev-${randomUUID()}`;
    await messages.put({
      conversationId,
      tsMsgId,
      type: 'sms',
      direction: direction ?? 'inbound',
      author: direction === 'outbound' ? 'teammate' : 'tenant',
      body,
      created_at: createdAt,
    });
    log.info({ conversationId, tsMsgId }, 'dev message fixture planted');
    res.json({ tsMsgId });
  });
```

Match the repo's real `put` signature; if `createMessagesRepo` exposes a different write method, use that one and keep `created_at` explicit.

- [ ] **Step 4: Run the e2e**

Run: `npm run e2e`
Expected: exit 0, including the new spec.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/dev.ts e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts
git commit -m "test(extraction): prove a manual run reads aged history an automatic run skips

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: File the latent hazards and close out

**Files:**
- Create: `docs/issues/extraction-driver-call-unbounded.md`
- Create: `docs/issues/extraction-claimedat-stamped-from-poll-clock.md`
- Create: `docs/issues/extraction-stranded-claim-no-reaper.md`
- Create: `docs/issues/soft-deleted-contact-still-extractable.md`
- Create: `docs/issues/manual-extraction-bulk-backfill.md`

- [ ] **Step 1: Write each issue from `docs/issues/_TEMPLATE.md`**

Content for each is in the spec's section 9. Each must state: it is pre-existing, it is not created by this feature, and the evidence line. Specifically:

1. `extraction-driver-call-unbounded` - the Anthropic client is built with no `timeout` and no `maxRetries` (`app/src/adapters/extraction.ts:218`), inheriting a 10-minute timeout with 2 retries that themselves retry timeouts: roughly 30 minutes of wall clock holding a claim.
2. `extraction-claimedat-stamped-from-poll-clock` - `claim` writes `claimedAt: nowIso` (`app/src/repos/extractionRepo.ts:270`), the poll-wide timestamp, so a later row in a long pass records a claim time already minutes stale. Harmless only because nothing reads it for logic.
3. `extraction-stranded-claim-no-reaper` - a process dying mid-run leaves the row claimed, out of the due index, with nothing to re-arm it.
4. `soft-deleted-contact-still-extractable` - this feature refuses the press (4.5) but the job has no soft-delete check, so the automatic path still writes into a deleted contact.
5. `manual-extraction-bulk-backfill` - the deferred backfill over the imported population, including the constraint that makes it more than a loop: the newest-50 page and 60k budget mean a long imported history is never fully read, so a backfill needs its own windowing design.

- [ ] **Step 2: Regenerate the index**

Run: `npm run issues`
Expected: `docs/issues/INDEX.md` regenerated (gitignored - do not stage it).

- [ ] **Step 3: Sync main once, then run all three gates bare**

```bash
git fetch
git merge main --no-edit
npm run typecheck
npm test
npm run e2e
```

Expected: exit 0 from each. Record the exact codes for the handback. Honour the known flakes: re-run once before blaming this branch, and report both runs.

- [ ] **Step 4: Commit**

```bash
git status
git add docs/issues/extraction-driver-call-unbounded.md docs/issues/extraction-claimedat-stamped-from-poll-clock.md docs/issues/extraction-stranded-claim-no-reaper.md docs/issues/soft-deleted-contact-still-extractable.md docs/issues/manual-extraction-bulk-backfill.md
git commit -m "docs(issues): file the latent hazards found specifying the manual trigger

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
| --- | --- |
| 4.1 flag, `requestId`, lifecycle | 1, 2 |
| 4.1 conditional `fail` | 2 |
| 4.2 both gate waivers | 3 |
| 4.3 nullable recorded age floor | 3 |
| 4.4 trigger from the flag, totality arm | 3 |
| 4.4a arm-the-poll (no runner) | design of 1 + 5; nothing to build |
| 4.4b event, `requestId`, counts, emit path, ninth-event count | 4 |
| 4.5 endpoint, filter, refusals, partial commit, audit | 5 |
| 4.6 indicator states, timeout, copy | 6 |
| 4.7 what does not change | no task by design |
| 4.8 surfaces | spread across 1-6; typecheck is the enumerator |
| 7 unit tests | 1, 2, 3, 4, 5 |
| 7 dashboard tests | 6 |
| 7 e2e incl. the negative assertion | 7 |
| 9 out of scope, filed | 8 |

No gaps.

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries real code. Two steps say "match the repo's real signature" (Task 1 step 8 harness fake, Task 7 step 3 `put`) - these name the exact file and the exact property that matters rather than deferring a decision.

**3. Type consistency.** `requestManualExtraction(conversationId, dueAt, requestId)` is used identically in Tasks 1, 2 and 5. `fail(conversationId, error, nextDueAt, { listedDueAt?, manual })` is defined in Task 2 and called with that shape in Task 2 step 5. `AiRunCompletedEvent` field names match across Task 4 (backend) and Task 6 (dashboard). `RunDraft.wrote`/`.suggested` are added in Task 3 and read in Task 4. `RUN_INDICATOR_TIMEOUT_MS` is defined and used in Task 6.

---

## Execution order and dependencies

```
1 -> 2 -> 3 -> 4 -> 6
     \-> 5 -----------> 6
                        \-> 7 -> 8
```

Tasks 2 and 5 can proceed in parallel once 1 lands. Task 6 needs both 4 and 5. Task 7 needs everything.
