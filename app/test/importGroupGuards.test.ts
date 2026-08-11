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
import { GROUP_TEXT_STATUS } from '../src/repos/conversationsRepo.js';
import { contactIdForPhone } from '../src/lib/import/ids.js';
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

  it('a workbook `drop` NEVER truncates a GROUP roster - it is reported instead', async () => {
    // A group thread's IDENTITY IS ITS FULL SORTED ROSTER, so a roster written
    // with one member filtered out cannot describe its own thread: conversion
    // refuses it (`roster_id_mismatch`), the runtime inline auto-convert refuses
    // it through the same precondition, and every inbound to that carrier group
    // scatters into 1:1s with an ERROR. This line was the only known PRODUCER of
    // that state, and it contradicted the policy the same file already enforces
    // in `retractImported` (a dropped contact on a group roster is KEPT).
    const review = cleanReview();
    for (const row of review.contacts.values()) {
      if (row.phone === PHONES.groupTenant) row.drop = 'Y';
    }
    const { doc, sent } = stubDoc();

    const report = await runApply({ doc, plan, review, importedAt });

    const participants = groupUpdates(sent)[0]!.ExpressionAttributeValues as Record<
      string,
      { contactId: string; phone: string }[]
    >;
    expect(participants[':participants']!.map((p) => p.phone).sort()).toEqual(
      [PHONES.groupTenant, PHONES.landlord].sort(),
    );
    // Counted and said out loud, so the founder adjudicates instead of hitting a
    // wall of refusals on cutover day.
    expect(report.conversations.groupRosterDropsKept).toBe(1);
    expect(
      report.warnings.some((w) => w.includes('KEPT ON THE GROUP ROSTER')),
    ).toBe(true);
  });

  it('leaves 1:1 drop semantics exactly as they were', async () => {
    // The rule changes for GROUP rosters only. A dropped participant of a 1:1
    // thread still drops out of that thread's participants.
    const review = cleanReview();
    for (const row of review.contacts.values()) {
      if (row.phone === PHONES.tenantBusy) row.drop = 'Y';
    }
    const { doc, sent } = stubDoc();

    const report = await runApply({ doc, plan, review, importedAt });

    const oneToOneWrites = sent.filter(
      (c) =>
        c.name === 'UpdateCommand' &&
        String(c.input.UpdateExpression ?? '').includes('participant_phone = :participantPhone'),
    );
    for (const c of oneToOneWrites) {
      const values = c.input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':participantPhone']).not.toBe(PHONES.tenantBusy);
    }
    expect(report.conversations.groupRosterDropsKept).toBe(0);
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

describe('import retractImported - group member guard (T7.2)', () => {
  const DROPPED_PHONE = PHONES.groupTenant;
  const DROPPED_CONTACT_ID = contactIdForPhone(DROPPED_PHONE);
  const droppedRowKey = plan.merge.people.find((p) => p.phone === DROPPED_PHONE)!.rowKey;

  /** The clean review with exactly one person marked drop. */
  const reviewDropping = (...phones: string[]): ReturnType<typeof parseWorkbook> => {
    const review = cleanReview();
    const targets = new Set(phones.length > 0 ? phones : [DROPPED_PHONE]);
    for (const row of review.contacts.values()) {
      if (typeof row.phone === 'string' && targets.has(row.phone)) row.drop = 'Y';
    }
    return review;
  };

  interface RetractWorld {
    /** Extra attributes merged onto the dropped person's stored contact. */
    contact?: Record<string, unknown>;
    /** contactIds the group_open partition walk should report. */
    rosterContactIds?: string[];
    /** Throw instead of answering the group partition query. */
    rosterFails?: boolean;
    /** Make the guarded contact delete lose its condition. */
    deleteLoses?: boolean;
  }

  function retractStub(world: RetractWorld = {}): {
    doc: DynamoDBDocumentClient;
    sent: RecordedCommand[];
  } {
    return stubDoc((cmd) => {
      const tableName = String(cmd.input.TableName ?? '');
      if (cmd.name === 'QueryCommand' && cmd.input.IndexName === 'byLastActivity') {
        if (world.rosterFails) throw new Error('ProvisionedThroughputExceededException');
        return {
          Items: [
            { participants: (world.rosterContactIds ?? []).map((contactId) => ({ contactId })) },
          ],
        };
      }
      if (
        cmd.name === 'GetCommand' &&
        tableName.includes('contacts') &&
        (cmd.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID
      ) {
        return {
          Item: {
            contactId: DROPPED_CONTACT_ID,
            phone: DROPPED_PHONE,
            imported_from: 'quo-airtable-import',
            ...world.contact,
          },
        };
      }
      if (
        world.deleteLoses &&
        cmd.name === 'DeleteCommand' &&
        tableName.includes('contacts') &&
        (cmd.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID
      ) {
        throw ccfe();
      }
      return undefined;
    });
  }

  const contactDeletes = (sent: RecordedCommand[]): RecordedCommand[] =>
    sent.filter(
      (c) =>
        c.name === 'DeleteCommand' &&
        String(c.input.TableName ?? '').includes('contacts') &&
        (c.input.Key as { contactId?: string }).contactId === DROPPED_CONTACT_ID,
    );

  const partitionWalks = (sent: RecordedCommand[]): RecordedCommand[] =>
    sent.filter((c) => c.name === 'QueryCommand' && c.input.IndexName === 'byLastActivity');

  /** The `:status` value a walk actually queried (the whole point of the walk). */
  const walkedStatus = (cmd: RecordedCommand): unknown =>
    (cmd.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[':status'];

  it('deletes a dropped contact under an atomic group_participation_at guard', async () => {
    const { doc, sent } = retractStub();
    const report = await runApply({ doc, plan, review: reviewDropping(), importedAt });

    const deletes = contactDeletes(sent);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.ConditionExpression).toBe(
      'attribute_not_exists(group_participation_at)',
    );
    expect(report.warnings.filter((w) => w.includes('GROUP MEMBER'))).toHaveLength(0);
  });

  it('refuses a contact group text detection created, and says which reason applies', async () => {
    // origin is checked BEFORE the import-provenance rule: a detection stub
    // fails both, and "we did not create it" would hide the real reason.
    const { doc, sent } = retractStub({ contact: { origin: 'group_detection' } });
    const report = await runApply({ doc, plan, review: reviewDropping(), importedAt });

    expect(contactDeletes(sent)).toHaveLength(0);
    const warning = report.warnings.find((w) => w.includes(droppedRowKey));
    expect(warning).toContain('GROUP MEMBER');
    expect(warning).toContain('detection');
  });

  it('refuses a contact a native group text roster references', async () => {
    const { doc, sent } = retractStub({ rosterContactIds: [DROPPED_CONTACT_ID] });
    const report = await runApply({ doc, plan, review: reviewDropping(), importedAt });

    expect(contactDeletes(sent)).toHaveLength(0);
    const warning = report.warnings.find((w) => w.includes(droppedRowKey));
    expect(warning).toContain('KEPT (GROUP MEMBER)');
  });

  it('reports rather than throws when the delete loses its condition mid-run', async () => {
    // The race the atomic guard exists for: detection stamped
    // group_participation_at after the roster walk read the partition.
    const { doc, sent } = retractStub({ deleteLoses: true });
    const report = await runApply({ doc, plan, review: reviewDropping(), importedAt });

    const warning = report.warnings.find((w) => w.includes(droppedRowKey));
    expect(warning).toContain('GROUP MEMBER');
    expect(warning).toContain('while this import was running');
    // Nothing half-retracted: the guarded delete runs FIRST, so a refusal leaves
    // the person's own thread and messages alone.
    const messageDeletes = sent.filter(
      (c) => c.name === 'DeleteCommand' && String(c.input.TableName ?? '').includes('messages'),
    );
    expect(messageDeletes).toHaveLength(0);
  });

  it('walks the group partition once per run, and only when something is dropped', async () => {
    const noDrops = retractStub();
    await runApply({ doc: noDrops.doc, plan, review: cleanReview(), importedAt });
    expect(partitionWalks(noDrops.sent)).toHaveLength(0);

    const twoDrops = retractStub();
    await runApply({
      doc: twoDrops.doc,
      plan,
      review: reviewDropping(DROPPED_PHONE, PHONES.landlord),
      importedAt,
    });
    expect(partitionWalks(twoDrops.sent)).toHaveLength(1);
  });

  it('walks THE group_open partition - the queried :status is the repo constant', async () => {
    // The value, not just the index name. `retractImported` reads group rosters
    // by KEY CONDITION on `status`, so querying any other partition returns zero
    // rosters and silently un-guards every contact delete in the run. apply.ts
    // now imports GROUP_TEXT_STATUS rather than repeating the literal (there is
    // no second copy left to drift), and this pins the wire value that reaches
    // DynamoDB either way.
    const { doc, sent } = retractStub();
    await runApply({ doc, plan, review: reviewDropping(), importedAt });

    const walks = partitionWalks(sent);
    expect(walks).toHaveLength(1);
    expect(walkedStatus(walks[0]!)).toBe(GROUP_TEXT_STATUS);
    expect(walkedStatus(walks[0]!)).toBe('group_open');
  });

  it('never reads the group partition on a dry run', async () => {
    const { doc, sent } = retractStub();
    await runApply({ doc, plan, review: reviewDropping(), importedAt, dryRun: true });
    expect(partitionWalks(sent)).toHaveLength(0);
    expect(contactDeletes(sent)).toHaveLength(0);
  });

  it('fails LOUDLY when the group partition read fails', async () => {
    // Treating the error as "no group threads" would silently un-guard every
    // delete in the run - the exact failure the guard exists to prevent.
    const { doc } = retractStub({ rosterFails: true });
    await expect(runApply({ doc, plan, review: reviewDropping(), importedAt })).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});
