# Retry Send Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No automatic retry of a carrier-30003 failure goes out more than 15 minutes after the original send; the screen says "will retry" only when a retry will be attempted, decided at the moment the failure is shown; a staff Retry is hidden and refused (409) while an automatic retry is pending; native group texts stop promising or queueing a retry; and the one-to-one retry follows the original send (its automated flag and its recipient).

**Architecture:** One pure module holds the window constants and checks, used at every scheduling point (the relay claim, the one-to-one decision, the relay transient re-enqueue) and at every send point (the relay job's last gate plus a bounded token-bucket acquire, the one-to-one job before its send). The relay claim previews the job's own gates through a shared evaluator and creates a declined rung already closed; the one-to-one webhook decides before it writes the failure and writes the promise (`retry_due_at`) in the same conditional write. The send wrapper records whether each one-to-one send was automated and its recipient, and both retry paths reuse them. The dashboard estimates the server's clock from the `Date` header and shows the one-to-one promise only while `retry_due_at` plus a grace is in the future on that clock.

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (AWS SDK v3; DynamoDB Local in tests), Vitest (app + dashboard workspaces), React 18 + Testing Library (dashboard), Playwright (e2e workspace, hermetic lane).

**Spec:** `docs/superpowers/specs/2026-09-24-retry-send-window-design.md` (draft 7 or later). Records: `docs/superpowers/reviews/2026-09-24-retry-send-window/` (the plan-draft findings `plan-draft-<A|B1|B2|C|D>-findings.md` explain every non-obvious choice below).

**Plan history:** v1 assembled from five slice drafts (skeleton `.superpowers/plan-drafts/skeleton.md`, gitignored), then adversarial plan review; see the adjudication files in the records folder.

## Global Constraints

- ASCII only in every new or touched line of source, tests, docs, log strings and test names (AGENTS.md). Verify a file with `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> `0`; for a file that already carries non-ASCII on lines you do not touch, check only your added lines (`git diff -U0 -- FILE | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`). Where a task must replace a region that contains a pre-existing non-ASCII character, it names the region by line range and its ASCII first and last lines: select it in the editor, never retype it.
- American English spelling in new prose and comments (color, behavior, summarize).
- Never rewrite a file with PowerShell `Get-Content | -replace | Set-Content`; use an edit tool.
- Commit explicit paths only (`git add <paths>`), read `git status` before every commit, commit with `git commit -m "<msg>" -- <paths>`; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model the session's attribution reminder names).
- No infrastructure, deploy, secret, SSM or `.env` change. No new dependency. No seed change (spec section 4: no seed writes retry fields).
- Never touch the human's live stack (`:5174` / `:8080`). Playwright only through the e2e workspace; hermetic lanes only.
- The lean seed's `contact-tenant-0002` / `conv-0002` (Dario Reyes, switched off on purpose) is NEVER the recipient of an automated text or retry in any new test or spec (spec D13).
- Copy, exact (spec section 7, approved): `Phone unreachable (error 30003)` (base, no promise); `Phone unreachable - will retry (error 30003)` (a one-to-one bubble with a live promise); `A retry is already scheduled for this message.` (409 `retry_pending` on the manual Retry); `Not retried - message too old` (the no-tail fallback for `retry_window_closed`; no current surface renders it). The gate copy `Not retried - group closed` / `no longer in this group` / `number changed since` / `opted out` is unchanged. The chip keeps its `<label> - <reason>` grammar and the Retry action keeps its accessible name `Retry sending this message`; "hidden" means NOT RENDERED, never `disabled`.
- Log levels (spec D9): a window decline is ERROR; a D3a skip, `gate_refused`, `already_claimed`, a missing or unparseable origin, and a failed read in the one-to-one decision are WARN; a missing conversation in the one-to-one decision is WARN (planner ruling: today's level); a failed read in the relay claim's preview is the existing `claim_failed` (ERROR, 5xx, Twilio redelivery). Every alarm threshold and the per-callback `delivery_failed` marker are unchanged.
- DynamoDB Local must be up for EVERY app vitest run, pure unit files included (`app/test/globalSetup.ts:50-80` fails the run otherwise): run `npm run db:start` from the worktree root once before Task 1 and keep it up.
- Test commands: app, one file: `cd app; npx vitest run test/<file>.test.ts`; dashboard, one file: `cd dashboard; npx vitest run src/<path>.test.ts(x)`; typecheck everything: `npm run typecheck` (worktree root; it type-checks tests too). Every task ends green on its own tests AND `npm run typecheck`.
- Gates (Task 21 only; bare, never piped, output redirected to a log): `npm run typecheck`, `npm test`, `npm run smoke`, `timeout 1500 npm run e2e` (Git Bash), and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` with baseline attribution against the merge base. Expected pre-existing gate-5 error: `dashboard/src/routes/contact/Timeline.tsx:1495` (`react-hooks/set-state-in-effect`), present on `main` @`da04d0cb`. After ANY aborted or killed e2e run, prove no listener survives on the lane's ports before another run (`reuseExistingServer` adopts an orphan on a commit match alone).
- Main sync (Cameron, 2026-09-25): `main` was merged at `f49a2fe9`. Task 21 merges `main` again ONLY if it has moved (`git rev-list --count HEAD..main` > 0), then re-runs every gate; later drift is reported, not chased.
- The e2e lane must be booted FRESH after Task 9 (`npm run e2e:restart` keeps the launcher's old `childEnv`, `scripts/e2e-session.mjs:109`, `:502`).

## Review Focus

Inputs the spec implies but the tasks' own tests would not exercise; each line names the owning task, which pins it with a test in its own step style (the steps marked "Review Focus").

1. A 30003 failure callback that arrives AFTER the text was already delivered (out-of-order callbacks): the forward-only status write refuses it, so nothing is stamped, nothing is enqueued, no decision line is logged, and the bubble stays "Delivered". Owner: Task 10 (Step 8b).
2. Two deliveries of the same 30003 callback processed concurrently: both decide, exactly one status write transitions, so there is exactly one stamp and one enqueued retry. Owner: Task 10 (Step 8b).
3. Rung 2 of a relay ladder whose rung 1 was claimed before this deploy (no `relay_retry_window_start` to carry): the claim cannot measure the window, so it claims the rung open with one WARN naming the gap - it never declines on a window it cannot measure (spec D5). Owner: Task 4 (Step 6b).
4. A text a staff member re-sent with the manual Retry that then fails 30003: that row has no `retry_attempt` and no `retry_window_start` (spec D2: a human chose to send now), so its automatic retry is attempt 1, measured from the manual send's own time, and - even on a breaker-tripped (manual-mode) thread - goes out as a person's send (spec D14). Owner: Task 10 (Step 8b).
5. A 30003 reported with `MessageStatus: failed` rather than `undelivered`: decided, stamped and retried exactly the same way (the decision's trigger is either failure status). Owner: Task 10 (Step 8b).

## File structure

New files:
- `app/src/lib/retrySendWindow.ts` - the window constants and pure checks (Task 1). No imports: the dashboard's mirror test imports it (Task 14).
- `app/src/lib/relayRetryGates.ts` - the relay retry job's four gates as one evaluator the job and the claim share (Task 3).
- `app/src/services/sendRefusalPreview.ts` - a pure preview of the one-to-one send wrapper's refusals for a given automated flag and recipient (Task 7).
- `app/src/services/oneToOneRetryDecision.ts` - the one-to-one retry decision (Task 10).
- `dashboard/src/api/serverClock.ts` - the server-clock estimate from the `Date` header (Task 14).
- `dashboard/src/routes/contact/retryPromise.ts` - the mirrored promise grace and `isRetryPromiseLive` (Task 14).
- `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` - the end-to-end proof (Task 19).
- Tests: `app/test/retrySendWindow.test.ts`, `app/test/relayRetryGates.test.ts`, `app/test/twilioWebhookHarnessRetryFields.test.ts`, `app/test/helpers/sendRefusalCases.ts`, `app/test/sendRefusalPreview.test.ts`, `app/test/retrySendBackoff.test.ts`, `app/test/oneToOneRetryDecision.test.ts`, `dashboard/src/api/serverClock.test.ts`, `dashboard/src/routes/contact/retryPromise.test.ts`, `dashboard/src/routes/contact/retryPromiseMirror.test.ts`.

Modified files (the task that owns each change):
- `app/src/repos/messagesRepo.ts` - the five new row fields, `updateDeliveryStatus`'s `retryDueAt` option, `MessageAnnotations.retryDueAt` (Task 2).
- `app/test/helpers/twilioWebhookHarness.ts` - the fakes mirror Task 2 (Task 2).
- `app/src/jobs/relayRetryLeg.ts` - the gates through the shared evaluator (Task 3); the window gate, the optional lineage field and the transient re-check (Task 5); the send deadline (Task 6).
- `app/src/lib/relayRetryClaim.ts` and `app/src/routes/webhooks/twilio.ts` - the relay claim decides at once (Task 4); the one-to-one call site kept green (Task 9); the one-to-one decision before the status write, the 30003 arm, native group text and the 30003 comments (Task 10).
- `app/src/jobs/relayFanOut.ts` - `sendOneRelayLeg`'s bounded acquire (Task 6).
- `app/src/services/sendMessage.ts` - the lineage inputs and the recorded send flags (Task 8).
- `app/src/jobs/retrySend.ts` - the backoff seam and `enqueueSendRetry(payload, runAt)` (Task 9); the window, lineage at append and the original send's flags (Task 11).
- `scripts/e2e-session.mjs` - `E2E_SEND_RETRY_BACKOFF_MS` in the lane `childEnv` (Task 9).
- `app/src/routes/api.ts` - the manual Retry's 409 and recorded recipient (Task 12).
- `app/src/routes/contactTimeline.ts`, `dashboard/src/api/types.ts` - `retry_due_at` on the timeline (Task 13).
- `dashboard/src/api/client.ts` - notes the `Date` header on every response (Task 14).
- `dashboard/src/routes/contact/deliveryStatus.ts` - `retryScheduled`, the base wording, the fallback copy, the comments (Task 15).
- `dashboard/src/routes/contact/relayRetryJoin.ts` - `retry_window_closed` carries no display code (Task 16).
- `dashboard/src/routes/contact/Timeline.tsx` - the live promise, Retry hidden, the ticker, the 409 copy (Task 17).
- Dashboard tests that pin the old wording (Tasks 15-18); docs and issues (Task 20); the build handback (Task 21).

## Slices, order and the mid-build states

Build strictly in task order; one writer on the tree.
1. Slice 1 - foundation: Task 1 (window module; Step 0 is `npm ci`), Task 2 (repository fields and the harness twins).
2. Slice 2 - relay: Tasks 3-6.
3. Slice 3 - one-to-one server: Tasks 7-13.
4. Slice 4 - dashboard: Tasks 14-18.
5. Slice 5 - proof and close: Tasks 19-21.

Stated aloud - the branch is not shippable between these points, and the per-task test runs are scoped so each task still ends green on its OWN tests and on `npm run typecheck`:
- Between Task 4 and Task 16, a rung closed `retry_window_closed` renders through the relay join as an unmapped code until Task 15 adds its fallback copy and Task 16 makes the join fall back to the original 30003.
- Between Task 15 and Tasks 17-18, four dashboard tests that pin the old shared 30003 wording are red by design (Task 15 names them: `Timeline.delivery.test.tsx:516` and `:577`, `Timeline.email.test.tsx:96`, `StatChips.test.tsx:134`); Tasks 17 and 18 move them, and Task 18 ends with the whole dashboard suite green.
- Between Task 10 and Task 14, the one-to-one chip still renders today's code-keyed "will retry" on EVERY 30003 (`deliveryStatus.ts:778`), declined retries included - over-promising, as today. From Task 15 until Task 17 the chip reads the new base wording but does not read the promise yet - under-promising only.
- Between Task 12 and Task 17, the server refuses a manual Retry with 409 `retry_pending` while the dashboard still shows the Retry button during the wait and maps that 409 to the generic "Couldn't send" copy (`Timeline.tsx:130`) until Task 17 maps it.

Line numbers in every task are at `f49a2fe9` (Tasks 10-11 say `fd38ba73`, a docs-only commit whose code is identical). Earlier tasks shift them; every edit is anchored on its quoted old text, which wins over the number.

Watch items - readers of retry lineage the spec (section 4) lists, checked in plan review round 1 and needing NO code change (a builder who touches one re-checks it):
- `app/src/routes/webhooks/twilio.ts:3129` (the relay-escalation gate on `relay_retry_of`) and `app/src/repos/messagesRepo.ts:2335` (the media-pointer guard): read fields this branch does not change.
- `dashboard/src/routes/contact/relayRetryJoin.ts:135-164` and `:453`: read `relay_retry_*` lineage only; Task 16 changes the terminal step alone.
- `dashboard/src/routes/conversation/useRelayThread.ts:101-142` (a fixed field list shared with `useGroupThread` via `buildRelayItems`): drops `retry_due_at` and `relay_retry_window_start` - harmless, and it keeps a fail-open stamp on a group text off the group view.
- `dashboard/src/routes/contact/Timeline.tsx:1077`, `:1975-1984`, `:2004-2019` (the `retry_of` supersession collapse): D6 writes `retry_of` at append instead of milliseconds later, so the collapse is unchanged.
- `dashboard/src/api/types.ts:2308-2315` and `:2509-2515` (the relay lineage fields on the wire types): unchanged; Task 13 adds `retry_due_at` only.

---

### Task 1: Send-window constants and pure helpers (spec D1, D2, D3, D4, D5, D10)

**Files:**
- Create: `app/src/lib/retrySendWindow.ts`
- Test: `app/test/retrySendWindow.test.ts` (new)

**Interfaces:**
- Consumes: nothing. Pure module - no clock, no I/O, no imports.
- Produces (the skeleton contract, exactly):
  ```ts
  export const RETRY_SEND_WINDOW_MS = 15 * 60_000;
  export const RETRY_JOB_GRACE_MS = 60_000;
  export const RETRY_PROMISE_GRACE_MS = 2 * 60_000;
  export const RETRY_PROMISE_WITHDRAWN_AT = '1970-01-01T00:00:00.000Z';
  export function parseRetryWindowOrigin(value: unknown): number | undefined;
  export function retryFitsSendWindow(args: { originMs: number; nowMs: number; backoffMs: number }): boolean;
  export function withinRetrySendWindow(args: { originMs: number; nowMs: number }): boolean;
  export function retrySendDeadlineMs(originMs: number): number;
  export function isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean;
  ```
  Consumers: Tasks 4, 5, 6 (relay), 10, 11, 12 (one-to-one server); Task 14 mirrors `RETRY_PROMISE_GRACE_MS` in the dashboard.

- [ ] **Step 0: Install dependencies (the worktree has no node_modules)**

Run from the worktree root `W:\tmp\retry-send-window`: `npm ci`
Expected: exit 0; `node_modules` populated at the root and in the workspaces. Then start DynamoDB Local: `npm run db:start` (Docker must be running). `app/test/globalSetup.ts:14-17` and `:69-88` FAIL every app vitest run without it - pure unit files included - unless `ALLOW_SKIP_DYNAMO_TESTS=1`, which is not a completion gate. Keep it up for the whole build.

- [ ] **Step 1: Write the failing test (spec D1-D5, D10; test intention 1)**

Create `app/test/retrySendWindow.test.ts`:

```ts
// The 15-minute send window for AUTOMATIC retries of a carrier-30003 failure
// (retry-send-window spec D1-D5, D10; test intention 1). Pure helpers: every
// case injects its own clock (D13).
import { describe, expect, it } from 'vitest';
import {
  RETRY_JOB_GRACE_MS,
  RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
  RETRY_SEND_WINDOW_MS,
  isRetryPromiseLive,
  parseRetryWindowOrigin,
  retryFitsSendWindow,
  retrySendDeadlineMs,
  withinRetrySendWindow,
} from '../src/lib/retrySendWindow.js';

const MIN = 60_000;
/** A fixed origin: the original send, Friday 2026-09-25 12:00:00 UTC. */
const ORIGIN_ISO = '2026-09-25T12:00:00.000Z';
const ORIGIN = Date.parse(ORIGIN_ISO);

describe('retrySendWindow constants (spec D1, D3, D7, D10)', () => {
  it('pins the window, the scheduling grace, the promise grace and the withdrawn stamp', () => {
    expect(RETRY_SEND_WINDOW_MS).toBe(15 * MIN);
    expect(RETRY_JOB_GRACE_MS).toBe(1 * MIN);
    expect(RETRY_PROMISE_GRACE_MS).toBe(2 * MIN);
    expect(RETRY_PROMISE_WITHDRAWN_AT).toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(RETRY_PROMISE_WITHDRAWN_AT)).toBe(0);
  });
});

describe('parseRetryWindowOrigin (spec D2, D5)', () => {
  it('parses an ISO 8601 origin', () => {
    expect(parseRetryWindowOrigin(ORIGIN_ISO)).toBe(ORIGIN);
  });

  it('parses an RFC 2822 origin to the same instant, offsets included', () => {
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 12:00:00 +0000')).toBe(ORIGIN);
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 12:00:00 GMT')).toBe(ORIGIN);
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 08:00:00 -0400')).toBe(ORIGIN);
  });

  // undefined is the FAIL-OPEN signal (D5): the caller skips the window check
  // and logs a WARN naming the gap. It never throws.
  it.each<[string, unknown]>([
    ['an absent', undefined],
    ['an empty', ''],
    ['a whitespace-only', '   '],
    ['a garbage', 'not-a-date'],
    ['an impossible-date', '2026-13-45T00:00:00Z'],
  ])('returns undefined for %s origin', (_label, value) => {
    expect(parseRetryWindowOrigin(value)).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a number (epoch ms)', ORIGIN],
    ['null', null],
    ['a Date object', new Date(ORIGIN)],
    ['a plain object', { at: ORIGIN_ISO }],
    ['a boolean', true],
  ])('returns undefined for a non-string origin: %s', (_label, value) => {
    expect(parseRetryWindowOrigin(value)).toBeUndefined();
  });
});

describe('retryFitsSendWindow - scheduling (spec D3, D3a): only with the grace to spare', () => {
  it('allows a rung whose send time plus the grace lands EXACTLY on the window end', () => {
    // 13 min in + 1 min backoff + 1 min grace = 15 min: allowed (<=).
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 13 * MIN, backoffMs: 1 * MIN }),
    ).toBe(true);
  });

  it('refuses the same rung one millisecond later', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 13 * MIN + 1, backoffMs: 1 * MIN }),
    ).toBe(false);
  });

  it('spends the grace: a rung that would go out inside the window but in its last minute is refused', () => {
    // Would send at 14:30 - inside the window - but 14:30 + 1:00 grace > 15:00.
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 12.5 * MIN, backoffMs: 2 * MIN }),
    ).toBe(false);
  });

  it('measures each rung by its own backoff: a 4-minute rung fits at 10 minutes in, not 1 ms later', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 10 * MIN, backoffMs: 4 * MIN }),
    ).toBe(true);
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 10 * MIN + 1, backoffMs: 4 * MIN }),
    ).toBe(false);
  });

  it('allows a normal early ladder (D1: first failure within a minute)', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 1 * MIN, backoffMs: 1 * MIN }),
    ).toBe(true);
  });
});

describe('withinRetrySendWindow - job time (spec D4): strict, the grace already spent', () => {
  it('allows a send at EXACTLY 15 minutes after the origin', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 15 * MIN })).toBe(true);
  });

  it('refuses a send one millisecond past 15 minutes', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 15 * MIN + 1 })).toBe(false);
  });

  it('allows a send whose clock reads before the origin', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN - 5_000 })).toBe(true);
  });
});

describe('retrySendDeadlineMs (spec D4 - the bounded acquire deadline)', () => {
  it('is the window end, and the job-time check agrees on that last instant', () => {
    expect(retrySendDeadlineMs(ORIGIN)).toBe(ORIGIN + 15 * MIN);
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: retrySendDeadlineMs(ORIGIN) })).toBe(true);
  });
});

describe('isRetryPromiseLive (spec D10 - the server guard)', () => {
  const DUE_ISO = '2026-09-25T12:05:00.000Z';
  const DUE = Date.parse(DUE_ISO);

  it('is live until retry_due_at plus the 2-minute grace, strictly', () => {
    expect(isRetryPromiseLive(DUE_ISO, DUE)).toBe(true);
    expect(isRetryPromiseLive(DUE_ISO, DUE + 2 * MIN - 1)).toBe(true);
    expect(isRetryPromiseLive(DUE_ISO, DUE + 2 * MIN)).toBe(false);
  });

  it('is live before the due time too', () => {
    expect(isRetryPromiseLive(DUE_ISO, DUE - 3 * MIN)).toBe(true);
  });

  it('is false with no retry_due_at, or an unparseable one', () => {
    expect(isRetryPromiseLive(undefined, DUE)).toBe(false);
    expect(isRetryPromiseLive('', DUE)).toBe(false);
    expect(isRetryPromiseLive('not-a-date', DUE)).toBe(false);
  });

  it('is false for a WITHDRAWN promise (D7 enqueue failure) at any real time', () => {
    expect(isRetryPromiseLive(RETRY_PROMISE_WITHDRAWN_AT, DUE)).toBe(false);
    expect(isRetryPromiseLive(RETRY_PROMISE_WITHDRAWN_AT, Date.parse('2000-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('parses an RFC 2822 retry_due_at', () => {
    expect(isRetryPromiseLive('Fri, 25 Sep 2026 12:05:00 GMT', DUE + 1 * MIN)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/retrySendWindow.test.ts`
Expected: FAIL - the suite cannot import `../src/lib/retrySendWindow.js` (module not found); no test runs.

- [ ] **Step 3: Implement the module (spec D1, D3, D4, D5, D7, D10)**

Create `app/src/lib/retrySendWindow.ts`:

```ts
// retrySendWindow - the 15-minute send window for AUTOMATIC retries of a
// carrier-30003 failure (retry-send-window spec D1-D5, D10).
//
// Cameron's ruling on relay-30003 Q4: nothing re-sends a text more than 15
// minutes after the original went out. The window measures when a retry GOES
// OUT, not when the failure arrives. It limits the two machine-initiated
// resend paths only - the relay retry ladder and the one-to-one
// `messaging.retrySend` chain; a staff member's manual Retry is a new send.
//
// PURE: no clock and no I/O. Every caller passes `nowMs`, so tests inject the
// clock (D13) and the webhook, the jobs and the manual route all judge with
// the same arithmetic.

/** D1: how long after the original send an automatic retry may still go out. */
export const RETRY_SEND_WINDOW_MS = 15 * 60_000;

/**
 * D3/D3a: the scheduling margin. A retry is scheduled only if it would go out
 * with this much of the window to spare, absorbing queue delay; the job-time
 * check (D4) is then strict, because the grace was spent at scheduling.
 */
export const RETRY_JOB_GRACE_MS = 60_000;

/**
 * D8/D10: how long past its `retry_due_at` a one-to-one retry promise stays
 * live - on screen ("will retry") and in the manual Retry guard (409
 * `retry_pending`). Mirrored in the dashboard and pinned by a test (Task 14).
 */
export const RETRY_PROMISE_GRACE_MS = 2 * 60_000;

/** Written over retry_due_at when a promise must be withdrawn (D7 enqueue failure). */
export const RETRY_PROMISE_WITHDRAWN_AT = '1970-01-01T00:00:00.000Z';

/** ms since epoch, or undefined when absent / not a string / unparseable (D5 fail-open).
 *  Accepts ISO 8601 and RFC 2822 (Date.parse). */
export function parseRetryWindowOrigin(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Scheduling (D3, D3a): nowMs + backoffMs + RETRY_JOB_GRACE_MS <= originMs + RETRY_SEND_WINDOW_MS */
export function retryFitsSendWindow(args: {
  originMs: number;
  nowMs: number;
  backoffMs: number;
}): boolean {
  return args.nowMs + args.backoffMs + RETRY_JOB_GRACE_MS <= args.originMs + RETRY_SEND_WINDOW_MS;
}

/** Job time (D4), strict: nowMs <= originMs + RETRY_SEND_WINDOW_MS */
export function withinRetrySendWindow(args: { originMs: number; nowMs: number }): boolean {
  return args.nowMs <= args.originMs + RETRY_SEND_WINDOW_MS;
}

/** originMs + RETRY_SEND_WINDOW_MS (the bounded acquire's deadline, D4) */
export function retrySendDeadlineMs(originMs: number): number {
  return originMs + RETRY_SEND_WINDOW_MS;
}

/** Server-side promise liveness (D10 guard): nowMs < Date.parse(retryDueAt) + RETRY_PROMISE_GRACE_MS;
 *  false for undefined or unparseable. */
export function isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean {
  if (typeof retryDueAt !== 'string') return false;
  const dueMs = Date.parse(retryDueAt);
  if (!Number.isFinite(dueMs)) return false;
  return nowMs < dueMs + RETRY_PROMISE_GRACE_MS;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd app; npx vitest run test/retrySendWindow.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/lib/retrySendWindow.ts app/test/retrySendWindow.test.ts
git commit -m "feat(retry-window): send-window constants and pure helpers (spec D1-D5, D10)

RETRY_SEND_WINDOW_MS (15 min), RETRY_JOB_GRACE_MS (60 s), RETRY_PROMISE_GRACE_MS
(2 min) and the withdrawn stamp; origin parsing that fails open (ISO and RFC
2822), the scheduling check with the grace, the strict job-time check, the
bounded-acquire deadline and server-side promise liveness. Pure; callers pass
the clock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/lib/retrySendWindow.ts app/test/retrySendWindow.test.ts
```

Expected: typecheck exit 0; `git status` shows only the two new files staged before the commit.

---


### Task 2: Message repository fields and the harness twins (spec D2, D6, D7, D14)

**Files:**
- Modify: `app/src/repos/messagesRepo.ts:725-732` (`NewMessage.retryOf` doc, D12, plus four new one-to-one fields), `:737-740` (the relay block's value-count comment), `:758` (`relayRetryLegBody`, new `relayRetryWindowStart` after it), `:1000` and `:1016` (`MessageItem`), `:1173-1177` (`MessageAnnotations`), `:1261` (`MessagesRepo.updateDeliveryStatus`), `:1405` (`annotateMessage` doc), `:2262-2284` (the real `append`'s item, D12 comment at `:2262-2264`), `:2541-2580` (`updateDeliveryStatus`), `:2916-2920` and `:2935-2938` (`annotateMessage`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts:1130-1152` (fake `append` allowlist), `:1213-1220` (fake `updateDeliveryStatus`), `:1343` (fake `annotateMessage`)
- Create: `app/test/twilioWebhookHarnessRetryFields.test.ts`
- Test: `app/test/messaging.integration.test.ts` (import after `:17`; new cases inserted before `:213`), `app/test/messagesRepoRetryLineage.integration.test.ts` (new case before the file's closing `:243`)

**Interfaces:**
- Consumes: Task 1's `RETRY_PROMISE_WITHDRAWN_AT` from `app/src/lib/retrySendWindow.ts` (tests only).
- Produces:
  - `NewMessage` gains `retryAttempt?: number; retryWindowStart?: string; automated?: boolean; recipientContactId?: string; relayRetryWindowStart?: string;` (`retryOf?: string` exists). The real `append` writes them as `retry_attempt`, `retry_window_start`, `automated`, `recipient_contact_id`, `relay_retry_window_start`, each only when defined; `automated` is written for `false` too.
  - `MessageItem` gains `retry_window_start?: string; retry_due_at?: string; automated?: boolean; recipient_contact_id?: string; relay_retry_window_start?: string;` (`retry_attempt` exists).
  - `updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string, options?: { retryDueAt?: string }): Promise<boolean>` - when `options.retryDueAt` is set, `retry_due_at` is SET in the SAME conditional `UpdateCommand` as the status, so it lands only if the transition does.
  - `MessageAnnotations` gains `retryDueAt?: string` (SET `retry_due_at`).
  - Harness (`app/test/helpers/twilioWebhookHarness.ts`): the fake `append` carries all five new fields; the fake `updateDeliveryStatus` honors `options.retryDueAt` only on a transition; the fake `annotateMessage` honors `retryDueAt`.
  - Unchanged, and must compile as they are (they pass no options): `app/src/services/emailEvents.ts:177`, `:182`; `app/src/services/groupReceipts.ts:354`; `app/src/services/relayQueuedMessages.ts:89`; `app/src/services/sendEmailMessage.ts:477`, `:510`; `app/src/routes/webhooks/twilio.ts:3251` (Task 10 adds the options there); and the `MessagesRepo` test fakes (`app/test/sendMessage.test.ts:239`, `app/test/scheduledSendSuppression.test.ts:281`, `app/test/relayProvisioning.test.ts:364`, `:514`, `app/test/groupReceipts.test.ts:135`, `app/test/emailEvents.test.ts:73`, `app/test/sendEmailMessage.test.ts:84`).

- [ ] **Step 1: Write the failing harness-double test**

Create `app/test/twilioWebhookHarnessRetryFields.test.ts` (the pattern of `app/test/twilioWebhookHarnessMediaIndex.test.ts`: `createFakeWorld()` from `./helpers/twilioWebhookHarness.js`, the FAKE under test):

```ts
// The harness FAKE's retry-send-window fields, pinned (spec section 4,
// "Repository and test doubles").
//
// WHY THIS FILE EXISTS. The fake `append` is an explicit field ALLOWLIST
// (twilioWebhookHarness.ts), so a field the real repo persists but the fake
// drops reads back as undefined - and a webhook or job test asserting that a
// retry "carries the chain's origin" or "follows the original send" would then
// pass VACUOUSLY through its fallback (`retry_window_start ?? provider_ts`,
// `automated ?? true`). The fake `updateDeliveryStatus` must land
// `retry_due_at` ONLY with a transition (spec D7), and the fake
// `annotateMessage` must write it for the enqueue-failure withdrawal. The real
// repo is covered against DynamoDB Local (messaging.integration.test.ts,
// messagesRepoRetryLineage.integration.test.ts); neither can see the double.
import { describe, expect, it } from 'vitest';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import type { NewMessage } from '../src/repos/messagesRepo.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const CONV = 'conv-rsw-harness';
const DUE = '2026-09-25T12:01:00.000Z';

function outbound(providerSid: string, providerTs: string): NewMessage {
  return {
    conversationId: CONV,
    providerSid,
    providerTs,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'hello',
    deliveryStatus: 'queued',
  };
}

describe('twilioWebhookHarness fake - retry-send-window fields', () => {
  it('append carries the four one-to-one fields - automated FALSE included', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append({
      ...outbound('SMrswfake0001', '2026-09-25T12:00:00.000Z'),
      retryOf: '2026-09-25T11:58:00.000Z#SMrswfake0000',
      retryAttempt: 2,
      retryWindowStart: '2026-09-25T11:58:00.000Z',
      automated: false,
      recipientContactId: 'c-real',
    });
    const row = await world.messagesRepo.getByTsMsgId(CONV, res.tsMsgId);
    expect(row).toMatchObject({
      retry_of: '2026-09-25T11:58:00.000Z#SMrswfake0000',
      retry_attempt: 2,
      retry_window_start: '2026-09-25T11:58:00.000Z',
      recipient_contact_id: 'c-real',
    });
    // `false` must be STORED: a row without the flag is retried as automated.
    expect(row).toHaveProperty('automated', false);
  });

  it('append carries the relay window origin on a retry row', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append({
      ...outbound('relayretry-deadbeefdeadbeef-2', '2026-09-25T12:02:00.000Z'),
      relayRetryOf: '2026-09-25T12:00:00.000Z#SMrswroot',
      relayRetryMemberKey: 'c-bob',
      relayRetryAttempt: 2,
      relayRetryDestDigest: 'deadbeefdeadbeef',
      relayRetryOriginDirection: 'outbound',
      relayRetryLegBody: 'Sam: hello',
      relayRetryWindowStart: '2026-09-25T12:00:03.000Z',
    });
    expect(
      (await world.messagesRepo.getByTsMsgId(CONV, res.tsMsgId))?.relay_retry_window_start,
    ).toBe('2026-09-25T12:00:03.000Z');
  });

  it('append writes none of the five when they are absent, and automated TRUE when true', async () => {
    const world = createFakeWorld();
    const plain = await world.messagesRepo.append(outbound('SMrswfake0003', '2026-09-25T12:03:00.000Z'));
    const row = await world.messagesRepo.getByTsMsgId(CONV, plain.tsMsgId);
    for (const field of [
      'retry_attempt',
      'retry_window_start',
      'automated',
      'recipient_contact_id',
      'relay_retry_window_start',
    ]) {
      expect(row).not.toHaveProperty(field);
    }
    const auto = await world.messagesRepo.append({
      ...outbound('SMrswfake0004', '2026-09-25T12:04:00.000Z'),
      automated: true,
    });
    expect(await world.messagesRepo.getByTsMsgId(CONV, auto.tsMsgId)).toHaveProperty('automated', true);
  });

  it('updateDeliveryStatus lands retry_due_at WITH a transition and a redelivery moves nothing (D7)', async () => {
    const world = createFakeWorld();
    await world.messagesRepo.append(outbound('SMrswfake0005', '2026-09-25T12:05:00.000Z'));
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0005', 'failed', '30003', { retryDueAt: DUE }),
    ).toBe(true);
    expect(await world.messagesRepo.getByProviderSid('SMrswfake0005')).toMatchObject({
      delivery_status: 'failed',
      error_code: '30003',
      retry_due_at: DUE,
    });
    // A redelivered callback transitions nothing and must not move the promise.
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0005', 'failed', '30003', {
        retryDueAt: '2026-09-25T12:09:00.000Z',
      }),
    ).toBe(false);
    expect((await world.messagesRepo.getByProviderSid('SMrswfake0005'))?.retry_due_at).toBe(DUE);
  });

  it('a REGRESSING failure writes no retry_due_at (D7)', async () => {
    const world = createFakeWorld();
    await world.messagesRepo.append(outbound('SMrswfake0006', '2026-09-25T12:06:00.000Z'));
    expect(await world.messagesRepo.updateDeliveryStatus('SMrswfake0006', 'delivered')).toBe(true);
    expect(
      await world.messagesRepo.updateDeliveryStatus('SMrswfake0006', 'undelivered', '30003', { retryDueAt: DUE }),
    ).toBe(false);
    const row = await world.messagesRepo.getByProviderSid('SMrswfake0006');
    expect(row?.delivery_status).toBe('delivered');
    expect(row).not.toHaveProperty('retry_due_at');
  });

  it('annotateMessage re-writes retry_due_at - the enqueue-failure withdrawal (D7)', async () => {
    const world = createFakeWorld();
    const res = await world.messagesRepo.append(outbound('SMrswfake0007', '2026-09-25T12:07:00.000Z'));
    await world.messagesRepo.updateDeliveryStatus('SMrswfake0007', 'failed', '30003', { retryDueAt: DUE });
    await world.messagesRepo.annotateMessage(CONV, res.tsMsgId, { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT });
    expect(await world.messagesRepo.getByProviderSid('SMrswfake0007')).toMatchObject({
      retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
      delivery_status: 'failed',
    });
  });
});
```

- [ ] **Step 2: Write the failing DynamoDB Local cases**

In `app/test/messaging.integration.test.ts`, add directly after `import { createLogger } from '../src/lib/logger.js';` (`:17`):

```ts
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
```

Then insert immediately BEFORE the line `    it('listByConversation pages newest-first and never returns sid pointer items', async () => {` (`:213`, inside `describe('messagesRepo', ...)`, which already declares `convId` and uses the file's `outbound()` builder, `:44-55`):

```ts
    // --- retry-send-window (spec D6, D7, D14) ---------------------------------
    it('retry-send-window D6/D14: append writes the one-to-one lineage, the window origin and the send flags - automated FALSE included', async () => {
      const res = await messages.append({
        ...outbound(convId, 'SMrswappend1', '2026-06-12T10:20:00.000Z', 'retry body'),
        retryOf: '2026-06-12T10:03:00.000Z#SMfail1',
        retryAttempt: 2,
        retryWindowStart: '2026-06-12T10:03:00.000Z',
        automated: false,
        recipientContactId: 'contact-rsw-1',
      });
      const row = await messages.getByTsMsgId(convId, res.tsMsgId);
      expect(row).toMatchObject({
        retry_of: '2026-06-12T10:03:00.000Z#SMfail1',
        retry_attempt: 2,
        retry_window_start: '2026-06-12T10:03:00.000Z',
        recipient_contact_id: 'contact-rsw-1',
      });
      // `false` must be STORED, not dropped: a row without the flag is retried
      // as automated (the pre-deploy default, spec D14).
      expect(row).toHaveProperty('automated', false);
    });

    it('retry-send-window D14: append writes automated TRUE, and none of the new fields when they are absent', async () => {
      const auto = await messages.append({
        ...outbound(convId, 'SMrswappend2', '2026-06-12T10:21:00.000Z', 'a reminder'),
        automated: true,
      });
      expect(await messages.getByTsMsgId(convId, auto.tsMsgId)).toHaveProperty('automated', true);

      const plain = await messages.append(outbound(convId, 'SMrswappend3', '2026-06-12T10:22:00.000Z', 'plain'));
      const row = await messages.getByTsMsgId(convId, plain.tsMsgId);
      for (const field of [
        'retry_attempt',
        'retry_window_start',
        'automated',
        'recipient_contact_id',
        'relay_retry_window_start',
        'retry_due_at',
      ]) {
        expect(row).not.toHaveProperty(field);
      }
    });

    it('retry-send-window D7: updateDeliveryStatus lands retry_due_at in the SAME conditional write as the transition, and a redelivery moves nothing', async () => {
      await messages.append(outbound(convId, 'SMrswdue1', '2026-06-12T10:23:00.000Z', 'will fail'));
      expect(
        await messages.updateDeliveryStatus('SMrswdue1', 'failed', '30003', {
          retryDueAt: '2026-06-12T10:24:00.000Z',
        }),
      ).toBe(true);
      expect(await messages.getByProviderSid('SMrswdue1')).toMatchObject({
        delivery_status: 'failed',
        error_code: '30003',
        retry_due_at: '2026-06-12T10:24:00.000Z',
      });
      // Twilio redelivers the same callback: no transition, so no new promise.
      expect(
        await messages.updateDeliveryStatus('SMrswdue1', 'failed', '30003', {
          retryDueAt: '2026-06-12T10:30:00.000Z',
        }),
      ).toBe(false);
      expect((await messages.getByProviderSid('SMrswdue1'))?.retry_due_at).toBe(
        '2026-06-12T10:24:00.000Z',
      );
    });

    it('retry-send-window D7: a REGRESSING failure writes no retry_due_at, and the no-options call shape writes none', async () => {
      await messages.append(outbound(convId, 'SMrswdue2', '2026-06-12T10:25:00.000Z', 'delivered first'));
      expect(await messages.updateDeliveryStatus('SMrswdue2', 'delivered')).toBe(true);
      expect(
        await messages.updateDeliveryStatus('SMrswdue2', 'undelivered', '30003', {
          retryDueAt: '2026-06-12T10:26:00.000Z',
        }),
      ).toBe(false);
      const regressed = await messages.getByProviderSid('SMrswdue2');
      expect(regressed?.delivery_status).toBe('delivered');
      expect(regressed).not.toHaveProperty('retry_due_at');

      await messages.append(outbound(convId, 'SMrswdue3', '2026-06-12T10:26:00.000Z', 'plain failure'));
      expect(await messages.updateDeliveryStatus('SMrswdue3', 'failed', '30003')).toBe(true);
      expect(await messages.getByProviderSid('SMrswdue3')).not.toHaveProperty('retry_due_at');
      // An unknown SID stays a quiet no-op with options too.
      expect(
        await messages.updateDeliveryStatus('SMrswghost', 'failed', '30003', {
          retryDueAt: '2026-06-12T10:27:00.000Z',
        }),
      ).toBe(false);
    });

    it('retry-send-window D7: builds the conditional write with retry_due_at and NO error code', async () => {
      await messages.append(outbound(convId, 'SMrswdue4', '2026-06-12T10:27:00.000Z', 'no code'));
      expect(
        await messages.updateDeliveryStatus('SMrswdue4', 'failed', undefined, {
          retryDueAt: '2026-06-12T10:28:00.000Z',
        }),
      ).toBe(true);
      const row = await messages.getByProviderSid('SMrswdue4');
      expect(row?.retry_due_at).toBe('2026-06-12T10:28:00.000Z');
      expect(row).not.toHaveProperty('error_code');
    });

    it('retry-send-window D7: annotateMessage re-writes retry_due_at - the enqueue-failure withdrawal', async () => {
      await messages.append(outbound(convId, 'SMrswann1', '2026-06-12T10:28:00.000Z', 'withdraw me'));
      await messages.updateDeliveryStatus('SMrswann1', 'failed', '30003', {
        retryDueAt: '2026-06-12T10:29:00.000Z',
      });
      await messages.annotateMessage(convId, '2026-06-12T10:28:00.000Z#SMrswann1', {
        retryDueAt: RETRY_PROMISE_WITHDRAWN_AT,
      });
      expect(await messages.getByProviderSid('SMrswann1')).toMatchObject({
        retry_due_at: RETRY_PROMISE_WITHDRAWN_AT,
        delivery_status: 'failed', // the failure itself is untouched
        body: 'withdraw me',
      });
    });

```

In `app/test/messagesRepoRetryLineage.integration.test.ts`, replace the file's last three lines (`:241-243`):

```ts
    expect(row?.delivery_recipients?.[MEMBER]?.transportAggregationState).toBeUndefined();
  });
});
```

with:

```ts
    expect(row?.delivery_recipients?.[MEMBER]?.transportAggregationState).toBeUndefined();
  });

  // retry-send-window D2/D5: the member's ORIGINAL leg send time rides every
  // rung as relay_retry_window_start. It is OPTIONAL: a rung claimed before the
  // field existed has none and must still append (the job then skips the
  // window check, with a WARN).
  it('round-trips the carried window origin, and appends a row without it', async () => {
    const withOrigin = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675316'), 2),
        providerTs: '2026-09-02T10:10:00.000Z',
        relayRetryAttempt: 2,
        relayRetryWindowStart: '2026-09-02T10:00:04.000Z',
      }),
    );
    expect((await messages.getByTsMsgId(CONV, withOrigin.tsMsgId))?.relay_retry_window_start).toBe(
      '2026-09-02T10:00:04.000Z',
    );

    const without = await messages.append(
      retryRow({
        providerSid: relayRetryProviderSid(relayRetryDigest(ROOT, '+15558675317'), 1),
        providerTs: '2026-09-02T10:11:00.000Z',
      }),
    );
    expect(await messages.getByTsMsgId(CONV, without.tsMsgId)).not.toHaveProperty(
      'relay_retry_window_start',
    );
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run (DynamoDB Local must be up - `npm run db:start` - because `app/test/globalSetup.ts` fails the run without it): `cd app; npx vitest run test/twilioWebhookHarnessRetryFields.test.ts test/messaging.integration.test.ts test/messagesRepoRetryLineage.integration.test.ts`
Expected: FAIL. In the harness file, 'append carries the four one-to-one fields', 'append carries the relay window origin', the TRUE half of 'append writes none of the five...', 'updateDeliveryStatus lands retry_due_at...' and 'annotateMessage re-writes retry_due_at...' fail (the fields read back undefined); 'a REGRESSING failure writes no retry_due_at' already passes and stays as a pin. In the integration files every new case fails the same way except 'a REGRESSING failure writes no retry_due_at, and the no-options call shape writes none' (a pin). `npm run typecheck` would also fail today (unknown `NewMessage` / `MessageAnnotations` properties, a fourth `updateDeliveryStatus` argument).

- [ ] **Step 4: Implement the repository fields and writes (`app/src/repos/messagesRepo.ts`)**

4a. `NewMessage` - replace the `retryOf` doc and field (`:725-732`, spec D12: its "the 30003 auto-retry job sets retry_of via annotateMessage instead" becomes false under D6). Old:

```ts
  /**
   * Manual retry (dashboard Retry button): the tsMsgId of the FAILED message this
   * send supersedes. Stamped as `retry_of` at append so the timeline can collapse
   * the stale failed bubble atomically (no annotate-after race). The 30003
   * auto-retry job sets retry_of via annotateMessage instead (it also writes
   * retry_attempt for the chain cap).
   */
  retryOf?: string;
```

New:

```ts
  /**
   * Retry lineage, stamped AT APPEND so the new row carries it atomically (no
   * annotate-after race): the tsMsgId of the FAILED message this send
   * supersedes, which the timeline collapses. The manual Retry passes it
   * alone; the automatic 30003 retry passes it together with retryAttempt and
   * retryWindowStart (retry-send-window D6).
   */
  retryOf?: string;
  /**
   * retry-send-window D6: the 1-based attempt number of an automatic 30003
   * retry, stored as `retry_attempt` - the field the next 30003 callback reads
   * for the chain cap, so it exists the moment the row does.
   */
  retryAttempt?: number;
  /**
   * retry-send-window D2/D6: the ORIGIN of the automatic 30003 retry chain (the
   * first send's provider_ts), stored as `retry_window_start` on every automatic
   * retry row so attempts 2 and 3 still measure the 15-minute window from the
   * first send. Never on a manual Retry: a human chose to send now.
   */
  retryWindowStart?: string;
  /**
   * retry-send-window D14: whether the one-to-one send that appended this row
   * was automated. Stored as `automated`, FALSE INCLUDED - a row without it
   * (written before the field existed) is retried as automated. The send
   * wrapper (services/sendMessage.ts) sets it on every row it appends; no other
   * writer does.
   */
  automated?: boolean;
  /**
   * retry-send-window D14: the contact the caller named as the recipient (the
   * send wrapper's `recipient`, share-skip-fix I8), stored as
   * `recipient_contact_id` so a retry judges that same contact. Absent when the
   * phone lookup decided.
   */
  recipientContactId?: string;
```

4b. The relay block's comment (`:737-740`) counts six values; a seventh joins it. Old:

```ts
  // retries. Six values stored; the dashboard PROJECTS four (D11). All six
  // reach the browser - GET /conversations/:id/messages returns the row as-is -
  // so "projected" is the honest word and "on the wire" is not. Absent on every
  // other message - a row carrying relayRetryOf IS a retry row.
```

New:

```ts
  // retries. Six lineage values stored, plus the window origin retry-send-window
  // adds (relayRetryWindowStart, D2); the dashboard PROJECTS four (D11). All of
  // them reach the browser - GET /conversations/:id/messages returns the row
  // as-is - so "projected" is the honest word and "on the wire" is not. Absent
  // on every other message - a row carrying relayRetryOf IS a retry row.
```

4c. After `  relayRetryLegBody?: string;` (`:758`) add:

```ts
  /**
   * retry-send-window D2: the member's ORIGINAL leg send time (the root slot's
   * `sentAt`), carried forward on every rung as `relay_retry_window_start` -
   * never re-derived from a retry row's own slot, which would restart the
   * window. OPTIONAL by design (D5): a rung claimed before the field existed, or
   * from a slot with no `sentAt`, has none and is not windowed.
   */
  relayRetryWindowStart?: string;
```

4d. `MessageItem` - after `  retry_attempt?: number;` (`:1000`; the doc line above it, `:999`, carries a non-ASCII section sign and is left as it is) add:

```ts
  /** retry-send-window D2/D6: the automatic retry chain's origin, written at append (see NewMessage.retryWindowStart). */
  retry_window_start?: string;
  /**
   * retry-send-window D7: when the automatic 30003 retry of THIS failed
   * one-to-one message runs (ISO 8601). Written in the SAME conditional write
   * as the failure (updateDeliveryStatus's `retryDueAt`), so the failure and the
   * promise become visible together; re-written through annotateMessage to
   * RETRY_PROMISE_WITHDRAWN_AT (lib/retrySendWindow.ts, already expired) when
   * the enqueue fails. The promise is live while now < retry_due_at +
   * RETRY_PROMISE_GRACE_MS. Absent when no retry was scheduled.
   */
  retry_due_at?: string;
  /** retry-send-window D14: the send's automated flag, false included (see NewMessage.automated). */
  automated?: boolean;
  /** retry-send-window D14: the recipient contact the send named (see NewMessage.recipientContactId). */
  recipient_contact_id?: string;
```

4e. After `  relay_retry_leg_body?: string;` (`:1016`) add:

```ts
  /** retry-send-window D2/D5: the member's original leg send time, carried on every rung; absent = not windowed (see NewMessage.relayRetryWindowStart). */
  relay_retry_window_start?: string;
```

4f. `MessageAnnotations` (`:1173-1177`). Old:

```ts
export interface MessageAnnotations {
  mediaAttachments?: MediaAttachment[];
  retryOf?: string;
  retryAttempt?: number;
}
```

New:

```ts
export interface MessageAnnotations {
  mediaAttachments?: MediaAttachment[];
  retryOf?: string;
  retryAttempt?: number;
  /**
   * retry-send-window D7: re-write `retry_due_at`. The status webhook sets it
   * to RETRY_PROMISE_WITHDRAWN_AT when the retry's enqueue fails, so a promise
   * with no retry behind it is withdrawn at once.
   */
  retryDueAt?: string;
}
```

4g. The `MessagesRepo` interface. Replace the signature line `:1261` (the doc block above it, `:1256-1260`, carries non-ASCII dashes and stays as it is; the new behavior is documented on the parameter). Old:

```ts
  updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string): Promise<boolean>;
```

New:

```ts
  updateDeliveryStatus(
    sid: string,
    status: DeliveryStatus,
    errorCode?: string,
    /**
     * retry-send-window D7: `retryDueAt` (the one-to-one retry's run time,
     * ISO 8601) is SET as `retry_due_at` in the SAME conditional write as the
     * status, so it lands only if the transition does - a redelivered or
     * regressing callback writes neither. Every other caller passes nothing.
     */
    options?: { retryDueAt?: string },
  ): Promise<boolean>;
```

And the `annotateMessage` doc (`:1405`). Old:

```ts
  /** Stamp operational metadata (media S3 keys / retry lineage) onto a message. */
```

New:

```ts
  /** Stamp operational metadata (media S3 keys / retry lineage / the retry promise's retry_due_at) onto a message. */
```

4h. The real `append`'s item (spec D6, D12, D14). Select `:2262-2265` - from the line `        // Manual retry (dashboard Retry button): stamp retry_of AT APPEND so the` through the line `        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),` (the middle comment line, `:2263`, carries a non-ASCII dash, so select the range rather than retyping it; its third comment line, "The 30003 auto-retry still annotates post-send", is what D6 makes false) - and replace the four lines with:

```ts
        // Retry lineage AT APPEND, so the row carries it atomically (no
        // annotate-after race): the manual Retry stamps retry_of alone; the
        // automatic 30003 retry also stamps retry_attempt (the chain cap) and
        // retry_window_start (the chain's origin, retry-send-window D2/D6), so a
        // fast 30003 on the retry can never read a row without them.
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        ...(message.retryAttempt !== undefined && { retry_attempt: message.retryAttempt }),
        ...(message.retryWindowStart !== undefined && {
          retry_window_start: message.retryWindowStart,
        }),
        // retry-send-window D14: the send's own flags, so its retry is sent the
        // same way. `automated` is written for FALSE too - absent means a row
        // from before the field existed, which is retried as automated.
        ...(message.automated !== undefined && { automated: message.automated }),
        ...(message.recipientContactId !== undefined && {
          recipient_contact_id: message.recipientContactId,
        }),
```

Then extend the relay lineage block. Old (`:2282-2284`):

```ts
        ...(message.relayRetryLegBody !== undefined && {
          relay_retry_leg_body: message.relayRetryLegBody,
        }),
```

New:

```ts
        ...(message.relayRetryLegBody !== undefined && {
          relay_retry_leg_body: message.relayRetryLegBody,
        }),
        // retry-send-window D2: the member's original leg send time, carried on
        // every rung; optional (D5 - absent = not windowed).
        ...(message.relayRetryWindowStart !== undefined && {
          relay_retry_window_start: message.relayRetryWindowStart,
        }),
```

4i. `updateDeliveryStatus` (spec D7) - replace the whole method (`:2541-2580`) with:

```ts
    async updateDeliveryStatus(sid, status, errorCode, options) {
      const existing = await getByProviderSid(sid);
      if (!existing) {
        log.warn({ providerSid: sid, status }, 'delivery status for unknown provider SID ignored');
        return false;
      }
      const allowed = allowedPriorStatuses(status);
      if (allowed.length === 0) return false; // nothing may transition INTO queued
      // retry-send-window D7: the one-to-one retry decision rides the SAME
      // conditional write as the failure, so `retry_due_at` lands only when the
      // transition does - a redelivered or regressing callback writes neither,
      // and the transition's one `message.persisted` carries both.
      const retryDueAt = options?.retryDueAt;
      const sets = ['delivery_status = :s'];
      if (errorCode !== undefined) sets.push('error_code = :e');
      if (retryDueAt !== undefined) sets.push('retry_due_at = :r');
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { conversationId: existing.conversationId, tsMsgId: existing.tsMsgId },
            UpdateExpression: `SET ${sets.join(', ')}`,
            // Forward-only: the write commits only from an allowed prior
            // status, so out-of-order callbacks can never regress `delivered`.
            ConditionExpression: `delivery_status IN (${allowed.map((_, i) => `:p${i}`).join(', ')})`,
            ExpressionAttributeValues: {
              ':s': status,
              ...(errorCode !== undefined && { ':e': errorCode }),
              ...(retryDueAt !== undefined && { ':r': retryDueAt }),
              ...Object.fromEntries(allowed.map((p, i) => [`:p${i}`, p])),
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info(
            { providerSid: sid, status, currentStatus: existing.delivery_status },
            'delivery status transition skipped (would regress)',
          );
          return false;
        }
        throw err;
      }
      log.info(
        { providerSid: sid, status, errorCode, ...(retryDueAt !== undefined && { retryDueAt }) },
        'delivery status updated',
      );
      return true;
    },
```

4j. `annotateMessage` (spec D7). Old (`:2916-2920`):

```ts
      if (annotations.retryAttempt !== undefined) {
        sets.push('retry_attempt = :retryAttempt');
        values[':retryAttempt'] = annotations.retryAttempt;
      }
      if (sets.length === 0) return;
```

New:

```ts
      if (annotations.retryAttempt !== undefined) {
        sets.push('retry_attempt = :retryAttempt');
        values[':retryAttempt'] = annotations.retryAttempt;
      }
      // retry-send-window D7: the enqueue-failure withdrawal re-writes the
      // promise to an already-expired instant.
      if (annotations.retryDueAt !== undefined) {
        sets.push('retry_due_at = :retryDueAt');
        values[':retryDueAt'] = annotations.retryDueAt;
      }
      if (sets.length === 0) return;
```

And its log line. Old (`:2935-2938`):

```ts
          retryOf: annotations.retryOf,
          retryAttempt: annotations.retryAttempt,
        },
        'message annotated',
```

New:

```ts
          retryOf: annotations.retryOf,
          retryAttempt: annotations.retryAttempt,
          retryDueAt: annotations.retryDueAt,
        },
        'message annotated',
```

- [ ] **Step 5: Implement the harness twins (`app/test/helpers/twilioWebhookHarness.ts`)**

5a. The fake `append` allowlist (spec section 4: it "would silently drop the new append-time fields"). Old (`:1130-1136`):

```ts
        // Manual-retry lineage: preserve retry_of so the timeline serializer can
        // emit it (mirrors the real repo's append passthrough).
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        // Relay 30003 retry lineage (spec D11/D12): preserve the six values the
        // real repo persists (messagesRepo.ts:2218-2233). Without them a claim
        // written through this fake reads back with NO lineage at all, and the
        // retry job throws on the row it was handed.
```

New (the old relay comment's line citation was stale; it now names the block):

```ts
        // Retry lineage (the manual Retry AND the automatic 30003 retry):
        // preserve retry_of so the timeline serializer can emit it (mirrors the
        // real repo's append passthrough).
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        // retry-send-window D6/D14: the append-time attempt number, the chain's
        // window origin and the send's own flags - automated FALSE included.
        // The real repo persists all four; a fake that dropped them would let a
        // "carried origin" or "follows the original send" test pass VACUOUSLY
        // through its fallback (retry_window_start ?? provider_ts,
        // automated ?? true). Pinned by twilioWebhookHarnessRetryFields.test.ts.
        ...(message.retryAttempt !== undefined && { retry_attempt: message.retryAttempt }),
        ...(message.retryWindowStart !== undefined && {
          retry_window_start: message.retryWindowStart,
        }),
        ...(message.automated !== undefined && { automated: message.automated }),
        ...(message.recipientContactId !== undefined && {
          recipient_contact_id: message.recipientContactId,
        }),
        // Relay 30003 retry lineage (spec D11/D12): preserve the six lineage
        // values the real repo persists, plus retry-send-window's window origin
        // (the relay block of messagesRepo.ts `append`). Without them a claim
        // written through this fake reads back with NO lineage at all, and the
        // retry job throws on the row it was handed.
```

5b. Old (`:1150-1152`):

```ts
        ...(message.relayRetryLegBody !== undefined && {
          relay_retry_leg_body: message.relayRetryLegBody,
        }),
```

New:

```ts
        ...(message.relayRetryLegBody !== undefined && {
          relay_retry_leg_body: message.relayRetryLegBody,
        }),
        ...(message.relayRetryWindowStart !== undefined && {
          relay_retry_window_start: message.relayRetryWindowStart,
        }),
```

5c. The fake `updateDeliveryStatus` - replace the whole method (`:1213-1220`) with:

```ts
    async updateDeliveryStatus(sid, status, errorCode, options) {
      const existing = findBySid(sid);
      if (!existing) return false;
      if (!allowedPriorStatuses(status).includes(existing.delivery_status)) return false;
      existing.delivery_status = status;
      if (errorCode !== undefined) existing.error_code = errorCode;
      // retry-send-window D7: mirror the real repo's ONE conditional write -
      // retry_due_at lands only on a transition; a redelivered or regressing
      // callback returned false above and wrote nothing.
      if (options?.retryDueAt !== undefined) existing.retry_due_at = options.retryDueAt;
      return true;
    },
```

5d. The fake `annotateMessage`. Old (`:1343`):

```ts
      if (annotations.retryAttempt !== undefined) item.retry_attempt = annotations.retryAttempt;
```

New:

```ts
      if (annotations.retryAttempt !== undefined) item.retry_attempt = annotations.retryAttempt;
      // retry-send-window D7: the enqueue-failure withdrawal.
      if (annotations.retryDueAt !== undefined) item.retry_due_at = annotations.retryDueAt;
```

- [ ] **Step 6: Run the new tests and the unchanged callers**

Run: `cd app; npx vitest run test/twilioWebhookHarnessRetryFields.test.ts test/messaging.integration.test.ts test/messagesRepoRetryLineage.integration.test.ts test/twilioWebhookHarnessMediaIndex.test.ts test/emailEvents.test.ts test/groupReceipts.test.ts test/sendEmailMessage.test.ts test/relayQueuedMessages.test.ts test/messagesRepo.email.test.ts test/twilioStatusWebhook.test.ts`
Expected: PASS (the new cases green; the other `updateDeliveryStatus` callers' suites unchanged).

- [ ] **Step 7: Typecheck, ASCII check, commit**

`npm run typecheck` proves every other caller and every `MessagesRepo` fake compiles unchanged (Expected: exit 0). ASCII: `tr -d '\11\12\15\40-\176' < app/test/twilioWebhookHarnessRetryFields.test.ts | wc -c` -> `0`; for each touched pre-existing file (`messagesRepo.ts`, the harness and the two integration tests carry older non-ASCII lines, so check only the added lines) `git diff -U0 -- <file> | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`.

```bash
npm run typecheck
git status
git add app/src/repos/messagesRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessRetryFields.test.ts app/test/messaging.integration.test.ts app/test/messagesRepoRetryLineage.integration.test.ts
git commit -m "feat(messages): retry lineage, window origin, send flags and retry_due_at on the message row (retry-send-window D2, D6, D7, D14)

NewMessage and MessageItem gain retry_attempt at append, retry_window_start,
automated (false included), recipient_contact_id and the relay window
origin; updateDeliveryStatus takes an optional retryDueAt SET in the same
conditional write as the transition; annotateMessage can re-write
retry_due_at. The webhook harness twins mirror all of it so later tests
cannot pass vacuously through a fallback.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/repos/messagesRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioWebhookHarnessRetryFields.test.ts app/test/messaging.integration.test.ts app/test/messagesRepoRetryLineage.integration.test.ts
```

---

### Task 3: One gate evaluator for the relay retry job and the claim (spec D3; the job's gates, relayRetryLeg.ts:491-555)

**Files:**
- Create: `app/src/lib/relayRetryGates.ts`
- Modify: `app/src/jobs/relayRetryLeg.ts:34-53` (imports), `:80-97` (`RelayRetryCloseCode` by reference), after `:256-258` (a per-code WARN message map), `:482-555` (the four gates become one `evaluateRelayRetryGates` call; the no-pool-number throw moves after them)
- Test: `app/test/relayRetryGates.test.ts` (new). `app/test/relayRetryLeg.test.ts` - four new cases inserted before the test `'never stamps contact_opted_out on an opt-out refusal (the rollup drops that code)'` (`:379`), pinning the moved pool-number throw. Every pre-existing case in that file stays byte-identical and green: its gate-case table (`:307-377`) and the gate-adjacent cases (`:379-423`, `:472-507`, `:801-829`, `:977-1000`) are the proof that the extraction preserves every refusal.

**Interfaces:**
- Consumes: `isMemberSuppressed(contacts: ContactsRepo, conversations: ConversationsRepo, member: ConversationParticipant): Promise<boolean>` - it lives in `app/src/services/relayAnnouncements.ts:64-100` (re-exported by `app/src/jobs/relayFanOut.ts:76`); the job imports it from the service (`relayRetryLeg.ts:54`) and calls it as `isMemberSuppressed(contactsRepo, conversationsRepo, member)` (`:548`). `relayMemberKey` (`app/src/repos/messagesRepo.ts:193-197`), `normalizeToE164` (`app/src/lib/phone.ts`), `relayRetryDigest(rootTsMsgId, destinationE164)` (`app/src/lib/relayRetryClaim.ts:25-30`).
- Produces (the skeleton contract, exactly):
  ```ts
  export type RelayRetryGateCode =
    | 'retry_group_closed' | 'retry_member_removed' | 'retry_number_changed' | 'retry_opted_out';
  export type RelayRetryGateResult =
    | { refused: false; conversation: ConversationItem; member: ConversationParticipant }
    | { refused: true; code: RelayRetryGateCode };
  export async function evaluateRelayRetryGates(args: {
    conversation: ConversationItem | undefined;
    memberKey: string;
    rootTsMsgId: string;
    destDigest: string;
    isSuppressed: (member: ConversationParticipant) => Promise<boolean>;
  }): Promise<RelayRetryGateResult>;
  ```
  and `RelayRetryCloseCode = RelayRetryGateCode | 'enqueue_failed' | 'transient_cap'` (Task 5 adds `'retry_window_closed'`). The job keeps its refusal writes (`refuseGate`), its per-gate WARN lines (Q1 ruling) and its "open group with no pool number -> throw".
- Behavior change (the only one in this task; spec D3, plan review R1 finding 7): the job threw "has no pool number" between the group-open gate and the roster gate (`relayRetryLeg.ts:510-515`); it now throws only after a non-refused result from all four gates - the order the claim previews (Task 4). An OPEN group with no pool number whose member fails gate 2, 3 or 4 therefore closes the rung with that gate's code instead of throwing; with every gate passing it still throws, now after the suppression read. Step 2 pins both halves.

- [ ] **Step 1: Write the failing evaluator test (spec D3)**

Create `app/test/relayRetryGates.test.ts`:

```ts
// The relay 30003 retry ladder's four send gates as ONE evaluator
// (retry-send-window spec D3, Task 3). The retry job runs it before every
// rung's send; the status webhook's claim previews the same gates with it.
// Pure: its only read is the injected `isSuppressed`.
import { describe, expect, it, vi } from 'vitest';
import { relayRetryDigest } from '../src/lib/relayRetryClaim.js';
import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../src/lib/relayRetryGates.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';

const ROOT = '2026-09-25T12:00:00.000Z#SMrelay-root-1';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const BOB_NEW = '+15558675399';
const BOB_KEY = 'c-bob';
/** The digest the claim stored for Bob's ladder: root + the handset it failed on. */
const DEST = relayRetryDigest(ROOT, BOB);

function relayConversation(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: 'conv-relay-1',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: '2026-09-25T12:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
    ],
    created_at: '2026-09-25T12:00:00.000Z',
    ...overrides,
  };
}

/** The roster with Bob absent (undefined) or overridden. */
function withBob(member: Partial<ConversationParticipant> | undefined): ConversationParticipant[] {
  const alice: ConversationParticipant = { contactId: 'c-alice', phone: ALICE, name: 'Alice' };
  return member === undefined
    ? [alice]
    : [alice, { contactId: BOB_KEY, phone: BOB, name: 'Bob', ...member }];
}

const notSuppressed = async (_member: ConversationParticipant): Promise<boolean> => false;
const suppressed = async (_member: ConversationParticipant): Promise<boolean> => true;

describe('evaluateRelayRetryGates (retry-send-window D3)', () => {
  it('passes when all four gates pass, handing back the conversation and the matched member', async () => {
    const conversation = relayConversation();
    const isSuppressed = vi.fn(notSuppressed);

    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });

    expect(result).toEqual({
      refused: false,
      conversation,
      member: { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
    });
    // The suppression read is the ONLY read, asked once, for the matched member.
    expect(isSuppressed).toHaveBeenCalledTimes(1);
    expect(isSuppressed).toHaveBeenCalledWith({ contactId: BOB_KEY, phone: BOB, name: 'Bob' });
  });

  it.each<[string, ConversationItem | undefined, RelayRetryGateCode]>([
    ['an absent conversation', undefined, 'retry_group_closed'],
    ['a closed group', relayConversation({ status: 'closed' }), 'retry_group_closed'],
    ['a group still connecting', relayConversation({ status: 'connecting' }), 'retry_group_closed'],
    ['a member no longer on the roster', relayConversation({ participants: withBob(undefined) }), 'retry_member_removed'],
    ['a member whose number changed', relayConversation({ participants: withBob({ phone: BOB_NEW }) }), 'retry_number_changed'],
    [
      'a member whose number cannot be normalized',
      relayConversation({ participants: withBob({ phone: 'not-a-number' }) }),
      'retry_number_changed',
    ],
  ])('refuses %s with its code, before any suppression read', async (_label, conversation, code) => {
    const isSuppressed = vi.fn(notSuppressed);

    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });

    expect(result).toEqual({ refused: true, code });
    expect(isSuppressed).not.toHaveBeenCalled();
  });

  it('refuses an opted-out member with retry_opted_out', async () => {
    const result = await evaluateRelayRetryGates({
      conversation: relayConversation(),
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed: suppressed,
    });
    expect(result).toEqual({ refused: true, code: 'retry_opted_out' });
  });

  it('matches a contact-less member by its phone# stored key', async () => {
    const conversation = relayConversation({ participants: [{ contactId: '', phone: BOB }] });
    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: `phone#${BOB}`,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed: notSuppressed,
    });
    expect(result).toMatchObject({ refused: false, member: { phone: BOB } });
  });

  // Two gates refusing at once: the FIRST in the job's order names the code,
  // so the claim's preview and the job's own refusal always agree (spec D3).
  it.each<[string, ConversationItem | undefined, (member: ConversationParticipant) => Promise<boolean>, RelayRetryGateCode]>([
    ['closed AND member removed', relayConversation({ status: 'closed', participants: withBob(undefined) }), notSuppressed, 'retry_group_closed'],
    ['closed AND number changed', relayConversation({ status: 'closed', participants: withBob({ phone: BOB_NEW }) }), notSuppressed, 'retry_group_closed'],
    ['closed AND opted out', relayConversation({ status: 'closed' }), suppressed, 'retry_group_closed'],
    ['member removed AND opted out', relayConversation({ participants: withBob(undefined) }), suppressed, 'retry_member_removed'],
    ['number changed AND opted out', relayConversation({ participants: withBob({ phone: BOB_NEW }) }), suppressed, 'retry_number_changed'],
  ])('with two gates refusing (%s), the first in the job order wins', async (_label, conversation, isSuppressed, code) => {
    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });
    expect(result).toEqual({ refused: true, code });
  });

  it('lets a failing suppression read propagate - the caller fails closed', async () => {
    const isSuppressed = async (_member: ConversationParticipant): Promise<boolean> => {
      throw new Error('dynamodb throttled');
    };
    await expect(
      evaluateRelayRetryGates({
        conversation: relayConversation(),
        memberKey: BOB_KEY,
        rootTsMsgId: ROOT,
        destDigest: DEST,
        isSuppressed,
      }),
    ).rejects.toThrow('dynamodb throttled');
  });
});
```

- [ ] **Step 2: Pin the moved pool-number throw, both halves (spec D3; plan review R1 finding 7)**

In `app/test/relayRetryLeg.test.ts`, insert the cases below immediately before the existing test at line 379. The file has no pool-less case today, and every pre-existing case stays as it is.

Old:
```ts
  it('never stamps contact_opted_out on an opt-out refusal (the rollup drops that code)', async () => {
```
New:
```ts
  // --- retry-send-window D3: the no-pool-number throw now FOLLOWS the four gates ---
  //
  // The job used to throw "has no pool number" between the group-open gate and
  // the roster gate. It now runs all four gates first - the order the claim's
  // preview shares - so both halves are pinned: on an OPEN group with NO pool
  // number, a gate that refuses still closes the rung with its own code, and
  // with every gate passing the job still throws, after the suppression read.

  it.each<[string, (world: FakeWorld) => void, string]>([
    [
      'removed member',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);
      },
      'retry_member_removed',
    ],
    [
      'changed number',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).map((m) =>
          m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
        );
      },
      'retry_number_changed',
    ],
    [
      'opted out',
      (w) => {
        w.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
      },
      'retry_opted_out',
    ],
  ])(
    'closes an OPEN group with NO pool number by its refusing gate (%s) - the gates run before the pool-number throw',
    async (_name, arrange, code) => {
      seedRelay(world, { pool_number: undefined });
      const row = seedRetryRow(world);
      arrange(world);
      register();

      await runHandler(payloadFor(row));

      expect(world.sent).toHaveLength(0);
      expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: code });
      const terminal = warnLogs().filter((l) => l['closeCode'] === code);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ retryClaim: 'gate_refused' });
      // No throw: a deferred job that throws is logged at ERROR by the queue
      // adapter, and the rung would be left `queued`.
      expect(errorLogs()).toHaveLength(0);
      expect(persistedEmits()).toHaveLength(1);
      expect(persistedEmits()[0]!.payload).toEqual(ROOT_CLOSE_EMIT);
    },
  );

  it('still THROWS for an OPEN group with NO pool number once all four gates pass - after the suppression read, nothing sent', async () => {
    seedRelay(world, { pool_number: undefined });
    const row = seedRetryRow(world);
    const suppressionRead = vi.spyOn(world.contactsRepo, 'getById');
    register();

    await expect(
      dispatchJob({
        jobId: 'job-poolless-1',
        jobName: RELAY_RETRY_LEG_JOB,
        payload: payloadFor(row),
        enqueuedAt: new Date().toISOString(),
      } as never),
    ).rejects.toThrow(/has no pool number/);
    // The throw now comes AFTER the fourth gate's read ...
    expect(suppressionRead).toHaveBeenCalledWith(BOB_KEY);
    // ... and still sends and closes nothing: no gate code describes it.
    expect(world.sent).toHaveLength(0);
    expect(slotOf(row.tsMsgId)?.status).toBe('queued');
    expect(persistedEmits()).toHaveLength(0);
  });

  it('never stamps contact_opted_out on an opt-out refusal (the rollup drops that code)', async () => {
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd app; npx vitest run test/relayRetryGates.test.ts test/relayRetryLeg.test.ts`
Expected: `relayRetryGates.test.ts` FAILS - it cannot import `../src/lib/relayRetryGates.js` (module not found). In `relayRetryLeg.test.ts` the four new cases FAIL, because today the job throws "has no pool number" right after the group-open gate: the three refusing-gate cases end with the rung still `queued` and an ERROR from the queue adapter, and the throw case never reaches the suppression read. Every pre-existing case PASSES.

- [ ] **Step 4: Create the evaluator (spec D3)**

Create `app/src/lib/relayRetryGates.ts`:

```ts
// The relay 30003 retry ladder's four send gates, as ONE evaluator
// (retry-send-window spec D3).
//
// The retry JOB runs these gates right before it sends a rung
// (`jobs/relayRetryLeg.ts`). Since retry-send-window the status webhook's
// CLAIM previews the SAME gates before it creates a rung, so a rung the job
// would refuse is created already closed with that gate's code and the leg
// reads "Not retried - ..." at once instead of "Retrying" for 1 to 4 minutes.
// One function for both callers is what keeps them from drifting: the same
// checks, in the same order, naming the same code when two gates apply.
//
// The ORDER is the job's and it is load-bearing (the FIRST refusing gate names
// the code): group open -> member still on the roster -> destination number
// unchanged (digest compare) -> member not opted out.
//
// Reads NOTHING itself except through `isSuppressed`: the caller has already
// read the conversation and owns the suppression read (the job relies on it
// being the ONLY such read before its send - code review R2, W4). A rejection
// from `isSuppressed` propagates, so the caller fails CLOSED.
import type { ConversationItem, ConversationParticipant } from '../repos/conversationsRepo.js';
import { relayMemberKey } from '../repos/messagesRepo.js';
import { normalizeToE164 } from './phone.js';
import { relayRetryDigest } from './relayRetryClaim.js';

/** The four gate close codes. Each has operator copy in the dashboard's
 *  internal-code map ("Not retried - group closed" and its three siblings). */
export type RelayRetryGateCode =
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out';

export type RelayRetryGateResult =
  | { refused: false; conversation: ConversationItem; member: ConversationParticipant }
  | { refused: true; code: RelayRetryGateCode };

/** The relay retry job's four gates, in the job's order: group open, on the
 *  roster, number unchanged (digest compare), not opted out. Reads nothing
 *  itself except through `isSuppressed`. The job and the webhook claim both
 *  call it. */
export async function evaluateRelayRetryGates(args: {
  conversation: ConversationItem | undefined;
  memberKey: string;
  rootTsMsgId: string;
  destDigest: string;
  isSuppressed: (member: ConversationParticipant) => Promise<boolean>;
}): Promise<RelayRetryGateResult> {
  const { conversation, memberKey, rootTsMsgId, destDigest, isSuppressed } = args;
  // 1. Group open. The same authoritative check the fan-out uses: `status`,
  // not pool_number presence (a pool number is KEPT on close for
  // burn-multiplexing). An absent conversation is not open either, and the
  // four codes are a closed set - "group closed" is the truthful one of them.
  if (conversation === undefined || conversation.status !== 'open') {
    return { refused: true, code: 'retry_group_closed' };
  }
  // 2. Still on the roster, matched by the STORED member key.
  const member = (conversation.participants ?? []).find(
    (candidate) => relayMemberKey(candidate) === memberKey,
  );
  if (member === undefined) return { refused: true, code: 'retry_member_removed' };
  // 3. Destination unchanged. Compare DIGESTS, never the raw number: the
  // handset is not stored anywhere on the row, and a member whose phone
  // changed must never silently receive an old message at the new number. A
  // current number that cannot be normalized produces no matching digest, so
  // it refuses here too.
  const currentE164 = normalizeToE164(member.phone);
  if (currentE164 === undefined || relayRetryDigest(rootTsMsgId, currentE164) !== destDigest) {
    return { refused: true, code: 'retry_number_changed' };
  }
  // 4. Not opted out - the caller's read.
  if (await isSuppressed(member)) return { refused: true, code: 'retry_opted_out' };
  return { refused: false, conversation, member };
}
```

- [ ] **Step 5: Make the job call it; the pool-number throw moves after the gates (spec D3; the job D9 gates)**

In `app/src/jobs/relayRetryLeg.ts`:

(a) Imports - replace lines 34-53:

Old:
```ts
import { getContext } from '../lib/context.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { relayRetryBackoffMs, relayRetryDigest } from '../lib/relayRetryClaim.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
```

New:
```ts
import { getContext } from '../lib/context.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { relayRetryBackoffMs } from '../lib/relayRetryClaim.js';
import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../lib/relayRetryGates.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  type MessageItem,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
```

(`normalizeToE164`, `relayRetryDigest`, `relayMemberKey` and `ConversationParticipant` move into the evaluator; leaving them imported here would be new `no-unused-vars` errors in a touched file.)

(b) `RelayRetryCloseCode` - replace lines 80-97:

Old:
```ts
/**
 * Every terminal code this job can write to a retry leg's slot (spec D15/D14/
 * D10). The four `retry_*` values are D9's gate refusals and each has operator
 * copy in the dashboard's internal-code map; `enqueue_failed` and
 * `transient_cap` already existed there and keep their meanings - retries did
 * not run vs. retries ran and the transient budget is spent.
 *
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 */
export type RelayRetryCloseCode =
  | 'retry_group_closed'
  | 'retry_member_removed'
  | 'retry_number_changed'
  | 'retry_opted_out'
  | 'enqueue_failed'
  | 'transient_cap';
```

New:
```ts
/**
 * Every terminal code this job can write to a retry leg's slot (spec D15/D14/
 * D10). The four gate `retry_*` values are D9's gate refusals - typed once as
 * `RelayRetryGateCode`, beside the shared evaluator that both this job and the
 * status webhook's claim run (retry-send-window D3) - and each has operator
 * copy in the dashboard's internal-code map; `enqueue_failed` and
 * `transient_cap` already existed there and keep their meanings - retries did
 * not run vs. retries ran and the transient budget is spent.
 *
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 */
export type RelayRetryCloseCode = RelayRetryGateCode | 'enqueue_failed' | 'transient_cap';
```

(c) Directly after `logSafeStoredMemberKey` (after line 258, before the `/** The lineage a retry row MUST carry ... */` comment) add:

```ts
/** The WARN message each gate refusal logs - one per code, unchanged since the
 *  gates moved into `evaluateRelayRetryGates` (retry-send-window D3). */
const GATE_REFUSAL_MESSAGES: Record<RelayRetryGateCode, string> = {
  retry_group_closed: 'relayRetryLeg: retry refused - relay group is not open',
  retry_member_removed: 'relayRetryLeg: retry refused - member is no longer on the roster',
  retry_number_changed: 'relayRetryLeg: retry refused - destination number changed since the claim',
  retry_opted_out: 'relayRetryLeg: retry refused - member opted out',
};
```

(d) The gates - replace lines 482-555 (from the comment `    // 4. The gates (spec D9), in order. Each refusal writes its OWN close code,` through the closing `    }` of the opt-out gate, i.e. everything before the blank line and `    // The fan-out's media-without-store ERROR, twinned (code review R1, F4).`) with:

```ts
    // 4. The gates (spec D9), in order, through the ONE evaluator the status
    // webhook's claim also previews them with (retry-send-window D3), so the
    // claim and this job can never disagree about which gate refuses, or which
    // code wins when two apply. Each refusal writes its OWN close code, logs a
    // WARN with the `gate_refused` cause, and ENDS the chain - no further rung
    // is claimed. WARN, not the spec's D23 ERROR, by Cameron's ruling on the
    // handback's open question Q1 (2026-09-24): a closed group, a removed
    // member, a changed number and an opt-out are deliberate human actions,
    // not faults - the 21610 carve-out's reasoning - and at ERROR an operator
    // who closed a group with several rungs pending could trip the ErrorLogs
    // burst alarm on their own action. The send-time refusal below (e.g.
    // `breaker_open`) is a system condition and stays ERROR.
    const conversation = await conversationsRepo.getById(conversationId);
    const gate = await evaluateRelayRetryGates({
      conversation,
      memberKey,
      rootTsMsgId,
      destDigest,
      // The evaluator reads nothing itself: this is the job's ONE suppression
      // read, the one `suppressionChecked: true` below relies on (R2, W4).
      isSuppressed: (candidate) => isMemberSuppressed(contactsRepo, conversationsRepo, candidate),
    });
    if (gate.refused) {
      await refuseGate(gate.code);
      log.warn(
        {
          ...ladder,
          // The STORED key's log-safe form: equal to `logSafeMemberKey` of the
          // roster member it matches, and the only form left once the member
          // is gone from the roster.
          memberKey: logSafeStoredMemberKey(memberKey),
          retryClaim: 'gate_refused',
          closeCode: gate.code,
          ...(gate.code === 'retry_group_closed' && { status: conversation?.status }),
        },
        GATE_REFUSAL_MESSAGES[gate.code],
      );
      return;
    }
    // An OPEN relay group with no pool number cannot send at all, and no gate
    // code describes it honestly. Throw rather than mis-stamp one of the four.
    // Checked AFTER all four gates (retry-send-window D3, the order the claim
    // previews): an open, pool-less group that ALSO refuses a gate closes with
    // that gate's code instead of throwing. relayRetryLeg.test.ts pins both
    // halves.
    const poolNumber = gate.conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      throw new Error(`relayRetryLeg: relay conversation ${conversationId} has no pool number`);
    }
    const member = gate.member;
    const memberLog = { ...ladder, memberKey: logSafeMemberKey(member) };
```

The rest of the handler (the media-without-store ERROR, the send, the outcomes) is unchanged: it still reads `member`, `poolNumber` and `memberLog`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/relayRetryGates.test.ts test/relayRetryLeg.test.ts test/relayRetryClaim.webhook.test.ts`
Expected: PASS - the new evaluator suite; `relayRetryLeg.test.ts`, every pre-existing case unchanged (same codes, same WARN fields, same single root SSE per refusal, the suppression flip read counted once) plus the four pool-less cases; `relayRetryClaim.webhook.test.ts` unchanged.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/lib/relayRetryGates.ts app/src/jobs/relayRetryLeg.ts app/test/relayRetryGates.test.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay-retry): one gate evaluator for the retry job and the claim; the pool-number throw follows the gates (spec D3)

The retry job's four gates - group open, on the roster, number unchanged by
digest, not opted out - move into evaluateRelayRetryGates, in the job's order,
reading nothing but the injected suppression check. The job keeps its refusal
writes, its WARN lines and its no-pool-number throw; RelayRetryCloseCode now
names the gate codes by reference.

One behavior change, pinned by four new job cases: the open-group-without-
pool-number throw now runs after all four gates, the order the claim will
preview. Such a group whose member fails a gate closes with that gate's code
instead of throwing; with every gate passing the job still throws, now after
the suppression read.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/lib/relayRetryGates.ts app/src/jobs/relayRetryLeg.ts app/test/relayRetryGates.test.ts app/test/relayRetryLeg.test.ts
```

---

### Task 4: The relay claim decides at once - gate preview, send window, closed rungs (spec D2, D3, D5, D9)

**Files:**
- Modify: `app/src/lib/relayRetryClaim.ts:47-90` (`RelayRetryClaimOutcome` gains `'window_closed'`; `gate_refused` gets its doc)
- Modify: `app/src/routes/webhooks/twilio.ts` - `:72-79` (import the `RelayRecipientDelivery` type), `:139-145` (imports), `:387-392` (`RelayRetryClaimResult.closeCode`), `:394-445` (`isTerminalRelayLegFailure` doc and WARN set), `:2665-2669` (claim doc), before `:2781` (new step 7a: the gate preview, the origin, the decision and the rung's slot), `:2802-2812` (the append seeds that slot), `:2826-2830` (the append carries `relayRetryWindowStart`), `:2831-2840` (dedupe, the D5 WARN, the declined exit), `:2893-2906` (step 9 through a shared emit), `:3077-3079` (the failure marker carries `closeCode`). NOT edited: `closeRetryLegEnqueueFailed` (`:618-658`) and its one call (`:2861-2867`) stay exactly as they are - still the claim's only close, used for `enqueue_failed` alone. Do NOT edit `:316-341` or the one-to-one arm - Task 10 owns them.
- Test: `app/test/relayRetryClaim.test.ts:51-88`; `app/test/relayRetryClaim.webhook.test.ts` - `:19` (the vitest import gains `vi`), `:39` (import), after `:69` (constants and `minutesAgo`), `:71-79` (`SourceOptions.carolSlot`), `:178` (Carol's slot), after `:258` (`runScheduledRung`), before the final `});` at `:827` (new section).

**Interfaces:**
- Consumes: Task 1 `parseRetryWindowOrigin(value: unknown): number | undefined`, `retryFitsSendWindow(args: { originMs: number; nowMs: number; backoffMs: number }): boolean`. Task 2 `NewMessage.relayRetryWindowStart?: string` (written as `relay_retry_window_start`), `MessageItem.relay_retry_window_start?: string`, and the harness fake `append` carrying it (`app/test/helpers/twilioWebhookHarness.ts:1081-1152`). Task 3 `evaluateRelayRetryGates(...)`, `RelayRetryGateCode`. Existing `resolveRelayRetryBackoff(deps?: Pick<RelayRetryLegJobDeps, 'backoffMs'>): (attempt: number) => number` (`app/src/jobs/relayRetryLeg.ts:214-218`, the chain `enqueueRelayRetryLeg` schedules with, `:225-234`); `isMemberSuppressed` (already imported, `twilio.ts:83-87`).
- Consumes (verified, the reason a closed rung can be ONE write): `messages.append` (`app/src/repos/messagesRepo.ts:2214-2253`) writes `delivery_recipients` verbatim, in the same `TransactWriteCommand` as the `sid#` pointer that IS the claim (`:2336-2360`). Its only shape check, `assertTransportPersistenceShape` (`:917-968`), looks at transport fields alone: a recipient transport field requires schema version 1 (a versioned rung carries it; a legacy closed slot has none) and an aggregation state must be `planned`, `attempted` or `excluded` (`:959-966`). It never inspects a slot's `status` or `errorCode`, so a `failed` / `excluded` slot is accepted at creation. The harness fake `append` stores `deliveryRecipients` as given (`twilioWebhookHarness.ts:1125-1127`).
- Produces:
  - `RelayRetryClaimOutcome` gains `'window_closed'` (13 -> 14 values).
  - `isTerminalRelayLegFailure` WARN set gains `'gate_refused'` (`window_closed` stays ERROR).
  - `RelayRetryClaimResult.closeCode?: RelayRetryGateCode | 'retry_window_closed'` (module-private), set on exactly the two decline outcomes; the failure marker carries it.
  - A DECLINED rung is APPENDED already closed, in the claim's one append transaction, never enqueued, with the member slot a job-time refusal (`refuseGate`, `relayRetryLeg.ts:449-467`) leaves for the same code: legacy `{ status: 'failed', errorCode }`; versioned `{ status: 'failed', requestedTransport?, transportAggregationState: 'excluded', errorCode }`. Every other field is what an open rung carries, the row-level `delivery_status: 'queued'` included, because the refusal's writers touch nothing but the member slot: `setRecipientDelivery` (`messagesRepo.ts:3562-3583`, SET `delivery_recipients.<key>`), `setRecipientTransportAggregationState` (`:3233-3302`, SET `delivery_recipients.<key>.transportAggregationState`), `applyRecipientSendResult` (`:3374-3514`, SET/REMOVE under `delivery_recipients.<key>` only). No second write, so no open rung ever exists to be stranded or read as "Retrying".
  - `closeRetryLegEnqueueFailed` - unchanged; the claim's only close, for `enqueue_failed` only.
  - Every rung the claim creates carries `relay_retry_window_start` (ISO) when the origin parses: rung 1 = the ROOT member slot's `sentAt`; rungs 2-3 = the previous rung row's `relay_retry_window_start`, never re-derived.

- [ ] **Step 1: Widen the exhaustive outcome test (spec D3, D9)**

In `app/test/relayRetryClaim.test.ts`, replace line 51:

Old:
```ts
  it('enumerates exactly the thirteen claim outcomes', () => {
```
New:
```ts
  it('enumerates exactly the fourteen claim outcomes', () => {
```

Replace lines 68-70:

Old:
```ts
      // Code review R1, F2: an internal fault WHILE claiming - the helper threw.
      claim_failed: true,
    };
```
New:
```ts
      // Code review R1, F2: an internal fault WHILE claiming - the helper threw.
      claim_failed: true,
      // retry-send-window D3/D9: the claim appended the rung already closed
      // because it could not go out inside the 15-minute send window.
      window_closed: true,
    };
```

And in the sorted list, replace lines 85-86:

Old:
```ts
        'to_missing',
      ].sort(),
```
New:
```ts
        'to_missing',
        'window_closed',
      ].sort(),
```

- [ ] **Step 2: Write the failing claim tests (spec D2, D3, D5, D9; test intention 2)**

In `app/test/relayRetryClaim.webhook.test.ts`:

(a) Replace line 19:

Old:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
```
New:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

(b) After line 39 (`import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';`) add:

```ts
import type { RelayRetryGateCode } from '../src/lib/relayRetryGates.js';
```

(c) After line 69 (`const PLACEMENT_ID = 'placement-relay-1';`) add:

```ts
/** Bob's number after a change (the changed-number gate, retry-send-window D3). */
const BOB_NEW = '+15558675399';

/**
 * An ISO instant `minutes` before now - a relay slot's `sentAt`, the send
 * window's origin (retry-send-window D2). Wall-clock relative, with a margin
 * of 30 seconds or more against every boundary a test aims at.
 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
```

(d) `SourceOptions` - replace lines 77-79:

Old:
```ts
  /** Bob's slot as the fan-out left it, BEFORE the failure callback. */
  bobSlot?: RelayRecipientDelivery;
}
```
New:
```ts
  /** Bob's slot as the fan-out left it, BEFORE the failure callback. */
  bobSlot?: RelayRecipientDelivery;
  /** Carol's slot, likewise (retry-send-window: the same-data comparison). */
  carolSlot?: RelayRecipientDelivery;
}
```

and in `seedSource`, replace line 178:

Old:
```ts
        [CAROL_KEY]: versioned ? versionedSlot('sent') : { status: 'sent' },
```
New:
```ts
        [CAROL_KEY]: opts.carolSlot ?? (versioned ? versionedSlot('sent') : { status: 'sent' }),
```

(e) After `failNextLeg` (after line 258, the function's closing `  }`) add:

```ts

  /**
   * Run the rung that is currently scheduled (it sends to Bob) and return that
   * rung's REAL leg SID - so a test can change the world between a rung going
   * out and its failure callback arriving.
   */
  async function runScheduledRung(): Promise<string> {
    await outbound.deliverDelayed(dispatchJob);
    await outbound.settle();
    const rows = retryRows();
    const latest = rows[rows.length - 1]!;
    const entry = [...world.relaySidPointers.entries()].find(
      ([, ref]) => ref.tsMsgId === latest.tsMsgId && ref.memberKey === BOB_KEY,
    );
    expect(entry).toBeDefined();
    return entry![0];
  }
```

(f) Before the final `});` of the file (line 827, right after the test `'still escalates a different member failing mid-ladder'`) add:

```ts

  // --- retry-send-window: the claim decides at once (spec D2, D3, D5, D9) ---
  //
  // Every NEW fixture below carries a slot `sentAt` - the window's origin
  // (D2). The older fixtures above carry none and pass through D5 unchanged:
  // their rungs are claimed without a window check, exactly as before.

  it('retry-send-window D3: with every gate passing inside the window, claims as today and carries the origin', async () => {
    const sentAt = minutesAgo(1);
    const root = await seedSource({ bobSlot: { status: 'sent', sentAt } });

    await postRootFailure();

    const rows = retryRows();
    expect(rows).toHaveLength(1);
    // D2: the ROOT member slot's sentAt, carried on the rung. The harness
    // append preserves the field (Task 2), so this cannot pass vacuously.
    expect(rows[0]!.relay_retry_window_start).toBe(sentAt);
    expect(slotOf(rows[0]!.tsMsgId)).toEqual({ status: 'queued' });
    const jobs = scheduledRetryJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.delaySeconds).toBe(60);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'claimed', retryAttempt: 1 }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
    // No D5 line: the origin was usable.
    expect(capture.atLevel(WARN).some((l) => l['windowOrigin'] !== undefined)).toBe(false);
    // The member's slot on the ROOT is untouched by the claim.
    expect(slotOf(root)).toEqual({ status: 'undelivered', errorCode: '30003', sentAt });
  });

  const claimGateCases: [string, () => void, RelayRetryGateCode][] = [
    [
      'the group closed',
      () => {
        world.conversations.get(CONV)!.status = 'closed';
      },
      'retry_group_closed',
    ],
    [
      'the member was removed',
      () => {
        const conv = world.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);
      },
      'retry_member_removed',
    ],
    [
      'the number changed',
      () => {
        const conv = world.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).map((m) =>
          m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
        );
      },
      'retry_number_changed',
    ],
    [
      'the member opted out',
      () => {
        world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
      },
      'retry_opted_out',
    ],
  ];

  it.each(claimGateCases)(
    'retry-send-window D3: when %s, rung 1 is APPENDED already CLOSED with that gate code and nothing is enqueued',
    async (_label, arrange, code) => {
      const sentAt = minutesAgo(1);
      const root = await seedSource({ bobSlot: { status: 'sent', sentAt } });
      arrange();

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      // ONE data shape: the rung exists with its full lineage and origin, and
      // is appended closed with the code the job itself would have written.
      expect(rows[0]).toMatchObject({
        relay_retry_of: root,
        relay_retry_attempt: 1,
        relay_retry_window_start: sentAt,
        delivery_status: 'queued',
      });
      expect(slotOf(rows[0]!.tsMsgId)).toEqual({ status: 'failed', errorCode: code });
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
      // WARN (Cameron's Q1 ruling), carrying the code the rung was appended with.
      expect(failureLines(WARN)).toContainEqual(
        expect.objectContaining({ retryClaim: 'gate_refused', retryAttempt: 1, closeCode: code }),
      );
      expect(capture.atLevel(ERROR)).toHaveLength(0);
      expect(slotOf(root)).toEqual({ status: 'undelivered', errorCode: '30003', sentAt });
    },
  );

  it('retry-send-window D3: with two gates refusing, the rung carries the one the JOB checks first', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    // Number changed AND opted out: the job checks the number first.
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).map((m) =>
      m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
    );
    world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB_NEW, sms_opt_out: true });

    await postRootFailure();

    expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({
      status: 'failed',
      errorCode: 'retry_number_changed',
    });
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', closeCode: 'retry_number_changed' }),
    );
  });

  it('retry-send-window D3: a gate refusal is recorded ahead of a closed window - the gates run first', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(14) } });
    world.conversations.get(CONV)!.status = 'closed';

    await postRootFailure();

    expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({
      status: 'failed',
      errorCode: 'retry_group_closed',
    });
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', closeCode: 'retry_group_closed' }),
    );
    expect(capture.atLevel(ERROR)).toHaveLength(0);
  });

  it.each([2, 3])(
    'retry-send-window D3: a member who opts out mid-ladder gets rung %i appended CLOSED at the claim, carrying the ROOT origin',
    async (rung) => {
      const sentAt = minutesAgo(1);
      await seedSource({ bobSlot: { status: 'sent', sentAt } });
      await postRootFailure(); // rung 1 claimed open
      for (let next = 2; next <= rung; next += 1) {
        const legSid = await runScheduledRung(); // rung next-1 goes out
        if (next === rung) {
          world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
        }
        await postStatus(failureParams({ MessageSid: legSid })); // ...and fails 30003
      }

      const rows = retryRows();
      expect(rows).toHaveLength(rung);
      const declined = rows[rung - 1]!;
      expect(declined.relay_retry_attempt).toBe(rung);
      // Carried rung to rung from the ROOT leg (D2), never re-derived.
      expect(declined.relay_retry_window_start).toBe(sentAt);
      expect(slotOf(declined.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_opted_out' });
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(rung - 1);
      expect(failureLines(WARN)).toContainEqual(
        expect.objectContaining({
          retryClaim: 'gate_refused',
          retryAttempt: rung,
          closeCode: 'retry_opted_out',
        }),
      );
      expect(failureLines(ERROR)).toHaveLength(0);
    },
  );

  it('retry-send-window D3: a TEAM send declined at the claim keeps its mirrored shape and its gate code', async () => {
    const sentAt = minutesAgo(1);
    await seedSource({
      direction: 'outbound',
      author: 'teammate',
      senderKey: TEAM_SENDER_KEY,
      versioned: true,
      bobSlot: { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt },
    });
    const conv = world.conversations.get(CONV)!;
    conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);

    await postRootFailure();

    const row = retryRows()[0]!;
    expect(row).toMatchObject({
      direction: 'outbound',
      author: 'teammate',
      relay_sender_key: TEAM_SENDER_KEY,
      relay_retry_origin_direction: 'outbound',
      relay_retry_window_start: sentAt,
      relay_retry_leg_body: `${TEAM_SENDER_LABEL}: ${RAW_BODY}`,
    });
    expect(slotOf(row.tsMsgId)).toEqual({
      status: 'failed',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
      errorCode: 'retry_member_removed',
    });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'gate_refused', retryAttempt: 1, closeCode: 'retry_member_removed' }),
    );
    expect(failureLines(ERROR)).toHaveLength(0);
  });

  it.each([false, true])(
    'retry-send-window D3: a rung that would send past the window is APPENDED CLOSED retry_window_closed - one write, one ERROR, nothing enqueued (versioned=%s)',
    async (versioned) => {
      // One minute of window left; rung 1 needs 60s backoff + 60s grace.
      const sentAt = minutesAgo(14);
      const root = await seedSource({
        versioned,
        bobSlot: versioned
          ? { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt }
          : { status: 'sent', sentAt },
      });
      // The three writers a job-time refusal uses. The root leg's own writes
      // go through updateRecipientDeliveryStatus / setRecipientActualTransport,
      // so any call to these would be a second write on the rung.
      const setSlot = vi.spyOn(world.messagesRepo, 'setRecipientDelivery');
      const setState = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
      const applyResult = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relay_retry_window_start).toBe(sentAt);
      // The SAME slot the job's own window refusal leaves (Task 5 pins the job
      // side to this identical literal) - written by the append alone.
      expect(slotOf(rows[0]!.tsMsgId)).toEqual(
        versioned
          ? {
              status: 'failed',
              requestedTransport: 'sms',
              transportAggregationState: 'excluded',
              errorCode: 'retry_window_closed',
            }
          : { status: 'failed', errorCode: 'retry_window_closed' },
      );
      expect(setSlot).not.toHaveBeenCalled();
      expect(setState).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      expect(scheduledRetryJobs()).toHaveLength(0);
      expect(world.sent).toHaveLength(0);
      // D9: ONE ERROR line - the marker, through isTerminalRelayLegFailure.
      expect(capture.atLevel(ERROR)).toHaveLength(1);
      expect(failureLines(ERROR)).toContainEqual(
        expect.objectContaining({
          retryClaim: 'window_closed',
          retryAttempt: 1,
          closeCode: 'retry_window_closed',
          errorCode: '30003',
        }),
      );
      expect(failureLines(WARN)).toHaveLength(0);
      if (!versioned) {
        expect(slotOf(root)).toEqual({ status: 'undelivered', errorCode: '30003', sentAt });
      }
    },
  );

  it('retry-send-window D2/D3: rung 2 measures from the ORIGIN rung 1 carried, never from the fresh send of rung 1', async () => {
    // 2.5 minutes of window left. Rung 1 needs 60s backoff + 60s grace: it
    // fits. Rung 2 needs 120s + 60s: it does not - measured from the ROOT
    // leg's send. Rung 1's own slot gets a FRESH sentAt when it goes out, so a
    // claim that re-derived the origin from that slot would find the whole
    // window left and claim.
    const sentAt = minutesAgo(12.5);
    await seedSource({ bobSlot: { status: 'sent', sentAt } });
    await postRootFailure();
    expect(retryRows()[0]!.relay_retry_window_start).toBe(sentAt);
    expect(scheduledRetryJobs()).toHaveLength(1);

    await failNextLeg(); // rung 1 goes out, then its own leg fails 30003

    const rows = retryRows();
    expect(rows).toHaveLength(2);
    const rungOneSentAt = slotOf(rows[0]!.tsMsgId)?.sentAt;
    expect(rungOneSentAt).toBeDefined();
    expect(Date.now() - Date.parse(rungOneSentAt!)).toBeLessThan(60_000);
    // Copied from rung 1's row, not re-derived from rung 1's own slot.
    expect(rows[1]!.relay_retry_window_start).toBe(sentAt);
    expect(slotOf(rows[1]!.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_window_closed' });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(ERROR)).toContainEqual(
      expect.objectContaining({
        retryClaim: 'window_closed',
        retryAttempt: 2,
        closeCode: 'retry_window_closed',
      }),
    );
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['unparseable', 'not-a-date'],
  ])(
    'retry-send-window D5: a %s slot sentAt fails OPEN - claimed without a window check, with one WARN naming the gap',
    async (label, sentAt) => {
      await seedSource({ bobSlot: sentAt === undefined ? { status: 'sent' } : { status: 'sent', sentAt } });

      await postRootFailure();

      const rows = retryRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.relay_retry_window_start).toBeUndefined();
      expect(scheduledRetryJobs()).toHaveLength(1);
      expect(failureLines(WARN)).toContainEqual(expect.objectContaining({ retryClaim: 'claimed' }));
      const gap = capture.atLevel(WARN).filter((l) => l['windowOrigin'] !== undefined);
      expect(gap).toHaveLength(1);
      expect(gap[0]).toMatchObject({
        windowOrigin: label,
        originField: 'sentAt',
        attempt: 1,
        memberKey: BOB_KEY,
        retryTsMsgId: rows[0]!.tsMsgId,
      });
      expect(JSON.stringify(gap[0])).not.toContain(BOB);
    },
  );

  it.each([false, true])(
    'retry-send-window D3: a claim-time decline appends the SAME rung data the job refusal leaves for that code (versioned=%s)',
    async (versioned) => {
      const sentAt = minutesAgo(1);
      const legSlot = (): RelayRecipientDelivery =>
        versioned
          ? { status: 'sent', requestedTransport: 'sms', transportAggregationState: 'attempted', sentAt }
          : { status: 'sent', sentAt };
      await seedSource({ versioned, bobSlot: legSlot(), carolSlot: legSlot() });
      // Carol's leg fails while the group is OPEN: her rung is claimed open.
      await postStatus(failureParams({ MessageSid: CAROL_LEG_SID, To: CAROL }));
      // The group closes. Bob's leg fails now: the CLAIM declines his rung and
      // appends it already closed - it is never enqueued, so only Carol's
      // rung is waiting. (Before this task both rungs were enqueued and the
      // job refused both, which would make the comparison below vacuous.)
      world.conversations.get(CONV)!.status = 'closed';
      await postRootFailure();
      expect(scheduledRetryJobs()).toHaveLength(1);
      const bobRung = retryRows().find((r) => r.relay_retry_member_key === BOB_KEY)!;
      expect(slotOf(bobRung.tsMsgId, BOB_KEY)).toMatchObject({
        status: 'failed',
        errorCode: 'retry_group_closed',
      });
      // Carol's rung runs, and the JOB refuses it at its own gate.
      await outbound.deliverDelayed(dispatchJob);
      await outbound.settle();
      const carolRung = retryRows().find((r) => r.relay_retry_member_key === CAROL_KEY)!;

      /** A rung's data minus what is per-member by construction - its key,
       *  provider identity, timestamps and destination digest - with the
       *  member slot read under the rung's own key. */
      const rungData = (row: MessageItem, key: string) => {
        const {
          tsMsgId: _tsMsgId,
          provider_sid: _providerSid,
          provider_ts: _providerTs,
          created_at: _createdAt,
          relay_retry_member_key: _memberKey,
          relay_retry_dest_digest: _destDigest,
          delivery_recipients: slots,
          ...rest
        } = row;
        return { ...rest, slot: slots?.[key] };
      };
      // Field by field - the row-level delivery_status included - the rung the
      // claim appended closed equals the rung the job closed.
      expect(rungData(bobRung, BOB_KEY)).toEqual(rungData(carolRung, CAROL_KEY));
      expect(bobRung.delivery_status).toBe('queued');
      expect(world.sent).toHaveLength(0);
    },
  );

  it.each<[string, number, boolean, RelayRetryGateCode | 'retry_window_closed']>([
    ['a gate decline', 1, true, 'retry_group_closed'],
    ['a window decline', 14, false, 'retry_window_closed'],
  ])(
    'retry-send-window D3: on %s the rung is APPENDED closed - one write, nothing closes it after - and the ROOT SSE fires once, after that write',
    async (_label, sentMinutesAgo, closeGroup, code) => {
      // The crash-recovery shape (the slot is already terminal on 30003):
      // nothing transitions, so the tail's own emit cannot fire and the ONLY
      // root emit is the claim's.
      const root = await seedSource({
        bobSlot: { status: 'undelivered', errorCode: '30003', sentAt: minutesAgo(sentMinutesAgo) },
      });
      if (closeGroup) world.conversations.get(CONV)!.status = 'closed';
      const rootEmits = (): number =>
        world.emitted.filter(
          (e) =>
            e.event === 'message.persisted' &&
            (e.payload as { tsMsgId?: string }).tsMsgId === root,
        ).length;
      // Record what the rung's append carried, and how many root emits had
      // already happened when it ran.
      let appendedSlot: RelayRecipientDelivery | undefined;
      let emitsAtAppend = -1;
      const realAppend = world.messagesRepo.append.bind(world.messagesRepo);
      world.messagesRepo.append = async (message) => {
        if (message.relayRetryOf !== undefined) {
          appendedSlot = message.deliveryRecipients?.[BOB_KEY];
          emitsAtAppend = rootEmits();
        }
        return realAppend(message);
      };
      const setSlot = vi.spyOn(world.messagesRepo, 'setRecipientDelivery');
      const setState = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
      const applyResult = vi.spyOn(world.messagesRepo, 'applyRecipientSendResult');

      await postRootFailure();

      // The append itself carried the final closed slot ...
      expect(appendedSlot).toEqual({ status: 'failed', errorCode: code });
      expect(slotOf(retryRows()[0]!.tsMsgId)).toEqual({ status: 'failed', errorCode: code });
      // ... and no second write touched the rung afterwards.
      expect(setSlot).not.toHaveBeenCalled();
      expect(setState).not.toHaveBeenCalled();
      expect(applyResult).not.toHaveBeenCalled();
      // The claim's root SSE fires once, AFTER that one write.
      expect(emitsAtAppend).toBe(0);
      expect(rootEmits()).toBe(1);
      expect(scheduledRetryJobs()).toHaveLength(0);
    },
  );

  it('retry-send-window D3: a duplicate callback for an OPEN rung answers already_claimed and changes nothing, whatever its own preview says', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    await postRootFailure();
    const rung = retryRows()[0]!;
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'queued' });
    // Between the two deliveries the group closes, so THIS callback's own
    // preview declines. Its append dedupes: the rung an earlier callback
    // opened stays open and enqueued.
    world.conversations.get(CONV)!.status = 'closed';

    await postRootFailure();

    expect(retryRows()).toHaveLength(1);
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'queued' });
    expect(scheduledRetryJobs()).toHaveLength(1);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'already_claimed', retryAttempt: 1 }),
    );
    expect(failureLines(WARN).some((l) => l['retryClaim'] === 'gate_refused')).toBe(false);
  });

  it('retry-send-window D3: a duplicate callback for a CLOSED rung answers already_claimed and enqueues nothing, whatever its own preview says', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    world.conversations.get(CONV)!.status = 'closed';
    await postRootFailure();
    const rung = retryRows()[0]!;
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_group_closed' });
    // The group reopens: THIS callback's preview would pass. Its append
    // dedupes: the rung an earlier callback closed stays closed.
    world.conversations.get(CONV)!.status = 'open';

    await postRootFailure();

    expect(retryRows()).toHaveLength(1);
    expect(slotOf(rung.tsMsgId)).toEqual({ status: 'failed', errorCode: 'retry_group_closed' });
    expect(scheduledRetryJobs()).toHaveLength(0);
    expect(failureLines(WARN)).toContainEqual(
      expect.objectContaining({ retryClaim: 'already_claimed', retryAttempt: 1 }),
    );
  });

  it('retry-send-window D3: a gate-preview read that THROWS is claim_failed - one ERROR, a 5xx, no rung - and the redelivery claims', async () => {
    await seedSource({ bobSlot: { status: 'sent', sentAt: minutesAgo(1) } });
    // The suppression read (the evaluator's one read) fails ONCE.
    const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    let failed = false;
    world.contactsRepo.getById = async (contactId) => {
      if (!failed && contactId === BOB_KEY) {
        failed = true;
        throw new Error('dynamodb throttled');
      }
      return realGetById(contactId);
    };

    const res = await signedTwilioPost(app, STATUS_PATH, failureParams());

    expect(res.status).toBe(500);
    expect(failed).toBe(true);
    expect(retryRows()).toHaveLength(0);
    expect(capture.atLevel(ERROR)).toHaveLength(1);
    expect(failureLines(ERROR)).toContainEqual(expect.objectContaining({ retryClaim: 'claim_failed' }));

    await postRootFailure(); // Twilio's redelivery re-runs the claim

    expect(retryRows()).toHaveLength(1);
    expect(scheduledRetryJobs()).toHaveLength(1);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd app; npx vitest run test/relayRetryClaim.test.ts test/relayRetryClaim.webhook.test.ts`
Expected: `relayRetryClaim.test.ts` PASSES at runtime (the union check is compile-time: `npm run typecheck` reports `window_closed` as an unknown property of `Record<RelayRetryClaimOutcome, true>` until Step 4). `relayRetryClaim.webhook.test.ts`: every new `retry-send-window` case FAILS - the rung is appended OPEN and enqueued (so the same-data case sees two scheduled rungs, and the one-write case sees a `queued` slot in the append), it carries no `relay_retry_window_start`, no gap WARN is logged, and the preview-read case gets a 200 - EXCEPT the open-rung duplicate case, a pin that already passes. Every pre-existing case passes.

- [ ] **Step 4: Widen the outcome union (spec D3, D9)**

In `app/src/lib/relayRetryClaim.ts`, replace line 51:

Old:
```ts
  | 'gate_refused'
```
New:
```ts
  /**
   * A job gate refuses the rung: group closed, member removed, number changed
   * or opted out. The relay JOB logs it when its send-time gate refuses; since
   * retry-send-window D3 the CLAIM returns it too, when its gate preview sees
   * that refusal coming and appends the rung already closed with the gate's
   * code. WARN on both ends (Cameron's Q1 ruling, 2026-09-24): a deliberate
   * human action, not a fault.
   */
  | 'gate_refused'
```

and replace lines 76-77:

Old:
```ts
  | 'code_not_retryable'
  | 'enqueue_failed'
```
New:
```ts
  | 'code_not_retryable'
  | 'enqueue_failed'
  /**
   * retry-send-window D3: the claim appended rung N already CLOSED with
   * `retry_window_closed`, because it could not go out inside the send window
   * (its send time plus RETRY_JOB_GRACE_MS lands after the member's original
   * leg send plus 15 minutes). Nothing is enqueued. ERROR (D9): the member
   * never got the text - a dead end, like `cap_exhausted`. The relay JOB logs
   * the same value for its own window closes.
   */
  | 'window_closed'
```

- [ ] **Step 5: Implement the claim in the webhook (spec D2, D3, D5, D9)**

In `app/src/routes/webhooks/twilio.ts`:

(a) Imports. Replace lines 72-79:

Old:
```ts
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type DeliveryStatus,
  type MediaAttachment,
  type MessagesRepo,
} from '../../repos/messagesRepo.js';
```
New:
```ts
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type DeliveryStatus,
  type MediaAttachment,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../../repos/messagesRepo.js';
```

Replace line 139:

Old:
```ts
import { enqueueRelayRetryLeg } from '../../jobs/relayRetryLeg.js';
```
New:
```ts
import { enqueueRelayRetryLeg, resolveRelayRetryBackoff } from '../../jobs/relayRetryLeg.js';
```

and after line 145 (`} from '../../lib/relayRetryClaim.js';`) add:

```ts
import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../../lib/relayRetryGates.js';
import { parseRetryWindowOrigin, retryFitsSendWindow } from '../../lib/retrySendWindow.js';
```

(b) `RelayRetryClaimResult` - replace lines 387-392:

Old:
```ts
/** What the claim decided, plus the rung it claimed (for the failure log). */
interface RelayRetryClaimResult {
  outcome: RelayRetryClaimOutcome;
  /** The 1-based rung, present only where a retry ROW exists for it. */
  attempt?: number;
}
```
New:
```ts
/** What the claim decided, plus the rung it claimed (for the failure log). */
interface RelayRetryClaimResult {
  outcome: RelayRetryClaimOutcome;
  /** The 1-based rung, present only where a retry ROW exists for it. */
  attempt?: number;
  /**
   * retry-send-window D3: the code a declined rung was APPENDED with (a gate
   * code, or `retry_window_closed`) - set on exactly `gate_refused` and
   * `window_closed`, the two claim-time declines. The failure marker carries
   * it, as the enqueue-failure line carries the code its close wrote.
   */
  closeCode?: RelayRetryGateCode | 'retry_window_closed';
}
```

(c) `isTerminalRelayLegFailure`. Replace line 399:

Old:
```ts
 * Four properties are load-bearing and none is obvious:
```
New:
```ts
 * Five properties are load-bearing and none is obvious:
```

Replace lines 423-428:

Old:
```ts
 *   - Every OTHER terminal 30003 on a fan-out or team leg is ERROR, whether the
 *     ladder ran to its cap, was refused at a gate, or was never claimed at all
 *     (`to_missing`, `to_malformed`, `source_unreadable`, `slot_ineligible`,
 *     `enqueue_failed`, `claim_failed`). What matters is the PRODUCT the leg
 *     belongs to, not whether the ladder happened to start - that whole set is
 *     what was approved.
```
New:
```ts
 *   - `gate_refused` stays WARN (retry-send-window spec D3, by Cameron's Q1
 *     ruling of 2026-09-24). The claim now previews the retry job's four gates
 *     and, when one would refuse, appends the rung already closed with that
 *     gate's code. A closed group, a removed member, a changed number and an
 *     opt-out are deliberate human actions, not faults - the job's own refusal
 *     of the same rung has logged WARN since that ruling, and the claim seeing
 *     it sooner must not turn it into an alarm.
 *   - Every OTHER terminal 30003 on a fan-out or team leg is ERROR, whether the
 *     ladder ran to its cap, could not go out inside the 15-minute send window
 *     (`window_closed`, retry-send-window D9 - the member never got the text, a
 *     dead end like the cap), or was never claimed at all (`to_missing`,
 *     `to_malformed`, `source_unreadable`, `slot_ineligible`, `enqueue_failed`,
 *     `claim_failed`). What matters is the PRODUCT the leg belongs to, not
 *     whether the ladder happened to start - that whole set is what was
 *     approved.
```

Replace lines 439-444:

Old:
```ts
  return (
    claim !== 'claimed' &&
    claim !== 'already_claimed' &&
    claim !== 'fenced_announcement' &&
    claim !== 'slot_settled'
  );
```
New:
```ts
  return (
    claim !== 'claimed' &&
    claim !== 'already_claimed' &&
    claim !== 'fenced_announcement' &&
    claim !== 'slot_settled' &&
    claim !== 'gate_refused'
  );
```

(d) The claim's doc. Replace lines 2665-2669:

Old:
```ts
     * A retry is a NEW single-recipient source row, never a promotion of the
     * failed slot (D1), and the row's `sid#<providerSid>` pointer create IS the
     * atomic claim - a duplicate, redelivered or concurrent callback loses that
     * create and claims nothing.
     *
```
New:
```ts
     * A retry is a NEW single-recipient source row, never a promotion of the
     * failed slot (D1), and the row's `sid#<providerSid>` pointer create IS the
     * atomic claim - a duplicate, redelivered or concurrent callback loses that
     * create and claims nothing.
     *
     * It also DECIDES, before the rung exists, whether the rung will be
     * attempted (retry-send-window spec D3): the retry job's four gates are
     * previewed through the job's own evaluator, then the 15-minute send window
     * is checked, and a rung that either check refuses is APPENDED already
     * CLOSED - in that same single write - and never enqueued, so the leg
     * shows at once whether a retry is coming.
     *
```

(e) Step 7a. Replace lines 2780-2781:

Old:
```ts
          : await composeRelayLegCopy(ptr.conversationId, senderKey, rawBody, sourceMedia.length);
      const appended = await messages.append({
```
New:
```ts
          : await composeRelayLegCopy(ptr.conversationId, senderKey, rawBody, sourceMedia.length);

      // 7a. Decide NOW whether rung N will be attempted (retry-send-window spec
      // D3), so the leg shows at once whether a retry is coming - never
      // "Retrying" for the 1 to 4 minutes before the job refuses a rung the
      // claim could already see was doomed. The decision is known BEFORE the
      // append, so it is recorded IN the append: a declined rung is written
      // already closed, ONE data shape (the one a job-time refusal already
      // leaves), and the append's SID dedupe still answers a duplicate callback
      // with no separate lookup. The member's slot on the ROOT is never touched.
      //
      // First the job's four gates, in the job's own order (group open, on the
      // roster, number unchanged, not opted out), through the SAME evaluator
      // the job runs, so "that gate's code" is deterministic when two apply.
      // The job still re-runs every gate at send time: a group can close during
      // the backoff. A read that THROWS here is the existing `claim_failed`
      // (ERROR, a 5xx, and Twilio's redelivery re-runs the claim), like every
      // read above.
      const conversation = await conversations.getById(ptr.conversationId);
      const gate = await evaluateRelayRetryGates({
        conversation,
        memberKey: ptr.memberKey,
        rootTsMsgId,
        destDigest,
        isSuppressed: (member) => isMemberSuppressed(contacts, conversations, member),
      });
      // D2: where this ladder's window started. Step 6 fell back to
      // `ptr.tsMsgId` for the root key exactly when this callback is for the
      // ROOT's own leg - rung 1 - whose origin is that member slot's `sentAt`:
      // the leg's real send time (Twilio's dateCreated), never the root row's
      // timestamp, which is receipt or compose time and, for a message held
      // while a group connects, can precede the send by a long time. Rungs 2-3
      // are claimed off the previous RETRY row and copy the origin it carries -
      // never re-derived from that row's own slot, which would restart the
      // window on every rung.
      const onRootLeg = rootTsMsgId === ptr.tsMsgId;
      const originRaw: unknown = onRootLeg ? slot.sentAt : src.relay_retry_window_start;
      const originMs = parseRetryWindowOrigin(originRaw);
      let decline: RelayRetryGateCode | 'retry_window_closed' | undefined;
      let originGap: 'missing' | 'unparseable' | undefined;
      if (gate.refused) {
        decline = gate.code;
      } else if (originMs === undefined) {
        // D5: no usable origin fails OPEN - the rung is claimed without a
        // window check, and a WARN names the gap once the rung exists (below).
        originGap = originRaw === undefined ? 'missing' : 'unparseable';
      } else if (
        !retryFitsSendWindow({
          originMs,
          nowMs: Date.now(),
          // The SAME resolution chain `enqueueRelayRetryLeg` schedules this
          // rung with, so the check measures the send time the queue honors.
          backoffMs: resolveRelayRetryBackoff()(attempt),
        })
      ) {
        // Then the window (D1, D3 step 2): now + backoff + RETRY_JOB_GRACE_MS
        // must still fit inside origin + RETRY_SEND_WINDOW_MS.
        decline = 'retry_window_closed';
      }
      // The rung's member slot. An OPEN rung is seeded `queued` for its job,
      // as always. A DECLINED rung is appended ALREADY CLOSED, with exactly the
      // slot the job's own pre-send refusal (`refuseGate` in
      // `jobs/relayRetryLeg.ts`) leaves for that code - in this one write, not
      // a second one, so no open rung ever exists to be stranded or to be read
      // as "Retrying" by a refetch. The refusal's writers touch nothing but
      // this slot (`setRecipientTransportAggregationState`,
      // `applyRecipientSendResult`, `setRecipientDelivery` in
      // `repos/messagesRepo.ts`), so every other field of the rung - its
      // row-level `delivery_status` included - is the same either way; and
      // `append`'s shape check covers transport fields only, so it accepts a
      // closed slot.
      let rungSlot: RelayRecipientDelivery;
      if (decline === undefined) {
        rungSlot = versioned
          ? {
              status: 'queued',
              ...(requestedTransport !== undefined && { requestedTransport }),
              // `attempted` is reachable ONLY from `planned`, so a slot seeded
              // without it throws on the first retry send.
              transportAggregationState: 'planned',
            }
          : { status: 'queued' };
      } else if (versioned) {
        // The versioned refusal's two writes - aggregation `excluded`, then
        // the failed slot with the code - folded into the one.
        rungSlot = {
          status: 'failed',
          ...(requestedTransport !== undefined && { requestedTransport }),
          transportAggregationState: 'excluded',
          errorCode: decline,
        };
      } else {
        // `markRecipient`'s whole-slot write: nothing else survives in it.
        rungSlot = { status: 'failed', errorCode: decline };
      }
      const appended = await messages.append({
```

(f) The append seeds the decided slot. Replace lines 2802-2812:

Old:
```ts
        deliveryRecipients: {
          [ptr.memberKey]: versioned
            ? {
                status: 'queued' as const,
                ...(requestedTransport !== undefined && { requestedTransport }),
                // `attempted` is reachable ONLY from `planned`, so a slot seeded
                // without it throws on the first retry send.
                transportAggregationState: 'planned' as const,
              }
            : { status: 'queued' as const },
        },
```
New:
```ts
        // The member slot step 7a decided: open for its job, or - for a
        // decline - already closed, in this same write.
        deliveryRecipients: { [ptr.memberKey]: rungSlot },
```

(g) The append carries the origin. Replace lines 2826-2830:

Old:
```ts
        relayRetryLegBody: legBody,
        // DELIBERATELY no `retryOf`: stamping it would add the ORIGINAL to the
        // timeline's supersededIds and DELETE the bubble this retry is meant to
        // render beside - the display contract, inverted.
      });
```
New:
```ts
        relayRetryLegBody: legBody,
        // retry-send-window D2: the ladder's window origin, carried on every
        // rung so rungs 2-3 measure from the member's ORIGINAL leg send.
        // Normalized to ISO; absent when there is no usable origin (D5).
        ...(originMs !== undefined && {
          relayRetryWindowStart: new Date(originMs).toISOString(),
        }),
        // DELIBERATELY no `retryOf`: stamping it would add the ORIGINAL to the
        // timeline's supersededIds and DELETE the bubble this retry is meant to
        // render beside - the display contract, inverted.
      });
```

(h) Dedupe, the D5 WARN and the declined exit. Replace lines 2831-2840:

Old:
```ts
      if (appended.deduped) {
        // A sibling callback won the create. The ladder is running; claim nothing
        // further and do not re-emit for it.
        return { outcome: 'already_claimed', attempt };
      }

      // 8. Hand the rung to the queue. The claim defeats duplicate CALLBACKS;
      // the job's own execution marker defeats duplicate DELIVERIES.
      const retryTsMsgId = appended.tsMsgId;
      let outcome: RelayRetryClaimOutcome = 'claimed';
```
New:
```ts
      if (appended.deduped) {
        // A sibling callback won the create. The ladder is running - or its
        // rung was already appended CLOSED - so claim nothing further and do
        // not re-emit for it. The dedupe also means THIS callback wrote
        // nothing, whatever its own preview decided (retry-send-window D3): a
        // duplicate can never close a rung an earlier callback opened, nor
        // open one it closed.
        return { outcome: 'already_claimed', attempt };
      }
      const retryTsMsgId = appended.tsMsgId;
      if (originGap !== undefined) {
        // D5, logged only for a rung THIS claim created (a duplicate returned
        // above), so a redelivered callback does not repeat it.
        log.warn(
          {
            conversationId: ptr.conversationId,
            retryTsMsgId,
            rootTsMsgId,
            attempt,
            memberKey: logSafeStoredRelayMemberKey(ptr.memberKey),
            windowOrigin: originGap,
            originField: onRootLeg ? 'sentAt' : 'relay_retry_window_start',
          },
          'relay retry claim: no usable send-window origin - rung claimed without a window check (spec D5)',
        );
      }
      /** Step 9's emit, shared by both exits below (see step 9). */
      const announceRootClaim = (): void => {
        events.emit('message.persisted', {
          conversationId: ptr.conversationId,
          tsMsgId: rootTsMsgId,
          direction: 'inbound',
          deliveryStatus: mapped,
        });
      };

      if (decline !== undefined) {
        // 8a. A DECLINED rung (retry-send-window D3). The append above wrote it
        // already CLOSED, in the one transaction that IS the claim, so there is
        // nothing to enqueue and nothing left to close. The dashboard join
        // renders it exactly as a rung the job refused: a gate code reads "Not
        // retried - ...", and `retry_window_closed` leaves the original's 30003
        // standing. Step 9's SSE fires after that one write.
        announceRootClaim();
        return {
          outcome: decline === 'retry_window_closed' ? 'window_closed' : 'gate_refused',
          attempt,
          closeCode: decline,
        };
      }

      // 8. Hand the rung to the queue. The claim defeats duplicate CALLBACKS;
      // the job's own execution marker defeats duplicate DELIVERIES.
      let outcome: RelayRetryClaimOutcome = 'claimed';
```

The enqueue that follows (`:2841-2891`), with `closeRetryLegEnqueueFailed` on its failure, is unchanged.

(i) Step 9 - replace lines 2900-2906:

Old:
```ts
      events.emit('message.persisted', {
        conversationId: ptr.conversationId,
        tsMsgId: rootTsMsgId,
        direction: 'inbound',
        deliveryStatus: mapped,
      });
      return { outcome, attempt };
```
New:
```ts
      announceRootClaim();
      return { outcome, attempt };
```

(The step-9 comment at `:2893-2899` stays as it is, directly above.)

(j) The failure marker carries the code. Replace lines 3077-3079:

Old:
```ts
          retryClaim: retryClaim.outcome,
          ...(retryClaim.attempt !== undefined && { retryAttempt: retryClaim.attempt }),
        };
```
New:
```ts
          retryClaim: retryClaim.outcome,
          ...(retryClaim.attempt !== undefined && { retryAttempt: retryClaim.attempt }),
          // retry-send-window D3: the code a declined rung was appended with -
          // present on `gate_refused` and `window_closed` only.
          ...(retryClaim.closeCode !== undefined && { closeCode: retryClaim.closeCode }),
        };
```

The severity call below it is unchanged: `isTerminalRelayLegFailure` now answers WARN for `gate_refused` and ERROR for `window_closed` (spec D9), and both take the shared carrier-shaped message.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/relayRetryClaim.test.ts test/relayRetryClaim.webhook.test.ts test/twilioStatusWebhook.test.ts test/relayRetryLeg.test.ts test/relayRetryGates.test.ts`
Expected: PASS. The pre-existing claim cases (fixtures without a slot `sentAt`) pass through D5 unchanged, the enqueue-failure cases (`'closes the retry leg enqueue_failed when the enqueue throws'`, its versioned twin and `'keeps enqueue_failed when the enqueue-failure close throws as well'`) still exercise the untouched `closeRetryLegEnqueueFailed`, and the relay severity battery in `twilioStatusWebhook.test.ts:1256-1419` is unchanged (its rung-3 case stops at the cap, before the preview).

- [ ] **Step 6b: Pin the plan's Review Focus case 3**

Add to `app/test/relayRetryClaim.webhook.test.ts`, directly after the test `'retry-send-window D2/D3: rung 2 measures from the ORIGIN rung 1 carried, never from the fresh send of rung 1'` (same `describe`, same helpers):

```ts
  it('Review Focus 3: rung 2 of a ladder whose rung 1 predates this deploy (no carried origin) claims OPEN, with one WARN naming the gap', async () => {
    // 12.5 minutes after the root leg's send: a windowed rung 2 (120 s backoff
    // + 60 s grace) would be declined. Without a carried origin the claim
    // cannot measure the window, so it must not decline on it (spec D5).
    const sentAt = minutesAgo(12.5);
    await seedSource({ bobSlot: { status: 'sent', sentAt } });
    await postRootFailure();
    // A rung 1 written before this deploy carries no origin. retryRows()
    // returns the stored rows, so this edits the world.
    delete (retryRows()[0] as { relay_retry_window_start?: string }).relay_retry_window_start;

    await failNextLeg(); // rung 1 goes out, then its own leg fails 30003

    const rows = retryRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.relay_retry_window_start).toBeUndefined();
    expect(slotOf(rows[1]!.tsMsgId)?.status).toBe('queued');
    const gap = capture.atLevel(WARN).filter((l) => l['windowOrigin'] !== undefined);
    expect(gap).toContainEqual(
      expect.objectContaining({
        windowOrigin: 'missing',
        originField: 'relay_retry_window_start',
        attempt: 2,
      }),
    );
  });
```

Run: `cd app; npx vitest run test/relayRetryClaim.webhook.test.ts`
Expected: PASS (Step 5's origin resolution reads `src.relay_retry_window_start` for rungs 2-3 and fails open on its absence). It fails if the claim ever re-derives the origin from rung 1's own slot or declines without one.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/lib/relayRetryClaim.ts app/src/routes/webhooks/twilio.ts app/test/relayRetryClaim.test.ts app/test/relayRetryClaim.webhook.test.ts
git commit -m "feat(relay-retry): the claim decides at once - gate preview and send window (spec D2, D3, D5, D9)

After the cap check the 30003 claim previews the retry job's four gates
through the shared evaluator, then checks the 15-minute send window from the
member's original leg send, carried on every rung as relay_retry_window_start.
A declined rung is appended already closed, in the claim's one append, with
the member slot the job's own refusal leaves for that code - the gate code
(gate_refused, WARN) or retry_window_closed (window_closed, ERROR) - and is
never enqueued: no second write, so no open rung to strand. The root SSE fires
after that append; a duplicate callback still answers already_claimed first; a
missing or unparseable origin fails open with a WARN.
closeRetryLegEnqueueFailed is unchanged and remains the claim's only close.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/lib/relayRetryClaim.ts app/src/routes/webhooks/twilio.ts app/test/relayRetryClaim.test.ts app/test/relayRetryClaim.webhook.test.ts
```

---

### Task 5: The relay job's send-window gate, optional lineage field and transient re-check (spec D2, D4, D5, D9)

**Files:**
- Modify: `app/src/jobs/relayRetryLeg.ts` - `:1-7` (header), the imports (after Task 3's `relayRetryGates` import), `RelayRetryCloseCode` (Task 3's text at `:80-93`), `:260-292` (lineage: an OPTIONAL `windowStart`), `:371` (destructure), a new step 4b between Task 3's gate block and the media-without-store ERROR (`:557` at HEAD), `:643-646` (the transient re-enqueue re-checks the window)
- Test: `app/test/relayRetryLeg.test.ts` - after `:96-98` (`minutesAgo`), `:139` and `:183` (a `windowStart` seed option), `:307-377` (the gate-case table gains the window row), a new section before `:425` (`// --- D12: the send, and the leg copy frozen at claim time ---`)

**Interfaces:**
- Consumes: Task 1 `parseRetryWindowOrigin`, `withinRetrySendWindow(args: { originMs: number; nowMs: number }): boolean`, `retryFitsSendWindow`; Task 2 `MessageItem.relay_retry_window_start?: string`; Task 3's gate block (`member`, `memberLog`, `refuseGate`).
- Produces: `RelayRetryCloseCode` gains `'retry_window_closed'`; the job's window closes log `{ retryClaim: 'window_closed', closeCode: 'retry_window_closed', windowCheck: 'gate' | 'transient_reschedule' }` at ERROR; the D5 gap logs `{ windowOrigin: 'missing' | 'unparseable' }` at WARN; a handler-scope `const originMs: number | undefined` that Task 6 reads.

- [ ] **Step 1: Write the failing tests (spec D2, D4, D5, D9; test intention 3)**

In `app/test/relayRetryLeg.test.ts`:

(a) After `legArgs` (lines 96-98) add:

```ts

/**
 * An ISO instant `minutes` before now: a rung's carried send-window origin
 * (retry-send-window D2). Wall-clock relative, with a margin of 30 seconds or
 * more against every boundary a test aims at.
 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
```

(b) In `SeedRetryOptions`, replace line 139:

Old:
```ts
  legBody?: string;
}
```
New:
```ts
  legBody?: string;
  /** retry-send-window D2: the origin the claim carried on the row
   *  (`relay_retry_window_start`). Absent = a rung claimed before the window
   *  shipped (D5). */
  windowStart?: string;
}
```

and in `seedRetryRow`'s row literal, replace line 183:

Old:
```ts
    relay_retry_leg_body: opts.legBody ?? LEG_BODY,
```
New:
```ts
    relay_retry_leg_body: opts.legBody ?? LEG_BODY,
    ...(opts.windowStart !== undefined && { relay_retry_window_start: opts.windowStart }),
```

(c) Replace the gate-case table and its `it.each` (lines 307-377, from `  const gateCases: [string, (world: FakeWorld) => void, string][] = [` through the `it.each`'s closing `  );`) with:

```ts
  const gateCases: [string, (world: FakeWorld) => void, string, ('warn' | 'error')?][] = [
    [
      'closed group',
      (w) => {
        w.conversations.get(CONV)!.status = 'closed';
      },
      'retry_group_closed',
    ],
    [
      'removed member',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).filter((m) => m.contactId !== BOB_KEY);
      },
      'retry_member_removed',
    ],
    [
      'changed number',
      (w) => {
        const conv = w.conversations.get(CONV)!;
        conv.participants = (conv.participants ?? []).map((m) =>
          m.contactId === BOB_KEY ? { ...m, phone: BOB_NEW } : m,
        );
      },
      'retry_number_changed',
    ],
    [
      'opted out',
      (w) => {
        w.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
      },
      'retry_opted_out',
    ],
    [
      // retry-send-window D4: the send window is the LAST gate, and the one
      // that logs ERROR (D9) - the member never got the text, a dead end like
      // the cap, not a deliberate human action like the four above.
      'send window closed',
      (w) => {
        const row = w.messages.find((m) => m.relay_retry_of === ROOT_TS_MSG_ID)!;
        row.relay_retry_window_start = minutesAgo(16);
      },
      'retry_window_closed',
      'error',
    ],
  ];

  it.each(gateCases)(
    'refuses on %s, closes the retry leg with its code, and logs it at the ruled level',
    async (_name, arrange, code, level = 'warn') => {
      seedRelay(world);
      const row = seedRetryRow(world);
      arrange(world);
      register();

      await runHandler(payloadFor(row));

      expect(world.sent).toHaveLength(0);
      expect(legSend.calls).toHaveLength(0);
      expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: code });
      // The chain ENDS: nothing further is scheduled, on either ladder.
      expect(outbound.delayed).toHaveLength(0);
      // WARN for the four human-action gates (Cameron's Q1 ruling,
      // 2026-09-24), so they never feed the ErrorLogs alarms; ERROR for the
      // send window (retry-send-window D9).
      const terminal = (level === 'warn' ? warnLogs() : errorLogs()).filter(
        (l) => l['closeCode'] === code,
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        event: 'relay_retry_leg',
        relay: true,
        retryClaim: level === 'warn' ? 'gate_refused' : 'window_closed',
        rootTsMsgId: ROOT_TS_MSG_ID,
        attempt: 1,
      });
      expect(errorLogs().some((l) => l['retryClaim'] === 'gate_refused')).toBe(false);
      // Finding P1: the close ANNOUNCES, once, for the ROOT. Without it the
      // refusal is durable but invisible - the chip keeps reading `retrying`
      // until an unrelated SSE arrives, then ages into `not confirmed`.
      // Length 1 over ALL message.persisted emits is what pins "for the ROOT":
      // an emit addressed to `row.tsMsgId` would be a second entry here.
      expect(persistedEmits()).toHaveLength(1);
      expect(persistedEmits()[0]!.payload).toEqual(ROOT_CLOSE_EMIT);
    },
  );
```

(d) Immediately before the line `  // --- D12: the send, and the leg copy frozen at claim time ---` (line 425) add:

```ts
  // --- retry-send-window D4/D5: the send window, the LAST gate ---

  it('retry-send-window D4: sends a rung inside the window, with no window line at all', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { windowStart: minutesAgo(1) });
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(1);
    expect(errorLogs()).toHaveLength(0);
    expect(warnLogs().some((l) => l['windowOrigin'] !== undefined)).toBe(false);
  });

  it('retry-send-window D4: the window close leaves the same slot the claim-time window close leaves', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { versioned: true, windowStart: minutesAgo(16) });
    register();

    await runHandler(payloadFor(row));

    // The identical literal relayRetryClaim.webhook.test.ts pins for the
    // claim's own window close of a versioned rung (spec D3's one data shape).
    expect(slotOf(row.tsMsgId)).toEqual({
      status: 'failed',
      requestedTransport: 'sms',
      transportAggregationState: 'excluded',
      errorCode: 'retry_window_closed',
    });
    expect(world.sent).toHaveLength(0);
    expect(bumps).toHaveLength(0);
  });

  it('retry-send-window D4: an opt-out is recorded ahead of a closed window - the window is the LAST gate', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { windowStart: minutesAgo(16) });
    world.contacts.push({ contactId: BOB_KEY, type: 'tenant', phone: BOB, sms_opt_out: true });
    register();

    await runHandler(payloadFor(row));

    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'retry_opted_out' });
    expect(errorLogs()).toHaveLength(0);
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['unparseable', 'not-a-date'],
  ])('retry-send-window D5: a rung with a %s origin still runs, with one WARN naming the gap', async (label, windowStart) => {
    seedRelay(world);
    // `missing` is every rung claimed before the window shipped. The lineage
    // check must NOT throw on it: it runs after the execution marker, so a
    // throw would drop the rung for good.
    const row = seedRetryRow(world, windowStart === undefined ? {} : { windowStart });
    register();

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(1);
    expect(errorLogs()).toHaveLength(0);
    const gap = warnLogs().filter((l) => l['windowOrigin'] !== undefined);
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({
      event: 'relay_retry_leg',
      windowOrigin: label,
      rootTsMsgId: ROOT_TS_MSG_ID,
      memberKey: BOB_KEY,
    });
  });

  it('retry-send-window D4: a transient pass that could not re-run inside the window closes instead of re-enqueueing', async () => {
    seedRelay(world);
    // 30 seconds of window left: the job-time gate passes, but a 5s re-run
    // plus the 60s scheduling grace would land past origin + 15 minutes.
    const row = seedRetryRow(world, { windowStart: minutesAgo(14.5) });
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    register();

    await runHandler(payloadFor(row));

    expect(outbound.delayed).toHaveLength(0);
    expect(slotOf(row.tsMsgId)).toMatchObject({ status: 'failed', errorCode: 'retry_window_closed' });
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        event: 'relay_retry_leg',
        retryClaim: 'window_closed',
        closeCode: 'retry_window_closed',
        windowCheck: 'transient_reschedule',
        transientPass: 1,
      }),
    );
    expect(persistedEmits()).toHaveLength(1);
    expect(persistedEmits()[0]!.payload).toEqual(ROOT_CLOSE_EMIT);
  });

  it('retry-send-window D4: a transient pass with room left in the window re-enqueues as before', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { windowStart: minutesAgo(1) });
    legSend.override = async (): Promise<RelayLegSendOutcome> => ({
      kind: 'transient',
      errorCode: '429',
    });
    register();

    await runHandler(payloadFor(row));

    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.delaySeconds).toBe(5);
    expect(slotOf(row.tsMsgId)?.status).toBe('queued');
    expect(errorLogs()).toHaveLength(0);
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts`
Expected: FAIL on the `send window closed` table row (the job sends), the versioned window-close shape case, both D5 cases (no gap WARN) and the transient-past-window case (it re-enqueues). PASS on the pins: inside-the-window, opt-out-ahead-of-window, transient-with-room, and every pre-existing case.

- [ ] **Step 3: Implement the window gate (spec D2, D4, D5, D9)**

In `app/src/jobs/relayRetryLeg.ts`:

(a) Header - replace lines 1-7:

Old:
```ts
// relay.retryLeg - one rung of the 30003 retry ladder for ONE relay leg.
//
// The claim lives in the status webhook (spec D3): it appends a NEW single-
// recipient source row carrying the lineage of the leg that failed, and enqueues
// this job with that row's key. This handler owns everything after the claim -
// the four send gates, the send itself, the status-preserving activity bump, the
// transient sub-ladder and the terminal closes.
```
New:
```ts
// relay.retryLeg - one rung of the 30003 retry ladder for ONE relay leg.
//
// The claim lives in the status webhook (spec D3): it appends a NEW single-
// recipient source row carrying the lineage of the leg that failed, and enqueues
// this job with that row's key. This handler owns everything after the claim -
// the four send gates, the send window, the send itself, the status-preserving
// activity bump, the transient sub-ladder and the terminal closes.
//
// Since retry-send-window (its spec D3/D4) the claim PREVIEWS the four gates -
// through the same `evaluateRelayRetryGates` this job runs - and the 15-minute
// send window, and creates a rung it can already see is doomed as CLOSED, never
// enqueued. This job still re-runs every check at send time: a group can close,
// and the window can run out, during the backoff.
```

(b) Imports - after `import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../lib/relayRetryGates.js';` (added by Task 3) add:

```ts
import {
  parseRetryWindowOrigin,
  retryFitsSendWindow,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
```

(c) `RelayRetryCloseCode` - replace Task 3's text:

Old:
```ts
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 */
export type RelayRetryCloseCode = RelayRetryGateCode | 'enqueue_failed' | 'transient_cap';
```
New:
```ts
 * `retry_window_closed` (retry-send-window D4) is the send-window close: the
 * window gate below, or a transient re-run that would land past the window.
 * Kept for data and logs; the dashboard's relay join gives it NO display
 * code, so the leg reads as the original 30003 - a plain failed attempt.
 *
 * `contact_opted_out` is deliberately NOT in this set: the dashboard drops that
 * code from the relay rollup entirely, so a refusal stamped with it would
 * silently vanish from the surface this feature exists to make truthful.
 */
export type RelayRetryCloseCode =
  | RelayRetryGateCode
  | 'enqueue_failed'
  | 'transient_cap'
  | 'retry_window_closed';
```

(d) The lineage - replace lines 260-266:

Old:
```ts
/** The lineage a retry row MUST carry for this job to be able to run at all. */
interface RetryRowLineage {
  rootTsMsgId: string;
  memberKey: string;
  destDigest: string;
  legBody: string;
}
```
New:
```ts
/** The lineage a retry row MUST carry for this job to be able to run at all -
 *  plus the one field it may lack. */
interface RetryRowLineage {
  rootTsMsgId: string;
  memberKey: string;
  destDigest: string;
  legBody: string;
  /**
   * retry-send-window D2/D5: the ladder's send-window origin as the claim
   * stored it, or undefined. OPTIONAL on purpose - it is NOT in the `missing`
   * list below. That check throws AFTER the execution marker is set, so
   * requiring the field would silently drop every rung claimed before the
   * window shipped; such a rung runs unwindowed instead, with a WARN.
   */
  windowStart: string | undefined;
}
```

and replace lines 286-291:

Old:
```ts
  return {
    rootTsMsgId: rootTsMsgId as string,
    memberKey: memberKey as string,
    destDigest: destDigest as string,
    legBody: legBody as string,
  };
```
New:
```ts
  return {
    rootTsMsgId: rootTsMsgId as string,
    memberKey: memberKey as string,
    destDigest: destDigest as string,
    legBody: legBody as string,
    windowStart: row.relay_retry_window_start,
  };
```

(e) Line 371:

Old:
```ts
    const { rootTsMsgId, memberKey, destDigest, legBody } = readRetryLineage(row, retryTsMsgId);
```
New:
```ts
    const { rootTsMsgId, memberKey, destDigest, legBody, windowStart } = readRetryLineage(
      row,
      retryTsMsgId,
    );
```

(f) Step 4b - immediately before the line `    // The fan-out's media-without-store ERROR, twinned (code review R1, F4).` (after Task 3's `const memberLog = ...` line and a blank line) add:

```ts
    // 4b. The send window (retry-send-window spec D4) - the LAST gate, after
    // the opt-out, so a deliberate human action keeps its own "Not retried -
    // ..." code when both apply. STRICT at send time: the claim already spent
    // RETRY_JOB_GRACE_MS when it scheduled this rung, so the rule here is only
    // "not after origin + 15 minutes". The origin is the one the claim carried
    // on this row (the member's ORIGINAL leg send, spec D2) - never re-derived.
    // A row without a usable one (claimed before the window shipped, or
    // unparseable) is NOT windowed and runs, with a WARN naming the gap (D5).
    const originMs = parseRetryWindowOrigin(windowStart);
    if (originMs === undefined) {
      log.warn(
        { ...memberLog, windowOrigin: windowStart === undefined ? 'missing' : 'unparseable' },
        'relayRetryLeg: no usable send-window origin on the retry row - window not checked (spec D5)',
      );
    } else if (!withinRetrySendWindow({ originMs, nowMs: Date.now() })) {
      await refuseGate('retry_window_closed');
      // ERROR (D9): the member never got the text - a dead end like the cap,
      // not a human action like the four gates above.
      log.error(
        {
          ...memberLog,
          retryClaim: 'window_closed',
          closeCode: 'retry_window_closed',
          windowCheck: 'gate',
        },
        'relayRetryLeg: retry refused - past the 15-minute send window',
      );
      return;
    }

```

(g) The transient re-enqueue re-checks the window. Replace lines 643-646:

Old:
```ts
      try {
        await enqueue(RELAY_RETRY_LEG_JOB, payload, {
          runAt: new Date(Date.now() + transientBackoff(claim.attempt)),
        });
```
New:
```ts
      // retry-send-window D4: re-enqueueing is a SCHEDULING decision, so it
      // meets the claim's rule - the re-run must still fit the window with
      // RETRY_JOB_GRACE_MS to spare. Past it the rung closes here instead of
      // re-enqueueing a pass the job-time gate would only refuse. A POST-send
      // close (this pass reached the provider), so `closeTerminally`, exactly
      // as the cap branch above. No origin (D5): unwindowed, as before.
      const transientDelayMs = transientBackoff(claim.attempt);
      if (
        originMs !== undefined &&
        !retryFitsSendWindow({ originMs, nowMs: Date.now(), backoffMs: transientDelayMs })
      ) {
        await closeTerminally('retry_window_closed');
        log.error(
          {
            ...memberLog,
            retryClaim: 'window_closed',
            closeCode: 'retry_window_closed',
            windowCheck: 'transient_reschedule',
            errorCode: outcome.errorCode,
            transientPass: claim.attempt,
          },
          'relayRetryLeg: a transient re-run would land past the send window - retry leg closed',
        );
        return;
      }
      try {
        await enqueue(RELAY_RETRY_LEG_JOB, payload, {
          runAt: new Date(Date.now() + transientDelayMs),
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayRetryClaim.webhook.test.ts test/relayRetryGates.test.ts`
Expected: PASS. The pre-existing job cases seed no origin and now log one D5 WARN each, which no existing assertion counts; the webhook ladder cases run their rungs inside the window.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/jobs/relayRetryLeg.ts app/test/relayRetryLeg.test.ts
git commit -m "feat(relay-retry): the retry job's send-window gate (spec D2, D4, D5, D9)

The window is the job's last gate, after the opt-out: strict at send time,
measured from the origin the claim carried on the row; past it the rung closes
retry_window_closed through refuseGate with one ERROR and one root SSE. The
origin is optional in the lineage check - a rung claimed before this deploy
runs unwindowed with a WARN. A transient re-enqueue re-checks the window with
the scheduling grace and closes instead of re-enqueueing once past it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/jobs/relayRetryLeg.ts app/test/relayRetryLeg.test.ts
```

---

### Task 6: The bounded token-bucket acquire for a relay retry rung (spec D4, D9; section 5 requirement 5)

**Files:**
- Modify: `app/src/jobs/relayFanOut.ts` - `:35` (import), `:1219-1231` (`RelayLegSendOutcome`), `:1250-1252` (the knobs doc), `:1298-1300` (the `sendDeadlineMs` argument), `:1316` (destructure), `:1360` (the acquire)
- Modify: `app/src/jobs/relayRetryLeg.ts` - the `retrySendWindow` import (Task 5), the `RelayRetryCloseCode` doc (Task 5's text), the send call (`:575-598` at HEAD), a new branch before `if (outcome.kind === 'transient') {` (`:618` at HEAD)
- Test: `app/test/relayRetryLeg.test.ts` - after `:48` (import), a new section before `// --- Malformed input is a programming error, not a gate refusal ---` (`:938` at HEAD); `app/test/relayFanOut.test.ts` - after `:38` (import), a new `describe` appended after the file's last `});`

**Interfaces:**
- Consumes: Task 1 `retrySendDeadlineMs(originMs: number): number`; `TokenBucket.acquire(count = 1, opts: { timeoutMs?: number } = {}): Promise<void>` (`app/src/lib/tokenBucket.ts:136`) and `TokenBucketBusyError` (`:219-232`) - the group-send precedent is `app/src/services/groupSend.ts:503-516`; Task 5's handler-scope `originMs`.
- Produces:
  - `sendOneRelayLeg(args: { ...; suppressionChecked?: boolean; sendDeadlineMs?: number })` - when `sendDeadlineMs` is set and a bucket is given, the acquire is `tokenBucket.acquire(1, { timeoutMs: Math.max(0, sendDeadlineMs - Date.now()) })`; unset, it is `tokenBucket.acquire(1)` exactly as before.
  - `RelayLegSendOutcome.kind` gains `'deadline_exceeded'` (placement: the existing `kind` string union of the interface at `relayFanOut.ts:1227-1231`; the outcome carries neither `providerSid` nor `errorCode`), returned BEFORE the presign, the `attempted` aggregation write (`:1380-1382`) and the provider call.
  - The job maps it to `refuseGate('retry_window_closed')` + ERROR `{ retryClaim: 'window_closed', closeCode: 'retry_window_closed', windowCheck: 'send_deadline' }`; never the transient branch.

- [ ] **Step 1: Write the failing tests (spec D4, D5, D9; test intention 3)**

(a) In `app/test/relayRetryLeg.test.ts`, after line 48 (`import { relayRetryDigest, relayRetryProviderSid } from '../src/lib/relayRetryClaim.js';`) add:

```ts
import { RETRY_SEND_WINDOW_MS } from '../src/lib/retrySendWindow.js';
```

and immediately before the line `  // --- Malformed input is a programming error, not a gate refusal ---` add:

```ts
  // --- retry-send-window D4: the bounded token-bucket acquire ---

  /**
   * One token, refilled at 1 per 1,000 seconds: once drawn, the next draw waits
   * about 16.7 minutes - longer than any window has left. `sleep` THROWS, so
   * an unbounded acquire fails the test at once instead of hanging it for the
   * whole wait.
   */
  async function drainedBucket(): Promise<TokenBucket> {
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSec: 0.001,
      maxJitterMs: 0,
      sleep: async () => {
        throw new Error('the retry leg slept on the A2P meter - its acquire must be bounded');
      },
    });
    await bucket.acquire(1); // take the only token
    return bucket;
  }

  it.each([true, false])(
    'retry-send-window D4: a bounded acquire that outlasts the window closes retry_window_closed through refuseGate - nothing sent, never transient (versioned=%s)',
    async (versioned) => {
      seedRelay(world);
      const origin = minutesAgo(1);
      const row = seedRetryRow(world, { versioned, windowStart: origin });
      const bucket = await drainedBucket();
      const aggregate = vi.spyOn(world.messagesRepo, 'setRecipientTransportAggregationState');
      const claimPass = vi.spyOn(world.messagesRepo, 'claimFanoutPass');
      register({ tokenBucket: bucket });

      await runHandler(payloadFor(row));

      // The job handed the unit the window's end as its deadline.
      expect(legArgs(0).sendDeadlineMs).toBe(Date.parse(origin) + RETRY_SEND_WINDOW_MS);
      expect(world.sent).toHaveLength(0);
      // Returned BEFORE the unit's `attempted` write, and closed - never left queued.
      expect(aggregate.mock.calls.some((call) => call[3] === 'attempted')).toBe(false);
      expect(slotOf(row.tsMsgId)).toEqual(
        versioned
          ? {
              status: 'failed',
              requestedTransport: 'sms',
              transportAggregationState: 'excluded',
              errorCode: 'retry_window_closed',
            }
          : { status: 'failed', errorCode: 'retry_window_closed' },
      );
      // Never the transient branch: no pass claimed, nothing re-enqueued.
      expect(claimPass).not.toHaveBeenCalled();
      expect(outbound.delayed).toHaveLength(0);
      expect(errorLogs()).toContainEqual(
        expect.objectContaining({
          event: 'relay_retry_leg',
          retryClaim: 'window_closed',
          closeCode: 'retry_window_closed',
          windowCheck: 'send_deadline',
        }),
      );
      expect(persistedEmits()).toHaveLength(1);
      expect(persistedEmits()[0]!.payload).toEqual(ROOT_CLOSE_EMIT);
    },
  );

  it('retry-send-window D4: a rung inside the window draws its token with a wait bounded by the window end, and sends', async () => {
    seedRelay(world);
    const row = seedRetryRow(world, { windowStart: minutesAgo(1) });
    const bucket = new TokenBucket({ capacity: 5, refillPerSec: 5, maxJitterMs: 0 });
    const acquire = vi.spyOn(bucket, 'acquire');
    register({ tokenBucket: bucket });

    await runHandler(payloadFor(row));

    expect(world.sent).toHaveLength(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    const [count, opts] = acquire.mock.calls[0]!;
    expect(count).toBe(1);
    // About 14 of the window's 15 minutes are left.
    expect(opts?.timeoutMs).toBeGreaterThan(13 * 60_000);
    expect(opts?.timeoutMs).toBeLessThanOrEqual(14 * 60_000);
  });

  it('retry-send-window D5: a rung with no usable origin gets NO send deadline - its acquire stays unbounded', async () => {
    seedRelay(world);
    const row = seedRetryRow(world);
    const bucket = new TokenBucket({ capacity: 5, refillPerSec: 5, maxJitterMs: 0 });
    const acquire = vi.spyOn(bucket, 'acquire');
    register({ tokenBucket: bucket });

    await runHandler(payloadFor(row));

    expect(legArgs(0).sendDeadlineMs).toBeUndefined();
    expect(acquire.mock.calls).toEqual([[1]]);
    expect(world.sent).toHaveLength(1);
  });

```

(b) In `app/test/relayFanOut.test.ts`, after line 38 (`import { createLogger } from '../src/lib/logger.js';`) add:

```ts
import { TokenBucket } from '../src/lib/tokenBucket.js';
```

and append at the end of the file, after its last `});`:

```ts

// retry-send-window (spec D4): the BOUNDED acquire belongs to the 30003 retry
// job alone. The fan-out passes no send deadline, so its per-leg acquire stays
// exactly as unbounded as before - a pin, green before and after that change.
describe('relay.fanOut token-bucket acquire (retry-send-window D4)', () => {
  let world: FakeWorld;
  let outbound: InProcessOutboundQueueAdapter;
  let bucket: TokenBucket;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    bucket = new TokenBucket({ capacity: 10, refillPerSec: 10, maxJitterMs: 0 });
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      tokenBucket: bucket,
      logger,
    });
    outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
  });

  it('draws one token per leg with NO timeout - the fan-out passes no send deadline', async () => {
    seedRelay(world);
    const source = seedSource(world, 'is the unit still available?', 'c-alice');
    const acquire = vi.spyOn(bucket, 'acquire');

    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: 'conv-relay-1',
      sourceTsMsgId: source.tsMsgId,
      senderKey: 'c-alice',
    });
    await outbound.settle();

    expect(world.sent.map((s) => s.to).sort()).toEqual([BOB, CAROL].sort());
    // Exactly `acquire(1)` per leg - no options object, so no bound.
    expect(acquire.mock.calls).toEqual([[1], [1]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayFanOut.test.ts`
Expected: FAIL on both bounded-acquire cases (no deadline reaches the unit: `sendDeadlineMs` is undefined, the unbounded acquire calls the throwing `sleep`, the error escapes the job and the slot stays `queued`) and on the inside-the-window case (`opts` is undefined). PASS on the no-origin case and the fan-out pin (both describe today's unbounded acquire), and on every pre-existing case.

- [ ] **Step 3: Bound the acquire in the send unit (spec D4; section 5 requirement 5)**

In `app/src/jobs/relayFanOut.ts`:

(a) Replace line 35:

Old:
```ts
import type { TokenBucket } from '../lib/tokenBucket.js';
```
New:
```ts
import { TokenBucketBusyError, type TokenBucket } from '../lib/tokenBucket.js';
```

(b) Replace lines 1219-1231:

Old:
```ts
/**
 * How one relay leg ended. `kind` mirrors the fan-out loop body's five early
 * exits plus its success fall-through, so a caller can rebuild the two counters
 * the loop used to mutate in place: `transient` re-defers the member to the
 * continuation, `sent` counts toward the completion log. `providerSid` is
 * present on `sent` only; `errorCode` carries the code that was persisted to
 * the member's slot on `suppressed`, `refused`, `filtered` and `transient`.
 */
export interface RelayLegSendOutcome {
  kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'transient';
  providerSid?: string;
  errorCode?: string;
}
```
New:
```ts
/**
 * How one relay leg ended. `kind` mirrors the fan-out loop body's five early
 * exits plus its success fall-through, so a caller can rebuild the two counters
 * the loop used to mutate in place: `transient` re-defers the member to the
 * continuation, `sent` counts toward the completion log. `providerSid` is
 * present on `sent` only; `errorCode` carries the code that was persisted to
 * the member's slot on `suppressed`, `refused`, `filtered` and `transient`.
 *
 * `deadline_exceeded` (retry-send-window spec D4) is reachable ONLY for a
 * caller that passed `sendDeadlineMs` - the 30003 retry job; the fan-out never
 * does. The bounded token-bucket wait ran out: NOTHING was written (no slot,
 * no aggregation state) and nothing was sent, so the caller owns the close. It
 * is terminal for a retry rung - never a `transient` to re-defer, whose branch
 * assumes a provider refusal and would re-open a send past the window.
 */
export interface RelayLegSendOutcome {
  kind:
    | 'sent'
    | 'skipped_terminal'
    | 'suppressed'
    | 'refused'
    | 'filtered'
    | 'transient'
    | 'deadline_exceeded';
  providerSid?: string;
  errorCode?: string;
}
```

(c) Replace lines 1250-1252:

Old:
```ts
 * `suppressionChecked` (optional, default false) is the one behavioural knob,
 * and the fan-out never passes it - see its own doc below for why a caller that
 * has just run the same check must not let this unit run it a second time.
```
New:
```ts
 * `suppressionChecked` and `sendDeadlineMs` (both optional) are the two
 * behavioral knobs, and the fan-out passes neither - see each one's own doc
 * below: why a caller that has just run the same suppression check must not
 * let this unit run it a second time, and why a retry rung's wait on the A2P
 * meter is bounded by its send window.
```

(d) Replace lines 1299-1300:

Old:
```ts
  suppressionChecked?: boolean;
}): Promise<RelayLegSendOutcome> {
```
New:
```ts
  suppressionChecked?: boolean;
  /**
   * retry-send-window spec D4: the epoch-ms instant after which this leg must
   * NOT go out - the 30003 retry job's send-window end (origin + 15 minutes).
   * When set, the token-bucket wait is BOUNDED by it (`acquire(1,
   * { timeoutMs })`, the group-send precedent) instead of lasting as long as
   * the shared A2P meter takes, and a timeout returns `deadline_exceeded`
   * before any write. Unset - the fan-out, and a retry rung with no usable
   * origin - the acquire is unbounded exactly as before.
   */
  sendDeadlineMs?: number;
}): Promise<RelayLegSendOutcome> {
```

(e) Replace line 1316:

Old:
```ts
    suppressionChecked = false,
```
New:
```ts
    suppressionChecked = false,
    sendDeadlineMs,
```

(f) Replace line 1360:

Old:
```ts
  await tokenBucket?.acquire(1);
```
New:
```ts
  if (tokenBucket !== undefined) {
    if (sendDeadlineMs === undefined) {
      await tokenBucket.acquire(1);
    } else {
      // retry-send-window D4. BOUNDED for a caller with a send deadline, and
      // the timeout is an OUTCOME, not a throw: this acquire sits outside the
      // send's only try below, this unit lets unclassified errors escape, and
      // the retry job - its execution marker already set - has no catch
      // around this call, so a thrown TokenBucketBusyError would strand the
      // rung at `queued`. It returns BEFORE the presign, the `attempted`
      // aggregation write and the provider call: nothing was attempted.
      try {
        await tokenBucket.acquire(1, { timeoutMs: Math.max(0, sendDeadlineMs - Date.now()) });
      } catch (err) {
        if (err instanceof TokenBucketBusyError) return { kind: 'deadline_exceeded' };
        throw err;
      }
    }
  }
```

- [ ] **Step 4: Pass the deadline from the job and close on a timeout (spec D4, D9)**

In `app/src/jobs/relayRetryLeg.ts`:

(a) Replace Task 5's import:

Old:
```ts
import {
  parseRetryWindowOrigin,
  retryFitsSendWindow,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
```
New:
```ts
import {
  parseRetryWindowOrigin,
  retryFitsSendWindow,
  retrySendDeadlineMs,
  withinRetrySendWindow,
} from '../lib/retrySendWindow.js';
```

(b) In the `RelayRetryCloseCode` doc (Task 5's text):

Old:
```ts
 * `retry_window_closed` (retry-send-window D4) is the send-window close: the
 * window gate below, or a transient re-run that would land past the window.
```
New:
```ts
 * `retry_window_closed` (retry-send-window D4) is the send-window close: the
 * window gate below, the send deadline passing while the rung waits on the
 * A2P meter, or a transient re-run that would land past the window.
```

(c) In the `sendOneRelayLeg({ ... })` call, replace:

Old:
```ts
      // one answer, no window.
      suppressionChecked: true,
    });
```
New:
```ts
      // one answer, no window.
      suppressionChecked: true,
      // retry-send-window D4: the window's end, so the unit's wait on the
      // shared A2P meter is BOUNDED by it - a rung queued behind a burst must
      // not go out after origin + 15 minutes. Omitted when the row has no
      // usable origin (D5): that rung is not windowed.
      ...(originMs !== undefined && { sendDeadlineMs: retrySendDeadlineMs(originMs) }),
    });
```

(d) Immediately before the line `    if (outcome.kind === 'transient') {` add:

```ts
    if (outcome.kind === 'deadline_exceeded') {
      // retry-send-window D4: the send deadline (origin + 15 minutes) passed
      // while this rung waited on the shared A2P meter. Nothing was sent and
      // nothing written, so this is a PRE-send refusal - `refuseGate`, the
      // same close as the window gate above - and NEVER the transient branch
      // below, whose re-enqueue assumes a provider refusal and would try again
      // past the window. ERROR (D9); refuseGate announces the root once.
      await refuseGate('retry_window_closed');
      log.error(
        {
          ...memberLog,
          retryClaim: 'window_closed',
          closeCode: 'retry_window_closed',
          windowCheck: 'send_deadline',
        },
        'relayRetryLeg: send-window deadline passed while waiting for the A2P meter - nothing sent, retry leg closed',
      );
      return;
    }

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayFanOut.test.ts test/relayRetryClaim.webhook.test.ts test/tokenBucket.test.ts`
Expected: PASS - both bounded-acquire cases close `retry_window_closed` without a send, a transient claim, a re-enqueue or an `attempted` write; the in-window rung draws with a bound of about 14 minutes; the no-origin rung and the fan-out still draw `acquire(1)` with no options.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/jobs/relayFanOut.ts app/src/jobs/relayRetryLeg.ts app/test/relayRetryLeg.test.ts app/test/relayFanOut.test.ts
git commit -m "feat(relay-retry): bound a retry rung's wait on the A2P meter by its send window (spec D4, D9)

sendOneRelayLeg takes an optional sendDeadlineMs; when set, its token-bucket
acquire is bounded (the group-send precedent) and a timeout returns a new
deadline_exceeded outcome before the presign, the attempted write and the
provider call. The retry job passes origin + 15 minutes when the row carries an
origin and closes deadline_exceeded as retry_window_closed through refuseGate
with one ERROR - never the transient branch, never a rung left queued. The
fan-out passes no deadline; its acquire stays unbounded (pinned).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/jobs/relayFanOut.ts app/src/jobs/relayRetryLeg.ts app/test/relayRetryLeg.test.ts app/test/relayFanOut.test.ts
```

---

### Task 7: A pure preview of the one-to-one send wrapper's refusals, with a parity test (spec D3a step 2, D14)

**Files:**
- Create: `app/src/services/sendRefusalPreview.ts`
- Create: `app/test/helpers/sendRefusalCases.ts` (the ONE case table)
- Create: `app/test/sendRefusalPreview.test.ts`
- Modify (test): `app/test/sendMessage.test.ts:33-35` (imports) and the end of the file (after `:922`: the parity `describe`)

**Interfaces:**
- Consumes: `isKillSwitchOff`, `isOptedOut`, `isManualMode` (`app/src/services/scheduledSendSuppression.ts:30-38`); `isDeleted` (`app/src/repos/contactsRepo.ts:309-311`); `hasSmsConsent` (`app/src/lib/smsCompliance.ts:101-103`) - the predicates `sendMessage` itself calls (`app/src/services/sendMessage.ts:298`, `:324`, `:348`, `:362`, `:373`).
- Produces (exactly per the contract):
  ```ts
  export type SendRefusalCode =
    | 'sms_sending_disabled' | 'contact_opted_out' | 'contact_deleted'
    | 'contact_no_consent' | 'manual_mode';
  export function previewSendRefusal(args: {
    smsSendingEnabled: boolean | undefined;
    conversation: Pick<ConversationItem, 'sms_opt_out' | 'ai_mode'>;
    phoneContact: ContactItem | undefined;
    recipient: ContactItem | undefined;
    automated: boolean;
  }): SendRefusalCode | undefined;
  ```
  Test-only: `SendRefusalCase`, `SEND_REFUSAL_CASES`, `LIVE_CONTACT` from `app/test/helpers/sendRefusalCases.ts`, so Task 10's decision test can run the same rows (spec test intention 4, "one table drives both tests").

- [ ] **Step 1: Write the case table**

Create `app/test/helpers/sendRefusalCases.ts`:

```ts
// retry-send-window D3a: ONE table of one-to-one send-refusal cases.
//
// It drives BOTH halves of the drift guard: previewSendRefusal's unit test
// (sendRefusalPreview.test.ts) and the parity test that runs every row through
// the REAL send wrapper (sendMessage.test.ts, 'previewSendRefusal parity ...').
// The one-to-one retry decision's own test may run the same rows (spec test
// intention 4: "one table drives both tests").
//
// Every row is a one-to-one thread (the channel guards are the caller's, never
// the preview's), a fresh breaker (one send never trips it), the phone-matched
// contact, and an optional caller-resolved recipient on the SAME phone - the
// duplicate-contacts shape share-skip-fix I8 exists for.
import type { ContactItem } from '../../src/repos/contactsRepo.js';
import type { ConversationMode } from '../../src/repos/conversationsRepo.js';
import type { SendRefusalCode } from '../../src/services/sendRefusalPreview.js';

export interface SendRefusalCase {
  name: string;
  /** The A2P kill switch (config.smsSendingEnabled); false refuses everything. */
  smsSendingEnabled: boolean;
  conversation: { sms_opt_out?: boolean; ai_mode: ConversationMode };
  /** What contacts.findByPhone(participant_phone) returns; undefined = no record. */
  phoneContact: ContactItem | undefined;
  /** The caller-resolved recipient (sendMessage's `recipient`); undefined = none named. */
  recipient: ContactItem | undefined;
  automated: boolean;
  /** The refusal code both must produce; undefined = the send goes out. */
  expected: SendRefusalCode | undefined;
}

const PHONE = '+15550100001';
const DELETED_AT = '2026-09-01T00:00:00.000Z';

/** A live, consenting tenant - the phone-matched contact unless a row says otherwise. */
export const LIVE_CONTACT: ContactItem = {
  contactId: 'c-live',
  type: 'tenant',
  phone: PHONE,
  consent_method: 'inbound_text',
};
const NO_CONSENT: ContactItem = { contactId: 'c-nc', type: 'tenant', phone: PHONE };
const DELETED: ContactItem = { ...LIVE_CONTACT, contactId: 'c-del', deleted_at: DELETED_AT };
const OPTED_OUT: ContactItem = { ...LIVE_CONTACT, contactId: 'c-stop', sms_opt_out: true };
/** The caller-resolved recipient: a DIFFERENT contact on the same phone. */
const RECIPIENT: ContactItem = {
  contactId: 'c-real',
  type: 'tenant',
  phone: PHONE,
  consent_method: 'verbal_in_person',
};
const AUTO: SendRefusalCase['conversation'] = { ai_mode: 'auto' };
const MANUAL: SendRefusalCase['conversation'] = { ai_mode: 'manual' };

/** Defaults: kill switch on, an auto thread, a live phone-matched contact, no recipient, a person's send. */
function row(name: string, over: Partial<Omit<SendRefusalCase, 'name'>>): SendRefusalCase {
  return {
    name,
    smsSendingEnabled: true,
    conversation: AUTO,
    phoneContact: LIVE_CONTACT,
    recipient: undefined,
    automated: false,
    expected: undefined,
    ...over,
  };
}

export const SEND_REFUSAL_CASES: readonly SendRefusalCase[] = [
  // --- the send goes out -----------------------------------------------------
  row('person send, all clear: sends', {}),
  row('automated send, all clear: sends', { automated: true }),
  row('no contact record at all: a person send to a raw phone sends', { phoneContact: undefined }),
  // --- (0a) the kill switch, ahead of everything -----------------------------
  row('kill switch off refuses a clean person send', {
    smsSendingEnabled: false,
    expected: 'sms_sending_disabled',
  }),
  row('kill switch off refuses before opt-out, deleted and manual mode', {
    smsSendingEnabled: false,
    conversation: { ...MANUAL, sms_opt_out: true },
    phoneContact: DELETED,
    automated: true,
    expected: 'sms_sending_disabled',
  }),
  // --- (1) opt-out: the conversation, the phone-matched contact OR the recipient
  row('conversation opted out with no contact record refuses', {
    conversation: { ...AUTO, sms_opt_out: true },
    phoneContact: undefined,
    expected: 'contact_opted_out',
  }),
  row('phone-matched contact opted out refuses an automated send', {
    phoneContact: OPTED_OUT,
    automated: true,
    expected: 'contact_opted_out',
  }),
  row('duplicate contacts: recipient opted out, phone-matched contact not: refuses', {
    recipient: { ...RECIPIENT, sms_opt_out: true },
    expected: 'contact_opted_out',
  }),
  row('duplicate contacts: phone-matched contact opted out, recipient clean: refuses (Do Not Contact)', {
    phoneContact: OPTED_OUT,
    recipient: RECIPIENT,
    expected: 'contact_opted_out',
  }),
  row('opted out AND deleted: opt-out wins', {
    phoneContact: { ...DELETED, sms_opt_out: true },
    expected: 'contact_opted_out',
  }),
  row('manual mode + opted out: opt-out wins over mode', {
    conversation: { ...MANUAL, sms_opt_out: true },
    automated: true,
    expected: 'contact_opted_out',
  }),
  // --- (1b) soft-deleted: the recipient when named, else the phone-matched one
  row('phone-matched contact soft-deleted refuses an automated send too', {
    phoneContact: DELETED,
    automated: true,
    expected: 'contact_deleted',
  }),
  row('duplicate contacts: phone-matched contact deleted, recipient live: sends', {
    phoneContact: DELETED,
    recipient: RECIPIENT,
  }),
  row('duplicate contacts: recipient deleted, phone-matched contact live: refuses', {
    recipient: { ...RECIPIENT, contactId: 'c-gone', deleted_at: DELETED_AT },
    expected: 'contact_deleted',
  }),
  row('deleted AND no consent: deleted wins', {
    phoneContact: { ...NO_CONSENT, deleted_at: DELETED_AT },
    expected: 'contact_deleted',
  }),
  row('manual mode + deleted: deleted wins over mode', {
    conversation: MANUAL,
    phoneContact: DELETED,
    automated: true,
    expected: 'contact_deleted',
  }),
  // --- (1.5) JIT consent: a PERSON's send only -------------------------------
  row('person send to a no-consent contact refuses (JIT gate)', {
    phoneContact: NO_CONSENT,
    expected: 'contact_no_consent',
  }),
  row('automated send to a no-consent contact sends (the JIT gate is for a person send)', {
    phoneContact: NO_CONSENT,
    automated: true,
  }),
  row('duplicate contacts: no-consent phone contact, consenting recipient: a person send sends', {
    phoneContact: NO_CONSENT,
    recipient: RECIPIENT,
  }),
  row('duplicate contacts: consenting phone contact, no-consent recipient: a person send refuses', {
    recipient: { ...NO_CONSENT, contactId: 'c-real-nc' },
    expected: 'contact_no_consent',
  }),
  row('manual mode + no consent: a person send refuses on consent, not on mode', {
    conversation: MANUAL,
    phoneContact: NO_CONSENT,
    expected: 'contact_no_consent',
  }),
  // --- (2) manual mode: an AUTOMATED send only -------------------------------
  row('manual mode refuses an automated send', {
    conversation: MANUAL,
    automated: true,
    expected: 'manual_mode',
  }),
  row('manual mode (a breaker-tripped thread) lets a person send go out', { conversation: MANUAL }),
  row('manual mode + no consent: an automated send refuses on mode', {
    conversation: MANUAL,
    phoneContact: NO_CONSENT,
    automated: true,
    expected: 'manual_mode',
  }),
];
```

- [ ] **Step 2: Write the failing unit test**

Create `app/test/sendRefusalPreview.test.ts`:

```ts
// retry-send-window D3a step 2: previewSendRefusal, the PURE preview of the
// one-to-one send wrapper's refusals. The rows live in ONE table
// (helpers/sendRefusalCases.ts) that the parity test in sendMessage.test.ts
// also runs through the REAL wrapper, so green here plus green there means the
// preview and the send path agree on every row.
import { describe, expect, it } from 'vitest';
import { previewSendRefusal, type SendRefusalCode } from '../src/services/sendRefusalPreview.js';
import { LIVE_CONTACT, SEND_REFUSAL_CASES } from './helpers/sendRefusalCases.js';

describe('previewSendRefusal (retry-send-window D3a step 2)', () => {
  it.each(SEND_REFUSAL_CASES)('$name', (c) => {
    expect(
      previewSendRefusal({
        smsSendingEnabled: c.smsSendingEnabled,
        conversation: c.conversation,
        phoneContact: c.phoneContact,
        recipient: c.recipient,
        automated: c.automated,
      }),
    ).toBe(c.expected);
  });

  it('treats an UNSET kill switch as enabled (explicit false only, like sendMessage)', () => {
    expect(
      previewSendRefusal({
        smsSendingEnabled: undefined,
        conversation: { ai_mode: 'auto' },
        phoneContact: LIVE_CONTACT,
        recipient: undefined,
        automated: true,
      }),
    ).toBeUndefined();
  });

  it('the table exercises every refusal code AND the sent outcome', () => {
    const all: (SendRefusalCode | 'sent')[] = [
      'contact_deleted',
      'contact_no_consent',
      'contact_opted_out',
      'manual_mode',
      'sent',
      'sms_sending_disabled',
    ];
    expect([...new Set(SEND_REFUSAL_CASES.map((c) => c.expected ?? 'sent'))].sort()).toEqual(all);
  });
});
```

- [ ] **Step 3: Write the failing parity test (one table, both paths)**

In `app/test/sendMessage.test.ts`, the imports (`:33-35`). Old:

```ts
} from '../src/services/sendMessage.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';
```

New:

```ts
} from '../src/services/sendMessage.js';
import { previewSendRefusal } from '../src/services/sendRefusalPreview.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';
import { SEND_REFUSAL_CASES } from './helpers/sendRefusalCases.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';
```

Append at the end of the file (after `:922`). It builds the real wrapper with this file's `makeFakes` (`:55-392`): `contact` is what the fake `findByPhone` returns (`:200`), the row's `recipient` rides the send input, and the kill switch goes through `loadConfig` as `SMS_SENDING_ENABLED` (`:380`):

```ts
// ---------------------------------------------------------------------------
// retry-send-window D3a: PARITY between previewSendRefusal and the real send
// wrapper. ONE table (helpers/sendRefusalCases.ts) drives both: every row runs
// through the pure preview AND through createSendMessageService with this
// file's fakes, and the refusal code must match (undefined = the send went
// out). A gate reordered in or removed from sendMessage turns a row red; a NEW
// gate turns nothing red until a row exercises it - add its row with the gate.
// The same table drives the retry decision's own test
// (test/oneToOneRetryDecision.test.ts), so the decision cannot drift either.
// ---------------------------------------------------------------------------
describe('previewSendRefusal parity with the send wrapper (retry-send-window D3a)', () => {
  it.each(SEND_REFUSAL_CASES)('$name', async (c) => {
    const preview = previewSendRefusal({
      smsSendingEnabled: c.smsSendingEnabled,
      conversation: c.conversation,
      phoneContact: c.phoneContact,
      recipient: c.recipient,
      automated: c.automated,
    });

    const f = makeFakes({
      conversation: c.conversation,
      contact: c.phoneContact ?? null,
      env: { SMS_SENDING_ENABLED: c.smsSendingEnabled ? 'true' : 'false' },
    });
    let thrown: SendRefusedError['code'] | undefined;
    try {
      await f.service({
        conversationId: 'conv-1',
        body: 'parity',
        automated: c.automated,
        recipient: c.recipient,
      });
    } catch (err) {
      if (!(err instanceof SendRefusedError)) throw err;
      thrown = err.code;
    }

    // Compile-time half: every preview code IS a code the wrapper throws.
    const previewAsSendCode: SendRefusedError['code'] | undefined = preview;
    expect(previewAsSendCode).toBe(thrown);
    expect(preview).toBe(c.expected);
    // A refused row never reached the provider; a sent row did, exactly once.
    expect(f.sent).toHaveLength(c.expected === undefined ? 1 : 0);
  });
});
```

- [ ] **Step 4: Run both to verify they fail**

Run: `cd app; npx vitest run test/sendRefusalPreview.test.ts test/sendMessage.test.ts`
Expected: FAIL - both files fail to load: the import of `../src/services/sendRefusalPreview.js` does not resolve (the module does not exist yet).

- [ ] **Step 5: Implement the preview**

Create `app/src/services/sendRefusalPreview.ts` (spec D3a step 2; it mirrors `sendMessage.ts:298-391` minus the channel guards `:309-314` and the breaker `:374-390`):

```ts
// retry-send-window D3a step 2: a PURE preview of the refusals the one-to-one
// send wrapper (services/sendMessage.ts) would make right now for a given
// automated flag and recipient. The status webhook's 30003 decision asks it
// before promising a retry, so the screen never says "will retry" for a text
// the send path is certain to refuse, and says it at once when one will go.
//
// It mirrors the wrapper's gates IN ORDER - (0a) kill switch, (1) opt-out,
// (1b) soft-deleted, (1.5) JIT consent for a person's send, (2) manual mode for
// an automated send - through the SAME predicates the wrapper calls
// (isKillSwitchOff / isOptedOut / isManualMode, isDeleted, hasSmsConsent). A
// parity test (sendMessage.test.ts) runs one case table through this function
// AND the real wrapper and requires the same code, so the two cannot drift
// silently.
//
// Deliberately NOT previewed:
//   - the channel guards (relay_group, group_text, no participant_phone): the
//     caller decides those first, with its own reasons (D11);
//   - the circuit breaker: live per-minute state that meters automated sends
//     only - an automated retry it refuses at send time keeps its promise until
//     the promise expires (spec section 9);
//   - `conversation_not_found`: the caller already holds the conversation.
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { isDeleted, type ContactItem } from '../repos/contactsRepo.js';
import type { ConversationItem } from '../repos/conversationsRepo.js';
import { isKillSwitchOff, isManualMode, isOptedOut } from './scheduledSendSuppression.js';

/** The SendRefusedError codes sendMessage's previewable gates throw. */
export type SendRefusalCode =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'contact_deleted'
  | 'contact_no_consent'
  | 'manual_mode';

/**
 * Pure: what sendMessage's gates ((0a) through (2), in that order) would refuse
 * for this conversation, phone-matched contact, optional recipient and
 * automated flag. Excludes the channel guards (the caller handles relay_group /
 * group_text / no participant_phone) and the breaker (live state). Codes equal
 * the SendRefusedError codes sendMessage throws; undefined = the send goes out.
 */
export function previewSendRefusal(args: {
  smsSendingEnabled: boolean | undefined;
  conversation: Pick<ConversationItem, 'sms_opt_out' | 'ai_mode'>;
  phoneContact: ContactItem | undefined;
  recipient: ContactItem | undefined;
  automated: boolean;
}): SendRefusalCode | undefined {
  const { smsSendingEnabled, conversation, phoneContact, recipient, automated } = args;
  // (0a) The A2P kill switch, ahead of everything (explicit false only).
  if (isKillSwitchOff(smsSendingEnabled)) return 'sms_sending_disabled';
  // (1) Opt-out: the conversation's flag, the phone-matched contact's, OR the
  // recipient's - either contact's flag refuses (duplicate contacts on one phone).
  if (
    isOptedOut(conversation.sms_opt_out, phoneContact?.sms_opt_out) ||
    recipient?.sms_opt_out === true
  ) {
    return 'contact_opted_out';
  }
  // The contact the deleted and consent gates judge: the recipient when the
  // caller named one, else the phone-matched contact (share-skip-fix I8).
  const judged = recipient ?? phoneContact;
  // (1b) Soft-deleted - harder than no-consent, softer than opt-out.
  if (judged !== undefined && isDeleted(judged)) return 'contact_deleted';
  // (1.5) JIT consent - a PERSON'S send only; no contact record means no gate.
  if (!automated && judged !== undefined && !hasSmsConsent(judged)) return 'contact_no_consent';
  // (2) Manual mode - an AUTOMATED send only. The breaker that follows it in
  // the wrapper is live state and is not previewed.
  if (automated && isManualMode(conversation.ai_mode)) return 'manual_mode';
  return undefined;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/sendRefusalPreview.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts`
Expected: PASS - every table row agrees in both files (24 rows each), and the existing `sendMessage` and scheduled-suppression suites are unchanged.

- [ ] **Step 7: Typecheck, ASCII check, commit**

`npm run typecheck` (Expected: exit 0 - including the compile-time half of the parity test). ASCII: `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> `0` for `app/src/services/sendRefusalPreview.ts`, `app/test/helpers/sendRefusalCases.ts` and `app/test/sendRefusalPreview.test.ts`; `git diff -U0 -- app/test/sendMessage.test.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`.

```bash
npm run typecheck
git status
git add app/src/services/sendRefusalPreview.ts app/test/helpers/sendRefusalCases.ts app/test/sendRefusalPreview.test.ts app/test/sendMessage.test.ts
git commit -m "feat(send): previewSendRefusal - a pure preview of the one-to-one send wrapper's refusals, with a parity test (retry-send-window D3a)

Mirrors sendMessage's kill switch, opt-out, deleted, JIT consent and manual
mode gates in order, through the same predicates. One case table drives
the preview's unit test and a parity test through the real wrapper, so the
retry decision and the send path cannot drift.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/services/sendRefusalPreview.ts app/test/helpers/sendRefusalCases.ts app/test/sendRefusalPreview.test.ts app/test/sendMessage.test.ts
```

---
### Task 8: The send wrapper records the send's flags and the retry lineage at append (spec D6, D14, D12)

**Files:**
- Modify: `app/src/services/sendMessage.ts:207-212` (`automated` doc), `:235-241` (`retryOf` doc, D12, plus the two new inputs), `:249-252` (`recipient` doc), `:287` (destructuring), `:450-451` (the append)
- Test: `app/test/sendMessage.test.ts` (a new `describe` at the end of the file, after Task 7's parity block)

**Interfaces:**
- Consumes: Task 2's `NewMessage.retryAttempt`, `retryWindowStart`, `automated`, `recipientContactId`.
- Produces: `SendMessageInput` gains `retryAttempt?: number; retryWindowStart?: string;` (`retryOf` exists). The append passes `retryAttempt`, `retryWindowStart`, `automated` (ALWAYS - the input's default `false` included) and `recipientContactId: recipient.contactId` when `recipient` is set. Task 11 passes `retryOf` / `retryAttempt` / `retryWindowStart` / `automated` / `recipient` from the job; Task 12 passes `recipient` from the manual route. No caller changes here: every caller already passes `automated` explicitly or takes the person's-send default (spec D14).

- [ ] **Step 1: Write the failing tests**

Append at the end of `app/test/sendMessage.test.ts`:

```ts
// ---------------------------------------------------------------------------
// retry-send-window D6 + D14 (spec test intention 6a): what the wrapper writes
// at append so a retry can follow the original send. `automated` goes on EVERY
// row (the default false included), the caller's recipient by id only when one
// was named, and the automatic retry's lineage - attempt and window origin - at
// append rather than annotated afterwards.
// ---------------------------------------------------------------------------
describe('append-time retry lineage and the send flags (retry-send-window D6, D14)', () => {
  it('records automated on EVERY append: the default false, an explicit false and true', async () => {
    const f = makeFakes();
    await f.service({ conversationId: 'conv-1', body: 'default' });
    await f.service({ conversationId: 'conv-1', body: 'person', automated: false });
    await f.service({ conversationId: 'conv-1', body: 'machine', automated: true });
    // toHaveProperty WITH the value: an ABSENT flag must fail here, because a
    // row without it is retried as automated (D14's pre-deploy default).
    expect(f.appended[0]).toHaveProperty('automated', false);
    expect(f.appended[1]).toHaveProperty('automated', false);
    expect(f.appended[2]).toHaveProperty('automated', true);
  });

  it('records recipientContactId ONLY when the caller named a recipient', async () => {
    const f = makeFakes();
    const real: ContactItem = {
      contactId: 'c-real',
      type: 'tenant',
      phone: '+15550100001',
      consent_method: 'verbal_in_person',
    };
    await f.service({ conversationId: 'conv-1', body: 'fenced', automated: false, recipient: real });
    await f.service({ conversationId: 'conv-1', body: 'by phone' });
    expect(f.appended[0]).toHaveProperty('recipientContactId', 'c-real');
    expect(f.appended[1]).not.toHaveProperty('recipientContactId');
  });

  it('passes retryOf, retryAttempt and retryWindowStart into the append, and none of them on a normal send', async () => {
    const f = makeFakes();
    await f.service({
      conversationId: 'conv-1',
      body: 'retry body',
      automated: true,
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
      retryAttempt: 2,
      retryWindowStart: '2026-06-12T09:58:00.000Z',
    });
    await f.service({ conversationId: 'conv-1', body: 'normal' });
    expect(f.appended[0]).toMatchObject({
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
      retryAttempt: 2,
      retryWindowStart: '2026-06-12T09:58:00.000Z',
      automated: true,
    });
    for (const field of ['retryOf', 'retryAttempt', 'retryWindowStart']) {
      expect(f.appended[1]).not.toHaveProperty(field);
    }
  });

  it('the manual Retry shape (retryOf alone, a person send) carries no attempt and no window origin (D2)', async () => {
    const f = makeFakes();
    await f.service({
      conversationId: 'conv-1',
      body: 'again',
      automated: false,
      retryOf: '2026-06-12T09:58:00.000Z#SMorig',
    });
    expect(f.appended[0]).toMatchObject({ retryOf: '2026-06-12T09:58:00.000Z#SMorig', automated: false });
    expect(f.appended[0]).not.toHaveProperty('retryAttempt');
    expect(f.appended[0]).not.toHaveProperty('retryWindowStart');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app; npx vitest run test/sendMessage.test.ts`
Expected: FAIL on all four new cases - the append carries no `automated`, no `recipientContactId`, no `retryAttempt` and no `retryWindowStart` yet (vitest strips types, so the unknown inputs reach the wrapper and are ignored). Every other case in the file passes.

- [ ] **Step 3: Implement (`app/src/services/sendMessage.ts`)**

3a. The `automated` doc (spec D14, D12: under D14 its first sentence, "True for machine-initiated sends", stops being true - the automatic retry of a person's send is machine-initiated and passes false). Select `:207-212` - from the `  /**` whose next line begins `   * True for machine-initiated sends` through `  automated?: boolean;` (line `:208` carries a non-ASCII dash, so select the range rather than retyping it) - and replace the six lines with:

```ts
  /**
   * True for a send GATED like a machine's: the circuit breaker meters it and
   * manual mode refuses it (reminders, the missed-call and welcome texts, AI in
   * Phase 2). A person's send is false: never metered and never refused by
   * manual mode, but judged by the just-in-time consent gate. The
   * automatic 30003 retry passes the ORIGINAL send's value (retry-send-window
   * D14), so a person's text is retried as a person's send - the flag says how
   * a send is gated, not who initiated it. Persisted on every row this wrapper
   * appends as `automated` (false included - the default is a person's send).
   */
  automated?: boolean;
```

3b. The `retryOf` doc (spec D12: its "(The 30003 auto-retry annotates retry_of itself; it doesn't use this.)" becomes false under D6) and the two new inputs. Select `:235-241` - from the `  /**` whose next line reads `   * Manual retry (dashboard Retry button): the tsMsgId of the FAILED message this` through `  retryOf?: string;` (line `:238` carries a non-ASCII dash, so select the range rather than retyping it) - and replace the seven lines with:

```ts
  /**
   * Retry lineage: the tsMsgId of the FAILED message this send supersedes,
   * persisted as `retry_of` on the new message AT APPEND so the contact
   * timeline collapses the stale failed bubble. The manual Retry route passes
   * it alone; the automatic 30003 retry (messaging.retrySend) passes it with
   * retryAttempt and retryWindowStart (retry-send-window D6). Absent on a
   * normal send.
   */
  retryOf?: string;
  /**
   * retry-send-window D6: the 1-based attempt number of an automatic 30003
   * retry, persisted as `retry_attempt` AT APPEND so a fast 30003 on the new
   * message reads the chain's depth (the cap) with no annotate-after race.
   * Absent on every other send, the manual Retry included.
   */
  retryAttempt?: number;
  /**
   * retry-send-window D2/D6: the ORIGIN of the automatic retry chain - the
   * first send's provider_ts - persisted as `retry_window_start`, so attempts 2
   * and 3 measure the 15-minute window from the first send. A manual Retry
   * never passes it: a human chose to send now.
   */
  retryWindowStart?: string;
```

3c. The `recipient` doc (spec D14). Old (`:249-252`):

```ts
   * So the deleted and consent gates judge the caller's already-resolved
   * snapshot (redundant with the fan-out's own fence); opt-out stays fresh.
   */
  recipient?: ContactItem;
```

New:

```ts
   * So the deleted and consent gates judge the caller's already-resolved
   * snapshot (redundant with the fan-out's own fence); opt-out stays fresh.
   * retry-send-window D14: its id is persisted as `recipient_contact_id`, so a
   * retry of the row can judge the SAME contact (read back by id).
   */
  recipient?: ContactItem;
```

3d. The destructuring. Old (`:287`):

```ts
    const { conversationId, body, mediaUrls, attachments, automated = false, author = 'teammate', from, broadcastId, retryOf, recipient } = input;
```

New:

```ts
    const {
      conversationId,
      body,
      mediaUrls,
      attachments,
      automated = false,
      author = 'teammate',
      from,
      broadcastId,
      retryOf,
      retryAttempt,
      retryWindowStart,
      recipient,
    } = input;
```

3e. The append (spec D6, D14). Select `:450-451` - the comment line `      // Manual-retry lineage (additive ... absent on a normal send).` (it carries a non-ASCII dash; select it, do not retype it) and the `      ...(retryOf !== undefined && { retryOf }),` line under it - and replace the two lines with (the closing `    });` on `:452` stays):

```ts
      // Retry lineage, stamped AT APPEND (retry-send-window D6): the manual
      // Retry passes retryOf alone; the automatic 30003 retry passes all three,
      // so a fast 30003 on the retry can never read a row without its attempt
      // number or its chain's window origin. Absent on a normal send.
      ...(retryOf !== undefined && { retryOf }),
      ...(retryAttempt !== undefined && { retryAttempt }),
      ...(retryWindowStart !== undefined && { retryWindowStart }),
      // retry-send-window D14: the send's own flags, so its automatic retry is
      // sent the same way - `automated` on EVERY row (false included: the
      // input's default is a person's send) and the caller's recipient by id.
      automated,
      ...(recipient !== undefined && { recipientContactId: recipient.contactId }),
```

- [ ] **Step 4: Run the tests to verify they pass, plus the suites that send through the wrapper**

Run: `cd app; npx vitest run test/sendMessage.test.ts test/twilioStatusWebhook.test.ts test/broadcastFanOut.test.ts test/broadcastApi.test.ts test/missedCallAutoText.test.ts test/tourReminders.test.ts test/placementNudges.test.ts test/twilioWebhookHarnessRetryFields.test.ts`
Expected: PASS. The extra suites append through the harness world's real wrapper (`twilioWebhookHarness.ts:4416`); every appended row now also carries `automated` (and, from a share, `recipient_contact_id`), and none of them pins an exact row shape - a failure here means one does, and the assertion (not the new field) is what to fix.

- [ ] **Step 5: Typecheck, ASCII check, commit**

`npm run typecheck` (Expected: exit 0). ASCII of the added lines: `git diff -U0 -- app/src/services/sendMessage.ts app/test/sendMessage.test.ts | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`.

```bash
npm run typecheck
git status
git add app/src/services/sendMessage.ts app/test/sendMessage.test.ts
git commit -m "feat(send): the send wrapper records automated, the recipient and the retry lineage at append (retry-send-window D6, D14)

Every one-to-one row now carries automated (false included) and, when the
caller named one, recipient_contact_id, so its 30003 retry can be sent the
way the original was. retryAttempt and retryWindowStart ride the input into
the append so the automatic retry's lineage lands with the row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/services/sendMessage.ts app/test/sendMessage.test.ts
```

---
### Task 9: The one-to-one retry backoff lane seam and an explicit-runAt enqueue (spec D13, D7)

**Files:**
- Modify: `app/src/jobs/retrySend.ts:72-77` (`enqueueSendRetry`; new `resolveSendRetryBackoffMs` above it)
- Modify: `app/src/routes/webhooks/twilio.ts:119-122` (import), `:3364-3368` (the one call site - a MINIMAL change that keeps the build green; Task 10 replaces this arm and passes the D3a decision's `runAt` instead)
- Modify: `scripts/e2e-session.mjs:272` (lane `childEnv`)
- Create: `app/test/retrySendBackoff.test.ts`
- Test (run, unchanged): `app/test/twilioStatusWebhook.test.ts:423-451` (the default 60s enqueue), `:847-851` (`retryBackoffMs`)

**Interfaces:**
- Consumes: `retryBackoffMs(attempt)` (`app/src/jobs/retrySend.ts:40-42`); `enqueue(jobName, payload, { runAt })` (`app/src/jobs/jobs.ts:107-151`, which ceils `runAt - now` to whole seconds).
- Produces (exactly per the contract):
  ```ts
  export function resolveSendRetryBackoffMs(attempt: number): number;
  export async function enqueueSendRetry(payload: RetrySendPayload, runAt: Date): Promise<void>;
  ```
  and the lane `childEnv` entry `E2E_SEND_RETRY_BACKOFF_MS: '10000'`. Task 10's decision computes its `runAt` and its window check from `resolveSendRetryBackoffMs(attempt)` and passes that `runAt` here. No test pins the lane `childEnv` today (the relay value is unpinned too); the seam's in-process reach is pinned below, and Task 19's e2e is the proof that the lane value arrives.

- [ ] **Step 1: Write the failing tests**

Create `app/test/retrySendBackoff.test.ts`, mirroring the relay seam's own suite (`app/test/relayRetryLeg.test.ts:1005-1151`: the same env save/delete/restore, the same malformed values, the same topology cases):

```ts
// retry-send-window D13: the one-to-one retry backoff lane seam
// (E2E_SEND_RETRY_BACKOFF_MS) and the explicit-runAt producer. Mirrors the
// relay seam's tests ('relay.retryLeg backoff seam', relayRetryLeg.test.ts):
// the override is honored only in the one topology where a lane exists
// (JOBS_QUEUE_URL unset) and only when it parses to a positive integer, so a
// stray value in a deployed environment can never reshape a real retry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsClock,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
} from '../src/jobs/jobs.js';
import {
  enqueueSendRetry,
  resolveSendRetryBackoffMs,
  RETRY_SEND_JOB,
} from '../src/jobs/retrySend.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  makeWebhookHarness,
  signedTwilioPost,
  statusParams,
  TENANT_PHONE,
} from './helpers/twilioWebhookHarness.js';

const ENV_KEY = 'E2E_SEND_RETRY_BACKOFF_MS';
/** The TOPOLOGY discriminator: set in every deployed environment, unset in the
 *  hermetic lane and local dev (the relay seam's guard, relayRetryLeg.ts). */
const QUEUE_KEY = 'JOBS_QUEUE_URL';
const PROD_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/hc-prod-jobs';

describe('messaging.retrySend backoff seam (E2E_SEND_RETRY_BACKOFF_MS, retry-send-window D13)', () => {
  let outbound: InProcessOutboundQueueAdapter;
  let savedOverride: string | undefined;
  let savedQueueUrl: string | undefined;

  beforeEach(() => {
    _resetForTests();
    savedOverride = process.env[ENV_KEY];
    savedQueueUrl = process.env[QUEUE_KEY];
    delete process.env[ENV_KEY];
    delete process.env[QUEUE_KEY];
    const logger = createLogger({ destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    outbound = new InProcessOutboundQueueAdapter({ dispatch: async () => {}, logger });
    configureOutboundQueue(outbound);
  });

  afterEach(() => {
    if (savedOverride === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedOverride;
    if (savedQueueUrl === undefined) delete process.env[QUEUE_KEY];
    else process.env[QUEUE_KEY] = savedQueueUrl;
    _resetForTests();
  });

  const backoffs = (): number[] => [1, 2, 3].map((attempt) => resolveSendRetryBackoffMs(attempt));

  it('is retryBackoffMs (60/120/240s) with the override ABSENT', () => {
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  it.each(['abc', '0', '-5', '', '  '])('ignores the malformed value %j', (value) => {
    process.env[ENV_KEY] = value;
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  it('returns the override for EVERY attempt on a valid positive value with JOBS_QUEUE_URL unset', () => {
    process.env[ENV_KEY] = '10000';
    expect(backoffs()).toEqual([10_000, 10_000, 10_000]);
  });

  it('IGNORES the override in production topology (JOBS_QUEUE_URL set)', () => {
    process.env[ENV_KEY] = '10000';
    process.env[QUEUE_KEY] = PROD_QUEUE_URL;
    expect(backoffs()).toEqual([60_000, 120_000, 240_000]);
  });

  // An EMPTY queue URL is not a deployed topology: shells and `.env` files
  // routinely carry an unset value as the empty string.
  it('treats an EMPTY JOBS_QUEUE_URL as unset', () => {
    process.env[ENV_KEY] = '10000';
    process.env[QUEUE_KEY] = '';
    expect(backoffs()).toEqual([10_000, 10_000, 10_000]);
  });

  it('enqueueSendRetry schedules at EXACTLY the runAt it is given - the attempt no longer picks the delay (D7)', async () => {
    const now = Date.now();
    configureJobsClock(() => now);
    await enqueueSendRetry(
      { providerSid: 'SMseam0001', conversationId: 'conv-seam', attempt: 3 },
      new Date(now + 37_000),
    );
    expect(outbound.delayed).toHaveLength(1);
    const { envelope, delaySeconds } = outbound.delayed[0]!;
    expect(envelope.jobName).toBe(RETRY_SEND_JOB);
    expect(envelope.payload).toEqual({ providerSid: 'SMseam0001', conversationId: 'conv-seam', attempt: 3 });
    // 37s, not attempt 3's 240s: the caller's runAt - the instant it also
    // writes as retry_due_at - IS the schedule.
    expect(delaySeconds).toBe(37);
  });

  it('the status webhook schedules a 30003 retry on the lane override (the seam reaches the arm)', async () => {
    process.env[ENV_KEY] = '10000';
    const { app, world } = makeWebhookHarness();
    const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
      TENANT_PHONE,
      'tenant_1to1',
    );
    // Sent just now, so any send-window check applied to this chain is open.
    await world.messagesRepo.append({
      conversationId: conversation.conversationId,
      providerSid: 'SMseam0002',
      providerTs: new Date().toISOString(),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'lane body',
      deliveryStatus: 'queued',
    });

    const res = await signedTwilioPost(
      app,
      '/webhooks/twilio/status',
      statusParams({ MessageSid: 'SMseam0002', MessageStatus: 'undelivered', ErrorCode: '30003' }),
    );

    expect(res.status).toBe(200);
    expect(outbound.delayed).toHaveLength(1);
    expect(outbound.delayed[0]!.envelope.jobName).toBe(RETRY_SEND_JOB);
    // The lane's 10s, not attempt 1's 60s.
    expect(outbound.delayed[0]!.delaySeconds).toBe(10);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/retrySendBackoff.test.ts`
Expected: FAIL - the seam cases throw `resolveSendRetryBackoffMs is not a function` (not exported yet); the explicit-runAt case records `240` (attempt 3's backoff, `enqueueSendRetry` ignores its second argument today); the webhook case records `60` instead of `10`.

- [ ] **Step 3: Implement the seam and the producer (`app/src/jobs/retrySend.ts`, spec D13, D7)**

Replace `:72-77`. Old:

```ts
/** Producer side (status webhook): schedule ONE backed-off retry. */
export async function enqueueSendRetry(payload: RetrySendPayload): Promise<void> {
  await enqueue(RETRY_SEND_JOB, payload, {
    runAt: new Date(Date.now() + retryBackoffMs(payload.attempt)),
  });
}
```

New:

```ts
/**
 * The lane's one-to-one backoff override (retry-send-window D13). LANE-ONLY:
 * set in scripts/e2e-session.mjs's childEnv, never in dev or prod, and absent
 * from every `.env*`. The relay ladder's twin is E2E_RELAY_RETRY_BACKOFF_MS
 * (relayRetryLeg.ts), and this one takes the SAME two guards.
 */
const SEND_RETRY_BACKOFF_ENV_KEY = 'E2E_SEND_RETRY_BACKOFF_MS';

/**
 * retryBackoffMs(attempt) unless the lane override applies: env
 * E2E_SEND_RETRY_BACKOFF_MS (positive integer) honored ONLY when
 * JOBS_QUEUE_URL is unset (the relay seam's guard).
 *
 * JOBS_QUEUE_URL IS the topology: every deployed environment sets it
 * (Terraform's jobs module), and the one-to-one retry is scheduled by the
 * status webhook in the APP process - so without the guard a stray value in a
 * deployed environment would reshape every real retry, texting a tenant again
 * seconds after a failure. The hermetic lane and local dev leave it unset; an
 * EMPTY value counts as unset. Anything that does not parse to a positive
 * integer is ignored. Read from `process.env`, not config, on purpose: this is
 * a leaf on the enqueue path and the queue URL is only tested for presence.
 * The status webhook computes the retry's run time from this one function, so
 * the schedule and the promise it writes share the lane's value.
 */
export function resolveSendRetryBackoffMs(attempt: number): number {
  const queueUrl = process.env['JOBS_QUEUE_URL'];
  if (typeof queueUrl !== 'string' || queueUrl.length === 0) {
    const parsed = Number.parseInt(process.env[SEND_RETRY_BACKOFF_ENV_KEY] ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return retryBackoffMs(attempt);
}

/**
 * Producer side (status webhook): schedule ONE retry at an explicit run time.
 * The caller decides `runAt` (now plus the resolved backoff) and writes the
 * same instant as the failed message's `retry_due_at`, so the promise on
 * screen and the job's schedule are one value (retry-send-window D7).
 * `payload.attempt` rides along for the job's cap; it no longer picks the
 * delay here.
 */
export async function enqueueSendRetry(payload: RetrySendPayload, runAt: Date): Promise<void> {
  await enqueue(RETRY_SEND_JOB, payload, { runAt });
}
```

- [ ] **Step 4: Keep the one caller green - minimal (`app/src/routes/webhooks/twilio.ts`)**

This is the ONLY `enqueueSendRetry` caller (`git grep -n enqueueSendRetry -- app` shows the import and `:3364`). The change keeps today's behavior - 60/120/240s in production, the lane value in the lane - and nothing more; Task 10 replaces this arm with the D3a decision and passes the decision's `runAt`.

The import. Old (`:119-122`):

```ts
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';
```

New:

```ts
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
  resolveSendRetryBackoffMs,
} from '../../jobs/retrySend.js';
```

The call. Old (`:3364-3368`):

```ts
            await enqueueSendRetry({
              providerSid: MessageSid,
              conversationId: message.conversationId,
              attempt: priorAttempt + 1,
            });
```

New:

```ts
            // The retry runs one resolved backoff from now (the lane seam,
            // retry-send-window D13); the job is scheduled at exactly that instant.
            await enqueueSendRetry(
              {
                providerSid: MessageSid,
                conversationId: message.conversationId,
                attempt: priorAttempt + 1,
              },
              new Date(Date.now() + resolveSendRetryBackoffMs(priorAttempt + 1)),
            );
```

- [ ] **Step 5: Set the lane value (`scripts/e2e-session.mjs`, spec D13)**

Old (`:272-273`):

```js
  E2E_RELAY_RETRY_BACKOFF_MS: '10000',
  // Pass the lane to child processes so they can self-identify if needed.
```

New:

```js
  E2E_RELAY_RETRY_BACKOFF_MS: '10000',
  // One-to-one 30003 retry chain (retry-send-window D13): the same lane-only
  // seam for messaging.retrySend, so the one-to-one browser proof can watch a
  // bubble read "will retry" and then be replaced by the retry's own bubble
  // inside its budget. Read by app/src/jobs/retrySend.ts
  // (resolveSendRetryBackoffMs) under the SAME two guards as the relay value
  // above - ignored whenever JOBS_QUEUE_URL is set, ignored unless it parses to
  // a positive integer - so production keeps 60/120/240. Ten seconds for the
  // relay value's reason: it is the observation window. share-skip-fix Branch
  // B and send-outcome-reconcile reuse it.
  E2E_SEND_RETRY_BACKOFF_MS: '10000',
  // Pass the lane to child processes so they can self-identify if needed.
```

- [ ] **Step 6: Run the tests to verify they pass, and that the default is unchanged**

Run: `cd app; npx vitest run test/retrySendBackoff.test.ts test/twilioStatusWebhook.test.ts`
Expected: PASS - including `twilioStatusWebhook.test.ts`'s '30003 (transient) enqueues EXACTLY ONE backed-off retry job' (`:423-451`, still 60s: the override is absent in the test process) and the retrySend END TO END case (`:853-900`).

Then prove the lane literal parses and the seam stays lane-only (the relay review's conformance method):

```bash
node --check scripts/e2e-session.mjs
git grep -n --untracked "E2E_SEND_RETRY_BACKOFF_MS" -- ':!docs'
git grep -n --untracked "E2E_SEND_RETRY_BACKOFF_MS" -- '*.env*' 'infra'
```

Expected: `node --check` exits 0; the first grep lists only `app/src/jobs/retrySend.ts`, `app/test/retrySendBackoff.test.ts` and `scripts/e2e-session.mjs`; the second prints nothing.

- [ ] **Step 7: Typecheck, ASCII check, commit**

`npm run typecheck` (Expected: exit 0). ASCII: `tr -d '\11\12\15\40-\176' < app/test/retrySendBackoff.test.ts | wc -c` -> `0`; `git diff -U0 -- app/src/jobs/retrySend.ts app/src/routes/webhooks/twilio.ts scripts/e2e-session.mjs | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> `0`.

```bash
npm run typecheck
git status
git add app/src/jobs/retrySend.ts app/src/routes/webhooks/twilio.ts scripts/e2e-session.mjs app/test/retrySendBackoff.test.ts
git commit -m "feat(retry): one-to-one retry backoff lane seam and an explicit-runAt enqueue (retry-send-window D13, D7)

resolveSendRetryBackoffMs honors E2E_SEND_RETRY_BACKOFF_MS only when
JOBS_QUEUE_URL is unset and the value is a positive integer (the relay
seam's guards); enqueueSendRetry takes its run time from the caller so the
schedule and retry_due_at can be one instant. The 30003 arm passes now plus
the resolved backoff (unchanged timing); the lane sets the override to 10s.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/jobs/retrySend.ts app/src/routes/webhooks/twilio.ts scripts/e2e-session.mjs app/test/retrySendBackoff.test.ts
```

---

### Task 10: The one-to-one 30003 retry is decided before the failure is written (spec D3a, D7, D9, D11, D12, D13, D14)

**Files:**
- Create: `app/src/services/oneToOneRetryDecision.ts`
- Test (create): `app/test/oneToOneRetryDecision.test.ts`
- Modify: `app/src/routes/webhooks/twilio.ts` - the `../../jobs/retrySend.js` import (`:119-122`); the delivery-failure severity comment (`:315-341`); the one-to-one status write (`:3251`); `case '30003'` (`:3350-3370`); the group-text comments in the 30005/30006 arm (`:3422-3429`) and the 21610 arm (`:3477-3479`). Line numbers are at HEAD `fd38ba73`; Tasks 4-6 edit this file above `:2907` and shift them - anchor every edit on its quoted text.
- Test (modify): `app/test/twilioStatusWebhook.test.ts` - imports (`:19-41`), `seedOutbound` (`:48-73`), the first two 30003 tests (`:423-462`), new tests after the cap test (`:464-478`), the native group-text test in the D23 describe (`:1421-1464`).

**Interfaces:**
- Consumes:
  - Task 1 (`app/src/lib/retrySendWindow.ts`): `parseRetryWindowOrigin(value: unknown): number | undefined`; `retryFitsSendWindow(args: { originMs: number; nowMs: number; backoffMs: number }): boolean`; `RETRY_PROMISE_WITHDRAWN_AT`; in tests `RETRY_SEND_WINDOW_MS`, `RETRY_JOB_GRACE_MS`.
  - Task 2: `MessageItem.retry_window_start?: string`, `.retry_due_at?: string`, `.automated?: boolean`, `.recipient_contact_id?: string`; `updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string, options?: { retryDueAt?: string }): Promise<boolean>` (the stamp lands only with the transition); `MessageAnnotations.retryDueAt?: string`; the harness twins (`app/test/helpers/twilioWebhookHarness.ts`): fake `updateDeliveryStatus` honors `options.retryDueAt` only on a transition, fake `annotateMessage` honors `retryDueAt`.
  - Task 7: `previewSendRefusal(args: { smsSendingEnabled: boolean | undefined; conversation: Pick<ConversationItem, 'sms_opt_out' | 'ai_mode'>; phoneContact: ContactItem | undefined; recipient: ContactItem | undefined; automated: boolean }): SendRefusalCode | undefined` and `SendRefusalCode` (its parity table is what keeps the decision and `sendMessage` refusing the same cases, spec D3a step 2).
  - Task 9: `resolveSendRetryBackoffMs(attempt: number): number`; `enqueueSendRetry(payload: RetrySendPayload, runAt: Date): Promise<void>`.
  - Existing: `MAX_SEND_RETRY_ATTEMPTS` (`app/src/jobs/retrySend.ts:37`).
- Produces (exact, the skeleton contract):

```ts
export type OneToOneRetryDeclineReason =
  | 'conversation_missing' | 'group_text' | 'not_one_to_one' | SendRefusalCode
  | 'cap_exhausted' | 'window_closed';
export type OneToOneRetryDecision =
  | { kind: 'retry'; attempt: number; runAt: Date; failOpen?: 'read_failed' | 'no_origin'; readError?: unknown }
  | { kind: 'decline'; reason: OneToOneRetryDeclineReason; level: 'warn' | 'error' };
export async function decideOneToOneRetry(args: {
  message: MessageItem;
  conversations: Pick<ConversationsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'findByPhone' | 'getById'>;
  smsSendingEnabled: boolean | undefined;
  nowMs: number;
}): Promise<OneToOneRetryDecision>;
```

  Webhook behavior produced: a failed/undelivered callback carrying `30003` on the message path is decided BEFORE `updateDeliveryStatus`; a `retry` verdict passes `{ retryDueAt: runAt.toISOString() }`; the `30003` arm (transition only) logs the verdict and, for `retry`, calls `enqueueSendRetry(payload, runAt)`; an enqueue failure re-writes `retryDueAt: RETRY_PROMISE_WITHDRAWN_AT`, emits `message.persisted` and rethrows to the arm's existing ERROR. Log lines produced (tests match them exactly): decline `one-to-one 30003 retry not scheduled: <reason>` (field `retryDecision`), except `cap_exhausted`, which keeps today's exhausted-retries ERROR line byte-for-byte; fail-open WARNs `one-to-one 30003 retry scheduled without its checks: a conversation or contact read failed (fail open)` and `one-to-one 30003 retry scheduled without a window check: the message has no usable send time (fail open)` (field `failOpen`); INFO `one-to-one 30003 retry scheduled`; ERROR `one-to-one 30003 retry promise NOT withdrawn after a failed enqueue - it stands until it expires`.

- [ ] **Step 1: Write the failing decision unit tests (spec D3a, D5, D11, D13, D14)**

Create `app/test/oneToOneRetryDecision.test.ts` (pure: injected reads, injected clock, no harness, no DynamoDB):

```ts
// retry-send-window D3a + D14 (plan Task 10): decideOneToOneRetry, the
// one-to-one 30003 retry decision the status webhook makes BEFORE it writes
// the failure. Pure over injected reads and an injected clock (spec D13) - no
// harness, no DynamoDB. Every branch, and the order between them.
import { describe, expect, it } from 'vitest';
import { MAX_SEND_RETRY_ATTEMPTS, resolveSendRetryBackoffMs } from '../src/jobs/retrySend.js';
import { RETRY_JOB_GRACE_MS, RETRY_SEND_WINDOW_MS } from '../src/lib/retrySendWindow.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import {
  decideOneToOneRetry,
  type OneToOneRetryDecision,
  type OneToOneRetryDeclineReason,
} from '../src/services/oneToOneRetryDecision.js';

const NOW = Date.parse('2026-09-25T15:00:00.000Z');
const MIN = 60_000;
const PHONE = '+15550100001';
const iso = (ms: number): string => new Date(ms).toISOString();

/** A one-to-one outbound that just failed: sent 30 seconds before NOW. */
function failed(over: Partial<MessageItem> = {}): MessageItem {
  const providerTs = over.provider_ts ?? iso(NOW - 30_000);
  return {
    conversationId: 'conv-1',
    tsMsgId: `${providerTs}#SMfail01`,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    provider_sid: 'SMfail01',
    provider_ts: providerTs,
    delivery_status: 'sent',
    created_at: providerTs,
    ...over,
  };
}

function thread(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: 'conv-1',
    participant_phone: PHONE,
    status: 'open',
    last_activity_at: iso(NOW),
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: iso(NOW - 60 * MIN),
    ...over,
  };
}

function contact(over: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId: 'c-tenant',
    type: 'tenant',
    phone: PHONE,
    consent_method: 'verbal_in_person',
    ...over,
  };
}

interface Reads {
  /** The conversation read's answer; 'throw' makes it throw. Omitted: thread(). */
  conversation?: ConversationItem | undefined | 'throw';
  /** findByPhone's answer; 'throw' makes it throw. Omitted: no contact. */
  phoneContact?: ContactItem | 'throw';
  /** getById's answers, by contactId. */
  byId?: Record<string, ContactItem>;
  /** getById throws. */
  byIdThrows?: boolean;
  /** config.smsSendingEnabled. Omitted: true. */
  smsSendingEnabled?: boolean;
}

function decide(message: MessageItem, reads: Reads = {}): Promise<OneToOneRetryDecision> {
  const conversations: Pick<ConversationsRepo, 'getById'> = {
    async getById() {
      if (!('conversation' in reads)) return thread();
      const c = reads.conversation;
      if (c === 'throw') throw new Error('conversation read exploded');
      return c;
    },
  };
  const contacts: Pick<ContactsRepo, 'findByPhone' | 'getById'> = {
    async findByPhone() {
      const c = reads.phoneContact;
      if (c === 'throw') throw new Error('contact read exploded');
      return c;
    },
    async getById(contactId: string) {
      if (reads.byIdThrows === true) throw new Error('recipient read exploded');
      return reads.byId?.[contactId];
    },
  };
  return decideOneToOneRetry({
    message,
    conversations,
    contacts,
    smsSendingEnabled: reads.smsSendingEnabled ?? true,
    nowMs: NOW,
  });
}

const retryAt = (attempt: number): OneToOneRetryDecision => ({
  kind: 'retry',
  attempt,
  runAt: new Date(NOW + resolveSendRetryBackoffMs(attempt)),
});
const declined = (
  reason: OneToOneRetryDeclineReason,
  level: 'warn' | 'error',
): OneToOneRetryDecision => ({ kind: 'decline', reason, level });

// The send path's refusals, judged as the retry will be SENT (D14): with the
// ORIGINAL's automated flag (absent = automated) and its recorded recipient.
const REFUSALS: {
  name: string;
  message: MessageItem;
  reads: Reads;
  reason: OneToOneRetryDeclineReason;
}[] = [
  {
    name: 'the SMS kill switch is off',
    message: failed(),
    reads: { smsSendingEnabled: false },
    reason: 'sms_sending_disabled',
  },
  {
    name: 'the conversation is opted out',
    message: failed(),
    reads: { conversation: thread({ sms_opt_out: true }) },
    reason: 'contact_opted_out',
  },
  {
    name: 'the phone-matched contact is opted out',
    message: failed(),
    reads: { phoneContact: contact({ sms_opt_out: true }) },
    reason: 'contact_opted_out',
  },
  {
    name: 'the recorded recipient is opted out',
    message: failed({ automated: false, recipient_contact_id: 'c-real' }),
    reads: {
      phoneContact: contact(),
      byId: { 'c-real': contact({ contactId: 'c-real', sms_opt_out: true }) },
    },
    reason: 'contact_opted_out',
  },
  {
    name: 'the recorded recipient is soft-deleted',
    message: failed({ automated: false, recipient_contact_id: 'c-real' }),
    reads: {
      phoneContact: contact(),
      byId: { 'c-real': contact({ contactId: 'c-real', deleted_at: '2026-09-01T00:00:00.000Z' }) },
    },
    reason: 'contact_deleted',
  },
  {
    name: 'an AUTOMATED original sits on a manual-mode thread',
    message: failed({ automated: true }),
    reads: { conversation: thread({ ai_mode: 'manual' }) },
    reason: 'manual_mode',
  },
  {
    name: 'a row with NO automated flag (pre-deploy = automated) sits on a manual-mode thread',
    message: failed(),
    reads: { conversation: thread({ ai_mode: 'manual' }) },
    reason: 'manual_mode',
  },
  {
    name: "a PERSON'S original went to a contact with no recorded consent",
    message: failed({ automated: false }),
    reads: { phoneContact: contact({ consent_method: undefined }) },
    reason: 'contact_no_consent',
  },
];

describe('decideOneToOneRetry (retry-send-window D3a + D14)', () => {
  it('schedules attempt 1 at now + the resolved backoff when nothing refuses, with no fail-open flag', async () => {
    const d = await decide(failed());
    expect(d).toEqual(retryAt(1));
    expect(d).not.toHaveProperty('failOpen');
  });

  it('numbers the attempt from the row retry_attempt and backs off for THAT attempt', async () => {
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(NOW - 2 * MIN) }))).toEqual(
      retryAt(3),
    );
  });

  it('declines conversation_missing at WARN when the conversation row is gone (the level it logs at today)', async () => {
    expect(await decide(failed(), { conversation: undefined })).toEqual(
      declined('conversation_missing', 'warn'),
    );
  });

  it('declines a native group text at WARN (D11), ahead of the kill switch and the cap', async () => {
    const d = await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), {
      conversation: thread({ type: 'group_text', participant_phone: undefined, ai_mode: 'manual' }),
      smsSendingEnabled: false,
    });
    expect(d).toEqual(declined('group_text', 'warn'));
  });

  it('declines a relay_group or a phone-less thread as not_one_to_one at WARN', async () => {
    expect(await decide(failed(), { conversation: thread({ type: 'relay_group' }) })).toEqual(
      declined('not_one_to_one', 'warn'),
    );
    expect(await decide(failed(), { conversation: thread({ participant_phone: undefined }) })).toEqual(
      declined('not_one_to_one', 'warn'),
    );
  });

  it.each(REFUSALS)('declines at WARN when $name ($reason)', async ({ message, reads, reason }) => {
    expect(await decide(message, reads)).toEqual(declined(reason, 'warn'));
  });

  it("retries a PERSON'S original on a manual-mode (breaker-tripped) thread: manual mode refuses only automated sends (D14)", async () => {
    const d = await decide(failed({ automated: false }), {
      conversation: thread({ ai_mode: 'manual' }),
      phoneContact: contact(),
    });
    expect(d).toEqual(retryAt(1));
  });

  it("retries an AUTOMATED original to a no-consent contact: the consent gate judges a person's send only", async () => {
    const d = await decide(failed({ automated: true }), {
      phoneContact: contact({ consent_method: undefined }),
    });
    expect(d).toEqual(retryAt(1));
  });

  it('judges the RECORDED recipient: a soft-deleted duplicate on the same phone does not decline it (share-skip-fix I8)', async () => {
    const d = await decide(failed({ automated: false, recipient_contact_id: 'c-real' }), {
      phoneContact: contact({
        contactId: 'c-dup',
        deleted_at: '2026-09-01T00:00:00.000Z',
        consent_method: undefined,
      }),
      byId: { 'c-real': contact({ contactId: 'c-real' }) },
    });
    expect(d).toEqual(retryAt(1));
  });

  it('a recorded recipient id that resolves to nothing falls back to the phone-matched contact', async () => {
    const message = failed({ automated: false, recipient_contact_id: 'c-gone' });
    // Judged in the recipient's place, a no-consent phone contact declines it...
    expect(await decide(message, { phoneContact: contact({ consent_method: undefined }) })).toEqual(
      declined('contact_no_consent', 'warn'),
    );
    // ...and a consenting one lets it through.
    expect(await decide(message, { phoneContact: contact() })).toEqual(retryAt(1));
  });

  it('declines cap_exhausted at ERROR once retry_attempt reaches MAX_SEND_RETRY_ATTEMPTS', async () => {
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS, retry_window_start: iso(NOW - MIN) })),
    ).toEqual(declined('cap_exhausted', 'error'));
  });

  it('declines window_closed at ERROR once now + backoff + grace passes origin + 15 minutes, with THAT attempt backoff', async () => {
    // Attempt 3: the latest origin that still fits is now + backoff(3) + grace - window.
    const latestFit = NOW + resolveSendRetryBackoffMs(3) + RETRY_JOB_GRACE_MS - RETRY_SEND_WINDOW_MS;
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(latestFit) }))).toEqual(
      retryAt(3),
    );
    expect(await decide(failed({ retry_attempt: 2, retry_window_start: iso(latestFit - 1) }))).toEqual(
      declined('window_closed', 'error'),
    );
    // Attempt 1 of a text first sent 20 minutes ago.
    expect(await decide(failed({ provider_ts: iso(NOW - 20 * MIN) }))).toEqual(
      declined('window_closed', 'error'),
    );
  });

  it('measures from the CHAIN origin: retry_window_start wins over the row own provider_ts (D2)', async () => {
    // A retry row sent 30s ago whose chain began 14 minutes ago: attempt 2 no
    // longer fits, although it would from the row's own send time.
    expect(await decide(failed({ retry_attempt: 1, retry_window_start: iso(NOW - 14 * MIN) }))).toEqual(
      declined('window_closed', 'error'),
    );
  });

  it('ORDER: a send-path refusal outranks the cap, and the cap outranks the window', async () => {
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), {
        conversation: thread({ sms_opt_out: true }),
      }),
    ).toEqual(declined('contact_opted_out', 'warn'));
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS, provider_ts: iso(NOW - 20 * MIN) })),
    ).toEqual(declined('cap_exhausted', 'error'));
  });

  it('a THROWN conversation read fails OPEN (read_failed) - and the cap and the window still apply', async () => {
    expect(await decide(failed(), { conversation: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
    expect(
      await decide(failed({ retry_attempt: MAX_SEND_RETRY_ATTEMPTS }), { conversation: 'throw' }),
    ).toEqual(declined('cap_exhausted', 'error'));
    expect(
      await decide(failed({ provider_ts: iso(NOW - 20 * MIN) }), { conversation: 'throw' }),
    ).toEqual(declined('window_closed', 'error'));
  });

  it('a THROWN contact read (phone lookup or recorded recipient) fails OPEN after the conversation-level checks', async () => {
    expect(await decide(failed(), { phoneContact: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
    expect(
      await decide(failed({ automated: false, recipient_contact_id: 'c-real' }), {
        phoneContact: contact(),
        byIdThrows: true,
      }),
    ).toEqual({ ...retryAt(1), failOpen: 'read_failed', readError: expect.any(Error) });
    // The conversation read succeeded, so group_text still declines first.
    expect(
      await decide(failed(), {
        conversation: thread({ type: 'group_text', participant_phone: undefined }),
        phoneContact: 'throw',
      }),
    ).toEqual(declined('group_text', 'warn'));
  });

  it('a missing or unparseable origin fails OPEN (no_origin) and is never re-derived from provider_ts (D5)', async () => {
    const none = failed();
    delete (none as { provider_ts?: string }).provider_ts;
    expect(await decide(none)).toEqual({ ...retryAt(1), failOpen: 'no_origin' });
    // An unparseable retry_window_start is NOT replaced by the row's own (old)
    // provider_ts - that would restart the window.
    expect(
      await decide(failed({ retry_window_start: 'not-a-date', provider_ts: iso(NOW - 20 * MIN) })),
    ).toEqual({ ...retryAt(1), failOpen: 'no_origin' });
  });

  it('reports read_failed when a read throws AND the origin is missing', async () => {
    const none = failed();
    delete (none as { provider_ts?: string }).provider_ts;
    expect(await decide(none, { conversation: 'throw' })).toEqual({
      ...retryAt(1),
      failOpen: 'read_failed',
      readError: expect.any(Error),
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/oneToOneRetryDecision.test.ts`
Expected: FAIL - the suite cannot load `../src/services/oneToOneRetryDecision.js` (the module does not exist yet); no test runs.

- [ ] **Step 3: Implement the decision (spec D3a, D5, D11, D14)**

Create `app/src/services/oneToOneRetryDecision.ts`:

```ts
// retry-send-window D3a + D14 (plan Task 10): the ONE-TO-ONE 30003 retry
// decision. The status webhook calls it BEFORE it writes the failed status, so
// the failure and whether a retry will be attempted become visible together: a
// `retry` verdict rides the failure's conditional write as retry_due_at (D7), a
// `decline` leaves the failure plain. The 30003 arm then logs the verdict and,
// for a retry, enqueues it at exactly `runAt` - only on the transition, so a
// redelivered callback does nothing twice.
//
// ORDER (spec D3a - the send path's own gates, as it runs them):
//   1. the conversation row     - missing: decline, WARN (the level it logs at today)
//   2. group_text               - no retry exists for a native group text (D11), WARN
//   3. relay_group / no phone   - not a one-to-one SMS thread, WARN
//   4. the send path's refusals - previewSendRefusal, the SAME predicates as
//      sendMessage's gates (pinned by the parity table in
//      test/sendMessage.test.ts), judged for the ORIGINAL's `automated`
//      flag (absent = automated, D14) and its recorded recipient (absent, or an
//      id that resolves to nothing = the phone-matched contact), WARN
//   5. the cap                  - retry_attempt >= MAX_SEND_RETRY_ATTEMPTS, ERROR
//   6. the window               - the retry must go out by origin + 15 minutes
//      with RETRY_JOB_GRACE_MS to spare; origin = retry_window_start ??
//      provider_ts (D2), ERROR
//   7. otherwise                - retry at now + resolveSendRetryBackoffMs(attempt)
//
// FAILURE SEMANTICS (Cameron: attempt rather than risk a text never delivered):
// a conversation or contact read that THROWS fails OPEN - the checks it would
// have fed are skipped and the verdict is a retry marked failOpen 'read_failed'.
// The cap and the window still apply: they need no read. A missing or
// unparseable origin fails open too (failOpen 'no_origin', D5); when both
// happen, 'read_failed' is reported. The job's sendMessage re-applies every
// refusal at send time; the breaker is the one refusal no preview can see.
//
// No logging (the arm logs the verdict; the job WARNs on a recorded recipient
// that no longer exists) and no clock (the caller passes nowMs, spec D13).
import { MAX_SEND_RETRY_ATTEMPTS, resolveSendRetryBackoffMs } from '../jobs/retrySend.js';
import { parseRetryWindowOrigin, retryFitsSendWindow } from '../lib/retrySendWindow.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';
import { previewSendRefusal, type SendRefusalCode } from './sendRefusalPreview.js';

export type OneToOneRetryDeclineReason =
  | 'conversation_missing'
  | 'group_text'
  | 'not_one_to_one'
  | SendRefusalCode
  | 'cap_exhausted'
  | 'window_closed';

export type OneToOneRetryDecision =
  | { kind: 'retry'; attempt: number; runAt: Date; failOpen?: 'read_failed' | 'no_origin'; readError?: unknown }
  | { kind: 'decline'; reason: OneToOneRetryDeclineReason; level: 'warn' | 'error' };

export async function decideOneToOneRetry(args: {
  message: MessageItem;
  conversations: Pick<ConversationsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'findByPhone' | 'getById'>;
  smsSendingEnabled: boolean | undefined;
  nowMs: number;
}): Promise<OneToOneRetryDecision> {
  const { message, conversations, contacts, smsSendingEnabled, nowMs } = args;
  let readFailed = false;
  // The first thrown read, carried on the verdict so the arm's fail-open WARN
  // can name the fault (planner ruling on plan-draft-B2 F8).
  let readError: unknown;

  let conversation: ConversationItem | undefined;
  try {
    conversation = await conversations.getById(message.conversationId);
  } catch (err) {
    readFailed = true;
    readError = err;
  }

  if (!readFailed) {
    if (conversation === undefined) {
      return { kind: 'decline', reason: 'conversation_missing', level: 'warn' };
    }
    if (conversation.type === 'group_text') {
      return { kind: 'decline', reason: 'group_text', level: 'warn' };
    }
    const participantPhone = conversation.participant_phone;
    if (conversation.type === 'relay_group' || participantPhone === undefined) {
      return { kind: 'decline', reason: 'not_one_to_one', level: 'warn' };
    }

    let phoneContact: ContactItem | undefined;
    let recipient: ContactItem | undefined;
    try {
      phoneContact = await contacts.findByPhone(participantPhone);
      const recipientContactId = message.recipient_contact_id;
      if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
        recipient = await contacts.getById(recipientContactId);
      }
    } catch (err) {
      readFailed = true;
      readError = err;
    }

    if (!readFailed) {
      const refusal = previewSendRefusal({
        smsSendingEnabled,
        conversation,
        phoneContact,
        recipient,
        automated: message.automated ?? true,
      });
      if (refusal !== undefined) return { kind: 'decline', reason: refusal, level: 'warn' };
    }
  }

  const priorAttempt = message.retry_attempt ?? 0;
  if (priorAttempt >= MAX_SEND_RETRY_ATTEMPTS) {
    return { kind: 'decline', reason: 'cap_exhausted', level: 'error' };
  }
  const attempt = priorAttempt + 1;
  const backoffMs = resolveSendRetryBackoffMs(attempt);
  const originMs = parseRetryWindowOrigin(message.retry_window_start ?? message.provider_ts);
  if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs, backoffMs })) {
    return { kind: 'decline', reason: 'window_closed', level: 'error' };
  }
  const failOpen = readFailed ? 'read_failed' : originMs === undefined ? 'no_origin' : undefined;
  return {
    kind: 'retry',
    attempt,
    runAt: new Date(nowMs + backoffMs),
    ...(failOpen !== undefined && { failOpen }),
    ...(readError !== undefined && { readError }),
  };
}
```

- [ ] **Step 4: Run the decision tests to verify they pass**

Run: `cd app; npx vitest run test/oneToOneRetryDecision.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Move the fixture to a realistic send time and write the failing webhook tests (spec D3a, D7, D9, D11, D13, D14; test intention 4)**

All edits in `app/test/twilioStatusWebhook.test.ts`.

(a) Imports. Change the messages-repo type import (`:27`) to:

```ts
import type { MessageItem, MessagesRepo } from '../src/repos/messagesRepo.js';
```

Add `resolveSendRetryBackoffMs` to the `../src/jobs/retrySend.js` import (`:19-25`) unless Task 9 already added it; the import then reads:

```ts
import {
  MAX_SEND_RETRY_ATTEMPTS,
  parseRetrySendPayload,
  registerRetrySendJobHandler,
  resolveSendRetryBackoffMs,
  RETRY_SEND_JOB,
  retryBackoffMs,
} from '../src/jobs/retrySend.js';
```

Add after `import { loadConfig } from '../src/lib/config.js';` (`:31`):

```ts
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
```

(b) Replace `seedOutbound` (`:48-73`, the doc line through its closing brace) with (spec D13: the fixed past `providerTs` at `:59` moves to a realistic time):

```ts
/**
 * Seed one outbound message (the thing callbacks are about) into the world.
 *
 * retry-send-window D13: the send time is REALISTIC - 30 seconds before the
 * wall clock the webhook's decision reads - because a 30003 now measures the
 * 15-minute retry window from it; the old fixed 2026-06-12 date would close
 * the window on every retry test. `overrides.provider_ts` sets it explicitly
 * (and the tsMsgId prefix follows it).
 */
async function seedOutbound(
  world: FakeWorld,
  sid: string,
  overrides: Partial<MessageItem> = {},
  participantPhone: string = TENANT_PHONE,
): Promise<MessageItem> {
  const conversation = await world.conversationsRepo.createOrGetByParticipantPhone(
    participantPhone,
    'tenant_1to1',
  );
  const providerTs = overrides.provider_ts ?? new Date(Date.now() - 30_000).toISOString();
  await world.messagesRepo.append({
    conversationId: conversation.conversationId,
    providerSid: sid,
    providerTs,
    type: 'sms',
    direction: 'outbound',
    author: 'teammate',
    body: 'outbound body',
    deliveryStatus: 'queued',
  });
  const item = (await world.messagesRepo.getByProviderSid(sid))!;
  Object.assign(item, overrides);
  return item;
}
```

(c) Replace the test `'30003 (transient) enqueues EXACTLY ONE backed-off retry job through jobs.enqueue()'` (`:423-451`, whole `it(...)` block) with:

```ts
    it('30003 (transient) stamps retry_due_at IN the failure write, emits ONE SSE that already sees both, then enqueues EXACTLY ONE backed-off retry (retry-send-window D3a/D7)', async () => {
      const { app, world, capture } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');
      // Record every status write and every annotate: D7 is ONE conditional
      // write carrying the failure AND the stamp, with no second write after.
      const statusWrites: Parameters<MessagesRepo['updateDeliveryStatus']>[] = [];
      const realUpdate = world.messagesRepo.updateDeliveryStatus.bind(world.messagesRepo);
      world.messagesRepo.updateDeliveryStatus = async (...args) => {
        statusWrites.push(args);
        return realUpdate(...args);
      };
      let annotates = 0;
      const realAnnotate = world.messagesRepo.annotateMessage.bind(world.messagesRepo);
      world.messagesRepo.annotateMessage = async (...args) => {
        annotates += 1;
        return realAnnotate(...args);
      };
      // What the row holds at the instant of each message.persisted emit.
      const atEmit: { status: string | undefined; due: string | undefined }[] = [];
      world.events.on('message.persisted', () => {
        const row = world.messages.find((m) => m.provider_sid === 'SMout0001');
        atEmit.push({ status: row?.delivery_status, due: row?.retry_due_at });
      });

      const before = Date.now();
      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );
      const after = Date.now();
      expect(res.status).toBe(200);

      const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
      const due = row.retry_due_at!;
      // The run time = the decision's clock + the resolved backoff for attempt 1.
      expect(Date.parse(due)).toBeGreaterThanOrEqual(before + resolveSendRetryBackoffMs(1));
      expect(Date.parse(due)).toBeLessThanOrEqual(after + resolveSendRetryBackoffMs(1));
      expect(statusWrites).toEqual([['SMout0001', 'undelivered', '30003', { retryDueAt: due }]]);
      expect(annotates).toBe(0);
      expect(atEmit).toEqual([{ status: 'undelivered', due }]);
      // A clean retry logs one INFO line and no decision WARN or ERROR.
      expect(
        capture.lines.filter((l) => l['msg'] === 'one-to-one 30003 retry scheduled'),
      ).toHaveLength(1);
      expect(
        capture.lines.some((l) => l['retryDecision'] !== undefined || l['failOpen'] !== undefined),
      ).toBe(false);

      // Routed through the SQS path with an exact DelaySeconds backoff (60s for
      // attempt 1), recorded as a delayed outbound job - NOT an EventBridge
      // schedule, and NOT clamped to a 60s floor.
      expect(outbound.delayed).toHaveLength(1);
      const { envelope, delaySeconds } = outbound.delayed[0]!;
      expect(envelope.jobName).toBe(RETRY_SEND_JOB);
      expect(envelope.payload).toEqual({
        providerSid: 'SMout0001',
        conversationId: seeded.conversationId,
        attempt: 1,
      });
      // context envelope: the recovered conversationId rides the job
      expect(envelope.correlationContext.conversationId).toBe(seeded.conversationId);
      // enqueued at the SAME run time the stamp promised
      expect(delaySeconds).toBe(resolveSendRetryBackoffMs(1) / 1000);
      // the payload never carries the message body (PII rides the DB, not the wire)
      expect(JSON.stringify(envelope.payload)).not.toContain('outbound body');
    });
```

(d) Replace the test `'a REDELIVERED 30003 callback does not enqueue a second retry (transition no-op gates side effects)'` (`:453-462`) with:

```ts
    it('a REDELIVERED 30003 callback writes, logs and enqueues nothing more - the transition gates every side effect (retry-send-window D3a)', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      const params = statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' });

      await signedTwilioPost(app, STATUS_PATH, params);
      const stamped = (await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at;
      expect(stamped).toBeDefined();
      const emitsAfterFirst = world.emitted.filter((e) => e.event === 'message.persisted').length;

      await signedTwilioPost(app, STATUS_PATH, params); // Twilio redelivery

      expect(outbound.delayed).toHaveLength(1);
      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at).toBe(stamped);
      expect(world.emitted.filter((e) => e.event === 'message.persisted')).toHaveLength(
        emitsAfterFirst,
      );
      expect(
        capture.lines.filter((l) => l['msg'] === 'one-to-one 30003 retry scheduled'),
      ).toHaveLength(1);
    });
```

(e) Insert directly after the test `'30003 past the attempt cap ERRORs (now terminal) and does NOT enqueue'` (ends `:478`):

```ts
    // retry-send-window D3a/D9/D11/D14: EVERY decline leaves the failure plain -
    // no retry_due_at and no enqueue - and logs exactly ONE line naming the
    // reason at the decision's level. One harness per case (each owns its log
    // capture); the beforeEach gives each a fresh outbound queue.
    const DECLINES: {
      reason: string;
      name: string;
      level: number;
      msg: string;
      env?: Record<string, string>;
      arrange: (world: FakeWorld) => Promise<void>;
    }[] = [
      {
        reason: 'conversation_missing',
        name: 'the conversation row is gone',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: conversation_missing',
        arrange: async (world) => {
          const seeded = await seedOutbound(world, 'SMout0001');
          world.conversations.delete(seeded.conversationId);
        },
      },
      {
        reason: 'not_one_to_one',
        name: 'the row sits on a relay_group thread',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: not_one_to_one',
        arrange: async (world) => {
          const seeded = await seedOutbound(world, 'SMout0001');
          world.conversations.get(seeded.conversationId)!.type = 'relay_group';
        },
      },
      {
        reason: 'sms_sending_disabled',
        name: 'the SMS kill switch is off',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: sms_sending_disabled',
        env: { SMS_SENDING_ENABLED: 'false' },
        arrange: async (world) => {
          await seedOutbound(world, 'SMout0001');
        },
      },
      {
        reason: 'contact_opted_out',
        name: 'the conversation is opted out',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: contact_opted_out',
        arrange: async (world) => {
          const seeded = await seedOutbound(world, 'SMout0001');
          world.conversations.get(seeded.conversationId)!.sms_opt_out = true;
        },
      },
      {
        reason: 'contact_deleted',
        name: 'the recorded recipient is soft-deleted',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: contact_deleted',
        arrange: async (world) => {
          world.contacts.push({
            contactId: 'c-gone',
            type: 'tenant',
            phone: TENANT_PHONE,
            consent_method: 'verbal_in_person',
            deleted_at: '2026-09-01T00:00:00.000Z',
          });
          await seedOutbound(world, 'SMout0001', { automated: false, recipient_contact_id: 'c-gone' });
        },
      },
      {
        reason: 'manual_mode',
        name: 'an AUTOMATED original sits on a manual-mode (breaker-tripped) thread',
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: manual_mode',
        arrange: async (world) => {
          const seeded = await seedOutbound(world, 'SMout0001', { automated: true });
          world.conversations.get(seeded.conversationId)!.ai_mode = 'manual';
        },
      },
      {
        reason: 'contact_no_consent',
        name: "a PERSON'S original went to a contact with no recorded consent",
        level: WARN,
        msg: 'one-to-one 30003 retry not scheduled: contact_no_consent',
        arrange: async (world) => {
          world.contacts.push({ contactId: 'c-nc', type: 'tenant', phone: TENANT_PHONE });
          await seedOutbound(world, 'SMout0001', { automated: false });
        },
      },
      {
        reason: 'window_closed',
        name: 'the original went out 20 minutes ago',
        level: ERROR,
        msg: 'one-to-one 30003 retry not scheduled: window_closed',
        arrange: async (world) => {
          await seedOutbound(world, 'SMout0001', {
            provider_ts: new Date(Date.now() - 20 * 60_000).toISOString(),
          });
        },
      },
      {
        reason: 'cap_exhausted',
        name: 'the retries are exhausted',
        level: ERROR,
        // The pre-existing exhausted-retries line, kept byte-for-byte (its
        // tail carries a non-ASCII dash, so this matches the ASCII prefix).
        msg: 'transient delivery failure exhausted retries',
        arrange: async (world) => {
          await seedOutbound(world, 'SMout0001', { retry_attempt: MAX_SEND_RETRY_ATTEMPTS });
        },
      },
    ];

    it.each(DECLINES)(
      'retry-send-window: $reason ($name) leaves a plain failure - no stamp, no enqueue, one line',
      async ({ level, msg, env, arrange }) => {
        const { app, world, capture } = makeWebhookHarness(env !== undefined ? { env } : {});
        await arrange(world);

        const res = await signedTwilioPost(
          app,
          STATUS_PATH,
          statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
        );
        expect(res.status).toBe(200);

        const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
        expect(row.delivery_status).toBe('undelivered');
        expect(row.error_code).toBe('30003');
        expect(row.retry_due_at).toBeUndefined();
        expect(outbound.delayed).toHaveLength(0);
        expect(capture.atLevel(level).filter((l) => String(l['msg']).startsWith(msg))).toHaveLength(1);
      },
    );

    it("retry-send-window D14: a PERSON'S original on a manual-mode (breaker-tripped) thread IS retried - stamped and enqueued", async () => {
      const { app, world } = makeWebhookHarness();
      world.contacts.push({
        contactId: 'contact-T',
        type: 'tenant',
        phone: TENANT_PHONE,
        consent_method: 'verbal_in_person',
      });
      const seeded = await seedOutbound(world, 'SMout0001', { automated: false });
      world.conversations.get(seeded.conversationId)!.ai_mode = 'manual';

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
    });

    it('retry-send-window D14: the RECORDED recipient is judged - a soft-deleted duplicate contact on the same phone does not decline the retry', async () => {
      const { app, world } = makeWebhookHarness();
      // The fake findByPhone returns the FIRST contact on the phone: push the
      // soft-deleted, no-consent duplicate first, the real recipient second.
      world.contacts.push({
        contactId: 'c-dup',
        type: 'tenant',
        phone: TENANT_PHONE,
        deleted_at: '2026-09-01T00:00:00.000Z',
      });
      world.contacts.push({
        contactId: 'c-real',
        type: 'tenant',
        phone: TENANT_PHONE,
        consent_method: 'verbal_in_person',
      });
      await seedOutbound(world, 'SMout0001', { automated: false, recipient_contact_id: 'c-real' });

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
    });

    it('retry-send-window D3a: a contact read that THROWS fails open - stamped, enqueued, one WARN naming the gap', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      world.contactsRepo.findByPhone = async () => {
        throw new Error('contacts read exploded');
      };

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
      const warns = capture.atLevel(WARN).filter((l) => l['failOpen'] === 'read_failed');
      expect(warns).toHaveLength(1);
      expect(warns[0]!['msg']).toBe(
        'one-to-one 30003 retry scheduled without its checks: a conversation or contact read failed (fail open)',
      );
    });

    it('retry-send-window D5: a row with no usable send time fails open - stamped, enqueued, one WARN naming the gap', async () => {
      const { app, world, capture } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');
      delete (seeded as { provider_ts?: string }).provider_ts;

      await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );

      expect((await world.messagesRepo.getByProviderSid('SMout0001'))?.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
      const warns = capture.atLevel(WARN).filter((l) => l['failOpen'] === 'no_origin');
      expect(warns).toHaveLength(1);
      expect(warns[0]!['msg']).toBe(
        'one-to-one 30003 retry scheduled without a window check: the message has no usable send time (fail open)',
      );
    });

    it('retry-send-window D7: a FAILED enqueue withdraws the promise at once - expired stamp, one more SSE - and keeps the arm ERROR', async () => {
      const { app, world, capture } = makeWebhookHarness();
      const seeded = await seedOutbound(world, 'SMout0001');
      configureOutboundQueue({
        async enqueue() {
          throw new Error('queue down');
        },
      });

      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );
      expect(res.status).toBe(200); // a side effect never 5xxs the callback

      const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
      expect(row.delivery_status).toBe('undelivered');
      expect(row.retry_due_at).toBe(RETRY_PROMISE_WITHDRAWN_AT);
      const emits = world.emitted.filter(
        (e) =>
          e.event === 'message.persisted' &&
          (e.payload as { tsMsgId: string }).tsMsgId === seeded.tsMsgId,
      );
      expect(emits).toHaveLength(2); // the transition's, then the withdrawal's
      expect(
        capture.atLevel(ERROR).filter((l) => l['msg'] === 'delivery-error side effect failed'),
      ).toHaveLength(1);
      expect(capture.lines.some((l) => l['msg'] === 'one-to-one 30003 retry scheduled')).toBe(false);
    });
```

(f) Invert the synthetic native group-text test in the `relay delivery-failure severity (D23)` describe (spec D11): replace its comment and the test `'leaves a native group-text 30003 receipt unchanged'` (`:1421-1464`) with:

```ts
  // retry-send-window D11 - INVERTED from "leaves a native group-text 30003
  // receipt unchanged". A group leg resolves as a MESSAGE, not through a
  // relaysid pointer, so it never reaches the relay branch: the shared set still
  // keeps its delivery_failed marker at WARN with no retryClaim. What changed is
  // the arm: no retry exists for a native group text, so the one-to-one decision
  // declines it (WARN, group_text) - no retry_due_at stamp and NO enqueue, where
  // the arm used to enqueue a retry that sendMessage then refused.
  it('keeps a native group-text 30003 marker at WARN and schedules NO retry (retry-send-window D11)', async () => {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const { app, world, capture } = makeWebhookHarness();
    world.contacts.push({ contactId: 'contact-T', type: 'tenant', phone: TENANT_PHONE });
    const group = await world.conversationsRepo.createGroupTextThread({
      conversationId: 'gt-30003-severity',
      members: [
        { contactId: 'contact-T', phone: TENANT_PHONE },
        { contactId: 'contact-O', phone: '+15550100009' },
      ],
    });
    await world.messagesRepo.append({
      conversationId: group.item.conversationId,
      providerSid: 'SMgroup30003',
      // A realistic send time, inside the retry window: the decline must come
      // from group_text, never from the window (spec D13).
      providerTs: new Date(Date.now() - 30_000).toISOString(),
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'group body',
      deliveryStatus: 'queued',
    });

    await signedTwilioPost(
      app,
      STATUS_PATH,
      statusParams({
        MessageSid: 'SMgroup30003',
        MessageStatus: 'undelivered',
        ErrorCode: '30003',
      }),
    );

    expect(capture.atLevel(ERROR).filter((l) => l['event'] === 'delivery_failed')).toHaveLength(0);
    const warn = capture
      .atLevel(WARN)
      .find((l) => l['event'] === 'delivery_failed' && l['providerSid'] === 'SMgroup30003');
    expect(warn).toBeDefined();
    expect(warn!['relay']).toBeUndefined();
    expect(warn!['retryClaim']).toBeUndefined();
    // D11: no retry exists for a native group text - no promise, no job.
    const row = await world.messagesRepo.getByProviderSid('SMgroup30003');
    expect(row?.delivery_status).toBe('undelivered');
    expect(row?.retry_due_at).toBeUndefined();
    expect(outbound.delayed).toHaveLength(0);
    const declined = capture.atLevel(WARN).filter((l) => l['retryDecision'] === 'group_text');
    expect(declined).toHaveLength(1);
    expect(declined[0]!['msg']).toBe('one-to-one 30003 retry not scheduled: group_text');
  });
```

- [ ] **Step 6: Run the webhook suite to verify the new tests fail**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts`
Expected: FAIL on: the stamp test (no `retry_due_at`; the status write has three arguments), the redelivery test (`stamped` undefined), every `it.each` decline except `cap_exhausted` (the arm enqueues today, so `outbound.delayed` has 1, and no decline line is logged), the four acceptance tests (no stamp; no fail-open WARN), the failed-enqueue test (no withdrawal: `retry_due_at` undefined, one emit), and the inverted D11 test (the arm enqueues for the group row; no `group_text` line). The `cap_exhausted` row and every other existing test pass: the realistic seed time changes nothing today.

- [ ] **Step 7: Implement the webhook (spec D3a, D7, D9, D11, D12)**

All edits in `app/src/routes/webhooks/twilio.ts`.

(A) Imports (`:119-122`). Replace

```ts
import {
  enqueueSendRetry,
  MAX_SEND_RETRY_ATTEMPTS,
} from '../../jobs/retrySend.js';
```

with the block below (after this task nothing here reads `MAX_SEND_RETRY_ATTEMPTS`; if Task 9 added `resolveSendRetryBackoffMs` to this import for an interim call site, drop it too - the decision owns that call now). If Task 4 already imports from `../../lib/retrySendWindow.js`, fold `RETRY_PROMISE_WITHDRAWN_AT` into that import instead of adding a second one.

```ts
import { enqueueSendRetry } from '../../jobs/retrySend.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../../lib/retrySendWindow.js';
import {
  decideOneToOneRetry,
  type OneToOneRetryDecision,
} from '../../services/oneToOneRetryDecision.js';
```

(B) The severity-taxonomy comment (spec D12). Replace the whole comment block at HEAD `:315-341` - the 27 lines from `// --- Delivery-failure severity taxonomy` down to `// path where the promise holds.`, directly above `const TRANSIENT_RETRYING_DELIVERY_CODES` (the old block carries non-ASCII characters this ASCII-only plan cannot quote; the two `const` lines below it stay) - with:

```ts
// --- Delivery-failure severity taxonomy --------------------------------------
// Policy: a message that ends UNDELIVERED and won't be retried is a TERMINAL
// failure - log at ERROR (it degraded a real send, is operator-actionable, and
// feeds the hc-<env>-error-logs alarm + the Recent Errors panel). Two carve-outs
// keep the per-callback `delivery_failed` marker at WARN: 30003 (handset
// unreachable, the one code with an automatic retry) and a provider-side opt-out
// (21610 = correctly honoring STOP - the platform working, not a failure). See
// docs/GLOSSARY / the error-vs-warn decision rule.
//
// THE 30003 CARVE-OUT GOVERNS THE MARKER, NOT A PROMISE (retry-send-window D9).
// The marker stays WARN on every 30003, retried or not, so no alarm threshold
// moves. Whether a retry will actually be attempted is decided per message and
// logged on a line of its own:
//
//   - ONE-TO-ONE: decideOneToOneRetry (services/oneToOneRetryDecision.ts) runs
//     BEFORE the status write (D3a), and a retry verdict rides that same
//     conditional write as retry_due_at (D7), so the screen never sees the
//     failure without its decision. The 30003 arm below logs the verdict once,
//     on the transition: a dead end (retries exhausted, the 15-minute send
//     window closed) is its own ERROR line; a retry the send path would
//     refuse right now (kill switch, opt-out, a deleted recipient, manual mode
//     for an automated original, no consent for a person's original), a native
//     group text, a thread that is not a one-to-one SMS thread and a missing
//     conversation row are WARN.
//   - NATIVE GROUP TEXT: no retry exists (D11). The decision refuses to
//     schedule one for a `group_text` conversation, and sendMessage refuses the
//     send anyway (GroupTextSendNotSupportedError) should a failed read let one
//     through. Whether a classic callback reaches this path for a group leg at
//     all is unverified live behavior (services/groupReceipts.ts:3-10).
//   - RELAY: this set does not decide relay severity at all. The relay branch
//     reads isTerminalRelayLegFailure below, which is attempt-aware; its own
//     comment names which claim outcomes stay WARN.
//
// The set's VALUES are unchanged.
```

(B2) The `isTerminalDeliveryFailure` doc (spec D12). Replace the six-line doc comment directly above `export function isTerminalDeliveryFailure(` (HEAD `:345-350`, from `/**` to ` */`; it carries a non-ASCII arrow, so select it rather than retyping) with:

```ts
/**
 * True when an undelivered/failed delivery callback is a TERMINAL, operator-
 * actionable failure (log at ERROR). False for 30003, the one code with an
 * automatic retry, whose per-callback marker stays WARN whether or not a retry
 * is attempted (retry-send-window D9: the retry decision logs its own line),
 * and for a provider-side opt-out (21610). A failure with no code, or any
 * unrecognized code, is treated as terminal (fail loud, not silent).
 */
```

(B3) The one-to-one delivery-failure marker comment (spec D12). Replace the seven-line comment that ends with the line `    // IDs/codes only, never the body (PII).` (unique in the file; HEAD `:3272-3278`, starting at `    // Delivery-failure marker (doc` - the one-to-one path's, not the relay one at `:3019`; it carries non-ASCII characters, so select it rather than retyping) with:

```ts
    // Delivery-failure marker (doc section 9 "Send failures / delivery errors"):
    // a callback that resolves to undelivered/failed is a countable failed
    // delivery. Severity follows the taxonomy above - a TERMINAL failure is an
    // ERROR (feeds the error-logs alarm + Recent Errors panel); a 30003 (retried
    // or not - the retry decision logs its own line, retry-send-window D9) or a
    // provider-side opt-out (21610) stays WARN. The `event` field is unchanged,
    // so the DeliveryFailures count metric (keyed on `event`, not level) is
    // unaffected. IDs/codes only, never the body (PII).
```

(C) The status write (`:3251`). Replace

```ts
    const transitioned = await messages.updateDeliveryStatus(MessageSid, mappedStatus, ErrorCode);
```

with:

```ts
    // retry-send-window D3a/D7: a 30003 FAILURE decides NOW - before the status
    // write - whether a retry will be attempted, and a retry verdict rides the
    // SAME conditional write as retry_due_at (= the retry's run time), so the
    // failure and its promise become visible together, in the transition's one
    // SSE below. Only a failed/undelivered callback carrying 30003 decides; the
    // verdict is logged and acted on in the 30003 arm, only on the transition.
    const oneToOneRetry: OneToOneRetryDecision | undefined =
      (mappedStatus === 'undelivered' || mappedStatus === 'failed') && ErrorCode === '30003'
        ? await decideOneToOneRetry({
            message,
            conversations,
            contacts,
            smsSendingEnabled: config.smsSendingEnabled,
            nowMs: Date.now(),
          })
        : undefined;
    const transitioned = await messages.updateDeliveryStatus(
      MessageSid,
      mappedStatus,
      ErrorCode,
      oneToOneRetry?.kind === 'retry' ? { retryDueAt: oneToOneRetry.runAt.toISOString() } : undefined,
    );
```

(D) The head of `case '30003'` (`:3351-3354`). Replace

```ts
            // Transient (handset unreachable): ONE scheduled retry with
            // backoff, capped chain (attempt count rides the job payload).
            const priorAttempt = message.retry_attempt ?? 0;
            if (priorAttempt >= MAX_SEND_RETRY_ATTEMPTS) {
```

with the lines below. Leave the next nine lines (`:3355-3363`: the three-line "Retries exhausted" comment, the `log.error(...)` with today's exhausted-retries text, `break;` and the closing `}`) EXACTLY as they are - that text is the `cap_exhausted` line D9 keeps, and it carries a pre-existing non-ASCII dash, so do not retype it:

```ts
            // Transient (handset unreachable). retry-send-window D3a/D9: WHETHER
            // to retry was decided above, BEFORE the status write, and a retry
            // verdict rode that write as retry_due_at (D7). This arm runs only on
            // the transition, so a redelivered callback logs and enqueues
            // nothing twice. A non-failure status carrying 30003 decided nothing.
            if (oneToOneRetry === undefined) break;
            const priorAttempt = message.retry_attempt ?? 0;
            if (oneToOneRetry.kind === 'decline' && oneToOneRetry.reason === 'cap_exhausted') {
```

(E) The tail of `case '30003'` (`:3364-3369`): replace the `enqueueSendRetry(...)` call and the `break;` after it (Task 9 may have given this call a second `runAt` argument - replace it whatever its arguments), keeping the case's closing `}` and the following `case '30005':`, i.e. replace

```ts
            await enqueueSendRetry({
              providerSid: MessageSid,
              conversationId: message.conversationId,
              attempt: priorAttempt + 1,
            });
            break;
```

with:

```ts
            if (oneToOneRetry.kind === 'decline') {
              // D9: a closed window is a dead end and is ERROR; a retry the send
              // path would refuse now, a native group text (D11), a thread that
              // is not one-to-one SMS, or a missing conversation (the level it
              // logs at today) is WARN. Nothing was stamped, so the bubble shows
              // the plain failure and its Retry.
              const declined = {
                providerSid: MessageSid,
                errorCode: ErrorCode,
                attempt: priorAttempt + 1,
                retryDecision: oneToOneRetry.reason,
              };
              const declinedMsg = `one-to-one 30003 retry not scheduled: ${oneToOneRetry.reason}`;
              if (oneToOneRetry.level === 'error') log.error(declined, declinedMsg);
              else log.warn(declined, declinedMsg);
              break;
            }
            const scheduled = {
              providerSid: MessageSid,
              errorCode: ErrorCode,
              attempt: oneToOneRetry.attempt,
              runAt: oneToOneRetry.runAt.toISOString(),
            };
            // D3a/D5: a failed read or a missing/unparseable origin FAILS OPEN -
            // the retry is attempted (and promised) anyway; say which gap it
            // crossed.
            if (oneToOneRetry.failOpen === 'read_failed') {
              log.warn(
                { ...scheduled, failOpen: 'read_failed', err: oneToOneRetry.readError },
                'one-to-one 30003 retry scheduled without its checks: a conversation or contact read failed (fail open)',
              );
            } else if (oneToOneRetry.failOpen === 'no_origin') {
              log.warn(
                { ...scheduled, failOpen: 'no_origin' },
                'one-to-one 30003 retry scheduled without a window check: the message has no usable send time (fail open)',
              );
            }
            try {
              // Enqueued at EXACTLY the run time the stamp promised.
              await enqueueSendRetry(
                {
                  providerSid: MessageSid,
                  conversationId: message.conversationId,
                  attempt: oneToOneRetry.attempt,
                },
                oneToOneRetry.runAt,
              );
            } catch (enqueueErr) {
              // D7: a promise with no retry behind it is withdrawn AT ONCE -
              // retry_due_at is rewritten to an already-expired instant and the
              // row is re-emitted, so the bubble drops "will retry" and shows
              // its Retry button. The enqueue failure itself rethrows to the
              // arm's catch below, which logs today's ERROR (D9).
              try {
                await messages.annotateMessage(message.conversationId, message.tsMsgId, {
                  retryDueAt: RETRY_PROMISE_WITHDRAWN_AT,
                });
                events.emit('message.persisted', {
                  conversationId: message.conversationId,
                  tsMsgId: message.tsMsgId,
                  direction: message.direction,
                  deliveryStatus: mappedStatus,
                });
              } catch (withdrawErr) {
                // Spec section 9: the promise then stands until it expires (at
                // most the backoff plus RETRY_PROMISE_GRACE_MS).
                log.error(
                  { err: withdrawErr, providerSid: MessageSid },
                  'one-to-one 30003 retry promise NOT withdrawn after a failed enqueue - it stands until it expires',
                );
              }
              throw enqueueErr;
            }
            log.info(scheduled, 'one-to-one 30003 retry scheduled');
            break;
```

(F) The 30005/30006 arm's group-text comment (spec D11, D12). Replace the eight lines at `:3422-3429`, from `// NATIVE GROUP TEXTS ARE REACHABLE HERE. A classic status callback` through `// says so and logs ONCE per sid instead of on every redelivery.`, with:

```ts
            // NATIVE GROUP TEXTS MAY REACH THIS ARM - UNVERIFIED (retry-send-window
            // D11). Classic status callbacks were proven NOT to fire for
            // Conversations-originated sends (services/groupReceipts.ts:3-10), and
            // no build can settle whether a classic callback for a group leg
            // still lands here live, so the arm is written as if it can. IF one
            // does, it resolves to the GROUP thread, which carries NO
            // participant_phone - so the lookup below finds no contact and the
            // whole case degrades to a log line. That outcome is CORRECT (there is
            // no single member to flag: a group failure says nothing about any one
            // number), but it is a distinct situation from "we have a number and
            // no contact record", so it says so and logs ONCE per sid instead of
            // on every redelivery.
```

(G) The 21610 arm's group-text comment (spec D11, D12). Replace the three lines at `:3477-3479`, from `// NATIVE GROUP TEXTS ARE REACHABLE HERE, exactly as on the` through `// resolves to the GROUP thread, which carries no participant_phone.` (the `// RULING (invariant 13.8)` lines after them stay), with:

```ts
            // NATIVE GROUP TEXTS MAY REACH THIS ARM - UNVERIFIED (retry-send-window
            // D11), exactly as on the 30005/30006 twin above: IF a classic status
            // callback for a group leg lands here, it resolves to the GROUP
            // thread, which carries no participant_phone.
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/oneToOneRetryDecision.test.ts test/twilioStatusWebhook.test.ts test/relayRetryClaim.webhook.test.ts test/deliveryFailureSeverity.test.ts`
Expected: PASS.

- [ ] **Step 8b: Pin the plan's Review Focus cases 1, 2, 4 and 5, and run the shared refusal table through the decision**

Add to `app/test/twilioStatusWebhook.test.ts`, inside the same `describe` as the test `'30003 (transient) stamps retry_due_at IN the failure write, emits ONE SSE that already sees both, then enqueues EXACTLY ONE backed-off retry (retry-send-window D3a/D7)'` (it has `makeWebhookHarness`, `seedOutbound`, `signedTwilioPost`, `STATUS_PATH`, `statusParams` and the `outbound` queue in scope):

```ts
    it('Review Focus 1: a 30003 failure that arrives AFTER the text was delivered stamps nothing, enqueues nothing and logs no decision', async () => {
      const { app, world, capture } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      await signedTwilioPost(app, STATUS_PATH, statusParams({ MessageStatus: 'delivered' }));

      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' }),
      );
      expect(res.status).toBe(200);

      const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
      expect(row.delivery_status).toBe('delivered');
      expect(row.retry_due_at).toBeUndefined();
      expect(outbound.delayed).toHaveLength(0);
      expect(
        capture.lines.some(
          (l) =>
            l['retryDecision'] !== undefined ||
            l['failOpen'] !== undefined ||
            l['msg'] === 'one-to-one 30003 retry scheduled',
        ),
      ).toBe(false);
    });

    it('Review Focus 2: two deliveries of the same 30003 callback processed concurrently stamp once and enqueue exactly one retry', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');
      const params = statusParams({ MessageStatus: 'undelivered', ErrorCode: '30003' });

      const [first, second] = await Promise.all([
        signedTwilioPost(app, STATUS_PATH, params),
        signedTwilioPost(app, STATUS_PATH, params),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);

      const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
      expect(row.delivery_status).toBe('undelivered');
      expect(row.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
    });

    it('Review Focus 5: a 30003 reported as failed (not undelivered) is decided, stamped and retried the same way', async () => {
      const { app, world } = makeWebhookHarness();
      await seedOutbound(world, 'SMout0001');

      const res = await signedTwilioPost(
        app,
        STATUS_PATH,
        statusParams({ MessageStatus: 'failed', ErrorCode: '30003' }),
      );
      expect(res.status).toBe(200);

      const row = (await world.messagesRepo.getByProviderSid('SMout0001'))!;
      expect(row.delivery_status).toBe('failed');
      expect(row.retry_due_at).toBeDefined();
      expect(outbound.delayed).toHaveLength(1);
    });
```

Add to `app/test/oneToOneRetryDecision.test.ts`, inside its top-level `describe`:

```ts
  it('Review Focus 4: a text a staff member re-sent with the manual Retry is retried from a FRESH window, as a person's send, even on a manual-mode thread', async () => {
    // The manual Retry route's row: retry_of set, no retry_attempt and no
    // retry_window_start (spec D2: a human chose to send now), automated false.
    const manualRetry = failed({ retry_of: '2026-09-25T09:00:00.000Z#SMorig01', automated: false });
    expect(
      await decide(manualRetry, {
        conversation: thread({ ai_mode: 'manual' }),
        phoneContact: contact(),
      }),
    ).toEqual(retryAt(1));
  });
```

Also add to `app/test/oneToOneRetryDecision.test.ts` the parity run over the ONE shared table (spec test intention 4, "one table drives both tests"): add `import { SEND_REFUSAL_CASES } from './helpers/sendRefusalCases.js';` beside the file's other imports, and inside its top-level `describe`:

```ts
  // retry-send-window D3a: the SAME table the preview/send-path parity test runs
  // (test/sendMessage.test.ts), through the decision: every row the send path
  // refuses, the decision declines with the same code; every row it sends, the
  // decision retries.
  it.each(SEND_REFUSAL_CASES)('parity with the send path: $name', async (c) => {
    const message = failed({
      automated: c.automated,
      ...(c.recipient !== undefined && { recipient_contact_id: c.recipient.contactId }),
    });
    const verdict = await decide(message, {
      conversation: thread({
        ai_mode: c.conversation.ai_mode,
        ...(c.conversation.sms_opt_out !== undefined && { sms_opt_out: c.conversation.sms_opt_out }),
      }),
      ...(c.phoneContact !== undefined && { phoneContact: c.phoneContact }),
      ...(c.recipient !== undefined && { byId: { [c.recipient.contactId]: c.recipient } }),
      smsSendingEnabled: c.smsSendingEnabled,
    });
    if (c.expected === undefined) expect(verdict).toEqual(retryAt(1));
    else expect(verdict).toEqual(declined(c.expected, 'warn'));
  });
```

Run: `cd app; npx vitest run test/oneToOneRetryDecision.test.ts test/twilioStatusWebhook.test.ts`
Expected: PASS. The parity rows pass because the decision calls `previewSendRefusal` with the row's own inputs (Task 7's parity test pins the preview to the send path). Each other case pins behavior Steps 3 and 7 already deliver: case 1 through the forward-only write (`allowedPriorStatuses`: `undelivered` follows only `queued` or `sent`), case 2 through the transition gate, case 4 through D2 and D14, case 5 through the decision's two-status trigger. Each fails if its guard regresses.

- [ ] **Step 9: Typecheck, ASCII check and commit**

```bash
npm run typecheck
tr -d '\11\12\15\40-\176' < app/src/services/oneToOneRetryDecision.ts | wc -c
tr -d '\11\12\15\40-\176' < app/test/oneToOneRetryDecision.test.ts | wc -c
git diff -U0 -- app/src/routes/webhooks/twilio.ts app/test/twilioStatusWebhook.test.ts | awk '/^\+/ && /[^\x01-\x7e]/' | wc -l
git status
git add app/src/services/oneToOneRetryDecision.ts app/test/oneToOneRetryDecision.test.ts app/src/routes/webhooks/twilio.ts app/test/twilioStatusWebhook.test.ts
git commit -m "feat(retry-send-window): the one-to-one 30003 retry is decided before the failure is written (spec D3a, D7, D9, D11, D12)

decideOneToOneRetry judges group_text, the channel, the send path's own
refusals for the ORIGINAL's automated flag and recorded recipient, the cap
and the 15-minute window. A retry verdict rides the failure's conditional
write as retry_due_at and is enqueued at exactly that run time on the
transition; a failed enqueue withdraws the promise at once. Native group
texts schedule no retry. The 30003 carve-out comments say what now holds,
and the status-webhook fixtures send at realistic times.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/services/oneToOneRetryDecision.ts app/test/oneToOneRetryDecision.test.ts app/src/routes/webhooks/twilio.ts app/test/twilioStatusWebhook.test.ts
```

Expected: typecheck exit 0; the three ASCII counts print `0`.

---

### Task 11: The one-to-one retry job checks the window and follows the original send (spec D4, D5, D6, D12, D14)

**Files:**
- Modify: `app/src/jobs/retrySend.ts` - the header comment (`:9-10`); imports (`:11-25`); `RetrySendJobDeps` (`:79-90`); `registerRetrySendJobHandler` (`:93-239`): the lazy deps (`:96-97`), a recipient read between the not-outbound refusal (`:117-120`) and the execution-guard comment (`:122`), a window check between the guard (`:129-146`) and the presign comment (`:148`), the send (`:196-207`), the post-send annotate removed (`:221-229`). Lines at HEAD `fd38ba73`; Task 9 edits `:36-77` first and shifts them - anchor on the quoted text.
- Test (modify): `app/test/twilioStatusWebhook.test.ts` - imports (`:26`, `:30`); new tests at the end of the `messaging.retrySend job (worker side)` describe (after the test `'a missing original message WARNs and does nothing'`, `:1119-1142`).
- No change: `app/src/jobs/registerHandlers.ts:47` (`registerRetrySendJobHandler()` with no deps) - both new deps are optional with lazy defaults.

**Interfaces:**
- Consumes:
  - Task 1: `parseRetryWindowOrigin(value: unknown): number | undefined`; `withinRetrySendWindow(args: { originMs: number; nowMs: number }): boolean` (strict, D4).
  - Task 2: `MessageItem.retry_window_start?: string`, `.automated?: boolean`, `.recipient_contact_id?: string`; the harness fake `append` carrying `retryAttempt`, `retryWindowStart`, `automated`, `recipientContactId`.
  - Task 8: `SendMessageInput.retryAttempt?: number`, `SendMessageInput.retryWindowStart?: string` (`retryOf?: string` and `recipient?: ContactItem` exist); the append writes `retry_of`, `retry_attempt`, `retry_window_start`, `automated` (always) and `recipient_contact_id` (when a recipient is passed).
- Produces: `RetrySendJobDeps` gains `contactsRepo?: ContactsRepo` and `now?: () => number` (additive, job-internal). The handler: reads the recorded recipient BEFORE the execution marker (a throw fails the delivery, so SQS redelivers); after the marker the strict window check (origin = `retry_window_start ?? provider_ts`; missing -> WARN `retrySend: no usable window origin - sending without a window check (fail open)` and continue; closed -> ERROR `retrySend: retry window closed - retry chain ended without sending` with `retryDecision: 'window_closed'`, end); sends with `automated: original.automated ?? true`, `recipient` (when resolved), `retryOf: original.tsMsgId`, `retryAttempt: payload.attempt`, `retryWindowStart: original.retry_window_start ?? original.provider_ts`; NO post-send annotate. A recorded recipient that resolves to nothing: WARN `retrySend: recorded recipient no longer exists - retrying to the phone-matched contact`, no recipient passed.

- [ ] **Step 1: Write the failing job tests (spec D4, D5, D6, D14; test intention 5)**

In `app/test/twilioStatusWebhook.test.ts`, change the logger import (`:26`) and the send-service import (`:30`) to:

```ts
import { createLogger, type Logger } from '../src/lib/logger.js';
```

```ts
import {
  createSendMessageService,
  type SendMessageInput,
  type SendMessageService,
} from '../src/services/sendMessage.js';
```

Then append, inside the `messaging.retrySend job (worker side)` describe, after the test `'a missing original message WARNs and does nothing'`:

```ts
  // ---------------------------------------------------------------------------
  // retry-send-window (plan Task 11): the job's window check (D4), the lineage
  // written WITH the row (D6) and the retry that follows the original send
  // (D14). These enqueue the job DIRECTLY - no webhook - so the job's own gates
  // are under test. The job's clock is injected (spec D13) and every send time
  // is pinned relative to it.
  // ---------------------------------------------------------------------------
  const JOB_NOW = Date.parse('2026-09-25T15:00:00.000Z');
  const jobIso = (ms: number): string => new Date(ms).toISOString();

  function wireJobs(): {
    outbound: InProcessOutboundQueueAdapter;
    capture: LogCapture;
    logger: Logger;
  } {
    const outbound = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(outbound);
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    configureJobsLogger(logger);
    return { outbound, capture, logger };
  }

  /** A spy send service: records every input and answers a fake outcome. */
  function spySend(calls: SendMessageInput[]): SendMessageService {
    return async (input) => {
      calls.push(input);
      return {
        conversationId: input.conversationId,
        providerSid: `SMretry${calls.length}`,
        tsMsgId: `${jobIso(JOB_NOW)}#SMretry${calls.length}`,
        status: 'queued',
      };
    };
  }

  /** The REAL send service over the world fakes - the append path is under test. */
  function realSend(world: FakeWorld, logger: Logger): SendMessageService {
    return createSendMessageService({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: ORIGIN_SECRET, MESSAGING_DRIVER: 'console' }),
      logger,
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
    });
  }

  it('retry-send-window D4: past the 15-minute window the job ends the chain WITHOUT sending (ERROR naming window_closed)', async () => {
    const { outbound, capture, logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMlate01', { provider_ts: jobIso(JOB_NOW - 16 * 60_000) });
    const calls: SendMessageInput[] = [];
    registerRetrySendJobHandler({
      sendMessage: spySend(calls),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMlate01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(calls).toHaveLength(0);
    const closed = capture.atLevel(ERROR).filter((l) => l['retryDecision'] === 'window_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]!['msg']).toBe('retrySend: retry window closed - retry chain ended without sending');
    // The check sits AFTER the execution marker (D4): a redelivery ends there.
    expect(world.jobExecutionMarkers.size).toBe(1);
  });

  it('retry-send-window D2/D4: attempt 2 measures from the CHAIN origin (retry_window_start), not the row own send time', async () => {
    const { outbound, logger } = wireJobs();
    const world = createFakeWorld();
    // A retry row sent 30 seconds ago whose chain began 16 minutes ago.
    const seeded = await seedOutbound(world, 'SMchain01', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      retry_attempt: 1,
      retry_window_start: jobIso(JOB_NOW - 16 * 60_000),
    });
    const calls: SendMessageInput[] = [];
    registerRetrySendJobHandler({
      sendMessage: spySend(calls),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMchain01', conversationId: seeded.conversationId, attempt: 2 });
    await outbound.settle();

    expect(calls).toHaveLength(0);
  });

  it('retry-send-window D5: a row with no usable origin WARNs and still sends (fail open), passing no retry_window_start', async () => {
    const { outbound, capture, logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMnots01', { provider_ts: jobIso(JOB_NOW - 30_000) });
    delete (seeded as { provider_ts?: string }).provider_ts;
    const calls: SendMessageInput[] = [];
    registerRetrySendJobHandler({
      sendMessage: spySend(calls),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMnots01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('retryWindowStart');
    expect(
      capture
        .atLevel(WARN)
        .filter((l) => l['msg'] === 'retrySend: no usable window origin - sending without a window check (fail open)'),
    ).toHaveLength(1);
  });

  it('retry-send-window D14 + D6: a row with NO automated flag (sent before this deploy) is re-sent automated with no recipient, its lineage passed INTO the send', async () => {
    const { outbound, logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMlegacy01', { provider_ts: jobIso(JOB_NOW - 30_000) });
    const calls: SendMessageInput[] = [];
    registerRetrySendJobHandler({
      sendMessage: spySend(calls),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMlegacy01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(calls).toEqual([
      {
        conversationId: seeded.conversationId,
        body: 'outbound body',
        automated: true,
        author: 'teammate',
        retryOf: seeded.tsMsgId,
        retryAttempt: 1,
        retryWindowStart: seeded.provider_ts,
      },
    ]);
  });

  it('retry-send-window D14: a recorded recipient that no longer exists WARNs and falls back to the phone lookup - no recipient passed', async () => {
    const { outbound, capture, logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMgone01', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      automated: false,
      recipient_contact_id: 'c-gone',
    });
    const calls: SendMessageInput[] = [];
    registerRetrySendJobHandler({
      sendMessage: spySend(calls),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMgone01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('recipient');
    expect(calls[0]?.automated).toBe(false);
    const warn = capture
      .atLevel(WARN)
      .find((l) => l['msg'] === 'retrySend: recorded recipient no longer exists - retrying to the phone-matched contact');
    expect(warn?.['recipientContactId']).toBe('c-gone');
  });

  it('retry-send-window D14: a THROWING recipient read fails the delivery BEFORE the execution marker, so SQS redelivers it', async () => {
    const { logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMrcpt01', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      automated: false,
      recipient_contact_id: 'c-real',
    });
    world.contactsRepo.getById = async () => {
      throw new Error('recipient read exploded');
    };
    registerRetrySendJobHandler({
      sendMessage: async () => {
        throw new Error('must not be reached - the recipient read precedes the marker and the send');
      },
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });
    // A delayed enqueue records the envelope without dispatching it, so the
    // test dispatches it itself and sees the rejection.
    const envelope = await enqueue(
      RETRY_SEND_JOB,
      { providerSid: 'SMrcpt01', conversationId: seeded.conversationId, attempt: 1 },
      { runAt: new Date(Date.now() + 60_000) },
    );

    await expect(dispatchJob(JSON.parse(JSON.stringify(envelope)))).rejects.toThrow('recipient read exploded');
    expect(world.jobExecutionMarkers.size).toBe(0); // no marker: the redelivery runs the job again
    expect(world.sent).toHaveLength(0);
  });

  it("retry-send-window D14: a PERSON'S original is re-sent automated:false with its recorded recipient - not refused manual_mode, never breaker-counted", async () => {
    const { outbound, capture, logger } = wireJobs();
    const world = createFakeWorld();
    // The phone lookup finds a NO-consent duplicate first; the recorded
    // recipient is the real, consenting contact (share-skip-fix I8).
    world.contacts.push({ contactId: 'c-dup', type: 'tenant', phone: TENANT_PHONE });
    world.contacts.push({
      contactId: 'c-real',
      type: 'tenant',
      phone: TENANT_PHONE,
      consent_method: 'verbal_in_person',
    });
    const seeded = await seedOutbound(world, 'SMperson01', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      automated: false,
      recipient_contact_id: 'c-real',
    });
    world.conversations.get(seeded.conversationId)!.ai_mode = 'manual'; // the breaker tripped
    let breakerCounts = 0;
    world.conversationsRepo.incrementAutomatedSendCount = async () => {
      breakerCounts += 1;
      return 1;
    };
    registerRetrySendJobHandler({
      sendMessage: realSend(world, logger),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMperson01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(world.sent).toHaveLength(1);
    expect(breakerCounts).toBe(0);
    const retried = world.messages.find((m) => m.retry_of === seeded.tsMsgId)!;
    expect(retried).toMatchObject({ automated: false, recipient_contact_id: 'c-real' });
    const sentAudit = world.auditEvents.filter((e) => e.event_type === 'message_sent');
    expect(sentAudit).toHaveLength(1);
    expect(sentAudit[0]!.payload).toMatchObject({ automated: false });
    expect(capture.lines.some((l) => String(l['msg']).includes('send refused'))).toBe(false);
  });

  it('retry-send-window D14: an AUTOMATED original is re-sent automated and breaker-metered, with no recipient', async () => {
    const { outbound, logger } = wireJobs();
    const world = createFakeWorld();
    const seeded = await seedOutbound(world, 'SMauto01', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      automated: true,
    });
    let breakerCounts = 0;
    world.conversationsRepo.incrementAutomatedSendCount = async () => {
      breakerCounts += 1;
      return 1;
    };
    registerRetrySendJobHandler({
      sendMessage: realSend(world, logger),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMauto01', conversationId: seeded.conversationId, attempt: 1 });
    await outbound.settle();

    expect(world.sent).toHaveLength(1);
    expect(breakerCounts).toBe(1);
    const retried = world.messages.find((m) => m.retry_of === seeded.tsMsgId)!;
    expect(retried.automated).toBe(true);
    expect(retried.recipient_contact_id).toBeUndefined();
  });

  it('retry-send-window D6: the new row carries its lineage, window origin, automated flag and recipient FROM THE APPEND - nothing is annotated after the send', async () => {
    const { outbound, logger } = wireJobs();
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-real',
      type: 'tenant',
      phone: TENANT_PHONE,
      consent_method: 'verbal_in_person',
    });
    const origin = jobIso(JOB_NOW - 2 * 60_000);
    // The original is itself attempt 1 of a chain that began two minutes ago.
    const seeded = await seedOutbound(world, 'SMchain02', {
      provider_ts: jobIso(JOB_NOW - 30_000),
      retry_attempt: 1,
      retry_window_start: origin,
      automated: false,
      recipient_contact_id: 'c-real',
    });
    let annotates = 0;
    world.messagesRepo.annotateMessage = async () => {
      annotates += 1;
    };
    registerRetrySendJobHandler({
      sendMessage: realSend(world, logger),
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      now: () => JOB_NOW,
      logger,
    });

    await enqueue(RETRY_SEND_JOB, { providerSid: 'SMchain02', conversationId: seeded.conversationId, attempt: 2 });
    await outbound.settle();

    const retried = world.messages.find((m) => m.retry_of === seeded.tsMsgId)!;
    expect(retried).toMatchObject({
      retry_of: seeded.tsMsgId,
      retry_attempt: 2,
      retry_window_start: origin, // the CHAIN origin, never this row's own send (D2)
      automated: false,
      recipient_contact_id: 'c-real',
    });
    expect(annotates).toBe(0);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts`
Expected: FAIL on the new tests: the two window tests (the job sends today: `calls` has 1), the no-origin test (no WARN), the legacy-row test (the input lacks `retryOf`, `retryAttempt`, `retryWindowStart`), the gone-recipient test (`automated` is true; no WARN), the throwing-read test (the job reads no recipient, so the dispatch rejects with the send spy's message and the marker is set), the person's-original test (sent automated, refused `manual_mode`, nothing sent), and the D6 test (the job annotates once; no `retry_window_start`). The AUTOMATED-original test already passes (the job sends automated today and Task 8's append records it) and stays as a pin. Every earlier test passes.

- [ ] **Step 3: Implement (spec D4, D5, D6, D12, D14)**

All edits in `app/src/jobs/retrySend.ts`.

(a) Header comment (spec D12). Replace lines `:9-10`

```ts
// Attempt count rides the payload; the handler stamps retry_attempt onto the
// NEW message so the next 30003 callback can see how deep the chain is.
```

with:

```ts
// Attempt count rides the payload. The handler passes it into the send with
// retry_of and the chain's window origin (retry_window_start), so the NEW
// message carries all three from its append (retry-send-window D6) - the next
// 30003 callback reads retry_attempt for the cap and retry_window_start for the
// 15-minute window. The retry follows the ORIGINAL send (D14): its `automated`
// flag and its recorded recipient.
```

(b) Imports. After the `../repos/messagesRepo.js` import (`:11-16`) add:

```ts
import {
  createContactsRepo,
  type ContactItem,
  type ContactsRepo,
} from '../repos/contactsRepo.js';
```

and after `import { getContext } from '../lib/context.js';` (`:23`) add:

```ts
import { parseRetryWindowOrigin, withinRetrySendWindow } from '../lib/retrySendWindow.js';
```

(c) `RetrySendJobDeps` (`:79-90`). Replace

```ts
  mediaStore?: MediaStore;
  logger?: Logger;
}
```

with:

```ts
  mediaStore?: MediaStore;
  /**
   * retry-send-window D14: reads the recipient the original was fenced to
   * (`recipient_contact_id`), by id, BEFORE the execution marker. Built lazily,
   * and only when a row records a recipient.
   */
  contactsRepo?: ContactsRepo;
  /** The D4 window check's clock (tests pin it); Date.now by default. */
  now?: () => number;
  logger?: Logger;
}
```

(d) Lazy deps (`:96-97`). Replace

```ts
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;
```

with:

```ts
  let sendMessage = deps.sendMessage;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  const now = deps.now ?? Date.now;
```

(e) The recipient read, BEFORE the execution marker (spec D14). Insert the block below between the not-outbound refusal block (`:117-120`) and the execution-guard comment. Anchor: replace the exact text `    // Execution guard (M1.2): SQS is at-least-once` (the ASCII start of `:122`) with the block followed by that same text:

```ts
    // retry-send-window D14: the retry is judged against the contact the
    // original was fenced to (share-skip-fix I8), read by id BEFORE the
    // execution marker - a read that throws fails this delivery and SQS
    // redelivers it, instead of dropping the retry behind a marker. A recorded
    // recipient that no longer exists falls back to the phone-matched contact.
    const recipientContactId = original.recipient_contact_id;
    let recipient: ContactItem | undefined;
    if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
      contacts ??= createContactsRepo({ logger: deps.logger });
      recipient = await contacts.getById(recipientContactId);
      if (recipient === undefined) {
        log.warn(
          { providerSid: payload.providerSid, conversationId: payload.conversationId, recipientContactId },
          'retrySend: recorded recipient no longer exists - retrying to the phone-matched contact',
        );
      }
    }

    // Execution guard (M1.2): SQS is at-least-once
```

(f) The window check, AFTER the execution marker (spec D4, D5). Replace the exact line

```ts
    // PRESIGN PER ATTEMPT (design Sec 5 - the Cameron rule): a retry is a NEW
```

(`:148`) with:

```ts
    // retry-send-window D4: the strict window check, right before the send and
    // AFTER the execution marker (a redelivery of a job that ended here ends at
    // the marker). The grace was spent when the webhook scheduled this retry
    // (D3a), so nothing may go out past origin + 15 minutes. The origin is the
    // chain's FIRST send (D2): retry_window_start on a retry row, else this
    // row's own provider_ts. A missing or unparseable origin fails OPEN (D5):
    // the retry goes out unwindowed, with a WARN naming the gap.
    const windowStart = original.retry_window_start ?? original.provider_ts;
    const originMs = parseRetryWindowOrigin(windowStart);
    if (originMs === undefined) {
      log.warn(
        { providerSid: payload.providerSid, conversationId: payload.conversationId, attempt: payload.attempt },
        'retrySend: no usable window origin - sending without a window check (fail open)',
      );
    } else if (!withinRetrySendWindow({ originMs, nowMs: now() })) {
      log.error(
        {
          providerSid: payload.providerSid,
          conversationId: payload.conversationId,
          attempt: payload.attempt,
          retryDecision: 'window_closed',
        },
        'retrySend: retry window closed - retry chain ended without sending',
      );
      return;
    }

    // PRESIGN PER ATTEMPT (design Sec 5 - the Cameron rule): a retry is a NEW
```

(g) The send (spec D6, D12, D14). Replace HEAD lines `:196-207` - the four-line comment that opens `// automated: true on purpose` (it carries a pre-existing non-ASCII dash) and the `outcome = await sendMessage({` call through its closing `});` - with the block below. The `let outcome;`, `try {` above it and the `catch (err) {` refusal block after it (`:208-219`) stay byte-for-byte:

```ts
      // retry-send-window D14: the retry FOLLOWS THE ORIGINAL SEND. An automated
      // original (a reminder, the missed-call text, an automated share) is
      // retried automated and breaker-metered - a retry storm must still trip
      // the breaker. A person's original is retried as a person's send: manual
      // mode and the breaker do not apply, the consent gate does. A row with no
      // `automated` (sent before this deploy) is retried automated, as before.
      // The retried message keeps the ORIGINAL author (the retry is the same
      // logical message, not a new teammate action).
      //
      // D6: the lineage rides the APPEND - retry_of, retry_attempt and the
      // chain's window origin - so the next 30003 callback reads it from the
      // new row with no annotate-after race.
      outcome = await sendMessage({
        conversationId: payload.conversationId,
        ...(original.body !== undefined && { body: original.body }),
        ...(retryMediaUrls !== undefined && { mediaUrls: retryMediaUrls }),
        ...(retryAttachments !== undefined && { attachments: retryAttachments }),
        automated: original.automated ?? true,
        author: original.author === 'ai' ? 'ai' : 'teammate',
        ...(recipient !== undefined && { recipient }),
        retryOf: original.tsMsgId,
        retryAttempt: payload.attempt,
        ...(typeof windowStart === 'string' && { retryWindowStart: windowStart }),
      });
```

(h) Delete the post-send annotate (spec D6, D12): remove HEAD lines `:221-229` - the comment block that opens `// Lineage: the new message records what it retried and how deep the` (it carries pre-existing non-ASCII dashes) and the `await messages.annotateMessage(payload.conversationId, outcome.tsMsgId, {` call through its closing `});`. The `log.info(` block that follows (`'retrySend: message re-sent'`) stays.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/twilioStatusWebhook.test.ts test/oneToOneRetryDecision.test.ts`
Expected: PASS (the new job tests and every earlier test in both files, including the END TO END test, whose retry row now gets `retry_of` and `retry_attempt` from the append).

- [ ] **Step 5: Typecheck, ASCII check and commit**

```bash
npm run typecheck
git diff -U0 -- app/src/jobs/retrySend.ts app/test/twilioStatusWebhook.test.ts | awk '/^\+/ && /[^\x01-\x7e]/' | wc -l
git status
git add app/src/jobs/retrySend.ts app/test/twilioStatusWebhook.test.ts
git commit -m "feat(retry-send-window): the one-to-one retry job checks the window and follows the original send (spec D4, D6, D12, D14)

The job reads the recorded recipient before its execution marker, ends the
chain without sending once past origin + 15 minutes (ERROR), fails open on a
missing origin (WARN), and sends with the original's automated flag, its
recipient and the lineage (retry_of, retry_attempt, retry_window_start) at
append. The post-send annotate is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/jobs/retrySend.ts app/test/twilioStatusWebhook.test.ts
```

Expected: typecheck exit 0; the ASCII count prints `0`.

---

### Task 12: The manual Retry refuses 409 retry_pending while an automatic retry is scheduled (spec D10, D14)

**Files:**
- Modify: `app/src/routes/api.ts` - an import beside `:42`; the retry route (`:1564-1661`): the D10 check after the not-failed check (`:1589-1595`), the recorded-recipient read before the presign comment (`:1597`), the send input (`:1642-1652`).
- Test (modify): `app/test/apiRoutes.test.ts` - imports (`:1-22`), `makeRetryApp` (`:388-416`), new tests after the `not_failed` test (`:463-475`).

**Interfaces:**
- Consumes: Task 1 `isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean` (tests: `RETRY_PROMISE_GRACE_MS`, `RETRY_PROMISE_WITHDRAWN_AT`); Task 2 `MessageItem.retry_due_at?: string`, `MessageItem.recipient_contact_id?: string`; existing `SendMessageInput.recipient?: ContactItem` (share-skip-fix I8); the route's `contacts` repo (`api.ts:640`, `deps.contactsRepo ?? createContactsRepo(...)`).
- Produces: `POST /api/conversations/:conversationId/messages/:providerSid/retry` answers `409 { error: 'retry_pending' }` (the shape of the route's other refusals, `:1586`, `:1593`) after the not-failed check while `isRetryPromiseLive(original.retry_due_at, Date.now())`; passes `recipient` (read by id; an id that resolves to nothing -> none, WARN `retry: recorded recipient no longer exists - judging the phone-matched contact`); stays `automated: false`; never passes `retryWindowStart` or `retryAttempt`. Task 17 maps `retry_pending` to "A retry is already scheduled for this message."

- [ ] **Step 1: Write the failing route tests (spec D10, D14; test intention 6)**

In `app/test/apiRoutes.test.ts` add after `import { OUTBOUND_MMS_MAX_MEDIA_PER_MESSAGE } from '../src/lib/outboundMediaLimits.js';` (`:11`):

```ts
import { RETRY_PROMISE_GRACE_MS, RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
```

and after `import type { ConversationsRepo } from '../src/repos/conversationsRepo.js';` (`:20`):

```ts
import type { ContactsRepo } from '../src/repos/contactsRepo.js';
```

Replace `makeRetryApp` (`:388-416`) with (a third, optional contacts stub; the existing calls are unchanged):

```ts
  function makeRetryApp(
    original: unknown,
    mediaStore?: import('../src/adapters/mediaStore.js').MediaStore,
    contactsRepo?: Pick<ContactsRepo, 'getById'>,
  ) {
    const calls: SendMessageInput[] = [];
    const app = buildApp({
      config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        messagesRepo: {
          async getByProviderSid() {
            return original;
          },
        } as unknown as import('../src/repos/messagesRepo.js').MessagesRepo,
        ...(mediaStore !== undefined && { mediaStore }),
        // retry-send-window D14: the recorded-recipient read (by id).
        ...(contactsRepo !== undefined && { contactsRepo: contactsRepo as unknown as ContactsRepo }),
        sendMessageService: async (input) => {
          calls.push(input);
          return {
            conversationId: input.conversationId,
            providerSid: 'SMretry',
            tsMsgId: '2026-06-12T10:00:00.000Z#SMretry',
            status: 'queued',
          };
        },
      },
    });
    return { app, calls };
  }
```

Insert after the test `'409s when the original is not in a failure state (no accidental double-send)'` (`:463-475`):

```ts
  it('retry-send-window D10: 409 retry_pending while an automatic retry is scheduled - before retry_due_at and inside the grace after it', async () => {
    for (const offsetMs of [30_000, -60_000]) {
      const { app, calls } = makeRetryApp({
        ...FAILED_ORIGINAL,
        retry_due_at: new Date(Date.now() + offsetMs).toISOString(),
      });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'retry_pending' });
      expect(calls).toHaveLength(0);
    }
  });

  it('retry-send-window D10: the Retry goes through once the promise has expired, or after it was withdrawn', async () => {
    for (const due of [
      new Date(Date.now() - RETRY_PROMISE_GRACE_MS - 60_000).toISOString(),
      RETRY_PROMISE_WITHDRAWN_AT,
    ]) {
      const { app, calls } = makeRetryApp({ ...FAILED_ORIGINAL, retry_due_at: due });
      const res = await request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send();
      expect(res.status).toBe(201);
      expect(calls).toHaveLength(1);
    }
  });

  it('retry-send-window D10: the not-failed check still answers first', async () => {
    const { app, calls } = makeRetryApp({
      ...FAILED_ORIGINAL,
      delivery_status: 'delivered',
      retry_due_at: new Date(Date.now() + 30_000).toISOString(),
    });
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_failed' });
    expect(calls).toHaveLength(0);
  });

  it('retry-send-window D14: passes the RECORDED recipient (read by id), stays automated:false, and never copies retry_window_start or retry_attempt', async () => {
    const real = {
      contactId: 'c-real',
      type: 'tenant' as const,
      phone: '+15550100001',
      consent_method: 'verbal_in_person' as const,
    };
    const reads: string[] = [];
    const { app, calls } = makeRetryApp(
      {
        ...FAILED_ORIGINAL,
        recipient_contact_id: 'c-real',
        retry_window_start: '2026-06-12T08:58:00.000Z',
        retry_attempt: 2,
      },
      undefined,
      {
        async getById(contactId: string) {
          reads.push(contactId);
          return contactId === 'c-real' ? real : undefined;
        },
      },
    );
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    expect(res.status).toBe(201);
    expect(reads).toEqual(['c-real']);
    expect(calls).toEqual([
      {
        conversationId: 'conv-1',
        body: 'this failed',
        automated: false,
        author: 'teammate',
        retryOf: '2026-06-12T09:00:00.000Z#SMorig',
        recipient: real,
      },
    ]);
  });

  it('retry-send-window D14: a recorded recipient that no longer exists sends with NO recipient (the phone-matched contact is judged)', async () => {
    const { app, calls } = makeRetryApp({ ...FAILED_ORIGINAL, recipient_contact_id: 'c-gone' }, undefined, {
      async getById() {
        return undefined;
      },
    });
    const res = await request(app)
      .post('/api/conversations/conv-1/messages/SMorig/retry')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('recipient');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd app; npx vitest run test/apiRoutes.test.ts`
Expected: FAIL on the live-promise test (201, not 409) and the recorded-recipient test (no `recipient` in the input; `reads` empty). The expired/withdrawn test, the not-failed-first test and the gone-recipient test already pass and stay as pins.

- [ ] **Step 3: Implement (spec D10, D14)**

All edits in `app/src/routes/api.ts`.

(a) Add after `import { normalizeEmailAddress } from '../lib/email.js';` (`:42`):

```ts
import { isRetryPromiseLive } from '../lib/retrySendWindow.js';
```

(b) After the not-failed check. Replace

```ts
    if (original.delivery_status !== 'failed' && original.delivery_status !== 'undelivered') {
      res.status(409).json({ error: 'not_failed' });
      return;
    }
```

(`:1592-1595`) with:

```ts
    if (original.delivery_status !== 'failed' && original.delivery_status !== 'undelivered') {
      res.status(409).json({ error: 'not_failed' });
      return;
    }
    // retry-send-window D10: while an automatic 30003 retry is scheduled for
    // this message - its promise, retry_due_at plus RETRY_PROMISE_GRACE_MS, is
    // still ahead on THIS server's clock - a manual Retry would text the member
    // twice. Refuse it; the dashboard hides the button over the same window and
    // maps this code to its own sentence. An expired or withdrawn promise
    // (RETRY_PROMISE_WITHDRAWN_AT) lets the Retry through; the windows the
    // time-based guard leaves are filed as
    // manual-retry-double-send-residual-windows.
    if (isRetryPromiseLive(original.retry_due_at, Date.now())) {
      res.status(409).json({ error: 'retry_pending' });
      return;
    }
    // retry-send-window D14: a staff Retry of a property send is judged against
    // the contact the original was fenced to (share-skip-fix I8), read by id; a
    // recorded recipient that no longer exists falls back to the phone-matched
    // contact. It stays a person's send (automated: false below) and never
    // copies the original's retry_window_start: a human chose to send now (D2),
    // so this row starts a window of its own.
    const recipientContactId = original.recipient_contact_id;
    let recipient: ContactItem | undefined;
    if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
      recipient = await contacts.getById(recipientContactId);
      if (recipient === undefined) {
        log.warn(
          { conversationId, providerSid, recipientContactId },
          'retry: recorded recipient no longer exists - judging the phone-matched contact',
        );
      }
    }
```

(c) The send input. Replace

```ts
        // Lineage: the new message supersedes the failed one in the timeline.
        retryOf: original.tsMsgId,
      });
```

(`:1650-1652`) with:

```ts
        // Lineage: the new message supersedes the failed one in the timeline.
        retryOf: original.tsMsgId,
        // retry-send-window D14: the recorded recipient, when it still exists.
        ...(recipient !== undefined && { recipient }),
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/apiRoutes.test.ts test/rateLimit.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, ASCII check and commit**

```bash
npm run typecheck
git diff -U0 -- app/src/routes/api.ts app/test/apiRoutes.test.ts | awk '/^\+/ && /[^\x01-\x7e]/' | wc -l
git status
git add app/src/routes/api.ts app/test/apiRoutes.test.ts
git commit -m "feat(retry-send-window): the manual Retry refuses 409 retry_pending while an automatic retry is scheduled (spec D10, D14)

After its not-failed check the route refuses while retry_due_at plus the
grace is ahead on the server clock; an expired or withdrawn promise lets the
Retry through. The Retry is judged against the recorded recipient, stays a
person's send and never copies retry_window_start.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/routes/api.ts app/test/apiRoutes.test.ts
```

Expected: typecheck exit 0; the ASCII count prints `0`.

---

### Task 13: The contact timeline projects retry_due_at to the dashboard (spec D7, D8)

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` - the wire `TimelineMessage` (`:157-207`, after `retry_of` `:171-173`); `toTimelineMessage` (`:406-463`, after `:442`).
- Modify: `dashboard/src/api/types.ts` - `TimelineMessage` (`:2479`), after `retry_of` (`:2492-2494`), beside the other retry fields (`:2509-2515`).
- Test (modify): `app/test/contactTimeline.test.ts` - imports (`:11-38`); a new test after `'emits retry_of on a retry message so the client can collapse the superseded bubble'` (`:340-363`).

**Interfaces:**
- Consumes: Task 2 `MessageItem.retry_due_at?: string`; Task 1 `RETRY_PROMISE_WITHDRAWN_AT` (test).
- Produces: server `TimelineMessage.retry_due_at?: string` (projected verbatim when the stored value is a string, the withdrawn sentinel included); dashboard `TimelineMessage.retry_due_at?: string` - consumed by Task 14's `isRetryPromiseLive` and Task 17's bubble, Retry gate and ticker.

- [ ] **Step 1: Write the failing projection test (spec D7)**

In `app/test/contactTimeline.test.ts` add after the `presentCallState` import (`:38`):

```ts
import type { TimelineMessage as DashboardTimelineMessage } from '../../dashboard/src/api/types.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
```

Insert after the test `'emits retry_of on a retry message so the client can collapse the superseded bubble'`:

```ts
  it('retry-send-window D7: projects retry_due_at verbatim on a failed message that carries a promise, and nothing on one without', async () => {
    seedContact();
    seedConversation('conv-a', PHONE_A);
    await seedMessage('conv-a', '2026-06-16T10:00:00.000Z', 'SM-promised', {
      direction: 'outbound',
      body: 'will retry',
      deliveryStatus: 'failed',
    });
    await seedMessage('conv-a', '2026-06-16T10:01:00.000Z', 'SM-withdrawn', {
      direction: 'outbound',
      body: 'enqueue failed',
      deliveryStatus: 'failed',
    });
    await seedMessage('conv-a', '2026-06-16T10:02:00.000Z', 'SM-plain', {
      direction: 'outbound',
      body: 'declined',
      deliveryStatus: 'failed',
    });
    // retry_due_at is written by the failure's status write (or the withdrawal
    // annotate), never at append - so stamp the stored rows directly.
    const DUE = '2026-06-16T10:01:00.000Z';
    world.messages.find((m) => m.provider_sid === 'SM-promised')!.retry_due_at = DUE;
    world.messages.find((m) => m.provider_sid === 'SM-withdrawn')!.retry_due_at =
      RETRY_PROMISE_WITHDRAWN_AT;

    const res = await authedGet('/api/contacts/c-tenant/timeline');
    expect(res.status).toBe(200);
    // Typed as the DASHBOARD's TimelineMessage: `npm run typecheck` fails here
    // until the client type declares the field (this task's cross-package half).
    const items = res.body.items as DashboardTimelineMessage[];
    expect(items.find((i) => i.tsMsgId.endsWith('#SM-promised'))!.retry_due_at).toBe(DUE);
    // The withdrawn sentinel is projected as-is; the client reads it as expired.
    expect(items.find((i) => i.tsMsgId.endsWith('#SM-withdrawn'))!.retry_due_at).toBe(
      RETRY_PROMISE_WITHDRAWN_AT,
    );
    expect(items.find((i) => i.tsMsgId.endsWith('#SM-plain'))!).not.toHaveProperty('retry_due_at');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/contactTimeline.test.ts`
Expected: FAIL on the new test: `retry_due_at` is `undefined` on the promised and the withdrawn rows (the projection drops it). `npm run typecheck` also fails there: `Property 'retry_due_at' does not exist on type 'TimelineMessage'`.

- [ ] **Step 3: Implement (spec D7)**

(a) `app/src/routes/contactTimeline.ts`, the wire `TimelineMessage`. Replace

```ts
  retry_of?: string;
  fromPhone?: string;
```

(`:173-174`) with:

```ts
  retry_of?: string;
  /** retry-send-window D7: the run time of the automatic one-to-one 30003
   *  retry this FAILED message waits on, written in the same conditional write
   *  as the failure (see MessageItem.retry_due_at). The client promises "will
   *  retry" and hides Retry only while it is live on the server's clock; the
   *  manual Retry route's D10 guard reads the same field. Absent when no retry
   *  was scheduled. */
  retry_due_at?: string;
  fromPhone?: string;
```

(b) `toTimelineMessage`. Replace

```ts
    ...(m.retry_of !== undefined && { retry_of: m.retry_of }),
```

(`:442`) with:

```ts
    ...(m.retry_of !== undefined && { retry_of: m.retry_of }),
    // retry-send-window D7/D8: projected verbatim, the withdrawn sentinel
    // (1970-01-01) included - the client reads that as an expired promise.
    ...(typeof m.retry_due_at === 'string' && { retry_due_at: m.retry_due_at }),
```

(c) `dashboard/src/api/types.ts`, `TimelineMessage`. Replace

```ts
  retry_of?: string;
  // --- Relay 30003 retry lineage (spec D11/D17) -----------------------------
```

(`:2494-2495`) with:

```ts
  retry_of?: string;
  /** retry-send-window D7/D8: the run time of the automatic one-to-one 30003
   *  retry this FAILED message is waiting on - written with the failure, so the
   *  bubble learns "will retry" at once. The promise is live only while the
   *  SERVER clock is before this plus RETRY_PROMISE_GRACE_MS
   *  (routes/contact/retryPromise.ts); a failed enqueue rewrites it to
   *  1970-01-01T00:00:00.000Z (already expired). Absent when no retry was
   *  scheduled (declined, exhausted, a relay or group row). */
  retry_due_at?: string;
  // --- Relay 30003 retry lineage (spec D11/D17) -----------------------------
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/contactTimeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, ASCII check and commit**

```bash
npm run typecheck
git diff -U0 -- app/src/routes/contactTimeline.ts dashboard/src/api/types.ts app/test/contactTimeline.test.ts | awk '/^\+/ && /[^\x01-\x7e]/' | wc -l
git status
git add app/src/routes/contactTimeline.ts dashboard/src/api/types.ts app/test/contactTimeline.test.ts
git commit -m "feat(retry-send-window): the contact timeline projects retry_due_at (spec D7)

The server wire TimelineMessage and the dashboard TimelineMessage gain
retry_due_at, projected verbatim (the withdrawn sentinel included), so the
one-to-one bubble can show the promise with the failure.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- app/src/routes/contactTimeline.ts dashboard/src/api/types.ts app/test/contactTimeline.test.ts
```

Expected: typecheck exit 0 (the Step 1 type error is gone); the ASCII count prints `0`.

### Task 14: Server-clock estimate and the retry-promise predicate (spec D8, D10)

**Files:**
- Create: `dashboard/src/api/serverClock.ts`
- Create: `dashboard/src/api/serverClock.test.ts`
- Modify: `dashboard/src/api/client.ts:7-8` (import), `:118` (note the `Date` header before `parseBody`, inside `requestWithStatus` `:92-123`)
- Create: `dashboard/src/routes/contact/retryPromise.ts`
- Create: `dashboard/src/routes/contact/retryPromise.test.ts`
- Create: `dashboard/src/routes/contact/retryPromiseMirror.test.ts` (precedent: `dashboard/src/routes/contact/mediaTypeMirror.test.ts:1-62`)

**Interfaces:**
- Consumes (Task 1, `app/src/lib/retrySendWindow.ts`), read ONLY by the mirror test - the dashboard cannot import app code at runtime:
  - `export const RETRY_PROMISE_GRACE_MS = 2 * 60_000;`
  - `export const RETRY_PROMISE_WITHDRAWN_AT = '1970-01-01T00:00:00.000Z';`
  - `export function isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean;`
- Produces (exact contract):
  - `dashboard/src/api/serverClock.ts`:
    - `export function noteServerDate(dateHeader: string | null, receivedAtMs?: number): void;`
    - `export function serverNowMs(): number;` - `Date.now()` plus the latest offset (0 before any response).
    - `export function resetServerClockForTests(): void;`
  - `dashboard/src/api/client.ts` `requestWithStatus`: calls `noteServerDate(res.headers.get('Date'))` on EVERY response, ok or not, BEFORE `parseBody`.
  - `dashboard/src/routes/contact/retryPromise.ts`:
    - `export const RETRY_PROMISE_GRACE_MS = 120_000;` (mirror of the app constant, pinned by the mirror test)
    - `export function isRetryPromiseLive(retryDueAt: string | undefined, serverNowMs: number): boolean;`

- [ ] **Step 1: Write the failing server-clock tests (spec D8)**

Create `dashboard/src/api/serverClock.test.ts`. `src/test/setup.ts` pins `Date` with a bare `vi.setSystemTime` (no fake timers), so each test moves that pin to a whole second of its own: an HTTP date has one-second resolution, and only an aligned instant round-trips through a header exactly.

```ts
// The server-clock estimate (retry-send-window spec D8). The one-to-one retry
// promise is judged on the SERVER's clock, so a skewed browser clock cannot
// change how long it shows. The estimate is the latest API response's `Date`
// header against the browser instant that response arrived.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';
import { noteServerDate, resetServerClockForTests, serverNowMs } from './serverClock.js';

/** A whole second, so a header built from it parses back to exactly it. */
const BROWSER_NOW = Date.parse('2026-09-25T20:42:07.000Z');
const TEN_MINUTES = 10 * 60 * 1000;

/** An IMF-fixdate, the exact shape Node writes into a response's `Date`. */
const httpDate = (ms: number): string => new Date(ms).toUTCString();

beforeEach(() => {
  vi.setSystemTime(BROWSER_NOW);
  resetServerClockForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetServerClockForTests();
});

describe('serverClock - the estimate', () => {
  it('reads the browser clock before any response has been seen', () => {
    expect(serverNowMs()).toBe(BROWSER_NOW);
  });

  it('corrects a browser clock running 10 minutes FAST, and keeps correcting as time passes', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
    vi.setSystemTime(BROWSER_NOW + 5_000);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES + 5_000);
  });

  it('corrects a browser clock running 10 minutes SLOW', () => {
    noteServerDate(httpDate(BROWSER_NOW + TEN_MINUTES), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES);
    vi.setSystemTime(BROWSER_NOW + 5_000);
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES + 5_000);
  });

  it('takes the receipt instant from the browser clock when none is passed', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES));
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('lets the LATEST response win', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(httpDate(BROWSER_NOW + 30_000), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW + 30_000);
  });

  it('reads an in-step server at most one second BEHIND and never ahead - the header drops the milliseconds', () => {
    // The server stamped 20:42:07.900 as "20:42:07"; the browser, in step,
    // received it at .900. The estimate lags by the lost fraction only.
    const receivedAt = BROWSER_NOW + 900;
    vi.setSystemTime(receivedAt);
    expect(httpDate(receivedAt)).toBe(httpDate(BROWSER_NOW));
    noteServerDate(httpDate(receivedAt), receivedAt);
    expect(serverNowMs()).toBe(BROWSER_NOW);
    expect(receivedAt - serverNowMs()).toBeGreaterThanOrEqual(0);
    expect(receivedAt - serverNowMs()).toBeLessThan(1000);
  });

  it('ignores a MISSING header - the previous estimate stands', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(null, BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it.each(['', 'not a date'])('ignores a GARBAGE header %j - the previous estimate stands', (garbage) => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(garbage, BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('resets to the browser clock', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    resetServerClockForTests();
    expect(serverNowMs()).toBe(BROWSER_NOW);
  });
});

describe('requestWithStatus notes the server clock on EVERY response', () => {
  it('a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', date: httpDate(BROWSER_NOW - TEN_MINUTES) },
      }),
    );
    await expect(request('/api/clock-contract')).resolves.toEqual({ ok: true });
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('a REFUSED response too - the estimate is taken before the ApiError is thrown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'retry_pending' }), {
        status: 409,
        headers: { 'content-type': 'application/json', date: httpDate(BROWSER_NOW + TEN_MINUTES) },
      }),
    );
    const err: unknown = await request('/api/clock-contract', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'retry_pending' });
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES);
  });

  it('BEFORE the body is parsed, so the items a response carries are judged against the clock it brought', async () => {
    let seenWhileParsing: number | undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', date: httpDate(BROWSER_NOW - TEN_MINUTES) }),
      json: async () => {
        seenWhileParsing = serverNowMs();
        return { ok: true };
      },
    } as unknown as Response);
    await request('/api/clock-contract');
    expect(seenWhileParsing).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('a response with NO Date header leaves the estimate alone', async () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await request('/api/clock-contract');
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });
});
```

- [ ] **Step 2: Write the failing retry-promise tests and the mirror drift guard (spec D8, D10)**

Create `dashboard/src/routes/contact/retryPromise.test.ts`:

```ts
// The screen's retry promise (retry-send-window D8, D10): live from before the
// retry is due until RETRY_PROMISE_GRACE_MS after it, on the SERVER's clock -
// never from a missing, unparseable or withdrawn stamp.
import { describe, expect, it } from 'vitest';
import { isRetryPromiseLive, RETRY_PROMISE_GRACE_MS } from './retryPromise.js';

const DUE = '2026-09-25T20:42:00.000Z';
const DUE_MS = Date.parse(DUE);

describe('isRetryPromiseLive', () => {
  it('is live before and after the retry is due, until the grace runs out - exclusive at the edge', () => {
    expect(isRetryPromiseLive(DUE, DUE_MS - 60_000)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS + RETRY_PROMISE_GRACE_MS - 1)).toBe(true);
    expect(isRetryPromiseLive(DUE, DUE_MS + RETRY_PROMISE_GRACE_MS)).toBe(false);
    expect(isRetryPromiseLive(DUE, DUE_MS + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('grants two minutes of grace', () => {
    expect(RETRY_PROMISE_GRACE_MS).toBe(2 * 60 * 1000);
  });

  it('is never live without a parseable stamp', () => {
    expect(isRetryPromiseLive(undefined, DUE_MS)).toBe(false);
    expect(isRetryPromiseLive('', DUE_MS)).toBe(false);
    expect(isRetryPromiseLive('not a time', DUE_MS)).toBe(false);
  });

  it('reads the WITHDRAWN stamp - the epoch a failed enqueue writes (D7) - as long expired', () => {
    expect(isRetryPromiseLive('1970-01-01T00:00:00.000Z', DUE_MS)).toBe(false);
  });
});
```

Create `dashboard/src/routes/contact/retryPromiseMirror.test.ts`:

```ts
// Cross-workspace RETRY-PROMISE MIRROR DRIFT GUARD (retry-send-window D10).
//
// dashboard/src/routes/contact/retryPromise.ts HAND-COPIES the promise's grace
// from app/src/lib/retrySendWindow.ts: the dashboard is a separate package and
// cannot import app code at runtime. The two copies answer ONE question - is an
// automatic retry of this message still scheduled? - on the two sides of a 409:
// the screen hides the Retry button while its answer is yes, and the manual
// Retry route refuses with `retry_pending` while the server's answer is yes. If
// they drift, a shorter screen grace offers a Retry the server refuses, and a
// longer one hides a Retry the server would accept.
//
// MECHANISM and DIRECTION: the same as mediaTypeMirror.test.ts - import both
// copies and compare RESOLVED values and answers, from the dashboard side,
// because the app module is a near-leaf and the app's test tsconfig has no
// `jsx` option to take the traffic the other way.
import { describe, expect, it } from 'vitest';
import {
  isRetryPromiseLive as appIsRetryPromiseLive,
  RETRY_PROMISE_GRACE_MS as APP_RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
} from '../../../../app/src/lib/retrySendWindow.js';
import { isRetryPromiseLive, RETRY_PROMISE_GRACE_MS } from './retryPromise.js';

const DUE = '2026-09-25T20:42:00.000Z';
const DUE_MS = Date.parse(DUE);

/** One table, both predicates: [stamp, reading clock]. */
const CASES: Array<[string | undefined, number]> = [
  [DUE, DUE_MS - 60_000],
  [DUE, DUE_MS],
  [DUE, DUE_MS + APP_RETRY_PROMISE_GRACE_MS - 1],
  [DUE, DUE_MS + APP_RETRY_PROMISE_GRACE_MS],
  [DUE, DUE_MS + 24 * 60 * 60 * 1000],
  [undefined, DUE_MS],
  ['', DUE_MS],
  ['not a time', DUE_MS],
  [RETRY_PROMISE_WITHDRAWN_AT, DUE_MS],
];

describe('dashboard retry promise mirrors app/src/lib/retrySendWindow.ts', () => {
  it('the grace is the SAME value on both sides', () => {
    expect(RETRY_PROMISE_GRACE_MS).toBe(APP_RETRY_PROMISE_GRACE_MS);
  });

  it('the screen and the 409 guard give the SAME answer for every case', () => {
    for (const [stamp, nowMs] of CASES) {
      expect(isRetryPromiseLive(stamp, nowMs), `${String(stamp)} read at ${String(nowMs)}`).toBe(
        appIsRetryPromiseLive(stamp, nowMs),
      );
    }
  });

  it('does not compare two vacuous answers', () => {
    // The floor that stops the assertions above passing if an import ever
    // resolves to nothing, or every case collapses to one answer.
    expect(APP_RETRY_PROMISE_GRACE_MS).toBeGreaterThan(0);
    const answers = CASES.map(([stamp, nowMs]) => appIsRetryPromiseLive(stamp, nowMs));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd dashboard; npx vitest run src/api/serverClock.test.ts src/routes/contact/retryPromise.test.ts src/routes/contact/retryPromiseMirror.test.ts`
Expected: FAIL - all three files fail to load: `Failed to resolve import "./serverClock.js"` and `Failed to resolve import "./retryPromise.js"`. (The mirror test's app import resolves: Task 1 has landed.)

- [ ] **Step 4: Implement the server clock (spec D8)**

Create `dashboard/src/api/serverClock.ts`:

```ts
// The SERVER's clock, estimated in the browser (retry-send-window spec D8).
//
// A one-to-one bubble promises "will retry" only while its `retry_due_at` plus
// RETRY_PROMISE_GRACE_MS lies ahead on the SERVER's clock - the clock that wrote
// the stamp, and the one the manual Retry route's 409 guard reads. Judged on the
// browser's clock instead, a browser running fast drops the promise early (and
// offers a Retry the server refuses) and one running slow keeps it up for as
// long as the skew. So every API response through `requestWithStatus`
// (client.ts) re-estimates the server's clock from its `Date` header, and the
// promise reads `serverNowMs()`.
//
// WHY THE HEADER IS FRESH. Every /api response is uncached end to end: the
// CloudFront behavior for /api/* runs the managed CachingDisabled policy
// (infra/modules/cloudfront/main.tf), the app sends no Cache-Control and no
// Last-Modified on API JSON, so a browser never serves one as heuristically
// fresh, and a revalidated 304 carries a new `Date` that replaces the stored
// one. The only `max-age` API routes (call recordings, MMS media) are element
// sources, never fetched through the API client, and the service worker
// (public/sw.js) intercepts no fetch.
//
// THE ERROR. The header has one-second resolution (the server drops the
// milliseconds) and is stamped before the response travels, so the estimate
// lags the true server clock by under a second plus the one-way trip - it never
// runs ahead. The promise shows at most that much longer, and the Retry button
// never returns before the server would accept the press.
//
// One estimate per page, as module state; `resetServerClockForTests` exists for
// test isolation only.

/** The latest (server - browser) clock offset, ms. Zero until a response is seen. */
let offsetMs = 0;

/**
 * Re-estimate the server's clock from one response's `Date` header, received at
 * `receivedAtMs` on the browser's clock (default: now). A missing or unparseable
 * header changes nothing - the previous estimate stands.
 */
export function noteServerDate(dateHeader: string | null, receivedAtMs: number = Date.now()): void {
  if (dateHeader === null) return;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAtMs)) return;
  offsetMs = serverMs - receivedAtMs;
}

/** The server's clock now: the browser clock plus the latest offset - the plain
 *  browser clock before any response has been seen. */
export function serverNowMs(): number {
  return Date.now() + offsetMs;
}

/** Test isolation only: forget every response seen so far. */
export function resetServerClockForTests(): void {
  offsetMs = 0;
}
```

In `dashboard/src/api/client.ts`, insert the import between the header comment (`:1-6`) and the `ApiError` docblock (`:8`, the line that opens with ``/** A failed API call.``):

```ts
import { noteServerDate } from './serverClock.js';

```

Then in `requestWithStatus`, replace the single line (`:118`):

```ts
  const parsed = await parseBody(res);
```

with:

```ts
  // retry-send-window D8: EVERY response - ok or not, JSON or not - re-estimates
  // the server's clock from its `Date` header, and does so BEFORE the body is
  // parsed, so the items this response carries are judged against the clock it
  // brought (see serverClock.ts for why the header is fresh). A network failure
  // has no response and changes nothing.
  noteServerDate(res.headers.get('Date'));
  const parsed = await parseBody(res);
```

- [ ] **Step 5: Implement the promise predicate (spec D8, D10)**

Create `dashboard/src/routes/contact/retryPromise.ts`:

```ts
// The one-to-one retry PROMISE, as the screen judges it (retry-send-window D8,
// D10). A failed one-to-one message promises "will retry" only while it carries
// a live `retry_due_at` - the run time of the automatic retry the webhook
// scheduled, written in the same conditional write as the failure (D7) - never
// from the retry count. The Retry button is hidden for exactly as long, and the
// manual Retry route refuses with 409 `retry_pending` over the same window on
// the server's clock (`isRetryPromiseLive` in app/src/lib/retrySendWindow.ts).

/**
 * MIRROR of RETRY_PROMISE_GRACE_MS in app/src/lib/retrySendWindow.ts - the
 * dashboard is a separate package and cannot import app code at runtime.
 * Pinned by retryPromiseMirror.test.ts. The grace covers a retry job that runs
 * a little late: a retry due at T still counts as scheduled until T + 2 minutes,
 * after which the promise drops and Retry returns.
 */
export const RETRY_PROMISE_GRACE_MS = 120_000;

/**
 * Is the promise live at `serverNowMs` - the SERVER's clock (`serverNowMs()` in
 * api/serverClock.ts), never the browser's? True while `serverNowMs` is before
 * `retry_due_at + RETRY_PROMISE_GRACE_MS`; false for an absent or unparseable
 * stamp, and for the epoch stamp an enqueue failure writes to withdraw a
 * promise (D7). The app's twin answers the same question the same way; the
 * mirror test runs one table through both.
 */
export function isRetryPromiseLive(retryDueAt: string | undefined, serverNowMs: number): boolean {
  if (retryDueAt === undefined) return false;
  const dueMs = Date.parse(retryDueAt);
  if (!Number.isFinite(dueMs)) return false;
  return serverNowMs < dueMs + RETRY_PROMISE_GRACE_MS;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd dashboard; npx vitest run src/api src/routes/contact/retryPromise.test.ts src/routes/contact/retryPromiseMirror.test.ts`
Expected: PASS - including the two existing client suites (`client.maintenance.test.ts`, `mmsMedia.client.test.ts`): their fetch doubles carry a `headers` object with no `date`, so `res.headers.get('Date')` is null and changes nothing.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
npm run typecheck
npx eslint dashboard/src/api/serverClock.ts dashboard/src/api/serverClock.test.ts dashboard/src/api/client.ts dashboard/src/routes/contact/retryPromise.ts dashboard/src/routes/contact/retryPromise.test.ts dashboard/src/routes/contact/retryPromiseMirror.test.ts
git status
git add dashboard/src/api/serverClock.ts dashboard/src/api/serverClock.test.ts dashboard/src/api/client.ts dashboard/src/routes/contact/retryPromise.ts dashboard/src/routes/contact/retryPromise.test.ts dashboard/src/routes/contact/retryPromiseMirror.test.ts
git commit -m "feat(dashboard): estimate the server clock and judge the retry promise on it (retry-send-window D8, D10)

Every API response re-estimates the server clock from its Date header,
before the body is parsed, ok or not. The one-to-one retry promise is live
while retry_due_at plus a two-minute grace lies ahead on that clock; the
grace mirrors the app constant and a drift test runs one table through both
predicates.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- dashboard/src/api/serverClock.ts dashboard/src/api/serverClock.test.ts dashboard/src/api/client.ts dashboard/src/routes/contact/retryPromise.ts dashboard/src/routes/contact/retryPromise.test.ts dashboard/src/routes/contact/retryPromiseMirror.test.ts
```

Expected: typecheck exit 0; eslint reports no error on any line this task added.

---

### Task 15: `deliveryReason` promises a retry only when one is scheduled (spec D8, D11, D12)

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts:778` (base 30003 entry), `:818` (new `RETRY_SCHEDULED_REASONS` after the MMS map), `:820-858` (relay map docblock), `:863-876` (`DeliveryReasonOptions`), `:934` (new `INTERNAL_CODE_REASONS` entry), `:990-1004` (order comment and chain in `deliveryReason`)
- Test: `dashboard/src/routes/contact/deliveryStatus.test.ts:416-428`, `:663-667`, `:721-767`, `:843-853`, `:1648-1668`

Line numbers are at HEAD before this task's edits. The spec cites the order comment as `:959-969`; that is the pre-Branch-A position - at HEAD it is `:990-1000`.

**Interfaces:**
- Consumes: none.
- Produces (exact contract, Task 15):
  - `DeliveryReasonOptions` gains `retryScheduled?: boolean`.
  - `deliveryReason('30003', { retryScheduled: true })` (and `relay` not true) -> `'Phone unreachable - will retry (error 30003)'`, checked ahead of the media and base maps.
  - Base: `deliveryReason('30003')` -> `'Phone unreachable (error 30003)'`. The relay map keeps its 30003 entry; `relay` wins over `retryScheduled`.
  - `deliveryReason('retry_window_closed')` -> `'Not retried - message too old'` (no tail; `INTERNAL_CODE_REASONS`).
  - `RelayDeliveryOptions` (`:373`) inherits the option through `extends DeliveryReasonOptions`; no caller sets it there.

- [ ] **Step 1: Write the failing tests (spec D8, D11, D12)**

All edits in `dashboard/src/routes/contact/deliveryStatus.test.ts`.

(a) Replace the native group-text rollup test and its comment (`:416-428`, from `  // D20, at the rollup. The identical slot map WITHOUT the relay flag is a` through that test's closing `  });`) with the inversion (spec D11):

```ts
  // retry-send-window D11, at the rollup. The identical slot map WITHOUT the
  // relay flag is a native group text, which has no retry at all - the
  // one-to-one arm refuses to schedule one for a group_text conversation - so it
  // promises none and reads exactly as the relay rollup above. (Until the retry
  // send window this test pinned the promise here; it was never true.)
  it('promises no retry on a native group-text rollup either', () => {
    const presented = presentRelayDelivery([
      { status: 'delivered' },
      { status: 'undelivered', errorCode: '30003' },
    ]);
    expect(presented).toEqual({
      label: 'delivered 1/2 - 1 failed',
      tone: 'danger',
      isFailure: true,
      reason: 'Phone unreachable (error 30003)',
    });
    expect(presented?.reason).not.toMatch(/retry/i);
  });
```

(b) Replace the `EM_DASH` docblock (`:663-667`, from `/** The separator in the SHIPPED 1:1 30003 entry: one U+2014 EM DASH with an` through `presenter module. */`) - keep the `const EM_DASH = String.fromCharCode(0x2014);` line - with:

```ts
/** The separator the 1:1 30003 entry SHIPPED with before the retry send window:
 *  one U+2014 EM DASH. Spelled as an escape so every line stays ASCII
 *  (AGENTS.md), and kept only so a test can prove the new 30003 copy no longer
 *  carries it (retry-send-window D8: new and touched copy is ASCII). */
```

(c) Replace `:721-767` - from `  // D19. No relay retry exists: the status webhook returns on the relay-pointer` through the closing `  });` of `it('falls through the media map to the relay override for a 30003 attachment leg'` - with:

```ts
  // A relay leg's reason never promises a retry. A relay 30003 IS retried - the
  // relay retry ladder - but that promise is the retry join's own `Retrying`
  // state, decided from the rung, never copy keyed on the code. The override
  // KEEPS the carrier code - 30003 is a real number an operator can look up -
  // and the `(error <code>)` tail comes from the shared template, so there is
  // no second copy of the string to drift.
  it('drops the retry promise on a RELAY leg while keeping the carrier code', () => {
    const relay = deliveryReason('30003', { relay: true }) as string;
    expect(relay).toBe('Phone unreachable (error 30003)');
    expect(relay).not.toMatch(/retry/i);
  });

  // retry-send-window D8 and D11: WITHOUT `retryScheduled` no surface promises
  // a retry - not a one-to-one bubble whose retry was declined, exhausted or
  // never scheduled, and not a native group text, which has no retry at all.
  // This test pinned the opposite until the retry send window: the promise was
  // keyed on the code alone, and it was false after the last retry, on
  // manual-mode threads and on every native group text.
  it('promises nothing without retryScheduled - one-to-one and native group text alike', () => {
    const base = 'Phone unreachable (error 30003)';
    expect(deliveryReason('30003')).toBe(base);
    expect(deliveryReason('30003', { relay: false })).toBe(base);
    expect(deliveryReason('30003', { retryScheduled: false })).toBe(base);
    expect(deliveryReason('30003', { media: true })).toBe(base);
  });

  // retry-send-window D8: the ONE-TO-ONE promise, read only while the failed
  // message carries a live `retry_due_at` - the caller's `retryScheduled`.
  it('promises the retry with retryScheduled on a 30003 that is not a relay leg', () => {
    const promise = 'Phone unreachable - will retry (error 30003)';
    expect(deliveryReason('30003', { retryScheduled: true })).toBe(promise);
    expect(deliveryReason('30003', { retryScheduled: true, relay: false })).toBe(promise);
  });

  // Checked AHEAD of the media map, so an MMS one-to-one bubble with a live
  // stamp still promises. No media override holds 30003 today; the order keeps
  // the promise first if one ever does.
  it('keeps the promise on an MMS one-to-one 30003 - retryScheduled goes ahead of the media map', () => {
    expect(deliveryReason('30003', { media: true, retryScheduled: true })).toBe(
      'Phone unreachable - will retry (error 30003)',
    );
  });

  // 30003 is the only code the automatic retry runs for, so it is the only code
  // the option moves - and the internal map still early-returns ahead of it.
  it('moves no other code, and no internal code, when retryScheduled is set', () => {
    expect(deliveryReason('30005', { media: true, retryScheduled: true })).toBe(
      "Attachment didn't get through, texts may still work (error 30005)",
    );
    expect(deliveryReason('30007', { retryScheduled: true })).toBe(
      'Carrier filtered the message (error 30007)',
    );
    expect(deliveryReason('99999', { retryScheduled: true })).toBe('Delivery failed (error 99999)');
    expect(deliveryReason('transient_cap', { retryScheduled: true })).toBe(
      'Sending gave up after repeated carrier deferrals',
    );
    expect(deliveryReason(undefined, { retryScheduled: true })).toBeUndefined();
  });

  // New and touched copy is ASCII (spec D8): the old entry's separator was a
  // U+2014 em dash, and neither sentence may carry it forward.
  it('writes the 30003 copy in ASCII, with and without the promise', () => {
    for (const reason of [deliveryReason('30003'), deliveryReason('30003', { retryScheduled: true })]) {
      expect(reason).not.toContain(EM_DASH);
      expect(reason).toMatch(/^[ -~]+$/);
    }
  });

  // THE ORDER, pinned before any map can grow: the one-to-one PROMISE first (and
  // only without `relay`), media SECOND, relay THIRD, base LAST. The media and
  // relay override maps are disjoint today (media holds 30005/30006, relay holds
  // 30003), so nothing observable depends on THEIR order - which is exactly why
  // it has to be a test rather than a comment. Consulted the other way round, a
  // relay map that ever gained a 30005 would silently invert the prod-2026-08-24
  // MMS hedge on the surface whose own comment (the Timeline's per-recipient
  // row) calls that contradiction the thing it exists to prevent.
  it('lets the MEDIA hedge win over the relay override on an attachment leg', () => {
    expect(deliveryReason('30005', { media: true, relay: true })).toBe(
      "Attachment didn't get through, texts may still work (error 30005)",
    );
    expect(deliveryReason('30006', { media: true, relay: true })).toBe(
      "Attachment didn't get through, texts may still work (error 30006)",
    );
  });

  // The other half of the order (retry-send-window D8): `relay` WINS over
  // `retryScheduled`. A relay leg never promises through the one-to-one option -
  // its promise is the join's `Retrying` state - so the option is skipped
  // outright whenever `relay` is set, on an attachment leg too: the media map
  // holds no 30003, so a relay MMS leg lands on the relay copy.
  it('lets relay win over retryScheduled - a relay leg never promises, attachment or not', () => {
    const relay = 'Phone unreachable (error 30003)';
    expect(deliveryReason('30003', { relay: true, retryScheduled: true })).toBe(relay);
    expect(deliveryReason('30003', { media: true, relay: true, retryScheduled: true })).toBe(relay);
    expect(deliveryReason('30003', { media: true, relay: true })).toBe(relay);
  });
```

(d) In `it('never resolves a delivery reason off Object.prototype'` (`:843-853`), after the relay line of the loop body (`:851`, the line that opens with ``      expect(deliveryReason(code, { relay: true })).toBe(``) add:

```ts
      // The one-to-one promise map is a bare object literal as well, read the
      // same own-property way.
      expect(deliveryReason(code, { retryScheduled: true })).toBe(`Delivery failed (error ${code})`);
```

(e) Replace the close-code describe (`:1648-1668`, from `describe('deliveryReason - the four retry close codes (D15)', () => {` through its closing `});`) with:

```ts
describe('deliveryReason - the relay retry close codes (D15, retry-send-window D8)', () => {
  const RETRY_CODES: Array<[string, string]> = [
    ['retry_group_closed', 'Not retried - group closed'],
    ['retry_member_removed', 'Not retried - no longer in this group'],
    ['retry_number_changed', 'Not retried - number changed since'],
    ['retry_opted_out', 'Not retried - opted out'],
    // retry-send-window D8: the WINDOW decline's close. No current surface
    // prints it (the retry join gives it no display code), but the no-tail
    // rule holds for it like every other code this app invents.
    ['retry_window_closed', 'Not retried - message too old'],
  ];

  it.each(RETRY_CODES)('renders %s as prose with no (error N) tail', (code, copy) => {
    expect(deliveryReason(code, { relay: true })).toBe(copy);
    expect(deliveryReason(code, { relay: true })).not.toContain('(error ');
  });

  // INTERNAL codes are keyed on the code ALONE and short-circuit before any
  // product map, so they read identically wherever they land - the relay rollup,
  // the recital, one member's row, and a broadcast's results badge.
  it.each(RETRY_CODES)('renders %s the same with no product options at all', (code, copy) => {
    expect(deliveryReason(code)).toBe(copy);
    expect(deliveryReason(code, { media: true })).toBe(copy);
    expect(deliveryReason(code, { retryScheduled: true })).toBe(copy);
  });
});
```

- [ ] **Step 2: Run them to verify the new ones fail**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts`
Expected: FAIL on: `promises no retry on a native group-text rollup either`, `promises nothing without retryScheduled - one-to-one and native group text alike`, `promises the retry with retryScheduled on a 30003 that is not a relay leg`, `keeps the promise on an MMS one-to-one 30003 - retryScheduled goes ahead of the media map`, `writes the 30003 copy in ASCII, with and without the promise` (all read the em-dash "will retry" base, or ignore the unknown option), and both `retry_window_closed` rows of the close-code table (`Delivery failed (error retry_window_closed)`). Already green, kept as pins: the relay-leg test, `moves no other code...`, both order tests, and the prototype sweep.

- [ ] **Step 3: Implement (spec D8, D12)**

All edits in `dashboard/src/routes/contact/deliveryStatus.ts`.

(a) In `ERROR_CODE_REASONS` (`:777-784`), replace the `'30003'` entry at `:778` (its value carries a U+2014 em dash, not reproduced here) with:

```ts
  // retry-send-window D8: the BASE 30003 wording promises nothing. Only
  // RETRY_SCHEDULED_REASONS below promises, and only while a retry is actually
  // scheduled - never from the code alone, which was false after the last
  // retry, on manual-mode threads and on every native group text.
  '30003': 'Phone unreachable',
```

(b) After the MMS map (the closing `};` of `const MMS_ERROR_CODE_REASONS` at `:818`), insert:

```ts

/**
 * retry-send-window D8: the ONE-TO-ONE retry promise. Read only when the caller
 * says a retry IS scheduled (`retryScheduled`: the failed message carries a
 * live `retry_due_at` on the server's clock - see retryPromise.ts) and the leg
 * is NOT a relay leg. Checked FIRST, ahead of the media map, so an MMS
 * one-to-one bubble with a live stamp still promises: no media override holds
 * 30003 today, and the order keeps the promise first if one ever does.
 *
 * 30003 is the whole map because it is the only code the automatic retry runs
 * for. The copy is ASCII (the old base entry's em dash was not carried over),
 * and the `(error <code>)` tail comes from the shared template.
 */
const RETRY_SCHEDULED_REASONS: Record<string, string> = {
  '30003': 'Phone unreachable - will retry',
};
```

(c) Replace the docblock above `const RELAY_ERROR_CODE_REASONS` (`:820-858`, from `/**` / ` * Overrides that apply ONLY to a RELAY leg, checked after MMS_ERROR_CODE_REASONS` through its closing ` */`) with (spec D12):

```ts
/**
 * Overrides that apply ONLY to a RELAY leg, checked after MMS_ERROR_CODE_REASONS
 * and before ERROR_CODE_REASONS.
 *
 * 30003 is the whole map, and since the retry send window it reads EXACTLY as
 * the base entry does ("Phone unreachable"). It stays because `relay` is what
 * fences a relay leg off from the one-to-one promise (retry-send-window D8):
 * `deliveryReason` reads RETRY_SCHEDULED_REASONS only when `relay` is NOT set,
 * so a relay leg can never promise a retry through `retryScheduled`. A relay
 * 30003 IS retried - the relay retry ladder - but that promise is the retry
 * join's own `Retrying` state (relayRetryJoin.ts), decided from the rung,
 * never copy keyed on the code. A rung the window declined reads this same
 * plain failure; one a gate declined reads its "Not retried - ..." close from
 * INTERNAL_CODE_REASONS.
 *
 * A native group-text leg is NOT a relay leg and has no retry at all (D11): it
 * takes the base entry, which promises nothing either.
 *
 * THE CARRIER CODE IS KEPT. Only a promise is ever dropped: 30003 is a real
 * number an operator can look up, unlike the app-invented codes in
 * INTERNAL_CODE_REASONS. Nothing here appends it - the `(error <code>)` template
 * at the end of `deliveryReason` does, which is why the string below stops at the
 * observation.
 */
```

(d) Replace `DeliveryReasonOptions` and its docblock (`:863-876`) with:

```ts
/** What SCOPES a reason to the leg that actually failed. All three flags are
 *  hints, not routing: an unmapped code reads the same whatever they say.
 *
 *  `retryScheduled`, `media` and `relay` are independent, and their ORDER is
 *  decided in `deliveryReason` rather than here - see the chain there. */
export interface DeliveryReasonOptions {
  /** The failing leg carried media - an MMS bubble or a relay MMS rollup. */
  media?: boolean;
  /** The failing leg is a RELAY fan-out leg, as opposed to a native group text,
   *  a 1:1 message, an email or a broadcast recipient. Set from the timeline's
   *  `rosterKind`; absent everywhere the presenter has no product input, which is
   *  exactly the set of positions D19 leaves alone. It WINS over
   *  `retryScheduled`: a relay leg never promises through that option. */
  relay?: boolean;
  /** retry-send-window D8: an automatic retry of THIS failed one-to-one message
   *  is scheduled - it carries a live `retry_due_at` on the server's clock
   *  (`isRetryPromiseLive`, retryPromise.ts). Read only for 30003, and only when
   *  `relay` is not set. Set by exactly one caller, the one-to-one bubble's
   *  message-level chip in Timeline.tsx; every other surface (legs, rollups,
   *  the email card, the property-send results row) omits it and reads the
   *  plain failure. */
  retryScheduled?: boolean;
}
```

(e) In `INTERNAL_CODE_REASONS`, after the line `  retry_opted_out: 'Not retried - opted out',` (`:934`), insert (leave `SHARE_SKIP_REASONS` at `:948` untouched):

```ts
  // retry-send-window D8: the close a WINDOW decline writes (the relay claim or
  // the job found the retry would go out more than 15 minutes after the
  // original). No current surface prints it: the retry join treats this code as
  // carrying NO display code, so the leg keeps its original 30003 and reads the
  // plain failed attempt (relayRetryJoin.ts, the terminal step). The entry is
  // the fallback for a future surface that renders a rung's code directly, and
  // keeps this map's no-tail rule total.
  retry_window_closed: 'Not retried - message too old',
```

(f) In `deliveryReason`, replace the order comment and the `mapped` chain (`:990-1004`, from `  // THE ORDER IS LOAD-BEARING, and it is pinned by a test because nothing` through `    ownReason(ERROR_CODE_REASONS, errorCode);`) with:

```ts
  // THE ORDER IS LOAD-BEARING, and it is pinned by tests: the one-to-one
  // PROMISE first, media SECOND, relay THIRD, base LAST.
  //
  // The promise (retry-send-window D8) goes ahead of the media map so an MMS
  // one-to-one bubble with a live `retry_due_at` still promises, and it is
  // skipped outright whenever `relay` is set: a relay leg never promises through
  // `retryScheduled` - its promise is the retry join's `Retrying` state. That
  // fence is why the relay map, whose 30003 now reads exactly like the base,
  // still exists.
  //
  // Media before relay is pinned because nothing observable depends on it today:
  // the two override maps are disjoint right now (media holds 30005/30006, relay
  // holds 30003), so either order gives the same answers - which is precisely
  // why it has to be decided before the maps grow. Consulted the other way
  // round, a relay map that ever gained a 30005 would silently un-hedge the
  // prod-2026-08-24 MMS copy on a relay attachment leg, on the very surface whose
  // own comment (Timeline.tsx per-recipient row) calls that contradiction the
  // thing it exists to prevent. The MMS hedge is about what the CARRIER could not
  // move; the relay override is about what THIS APP will not do next. When both
  // apply, the carrier's reading is the one staff need first.
  const mapped =
    (opts.retryScheduled === true && opts.relay !== true
      ? ownReason(RETRY_SCHEDULED_REASONS, errorCode)
      : undefined) ??
    (opts.media === true ? ownReason(MMS_ERROR_CODE_REASONS, errorCode) : undefined) ??
    (opts.relay === true ? ownReason(RELAY_ERROR_CODE_REASONS, errorCode) : undefined) ??
    ownReason(ERROR_CODE_REASONS, errorCode);
```

(The `presentLegDelivery` docblock at `:661-663` quotes this comment's phrase "because nothing observable depends on it today"; the rewrite keeps that phrase, so the quote still resolves.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/contact/deliveryStatus.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the red this change hands to Tasks 17 and 18**

The base wording is shared, so four tests in other files that pin the OLD copy now fail by design. Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/StatChips.test.tsx`
Expected: exactly four failures, nothing else in those files:
- `Timeline.delivery.test.tsx` `keeps the retry promise on the SAME leg in a native GROUP TEXT` (`:516`) - turned by Task 17.
- `Timeline.delivery.test.tsx` `leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding` (`:577`) - turned by Task 17.
- `Timeline.email.test.tsx` `keeps the BASE 30003 copy on an outbound email failure` (`:96`) - turned by Task 18.
- `StatChips.test.tsx` `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped` (`:134`) - turned by Task 18.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck
npx eslint dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts
git status
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts
git commit -m "feat(dashboard): 30003 promises a retry only while one is scheduled (retry-send-window D8, D11, D12)

deliveryReason gains retryScheduled: with it, a 30003 that is not a relay
leg reads 'Phone unreachable - will retry', ahead of the media map; relay
wins. The base 30003 reads 'Phone unreachable' (ASCII), so native group
texts, rollups, email and the share row promise nothing. retry_window_closed
gets its no-tail fallback copy; the stale relay-map rationale is rewritten.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/contact/deliveryStatus.test.ts
```

Expected: typecheck exit 0; eslint reports no error on any line this task added (`EM_DASH` is still used, by the ASCII test).

---

### Task 16: The relay join gives a window-declined rung no display code (spec D8)

**Files:**
- Modify: `dashboard/src/routes/contact/relayRetryJoin.ts:94` (new constant after `TERMINAL_RUNG_STATUSES`, `:89-94`), `:405-415` (terminal step), `:425-429` (`projectRelayLegs` doc)
- Test: `dashboard/src/routes/contact/relayRetryJoin.test.ts:67` (new fixture after `failedLeg`, `:60-67`), `:199` (new cases after the terminal tests, `:166-199`)
- Test: `dashboard/src/routes/contact/Timeline.delivery.test.tsx:1014` (new cases after `projects a terminal close code onto the row and the chip reason`, `:987-1014`)

**Interfaces:**
- Consumes: the rung close Tasks 4 and 5 write for a window decline - the claim appends the declined rung already closed (Task 4) and the job closes it through `refuseGate('retry_window_closed')`, both the pre-send refusal shape (`app/src/jobs/relayRetryLeg.ts:449-467`; the claim's closed append is Task 4 Step 7a): the rung's slot is `{ status: 'failed', errorCode: 'retry_window_closed' }`, aggregation `excluded` on a versioned row. Task 15's `INTERNAL_CODE_REASONS.retry_window_closed` (never reached by the join after this task).
- Produces: `projectRelayLegs` (signature unchanged) - a last rung closed `retry_window_closed` leaves the original slot's `errorCode` in place (`retryState: 'terminal'`); every other close code is projected as today.

- [ ] **Step 1: Write the failing join tests (spec D8)**

In `dashboard/src/routes/contact/relayRetryJoin.test.ts`, after `failedLeg` (`:60-67`), add:

```ts
/** A rung the claim or the job closed as a WINDOW decline (retry-send-window
 *  D3/D4): the pre-send refusal shape - failed, never sent, aggregation
 *  `excluded` - with the window's close code. */
function windowClosedLeg(): RelayRecipientDelivery {
  return {
    status: 'failed',
    errorCode: 'retry_window_closed',
    requestedTransport: 'sms',
    transportAggregationState: 'excluded',
  };
}
```

After `it('leaves the original carrier code when the last rung carries none'` (ends `:199`), add:

```ts
  // retry-send-window D8: a WINDOW decline carries NO display code. The rung
  // closed `retry_window_closed` (kept for data and logs); the ORIGINAL's 30003
  // stands, so the leg reads as the plain failed attempt the ruling asks for -
  // every slot field intact, exactly as a terminal rung with no code leaves it.
  it('keeps the original carrier code when the last rung closed retry_window_closed', () => {
    const legs = project([retryItem({ attempt: 1, leg: windowClosedLeg(), atMs: NOW - 60_000 })], NOW);

    expect(legs).toEqual({ ...ORIGINAL, retryState: 'terminal' });
  });

  // Rung 2 is claimed only by rung 1's own 30003, so the code that stands is the
  // same carrier failure the ladder ran for.
  it('keeps the original carrier code when a LATER rung closed retry_window_closed', () => {
    const legs = project(
      [
        retryItem({ attempt: 1, leg: failedLeg('30003'), atMs: NOW - 300_000 }),
        retryItem({ attempt: 2, leg: windowClosedLeg(), atMs: NOW - 60_000 }),
      ],
      NOW,
    );

    expect(legs).toMatchObject({ errorCode: '30003', retryState: 'terminal' });
  });

  // The four GATE closes are untouched: each still replaces the carrier code,
  // so the leg reads its "Not retried - ..." copy (Cameron's gate answer).
  it.each(['retry_group_closed', 'retry_member_removed', 'retry_number_changed', 'retry_opted_out'])(
    'still projects the gate close %s onto the original leg',
    (code) => {
      const legs = project([retryItem({ attempt: 1, leg: failedLeg(code), atMs: NOW - 60_000 })], NOW);

      expect(legs).toMatchObject({ errorCode: code, retryState: 'terminal' });
    },
  );
```

- [ ] **Step 2: Write the failing Timeline test (spec D3, D8)**

In `dashboard/src/routes/contact/Timeline.delivery.test.tsx`, inside `describe('Timeline relay retry states - the chip, the recital and the row together'`, after the closing `  });` of `it('projects a terminal close code onto the row and the chip reason'` (`:1014`) and before the comment line that opens with ``  // D19's second table:`` (`:1016`), add:

```tsx
  // retry-send-window D8: a WINDOW decline is a plain failed attempt. The rung
  // closes `retry_window_closed` - kept for data and logs - but the join gives
  // that code NO display code, so the original's 30003 stands at all three
  // positions: never "Not retried - message too old", and never a promise. The
  // rung arrives already closed when the claim declines it at once (D3), so this
  // is also what the FIRST render shows - no "Retrying" in between.
  it('reads a window-declined rung as the plain 30003 failure at all three positions', () => {
    renderTimeline({
      items: [
        original(),
        retryRow({
          attempt: 1,
          atMs: FRESH_MS,
          leg: { status: 'failed', errorCode: 'retry_window_closed', transportAggregationState: 'excluded' },
        }),
      ],
      relayRoster: RELAY_ROSTER,
    });

    const rollup = screen.getByRole('img');
    expect(rollup).toHaveTextContent('delivered 1/2 - 1 failed - Phone unreachable (error 30003)');
    expect(rollup).toHaveAccessibleName(/Lars Landlord: Undelivered, Phone unreachable \(error 30003\)/);
    revealOriginal();
    expect(
      within(screen.getByRole('list', { name: LIST_NAME })).getByText(
        'Undelivered - Phone unreachable (error 30003)',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not retried/)).not.toBeInTheDocument();
    expect(screen.queryByText(/too old/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retrying/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
  });

  // The four GATE declines keep their copy (Cameron's gate answer), whether the
  // claim closed the rung at once (D3) or the job closed it at send time: one
  // data shape, one rendering.
  it.each([
    ['retry_group_closed', 'Not retried - group closed'],
    ['retry_member_removed', 'Not retried - no longer in this group'],
    ['retry_number_changed', 'Not retried - number changed since'],
    ['retry_opted_out', 'Not retried - opted out'],
  ] as Array<[string, string]>)('reads a rung closed %s as "%s" at the chip and the row', (code, copy) => {
    renderTimeline({
      items: [
        original(),
        retryRow({
          attempt: 1,
          atMs: FRESH_MS,
          leg: { status: 'failed', errorCode: code, transportAggregationState: 'excluded' },
        }),
      ],
      relayRoster: RELAY_ROSTER,
    });

    expect(screen.getByRole('img')).toHaveTextContent(`delivered 1/2 - 1 failed - ${copy}`);
    revealOriginal();
    expect(
      within(screen.getByRole('list', { name: LIST_NAME })).getByText(`Undelivered - ${copy}`),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run them to verify the new ones fail**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts src/routes/contact/Timeline.delivery.test.tsx`
Expected: FAIL on the two `retry_window_closed` join tests (the projected `errorCode` is `retry_window_closed`) and on `reads a window-declined rung as the plain 30003 failure at all three positions` (the chip reads `delivered 1/2 - 1 failed - Not retried - message too old`, Task 15's fallback copy). The two gate `it.each` tables pass already (pins). Timeline.delivery.test.tsx also still shows Task 15's two expected failures (`:516`, `:577`), turned in Task 17.

- [ ] **Step 4: Implement (spec D8)**

In `dashboard/src/routes/contact/relayRetryJoin.ts`, after `TERMINAL_RUNG_STATUSES` (the closing `]);` at `:94`), insert:

```ts

/** retry-send-window D8: the close a WINDOW decline writes on its rung - the
 *  relay claim (D3) or the job (D4) found the retry would go out more than 15
 *  minutes after the original. Kept on the rung for data and logs, and
 *  deliberately carrying NO display code here: the ruling is that a declined
 *  late retry reads as a plain failed attempt, so the original leg's own 30003
 *  stands. A copy of the app's `RelayRetryCloseCode` member
 *  (app/src/jobs/relayRetryLeg.ts); the dashboard cannot import app code. */
const WINDOW_CLOSED_CODE = 'retry_window_closed';
```

Replace the terminal step (`:405-415`):

```ts
  // 4. Otherwise every rung ended and none delivered. The close code comes from
  //    the LAST rung when it carries one - a D9 gate refusal or an enqueue
  //    failure has no bubble of its own, so its reason can only be read here -
  //    and otherwise the original's carrier code stands (D19).
  const last = rungs[rungs.length - 1];
  const closeCode = last?.leg.errorCode;
  return {
    ...slot,
    ...(closeCode !== undefined && { errorCode: closeCode }),
    retryState: 'terminal',
  };
```

with:

```ts
  // 4. Otherwise every rung ended and none delivered. The close code comes from
  //    the LAST rung when it carries one - a D9 gate refusal or an enqueue
  //    failure has no bubble of its own, so its reason can only be read here -
  //    and otherwise the original's carrier code stands (D19). A WINDOW decline
  //    counts as carrying none (retry-send-window D8): the ruling is that a
  //    late retry the window declined reads as a plain failed attempt, so the
  //    original's 30003 stands, never "Not retried - message too old".
  const last = rungs[rungs.length - 1];
  const lastCode = last?.leg.errorCode;
  const closeCode = lastCode === WINDOW_CLOSED_CODE ? undefined : lastCode;
  return {
    ...slot,
    ...(closeCode !== undefined && { errorCode: closeCode }),
    retryState: 'terminal',
  };
```

In the `projectRelayLegs` docblock, replace (`:428-429`):

```ts
 *    `terminal` only replaces `errorCode` when the last rung carries a close
 *    code of its own.
```

with:

```ts
 *    `terminal` only replaces `errorCode` when the last rung carries a close
 *    code of its own - never `retry_window_closed`, which carries no display
 *    code (retry-send-window D8), so a window decline reads the plain failure.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/contact/relayRetryJoin.test.ts src/routes/contact/Timeline.delivery.test.tsx`
Expected: PASS, except the two Task 15 hand-offs in Timeline.delivery.test.tsx (`:516`, `:577`), still red until Task 17.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck
npx eslint dashboard/src/routes/contact/relayRetryJoin.ts dashboard/src/routes/contact/relayRetryJoin.test.ts dashboard/src/routes/contact/Timeline.delivery.test.tsx
git status
git add dashboard/src/routes/contact/relayRetryJoin.ts dashboard/src/routes/contact/relayRetryJoin.test.ts dashboard/src/routes/contact/Timeline.delivery.test.tsx
git commit -m "feat(dashboard): a window-declined relay rung reads the plain 30003 failure (retry-send-window D8)

The join's terminal step treats retry_window_closed as carrying no display
code, so the original leg's 30003 stands and the leg reads 'Phone unreachable
(error 30003)' at the chip, the recital and the row. The four gate closes
still render their 'Not retried - ...' copy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- dashboard/src/routes/contact/relayRetryJoin.ts dashboard/src/routes/contact/relayRetryJoin.test.ts dashboard/src/routes/contact/Timeline.delivery.test.tsx
```

---

### Task 17: Timeline - the live promise, Retry hidden, the ticker arms on the server clock, 409 mapped (spec D8, D10, D11, D12)

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx`:
  - `:53` imports
  - `:126-127` `sendFailureMessage` (`:86-131`) gains `retry_pending`
  - `:766` new `showsRetryPromise` after `bubbleClocks` (`:758-766`)
  - `:768-852` run-condition docblock, `:859-871` `hasTickableLeg` signature and clause
  - `:901-929` `MessageBubble` props, `:973-980` the chip's reason (D12 comment), `:1272-1275` (D12 comment), `:1341` the Retry gate
  - `:1719-1753` `StreamItem` passes `promiseNowMs`
  - `:2055-2057` ticker comment, `:2101-2104` the `tickerArmed` memo, `:2529-2537` the `StreamItem` call
- Test: `dashboard/src/routes/contact/Timeline.delivery.test.tsx:63-68`, `:460-465`, `:509-537`, `:570-595`
- Test: `dashboard/src/routes/contact/Timeline.ticker.test.tsx:27-31`, `:124`, `:411-418`, `:921` (new describe at the end)
- Test: `dashboard/src/routes/contact/Timeline.test.tsx:930` (new 409 test after the rate-limited Retry test, `:914-929`)

**Interfaces:**
- Consumes: Task 13 `TimelineMessage.retry_due_at?: string` (`dashboard/src/api/types.ts`, beside `retry_of` at `:2494`); Task 14 `serverNowMs(): number` and `isRetryPromiseLive(retryDueAt: string | undefined, serverNowMs: number): boolean`; Task 15 `DeliveryReasonOptions.retryScheduled?: boolean`; Task 12's refusal `409 { error: 'retry_pending' }` (the route's other 409s have the same `{ error: <code> }` body, `app/src/routes/api.ts:1586`, `:1594`), which `errorFrom` turns into `ApiError.code === 'retry_pending'` (`dashboard/src/api/client.ts:68-76`).
- Produces (module-private to Timeline.tsx):
  - `function showsRetryPromise(msg: TimelineMessage, promiseNowMs: number): boolean`
  - `function hasTickableLeg(msg: TimelineMessage, tickNow: number, retries: Map<string, RelayRetryRow[]>, promiseNowMs: number): boolean`
  - `MessageBubble` and `StreamItem` gain a required prop `promiseNowMs: number`.
  - `sendFailureMessage` maps `retry_pending` to `'A retry is already scheduled for this message.'`

Design note: the promise is judged on ONE server-clock snapshot per arming decision, taken inside the `tickerArmed` memo with the contract's `serverNowMs()` and handed down beside `tickNow`, so the interval and every bubble read the same value - including a bubble re-rendered on its own by a reveal click. It does NOT read `bubbleClocks` (`:758-766`): that clock is the browser tick, and it is withheld on imported rows.

- [ ] **Step 1: Write the failing Timeline.delivery tests (spec D8, D10, D11, D12)**

All edits in `dashboard/src/routes/contact/Timeline.delivery.test.tsx`.

(a) Delete the `EM_DASH` docblock and constant (`:63-68`, from `/** The separator inside the SHIPPED 1:1 / group-text 30003 reason: one U+2014 EM` through `const EM_DASH = String.fromCharCode(0x2014);`). After (c) and (d) nothing uses it, and an unused constant is a lint error.

(b) In the slice-5a comment, replace the D19 paragraph (`:462-465`):

```tsx
  // D19: no relay retry is scheduled. The status webhook returns on the
  // relay-pointer branch BEFORE the 1:1 retry enqueue, and this branch adds no
  // relay retry - so "will retry" beside a relay member's name is a promise the
  // product cannot keep, in both worlds.
```

with (spec D12):

```tsx
  // D19, as it stands since the relay 30003 ladder and the retry send window: a
  // relay leg's retry IS real, but its promise is the retry join's own
  // `Retrying` state, never copy keyed on the code - and `relay` wins over the
  // one-to-one `retryScheduled` option (retry-send-window D8), so "will retry"
  // never appears beside a relay member's name.
```

(c) Replace the group-text test and its comment (`:509-537`, from the line that opens with ``  // D20, pinned EXPLICITLY rather than by relying on a default.`` through the closing `  });` of `it('keeps the retry promise on the SAME leg in a native GROUP TEXT'`) with the inversion (spec D11):

```tsx
  // retry-send-window D11, pinned EXPLICITLY rather than by relying on a default.
  // `rosterKind` defaults to 'relay' (Timeline.tsx:1790, and MessageBubble's own
  // default at :906), so exactly ONE production caller opts out: GroupTextView.
  // A native group text has NO retry - the one-to-one arm refuses to schedule
  // one for a group_text conversation - so its leg promises none either and
  // reads exactly as a relay leg does, at all three positions. (Until the retry
  // send window this test pinned the opposite; the promise was never true here.)
  it('promises NO retry on the SAME leg in a native GROUP TEXT', () => {
    const msg: TimelineItem = {
      ...RELAY_OUT,
      id: 'g-30003',
      tsMsgId: 'g-30003',
      body: 'group text to the pair',
      delivery_recipients: {
        c1: { status: 'delivered' },
        c2: { status: 'undelivered', errorCode: '30003' },
      },
    };
    renderTimeline({ items: [msg], relayRoster: GROUP_ROSTER, rosterKind: 'group_text' });
    const base = 'Phone unreachable (error 30003)';
    const rollup = screen.getByRole('img');
    expect(rollup).toHaveTextContent(`delivered 1/2 - 1 failed - ${base}`);
    expect(rollup).toHaveAccessibleName(
      `delivered 1 of 2, 1 failed, ${base}. Ann Tenant: Delivered. Bo Tenant: Undelivered, ${base}.`,
    );
    reveal('group text to the pair');
    const failedRow = rows()[1] as HTMLElement;
    expect(within(failedRow).getByText(`Undelivered - ${base}`)).toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
  });
```

(d) Replace the message-level chip comment and test (`:570-595`, from `  // Timeline.tsx:849 - the MESSAGE-LEVEL chip - is NOT overridden. It reads` through the closing `  });` of `it('leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding'`) with the D8 set:

```tsx
  // retry-send-window D8 and D10, at the MESSAGE-LEVEL chip - the one call site
  // that passes `retryScheduled`. A one-to-one bubble promises a retry ONLY
  // while it carries a live `retry_due_at`, judged on the server's clock (no API
  // response is seen in this file, so the estimate IS the pinned clock), and the
  // Retry button is hidden for exactly as long. Every case renders with the
  // DEFAULT rosterKind, which is 'relay' (Timeline.tsx:1790) - on purpose: the
  // chip must never pass `relay`, which wins over `retryScheduled` and would
  // switch the promise off on every contact page. (Until the retry send window
  // this test pinned the promise on EVERY 30003, stamp or not.)
  const ONE_TO_ONE_30003: TimelineItem = {
    kind: 'message',
    id: 'm-30003',
    at: RELAY_AT,
    conversationId: 'c1',
    tsMsgId: 'm-30003',
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    delivery_status: 'undelivered',
    error_code: '30003',
    body: 'one to one, no roster',
  };
  const PROMISE_TEXT = 'Undelivered - Phone unreachable - will retry (error 30003)';
  const PLAIN_TEXT = 'Undelivered - Phone unreachable (error 30003)';
  const RETRY_BUTTON = { name: 'Retry sending this message' };
  /** One minute past the pinned clock: the retry's run time. */
  const liveStamp = (): string => new Date(Date.now() + 60_000).toISOString();

  it('promises the retry and hides Retry while retry_due_at is live - relay default notwithstanding', () => {
    renderTimeline({ items: [{ ...ONE_TO_ONE_30003, retry_due_at: liveStamp() }], onRetry: vi.fn() });
    expect(screen.getByText(PROMISE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', RETRY_BUTTON)).not.toBeInTheDocument();
  });

  it('keeps the promise on an MMS one-to-one bubble - the promise is checked ahead of the media map', () => {
    renderTimeline({
      items: [{ ...ONE_TO_ONE_30003, type: 'mms', retry_due_at: liveStamp() }],
      onRetry: vi.fn(),
    });
    expect(screen.getByText(PROMISE_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', RETRY_BUTTON)).not.toBeInTheDocument();
  });

  it('reads the plain failure and offers Retry with NO stamp - declined, exhausted or a manual-mode thread', () => {
    renderTimeline({ items: [ONE_TO_ONE_30003], onRetry: vi.fn() });
    expect(screen.getByText(PLAIN_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', RETRY_BUTTON)).toBeInTheDocument();
  });

  it.each([
    ['EXPIRED - its grace ran out on the server clock', () => new Date(Date.now() - 3 * 60_000).toISOString()],
    ['WITHDRAWN - the epoch stamp a failed enqueue writes', () => '1970-01-01T00:00:00.000Z'],
    ['UNPARSEABLE', () => 'not a time'],
  ] as Array<[string, () => string]>)(
    'reads the plain failure and offers Retry when the stamp is %s',
    (_label, stamp) => {
      renderTimeline({ items: [{ ...ONE_TO_ONE_30003, retry_due_at: stamp() }], onRetry: vi.fn() });
      expect(screen.getByText(PLAIN_TEXT)).toBeInTheDocument();
      expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', RETRY_BUTTON)).toBeInTheDocument();
    },
  );
```

- [ ] **Step 2: Write the failing ticker tests (spec D8)**

All edits in `dashboard/src/routes/contact/Timeline.ticker.test.tsx`.

(a) After the import block (`:27-31`), add:

```tsx
import { noteServerDate, resetServerClockForTests } from '../../api/serverClock.js';
import { RETRY_PROMISE_GRACE_MS } from './retryPromise.js';
```

(b) After `reveal()` (ends `:124`) and before `describe('Timeline staleness ticker', () => {` (`:126`), add:

```tsx

/** `startFakeClock`, moved on to the next whole second: an HTTP `Date` header
 *  has one-second resolution, so a server instant round-trips through
 *  `noteServerDate` exactly only when it is aligned. Still derived from the
 *  fake clock's own `Date.now()`. */
function startAlignedClock(): number {
  const aligned = Math.ceil(startFakeClock() / 1000) * 1000;
  vi.setSystemTime(aligned);
  return aligned;
}

const ONE_TO_ONE_BODY = 'Your showing is confirmed for Tuesday';

/** A FAILED one-to-one bubble - no recipient map, so no LEG clause can ever arm
 *  for it - carrying the webhook's `retry_due_at` stamp when one is given. */
function failedOneToOneAt(atMs: number, retryDueAt: string | undefined): TimelineMessage {
  return {
    kind: 'message',
    id: 'o1',
    at: new Date(atMs).toISOString(),
    conversationId: 'c1',
    tsMsgId: 'o1',
    direction: 'outbound',
    author: 'teammate',
    type: 'sms',
    delivery_status: 'undelivered',
    error_code: '30003',
    body: ONE_TO_ONE_BODY,
    ...(retryDueAt !== undefined && { retry_due_at: retryDueAt }),
  };
}

// The server-clock estimate is module state: every test leaves it at a zero
// offset, so a skewed estimate can never leak into the next one.
afterEach(() => {
  resetServerClockForTests();
});
```

(c) In `SILENT_CASES`, replace the last case (`:411-418`):

```tsx
  {
    title: 'a bubble with NO delivery_recipients map at all has no legs to age',
    build: (t0) => {
      const msg = outboundAt(t0, {});
      delete msg.delivery_recipients;
      return msg;
    },
  },
```

with:

```tsx
  {
    title:
      'a bubble with NO delivery_recipients map and NO live retry promise has nothing to age (a one-to-one bubble with a live promise arms - see the promise clause below)',
    build: (t0) => {
      const msg = outboundAt(t0, {});
      delete msg.delivery_recipients;
      return msg;
    },
  },
  {
    title:
      'a FAILED one-to-one bubble with NO retry stamp - declined, exhausted, a manual-mode thread - promises nothing, so nothing is scheduled',
    build: (t0) => failedOneToOneAt(t0, undefined),
  },
  {
    title:
      'a one-to-one promise that already EXPIRED on the server clock can never be live again, so nothing is scheduled',
    build: (t0) => failedOneToOneAt(t0, new Date(t0 - 3 * 60 * 1000).toISOString()),
  },
  {
    title:
      'a WITHDRAWN one-to-one promise - the epoch stamp a failed enqueue writes (the app RETRY_PROMISE_WITHDRAWN_AT) - schedules nothing',
    build: (t0) => failedOneToOneAt(t0, '1970-01-01T00:00:00.000Z'),
  },
```

(d) At the end of the file (after the closing `});` of the relay retry clause describe, `:921`), add:

```tsx

// retry-send-window D8 - the SEVENTH clause. A one-to-one bubble has no
// recipient map, so no leg clause can ever arm for it, and its "will retry" copy
// and hidden Retry button change only when `retry_due_at` plus
// RETRY_PROMISE_GRACE_MS passes on the SERVER's clock. Judged on the browser's
// clock, a fast browser disarms while the promise is still live - and the
// promise never leaves the screen - and a slow one keeps it up for as long as
// the skew.
describe('Timeline staleness ticker - the one-to-one retry promise clause', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A first retry's backoff: the stamp is the retry's run time, one minute out. */
  const BACKOFF_MS = 60_000;
  /** The promise's whole life on screen, from the failure. Three tick periods. */
  const PROMISE_LIFE_MS = BACKOFF_MS + RETRY_PROMISE_GRACE_MS;
  const PROMISE_CHIP = 'Undelivered - Phone unreachable - will retry (error 30003)';
  const PLAIN_CHIP = 'Undelivered - Phone unreachable (error 30003)';
  const RETRY_BUTTON = { name: 'Retry sending this message' };

  it('ARMS for a live promise on a bubble with NO legs, drops it once retry_due_at + grace passes on the server clock, then STOPS - observable: the chip text and the Retry button, window.setInterval once, window.clearInterval with the ticker id', () => {
    const t0 = startAlignedClock();
    noteServerDate(new Date(t0).toUTCString(), t0);
    const spies = spyOnIntervals();
    renderTimeline({
      items: [failedOneToOneAt(t0, new Date(t0 + BACKOFF_MS).toISOString())],
      relayRoster: undefined,
      onRetry: vi.fn(),
    });

    expect(screen.getByText(PROMISE_CHIP)).toBeInTheDocument();
    expect(screen.queryByRole('button', RETRY_BUTTON)).not.toBeInTheDocument();
    // Nothing else on this thread can arm - the bubble has no legs - so this
    // call is the promise clause's.
    expect(spies.set).toHaveBeenCalledTimes(1);
    const tickerId: unknown = spies.set.mock.results[0]?.value;

    // One millisecond before the promise runs out: still promised.
    act(() => {
      vi.advanceTimersByTime(PROMISE_LIFE_MS - 1);
    });
    expect(screen.getByText(PROMISE_CHIP)).toBeInTheDocument();
    expect(screen.queryByRole('button', RETRY_BUTTON)).not.toBeInTheDocument();

    // The tick that crosses the edge drops the copy, returns Retry and disarms.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText(PLAIN_CHIP)).toBeInTheDocument();
    expect(screen.getByRole('button', RETRY_BUTTON)).toBeInTheDocument();
    expect(spies.clear).toHaveBeenCalledWith(tickerId);

    // And it does NOT re-arm: an expired promise can never be live again.
    act(() => {
      vi.advanceTimersByTime(A_LONG_WHILE_MS);
    });
    expect(spies.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['in step with the server', 0],
    ['10 minutes FAST', 10 * 60 * 1000],
    ['10 minutes SLOW', -10 * 60 * 1000],
  ] as Array<[string, number]>)(
    'shows the promise for the SAME real duration on a browser clock %s - observable: window.setInterval at mount, the chip one millisecond either side of the edge, window.clearInterval with the ticker id',
    (_label, browserAheadMs) => {
      const t0 = startAlignedClock();
      // The server's clock is the browser's minus the skew, and the first
      // response told the dashboard so.
      const serverT0 = t0 - browserAheadMs;
      noteServerDate(new Date(serverT0).toUTCString(), t0);
      const spies = spyOnIntervals();
      renderTimeline({
        items: [failedOneToOneAt(serverT0, new Date(serverT0 + BACKOFF_MS).toISOString())],
        relayRoster: undefined,
        onRetry: vi.fn(),
      });

      // ARMED on the server's clock. On the FAST browser its own clock already
      // reads the promise as expired, so a ticker judging by it would arm
      // nothing and the promise would never leave the screen.
      expect(screen.getByText(PROMISE_CHIP)).toBeInTheDocument();
      expect(spies.set).toHaveBeenCalledTimes(1);
      const tickerId: unknown = spies.set.mock.results[0]?.value;

      act(() => {
        vi.advanceTimersByTime(PROMISE_LIFE_MS - 1);
      });
      expect(screen.getByText(PROMISE_CHIP)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText(PLAIN_CHIP)).toBeInTheDocument();
      expect(screen.getByRole('button', RETRY_BUTTON)).toBeInTheDocument();
      expect(spies.clear).toHaveBeenCalledWith(tickerId);
    },
  );
});
```

- [ ] **Step 3: Write the failing 409 mapping test (spec D10)**

In `dashboard/src/routes/contact/Timeline.test.tsx`, before `  it('hides a failed message that a delivered retry superseded (retry_of), keeping only the retry', () => {` (`:931`), add:

```tsx
  it('retry-send-window D10: a 409 retry_pending on the manual Retry reads its own sentence, never the generic line', async () => {
    // A stale tab: the bubble never learned of the scheduled retry, so it still
    // offers Retry, and the server refuses the press while the retry is pending.
    const failed: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail',
      tsMsgId: 'm-fail',
      delivery_status: 'undelivered',
      error_code: '30003',
      body: 'This one failed',
    };
    const onRetry = vi.fn().mockRejectedValue(new ApiError(409, 'retry_pending', 'retry_pending'));
    renderTimeline({ items: [failed], onRetry });
    fireEvent.click(screen.getByRole('button', { name: /Retry sending/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A retry is already scheduled for this message.');
    expect(alert).not.toHaveTextContent(/Couldn't send/);
  });

```

- [ ] **Step 4: Run them to verify the new ones fail**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.ticker.test.tsx src/routes/contact/Timeline.test.tsx`
Expected: FAIL on:
- Timeline.delivery: `promises the retry and hides Retry while retry_due_at is live - relay default notwithstanding` and `keeps the promise on an MMS one-to-one bubble...` (the chip reads the plain failure and Retry shows).
- Timeline.ticker: the new describe's four tests (no promise on screen, and `window.setInterval` never called).
- Timeline.test: the 409 test (the alert reads the generic "Couldn't send" line).
Already green (Task 15 moved the copy): the group-text inversion, the no-stamp test, the three stale-stamp cases and the three new SILENT cases (pins).

- [ ] **Step 5: Implement (spec D8, D10, D11, D12)**

All edits in `dashboard/src/routes/contact/Timeline.tsx`.

(1) Imports: after `import type { EffectiveRelayLeg, RelayRetryRow } from './relayRetryJoin.js';` (`:53`), add:

```tsx
import { isRetryPromiseLive } from './retryPromise.js';
import { serverNowMs } from '../../api/serverClock.js';
```

`serverNowMs` is imported from its module, not through the api barrel (`dashboard/src/api/index.ts`): the barrel is left untouched, and a component test that mocks the barrel (`vi.mock('../../api/index.js', ...)`, e.g. `ContactCommsPane.test.tsx:31`) can never erase the clock the Timeline renders with.

(2) `sendFailureMessage`: after the two lines

```tsx
      case 'group_text_media_not_supported':
        return 'Group texts are text only for now - remove the attachment to send.';
```

(`:126-127`), add (spec D10):

```tsx
      // retry-send-window D10: the manual Retry route refuses while an automatic
      // retry of this message is still scheduled. The button is hidden then, so
      // a stale tab is what reads this - never the generic "couldn't send",
      // which would invite pressing again.
      case 'retry_pending':
        return 'A retry is already scheduled for this message.';
```

(3) After `bubbleClocks` - after the two lines `    bubbleNowMs: msg.imported === true ? undefined : tickNow,` / `  };` and its closing `}` (`:764-766`) - insert (spec D8, D10):

```tsx

/**
 * retry-send-window D8/D10: does this bubble show a LIVE one-to-one retry
 * promise? ONE predicate, read at three places so they cannot disagree: the
 * message-level chip's copy ("Phone unreachable - will retry"), the Retry
 * button (hidden while this is true), and the ticker's run condition (armed
 * while this is true, so the promise expires on screen without a reload).
 *
 * `promiseNowMs` is the SERVER-clock snapshot the timeline takes where it
 * decides arming (the `tickerArmed` memo), never the browser clock: the server
 * wrote the stamp, and the manual Retry route's 409 guard reads the server's
 * clock too. An EMAIL row renders an EmailCard, which promises nothing; an
 * inbound or unfailed bubble has nothing to promise about. The error code is
 * deliberately NOT checked: the server's guard does not check it either, and
 * the Retry button follows the guard.
 */
function showsRetryPromise(msg: TimelineMessage, promiseNowMs: number): boolean {
  if (msg.type === 'email' || msg.direction !== 'outbound') return false;
  if (presentDeliveryStatus(msg.delivery_status)?.isFailure !== true) return false;
  return isRetryPromiseLive(msg.retry_due_at, promiseNowMs);
}
```

(4) The run-condition docblock (`:768-852`), six edits:

Replace

```tsx
 * THE TICKER'S RUN CONDITION, per message: does this bubble render at least one
 * outbound leg that CAN still go stale but has not yet?
```

with

```tsx
 * THE TICKER'S RUN CONDITION, per message: does this bubble render at least one
 * outbound leg that CAN still go stale but has not yet - or a one-to-one retry
 * promise that has not yet expired (clause 7)?
```

Replace

```tsx
 * FIVE distinct non-terminations have been shipped-and-caught behind this one
 * line and a SIXTH was designed out before it could ship - six in total, each
 * closed by a specific clause here:
```

with

```tsx
 * FIVE distinct non-terminations have been shipped-and-caught behind this one
 * line, and a SIXTH and a SEVENTH were designed out before they could ship -
 * seven in total, each closed by a specific clause here:
```

After the line that opens with `` *     fresh rung in the future and pinned`` (`:818`, the last line of item 6), insert:

```tsx
 *  7. a PROMISE judged on the wrong clock (retry-send-window D8). A one-to-one
 *     bubble has no recipient map, so no leg clause can arm for it, and its
 *     "will retry" copy and hidden Retry button change only when
 *     `retry_due_at + RETRY_PROMISE_GRACE_MS` passes on the SERVER's clock.
 *     Judged on the browser clock, a fast browser disarms while the promise is
 *     still live, and the promise never leaves the screen. Closed by the
 *     promise clause below, which asks `showsRetryPromise` - the predicate the
 *     bubble renders from - against the server-clock snapshot the bubble reads
 *     (`promiseNowMs`, taken in the `tickerArmed` memo). It TERMINATES because
 *     that snapshot advances with real time and a promise past its grace can
 *     never be live again, so the tick that crosses the edge both drops the
 *     copy and disarms.
```

Replace

```tsx
 * cannot change any pixel, so it must not buy an interval. SIX clauses carry
 * that mirror, and each one names a real rendering decision made elsewhere:
```

with

```tsx
 * cannot change any pixel, so it must not buy an interval. SEVEN clauses carry
 * that mirror, and each one names a real rendering decision made elsewhere:
```

After the line ` *    set, so a bubble cannot find its own retries from its props.` (`:847`), insert:

```tsx
 *  - a LIVE ONE-TO-ONE RETRY PROMISE on an outbound failed bubble
 *    (retry-send-window D8), which the bubble renders twice - the chip's "will
 *    retry" and the Retry button's absence - and the only clause a bubble with
 *    NO recipient map can meet.
```

Replace

```tsx
 * `items`), and it is REQUIRED for the same reason `tickNow` is: an omitted one
 * would silently disable the retry half of the escalation rather than fail.
```

with

```tsx
 * `items`), and it is REQUIRED for the same reason `tickNow` is: an omitted one
 * would silently disable the retry half of the escalation rather than fail.
 * `promiseNowMs` is the thread's server-clock snapshot, required for the same
 * reason.
```

(5) `hasTickableLeg`: replace

```tsx
function hasTickableLeg(
  msg: TimelineMessage,
  tickNow: number,
  retries: Map<string, RelayRetryRow[]>,
): boolean {
  if (msg.type === 'email') return false;
```

with

```tsx
function hasTickableLeg(
  msg: TimelineMessage,
  tickNow: number,
  retries: Map<string, RelayRetryRow[]>,
  promiseNowMs: number,
): boolean {
  if (msg.type === 'email') return false;
  // Clause 7 (retry-send-window D8): a LIVE ONE-TO-ONE RETRY PROMISE, asked
  // through the SAME predicate the bubble renders from, against the SAME
  // server-clock snapshot it reads. Ahead of the leg clauses because a
  // one-to-one bubble has no recipient map - every one of them returns false
  // for it.
  if (showsRetryPromise(msg, promiseNowMs)) return true;
```

(6) `MessageBubble` destructuring: replace

```tsx
function MessageBubble({
  msg,
  onRetry,
  relayRoster,
  retryIndex,
  rosterKind = 'relay',
  tickNow,
}: {
```

with

```tsx
function MessageBubble({
  msg,
  onRetry,
  promiseNowMs,
  relayRoster,
  retryIndex,
  rosterKind = 'relay',
  tickNow,
}: {
```

and in its props type, replace

```tsx
   *  actually presents against. */
  tickNow: number;
}): React.JSX.Element {
```

with

```tsx
   *  actually presents against. */
  tickNow: number;
  /** retry-send-window D8: the thread's SERVER-clock snapshot, taken where the
   *  ticker decides arming (the `tickerArmed` memo) and handed down beside
   *  `tickNow`, so this bubble's retry promise - its copy and the hidden Retry
   *  button - and the interval that re-renders it read ONE value. Required,
   *  like `tickNow`. */
  promiseNowMs: number;
}): React.JSX.Element {
```

(7) The chip's reason (spec D8, D12): replace `:973-980`, from the line that opens with ``  // DELIBERATELY no`` through `  const reason = delivery?.isFailure ? deliveryReason(msg.error_code, { media: isMms }) : undefined;`, with:

```tsx
  // retry-send-window D8/D10: is an automatic retry of THIS message still
  // promised? Judged by the one predicate the ticker also arms on, against the
  // thread's server-clock snapshot, never the browser clock. It drives the
  // chip's copy below and hides the Retry button while it holds.
  const retryPromiseLive = showsRetryPromise(msg, promiseNowMs);
  // DELIBERATELY no `relay` flag here, and this is the one place in this
  // component where that is a decision rather than an omission. This site reads
  // the MESSAGE's own error_code, not a leg's: a relay source message never gets
  // one (the relay path writes SLOTS only), so what reaches it is a one-to-one
  // failure or the native-group-text aggregate. And `relay` WINS over
  // `retryScheduled` in deliveryReason (retry-send-window D8): passing
  // `rosterKind === 'relay'` here - the default roster kind, which every contact
  // page renders with - would switch the one-to-one promise off everywhere. A
  // native group text gets no stamp (D11), so its aggregate reads the plain
  // failure with no flag at all.
  const reason = delivery?.isFailure
    ? deliveryReason(msg.error_code, { media: isMms, retryScheduled: retryPromiseLive })
    : undefined;
```

(8) The per-recipient row comment (spec D12): replace (`:1272-1275`)

```tsx
            // `relay` is the second flag on exactly the same footing (D19/D21):
            // a relay leg's 30003 keeps its carrier code and drops the "will
            // retry" tail, because no relay retry is scheduled - while a native
            // group text, whose 30003 retry IS real, keeps the promise.
```

with

```tsx
            // `relay` is the second flag on exactly the same footing (D19/D21).
            // No LEG ever promises a retry: a relay leg's retry is the join's
            // own `Retrying` state, never copy keyed on the code, and a native
            // group-text leg has no retry at all (retry-send-window D11) - so
            // both read the plain "Phone unreachable (error 30003)". Neither
            // passes `retryScheduled`, which belongs to the one-to-one chip.
```

(9) The Retry gate (spec D10): replace the single line (`:1341`)

```tsx
      {delivery?.isFailure && onRetry ? (
```

with

```tsx
      {/* retry-send-window D10: no Retry while an automatic retry of this
       *  message is promised - the server refuses a manual one over the same
       *  window (409 retry_pending), and a press mid-wait was the double text. */}
      {delivery?.isFailure && onRetry && !retryPromiseLive ? (
```

(10) `StreamItem`: replace

```tsx
function StreamItem({
  item,
  onRetry,
  relayRoster,
```

with

```tsx
function StreamItem({
  item,
  onRetry,
  promiseNowMs,
  relayRoster,
```

replace

```tsx
   *  missed prop would silently disable the escalation rather than fail. */
  tickNow: number;
}): React.JSX.Element | null {
```

with

```tsx
   *  missed prop would silently disable the escalation rather than fail. */
  tickNow: number;
  /** The thread's server-clock snapshot, passed straight through to
   *  MessageBubble. Required for the same reason `tickNow` is - see its prop
   *  there. */
  promiseNowMs: number;
}): React.JSX.Element | null {
```

and replace

```tsx
          onRetry={onRetry}
          tickNow={tickNow}
          retryIndex={retryIndex}
```

with

```tsx
          onRetry={onRetry}
          tickNow={tickNow}
          promiseNowMs={promiseNowMs}
          retryIndex={retryIndex}
```

(11) The ticker comment: replace (`:2055-2057`)

```tsx
  // ARMED ONLY while some RENDERED leg can still cross the 15-minute boundary,
  // or while a LIVE RETRY RUNG for one of those legs can still resolve (D18) -
  // see `hasTickableLeg` for the six non-terminations that predicate closes.
```

with

```tsx
  // ARMED ONLY while some RENDERED leg can still cross the 15-minute boundary,
  // while a LIVE RETRY RUNG for one of those legs can still resolve (D18), or
  // while a one-to-one bubble shows a LIVE retry promise (retry-send-window D8)
  // - see `hasTickableLeg` for the seven non-terminations that predicate closes.
```

(12) The arming memo (spec D8): replace (`:2101-2104`)

```tsx
  const tickerArmed = useMemo(
    () => visible.some((i) => i.kind === 'message' && hasTickableLeg(i, tickNow, retryIndex)),
    [visible, tickNow, retryIndex],
  );
```

with

```tsx
  // retry-send-window D8: the SERVER-clock snapshot every bubble's one-to-one
  // retry promise is judged against, taken HERE, where arming is decided, and
  // handed down beside `tickNow`. One value for both, so the interval and the
  // bubbles it re-renders cannot disagree about whether a promise is live - not
  // even for a bubble re-rendered on its own by a reveal click. The browser's
  // clock would be wrong both ways: running fast, it disarms while the promise
  // is still live on the server's clock and the promise never leaves the
  // screen; running slow, it keeps the promise up for as long as the skew.
  // Re-taken on every tick and whenever the rendered set or the retry index
  // changes, so it is never older than the items it judges.
  const { armed: tickerArmed, promiseNowMs } = useMemo(() => {
    const snapshot = serverNowMs();
    return {
      armed: visible.some(
        (i) => i.kind === 'message' && hasTickableLeg(i, tickNow, retryIndex, snapshot),
      ),
      promiseNowMs: snapshot,
    };
  }, [visible, tickNow, retryIndex]);
```

(13) The `StreamItem` call site: replace (`:2532-2534`)

```tsx
                    onRetry={onRetrySurfaced}
                    tickNow={tickNow}
                    retryIndex={retryIndex}
```

with

```tsx
                    onRetry={onRetrySurfaced}
                    tickNow={tickNow}
                    promiseNowMs={promiseNowMs}
                    retryIndex={retryIndex}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/contact/Timeline.delivery.test.tsx src/routes/contact/Timeline.ticker.test.tsx src/routes/contact/Timeline.test.tsx`
Expected: PASS.

Then the whole dashboard: `cd dashboard; npx vitest run`
Expected: PASS except exactly the two Task 15 hand-offs Task 18 turns: `Timeline.email.test.tsx` `keeps the BASE 30003 copy on an outbound email failure` and `StatChips.test.tsx` `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped`.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
npm run typecheck
npx eslint dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx dashboard/src/routes/contact/Timeline.test.tsx
git status
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat(dashboard): one-to-one bubble promises a retry only while one is scheduled, hides Retry, ticks to expiry (retry-send-window D8, D10, D11, D12)

The one-to-one chip passes retryScheduled from the failed message's live
retry_due_at, judged on one server-clock snapshot the ticker memo takes and
hands to every bubble; the Retry button is hidden while it holds and the
ticker arms on it, so the promise expires on screen. A 409 retry_pending
reads its own sentence. Native group-text legs no longer promise, and the
comments that said they did are rewritten.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.delivery.test.tsx dashboard/src/routes/contact/Timeline.ticker.test.tsx dashboard/src/routes/contact/Timeline.test.tsx
```

Expected: typecheck exit 0; eslint reports no error on any line this task added or changed - in particular no `no-unused-vars` (the Timeline.delivery `EM_DASH` is gone with its last use) and no `react-hooks/exhaustive-deps` warning on the memo (every value it reads is in its deps; `serverNowMs` is a module import).

---

### Task 18: Every other reader of the 30003 copy reads the plain failure (spec D8)

**Files:**
- Test: `dashboard/src/routes/broadcasts/StatChips.test.tsx:128-138` (the DeliveryBadge 30003 promise test and its comment)
- Test: `dashboard/src/routes/contact/Timeline.email.test.tsx:89-116` (the EmailCard delivery-chip describe)
- Test: `dashboard/src/routes/broadcasts/broadcastFormat.test.ts:156-157` (the loose 30003 pin in `shareRecipientReason`'s failed-row test)
- Verify, no change: `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:36` -> `shareRecipientReason` (`dashboard/src/routes/broadcasts/broadcastFormat.ts:151-161`, which calls `deliveryReason(errorCode)` with no options); EmailCard (`dashboard/src/routes/contact/Timeline.tsx:1644-1645`, `deliveryReason(msg.error_code)` with no options); `dashboard/src/routes/broadcasts/BroadcastResults.test.tsx:138-145` (`/Phone unreachable/i`, still true).

**Interfaces:**
- Consumes: Task 15's base 30003 copy (`'Phone unreachable (error 30003)'` with no options) and `retryScheduled` (absent at every call site here); Task 13's `retry_due_at` on the dashboard message type (the EmailCard test sets it to prove the card ignores it).
- Produces: no source change. The share results row, the email card, the rollups, the rows and the spoken summaries promise nothing (spec D8): only the one-to-one bubble's message-level chip (Task 17) ever passes `retryScheduled`. Reading the failed message's live `retry_due_at` on the share row is share-skip-fix Branch B's (spec section 5).

Every dashboard test that pins "will retry" at HEAD, and where it ends up:

| test at HEAD | pin | after this slice |
| --- | --- | --- |
| `deliveryStatus.test.ts:419` `keeps the retry promise on a native group-text rollup` | positive | Task 15: `promises no retry on a native group-text rollup either` - reason `Phone unreachable (error 30003)` |
| `deliveryStatus.test.ts:738` `keeps the retry promise everywhere else - 1:1 and native group text` | positive | Task 15: `promises nothing without retryScheduled - one-to-one and native group text alike` |
| `Timeline.delivery.test.tsx:516` `keeps the retry promise on the SAME leg in a native GROUP TEXT` | positive | Task 17: `promises NO retry on the SAME leg in a native GROUP TEXT` - plain copy at chip, recital and row |
| `Timeline.delivery.test.tsx:577` `leaves the MESSAGE-LEVEL chip on the base copy, relay default notwithstanding` | positive | Task 17: the D8 set - live stamp promises and hides Retry (SMS and MMS); no stamp, expired, withdrawn or unparseable stamp reads the plain failure and offers Retry |
| `Timeline.email.test.tsx:96` `keeps the BASE 30003 copy on an outbound email failure` | positive | this task: `reads the plain 30003 failure on an outbound email - an EmailCard never promises a retry` |
| `StatChips.test.tsx:134` `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped` | positive | this task: `reads a property-send recipient 30003 as the plain failure - the row promises no retry` |
| `broadcastFormat.test.ts:157` (`toMatch(/^Phone unreachable/)`) | loose | this task: exact `Phone unreachable (error 30003)` |
| `deliveryStatus.test.ts:413`, `:730`; `:761` (rewritten by Task 15 to `lets relay win over retryScheduled...`) | negative | unchanged in meaning - still no promise on a relay leg |
| `Timeline.delivery.test.tsx:457`, `:506`, `:567`, `:980`, `:1051`, `:1074` | negative | unchanged - still pass |
| `StatChips.test.tsx:125`, `BroadcastResults.test.tsx:145` (`/Phone unreachable/i`) | loose | unchanged - still pass |

- [ ] **Step 1: Confirm the red Task 15 left**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/broadcastFormat.test.ts`
Expected: FAIL on exactly `StatChips.test.tsx` `keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped` and `Timeline.email.test.tsx` `keeps the BASE 30003 copy on an outbound email failure` (each expects "will retry"); `broadcastFormat.test.ts` passes (its 30003 pin only matches the prefix).

- [ ] **Step 2: Rewrite the expectations (spec D8)**

`dashboard/src/routes/broadcasts/StatChips.test.tsx` - replace the comment and test at `:128-138` (from `  // Slice 5a. The badge calls the shared deliveryReason with NO options, so it` through the closing `  });` of `it('keeps the retry promise on a broadcast recipient 30003 - the override is relay-scoped'`) with:

```tsx
  // retry-send-window D8. The badge renders a failed property-send row through
  // shareRecipientReason, which calls the shared deliveryReason with NO options:
  // the recipient slot carries no `retry_due_at`, so the row cannot know whether
  // a retry is scheduled and promises none - under-promising, never false.
  // Reading the failed message's live stamp is share-skip-fix Branch B's, under
  // the same rule. (This test pinned "will retry" here until the retry send
  // window: the promise was keyed on the code alone.)
  it('reads a property-send recipient 30003 as the plain failure - the row promises no retry', () => {
    const { container } = render(<DeliveryBadge status="failed" errorCode="30003" />);
    expect(container.textContent ?? '').toContain('Phone unreachable (error 30003)');
    expect(container.textContent ?? '').not.toContain('will retry');
  });
```

`dashboard/src/routes/contact/Timeline.email.test.tsx` - replace the whole describe at `:89-116` (from `describe('EmailCard (outbound delivery chip)', () => {` through its closing `});`) with:

```tsx
describe('EmailCard (outbound delivery chip)', () => {
  // The EmailCard's deliveryReason call (Timeline.tsx EmailCard) takes ONLY the
  // message - no `rosterKind`, no `media`, no `retryScheduled` - so it reads the
  // BASE copy, which since the retry send window promises nothing (D8). An
  // email is never retried automatically, and even a row that somehow carried a
  // live `retry_due_at` must not make the card promise one.
  it('reads the plain 30003 failure on an outbound email - an EmailCard never promises a retry', () => {
    renderTimeline({
      items: [
        {
          ...EMAIL_IN,
          id: 'e-fail',
          tsMsgId: '2026-06-08T09:15:00#EM124',
          direction: 'outbound',
          author: 'teammate',
          delivery_status: 'undelivered',
          error_code: '30003',
          email_from: 'team@housing.example',
          email_to: ['renter@example.com'],
          retry_due_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    expect(screen.getByText('Undelivered - Phone unreachable (error 30003)')).toBeInTheDocument();
    expect(screen.queryByText(/will retry/)).not.toBeInTheDocument();
  });
});
```

`dashboard/src/routes/broadcasts/broadcastFormat.test.ts` - replace the two lines at `:156-157`

```ts
    // The 30003 wording is the shared map's, untouched here (owned by feat/retry-send-window).
    expect(shareRecipientReason('failed', '30003')).toMatch(/^Phone unreachable/);
```

with

```ts
    // retry-send-window D8: a failed share row reads the PLAIN 30003. The slot
    // carries no retry_due_at, so the row cannot know a retry is scheduled and
    // promises none (under-promising, never false); reading the failed message's
    // live stamp is share-skip-fix Branch B's, under the same rule.
    expect(shareRecipientReason('failed', '30003')).toBe('Phone unreachable (error 30003)');
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/BroadcastResults.test.tsx`
Expected: PASS.

- [ ] **Step 4: Sweep the dashboard for any other promise reader**

Run: `git grep -n "will retry" -- dashboard/src`
Expected: every match is one of: (a) the `RETRY_SCHEDULED_REASONS` entry `'Phone unreachable - will retry'` in `deliveryStatus.ts`; (b) a comment; (c) a NEGATIVE assertion (`not.toContain('will retry')`, `queryByText(/will retry/)` ... `not.toBeInTheDocument()`); (d) a POSITIVE assertion of the one-to-one promise under a live stamp - the `retryScheduled` tests in `deliveryStatus.test.ts`, `PROMISE_TEXT` in `Timeline.delivery.test.tsx`, `PROMISE_CHIP` in `Timeline.ticker.test.tsx`. Any other positive match is a reader this slice missed: stop and fix it here. (The e2e matches are Slice D's: `relay-30003-retry.spec.ts` negatives and comments, and Task 19's new one-to-one spec.)

Run: `git grep -n "retryScheduled" -- dashboard/src ':!*.test.ts' ':!*.test.tsx'`
Expected: `deliveryStatus.ts` (the option, its docs and the chain) and exactly ONE call site that passes it, the message-level chip in `Timeline.tsx` (`deliveryReason(msg.error_code, { media: isMms, retryScheduled: retryPromiseLive })`) - plus comments.

- [ ] **Step 5: Run the whole dashboard suite - the red window Task 15 opened closes here**

Run: `cd dashboard; npx vitest run`
Expected: PASS, zero failures.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run typecheck
npx eslint dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/contact/Timeline.email.test.tsx dashboard/src/routes/broadcasts/broadcastFormat.test.ts
git status
git add dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/contact/Timeline.email.test.tsx dashboard/src/routes/broadcasts/broadcastFormat.test.ts
git commit -m "test(dashboard): every other 30003 reader reads the plain failure (retry-send-window D8)

The property-send results badge, the email card and shareRecipientReason
read 'Phone unreachable (error 30003)' with no promise: none of them knows
whether a retry is scheduled, so none promises one. The old tests that
pinned the code-keyed promise are inverted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/contact/Timeline.email.test.tsx dashboard/src/routes/broadcasts/broadcastFormat.test.ts
```

Expected: typecheck exit 0; eslint reports no error on any line this task changed (the email test's local `emDash` went with the test that used it).

### Task 19: One-to-one 30003 end-to-end proof (spec test intention 8)

**Files:**
- Create: `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts`
- Logs (gitignored, never committed): `.superpowers/gates/e2e-one-to-one.log`, `.superpowers/gates/e2e-neighbours.log`

**Interfaces:**
- Consumes:
  - Task 9: the lane seam `E2E_SEND_RETRY_BACKOFF_MS: '10000'` in `scripts/e2e-session.mjs` childEnv, read by `resolveSendRetryBackoffMs(attempt: number): number` in `app/src/jobs/retrySend.ts` (honored only when `JOBS_QUEUE_URL` is unset).
  - Task 8: every one-to-one append writes `automated` (false included).
  - Task 10: the webhook's D3a decision and `updateDeliveryStatus(sid, status, errorCode, { retryDueAt: runAt.toISOString() })` in the same conditional write as the failure, then `enqueueSendRetry(payload, runAt)`.
  - Task 11: `retrySend` appends `retry_of`, `retry_attempt`, `retry_window_start = original.retry_window_start ?? original.provider_ts` and `automated = original.automated ?? true` at append.
  - Task 12: `POST /api/conversations/:conversationId/messages/:providerSid/retry` answers `409 { error: 'retry_pending' }` while `isRetryPromiseLive(original.retry_due_at, Date.now())`.
  - Task 13: the contact-timeline projection carries `retry_due_at`.
  - Tasks 14, 15, 17: the one-to-one chip reads `Phone unreachable - will retry (error 30003)` (label prefix `Undelivered - `) while `isRetryPromiseLive(retry_due_at, serverNowMs())`, and the Retry action (accessible name `Retry sending this message`, `dashboard/src/routes/contact/Timeline.tsx:1349`) is not rendered or hidden for that time.
  - Fixtures: `setDeliveryOutcome`, `getOutboundTo` (`e2e/fixtures/fakeTwilio.ts:201-211`, `:354-373`); `reseed` (`e2e/fixtures/reseed.ts`); `expectTodayReady` (`e2e/support/today.ts`).
  - Route read for stored lineage: `GET /api/conversations/:conversationId/messages` returns raw `MessageItem` rows (`app/src/routes/api.ts:2148-2175`).
- Produces: one Playwright test in the new file; no exported symbols.

How the pieces meet (verified at `fd38ba73`):
- Failing a send: `setDeliveryOutcome` arms the NEXT message to one destination (`fake-twilio/src/engine/engine.ts:166-172`, a `Map.set` per number, consumed and deleted at `:463-464`). A `fail` profile plans queued -> sent -> `failState` (`fake-twilio/src/engine/delivery.ts:8-21`) at 0 / 150 / 300 ms (`:30-32`); every state after `queued` is POSTed as a signed status callback to `/webhooks/twilio/status`, carrying `ErrorCode` on the fail state (`engine.ts:501-533`, the code at `:512`). The app resolves the SID (`app/src/routes/webhooks/twilio.ts:3150`), writes the status (`:3251`, which Task 10 turns into the D3a-decided write), emits `message.persisted` on the transition (`:3295`) and runs the 30003 arm (`:3350-3369`). This is the same arming `relay-30003-retry.spec.ts:158-161` uses.
- Sending a one-to-one text: the contact page's composer, `getByRole('textbox', { name: 'Reply message' })` + `getByRole('button', { name: 'Send', exact: true })` (`e2e/support/selectors.md:44-45`), posts to `POST /api/conversations/conv-0001/messages` (`app/src/routes/api.ts:1234`), which sends `automated: false` (`:1436`). `inbox-comms.spec.ts:46-49` and `message-transport-fidelity.spec.ts:329-331` drive the same composer.
- Live updates: the contact timeline refetches on `message.persisted` with a 300 ms debounce (`dashboard/src/routes/contact/useContactTimeline.ts:109`, `:541-547`), so nothing is reloaded. A row whose `retry_of` names a message hides that message (`dashboard/src/routes/contact/Timeline.tsx:1971-1984`).
- The Retry action renders on every failed one-to-one bubble OUTSIDE the reveal (`Timeline.tsx:1341-1353`; `.retry` has no display rule, `Timeline.module.css:349-360`), so no click is needed to see it.
- Sign-in and data: the `Continue as dev user` button (`dashboard/src/routes/Login.tsx:89`) + `expectTodayReady`; `reseed(request)` posts the LEAN `/__dev/reseed` and logs the browser out, so it runs BEFORE sign-in.
- The recipient: the lean seed's `conv-0001` (Tasha Nguyen, `contact-tenant-0001`, `+15550100001`, `app/src/lib/seed/lean.ts:255-267`), which carries no `ai_mode` and so reads as auto (`app/src/services/scheduledSendSuppression.ts:36-38`), and whose contact has consent (`lean.ts:131-132`). NEVER `conv-0002` / `contact-tenant-0002` (Dario, switched off on purpose; `lean.ts:178-187` forbids him as the recipient of any automated text or retry) (spec D13).

Decisions (spec D13):
- Reseed BEFORE the test: `contact-detail.spec.ts:216-227` toggles Tasha's Do Not Contact and clears it, inbox specs text her, and any scheduled automated text left pending by an earlier spec would consume the one-shot arming on her handset. The lean reseed makes every precondition hold whatever ran first.
- Reseed AFTER the file, plus a disarm. Not for the reason `share-skip-fix.spec.ts:33-40` gives (inbox order): `conv-0001` is already the newest conversation row (`lean.ts:18-20`, `:260`) and a send keeps it newest. The reasons are failure hygiene: (1) a run that fails before its send leaves the 30003 arming unconsumed on a handset a dozen specs text, and a reseed does not touch the fake (only `/control/reset` clears arms, `e2e/support/preflight.ts:152-158`, `engine.ts:173-186`), so the spec re-arms `normal`, which replaces a pending profile (`engine.ts:171`); (2) a run that fails during the wait leaves a `messaging.retrySend` job pending in the app process - after the reseed that job finds no original and sends nothing (`app/src/jobs/retrySend.ts:112-116`) instead of texting Tasha inside the next spec; (3) it removes the failed control bubble this spec leaves.
- No other spec is disturbed: every spec that reads Tasha's thread (`inbox.spec.ts`, `inbox-comms.spec.ts`, `inbox-markread.spec.ts`, `contact-detail.spec.ts`, `comms-clickable-links.spec.ts`, `outbound-mms.spec.ts`, `mms-transcode.spec.ts`, `inbound-media-type.spec.ts`, `message-transport-fidelity.spec.ts`) adds its own run-unique bodies and filters by them; none asserts a Retry action, a 30003 chip or her thread's exact contents, and the only `getOutboundTo` reader of her number filters by `since` and body (`message-transport-fidelity.spec.ts:336-344`).
- The Retry action's absence is asserted ONLY together with the promise text, in one filtered locator, plus a positive control (a 30007 failure, never retried, spec section 8) that proves the same name IS found. A separate `toHaveCount(0)` would re-resolve onto the delivered retry's bubble once the retry collapse hides the original, and pass vacuously.
- Run commands. Root `npm run e2e` re-invokes npm (`package.json:41`), whose option parser eats `--grep`; use the e2e WORKSPACE form, `npm run e2e -w @housingchoice/e2e -- <spec paths>` (`e2e/package.json:7`, `playwright test`), which boots its own hermetic lane or reuses a live `e2e:session` of THIS worktree (`e2e/playwright.config.ts:26-52`). The full suite is Task 21's `timeout 1500 npm run e2e`.

This spec is written after Tasks 1-18 landed, so its first run is expected GREEN. Its red state is the code on `main`: there the chip reads `Phone unreachable` + an em dash + ` will retry (error 30003)` keyed by the code alone, WITH a Retry action and no `retry_due_at`, so Assert 1 (hyphen copy), Assert 2 and Assert 3 all fail.

- [ ] **Step 1: Confirm the seam, the copy and the Retry name are in the tree**

Run (Git Bash, worktree root):

```bash
rg -n "E2E_SEND_RETRY_BACKOFF_MS" scripts/e2e-session.mjs app/src/jobs/retrySend.ts
rg -n "Phone unreachable - will retry" dashboard/src/routes/contact/deliveryStatus.ts
rg -n "unreachable \x{2014}" dashboard/src
rg -n "Retry sending this message" dashboard/src/routes/contact/Timeline.tsx
rg -n "retry_pending" app/src/routes/api.ts dashboard/src/routes/contact/Timeline.tsx
rg -n "will retry|Phone unreachable" e2e/tests e2e/scenarios
```

Expected: the seam in both files (the childEnv entry `'10000'` beside `E2E_RELAY_RETRY_BACKOFF_MS`, and its read in `resolveSendRetryBackoffMs`); the hyphenated promise copy in `deliveryStatus.ts` (Task 15); NO hit for the em-dash form anywhere under `dashboard/src` (spec D8: touched copy is ASCII); the Retry aria-label still present (Task 17 keeps the name); `retry_pending` in the route (Task 12) and in `sendFailureMessage` (Task 17); in the e2e tree only `relay-30003-retry.spec.ts` (its `not.toContainText('will retry')` guards and its recital string). If any is missing, the owning task (9, 12, 15 or 17) is not done - stop and finish it first.

- [ ] **Step 2: Write the spec (spec test intention 8; D3a, D6, D7, D8, D10, D13, D14)**

Create `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { getOutboundTo, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { reseed } from '../../fixtures/reseed.js';
import { expectTodayReady } from '../../support/today.js';

// A ONE-TO-ONE 30003 PROMISES ITS RETRY WITH THE FAILURE, HIDES THE RETRY
// ACTION FOR THE WAIT, AND THE RETRY'S OWN BUBBLE REPLACES THE FAILED ONE -
// test intention 8 of docs/superpowers/specs/2026-09-24-retry-send-window-design.md
// (D3a, D6, D7, D8, D10, D13, D14). No one-to-one retry spec existed before
// this file; the relay ladder has its own (relay-30003-retry.spec.ts).
//
// WHAT IS UNDER TEST. A staff text from the contact page that the carrier
// reports `undelivered` with ErrorCode 30003. The status webhook decides
// whether a retry will be attempted BEFORE it writes the failure (D3a) and
// writes the failure and `retry_due_at` in ONE conditional write (D7), so the
// transition's single SSE carries both. The bubble must therefore read
// "Phone unreachable - will retry (error 30003)" the first time it reads as a
// failure at all - never a plain failure that later turns into a promise
// (spec section 1) - and must offer NO Retry action while that retry is
// scheduled (D10). The page is never reloaded: every state below arrives over
// SSE, which is the path under test. The contact page renders the chip with
// the Timeline's DEFAULT rosterKind ('relay'), which is exactly why the
// one-to-one chip must never pass the `relay` flag (D8).
//
// When the backed-off `messaging.retrySend` job sends, its row carries
// `retry_of` from the moment it is appended (D6), and the Timeline's retry
// collapse hides the original, so the thread keeps ONE bubble for the body:
// the retry's, delivered.
//
// THE RECIPIENT IS THE LEAN SEED'S TASHA NGUYEN (contact-tenant-0001,
// conv-0001) AND NEVER DARIO REYES (contact-tenant-0002, conv-0002), whose
// thread is switched off on purpose and whom the seed forbids as the
// recipient of any automated text or retry (spec D13, app/src/lib/seed/lean.ts).
// conv-0001 carries no `ai_mode`, which reads as auto. A composer send is a
// person's send, so its retry goes out as a person's send too (D14); the
// manual-mode half of D14 and every declined retry are proven below this
// layer (D13).
//
// THE LANE SHORTENS THE BACKOFF. E2E_SEND_RETRY_BACKOFF_MS (10000 in
// scripts/e2e-session.mjs's childEnv, read by resolveSendRetryBackoffMs in
// app/src/jobs/retrySend.ts, ignored whenever JOBS_QUEUE_URL is set) replaces
// the 60 s first rung, so the retry goes out ten seconds after the failure.
// That value is also this file's observation window for the promise. The
// stored `retry_due_at` is checked against it, so a lane booted without the
// seam fails with a message that names it instead of timing out. If the
// promise assertions ever go flaky, raise the lane value (and the relay one
// beside it) - NEVER weaken the assertions, which are the point of the file.
//
// ARMING IS ONE-SHOT PER DESTINATION (fixtures/fakeTwilio.ts
// setDeliveryOutcome): the armed 30003 is consumed by the original send, so
// the retry to the same handset runs the normal queued -> sent -> delivered
// progression with no second call.
//
// THE RETRY ACTION'S ABSENCE MEANS SOMETHING ONLY AT THE SAME INSTANT AS THE
// PROMISE. The action is not behind the bubble's reveal (it renders on every
// failed one-to-one bubble with no live promise), but once the retry lands the
// failed bubble is hidden, and a lazily re-resolved locator would find the
// delivered retry's bubble - which has no action either. So the absence is
// asserted in ONE locator filtered on the promise text AND on the action, and
// a positive control at the end proves the same accessible name IS found on a
// failed bubble that promises nothing: a 30007, which is never retried.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The lean seed's Tasha and her one-to-one thread. NEVER Dario - see above. */
const TASHA = {
  contactId: 'contact-tenant-0001',
  conversationId: 'conv-0001',
  phone: '+15550100001',
} as const;

/** MessageBubble's Retry action (Timeline.tsx); visible text is a glyph + "Retry". */
const RETRY_BUTTON = 'Retry sending this message';
/** The one-to-one chip while a retry is scheduled: the delivery label, then the
 *  reason with the template's code tail (spec section 7 copy). */
const PROMISE_CHIP = 'Undelivered - Phone unreachable - will retry (error 30003)';
/** The base 30003 reason, which promises nothing (spec D8). */
const PLAIN_30003 = 'Phone unreachable (error 30003)';
/** The control failure: 30007 is never retried (spec section 8). */
const CONTROL_CHIP = 'Undelivered - Carrier filtered the message (error 30007)';
/** E2E_SEND_RETRY_BACKOFF_MS on the lane (scripts/e2e-session.mjs). */
const LANE_BACKOFF_MS = 10_000;
/** Production's first one-to-one rung (retryBackoffMs(1), app/src/jobs/retrySend.ts). */
const PRODUCTION_FIRST_RUNG_MS = 60_000;

/** The stored fields this file reads. GET /api/conversations/:id/messages
 *  returns raw MessageItem rows, newest first. */
interface StoredMessage {
  tsMsgId: string;
  body?: string;
  provider_sid: string;
  provider_ts: string;
  delivery_status: string;
  error_code?: string;
  retry_of?: string;
  retry_attempt?: number;
  retry_window_start?: string;
  retry_due_at?: string;
  automated?: boolean;
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** Tasha's stored rows whose body is exactly `body` (the reseed keeps her
 *  thread far shorter than one page). */
async function storedRows(request: APIRequestContext, body: string): Promise<StoredMessage[]> {
  const res = await request.get(`${NEXT}/api/conversations/${TASHA.conversationId}/messages?limit=100`);
  expect(res.ok(), `messages fetch failed: ${res.status()}`).toBeTruthy();
  const { messages } = (await res.json()) as { messages: StoredMessage[] };
  return messages.filter((m) => m.body === body);
}

/** Every rendered bubble carrying `body`. A bubble is a bare div with no role,
 *  name or test id; its body text is the only addressable thing in it and its
 *  parent is the bubble (selectors.md, the meta-reveal row). PLURAL on purpose:
 *  for a beat during a send the optimistic bubble can sit beside the server's. */
function bubblesWithBody(page: Page, body: string): Locator {
  return page.getByText(body, { exact: true }).locator('xpath=..');
}

/** Send `body` from the open contact page's composer - a person's send. */
async function sendFromComposer(page: Page, body: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Reply message' });
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

// A clean lean world first: an earlier spec can leave Tasha opted out or a
// scheduled text aimed at her handset, which would eat the one-shot arming.
test.beforeEach(async ({ request }) => {
  await reseed(request);
});

// Failure hygiene for the specs after this file. A run that died before its
// send leaves the arming unconsumed (a reseed never touches the fake; re-arming
// `normal` replaces a pending profile), and a run that died during the wait
// leaves a retry job pending - after the reseed it finds no original to retry.
test.afterAll(async ({ request }) => {
  await setDeliveryOutcome(request, { partyNumber: TASHA.phone, profile: { kind: 'normal' } });
  await reseed(request);
});

test('a one-to-one 30003 promises its retry with the failure and hides Retry, then the retry replaces the failed bubble', async ({
  page,
  request,
}) => {
  test.slow(); // reseed + sign-in + the lane backoff + a second send for the control.
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${TASHA.contactId}`);
  await expect(page.getByRole('region', { name: 'Communications and activity' })).toBeVisible({
    timeout: 15_000,
  });

  // --- Arrange: the NEXT message to Tasha's handset fails 30003. ---
  await setDeliveryOutcome(request, {
    partyNumber: TASHA.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30003' },
  });

  // --- Act: a staff text from her contact page. ---
  const token = `one-to-one-30003-${Date.now()}`;
  await sendFromComposer(page, token);
  const bubbles = bubblesWithBody(page, token);

  // --- Assert 1: the promise arrives WITH the failure (spec section 1, D7).
  //     A tight, flat cadence samples the bubble from the send until the
  //     promise shows; any sample that shows the PLAIN 30003 first is the
  //     "plain failure that later turns into will retry" the ruling forbids.
  //     A sampled negative, not a proof - a regression tripwire. ---
  let sawPlainFailure = false;
  await expect
    .poll(
      async () => {
        const texts = await bubbles.allTextContents();
        if (texts.some((t) => t.includes(PLAIN_30003))) sawPlainFailure = true;
        return texts.some((t) => t.includes(PROMISE_CHIP));
      },
      {
        timeout: 20_000,
        intervals: [100],
        message:
          'the bubble never read "Phone unreachable - will retry (error 30003)" - is the 30003 arm ' +
          'stamping retry_due_at (D7) and the Timeline passing retryScheduled (D8)?',
      },
    )
    .toBe(true);
  expect(
    sawPlainFailure,
    'the bubble showed the plain 30003 before its promise - the failure and retry_due_at must land ' +
      'in ONE write (D7) and the screen must never turn a plain failure into "will retry"',
  ).toBe(false);

  // --- Assert 2: NO Retry action while the retry is scheduled (D10), taken
  //     at the SAME instant as the promise text: one locator, both filters. ---
  const promised = bubbles
    .filter({ hasText: PROMISE_CHIP })
    .filter({ hasNot: page.getByRole('button', { name: RETRY_BUTTON }) });
  await expect(
    promised,
    'a one-to-one bubble promising a retry must offer NO Retry action at the same instant (D10)',
  ).toHaveCount(1);

  // --- Assert 3: the stored failure carries the stamp, one LANE backoff out
  //     (D7, D13), and a Retry pressed during the wait - a stale tab, since
  //     the live screen hides the action - is refused on the server's clock
  //     (D10). Rows are picked by lineage, never by count, so a retry that
  //     lands early cannot break the read. ---
  const original = (await storedRows(page.request, token)).find((m) => m.retry_of === undefined);
  if (original === undefined) throw new Error('the failed original is not stored in conv-0001');
  expect(original.delivery_status).toBe('undelivered');
  expect(original.error_code).toBe('30003');
  expect(original.automated, "a composer text is a person's send (D14)").toBe(false);
  const originMs = Date.parse(original.provider_ts);
  const dueMs = Date.parse(original.retry_due_at ?? '');
  expect(Number.isNaN(dueMs), 'the failed row carries no parseable retry_due_at (D7)').toBe(false);
  expect(dueMs - originMs, 'retry_due_at must sit at least one lane backoff after the send').toBeGreaterThanOrEqual(
    LANE_BACKOFF_MS,
  );
  expect(
    dueMs - originMs,
    'retry_due_at sits a PRODUCTION rung out - is E2E_SEND_RETRY_BACKOFF_MS set on this lane (Task 9)?',
  ).toBeLessThan(PRODUCTION_FIRST_RUNG_MS);
  const pressed = await page.request.post(
    `${NEXT}/api/conversations/${TASHA.conversationId}/messages/${original.provider_sid}/retry`,
  );
  expect(pressed.status(), 'a Retry pressed while a retry is scheduled must be refused (D10)').toBe(409);
  expect(await pressed.json()).toMatchObject({ error: 'retry_pending' });

  // --- Assert 4: after the lane backoff the retry's OWN bubble replaces the
  //     failed one: one bubble for the body, delivered, no failure, no action. ---
  await expect(
    bubbles.getByText('Delivered', { exact: true }),
    'the automatic retry never delivered into the thread (lane backoff 10 s)',
  ).toBeVisible({ timeout: 45_000 });
  await expect(bubbles).toHaveCount(1);
  const retryBubble = bubbles.first();
  await expect(retryBubble).not.toContainText('Undelivered');
  await expect(retryBubble).not.toContainText('Phone unreachable');
  await expect(retryBubble.getByRole('button', { name: RETRY_BUTTON })).toHaveCount(0);

  // --- Assert 5: the carrier's own view - exactly two legs, the original 30003
  //     and ONE automatic retry. The screen cannot prove "no duplicate send". ---
  const legs = (await getOutboundTo(request, { to: TASHA.phone })).filter((m) => m.body === token);
  expect(
    legs.map((m) => m.state),
    'the handset must have received the body exactly twice: the original 30003, then the retry',
  ).toEqual(['undelivered', 'delivered']);
  expect(legs[0]?.errorCode).toBe('30003');

  // --- Assert 6: the replacing row IS the retry, lineage written at append:
  //     retry_of, attempt 1, the window origin carried from the original's
  //     send (D2, D6), a person's send retried as one (D14), and sent no
  //     earlier than its stamped run time (D7: retry_due_at is the run time;
  //     provider_ts is second-truncated, hence the one-second allowance). ---
  const rows = await storedRows(page.request, token);
  expect(
    rows,
    'exactly the original and ONE retry row - a third row means the Retry pressed during the wait was NOT refused (D10)',
  ).toHaveLength(2);
  const retry = rows.find((m) => m.retry_of !== undefined);
  if (retry === undefined) throw new Error('no stored row carries retry_of');
  expect(retry.retry_of).toBe(original.tsMsgId);
  expect(retry.retry_attempt).toBe(1);
  expect(retry.retry_window_start, 'the retry measures its window from the original send (D2)').toBe(
    original.provider_ts,
  );
  expect(retry.automated, "a person's text is retried as a person's send (D14)").toBe(false);
  expect(retry.delivery_status).toBe('delivered');
  expect(Date.parse(retry.provider_ts), 'the retry went out before its stamped run time').toBeGreaterThanOrEqual(
    dueMs - 1_000,
  );

  // --- Assert 7: POSITIVE CONTROL for Assert 2. A failure with no scheduled
  //     retry (30007, never retried) shows the SAME action under the SAME name,
  //     so Assert 2's absence could have failed. Do NOT press it. ---
  await setDeliveryOutcome(request, {
    partyNumber: TASHA.phone,
    profile: { kind: 'fail', failState: 'undelivered', errorCode: '30007' },
  });
  const control = `one-to-one-30007-control-${Date.now()}`;
  await sendFromComposer(page, control);
  const controlBubble = bubblesWithBody(page, control).filter({ hasText: CONTROL_CHIP });
  await expect(controlBubble, 'the control text never failed with 30007').toHaveCount(1, { timeout: 15_000 });
  await expect(controlBubble.getByRole('button', { name: RETRY_BUTTON })).toBeVisible();
  await expect(controlBubble).not.toContainText('will retry');
});
```

- [ ] **Step 3: ASCII, typecheck and lint the new file**

Run (Git Bash, worktree root), one command per call:

```bash
tr -d '\11\12\15\40-\176' < e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts | wc -c
npm run typecheck -w @housingchoice/e2e
npx eslint e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts
```

Expected: `0`; typecheck exit 0 (`noUncheckedIndexedAccess` is on, which is why the rows are narrowed with explicit `undefined` checks); eslint exit 0 with no output (every import is used).

- [ ] **Step 4: Run just this spec on a fresh hermetic lane**

A session booted before Task 9's commit lacks the seam, and `npm run e2e:restart` cannot add it: the launcher builds `childEnv` once at start (`scripts/e2e-session.mjs:109`, spawned with it at `:502`) and a restart re-spawns children under that same launcher (`scripts/e2e-restart.mjs:1-3`); the preflight also refuses a stack booted at an older commit (`e2e/support/preflight.ts:104-128`). So stop any session this worktree has, then run the spec through the e2e workspace (it boots its own lane). One command per call; nothing may follow the run on its line:

```bash
mkdir -p .superpowers/gates
npm run e2e:stop
timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/one-to-one-30003-retry.spec.ts > .superpowers/gates/e2e-one-to-one.log 2>&1
```

The third call's exit code is the verdict (0). Then read the log: `rg -n "passed|failed|Error:" .superpowers/gates/e2e-one-to-one.log`.
Expected: `1 passed`. A failure message names the decision it pins (D7 stamp, D8 copy, D10 guard, the seam). If the run is aborted (exit 124 or killed), do the lane-port check in Task 21 Step 5 before running anything else.

Interactive alternative (diagnosis or self-QA; never while a full suite runs in this worktree):
1. `npm run e2e:session` with `run_in_background`, and wait for its `ready` line.
2. Print the lane URLs: `node -e "const s=JSON.parse(require('fs').readFileSync('e2e/.artifacts/lane.json','utf8'));console.log(JSON.stringify(s.urls))"`.
3. The same workspace command as above now REUSES this live lane (`e2e/playwright.config.ts:26-52`).
4. By hand with the project Playwright MCP (bundled Chromium, `--isolated`, starts logged out): `curl -s -X POST <dashboard>/__dev/reseed`; arm with `curl -s -X POST <fake>/control/delivery-outcome -H 'content-type: application/json' -d '{"partyNumber":"+15550100001","profile":{"kind":"fail","failState":"undelivered","errorCode":"30003"}}'`; in the MCP browser open `<dashboard>/`, click `Continue as dev user`, open `<dashboard>/contacts/contact-tenant-0001`, type a unique body into `Reply message`, click `Send`; snapshot: the bubble chip reads `Undelivered - Phone unreachable - will retry (error 30003)` and the bubble has no `Retry sending this message` button; wait 12 s; snapshot: ONE bubble for that body, reading `Delivered`. Use only the lane URLs from step 2 - never :5174 / :8080.
5. `npm run e2e:stop` when done.

- [ ] **Step 5: Run it with the two specs it must not break (spec test intention 8)**

```bash
timeout 1200 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/one-to-one-30003-retry.spec.ts tests/dashboard-next/relay-30003-retry.spec.ts tests/dashboard-next/share-skip-fix.spec.ts > .superpowers/gates/e2e-neighbours.log 2>&1
```

Exit code 0; `rg -n "passed|failed" .superpowers/gates/e2e-neighbours.log`.
Expected: `5 passed` (1 here, 1 relay, 3 share-skip-fix). The relay spec still asserts `will retry` nowhere on a relay bubble; nothing it reads changed except the base wording it never pinned.

- [ ] **Step 6: Commit**

```bash
git status
git add e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts
git commit -m "test(e2e): one-to-one 30003 promises its retry with the failure, hides Retry, then the retry replaces it (retry-send-window)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts
```

Expected: `git status` shows only the new spec as untracked before the add (the logs are under the gitignored `.superpowers/`). Do not commit while any e2e run is in flight.

---

### Task 20: Issues, selectors and the relay spec comment (spec header table, D11, D12, section 9)

**Files:**
- Modify: `docs/issues/group-text-30003-leg-retry-promise-unverified.md` (frontmatter lines 6-10; Resolution inserted above line 13)
- Modify: `docs/issues/quiet-hours-ungated-automated-paths.md` (frontmatter lines 9-10; insert after line 51)
- Modify: `docs/issues/ai-mode-switch-gates-all-automation.md` (frontmatter lines 8-9; insert after line 60)
- Modify: `docs/issues/manual-retry-double-send-residual-windows.md` (frontmatter lines 8-9; lines 28-29; line 47)
- Modify: `e2e/support/selectors.md` (row 48; row 49; new row after 49)
- Modify: `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (lines 20-23, comment only)

**Interfaces:**
- Consumes (names only, from the skeleton contract): `retry_due_at`, `retry_window_start`, `relay_retry_window_start`, `automated`, `recipient_contact_id`; close code `retry_window_closed`; outcomes `window_closed`, `gate_refused`; `RETRY_SEND_WINDOW_MS` (`app/src/lib/retrySendWindow.ts`); `app/src/services/oneToOneRetryDecision.ts`; `dashboard/src/routes/contact/retryPromise.ts`; copy `Phone unreachable (error 30003)`, `Phone unreachable - will retry (error 30003)`, `Not retried - message too old`, `A retry is already scheduled for this message.`; the seam `E2E_SEND_RETRY_BACKOFF_MS`.
- Produces: no code. Documentation only.

Dates: every `2026-09-25` below is the day this plan was written. If `date +%F` prints a later day when the task runs, write that day instead in every frontmatter `updated:` / `resolved:` value and every bold date this task adds.

Spec section 9's residuals and where each is recorded after this task:

| residual (spec section 9) | record |
|---|---|
| Manual double send (late job, stale tab, pending outcome) + section 5's joint `unresolved` gap | `manual-retry-double-send-residual-windows` (Step 5 reconciles it) |
| Pending reconcile copy | accepted in the spec; carried as section 5 requirements 3-4 for reconcile's `retrySend` adoption (handback) |
| A promise with nothing behind it (breaker refusal, fail-open refused, job-time decline, failed correction write, a crash or throw between the stamped write and the enqueue, a provider error on the retry's own send) | accepted in the spec; handback lists it |
| A relay claim fault (`claim_failed`) | accepted, predates this branch; handback lists it |
| A human action reversed inside the backoff (D3) | accepted in the spec; handback lists it |
| A relay leg's slot written before its claim decides (section 1) | accepted in the spec; handback lists it |
| No usable origin (D5) | accepted in the spec; handback lists it |
| A text sent before this deploy (D14) | accepted in the spec; handback lists it |

- [ ] **Step 1: Close `group-text-30003-leg-retry-promise-unverified` (spec header table: closes; D8, D11, D12)**

In `docs/issues/group-text-30003-leg-retry-promise-unverified.md`, replace:

```
status: open
area: dashboard/messaging
created: 2026-09-01
updated: 2026-09-01
refs: app/src/services/sendMessage.ts:293, app/src/routes/webhooks/twilio.ts:2408, app/src/routes/webhooks/twilio.ts:2567, app/src/services/groupReceipts.ts:336, app/src/services/groupReceipts.ts:422, dashboard/src/routes/contact/deliveryStatus.ts:597, dashboard/src/routes/contact/Timeline.delivery.test.tsx:517
---

**Problem.** The "will retry" tail on a native group-text 30003 is FALSE, at
```

with:

```
status: resolved
area: dashboard/messaging
created: 2026-09-01
updated: 2026-09-25
resolved: 2026-09-25
refs: app/src/services/sendMessage.ts:293, app/src/routes/webhooks/twilio.ts:2408, app/src/routes/webhooks/twilio.ts:2567, app/src/services/groupReceipts.ts:336, app/src/services/groupReceipts.ts:422, dashboard/src/routes/contact/deliveryStatus.ts:597, dashboard/src/routes/contact/Timeline.delivery.test.tsx:517, app/src/services/oneToOneRetryDecision.ts, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
---

**Resolution (2026-09-25, `feat/retry-send-window`, spec
`docs/superpowers/specs/2026-09-24-retry-send-window-design.md` D8, D11, D12).
Closed: no native group text promises a retry any more, at either level.** The
promise no longer follows the error code at all. "will retry" is shown only on
a ONE-TO-ONE bubble whose failed message carries a live `retry_due_at` - the
stamp the status webhook writes, in the same conditional write as the failure,
only when it has decided a retry will be attempted (D3a, D7). Every other 30003
reads the base wording, "Phone unreachable (error 30003)" (`ERROR_CODE_REASONS`
in `dashboard/src/routes/contact/deliveryStatus.ts`), so the group-text leg
row, the rollup and the message-level chip - whose code can be leg-derived
through `rollUpAggregate`, as traced below - all state the failure and promise
nothing. Server side, the one-to-one 30003 arm no longer schedules a retry for a
`group_text` conversation whenever its conversation read succeeds (D11, one
WARN, `app/src/services/oneToOneRetryDecision.ts`); if that read fails the
decision fails open and the job's `sendMessage` still refuses the send
(`GroupTextSendNotSupportedError`), as before. The tests that pinned the
carve-out were INVERTED, not deleted (`deliveryStatus.test.ts`,
`Timeline.delivery.test.tsx`), and the comments that carried the old rationale
were rewritten (D12). The axis question under "Suggested fix" is settled by D8's
rule rather than by a `leg` option: a promise follows a SCHEDULED retry, never a
code or a product. The rollup still copies the worst leg's code onto a
group-text message row; that is now harmless (it carries no promise). A real
retry for native group texts stays out of scope (spec section 8).

**Problem.** The "will retry" tail on a native group-text 30003 is FALSE, at
```

- [ ] **Step 2: Annotate `quiet-hours-ungated-automated-paths` item 3 (spec header table: annotate; D1-D5, D14)**

In `docs/issues/quiet-hours-ungated-automated-paths.md`, replace:

```
updated: 2026-09-02
refs: app/src/jobs/relayNumberReady.ts:171, app/src/services/relayQueuedMessages.ts, app/src/jobs/retrySend.ts:73, app/src/jobs/relayRetryLeg.ts
```

with:

```
updated: 2026-09-25
refs: app/src/jobs/relayNumberReady.ts:171, app/src/services/relayQueuedMessages.ts, app/src/jobs/retrySend.ts:73, app/src/jobs/relayRetryLeg.ts, app/src/lib/retrySendWindow.ts
```

Then replace:

```
   one rung, which does not extend the bound.

None of these is a regression from the quiet-hours build (its exempt-files rule
```

with:

```
   one rung, which does not extend the bound.

   **2026-09-25 (feat/retry-send-window): automatic retries now END 15 minutes
   after the original send.** The ~7-minute bound above held only when the
   failure was reported promptly; a carrier can report 30003 hours or days
   after the send, and either retry path then re-sent that late. Both paths now
   refuse any automatic retry that would go out more than 15 minutes after the
   original message went out (`RETRY_SEND_WINDOW_MS`,
   `app/src/lib/retrySendWindow.ts`; spec
   `docs/superpowers/specs/2026-09-24-retry-send-window-design.md` D1-D5). The
   decision is made when the failure arrives, with a minute of grace for queue
   delay, and checked again right before the send - including the relay job's
   transient re-enqueue and its bounded token-bucket wait. So a retry can enter
   quiet hours only when the original went out within 15 minutes of
   quiet-start, which strengthens the "accept" recommendation for item 3. Also
   since that branch the one-to-one retry is no longer always
   `automated: true`: it is sent with the original's flag (spec D14), so a
   person's text is retried as a person's send.

None of these is a regression from the quiet-hours build (its exempt-files rule
```

- [ ] **Step 3: Annotate `ai-mode-switch-gates-all-automation` item 3 (spec header table: delivers it for the 30003 retry; D14)**

In `docs/issues/ai-mode-switch-gates-all-automation.md`, replace:

```
created: 2026-09-24
refs: app/src/services/sendMessage.ts, app/src/services/scheduledSendSuppression.ts, app/src/lib/import/apply.ts
```

with:

```
created: 2026-09-24
updated: 2026-09-25
refs: app/src/services/sendMessage.ts, app/src/services/scheduledSendSuppression.ts, app/src/lib/import/apply.ts, app/src/jobs/retrySend.ts, app/src/services/oneToOneRetryDecision.ts
```

Then replace:

```
3. A retry follows the original sender: a message a person sent is retried to
   exhaustion regardless of any AI or automation setting.
```

with:

```
3. A retry follows the original sender: a message a person sent is retried to
   exhaustion regardless of any AI or automation setting.
   **Delivered for the one-to-one 30003 retry (2026-09-25,
   `feat/retry-send-window`, spec D14).** Every one-to-one send now records on
   its message row whether it was automated (`automated`, true or false) and,
   when the caller named a recipient, that contact (`recipient_contact_id`).
   The automatic retry is sent with the original's flag and recipient, and the
   status webhook judges whether to schedule it the same way: a person's text
   is retried as a person's send - manual mode and the breaker do not apply,
   the consent gate does - to exhaustion inside the 15-minute retry window
   (Cameron's ruling, same branch), and an automated original is retried
   automated and breaker-metered, as before. The manual Retry route passes the
   recorded recipient too. A text sent before that deploy carries no flag and
   is retried as before (automated, recipient by phone). Everything else here
   stays Work Package 2's - including, under item 2, the automatic retry of an
   AUTOMATED original (a tour reminder, the missed-call text), which still
   stops on a manual-mode thread.
```

- [ ] **Step 4: Leave `relay-retry-stranded-claim-window` unchanged (spec header table; D3)**

A declined rung is appended already closed in the claim's single append transaction (spec D3, Task 4), so the claim adds no new stranding site and the issue needs no edit. Confirm nothing touched it:

```bash
git diff --stat -- docs/issues/relay-retry-stranded-claim-window.md
```

Expected: no output.

- [ ] **Step 5: Reconcile `manual-retry-double-send-residual-windows` with spec section 9 (draft 7)**

Checked against spec section 9 ("Manual double send") and section 5 (the joint gap): the issue matches - its gaps 1-3 are section 9's three windows (a late job; a stale tab on a replaced original; a pending outcome unless requirement 3 is honored), gap 4 is section 5's joint `unresolved` gap, and its second paragraph is section 9's "no Retry can find the failure without its promise". Three edits, none of substance:
(a) the reconcile revision named in "Suggested fix" is stale - spec section 5 names revision 5 @`616d120d`;
(b) gap 2 gains the qualifier the guard implies: before the promise expires the route refuses the stale tab's press (D10; `one-to-one-30003-retry.spec.ts` Assert 3 proves it), so the gap opens only after `retry_due_at + RETRY_PROMISE_GRACE_MS`;
(c) the refs carried `f49a2fe9` line numbers this branch moves; they become paths.
"(spec D7, draft 6)" stays: D7's same-write rule was introduced in draft 6 and is unchanged in draft 7.

In `docs/issues/manual-retry-double-send-residual-windows.md`, replace:

```
created: 2026-09-24
refs: app/src/routes/api.ts:1564, app/src/routes/webhooks/twilio.ts:3251, app/src/routes/webhooks/twilio.ts:3350, app/src/jobs/retrySend.ts:112, dashboard/src/routes/contact/Timeline.tsx:1341, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
```

with:

```
created: 2026-09-24
updated: 2026-09-25
refs: app/src/routes/api.ts, app/src/services/oneToOneRetryDecision.ts, app/src/routes/webhooks/twilio.ts, app/src/jobs/retrySend.ts, app/src/lib/retrySendWindow.ts, dashboard/src/routes/contact/retryPromise.ts, dashboard/src/routes/contact/Timeline.tsx, docs/superpowers/specs/2026-09-24-retry-send-window-design.md
```

Replace:

```
2. A stale browser tab retrying an original that an automatic retry has already
   replaced (the live screen hides replaced bubbles).
```

with:

```
2. A stale browser tab retrying, once the promise has expired, an original that
   an automatic retry has already replaced (the live screen hides replaced
   bubbles; before the promise expires the route refuses that press, 409
   `retry_pending`).
```

Replace:

```
**Suggested fix.** `feat/send-outcome-reconcile` (revision 4) introduces a
```

with:

```
**Suggested fix.** `feat/send-outcome-reconcile` (revision 5, @`616d120d`) introduces a
```

- [ ] **Step 6: `e2e/support/selectors.md` - the prose family, the stale reveal claim, the one-to-one row (D8, D11, D12)**

(a) Row 48 claims the reveal discloses the Retry action; it does not (`Timeline.tsx:1341-1353` renders it outside the reveal and `Timeline.module.css:349-360` never hides it). Replace:

```
It discloses the transport line, the per-recipient list below it, and the Retry action.
```

with:

```
It discloses the transport line and the per-recipient list below it. The Retry action is NOT behind the reveal: it renders on every failed one-to-one bubble that promises no retry (see the one-to-one row below).
```

(b) Row 49, the relay-retry prose family gains claim-time refusals and `retry_window_closed`. Replace:

```
so a refused ladder reads e.g. `Undelivered - Not retried - number changed since`.
```

with:

```
so a refused ladder reads e.g. `Undelivered - Not retried - number changed since` - and since retry-send-window (D3) it reads so AT ONCE when the 30003's own claim already sees the refusal, instead of `Retrying` for 1 to 4 minutes. A fifth close code, `retry_window_closed` (the retry would have gone out more than 15 minutes after the member's original leg), carries NO display code: the row keeps the original's 30003 and reads `Undelivered - Phone unreachable (error 30003)`, a plain failed attempt. Its no-tail fallback `Not retried - message too old` (`INTERNAL_CODE_REASONS`) exists only for a future surface that renders the code directly; no current surface does.
```

(c) Row 49. Replace:

```
and only a capped or refused ladder reads `Undelivered - <reason>`.
```

with:

```
and only a capped, refused or window-declined ladder reads `Undelivered - <reason>`.
```

(d) Row 49, native group text stopped promising (D11). Replace:

```
Native Group MMS keeps its existing `will retry` promise, unchanged.
```

with:

```
A native group text promises nothing either (no retry exists for one, retry-send-window D11): its 30003 leg reads `Undelivered - Phone unreachable (error 30003)`. `will retry` now appears ONLY on a one-to-one bubble - see the next row.
```

(e) A new row after row 49 for the one-to-one bubble the new spec relies on. Replace:

```
explicit transport fixtures own requested/actual facts. |
| Contact (AI extraction) | AI provenance badge |
```

with:

```
explicit transport fixtures own requested/actual facts. |
| Thread (one-to-one bubble) | failure chip, retry promise, Retry action | Address the bubble exactly as the meta-reveal row above does - `getByText('<body>', { exact: true }).locator('xpath=..')` - and read its chip with `toContainText`; the chip is `<delivery label> - <reason>`. A 30003 promises a retry ONLY while the failed message carries a live `retry_due_at`, i.e. an automatic retry is scheduled (retry-send-window D8): the chip reads `Undelivered - Phone unreachable - will retry (error 30003)` and the bubble offers NO Retry action. Without a live stamp (retries exhausted, a declined retry, an automated text on a manual-mode thread) it reads `Undelivered - Phone unreachable (error 30003)` and offers Retry. The action is `getByRole('button', { name: 'Retry sending this message' })` (visible text: a U+21BB glyph plus `Retry`) and is NOT behind the reveal. Its ABSENCE proves something only at the same instant as the promise text: once the automatic retry lands the failed bubble is hidden (a later row whose `retry_of` names it supersedes it) and a re-resolved locator lands on the delivered retry's bubble, which has no action either - so filter ONE locator on both (`.filter({ hasText: <chip> }).filter({ hasNot: <the button> })`) and keep a positive control (a failed bubble that does show the action), as `one-to-one-30003-retry.spec.ts` does. A Retry pressed during the wait (a stale tab) is refused 409 `retry_pending` and the composer's error slot reads `A retry is already scheduled for this message.` On a lane the first automatic retry goes out 10 s after the failure (`E2E_SEND_RETRY_BACKOFF_MS`, `scripts/e2e-session.mjs`). |
| Contact (AI extraction) | AI provenance badge |
```

- [ ] **Step 7: The relay 30003 spec's header comment (D12, `relay-30003-retry.spec.ts:18-22`)**

In `e2e/tests/dashboard-next/relay-30003-retry.spec.ts`, replace:

```
// pinned OUT is still pinned out: `will retry` was, and remains, a native
// group-text string, and every `not.toContainText('will retry')` below is
// inherited unchanged. What moved is the positive half: a relay 30003 no longer
// reads `Undelivered`, it reads `Retrying` and then `Delivered on retry`.
```

with:

```
// pinned OUT is still pinned out, and every `not.toContainText('will retry')`
// below is inherited unchanged. What changed around it: `will retry` is no
// longer a native group-text string (no retry exists for a native group text,
// retry-send-window D11); it now shows ONLY on a one-to-one bubble whose failed
// message carries a live `retry_due_at`, i.e. a scheduled automatic retry
// (retry-send-window D8, one-to-one-30003-retry.spec.ts). What moved here is
// the positive half: a relay 30003 no longer reads `Undelivered`, it reads
// `Retrying` and then `Delivered on retry`.
```

Comment-only: no assertion in the file changes.

- [ ] **Step 8: Regenerate the index and check ASCII**

Run (Git Bash, worktree root):

```bash
npm run issues
for f in docs/issues/group-text-30003-leg-retry-promise-unverified.md docs/issues/quiet-hours-ungated-automated-paths.md docs/issues/ai-mode-switch-gates-all-automation.md docs/issues/manual-retry-double-send-residual-windows.md e2e/tests/dashboard-next/relay-30003-retry.spec.ts; do printf '%s ' "$f"; tr -d '\11\12\15\40-\176' < "$f" | wc -c; done
git diff -U0 e2e/support/selectors.md | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
npx eslint e2e/tests/dashboard-next/relay-30003-retry.spec.ts
```

Expected: `npm run issues` regenerates the gitignored `docs/issues/INDEX.md`, lists `group-text-30003-leg-retry-promise-unverified` under Closed, and prints no warning naming any of the four issue files; each of the five files prints `0` (all five were fully ASCII before the edits); the selectors added-lines check prints `0` (that file carries pre-existing non-ASCII on other lines, so only added lines are checked); eslint exit 0. `INDEX.md` is never staged.

- [ ] **Step 9: Commit**

```bash
git status
git add docs/issues/group-text-30003-leg-retry-promise-unverified.md docs/issues/quiet-hours-ungated-automated-paths.md docs/issues/ai-mode-switch-gates-all-automation.md docs/issues/manual-retry-double-send-residual-windows.md e2e/support/selectors.md e2e/tests/dashboard-next/relay-30003-retry.spec.ts
git commit -m "docs(retry-send-window): close the group-text 30003 promise issue; annotate quiet-hours and ai-mode; reconcile the double-send residuals; selectors prose family and one-to-one row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/issues/group-text-30003-leg-retry-promise-unverified.md docs/issues/quiet-hours-ungated-automated-paths.md docs/issues/ai-mode-switch-gates-all-automation.md docs/issues/manual-retry-double-send-residual-windows.md e2e/support/selectors.md e2e/tests/dashboard-next/relay-30003-retry.spec.ts
```

Expected: `git status` before the add lists exactly these seven files as modified.

---

### Task 21: Final gates, a second main sync only if main moved, build handback

**Files:**
- Create: `docs/superpowers/reviews/2026-09-24-retry-send-window/build-handback.md` (committed)
- Logs (gitignored, never committed): `.superpowers/gates/{typecheck,test,smoke,e2e,lint}.log` and, only if gate 5 reports errors, `.superpowers/gates/lint-branch.json`, `.superpowers/gates/lint-failing.txt`, `.superpowers/gates/lint-base/`
- Possibly: one merge commit from `main` (Step 7)

**Interfaces:**
- Consumes: every earlier task, committed; AGENTS.md "Required completion gates"; Cameron's ruling (spec section 0, section 7): `main` was merged at `f49a2fe9`; merge it again before handback ONLY if it moved.
- Produces: the five gate verdicts, the handback, and (conditionally) the merge commit.

Rules for every gate call: run it BARE from the worktree root, redirected to its log, as its OWN tool call with NOTHING after it on the line - the call's exit code is then the gate's own. Never pipe it, never `;`-chain it, and never trust a background-task notification's exit code; read the verdict from the log afterwards. Do not commit while any gate runs.

- [ ] **Step 1: Quiet tree, no live lane, DynamoDB Local up**

```bash
git status
test -f "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE IN PROGRESS - stop" || echo "no merge in progress"
npm run e2e:stop
npm run db:start
mkdir -p .superpowers/gates
```

Expected: a clean tree; `no merge in progress`; `e2e:stop` either stops this worktree's session or prints `nothing to stop` (an `e2e:session` must not be live while `npm test` runs, and never during the full suite); `db:start` starts DynamoDB Local or reports it running.

- [ ] **Step 2: Gate 1 - typecheck**

```bash
npm run typecheck > .superpowers/gates/typecheck.log 2>&1
```

Expected: exit 0. Read: `rg -n "error TS" .superpowers/gates/typecheck.log` -> no hits.

- [ ] **Step 3: Gate 2 - npm test**

```bash
npm test > .superpowers/gates/test.log 2>&1
```

Expected: exit 0. Read: `rg -n "Test Files|FAIL|\[dynamoAdmin\]" .superpowers/gates/test.log` -> every workspace's `Test Files ... passed`, no `FAIL`, no `[dynamoAdmin]`.
If red on DynamoDB Local suites, follow AGENTS.md exactly: re-run each failing FILE alone more than once (`cd app; npx vitest run test/<file>`), run the full suite at the merge base (`git merge-base main HEAD`) in a separate detached worktree under `W:\tmp` (with `.claude\settings.local.json` copied in and `npm ci` run there; report that worktree in the handback, do not delete it), and compare failing FILES, reporting both runs. Never reach for an exported `AWS_ACCESS_KEY_ID`. ANY `[dynamoAdmin]` line is one real container fault: capture that run's `err.$metadata.httpStatusCode` and `attempts` first (`docs/issues/dynamo-local-control-plane-fault-shape-unverified.md`). The named-flake list is empty: a failing named test is a regression to diagnose.

- [ ] **Step 4: Gate 3 - smoke**

```bash
npm run smoke > .superpowers/gates/smoke.log 2>&1
```

Expected: exit 0 (every import of the compiled app output resolves under plain Node; the new modules `retrySendWindow.ts`, `relayRetryGates.ts`, `sendRefusalPreview.ts` and `oneToOneRetryDecision.ts` are all in it).

- [ ] **Step 5: Gate 4 - the full e2e suite (Git Bash)**

```bash
timeout 1500 npm run e2e > .superpowers/gates/e2e.log 2>&1
```

Expected: exit 0. Read: `rg -n " passed| failed| flaky|did not run|npm error code" .superpowers/gates/e2e.log` -> `N passed`, nothing failed; and `rg -n "one-to-one-30003-retry|relay-30003-retry|share-skip-fix" .superpowers/gates/e2e.log` -> all five of those tests passed.
A failing spec is a regression to diagnose (no named-flake list). For an intermittent CONTENT failure only, a re-run may set `E2E_CHILD_LOG_DIR=.artifacts/child-logs`; never for a hang or a stall (it changes timings), where the evidence is a trace (`E2E_TRACE=1`).
If the run exits 124 (the 25-minute ceiling) or is killed, it was ABORTED, not red - and `reuseExistingServer` would adopt its orphaned stack on a commit match (`e2e/playwright.config.ts:203`). Before any re-run, prove no listener survives on the lane's ports:

```bash
node -e "const fs=require('fs'),net=require('net');const f='e2e/.artifacts/lane.json';if(!fs.existsSync(f)){console.log('no lane.json - read the lane URLs from the [WebServer] lines of the e2e log');process.exit(0)}const s=JSON.parse(fs.readFileSync(f,'utf8'));const ps=Object.entries(s.ports);let n=0;for(const [k,p] of ps){const c=net.connect({host:'127.0.0.1',port:p});c.on('connect',()=>{console.log('LISTENER SURVIVES',k,p);c.destroy();if(++n===ps.length)process.exit(0)});c.on('error',()=>{console.log('free',k,p);if(++n===ps.length)process.exit(0)})}"
```

If any line reads `LISTENER SURVIVES`: `npm run e2e:stop`, then run the same check again. If a listener still survives, stop and report it - do not start another run on top of it, and never kill shared MCP browser processes. On a loaded box, re-run the gate when the box is quiet rather than raising the ceiling without saying so.

- [ ] **Step 6: Gate 5 - no new lint errors in the files this branch touched**

First print the list the gate will lint (a separate call):

```bash
git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'
```

Expected: non-empty (app, dashboard and e2e `.ts`/`.tsx` files plus `scripts/e2e-session.mjs`). If it were empty the gate would be skipped - never run a bare `npx eslint`. Then the gate:

```bash
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs') > .superpowers/gates/lint.log 2>&1
```

Expected: exit 1 with exactly ONE error, pre-existing: `dashboard/src/routes/contact/Timeline.tsx` `react-hooks/set-state-in-effect` ("Calling setState synchronously within an effect", at `:1495` on `main` @`da04d0cb`; the line moves with Task 17's edits). Every other file this branch modifies, and their tests, lint clean on `main`. Known hole (AGENTS.md): `scripts/e2e-session.mjs` is `.mjs`, and the config lints `.ts`/`.tsx` only, so nothing in it was checked.
If the gate reported any error (the expected case above), attribute EACH one by BASELINE, never by line number - each command its own call:

```bash
mkdir -p .superpowers/gates/lint-base
npx eslint -f json $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx') > .superpowers/gates/lint-branch.json
node -e "const fs=require('fs'),path=require('path');const r=JSON.parse(fs.readFileSync('.superpowers/gates/lint-branch.json','utf8'));for(const x of r)if(x.errorCount>0)console.log(path.relative(process.cwd(),x.filePath).split(path.sep).join('/'))" > .superpowers/gates/lint-failing.txt
BASE=$(git merge-base main HEAD); while read -r f; do if git cat-file -e "$BASE:$f" 2>/dev/null; then git show "$BASE:$f" > .superpowers/gates/lint-base/current.src; npx eslint -f json --stdin --stdin-filename "$f" < .superpowers/gates/lint-base/current.src > ".superpowers/gates/lint-base/$(printf '%s' "$f" | tr '/' '_').json"; else echo "$f: new on this branch - every error in it is the branch's"; fi; done < .superpowers/gates/lint-failing.txt
node -e "const fs=require('fs'),path=require('path');const key=(m)=>m.ruleId+' | '+m.message.split('\n')[0];const branch=JSON.parse(fs.readFileSync('.superpowers/gates/lint-branch.json','utf8'));for(const x of branch){if(x.errorCount===0)continue;const rel=path.relative(process.cwd(),x.filePath).split(path.sep).join('/');const bf='.superpowers/gates/lint-base/'+rel.split('/').join('_')+'.json';const base=fs.existsSync(bf)?JSON.parse(fs.readFileSync(bf,'utf8'))[0].messages:[];const left=new Map();for(const m of base){if(m.severity!==2)continue;left.set(key(m),(left.get(key(m))??0)+1)}for(const m of x.messages){if(m.severity!==2)continue;const k=key(m);const n=left.get(k)??0;if(n>0){left.set(k,n-1);console.log('PRE-EXISTING',rel+':'+m.line,k)}else console.log('BRANCH - BLOCKING',rel+':'+m.line,k)}}"
```

The base copy of each file is linted from stdin under its own path, so the same config applies and HEAD never moves. Expected: one `PRE-EXISTING` line (the Timeline.tsx error) and no `BRANCH - BLOCKING` line. Any `BRANCH - BLOCKING` line is this branch's: fix it (an unused import often means code was deleted by mistake), commit, and re-run Steps 2-6. Pre-existing errors are left alone and NAMED in the handback.

- [ ] **Step 7: A second main sync, only if main moved (Cameron's ruling)**

```bash
git rev-list --count HEAD..main
```

If it prints `0`: `main` has not moved since the `f49a2fe9` sync; no merge. Record that in the handback and go to Step 8.
If it prints a positive number, merge `main` again (Cameron: "do another one if it moves"; this repo's base is the LOCAL `main`, never `origin/main`):

```bash
git log --oneline HEAD..main
git status
git merge main -m "Merge main into feat/retry-send-window (main moved since f49a2fe9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

On a conflict, resolve each file preserving BOTH sides' intent (spec section 5 names the neighbours: `feat/send-outcome-reconcile` edits `relayRetryLeg.ts`, `relayFanOut.ts`, `retrySend.ts`, `messagesRepo.ts`, `sendMessage.ts`, `deliveryStatus.ts`, `relayRetryJoin.ts` and the lane `childEnv`; keep both sides' special cases in `relayRetryJoin.ts`'s terminal step, requirement 7), then `git add <each resolved path>` and `git commit --no-edit`. If a conflict in this branch's substance has no clearly correct resolution, stop and ask Cameron. Then:

```bash
test -f "$(git rev-parse --git-path MERGE_HEAD)" && echo "MERGE IN PROGRESS - stop" || echo "no merge in progress"
git diff --name-only ORIG_HEAD HEAD -- package-lock.json package.json app/package.json dashboard/package.json e2e/package.json fake-twilio/package.json
```

If the second command lists any file, run `npm ci` (a dependency-changing merge). Then re-run Steps 1-6 in full on the merged HEAD; only those runs count. This is the branch's last sync: any later drift of `main` is reported in the handback, not chased.

- [ ] **Step 8: Write the handback**

Create `docs/superpowers/reviews/2026-09-24-retry-send-window/build-handback.md` (ASCII, American English) with the content below. Fixed facts are written out; each `<...>` is filled from the command named beside it, verbatim.

````markdown
# Build handback - feat/retry-send-window

Worktree `W:\tmp\retry-send-window`, branch `feat/retry-send-window`, HEAD
`<git rev-parse --short HEAD>`, written `<date +%F>`. Spec:
`docs/superpowers/specs/2026-09-24-retry-send-window-design.md` (draft 7). Plan:
`docs/superpowers/plans/2026-09-25-retry-send-window.md`. Records: this folder.

## Verdict

<MERGE-READY, or NOT MERGE-READY and why. Merge-ready only when gates 1-4
exited 0 and gate 5's only errors are attributed PRE-EXISTING by baseline.>

## Main sync (Cameron's ruling: again only if main moved since f49a2fe9)

- `git rev-list --count HEAD..main` at Step 7: <N>.
- <"main had not moved; no second merge." OR "main had moved N commits (to
  <sha>); merged at <merge sha>; conflicts: <none, or each file and how both
  sides were kept>; npm ci: <run / not needed>; every gate below ran AFTER the
  merge.">
- Drift at handback (`git rev-list --count HEAD..main` again): <N>. Reported, not
  chased.

## Gates (bare, worktree root; exit codes as the tool reported them)

| # | command | exit | evidence (.superpowers/gates/) |
|---|---|---|---|
| 1 | `npm run typecheck` | <exit> | typecheck.log: no `error TS` |
| 2 | `npm test` | <exit> | test.log: <each workspace's Test Files line>; `[dynamoAdmin]` lines: <count> |
| 3 | `npm run smoke` | <exit> | smoke.log |
| 4 | `timeout 1500 npm run e2e` | <exit> | e2e.log: <"N passed (duration)">; one-to-one-30003-retry, relay-30003-retry and share-skip-fix passed |
| 5 | `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- ...)` | <exit> | lint.log; baseline: <each error, PRE-EXISTING or BRANCH> |

Pre-existing lint in a touched file, not fixed here: `dashboard/src/routes/contact/Timeline.tsx`
`react-hooks/set-state-in-effect` (at :1495 on main @da04d0cb). Known hole: gate 5
checked nothing in `scripts/e2e-session.mjs` (`.mjs`; AGENTS.md "Known hole").

## Commits

<git log --oneline --no-merges main..HEAD, one line each>

## Spec decisions -> tasks -> commits

| decision | tasks | commits |
|---|---|---|
| D1 the 15-minute window | 1, 4, 5, 10, 11 | <shas> |
| D2 the origin | 2, 4, 11 | <shas> |
| D3 the relay claim decides at once | 3, 4 | <shas> |
| D3a the one-to-one decision before the write | 7, 10 | <shas> |
| D4 re-check before sending (incl. bounded acquire) | 5, 6, 11 | <shas> |
| D5 missing origin fails open | 1, 5, 10, 11 | <shas> |
| D6 lineage at append | 2, 8, 11 | <shas> |
| D7 the stamp with the failure | 2, 10, 13 | <shas> |
| D8 what the screen says | 14, 15, 16, 17, 18 | <shas> |
| D9 logging | 4, 5, 10, 11 | <shas> |
| D10 manual Retry guard | 12, 14, 17 | <shas> |
| D11 native group text | 10, 15, 17 | <shas> |
| D12 comments that lied | 2, 8, 10, 11, 15, 17, 20 | <shas> |
| D13 seams and fixtures | 9, 19 (+ fixture moves in 4, 10) | <shas> |
| D14 a retry follows the original send | 2, 7, 8, 10, 11, 12 | <shas> |
| Test intentions 1 / 2 / 3 / 4 / 5 / 6 / 6a / 7 / 8 | 1 / 3-4 / 5-6 / 7, 10 / 11 / 12 / 8 / 14-18 / 19 | <shas> |

## Facts for the planner's Relay for SOR (send-outcome-reconcile) and share-skip-fix Branch B

The planner writes the final "Relay for SOR" block (Cameron's standing instruction, `rulings.md`: one fenced ASCII block, full W:\ paths, Branch A's items for SOR carried unchanged); this section gives it the facts, verbatim from the code.

### Files changed, by area

From `git diff --name-status main...HEAD` (A added, M modified); every file in
that output appears once below.
- Foundation: `app/src/lib/retrySendWindow.ts` (A), `app/src/repos/messagesRepo.ts`,
  `app/test/helpers/twilioWebhookHarness.ts`, their tests: <paths>
- Relay: `app/src/lib/relayRetryGates.ts` (A), `app/src/lib/relayRetryClaim.ts`,
  `app/src/routes/webhooks/twilio.ts` (claim), `app/src/jobs/relayRetryLeg.ts`,
  `app/src/jobs/relayFanOut.ts`, tests: <paths>
- One-to-one server: `app/src/services/sendRefusalPreview.ts` (A),
  `app/src/services/oneToOneRetryDecision.ts` (A), `app/src/services/sendMessage.ts`,
  `app/src/jobs/retrySend.ts`, `app/src/routes/webhooks/twilio.ts` (30003 arm),
  `app/src/routes/api.ts`, `app/src/routes/contactTimeline.ts`,
  `scripts/e2e-session.mjs`, tests: <paths>
- Dashboard: `dashboard/src/api/serverClock.ts` (A), `dashboard/src/api/client.ts`,
  `dashboard/src/api/types.ts`, `dashboard/src/routes/contact/retryPromise.ts` (A),
  `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/contact/relayRetryJoin.ts`,
  `dashboard/src/routes/contact/Timeline.tsx`, Task 18 readers, tests: <paths>
- Proof and docs: `e2e/tests/dashboard-next/one-to-one-30003-retry.spec.ts` (A),
  `e2e/tests/dashboard-next/relay-30003-retry.spec.ts` (comment),
  `e2e/support/selectors.md`, five `docs/issues/*.md`, records in this folder
- Other: <any file not named above, one line each on why>

### New stored fields (exact names)

- `retry_due_at` - on the FAILED one-to-one original. Written by
  `updateDeliveryStatus(sid, status, errorCode, { retryDueAt })` in the SAME
  conditional update as the failure (lands only if the transition does); re-written
  to `RETRY_PROMISE_WITHDRAWN_AT` (`'1970-01-01T00:00:00.000Z'`) through
  `annotateMessage` when the enqueue fails. Equals the retry job's run time.
  Read by the manual Retry guard (`isRetryPromiseLive`, `app/src/lib/retrySendWindow.ts`)
  and, through the contact-timeline projection, by the dashboard's
  `isRetryPromiseLive(retry_due_at, serverNowMs())`.
- `retry_window_start` - on one-to-one AUTOMATIC retry rows only: the chain's
  origin, `original.retry_window_start ?? original.provider_ts`, written at append
  (`SendMessageInput.retryWindowStart` -> `NewMessage.retryWindowStart`). A manual
  Retry never copies it.
- `relay_retry_window_start` - on relay retry rows (rungs): rung 1 = the ROOT
  member slot's `sentAt`; rungs 2-3 copy the previous rung's value; written by the
  claim's append (`NewMessage.relayRetryWindowStart`). OPTIONAL in the job's
  lineage check: absent = a rung claimed before this deploy, WARN, no window (D5).
- `automated` - on EVERY one-to-one row `sendMessage` appends, true or false
  (false is written; the input defaults to false). A row without it predates this
  deploy and is treated as automated.
- `recipient_contact_id` - on one-to-one rows `sendMessage` appended with a
  `recipient`; read by the D3a decision, `retrySend` and the manual Retry route
  (missing contact -> phone lookup + WARN).
- Now written AT APPEND instead of annotated after the send: `retry_of`,
  `retry_attempt` (D6).

### The lane seam

`E2E_SEND_RETRY_BACKOFF_MS` = `'10000'`, set in `scripts/e2e-session.mjs`
`childEnv` beside `E2E_RELAY_RETRY_BACKOFF_MS`. Read ONLY by
`resolveSendRetryBackoffMs(attempt)` in `app/src/jobs/retrySend.ts`, honored when
`JOBS_QUEUE_URL` is unset and the value is a positive integer, else
`retryBackoffMs(attempt)` (60/120/240 s). The D3a decision
(`app/src/services/oneToOneRetryDecision.ts`) uses it for the run time and the
window fit, and `enqueueSendRetry(payload, runAt)` schedules at that run time, so
`retry_due_at === runAt`. Branch B and SOR reuse it. `E2E_RETRY_SEND_WINDOW_MS`
(optional in D13) was not built - no e2e needed it.

### New codes and values

- Close code `retry_window_closed` (`RelayRetryCloseCode`,
  `app/src/jobs/relayRetryLeg.ts`), appended closed by the claim and written by the
  job (its window gate, and a bounded-acquire timeout). The union also takes the
  gate codes by reference from `RelayRetryGateCode`
  (`app/src/lib/relayRetryGates.ts`).
- Claim outcome `window_closed` (`RelayRetryClaimOutcome`,
  `app/src/lib/relayRetryClaim.ts`, 13 -> 14 values; ERROR). `gate_refused` is
  now produced at claim time and logged WARN (`isTerminalRelayLegFailure`).
- A claim-time decline APPENDS the rung already closed (gate code or
  `retry_window_closed`) in the claim's one append; `closeRetryLegEnqueueFailed`
  (`app/src/routes/webhooks/twilio.ts`) is unchanged and remains the claim's only
  close.
- `sendOneRelayLeg` (`app/src/jobs/relayFanOut.ts`): new arg `sendDeadlineMs?:
  number`; new result `'deadline_exceeded'`, returned BEFORE any `attempted`
  write: <state its exact place in the return union from the Task 6 code>. The
  fan-out passes no deadline.
- Manual Retry route: `409 { error: 'retry_pending' }`.
- One-to-one decision log values (`OneToOneRetryDeclineReason`):
  `conversation_missing`, `group_text`, `not_one_to_one`, the `SendRefusalCode`
  values (`sms_sending_disabled`, `contact_opted_out`, `contact_deleted`,
  `contact_no_consent`, `manual_mode`), `cap_exhausted`, `window_closed`;
  `failOpen`: `read_failed`, `no_origin`.
- Constants (`app/src/lib/retrySendWindow.ts`): `RETRY_SEND_WINDOW_MS` 15 min,
  `RETRY_JOB_GRACE_MS` 60 s, `RETRY_PROMISE_GRACE_MS` 2 min (mirrored in
  `dashboard/src/routes/contact/retryPromise.ts`, pinned by a test),
  `RETRY_PROMISE_WITHDRAWN_AT`.

### Copy strings and where they live

Confirm each by running `rg -n` over `dashboard/src --glob '!*.test.*'` for its
source literal - `'30003': 'Phone unreachable'`, `Phone unreachable - will retry`,
`Not retried - message too old`, `A retry is already scheduled for this message.`
(the `(error 30003)` tail is composed by `deliveryReason`, never stored) - and
write the `file:line` found.
- "Phone unreachable (error 30003)" - `ERROR_CODE_REASONS['30003']` + the
  `(error <code>)` tail, `dashboard/src/routes/contact/deliveryStatus.ts`:<line>.
  Every 30003 without a live promise; the relay map keeps its identical entry.
- "Phone unreachable - will retry (error 30003)" - `deliveryReason`'s
  `retryScheduled` branch, same file:<line>. Only a one-to-one bubble while
  `isRetryPromiseLive(retry_due_at, serverNowMs())` (Timeline.tsx:<line>).
- "Not retried - message too old" - `INTERNAL_CODE_REASONS.retry_window_closed`,
  same file:<line>. No current surface renders it.
- "A retry is already scheduled for this message." - `sendFailureMessage` case
  `retry_pending`, `dashboard/src/routes/contact/Timeline.tsx`:<line>.
- Unchanged, now shown at claim time too: "Not retried - group closed", "Not
  retried - no longer in this group", "Not retried - number changed since", "Not
  retried - opted out" (`INTERNAL_CODE_REASONS`).
- On this branch the share results row (`shareRecipientReason`,
  `dashboard/src/routes/broadcasts/broadcastFormat.ts`) shows the base wording
  even while a retry is scheduled (under-promising, never false).

### What SOR must carry (spec section 5), at the code this branch left

1. Any retry it re-drives later runs the same job handler, so the job-time
   window check (D4) bounds it: `relayRetryLeg`'s window gate (last gate, after
   the opt-out gate) and `retrySend`'s strict check after its execution marker.
2. Any path appending a one-to-one retry row carries `retry_of`,
   `retry_attempt`, `retry_window_start`, `automated` and `recipient_contact_id`
   AT APPEND (for a share, consistent with Branch A's `created_via`).
3. Any path deferring a one-to-one retry, or leaving its outcome pending past
   `retry_due_at`, applies the window to every re-schedule
   (`retryFitsSendWindow`) and keeps the promise and the D10 guard up by
   refreshing `retry_due_at` and emitting `message.persisted` after each refresh.
4. Its issue that an unresolved one-to-one retry leaves "will retry" standing
   changes with D8: the copy now follows `retry_due_at`, so requirement 3 is
   what keeps it truthful.
5. A deadline timeout (`'deadline_exceeded'`) is TERMINAL for a relay retry
   rung: nothing sent, the rung closes `retry_window_closed`; never a `retryable`
   deferral. Re-run the relay job tests (test intention 3) after that merge.
6. The relay job's window closes (the gate and the acquire timeout) are closes
   by a writer other than the recipient's own attempt: under SOR's D8 they read
   the attempt record first and close only if it is absent or
   `done`/`retryable`. The window checks run BEFORE SOR's claim (in `retrySend`
   too). A claim-time decline is a closed APPEND, not a close: no attempt record
   can exist for it.
7. `relayRetryJoin.ts`'s terminal step: SOR's `send_unconfirmed` special case
   and this branch's `retry_window_closed` (no display code) both survive the
   merge, each with its test.
Joint gap (neither spec closes it): an `unresolved` one-to-one retry leaves the
Retry action live after this branch's guard expired - recorded as gap 4 of
`manual-retry-double-send-residual-windows`.
For Branch B: read the failed message's live `retry_due_at` on the share
results row under D8's rule (never the retry count); reuse the seam above.

## Issues

- Closed: `group-text-30003-leg-retry-promise-unverified`.
- Annotated: `quiet-hours-ungated-automated-paths` (item 3),
  `ai-mode-switch-gates-all-automation` (item 3 delivered for the 30003 retry).
- Reconciled with spec section 9: `manual-retry-double-send-residual-windows`
  (revision 5 @616d120d, gap 2's "once the promise has expired", refs as paths).
- Filed new: `vitest-config-globalsetup-fail-soft-comment` (low; a stale comment
  found in plan review round 1, filed at 1c0c7ab3).

## Deferred and accepted

- Accepted residuals (spec section 9): pending-reconcile copy; a promise with
  nothing behind it (at most the longest backoff plus RETRY_PROMISE_GRACE_MS,
  6 minutes); a relay claim fault (`claim_failed`, recovered by redelivery); no
  usable origin (D5); a text sent before this deploy (D14); a human action
  reversed inside the backoff (D3); a relay leg's slot written before its claim
  decides (section 1).
- Recorded in issues: the double-send windows.
- Out of scope (spec section 8): a real native group-text retry; alarm
  thresholds and a manual relay retry; polling unconfirmed legs; the share
  results row's copy and its `retry_due_at` read (Branch B); the rest of
  `ai-mode-switch-gates-all-automation` (Work Package 2); retrying 30007; a
  conditional claim for the manual double send; the stranded-claim fix.
- Proven below the e2e layer on purpose (D13): the person's-send retry on a
  manual-mode thread, every declined retry (window, cap, D3a refusals) and the
  relay window.
- Deferred during the build: <each, with its record, or "none">.

## Build-time deviations from the plan

<each departure and its record, or "none">
````

- [ ] **Step 9: ASCII-check and commit the handback**

```bash
tr -d '\11\12\15\40-\176' < docs/superpowers/reviews/2026-09-24-retry-send-window/build-handback.md | wc -c
git status
git add docs/superpowers/reviews/2026-09-24-retry-send-window/build-handback.md
git commit -m "docs(retry-send-window): build handback - gates, main sync, relays for SOR and Branch B

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/superpowers/reviews/2026-09-24-retry-send-window/build-handback.md
```

Expected: `0`; `git status` shows only the handback (the logs sit in the gitignored `.superpowers/`). The commit is docs-only, so the gates are not re-run for it; confirm with `git diff --name-only HEAD~1 HEAD`, which must list only the handback. If the orchestrator keeps its own `.superpowers/sdd/handback.md`, it mirrors this file.

---

## Self-review notes (planner, plan v1; v2 below)

Assembled from five slice drafts written in parallel against one skeleton of
locked interfaces; each drafter's findings are in the records folder
(`plan-draft-A|B1|B2|C|D-findings.md`). Checked after assembly: every spec
decision D1-D14 is cited by at least one task; no placeholder; every shared name
(`evaluateRelayRetryGates`, the `retrySendWindow`
helpers, `resolveSendRetryBackoffMs`, `enqueueSendRetry(payload, runAt)`,
`previewSendRefusal`, `decideOneToOneRetry`, `serverNowMs` / `noteServerDate`,
`retryScheduled`, `deadline_exceeded`, the five row fields) is spelled the same
in every task; the file is ASCII.

Planner rulings applied at assembly:
- A one-to-one message whose conversation no longer exists declines at WARN,
  not ERROR (B2 F4): the level it logs at today, and spec D9 adds no alarm.
- The fail-open retry verdict carries the thrown read as `readError`, and the
  arm's WARN logs it under `err` (B2 F8).
- The Review Focus pins were added as Task 4 Step 6b and Task 10 Step 8b.
- Four dashboard tests are red between Task 15 and Tasks 17-18 by design (C);
  named in the slice section above.
- The D12 comments Tasks 2 and 8 rewrite describe the branch's end state, true
  from Task 11 on (B1 section 3); accepted inside one branch.
- `MessageAnnotations.retryOf` / `retryAttempt` lose their only caller at Task
  11 (B1); left in place - removing them is cleanup outside this spec.

Drafter choices accepted as written:
- The relay transient re-enqueue re-checks with the SCHEDULING rule (A F2).
- The job's no-pool-number throw now follows the four gates (A F4; spec D3 says
  so since draft 7.1).
- The server clock comes from the `Date` header: CloudFront serves `/api/*` with
  CachingDisabled, the app sets no Cache-Control on API JSON, and nothing in the
  client handles 304s itself (C finding 1). The Timeline takes ONE `serverNowMs()`
  snapshot per ticker pass and hands it down as `promiseNowMs`, so a re-rendered
  bubble cannot re-show a promise the ticker already expired (C finding 2).
- The webhook gets no clock seam; its tests use wall-clock-relative origins with
  wide margins (A F8, B2 F11).
- `E2E_RETRY_SEND_WINDOW_MS` is not built: no e2e needs a short window (D
  finding 10).

Spec draft 7.1 (same review scope as drafts 6 and 7) folded in the drafting
findings: D3a's deleted gate wording, the job's pool-number check order (D3),
the transient re-check's rule (D4), two WARN cases (D9), and section 9's
stale-tab qualifier, crash-before-enqueue and failed-close residuals.

Plan v2 (after adversarial plan review round 1, `plan-review-r1-a.md`,
`plan-review-r1-b.md`, adjudications in `plan-review-r1-adjudications.md`):
Tasks 3 and 4 rewritten by the slice-A drafter - a claim-time decline is now
APPENDED already closed in one write (the round's one decision change), so
`closeRetryLegEnqueueFailed` keeps its name and job, and the failed-close path
is gone; Task 3 pins the moved pool-number throw. Task 3 inserts 79 lines at
`app/test/relayRetryLeg.test.ts:379`, so Tasks 5 and 6's citations past `:378`
in that file are 79 lines early - their quoted anchors still match. The planner
applied every other accepted finding (see the adjudications' edit column).

Plan v3 (after plan review round 2, `plan-review-r2.md`, adjudications in
`plan-review-r2-adjudications.md`): precision only - Task 8's `automated` doc
names the consent gate; Task 21's handback names the one issue filed. The
round changed no decision, so the review is closed.
