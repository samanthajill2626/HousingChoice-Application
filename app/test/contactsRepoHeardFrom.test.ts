// contactsRepo.touchLastHeardFrom against a stub document client (no
// database): the exact conditional UpdateItem, normalization, the pointer and
// unparseable short-circuits, and the never-throws result mapping (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// section 5.1). The integration suite proves the condition against DynamoDB
// Local.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createContactsRepo, type ContactsRepo } from '../src/repos/contactsRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

describe('contactsRepo.touchLastHeardFrom (stub client)', () => {
  let sent: unknown[];
  let answer: (command: unknown) => Promise<unknown>;
  let capture: LogCapture;
  let contacts: ContactsRepo;

  beforeEach(() => {
    sent = [];
    answer = async () => ({});
    capture = createLogCapture();
    const stub = {
      send: async (command: unknown) => {
        sent.push(command);
        return answer(command);
      },
    };
    const logger = createLogger({ destination: capture.stream, level: 'debug' });
    contacts = createContactsRepo({ doc: stub as never, env: { TABLE_PREFIX: 'hc-test-lhf-' }, logger });
  });

  it("writes the guarded, forward-only UpdateItem and answers 'written'", async () => {
    await expect(contacts.touchLastHeardFrom('contact-a', '2026-09-01T10:00:00.000Z')).resolves.toBe('written');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    expect((sent[0] as UpdateCommand).input).toEqual({
      TableName: 'hc-test-lhf-contacts',
      Key: { contactId: 'contact-a' },
      UpdateExpression: 'SET #lhf = :at',
      ConditionExpression: 'attribute_exists(contactId) AND (attribute_not_exists(#lhf) OR #lhf < :at)',
      ExpressionAttributeNames: { '#lhf': 'last_heard_from_at' },
      ExpressionAttributeValues: { ':at': '2026-09-01T10:00:00.000Z' },
    });
  });

  it('stores the canonical ISO form of an offset instant', async () => {
    await expect(contacts.touchLastHeardFrom('contact-a', '2026-09-01T06:00:00-04:00')).resolves.toBe('written');
    expect(sent).toHaveLength(1);
    const input = (sent[0] as UpdateCommand).input;
    expect(input.ExpressionAttributeValues).toEqual({ ':at': '2026-09-01T10:00:00.000Z' });
  });

  it("refuses an unparseable instant with 'skipped', no write, and a warn line", async () => {
    await expect(contacts.touchLastHeardFrom('contact-a', 'yesterday')).resolves.toBe('skipped');
    expect(sent).toEqual([]);
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    expect(String(warns[0]!['msg'])).toContain('unparseable');
    expect(warns[0]!['contactId']).toBe('contact-a');
  });

  it("answers 'skipped' without a write for a phone or email pointer id", async () => {
    await expect(contacts.touchLastHeardFrom('phoneref#+15550100105', '2026-09-01T10:00:00.000Z')).resolves.toBe(
      'skipped',
    );
    await expect(contacts.touchLastHeardFrom('emailref#a@b.test', '2026-09-01T10:00:00.000Z')).resolves.toBe(
      'skipped',
    );
    expect(sent).toEqual([]);
  });

  it("maps a lost condition (no row, or already as late) to 'skipped'", async () => {
    answer = async () => {
      throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
    };
    await expect(contacts.touchLastHeardFrom('contact-a', '2026-09-01T10:00:00.000Z')).resolves.toBe('skipped');
  });

  it("maps any other error to 'failed' without throwing or logging an error (the CALLER logs)", async () => {
    answer = async () => {
      throw new Error('throttled');
    };
    await expect(contacts.touchLastHeardFrom('contact-a', '2026-09-01T10:00:00.000Z')).resolves.toBe('failed');
    expect(capture.atLevel(50)).toEqual([]);
  });
});
