# Share Skip Fix (Branch A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Property sends staff start reach the tenant regardless of the per-conversation `ai_mode` switch; every one-to-one conversation is switched back to `auto` by a Cameron-run script; skipped recipients stop counting as "Already sent"; skipped and failed rows show their reason; a one-to-one send defaults to the address plus the flyer link.

**Architecture:** Two operator scripts (a read-only census and a dry-run-first fix script) plus an import default change land first as their own slice and go to Cameron before anything else. The send job then reads a creation-time record (`created_via: 'dashboard'`) to send staff shares as a person's send, the prior-recipients union stops counting `skipped` slots, the fan-out records a reason on every skip and routes non-opt-out skips to a new `skipped_other` bucket, and the dashboard renders those reasons, derives a "Not sent" label for all-skipped sends, keeps seeded rows checked, and pre-fills the one-recipient composer with `[Address] [FlyerLink]`. A lean-seed tenant whose conversation is switched off backs the e2e proof.

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (AWS SDK v3, DynamoDB Local in tests), Vitest (app + dashboard workspaces), React 18 + Testing Library (dashboard), Playwright (e2e workspace, hermetic lane), tsx for scripts.

**Spec:** `docs/superpowers/specs/2026-09-24-share-skip-fix-design.md` (Branch A, v8 or later). Branch B stub (NOT this plan): `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`.

## Global Constraints

- ASCII only in every new or touched line of source, tests, docs, seed strings and log strings (AGENTS.md). Verify a file with `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> `0`. Existing non-ASCII lines you do not touch stay as they are.
- Never run a script against dev or prod. An agent runs the census and the fix script ONLY against DynamoDB Local (`--env local`) or the per-file test databases. Cameron runs them against real environments (spec D2 last bullet).
- The account the scripts may touch on real AWS is `938565869261`, through the `housingchoice` profile, and the DynamoDB client MUST be built from that profile's credentials (spec D2 "Target safety"). Never the default credential chain.
- Production is written only by the Cameron-run fix script (spec I7). No Terraform, no new GSI, no new dependency, no `.env` edits.
- Commit explicit paths only (`git add <paths>`), never `git add -A`; read `git status` before every commit; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` unless the session's attribution reminder names a different model - then use that one.
- The lean seed world stays byte-stable: fixed ids, fixed timestamps, every timestamp before `2026-06-01T14:05:45.000Z` (T2), `unread_count` 0 or absent, camelCase `firstName`/`lastName` on every contact, `participants` entries as `{ contactId, phone }` objects (spec section 5, `app/src/lib/seed/lean.ts:1-46`).
- Skip reasons are staff-facing dashboard copy and live in `dashboard/src/routes/broadcasts/broadcastFormat.ts`, never in the message catalog (spec D7). The 30003 wording is NOT touched (RSW owns it).
- No new slot STATUS values: slots stay `queued | sent | delivered | failed | skipped`; new information rides `errorCode` and the derived stats buckets (spec D7; this also keeps SOR's D10 merge point clean).
- Exact spec copy, verbatim (spec D7 table and D5): `Automatic texts were off for this conversation`, `Opted out of texts`, `Number can't receive texts`, `No texting consent recorded`, `Contact was deleted`, `No contact or phone on file`, `Stopped by the automatic-text safety limit`, `Texting is turned off`, `Delivery failed`, `Opted out or number unreachable`, `Not sent (<code>)`, label `Not sent`, review note `Flagged tenants you picked stay checked; "Select all" skips the others.`
- One-to-one default message, exactly: the one-line address, ONE space, the flyer link - `[Address] [FlyerLink]` resolved (spec D8). Blasts keep `DEFAULT_SEND_TEMPLATE` unchanged.
- Gates (from the worktree root, bare, never piped): `npm run typecheck`, `npm test` (needs `npm run db:start`), `npm run smoke`, `timeout 1500 npm run e2e`, and `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (skip the last if the list is empty; attribute errors by baseline comparison against the merge base).
- Slice 1 (Tasks 1-5) is reviewed and handed to Cameron BEFORE Tasks 6+ start being built (spec section 6). The orchestrator commits slice 1, writes its slice report, and continues; the planner hands the scripts to Cameron.

## Review Focus

Inputs the spec implies but no task's tests exercise by default; each line names the owning task, which adds the test in its own step style.

1. A conversation row whose `ai_mode` attribute is ABSENT (a legacy row, or a row the import touched before this branch) is neither `manual` nor `auto`: the census must report it in the `unset` column and the fix script must leave it alone (the send wrapper treats absent as auto - `isManualMode` is `=== 'manual'`). Owner: Task 1 (census `unset` count) and Task 2 (fix script skips it).
2. A `phone#`, `email#` or `token#` pointer item has no `type` and no `ai_mode`; the fix script's negative type test alone would admit it. The `ai_mode = :manual` condition keeps it out, and the census must count it as a pointer, never as a typeless conversation. Owner: Task 1 and Task 2 (pointer rows in the seeded world).
3. A share whose recipient key is `phone#<E164>` (no contactId) must still send as a person's send and must not crash the new `recipientContactId` plumbing (there is no contactId to pass). Owner: Task 7.
4. A prior share in which the SAME tenant was skipped in one send and sent in another must still flag the tenant (the union is "any counted slot"). Owner: Task 8.
5. A results page for a LEGACY share whose skipped slots carry no `errorCode` must render `Opted out or number unreachable` and count them under opted-out, and its stats object (persisted, no `skipped_other`) must not break the Skipped chip. Owner: Task 10 and Task 11.

---

## File structure

New files:
- `app/scripts/lib/stageClient.ts` - the shared `--env local|dev|prod` stage resolver for the two new ops scripts: DynamoDB Local with fake credentials for `local`; the account guard on the `housingchoice` profile plus a client built from `hcCredentials()` for `dev`/`prod`. Injectable guard for tests.
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
- `app/src/services/sendMessage.ts` - `recipientContactId` input so the deleted and consent gates judge the fenced recipient (I8).
- `app/test/helpers/twilioWebhookHarness.ts` - the in-memory double mirrors `create()` and `priorRecipientContactIds`.
- `app/src/lib/seed/lean.ts` - one more tenant with a switched-off one-to-one conversation.
- `dashboard/src/api/types.ts` - `skipped_other?` on `BroadcastStats`.
- `dashboard/src/routes/broadcasts/broadcastFormat.ts` - `shareRecipientReason`, `presentShareLabel`.
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx`, `BroadcastStatusPill.tsx`, `BroadcastResults.tsx`, `BroadcastsList.tsx`, `StatChips.tsx` - render the reasons, the label and the new bucket.
- `dashboard/src/routes/broadcasts/RecipientPreview.tsx` - `seeded` on the row, hand-adds pre-checked, Select all keeps seeded rows, the note copy.
- `dashboard/src/routes/broadcasts/resolveTemplate.ts`, `BroadcastComposer.tsx`, `MessageEditor.tsx` - the one-to-one default text.
- Tests beside each of the above; `e2e/tests/dashboard-next/matching-entry-points.spec.ts` (the D8 pin).

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
- typecheck everything: `npm run typecheck` (repo root)

---

### Task 1: Read-only census script (spec D1) + the shared stage resolver

**Files:**
- Create: `app/scripts/lib/stageClient.ts`
- Create: `app/scripts/conversation-automation-census.ts`
- Test: `app/test/stageClient.test.ts`
- Test: `app/test/conversationAutomationCensus.test.ts`

**Interfaces:**
- Consumes: `assertHousingChoiceAccount`, `hcCredentials`, `HC_ACCOUNT_ID`, `HC_PROFILE`, `HC_REGION` from `scripts/lib/hcAws.mjs`; `tableName` from `app/src/lib/config.ts`; `queryAll` from `app/src/lib/dynamoPaging.ts`; `isOneToOneBucket` from `app/src/lib/unreadFeed.ts`; `DISCONTINUED_REMINDER_KINDS`, `retiredByTourStart` from `app/src/jobs/tourReminders.ts`; repos `createToursRepo`, `createTourRemindersRepo`, `createPlacementNudgesRepo`, `createContactsRepo`, `createConversationsRepo` (all take `{ doc, env }`).
- Produces: `resolveStageClient(target, deps)` -> `{ doc, env, endpoint, prefix }` (Task 2 reuses it); `runConversationAutomationCensus(opts)` -> `AutomationCensus`; `reportCensus(census)`.

- [ ] **Step 1: Write the failing stage-resolver test**

`app/test/stageClient.test.ts`:

```ts
// The shared --env stage resolver for the share-skip-fix ops scripts. The
// guard MUST bind to the client the script writes through (spec D2 "Target
// safety"): a wrong-account identity refuses BEFORE any client is built, and
// `local` never consults AWS at all.
import { describe, expect, it } from 'vitest';
import { resolveStageClient } from '../scripts/lib/stageClient.js';

describe('resolveStageClient', () => {
  it('local: DynamoDB Local endpoint, hc-local- prefix, no account guard call', async () => {
    let guardCalls = 0;
    const stage = await resolveStageClient('local', {
      assertAccount: async () => {
        guardCalls += 1;
        return { Account: '938565869261' };
      },
    });
    expect(stage.endpoint).toBe('http://localhost:8000');
    expect(stage.prefix).toBe('hc-local-');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-');
    expect(guardCalls).toBe(0);
    stage.doc.destroy();
  });

  it('local: an explicit --prefix picks the tables (a hermetic e2e lane), never the live hc-local- stack', async () => {
    const stage = await resolveStageClient('local', {}, { prefix: 'hc-local-3-' });
    expect(stage.prefix).toBe('hc-local-3-');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-3-');
    stage.doc.destroy();
  });

  it('dev/prod: REFUSE a --prefix before any AWS call (the stage alone picks real tables)', async () => {
    let guardCalls = 0;
    await expect(
      resolveStageClient('dev', { assertAccount: async () => { guardCalls += 1; return { Account: '938565869261' }; } }, { prefix: 'hc-dev-' }),
    ).rejects.toThrow(/--prefix/);
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
//   local -> hc-local-* at DynamoDB Local (http://localhost:8000, fake creds)
//   dev   -> hc-dev-*  on AWS via the pinned `housingchoice` profile
//   prod  -> hc-prod-* on AWS via the pinned `housingchoice` profile
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

export interface StageClient {
  doc: DynamoDBDocumentClient;
  /** Env carrying the stage's TABLE_PREFIX - hand it to every repo/tableName call. */
  env: NodeJS.ProcessEnv;
  /** Set for local only; undefined means real AWS. */
  endpoint: string | undefined;
  prefix: string;
  /** For the target line the scripts log first. */
  describe: string;
}

export function parseStageTarget(raw: string | undefined): StageTarget | undefined {
  return STAGE_TARGETS.includes(raw as StageTarget) ? (raw as StageTarget) : undefined;
}

export interface StageClientOpts {
  /**
   * LOCAL ONLY: the table prefix to target, e.g. a hermetic e2e lane's
   * `hc-local-<L>-`. The bare default `hc-local-` is the human's live local
   * stack (AGENTS.md: never test against it), so an agent rehearsal ALWAYS
   * passes a lane prefix. Refused for dev/prod: there the stage alone picks
   * the tables, so a typo can never point a prod run at another prefix.
   */
  prefix?: string;
}

export async function resolveStageClient(
  target: StageTarget,
  deps: StageClientDeps = {},
  opts: StageClientOpts = {},
): Promise<StageClient> {
  if (opts.prefix !== undefined && target !== 'local') {
    throw new Error(`--prefix is accepted with --env local only (got --env ${target}); refusing to continue.`);
  }
  const prefix = target === 'local' ? (opts.prefix ?? 'hc-local-') : `hc-${target}-`;
  const env: NodeJS.ProcessEnv = { ...process.env, TABLE_PREFIX: prefix };
  const marshallOptions = { removeUndefinedValues: true };
  if (target === 'local') {
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: HC_REGION,
        endpoint: LOCAL_ENDPOINT,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
      { marshallOptions },
    );
    return { doc, env, endpoint: LOCAL_ENDPOINT, prefix, describe: `DynamoDB Local ${LOCAL_ENDPOINT}` };
  }
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
    describe: `AWS ${HC_REGION} account ${identity.Account} (profile ${HC_PROFILE})`,
  };
}
```

- [ ] **Step 4: Run the stage-resolver test to verify it passes**

Run: `cd app; npx vitest run test/stageClient.test.ts`
Expected: PASS (5 tests).

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

  it('groups every row the way the spec names, lists breaker trips, sizes rungs and claims, and writes nothing', async () => {
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
    await put('conversations', { conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', created_at: NOW });
    await put('conversations', { conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    // Pointer items: a claim that MATCHES its row, a claim that points ELSEWHERE, and an email claim.
    await put('conversations', { conversationId: 'phone#+15550000001', ref_conversationId: 'c-import-manual' });
    await put('conversations', { conversationId: 'phone#+15550000002', ref_conversationId: 'c-somewhere-else' });
    await put('conversations', { conversationId: 'email#x@example.com', ref_conversationId: 'c-auto' });

    // Tour rungs: contact + tour per case.
    await put('contacts', { contactId: 'ten-off', type: 'tenant', status: 'searching', phone: '+15550000001', firstName: 'A', lastName: 'B', created_at: NOW });
    await put('contacts', { contactId: 'ten-on', type: 'tenant', status: 'searching', phone: '+15550000004', firstName: 'C', lastName: 'D', created_at: NOW });
    const tours = createToursRepo({ doc, env });
    const reminders = createTourRemindersRepo({ doc, env });
    const offTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const onTour = await tours.create({ tenantId: 'ten-on', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const groupTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'landlord_led' });
    await tours.patch(groupTour.tourId, { groupThreadId: 'c-relay' });
    const pastTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-09-01T15:00:00.000Z', tourType: 'self_guided' });
    await reminders.create({ tourId: offTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: onTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: groupTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: pastTour.tourId, kind: 'day_before', dueAt: '2026-08-31T23:00:00.000Z' });
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
    };

    const census = await runConversationAutomationCensus({ doc, env, now: NOW });

    expect(census.pointerRows).toBe(3);
    expect(census.byType).toEqual({
      unknown_1to1: { auto: 0, manual: 1, unset: 0 },
      tenant_1to1: { auto: 1, manual: 1, unset: 1 },
      landlord_1to1: { auto: 0, manual: 1, unset: 0 },
      '(none)': { auto: 0, manual: 1, unset: 0 },
      relay_group: { auto: 0, manual: 1, unset: 0 },
      group_text: { auto: 0, manual: 1, unset: 0 },
    });
    // Cause precedence: group thread, then breaker trip, then imported, then other.
    expect(census.manualByCause).toEqual({ groupThread: 2, breakerTrip: 1, imported: 1, other: 2 });
    expect(census.breakerTripped).toEqual([
      { conversationId: 'c-breaker', type: 'tenant_1to1', trippedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    expect(census.importClaimMismatches).toBe(1);
    expect(census.pendingTourRungs).toEqual({
      oneToOneSwitchedOff: 1,
      oneToOneSwitchedOn: 1,
      groupPointer: 1,
      tourPast: 1,
      discontinued: 1,
      unresolvable: 0,
    });
    expect(census.pendingNudgesHeldManualOnly).toBe(2);

    // READ-ONLY: not one row changed in either table the census reads.
    expect(await scanAll('conversations')).toEqual(before.conversations);
    expect(await scanAll('audit_events')).toEqual(before.audit);
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
//   - pending tour-reminder rungs that would take the one-to-one route and
//     whose conversation is switched off (these start sending after the fix
//     script runs), replaying the reminder job's own target resolution:
//     discontinued kinds, tours already started, and non-self_guided tours
//     carrying a group pointer are reported separately and do NOT count;
//   - pending placement nudges, reported separately: they are held manual-only
//     today and the fix script releases none of them;
//   - imported one-to-one rows whose phone claim points at a DIFFERENT row (a
//     missing claim is the normal state for an imported row).
//
// TARGET: `--env local|dev|prod` (required) resolves the tables and the
// credentials through scripts/lib/stageClient.ts; dev/prod run the account
// guard first and never touch the default credential chain. NO AGENT RUNS
// THIS AGAINST A REAL ENVIRONMENT; the human does.
//
// Run: npx tsx app/scripts/conversation-automation-census.ts --env dev
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DISCONTINUED_REMINDER_KINDS, retiredByTourStart } from '../src/jobs/tourReminders.js';
import { tableName } from '../src/lib/config.js';
import { queryAll } from '../src/lib/dynamoPaging.js';
import { logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem } from '../src/repos/toursRepo.js';
import { parseStageTarget, resolveStageClient } from './lib/stageClient.js';

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
    oneToOneSwitchedOff: number;
    oneToOneSwitchedOn: number;
    groupPointer: number;
    tourPast: number;
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
      oneToOneSwitchedOn: 0,
      groupPointer: 0,
      tourPast: 0,
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
    if (tour.tourType !== 'self_guided' && typeof tour.groupThreadId === 'string') {
      // The job takes the group route when the group is USABLE and falls back
      // to the tenant's 1:1 otherwise; the census cannot cheaply prove
      // usability, so these are reported as their own group rather than
      // guessed either way.
      r.groupPointer += 1;
      continue;
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
    if (conv.ai_mode === 'manual') r.oneToOneSwitchedOff += 1;
    else r.oneToOneSwitchedOn += 1;
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
    { breakerTripped: census.breakerTripped.length, pendingNudgesHeldManualOnly: census.pendingNudgesHeldManualOnly },
    'conversation-automation-census - done (read-only; nothing written). Pending nudges are held manual-only today and are NOT released by the fix script.',
  );
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('conversation-automation-census.ts');
if (invokedDirectly) {
  // Two value flags, nothing else: an unknown argument is refused, never ignored.
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  let bad = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const v = args[i + 1];
    if ((a === '--env' || a === '--prefix') && v !== undefined && !v.startsWith('--')) {
      values.set(a, v);
      i += 1;
    } else bad = true;
  }
  const target = parseStageTarget(values.get('--env'));
  if (bad || target === undefined) {
    console.error(
      'Usage: npx tsx app/scripts/conversation-automation-census.ts --env local|dev|prod [--prefix <hc-local-L->]\n' +
        '  --prefix is for a hermetic local lane only (agents never run this against dev/prod).',
    );
    process.exit(2);
  }
  const prefix = values.get('--prefix');
  resolveStageClient(target, {}, prefix !== undefined ? { prefix } : {})
    .then(async (stage) => {
      logger.info(
        { target, endpoint: stage.describe, prefix: stage.prefix },
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
Expected: PASS. If `tours.patch` does not exist under that name, read `app/src/repos/toursRepo.ts` for the patch method (`patch(tourId, input)` is how `groupThreadId` and `currentLadderId` are written; grep `async patch(`) and use it; do not write the tour row by hand.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` (repo root). Expected: exit 0.

```bash
git status
git add app/scripts/lib/stageClient.ts app/scripts/conversation-automation-census.ts app/test/stageClient.test.ts app/test/conversationAutomationCensus.test.ts
git commit -m "feat(ops): conversation-automation census (read-only) + guarded stage resolver

Spec D1. Counts by type and switch state, switched-off rows by cause with the
breaker-tripped list, pending one-to-one tour rungs, held nudges, import claim
mismatches. --env resolves tables and credentials; dev/prod bind the client to
the housingchoice profile after the account guard.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The fix script - switch one-to-one conversations on (spec D2)

**Files:**
- Create: `app/scripts/enable-conversation-automation.ts`
- Test: `app/test/enableConversationAutomation.test.ts`

**Interfaces:**
- Consumes: `resolveStageClient`, `parseStageTarget` (Task 1); `findBreakerTrip`, `isPointerRow` (Task 1's census module); `isOneToOneBucket`; `createAuditRepo`; `createConversationsRepo`.
- Produces: `enableConversationAutomation(opts)` -> `EnableResult`; `reportEnableRun(result, apply)` -> exit code. Audit events `mode_changed` `{ from: 'manual', to: 'auto', reason: 'bulk_enable' | 'operator_resume', script: 'enable-conversation-automation' }` (the RUNBOOK in Task 4 names both reasons).

- [ ] **Step 1: Write the failing test**

`app/test/enableConversationAutomation.test.ts`:

```ts
// The fix script (spec D2) against DynamoDB Local: dry run writes nothing;
// apply enables only one-to-one `manual` rows (typeless included, group rows
// and pointer items never); breaker-tripped rows are skipped unless included;
// single mode refuses a group thread or an unknown id; a re-run changes nothing;
// every change is audited; the conditional write loses to a concurrent change.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import {
  enableConversationAutomation,
  reportEnableRun,
} from '../scripts/enable-conversation-automation.js';

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
    expect(first).toMatchObject({ planned: 2, enabled: 2, breakerTrippedExcluded: 1, skippedOnCondition: 0, failed: 0 });
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

  it('single mode: resumes ONE conversation with the operator_resume reason; refuses a group thread and an unknown id', async () => {
    const w = await seedWorld();
    const resumed = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker' });
    expect(resumed).toMatchObject({ planned: 1, enabled: 1, scanned: 1 });
    expect(await w.mode('c-breaker')).toBe('auto');
    expect((await w.modeEvents('c-breaker')).map((e) => (e.payload as { reason: string }).reason)).toEqual([
      'breaker_trip',
      'operator_resume',
    ]);
    // Already on: nothing written, reported as alreadyOn.
    const again = await enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-breaker' });
    expect(again).toMatchObject({ planned: 0, enabled: 0, alreadyOn: 1 });
    await expect(
      enableConversationAutomation({ doc, env: w.env, now: NOW, apply: true, conversationId: 'c-relay' }),
    ).rejects.toThrow(/not a one-to-one conversation/);
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
// row; refuses an unknown id or a group thread; reports an already-on row.
//
// EVERY WRITE IS CONDITIONAL on the row still being a one-to-one conversation
// with the switch off, so a re-run and a concurrent runtime write are both
// safe: a lost condition is counted `skippedOnCondition`, never overwritten.
// Every enable appends a `mode_changed` audit event (manual -> auto) whose
// reason tells a bulk enable (`bulk_enable`) from a resume (`operator_resume`).
//
// FAILURE HANDLING mirrors retire-paused-tour-reminders.ts: a row that cannot
// be PLANNED is stepped over and counted `failed` (exit 1); a WRITE failure
// other than the conditional check ABORTS with a PARTIAL report.
//
// TARGET: `--env local|dev|prod` through scripts/lib/stageClient.ts (dev/prod:
// account guard first, client bound to the housingchoice profile). DRY RUN IS
// THE DEFAULT; `--apply` writes. NO AGENT RUNS THIS AGAINST A REAL ENVIRONMENT;
// the human does, dry run first, per the RUNBOOK.
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
import { logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { findBreakerTrip, isPointerRow } from './conversation-automation-census.js';
import { parseStageTarget, resolveStageClient } from './lib/stageClient.js';

export const SCRIPT_NAME = 'enable-conversation-automation';

export type EnableReason = 'bulk_enable' | 'operator_resume';

export interface EnableResult {
  scanned: number;
  pointerRows: number;
  groupRows: number;
  alreadyOn: number;
  unset: number;
  breakerTrippedExcluded: number;
  /** Rows the run decided to enable (dry run: would enable). */
  planned: number;
  /** Rows actually written (apply only). */
  enabled: number;
  /** Planned rows by type ('(none)' for a typeless row). */
  byType: Record<string, number>;
  /** Writes whose condition failed because the row moved under the run. */
  skippedOnCondition: number;
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
    failed: 0,
  };
  try {
    await run(opts, result);
  } catch (err) {
    logger.error(
      { ...result, apply: opts.apply === true },
      `${SCRIPT_NAME} - PARTIAL result: the run ABORTED and these counters cover only what completed before the failure. Every write is conditional and idempotent, so re-running after the fix is safe.`,
    );
    throw err;
  }
  return result;
}

async function run(opts: EnableOpts, result: EnableResult): Promise<void> {
  const { doc, env } = opts;
  const table = tableName('conversations', env);
  const apply = opts.apply === true;
  const single = opts.conversationId;
  const audit = createAuditRepo({ doc, env });
  logger.info(
    { table, endpoint: env.DYNAMODB_ENDPOINT ?? '(stage client)', apply, mode: single !== undefined ? 'single' : 'bulk' },
    `${SCRIPT_NAME} - target resolved`,
  );

  const enable = async (row: ConversationItem, reason: EnableReason): Promise<boolean> => {
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
      logger.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - row moved under the run; skipped`);
      return false;
    }
    await audit.append(`conversations#${row.conversationId}`, 'mode_changed', {
      from: 'manual',
      to: 'auto',
      reason,
      script: SCRIPT_NAME,
    });
    result.enabled += 1;
    logger.info({ conversationId: row.conversationId, reason }, `${SCRIPT_NAME} - conversation switched on`);
    return true;
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
      logger.error({ err, conversationId: row.conversationId }, `${SCRIPT_NAME} - row could not be PLANNED; stepped over and counted failed`);
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
        logger.info({ conversationId: row.conversationId }, `${SCRIPT_NAME} - breaker-tripped row excluded (pass --include-breaker-tripped or resume it singly)`);
        return;
      case 'enable': {
        result.planned += 1;
        const typeKey = typeof row.type === 'string' ? row.type : '(none)';
        result.byType[typeKey] = (result.byType[typeKey] ?? 0) + 1;
        if (apply) await enable(row, reason);
        return;
      }
    }
  };

  if (single !== undefined) {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { conversationId: single } }));
    const row = Item as ConversationItem | undefined;
    if (!row) throw new Error(`${SCRIPT_NAME}: conversation ${single} not found`);
    if (isPointerRow(row.conversationId) || !isOneToOneBucket(row)) {
      throw new Error(`${SCRIPT_NAME}: conversation ${single} is not a one-to-one conversation - refusing`);
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

/** The end-of-run report and the exit code it earns (failed > 0 exits 1, dry run included). */
export function reportEnableRun(result: EnableResult, apply: boolean): 0 | 1 {
  const suffix = apply ? '' : ' (DRY RUN - nothing written)';
  if (result.failed > 0) {
    logger.warn({ ...result, apply }, `${SCRIPT_NAME} - COMPLETED WITH FAILURES${suffix}: ${result.failed} row(s) could not be planned. Investigate the logged conversationIds, then re-run (idempotent).`);
    return 1;
  }
  logger.info({ ...result, apply }, `${SCRIPT_NAME} - done${suffix}`);
  return 0;
}

const KNOWN_FLAGS = new Set(['--apply', '--include-breaker-tripped']);
const KNOWN_VALUES = new Set(['--env', '--conversation', '--prefix']);

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('enable-conversation-automation.ts');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let bad = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (KNOWN_VALUES.has(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) bad = true;
      else values.set(a, v);
      i += 1;
    } else if (KNOWN_FLAGS.has(a)) flags.add(a);
    else bad = true; // a mistyped --apply must never fall through to a dry run, nor the reverse
  }
  const target = parseStageTarget(values.get('--env'));
  if (bad || target === undefined) {
    console.error(
      `Usage: npx tsx app/scripts/${SCRIPT_NAME}.ts --env local|dev|prod [--apply] [--conversation <id>] [--include-breaker-tripped] [--prefix <hc-local-L->]\n` +
        '  DRY RUN by default; --apply writes. Unknown arguments are refused. --prefix is for a hermetic local lane only.',
    );
    process.exit(2);
  }
  const apply = flags.has('--apply');
  const prefix = values.get('--prefix');
  resolveStageClient(target, {}, prefix !== undefined ? { prefix } : {})
    .then(async (stage) => {
      logger.info({ target, endpoint: stage.describe, prefix: stage.prefix, apply }, `${SCRIPT_NAME} - starting`);
      const result = await enableConversationAutomation({
        doc: stage.doc,
        env: stage.env,
        apply,
        ...(values.has('--conversation') && { conversationId: values.get('--conversation')! }),
        includeBreakerTripped: flags.has('--include-breaker-tripped'),
      });
      process.exitCode = reportEnableRun(result, apply);
      stage.doc.destroy();
    })
    .catch((err: unknown) => {
      logger.error({ err }, `${SCRIPT_NAME} - FAILED (see the PARTIAL report above)`);
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app; npx vitest run test/enableConversationAutomation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`. Expected: exit 0.

```bash
git status
git add app/scripts/enable-conversation-automation.ts app/test/enableConversationAutomation.test.ts
git commit -m "feat(ops): enable-conversation-automation - dry-run-first fix script (spec D2)

Switches one-to-one manual conversations to auto (typeless rows included,
group threads and pointer items never); breaker-tripped rows excluded unless
asked; single-conversation resume; conditional writes; a mode_changed audit
event per enable. Guarded stage resolution; agents run it only against local.

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

**Owed after the share-skip-fix deploy: ONE census read, then ONE fix-script apply, dev then prod, each on Cameron's explicit go.** No Terraform, no secrets, no schema change.

Every conversation row carries `ai_mode` (`auto` | `manual`). It was designed as the Phase-2 AI on/off switch, but the one-to-one send wrapper refuses EVERY automated text on a `manual` row - tour reminders, the missed-call text, the sign-up welcome, the 30003 retry and (before this branch) staff property sends. The Quo import created every conversation `manual`, nothing else ever turns the switch back on, and the circuit breaker turns it off (`mode_changed` audit event, reason `breaker_trip`) when a conversation exceeds `SEND_BREAKER_MAX_PER_MINUTE` automated texts in a minute. Placement nudges are NOT affected either way: every nudge kind is held manual-only and "Send now" is a person's send.

Both scripts take `--env local|dev|prod` and resolve the tables AND the credentials themselves (`app/scripts/lib/stageClient.ts`): `local` is DynamoDB Local with fake credentials; `dev`/`prod` run `assertHousingChoiceAccount()` on the pinned `housingchoice` profile FIRST and build the DynamoDB client from that profile - the machine's default (wrong-account) credential chain is never used. No `DYNAMODB_ENDPOINT`, `TABLE_PREFIX` or `AWS_PROFILE` exports. Unknown arguments are refused (a mistyped flag must never turn a rehearsal into a live apply).

1. **Census (read-only):** `npx tsx app/scripts/conversation-automation-census.ts --env dev`. It logs counts only: rows by type and switch state (`unset` = no `ai_mode` attribute, which the wrapper already treats as auto), switched-off rows by cause (group thread / breaker trip / imported / other), EVERY breaker-tripped conversation id individually, pending one-to-one tour-reminder rungs that will start sending once the switch is on (`pendingTourRungs.oneToOneSwitchedOff`), pending nudges (held manual-only, unaffected), and imported rows whose phone claim points at a different conversation. Read the breaker list before step 2.
2. **Dry run:** `npx tsx app/scripts/enable-conversation-automation.ts --env dev`. Dry run is the DEFAULT. `planned` is what an apply would switch on; `breakerTrippedExcluded` are the breaker rows it will leave alone; `groupRows`, `alreadyOn`, `unset` and `pointerRows` are never touched. `failed > 0` exits 1 (`COMPLETED WITH FAILURES`): investigate the logged ids before applying.
3. **Apply:** the same command with `--apply`. Every write is CONDITIONAL on the row still being a one-to-one conversation with the switch off, so a breaker trip that lands mid-run keeps the runtime's outcome (`skippedOnCondition`) and a re-run is a no-op. Each enable appends a `mode_changed` audit event `{ from: manual, to: auto, reason: bulk_enable }`.
4. **Then prod**, the same three steps. Take dev all the way through first.
5. **Import-window rule:** between the prod apply and the deploy of this branch, do NOT run `import:apply` from `main` - it still creates one-to-one rows `manual`. If one must run, re-run step 3 afterwards (idempotent).

**A conversation tripped the breaker - how to see why, and how to resume it.** One trip fires NO alarm: `hc-<env>-error-logs` needs 5 errors in one 5-minute period and `hc-<env>-error-logs-sustained` needs 3 consecutive periods, and the trip writes exactly one ERROR line (later refusals are WARN). No page shows a conversation's audit trail. Find a trip through any of:

- Logs Insights (both log groups, see "Reading logs"): `fields @timestamp, conversationId, count, capPerMinute | filter msg = 'circuit breaker TRIPPED: automated outbound cap exceeded - conversation flipped to manual' | sort @timestamp desc` (the stored msg text uses an em dash before "conversation"; match on the prefix `circuit breaker TRIPPED` if the exact line does not hit).
- Settings -> System status -> Recent errors.
- The census breaker list (step 1).
- The conversation's audit partition, read-only, via the profile (replace `<id>` and `<env>`): `aws dynamodb query --profile housingchoice --region us-east-1 --table-name hc-<env>-audit_events --key-condition-expression "entityKey = :e" --expression-attribute-values "{\":e\":{\"S\":\"conversations#<id>\"}}" --no-scan-index-forward`. The `mode_changed` item is the trip; the `message_sent` items just before it, with `payload.automated = true`, are the texts that tripped it (their SIDs, never bodies). The same SIDs appear in `outbound message sent` log lines with `automated: true`.

Decide whether the burst was legitimate (a reminder ladder plus a share in one minute) or a loop, fix the cause if there is one, then resume the conversation: `npx tsx app/scripts/enable-conversation-automation.ts --env <env> --apply --conversation <id>`. It refuses a group thread or an unknown id, reports `alreadyOn` when there is nothing to do, and appends `mode_changed` with reason `operator_resume`. The bulk apply (step 3) deliberately skips breaker-tripped rows; `--include-breaker-tripped` overrides that after you have reviewed the list.

**No agent runs either script against dev or prod.** An agent may run them only against a hermetic local lane (`--env local`). The visible per-conversation control and the breaker's own resume action are Work Package 2 (`docs/issues/ai-mode-switch-gates-all-automation.md`); until then this script is the only way back.
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

**Files:** none new. This task proves slice 1 and stops for the independent review + Cameron's runs.

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

The bare `hc-local-` prefix is Cameron's live local dev stack (AGENTS.md forbids touching it). Rehearse on an e2e lane instead: `npm run e2e:session` boots one and seeds the lean world into `hc-local-<L>-*` tables (the session prints its lane and `TABLE_PREFIX`; `e2e/support/lane.mjs:306` is where the prefix is formed). Then, with `<L>` filled in:

```bash
npx tsx app/scripts/conversation-automation-census.ts --env local --prefix hc-local-<L>-
npx tsx app/scripts/enable-conversation-automation.ts --env local --prefix hc-local-<L>-
npx tsx app/scripts/enable-conversation-automation.ts --env local --prefix hc-local-<L>- --apply
npx tsx app/scripts/enable-conversation-automation.ts --env local --prefix hc-local-<L>- --apply
npm run e2e:stop
```

Expected: the census reports the lean world (the group text and the connecting relay group under `groupThread`; before Task 13 lands, `planned` is 0 and after it is 1 - Dario's `conv-0002`); the dry run and the apply agree on `planned`; the second apply reports `planned: 0`. Capture the outputs into the slice report (counts only). Stop the session before any other suite runs in this worktree.

- [ ] **Step 3: Write the slice-1 report and STOP for review**

Write `docs/superpowers/reviews/2026-09-24-share-skip-fix/slice-1-report.md` (ASCII; the exit codes quoted verbatim from Step 1, the rehearsal counts from Step 2, the commit list). Commit it with explicit paths. The orchestrator's manual then runs the slice review; on a clean review the PLANNER hands the two commands (census; dry run; apply) to Cameron. Building continues with Task 6 without waiting for Cameron's production runs (spec section 6: running the script before the rest ships is safe).

---

### Task 6: Recipient reasons on every skip, the `skipped_other` bucket, finalize log (spec D7 backend)

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastStats`, `deriveBroadcastStats`, `zeroStats`)
- Modify: `app/src/jobs/broadcastFanOut.ts` (the first fence, the refusal branch, `finalize`'s log line)
- Modify: `app/src/lib/seed/performance.ts` and `app/src/lib/seed/matrix.ts` (stats literals gain `skipped_other: 0`)
- Modify: `dashboard/src/api/types.ts` (`BroadcastStats.skipped_other?`)
- Modify: `dashboard/src/routes/broadcasts/StatChips.tsx` (Skipped sums the new bucket)
- Test: `app/test/deriveBroadcastStats.test.ts`, `app/test/broadcastFanOut.test.ts`, `dashboard/src/routes/broadcasts/StatChips.test.tsx`

**Interfaces:**
- Consumes: the slot `errorCode` conventions in the fan-out.
- Produces: slot reasons on record: first-fence skips carry `opted_out` or `unreachable`; refusals keep `err.code`. Stats gain optional `skipped_other`. Bucket rule (`deriveBroadcastStats`): `skipped` with `errorCode` in {`no_consent`, `contact_no_consent`} -> `skipped_no_consent`; `skipped` with no code or code in {`opted_out`, `contact_opted_out`} -> `skipped_opted_out`; every other `skipped` -> `skipped_other`. Task 10/11 (dashboard) and Task 7 (the deleted fence) rely on exactly these codes.

- [ ] **Step 1: Write the failing derive test**

In `app/test/deriveBroadcastStats.test.ts`, REPLACE the test `skipped split: only errorCode "no_consent" is skipped_no_consent; every other skip is opted_out` with:

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

And in the INVARIANT test, add `(out.skipped_other ?? 0)` to the sum:

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

- [ ] **Step 3: Write the failing dashboard chip test**

In `dashboard/src/routes/broadcasts/StatChips.test.tsx`, add inside `describe('StatChips', ...)`:

```tsx
  it('share-skip-fix D7: the Skipped chip also sums skipped_other, defaulting 0 for legacy rows without it', () => {
    const { rerender } = render(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3, skipped_other: 4 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('9');
    rerender(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('5');
  });
```

- [ ] **Step 4: Run all three to verify they fail**

Run: `cd app; npx vitest run test/deriveBroadcastStats.test.ts test/broadcastFanOut.test.ts` and `cd dashboard; npx vitest run src/routes/broadcasts/StatChips.test.tsx`
Expected: FAIL (`skipped_other` undefined; reasons absent; chip shows 5 not 9).

- [ ] **Step 5: Implement the bucket + reasons**

`app/src/repos/broadcastsRepo.ts` - in `BroadcastStats`, after `skipped_no_consent: number;` add:

```ts
  /**
   * share-skip-fix D7: every OTHER skip - the switch off (`manual_mode`), the
   * breaker, a deleted contact, an unreachable number, the kill switch, any
   * future refusal code. Kept apart from `skipped_opted_out` so an opt-out is
   * an opt-out and nothing else is filed under it. Optional because persisted
   * stats rows written before the field existed lack it (readers default 0).
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

`app/src/jobs/broadcastFanOut.ts` - replace the first fence (the `if (contact.sms_opt_out === true || contact.sms_unreachable === true) { ... }` block) with two branches, opt-out first:

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

Replace the refusal branch's bump (inside `if (err instanceof SendRefusedError) {`) so the persisted counter follows the same rule as the derived one:

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

Import `isNoConsentCode`, `isOptedOutCode` and the `BroadcastStats` type from `'../repos/broadcastsRepo.js'` (extend the existing import block). In `finalize`, replace the last `log.info(...)` with one that reports the DERIVED stats (the persisted counters never carried `skipped_no_consent`, and now would not carry `skipped_other` either on a legacy row):

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

Seeds: in `app/src/lib/seed/performance.ts` `statsForRecipients`, add `skipped_other: 0,` after `skipped_no_consent: 0,`; in `app/src/lib/seed/matrix.ts` add `skipped_other: 0,` to both stats literals.

Dashboard: `dashboard/src/api/types.ts` `BroadcastStats` - after `skipped_no_consent: number;` add:

```ts
  /** Every other skip (switch off, breaker, deleted, unreachable, kill switch).
   *  Optional: persisted stats written before 2026-09-25 lack it - default 0. */
  skipped_other?: number;
```

`dashboard/src/routes/broadcasts/StatChips.tsx` - the Skipped chip:

```tsx
    { label: 'Skipped', value: stats.skipped_opted_out + stats.skipped_no_consent + (stats.skipped_other ?? 0) },
```

and update the header comment's balance line to include `Skipped = opted out + no consent + other`.

- [ ] **Step 6: Run the tests to verify they pass; run the neighbours**

Run: `cd app; npx vitest run test/deriveBroadcastStats.test.ts test/broadcastFanOut.test.ts test/broadcastApi.test.ts test/twilioStatusWebhook.test.ts` and `cd dashboard; npx vitest run src/routes/broadcasts`
Expected: PASS. (`broadcastApi.test.ts:1207` and `:1234` build stats literals without `skipped_other` - fine, the field is optional; `deriveBroadcastStats` now returns `skipped_other: 0` so the `toEqual` at `:1220-1229` needs `skipped_other: 0` added - do that.)

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/repos/broadcastsRepo.ts app/src/jobs/broadcastFanOut.ts app/src/lib/seed/performance.ts app/src/lib/seed/matrix.ts dashboard/src/api/types.ts dashboard/src/routes/broadcasts/StatChips.tsx app/test/deriveBroadcastStats.test.ts app/test/broadcastFanOut.test.ts app/test/broadcastApi.test.ts dashboard/src/routes/broadcasts/StatChips.test.tsx
git commit -m "feat(broadcasts): a reason on every skip and a skipped_other bucket (spec D7)

First-fence skips record opted_out / unreachable; refusals bucket by code
(consent, opt-out, other) in the persisted counters and the derived stats;
the finalize log reports the derived stats; the Skipped chip sums all three.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard-created shares send as a person's send (spec D4, I2, I8)

**Files:**
- Modify: `app/src/repos/broadcastsRepo.ts` (`CreateBroadcastInput.createdVia`, `BroadcastItem.created_via`, `create()`)
- Modify: `app/src/routes/broadcasts.ts` (the draft route passes `createdVia: 'dashboard'`)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the in-memory `create()` copies `created_via`)
- Modify: `app/src/services/sendMessage.ts` (`recipientContactId` input)
- Modify: `app/src/jobs/broadcastFanOut.ts` (`automated`, `recipientContactId`, a deleted fence)
- Test: `app/test/broadcastApi.test.ts`, `app/test/broadcastFanOut.test.ts`, `app/test/sendMessage.test.ts`

**Interfaces:**
- Consumes: Task 6's bucket predicates (`contact_deleted` -> `skipped_other`).
- Produces: `BroadcastItem.created_via?: 'dashboard'` (absent = automated); `SendMessageInput.recipientContactId?: string`. The fan-out sends `automated: broadcast.created_via !== 'dashboard'`, passes `recipientContactId` for contactId-keyed recipients, and skips a soft-deleted resolved contact as `skipped` / `contact_deleted` before any send.

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

- [ ] **Step 2: Write the failing fan-out tests**

In `app/test/broadcastFanOut.test.ts`:

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
    // The wrapper audited it as a person's send.
    const sentEvents = world.auditEvents.filter(
      (e) => e.entityKey === `conversations#${offConv.conversationId}` && e.event_type === 'message_sent',
    );
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]!.payload).toMatchObject({ automated: false });
  });

  it('share-skip-fix I1: a DASHBOARD share still refuses an opted-out, a no-consent and a soft-deleted recipient', async () => {
    const stopped = seedTenant(world, { contactId: 'c-stop', sms_opt_out: true, phone: '+15550100001' });
    const noConsent = seedTenant(world, { contactId: 'c-nc', phone: '+15550100002', consent_method: undefined });
    const deleted = seedTenant(world, { contactId: 'c-del', phone: '+15550100003', deleted_at: '2026-09-01T00:00:00.000Z' });
    seedUnit(world);
    seedBroadcast(world, [stopped, noConsent, deleted], { created_via: 'dashboard' });
    wireHandler(world, logger);

    await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId: 'bcast-1' });
    await outbound.settle();

    expect(world.sent).toHaveLength(0);
    const bcast = world.broadcasts.get('bcast-1')!;
    expect(bcast.recipients['c-stop']).toEqual({ status: 'skipped', errorCode: 'opted_out' });
    expect(bcast.recipients['c-nc']).toEqual({ status: 'skipped', errorCode: 'no_consent' });
    expect(bcast.recipients['c-del']).toEqual({ status: 'skipped', errorCode: 'contact_deleted' });
    expect(bcast.stats).toMatchObject({ skipped_opted_out: 1, skipped_no_consent: 1, skipped_other: 1 });
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

`FakeWorld.auditEvents` records `{ entityKey, event_type, actorId?, payload? }` - the real DynamoDB item shape (`app/test/helpers/twilioWebhookHarness.ts:226-236`).

Add one more, for a recipient keyed by phone (no contactId to pass - Review Focus 3):

```ts
  it('share-skip-fix I8: a phone#-keyed recipient of a DASHBOARD share still sends (no contactId to name)', async () => {
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
```

- [ ] **Step 3: Write the failing send-wrapper test**

In `app/test/sendMessage.test.ts`, inside the JIT-consent `describe` (around `:584-661`), add:

```ts
    it('share-skip-fix I8: recipientContactId makes the consent + deleted gates judge THAT contact, not the phone-matched one', async () => {
      const f = makeFakes();
      // Two contacts on the conversation's phone; the phone lookup returns the
      // no-consent one first.
      f.contacts.push({ contactId: 'c-dup', type: 'tenant', phone: '+15550001234' });
      f.contacts.push({ contactId: 'c-real', type: 'tenant', phone: '+15550001234', consent_method: 'verbal_in_person' });
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false }),
      ).rejects.toBeInstanceOf(ContactNoConsentError);
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipientContactId: 'c-real' }),
      ).resolves.toMatchObject({ conversationId: 'conv-1' });
      // A deleted RECIPIENT is still refused even when the phone-matched contact is live.
      f.contacts.push({ contactId: 'c-gone', type: 'tenant', phone: '+15550001234', consent_method: 'verbal_in_person', deleted_at: '2026-09-01T00:00:00.000Z' });
      await expect(
        f.service({ conversationId: 'conv-1', body: 'hi', automated: false, recipientContactId: 'c-gone' }),
      ).rejects.toBeInstanceOf(ContactDeletedError);
    });
```

Adapt the fixture calls to the suite's own `makeFakes` shape (read the suite's first 120 lines: how a contact is seeded, what phone `conv-1` carries, which errors are imported). The assertion pattern above is what matters.

- [ ] **Step 4: Run all three to verify they fail**

Run: `cd app; npx vitest run test/broadcastApi.test.ts test/broadcastFanOut.test.ts test/sendMessage.test.ts`
Expected: FAIL (`created_via` undefined; the manual conversation refuses; `recipientContactId` ignored).

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

`app/src/routes/broadcasts.ts` - in the draft route's `broadcasts.create({ ... })` call add `createdVia: 'dashboard',` after `created_by: actor,` with the comment:

```ts
      // share-skip-fix D4: only an authenticated staff session reaches this
      // route (sessionMiddleware + requireAuth on /api), so the share is a
      // person's share - recorded here, ONCE, so the send job never has to look
      // the creator up. A removed teammate's draft keeps the record.
      createdVia: 'dashboard',
```

`app/src/services/sendMessage.ts` - `SendMessageInput` gains:

```ts
  /**
   * share-skip-fix I8: the contact the CALLER already resolved as the
   * recipient (the broadcast fan-out's fenced tenant). When set, the deleted
   * and JIT-consent gates judge THIS contact rather than whichever contact the
   * phone lookup returns first (duplicate contacts on one phone), and the
   * opt-out gate refuses on EITHER contact's flag. Absent on every other send.
   */
  recipientContactId?: string;
```

Destructure it (`recipientContactId`) with the other inputs, then replace the block from `const contact = await contacts.findByPhone(participantPhone);` through the JIT consent gate with:

```ts
    const phoneContact = await contacts.findByPhone(participantPhone);
    const recipient =
      recipientContactId !== undefined ? await contacts.getById(recipientContactId) : undefined;
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

Keep the deleted gate and the JIT consent gate exactly as they are (they read `contact`, which is now the recipient when one was given).

`app/src/jobs/broadcastFanOut.ts` - after the contact resolves and BEFORE the first fence, add a deleted fence (import `isDeleted` from `'../repos/contactsRepo.js'`):

```ts
      // share-skip-fix I8: a soft-deleted recipient is unreachable through this
      // path (the deleted-contact rule). Judged on the RESOLVED contact, before
      // any send, with its own reason - never left to the wrapper's phone lookup.
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

Then the send call becomes:

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
          // cannot make the wrapper refuse (or admit) the wrong person. A
          // phone#-keyed recipient has no contactId to pass.
          ...(contactKey.startsWith('phone#') ? {} : { recipientContactId: contact.contactId }),
          broadcastId: payload.broadcastId,
        });
```

Update the file header comment lines 14-16 and 24-26 (the "SendRefusedError (conversation-level opt-out/breaker/manual)" wording) to say a dashboard share is a person's send and the manual/breaker refusals apply to automated shares only.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app; npx vitest run test/broadcastApi.test.ts test/broadcastFanOut.test.ts test/sendMessage.test.ts test/contactsBatchReads.test.ts test/contactsBatchIncomplete.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add app/src/repos/broadcastsRepo.ts app/src/routes/broadcasts.ts app/src/services/sendMessage.ts app/src/jobs/broadcastFanOut.ts app/test/helpers/twilioWebhookHarness.ts app/test/broadcastApi.test.ts app/test/broadcastFanOut.test.ts app/test/sendMessage.test.ts
git commit -m "feat(broadcasts): dashboard-created shares send as a person's send (spec D4, I8)

The draft route records created_via dashboard; the fan-out sends those shares
with automated false and names the fenced recipient so the wrapper's deleted
and consent gates judge that contact; a soft-deleted recipient is skipped with
its own reason before any send.

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

In `app/test/broadcastsRepo.integration.test.ts`, inside the existing DynamoDB Local describe (reuse its `repo`, table setup and any `unit-1`-style ids; read the file's first 80 lines for the names), add:

```ts
  it('share-skip-fix D5: prior recipients = any NON-skipped slot in a sent/sending share; a skipped slot never counts, a failed one still does', async () => {
    const unitId = 'unit-d5';
    // Share A (sent): one sent, one failed, one skipped, one skipped-in-A-but-sent-in-B.
    const a = await repo.create({
      created_by: 'usr_test',
      unitId,
      audience_filter: { contact_type: 'tenant' },
      body_template: 'Hi [TenantName]',
    });
    await repo.markSending(a.broadcastId, {
      'c-sent': { status: 'queued' },
      'c-failed': { status: 'queued' },
      'c-skipped': { status: 'queued' },
      'c-both': { status: 'queued' },
    });
    await repo.setRecipient(a.broadcastId, 'c-sent', { status: 'sent' });
    await repo.setRecipient(a.broadcastId, 'c-failed', { status: 'failed', errorCode: '30007' });
    await repo.setRecipient(a.broadcastId, 'c-skipped', { status: 'skipped', errorCode: 'manual_mode' });
    await repo.setRecipient(a.broadcastId, 'c-both', { status: 'skipped', errorCode: 'manual_mode' });
    await repo.markSent(a.broadcastId);
    // Share B (sending): c-both was sent this time; c-legacy is a code-less legacy skip.
    const b = await repo.create({
      created_by: 'usr_test',
      unitId,
      audience_filter: { contact_type: 'tenant' },
      body_template: 'Hi [TenantName]',
    });
    await repo.markSending(b.broadcastId, { 'c-both': { status: 'queued' }, 'c-legacy': { status: 'queued' } });
    await repo.setRecipient(b.broadcastId, 'c-both', { status: 'sent' });
    await repo.setRecipient(b.broadcastId, 'c-legacy', { status: 'skipped' });
    // Share C (draft): its slots never count, as before.
    const c = await repo.create({
      created_by: 'usr_test',
      unitId,
      audience_filter: { contact_type: 'tenant' },
      body_template: 'Hi [TenantName]',
    });
    void c;

    const prior = await repo.priorRecipientContactIds(unitId);
    expect([...prior].sort()).toEqual(['c-both', 'c-failed', 'c-sent']);
  });
```

If `markSending` in this file takes a different second argument shape, mirror whatever the file's existing tests pass (the repo's `markSending(broadcastId, recipients)` at `app/src/repos/broadcastsRepo.ts:552` takes the recipients map).

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
      audience_filter: { contact_type: 'tenant' },
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
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (add `shareRecipientReason`)
- Modify: `dashboard/src/routes/broadcasts/DeliveryBadge.tsx` (render the reason for skipped rows too)
- Test: `dashboard/src/routes/broadcasts/broadcastFormat.test.ts` (create if absent; the folder's other `.test.ts` files show the vitest import style), `dashboard/src/routes/broadcasts/StatChips.test.tsx` (DeliveryBadge cases)

**Interfaces:**
- Consumes: slot `errorCode` values from Task 6/7 (`opted_out`, `unreachable`, `contact_deleted`, `manual_mode`, `breaker_open`, `no_consent`, `contact_no_consent`, `contact_opted_out`, `sms_sending_disabled`, `no_contact`) and `deliveryReason` from `dashboard/src/routes/contact/deliveryStatus.ts` (carrier codes, `transient_cap`, `enqueue_failed`; untouched).
- Produces: `shareRecipientReason(status, errorCode): string | undefined` - the ONE reason map for share results rows. Task 14's e2e reads its copy.

- [ ] **Step 1: Write the failing pure-function test**

`dashboard/src/routes/broadcasts/broadcastFormat.test.ts` (add to the file if it exists, keeping its imports):

```ts
import { describe, expect, it } from 'vitest';
import { shareRecipientReason } from './broadcastFormat.js';

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

`dashboard/src/routes/broadcasts/broadcastFormat.ts` - import `deliveryReason` beside `presentDeliveryStatus` and add:

```ts
/** share-skip-fix D7: the staff-facing reason for a SKIPPED share recipient,
 *  keyed by the slot's errorCode (the send wrapper's refusal code, or the
 *  fan-out's own fence code). STAFF-FACING DASHBOARD COPY - it lives here, not
 *  in the message catalog. A skipped slot recorded before 2026-09-25 carries no
 *  code and was an opt-out or an unreachable number, unknown which - say so. */
const SKIP_REASONS: Readonly<Record<string, string>> = {
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

const LEGACY_SKIP_REASON = 'Opted out or number unreachable';

/** The reason a share recipient was NOT texted or NOT delivered - one sentence
 *  per row, for skipped AND failed slots (spec D7). Failed rows keep the shared
 *  deliveryReason (carrier codes, the fan-out's transient_cap / enqueue_failed,
 *  and the 30003 wording, which is owned elsewhere); `no_contact` is the
 *  fan-out's own "nothing to send to". Undefined for queued / sent / delivered. */
export function shareRecipientReason(
  status: BroadcastRecipient['status'],
  errorCode: string | undefined,
): string | undefined {
  if (status === 'skipped') {
    if (errorCode === undefined || errorCode.length === 0) return LEGACY_SKIP_REASON;
    // Own-property lookup: errorCode is wire data, never a trusted key.
    if (Object.prototype.hasOwnProperty.call(SKIP_REASONS, errorCode)) return SKIP_REASONS[errorCode];
    return `Not sent (${errorCode})`;
  }
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
git add dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/DeliveryBadge.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx
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

Append to `dashboard/src/routes/broadcasts/broadcastFormat.test.ts`:

```ts
import { presentShareLabel } from './broadcastFormat.js';

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

(Add `import type { BroadcastStats } from '../../api/index.js';` at the top of the file.)

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
- Modify: `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:186-196` (the resolved-mode auto-seed)
- Modify: `dashboard/src/routes/broadcasts/MessageEditor.tsx:84` (the placeholder in resolved mode)
- Test: `dashboard/src/routes/broadcasts/resolveTemplate.test.ts`, `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx:368-414`, `e2e/tests/dashboard-next/matching-entry-points.spec.ts:131-136`

**Interfaces:**
- Consumes: `resolveTemplateForUnit`, `serverFormatAddress` (unchanged).
- Produces: `ONE_TO_ONE_SEND_TEMPLATE = '[Address] [FlyerLink]'`. A one-recipient compose (resolved mode) pre-fills `<one-line address> <flyer link>`; blasts keep `DEFAULT_SEND_TEMPLATE` byte for byte. Task 14's e2e asserts the resolved value.

- [ ] **Step 1: Write the failing template test**

Append to `dashboard/src/routes/broadcasts/resolveTemplate.test.ts` (add `ONE_TO_ONE_SEND_TEMPLATE` to the import):

```ts
describe('ONE_TO_ONE_SEND_TEMPLATE (share-skip-fix D8)', () => {
  it('is the one-line address, ONE space, the flyer link - nothing else', () => {
    expect(ONE_TO_ONE_SEND_TEMPLATE).toBe('[Address] [FlyerLink]');
    expect(resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, makeUnit(), 'https://x/p/u1')).toBe(
      '44 Clifton Rd NE, Atlanta, GA 30307 https://x/p/u1',
    );
    // A structured address renders the server's one-line form.
    expect(
      resolveTemplateForUnit(
        ONE_TO_ONE_SEND_TEMPLATE,
        makeUnit({ address: { line1: '77 Peachtree St', line2: 'Apt 4', city: 'Atlanta', state: 'GA', zip: '30303' } }),
        'https://x/p/u1',
      ),
    ).toBe('77 Peachtree St Apt 4, Atlanta, GA 30303 https://x/p/u1');
  });

  it('the blast template is unchanged', () => {
    expect(DEFAULT_SEND_TEMPLATE).toBe(
      'Hi [TenantName], a [Beds]-bedroom home at [Address] is available for [Rent]/mo. Details: [FlyerLink]',
    );
  });
});
```

- [ ] **Step 2: Repin the composer tests**

In `dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx`, the resolved-mode describe (lines 368-414) pins `'Hi Tasha,'` three times. The default `getUnit` mock returns `unit()` = 1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314. Change:

- Test `a single seed + attached property auto-seeds the resolved text and hides the merge chips` - replace the `waitFor` with:

```tsx
    // share-skip-fix D8: the one-recipient default is the address + the flyer
    // link, nothing else - no greeting, no beds, no rent.
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

- [ ] **Step 3: Repin the e2e assertion**

In `e2e/tests/dashboard-next/matching-entry-points.spec.ts:131-136`, replace the three `message` expectations with:

```ts
    // The message now holds the FINAL resolved one-to-one text (share-skip-fix
    // D8): the property's one-line address, a space, the flyer link - and
    // nothing else. No greeting, no [TenantName] token.
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(
      new RegExp(`^${stamp} Matching Entry Ave, Atlanta, GA 30314 \\S+/p/${unitId}$`),
      { timeout: 10_000 },
    );
```

(Confirm the unit's city/state/zip in this spec's `createUnitViaApi` - lines 60-90 - and use those values.)

- [ ] **Step 4: Run the dashboard tests to verify they fail**

Run: `cd dashboard; npx vitest run src/routes/broadcasts/resolveTemplate.test.ts src/routes/broadcasts/BroadcastComposer.test.tsx`
Expected: FAIL - `ONE_TO_ONE_SEND_TEMPLATE` not exported; the resolved text still starts `Hi Tasha,`.

- [ ] **Step 5: Implement**

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

`dashboard/src/routes/broadcasts/BroadcastComposer.tsx` - import `ONE_TO_ONE_SEND_TEMPLATE` beside `DEFAULT_SEND_TEMPLATE`, and in the resolved-mode effect (lines 186-196) replace the body line:

```tsx
        // share-skip-fix D8: one recipient -> address + flyer link only.
        body: resolveTemplateForUnit(ONE_TO_ONE_SEND_TEMPLATE, unit, flyer),
```

The effect's dependency list can drop `seedContact` if nothing else in it reads it (it no longer does); update the comment above the effect ("Auto-seed the resolved default message ...") to say the one-to-one default carries no name. `resolveTemplateForTenant` stays exported (its tests still cover it).

`dashboard/src/routes/broadcasts/MessageEditor.tsx:84`:

```tsx
        placeholder={resolved ? ONE_TO_ONE_SEND_TEMPLATE : DEFAULT_SEND_TEMPLATE}
```

(import `ONE_TO_ONE_SEND_TEMPLATE` beside `DEFAULT_SEND_TEMPLATE`). Update the header comment of resolveTemplate.ts's `DEFAULT_SEND_TEMPLATE` doc ("ONE source of the copy for both") to name the one-to-one twin.

- [ ] **Step 6: Run the dashboard suites to verify they pass; lint the touched files**

Run: `cd dashboard; npx vitest run src/routes/broadcasts` then `npx eslint dashboard/src/routes/broadcasts/resolveTemplate.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/MessageEditor.tsx` (from the repo root).
Expected: PASS; no new lint errors (an unused `resolveTemplateForTenant` import in the composer would be one - remove the import if the composer no longer uses it).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git status
git add dashboard/src/routes/broadcasts/resolveTemplate.ts dashboard/src/routes/broadcasts/resolveTemplate.test.ts dashboard/src/routes/broadcasts/BroadcastComposer.tsx dashboard/src/routes/broadcasts/BroadcastComposer.test.tsx dashboard/src/routes/broadcasts/MessageEditor.tsx e2e/tests/dashboard-next/matching-entry-points.spec.ts
git commit -m "feat(dashboard): one-to-one share defaults to the address and the flyer link (spec D8)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Lean seed - a second tenant whose one-to-one conversation is switched off (spec section 5)

**Files:**
- Modify: `app/src/lib/seed/lean.ts` (`IDS`, one contact, one conversation)
- Test: `app/test/seedData.test.ts` (one assertion)

**Interfaces:**
- Produces: `contact-tenant-0002` (Dario Reyes, `+15550100004`, voucherSize 1, atlanta_housing, `verbal_phone` consent) and `conv-0002` (`tenant_1to1`, `ai_mode: 'manual'`, `imported_from: 'quo'`, `last_activity_at` before every other row). Task 14 drives him. The byte-stable rules from Global Constraints apply.

Why these values: voucherSize 1 keeps him OUT of every 2-BR audience the existing specs build (`broadcasts.spec.ts`, `matching-entry-points.spec.ts`) and out of `contacts-list-facets.spec.ts`'s 2-BR + DCA survivor; `atlanta_housing` is the authority the lean world already uses; the earliest `last_activity_at` keeps Tasha the newest inbox row (adjudication A29 in the file); `unread_count: 0` keeps the Unread tab empty (`inbox-markread.spec.ts`); `deleted-contact-resurfacing.spec.ts` anchors on "some other row rendered", so one more row is fine.

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
      // him anyway. voucherSize 1 keeps him out of every 2-BR audience the
      // existing specs build; atlanta_housing keeps the facet spec's DCA/Fulton
      // discriminators unused.
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
    // him regardless because a dashboard share is a person's send.
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

- [ ] **Step 4: Run the seed tests and the lean-world consumers**

Run: `cd app; npx vitest run test/seedData.test.ts test/seedRosterShape.test.ts` and any test that greps `+15550100004` in `app/test` against the SEED (none today - `broadcastApi.test.ts:869` uses that number in its own in-memory world, not the seed).
Expected: PASS.

- [ ] **Step 5: ASCII-check and commit**

```bash
git diff -U0 app/src/lib/seed/lean.ts | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c
git status
git add app/src/lib/seed/lean.ts app/test/seedData.test.ts
git commit -m "feat(seed): lean tenant with a switched-off one-to-one conversation (share-skip-fix e2e fixture)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: the wc prints `0`.

---

### Task 14: End-to-end proof (spec section 5 e2e)

**Files:**
- Create: `e2e/tests/dashboard-next/share-skip-fix.spec.ts`

**Interfaces:**
- Consumes: Task 13's seeded tenant; `listThreads`, `postInboundSms` from `e2e/fixtures/fakeTwilio.ts`; `expectTodayReady` from `e2e/support/today.ts`; the dashboard copy from Tasks 9, 10, 11, 12.
- Produces: two specs the gate runs.

- [ ] **Step 1: Write the spec**

`e2e/tests/dashboard-next/share-skip-fix.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { listThreads, postInboundSms } from '../../fixtures/fakeTwilio.js';
import { expectTodayReady } from '../../support/today.js';

// share-skip-fix (Sam's improvements #4 and #5), end to end on the hermetic lane:
//   1. A one-to-one share to a tenant whose conversation is switched OFF
//      (lean seed: Dario, conv-0002, ai_mode manual) pre-fills the address +
//      flyer link only (D8), reaches him anyway (D4), and the NEXT share of the
//      same property flags him "Already sent" AND keeps him checked (D5 seeded).
//   2. A share whose only recipient has opted out reads "Not sent" (D6) and
//      its row says "Opted out of texts" (D7).
// Sends are proven through the fake-twilio thread store, never real SMS.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DARIO = { contactId: 'contact-tenant-0002', phone: '+15550100004', firstName: 'Dario' };

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A fresh Available 1-BR property (Dario is a 1-BR voucher; the seeded units are
 *  under_application / off the send guard). Returns its id and street line. */
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

/** A consenting tenant with a unique phone (mirrors broadcasts.spec.ts). */
async function createTenant(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  const phone = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: 'tenant', firstName, lastName: 'Skiptest', phone, voucherSize: 1 },
  });
  expect(res.ok()).toBeTruthy();
  const contactId = (await res.json()).contact.contactId as string;
  const consent = await request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { consent_method: 'verbal_in_person', consent_at: new Date().toISOString() },
  });
  expect(consent.ok()).toBeTruthy();
  return { contactId, phone };
}

/** Outbound messages to `phone` whose body carries `needle`. */
async function outboundHits(request: APIRequestContext, phone: string, needle: string): Promise<number> {
  const thread = (await listThreads(request)).find((t) => t.partyNumber === phone);
  return thread?.messages.filter((m) => m.direction === 'outbound' && (m.body ?? '').includes(needle)).length ?? 0;
}

test.describe('share-skip-fix - one-to-one shares', () => {
  test('a share to a switched-off conversation: address + link default, the text lands, the next share keeps him checked', async ({
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

    // D8: the one-line address, ONE space, the flyer link - nothing else.
    const message = page.getByLabel('Message');
    await expect(message).toHaveValue(
      new RegExp(`^${line1}, Atlanta, GA 30314 \\S+/p/${unitId}$`),
      { timeout: 10_000 },
    );

    const previewBtn = page.getByRole('button', { name: 'Preview recipients' });
    await expect(previewBtn).toBeEnabled({ timeout: 15_000 });
    await previewBtn.click();
    const list = page.getByRole('list', { name: 'Candidate recipients' });
    await expect(list.getByRole('checkbox')).toHaveCount(1);
    await expect(list.getByRole('checkbox')).toBeChecked();
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

    // D5: the NEXT share of the same property to Dario flags him "Already sent"
    // and, because he is the seeded one-to-one recipient, keeps him CHECKED.
    await page.goto(`${NEXT}/broadcasts/new?unitId=${unitId}&contactId=${DARIO.contactId}`);
    await expect(page.getByLabel('Message')).toHaveValue(new RegExp(`/p/${unitId}$`), { timeout: 10_000 });
    const preview2 = page.getByRole('button', { name: 'Preview recipients' });
    await expect(preview2).toBeEnabled({ timeout: 15_000 });
    await preview2.click();
    const list2 = page.getByRole('list', { name: 'Candidate recipients' });
    const darioRow = list2.locator('li', { hasText: DARIO.firstName });
    await expect(darioRow.getByText('Already sent')).toBeVisible();
    await expect(darioRow.getByRole('checkbox')).toBeChecked();
    await expect(
      page.getByText('Flagged tenants you picked stay checked; "Select all" skips the others.'),
    ).toBeVisible();
    // Do not send twice; leave the draft (the composer disposes an untouched one).
  });

  test('a share whose only recipient opted out reads Not sent, and the row says why', async ({
    page,
    request,
  }) => {
    await devLogin(page);
    const stamp = `${Date.now()}`.slice(-6);
    const { unitId } = await createUnitViaApi(page.request, stamp);
    const stopped = await createTenant(page.request, `Stopme${stamp}`);
    // The tenant opts out (an inbound STOP through the signed webhook).
    const inbound = await postInboundSms(request, {
      from: stopped.phone,
      body: 'STOP',
      messageSid: `SM${stamp}stop${Math.floor(Math.random() * 1e6)}`,
    });
    expect(inbound.status).toBeLessThan(300);

    // Share the property with them, straight through the API (the review list
    // would fence an opted-out tenant out of a hand-add; the seeded path sends
    // to the explicit id, which is exactly the production shape of Sam's #5).
    const draft = await page.request.post(`${NEXT}/api/broadcasts`, {
      data: { unitId, body_template: `[Address] [FlyerLink]`, seedContactIds: [stopped.contactId] },
    });
    expect(draft.ok()).toBeTruthy();
    const broadcastId = (await draft.json()).broadcastId as string;
    const send = await page.request.post(`${NEXT}/api/broadcasts/${broadcastId}/send`, {
      data: { recipientContactIds: [stopped.contactId] },
    });
    expect(send.ok()).toBeTruthy();

    // D6 + D7 on the results page.
    await page.goto(`${NEXT}/broadcasts/${broadcastId}`);
    await expect(page.getByText('Not sent', { exact: true })).toBeVisible({ timeout: 15_000 });
    const recipients = page.getByRole('list', { name: 'Recipients' });
    await expect(recipients.getByText(/Opted out of texts/)).toBeVisible({ timeout: 15_000 });
    expect(await outboundHits(request, stopped.phone, `/p/${unitId}`)).toBe(0);

    // D6 on the list: the same share reads Not sent there, under the Sent tab.
    await page.goto(`${NEXT}/broadcasts`);
    await page.getByRole('tab', { name: 'Sent' }).click();
    const rows = page.getByRole('list', { name: 'Property sends' });
    await expect(rows.getByText('Not sent', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });
});
```

If the seeded draft route refuses `seedContactIds` without a `body_template` token, or the send route needs `recipientContactIds` to be the resolved seeds (it does: `broadcasts.spec.ts:134-137` posts them), keep the shape above; if the STOP does not flag the CONTACT (only the conversation), the fan-out's second fence refuses with `contact_opted_out` and the row still reads "Opted out of texts" - the assertion holds either way. If `page.getByText('Not sent', { exact: true })` also matches a row badge, scope it: `page.locator('header').getByText('Not sent', { exact: true })`.

- [ ] **Step 2: Run the new spec and its neighbours through the e2e workspace**

Run (repo root): `timeout 1500 npm run e2e -- --grep "share-skip-fix|Matching entry points|Broadcasts"` - NOTE the root script may not forward `--grep` (memory: "root `npm run e2e` EATS `--grep`"); if the filter is ignored, run the whole suite: `timeout 1500 npm run e2e`.
Expected: PASS for `share-skip-fix.spec.ts`, `matching-entry-points.spec.ts` (repinned in Task 12) and `broadcasts.spec.ts` (unchanged: Tasha, an unseeded filter candidate, still starts unchecked).

- [ ] **Step 3: Commit**

```bash
git status
git add e2e/tests/dashboard-next/share-skip-fix.spec.ts
git commit -m "test(e2e): one-to-one share to a switched-off conversation; Not sent + reasons (share-skip-fix)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Final gates, main sync, handback

**Files:** `docs/superpowers/reviews/2026-09-24-share-skip-fix/` (reports), `.superpowers/sdd/handback.md` (gitignored, per the profile).

- [ ] **Step 1: Sync main ONCE**

```bash
git status
git fetch origin main
git merge origin/main
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

Expected: exit 0 for each. For gate 5, attribute any error by BASELINE COMPARISON (run the same `npx eslint <paths>` at the merge base; only errors absent there are yours). Quote every exit code verbatim in the handback. `npm test` needs DynamoDB Local (`npm run db:start`) and must not run while an `e2e:session` is live in this worktree.

- [ ] **Step 3: Write the handback**

`docs/superpowers/reviews/2026-09-24-share-skip-fix/build-handback.md` (ASCII): the commit list, the five exit codes quoted, the slice reports linked, every spec decision mapped to its commit (D1-D10, I1-I8), anything deferred (Cameron's own runs: the census and the fix script on dev then prod, per `RUNBOOK.md`), and the two relays for the sibling branches (RSW: reading `retry_due_at` on the share results row is Branch B's; A touched no 30003 wording. SOR: file the broadcast-30003 slot-update issue itself; its adoption reads `created_via` for `automated`; A's merge points are spec section 6 item 3). Commit it with explicit paths.

---

## Self-review notes (planner)

- Spec coverage: D1 T1; D2 T2; D3 T3; D4 T7; D5 T8+T9; D6 T11; D7 T6+T10; D8 T12; D9 T4; D10 already filed (issues committed with the spec); I1 T7 tests; I2 T7 (`created_via` absent = automated); I3 T3 (`if_not_exists` unchanged, re-run test); I4 T9; I5 (blasts unchanged) T12 test; I6 (no new slot status) Global Constraints + T6; I7 T2 (conditional writes, dry run default); I8 T7. Section 5 surfaces: lean seed T13, e2e T14, RUNBOOK T4, seed broadcast fixtures T6.
- Type consistency: `skipped_other?: number` (T6, both workspaces); `created_via?: 'dashboard'` / `createdVia` (T7); `recipientContactId?: string` (T7); `Row.seeded: boolean` (T9); `shareRecipientReason(status, errorCode)` (T10); `presentShareLabel(status, stats?)` (T11); `ONE_TO_ONE_SEND_TEMPLATE` (T12); `resolveStageClient(target, deps, opts)` (T1, T2 CLI); `findBreakerTrip`, `isPointerRow` exported from the census module and imported by T2.
- Review Focus 1-5 have tests in T1/T2 (unset rows, pointer rows), T7 (phone#-keyed recipient: covered by the existing `phone#` fan-out test plus the `contactKey.startsWith('phone#')` branch - T7 Step 2 adds no new case; the builder adds one if the existing suite lacks a phone#-keyed send), T8 (`c-both`), T10/T11 (legacy code-less skips and legacy stats).
