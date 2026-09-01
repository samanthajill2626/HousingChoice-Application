// Acceptance suite for the DynamoDB Local control-plane retry in
// src/lib/dynamoAdmin.ts (mission M7 "npm test soundness", spec item 1A).
//
// NO CONTAINER, NO NETWORK. Every case drives a stub client whose `send` is
// scripted per command type, per call. That is deliberate: the retry it proves
// only fires against a LOCAL endpoint under a transient container fault, which
// is exactly the condition a real DynamoDB Local cannot be asked to produce on
// demand. Without this file the whole item could ship inert behind five green
// gates - cases 11 and 12 are what make "the retry did not fire" observable.
//
// Two conventions worth knowing before reading a case:
//
//  - the retry discriminates by `err.name`, while ensureTable /
//    deleteTableIfExists discriminate by `instanceof`. So the stub throws REAL
//    ResourceInUseException / ResourceNotFoundException / InternalServerError
//    instances. `InternalFailure` has NO class anywhere in the SDK, so it is
//    synthesised as an Error carrying that name - which is all the retry reads.
//  - the verification hook re-reads the SAME command type as the pre-send
//    guard (DescribeTimeToLive), so a per-command send counter cannot tell a
//    hook call from a send. Cases 5-10 therefore assert the ORDERED send log,
//    in which a hook read is identified by its POSITION (it falls between two
//    mutation sends). That is strictly more informative than two counters.
//
// hc:dynamo-lane none
//
// Declared for the creates-tables guard in
// app/test/setup/dynamoAccessKeyGuard.test.ts. This file's source names
// ensureTable and CreateTableCommand, which is the guard's cue that a suite
// creates container tables under fixed names - but every one of those names is
// handed to a stub client, so no DynamoDB Local database is ever opened and no
// container table is ever created. Case 13 does construct two REAL
// DynamoDBClients straight from the SDK to pin the endpoint predicate, and
// never sends through either; that is the SDK constructor, not
// src/lib/dynamo.js's factory, so the marker's rot-proof check (a `none` suite
// must not import the container-reaching factory) holds.
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  InternalServerError,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { ensureGsis } from '../scripts/db-update-gsis.js';
import { tableName } from '../src/lib/config.js';
import {
  deleteTableIfExists,
  ensureTable,
  isLocalDynamoEndpoint,
  pollUntilTableActive,
  TableNotActiveError,
} from '../src/lib/dynamoAdmin.js';
import { getTableSpec, type TableSpec } from '../src/lib/tables.js';

// --- the stub client --------------------------------------------------------

/**
 * One scripted answer. `delayMs` makes the send TAKE that long before it
 * answers - the only way to script the two things a send counter cannot show:
 * an ORDERING between two concurrent calls (case 20) and an ELAPSED-TIME
 * budget (case 21).
 */
type Step = ({ ok: unknown } | { fail: unknown }) & { delayMs?: number };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface StubEndpoint {
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
}

type CommandName =
  | 'CreateTable'
  | 'DeleteTable'
  | 'DescribeTable'
  | 'DescribeTimeToLive'
  | 'UpdateTable'
  | 'UpdateTimeToLive';

/** instanceof, not constructor.name - a bundler may rename the class. */
function commandName(command: unknown): CommandName {
  if (command instanceof CreateTableCommand) return 'CreateTable';
  if (command instanceof DeleteTableCommand) return 'DeleteTable';
  if (command instanceof DescribeTableCommand) return 'DescribeTable';
  if (command instanceof DescribeTimeToLiveCommand) return 'DescribeTimeToLive';
  if (command instanceof UpdateTableCommand) return 'UpdateTable';
  if (command instanceof UpdateTimeToLiveCommand) return 'UpdateTimeToLive';
  throw new Error(`stub client: unscripted command ${String(command)}`);
}

function tableDescription(
  status: string,
  indexes: Array<{ IndexName: string; IndexStatus: string }> = [],
): unknown {
  return { Table: { TableName: 'stub', TableStatus: status, GlobalSecondaryIndexes: indexes } };
}

const LOCAL_ENDPOINT: StubEndpoint = {
  protocol: 'http:',
  hostname: 'localhost',
  port: 8000,
  path: '/',
};

class StubClient {
  /** Every command this client was asked to send, in ISSUE order. */
  readonly sent: CommandName[] = [];

  config: { endpoint?: () => Promise<StubEndpoint> } = {
    endpoint: async () => LOCAL_ENDPOINT,
  };

  /** Shared ACROSS clients when set - see recordInto. */
  private timeline: string[] | undefined;

  private label = 'stub';

  private readonly scripts = new Map<CommandName, Step[]>();

  private readonly defaults = new Map<CommandName, Step>([
    ['CreateTable', { ok: {} }],
    ['DeleteTable', { ok: {} }],
    ['UpdateTable', { ok: {} }],
    ['UpdateTimeToLive', { ok: {} }],
    ['DescribeTimeToLive', { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } }],
    ['DescribeTable', { ok: tableDescription('ACTIVE') }],
  ]);

  /** An ordered script for one command type; consumed before the default. */
  script(command: CommandName, steps: Step[]): this {
    this.scripts.set(command, [...steps]);
    return this;
  }

  /** What this command answers once its script (if any) runs out. */
  fallback(command: CommandName, step: Step): this {
    this.defaults.set(command, step);
    return this;
  }

  /**
   * Record this client's sends into a log SHARED with other clients, as
   * `<label>:<CommandName>`. Two per-client counters can say how often each was
   * called but never in what ORDER relative to each other, and an ordering is
   * the whole content of case 20.
   *
   * The shared log records when a send ANSWERS, not when it is issued: what
   * decides whether a concurrent caller could inherit another call's state is
   * where its catch block runs, and a delayed send is issued long before that.
   * `sent` (and therefore count()) keeps issue order and is unaffected.
   */
  recordInto(timeline: string[], label: string): this {
    this.timeline = timeline;
    this.label = label;
    return this;
  }

  endpointHostname(hostname: string): this {
    this.config.endpoint = async () => ({ ...LOCAL_ENDPOINT, hostname });
    return this;
  }

  noEndpoint(): this {
    this.config = {};
    return this;
  }

  throwingEndpoint(): this {
    this.config.endpoint = async () => {
      throw new Error('endpoint provider blew up');
    };
    return this;
  }

  count(command: CommandName): number {
    return this.sent.filter((name) => name === command).length;
  }

  /** The TTL conversation alone: mutation sends interleaved with hook re-reads. */
  ttlLog(): CommandName[] {
    return this.sent.filter(
      (name) => name === 'DescribeTimeToLive' || name === 'UpdateTimeToLive',
    );
  }

  asClient(): DynamoDBClient {
    return this as unknown as DynamoDBClient;
  }

  async send(command: unknown): Promise<unknown> {
    const name = commandName(command);
    this.sent.push(name);
    const queue = this.scripts.get(name);
    const step = (queue && queue.length > 0 ? queue.shift() : undefined) ?? this.defaults.get(name);
    if (!step) throw new Error(`stub client: no response configured for ${name}`);
    if (step.delayMs !== undefined) await delay(step.delayMs);
    this.timeline?.push(`${this.label}:${name}`);
    if ('fail' in step) throw step.fail;
    return step.ok;
  }
}

// --- error factories --------------------------------------------------------

/**
 * DynamoDB Local's own wording. There is NO InternalFailure class in the AWS
 * SDK (verified against @aws-sdk/client-dynamodb 3.1070.0), so the only thing
 * a caller can match on is the name - which is what the retry matches on.
 */
function internalFailure(): Error {
  return Object.assign(
    new Error('The request processing has failed because of an unknown error, exception or failure.'),
    { name: 'InternalFailure' },
  );
}

/** The container's per-table tryLock(10s) expiring. A REAL SDK class. */
function lockTimeout(): InternalServerError {
  return new InternalServerError({
    $metadata: {},
    message: 'This action timed out because it took too long waiting for a lock',
  });
}

function resourceInUse(): ResourceInUseException {
  return new ResourceInUseException({
    $metadata: {},
    message: 'Table already exists: stub',
  });
}

/** What DescribeTable answers once the table really is gone. A REAL SDK class. */
function resourceNotFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    $metadata: {},
    message: 'Requested resource not found: Table: stub not found',
  });
}

// --- shared fixtures --------------------------------------------------------

/** No backoff: this file must not spend ~4-5s in real setTimeout. */
const FAST = { backoffMs: (): number => 0 };
const NO_TTL = getTableSpec('contacts'); // no ttlAttribute
const TTL_SPEC = getTableSpec('messages'); // ttlAttribute: expires_at, zero GSIs
const LIVE_ENV = {}; // DYNAMO_DISABLE_TTL unset, so the TTL path is reachable

const ONE_GSI_SPEC: TableSpec = {
  baseName: 'stubgsi',
  hashKey: { name: 'id', type: 'S' },
  gsis: [{ indexName: 'byThing', hashKey: { name: 'thing', type: 'S' } }],
};
const ONE_GSI_TABLE = tableName(ONE_GSI_SPEC.baseName, LIVE_ENV);
const INDEX_ACTIVE = tableDescription('ACTIVE', [
  { IndexName: 'byThing', IndexStatus: 'ACTIVE' },
]);
const INDEX_ABSENT = tableDescription('ACTIVE');
const silent = (): void => undefined;

// ----------------------------------------------------------------------------

describe('dynamoAdmin control-plane retry (DynamoDB Local InternalFailure)', () => {
  it('case 1: CreateTable retries a transient InternalFailure twice and then succeeds', async () => {
    const stub = new StubClient().script('CreateTable', [
      { fail: internalFailure() },
      { fail: internalFailure() },
      { ok: {} },
    ]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    expect(stub.count('CreateTable')).toBe(3);
  });

  it('case 2: an accepted-but-unanswered CreateTable polls until the table is ACTIVE', async () => {
    const stub = new StubClient()
      .script('CreateTable', [{ fail: internalFailure() }, { fail: resourceInUse() }])
      .script('DescribeTable', [
        { ok: tableDescription('CREATING') },
        { ok: tableDescription('CREATING') },
        { ok: tableDescription('ACTIVE') },
      ]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, {
        retry: FAST,
        poll: { intervalMs: 1, ceilingMs: 5_000 },
      }),
    ).resolves.toBe('exists');
    expect(stub.count('CreateTable')).toBe(2);
    expect(stub.count('DescribeTable')).toBe(3);
  });

  it('case 3: a plainly pre-existing table returns exists with ZERO DescribeTable calls', async () => {
    const stub = new StubClient().script('CreateTable', [{ fail: resourceInUse() }]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('exists');
    expect(stub.count('CreateTable')).toBe(1);
    expect(stub.count('DescribeTable')).toBe(0);
  });

  it('case 4: DeleteTable retries, then tolerates ResourceInUseException (DELETING landed)', async () => {
    // The delete already completed by the time the conflict is handled, so the
    // wait costs exactly ONE read. Case 23 is the same tolerance over a table
    // that is still DELETING for two reads first.
    const stub = new StubClient()
      .script('DeleteTable', [{ fail: internalFailure() }, { fail: resourceInUse() }])
      .script('DescribeTable', [{ fail: resourceNotFound() }]);

    await expect(
      deleteTableIfExists(stub.asClient(), 'stub', {
        retry: FAST,
        poll: { intervalMs: 1, ceilingMs: 5_000 },
      }),
    ).resolves.toBeUndefined();
    expect(stub.count('DeleteTable')).toBe(2);
    expect(stub.count('DescribeTable')).toBe(1);
  });

  it('case 5: UpdateTimeToLive re-reads status between attempts before re-sending', async () => {
    const stub = new StubClient().script('UpdateTimeToLive', [
      { fail: internalFailure() },
      { ok: {} },
    ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    expect(stub.ttlLog()).toEqual([
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
      'UpdateTimeToLive',
    ]);
  });

  it('case 6: a re-read reporting ENABLED ends the retry with NO re-send', async () => {
    const stub = new StubClient()
      .script('UpdateTimeToLive', [{ fail: internalFailure() }])
      .script('DescribeTimeToLive', [
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED' } } },
      ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    expect(stub.count('UpdateTimeToLive')).toBe(1);
    expect(stub.ttlLog()).toEqual([
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
    ]);
  });

  it('case 7: a re-read that THROWS rethrows the ORIGINAL error and does not re-send', async () => {
    const stub = new StubClient()
      .script('UpdateTimeToLive', [{ fail: internalFailure() }])
      .script('DescribeTimeToLive', [
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { fail: new Error('the verification read itself failed') },
      ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).rejects.toMatchObject({ name: 'InternalFailure' });
    expect(stub.count('UpdateTimeToLive')).toBe(1);
  });

  it('case 8: the InternalServerError lock-timeout signature is retried identically', async () => {
    const stub = new StubClient().script('CreateTable', [{ fail: lockTimeout() }, { ok: {} }]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    expect(stub.count('CreateTable')).toBe(2);
  });

  it('case 9: the PRE-SEND DescribeTimeToLive guard is itself retried', async () => {
    const stub = new StubClient().script('DescribeTimeToLive', [
      { fail: internalFailure() },
      { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
    ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    expect(stub.ttlLog()).toEqual([
      'DescribeTimeToLive',
      'DescribeTimeToLive',
      'UpdateTimeToLive',
    ]);
  });

  it('case 10: the bound is 4 sends and the hook runs 4 times, including the final attempt', async () => {
    // The attempt bound stops RE-SENDS, not the "did it land?" read. The final
    // failed attempt is exactly as likely to have been ACCEPTED as any other -
    // the same argument the deadline makes in case 22 - so it gets its read
    // too, and the interleave therefore ENDS on a DescribeTimeToLive.
    const stub = new StubClient().fallback('UpdateTimeToLive', { fail: internalFailure() });

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).rejects.toMatchObject({ name: 'InternalFailure' });
    expect(stub.count('UpdateTimeToLive')).toBe(4);
    expect(stub.ttlLog()).toEqual([
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
      'UpdateTimeToLive',
      'DescribeTimeToLive',
    ]);
  });

  it('case 11: a NON-LOCAL endpoint gets today behaviour - one send, error propagates', async () => {
    const stub = new StubClient()
      .endpointHostname('dynamodb.us-east-1.amazonaws.com')
      .script('CreateTable', [{ fail: internalFailure() }, { ok: {} }]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, { retry: FAST }),
    ).rejects.toMatchObject({ name: 'InternalFailure' });
    expect(stub.count('CreateTable')).toBe(1);
  });

  it('case 12: NO endpoint provider fails closed the same way', async () => {
    const stub = new StubClient()
      .noEndpoint()
      .script('CreateTable', [{ fail: internalFailure() }, { ok: {} }]);

    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, { retry: FAST }),
    ).rejects.toMatchObject({ name: 'InternalFailure' });
    expect(stub.count('CreateTable')).toBe(1);
  });

  it('case 13: the predicate reads a REAL DynamoDBClient config.endpoint correctly', async () => {
    const local = new DynamoDBClient({ region: 'us-east-1', endpoint: 'http://localhost:8000' });
    const remote = new DynamoDBClient({ region: 'us-east-1' });
    try {
      await expect(isLocalDynamoEndpoint(local)).resolves.toBe(true);
      await expect(isLocalDynamoEndpoint(remote)).resolves.toBe(false);
    } finally {
      local.destroy();
      remote.destroy();
    }
  });

  it('case 14: localhost, 127.0.0.1, ::1 and [::1] are local; everything else is not', async () => {
    for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      const stub = new StubClient().endpointHostname(hostname);
      await expect(isLocalDynamoEndpoint(stub.asClient())).resolves.toBe(true);
    }
    for (const hostname of ['dynamodb.us-east-1.amazonaws.com', '10.0.0.5', 'localhost.evil.com']) {
      const stub = new StubClient().endpointHostname(hostname);
      await expect(isLocalDynamoEndpoint(stub.asClient())).resolves.toBe(false);
    }
    await expect(isLocalDynamoEndpoint(new StubClient().noEndpoint().asClient())).resolves.toBe(
      false,
    );
    await expect(
      isLocalDynamoEndpoint(new StubClient().throwingEndpoint().asClient()),
    ).resolves.toBe(false);
  });

  it('case 15: ensureGsis still retries UpdateTable after the move to the shared helper', async () => {
    const stub = new StubClient()
      .script('UpdateTable', [{ fail: internalFailure() }, { ok: {} }])
      // 1st read: liveIndexNames (index absent). 2nd: the verification re-read,
      // still absent, so attempt 1 did NOT land and a re-send is required.
      .script('DescribeTable', [{ ok: INDEX_ABSENT }, { ok: INDEX_ABSENT }])
      .fallback('DescribeTable', { ok: INDEX_ACTIVE });

    const result = await ensureGsis(stub.asClient(), [ONE_GSI_SPEC], LIVE_ENV, silent, {
      retry: FAST,
    });

    expect(stub.count('UpdateTable')).toBe(2);
    expect(result.added).toEqual([`${ONE_GSI_TABLE}.byThing`]);
  });

  it('case 16: ensureGsis stays FAIL-OPEN when its verification read throws', async () => {
    const stub = new StubClient()
      .script('UpdateTable', [{ fail: internalFailure() }, { ok: {} }])
      // The verification read THROWS. indexStatus swallows it and answers
      // `undefined`, so the hook returns false and the re-send happens - the
      // caller-side tolerance survived the move to a fail-closed helper.
      .script('DescribeTable', [
        { ok: INDEX_ABSENT },
        { fail: new Error('describe failed mid-retry') },
      ])
      .fallback('DescribeTable', { ok: INDEX_ACTIVE });

    const result = await ensureGsis(stub.asClient(), [ONE_GSI_SPEC], LIVE_ENV, silent, {
      retry: FAST,
    });

    expect(stub.count('UpdateTable')).toBe(2);
    expect(result.added).toEqual([`${ONE_GSI_TABLE}.byThing`]);
  });

  it('case 17: the ACTIVE poll throws its OWN error at the ceiling, naming table and status', async () => {
    const stub = new StubClient().fallback('DescribeTable', { ok: tableDescription('CREATING') });

    const failure = await pollUntilTableActive(stub.asClient(), 'stub-table', {
      intervalMs: 1,
      ceilingMs: 25,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(TableNotActiveError);
    expect((failure as TableNotActiveError).message).toContain('stub-table');
    expect((failure as TableNotActiveError).message).toContain('CREATING');
    expect((failure as TableNotActiveError).observedStatus).toBe('CREATING');
    expect(stub.count('DescribeTable')).toBeGreaterThan(0);
  });

  it('case 18: an UN-RETRIED ResourceInUseException on DeleteTable still throws', async () => {
    // The counterpart to case 4, and the case that gives case 4 its meaning.
    // deleteTableIfExists tolerates a conflict ONLY where it could mean "attempt
    // 1 landed and we lost its response" - i.e. after a retry. On the very first
    // attempt the table really is in use by somebody else, and swallowing that
    // would hand the caller a table it believes is gone: the delete-then-create
    // hooks (importApply.integration.test.ts and ~50 siblings) would then run
    // against the previous run's rows instead of failing loudly.
    const conflict = resourceInUse();
    const stub = new StubClient().script('DeleteTable', [{ fail: conflict }]);

    await expect(deleteTableIfExists(stub.asClient(), 'stub', { retry: FAST })).rejects.toBe(
      conflict,
    );
    expect(stub.count('DeleteTable')).toBe(1);
  });

  it('case 19: a retried conflict on a table that never goes ACTIVE rethrows the CONFLICT', async () => {
    // The ensureTable half of the exhaustion split. Case 17 pins what
    // pollUntilTableActive throws on its own; this pins what the CALLER throws,
    // which is deliberately not that. The conflict is the fact the operator
    // needs (the table exists and is not ours to create), and the poll's
    // observation is appended to it rather than replacing it - so a caller
    // catching ResourceInUseException, as the delete-then-create hooks do,
    // still sees the error it is written against.
    const stub = new StubClient()
      .script('CreateTable', [{ fail: internalFailure() }, { fail: resourceInUse() }])
      .fallback('DescribeTable', { ok: tableDescription('CREATING') });

    const failure = await ensureTable(stub.asClient(), NO_TTL, 'stub-c19', LIVE_ENV, {
      retry: FAST,
      poll: { intervalMs: 1, ceilingMs: 20 },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(ResourceInUseException);
    expect(failure).not.toBeInstanceOf(TableNotActiveError);
    // Both halves of the story: the conflict, and what the poll actually saw.
    expect((failure as Error).message).toContain('stub-c19');
    expect((failure as Error).message).toContain('CREATING');
  });

  it('case 20: a CONCURRENT plain conflict does not inherit the retried call flag', async () => {
    // `retried` is per call, and only a stub can prove it. Two ensureTable calls
    // overlap: A retries and then meets a conflict (so it must poll), while B
    // meets a plainly pre-existing table with no retry at all (so it must not).
    // B's single send is DELAYED past A's retry, so a module-level flag set by A
    // would already be true when B's conflict is handled - and B would poll.
    // Every sequential test in this file would still pass under that defect.
    //
    // The outcome assertions below are only worth what the INTERLEAVING is
    // worth: if B's delayed send ever answered before A's retry fired, the case
    // would pass without exercising the per-call flag at all and nobody would
    // be told. One shared answer-ordered timeline pins it.
    const timeline: string[] = [];
    const retriedStub = new StubClient()
      .recordInto(timeline, 'retried')
      .script('CreateTable', [{ fail: internalFailure() }, { fail: resourceInUse() }]);
    const plainStub = new StubClient()
      .recordInto(timeline, 'plain')
      .script('CreateTable', [{ fail: resourceInUse(), delayMs: 25 }]);

    const [a, b] = await Promise.all([
      ensureTable(retriedStub.asClient(), NO_TTL, 'stub-a', LIVE_ENV, {
        retry: FAST,
        poll: { intervalMs: 1, ceilingMs: 5_000 },
      }),
      ensureTable(plainStub.asClient(), NO_TTL, 'stub-b', LIVE_ENV, { retry: FAST }),
    ]);

    expect(a).toBe('exists');
    expect(b).toBe('exists');
    expect(retriedStub.count('CreateTable')).toBe(2);
    expect(retriedStub.count('DescribeTable')).toBeGreaterThanOrEqual(1);
    expect(plainStub.count('CreateTable')).toBe(1);
    expect(plainStub.count('DescribeTable')).toBe(0);

    // B's conflict was handled AFTER A had already retried - the only ordering
    // under which a module-level flag would have been set when B's catch ran.
    const retriedFirst = timeline.indexOf('retried:CreateTable');
    const retriedSecond = timeline.indexOf('retried:CreateTable', retriedFirst + 1);
    const plainFirst = timeline.indexOf('plain:CreateTable');
    expect(retriedSecond, `timeline: ${timeline.join(', ')}`).toBeGreaterThan(-1);
    expect(plainFirst, `timeline: ${timeline.join(', ')}`).toBeGreaterThan(retriedSecond);
  });

  it('case 21: the retry stops at its ELAPSED-TIME deadline, not just the attempt bound', async () => {
    // The attempt bound alone is not a budget. The lock-timeout signature costs
    // ~10s per attempt by the retry's own account, so four attempts can spend
    // ~41.5s inside a 60s hook that loops the whole 22-table manifest - and the
    // failure the caller then sees is "Hook timed out in 60000ms", which names
    // nothing.
    //
    // SCRIPTED TO BE DETERMINISTIC IN BOTH DIRECTIONS, so the count is an
    // EQUALITY rather than a ratio. The deadline is read only in the catch,
    // never during a send:
    //   it cannot fire early - send 1 completes at ~5ms, which is nowhere near
    //     the 2000ms budget no matter how loaded the worker is;
    //   it cannot fail to fire - send 2 alone takes 2500ms, so elapsed is
    //     >= 2505 > 2000 when its catch runs, on any machine.
    // The attempt bound is lifted to 12 so it can never be the thing that
    // stopped the loop: remove the deadline and this stub answers 12 sends.
    const fault = internalFailure();
    const stub = new StubClient()
      .script('CreateTable', [
        { fail: fault, delayMs: 5 },
        { fail: fault, delayMs: 2_500 },
      ])
      // Fast and DIFFERENT: a third send would both break the count below and
      // reject with an error that is not `fault`.
      .fallback('CreateTable', { fail: internalFailure() });

    // The ORIGINAL container fault, by identity - not a deadline error of the
    // retry's own invention.
    await expect(
      ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, {
        retry: { attempts: 12, backoffMs: (): number => 0, deadlineMs: 2_000 },
      }),
    ).rejects.toBe(fault);

    expect(stub.count('CreateTable')).toBe(2);
  });

  it('case 22: an EXPIRED deadline still asks the hook whether the mutation landed', async () => {
    // The deadline stops RE-SENDS; it must never stop the "did it land?" read.
    // The hazard is the one the whole module exists to remove: the server
    // ACCEPTS the mutation and only its RESPONSE fails, so a bare throw reports
    // a run whose mutation SUCCEEDED as failed. The deadline reaches that blind
    // spot EARLIER than the attempt bound (it can fire on attempt 2 of 4) and
    // preferentially on the ~10s lock-timeout signature - the fault where the
    // server spent the most work and is therefore the most likely to have
    // accepted. The hook is one cheap read and cannot loop, so nothing is saved
    // by skipping it.
    //
    // Here the deadline (1ms) is already blown by the 30ms attempt when the
    // catch runs, and the re-read reports ENABLED. Exactly one UpdateTimeToLive
    // (no re-send) and exactly two DescribeTimeToLive (the pre-send guard, then
    // the hook) is what says the hook RAN despite the expiry.
    const stub = new StubClient()
      .script('UpdateTimeToLive', [{ fail: internalFailure(), delayMs: 30 }])
      .script('DescribeTimeToLive', [
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED' } } },
      ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, {
        retry: { backoffMs: (): number => 0, deadlineMs: 1 },
      }),
    ).resolves.toBe('created');
    expect(stub.count('UpdateTimeToLive')).toBe(1);
    expect(stub.count('DescribeTimeToLive')).toBe(2);
  });

  it('case 23: a retried DeleteTable conflict WAITS for the table to actually be gone', async () => {
    // The mirror of case 2, and the reason it has to exist: the commonest
    // caller of deleteTableIfExists is a delete-then-create hook
    // (importApply.integration.test.ts and ~50 siblings), which re-creates the
    // SAME name on the next line. Tolerating a retried conflict without
    // waiting hands that caller a name that is still DELETING, and the create
    // that follows draws its own conflict.
    const stub = new StubClient()
      .script('DeleteTable', [{ fail: internalFailure() }, { fail: resourceInUse() }])
      .script('DescribeTable', [
        { ok: tableDescription('DELETING') },
        { ok: tableDescription('DELETING') },
        { fail: resourceNotFound() },
      ]);

    await expect(
      deleteTableIfExists(stub.asClient(), 'stub', {
        retry: FAST,
        poll: { intervalMs: 1, ceilingMs: 5_000 },
      }),
    ).resolves.toBeUndefined();
    expect(stub.count('DeleteTable')).toBe(2);
    // ResourceNotFoundException from DescribeTable is the ONLY proof of gone.
    expect(stub.count('DescribeTable')).toBe(3);
  });

  it('case 24: a retried conflict on a table that never goes rethrows the CONFLICT', async () => {
    // The delete half of the exhaustion split, matching case 19 exactly: the
    // caller sees the ORIGINAL ResourceInUseException instance with the poll's
    // observation appended, never a poll error of the helper's own invention.
    const conflict = resourceInUse();
    const stub = new StubClient()
      .script('DeleteTable', [{ fail: internalFailure() }, { fail: conflict }])
      .fallback('DescribeTable', { ok: tableDescription('DELETING') });

    const failure = await deleteTableIfExists(stub.asClient(), 'stub-c24', {
      retry: FAST,
      poll: { intervalMs: 1, ceilingMs: 20 },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBe(conflict);
    expect(failure).toBeInstanceOf(ResourceInUseException);
    expect((failure as Error).message).toContain('stub-c24');
    expect((failure as Error).message).toContain('DELETING');
  });

  it('case 25: a mutation that lands on the FINAL attempt is reported as success', async () => {
    // The blind spot the attempt bound had, and the exact mirror of case 22's
    // deadline argument: attempt 4 is the last one, but the server is no less
    // likely to have ACCEPTED it and lost only the response. Reading the bound
    // first would report a TTL that IS enabled as a failure - the one outcome
    // this module exists to remove.
    //
    // Five DescribeTimeToLive answers: the pre-send guard, then one hook read
    // per failed attempt, the LAST of which sees the enable that landed.
    const stub = new StubClient()
      .fallback('UpdateTimeToLive', { fail: internalFailure() })
      .script('DescribeTimeToLive', [
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } } },
        { ok: { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED' } } },
      ]);

    await expect(
      ensureTable(stub.asClient(), TTL_SPEC, 'stub', LIVE_ENV, { retry: FAST }),
    ).resolves.toBe('created');
    // Four sends: the bound was still honoured, it just did not pre-empt the read.
    expect(stub.count('UpdateTimeToLive')).toBe(4);
    expect(stub.count('DescribeTimeToLive')).toBe(5);
  });
});
