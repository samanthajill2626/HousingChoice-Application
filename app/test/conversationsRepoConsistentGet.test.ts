// conversationsRepo.getByIdConsistent (today-checklist plan ruling PR6)
// against a stub document client (no database): ONE strongly consistent
// GetItem on the conversation's key, answering the raw item exactly as
// getById does. The relay/group writers build their after-loop
// conversation.updated from it (spec 7.3), because two dashboard consumers
// set unread_count straight from that event. DynamoDB Local's acceptance of
// the consistent GetItem, and the harness fake's agreement with the real
// repo, are pinned in caseworkerRepoParity.integration.test.ts.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

function rig(item: Record<string, unknown> | undefined) {
  const sent: unknown[] = [];
  const stub = {
    send: async (command: unknown) => {
      sent.push(command);
      return item === undefined ? {} : { Item: item };
    },
  };
  const logger = createLogger({ destination: createLogCapture().stream });
  const conversations = createConversationsRepo({ doc: stub as never, env: { TABLE_PREFIX: 'hc-test-gbc-' }, logger });
  return { sent, conversations };
}

describe('conversationsRepo.getByIdConsistent (stub client)', () => {
  it('sends ONE GetItem on the key with ConsistentRead true and answers the item', async () => {
    const item = { conversationId: 'conv-1', type: 'relay_group', status: 'open', unread_count: 3 };
    const { sent, conversations } = rig(item);

    await expect(conversations.getByIdConsistent('conv-1')).resolves.toEqual(item);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect((sent[0] as GetCommand).input).toEqual({
      TableName: 'hc-test-gbc-conversations',
      Key: { conversationId: 'conv-1' },
      ConsistentRead: true,
    });
  });

  it('answers undefined when the key holds no item', async () => {
    const { conversations } = rig(undefined);
    await expect(conversations.getByIdConsistent('conv-missing')).resolves.toBeUndefined();
  });

  it('(PIN) getById stays eventually consistent - no ConsistentRead', async () => {
    const { sent, conversations } = rig({ conversationId: 'conv-1' });
    await conversations.getById('conv-1');
    expect((sent[0] as GetCommand).input).toEqual({
      TableName: 'hc-test-gbc-conversations',
      Key: { conversationId: 'conv-1' },
    });
  });
});
