// M1.10 fast unit tests: placements repo PURE logic — the stage/deadline
// allowlists and the UpdateExpression construction that the boards/relay/
// escalation paths depend on (null→REMOVE for sparse keys). Real DynamoDB
// UpdateExpression SEMANTICS live in placementsRepo.integration.test.ts
// (DynamoDB Local); these assert what we BUILD.
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  PLACEMENT_DEADLINE_TYPES,
  createPlacementsRepo,
  isPlacementDeadlineType,
  TERMINAL_STAGES,
} from '../src/repos/placementsRepo.js';
import { PLACEMENT_STAGES, isPlacementStage } from '../src/lib/statusModel.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('placement stage + deadline allowlists', () => {
  it('isPlacementStage accepts every ladder stage and rejects strays', () => {
    for (const s of PLACEMENT_STAGES) expect(isPlacementStage(s)).toBe(true);
    expect(isPlacementStage('property')).toBe(false); // terminology guard, just in case
    expect(isPlacementStage('placed')).toBe(false); // a tenant status, NOT a placement stage
    expect(isPlacementStage('touring')).toBe(false); // legacy stage gone
    expect(isPlacementStage('')).toBe(false);
    expect(isPlacementStage(undefined)).toBe(false);
    expect(isPlacementStage(42)).toBe(false);
  });

  it('the placement ladder runs send_application → … → moved_in | lost', () => {
    expect(PLACEMENT_STAGES[0]).toBe('send_application');
    expect(PLACEMENT_STAGES).toContain('awaiting_authority_approval');
    expect(PLACEMENT_STAGES).toContain('awaiting_hap_contract');
    expect(TERMINAL_STAGES.has('moved_in')).toBe(true);
    expect(TERMINAL_STAGES.has('lost')).toBe(true);
    expect(TERMINAL_STAGES.has('send_application')).toBe(false);
  });

  it('isPlacementDeadlineType gates the live deadline types (retired ones rejected)', () => {
    for (const t of PLACEMENT_DEADLINE_TYPES) expect(isPlacementDeadlineType(t)).toBe(true);
    expect(PLACEMENT_DEADLINE_TYPES).toEqual(['rta_window', 'voucher_expiration', 'follow_up']);
    // Retired types are no longer valid deadline types.
    expect(isPlacementDeadlineType('tour_reminder')).toBe(false);
    expect(isPlacementDeadlineType('stuck_placement')).toBe(false);
    expect(isPlacementDeadlineType('whenever')).toBe(false);
    expect(isPlacementDeadlineType(null)).toBe(false);
  });
});

/** A fake doc client that records the last command's input for assertion. */
function captureDoc(): { doc: DynamoDBDocumentClient; last: () => UpdateCommand | undefined } {
  let last: UpdateCommand | undefined;
  const doc = {
    send: async (cmd: unknown) => {
      if (cmd instanceof UpdateCommand) {
        last = cmd;
        return { Attributes: { placementId: 'placement-1', ...(cmd.input.Key ?? {}) } };
      }
      throw new Error(`unexpected command: ${String(cmd)}`);
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, last: () => last };
}

function repoWith(doc: DynamoDBDocumentClient) {
  return createPlacementsRepo({
    doc,
    env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv,
    logger: createLogger({ destination: createLogCapture().stream }),
  });
}

describe('placementsRepo.update — SET non-null, REMOVE null, skip undefined', () => {
  it('builds a combined SET … REMOVE … expression and always bumps updated_at', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('placement-1', {
      stage: 'awaiting_approval', // SET
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
    expect(Object.values(values)).toContain('awaiting_approval');
    expect(Object.values(values)).not.toContain(null);
  });

  it('a patch with no removes emits a plain SET (no dangling REMOVE)', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('placement-1', { stage: 'awaiting_inspection' });
    expect(last()!.input.UpdateExpression).not.toContain('REMOVE');
  });

  it('an empty patch still bumps updated_at via a valid SET-only expression', async () => {
    const { doc, last } = captureDoc();
    await repoWith(doc).update('placement-1', {});
    const expr = last()!.input.UpdateExpression!;
    // Never an empty SET (DynamoDB rejects that) and never a dangling REMOVE.
    expect(expr).toMatch(/^SET /);
    expect(expr).not.toContain('REMOVE');
    expect(Object.values(last()!.input.ExpressionAttributeNames!)).toContain('updated_at');
  });

  // NOTE: the next_deadline composite slot + setNextDeadline are RETIRED
  // (placement-deadline-model): deadlines are first-class placementDeadlines
  // items now. See placementDeadlinesRepo.test.ts for their arm/retire/soonest
  // semantics; update() has no special-cased deadline keys any more.
});
