# Share Skip Fix (Branch A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Property sends staff start reach the tenant regardless of the per-conversation `ai_mode` switch; every one-to-one conversation is switched back to `auto` by a Cameron-run script; skipped recipients stop counting as "Already sent"; skipped and failed rows show their reason; a one-to-one send defaults to the address plus the flyer link.

**Architecture:** Two operator scripts (a read-only census and a dry-run-first fix script) plus an import default change land first as their own slice and go to Cameron before anything else. The send job then reads a creation-time record (`created_via: 'dashboard'`) to send staff shares as a person's send, the prior-recipients union stops counting `skipped` slots, the fan-out records a reason on every skip and routes non-opt-out skips to a new `skipped_other` bucket, and the dashboard renders those reasons, derives a "Not sent" label for all-skipped sends, keeps seeded rows checked, and pre-fills the one-recipient composer with `[Address] [FlyerLink]`. A lean-seed tenant whose conversation is switched off backs the e2e proof.

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (AWS SDK v3, DynamoDB Local in tests), Vitest (app + dashboard workspaces), React 18 + Testing Library (dashboard), Playwright (e2e workspace, hermetic lane), tsx for scripts.

**Spec:** `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A, v9 or later). Branch B stub (NOT this plan): `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`.

**Plan history:** v1 @a0e594b5; v2 after adversarial plan review round 1 (`docs/superpowers/reviews/2026-09-24-share-skip-fix/plan-review-r1-a.md`, `plan-review-r1-b.md`, adjudications in `plan-review-r1-adjudications.md`).

## Global Constraints

- ASCII only in every new or touched line of source, tests, docs, seed strings and log strings (AGENTS.md). Verify a file with `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> `0`. Existing non-ASCII lines you do not touch stay as they are.
- Never run a script against dev or prod. An agent runs the census and the fix script ONLY against the per-file DynamoDB Local test databases (the vitest suites) or a hermetic e2e lane it started itself: `--env local --lane <L>` (Task 1 derives the lane's table prefix `hc-local-<L>-` AND its DynamoDB Local access key `hclane<L>`, which is what selects the lane's database). A bare `--env local` (no `--lane`) is the human's live local dev stack (`npm run dev -- --local`, key `local`): an agent never runs that. Cameron runs the scripts against real environments (spec D2 last bullet).
- The account the scripts may touch on real AWS is `938565869261`, through the `housingchoice` profile, and the DynamoDB client MUST be built from that profile's credentials (spec D2 "Target safety"). Never the default credential chain.
- Production is written only by the Cameron-run fix script (spec I7). No Terraform, no new GSI, no new dependency, no `.env` edits.
- Commit explicit paths only (`git add <paths>`), never `git add -A`; read `git status` before every commit; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` unless the session's attribution reminder names a different model - then use that one.
- The lean seed world stays byte-stable: fixed ids, fixed timestamps, every timestamp before `2026-06-01T14:05:45.000Z` (T2), `unread_count` 0 or absent, camelCase `firstName`/`lastName` on every contact, `participants` entries as `{ contactId, phone }` objects (spec section 5, `app/src/lib/seed/lean.ts:1-46`). The full (demo) profile composes lean, so the new tenant appears there too - intended.
- Skip reasons are staff-facing dashboard copy: the code-to-sentence map lives in `dashboard/src/routes/contact/deliveryStatus.ts` beside the existing `INTERNAL_CODE_REASONS` (spec D7 + Appendix A), and `dashboard/src/routes/broadcasts/broadcastFormat.ts` only composes it per row. Never the message catalog. The 30003 wording is NOT touched (RSW owns it).
- No new slot STATUS values: slots stay `queued | sent | delivered | failed | skipped`; new information rides `errorCode` and the derived stats buckets (spec D7; this also keeps SOR's D10 merge point clean).
- Exact spec copy, verbatim (spec D7 table and D5): `Automatic texts were off for this conversation`, `Opted out of texts`, `Number can't receive texts`, `No texting consent recorded`, `Contact was deleted`, `No contact or phone on file`, `Stopped by the automatic-text safety limit`, `Texting is turned off`, `Delivery failed`, `Opted out or number unreachable`, `Not sent (<code>)`, label `Not sent`, review note `Flagged tenants you picked stay checked; "Select all" skips the others.`
- One-to-one default message, exactly: the one-line address, ONE space, the flyer link - `[Address] [FlyerLink]` resolved (spec D8). Blasts keep `DEFAULT_SEND_TEMPLATE` unchanged. The SENT flyer link ends in `?cta=text` (`app/src/lib/mergeFields.ts:28-30`); the composer shows a query-less same-origin fallback only for the ~600 ms before the first draft exists, so e2e assertions must target the `?cta=text` steady state.
- Gates (from the worktree root, bare, never piped): `npm run typecheck`, `npm test` (needs `npm run db:start`), `npm run smoke`, `npm run e2e`, and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (skip the last if the list is empty; attribute errors by baseline comparison against the merge base). Run the e2e gate from Git Bash as `timeout 1500 npm run e2e` (the hard outer timeout AGENTS.md asks for; PowerShell's `timeout` is a different program - there, run `npm run e2e` bare). After ANY aborted or killed e2e run, confirm no listener survives on the lane's ports before starting another (`reuseExistingServer` adopts an orphan on a commit match alone).
- Slice 1 (Tasks 1-5) is built, gated, and reviewed by the orchestrator's own slice review, and the planner hands its two commands to Cameron, BEFORE Task 6 starts. Task 6 does NOT wait for Cameron's dev/prod runs (spec section 6: running the script before the rest ships is safe).

## Review Focus

Inputs the spec implies but no task's tests exercise by default; each line names the owning task, which adds the test in its own step style.

1. A conversation row whose `ai_mode` attribute is ABSENT (a legacy row created before the switch existed - never the import, which always writes `if_not_exists`) is neither `manual` nor `auto`: the census reports it in the `unset` column and the fix script leaves it alone (the send wrapper treats absent as auto - `isManualMode` is `=== 'manual'`). Owner: Task 1 (census `unset` count) and Task 2 (fix script skips it).
2. A `phone#`, `email#` or `token#` pointer item has no `type` and no `ai_mode`; the fix script's negative type test alone would admit it. The `ai_mode = :manual` condition keeps it out, and the census counts it as a pointer, never as a typeless conversation. Owner: Task 1 and Task 2 (pointer rows in the seeded world).
3. A share whose recipient key is `phone#<E164>` (no contactId) still sends as a person's send. Owner: Task 7 (its own phone#-keyed test).
4. A prior share in which the SAME tenant was skipped in one send and sent in another still flags the tenant (the union is "any counted slot"). Owner: Task 8.
5. A results page for a LEGACY share whose skipped slots carry no `errorCode` renders `Opted out or number unreachable` and counts them under opted-out, and its persisted stats object (no `skipped_other`) does not break the Skipped chip, the label, or the fan-out's `ADD` on a share mid-send at deploy. Owner: Task 6 (bumpStats integration case), Task 10 and Task 11.

---

## File structure

New files:
- `app/scripts/lib/stageClient.ts` - the shared `--env local|dev|prod` stage resolver for the two new ops scripts: DynamoDB Local for `local` (bare = the live local stack with key `local`; `--lane <L>` = the hermetic lane's prefix + key); the account guard on the `housingchoice` profile plus a client built from `hcCredentials()` for `dev`/`prod`. Injectable guard for tests.
- `app/scripts/conversation-automation-census.ts` - read-only census (spec D1).
- `app/scripts/enable-conversation-automation.ts` - the dry-run-first fix script (spec D2).
- `app/test/stageClient.test.ts`, `app/test/conversationAutomationCensus.test.ts`, `app/test/enableConversationAutomation.test.ts` - their tests (DynamoDB Local, per-file database, `hc-test-<uuid>-` prefixes).
- `e2e/tests/dashboard-next/share-skip-fix.spec.ts` - the end-to-end proof.

Modified files (one responsibility each):
- `app/src/lib/import/apply.ts` - one-to-one rows import as `auto` (D3).
- `RUNBOOK.md` - the "a conversation tripped the breaker" section (D9).
- `app/src/repos/broadcastsRepo.ts` - `created_via` on the item, the `skipped_other` bucket, the prior-recipients union without skipped slots.
- `app/src/routes/broadcasts.ts` - the draft route records `created_via: 'dashboard'`.
- `app/src/jobs/broadcastFanOut.ts` - person's sends for dashboard shares, a deleted fence, distinct first-fence reasons, bucket routing, finalize log from derived stats.
- `app/src/services/sendMessage.ts` - `recipient` input so the deleted and consent gates judge the fenced recipient (I8) without a second read.
- `app/test/helpers/twilioWebhookHarness.ts` - the in-memory double mirrors `create()` and `priorRecipientContactIds`.
- `app/src/lib/seed/lean.ts` - one more tenant with a switched-off one-to-one conversation; `app/src/lib/seed/matrix.ts`, `app/src/lib/seed/performance.ts` - seeded shares carry `created_via: 'dashboard'` and `skipped_other: 0`.
- `dashboard/src/api/types.ts` - `skipped_other?` on `BroadcastStats`.
- `dashboard/src/routes/contact/deliveryStatus.ts` - `SHARE_SKIP_REASONS` + `shareSkipReason`.
- `dashboard/src/routes/broadcasts/broadcastFormat.ts` - `shareRecipientReason`, `presentShareLabel`.
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx`, `BroadcastStatusPill.tsx`, `BroadcastResults.tsx`, `BroadcastsList.tsx`, `StatChips.tsx` - render the reasons, the label and the new bucket.
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx` - `seeded` on the row, hand-adds pre-checked, Select all keeps seeded rows, the note copy.
- `dashboard/src/routes/broadcasts/resolveTemplate.ts`, `BroadcastComposer.tsx`, `MessageEditor.tsx` - the one-to-one default text.
- Tests beside each of the above; `e2e/tests/dashboard-next/matching-entry-points.spec.ts` (the D8 pin); `e2e/tests/dashboard-next/contacts-list-facets.spec.ts` (a stale comment).

Slices and the order they are built:
1. Slice 1 - Tasks 1-5 (census, fix script, import default, RUNBOOK, slice gates + handoff).
2. Slice 2 - Tasks 6-7 (recipient reasons + buckets; person's sends).
3. Slice 3 - Tasks 8-9 ("Already sent" rule; review list).
4. Slice 4 - Tasks 10-11 (dashboard reasons + counts; "Not sent" label).
5. Slice 5 - Task 12 (one-to-one default text).
6. Slice 6 - Tasks 13-15 (lean seed, e2e, final gates + main sync + handback).

Test commands used throughout (run from the named workspace; DynamoDB Local must be up: `npm run db:start` from the repo root):
- app unit/integration, one file: `cd app; npx vitest run test/<file>.test.ts`
- dashboard, one file: `cd dashboard; npx vitest run src/routes/broadcasts/<file>.test.tsx`
- typecheck everything: `npm run typecheck` (repo root; it includes `tsc -p tsconfig.test.json`, so test literals must type-check too)

A note on "Run it to verify it fails": most steps are true red-green. Where a listed test is a REGRESSION PIN that is already green on today's code, the step says so; a builder must not report a red state they did not see.

---

### Task 1: Read-only census script (spec D1) + the shared stage resolver

**Files:**
- Create: `app/scripts/lib/stageClient.ts`
- Create: `app/scripts/conversation-automation-census.ts`
- Test: `app/test/stageClient.test.ts`
- Test: `app/test/conversationAutomationCensus.test.ts`

**Interfaces:**
- Consumes: `assertHousingChoiceAccount`, `hcCredentials`, `HC_ACCOUNT_ID`, `HC_PROFILE`, `HC_REGION` from `scripts/lib/hcAws.mjs`; `tableName` from `app/src/lib/config.ts`; `queryAll` from `app/src/lib/dynamoPaging.ts`; `isOneToOneBucket` from `app/src/lib/unreadFeed.ts`; `DISCONTINUED_REMINDER_KINDS`, `retiredByTourStart`, `resolveUsableGroup` (exported, `app/src/jobs/tourReminders.ts:1496`), `RunDueTourRemindersDeps` type from `app/src/jobs/tourReminders.ts`; `isSupersededRung` from `app/src/lib/ladderPointer.ts`; repos `createToursRepo`, `createTourRemindersRepo`, `createPlacementNudgesRepo`, `createContactsRepo`, `createConversationsRepo` (all take `{ doc, env }`).
- Produces: `resolveStageClient(target, deps, opts)` -> `{ doc, env, endpoint, prefix, accessKeyId, describe }` (Task 2 reuses it); `parseStageTarget`, `parseLane`; `runConversationAutomationCensus(opts)` -> `AutomationCensus`; `reportCensus(census)`; `findBreakerTrip`, `isPointerRow` (Task 2 imports them).

- [ ] **Step 1: Write the failing stage-resolver test**

`app/test/stageClient.test.ts`:

```ts
// The shared --env stage resolver for the share-skip-fix ops scripts. The
// guard MUST bind to the client the script writes through (spec D2 "Target
// safety"): a wrong-account identity refuses BEFORE any client is built, and
// `local` never consults AWS at all. DynamoDB Local without -sharedDb keeps
// ONE DATABASE PER ACCESS KEY (e2e/support/lane.mjs:150-168), so a lane is
// selected by its key `hclane<L>` as much as by its prefix - a prefix alone
// would read (and write) the wrong database.
import { describe, expect, it } from 'vitest';
import { parseLane, resolveStageClient } from '../scripts/lib/stageClient.js';

describe('resolveStageClient', () => {
  it('local (no lane): DynamoDB Local, key local, hc-local- prefix - the live local dev stack; no account guard call', async () => {
    let guardCalls = 0;
    const stage = await resolveStageClient('local', {
      assertAccount: async () => {
        guardCalls += 1;
        return { Account: '938565869261' };
      },
    });
    expect(stage.endpoint).toBe('http://localhost:8000');
    expect(stage.prefix).toBe('hc-local-');
    expect(stage.accessKeyId).toBe('local');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-');
    expect(guardCalls).toBe(0);
    stage.doc.destroy();
  });

  it('local --lane L: the lane prefix AND the lane access key, together (never one without the other)', async () => {
    const stage = await resolveStageClient('local', {}, { lane: 3 });
    expect(stage.prefix).toBe('hc-local-3-');
    expect(stage.accessKeyId).toBe('hclane3');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-3-');
    expect(stage.env.AWS_ACCESS_KEY_ID).toBe('hclane3');
    stage.doc.destroy();
  });

  it('parseLane: a positive integer only (lane 0 is the live stack and has no key of its own)', () => {
    expect(parseLane('3')).toBe(3);
    expect(parseLane('0')).toBeUndefined();
    expect(parseLane('-1')).toBeUndefined();
    expect(parseLane('x')).toBeUndefined();
    expect(parseLane(undefined)).toBeUndefined();
  });

  it('dev/prod: REFUSE a lane before any AWS call (the stage alone picks real tables)', async () => {
    let guardCalls = 0;
    await expect(
      resolveStageClient('dev', { assertAccount: async () => { guardCalls += 1; return { Account: '938565869261' }; } }, { lane: 3 }),
    ).rejects.toThrow(/--lane/);
    expect(guardCalls).toBe(0);
  });

  it('prod: REFUSES when the profile resolves to any account but 938565869261', async () => {
    await expect(
      resolveStageClient('prod', {
        assertAccount: async () => ({ Account: '000000000000', Arn: 'arn:aws:iam::000000000000:user/x' }),
      }),
    ).rejects.toThrow(/ACCOUNT GUARD/);
  });

  it('dev: builds the client from the injected profile credentials after the guard passes', async () => {
    let credentialCalls = 0;
    const stage = await resolveStageClient('dev', {
      assertAccount: async () => ({ Account: '938565869261', Arn: 'arn:aws:iam::938565869261:user/housingchoice' }),
      credentials: () => {
        credentialCalls += 1;
        return async () => ({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' });
      },
    });
    expect(stage.prefix).toBe('hc-dev-');
    expect(stage.endpoint).toBeUndefined();
    expect(stage.accessKeyId).toBeUndefined();
    expect(credentialCalls).toBe(1);
    stage.doc.destroy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/stageClient.test.ts`
Expected: FAIL - `Cannot find module '../scripts/lib/stageClient.js'`.

- [ ] **Step 3: Write the stage resolver**

`app/scripts/lib/stageClient.ts`:

```ts
// The ONE stage resolver for the share-skip-fix ops scripts (the census and
// the fix script). Mirrors import-apply.ts / rail-verify.ts: `--env` picks the
// tables AND the credentials, no ambient env vars decide anything.
//
//   local          -> hc-local-*     at DynamoDB Local, access key `local`
//                     (= the human's live `npm run dev -- --local` stack;
//                     an AGENT NEVER TARGETS THIS - AGENTS.md)
//   local --lane L -> hc-local-L-*   at DynamoDB Local, access key `hclaneL`
//                     (a hermetic e2e lane: the ONLY local target an agent
//                     may use; see e2e/support/lane.mjs laneAccessKeyId)
//   dev            -> hc-dev-*       on AWS via the pinned `housingchoice` profile
//   prod           -> hc-prod-*      on AWS via the pinned `housingchoice` profile
//
// WHY THE LANE SETS THE KEY: DynamoDB Local runs WITHOUT -sharedDb, so each
// (accessKeyId, region) pair is its own database (scripts/db.mjs). A lane's
// tables exist only inside database `hclane<L>`; the same prefix under key
// `local` is a different database (and the live one). The two are therefore
// derived from ONE `--lane` argument and never set separately.
//
// THE ACCOUNT GUARD MUST BIND TO THE CLIENT THE SCRIPT WRITES THROUGH. On the
// operator machine the default credential chain belongs to an UNRELATED
// account (scripts/lib/hcAws.mjs), so asserting the account and then building
// a client from the default chain would prove an account the writes never
// touch. Every dev/prod client here is built from `hcCredentials()`, and the
// guard is re-checked here (not only inside assertHousingChoiceAccount) so a
// test can inject a wrong-account identity and prove the refusal.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import {
  assertHousingChoiceAccount,
  hcCredentials,
  HC_ACCOUNT_ID,
  HC_PROFILE,
  HC_REGION,
} from '../../../scripts/lib/hcAws.mjs';

export const STAGE_TARGETS = ['local', 'dev', 'prod'] as const;
export type StageTarget = (typeof STAGE_TARGETS)[number];

export const LOCAL_ENDPOINT = 'http://localhost:8000';

export interface StageClientDeps {
  /** Test seam: the identity check. Defaults to the real STS call on the profile. */
  assertAccount?: () => Promise<{ Account?: string; Arn?: string }>;
  /** Test seam: the credentials the dev/prod client is built from. */
  credentials?: () => AwsCredentialIdentityProvider;
}

export interface StageClientOpts {
  /**
   * LOCAL ONLY: the hermetic e2e lane to target (a positive integer). Sets
   * BOTH the table prefix `hc-local-<L>-` and the DynamoDB Local access key
   * `hclane<L>` (e2e/support/lane.mjs laneAccessKeyId - the format is pinned
   * by stageClient.test.ts). Refused for dev/prod: there the stage alone
   * picks the tables, so a typo can never point a prod run at another prefix.
   */
  lane?: number;
}

export interface StageClient {
  doc: DynamoDBDocumentClient;
  /** Env carrying the stage's TABLE_PREFIX (and the lane key) - hand it to every repo/tableName call. */
  env: NodeJS.ProcessEnv;
  /** Set for local only; undefined means real AWS. */
  endpoint: string | undefined;
  prefix: string;
  /** The DynamoDB Local access key (selects the database); undefined on AWS. */
  accessKeyId: string | undefined;
  /** For the target line the scripts log first. */
  describe: string;
}

export function parseStageTarget(raw: string | undefined): StageTarget | undefined {
  return STAGE_TARGETS.includes(raw as StageTarget) ? (raw as StageTarget) : undefined;
}

/** A lane number: a positive integer. Lane 0 is the live dev stack, which has
 *  no key of its own (it rides the `local` fallback) - not a lane here. */
export function parseLane(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

/** Mirrors e2e/support/lane.mjs laneAccessKeyId - alphanumeric only (DynamoDB
 *  Local rejects `-`/`_` in a key once -sharedDb is off). */
export function laneAccessKeyId(lane: number): string {
  return `hclane${lane}`;
}

export async function resolveStageClient(
  target: StageTarget,
  deps: StageClientDeps = {},
  opts: StageClientOpts = {},
): Promise<StageClient> {
  if (opts.lane !== undefined && target !== 'local') {
    throw new Error(`--lane is accepted with --env local only (got --env ${target}); refusing to continue.`);
  }
  const marshallOptions = { removeUndefinedValues: true };
  if (target === 'local') {
    const prefix = opts.lane !== undefined ? `hc-local-${opts.lane}-` : 'hc-local-';
    const accessKeyId = opts.lane !== undefined ? laneAccessKeyId(opts.lane) : 'local';
    const env: NodeJS.ProcessEnv = { ...process.env, TABLE_PREFIX: prefix, AWS_ACCESS_KEY_ID: accessKeyId };
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: HC_REGION,
        endpoint: LOCAL_ENDPOINT,
        credentials: { accessKeyId, secretAccessKey: 'local' },
      }),
      { marshallOptions },
    );
    return {
      doc,
      env,
      endpoint: LOCAL_ENDPOINT,
      prefix,
      accessKeyId,
      describe: `DynamoDB Local ${LOCAL_ENDPOINT} database ${accessKeyId}${opts.lane !== undefined ? ` (e2e lane ${opts.lane})` : ' (the live local dev stack)'}`,
    };
  }
  const prefix = `hc-${target}-`;
  const env: NodeJS.ProcessEnv = { ...process.env, TABLE_PREFIX: prefix };
  const identity = await (deps.assertAccount ?? assertHousingChoiceAccount)();
  if (identity.Account !== HC_ACCOUNT_ID) {
    throw new Error(
      `ACCOUNT GUARD: profile "${HC_PROFILE}" resolves to account ${identity.Account}, ` +
        `but HousingChoice is pinned to ${HC_ACCOUNT_ID}. Refusing to continue.`,
    );
  }
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: HC_REGION, credentials: (deps.credentials ?? hcCredentials)() }),
    { marshallOptions },
  );
  return {
    doc,
    env,
    endpoint: undefined,
    prefix,
    accessKeyId: undefined,
    describe: `AWS ${HC_REGION} account ${identity.Account} (profile ${HC_PROFILE})`,
  };
}

/** Shared CLI parsing for the two scripts: `--env` (required), `--lane`
 *  (local only), plus the caller's own value/flag names. Unknown arguments are
 *  REFUSED, never ignored - a mistyped flag must never turn a rehearsal into a
 *  live apply, nor the reverse. */
export function parseStageArgs(
  argv: string[],
  known: { values: string[]; flags: string[] },
): { target: StageTarget; lane: number | undefined; values: Map<string, string>; flags: Set<string> } | { usage: true } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueNames = new Set(['--env', '--lane', ...known.values]);
  const flagNames = new Set(known.flags);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (valueNames.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { usage: true };
      values.set(a, v);
      i += 1;
    } else if (flagNames.has(a)) flags.add(a);
    else return { usage: true };
  }
  const target = parseStageTarget(values.get('--env'));
  if (target === undefined) return { usage: true };
  const rawLane = values.get('--lane');
  const lane = parseLane(rawLane);
  if (rawLane !== undefined && lane === undefined) return { usage: true };
  return { target, lane, values, flags };
}
```

- [ ] **Step 4: Run the stage-resolver test to verify it passes**

Run: `cd app; npx vitest run test/stageClient.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing census test**

`app/test/conversationAutomationCensus.test.ts`:

```ts
// The read-only census (spec D1) against DynamoDB Local: every group the spec
// names, each proven by one seeded row, and the invariant that it WRITES NOTHING.
import { randomUUID } from 'node:crypto';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { runConversationAutomationCensus } from '../scripts/conversation-automation-census.js';

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
if (!reachable) {
  console.warn(`[conversationAutomationCensus] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

const TABLES = ['conversations', 'audit_events', 'contacts', 'tours', 'tourReminders', 'placementNudges'] as const;
const NOW = '2026-09-25T12:00:00.000Z';

describe.skipIf(!reachable)('conversation-automation-census against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const t = (base: string): string => tableName(base, env);

  beforeAll(async () => {
    for (const base of TABLES) await ensureTable(client, getTableSpec(base), t(base));
  }, 120_000);
  afterAll(async () => {
    for (const base of TABLES) await deleteTableIfExists(client, t(base));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function put(base: string, item: Record<string, unknown>): Promise<void> {
    await doc.send(new PutCommand({ TableName: t(base), Item: item }));
  }
  async function scanAll(base: string): Promise<Record<string, unknown>[]> {
    const { Items } = await doc.send(new ScanCommand({ TableName: t(base) }));
    return (Items ?? []) as Record<string, unknown>[];
  }

  it('groups every row the way the spec names, lists breaker trips, replays the reminder routing, and writes nothing', async () => {
    const audit = createAuditRepo({ doc, env });
    // Conversations: one of each group.
    await put('conversations', { conversationId: 'c-import-manual', participant_phone: '+15550000001', status: 'open', last_activity_at: NOW, type: 'unknown_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await put('conversations', { conversationId: 'c-breaker', participant_phone: '+15550000002', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await audit.append('conversations#c-breaker', 'message_sent', { automated: true });
    await audit.append('conversations#c-breaker', 'mode_changed', { from: 'auto', to: 'manual', reason: 'breaker_trip' });
    await put('conversations', { conversationId: 'c-other-manual', participant_phone: '+15550000003', status: 'open', last_activity_at: NOW, type: 'landlord_1to1', ai_mode: 'manual', created_at: NOW });
    await put('conversations', { conversationId: 'c-auto', participant_phone: '+15550000004', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'auto', created_at: NOW });
    await put('conversations', { conversationId: 'c-unset', participant_phone: '+15550000005', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', created_at: NOW });
    await put('conversations', { conversationId: 'c-typeless', participant_phone: '+15550000006', status: 'open', last_activity_at: NOW, ai_mode: 'manual', created_at: NOW });
    // A USABLE relay group (open, pool number, roster) and a CLOSED one.
    await put('conversations', { conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', participants: [{ contactId: 'ten-off', phone: '+15550000001' }], created_at: NOW });
    await put('conversations', { conversationId: 'c-relay-closed', status: 'closed', relay_status: 'relay_group#closed', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009002', participant_phone: '+15550009002', participants: [{ contactId: 'ten-off', phone: '+15550000001' }], created_at: NOW });
    await put('conversations', { conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    // Pointer items: a claim that MATCHES its row, a claim that points ELSEWHERE, and an email claim.
    await put('conversations', { conversationId: 'phone#+15550000001', ref_conversationId: 'c-import-manual' });
    await put('conversations', { conversationId: 'phone#+15550000002', ref_conversationId: 'c-somewhere-else' });
    await put('conversations', { conversationId: 'email#x@example.com', ref_conversationId: 'c-auto' });

    // Tour rungs: contact + tour per case.
    await put('contacts', { contactId: 'ten-off', type: 'tenant', status: 'searching', phone: '+15550000001', firstName: 'A', lastName: 'B', created_at: NOW });
    await put('contacts', { contactId: 'ten-trip', type: 'tenant', status: 'searching', phone: '+15550000002', firstName: 'T', lastName: 'R', created_at: NOW });
    await put('contacts', { contactId: 'ten-on', type: 'tenant', status: 'searching', phone: '+15550000004', firstName: 'C', lastName: 'D', created_at: NOW });
    const tours = createToursRepo({ doc, env });
    const reminders = createTourRemindersRepo({ doc, env });
    const offTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const tripTour = await tours.create({ tenantId: 'ten-trip', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const onTour = await tours.create({ tenantId: 'ten-on', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const groupTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'landlord_led' });
    await tours.patch(groupTour.tourId, { groupThreadId: 'c-relay' });
    const fallbackTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'landlord_led' });
    await tours.patch(fallbackTour.tourId, { groupThreadId: 'c-relay-closed' }); // unusable group -> tenant 1:1
    const pastTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-09-01T15:00:00.000Z', tourType: 'self_guided' });
    const supersededTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    await tours.patch(supersededTour.tourId, { currentLadderId: 'ladder-2' }); // a rung with no ladderId is superseded
    await reminders.create({ tourId: offTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: tripTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: onTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: groupTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: fallbackTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: pastTour.tourId, kind: 'day_before', dueAt: '2026-08-31T23:00:00.000Z' });
    await reminders.create({ tourId: supersededTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: offTour.tourId, kind: 'confirmation', dueAt: '2026-09-26T09:00:00.000Z' });
    await reminders.create({ tourId: offTour.tourId, kind: 'morning_of', dueAt: '2026-10-01T11:00:00.000Z', skipped: { at: NOW, reason: 'tenant_not_on_roster' } });
    // Nudges: two pending, one sent.
    const nudges = createPlacementNudgesRepo({ doc, env });
    await nudges.create({ placementId: 'p1', kind: 'receipt_check', dueAt: '2026-09-26T00:00:00.000Z' });
    await nudges.create({ placementId: 'p1', kind: 'completion_check', dueAt: '2026-09-27T00:00:00.000Z' });
    const sentNudge = await nudges.create({ placementId: 'p2', kind: 'approval_check', dueAt: '2026-09-20T00:00:00.000Z' });
    await nudges.claimSend(sentNudge.nudgeId, NOW);

    const before = {
      conversations: await scanAll('conversations'),
      audit: await scanAll('audit_events'),
      reminders: await scanAll('tourReminders'),
    };

    const census = await runConversationAutomationCensus({ doc, env, now: NOW });

    expect(census.pointerRows).toBe(3);
    expect(census.byType).toEqual({
      unknown_1to1: { auto: 0, manual: 1, unset: 0 },
      tenant_1to1: { auto: 1, manual: 1, unset: 1 },
      landlord_1to1: { auto: 0, manual: 1, unset: 0 },
      '(none)': { auto: 0, manual: 1, unset: 0 },
      relay_group: { auto: 0, manual: 2, unset: 0 },
      group_text: { auto: 0, manual: 1, unset: 0 },
    });
    // Cause precedence: group thread, then breaker trip, then imported, then other.
    expect(census.manualByCause).toEqual({ groupThread: 3, breakerTrip: 1, imported: 1, other: 2 });
    expect(census.breakerTripped).toEqual([
      { conversationId: 'c-breaker', type: 'tenant_1to1', trippedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    expect(census.importClaimMismatches).toBe(1);
    // The job's own routing, replayed: usable group -> group; unusable group ->
    // the tenant 1:1; a breaker-tripped 1:1 is its own line because the bulk
    // fix script leaves those rows alone.
    expect(census.pendingTourRungs).toEqual({
      oneToOneSwitchedOff: 2, // offTour + fallbackTour (closed group -> tenant 1:1)
      oneToOneBreakerTripped: 1, // tripTour
      oneToOneSwitchedOn: 1, // onTour
      groupRouted: 1, // groupTour (usable relay group)
      tourPast: 1,
      superseded: 1,
      discontinued: 1,
      unresolvable: 0,
    });
    expect(census.pendingNudgesHeldManualOnly).toBe(2);

    // READ-ONLY: not one row changed in any table the census reads.
    expect(await scanAll('conversations')).toEqual(before.conversations);
    expect(await scanAll('audit_events')).toEqual(before.audit);
    expect(await scanAll('tourReminders')).toEqual(before.reminders);
  }, 120_000);
});
```

- [ ] **Step 6: Run the census test to verify it fails**

Run: `cd app; npx vitest run test/conversationAutomationCensus.test.ts`
Expected: FAIL - `Cannot find module '../scripts/conversation-automation-census.js'`.

- [ ] **Step 7: Write the census script**

`app/scripts/conversation-automation-census.ts`:

```ts
// conversation-automation-census - READ-ONLY census of the per-conversation
// `ai_mode` switch (share-skip-fix spec D1). Counts only: no names, phones or
// bodies are ever logged or reported. Conversation ids ARE reported (the
// breaker list is for the operator to review one by one).
//
// It answers, for one stage:
//   - every conversation row by type and switch state (pointer items excluded,
//     rows with no type reported as their own group);
//   - switched-off rows by cause, in this precedence: group thread (off by
//     design), breaker trip (a `mode_changed` audit event with reason
//     `breaker_trip`), imported (the import stamp), other;
//   - the breaker-tripped rows, individually;
//   - pending tour-reminder rungs, routed the way the reminder job routes them
//     (jobs/tourReminders.ts resolveReminderTarget): discontinued kinds, tours
//     already started and superseded ladders retire without sending; a
//     non-self_guided tour with a USABLE group goes to the group; everything
//     else goes to the tenant's one-to-one conversation, reported by that
//     conversation's switch state - `oneToOneSwitchedOff` is what the bulk
//     fix script RELEASES, `oneToOneBreakerTripped` is what it leaves alone.
//     The quiet-hours deferral is not replayed (it delays, never retires), so
//     the released count is exact for today's pending rows, not a forecast;
//   - pending placement nudges, reported separately: they are held manual-only
//     today and the fix script releases none of them;
//   - imported one-to-one rows whose phone claim points at a DIFFERENT row (a
//     missing claim is the normal state for an imported row).
//
// TARGET: `--env local|dev|prod` (required) resolves the tables and the
// credentials through scripts/lib/stageClient.ts; dev/prod run the account
// guard first and never touch the default credential chain. An agent runs
// this ONLY with `--env local --lane <L>` against a hermetic e2e lane it
// started; a bare `--env local` is the human's live local stack. NO AGENT
// RUNS THIS AGAINST A REAL ENVIRONMENT; the human does.
//
// Run: npx tsx app/scripts/conversation-automation-census.ts --env dev
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCONTINUED_REMINDER_KINDS,
  resolveUsableGroup,
  retiredByTourStart,
  type RunDueTourRemindersDeps,
} from '../src/jobs/tourReminders.js';
import { tableName } from '../src/lib/config.js';
import { queryAll } from '../src/lib/dynamoPaging.js';
import { isSupersededRung } from '../src/lib/ladderPointer.js';
import { logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem } from '../src/repos/toursRepo.js';
import { parseStageArgs, resolveStageClient } from './lib/stageClient.js';

/** Pointer partitions in the conversations table (claims + reply tokens). They
 *  carry only a key and a ref - never a conversation. Mirrors the private list
 *  in lib/unreadFeed.ts. */
export const POINTER_PREFIXES = ['phone#', 'email#', 'token#'] as const;

/** A dueAt bound past every real rung: listDue(FAR_FUTURE) = every pending row. */
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

export type SwitchState = 'auto' | 'manual' | 'unset';

export interface AutomationCensus {
  scannedRows: number;
  pointerRows: number;
  byType: Record<string, Record<SwitchState, number>>;
  manualByCause: { groupThread: number; breakerTrip: number; imported: number; other: number };
  breakerTripped: Array<{ conversationId: string; type: string; trippedAt: string }>;
  pendingTourRungs: {
    /** Would send once the bulk fix script runs. */
    oneToOneSwitchedOff: number;
    /** Held by a breaker-tripped conversation; the bulk run leaves these off. */
    oneToOneBreakerTripped: number;
    oneToOneSwitchedOn: number;
    /** Routed to a usable relay group; the switch never applies. */
    groupRouted: number;
    tourPast: number;
    superseded: number;
    discontinued: number;
    unresolvable: number;
  };
  pendingNudgesHeldManualOnly: number;
  importedOneToOneRows: number;
  importClaimMismatches: number;
}

export function switchStateOf(row: Pick<ConversationItem, 'ai_mode'>): SwitchState {
  if (row.ai_mode === 'manual') return 'manual';
  if (row.ai_mode === 'auto') return 'auto';
  return 'unset';
}

export function isPointerRow(conversationId: string): boolean {
  return POINTER_PREFIXES.some((p) => conversationId.startsWith(p));
}

/** The breaker trip on record for a conversation, newest first, or undefined.
 *  A PAGED, FILTERED query: the audit partition also holds one `message_sent`
 *  per send, so an old trip can sit behind many newer events and
 *  auditRepo.listByEntity's single page would miss it. */
export async function findBreakerTrip(
  doc: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  conversationId: string,
): Promise<AuditEvent | undefined> {
  const events = await queryAll<AuditEvent>(doc, {
    TableName: tableName('audit_events', env),
    KeyConditionExpression: '#e = :e',
    FilterExpression: '#t = :t',
    ExpressionAttributeNames: { '#e': 'entityKey', '#t': 'event_type' },
    ExpressionAttributeValues: { ':e': `conversations#${conversationId}`, ':t': 'mode_changed' },
    ScanIndexForward: false,
  });
  return events.find((e) => (e.payload as { reason?: unknown } | undefined)?.reason === 'breaker_trip');
}

export interface CensusOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** The instant "tour already started" is judged against. Defaults to now. */
  now?: string;
  /** Scan page bound (tests exercise the paging loop with it). */
  scanLimit?: number;
}

export async function runConversationAutomationCensus(opts: CensusOpts): Promise<AutomationCensus> {
  const { doc, env } = opts;
  const now = opts.now ?? new Date().toISOString();
  const census: AutomationCensus = {
    scannedRows: 0,
    pointerRows: 0,
    byType: {},
    manualByCause: { groupThread: 0, breakerTrip: 0, imported: 0, other: 0 },
    breakerTripped: [],
    pendingTourRungs: {
      oneToOneSwitchedOff: 0,
      oneToOneBreakerTripped: 0,
      oneToOneSwitchedOn: 0,
      groupRouted: 0,
      tourPast: 0,
      superseded: 0,
      discontinued: 0,
      unresolvable: 0,
    },
    pendingNudgesHeldManualOnly: 0,
    importedOneToOneRows: 0,
    importClaimMismatches: 0,
  };

  // ---- Conversations: one Scan, every row classified; claims collected ------
  const phoneClaims = new Map<string, string>();
  const importedOneToOne: Array<{ conversationId: string; phone: string }> = [];
  const breakerTrippedIds = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName('conversations', env),
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      census.scannedRows += 1;
      if (isPointerRow(raw.conversationId)) {
        census.pointerRows += 1;
        if (raw.conversationId.startsWith('phone#') && typeof raw.ref_conversationId === 'string') {
          phoneClaims.set(raw.conversationId.slice('phone#'.length), raw.ref_conversationId);
        }
        continue;
      }
      const typeKey = typeof raw.type === 'string' ? raw.type : '(none)';
      const bucket = (census.byType[typeKey] ??= { auto: 0, manual: 0, unset: 0 });
      const state = switchStateOf(raw);
      bucket[state] += 1;
      const imported = typeof raw.imported_from === 'string';
      if (isOneToOneBucket(raw) && imported && typeof raw.participant_phone === 'string') {
        importedOneToOne.push({ conversationId: raw.conversationId, phone: raw.participant_phone });
      }
      if (state !== 'manual') continue;
      if (!isOneToOneBucket(raw)) {
        census.manualByCause.groupThread += 1;
        continue;
      }
      const trip = await findBreakerTrip(doc, env, raw.conversationId);
      if (trip !== undefined) {
        census.manualByCause.breakerTrip += 1;
        breakerTrippedIds.add(raw.conversationId);
        census.breakerTripped.push({
          conversationId: raw.conversationId,
          type: typeKey,
          trippedAt: trip.ts.split('#')[0] ?? trip.ts,
        });
        continue;
      }
      if (imported) census.manualByCause.imported += 1;
      else census.manualByCause.other += 1;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  census.importedOneToOneRows = importedOneToOne.length;
  for (const row of importedOneToOne) {
    const claim = phoneClaims.get(row.phone);
    if (claim !== undefined && claim !== row.conversationId) census.importClaimMismatches += 1;
  }

  // ---- Pending tour rungs: replay the job's target resolution -------------
  const tours = createToursRepo({ doc, env });
  const reminders = createTourRemindersRepo({ doc, env });
  const contacts = createContactsRepo({ doc, env });
  const conversations = createConversationsRepo({ doc, env });
  // resolveUsableGroup reads only deps.conversationsRepo (tourReminders.ts:1496-1530);
  // the cast hands it that one dependency rather than a whole job wiring.
  const usabilityDeps = { conversationsRepo: conversations } as unknown as RunDueTourRemindersDeps;
  const tourCache = new Map<string, TourItem | undefined>();
  const tourFor = async (tourId: string): Promise<TourItem | undefined> => {
    if (tourCache.has(tourId)) return tourCache.get(tourId);
    const tour = await tours.get(tourId);
    tourCache.set(tourId, tour);
    return tour;
  };
  for (const rung of await reminders.listDue(FAR_FUTURE)) {
    const r = census.pendingTourRungs;
    if (DISCONTINUED_REMINDER_KINDS.has(rung.kind)) {
      r.discontinued += 1;
      continue;
    }
    const tour = await tourFor(rung.tourId);
    if (!tour) {
      r.unresolvable += 1;
      continue;
    }
    if (retiredByTourStart(rung, tour.scheduledAt, now)) {
      r.tourPast += 1;
      continue;
    }
    if (isSupersededRung(rung, tour)) {
      r.superseded += 1;
      continue;
    }
    if (tour.tourType !== 'self_guided') {
      const group = await resolveUsableGroup(tour, rung, usabilityDeps, logger);
      if (group !== undefined) {
        r.groupRouted += 1;
        continue;
      }
      // Unusable group: the job falls back to the tenant 1:1 - so does this.
    }
    const contact = await contacts.getById(tour.tenantId);
    const phone = contact?.phone;
    if (typeof phone !== 'string' || phone.length === 0) {
      r.unresolvable += 1;
      continue;
    }
    const convs = await conversations.findByParticipantPhone(phone);
    const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
    if (!conv) {
      r.unresolvable += 1;
      continue;
    }
    if (conv.ai_mode !== 'manual') r.oneToOneSwitchedOn += 1;
    else if (breakerTrippedIds.has(conv.conversationId)) r.oneToOneBreakerTripped += 1;
    else r.oneToOneSwitchedOff += 1;
  }

  // ---- Pending nudges: held manual-only, unaffected by the fix script ------
  const nudges = createPlacementNudgesRepo({ doc, env });
  census.pendingNudgesHeldManualOnly = (await nudges.listDue(FAR_FUTURE)).length;

  return census;
}

/** Log the census (counts + the breaker list) and return the exit code. */
export function reportCensus(census: AutomationCensus): 0 {
  logger.info({ ...census, breakerTripped: undefined }, 'conversation-automation-census - counts');
  for (const trip of census.breakerTripped) {
    logger.info(trip, 'conversation-automation-census - breaker-tripped conversation (review before enabling)');
  }
  logger.info(
    {
      breakerTripped: census.breakerTripped.length,
      rungsReleasedByBulkEnable: census.pendingTourRungs.oneToOneSwitchedOff,
      rungsHeldByBreakerTrips: census.pendingTourRungs.oneToOneBreakerTripped,
      pendingNudgesHeldManualOnly: census.pendingNudgesHeldManualOnly,
    },
    'conversation-automation-census - done (read-only; nothing written). rungsReleasedByBulkEnable start sending after the bulk apply; breaker-held rungs only after a single-conversation resume. Pending nudges are held manual-only today and are NOT released by the fix script.',
  );
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('conversation-automation-census.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), { values: [], flags: [] });
  if ('usage' in parsed) {
    console.error(
      'Usage: npx tsx app/scripts/conversation-automation-census.ts --env local|dev|prod [--lane <L>]\n' +
        '  --lane selects a hermetic e2e lane (local only; the only local target an agent may use).',
    );
    process.exit(2);
  }
  resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {})
    .then(async (stage) => {
      logger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix },
        'conversation-automation-census - target resolved (read-only)',
      );
      const census = await runConversationAutomationCensus({ doc: stage.doc, env: stage.env });
      process.exitCode = reportCensus(census);
      stage.doc.destroy();
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'conversation-automation-census - FAILED');
      process.exitCode = 1;
    });
}
```

- [ ] **Step 8: Run the census test to verify it passes**

Run: `cd app; npx vitest run test/conversationAutomationCensus.test.ts`
Expected: PASS. (`tours.patch(tourId, updates)` is at `app/src/repos/toursRepo.ts:387` and writes `groupThreadId` / `currentLadderId`; `reminders.create` accepts `skipped` at `app/src/repos/tourRemindersRepo.ts:161-163`; `listDue` never returns a skipped row, `:155-158`.)

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` (repo root). Expected: exit 0.

```bash
git status
git add app/scripts/lib/stageClient.ts app/scripts/conversation-automation-census.ts app/test/stageClient.test.ts app/test/conversationAutomationCensus.test.ts
git commit -m "feat(ops): conversation-automation census (read-only) + guarded stage resolver

Spec D1. Counts by type and switch state, switched-off rows by cause with the
breaker-tripped list, pending tour rungs routed the way the reminder job routes
them, held nudges, import claim mismatches. --env resolves tables and
credentials; --lane selects a hermetic e2e lane's prefix AND access key;
dev/prod bind the client to the housingchoice profile after the account guard.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The fix script - switch one-to-one conversations on (spec D2)

**Files:**
- Create: `app/scripts/enable-conversation-automation.ts`
- Test: `app/test/enableConversationAutomation.test.ts`

**Interfaces:**
- Consumes: `resolveStageClient`, `parseStageArgs` (Task 1); `findBreakerTrip`, `isPointerRow` (Task 1's census module); `isOneToOneBucket`; `createAuditRepo`; `createConversationsRepo`.
- Produces: `enableConversationAutomation(opts)` -> `EnableResult`; `reportEnableRun(result, apply)` -> exit code; `UsageError` for single-mode refusals. Audit events `mode_changed` `{ from: 'manual', to: 'auto', reason: 'bulk_enable' | 'operator_resume', script: 'enable-conversation-automation' }` (the RUNBOOK in Task 4 names both reasons).

- [ ] **Step 1: Write the failing test**

`app/test/enableConversationAutomation.test.ts`:

```ts
// The fix script (spec D2) against DynamoDB Local: dry run writes nothing;
// apply enables only one-to-one `manual` rows (typeless included, group rows
// and pointer items never); breaker-tripped rows are skipped unless included;
// single mode refuses a group thread or an unknown id as a USAGE error; a
// re-run changes nothing; every change is audited, and a lost audit write is
// named and counted; the conditional write loses to a concurrent change.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import {
  enableConversationAutomation,
  reportEnableRun,
  UsageError,
} from '../scripts/enable-conversation-automation.js';
import { createLogCapture } from './helpers/logCapture.js';

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
if (!reachable) console.warn(`[enableConversationAutomation] SKIPPED - no DynamoDB Local at ${endpoint}.`);

const NOW = '2026-09-25T12:00:00.000Z';
const ERROR = 50;

describe.skipIf(!reachable)('enable-conversation-automation against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const created: string[] = [];

  afterEach(async () => {
    for (const table of created.splice(0)) await deleteTableIfExists(client, table);
  }, 120_000);

  async function seedWorld() {
    const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
    for (const base of ['conversations', 'audit_events'] as const) {
      await ensureTable(client, getTableSpec(base), tableName(base, env));
      created.push(tableName(base, env));
    }
    const put = (item: Record<string, unknown>) =>
      doc.send(new PutCommand({ TableName: tableName('conversations', env), Item: item }));
    await put({ conversationId: 'c-import', participant_phone: '+15550000001', status: 'open', last_activity_at: NOW, type: 'unknown_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await put({ conversationId: 'c-typeless', participant_phone: '+15550000002', status: 'open', last_activity_at: NOW, ai_mode: 'manual', created_at: NOW });
    await put({ conversationId: 'c-breaker', participant_phone: '+15550000003', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'manual', created_at: NOW });
    await createAuditRepo({ doc, env }).append('conversations#c-breaker', 'mode_changed', { from: 'auto', to: 'manual', reason: 'breaker_trip' });
    await put({ conversationId: 'c-auto', participant_phone: '+15550000004', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'auto', created_at: NOW });
    await put({ conversationId: 'c-unset', participant_phone: '+15550000005', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', created_at: NOW });
    await put({ conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', created_at: NOW });
    await put({ conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    await put({ conversationId: 'phone#+15550000001', ref_conversationId: 'c-import' });
    const mode = async (id: string): Promise<unknown> =>
      (await doc.send(new GetCommand({ TableName: tableName('conversations', env), Key: { conversationId: id } }))).Item?.ai_mode;
    const modeEvents = async (id: string) =>
      ((await doc.send(new ScanCommand({ TableName: tableName('audit_events', env) }))).Items ?? []).filter(
        (e) => e.entityKey === `conversations#${id}` && e.event_type === 'mode_changed',
      );
    return { env, mode, modeEvents };
  }

  it('dry run: plans the one-to-one manual rows (breaker-tripped excluded) and writes NOTHING', async () => {
    const w = await seedWorld();
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW });
    expect(result).toMatchObject({
      scanned: 8,
      pointerRows: 1,
      groupRows: 2,
      alreadyOn: 1,
      unset: 1,
      breakerTrippedExcluded: 1,
      planned: 2,
      enabled: 0,
      skippedOnCondition: 0,
      auditFailed: 0,
      failed: 0,
    });
    expect(result.byType).toEqual({ unknown_1to1: 1, '(none)': 1 });
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
    expect(await w.modeEvents('c-import')).toHaveLength(0);
    expect(reportEnableRun(result, false)).toBe(0);
  }, 120_000);

  it('apply: enables exactly the planned rows with an audit event each; a SECOND run is a no-op', async () => {
    const w = await seedWorld();
    const first = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(first).toMatchObject({ planned: 2, enabled: 2, breakerTrippedExcluded: 1, skippedOnCondition: 0, auditFailed: 0, failed: 0 });
    expect(await w.mode('c-import')).toBe('auto');
    expect(await w.mode('c-typeless')).toBe('auto');
    // Untouched: breaker-tripped, already-on, unset, group threads, pointer.
    expect(await w.mode('c-breaker')).toBe('manual');
    expect(await w.mode('c-auto')).toBe('auto');
    expect(await w.mode('c-unset')).toBeUndefined();
    expect(await w.mode('c-relay')).toBe('manual');
    expect(await w.mode('c-group')).toBe('manual');
    expect(await w.mode('phone#+15550000001')).toBeUndefined();
    const events = await w.modeEvents('c-import');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      from: 'manual',
      to: 'auto',
      reason: 'bulk_enable',
      script: 'enable-conversation-automation',
    });
    const second = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true });
    expect(second).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 3 });
    expect(await w.modeEvents('c-import')).toHaveLength(1);
  }, 120_000);

  it('apply with --include-breaker-tripped also enables the tripped row, with the same reason', async () => {
    const w = await seedWorld();
    const result = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, includeBreakerTripped: true });
    expect(result).toMatchObject({ planned: 3, enabled: 3, breakerTrippedExcluded: 0 });
    expect(await w.mode('c-breaker')).toBe('auto');
  }, 120_000);

  it('single mode: resumes ONE conversation with the operator_resume reason and names it; refuses a group thread and an unknown id as usage errors', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const resumed = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker', logger: log });
    expect(resumed).toMatchObject({ planned: 1, enabled: 1, scanned: 1 });
    expect(await w.mode('c-breaker')).toBe('auto');
    expect((await w.modeEvents('c-breaker')).map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'breaker_trip',
      'operator_resume',
    ]);
    // The targeted id is printed up front (spec D2: single mode reports the one id).
    expect(capture.atLevel(30).some((l) => l['conversationId'] === 'c-breaker' && String(l['msg']).includes('single mode'))).toBe(true);
    // Already on: nothing written, reported as alreadyOn.
    const again = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker' });
    expect(again).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 1 });
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-relay' }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-missing' }),
    ).rejects.toThrow(/not found/);
    expect(await w.mode('c-relay')).toBe('manual');
  }, 120_000);

  it('a row the breaker switches OFF again mid-run keeps the runtime outcome: the conditional write loses and is counted', async () => {
    const w = await seedWorld();
    // Between the Scan and the write, flip c-import to a state the condition
    // rejects (auto here stands in for "the runtime moved it").
    let raced = false;
    const racingDoc = {
      send: async (command: unknown) => {
        const out = await (doc as DynamoDBDocumentClient).send(command as never);
        if (command instanceof ScanCommand && !raced) {
          raced = true;
          await doc.send(
            new UpdateCommand({
              TableName: tableName('conversations', w.env),
              Key: { conversationId: 'c-import' },
              UpdateExpression: 'SET ai_mode = :auto',
              ExpressionAttributeValues: { ':auto': 'auto' },
            }),
          );
        }
        return out;
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const result = await enableConversationAutomation({ doc: racingDoc, env: w.env, now: NOW, apply: true });
    expect(raced).toBe(true);
    expect(result.skippedOnCondition).toBe(1);
    expect(result.enabled).toBe(1); // c-typeless still landed
    expect(await w.modeEvents('c-import')).toHaveLength(0); // no audit for a lost write
  }, 120_000);

  it('a lost AUDIT write is named at ERROR, counted, and exits 1 - the switch stays on (I6 is reported, never hidden)', async () => {
    const w = await seedWorld();
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const auditFailingDoc = {
      send: async (command: unknown) => {
        if (command instanceof PutCommand && String((command as PutCommand).input.TableName).endsWith('audit_events')) {
          throw new Error('audit-boom');
        }
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    const result = await enableConversationAutomation({ doc: auditFailingDoc, env: w.env, now: NOW, apply: true, logger: log });
    expect(result).toMatchObject({ planned: 2, enabled: 2, auditFailed: 2 });
    expect(await w.mode('c-import')).toBe('auto');
    expect(await w.mode('c-typeless')).toBe('auto');
    const errors = capture.atLevel(ERROR).filter((l) => String(l['msg']).includes('audit NOT written'));
    expect(errors.map((l) => l['conversationId']).sort()).toEqual(['c-import', 'c-typeless']);
    expect(reportEnableRun(result, true)).toBe(1);
  }, 120_000);

  it('a WRITE failure aborts the run (systemic until proven otherwise) and is reported as FAILED', async () => {
    const w = await seedWorld();
    const failingDoc = {
      send: async (command: unknown) => {
        if (command instanceof UpdateCommand) throw new Error('update-boom');
        return await (doc as DynamoDBDocumentClient).send(command as never);
      },
      destroy: () => {},
    } as unknown as DynamoDBDocumentClient;
    await expect(
      enableConversationAutomation({ doc: failingDoc, env: w.env, now: NOW, apply: true }),
    ).rejects.toThrow('update-boom');
    expect(await w.mode('c-import')).toBe('manual');
    expect(await w.mode('c-typeless')).toBe('manual');
  }, 120_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/enableConversationAutomation.test.ts`
Expected: FAIL - `Cannot find module '../scripts/enable-conversation-automation.js'`.

- [ ] **Step 3: Write the fix script**

`app/scripts/enable-conversation-automation.ts`:

```ts
// enable-conversation-automation - ONE-TIME, IDEMPOTENT: switch one-to-one
// conversations from `ai_mode = manual` back to `auto` (share-skip-fix spec D2).
//
// WHY. The Quo import created every conversation `manual`, and the one-to-one
// send wrapper refuses EVERY automated text on a manual conversation - staff
// property sends (until Branch A), tour reminders, the missed-call text, the
// welcome text and the 30003 retry. Nothing else ever turns the switch back on:
// there is no UI or API, and the breaker only turns it off.
//
// POPULATION (bulk mode): rows whose `ai_mode` is exactly `manual` and whose
// type is NOT relay_group / group_text - the codebase's own one-to-one
// definition (lib/unreadFeed.ts isOneToOneBucket), which includes legacy rows
// with no type. Pointer items (phone#/email#/token#) carry no ai_mode and are
// never matched. A row with NO ai_mode is left alone (the wrapper already reads
// absent as auto). A row with a breaker trip on record (a `mode_changed` audit
// event with reason `breaker_trip`) is EXCLUDED unless --include-breaker-tripped
// is passed: Cameron reviews the census list first.
//
// SINGLE MODE (--conversation <id>): the breaker-resume path. Enables that one
// row; refuses an unknown id or a group thread as a USAGE error (exit 2, no
// partial-run banner); reports an already-on row.
//
// EVERY WRITE IS CONDITIONAL on the row still being a one-to-one conversation
// with the switch off, so a re-run and a concurrent runtime write are both
// safe: a lost condition is counted `skippedOnCondition`, never overwritten.
// Every enable appends a `mode_changed` audit event (manual -> auto) whose
// reason tells a bulk enable (`bulk_enable`) from a resume (`operator_resume`).
// The switch write and the audit write are two operations: if the audit write
// fails AFTER the switch landed, the row is on and a re-run would report it
// `alreadyOn`, so that case is NAMED at ERROR (conversationId + "audit NOT
// written"), counted `auditFailed`, and the run exits 1 - the operator
// backfills the event from the log line (spec I6: every change audited, and
// never silently not).
//
// FAILURE HANDLING mirrors retire-paused-tour-reminders.ts: a row that cannot
// be PLANNED is stepped over and counted `failed` (exit 1); a SWITCH write
// failure other than the conditional check ABORTS with a PARTIAL report.
//
// TARGET: `--env local|dev|prod` through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). DRY RUN IS
// THE DEFAULT; `--apply` writes. An agent runs this ONLY with `--env local
// --lane <L>` against a hermetic e2e lane it started. NO AGENT RUNS THIS
// AGAINST A REAL ENVIRONMENT; the human does, dry run first, per the RUNBOOK.
//
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply --conversation <id>
//   npx tsx app/scripts/enable-conversation-automation.ts --env dev --apply --include-breaker-tripped
//
// PII: logs counts and conversation ids only. Never a name, phone or body.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { logger as defaultLogger, type Logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { findBreakerTrip, isPointerRow } from './conversation-automation-census.js';
import { parseStageArgs, resolveStageClient } from './lib/stageClient.js';

export const SCRIPT_NAME = 'enable-conversation-automation';

export type EnableReason = 'bulk_enable' | 'operator_resume';

/** A refusal of the operator's INPUT (single mode: unknown id, not a
 *  one-to-one conversation). Exit 2, no partial-run banner: nothing ran. */
export class UsageError extends Error {}

export interface EnableResult {
  scanned: number;
  pointerRows: number;
  groupRows: number;
  alreadyOn: number;
  unset: number;
  breakerTrippedExcluded: number;
  /** Rows the run decided to enable (dry run: would enable). */
  planned: number;
  /** Rows actually switched on (apply only). */
  enabled: number;
  /** Planned rows by type ('(none)' for a typeless row). */
  byType: Record<string, number>;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: number;
  /** Rows switched on whose audit event could NOT be written (named at ERROR). */
  auditFailed: number;
  /** Rows the run could not PLAN (a read that threw); nothing written for them. */
  failed: number;
}

export interface EnableOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** Write. Absent/false = dry run (the default). */
  apply?: boolean;
  /** Single mode: enable this one conversation (breaker resume). */
  conversationId?: string;
  /** Bulk mode: also enable rows with a breaker trip on record. */
  includeBreakerTripped?: boolean;
  now?: string;
  scanLimit?: number;
  logger?: Logger;
}

type Plan = 'enable' | 'already_on' | 'unset' | 'group' | 'pointer' | 'breaker_excluded';

export function planRow(
  row: ConversationItem,
  opts: { includeBreakerTripped: boolean; hasBreakerTrip: boolean },
): Plan {
  if (isPointerRow(row.conversationId)) return 'pointer';
  if (!isOneToOneBucket(row)) return 'group';
  if (row.ai_mode === 'auto') return 'already_on';
  if (row.ai_mode !== 'manual') return 'unset';
  if (opts.hasBreakerTrip && !opts.includeBreakerTripped) return 'breaker_excluded';
  return 'enable';
}

export async function enableConversationAutomation(opts: EnableOpts): Promise<EnableResult> {
  const log = opts.logger ?? defaultLogger;
  const result: EnableResult = {
    scanned: 0,
    pointerRows: 0,
    groupRows: 0,
    alreadyOn: 0,
    unset: 0,
    breakerTrippedExcluded: 0,
    planned: 0,
    enabled: 0,
    byType: {},
    skippedOnCondition: 0,
    auditFailed: 0,
    failed: 0,
  };
  try {
    await run(opts, result, log);
  } catch (err) {
    if (err instanceof UsageError) throw err; // nothing ran - no partial banner
    log.error(
      { ...result, apply: opts.apply === true },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and idempotent, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function run(opts: EnableOpts, result: EnableResult, log: Logger): Promise<void> {
  const { doc, env } = opts;
  const table = tableName('conversations', env);
  const apply = opts.apply === true;
  const single = opts.conversationId;
  const audit = createAuditRepo({ doc, env });
  log.info(
    { table, apply, mode: single !== undefined ? 'single' : 'bulk', ...(single !== undefined && { conversationId: single }) },
    single !== undefined ? `${SCRIPT_NAME} - single mode: targeting one conversation` : `${SCRIPT_NAME} - bulk mode`,
  );

  const enable = async (row: ConversationItem, reason: EnableReason): Promise<void> => {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: row.conversationId },
          UpdateExpression: 'SET ai_mode = :auto',
          // Still a one-to-one conversation (negative type test, typeless rows
          // included) AND still switched off: a runtime write in between loses
          // nothing, and a pointer item can never match (no ai_mode).
          ConditionExpression:
            'attribute_exists(conversationId) AND ai_mode = :manual AND ' +
            '(attribute_not_exists(#type) OR NOT #type IN (:relay, :groupText))',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':auto': 'auto',
            ':manual': 'manual',
            ':relay': 'relay_group',
            ':groupText': 'group_text',
          },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      result.skippedOnCondition += 1;
      log.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - row moved under the run; skipped`);
      return;
    }
    // The switch is ON from here. Whatever happens to the audit write, say so.
    result.enabled += 1;
    log.info({ conversationId: row.conversationId, reason }, `${SCRIPT_NAME} - conversation switched on`);
    try {
      await audit.append(`conversations#${row.conversationId}`, 'mode_changed', {
        from: 'manual',
        to: 'auto',
        reason,
        script: SCRIPT_NAME,
      });
    } catch (err) {
      result.auditFailed += 1;
      log.error(
        { err, conversationId: row.conversationId, reason },
        `${SCRIPT_NAME} - switched on but audit NOT written: append the mode_changed event for this conversation by hand (a re-run will report it alreadyOn)`,
      );
    }
  };

  const consider = async (row: ConversationItem, reason: EnableReason): Promise<void> => {
    result.scanned += 1;
    let plan: Plan;
    try {
      const needsTripCheck =
        !isPointerRow(row.conversationId) && isOneToOneBucket(row) && row.ai_mode === 'manual' && reason === 'bulk_enable';
      const trip = needsTripCheck ? await findBreakerTrip(doc, env, row.conversationId) : undefined;
      plan = planRow(row, { includeBreakerTripped: opts.includeBreakerTripped === true, hasBreakerTrip: trip !== undefined });
    } catch (err) {
      result.failed += 1;
      log.error({ err, conversationId: row.conversationId }, `${SCRIPT_NAME} - row could not be PLANNED; stepped over and counted failed`);
      return;
    }
    switch (plan) {
      case 'pointer':
        result.pointerRows += 1;
        return;
      case 'group':
        result.groupRows += 1;
        return;
      case 'already_on':
        result.alreadyOn += 1;
        return;
      case 'unset':
        result.unset += 1;
        return;
      case 'breaker_excluded':
        result.breakerTrippedExcluded += 1;
        log.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - breaker-tripped row excluded (pass --include-breaker-tripped or resume it singly)`);
        return;
      case 'enable': {
        result.planned += 1;
        const typeKey = typeof row.type === 'string' ? row.type : '(none)';
        result.byType[typeKey] = (result.byType[typeKey] ?? 0) + 1;
        if (apply) await enable(row, reason);
        else log.info({ conversationId: row.conversationId, type: typeKey }, `${SCRIPT_NAME} - DRY RUN: would switch on`);
        return;
      }
    }
  };

  if (single !== undefined) {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: single } }));
    const row = Item as ConversationItem | undefined;
    if (!row) throw new UsageError(`${SCRIPT_NAME}: conversation ${single} not found`);
    if (isPointerRow(row.conversationId) || !isOneToOneBucket(row)) {
      throw new UsageError(`${SCRIPT_NAME}: conversation ${single} is not a one-to-one conversation - refusing`);
    }
    await consider(row, 'operator_resume');
    return;
  }

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) await consider(raw, 'bulk_enable');
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
}

/** The end-of-run report and the exit code it earns (failed or auditFailed > 0 exits 1). */
export function reportEnableRun(result: EnableResult, apply: boolean, log: Logger = defaultLogger): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  if (result.failed > 0 || result.auditFailed > 0) {
    log.warn(
      { ...result, apply },
      `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.failed} row(s) could not be planned, ${result.auditFailed} switched on without an audit event (see the ERROR lines naming them). Investigate, then re-run (idempotent).`,
    );
    return 1;
  }
  log.info({ ...result, apply }, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('enable-conversation-automation.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), {
    values: ['--conversation'],
    flags: ['--apply', '--include-breaker-tripped'],
  });
  if ('usage' in parsed) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--lane <L>] [--apply] [--conversation <id>] [--include-breaker-tripped]\n` +
        '  DRY RUN by default; --apply writes. Unknown arguments are refused. --lane selects a hermetic e2e lane (local only).',
    );
    process.exit(2);
  }
  const apply = parsed.flags.has('--apply');
  resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {})
    .then(async (stage) => {
      defaultLogger.info({ target: parsed.target, endpoint: stage.describe, prefix: stage.prefix, apply }, `${SCRIPT_NAME} - starting`);
      const result = await enableConversationAutomation({
        doc: stage.doc,
        env: stage.env,
        apply,
        ...(parsed.values.has('--conversation') && { conversationId: parsed.values.get('--conversation')! }),
        includeBreakerTripped: parsed.flags.has('--include-breaker-tripped'),
      });
      process.exitCode = reportEnableRun(result, apply);
      stage.doc.destroy();
    })
    .catch((err: unknown) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exitCode = 2;
        return;
      }
      defaultLogger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app; npx vitest run test/enableConversationAutomation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`. Expected: exit 0.

```bash
git status
git add app/scripts/enable-conversation-automation.ts app/test/enableConversationAutomation.test.ts
git commit -m "feat(ops): enable-conversation-automation - dry-run-first fix script (spec D2)

Switches one-to-one manual conversations to auto (typeless rows included,
group threads and pointer items never); breaker-tripped rows excluded unless
asked; single-conversation resume; conditional writes; a mode_changed audit
event per enable, with a lost audit write named and counted. Guarded stage
resolution; agents run it only against a hermetic lane.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: The import creates one-to-one conversations `auto` (spec D3)

**Files:**
- Modify: `app/src/lib/import/apply.ts:1107` (the `:aiMode` binding inside `upsertConversation`)
- Test: `app/test/importApply.integration.test.ts` (add one assertion), `app/test/importGroupGuards.test.ts` (add one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: an imported one-to-one row carries `ai_mode: 'auto'`; an imported group row still carries `ai_mode: 'manual'`; re-runs still never change an existing row's switch (`if_not_exists` is unchanged).

- [ ] **Step 1: Add the failing integration assertion**

In `app/test/importApply.integration.test.ts`, inside the existing test `folds two Quo conversations for one phone into a single thread` (around line 241), extend the `toMatchObject`:

```ts
    expect(conv.Item).toMatchObject({
      type: 'unknown_1to1',
      participant_phone: PHONES.tenantBusy,
      // share-skip-fix D3: a one-to-one row imports switched ON. The group row
      // stays manual (see the group_text byte-identical test below).
      ai_mode: 'auto',
    });
```

- [ ] **Step 2: Add the failing wire-shape test**

In `app/test/importGroupGuards.test.ts`, after the test `leaves the 1:1 path completely unguarded`, add:

```ts
  it('binds :aiMode to auto on the 1:1 path and manual on the group path (share-skip-fix D3)', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });
    const updates = sent.filter((c) => c.name === 'UpdateCommand');
    const oneToOne = updates.filter((c) =>
      String(c.input.UpdateExpression ?? '').includes('participant_phone = :participantPhone'),
    );
    const groups = groupUpdates(sent).filter((u) =>
      String(u.UpdateExpression ?? '').includes('ai_mode = if_not_exists(ai_mode, :aiMode)'),
    );
    expect(oneToOne.length).toBeGreaterThan(0);
    for (const c of oneToOne) {
      expect(String(c.input.UpdateExpression)).toContain('ai_mode = if_not_exists(ai_mode, :aiMode)');
      expect((c.input.ExpressionAttributeValues as Record<string, unknown>)[':aiMode']).toBe('auto');
    }
    expect(groups.length).toBeGreaterThan(0);
    for (const u of groups) {
      expect((u.ExpressionAttributeValues as Record<string, unknown>)[':aiMode']).toBe('manual');
    }
  });
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd app; npx vitest run test/importGroupGuards.test.ts test/importApply.integration.test.ts`
Expected: FAIL on the two new assertions (`'manual'` where `'auto'` is expected).

- [ ] **Step 4: Change the binding**

In `app/src/lib/import/apply.ts`, replace:

```ts
    ':aiMode': 'manual',
```

with:

```ts
    // share-skip-fix D3 (2026-09-25): a one-to-one thread imports switched ON.
    // `manual` was designed as the AI-only default (the AI layer is Phase 2)
    // but the send wrapper refuses EVERY automated text on a manual row -
    // reminders, the missed-call text, the welcome, retries and staff property
    // sends - so every imported contact silently lost them. Group threads stay
    // manual (their send paths never read the switch). `if_not_exists` above
    // keeps a re-run from ever changing an existing row's switch.
    ':aiMode': input.isGroup ? 'manual' : 'auto',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/importGroupGuards.test.ts test/importApply.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/lib/import/apply.ts app/test/importApply.integration.test.ts app/test/importGroupGuards.test.ts
git commit -m "fix(import): one-to-one conversations import with ai_mode auto (spec D3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: RUNBOOK section (spec D9) + the issue index

**Files:**
- Modify: `RUNBOOK.md` (insert a new `###` section directly BEFORE the line `### Tour reminder supersession (2026-09-01): NOTHING is owed - no backfill, no Terraform, no sweep`)
- Regenerate: `docs/issues/INDEX.md` via `npm run issues` (gitignored - nothing to commit for it; just run it)

- [ ] **Step 1: Insert the section**

Insert this text (ASCII only) before the supersession heading in `RUNBOOK.md`:

```markdown
### One-to-one conversation automation switch (2026-09-25): census, the fix script, and "a conversation tripped the breaker"

**Owed as soon as slice 1 of `feat/share-skip-fix` is reviewed - BEFORE its merge and deploy: ONE census read, then ONE fix-script apply, dev then prod, each on Cameron's explicit go, run from that branch's checkout.** No Terraform, no secrets, no schema change. Running it early is safe: it only turns switches on, and one-to-one shares already work for switched-on conversations.

Every conversation row carries `ai_mode` (`auto` | `manual`). It was designed as the Phase-2 AI on/off switch, but the one-to-one send wrapper refuses EVERY automated text on a `manual` row - tour reminders, the missed-call text, the sign-up welcome, the 30003 retry and (before this branch) staff property sends. The Quo import created every conversation `manual`, nothing else ever turns the switch back on, and the circuit breaker turns it off (`mode_changed` audit event, reason `breaker_trip`) when a conversation exceeds `SEND_BREAKER_MAX_PER_MINUTE` automated texts in a minute. Placement nudges are NOT affected either way: every nudge kind is held manual-only and "Send now" is a person's send.

Both scripts take `--env local|dev|prod` and resolve the tables AND the credentials themselves (`app/scripts/lib/stageClient.ts`): `dev`/`prod` run `assertHousingChoiceAccount()` on the pinned `housingchoice` profile FIRST and build the DynamoDB client from that profile - the machine's default (wrong-account) credential chain is never used. No `DYNAMODB_ENDPOINT`, `TABLE_PREFIX` or `AWS_PROFILE` exports. Unknown arguments are refused (a mistyped flag must never turn a rehearsal into a live apply). `--env local` is the live local dev stack; `--env local --lane <L>` is a hermetic e2e lane (its table prefix and its DynamoDB Local access key together) - the only local target an agent may use.

1. **Census (read-only):** `npx tsx app/scripts/conversation-automation-census.ts --env dev`. It logs counts only: rows by type and switch state (`unset` = no `ai_mode` attribute, which the wrapper already treats as auto), switched-off rows by cause (group thread / breaker trip / imported / other), EVERY breaker-tripped conversation id individually, pending tour-reminder rungs routed the way the reminder job routes them (`pendingTourRungs.oneToOneSwitchedOff` = the rungs the bulk apply releases; `oneToOneBreakerTripped` = held until a single-conversation resume; `groupRouted` never reads the switch), pending nudges (held manual-only, unaffected), and imported rows whose phone claim points at a different conversation. Read the breaker list before step 2.
2. **Dry run:** `npx tsx app/scripts/enable-conversation-automation.ts --env dev`. Dry run is the DEFAULT. `planned` is what an apply would switch on (each id is logged); `breakerTrippedExcluded` are the breaker rows it will leave alone; `groupRows`, `alreadyOn`, `unset` and `pointerRows` are never touched. `failed > 0` exits 1 (`COMPLETED WITH FAILURES`): investigate the logged ids before applying.
3. **Apply:** the same command with `--apply`. Every write is CONDITIONAL on the row still being a one-to-one conversation with the switch off, so a breaker trip that lands mid-run keeps the runtime's outcome (`skippedOnCondition`) and a re-run is a no-op. Each enable appends a `mode_changed` audit event `{ from: manual, to: auto, reason: bulk_enable }`. If the audit write fails after a switch landed, the run names that conversation at ERROR (`switched on but audit NOT written`), counts it `auditFailed` and exits 1: append the event by hand for each named id (a re-run reports them `alreadyOn`, it will not retry the audit).
4. **Then prod**, the same three steps. Take dev all the way through first.
5. **Import-window rule:** between the prod apply and the MERGE of this branch, do NOT run `import:apply` from `main` - it still creates one-to-one rows `manual` (the import is a local CLI run, so the boundary is the merge, not the deploy). If one must run, re-run step 3 afterwards (idempotent).

**A conversation tripped the breaker - how to see why, and how to resume it.** One trip fires NO alarm: `hc-<env>-error-logs` needs 5 errors in one 5-minute period and `hc-<env>-error-logs-sustained` needs 3 consecutive periods, and the trip writes exactly one ERROR line (later refusals are WARN). No page shows a conversation's audit trail. Find a trip through any of:

- Logs Insights (both log groups, see "Reading logs"): `fields @timestamp, conversationId, count, capPerMinute | filter msg like /circuit breaker TRIPPED/ | sort @timestamp desc` (a `like` match on the prefix: the stored message text carries an em dash further along, so an `=` on a retyped line never matches).
- Settings -> System status -> Recent errors.
- The census breaker list (step 1).
- The conversation's audit partition, read-only, via the profile (replace `<id>` and `<env>`; PowerShell, the same `ConvertTo-Json` idiom as the other Query steps in this file):

  ```powershell
  $v = @{':e'=@{S='conversations#<id>'}} | ConvertTo-Json -Compress; aws dynamodb query --table-name hc-<env>-audit_events --key-condition-expression 'entityKey = :e' --expression-attribute-values $v --no-scan-index-forward --profile housingchoice --region us-east-1 --no-cli-pager
  ```

  The `mode_changed` item is the trip; the `message_sent` items just before it, with `payload.automated = true`, are the texts that tripped it (their SIDs, never bodies). The same SIDs appear in `outbound message sent` log lines with `automated: true`.

Decide whether the burst was legitimate (a reminder ladder plus a share in one minute) or a loop, fix the cause if there is one, then resume the conversation: `npx tsx app/scripts/enable-conversation-automation.ts --env <env> --apply --conversation <id>`. It prints the id it targets, refuses a group thread or an unknown id (exit 2, nothing run), reports `alreadyOn` when there is nothing to do, and appends `mode_changed` with reason `operator_resume`. The bulk apply (step 3) deliberately skips breaker-tripped rows; `--include-breaker-tripped` overrides that after you have reviewed the list.

**No agent runs either script against dev or prod.** An agent may run them only against a hermetic e2e lane it started (`--env local --lane <L>`), never a bare `--env local`. The visible per-conversation control and the breaker's own resume action are Work Package 2 (`docs/issues/ai-mode-switch-gates-all-automation.md`); until then this script is the only way back.
```

- [ ] **Step 2: ASCII-check the section and regenerate the issue index**

Run (repo root, bash):

```bash
git diff -U0 RUNBOOK.md | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
npm run issues
```

Expected: the first prints `0`; the second regenerates the gitignored index without error.

- [ ] **Step 3: Commit**

```bash
git status
git add RUNBOOK.md
git commit -m "docs(runbook): conversation automation switch - census, fix script, breaker resume (spec D9)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Slice 1 gates, review, and the handoff to Cameron

**Files:** none new. This task proves slice 1 and stops for the independent review + the handoff; Task 6 starts once the slice review is clean and the commands are in Cameron's hands.

- [ ] **Step 1: Run the slice-1 gates, bare**

From the worktree root:

```bash
npm run typecheck
npm test
npm run smoke
npx eslint app/scripts/lib/stageClient.ts app/scripts/conversation-automation-census.ts app/scripts/enable-conversation-automation.ts app/test/stageClient.test.ts app/test/conversationAutomationCensus.test.ts app/test/enableConversationAutomation.test.ts app/src/lib/import/apply.ts app/test/importApply.integration.test.ts app/test/importGroupGuards.test.ts
```

Expected: exit 0 each (eslint: no NEW errors versus the same command at the merge base - `apply.ts` and the two import tests may carry pre-existing errors; attribute by baseline comparison, per AGENTS.md).

- [ ] **Step 2: CLI rehearsal of the operator sequence on a HERMETIC lane (never the live stack)**

The bare `--env local` target is Cameron's live local dev stack (AGENTS.md forbids touching it). Rehearse on an e2e lane instead: `npm run e2e:session` boots one and seeds the lean world into `hc-local-<L>-*` tables inside DynamoDB Local database `hclane<L>` (the session prints its lane number, `TABLE_PREFIX` and access key at startup; `e2e/support/lane.mjs:150-168, 306-308`). Then, with `<L>` filled in:

```bash
npx tsx app/scripts/conversation-automation-census.ts --env local --lane <L>
npx tsx app/scripts/enable-conversation-automation.ts --env local --lane <L>
npx tsx app/scripts/enable-conversation-automation.ts --env local --lane <L> --apply
npx tsx app/scripts/enable-conversation-automation.ts --env local --lane <L> --apply
npm run e2e:stop
```

Expected: the census reports the lean world (the group text and the connecting relay group under `groupThread`; before Task 13 lands, `planned` is 0 and after it is 1 - Dario's `conv-0002`); the dry run and the apply agree on `planned`; the second apply reports `planned: 0`; a `ResourceNotFoundException` means the lane number is wrong - never fall back to a bare `--env local`. Capture the outputs into the slice report (counts only). Stop the session before any other suite runs in this worktree.

- [ ] **Step 3: Write the slice-1 report; the orchestrator reviews; the planner hands off; then Task 6**

Write `docs/superpowers/reviews/2026-09-24-share-skip-fix/slice-1-report.md` (ASCII; the exit codes quoted verbatim from Step 1, the rehearsal counts from Step 2, the commit list). Commit it with explicit paths. The orchestrator's manual then runs its slice review and fixes anything it finds; on a clean review it reports the slice to the planner, who hands the three commands (census; dry run; apply, dev then prod) to Cameron. Task 6 starts right after that report - it never waits for Cameron's dev/prod runs (spec section 6: running the script before the rest ships is safe).

---

### Task 6: Recipient reasons on every skip, the `skipped_other` bucket, finalize log (spec D7 backend)

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastStats`, `deriveBroadcastStats`, `zeroStats`)
- Modify: `app/src/jobs/broadcastFanOut.ts` (the first fence, the refusal branch, `finalize`'s log line)
- Modify: `app/src/lib/seed/performance.ts` and `app/src/lib/seed/matrix.ts` (stats literals gain `skipped_other: 0`)
- Modify: `dashboard/src/api/types.ts` (`BroadcastStats.skipped_other?`, the balance comment)
- Modify: `dashboard/src/routes/broadcasts/StatChips.tsx` (Skipped sums the new bucket)
- Test: `app/test/deriveBroadcastStats.test.ts`, `app/test/broadcastFanOut.test.ts`, `app/test/broadcastsRepo.integration.test.ts`, `app/test/broadcastApi.test.ts`, `dashboard/src/routes/broadcasts/StatChips.test.tsx`

**Interfaces:**
- Consumes: the slot `errorCode` conventions in the fan-out.
- Produces: slot reasons on record: first-fence skips carry `opted_out` or `unreachable`; refusals keep `err.code`. Stats gain optional `skipped_other`. Bucket rule (`deriveBroadcastStats`): `skipped` with `errorCode` in {`no_consent`, `contact_no_consent`} -> `skipped_no_consent`; `skipped` with no code or code in {`opted_out`, `contact_opted_out`} -> `skipped_opted_out`; every other `skipped` -> `skipped_other`. Task 10/11 (dashboard) and Task 7 (the deleted fence) rely on exactly these codes. Exported predicates `isNoConsentCode(code)`, `isOptedOutCode(code)`.

- [ ] **Step 1: Write the failing derive tests**

In `app/test/deriveBroadcastStats.test.ts`:

(a) In the test `computes every bucket from the map (disjoint), audience = map size` (lines 28-52), add `skipped_other: 0,` to the exact `toEqual` object (after `skipped_no_consent: 1,`).

(b) REPLACE the test `skipped split: only errorCode "no_consent" is skipped_no_consent; every other skip is opted_out` with:

```ts
  it('skipped split (share-skip-fix D7): consent codes -> no_consent; opt-out codes and code-less -> opted_out; everything else -> skipped_other', () => {
    const recipients = recips([
      ['c-1', { status: 'skipped', errorCode: 'no_consent' }],
      ['c-1b', { status: 'skipped', errorCode: 'contact_no_consent' }],
      ['c-2', { status: 'skipped', errorCode: 'contact_opted_out' }],
      ['c-2b', { status: 'skipped', errorCode: 'opted_out' }],
      ['c-3', { status: 'skipped' }], // legacy first-fence skip: opt-out or unreachable, unknown which
      ['c-4', { status: 'skipped', errorCode: 'manual_mode' }],
      ['c-5', { status: 'skipped', errorCode: 'unreachable' }],
      ['c-6', { status: 'skipped', errorCode: 'contact_deleted' }],
    ]);
    const out = deriveBroadcastStats({ recipients, stats: zeroStats() });
    expect(out.skipped_no_consent).toBe(2);
    expect(out.skipped_opted_out).toBe(3);
    expect(out.skipped_other).toBe(3);
    expect(out.audience).toBe(8);
  });
```

(c) In the INVARIANT test, add `(out.skipped_other ?? 0)` to the sum:

```ts
    const sum =
      out.queued +
      (out.sending ?? 0) +
      out.sent +
      out.delivered +
      out.failed +
      out.skipped_opted_out +
      out.skipped_no_consent +
      (out.skipped_other ?? 0);
```

- [ ] **Step 2: Write the failing fan-out tests**

In `app/test/broadcastFanOut.test.ts`, change the existing test `skips an opted-out recipient (skipped_opted_out++), NO token spent, NO send` to also assert the reason:

```ts
    expect(bcast.recipients['c-stop']?.status).toBe('skipped');
    expect(bcast.recipients['c-stop']?.errorCode).toBe('opted_out'); // share-skip-fix D7: a recorded reason
```

Add, right after it:

```ts
  it('share-skip-fix D7: an UNREACHABLE recipient is skipped with its own reason and counted skipped_other, NO token, NO send', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const dead = seedTenant(world, { contactId: 'c-dead', sms_unreachable: true, phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [ok, dead]);
    const acquire = vi.fn(async () => {});
    wireHandler(world, logger, { acquire } as unknown as TokenBucket);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    expect(acquire).toHaveBeenCalledTimes(1);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-dead']).toEqual({ status: 'skipped', errorCode: 'unreachable' });
    expect(bcast.stats.skipped_other).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(0);
  });

  it('share-skip-fix D7: a manual-mode refusal is skipped with reason manual_mode and counted skipped_other, not opted_out', async () => {
    const ok = seedTenant(world, { contactId: 'c-ok', firstName: 'Ok', phone: '+15550100001' });
    const off = seedTenant(world, { contactId: 'c-off', phone: '+15550100002' });
    seedUnit(world);
    seedBroadcast(world, [ok, off]); // an AUTOMATED share (no created_via) - Task 7 covers the staff path
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    const { capture, logger: log } = capturingLogger(); // the file's own helper (line ~159)
    wireHandler(world, log);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([ok.phone]);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-off']).toEqual({ status: 'skipped', errorCode: 'manual_mode' });
    expect(bcast.stats.skipped_other).toBe(1);
    expect(bcast.stats.skipped_opted_out).toBe(0);
    // The finalize log line reports every skip from the DERIVED stats (info = 30).
    const done = capture.atLevel(30).find((l) => String(l['msg']).includes('broadcast send finalized'));
    expect(done).toBeDefined();
    expect(done!['skipped_other']).toBe(1);
  });
```

Also update the existing `bucketsSumToAudience` helper in the S2 block:

```ts
  function bucketsSumToAudience(s: BroadcastStats): boolean {
    return (
      s.queued +
        (s.sending ?? 0) +
        s.sent +
        s.delivered +
        s.failed +
        s.skipped_opted_out +
        s.skipped_no_consent +
        (s.skipped_other ?? 0) ===
      s.audience
    );
  }
```

- [ ] **Step 3: Write the failing DynamoDB integration case (Review Focus 5: a share mid-send at deploy)**

In `app/test/broadcastsRepo.integration.test.ts`, inside the DynamoDB Local describe (the repo is bound as `broadcasts`, `:61`), add:

```ts
  it('share-skip-fix D7: bumpStats ADDs skipped_other onto a persisted stats map that predates the field (a share mid-send at deploy)', async () => {
    const created = await broadcasts.create({
      created_by: 'usr_test',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'Hi [TenantName]',
    });
    await broadcasts.markSending(created.broadcastId, { 'c-1': { status: 'queued' } });
    // Simulate the pre-deploy shape: the field is absent from the stored map.
    await doc.send(
      new UpdateCommand({
        TableName: broadcastsTable,
        Key: { broadcastId: created.broadcastId },
        UpdateExpression: 'REMOVE stats.skipped_other',
      }),
    );
    const bumped = await broadcasts.bumpStats(created.broadcastId, { skipped_other: 1, queued: -1 });
    expect(bumped.stats.skipped_other).toBe(1);
    expect(bumped.stats.queued).toBe(0);
  });
```

(Add `UpdateCommand` to the file's `@aws-sdk/lib-dynamodb` import if it is not there. If `create()` seeds `skipped_other: 0` only after this task, the `REMOVE` is still the honest simulation.)

- [ ] **Step 4: Write the failing dashboard chip test**

In `dashboard/src/routes/broadcasts/StatChips.test.tsx`, add inside `describe('StatChips', ...)`:

```tsx
  it('share-skip-fix D7: the Skipped chip also sums skipped_other, defaulting 0 for legacy rows without it', () => {
    const { rerender } = render(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3, skipped_other: 4 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('9');
    rerender(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('5');
  });
```

- [ ] **Step 5: Run all of them to verify they fail**

Run: `cd app; npx vitest run test/deriveBroadcastStats.test.ts test/broadcastFanOut.test.ts test/broadcastsRepo.integration.test.ts` and `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx`
Expected: FAIL (`skipped_other` undefined / not on the type; reasons absent; chip shows 5 not 9).

- [ ] **Step 6: Implement the bucket + reasons**

`app/src/repos/broadcastsRepo.ts` - in `BroadcastStats`, after `skipped_no_consent: number;` add:

```ts
  /**
   * share-skip-fix D7: every OTHER skip - the switch off (`manual_mode`), the
   * breaker, a deleted contact, an unreachable number, the kill switch, any
   * future refusal code. Kept apart from `skipped_opted_out` so an opt-out is
   * an opt-out and nothing else is filed under it. Optional because persisted
   * stats rows written before the field existed lack it (readers default 0;
   * the fan-out's ADD creates it on such a row).
   */
  skipped_other?: number;
```

In `deriveBroadcastStats`, replace the doc-comment lines for the skipped buckets and the `case 'skipped'` arm:

```ts
 *     skipped_no_consent = 'skipped' slots with errorCode no_consent | contact_no_consent
 *     skipped_opted_out  = 'skipped' slots with errorCode opted_out | contact_opted_out,
 *                          or NO errorCode (a legacy first-fence skip: opt-out or
 *                          unreachable, recorded without a reason before 2026-09-25)
 *     skipped_other      = every remaining 'skipped' slot (manual_mode, breaker_open,
 *                          contact_deleted, unreachable, sms_sending_disabled, ...)
```

```ts
      case 'skipped':
        if (isNoConsentCode(slot.errorCode)) skipped_no_consent += 1;
        else if (isOptedOutCode(slot.errorCode)) skipped_opted_out += 1;
        else skipped_other += 1;
        break;
```

Add `let skipped_other = 0;` beside the other counters, `skipped_other,` to the returned object, `skipped_other: 0,` to `zeroStats()`, and these two exported predicates above `deriveBroadcastStats`:

```ts
/** The two consent refusal codes: the fan-out's own fence and the send wrapper's JIT gate. */
export function isNoConsentCode(code: string | undefined): boolean {
  return code === 'no_consent' || code === 'contact_no_consent';
}

/** The opt-out codes, plus NO code: a skipped slot recorded before 2026-09-25
 *  carried no reason and was an opt-out or an unreachable number - filed under
 *  opted-out, as it always was. */
export function isOptedOutCode(code: string | undefined): boolean {
  return code === undefined || code === 'opted_out' || code === 'contact_opted_out';
}
```

`app/src/jobs/broadcastFanOut.ts` - replace the first fence (the `if (contact.sms_opt_out === true || contact.sms_unreachable === true) { ... }` block at `:379-390`) with two branches, opt-out first:

```ts
      // TCPA first fence: skip opted-out / unreachable here (NO token spent, NO
      // send). sendMessage's opt-out gate is the second fence. Each skip records
      // its REASON (share-skip-fix D7): opt-out wins when both flags are set.
      if (contact.sms_opt_out === true) {
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped', errorCode: 'opted_out' });
        emitBroadcastProgress(
          events,
          payload.broadcastId,
          await broadcasts.bumpStats(payload.broadcastId, { skipped_opted_out: 1, queued: -1 }),
        );
        skippedCount += 1;
        continue;
      }
      if (contact.sms_unreachable === true) {
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped', errorCode: 'unreachable' });
        emitBroadcastProgress(
          events,
          payload.broadcastId,
          await broadcasts.bumpStats(payload.broadcastId, { skipped_other: 1, queued: -1 }),
        );
        skippedCount += 1;
        continue;
      }
```

Replace the refusal branch's bump (inside `if (err instanceof SendRefusedError) {`, `:491-504`) so the persisted counter follows the same rule as the derived one:

```ts
          await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped', errorCode: err.code });
          const bucket: keyof BroadcastStats = isNoConsentCode(err.code)
            ? 'skipped_no_consent'
            : isOptedOutCode(err.code)
              ? 'skipped_opted_out'
              : 'skipped_other';
          emitBroadcastProgress(
            events,
            payload.broadcastId,
            await broadcasts.bumpStats(payload.broadcastId, { [bucket]: 1, queued: -1 }),
          );
```

Import `isNoConsentCode`, `isOptedOutCode` and the `BroadcastStats` type from `'../repos/broadcastsRepo.js'` (extend the existing import block). In `finalize` (`:697-700`), replace the last `log.info(...)` with one that reports the DERIVED stats - the persisted counters are cumulative and, on a legacy row, lack `skipped_other`, while every other surface (SSE, results, list) already reads the derived buckets:

```ts
  const derived = deriveBroadcastStats(finalItem);
  log.info(
    {
      broadcastId,
      status: finalItem.status,
      sent: derived.sent,
      sending: derived.sending ?? 0,
      delivered: derived.delivered,
      failed: derived.failed,
      skipped_opted_out: derived.skipped_opted_out,
      skipped_no_consent: derived.skipped_no_consent,
      skipped_other: derived.skipped_other ?? 0,
    },
    'broadcast send finalized',
  );
```

Update the header comment's "SendRefusedError -> recipient 'skipped' (bump skipped_opted_out)" lines (`:26-27`) to "bump the bucket its code selects: consent, opt-out, or other".

Seeds: in `app/src/lib/seed/performance.ts` `statsForRecipients`, add `skipped_other: 0,` after `skipped_no_consent: 0,`; in `app/src/lib/seed/matrix.ts` add `skipped_other: 0,` to both stats literals.

Dashboard: `dashboard/src/api/types.ts` `BroadcastStats` - after `skipped_no_consent: number;` add:

```ts
  /** Every other skip (switch off, breaker, deleted, unreachable, kill switch).
   *  Optional: persisted stats written before 2026-09-25 lack it - default 0. */
  skipped_other?: number;
```

and extend the interface's doc comment (`:2889-2892`) so the balance reads `queued + sending + sent + delivered + failed + skipped_opted_out + skipped_no_consent + skipped_other == audience`.

`dashboard/src/routes/broadcasts/StatChips.tsx` - the Skipped chip:

```tsx
    { label: 'Skipped', value: stats.skipped_opted_out + stats.skipped_no_consent + (stats.skipped_other ?? 0) },
```

and update the header comment's balance line to `"Skipped" folds all three skip buckets (opted out + no consent + other)`.

- [ ] **Step 7: Run the tests to verify they pass; run the neighbours**

Run: `cd app; npx vitest run test/deriveBroadcastStats.test.ts test/broadcastFanOut.test.ts test/broadcastsRepo.integration.test.ts test/broadcastApi.test.ts test/twilioStatusWebhook.test.ts` and `cd dashboard; npx vitest run src/routes/broadcasts`
Expected: PASS. (`broadcastApi.test.ts:1207` and `:1234` build stats literals without `skipped_other` - fine, the field is optional; `deriveBroadcastStats` now returns `skipped_other: 0` so the exact `toEqual` at `:1220-1229` needs `skipped_other: 0` added - do that.)

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/repos/broadcastsRepo.ts app/src/jobs/broadcastFanOut.ts app/src/lib/seed/performance.ts app/src/lib/seed/matrix.ts dashboard/src/api/types.ts dashboard/src/routes/broadcasts/StatChips.tsx app/test/deriveBroadcastStats.test.ts app/test/broadcastFanOut.test.ts app/test/broadcastsRepo.integration.test.ts app/test/broadcastApi.test.ts dashboard/src/routes/broadcasts/StatChips.test.tsx
git commit -m "feat(broadcasts): a reason on every skip and a skipped_other bucket (spec D7)

First-fence skips record opted_out / unreachable; refusals bucket by code
(consent, opt-out, other) in the persisted counters and the derived stats;
the finalize log reports the derived stats; the Skipped chip sums all three.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard-created shares send as a person's send (spec D4, I1, I2, I8)

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (`CreateBroadcastInput.createdVia`, `BroadcastItem.created_via`, `create()`)
- Modify: `app/src/routes/broadcasts.ts` (the draft route passes `createdVia: 'dashboard'`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the in-memory `create()` copies `created_via`)
- Modify: `app/src/services/sendMessage.ts` (`recipient` input)
- Modify: `app/src/jobs/broadcastFanOut.ts` (`automated`, `recipient`, a deleted fence)
- Modify: `app/src/lib/seed/matrix.ts:1232-1248` and `app/src/lib/seed/performance.ts` (seeded shares carry `created_via: 'dashboard'`)
- Test: `app/test/broadcastApi.test.ts`, `app/test/broadcastFanOut.test.ts`, `app/test/sendMessage.test.ts`

**Interfaces:**
- Consumes: Task 6's bucket predicates (`contact_deleted` -> `skipped_other`).
- Produces: `BroadcastItem.created_via?: 'dashboard'` (absent = automated); `SendMessageInput.recipient?: ContactItem` - the caller's already-resolved recipient, so the wrapper's deleted and consent gates judge THAT contact with NO second read (spec I8; a read on the send path would feed the fan-out's generic strand-the-broadcast throw). The fan-out sends `automated: broadcast.created_via !== 'dashboard'`, passes `recipient: contact` for every recipient (contactId- and phone#-keyed alike: the fenced contact IS the resolved recipient), and skips a soft-deleted resolved contact as `skipped` / `contact_deleted` after the opt-out and unreachable fences and before the consent fence (the wrapper's own precedence: opt-out wins, `sendMessage.ts:320-323`).

- [ ] **Step 1: Write the failing route test**

In `app/test/broadcastApi.test.ts`, add near the draft-create tests:

```ts
  it('share-skip-fix D4: a draft created through the dashboard route records created_via dashboard', async () => {
    seedUnit(world);
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    expect(world.broadcasts.get(id)?.created_via).toBe('dashboard');
  });
```

- [ ] **Step 2: Write the fan-out tests**

Red before this task: the D4 test (a manual conversation refuses the share today) and the reason/bucket assertions on `c-del`. Regression PINS (already green today, kept as guards): the I1 opted-out/no-consent rows, the I2 test, the phone#-keyed test, the fan-out I8 test. In `app/test/broadcastFanOut.test.ts`:

```ts
  it('share-skip-fix D4: a DASHBOARD share reaches a switched-off (manual) conversation - sent as a person, never breaker-metered', async () => {
    const off = seedTenant(world, { contactId: 'c-off', firstName: 'Off', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [off], { created_via: 'dashboard' });
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([off.phone]);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-off']?.status).toBe('sent');
    // The wrapper audited it as a person's send (the harness records the real
    // DynamoDB item shape: event_type, payload - twilioWebhookHarness.ts:226-236).
    const sentEvents = world.auditEvents.filter(
      (e) => e.entityKey === `conversations#${offConv.conversationId}` && e.event_type === 'message_sent',
    );
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.payload).toMatchObject({ automated: false });
  });

  it('share-skip-fix I1: a DASHBOARD share still refuses an opted-out, a no-consent and a soft-deleted recipient (deleted judged AFTER opt-out)', async () => {
    const stopped = seedTenant(world, { contactId: 'c-stop', sms_opt_out: true, phone: '+15550100001' });
    const noConsent = seedTenant(world, { contactId: 'c-nc', phone: '+15550100002', consent_method: undefined });
    const deleted = seedTenant(world, { contactId: 'c-del', phone: '+15550100003', deleted_at: '2026-09-01T00:00:00.000Z' });
    const both = seedTenant(world, { contactId: 'c-both', phone: '+15550100004', sms_opt_out: true, deleted_at: '2026-09-01T00:00:00.000Z' });
    seedUnit(world);
    seedBroadcast(world, [stopped, noConsent, deleted, both], { created_via: 'dashboard' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-stop']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
    expect(bcast.recipients['c-nc']).toEqual({ status: 'skipped', errorCode: 'no_consent' });
    expect(bcast.recipients['c-del']).toEqual({ status: 'skipped', errorCode: 'contact_deleted' });
    expect(bcast.recipients['c-both']).toEqual({ status: 'skipped', errorCode: 'opted_out' }); // opt-out wins
    expect(bcast.stats).toMatchObject({ skipped_opted_out: 2, skipped_no_consent: 1, skipped_other: 1 });
  });

  it('share-skip-fix I8: consent is judged on the FENCED recipient, not on a duplicate no-consent contact that shares the phone', async () => {
    // The fake findByPhone returns the FIRST contact on the phone in insertion
    // order: push the duplicate (no consent) first, the real recipient second.
    seedTenant(world, { contactId: 'c-dup', phone: '+15550100001', consent_method: undefined });
    const real = seedTenant(world, { contactId: 'c-real', firstName: 'Real', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [real], { created_via: 'dashboard' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([real.phone]);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-real']?.status).toBe('sent');
  });

  it('share-skip-fix I8: a phone#-keyed recipient of a DASHBOARD share still sends', async () => {
    const byPhone = seedTenant(world, { contactId: 'c-by-phone', firstName: 'Ph', phone: '+15550100009' });
    seedUnit(world);
    const item = seedBroadcast(world, [], { created_via: 'dashboard' });
    item.recipients[`phone#${byPhone.phone}`] = { status: 'queued' };
    item.stats.audience = 1;
    item.stats.queued = 1;
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent.map((s) => s.to)).toEqual([byPhone.phone]);
    expect(world.broadcasts.get('bcast-1')!.recipients[`phone#${byPhone.phone}`]?.status).toBe('sent');
  });

  it('share-skip-fix I2: a share with NO created_via is automated and a manual conversation still refuses it', async () => {
    const off = seedTenant(world, { contactId: 'c-off', phone: '+15550100001' });
    seedUnit(world);
    seedBroadcast(world, [off]);
    const offConv = await world.conversationsRepo.createOrGetByParticipantPhone(off.phone!, 'tenant_1to1');
    await world.conversationsRepo.setMode(offConv.conversationId, 'manual');
    wireHandler(world, logger);
    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();
    expect(world.sent).toHaveLength(0);
    expect(world.broadcasts.get('bcast-1')!.recipients['c-off']).toEqual({ status: 'skipped', errorCode: 'manual_mode' });
  });
```

- [ ] **Step 3: Write the failing send-wrapper test**

In `app/test/sendMessage.test.ts`, inside the JIT-consent `describe` (`:584-661`), add. `makeFakes` models ONE contact (the phone-matched one, `:75-86`, `findByPhone: async () => contact`); the `recipient` input carries the item itself, so no fixture change is needed:

```ts
    it('share-skip-fix I8: a `recipient` item makes the consent + deleted gates judge THAT contact, not the phone-matched one', async () => {
      // The phone lookup finds a NO-consent duplicate; the caller resolved the
      // real recipient separately and hands it over.
      const f = makeFakes({
        contact: { contactId: 'c-dup', type: 'tenant', phone: '+15550100001' }, // no consent_method
      });
      const real: ContactItem = { contactId: 'c-real', type: 'tenant', phone: '+15550100001', consent_method: 'verbal_in_person' };
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false }),
      ).rejects.toBeInstanceOf(ContactNoConsentError);
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: real }),
      ).resolves.toMatchObject({ providerSid: 'SMfake-1' });
      // A deleted RECIPIENT is refused even when the phone-matched contact is live and consenting.
      const g = makeFakes();
      const gone: ContactItem = { ...real, contactId: 'c-gone', deleted_at: '2026-09-01T00:00:00.000Z' };
      await expect(
        g.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: gone }),
      ).rejects.toBeInstanceOf(ContactDeletedError);
      // The recipient's own opt-out refuses too (either contact's flag wins).
      const h = makeFakes();
      await expect(
        h.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipient: { ...real, sms_opt_out: true } }),
      ).rejects.toBeInstanceOf(ContactOptedOutError);
    });
```

- [ ] **Step 4: Run all three to verify the red ones fail**

Run: `cd app; npx vitest run test/broadcastApi.test.ts test/broadcastFanOut.test.ts test/sendMessage.test.ts`
Expected: FAIL on: the route test (`created_via` undefined), the D4 fan-out test (the manual conversation refuses), the `c-del`/`c-both` reason assertions, and the wrapper test (`recipient` is not a known input, so the typecheck and the assertions fail). The pins listed in Step 2 pass already.

- [ ] **Step 5: Implement**

`app/src/repos/broadcastsRepo.ts` - `CreateBroadcastInput` gains:

```ts
  /**
   * share-skip-fix D4: `'dashboard'` when the authenticated dashboard draft
   * route created this share. The send job sends such a share as a PERSON'S
   * send (no switch, no breaker). Absent = automated (a draft created before
   * 2026-09-25, or by any other path, including a future engine).
   */
  createdVia?: 'dashboard';
```

`BroadcastItem` gains, after `created_by`:

```ts
  /** share-skip-fix D4: the creation path; `'dashboard'` = a person's share. See CreateBroadcastInput.createdVia. */
  created_via?: 'dashboard';
```

`create()` copies it: add `...(input.createdVia !== undefined && { created_via: input.createdVia }),` to the item literal. Mirror the same line in the harness double's `create()` (`app/test/helpers/twilioWebhookHarness.ts`, the item literal around `:2880-2903`).

`app/src/routes/broadcasts.ts` - in the draft route's `broadcasts.create({ ... })` call (`:448`) add `createdVia: 'dashboard',` after `created_by: actor,` with the comment:

```ts
      // share-skip-fix D4: only an authenticated staff session reaches this
      // route (sessionMiddleware + requireAuth on /api), so the share is a
      // person's share - recorded here, ONCE, so the send job never has to look
      // the creator up. A removed teammate's draft keeps the record.
      createdVia: 'dashboard',
```

Seed fixtures (spec section 5: seeded shares a test sends as staff must carry it): add `created_via: 'dashboard',` to the seeded draft `broadcast-mx-draft-01` in `app/src/lib/seed/matrix.ts:1232-1248` and to every broadcast literal in `app/src/lib/seed/performance.ts` (they model staff-created shares; a demo-world draft sent from the dashboard must reach a switched-off conversation like any other).

`app/src/services/sendMessage.ts` - `SendMessageInput` gains (import the `ContactItem` type from `'../repos/contactsRepo.js'` beside `ContactsRepo`):

```ts
  /**
   * share-skip-fix I8: the contact the CALLER already resolved as the
   * recipient (the broadcast fan-out's fenced tenant), handed over as the
   * item so this path does no second read. When set, the deleted and
   * JIT-consent gates judge THIS contact rather than whichever contact the
   * phone lookup returns first (duplicate contacts on one phone), and the
   * opt-out gate refuses on EITHER contact's flag. Absent on every other send.
   */
  recipient?: ContactItem;
```

Destructure it (`recipient`) with the other inputs at `:275`, then replace ONLY the lookup line and the opt-out gate (`:307-318` - the `const contact = ...findByPhone` line through the `throw new ContactOptedOutError` block) with:

```ts
    const phoneContact = await contacts.findByPhone(participantPhone);
    // The contact the deleted + consent gates judge: the caller's resolved
    // recipient when given (share-skip-fix I8), else the phone-matched one.
    const contact = recipient ?? phoneContact;
    if (
      isOptedOut(conversation.sms_opt_out, phoneContact?.sms_opt_out) ||
      recipient?.sms_opt_out === true
    ) {
      log.warn(
        {
          conversationId,
          contactId: contact?.contactId,
          conversationOptOut: conversation.sms_opt_out === true,
        },
        'send refused: sms_opt_out is set (conversation and/or contact)',
      );
      throw new ContactOptedOutError(conversationId);
    }
```

The deleted gate (`:320-327`) and the JIT consent gate (`:329-344`) stay exactly as they are: they read `contact`, which is now the recipient when one was given.

`app/src/jobs/broadcastFanOut.ts` - AFTER the two first-fence branches (opt-out, unreachable) and BEFORE the consent fence (`if (!hasSmsConsent(contact))`), add a deleted fence (import `isDeleted` from `'../repos/contactsRepo.js'`):

```ts
      // share-skip-fix I8: a soft-deleted recipient is unreachable through this
      // path (the deleted-contact rule). Judged on the RESOLVED contact, before
      // any send, with its own reason - never left to the wrapper's phone lookup.
      // Sits after the opt-out fence (opt-out wins, as in sendMessage) and before
      // the consent fence.
      if (isDeleted(contact)) {
        await recordRecipient(broadcasts, payload.broadcastId, contactKey, { status: 'skipped', errorCode: 'contact_deleted' });
        emitBroadcastProgress(
          events,
          payload.broadcastId,
          await broadcasts.bumpStats(payload.broadcastId, { skipped_other: 1, queued: -1 }),
        );
        skippedCount += 1;
        log.info({ broadcastId: payload.broadcastId, contactKey }, 'broadcastFanOut: recipient contact is soft-deleted - skipped');
        continue;
      }
```

Then the send call (`:417-423`) becomes:

```ts
        // share-skip-fix D4: a share the dashboard created is a PERSON'S send -
        // the switch and the breaker do not apply; kill switch, opt-out,
        // deleted and consent still do (the wrapper's gates). Anything else
        // (a pre-2026-09-25 draft, a future engine) stays automated.
        const staffShare = broadcast.created_via === 'dashboard';
        const outcome = await sendMessage({
          conversationId: conversation.conversationId,
          body,
          author: 'teammate',
          automated: !staffShare,
          // I8: the fenced recipient, so a duplicate contact on the same phone
          // cannot make the wrapper refuse (or admit) the wrong person.
          recipient: contact,
          broadcastId: payload.broadcastId,
        });
```

Update the file header comment lines 14-16 and 24-26 (the "SendRefusedError (conversation-level opt-out/breaker/manual)" wording) to say a dashboard share is a person's send and the manual/breaker refusals apply to automated shares only.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/broadcastApi.test.ts test/broadcastFanOut.test.ts test/sendMessage.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts test/seedData.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/repos/broadcastsRepo.ts app/src/routes/broadcasts.ts app/src/services/sendMessage.ts app/src/jobs/broadcastFanOut.ts app/src/lib/seed/matrix.ts app/src/lib/seed/performance.ts app/test/helpers/twilioWebhookHarness.ts app/test/broadcastApi.test.ts app/test/broadcastFanOut.test.ts app/test/sendMessage.test.ts
git commit -m "feat(broadcasts): dashboard-created shares send as a person's send (spec D4, I8)

The draft route records created_via dashboard; the fan-out sends those shares
with automated false and hands the wrapper the fenced recipient so its deleted
and consent gates judge that contact without a second read; a soft-deleted
recipient is skipped with its own reason after the opt-out fence.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: "Already sent" ignores skipped slots (spec D5, I4) - repo, harness double, preview route

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts:524-550` (`priorRecipientContactIds`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts:3010-3019` (the in-memory double)
- Test: `app/test/broadcastsRepo.integration.test.ts`, `app/test/broadcastApi.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `priorRecipientContactIds(unitId)` returns the union of recipient KEYS whose slot status is anything but `skipped`, across the unit's `sent`/`sending` shares. Both dashboard readers (the per-candidate `alreadySentThisProperty` and the hand-add annotation `priorRecipientContactIds`) come from this one call (`app/src/routes/broadcasts.ts:516-519`, `:542-544`, `:564`), so neither needs a change.

- [ ] **Step 1: Write the failing repo integration test**

In `app/test/broadcastsRepo.integration.test.ts`, inside the existing DynamoDB Local describe (the repo is bound as `broadcasts`, `:61`; `AudienceFilter` REQUIRES `excludeOptedOut` and `excludeUnreachable`, `app/src/repos/broadcastsRepo.ts:76-82`, and `npm run typecheck` covers test files), add:

```ts
  it('share-skip-fix D5: prior recipients = any NON-skipped slot in a sent/sending share; a skipped slot never counts, a failed one still does', async () => {
    const unitId = 'unit-d5';
    const filter = { contact_type: 'tenant' as const, excludeOptedOut: true, excludeUnreachable: true };
    // Share A (sent): one sent, one failed, one skipped, one skipped-in-A-but-sent-in-B.
    const a = await broadcasts.create({ created_by: 'usr_test', unitId, audience_filter: filter, body_template: 'Hi [TenantName]' });
    await broadcasts.markSending(a.broadcastId, {
      'c-sent': { status: 'queued' },
      'c-failed': { status: 'queued' },
      'c-skipped': { status: 'queued' },
      'c-both': { status: 'queued' },
    });
    await broadcasts.setRecipient(a.broadcastId, 'c-sent', { status: 'sent' });
    await broadcasts.setRecipient(a.broadcastId, 'c-failed', { status: 'failed', errorCode: '30007' });
    await broadcasts.setRecipient(a.broadcastId, 'c-skipped', { status: 'skipped', errorCode: 'manual_mode' });
    await broadcasts.setRecipient(a.broadcastId, 'c-both', { status: 'skipped', errorCode: 'manual_mode' });
    await broadcasts.markSent(a.broadcastId);
    // Share B (sending): c-both was sent this time; c-legacy is a code-less legacy skip.
    const b = await broadcasts.create({ created_by: 'usr_test', unitId, audience_filter: filter, body_template: 'Hi [TenantName]' });
    await broadcasts.markSending(b.broadcastId, { 'c-both': { status: 'queued' }, 'c-legacy': { status: 'queued' } });
    await broadcasts.setRecipient(b.broadcastId, 'c-both', { status: 'sent' });
    await broadcasts.setRecipient(b.broadcastId, 'c-legacy', { status: 'skipped' });
    // Share C (draft): its slots never count, as before.
    await broadcasts.create({ created_by: 'usr_test', unitId, audience_filter: filter, body_template: 'Hi [TenantName]' });

    const prior = await broadcasts.priorRecipientContactIds(unitId);
    expect([...prior].sort()).toEqual(['c-both', 'c-failed', 'c-sent']);
  });
```

(`markSending(broadcastId, recipients)` takes the recipients map, `app/src/repos/broadcastsRepo.ts:552`; `setRecipient` and `markSent` are the methods the file's lifecycle test already uses.)

- [ ] **Step 2: Write the failing preview-route test (the harness double)**

In `app/test/broadcastApi.test.ts`, near the existing preview tests (grep `alreadySentThisProperty` in the file for the block), add:

```ts
  it('share-skip-fix D5: a tenant whose only earlier slot was SKIPPED is NOT "already sent"; a failed one still is', async () => {
    const skipped = seedTenant(world, { contactId: 'c-skipped', firstName: 'Skip', phone: '+15550100001' });
    const failed = seedTenant(world, { contactId: 'c-failed', firstName: 'Fail', phone: '+15550100002' });
    seedUnit(world);
    const now = new Date().toISOString();
    world.broadcasts.set('bcast-prior', {
      broadcastId: 'bcast-prior',
      created_by: 'usr_test',
      created_at: now,
      updated_at: now,
      status: 'sent',
      unitId: 'unit-1',
      audience_filter: { contact_type: 'tenant', excludeOptedOut: true, excludeUnreachable: true },
      body_template: 'hi',
      stats: { audience: 2, sent: 0, delivered: 0, failed: 1, skipped_opted_out: 0, skipped_no_consent: 0, skipped_other: 1, queued: 0 },
      recipients: {
        'c-skipped': { status: 'skipped', errorCode: 'manual_mode' },
        'c-failed': { status: 'failed', errorCode: '30007' },
      },
    });
    const { app } = makeWebhookHarness({ world });
    const id = await createDraft(app);
    const preview = await request(app)
      .post(`/api/broadcasts/${id}/preview`)
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(preview.status).toBe(200);
    const byId = new Map(
      (preview.body.candidates as Array<{ contactId: string; alreadySentThisProperty: boolean }>).map((c) => [c.contactId, c]),
    );
    expect(byId.get(skipped.contactId)?.alreadySentThisProperty).toBe(false);
    expect(byId.get(failed.contactId)?.alreadySentThisProperty).toBe(true);
    // The hand-add annotation reads the SAME set (spec D5: one rule, one reader).
    expect(preview.body.priorRecipientContactIds).toEqual([failed.contactId]);
  });
```

If `BroadcastItem` in the harness requires `_listPartition` for the list, it is not needed here: `priorRecipientContactIds` in the double filters by `unitId` and status only.

- [ ] **Step 3: Run both to verify they fail**

Run: `cd app; npx vitest run test/broadcastsRepo.integration.test.ts test/broadcastApi.test.ts`
Expected: FAIL - `c-skipped`/`c-legacy` present in the union; `alreadySentThisProperty` true for the skipped tenant.

- [ ] **Step 4: Implement the rule in the repo and the double**

`app/src/repos/broadcastsRepo.ts` - replace the inner loop of `priorRecipientContactIds`:

```ts
          for (const b of page.items) {
            if (b.status !== 'sent' && b.status !== 'sending') continue;
            for (const [key, slot] of Object.entries(b.recipients ?? {})) {
              // share-skip-fix D5 (interim rule): a SKIPPED slot means no text was
              // attempted for that tenant, so it must not flag them "Already sent"
              // (Sam's #5: the skipped tenant then started unchecked on the next
              // share). queued / sent / delivered still count; FAILED still counts
              // on purpose - a failed text may have been delivered by a retry this
              // share never hears about (Branch B replaces this with the attempts
              // rule). This is the ONE place the rule lives: the route's
              // per-candidate flag and the hand-add annotation both read this set.
              if (slot.status === 'skipped') continue;
              prior.add(key);
            }
          }
```

Update the method's doc comment on the interface (`app/src/repos/broadcastsRepo.ts:310-323`) to say "recipient keys with a non-skipped slot".

`app/test/helpers/twilioWebhookHarness.ts` - the double, in lockstep:

```ts
    async priorRecipientContactIds(unitId) {
      // Union of every sent/sending broadcast's NON-SKIPPED recipient keys for
      // the unit (share-skip-fix D5) - mirrors the real repo exactly.
      const prior = new Set<string>();
      for (const b of broadcasts.values()) {
        if (b.unitId !== unitId) continue;
        if (b.status !== 'sent' && b.status !== 'sending') continue;
        for (const [key, slot] of Object.entries(b.recipients ?? {})) {
          if (slot.status === 'skipped') continue;
          prior.add(key);
        }
      }
      return prior;
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/broadcastsRepo.integration.test.ts test/broadcastApi.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/repos/broadcastsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/broadcastsRepo.integration.test.ts app/test/broadcastApi.test.ts
git commit -m "fix(broadcasts): a skipped slot never counts as already sent (spec D5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Review list - seeded rows stay checked, hand-adds are seeds, the note tells the truth (spec D5, I4)

**Files:**
- Modify: `dashboard/src/routes/broadcasts/RecipientPreview.tsx` (`Row`, `initialRows`, `selectAll`, `addTenant`, the note, the header comment)
- Test: `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`

**Interfaces:**
- Consumes: `PreviewCandidate.seeded` (already on the wire, `dashboard/src/api/types.ts:3017`).
- Produces: `Row.seeded: boolean`. A seeded row (preview-returned seed OR an in-session hand-add) starts checked even when flagged, and Select all keeps it checked; an unseeded flagged row still starts unchecked and Select all still skips it. No-consent rows unchanged (never checkable).

- [ ] **Step 1: Rewrite the pinned hand-add test and add the Select-all + note tests**

In `dashboard/src/routes/broadcasts/RecipientPreview.test.tsx`, REPLACE the test `annotates a manually-added tenant already-sent via priorRecipientContactIds (unchecked)` (lines 251-267) with:

```tsx
  it('share-skip-fix D5: a hand-added tenant who is already-sent is flagged AND starts CHECKED (a hand-pick is a seed)', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })],
        priorRecipientContactIds: ['cX'],
      }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Prior', lastName: 'Sent' })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Prior');
    await u.click(await screen.findByRole('option', { name: /Prior Sent/ }));

    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    const row = within(list).getByText('Prior Sent').closest('li') as HTMLElement;
    expect(within(row).getByRole('checkbox')).toBeChecked();
    expect(within(row).getByText('Already sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to 2 tenants' })).toBeInTheDocument();
  });
```

In the `RecipientPreview - bulk select` describe (the file's heading uses an em dash; match it as written), add after the existing test:

```tsx
  it('share-skip-fix D5: Select all keeps SEEDED already-sent rows checked (preview seeds and hand-adds), still skips unseeded ones', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002', alreadySentThisProperty: true }),
          candidate({ contactId: 'c3', firstName: 'Seeded', phone: '+14040000003', alreadySentThisProperty: true, seeded: true }),
        ],
        priorRecipientContactIds: ['c2', 'c3', 'cX'],
      }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Prior', lastName: 'Sent' })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Prior');
    await u.click(await screen.findByRole('option', { name: /Prior Sent/ }));
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    const box = (name: string) =>
      within(within(list).getByText(name).closest('li') as HTMLElement).getByRole('checkbox');

    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(box('Seeded')).not.toBeChecked();
    expect(box('Prior Sent')).not.toBeChecked();

    await u.click(screen.getByRole('button', { name: 'Select all' }));
    expect(box('Tasha')).toBeChecked();
    expect(box('Bo')).not.toBeChecked(); // unseeded + already sent: skipped, as before
    expect(box('Seeded')).toBeChecked(); // a preview seed
    expect(box('Prior Sent')).toBeChecked(); // a hand-add is a seed too
  });

  it('share-skip-fix D5: the note states the seeded-row rule', () => {
    renderPreview({ preview: previewOf({ candidates: [candidate()] }) });
    expect(
      screen.getByText('Flagged tenants you picked stay checked; "Select all" skips the others.'),
    ).toBeInTheDocument();
  });
```

Also update the file's header comment (lines 2-7) to say "already-sent rows unchecked + amber-flagged UNLESS seeded; Select-all skips UNSEEDED already-sent rows; a hand-add is a seed".

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/RecipientPreview.test.tsx`
Expected: FAIL - the hand-add starts unchecked; Select all unchecks Seeded/Prior Sent; the note text is not found.

- [ ] **Step 3: Implement**

`dashboard/src/routes/broadcasts/RecipientPreview.tsx`:

The header comment lines 8-10 become:

```tsx
// Already-sent-this-property rows render amber and start UNCHECKED (a SOFT
// opt-in-to-resend flag, never a hard gate) - UNLESS the row is SEEDED: a seed
// (the one-to-one tenant, a preview-returned hand-pick, or a tenant added right
// here) is a deliberate choice and stays checked, through "Select all" too
// (share-skip-fix D5 / I4). "Select all" skips UNSEEDED already-sent rows.
```

`Row` gains, after `added?: boolean;`:

```tsx
  /** share-skip-fix D5: a deliberate pick (a preview-returned seed, or a tenant
   *  added in this session). Seeded rows start checked even when already sent,
   *  and "Select all" keeps them checked. */
  seeded: boolean;
```

`initialRows` maps `seeded: c.seeded,` (add the line after `hasConsent: c.has_consent,`) and keeps `checked: c.has_consent && (c.seeded || !c.alreadySentThisProperty),`.

`selectAll` becomes:

```tsx
  /** Select all - but SKIP unseeded already-sent rows (opt-in only) AND
   *  no-consent rows (hard fence). A SEEDED row stays checked whatever its flag
   *  (share-skip-fix D5): the operator picked them on purpose. */
  function selectAll(): void {
    setRows((prev) =>
      prev.map((r) => ({ ...r, checked: r.hasConsent && (r.seeded || !r.alreadySentThisProperty) })),
    );
  }
```

In `addTenant`, the appended row becomes:

```tsx
        {
          contactId: candidate.contactId,
          name,
          phone,
          alreadySentThisProperty: already,
          hasConsent: true,
          // share-skip-fix D5: a hand-pick is a seed from the moment it is added -
          // the same row the server returns as `seeded: true` after a re-preview,
          // so it must not start unchecked here and checked there.
          checked: true,
          added: true,
          seeded: true,
        },
```

The note (lines 334-336) becomes:

```tsx
      <p className={styles.note}>
        Flagged tenants you picked stay checked; &quot;Select all&quot; skips the others.
      </p>
```

- [ ] **Step 4: Run the dashboard broadcasts suite to verify it passes**

Run: `cd dashboard; npx vitest run src/routes/broadcasts`
Expected: PASS (the `resolvedFor` tests at `RecipientPreview.test.tsx:505-560` still hold: the seeded 1:1 row starts checked as before).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git status
git add dashboard/src/routes/broadcasts/RecipientPreview.tsx dashboard/src/routes/broadcasts/RecipientPreview.test.tsx
git commit -m "fix(dashboard): seeded and hand-added rows stay checked through Select all; note copy (spec D5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Every skipped and failed row says why (spec D7 dashboard)

**Files:**
- Modify: `dashboard/src/routes/contact/deliveryStatus.ts` (add `SHARE_SKIP_REASONS` + `shareSkipReason` beside `INTERNAL_CODE_REASONS`)
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (add `shareRecipientReason`)
- Modify: `dashboard/src/routes/broadcasts/DeliveryBadge.tsx` (render the reason for skipped rows too)
- Test: `dashboard/src/routes/broadcasts/broadcastFormat.test.ts` (EXISTS - append, extending its import from `./broadcastFormat.js`), `dashboard/src/routes/broadcasts/StatChips.test.tsx` (DeliveryBadge cases)

**Interfaces:**
- Consumes: slot `errorCode` values from Task 6/7 (`opted_out`, `unreachable`, `contact_deleted`, `manual_mode`, `breaker_open`, `no_consent`, `contact_no_consent`, `contact_opted_out`, `sms_sending_disabled`, `no_contact`) and `deliveryReason` from `dashboard/src/routes/contact/deliveryStatus.ts` (carrier codes, `transient_cap`, `enqueue_failed`; untouched).
- Produces: `shareSkipReason(errorCode): string` in `deliveryStatus.ts` - the code-to-sentence map, living WITH the existing staff-facing reason wording (spec D7 + Appendix A), which is also where SOR/RSW were told the reason maps live (spec section 6 item 3); `shareRecipientReason(status, errorCode): string | undefined` in `broadcastFormat.ts` - the per-row composition DeliveryBadge calls for skipped AND failed rows (the "results-row reason gate" of section 6 item 3). Task 14's e2e reads the copy.

- [ ] **Step 1: Write the failing pure-function test**

Append to `dashboard/src/routes/broadcasts/broadcastFormat.test.ts` (it exists; add `shareRecipientReason` and `presentShareLabel` - Task 11 - to its existing import from `./broadcastFormat.js`, and `import type { BroadcastStats } from '../../api/index.js';` for Task 11):

```ts
describe('shareRecipientReason (share-skip-fix D7)', () => {
  it('maps every skip code to its staff-facing reason, exactly', () => {
    expect(shareRecipientReason('skipped', 'manual_mode')).toBe('Automatic texts were off for this conversation');
    expect(shareRecipientReason('skipped', 'opted_out')).toBe('Opted out of texts');
    expect(shareRecipientReason('skipped', 'contact_opted_out')).toBe('Opted out of texts');
    expect(shareRecipientReason('skipped', 'unreachable')).toBe("Number can't receive texts");
    expect(shareRecipientReason('skipped', 'no_consent')).toBe('No texting consent recorded');
    expect(shareRecipientReason('skipped', 'contact_no_consent')).toBe('No texting consent recorded');
    expect(shareRecipientReason('skipped', 'contact_deleted')).toBe('Contact was deleted');
    expect(shareRecipientReason('skipped', 'breaker_open')).toBe('Stopped by the automatic-text safety limit');
    expect(shareRecipientReason('skipped', 'sms_sending_disabled')).toBe('Texting is turned off');
  });

  it('a legacy skip with no code reads the honest disjunction; an unknown code shows the code', () => {
    expect(shareRecipientReason('skipped', undefined)).toBe('Opted out or number unreachable');
    expect(shareRecipientReason('skipped', 'something_new')).toBe('Not sent (something_new)');
  });

  it('failed rows: no_contact has its own line; carrier and fan-out codes keep deliveryReason; no code = Delivery failed', () => {
    expect(shareRecipientReason('failed', 'no_contact')).toBe('No contact or phone on file');
    expect(shareRecipientReason('failed', '30007')).toBe('Carrier filtered the message (error 30007)');
    expect(shareRecipientReason('failed', 'transient_cap')).toBe('Sending gave up after repeated carrier deferrals');
    expect(shareRecipientReason('failed', 'enqueue_failed')).toBe('Sending could not be scheduled');
    expect(shareRecipientReason('failed', undefined)).toBe('Delivery failed');
    // The 30003 wording is the shared map's, untouched here (owned by feat/retry-send-window).
    expect(shareRecipientReason('failed', '30003')).toMatch(/^Phone unreachable/);
  });

  it('no reason for the in-flight and success states', () => {
    for (const s of ['queued', 'sent', 'delivered'] as const) {
      expect(shareRecipientReason(s, 'anything')).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Write the failing badge tests**

In `dashboard/src/routes/broadcasts/StatChips.test.tsx`, inside `describe('DeliveryBadge', ...)`, add:

```tsx
  it('share-skip-fix D7: a skipped row appends its reason, and a code-less legacy skip the disjunction', () => {
    const { rerender } = render(<DeliveryBadge status="skipped" errorCode="manual_mode" />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText(/Automatic texts were off for this conversation/)).toBeInTheDocument();
    rerender(<DeliveryBadge status="skipped" errorCode="opted_out" />);
    expect(screen.getByText(/Opted out of texts/)).toBeInTheDocument();
    rerender(<DeliveryBadge status="skipped" />);
    expect(screen.getByText(/Opted out or number unreachable/)).toBeInTheDocument();
  });

  it('share-skip-fix D7: a failed row with no code reads Delivery failed; no_contact has its own reason', () => {
    const { rerender } = render(<DeliveryBadge status="failed" />);
    expect(screen.getByText(/Delivery failed/)).toBeInTheDocument();
    rerender(<DeliveryBadge status="failed" errorCode="no_contact" />);
    expect(screen.getByText(/No contact or phone on file/)).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/StatChips.test.tsx`
Expected: FAIL - `shareRecipientReason` is not exported; skipped rows render no reason.

- [ ] **Step 4: Implement**

`dashboard/src/routes/contact/deliveryStatus.ts` - directly after `INTERNAL_CODE_REASONS` (`:913-935`), add:

```ts
/**
 * share-skip-fix D7: the staff-facing reason for a SKIPPED share recipient,
 * keyed by the slot's errorCode - the send wrapper's refusal code
 * (app/src/services/sendMessage.ts SendRefusedError codes) or the fan-out's
 * own fence code (app/src/jobs/broadcastFanOut.ts: opted_out, unreachable,
 * contact_deleted, no_consent). STAFF-FACING DASHBOARD COPY, beside the other
 * reason wording above - never the message catalog. A skipped slot recorded
 * before 2026-09-25 carries no code and was an opt-out or an unreachable
 * number, unknown which - say exactly that. Read through `shareSkipReason`,
 * an own-property lookup (errorCode is wire data, never a trusted key).
 */
const SHARE_SKIP_REASONS: Record<string, string> = {
  manual_mode: 'Automatic texts were off for this conversation',
  opted_out: 'Opted out of texts',
  contact_opted_out: 'Opted out of texts',
  unreachable: "Number can't receive texts",
  no_consent: 'No texting consent recorded',
  contact_no_consent: 'No texting consent recorded',
  contact_deleted: 'Contact was deleted',
  breaker_open: 'Stopped by the automatic-text safety limit',
  sms_sending_disabled: 'Texting is turned off',
};

const LEGACY_SHARE_SKIP_REASON = 'Opted out or number unreachable';

/** The sentence for a skipped share recipient's errorCode (see SHARE_SKIP_REASONS). */
export function shareSkipReason(errorCode: string | undefined): string {
  if (errorCode === undefined || errorCode.length === 0) return LEGACY_SHARE_SKIP_REASON;
  return ownReason(SHARE_SKIP_REASONS, errorCode) ?? `Not sent (${errorCode})`;
}
```

`dashboard/src/routes/broadcasts/broadcastFormat.ts` - import `deliveryReason` and `shareSkipReason` beside `presentDeliveryStatus` and add:

```ts
/** The reason a share recipient was NOT texted or NOT delivered - one sentence
 *  per row, for skipped AND failed slots (spec D7). Skipped rows read the
 *  share-skip map in deliveryStatus.ts; failed rows keep the shared
 *  deliveryReason (carrier codes, the fan-out's transient_cap / enqueue_failed,
 *  and the 30003 wording, which is owned elsewhere), with `no_contact` - the
 *  fan-out's own "nothing to send to" - as the one share-specific failure line.
 *  Undefined for queued / sent / delivered. */
export function shareRecipientReason(
  status: BroadcastRecipient['status'],
  errorCode: string | undefined,
): string | undefined {
  if (status === 'skipped') return shareSkipReason(errorCode);
  if (status === 'failed') {
    if (errorCode === 'no_contact') return 'No contact or phone on file';
    return deliveryReason(errorCode) ?? 'Delivery failed';
  }
  return undefined;
}
```

`dashboard/src/routes/broadcasts/DeliveryBadge.tsx` - replace the `deliveryReason` import with `shareRecipientReason` (from `./broadcastFormat.js`) and the reason line:

```tsx
  // share-skip-fix D7: every skipped and failed row carries its reason.
  const reason = shareRecipientReason(status, errorCode);
```

Update the header comment (lines 1-5) to say "plus the reason a skipped or failed recipient was not reached".

- [ ] **Step 5: Run to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/broadcasts`
Expected: PASS. The existing `keeps the retry promise on a broadcast recipient 30003` test still passes (failed + 30003 goes through `deliveryReason` with no options, exactly as before).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git status
git add dashboard/src/routes/contact/deliveryStatus.ts dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/DeliveryBadge.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx
git commit -m "feat(dashboard): a reason on every skipped and failed share row (spec D7)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A share that reached nobody reads "Not sent" (spec D6)

**Files:**
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (add `presentShareLabel`)
- Modify: `dashboard/src/routes/broadcasts/BroadcastStatusPill.tsx` (optional `stats` prop)
- Modify: `dashboard/src/routes/broadcasts/BroadcastsList.tsx:144`, `dashboard/src/routes/broadcasts/BroadcastResults.tsx:138` (pass the stats)
- Test: `dashboard/src/routes/broadcasts/broadcastFormat.test.ts`, `dashboard/src/routes/broadcasts/StatChips.test.tsx` (pill cases)

**Interfaces:**
- Consumes: `BroadcastStats` incl. `skipped_other?` (Task 6).
- Produces: `presentShareLabel(status, stats?) -> { label: string; tone: BroadcastStatusTone }`. Presentation only: the status filter tabs, the stored status, the `sent` GSI value are untouched; an all-skipped share still lists under "Sent" (spec D6).

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/routes/broadcasts/broadcastFormat.test.ts` (`presentShareLabel` and the `BroadcastStats` type were added to the file's top-of-file imports in Task 10):

```ts
function stats(over: Partial<BroadcastStats> = {}): BroadcastStats {
  return { audience: 0, sent: 0, delivered: 0, failed: 0, skipped_opted_out: 0, skipped_no_consent: 0, queued: 0, ...over };
}

describe('presentShareLabel (share-skip-fix D6)', () => {
  it('a finished share whose EVERY recipient was skipped reads Not sent (neutral)', () => {
    expect(presentShareLabel('sent', stats({ audience: 1, skipped_other: 1 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
    expect(presentShareLabel('sent', stats({ audience: 3, skipped_opted_out: 1, skipped_no_consent: 1, skipped_other: 1 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
    // Legacy stats without skipped_other: the two old buckets alone decide.
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_opted_out: 2 }))).toEqual({ label: 'Not sent', tone: 'neutral' });
  });

  it('anything else keeps the status label and tone', () => {
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, delivered: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    expect(presentShareLabel('sent', stats({ audience: 2, skipped_other: 1, failed: 1 }))).toEqual({ label: 'Sent', tone: 'positive' });
    expect(presentShareLabel('sending', stats({ audience: 1, skipped_other: 1 }))).toEqual({ label: 'Sending', tone: 'progress' });
    expect(presentShareLabel('failed', stats({ audience: 1, failed: 1 }))).toEqual({ label: 'Failed', tone: 'danger' });
    expect(presentShareLabel('draft', stats({ audience: 5 }))).toEqual({ label: 'Draft', tone: 'neutral' });
    expect(presentShareLabel('sent', stats())).toEqual({ label: 'Sent', tone: 'positive' }); // audience 0 is not "all skipped"
    expect(presentShareLabel('sent')).toEqual({ label: 'Sent', tone: 'positive' }); // no stats at hand
  });
});
```

In `dashboard/src/routes/broadcasts/StatChips.test.tsx`, inside `describe('BroadcastStatusPill', ...)`, add:

```tsx
  it('share-skip-fix D6: with stats, an all-skipped sent share reads Not sent; a partly delivered one still reads Sent', () => {
    const { rerender } = render(
      <BroadcastStatusPill status="sent" stats={stats({ audience: 1, sent: 0, delivered: 0, queued: 0, skipped_other: 1 })} />,
    );
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    rerender(<BroadcastStatusPill status="sent" stats={stats({ audience: 2, sent: 0, delivered: 1, queued: 0, skipped_other: 1 })} />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/broadcastFormat.test.ts src/routes/broadcasts/StatChips.test.tsx`
Expected: FAIL - `presentShareLabel` not exported; the pill has no `stats` prop.

- [ ] **Step 3: Implement**

`dashboard/src/routes/broadcasts/broadcastFormat.ts` - add `BroadcastStats` to the type import and:

```ts
/** share-skip-fix D6: the share's label for the list row and the results
 *  header. A finished share (`sent`) whose EVERY recipient was skipped reached
 *  nobody, and "Sent" would be a lie (Sam's #5: one-to-one shares that read
 *  Sent with a Skipped row). Presentation ONLY: the stored status, the list's
 *  status filter and the tab it lists under are unchanged. A share with any
 *  sent / delivered / failed / queued slot keeps its status label. */
export function presentShareLabel(
  status: BroadcastStatus,
  stats?: BroadcastStats,
): { label: string; tone: BroadcastStatusTone } {
  if (status === 'sent' && stats !== undefined && stats.audience > 0) {
    const skipped = stats.skipped_opted_out + stats.skipped_no_consent + (stats.skipped_other ?? 0);
    if (skipped >= stats.audience) return { label: 'Not sent', tone: 'neutral' };
  }
  return { label: BROADCAST_STATUS_LABELS[status], tone: BROADCAST_STATUS_TONE[status] };
}
```

`dashboard/src/routes/broadcasts/BroadcastStatusPill.tsx`:

```tsx
import type { BroadcastStats, BroadcastStatus } from '../../api/index.js';
import { presentShareLabel } from './broadcastFormat.js';
import styles from './BroadcastStatusPill.module.css';

const TONE_CLASS: Record<string, string> = {
  neutral: styles.neutral ?? '',
  progress: styles.progress ?? '',
  positive: styles.positive ?? '',
  danger: styles.danger ?? '',
};

/** The lifecycle pill. With `stats`, an all-skipped finished share reads
 *  "Not sent" (share-skip-fix D6); without them, the plain status label. */
export function BroadcastStatusPill({
  status,
  stats,
}: {
  status: BroadcastStatus;
  stats?: BroadcastStats;
}): React.JSX.Element {
  const { label, tone } = presentShareLabel(status, stats);
  return <span className={`${styles.pill} ${TONE_CLASS[tone]}`}>{label}</span>;
}
```

`BroadcastsList.tsx:144` -> `<BroadcastStatusPill status={row.status} stats={row.stats} />`; `BroadcastResults.tsx:138` -> `<BroadcastStatusPill status={results.status} stats={results.stats} />`. (The results hook overlays live status+stats from the SSE event, so the header label follows the send to its end.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd dashboard; npx vitest run src/routes/broadcasts`
Expected: PASS (the existing pill test renders without `stats` and still sees the four plain labels).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git status
git add dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/BroadcastStatusPill.tsx dashboard/src/routes/broadcasts/BroadcastsList.tsx dashboard/src/routes/broadcasts/BroadcastResults.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx
git commit -m "feat(dashboard): an all-skipped share reads Not sent (spec D6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: One-to-one default text = address + flyer link (spec D8)

**Files:**
- Modify: `dashboard/src/routes/broadcasts/resolveTemplate.ts` (add `ONE_TO_ONE_SEND_TEMPLATE`)
- Modify: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:186-196` (the resolved-mode auto-seed), `:260-267` (a comment)
- Modify: `dashboard/src/routes/broadcasts/MessageEditor.tsx:84` (the placeholder in resolved mode)
- Modify: `dashboard/src/routes/broadcasts/RecipientPreview.tsx:58-63`, `:119-121` (two comments)
- Test: `dashboard/src/routes/broadcasts/resolveTemplate.test.ts`, `dashboard/src/routes/broadcasts/MessageEditor.test.tsx`, `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx:368-414`, `e2e/tests/dashboard-next/matching-entry-points.spec.ts:131-136`

**Interfaces:**
- Consumes: `resolveTemplateForUnit`, `serverFormatAddress` (unchanged).
- Produces: `ONE_TO_ONE_SEND_TEMPLATE = '[Address] [FlyerLink]'`. A one-recipient compose (resolved mode) pre-fills `<one-line address> <flyer link>`; blasts keep `DEFAULT_SEND_TEMPLATE` byte for byte. The steady-state flyer link is the server's `${base}/p/${unitId}?cta=text` (after the first draft exists); Task 14's e2e asserts that value.

- [ ] **Step 1: Write the failing template test**

Append to `dashboard/src/routes/broadcasts/resolveTemplate.test.ts` (add `ONE_TO_ONE_SEND_TEMPLATE` to the import):

```ts
describe('ONE_TO_ONE_SEND_TEMPLATE (share-skip-fix D8)', () => {
  it('is the one-line address, ONE space, the flyer link - nothing else', () => {
    expect(ONE_TO_ONE_SEND_TEMPLATE).toBe('[Address] [FlyerLink]');
    expect(resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, makeUnit(), 'https://x/p/u1?cta=text')).toBe(
      '44 Clifton Rd NE, Atlanta, GA 30307 https://x/p/u1?cta=text',
    );
    // A structured address renders the server's one-line form.
    expect(
      resolveTemplateForUnit(
        ONE_TO_ONE_SEND_TEMPLATE,
        makeUnit({ address: { line1: '77 Peachtree St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' } }),
        'https://x/p/u1?cta=text',
      ),
    ).toBe('77 Peachtree St Apt 4, Atlanta, GA 30303 https://x/p/u1?cta=text');
  });

  it('the blast template is unchanged', () => {
    expect(DEFAULT_SEND_TEMPLATE).toBe(
      'Hi [TenantName], a [Beds]-bedroom home at [Address] is available for [Rent]/mo. Details: [FlyerLink]',
    );
  });
});
```

- [ ] **Step 2: Write the failing placeholder test**

In `dashboard/src/routes/broadcasts/MessageEditor.test.tsx`, add a describe (import `DEFAULT_SEND_TEMPLATE` and `ONE_TO_ONE_SEND_TEMPLATE` from `./resolveTemplate.js`):

```tsx
describe('MessageEditor - placeholder (share-skip-fix D8)', () => {
  it('shows the one-to-one template in resolved mode and the blast template otherwise', () => {
    const { rerender } = render(<MessageEditor value="" onChange={() => {}} resolved />);
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', ONE_TO_ONE_SEND_TEMPLATE);
    rerender(<MessageEditor value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', DEFAULT_SEND_TEMPLATE);
  });
});
```

- [ ] **Step 3: Repin the composer tests**

In `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`, the resolved-mode describe (lines 368-414) pins `'Hi Tasha,'` three times. The default `getUnit` mock returns `unit()` = 1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314, and this file's `createBroadcast` mock returns NO `flyerUrl` (`:85-87`), so the composer keeps the same-origin fallback `${origin}/p/unit-0001` here - which is why these unit assertions end at the unit id while the e2e ones end at `?cta=text`. Change:

- Test `a single seed + attached property auto-seeds the resolved text and hides the merge chips` - replace the `waitFor` with:

```tsx
    // share-skip-fix D8: the one-recipient default is the address + the flyer
    // link, nothing else - no greeting, no beds, no rent. (The fallback link:
    // this file's createBroadcast mock returns no flyerUrl.)
    await waitFor(() => {
      const v = (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
      expect(v).toMatch(/^1450 Joseph E\. Boone Blvd NW, Atlanta, GA 30314 \S+\/p\/unit-0001$/);
    });
```

- Test `an UNEDITED auto-seeded body resets silently...` - replace `await waitFor(() => expect(ta.value).toContain('Hi Tasha,'));` with `await waitFor(() => expect(ta.value).toMatch(/^1450 Joseph E\. Boone Blvd NW/));` and extend the final block so the flip back to token mode is proven both ways:

```tsx
    await waitFor(() => {
      expect(ta.value).toContain('Hi [TenantName],');
      expect(ta.value).not.toMatch(/^1450 Joseph/);
    });
```

- Test `editing the resolved text then "Add more tenants by filters" prompts...` - replace the `'Hi Tasha,'` wait with `await waitFor(() => expect((ta as HTMLTextAreaElement).value).toMatch(/^1450 Joseph E\. Boone Blvd NW/));`.

- [ ] **Step 4: Repin the e2e assertion**

In `e2e/tests/dashboard-next/matching-entry-points.spec.ts:131-136`, replace the three `message` expectations with ONE steady-state assertion (the value is the server's link once the first draft exists, ~600 ms after the property is picked; `toHaveValue` polls until then):

```ts
    // The message now holds the FINAL resolved one-to-one text (share-skip-fix
    // D8): the property's one-line address, a space, the flyer link - and
    // nothing else. No greeting, no [TenantName] token. The link is the SERVER's
    // (?cta=text), which replaces the same-origin fallback once the draft exists.
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(
      new RegExp(`^${stamp} Matching Entry Ave, Atlanta, GA 30314 \\S+/p/${unitId}\\?cta=text$`),
      { timeout: 10_000 },
    );
```

(Confirm the unit's city/state/zip in this spec's `createUnitViaApi` - lines 60-90 - and use those values.)

- [ ] **Step 5: Run the dashboard tests to verify they fail**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/resolveTemplate.test.ts src/routes/broadcasts/MessageEditor.test.tsx src/routes/broadcasts/BroadcastComposer.test.tsx`
Expected: FAIL - `ONE_TO_ONE_SEND_TEMPLATE` not exported; the resolved text still starts `Hi Tasha,`; the resolved placeholder is the blast template.

- [ ] **Step 6: Implement**

`dashboard/src/routes/broadcasts/resolveTemplate.ts`, after `DEFAULT_SEND_TEMPLATE`:

```ts
/** share-skip-fix D8 (Sam's #4): the ONE-RECIPIENT default. A navigator sharing
 *  one property with one tenant is usually mid-conversation, so the text is the
 *  address and the link and nothing else - no greeting, no beds, no rent. The
 *  blast default above is unchanged. Resolved through resolveTemplateForUnit
 *  (no per-recipient token here). Dashboard copy, not catalog copy: the
 *  operator sees and edits it before anything sends. */
export const ONE_TO_ONE_SEND_TEMPLATE = '[Address] [FlyerLink]';
```

and extend the `DEFAULT_SEND_TEMPLATE` doc comment ("ONE source of the copy for both") to name the one-to-one twin.

`dashboard/src/routes/broadcasts/BroadcastComposer.tsx` - import `ONE_TO_ONE_SEND_TEMPLATE` beside `DEFAULT_SEND_TEMPLATE`, and in the resolved-mode effect (`:186-196`) replace the body line:

```tsx
        // share-skip-fix D8: one recipient -> address + flyer link only.
        body: resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, unit, flyer),
```

Drop `seedContact` from that effect's dependency list (nothing in it reads it now) and remove the `resolveTemplateForTenant` import if the composer no longer uses it (an unused import is a gate-5 lint error; the function stays exported and tested). Rewrite the comment above the effect (`:179-185`) to say the one-to-one default carries no name and re-seeds on unit/flyer change. In the `onEnableFilters` comment (`:260-267`) replace "the resolved text names ONE tenant and must never send to a broader audience" with "the resolved text was composed for ONE tenant (and may have been edited for them), so it must never send to a broader audience".

`dashboard/src/routes/broadcasts/RecipientPreview.tsx` - the `resolvedFor` doc (`:59-63`) and the `resolvedMismatch` comment (`:119-121`) say the body "was rendered with ONE tenant's name baked in" / "names ONE tenant". Reword both: the message was composed for exactly one tenant (the one-to-one default is the address and the link, and any edit was written for them), so it must reach exactly that tenant. The guard's behavior is unchanged.

`dashboard/src/routes/broadcasts/MessageEditor.tsx:84`:

```tsx
        placeholder={resolved ? ONE_TO_ONE_SEND_TEMPLATE : DEFAULT_SEND_TEMPLATE}
```

(import `ONE_TO_ONE_SEND_TEMPLATE` beside `DEFAULT_SEND_TEMPLATE`).

- [ ] **Step 7: Run the dashboard suites to verify they pass; lint the touched files**

Run: `cd dashboard; npx vitest run src/routes/broadcasts` then, from the repo root, `npx eslint dashboard/src/routes/broadcasts/resolveTemplate.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/MessageEditor.tsx dashboard/src/routes/broadcasts/RecipientPreview.tsx`.
Expected: PASS; no new lint errors.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git status
git add dashboard/src/routes/broadcasts/resolveTemplate.ts dashboard/src/routes/broadcasts/resolveTemplate.test.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/routes/broadcasts/MessageEditor.tsx dashboard/src/routes/broadcasts/MessageEditor.test.tsx dashboard/src/routes/broadcasts/RecipientPreview.tsx e2e/tests/dashboard-next/matching-entry-points.spec.ts
git commit -m "feat(dashboard): one-to-one share defaults to the address and the flyer link (spec D8)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Lean seed - a second tenant whose one-to-one conversation is switched off (spec section 5)

**Files:**
- Modify: `app/src/lib/seed/lean.ts` (`IDS`, one contact, one conversation)
- Modify: `e2e/tests/dashboard-next/contacts-list-facets.spec.ts:11-12, 23-24` (a stale "exactly ONE tenant" comment)
- Test: `app/test/seedData.test.ts` (one assertion)

**Interfaces:**
- Produces: `contact-tenant-0002` (Dario Reyes, `+15550100004`, voucherSize 1, atlanta_housing, `verbal_phone` consent) and `conv-0002` (`tenant_1to1`, `ai_mode: 'manual'`, `imported_from: 'quo'`, `last_activity_at` before every other row). Task 14 drives him. The byte-stable rules from Global Constraints apply. The full (demo) profile composes lean (`app/src/lib/seed/index.ts:7`), so he appears there too - intended, and the spec's section 5 says so (v9).

Why these values: voucherSize 1 keeps him OUT of every 2-BR audience the existing specs build (`broadcasts.spec.ts`, `matching-entry-points.spec.ts`; the resolver matches voucherSize exactly, `app/src/services/audienceResolution.ts:153-154`) and out of `contacts-list-facets.spec.ts`'s 2-BR + DCA survivor; `atlanta_housing` is the authority the lean world already uses; the earliest `last_activity_at` keeps Tasha the newest inbox row (adjudication A29 in the file); `unread_count: 0` keeps the Unread tab empty (`inbox-markread.spec.ts`); `deleted-contact-resurfacing.spec.ts` anchors on "some other row rendered", so one more row is fine.

- [ ] **Step 1: Write the failing seed assertion**

In `app/test/seedData.test.ts`, inside the existing describe (after the contacts loop around line 59-90), add:

```ts
  it('share-skip-fix: seeds a tenant whose one-to-one conversation is switched off (the e2e proof for a person-sent share)', () => {
    const contacts = SEED['contacts'] ?? [];
    const dario = contacts.find((c) => c['contactId'] === 'contact-tenant-0002');
    expect(dario).toMatchObject({ type: 'tenant', phone: '+15550100004', firstName: 'Dario', voucherSize: 1 });
    expect(typeof dario?.['consent_method']).toBe('string');
    const conv = SEED.conversations.find((c) => c['conversationId'] === 'conv-0002');
    expect(conv).toMatchObject({ type: 'tenant_1to1', ai_mode: 'manual', participant_phone: '+15550100004', status: 'open' });
    expect(conv?.participants).toEqual([{ contactId: 'contact-tenant-0002', phone: '+15550100004' }]);
    // Tasha stays the newest inbox row (A29): every other conversation is older than hers.
    const tasha = SEED.conversations.find((c) => c['conversationId'] === 'conv-0001');
    expect(String(conv?.['last_activity_at']) < String(tasha?.['last_activity_at'])).toBe(true);
  });
```

(Use the file's existing name for the imported seed object; it imports `SEED` from `../src/lib/seed/lean.js` or through the seed module - mirror the existing import.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd app; npx vitest run test/seedData.test.ts`
Expected: FAIL - `dario` undefined.

- [ ] **Step 3: Add the rows**

`app/src/lib/seed/lean.ts`:

Add to `IDS`:

```ts
  tenantOff: 'contact-tenant-0002',
  conversationOff: 'conv-0002',
```

Add a timestamp beside `TC0`:

```ts
// share-skip-fix: the switched-off tenant's thread. EARLIER than everything
// else (A29 again): it must never displace Tasha as the newest inbox row.
const TS0 = '2026-06-01T13:20:00.000Z';
```

Append to `contacts` (after Renee's row):

```ts
    {
      // share-skip-fix (2026-09-25): a tenant whose one-to-one conversation is
      // switched OFF (`ai_mode: manual`, the state the Quo import left every
      // imported thread in). The e2e proof that a staff property send reaches
      // him anyway (share-skip-fix.spec.ts). ANY AUTOMATED SEND TO HIM IS
      // REFUSED manual_mode BY DESIGN: no other spec - the retry-send-window
      // one-to-one e2e included - may use him as a recipient of a reminder,
      // a retry or any other automated text. voucherSize 1 keeps him out of
      // every 2-BR audience the existing specs build; atlanta_housing keeps
      // the facet spec's DCA/Fulton discriminators unused.
      contactId: IDS.tenantOff,
      type: 'tenant', // byTypeStatus HASH
      status: 'searching', // byTypeStatus RANGE
      phone: '+15550100004', // byPhone
      housingAuthority: 'atlanta_housing', // byHousingAuthority
      firstName: 'Dario',
      lastName: 'Reyes',
      voucherSize: 1,
      voucher_program: 'HCV',
      // Consent recorded by a human (an imported contact whose intake call was
      // logged), so the JIT gate never blocks a person's send to him.
      consent_method: 'verbal_phone',
      consent_at: T0,
      created_at: T0,
    },
```

Append to `conversations` (after Tasha's row, before the group text):

```ts
    // share-skip-fix: Dario's one-to-one thread, SWITCHED OFF. `imported_from`
    // marks it the way the import does, so the census counts it under
    // "imported" and the fix script's dry run plans it; the send job reaches
    // him regardless because a dashboard share is a person's send. Automated
    // sends to this thread are refused - see the contact's comment.
    {
      conversationId: IDS.conversationOff,
      participant_phone: '+15550100004', // byParticipantPhone
      status: 'open', // byLastActivity HASH
      last_activity_at: TS0, // byLastActivity RANGE - oldest row on purpose
      type: 'tenant_1to1',
      ai_mode: 'manual',
      participants: [{ contactId: IDS.tenantOff, phone: '+15550100004' }],
      last_message_preview: 'Thanks, I will keep an eye out.',
      unread_count: 0,
      imported_from: 'quo',
      imported_at: TS0,
      created_at: TS0,
    },
```

`e2e/tests/dashboard-next/contacts-list-facets.spec.ts:11-12` and `:23-24` say the lean world "holds exactly ONE tenant (Tasha, 2-BR / atlanta_housing)". Reword: two tenants, Tasha (2-BR / atlanta_housing) and Dario (1-BR / atlanta_housing), neither of which can make the DCA/Fulton or 3-BR facets discriminate.

- [ ] **Step 4: Run the seed tests and the lean-world consumers**

Run: `cd app; npx vitest run test/seedData.test.ts test/seedRosterShape.test.ts`
Expected: PASS. (`+15550100004` appears in `app/test/broadcastApi.test.ts:869` and a few relay/group tests inside their own in-memory worlds, never the seed - no collision.)

- [ ] **Step 5: ASCII-check and commit**

```bash
git diff -U0 app/src/lib/seed/lean.ts e2e/tests/dashboard-next/contacts-list-facets.spec.ts | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
git status
git add app/src/lib/seed/lean.ts app/test/seedData.test.ts e2e/tests/dashboard-next/contacts-list-facets.spec.ts
git commit -m "feat(seed): lean tenant with a switched-off one-to-one conversation (share-skip-fix e2e fixture)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the wc prints `0`.

---

### Task 14: End-to-end proof (spec section 7)

**Files:**
- Create: `e2e/tests/dashboard-next/share-skip-fix.spec.ts`

**Interfaces:**
- Consumes: Task 13's seeded tenant; `listThreads`, `setDeliveryOutcome` from `e2e/fixtures/fakeTwilio.ts`; `expectTodayReady` from `e2e/support/today.ts`; the dashboard copy from Tasks 9, 10, 11, 12.
- Produces: three specs the gate runs, covering spec section 7's e2e list: (a) a staff one-to-one share to a switched-off conversation is delivered; (b) a tenant whose earlier share was SKIPPED is not "Already sent" next time; (c) one whose text went out is, and one whose text FAILED still is (the interim rule, pinned as such); (d) skipped rows show their reasons; (e) an all-skipped share reads "Not sent"; (f) the one-to-one default text.

How a skipped slot is produced end to end: the send route's explicit-selection path re-fences opt-out and unreachable (`app/src/routes/broadcasts.ts:654-673` -> `400 empty_audience` when nobody survives) but has NO consent fence, so a tenant with no recorded consent, sent by explicit id, reaches the fan-out and is skipped `no_consent` (`app/src/jobs/broadcastFanOut.ts:397-407`; `a2p-compliance.spec.ts:433-483` drives the same path). Recording consent afterwards makes them sendable again, which is what (b) needs. A FAILED slot: arm the fake's next message to that handset with a 30007 failure (`setDeliveryOutcome`, `e2e/fixtures/fakeTwilio.ts:354-372`); the status webhook rolls it into the slot.

- [ ] **Step 1: Write the spec**

`e2e/tests/dashboard-next/share-skip-fix.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads, setDeliveryOutcome } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

// share-skip-fix (Sam's improvements #4 and #5), end to end on the hermetic lane:
//   1. A one-to-one share to a tenant whose conversation is switched OFF
//      (lean seed: Dario, conv-0002, ai_mode manual) pre-fills the address +
//      flyer link only (D8), reaches him anyway (D4), and the NEXT share of the
//      same property flags him "Already sent" (his text went out) and keeps him
//      checked (D5: he is the seeded recipient).
//   2. A share whose only recipient was SKIPPED (no consent recorded) reads
//      "Not sent" (D6), its row says why (D7), and once consent is recorded the
//      next share of the property does NOT flag them "Already sent" (D5: a
//      skipped slot never counts).
//   3. A share whose only recipient FAILED (carrier 30007) keeps flagging them
//      "Already sent" - the interim rule, pinned as such (D5; Branch B replaces it).
// Sends are proven through the fake-twilio thread store, never real SMS.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DARIO = { contactId: 'contact-tenant-0002', phone: '+15550100004', firstName: 'Dario' };
const NOTE = 'Flagged tenants you picked stay checked; "Select all" skips the others.';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh Available 1-BR property (Dario is a 1-BR voucher; the seeded units
 *  are under_application and the send guard would refuse them). */
async function createUnitViaApi(
  request: APIRequestContext,
  stamp: string,
): Promise<{ unitId: string; line1: string }> {
  const line1 = `${stamp} Share Skip Ave`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId: 'contact-landlord-0001',
      beds: 1,
      accepted_authorities: ['atlanta_housing'],
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
      rent_min: 1100,
      rent_max: 1100,
    },
  });
  expect(res.ok()).toBeTruthy();
  const unitId = (await res.json()).unit.unitId as string;
  const flip = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(flip.ok()).toBeTruthy();
  return { unitId, line1 };
}

/** A 1-BR tenant with a unique phone; `consent: false` leaves consent unrecorded
 *  (the fan-out's consent fence then skips them). Mirrors broadcasts.spec.ts. */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
  opts: { consent: boolean },
): Promise<{ contactId: string; phone: string; firstName: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Skiptest', phone, voucherSize: 1 },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  if (opts.consent) await recordConsent(request, contactId);
  return { contactId, phone, firstName };
}

async function recordConsent(request: APIRequestContext, contactId: string): Promise<void> {
  const res = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(res.ok()).toBeTruthy();
}

/** Share `unitId` with exactly `contactId` through the API (a seeded draft sent
 *  by explicit selection - the same route the dashboard's Send button posts). */
async function shareViaApi(request: APIRequestContext, unitId: string, contactId: string): Promise<string> {
  const draft = await request.post(`${NEXT}/api/broadcasts`, {
    data: { unitId, body_template: '[Address] [FlyerLink]', seedContactIds: [contactId] },
  });
  expect(draft.ok()).toBeTruthy();
  const broadcastId = (await draft.json()).broadcastId as string;
  const send = await request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
    data: { recipientContactIds: [contactId] },
  });
  expect(send.ok()).toBeTruthy();
  return broadcastId;
}

/** Outbound messages to `phone` whose body carries `needle`. */
async function outboundHits(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  const thread = (await listThreads(request)).find((t) => t.partyNumber === phone);
  return thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle)).length ?? 0;
}

/** Open the seeded one-to-one composer for (unit, tenant) and go to the review
 *  list; returns the tenant's row locator. */
async function openReviewRow(page: Page, unitId: string, contactId: string, firstName: string) {
  await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}&contactId=${contactId}`);
  await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}\\?cta=text$`), { timeout: 10_000 });
  const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
  await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
  await previewBtn.click();
  const list = page.getByRole('list', { name: 'Candidate recipients' });
  await expect(list).toBeVisible();
  return list.locator('li', { hasText: firstName });
}

test.describe('share-skip-fix - one-to-one shares', () => {
  test('a share to a switched-off conversation: address + link default, the text lands, the next share flags him and keeps him checked', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId, line1 } = await createUnitViaApi(page.request, stamp);

    // From Dario's contact page: "+ Send" opens the seeded one-to-one composer.
    await page.goto(`${NEXT}/contacts/${DARIO.contactId}`);
    await page.getByRole('button', { name: 'Send a property to this tenant' }).click();
    await expect(page).toHaveURL(new RegExp(`/broadcasts/new\\?contactId=${DARIO.contactId}`));
    await page.getByRole('combobox', { name: 'Property' }).fill(line1);
    await page.getByRole('option', { name: new RegExp(`${stamp} Share Skip`) }).click();

    // D8: the one-line address, ONE space, the flyer link - nothing else. The
    // link is the server's (?cta=text) once the first draft exists.
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(
      new RegExp(`^${line1}, Atlanta, GA 30314 \\S+/p/${unitId}\\?cta=text$`),
      { timeout: 10_000 },
    );

    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();
    await expect(page.getByText(NOTE)).toBeVisible();
    await page.getByRole('button', { name: /^Send to 1 tenant\b/ }).click();

    // D4: the conversation is switched OFF (lean seed) and the text lands anyway;
    // the results row reaches Delivered (the fake auto-delivers).
    await expect(page).toHaveURL(/\/broadcasts\/[A-Za-z0-9_-]+$/, { timeout: 15_000 });
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText('Delivered').first()).toBeVisible({ timeout: 15_000 });
    await expect(recipients.getByText('Skipped')).toHaveCount(0);
    await expect
      .poll(async () => outboundHits(request, DARIO.phone, `/p/${unitId}`), { timeout: 15_000 })
      .toBe(1);

    // D5 (went out -> flagged): the NEXT share of the same property flags Dario
    // "Already sent" and, as the seeded recipient, keeps him CHECKED.
    const row = await openReviewRow(page, unitId, DARIO.contactId, DARIO.firstName);
    await expect(row.getByText('Already sent')).toBeVisible();
    await expect(row.getByRole('checkbox')).toBeChecked();
    // Do not send twice; leave the draft (the composer disposes an untouched one).
  });

  test('a share whose only recipient was SKIPPED reads Not sent and says why; after consent is recorded they are NOT "Already sent"', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createUnitViaApi(page.request, stamp);
    const noConsent = await createTenant(page.request, `Skipme${stamp}`, { consent: false });
    const broadcastId = await shareViaApi(page.request, unitId, noConsent.contactId);

    // D6 + D7 on the results page: the one recipient was skipped for consent.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    await expect(page.locator('header').getByText('Not sent', { exact: true })).toBeVisible({ timeout: 15_000 });
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText(/No texting consent recorded/)).toBeVisible({ timeout: 15_000 });
    expect(await outboundHits(request, noConsent.phone, `/p/${unitId}`)).toBe(0);

    // D6 on the list: the same share reads Not sent there, still under the Sent tab.
    await page.goto(`${NEXT}/broadcasts`);
    await page.getByRole('tab', { name: 'Sent' }).click();
    const rows = page.getByRole('list', { name: 'Property sends' });
    await expect(rows.getByText('Not sent', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // D5 (skipped -> NOT flagged): record consent, open the next share of the
    // same property to them - no "Already sent" flag, and the row is checked.
    await recordConsent(page.request, noConsent.contactId);
    const row = await openReviewRow(page, unitId, noConsent.contactId, noConsent.firstName);
    await expect(row).toBeVisible();
    await expect(row.getByText('Already sent')).toHaveCount(0);
    await expect(row.getByRole('checkbox')).toBeChecked();
  });

  test('a share whose only recipient FAILED still flags them "Already sent" (the interim rule, pinned)', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createUnitViaApi(page.request, stamp);
    const failing = await createTenant(page.request, `Failme${stamp}`, { consent: true });
    // Arm the NEXT message to this handset with a carrier failure.
    await setDeliveryOutcome(request, {
      partyNumber: failing.phone,
      profile: { kind: 'fail', failState: 'failed', errorCode: '30007' },
    });
    const broadcastId = await shareViaApi(page.request, unitId, failing.contactId);

    // D7 on a failed row: the carrier reason, from the shared map.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText('Failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(recipients.getByText(/Carrier filtered the message/)).toBeVisible({ timeout: 15_000 });

    // D5 (failed -> still flagged, interim): the next share of the property flags them.
    const row = await openReviewRow(page, unitId, failing.contactId, failing.firstName);
    await expect(row.getByText('Already sent')).toBeVisible();
    await expect(row.getByRole('checkbox')).toBeChecked(); // seeded, so still checked
  });
});
```

If the seeded draft route rejects `seedContactIds` with a body that carries no `[TenantName]`, keep the shape (the route accepts any template). If the results header renders the pill outside a `<header>`, scope the "Not sent" lookup to the element that holds the `BroadcastStatusPill` (`BroadcastResults.tsx:135-139` puts it inside `<header className={styles.header}>`).

- [ ] **Step 2: Run the new spec and its neighbours through the e2e workspace**

Run (repo root, Git Bash): `timeout 1500 npm run e2e`. The root script does not forward `--grep` reliably (memory: "root `npm run e2e` EATS `--grep`"), so run the whole suite; if a single spec must be isolated, use the e2e workspace's own runner from `e2e/` per `e2e/README.md`, never a stray root Playwright invocation.
Expected: PASS for `share-skip-fix.spec.ts`, `matching-entry-points.spec.ts` (repinned in Task 12) and `broadcasts.spec.ts` (unchanged: Tasha, an unseeded filter candidate, still starts unchecked).

- [ ] **Step 3: Commit**

```bash
git status
git add e2e/tests/dashboard-next/share-skip-fix.spec.ts
git commit -m "test(e2e): one-to-one share to a switched-off conversation; skipped vs failed already-sent; Not sent + reasons (share-skip-fix)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Final gates, main sync, handback

**Files:** `docs/superpowers/reviews/2026-09-24-share-skip-fix/build-handback.md` (committed); the orchestrator's own `.superpowers/sdd/handback.md` (gitignored, per its manual) mirrors it.

- [ ] **Step 1: Sync main ONCE**

This repo's shared branch is the LOCAL `main` (the `github` remote lags it; `origin/main` is not the base). If `main` has advanced in a way that could conflict with active work, ask before syncing (AGENTS.md).

```bash
git status
git merge main
```

Resolve conflicts preserving both sides' intent (the likely overlap: `app/src/jobs/broadcastFanOut.ts`, `dashboard/src/routes/contact/deliveryStatus.ts` if `feat/retry-send-window` merged first - keep its 30003 wording; `app/src/repos/broadcastsRepo.ts` if `feat/send-outcome-reconcile` merged first - keep both `created_via` and its attempt fields). Check `.git/MERGE_HEAD` is gone after the commit.

- [ ] **Step 2: Run every gate, bare, from the worktree root, on a quiet tree**

```bash
npm run typecheck
npm test
npm run smoke
timeout 1500 npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Expected: exit 0 for each. Git Bash for the e2e line (see Global Constraints; in PowerShell run `npm run e2e` bare). For gate 5, attribute any error by BASELINE COMPARISON (run the same `npx eslint <paths>` at the merge base; only errors absent there are yours). Quote every exit code verbatim in the handback. `npm test` needs DynamoDB Local (`npm run db:start`) and must not run while an `e2e:session` is live in this worktree. After any aborted e2e run, confirm no listener survives on the lane's ports before re-running.

- [ ] **Step 3: Write the handback**

`docs/superpowers/reviews/2026-09-24-share-skip-fix/build-handback.md` (ASCII), with everything spec section 7 asks for: the commit list; the five exit codes quoted; the slice reports linked; every spec decision mapped to its commit (D1-D10, I1-I8); the D1 numbers and the D2 outcome (from Cameron's dev/prod runs if he has made them by then, otherwise stated as PENDING with the lane rehearsal's counts in their place); the diagnosed cause (a pointer to `diagnosis.md`); every issue filed or amended (the WP2 issue, `import-conversations-missing-phone-claim`, `tenant-timeline-property-sent-milestone-after-failed-delivery`); anything deferred; and the two relays for the sibling branches (RSW: reading `retry_due_at` on the share results row is Branch B's; A touched no 30003 wording. SOR: file the broadcast-30003 slot-update issue itself; its adoption reads `created_via` for `automated`; A's merge points are spec section 6 item 3, which now also names `shareRecipientReason` in `broadcastFormat.ts` as the results-row reason gate). Commit it with explicit paths.

---

## Self-review notes (planner, plan v2)

- Spec coverage: D1 T1; D2 T2; D3 T3; D4 T7; D5 T8+T9 (+T14 tests 1-3); D6 T11 (+T14 test 2); D7 T6+T10 (+T14 tests 2-3); D8 T12 (+T14 test 1); D9 T4; D10 already filed (issues committed with the spec). Invariants (spec v8/v9 numbering): I1 T7 tests (kill switch stays in the wrapper, untouched); I2 T7 (`created_via` absent = automated); I3 T8 (skipped never "Already sent") + T11 (all-skipped never reads "Sent"); I4 T9 (Select all keeps seeded rows); I5 - no task writes `manual`: T2's condition/update only writes `auto`, T3 writes `auto` for one-to-one rows, nothing else touches the switch (verified by the T2 apply test: group rows and the breaker-tripped row are untouched); I6 T2 (only `auto`, only one-to-one, an audit event per enable, a lost audit write named and counted); I7 - Global Constraints + T2 (dry run default, `--apply` explicit, no infra/index/dependency in any task); I8 T7 (`recipient` item; deleted fence on the resolved contact). Section 5 surfaces: the switch (T2, T3, T13 seed; readers unchanged), the person's-share record (T7 route + seeded shares in matrix/performance), reasons and stats (T6 writers; readers T6 StatChips, T10 rows, T11 labels, T8 already-sent, T6 finalize log), one-to-one text (T12 composer + placeholder). Section 6 slicing: Global Constraints + T5 Step 3. Section 7: T14 covers all six e2e items; hermetic tests per decision in their tasks; gates T15.
- Type consistency: `skipped_other?: number` (T6, both workspaces); `created_via?: 'dashboard'` / `createdVia` (T7); `recipient?: ContactItem` (T7); `Row.seeded: boolean` (T9); `shareSkipReason(errorCode)` in deliveryStatus.ts and `shareRecipientReason(status, errorCode)` in broadcastFormat.ts (T10); `presentShareLabel(status, stats?)` (T11); `ONE_TO_ONE_SEND_TEMPLATE` (T12); `resolveStageClient(target, deps, opts: { lane? })`, `parseStageArgs`, `parseLane`, `laneAccessKeyId` (T1, used by T2's CLI); `findBreakerTrip`, `isPointerRow` exported from the census module and imported by T2; `UsageError` (T2).
- Review Focus 1-5 have tests in T1/T2 (unset rows, pointer rows), T7 (the phone#-keyed test), T8 (`c-both`), T6 (the bumpStats integration case) and T10/T11 (legacy code-less skips and legacy stats).
- Plan-internal claims re-verified against the code (round 1 findings): the persisted counters DO carry `skipped_no_consent` (`broadcastFanOut.ts:402`); the finalize log now reads derived stats because the persisted counters are cumulative and lack `skipped_other` on legacy rows; `broadcastFormat.test.ts` exists; the import never leaves `ai_mode` absent; the harness audit shape is `event_type` + `payload`.
