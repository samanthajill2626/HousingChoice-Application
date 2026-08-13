// listGroupTexts is a LOUD reader (spec 4.2): a failed Query on the group
// partition logs at ERROR and THROWS. It must never degrade to a best-effort
// empty page - an empty page is indistinguishable from "no group threads", and
// the inbox would then silently hide every group conversation.
//
// Pure unit: a stub document client, no DynamoDB Local.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

/** A doc client whose every send() rejects - the "GSI Query failed" shape. */
function failingDoc(err: Error): DynamoDBDocumentClient {
  return {
    send: async () => {
      throw err;
    },
  } as unknown as DynamoDBDocumentClient;
}

describe('listGroupTexts loud-failure contract', () => {
  it('logs at ERROR and rethrows when the group-partition Query fails', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const conversations = createConversationsRepo({
      doc: failingDoc(new Error('dynamo unavailable')),
      env: { TABLE_PREFIX: 'hc-unit-' },
      logger,
    });

    await expect(conversations.listGroupTexts({ limit: 10 })).rejects.toThrowError(
      'dynamo unavailable',
    );

    const errors = capture.atLevel(50);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((l) => String(l['msg']).includes('group text list query failed'))).toBe(true);
  });

  it('rejects a malformed cursor before issuing any query', async () => {
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const conversations = createConversationsRepo({
      doc: failingDoc(new Error('should never be sent')),
      env: { TABLE_PREFIX: 'hc-unit-' },
      logger,
    });

    await expect(conversations.listGroupTexts({ cursor: 'not-base64-json' })).rejects.toThrowError(
      /cursor/i,
    );
  });
});
