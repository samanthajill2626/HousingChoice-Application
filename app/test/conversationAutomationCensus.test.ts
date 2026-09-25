// The read-only census (spec D1) against DynamoDB Local: every group the spec
// names, each proven by one seeded row, and the invariant that it WRITES NOTHING.
import { randomUUID } from 'node:crypto';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { runConversationAutomationCensus } from '../scripts/conversation-automation-census.js';

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
if (!reachable) {
  console.warn(`[conversationAutomationCensus] SKIPPED - no DynamoDB Local at ${endpoint}.`);
}

const TABLES = ['conversations', 'audit_events', 'contacts', 'tours', 'tourReminders', 'placementNudges'] as const;
const NOW = '2026-09-25T12:00:00.000Z';

describe.skipIf(!reachable)('conversation-automation-census against DynamoDB Local', () => {
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const env = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const t = (base: string): string => tableName(base, env);

  beforeAll(async () => {
    for (const base of TABLES) await ensureTable(client, getTableSpec(base), t(base));
  }, 120_000);
  afterAll(async () => {
    for (const base of TABLES) await deleteTableIfExists(client, t(base));
    doc.destroy();
    client.destroy();
  }, 120_000);

  async function put(base: string, item: Record<string, unknown>): Promise<void> {
    await doc.send(new PutCommand({ TableName: t(base), Item: item }));
  }
  async function scanAll(base: string): Promise<Record<string, unknown>[]> {
    const { Items } = await doc.send(new ScanCommand({ TableName: t(base) }));
    return (Items ?? []) as Record<string, unknown>[];
  }

  it('groups every row the way the spec names, lists breaker trips, replays the reminder routing, and writes nothing', async () => {
    const audit = createAuditRepo({ doc, env });
    // Conversations: one of each group.
    await put('conversations', { conversationId: 'c-import-manual', participant_phone: '+15550000001', status: 'open', last_activity_at: NOW, type: 'unknown_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await put('conversations', { conversationId: 'c-breaker', participant_phone: '+15550000002', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'manual', imported_from: 'quo-airtable-import', created_at: NOW });
    await audit.append('conversations#c-breaker', 'message_sent', { automated: true });
    await audit.append('conversations#c-breaker', 'mode_changed', { from: 'auto', to: 'manual', reason: 'breaker_trip' });
    await put('conversations', { conversationId: 'c-other-manual', participant_phone: '+15550000003', status: 'open', last_activity_at: NOW, type: 'landlord_1to1', ai_mode: 'manual', created_at: NOW });
    await put('conversations', { conversationId: 'c-auto', participant_phone: '+15550000004', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', ai_mode: 'auto', created_at: NOW });
    await put('conversations', { conversationId: 'c-unset', participant_phone: '+15550000005', status: 'open', last_activity_at: NOW, type: 'tenant_1to1', created_at: NOW });
    await put('conversations', { conversationId: 'c-typeless', participant_phone: '+15550000006', status: 'open', last_activity_at: NOW, ai_mode: 'manual', created_at: NOW });
    // A USABLE relay group (open, pool number, roster) and a CLOSED one.
    await put('conversations', { conversationId: 'c-relay', status: 'open', relay_status: 'relay_group#open', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009001', participant_phone: '+15550009001', participants: [{ contactId: 'ten-off', phone: '+15550000001' }], created_at: NOW });
    await put('conversations', { conversationId: 'c-relay-closed', status: 'closed', relay_status: 'relay_group#closed', last_activity_at: NOW, type: 'relay_group', ai_mode: 'manual', pool_number: '+15550009002', participant_phone: '+15550009002', participants: [{ contactId: 'ten-off', phone: '+15550000001' }], created_at: NOW });
    await put('conversations', { conversationId: 'c-group', status: 'group_open', last_activity_at: NOW, type: 'group_text', ai_mode: 'manual', created_at: NOW });
    // Pointer items: a claim that MATCHES its row, a claim that points ELSEWHERE, and an email claim.
    await put('conversations', { conversationId: 'phone#+15550000001', ref_conversationId: 'c-import-manual' });
    await put('conversations', { conversationId: 'phone#+15550000002', ref_conversationId: 'c-somewhere-else' });
    await put('conversations', { conversationId: 'email#x@example.com', ref_conversationId: 'c-auto' });

    // Tour rungs: contact + tour per case.
    await put('contacts', { contactId: 'ten-off', type: 'tenant', status: 'searching', phone: '+15550000001', firstName: 'A', lastName: 'B', created_at: NOW });
    await put('contacts', { contactId: 'ten-trip', type: 'tenant', status: 'searching', phone: '+15550000002', firstName: 'T', lastName: 'R', created_at: NOW });
    await put('contacts', { contactId: 'ten-on', type: 'tenant', status: 'searching', phone: '+15550000004', firstName: 'C', lastName: 'D', created_at: NOW });
    const tours = createToursRepo({ doc, env });
    const reminders = createTourRemindersRepo({ doc, env });
    const offTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const tripTour = await tours.create({ tenantId: 'ten-trip', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const onTour = await tours.create({ tenantId: 'ten-on', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    const groupTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'landlord_led' });
    await tours.patch(groupTour.tourId, { groupThreadId: 'c-relay' });
    const fallbackTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'landlord_led' });
    await tours.patch(fallbackTour.tourId, { groupThreadId: 'c-relay-closed' }); // unusable group -> tenant 1:1
    const pastTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-09-01T15:00:00.000Z', tourType: 'self_guided' });
    const supersededTour = await tours.create({ tenantId: 'ten-off', unitId: 'u1', scheduledAt: '2026-10-01T15:00:00.000Z', tourType: 'self_guided' });
    await tours.patch(supersededTour.tourId, { currentLadderId: 'ladder-2' }); // a rung with no ladderId is superseded
    await reminders.create({ tourId: offTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: tripTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: onTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: groupTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: fallbackTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: pastTour.tourId, kind: 'day_before', dueAt: '2026-08-31T23:00:00.000Z' });
    await reminders.create({ tourId: supersededTour.tourId, kind: 'day_before', dueAt: '2026-09-30T23:00:00.000Z' });
    await reminders.create({ tourId: offTour.tourId, kind: 'confirmation', dueAt: '2026-09-26T09:00:00.000Z' });
    await reminders.create({ tourId: offTour.tourId, kind: 'morning_of', dueAt: '2026-10-01T11:00:00.000Z', skipped: { at: NOW, reason: 'tenant_not_on_roster' } });
    // Nudges: two pending, one sent.
    const nudges = createPlacementNudgesRepo({ doc, env });
    await nudges.create({ placementId: 'p1', kind: 'receipt_check', dueAt: '2026-09-26T00:00:00.000Z' });
    await nudges.create({ placementId: 'p1', kind: 'completion_check', dueAt: '2026-09-27T00:00:00.000Z' });
    const sentNudge = await nudges.create({ placementId: 'p2', kind: 'approval_check', dueAt: '2026-09-20T00:00:00.000Z' });
    await nudges.claimSend(sentNudge.nudgeId, NOW);

    const before = {
      conversations: await scanAll('conversations'),
      audit: await scanAll('audit_events'),
      reminders: await scanAll('tourReminders'),
    };

    const census = await runConversationAutomationCensus({ doc, env, now: NOW });

    expect(census.pointerRows).toBe(3);
    expect(census.byType).toEqual({
      unknown_1to1: { auto: 0, manual: 1, unset: 0 },
      tenant_1to1: { auto: 1, manual: 1, unset: 1 },
      landlord_1to1: { auto: 0, manual: 1, unset: 0 },
      '(none)': { auto: 0, manual: 1, unset: 0 },
      relay_group: { auto: 0, manual: 2, unset: 0 },
      group_text: { auto: 0, manual: 1, unset: 0 },
    });
    // Cause precedence: group thread, then breaker trip, then imported, then other.
    expect(census.manualByCause).toEqual({ groupThread: 3, breakerTrip: 1, imported: 1, other: 2 });
    expect(census.breakerTripped).toEqual([
      { conversationId: 'c-breaker', type: 'tenant_1to1', trippedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    expect(census.importClaimMismatches).toBe(1);
    // The job's own routing, replayed: usable group -> group; unusable group ->
    // the tenant 1:1; a breaker-tripped 1:1 is its own line because the bulk
    // fix script leaves those rows alone.
    expect(census.pendingTourRungs).toEqual({
      oneToOneSwitchedOff: 2, // offTour + fallbackTour (closed group -> tenant 1:1)
      oneToOneBreakerTripped: 1, // tripTour
      oneToOneSwitchedOn: 1, // onTour
      groupRouted: 1, // groupTour (usable relay group)
      tourPast: 1,
      superseded: 1,
      discontinued: 1,
      unresolvable: 0,
    });
    expect(census.pendingNudgesHeldManualOnly).toBe(2);

    // The Scan paging loop: two rows a page walks every page to the same answer
    // (a real table spans many 1 MB pages; a dropped ExclusiveStartKey would
    // silently undercount).
    expect(await runConversationAutomationCensus({ doc, env, now: NOW, scanLimit: 2 })).toEqual(census);

    // READ-ONLY: not one row changed in any table the census reads.
    expect(await scanAll('conversations')).toEqual(before.conversations);
    expect(await scanAll('audit_events')).toEqual(before.audit);
    expect(await scanAll('tourReminders')).toEqual(before.reminders);
  }, 120_000);
});
