// Table administration helpers built on lib/tables.ts — used by the dev-loop
// creation script (app/scripts/db-create.ts) and the integration tests.
//
// These are LOCAL/DEV tooling only: in AWS the tables are created and owned by
// Terraform (M0.4), which must mirror lib/tables.ts exactly. Nothing in the
// app's request path calls these.
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
  type DynamoDBClient,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb';
import type { GsiSpec, KeyAttribute, TableSpec } from './tables.js';

function keySchema(hashKey: KeyAttribute, rangeKey?: KeyAttribute): KeySchemaElement[] {
  return [
    { AttributeName: hashKey.name, KeyType: 'HASH' },
    ...(rangeKey ? [{ AttributeName: rangeKey.name, KeyType: 'RANGE' as const }] : []),
  ];
}

/** Every distinct attribute referenced by the table key or any GSI key. */
function attributeDefinitions(spec: TableSpec): CreateTableCommandInput['AttributeDefinitions'] {
  const attrs = new Map<string, KeyAttribute>();
  const add = (attr?: KeyAttribute): void => {
    if (attr) attrs.set(attr.name, attr);
  };
  add(spec.hashKey);
  add(spec.rangeKey);
  for (const gsi of spec.gsis) {
    add(gsi.hashKey);
    add(gsi.rangeKey);
  }
  return [...attrs.values()].map((a) => ({ AttributeName: a.name, AttributeType: a.type }));
}

/**
 * Pure converter: GsiSpec -> the index input shape. Exported because
 * app/scripts/db-update-gsis.ts passes the SAME object to UpdateTable's
 * `GlobalSecondaryIndexUpdates: [{ Create: ... }]`, and the two paths must
 * never drift on key schema or projection.
 */
export function gsiInput(
  gsi: GsiSpec,
): NonNullable<CreateTableCommandInput['GlobalSecondaryIndexes']>[number] {
  return {
    IndexName: gsi.indexName,
    KeySchema: keySchema(gsi.hashKey, gsi.rangeKey),
    // Projection ALL is part of the M0.3 contract (document-style items).
    Projection: { ProjectionType: 'ALL' },
  };
}

/** Pure converter: TableSpec -> CreateTable input (also unit-tested). */
export function toCreateTableInput(spec: TableSpec, physicalName: string): CreateTableCommandInput {
  return {
    TableName: physicalName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: keySchema(spec.hashKey, spec.rangeKey),
    AttributeDefinitions: attributeDefinitions(spec),
    ...(spec.gsis.length > 0 ? { GlobalSecondaryIndexes: spec.gsis.map(gsiInput) } : {}),
    ...(spec.stream
      ? { StreamSpecification: { StreamEnabled: true, StreamViewType: spec.stream } }
      : {}),
  };
}

// --- DynamoDB Local control-plane retry -------------------------------------
//
// LOCAL-ONLY HAZARD, not an API contract issue. Under concurrent load the
// DynamoDB Local container answers control-plane calls with
//
//   InternalFailure: The request processing has failed because of an unknown
//   error, exception or failure.
//
// or with
//
//   InternalServerError: This action timed out because it took too long
//   waiting for a lock
//
// (its own per-table tryLock(10s) expiring). Neither is a rejected request -
// it is the container buckling, the same call succeeds moments later, and
// running the suite alone is green. The AWS SDK's default retry policy covers
// neither code, so both escape to the caller and fail whatever gate is
// running. See docs/issues/npm-test-dynamodb-local-contention.md.
//
// THE RETRY MUST BE ABLE TO RE-READ. This is the part an earlier version of
// this reasoning (in app/scripts/db-update-gsis.ts, which this helper now
// serves) claimed but did not perform: the case the retry exists for is the
// server ACCEPTING attempt 1 and only its RESPONSE failing. A bare re-send
// then asks for something that already exists and draws a
// ResourceInUseException - which is not retryable - so a run whose mutation
// SUCCEEDED fails anyway, blaming a resource conflict. Reproduced against the
// container by an adversarial review, 2026-08-23.
//
// So a caller whose re-send is not idempotent supplies a verification hook
// (sendWithRetryVerified) that answers "did attempt N actually land?". The
// hook's contract is ONE contract for every caller, deliberately:
//
//   returns true  -> the mutation landed; return success, no re-send
//   returns false -> re-send, subject to the attempt bound
//   throws        -> FAIL CLOSED: rethrow the ORIGINAL error, no re-send
//
// It is called at most once per failed attempt, is never itself retried, and
// is NOT called on the final attempt (the bound is checked first). A caller
// that WANTS to tolerate a failed verification puts that tolerance in its own
// hook - see indexStatus in app/scripts/db-update-gsis.ts - never here, where
// the next caller would inherit it silently.
//
// The retry activates ONLY against a localhost DynamoDB Local endpoint, so it
// can never mask a production fault; against real AWS this code is inert and
// the original error propagates on the first failure, exactly as before.

/**
 * Retry schedule for the control-plane retry. Injectable ONLY so the
 * acceptance suite (test/dynamoAdminRetry.test.ts) does not spend seconds in
 * real setTimeout; no product caller overrides it.
 */
export interface RetrySchedule {
  /** Total attempts INCLUDING the first. Default 4. */
  attempts?: number;
  /** Delay before re-sending after failed attempt N. Default `N * 250` ms. */
  backoffMs?: (attempt: number) => number;
  /**
   * Wall-clock budget for the WHOLE retry, measured from just before attempt 1
   * and checked before each re-send. Default 20_000 ms.
   */
  deadlineMs?: number;
}

/** Tuning for pollUntilTableActive; injectable for the same reason. */
export interface PollOptions {
  intervalMs?: number;
  ceilingMs?: number;
}

const DEFAULT_ATTEMPTS = 4;
// THE ATTEMPT BOUND IS NOT A BUDGET. The lock-timeout signature above costs the
// caller ~10s of blocking per attempt, so four attempts plus linear backoff can
// spend ~41.5s - and the hooks that reach here loop the whole 22-table manifest
// inside a 60s hookTimeout, where the resulting failure reads "Hook timed out in
// 60000ms" and names nothing. 20s is chosen so that ONE full lock-timeout retry
// (~10s + backoff) still fits, and several fast InternalFailure retries still
// fit.
//
// WHAT IT BOUNDS IS ONE RETRIED SEND. It is read only before a RE-SEND, never
// during one, so an attempt already in flight is not interrupted: the effective
// bound is deadlineMs PLUS one attempt. It is not a budget for a whole
// ensureTable call either - on a TTL-bearing spec that makes up to THREE
// retried sends (CreateTable, the pre-send DescribeTimeToLive, and
// UpdateTimeToLive), each with its own fresh clock, plus up to 10s in
// pollUntilTableActive on the retried-conflict path; and the success path's SDK
// waiter (waitUntilTableExists, 60s) sits outside all of them. Under `npm test`
// the two TTL legs do not run at all (DYNAMO_DISABLE_TTL=1); db:create and the
// e2e lanes do reach them. Size a hook timeout by adding these up, not by
// reading this one number.
const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
// Argued against DynamoDB Local's own 10s per-table lock timeout: a table that
// is still not ACTIVE after 10s locally is not going to become so inside the
// same test hook.
//
// NOT a contradiction of db-update-gsis.ts's 900s timeout, which the same diff
// introduced: that one waits on a GSI BACKFILL over a populated local table,
// which legitimately takes minutes. This one waits on a table THIS call just
// created - empty, and, FOR THE VITEST CALLERS, not being created concurrently
// by anyone else, because the access-key guard puts every such suite on a
// per-run-random table prefix or a worktree-derived key. An empty table that is
// still not ACTIVE after 10s is stuck, not busy.
//
// THAT EXCLUSIVITY IS A CLAIM ABOUT THE VITEST KEY SCHEME ACROSS WORKTREES, not
// about every caller. app/scripts/db-create.ts runs against the human's ambient
// database under fixed names, and scripts/e2e-session.mjs runs db-create and
// then db-update-gsis over the same lane tables - so a table there really can be
// UPDATING for the minutes that backfill budget allows. What those callers lose
// is bounded: only a RETRIED conflict reaches this poll at all, and it then
// fails after 10s naming the observed status, where the base code failed
// IMMEDIATELY on the InternalFailure. A slower failure, not a lost success.
//
// A DescribeTable that FAILS inside the poll counts as not-ACTIVE by design and
// is not retried (see pollUntilTableActive), so 10s of unreadable container ends
// a retried conflict in a hard failure rather than a longer wait.
const DEFAULT_POLL_CEILING_MS = 10_000;

// URL.hostname yields the BRACKETED form for an IPv6 literal, so both spellings
// belong here. app/scripts/db-create.ts:25 accepts the same four, from a URL
// STRING; this predicate reads a RESOLVED endpoint object instead, which is why
// it is a separate function rather than an import (and `lib` must not import
// from `scripts` regardless).
const LOCAL_ENDPOINT_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Does this client point at a DynamoDB Local on this machine?
 *
 * `client.config.endpoint` is `Provider<Endpoint> | undefined` - an async
 * provider, not a URL string. FAIL CLOSED: no provider, a provider that
 * throws, or any other hostname all mean NOT local, and therefore no retry.
 *
 * Exported so the acceptance suite can pin the predicate against a REAL
 * DynamoDBClient without sending anything.
 */
export async function isLocalDynamoEndpoint(client: DynamoDBClient): Promise<boolean> {
  const provider = client.config.endpoint;
  if (typeof provider !== 'function') return false;
  try {
    const endpoint = await provider();
    return LOCAL_ENDPOINT_HOSTNAMES.has(endpoint.hostname);
  } catch {
    return false;
  }
}

function isRetryableContainerFault(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name ?? '';
  return name === 'InternalFailure' || name === 'InternalServerError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The one retry loop. Both public entry points below delegate here; the
 * difference between them is only which of `verify` / `onRetry` they may pass,
 * which is what makes the hook constraint a TYPE rather than a comment.
 */
async function retryLocalControlPlane(
  client: DynamoDBClient,
  attempt: () => Promise<void>,
  opts: {
    schedule?: RetrySchedule | undefined;
    verify?: (() => Promise<boolean>) | undefined;
    onRetry?: (() => void) | undefined;
  },
): Promise<void> {
  const attempts = opts.schedule?.attempts ?? DEFAULT_ATTEMPTS;
  // Linear: the container needs a moment, not an exponential one.
  const backoffMs = opts.schedule?.backoffMs ?? ((n: number): number => n * 250);
  const deadlineMs = opts.schedule?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  // Resolved LAZILY, and at most once: the hot path never touches the endpoint.
  let local: boolean | undefined;

  for (let n = 1; ; n += 1) {
    try {
      await attempt();
      return;
    } catch (err) {
      if (!isRetryableContainerFault(err)) throw err;
      if (n >= attempts) throw err;
      local ??= await isLocalDynamoEndpoint(client);
      if (!local) throw err;
      if (opts.verify) {
        let landed: boolean;
        try {
          landed = await opts.verify();
        } catch {
          // Fail closed. A verification we could not perform is not a licence
          // to re-send: re-sending a mutation that already landed converts a
          // transient hiccup into a hard, misleading failure.
          throw err;
        }
        if (landed) return;
      }
      // The elapsed-time half of the bound. Read only here, in the catch, so a
      // clean send never touches the clock, and deliberately AFTER the verify
      // block: the deadline stops RE-SENDS only. Every non-final failed attempt
      // still asks "did it land?" - skipping that read would report a mutation
      // the server ACCEPTED as failed, which is the one failure this whole
      // module exists to remove, and the deadline reaches it earlier than the
      // attempt bound does (see case 22). The hook is one read and cannot loop.
      // Checked before the re-send rather than after it, because the point is
      // to stop spending, not to notice afterwards that we did.
      if (Date.now() - startedAt >= deadlineMs) throw err;
      opts.onRetry?.();
      await sleep(backoffMs(n));
    }
  }
}

/**
 * Send a command, retrying the container's transient control-plane faults.
 * Accepts NO verification hook - use it only where a re-send is harmless or
 * where the caller's own catch already tolerates the "it landed" error.
 *
 * `onRetry` fires immediately before each re-send, so a caller can tell a
 * retried call from a clean one. Keep that state PER CALL (a module-level flag
 * would be wrong: ensureTable is called concurrently).
 */
export async function sendWithRetry<TOut>(
  client: DynamoDBClient,
  send: () => Promise<TOut>,
  opts: { schedule?: RetrySchedule | undefined; onRetry?: (() => void) | undefined } = {},
): Promise<TOut> {
  // Definitely assigned: with no `verify` hook the loop can only return after
  // the closure below has run to completion; every other exit throws.
  let output!: TOut;
  await retryLocalControlPlane(
    client,
    async () => {
      output = await send();
    },
    { schedule: opts.schedule, onRetry: opts.onRetry },
  );
  return output;
}

/**
 * Send a command whose re-send is NOT idempotent, with a required hook that
 * answers "did the failed attempt actually land?". Returns void: on the
 * hook-said-yes path there is no output to hand back, and typing that away
 * would make the constraint unenforceable.
 */
export async function sendWithRetryVerified(
  client: DynamoDBClient,
  send: () => Promise<unknown>,
  verify: () => Promise<boolean>,
  opts: { schedule?: RetrySchedule | undefined } = {},
): Promise<void> {
  await retryLocalControlPlane(
    client,
    async () => {
      await send();
    },
    { schedule: opts.schedule, verify },
  );
}

/** Thrown by pollUntilTableActive when the table is still not ACTIVE. */
export class TableNotActiveError extends Error {
  readonly tableName: string;
  readonly observedStatus: string;

  constructor(physicalName: string, observedStatus: string, ceilingMs: number) {
    super(`table ${physicalName} is still ${observedStatus} after ${ceilingMs}ms`);
    this.name = 'TableNotActiveError';
    this.tableName = physicalName;
    this.observedStatus = observedStatus;
  }
}

/**
 * Wait for a table to report ACTIVE, bounded.
 *
 * NOT waitUntilTableExists: the SDK waiter's default schedule makes its second
 * poll a flat 20s and it throws at 60s, which is the whole budget of the
 * beforeAll hooks that reach ensureTable. Arming a new false red while fixing
 * an old one is not a trade worth making.
 *
 * The SUCCESS path of ensureTable nevertheless keeps waitUntilTableExists
 * deliberately unchanged - its first poll is immediate, so a fresh empty table
 * normally returns on the first check and the flat-20s second tick bites only
 * when the create itself is slow - and this mission changed only the
 * retried-conflict path.
 *
 * Its own DescribeTable reads are NOT retried - a read that fails here simply
 * counts as "not ACTIVE yet" and is polled again until the ceiling. It carries
 * no endpoint gate of its own either: the only caller reaches it after a retry
 * that could only have happened on a local endpoint, so a second gate would be
 * dead code that reads as a live safeguard.
 */
export async function pollUntilTableActive(
  client: DynamoDBClient,
  physicalName: string,
  opts: PollOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ceilingMs = opts.ceilingMs ?? DEFAULT_POLL_CEILING_MS;
  const deadline = Date.now() + ceilingMs;
  let observed = 'unknown';
  for (;;) {
    try {
      const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
      observed = Table?.TableStatus ?? 'absent';
      if (observed === 'ACTIVE') return;
    } catch {
      observed = 'unreadable';
    }
    if (Date.now() >= deadline) throw new TableNotActiveError(physicalName, observed, ceilingMs);
    await sleep(intervalMs);
  }
}

export type EnsureTableResult = 'created' | 'exists';

/** Retry/poll tuning for ensureTable. Tests inject; product callers do not. */
export interface EnsureTableOptions {
  retry?: RetrySchedule;
  poll?: PollOptions;
}

/**
 * Idempotently create the table (plus TTL setting) for a spec. Safe to re-run:
 * existing tables are left untouched and reported as 'exists'.
 */
export async function ensureTable(
  client: DynamoDBClient,
  spec: TableSpec,
  physicalName: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: EnsureTableOptions = {},
): Promise<EnsureTableResult> {
  let result: EnsureTableResult = 'created';
  // PER CALL, never module-level: ensureTable is called concurrently (see
  // test/todayUnmatchedNonRegression.test.ts:105-109), so a shared flag set by
  // one call would make an unrelated call poll - and every sequential test
  // would still pass.
  let retried = false;
  try {
    await sendWithRetry(
      client,
      () => client.send(new CreateTableCommand(toCreateTableInput(spec, physicalName))),
      {
        schedule: opts.retry,
        onRetry: () => {
          retried = true;
        },
      },
    );
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: physicalName });
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
    result = 'exists';
    // ONLY when the conflict followed a RETRIED attempt. A plainly
    // pre-existing table takes exactly the path it always took - 'exists', no
    // DescribeTable, no new failure mode - which matters because this is the
    // commonest call in the test suite. A retried attempt is different: the
    // server may have ACCEPTED attempt 1 and lost only its response, so the
    // conflict means "still CREATING", and returning without waiting hands
    // back a table the caller cannot yet write to.
    //
    // KNOWN, PRE-EXISTING, deliberately not fixed here: a genuinely CREATING
    // table that this process did not just create is still reported 'exists'
    // with no wait. That hole predates the retry.
    if (retried) {
      try {
        await pollUntilTableActive(client, physicalName, opts.poll);
      } catch (pollErr) {
        if (!(pollErr instanceof TableNotActiveError)) throw pollErr;
        // Rethrow the ORIGINAL conflict - the poll never saw it - with what we
        // observed appended, so the message names both halves of the story.
        err.message = `${err.message} (${pollErr.message})`;
        throw err;
      }
    }
  }
  // TTL IS A TIME BOMB IN TESTS, so it is opt-OUT-able for them.
  //
  // A test that pins a PAST clock and writes a TTL-bearing row is writing a row
  // that is born already expired, because services derive `expires_at` from
  // their injected clock. DynamoDB Local really does reap, on its own schedule,
  // so the row vanishes mid-test and an assertion about its continued existence
  // fails - intermittently, and only from the date the pinned clock plus the
  // retention window falls behind real time.
  //
  // That is not hypothetical. groupCrossCheck.test.ts pinned 2026-08-11 with a
  // 7-day window, so from 2026-08-18 its dedupe markers were born expired and
  // "a DUPLICATE redelivery is deduped" began failing ~10% of runs - a suite
  // that had been stable for months started rotting on a date, and it was
  // misfiled as container contention for three days.
  // aiRunsRepo.integration.test.ts has the identical fuse set for 2026-11-04.
  //
  // No test anywhere asserts that TTL is ENABLED on a live table (the ai-runs
  // suite asserts the attribute VALUE, which does not need the reaper), so the
  // reaper buys tests nothing and costs them this. It stays ON everywhere else:
  // db:create, e2e lanes and every deployed path leave the flag unset.
  //
  // See docs/issues/npm-test-dynamodb-local-contention.md.
  const ttlDisabled = env['DYNAMO_DISABLE_TTL'] === '1';
  if (spec.ttlAttribute && !ttlDisabled) {
    await enableTtlIfNeeded(client, physicalName, spec.ttlAttribute, opts.retry);
  }
  return result;
}

async function ttlStatus(
  client: DynamoDBClient,
  physicalName: string,
): Promise<string | undefined> {
  const { TimeToLiveDescription: ttl } = await client.send(
    new DescribeTimeToLiveCommand({ TableName: physicalName }),
  );
  return ttl?.TimeToLiveStatus;
}

async function enableTtlIfNeeded(
  client: DynamoDBClient,
  physicalName: string,
  ttlAttribute: string,
  schedule?: RetrySchedule,
): Promise<void> {
  // The PRE-SEND guard is a read, but it is the guard for a mutation in this
  // same function rather than a standalone read, so it is retried like any
  // other send here. The hook invocation below is a DIFFERENT call site and is
  // NOT retried - two sites, not one contradictory rule.
  const status = await sendWithRetry(client, () => ttlStatus(client, physicalName), { schedule });
  if (status === 'ENABLED' || status === 'ENABLING') return;
  await sendWithRetryVerified(
    client,
    () =>
      client.send(
        new UpdateTimeToLiveCommand({
          TableName: physicalName,
          TimeToLiveSpecification: { AttributeName: ttlAttribute, Enabled: true },
        }),
      ),
    // Deliberately does NOT swallow: a re-read that fails must reach the
    // helper's fail-closed branch, because re-sending an enable for a TTL that
    // is already enabled can draw a ValidationException - turning a transient
    // container hiccup into a hard failure.
    async () => {
      const observed = await ttlStatus(client, physicalName);
      return observed === 'ENABLED' || observed === 'ENABLING';
    },
    { schedule },
  );
}

/** Delete a table, tolerating absence (integration-test cleanup). */
export async function deleteTableIfExists(
  client: DynamoDBClient,
  physicalName: string,
  opts: { retry?: RetrySchedule } = {},
): Promise<void> {
  // PER CALL, never module-level - the same rule and the same reason as
  // ensureTable's flag above.
  let retried = false;
  try {
    await sendWithRetry(
      client,
      () => client.send(new DeleteTableCommand({ TableName: physicalName })),
      {
        schedule: opts.retry,
        onRetry: () => {
          retried = true;
        },
      },
    );
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    // ONLY when the conflict followed a RETRIED attempt. Then it can mean
    // attempt 1 landed and only its response was lost, leaving the table
    // DELETING - tolerated for the same reason absence is: the caller asked for
    // the table to be gone, and it is going.
    //
    // An UN-retried conflict is a different animal: the table is in use by
    // somebody else and this call did nothing. Swallowing it would tell the
    // caller the table is gone when it is not - and the commonest caller is a
    // delete-then-create hook, which would then run against the previous run's
    // rows. Every un-retried caller (app/scripts/db-create.ts and ~50 suites)
    // therefore keeps exactly the behaviour it had before the retry existed.
    // Pinned by acceptance cases 4 (retried, tolerated) and 18 (not, thrown).
    if (retried && err instanceof ResourceInUseException) return;
    throw err;
  }
}
