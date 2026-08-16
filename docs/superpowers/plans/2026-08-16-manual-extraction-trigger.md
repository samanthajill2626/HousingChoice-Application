# Manual Extraction Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff user presses one action on a contact and the AI extraction layer runs over that contact's stored conversation history with no 30-day age floor, showing a running indicator that resolves to the run's real outcome.

**Architecture:** A press writes a sticky `manualRequested` flag plus a per-press `requestId` onto the conversation's existing due row and arms it for `now`. The worker's existing poll claims and runs it; the job keys two gate waivers off the flag. A new `ai_run.completed` event carries the run's outcome back to the waiting page over the existing SSE bridge. No new runner, no new process, no lease.

**Tech Stack:** TypeScript, Express, DynamoDB (single-table with sparse GSIs), Vitest, React 18, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-13-manual-extraction-trigger-design.md`

## Global Constraints

- **ASCII only** on every new or touched line in specs, plans, prompts, issues, labels, comments, seed strings, and test names.
- **Never rewrite source with PowerShell pipelines** - they mojibake BOM-less UTF-8. Use an edit tool.
- **Read bare `git status` before every commit**; stage explicit paths only, never `git add -A`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **PII rule:** extraction code logs and emits ids and counts only - never message bodies, phone numbers, or field values.
- **Gates before handback:** `npm run typecheck`, `npm test`, `npm run e2e`, run bare from the feature worktree. Never pipe a gate command.
- **Vendor SDK imports live in `app/src/adapters`.**
- Worktree: `W:\tmp\manual-extraction-trigger`, branch `feat/manual-extraction-trigger`.

## Test infrastructure you will use (read this before Task 1)

This plan's predecessor invented helper names. These are the real ones, verified in the repo:

| Layer | Helper | Location |
| --- | --- | --- |
| Repo unit tests | `repoWith(doc)`, `makeFakeDoc()`, constants `T1` `T2` `T3` `FUTURE` | `app/test/extractionRepo.test.ts:298` |
| Job unit tests | `makeHarness({dueRows, messages?, contact?, conversation?, claimResult?, driver?, aiRuns?})` returning `{deps, repo, seen, runs, aiRuns, applyEvents}`; `dueRow(overrides)`; `msg(seconds, direction, body)`; `tenantContact()`; `convWith(id)`; constants `NOW` `WALL_NOW` `DEBOUNCE` | `app/test/extractionJob.test.ts:182-271` |
| Route tests | `makeWebhookHarness()` returning `{app, world}`; `createFakeWorld`; `ORIGIN_SECRET`; `TEST_SESSION_COOKIE`; supertest | `app/test/helpers/twilioWebhookHarness.ts` |
| Dashboard tests | `renderAt(contactId)`; a `vi.mock` factory over `../../api/index.js` | `dashboard/src/routes/contact/ContactDetail.test.tsx:72` |
| E2E | `extractionTick(request)`, `sendExtractSms(...)`, `planTranscribedCall(...)`, `reseed(request)`, `postInboundSms(...)` | `e2e/fixtures/extraction.ts`, `e2e/fixtures/reseed.ts`, `e2e/fixtures/fakeTwilio.ts` |

**Two constraints the fake infrastructure imposes:**

1. **The repo test's fake doc client evaluates `ConditionExpression` by splitting on `AND` only** and THROWS on anything else (`app/test/extractionRepo.test.ts:73-111`). An `OR` condition is not merely unsupported - it errors. Task 2 is designed around this.
2. **`ContactDetail.test.tsx:66` stubs `useEventStream: () => {}`**, so there is no way to deliver an event today. Task 6 changes that stub to capture the handlers.

**The fake driver's protocol** is a marker in a message body: `EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}` (see `app/test/extractionJob.test.ts` happy-path test). It is JSON, not `key=value`.

---

## File Structure

**Repo:** `app/src/repos/extractionRepo.ts` - two new sparse attributes, one new method, `claim` clears them, `fail` becomes conditional.
**Job:** `app/src/jobs/extraction.ts` - `manual` derivation, two gate waivers, draft fields, the completion emit. `app/src/services/extraction/{runTypes,runWindow}.ts` - nullable recorded age floor.
**Events:** `app/src/lib/events.ts`, `app/src/routes/api.ts`.
**Route:** `app/src/routes/contacts.ts`.
**Dev seam:** `app/src/routes/dev.ts` - a direct doc-client write, because no repo method accepts a caller-supplied `created_at`.
**Dashboard:** `dashboard/src/api/{types,endpoints}.ts`, `EventStreamProvider.tsx`, `routes/contact/{ContactActionsMenu,ContactDetail}.tsx` + its CSS module.
**E2E:** `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`.

---

### Task 1: The due row carries a manual flag and a press id

**Files:**
- Modify: `app/src/repos/extractionRepo.ts`
- Modify: `app/src/jobs/extraction.ts:296-299` (`newRunDraft` - see step 6, this is required IN THIS TASK)
- Modify: `app/test/helpers/twilioWebhookHarness.ts`, `app/test/extractionJob.test.ts`, `app/test/extractionJobDraftGuard.test.ts`, `app/test/twilioSmsWebhook.test.ts` (repo literals)
- Test: `app/test/extractionRepo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `requestManualExtraction(conversationId: string, dueAt: string, requestId: string): Promise<void>`; `DueExtractionItem.manualRequested?: true`; `DueExtractionItem.requestId?: string`; `DueExtractionItem.channel?: ...` (now optional).

**Ordering note:** making `channel` optional breaks `newRunDraft`, which assigns `trigger: row.channel` into a required `RunTrigger` (`app/src/jobs/extraction.ts:298`). That fix belongs in THIS task or the task cannot reach its own typecheck gate. Step 6 does it.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/extractionRepo.test.ts`, using the file's existing `makeDoc()` / `repoWith()` / `T1..T3` vocabulary:

```ts
describe('extractionRepo.requestManualExtraction', () => {
  it('arms the row with the flag and the request id, and never writes channel', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T1);
    expect(item!._duePartition).toBe('due');
    expect(item!.manualRequested).toBe(true);
    expect(item!.requestId).toBe('req-abc');
    expect(item!.channel).toBeUndefined();
  });

  it('leaves an existing channel untouched when a press lands on a scheduled row', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    const item = await repo.getDue('conv-1');
    expect(item!.channel).toBe('sms');
    expect(item!.manualRequested).toBe(true);
    expect(item!.dueAt).toBe(T2);
  });

  it('scheduleExtraction never sets the flag or a request id', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
    expect(item!.requestId).toBeUndefined();
  });

  it('claim removes the flag and the request id with the index keys', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    expect(await repo.claim('conv-1', T2, T1)).toBe(true);
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
    expect(item!.requestId).toBeUndefined();
    expect(item!._duePartition).toBeUndefined();
  });
});
```

These names are read from the file, not guessed: `makeFakeDoc` is at `app/test/extractionRepo.test.ts:176` and `repoWith` at `:298`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: FAIL - `repo.requestManualExtraction is not a function`.

- [ ] **Step 3: Widen `DueExtractionItem`**

In `app/src/repos/extractionRepo.ts`, replace the `channel` field and its comment:

```ts
  /** What scheduled the run through an INBOUND path. OPTIONAL because a manual
   *  press can create a row that no inbound path ever scheduled - see
   *  requestManualExtraction, which deliberately does not write it. */
  channel?: 'sms' | 'voice' | 'triage' | 'email';
  /** Sticky manual marker (sparse). Set by requestManualExtraction, REMOVEd by
   *  claim and by fail's park branch. The single source of truth for the job's
   *  gate waivers and the recorded trigger - an inbound sliding dueAt forward
   *  cannot erase it. */
  manualRequested?: true;
  /** Correlates one press to the one run it produces (sparse). Cleared wherever
   *  manualRequested is, so a dead press's key can never ride a later run. */
  requestId?: string;
```

- [ ] **Step 4: Declare the method**

In the `ExtractionRepo` interface, after `scheduleExtraction`:

```ts
  /**
   * Arm a row for an IMMEDIATE manual run. Same sliding upsert as
   * scheduleExtraction, plus manualRequested and the caller's requestId, and
   * deliberately WITHOUT touching `channel` - `channel` has no clearing site,
   * so a 'manual' value stored there would outlive the flag and could later
   * label an automatic run as manual in the run log.
   */
  requestManualExtraction(conversationId: string, dueAt: string, requestId: string): Promise<void>;
```

- [ ] **Step 5: Implement it and clear on claim**

In the factory, after `scheduleExtraction`:

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

In `claim`, extend the REMOVE clause and the names map:

```ts
            UpdateExpression: 'SET #claimedAt = :claimedAt REMOVE #dp, #dueAt, #manual, #requestId',
```

```ts
              '#manual': 'manualRequested',
              '#requestId': 'requestId',
```

- [ ] **Step 6: Keep `newRunDraft` compiling (REQUIRED in this task)**

`app/src/jobs/extraction.ts`, replace `newRunDraft`:

```ts
/** Allocate a draft before processing so the outer backstop retains all evidence. */
export function newRunDraft(row: DueExtractionItem, startedAt: string): RunDraft {
  const manual = row.manualRequested === true;
  // The `?? 'manual'` arm is a totality device, not a second labelling rule. A
  // row with no `channel` can only have been created by
  // requestManualExtraction, which always sets the flag - and every
  // flag-clearing site also de-arms the row, so listDue cannot return a
  // channel-less row without the flag.
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

Add `requestId?: string;` to `RunDraft`. Add `'manual'` to `RunTrigger` in `app/src/repos/aiRunsRepo.ts:23`:

```ts
export type RunTrigger = 'sms' | 'voice' | 'triage' | 'email' | 'manual';
```

- [ ] **Step 7: Typecheck to enumerate the repo literals**

Run: `npm run typecheck`
Expected: FAIL, naming every full `ExtractionRepo` literal missing the new method. **Typecheck is the enumerator of record** - the known sites are `app/test/helpers/twilioWebhookHarness.ts:2886`, `app/test/extractionJob.test.ts:164`, `app/test/extractionJobDraftGuard.test.ts:108`, `app/test/twilioSmsWebhook.test.ts:1135`, but do not assume that list is complete.

For the three simple fakes add:

```ts
    async requestManualExtraction() {},
```

For `twilioWebhookHarness.ts`, whose fake keeps real state, mirror its own `scheduleExtraction` body and additionally set `manualRequested: true` and the `requestId`, leaving `channel` alone.

- [ ] **Step 8: Run typecheck and the full suite**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm test`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git status
git add app/src/repos/extractionRepo.ts app/src/jobs/extraction.ts app/src/repos/aiRunsRepo.ts app/test/extractionRepo.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/extractionJob.test.ts app/test/extractionJobDraftGuard.test.ts app/test/twilioSmsWebhook.test.ts
git commit -m "feat(extraction): arm a due row manually with a sticky flag and a press id

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `fail` stops destroying a re-arm that landed during the run

**Files:**
- Modify: `app/src/repos/extractionRepo.ts`
- Modify: `app/src/jobs/extraction.ts` (the `claim` result must reach `fail`; the single production call site)
- Test: `app/test/extractionRepo.test.ts`

**Interfaces:**
- Consumes: Task 1's item shape.
- Produces: `fail(conversationId, error, nextDueAt, opts: { claimed: boolean; listedDueAt: string; manual: boolean }): Promise<void>`.

**Why no `OR`:** the natural predicate is "nobody re-armed since we listed it", which reads as `attribute_not_exists(_duePartition) OR dueAt = :listedDueAt`. The repo test's fake doc client splits only on `AND` and throws on anything else (`app/test/extractionRepo.test.ts:73-111`). It does not need to: the job knows whether the claim succeeded, and each path justifies exactly one conjunct.

- **Claim succeeded** -> the claim removed `_duePartition`, so "not re-armed" is precisely `attribute_not_exists(_duePartition)`.
- **Claim threw** -> the row was never un-armed, so "not re-armed" is precisely `dueAt = :listedDueAt`.

Passing `claimed` is strictly more precise than the disjunction and needs no `OR`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('extractionRepo.fail - re-arm survival', () => {
  const opts = (over: Partial<{ claimed: boolean; listedDueAt: string; manual: boolean }> = {}) =>
    ({ claimed: true, listedDueAt: T1, manual: false, ...over });

  it('claimed, nobody re-armed: backs off normally', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', T3, opts());
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T3);
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toBe('boom');
  });

  it('claimed, a press re-armed: the press survives and the error is still recorded', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    await repo.fail('conv-1', 'boom', T3, opts());
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2);
    expect(item!.manualRequested).toBe(true);
    expect(item!.requestId).toBe('req-abc');
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toBe('boom');
  });

  it('claimed, a press re-armed, and the run PARKS: the press is not deleted', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.claim('conv-1', T2, T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    await repo.fail('conv-1', 'boom', null, opts());
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2);
    expect(item!._duePartition).toBe('due');
    expect(item!.requestId).toBe('req-abc');
  });

  it('claim THREW and nobody re-armed: still backs off, and can still park', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.fail('conv-1', 'boom', T3, opts({ claimed: false }));
    expect((await repo.getDue('conv-1'))!.dueAt).toBe(T3);
    await repo.fail('conv-1', 'boom', null, opts({ claimed: false, listedDueAt: T3 }));
    const parked = await repo.getDue('conv-1');
    expect(parked!._duePartition).toBeUndefined();
    expect(parked!.dueAt).toBeUndefined();
  });

  it('claim THREW and a press re-armed: the press survives', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.scheduleExtraction('conv-1', 'sms', T1);
    await repo.requestManualExtraction('conv-1', T2, 'req-abc');
    await repo.fail('conv-1', 'boom', T3, opts({ claimed: false }));
    const item = await repo.getDue('conv-1');
    expect(item!.dueAt).toBe(T2);
    expect(item!.manualRequested).toBe(true);
  });

  it('a manual run re-arms WITH the flag; an automatic one does not', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', T3, opts({ manual: true }));
    expect((await repo.getDue('conv-1'))!.manualRequested).toBe(true);

    await repo.scheduleExtraction('conv-2', 'sms', T1);
    await repo.claim('conv-2', T2, T1);
    await repo.fail('conv-2', 'boom', T3, opts());
    expect((await repo.getDue('conv-2'))!.manualRequested).toBeUndefined();
  });

  it('parking REMOVEs BOTH the flag and the request id', async () => {
    const { doc } = makeFakeDoc();
    const repo = repoWith(doc);
    await repo.requestManualExtraction('conv-1', T1, 'req-abc');
    await repo.claim('conv-1', T2, T1);
    await repo.fail('conv-1', 'boom', null, opts({ manual: true }));
    const item = await repo.getDue('conv-1');
    expect(item!.manualRequested).toBeUndefined();
    expect(item!.requestId).toBeUndefined();
  });
});
```

The last case is the one that matters most: leaving `requestId` behind on a park would let a later automatic run inherit a dead press's correlation key and resolve a stale indicator.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: FAIL - `fail` takes three arguments; the survival cases clobber `dueAt`.

- [ ] **Step 3: Change the interface**

```ts
  /**
   * Record a failed run. `nextDueAt` non-null re-arms with backoff; null parks.
   *
   * Both branches are CONDITIONAL on nobody having re-armed the row since it
   * was listed. Unconditional writes destroyed a press or an inbound that
   * landed during the failing run - the park branch permanently, since the row
   * then leaves the due index with nothing left to re-arm it.
   *
   * The condition depends on how the run reached this point, which is why the
   * caller passes `claimed`:
   *   claimed  -> attribute_not_exists(_duePartition)  (the claim un-armed it)
   *   !claimed -> dueAt = :listedDueAt                 (claim threw; never un-armed)
   * Each path asserts exactly what it knows, and neither needs an OR.
   *
   * On a condition failure a second, scheduling-free update records only
   * lastError and attempts, leaving the fresh dueAt and marker alone.
   */
  fail(
    conversationId: string,
    error: string,
    nextDueAt: string | null,
    opts: { claimed: boolean; listedDueAt: string; manual: boolean },
  ): Promise<void>;
```

- [ ] **Step 4: Implement it**

```ts
    async fail(conversationId, error, nextDueAt, opts) {
      const common = { TableName: table, Key: { itemId: dueId(conversationId) } };
      const condition = opts.claimed
        ? 'attribute_not_exists(#dp)'
        : '#dueAt = :listedDueAt';

      const scheduling = async (): Promise<void> => {
        if (nextDueAt !== null) {
          await doc.send(new UpdateCommand({
            ...common,
            UpdateExpression: opts.manual
              ? 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp, #manual = :manual ADD #attempts :one'
              : 'SET #lastError = :error, #dueAt = :dueAt, #dp = :dp ADD #attempts :one',
            ConditionExpression: condition,
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
              ...(!opts.claimed && { ':listedDueAt': opts.listedDueAt }),
            },
          }));
          log.debug({ conversationId, nextDueAt }, 'extraction failed - re-armed');
          return;
        }
        // Park. REMOVE the correlation key with the flag: a dead press's
        // requestId riding a later automatic run would resolve a stale
        // indicator on someone's screen.
        await doc.send(new UpdateCommand({
          ...common,
          UpdateExpression: 'SET #lastError = :error REMOVE #dp, #dueAt, #manual, #requestId ADD #attempts :one',
          ConditionExpression: condition,
          ExpressionAttributeNames: {
            '#lastError': 'lastError',
            '#dp': '_duePartition',
            '#dueAt': 'dueAt',
            '#manual': 'manualRequested',
            '#requestId': 'requestId',
            '#attempts': 'attempts',
          },
          ExpressionAttributeValues: {
            ':error': error,
            ':one': 1,
            ...(!opts.claimed && { ':listedDueAt': opts.listedDueAt }),
          },
        }));
        log.warn({ conversationId }, 'extraction failed - parked (max attempts)');
      };

      try {
        await scheduling();
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
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

- [ ] **Step 5: Thread the claim outcome to the call site**

`processRow` currently swallows whether the claim threw. It must report it. In `processRow`, change the claim block so a throw is distinguishable, and carry the fact on the draft (the simplest channel to the caller, which already reads `draft`):

Add to `RunDraft`:

```ts
  /** False when repo.claim THREW - the row was never un-armed, which changes
   *  which condition fail() may assert. */
  claimed?: boolean;
```

In `processRow`:

```ts
  let claimed: boolean;
  try {
    claimed = await repo.claim(conversationId, nowIso, listedDueAt);
    draft.claimed = claimed;
  } catch (err) {
    draft.claimed = false;
    return failed('repo', err);
  }
```

In `runDueExtractions`, replace the `repo.fail(...)` call. `row.dueAt` is optional on the type but `processRow` returns early when it is absent (`app/src/jobs/extraction.ts:363`), so the `?? ''` below is UNREACHABLE today - it exists only to satisfy the optional type. Do not treat it as a real fallback: if that guard ever moves, an empty `listedDueAt` would make the not-claimed condition never match and resurrect the unbounded-retry bug. A comment on the line should say so.

```ts
      try {
        await repo.fail(row.conversationId, draft.error?.message ?? 'unknown', nextDueAt, {
          claimed: draft.claimed === true,
          listedDueAt: row.dueAt ?? '',
          manual: row.manualRequested === true,
        });
      } catch (failErr) {
```

- [ ] **Step 6: Run the tests**

Run: `npm test --workspace app -- extractionRepo.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: exit 0 from both. Existing `extractionJob.test.ts` assertions on `repo.fail` call shape will need their expected argument list updated to the four-argument form - update them, do not weaken them.

- [ ] **Step 7: Commit**

```bash
git status
git add app/src/repos/extractionRepo.ts app/src/jobs/extraction.ts app/test/extractionRepo.test.ts app/test/extractionJob.test.ts
git commit -m "fix(extraction): stop fail() destroying a re-arm that landed during the run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The job waives both gates for a manual run

**Files:**
- Modify: `app/src/jobs/extraction.ts`
- Modify: `app/src/services/extraction/runTypes.ts`, `runWindow.ts`
- Test: `app/test/extractionJob.test.ts`, `app/test/extractionRunWindow.test.ts`

**Interfaces:**
- Consumes: `DueExtractionItem.manualRequested` (Task 1).
- Produces: `RunWindowParams.maxTranscriptAgeDays: number | null`; `BuildFullRunWindowInput.maxTranscriptAgeDays: number | null`; `RunDraft.wrote?: number`, `.suggested?: number`.

- [ ] **Step 1: Write the failing tests**

Add to `app/test/extractionJob.test.ts`. `msg()` stamps `created_at` at `2026-07-16T12:00:SS.000Z` and `NOW` is `2026-07-17T00:00:00.000Z`, so a helper is needed for a genuinely aged message:

```ts
/** A message far outside the 30-day window, for the manual-run age waiver. */
function agedMsg(direction: 'inbound' | 'outbound', body: string): MessageItem {
  const ts = '2026-01-05T12:00:00.000Z';
  return {
    conversationId: 'conv1',
    tsMsgId: `${ts}#aged`,
    type: 'sms',
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    body,
    provider_sid: 'aged',
    provider_ts: ts,
    delivery_status: 'delivered',
    created_at: ts,
  };
}

describe('manual runs waive both gates', () => {
  const EXTRACT_BODY = 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}';

  it('reaches the driver when every message predates the 30-day cutoff', async () => {
    const h = makeHarness({
      dueRows: [dueRow({ manualRequested: true, requestId: 'req-abc' })],
      messages: [agedMsg('inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.seen).toHaveLength(1);
  });

  it('the SAME fixture without the flag skips no_new_client, not empty_window', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [agedMsg('inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.seen).toHaveLength(0);
    expect(h.runs[0]!.outcome).toBe('skipped');
    expect(h.runs[0]!.skipReason).toBe('no_new_client');
  });

  it('waives no_new_client when the cursor is already past every message', async () => {
    const fresh = msg(10, 'inbound', EXTRACT_BODY);
    const h = makeHarness({
      dueRows: [dueRow({ manualRequested: true, cursor: fresh.tsMsgId })],
      messages: [fresh],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.seen).toHaveLength(1);
  });

  it('records trigger manual from the flag even when channel says sms', async () => {
    const h = makeHarness({
      dueRows: [dueRow({ channel: 'sms', manualRequested: true })],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]!.trigger).toBe('manual');
  });

  it('records a defined trigger for a row with no channel at all', async () => {
    const h = makeHarness({
      dueRows: [dueRow({ channel: undefined, manualRequested: true })],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(h.runs[0]!.trigger).toBe('manual');
  });

  it('records the age floor it actually applied: null when waived, 30 otherwise', async () => {
    const manual = makeHarness({
      dueRows: [dueRow({ manualRequested: true })],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, manual.deps);
    expect(manual.runs[0]!.window!.windowParams!.maxTranscriptAgeDays).toBeNull();

    const auto = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, auto.deps);
    expect(auto.runs[0]!.window!.windowParams!.maxTranscriptAgeDays).toBe(30);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionJob.test.ts`
Expected: FAIL - the aged fixture produces no driver call.

- [ ] **Step 3: Make the recorded floor nullable**

`app/src/services/extraction/runTypes.ts`, in `RunWindowParams`:

```ts
  /** The floor this run actually applied; null when waived (a manual run).
   *  Legacy stored records always carry a number. */
  maxTranscriptAgeDays: number | null;
```

`app/src/services/extraction/runWindow.ts` - add to `BuildFullRunWindowInput`:

```ts
  /** The floor this run actually applied; null when waived. */
  maxTranscriptAgeDays: number | null;
```

and in `buildFullRunWindow`'s `windowParams`, replace the constant with `input.maxTranscriptAgeDays`. Remove `MAX_TRANSCRIPT_AGE_DAYS` from the import list at `runWindow.ts:6` if nothing else in the file uses it - a dangling import of a constant this file no longer applies is misleading to the next reader.

- [ ] **Step 4: Update the window unit tests**

`app/test/extractionRunWindow.test.ts` calls `buildFullRunWindow` in **7** places, each with an inline object literal (there is no shared input builder). Add `maxTranscriptAgeDays: 30` to all 7 - they all model automatic runs - and add one new case that copies the nearest existing literal and overrides the field:

```ts
  it('records a null age floor when the run waived it', () => {
    // Copy the input literal from the 'records the byte-affecting constants'
    // test above and override the one field.
    const window = buildFullRunWindow({ /* ...that literal... */ maxTranscriptAgeDays: null });
    expect(window.windowParams!.maxTranscriptAgeDays).toBeNull();
  });
```

- [ ] **Step 5: Waive the two gates**

In `processRow`, after `const cursor = row.cursor ?? '';`:

```ts
  // The single source of truth for both waivers and the recorded trigger. Read
  // from the row listDue returned, which is BEFORE claim clears it.
  const manual = row.manualRequested === true;
```

Replace the cutoff block:

```ts
  const cutoff = new Date(Date.parse(nowIso) - MAX_TRANSCRIPT_AGE_DAYS * DAY_MS).toISOString();
  const chronological = [...newestFirst].reverse();
  // A manual run waives the age floor: the imported history this feature exists
  // to reach is historical by definition. Newest-50 and the 60k char budget
  // still bound the window.
  const fresh = manual ? chronological : chronological.filter((m) => m.created_at >= cutoff);
  const agedOutTsMsgIds = manual
    ? []
    : chronological.filter((m) => m.created_at < cutoff).map((m) => m.tsMsgId);
```

Replace the freshness gate:

```ts
  const hasNewClient = manual || row.channel === 'voice' || row.channel === 'triage' || fresh.some(
```

Pass the effective floor:

```ts
  const fullWindow = draftPiece(logger, draft, () => buildFullRunWindow({
    cursor, fetchedCount, agedOutTsMsgIds, perMessage, included, hasInferredRoleContent,
    maxTranscriptAgeDays: manual ? null : MAX_TRANSCRIPT_AGE_DAYS,
    ...(newestTsMsgId !== undefined && { newestTsMsgId }),
  }));
```

- [ ] **Step 6: Carry the counts for the event**

Add to `RunDraft`:

```ts
  /** Counts for the completion event, sourced from applyOutcome where they
   *  exist - NOT re-derived from `decisions`, which is best-effort. */
  wrote?: number;
  suggested?: number;
```

Where `draft.notedLines` is assigned after `applyExtraction`:

```ts
  draft.notedLines = applyOutcome.notedLines;
  draft.wrote = applyOutcome.wrote.length;
  draft.suggested = applyOutcome.suggested.length;
```

- [ ] **Step 7: Run the tests**

Run: `npm test --workspace app -- extractionJob.test.ts extractionRunWindow.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git status
git add app/src/jobs/extraction.ts app/src/services/extraction/runTypes.ts app/src/services/extraction/runWindow.ts app/test/extractionJob.test.ts app/test/extractionRunWindow.test.ts
git commit -m "feat(extraction): waive the age and freshness gates for a manual run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ai_run.completed` reaches the page

**Files:**
- Modify: `app/src/lib/events.ts`
- Modify: `app/test/eventBridge.test.ts:42-43`
- Modify: `app/src/jobs/extraction.ts`
- Modify: `app/src/worker.ts`, `app/src/routes/dev.ts`
- Modify: `app/src/routes/api.ts`
- Test: `app/test/extractionJob.test.ts`, `app/test/extractionJobDraftGuard.test.ts`

**Interfaces:**
- Consumes: `RunDraft.requestId`, `.wrote`, `.suggested` (Tasks 1, 3).
- Produces: `'ai_run.completed'` with `AiRunCompletedEvent`.

- [ ] **Step 1: Write the failing tests**

`makeHarness` needs a recording emitter. Add to the `Harness` interface `jobEvents: { emit: ReturnType<typeof vi.fn> }`, create `const jobEvents = { emit: vi.fn() };` beside the existing `applyEvents`, put `events: jobEvents` in the `deps` object, and return it. Then:

```ts
describe('ai_run.completed', () => {
  const EXTRACT_BODY = 'EXTRACT:{"fields":{"pets":{"op":"write","value":"yes"}}}';
  const emitted = (h: ReturnType<typeof makeHarness>) =>
    h.jobEvents.emit.mock.calls.filter((c) => c[0] === 'ai_run.completed');

  it('emits once for an applied run, carrying the counts', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(emitted(h)).toHaveLength(1);
    expect(emitted(h)[0]![1]).toMatchObject({ outcome: 'applied', wrote: 1, suggested: 0 });
  });

  it('emits for a SKIPPED run - the case the indicator most needs', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(emitted(h)[0]![1]).toMatchObject({ outcome: 'skipped' });
  });

  it('emits for a NO_OP run (the model proposed nothing)', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'just saying hi')], // no EXTRACT marker
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    expect(emitted(h)[0]![1]).toMatchObject({ outcome: 'no_op', wrote: 0, suggested: 0 });
  });

  it('emits for a FAILED run, carrying the error kind', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
      driver: {
        kind: 'fake',
        extract: async () => ({
          ok: false as const,
          meta: { driver: 'fake' as const },
          failure: 'driver' as const,
          message: 'boom',
        }),
      },
    });
    await runDueExtractions(NOW, h.deps);
    expect(emitted(h)[0]![1]).toMatchObject({ outcome: 'failed', errorKind: 'driver' });
  });

  it('still emits when the run-log write fails', async () => {
    const aiRuns = {
      beginFinalization: vi.fn(async () => true),
      putRun: vi.fn(async () => { throw new Error('dynamo down'); }),
      setVerdict: vi.fn(async () => true),
    };
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
      aiRuns,
    });
    await runDueExtractions(NOW, h.deps);
    expect(emitted(h)).toHaveLength(1);
  });

  it('carries the requestId of the press that started it, and none for an automatic run', async () => {
    const manual = makeHarness({
      dueRows: [dueRow({ manualRequested: true, requestId: 'req-abc' })],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, manual.deps);
    expect(emitted(manual)[0]![1].requestId).toBe('req-abc');

    const auto = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, auto.deps);
    expect(emitted(auto)[0]![1].requestId).toBeUndefined();
  });

  it('a no_contact run emits with conversationId and no contactId', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', 'hi')],
      contact: undefined,
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    const payload = emitted(h)[0]![1];
    expect(payload.conversationId).toBe('conv1');
    expect(payload.contactId).toBeUndefined();
  });

  it('carries ids and counts only - no body, no phone, no field value', async () => {
    const h = makeHarness({
      dueRows: [dueRow()],
      messages: [msg(10, 'inbound', EXTRACT_BODY)],
      contact: tenantContact(),
      conversation: convWith('c1'),
    });
    await runDueExtractions(NOW, h.deps);
    const serialized = JSON.stringify(emitted(h)[0]![1]);
    expect(serialized).not.toContain('EXTRACT:');
    expect(serialized).not.toContain('yes');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- extractionJob.test.ts`
Expected: FAIL - `deps.events` does not exist.

- [ ] **Step 3: Add the event**

`app/src/lib/events.ts`, beside `SuggestionUpdatedEvent`:

```ts
/**
 * One extraction run finished (manual-extraction-trigger 4.4b). Emitted for
 * EVERY run - applied, no_op, skipped and failed - because the skip and failure
 * cases are exactly what the contact page's running indicator has to explain.
 * `requestId` is present only when a human press started the run, and is what
 * correlates that press to THIS run: conversationId identifies the thread, not
 * the run, so it cannot do that job alone.
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

Add `'ai_run.completed': AiRunCompletedEvent;` to `AppEventMap` and `'ai_run.completed': true,` to `ALL_APP_EVENTS`. The map comment above `ALL_APP_EVENTS` says "adding an eighth event" - update that wording; it is now nine.

- [ ] **Step 4: Fix the runtime count assertion**

`app/test/eventBridge.test.ts:43` - typecheck cannot see this:

```ts
    expect(APP_EVENT_NAMES).toHaveLength(9);
```

Update the comment at `:42` if it names eight.

- [ ] **Step 5: Add the REQUIRED dep and emit**

`app/src/jobs/extraction.ts`, in `ExtractionJobDeps`:

```ts
  /**
   * The completion emitter. REQUIRED so a missed construction site is a
   * typecheck failure rather than a silently dead indicator - the same reasoning
   * as `aiRuns` above.
   */
  events: Pick<EventBus, 'emit'>;
```

with `import type { EventBus } from '../lib/events.js';`.

In `runDueExtractions`, directly after `await recordRun(deps, outcome, draft);`:

```ts
    // AFTER recordRun but NOT dependent on it: recordRun is best-effort and
    // swallows its own failures, and the indicator must not hinge on an
    // observability write.
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

- [ ] **Step 6: Supply it at every construction site**

Run `npm run typecheck` to enumerate them. Known: `app/src/worker.ts` (add `events: appEvents,` - the module-level import already in scope), `app/src/routes/dev.ts` (add `events: appEvents,`; `DevRouterDeps` has no `events` field, so import the singleton rather than threading a dep), `app/test/extractionJob.test.ts` (step 1), and a fourth at `app/test/extractionJobDraftGuard.test.ts:158` (add `events: { emit: vi.fn() },`).

- [ ] **Step 7: Write and clean up the SSE listener**

`app/src/routes/api.ts`, beside `onSuggestionUpdated`:

```ts
    const onAiRunCompleted = (payload: AiRunCompletedEvent): void => {
      writeEvent('ai_run.completed', payload);
    };
```

Register it with the others, and - this half is easy to forget and leaks a listener per SSE connection - add the matching cleanup beside the other `events.off(...)` calls:

```ts
    events.on('ai_run.completed', onAiRunCompleted);
```

```ts
      events.off('ai_run.completed', onAiRunCompleted);
```

Import `AiRunCompletedEvent` with the sibling event types.

- [ ] **Step 8: Assert the cleanup**

`app/test/sse.test.ts` already asserts listener cleanup for the named events. Extend its list to include `ai_run.completed` so a missing `off` fails a test rather than leaking silently in production.

- [ ] **Step 9: Run everything**

Run: `npm test --workspace app`
Expected: PASS, including `eventBridge.test.ts` and `sse.test.ts`.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git status
git add app/src/lib/events.ts app/test/eventBridge.test.ts app/src/jobs/extraction.ts app/src/worker.ts app/src/routes/dev.ts app/src/routes/api.ts app/test/extractionJob.test.ts app/test/extractionJobDraftGuard.test.ts app/test/sse.test.ts
git commit -m "feat(extraction): emit ai_run.completed for every run

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/contacts/:contactId/extraction-run`

**Files:**
- Modify: `app/src/routes/contacts.ts`
- Test: `app/test/contactExtractionRun.test.ts` (create)

**Interfaces:**
- Consumes: `requestManualExtraction` (Task 1), `conversationsForContact` (`app/src/lib/contactThreads.ts:38`), `isDeleted` and `PHONE_REF_PREFIX` (`app/src/repos/contactsRepo.ts:297,302`).
- Produces: `200 { requestId, scheduled: string[], failed: string[] }` or `{ error }`.

**Note on the phone-pointer id:** `PHONE_REF_PREFIX` is `'phoneref#'`, not `'phone#'`. A fixture using the wrong prefix makes that branch untestable.

- [ ] **Step 1: Write the failing tests**

Create `app/test/contactExtractionRun.test.ts`, modelled on `app/test/contactSoftDelete.test.ts`:

```ts
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

type World = ReturnType<typeof createFakeWorld>;

const auth = (req: request.Test) =>
  req.set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_SESSION_COOKIE);

function seedContact(world: World, over: Partial<ContactItem> & { contactId: string; type: ContactItem['type'] }): void {
  world.contacts.push({ status: 'active', phone: '+15550000001', ...over });
}

function seedConversation(world: World, id: string, type: ConversationItem['type']): void {
  world.conversations.set(id, {
    conversationId: id,
    status: 'open',
    type,
    ai_mode: 'auto',
    participant_phone: '+15550000001',
    last_activity_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
  });
}

describe('POST /api/contacts/:contactId/extraction-run', () => {
  it('schedules every eligible 1:1 thread and returns their ids', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled.sort()).toEqual(['conv-a', 'conv-b']);
    expect(res.body.failed).toEqual([]);
    expect(typeof res.body.requestId).toBe('string');
  });

  it('EXCLUDES relay_group and landlord_1to1', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-ok', 'tenant_1to1');
    seedConversation(world, 'conv-relay', 'relay_group');
    seedConversation(world, 'conv-ll', 'landlord_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.body.scheduled).toEqual(['conv-ok']);
  });

  it('404s an unknown contact and a phone-pointer id', async () => {
    const { app } = makeWebhookHarness();
    expect((await auth(request(app).post('/api/contacts/nope/extraction-run'))).status).toBe(404);
    const ref = await auth(request(app).post(`/api/contacts/${encodeURIComponent('phoneref#+15550000001')}/extraction-run`));
    expect(ref.status).toBe(404);
    expect(ref.body.error).toBe('contact_not_found');
  });

  it('refuses a soft-deleted contact', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant', deleted_at: '2026-08-01T00:00:00.000Z' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('contact_deleted');
  });

  it.each(['landlord', 'partner', 'team_member'] as const)('refuses a %s contact', async (type) => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ineligible_contact_type');
  });

  it('distinguishes no threads from no ELIGIBLE threads', async () => {
    const a = makeWebhookHarness();
    seedContact(a.world, { contactId: 'c-1', type: 'tenant' });
    expect((await auth(request(a.app).post('/api/contacts/c-1/extraction-run'))).body.error)
      .toBe('no_conversations');

    const b = makeWebhookHarness();
    seedContact(b.world, { contactId: 'c-2', type: 'tenant' });
    seedConversation(b.world, 'conv-relay', 'relay_group');
    expect((await auth(request(b.app).post('/api/contacts/c-2/extraction-run'))).body.error)
      .toBe('no_eligible_conversations');
  });
});
```

Two more cases need harness support that **does not exist yet and must be built
in this task** - do not assume it:

**(a) A throwing `requestManualExtraction`.** Add to `createFakeWorld` a
`failManualExtractionFor = new Set<string>()`, and in the fake extraction repo's
`requestManualExtraction`, throw when the conversationId is in that set. Follow
the pattern the fake already uses for recording `scheduleExtraction` calls
(`app/test/helpers/twilioWebhookHarness.ts:2886`).

**(b) The kill switch off.** The contacts router reads `aiExtractionEnabled`
from its deps (`app/src/routes/contacts.ts:142,889`). Give `makeWebhookHarness`
an options argument that forwards it, so the refusal is testable at all:

```ts
  it('refuses when the kill switch is off', async () => {
    const { app, world } = makeWebhookHarness({ aiExtractionEnabled: false });
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('extraction_disabled');
  });

  it('appends an audit entry with the counts', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    const entry = world.auditEntries.find((e) => e.action === 'extraction_run_requested');
    expect(entry).toBeDefined();
    expect(entry!.payload).toMatchObject({ scheduled: 1, failed: 0 });
  });
```

Read how the harness records audit appends before writing that last assertion -
`world.auditEntries` is the expected shape but confirm the property name.

Then the partial-failure pair:

```ts
  it('is a 200 with a partial list when one write fails, never a 500', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    seedConversation(world, 'conv-b', 'unknown_1to1');
    world.failManualExtractionFor.add('conv-b');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toEqual(['conv-a']);
    expect(res.body.failed).toEqual(['conv-b']);
  });

  it('is a 500 only when NOTHING was scheduled', async () => {
    const { app, world } = makeWebhookHarness();
    seedContact(world, { contactId: 'c-1', type: 'tenant' });
    seedConversation(world, 'conv-a', 'tenant_1to1');
    world.failManualExtractionFor.add('conv-a');
    const res = await auth(request(app).post('/api/contacts/c-1/extraction-run'));
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('schedule_failed');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace app -- contactExtractionRun.test.ts`
Expected: FAIL - 404 on an unregistered route.

- [ ] **Step 3: Implement the route**

In `app/src/routes/contacts.ts`. Check the file's existing imports first: it already imports `conversationsForContact` (`:68`) and `PHONE_REF_PREFIX` is available from `contactsRepo`. Add `isDeleted` to that import, and `randomUUID` from `node:crypto` if absent. Use the same `json()` body-parser and `AuthedRequest` typing the neighbouring routes use - copy the shape of an existing `router.post` in this file rather than the sketch below verbatim.

```ts
  // Manual extraction trigger (design 4.5). Arms each eligible 1:1 thread for an
  // IMMEDIATE run (dueAt = now, no debounce) and returns; the worker poll does
  // the work.
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
    if (isDeleted(contact)) {
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
    // across a contact's threads, and conversationsForContact returns the raw
    // phone+email union - a phone query can return relay_group threads.
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
        // Partial failure is NOT a total one: a queued run will bill, so a 500
        // here would tell the operator nothing happened when something did.
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

Run: `npm test --workspace app -- contactExtractionRun.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/contacts.ts app/test/contactExtractionRun.test.ts app/test/helpers/twilioWebhookHarness.ts
git commit -m "feat(contacts): add the manual extraction-run endpoint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The contact page action and its running indicator

**Files:**
- Modify: `dashboard/src/api/types.ts`, `endpoints.ts`, `EventStreamProvider.tsx`
- Modify: `dashboard/src/routes/contact/ContactActionsMenu.tsx` + `ContactActionsMenu.test.tsx`
- Modify: `dashboard/src/routes/contact/ContactDetail.tsx` + `ContactDetail.module.css` + `ContactDetail.test.tsx`

**Interfaces:**
- Consumes: the endpoint (Task 5), `ai_run.completed` (Task 4).
- Produces: `runExtraction(contactId: string): Promise<{ requestId: string; scheduled: string[]; failed: string[] }>`.

- [ ] **Step 1: Give the test file an event seam**

`ContactDetail.test.tsx:66` currently has `useEventStream: () => {}` inside the `vi.mock` factory, so no event can be delivered. Replace it with a capturing stub, and add `runExtraction` to the same factory (a missing mock makes every new test fail on a real fetch):

```ts
  let capturedHandlers: Record<string, ((e: unknown) => void) | undefined> = {};
  // ...inside the mock factory object:
    useEventStream: (handlers: Record<string, ((e: unknown) => void) | undefined>) => {
      capturedHandlers = handlers;
    },
    runExtraction: (...a: unknown[]) => runExtraction(...a),
```

with `const runExtraction = vi.fn();` hoisted beside the file's other `vi.fn()` declarations. Follow the file's existing hoisting idiom exactly - the factory must not close over anything declared after it.

Add helpers beside `renderAt`. **Match this file's idioms exactly** - it imports
`userEvent` per test via a dynamic import and calls `userEvent.setup()`
(`ContactDetail.test.tsx:195-196`); neither `act` nor a bare `userEvent` is in
scope at module level:

```tsx
function emitRunCompleted(payload: Record<string, unknown>): void {
  capturedHandlers.onAiRunCompleted?.(payload);
}

async function pressRun(): Promise<void> {
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /more actions/i }));
  await user.click(screen.getByRole('menuitem', { name: /run ai extraction/i }));
}
```

If `emitRunCompleted` produces an act() warning in practice, wrap it using
whatever `act` import the file already has - do not add a module-level one that
conflicts with the dynamic-import idiom.

Confirm the kebab button's accessible name against `ContactActionsMenu.tsx`
before using `/more actions/i`.

**Every test must seed the contact.** The file's outer `beforeEach` only calls
`getContact.mockReset()` (`ContactDetail.test.tsx:139-140`) - it does not seed a
value, so each test does its own `getContact.mockResolvedValue(...)`. Without
that, `renderAt('k1')` renders no contact and there is no kebab to click.

- [ ] **Step 2: Write the failing tests**

```tsx
describe('Run AI extraction', () => {
  beforeEach(() => {
    // The outer beforeEach only resets these; seeding is per-test in this file.
    getContact.mockResolvedValue(TENANT);
    runExtraction.mockResolvedValue({ requestId: 'req-1', scheduled: ['conv-a'], failed: [] });
  });

  it('enters a running state on press', async () => {
    renderAt('k1');
    await pressRun();
    expect(await screen.findByRole('status')).toHaveTextContent(/running ai extraction/i);
  });

  it('disables the item against a second press', async () => {
    renderAt('k1');
    await pressRun();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.getByRole('menuitem', { name: /run ai extraction/i })).toBeDisabled();
  });

  it('times out to the still-running copy when no event arrives', async () => {
    vi.useFakeTimers();
    try {
      renderAt('k1');
      await pressRun();
      vi.advanceTimersByTime(RUN_INDICATOR_TIMEOUT_MS + 1);
      expect(await screen.findByRole('status')).toHaveTextContent(/still running/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves to the applied copy', async () => {
    renderAt('k1');
    await pressRun();
    emitRunCompleted({ conversationId: 'conv-a', runId: 'r1', requestId: 'req-1', outcome: 'applied', wrote: 2, suggested: 1, notedLines: 0 });
    expect(await screen.findByRole('status')).toHaveTextContent(/updated 2 fields, 1 suggestion/i);
  });

  it('says nothing-new for a skipped run', async () => {
    renderAt('k1');
    await pressRun();
    emitRunCompleted({ conversationId: 'conv-a', runId: 'r1', requestId: 'req-1', outcome: 'skipped', skipReason: 'no_new_client', wrote: 0, suggested: 0, notedLines: 0 });
    expect(await screen.findByRole('status')).toHaveTextContent(/nothing new to extract/i);
  });

  it('gives a truncated failure its own actionable copy', async () => {
    renderAt('k1');
    await pressRun();
    emitRunCompleted({ conversationId: 'conv-a', runId: 'r1', requestId: 'req-1', outcome: 'failed', errorKind: 'truncated', wrote: 0, suggested: 0, notedLines: 0 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/ran out of room/i);
  });

  it('waits for EVERY scheduled thread, including when one fails', async () => {
    runExtraction.mockResolvedValue({ requestId: 'req-1', scheduled: ['conv-a', 'conv-b'], failed: [] });
    renderAt('k1');
    await pressRun();
    emitRunCompleted({ conversationId: 'conv-a', runId: 'r1', requestId: 'req-1', outcome: 'failed', errorKind: 'driver', wrote: 0, suggested: 0, notedLines: 0 });
    expect(screen.getByRole('status')).toHaveTextContent(/running ai extraction/i);
    emitRunCompleted({ conversationId: 'conv-b', runId: 'r2', requestId: 'req-1', outcome: 'applied', wrote: 1, suggested: 0, notedLines: 0 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/extraction failed/i);
  });

  it('IGNORES an event carrying a different requestId', async () => {
    renderAt('k1');
    await pressRun();
    emitRunCompleted({ conversationId: 'conv-a', runId: 'r1', requestId: 'someone-else', outcome: 'applied', wrote: 9, suggested: 9, notedLines: 0 });
    expect(screen.getByRole('status')).toHaveTextContent(/running ai extraction/i);
  });

  it('reports threads that could not be queued', async () => {
    runExtraction.mockResolvedValue({ requestId: 'req-1', scheduled: ['conv-a'], failed: ['conv-b'] });
    renderAt('k1');
    await pressRun();
    expect(await screen.findByRole('status')).toHaveTextContent(/1 thread could not be queued/i);
  });

  it.each([
    ['extraction_disabled', /turned off/i],
    ['ineligible_contact_type', /only tenants and untriaged/i],
    ['contact_deleted', /deleted contact/i],
    ['no_conversations', /no conversations/i],
    ['no_eligible_conversations', /no eligible conversations/i],
    ['schedule_failed', /could not be started/i],
  ])('renders its own copy for %s', async (code, copy) => {
    // A REAL ApiError: the copy helper gates on `instanceof ApiError`
    // (dashboard/src/api/client.ts:11), so a plain Error carrying a `code`
    // property falls through to the default and five of these six rows fail.
    runExtraction.mockRejectedValue(new ApiError(409, code, 'refused'));
    renderAt('k1');
    await pressRun();
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });
});
```

`ApiError`'s constructor is `(status, code, message, body?)` and it already
carries the server's `{ error }` value as `code` - read that, never re-parse
`body`. Import it in the test file from wherever the other tests import it.

- [ ] **Step 3: Run to verify they fail**

Run: `npm test --workspace dashboard -- ContactDetail.test.tsx`
Expected: FAIL - no such menu item.

- [ ] **Step 4: Types and client**

`dashboard/src/api/types.ts`: add `'manual'` to `AiRunTrigger`; widen `windowParams.maxTranscriptAgeDays` to `number | null` (`:292`); add `AiRunCompletedEvent` mirroring the backend interface from Task 4 step 3.

`dashboard/src/api/endpoints.ts`: follow the file's own `request<T>` idiom (there is no `postJson`):

```ts
export async function runExtraction(
  contactId: string,
): Promise<{ requestId: string; scheduled: string[]; failed: string[] }> {
  return request(`/api/contacts/${encodeURIComponent(contactId)}/extraction-run`, { method: 'POST' });
}
```

Match the generic/options shape of a neighbouring POST in the file exactly.

`dashboard/src/api/EventStreamProvider.tsx`: follow the existing listener idiom at `:208` - it uses a `parse<T>` helper, a `dispatch(...)` call and a mandatory `markActivity()`. Copy that block for `'ai_run.completed'` rather than writing a bare `addEventListener`, and add `onAiRunCompleted?: (e: AiRunCompletedEvent) => void` to the handler map type.

- [ ] **Step 5: The menu item**

`ContactActionsMenu.tsx` stays presentational. Add to the props interface:

```tsx
  /** Start a manual AI extraction run; the parent does the request. */
  onRunExtraction: () => void;
  /** True from press until the run reports back (disables the item). */
  extractionBusy?: boolean;
```

and in the menu body, following the existing item pattern - **including the `setOpen(false)` the other items call**, or the menu stays open and a second query for the item finds a stale node:

```tsx
          <button
            type="button"
            role="menuitem"
            disabled={extractionBusy}
            onClick={() => { setOpen(false); onRunExtraction(); }}
          >
            Run AI extraction
          </button>
```

`ContactActionsMenu.test.tsx` renders the component directly and will fail on the new required prop. Add `onRunExtraction={() => {}}` to its render helper.

- [ ] **Step 6: The state machine in `ContactDetail`**

```tsx
/** How long the indicator waits before it stops claiming to know. Comfortably
 *  above the observed 5-40s (a 30s worker poll plus the run), because the poll
 *  can be delayed by a long-running row ahead of this one in the same pass. */
export const RUN_INDICATOR_TIMEOUT_MS = 180_000;

type ExtractionState =
  | { phase: 'idle' }
  | { phase: 'running'; requestId: string; pending: Set<string>; wrote: number; suggested: number; failedThreads: number; errorKind?: string }
  | { phase: 'done'; tone: 'status' | 'alert'; message: string };
```

```tsx
  const [extraction, setExtraction] = useState<ExtractionState>({ phase: 'idle' });

  const onRunExtraction = useCallback(async () => {
    // Busy from the press, not from the response: otherwise a double-click
    // fires two POSTs before the first resolves.
    setExtraction({ phase: 'running', requestId: '', pending: new Set(), wrote: 0, suggested: 0, failedThreads: 0 });
    try {
      const res = await runExtraction(contactId);
      setExtraction({
        phase: 'running',
        requestId: res.requestId,
        pending: new Set(res.scheduled),
        wrote: 0,
        suggested: 0,
        failedThreads: res.failed.length,
      });
    } catch (err) {
      setExtraction({ phase: 'done', tone: 'alert', message: extractionRefusalCopy(err) });
    }
  }, [contactId]);
```

Resolution collects every scheduled thread before deciding, so one failing thread does not hide the others (spec 4.6):

```tsx
  useEventStream({
    onAiRunCompleted: (e) => {
      setExtraction((prev) => {
        if (prev.phase !== 'running' || !prev.requestId || e.requestId !== prev.requestId) return prev;
        const pending = new Set(prev.pending);
        pending.delete(e.conversationId);
        const wrote = prev.wrote + e.wrote;
        const suggested = prev.suggested + e.suggested;
        const errorKind = prev.errorKind ?? (e.outcome === 'failed' ? (e.errorKind ?? 'driver') : undefined);
        if (pending.size > 0) return { ...prev, pending, wrote, suggested, ...(errorKind !== undefined && { errorKind }) };
        if (errorKind !== undefined) {
          return { phase: 'done', tone: 'alert', message: extractionFailureCopy(errorKind) };
        }
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
      setExtraction({ phase: 'done', tone: 'status', message: 'Still running - check Settings > AI runs.' });
    }, RUN_INDICATOR_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [extraction.phase]);
```

```tsx
function extractionFailureCopy(errorKind: string): string {
  return errorKind === 'truncated'
    ? 'Extraction ran out of room - the transcript may be too long.'
    : 'Extraction failed - see Settings > AI runs.';
}

function extractionRefusalCopy(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  switch (code) {
    case 'extraction_disabled': return 'AI extraction is turned off for this environment.';
    case 'ineligible_contact_type': return 'Only tenants and untriaged contacts can be extracted.';
    case 'contact_deleted': return 'This is a deleted contact.';
    case 'no_conversations': return 'This contact has no conversations to extract.';
    case 'no_eligible_conversations': return 'This contact has no eligible conversations to extract.';
    default: return 'Extraction could not be started - try again.';
  }
}
```

Render beside the existing `deletedBanner`:

```tsx
        {extraction.phase === 'running' ? (
          <div className={styles.extractionBanner} role="status">
            {`Running AI extraction${extraction.pending.size > 1 ? ` on ${extraction.pending.size} threads` : ''}...`}
            {extraction.failedThreads > 0
              ? ` ${extraction.failedThreads} thread${extraction.failedThreads === 1 ? '' : 's'} could not be queued.`
              : ''}
          </div>
        ) : null}
        {extraction.phase === 'done' ? (
          <div className={styles.extractionBanner} role={extraction.tone}>{extraction.message}</div>
        ) : null}
```

Pass `onRunExtraction` and `extractionBusy={extraction.phase === 'running'}` to `ContactActionsMenu`.

- [ ] **Step 7: Add the style**

`ContactDetail.module.css` needs an `.extractionBanner` rule - a CSS-module miss typechecks and ships unstyled. Copy `.deletedBanner`'s shape.

- [ ] **Step 8: Run the tests**

Run: `npm test --workspace dashboard`
Expected: PASS, including `ContactActionsMenu.test.tsx`.
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/api/EventStreamProvider.tsx dashboard/src/routes/contact/ContactActionsMenu.tsx dashboard/src/routes/contact/ContactActionsMenu.test.tsx dashboard/src/routes/contact/ContactDetail.tsx dashboard/src/routes/contact/ContactDetail.module.css dashboard/src/routes/contact/ContactDetail.test.tsx
git commit -m "feat(contact): add the Run AI extraction action and its running indicator

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: A dev seam that can age a message, and the e2e that proves the waiver

**Files:**
- Modify: `app/src/routes/dev.ts`
- Create: `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`

**Interfaces:**
- Produces: `POST /__dev/extraction/message-fixture` taking `{ conversationId, body, createdAt, direction? }`.

**Why a direct doc-client write:** `MessagesRepo` has no `put`, and `append` hard-stamps `created_at: now` (`app/src/repos/messagesRepo.ts:1713`) - there is no caller-supplied `created_at` path anywhere in the repo. Rather than widen a production write path for a test-only need, this seam writes the item directly. `app/src/routes/dev.ts` already imports `tableName` (`:9`) and `createDocumentClient` (`:10`), so it is in-idiom for this file, and like every `/__dev` route it is structurally absent in deployed environments.

- [ ] **Step 1: Write the e2e**

Create `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts`, modelled on `e2e/tests/dashboard-next/ai-run-log.spec.ts` (same directory - copy its `NEXT`, `devLoginAs` and `createContact` helpers rather than importing a `steps.js` that does not exist):

```ts
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { extractionTick } from "../../fixtures/extraction.js";
import { postInboundSms } from "../../fixtures/fakeTwilio.js";
import { reseed } from "../../fixtures/reseed.js";

const NEXT = process.env["E2E_DASHBOARD_URL"] ?? "http://127.0.0.1:5174";
const AGED = "2026-01-05T12:00:00.000Z";
const MARKER = 'EXTRACT:{"fields":{"pets":{"op":"write","value":"Two cats"}}}';

// devLoginAs / createContact / uniquePhone: copy from ai-run-log.spec.ts.
// The seeded staff user is founder@example.com (app/src/lib/seed/lean.ts:383);
// staff@example.com does not exist and dev-login will fail.

test("a manual run reads aged history that an automatic run cannot see", async ({ page, request }) => {
  await reseed(request); // every sibling spec starts from a known world
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createContact(request, { firstName: "Aged", type: "tenant" });

  // An ordinary inbound creates the conversation AND an automatic due row.
  // postInboundSms requires a messageSid (e2e/fixtures/fakeTwilio.ts:56).
  await postInboundSms(request, { from: phone, body: "hello", messageSid: `SM${Date.now()}` });
  const convId = await conversationIdFor(request, contactId);

  // Plant the marker on a message far outside the 30-day window.
  const planted = await request.post(`${NEXT}/__dev/extraction/message-fixture`, {
    data: { conversationId: convId, body: MARKER, createdAt: AGED, direction: "inbound" },
  });
  expect(planted.ok()).toBeTruthy();

  // NEGATIVE: the automatic run is due and DOES run - it just cannot see the
  // aged message, so it produces no suggestion. This is the assertion that
  // proves the age gate, not the absence of a run.
  await extractionTick(request);
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(page.getByText(/two cats/i)).toHaveCount(0);

  // POSITIVE: the manual run waives the floor and sees it.
  await page.getByRole("button", { name: /more actions/i }).click();
  await page.getByRole("menuitem", { name: /run ai extraction/i }).click();
  await expect(page.getByRole("status")).toContainText(/running ai extraction/i);

  await extractionTick(request);
  await expect(page.getByText(/two cats/i)).toBeVisible({ timeout: 15_000 });

  // And the run is recorded as manual.
  await page.goto(`${NEXT}/settings/ai-runs`);
  await expect(page.getByRole("heading", { name: "AI run log" })).toBeVisible();
  const rows = page.getByRole("list", { name: "AI runs" });
  await expect(rows.getByText(/manual/i).first()).toBeVisible();
});
```

**`conversationIdFor` does not exist - write it in this spec file.** Read the
contact-threads or conversations endpoint the dashboard itself calls
(`dashboard/src/api/endpoints.ts`) and hit the same path, e.g. GET the contact's
conversations and take the `tenant_1to1` one's id. Confirm the settings route
(`/settings/ai-runs`), the run-log heading ("AI run log"), the list's
accessible name ("AI runs" - `AiRunList.tsx:47`) and the kebab's accessible name
against the app before finalising.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run e2e`
Expected: FAIL - 404 on `/__dev/extraction/message-fixture`. (`npm run e2e -- --grep ...` does not forward flags through npm; run the suite, or invoke Playwright from the e2e workspace.)

- [ ] **Step 3: Implement the seam**

In `app/src/routes/dev.ts`, beside the transcript fixture:

```ts
  // POST /__dev/extraction/message-fixture - plant ONE message with an
  // arbitrary created_at. Hermetic-only, like every /__dev route.
  //
  // A direct doc-client write on purpose: MessagesRepo has no put(), and
  // append() hard-stamps created_at (messagesRepo.ts:1713). Widening a
  // production write path for a test-only need is the worse trade.
  router.post('/__dev/extraction/message-fixture', json(), async (req, res) => {
    const { conversationId, body, createdAt, direction } = req.body as {
      conversationId?: string; body?: string; createdAt?: string; direction?: 'inbound' | 'outbound';
    };
    if (!conversationId || !body || !createdAt) {
      res.status(400).json({ error: 'conversationId, body and createdAt are required' });
      return;
    }
    const dir = direction ?? 'inbound';
    const sid = `dev-${randomUUID()}`;
    const item = {
      conversationId,
      tsMsgId: `${createdAt}#${sid}`,
      type: 'sms',
      direction: dir,
      author: dir === 'inbound' ? 'tenant' : 'teammate',
      body,
      provider_sid: sid,
      provider_ts: createdAt,
      delivery_status: 'delivered',
      created_at: createdAt,
    };
    // Reuse the router-scoped client (dev.ts:176) rather than constructing a
    // second one - that one honours the injectable `deps.doc` the tests use.
    await doc.send(new PutCommand({ TableName: tableName('messages'), Item: item }));
    log.info({ conversationId, tsMsgId: item.tsMsgId }, 'dev message fixture planted');
    res.json({ tsMsgId: item.tsMsgId });
  });
```

Confirm the table base name against `tableName(...)`'s other uses in this file (`:304` uses `OUTBOX_TABLE_BASE`), reuse the router-scoped `doc` at `:176`, and import `PutCommand` from `@aws-sdk/lib-dynamodb` and `randomUUID` from `node:crypto` if not already present.

- [ ] **Step 4: Run the e2e**

Run: `npm run e2e`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/dev.ts e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts
git commit -m "test(extraction): prove a manual run reads aged history an automatic run cannot

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: File the latent hazards and close out

**Files:**
- Create: five files under `docs/issues/`

- [ ] **Step 1: Write each issue from `docs/issues/_TEMPLATE.md`**

Each states that it is pre-existing, not created by this feature, and its evidence line:

1. `extraction-driver-call-unbounded` - the Anthropic client is built with no `timeout` and no `maxRetries` (`app/src/adapters/extraction.ts:218`), inheriting a 10-minute timeout with 2 retries that themselves retry timeouts: roughly 30 minutes holding a claim.
2. `extraction-claimedat-stamped-from-poll-clock` - `claim` writes `claimedAt: nowIso` (`app/src/repos/extractionRepo.ts:270`), the poll-wide timestamp, so a later row in a long pass records a claim time already minutes stale. Harmless only because nothing reads it for logic.
3. `extraction-stranded-claim-no-reaper` - a process dying mid-run leaves the row claimed, out of the due index, with nothing to re-arm it.
4. `soft-deleted-contact-still-extractable` - this feature refuses the press (4.5); the job has no soft-delete check, so the automatic path still writes into a deleted contact.
5. `manual-extraction-bulk-backfill` - the deferred backfill, including the constraint that makes it more than a loop: newest-50 and the 60k budget mean a long imported history is never fully read.

- [ ] **Step 2: Regenerate the index**

Run: `npm run issues`
Expected: `docs/issues/INDEX.md` regenerated. It is gitignored - do not stage it.

- [ ] **Step 3: Sync main once, then run all three gates bare**

```bash
git fetch
git merge main --no-edit
npm run typecheck
npm test
npm run e2e
```

Record the exact exit codes. Honour the known flakes (`tour-reminders-panel-e2e-flake`, `conversationdetail-members-mock-suite-flake`): re-run once before blaming this branch, and report both runs.

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
| 4.1 flag, `requestId`, claim clears both | 1 |
| 4.1 conditional `fail`, park clears both | 2 |
| 4.2 both gate waivers | 3 |
| 4.3 nullable recorded age floor | 3 |
| 4.4 trigger from the flag, totality arm | 1 (forced early by the type change) |
| 4.4a arm-the-poll, no second runner | design of 1 + 5; nothing to build |
| 4.4b event, `requestId`, counts, emit path, ninth-event count | 4 |
| 4.5 endpoint, filter, refusals, partial commit, audit | 5 |
| 4.6 indicator states, timeout, copy | 6 |
| 4.8 surfaces | 1-6; typecheck is the enumerator |
| 7 unit tests | 1, 2, 3, 4, 5 |
| 7 dashboard tests | 6 |
| 7 e2e with a real negative | 7 |
| 9 out of scope, filed | 8 |

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N".

Several steps say "confirm X against the file" or "this does not exist - build
it". Those are deliberate and each names the exact file and property. The first
revision of this plan invented helper names wholesale and asserted they were
real; naming the uncertainty is the correction, and a builder must not inherit
the earlier habit.

**Three pieces of test infrastructure are BUILT by this plan, not assumed:**
`makeHarness`'s `jobEvents` recorder (Task 4 step 1), `createFakeWorld`'s
`failManualExtractionFor` set and `makeWebhookHarness`'s `aiExtractionEnabled`
option (Task 5 step 1), and the test file's `capturedHandlers` seam plus
`conversationIdFor` (Tasks 6 and 7).

**3. Type consistency.** `requestManualExtraction(conversationId, dueAt, requestId)` is identical in Tasks 1, 5. `fail(conversationId, error, nextDueAt, {claimed, listedDueAt, manual})` is defined in Task 2 and called with that shape in Task 2 step 5. `AiRunCompletedEvent` fields match across Task 4 (backend) and Task 6 (dashboard). `RunDraft.requestId` is set in Task 1 and read in Task 4; `.wrote`/`.suggested` set in Task 3, read in Task 4; `.claimed` set and read in Task 2.

**4. Known-good ordering.** Task 1 includes the `newRunDraft` change because making `channel` optional breaks it - without that, Task 1 cannot reach its own typecheck gate. Tasks 2 and 5 both depend only on Task 1 and touch disjoint code, so they can run in parallel. Task 4 needs Task 3's draft counts. Task 6 needs 4 and 5. Task 7 needs everything.

---

## Execution order

```
1 -> 2 ------------\
 \-> 3 -> 4 -------> 6 -> 7 -> 8
  \-> 5 -----------/
```
