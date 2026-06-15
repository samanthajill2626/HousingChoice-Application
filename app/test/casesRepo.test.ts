// M1.10 fast unit tests: cases repo PURE logic — the stage/deadline allowlists
// and the UpdateExpression construction that the boards/relay/escalation paths
// depend on (null→REMOVE for sparse keys; both-or-neither for the next_deadline
// composite key). Real DynamoDB UpdateExpression SEMANTICS live in
// casesRepo.integration.test.ts (DynamoDB Local); these assert what we BUILD.
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  CASE_DEADLINE_TYPES,
  CASE_STAGES,
  createCasesRepo,
  isCaseDeadlineType,
  isCaseStage,
  TERMINAL_STAGES,
} from '../src/repos/casesRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('case stage + deadline allowlists', () => {
  it('isCaseStage accepts every ladder stage and rejects strays', () => {
    for (const s of CASE_STAGES) expect(isCaseStage(s)).toBe(true);
    expect(isCaseStage('property')).toBe(false); // terminology guard, just in case
    expect(isCaseStage('placed')).toBe(false); // a unit status, NOT a case stage
    expect(isCaseStage('')).toBe(false);
    expect(isCaseStage(undefined)).toBe(false);
    expect(isCaseStage(42)).toBe(false);
  });

  it('the ladder runs interested → … → moved_in | lost, with porting as a branch', () => {
    expect(CASE_STAGES[0]).toBe('interested');
    expect(CASE_STAGES).toContain('porting');
    expect(CASE_STAGES).toContain('rta_submitted');
    expect(TERMINAL_STAGES.has('moved_in')).toBe(true);
    expect(TERMINAL_STAGES.has('lost')).toBe(true);
    expect(TERMINAL_STAGES.has('interested')).toBe(false);
  });

  it('isCaseDeadlineType gates the byNextDeadline partition key', () => {
    for (const t of CASE_DEADLINE_TYPES) expect(isCaseDeadlineType(t)).toBe(true);
    expect(isCaseDeadlineType('whenever')).toBe(false);
    expect(isCaseDeadlineType(null)).toBe(false);
  });
});

/** A fake doc client that records the last command's input for assertion. */
function captureDoc(): { doc: DynamoDBDocumentClient; last: () => UpdateCommand | undefined } {
  let last: UpdateCommand | undefined;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof UpdateCommand) {
        last = cmd;
        return { Attributes: { caseId: 'case-1', ...(cmd.input.Key ?? {}) } };
      }
      throw new Error(`unexpected command: ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, last: () => last };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createCasesRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('casesRepo.update — SET non-null, REMOVE null, skip undefined', () => {
  it('builds a combined SET … REMOVE … expression and always bumps updated_at', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('case-1', {
      stage: 'applied', // SET
      tour_date: null, // REMOVE (clear the sparse byTourDate key)
      attention: null, // REMOVE the escalation flag
      lost_reason: undefined, // skipped entirely
    });
    const cmd = last()!;
    const expr = cmd.input.UpdateExpression!;
    expect(expr).toMatch(/^SET /);
    expect(expr).toContain('REMOVE');
    // updated_at is always set.
    expect(Object.values(cmd.input.ExpressionAttributeNames!)).toContain('updated_at');
    // The two nulls became REMOVEs; the skipped undefined contributed nothing.
    const names = cmd.input.ExpressionAttributeNames!;
    expect(Object.values(names)).toContain('tour_date');
    expect(Object.values(names)).toContain('attention');
    expect(Object.values(names)).not.toContain('lost_reason');
    // Only the SET fields (stage + updated_at) carry values; nulls do not.
    const values = cmd.input.ExpressionAttributeValues!;
    expect(Object.values(values)).toContain('applied');
    expect(Object.values(values)).not.toContain(null);
  });

  it('a patch with no removes emits a plain SET (no dangling REMOVE)', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('case-1', { stage: 'touring' });
    expect(last()!.input.UpdateExpression).not.toContain('REMOVE');
  });

  it('an empty patch still bumps updated_at via a valid SET-only expression', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('case-1', {});
    const expr = last()!.input.UpdateExpression!;
    // Never an empty SET (DynamoDB rejects that) and never a dangling REMOVE.
    expect(expr).toMatch(/^SET /);
    expect(expr).not.toContain('REMOVE');
    expect(Object.values(last()!.input.ExpressionAttributeNames!)).toContain('updated_at');
  });

  it('REFUSES to write the next_deadline composite key (must go through setNextDeadline)', async () => {
    const { doc } = captureDoc();
    const repo = repoWith(doc);
    await expect(repo.update('case-1', { next_deadline_at: '2026-07-01T00:00:00.000Z' })).rejects.toThrow(
      /setNextDeadline/,
    );
    await expect(repo.update('case-1', { next_deadline_type: 'rta_window' })).rejects.toThrow(
      /setNextDeadline/,
    );
  });
});

describe('casesRepo.setNextDeadline — both-or-neither composite key', () => {
  it('SETs both next_deadline attributes together', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).setNextDeadline('case-1', {
      type: 'rta_window',
      at: '2026-06-16T00:00:00.000Z',
    });
    const cmd = last()!;
    // Attributes are expression-aliased (#t/#a); the real names live in
    // ExpressionAttributeNames, and BOTH must be SET (no REMOVE).
    const names = Object.values(cmd.input.ExpressionAttributeNames!);
    expect(names).toContain('next_deadline_type');
    expect(names).toContain('next_deadline_at');
    // Both must be BOUND in the SET clause (not merely declared) — guards
    // against a regression that drops one half of the composite key.
    expect(cmd.input.UpdateExpression).toContain('#t = :t');
    expect(cmd.input.UpdateExpression).toContain('#a = :a');
    expect(cmd.input.UpdateExpression).not.toContain('REMOVE');
    const values = Object.values(cmd.input.ExpressionAttributeValues!);
    expect(values).toContain('rta_window');
    expect(values).toContain('2026-06-16T00:00:00.000Z');
  });

  it('REMOVEs both next_deadline attributes when cleared with null', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).setNextDeadline('case-1', null);
    const cmd = last()!;
    const expr = cmd.input.UpdateExpression!;
    expect(expr).toContain('REMOVE');
    const removed = Object.values(cmd.input.ExpressionAttributeNames!);
    expect(removed).toContain('next_deadline_type');
    expect(removed).toContain('next_deadline_at');
    // Only updated_at is set on a clear — no stray deadline values bound.
    expect(Object.values(cmd.input.ExpressionAttributeValues!)).not.toContain('rta_window');
  });
});
