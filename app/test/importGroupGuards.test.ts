// S7 import guards, exercised against a STUB document client.
//
// The claims here are about the exact WIRE SHAPE of the writes - which
// ConditionExpression is attached, and which attributes survive into the retry
// - and those are invisible to a DynamoDB Local run, which only shows the end
// state of a row nothing raced. `runApply` takes its doc client by parameter
// (ApplyOptions.doc), so the whole importer can be driven over a recording stub.
//
// The integration counterpart (importApply.integration.test.ts) proves the same
// guards against a real table.
import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { runApply } from '../src/lib/import/apply.js';
import { runPlan } from '../src/lib/import/plan.js';
import { conversationIdForGroup } from '../src/lib/import/ids.js';
import { parseWorkbook } from '../src/lib/import/workbook.js';
import { PHONES, writeFixture } from './importFixture.js';

const fixture = writeFixture();
const plan = runPlan({ quoDir: fixture.quoDir, airtableDir: fixture.airtableDir });
const importedAt = '2026-08-05T00:00:00.000Z';
const GROUP_ID = conversationIdForGroup([PHONES.groupTenant, PHONES.landlord]);

const cleanReview = (): ReturnType<typeof parseWorkbook> =>
  parseWorkbook({
    contacts: plan.files['contacts.csv'],
    groups: plan.files['groups.csv'],
    units: plan.files['units.csv'],
  });

interface RecordedCommand {
  name: string;
  input: Record<string, unknown>;
}

/** ConditionalCheckFailedException as the AWS SDK surfaces it (name-tagged). */
function ccfe(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/**
 * A recording stub doc client. `onSend` may throw to simulate a losing
 * conditional write; anything it returns is handed back to the importer.
 */
function stubDoc(onSend?: (cmd: RecordedCommand) => unknown): {
  doc: DynamoDBDocumentClient;
  sent: RecordedCommand[];
} {
  const sent: RecordedCommand[] = [];
  const doc = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const recorded = { name: command.constructor.name, input: command.input };
      sent.push(recorded);
      const override = onSend?.(recorded);
      if (override !== undefined) return override;
      if (recorded.name === 'BatchWriteCommand') return { UnprocessedItems: {} };
      if (recorded.name === 'QueryCommand') return { Items: [] };
      return {};
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, sent };
}

/** Every group-conversation UpdateCommand, in order. */
function groupUpdates(sent: RecordedCommand[]): Record<string, unknown>[] {
  return sent
    .filter(
      (c) =>
        c.name === 'UpdateCommand' &&
        (c.input.Key as { conversationId?: string } | undefined)?.conversationId === GROUP_ID,
    )
    .map((c) => c.input);
}

/**
 * Placeholders an UpdateCommand actually references. DynamoDB rejects the whole
 * request when ExpressionAttributeValues carries an unused entry, so a reduced
 * retry that forgets to prune its values is a ValidationException, not a
 * partial success - assert on both directions.
 */
function referencedValues(input: Record<string, unknown>): string[] {
  const expr = `${String(input.UpdateExpression ?? '')} ${String(input.ConditionExpression ?? '')}`;
  return Object.keys((input.ExpressionAttributeValues ?? {}) as Record<string, unknown>).filter(
    (k) => new RegExp(`${k}\\b`).test(expr),
  );
}

describe('import upsertConversation - group_text type guard (T7.1)', () => {
  const reviewWithConnectFlag = (): ReturnType<typeof parseWorkbook> => {
    const review = cleanReview();
    // Force the one attribute that only appears when the founder asked for a
    // day-one connect, so the reduced retry has to prune it too.
    for (const row of review.groups.values()) row.connect_day_one = 'Y';
    return review;
  };

  it('guards the full group upsert on the row not already being a group_text', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: reviewWithConnectFlag(), importedAt });

    const [first] = groupUpdates(sent);
    expect(first).toBeDefined();
    expect(first!.ConditionExpression).toBe(
      'attribute_not_exists(#type) OR #type <> :groupText',
    );
    expect((first!.ExpressionAttributeValues as Record<string, unknown>)[':groupText']).toBe(
      'group_text',
    );
    // The full write is otherwise exactly what it always was.
    const expr = String(first!.UpdateExpression);
    expect(expr).toContain('participants = :participants');
    expect(expr).toContain('relay_status = if_not_exists(relay_status, :relayStatus)');
    expect(expr).toContain('import_connect_requested = :true');
    expect(expr).toContain('imported_from = :importSource');
    expect(expr).toContain('imported_at = :importedAt');
  });

  it('retries with a reduced expression that skips every field a detected thread owns', async () => {
    const { doc, sent } = stubDoc((cmd) => {
      if (
        cmd.name === 'UpdateCommand' &&
        (cmd.input.Key as { conversationId?: string }).conversationId === GROUP_ID &&
        String(cmd.input.ConditionExpression ?? '').includes(':groupText')
      ) {
        throw ccfe();
      }
      return undefined;
    });
    await runApply({ doc, plan, review: reviewWithConnectFlag(), importedAt });

    const updates = groupUpdates(sent);
    // full attempt, reduced retry, then the guarded last_activity_at advance.
    expect(updates).toHaveLength(3);
    const retry = updates[1]!;
    const expr = String(retry.UpdateExpression);

    for (const skipped of [
      'relay_status',
      'participants',
      'import_connect_requested',
      'imported_from',
      'imported_at',
    ]) {
      expect(expr).not.toContain(skipped);
    }
    // last_activity_at survives - it is not `imported_at`.
    expect(expr).toContain('last_activity_at = if_not_exists(last_activity_at, :lastActivity)');
    expect(expr).toContain('#type = if_not_exists(#type, :type)');
    expect(expr).toContain('#status = if_not_exists(#status, :status)');
    expect(expr).toContain('ai_mode = if_not_exists(ai_mode, :aiMode)');
    expect(expr).toContain('created_at = if_not_exists(created_at, :createdAt)');
    // The retry is unconditional: the row IS a group_text, that is the point.
    expect(retry.ConditionExpression).toBeUndefined();
  });

  it('prunes the retry bindings so DynamoDB cannot reject it as unused', async () => {
    const { doc, sent } = stubDoc((cmd) => {
      if (
        cmd.name === 'UpdateCommand' &&
        (cmd.input.Key as { conversationId?: string }).conversationId === GROUP_ID &&
        String(cmd.input.ConditionExpression ?? '').includes(':groupText')
      ) {
        throw ccfe();
      }
      return undefined;
    });
    await runApply({ doc, plan, review: reviewWithConnectFlag(), importedAt });

    const retry = groupUpdates(sent)[1]!;
    const bound = Object.keys(
      (retry.ExpressionAttributeValues ?? {}) as Record<string, unknown>,
    );
    expect(bound.sort()).toEqual(referencedValues(retry).sort());
    expect(bound).not.toContain(':participants');
    expect(bound).not.toContain(':groupText');

    const names = Object.keys(
      (retry.ExpressionAttributeNames ?? {}) as Record<string, unknown>,
    );
    const expr = String(retry.UpdateExpression);
    for (const n of names) expect(expr).toContain(n);
  });

  it('leaves the 1:1 path completely unguarded', async () => {
    const { doc, sent } = stubDoc();
    await runApply({ doc, plan, review: cleanReview(), importedAt });

    const oneToOne = sent.filter(
      (c) =>
        c.name === 'UpdateCommand' &&
        String(c.input.UpdateExpression ?? '').includes('participant_phone = :participantPhone'),
    );
    expect(oneToOne.length).toBeGreaterThan(0);
    for (const c of oneToOne) expect(c.input.ConditionExpression).toBeUndefined();
  });

  it('still rethrows a non-CCFE failure from the group upsert', async () => {
    const { doc } = stubDoc((cmd) => {
      if (
        cmd.name === 'UpdateCommand' &&
        (cmd.input.Key as { conversationId?: string }).conversationId === GROUP_ID
      ) {
        throw new Error('ProvisionedThroughputExceededException');
      }
      return undefined;
    });
    await expect(
      runApply({ doc, plan, review: cleanReview(), importedAt }),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});
