// Unit test: contactVocabularyRepo.add builds an ADD UpdateExpression that
// ALIASES every attribute name via ExpressionAttributeNames. `roles` is a
// DynamoDB RESERVED keyword, so a bare name in the expression is a runtime
// ValidationException ("Attribute name is a reserved keyword; reserved keyword:
// roles"). The write-path swallows that best-effort, so the bug was silent —
// custom-kind roles/labels never persisted. This guards the alias from regressing.
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createContactVocabularyRepo } from '../src/repos/contactVocabularyRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

/** A fake doc client that records every UpdateCommand for assertion. */
function captureDoc(): { doc: DynamoDBDocumentClient; calls: () => UpdateCommand[] } {
  const calls: UpdateCommand[] = [];
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof UpdateCommand) {
        calls.push(cmd);
        return {};
      }
      throw new Error(`unexpected command: ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, calls: () => calls };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createContactVocabularyRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('contactVocabularyRepo.add — aliases reserved attribute names', () => {
  it('aliases every group via ExpressionAttributeNames (roles is a DynamoDB reserved word)', async () => {
    const { doc, calls } = captureDoc();
    await repoWith(doc).add({
      roles: ['Case worker'],
      relationshipRoles: ['Client'],
      fieldLabels: ['Agency'],
    });
    expect(calls()).toHaveLength(1);
    const input = calls()[0]!.input;
    expect(input.UpdateExpression).toBe('ADD #roles :roles, #rr :rr, #fl :fl');
    expect(input.ExpressionAttributeNames).toEqual({
      '#roles': 'roles',
      '#rr': 'relationshipRoles',
      '#fl': 'fieldLabels',
    });
    // The reserved word must NEVER appear as a bare token in the expression.
    expect(input.UpdateExpression!.split(/[\s,]+/)).not.toContain('roles');
  });

  it('writes only the non-empty groups, and no-ops when all are empty', async () => {
    const { doc, calls } = captureDoc();
    const repo = repoWith(doc);

    await repo.add({ roles: ['X'], relationshipRoles: [], fieldLabels: [] });
    expect(calls()[0]!.input.UpdateExpression).toBe('ADD #roles :roles');
    expect(calls()[0]!.input.ExpressionAttributeNames).toEqual({ '#roles': 'roles' });

    await repo.add({ roles: [], relationshipRoles: [], fieldLabels: [] });
    expect(calls()).toHaveLength(1); // the all-empty add() is a no-op (no second call)
  });
});
