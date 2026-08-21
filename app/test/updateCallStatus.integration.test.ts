/**
 * updateCallStatus against REAL DynamoDB Local.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every voice-webhook test drives the FAKE `updateCallStatus` in
 * `app/test/helpers/twilioWebhookHarness.ts`, which hand-mirrors the real
 * repo's forward-only ConditionExpression. Nothing exercised the REAL one, and
 * the consequence was demonstrated with two mutation probes on 2026-08-19:
 *
 *   1. narrowing removed from the FAKE only  -> the suite goes RED
 *   2. narrowing removed from the REAL repo  -> the suite stays GREEN, exit 0
 *
 * Probe 2 is the point. The conditional write that stops a redelivered webhook
 * from terminating a LIVE call could be broken outright and every gate stayed
 * green. The convention that the fake mirrors the real semantics 1:1 is
 * reasonable; it was enforced only by whoever remembered it.
 *
 * So this file pins the real repo against the real service, covering exactly
 * the matrix the ConditionExpression encodes. It is deliberately small: the
 * fake keeps carrying the volume, this proves the thing the fake is imitating.
 *
 * See docs/issues/update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible.md.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createMessagesRepo } from '../src/repos/messagesRepo.js';
import { createLogger } from '../src/lib/logger.js';
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

describe.skipIf(!reachable)('updateCallStatus against DynamoDB Local', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const messages = createMessagesRepo({ doc, env: testEnv, logger });
  const table = tableName('messages', testEnv);

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('messages'), table);
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  /** A fresh ringing call row, returning its CallSid. */
  async function ringingCall(): Promise<string> {
    const callSid = `CA${randomUUID().replace(/-/g, '')}`.slice(0, 34);
    await messages.append({
      conversationId: `conv-${randomUUID().slice(0, 8)}`,
      providerSid: callSid,
      providerTs: '2026-08-21T12:00:00.000Z',
      type: 'call',
      direction: 'inbound',
      author: 'unknown',
      deliveryStatus: 'delivered',
      callStatus: 'ringing',
    });
    return callSid;
  }

  it('commits a FORWARD transition and stamps the lifecycle fields', async () => {
    const callSid = await ringingCall();
    const result = await messages.updateCallStatus(callSid, {
      callStatus: 'in-progress',
      answeredAt: '2026-08-21T12:00:05.000Z',
    });
    expect(result.transitioned).toBe(true);

    const stored = await messages.getByProviderSid(callSid);
    expect(stored?.call_status).toBe('in-progress');
    expect(stored?.answered_at).toBe('2026-08-21T12:00:05.000Z');
  });

  it('REFUSES a regressing transition - a terminal call cannot be reopened', async () => {
    // The whole point of the ConditionExpression: a redelivered or out-of-order
    // callback must never walk a finished call backwards.
    const callSid = await ringingCall();
    expect((await messages.updateCallStatus(callSid, { callStatus: 'completed' })).transitioned).toBe(true);

    const regress = await messages.updateCallStatus(callSid, { callStatus: 'in-progress' });
    expect(regress.transitioned).toBe(false);
    expect((await messages.getByProviderSid(callSid))?.call_status).toBe('completed');
  });

  it('REFUSES a second terminal transition - terminals never regress into each other', async () => {
    const callSid = await ringingCall();
    expect((await messages.updateCallStatus(callSid, { callStatus: 'completed' })).transitioned).toBe(true);

    const second = await messages.updateCallStatus(callSid, { callStatus: 'no-answer' });
    expect(second.transitioned).toBe(false);
    expect((await messages.getByProviderSid(callSid))?.call_status).toBe('completed');
  });

  it('is a no-op for an unknown CallSid', async () => {
    const result = await messages.updateCallStatus(`CA${randomUUID().replace(/-/g, '')}`, {
      callStatus: 'completed',
    });
    expect(result.transitioned).toBe(false);
    expect(result.row).toBeUndefined();
  });

  it('nothing transitions INTO ringing, even from ringing', async () => {
    const callSid = await ringingCall();
    const result = await messages.updateCallStatus(callSid, { callStatus: 'ringing' });
    expect(result.transitioned).toBe(false);
  });

  describe('expectedPriorCallStatuses narrowing - the arm probe 2 proved was unguarded', () => {
    it('COMMITS when the expectation includes the actual prior', async () => {
      const callSid = await ringingCall();
      const result = await messages.updateCallStatus(
        callSid,
        { callStatus: 'completed' },
        { expectedPriorCallStatuses: ['ringing'] },
      );
      expect(result.transitioned).toBe(true);
      expect((await messages.getByProviderSid(callSid))?.call_status).toBe('completed');
    });

    it('REFUSES when the expectation excludes the actual prior', async () => {
      // The row is `ringing`; the caller says it should only commit from
      // `in-progress`. The intersection is empty, so no write may happen - and
      // critically the row must be left ALONE.
      const callSid = await ringingCall();
      const result = await messages.updateCallStatus(
        callSid,
        { callStatus: 'completed' },
        { expectedPriorCallStatuses: ['in-progress'] },
      );
      expect(result.transitioned).toBe(false);
      expect((await messages.getByProviderSid(callSid))?.call_status).toBe('ringing');
    });

    it('narrows rather than widens - it cannot authorise a transition the machine forbids', async () => {
      // `completed` -> `in-progress` is forbidden by the machine. A caller
      // expectation naming `completed` must NOT unlock it: the option
      // intersects the machine's set, it never replaces it.
      const callSid = await ringingCall();
      await messages.updateCallStatus(callSid, { callStatus: 'completed' });

      const result = await messages.updateCallStatus(
        callSid,
        { callStatus: 'in-progress' },
        { expectedPriorCallStatuses: ['completed'] },
      );
      expect(result.transitioned).toBe(false);
      expect((await messages.getByProviderSid(callSid))?.call_status).toBe('completed');
    });
  });
});
