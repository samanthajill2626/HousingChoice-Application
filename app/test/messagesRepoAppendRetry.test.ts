// A send reaches Twilio BEFORE `append` persists it (sendMessage.ts step 3 then
// step 4), so a transaction that dies on a transient DynamoDB concurrency fault
// loses the row for a message the recipient already received. Prod 2026-09-09:
// a missed-call auto-text was delivered, its append threw
// TransactionInProgressException, and the three status callbacks that followed
// found no row. `append` is condition-guarded on `attribute_not_exists(tsMsgId)`
// and its key is derived from the provider result, so re-sending the SAME
// transaction is safe: a landed first attempt loses the condition instead of
// double-writing.
import { TransactionInProgressException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createMessagesRepo, type NewMessage } from '../src/repos/messagesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

function inProgress(): TransactionInProgressException {
  return new TransactionInProgressException({
    message: 'Transaction from previous request is still in progress',
    $metadata: { httpStatusCode: 400 },
  });
}

/** Fails the first `failures` TransactWriteCommand attempts, then succeeds. */
function stubDoc(failures: number): { doc: DynamoDBDocumentClient; attempts: () => number } {
  let attempts = 0;
  const doc = {
    send(command: unknown): Promise<unknown> {
      if (command instanceof TransactWriteCommand) {
        attempts += 1;
        return attempts <= failures ? Promise.reject(inProgress()) : Promise.resolve({});
      }
      return Promise.resolve({});
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, attempts: () => attempts };
}

const message: NewMessage = {
  conversationId: 'conv-append-retry',
  providerSid: `SM${'a'.repeat(32)}`,
  providerTs: '2026-09-09T18:29:19.000Z',
  type: 'sms',
  direction: 'outbound',
  author: 'teammate',
  body: 'courtesy text',
  deliveryStatus: 'queued',
};

function repoWith(doc: DynamoDBDocumentClient, capture = createLogCapture()) {
  return createMessagesRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-append-retry-' },
    logger: createLogger({ destination: capture.stream }),
  });
}

describe('messages append transaction retry', () => {
  it('persists the message when a transaction is still in progress on the first attempt', async () => {
    const { doc, attempts } = stubDoc(1);

    const result = await repoWith(doc).append(message);

    expect(result.deduped).not.toBe(true);
    expect(attempts()).toBe(2);
  });

  it('records a retried attempt so a recovered fault is still countable', async () => {
    const { doc } = stubDoc(1);
    const capture = createLogCapture();

    await repoWith(doc, capture).append(message);

    expect(capture.lines.find((line) => line['event'] === 'message_append_transaction_retry')).toMatchObject({
      level: 40,
      attempt: 1,
      providerSid: message.providerSid,
    });
  });

  it('surfaces the fault when every attempt finds a transaction in progress', async () => {
    const { doc, attempts } = stubDoc(Number.MAX_SAFE_INTEGER);

    await expect(repoWith(doc).append(message)).rejects.toBeInstanceOf(
      TransactionInProgressException,
    );
    expect(attempts()).toBeGreaterThan(1);
  });
});
