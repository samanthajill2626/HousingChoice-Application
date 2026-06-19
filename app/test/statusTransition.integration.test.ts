// Status-model transition INTEGRATION tests against DynamoDB Local — the real
// cross-repo writes the in-memory fakes can't fully validate:
//   • a transition writes the denormalized stage onto cases, the DERIVED
//     tenant_status onto contacts, the DERIVED listing status onto units, and a
//     real audit_events row.
//   • auditRepo.listByEntity reads the provenance back NEWEST-FIRST.
//   • the stuck_case next-deadline round-trips through the byNextDeadline GSI.
//   • a prior MANUAL tenant pin is NOT overwritten by a later DERIVED transition.
//
// Self-skipping like casesRepo.integration.test.ts: when nothing answers at
// DYNAMODB_ENDPOINT the suite is skipped so `npm test` stays green without
// Docker. Uses a throwaway table prefix (created + dropped per run).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createCasesRepo } from '../src/repos/casesRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createEventBus } from '../src/lib/events.js';
import { createStatusTransitionService } from '../src/services/statusTransition.js';
import { createLogCapture } from './helpers/logCapture.js';

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
  console.warn(
    `[statusTransition.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

const TABLES = ['cases', 'contacts', 'units', 'audit_events'] as const;

describe.skipIf(!reachable)('statusTransition against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });

  const cases = createCasesRepo({ doc, env: testEnv, logger });
  const contacts = createContactsRepo({ doc, env: testEnv, logger });
  const units = createUnitsRepo({ doc, env: testEnv, logger });
  const audit = createAuditRepo({ doc, env: testEnv, logger });
  const svc = createStatusTransitionService({
    casesRepo: cases,
    unitsRepo: units,
    contactsRepo: contacts,
    auditRepo: audit,
    events: createEventBus({ logger }),
    logger,
  });

  beforeAll(async () => {
    for (const t of TABLES) {
      await ensureTable(client, getTableSpec(t), tableName(t, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const t of TABLES) {
      await deleteTableIfExists(client, tableName(t, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('a transition denormalizes the stage + derives tenant/listing statuses + writes a real audit row; history reads back newest-first', async () => {
    const tenantId = `contact-${randomUUID().slice(0, 8)}`;
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    await contacts.create({ contactId: tenantId, type: 'tenant', rta_in_hand: true });
    await units.create({ unitId, landlordId: 'll-1', status: 'available' });
    const c = await cases.create({ tenantId, unitId, stage: 'send_application' });

    await svc.transitionPlacement(c.caseId, { toStage: 'collect_rta', source: 'manual' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_hap_contract', source: 'manual' });

    // Denormalized stage on the case.
    const storedCase = await cases.getById(c.caseId);
    expect(storedCase!.stage).toBe('awaiting_hap_contract');
    expect(typeof storedCase!.stage_entered_at).toBe('string');

    // Derived tenant status on the contact (Contract phase ⇒ placing).
    expect((await contacts.getById(tenantId))!.tenant_status).toBe('placing');
    // Derived listing status on the unit (Contract phase ⇒ finalizing).
    expect((await units.getById(unitId))!.status).toBe('finalizing');

    // A real audit_events row per transition, read back NEWEST-FIRST.
    const history = await audit.listByEntity(`cases#${c.caseId}`);
    const transitions = history.filter((e) => e.event_type === 'case_stage_changed');
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    expect((transitions[0]!.payload as { to: string }).to).toBe('awaiting_hap_contract');
  });

  it('the stuck_case next-deadline round-trips through the byNextDeadline GSI', async () => {
    const tenantId = `contact-${randomUUID().slice(0, 8)}`;
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    await contacts.create({ contactId: tenantId, type: 'tenant', rta_in_hand: true });
    await units.create({ unitId, landlordId: 'll-1', status: 'available' });
    const c = await cases.create({ tenantId, unitId, stage: 'send_application' });

    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });

    const stored = await cases.getById(c.caseId);
    expect(stored!.next_deadline_type).toBe('stuck_case');
    // Queryable via the byNextDeadline GSI (due-by a far cutoff finds it).
    const page = await cases.listByNextDeadline('stuck_case', { beforeAt: '2099-01-01T00:00:00.000Z' });
    expect(page.items.some((x) => x.caseId === c.caseId)).toBe(true);
  });

  it('a prior MANUAL tenant pin is NOT overwritten by a later DERIVED transition', async () => {
    const tenantId = `contact-${randomUUID().slice(0, 8)}`;
    const unitId = `unit-${randomUUID().slice(0, 8)}`;
    await contacts.create({ contactId: tenantId, type: 'tenant', rta_in_hand: true });
    await units.create({ unitId, landlordId: 'll-1', status: 'available' });

    // Pin the tenant status manually (e.g. on_hold).
    await svc.setTenantStatus(tenantId, { toStatus: 'on_hold', source: 'manual' });

    // A placement transition would DERIVE tenant→placing, but the manual pin wins.
    const c = await cases.create({ tenantId, unitId, stage: 'send_application' });
    await svc.transitionPlacement(c.caseId, { toStage: 'awaiting_approval', source: 'manual' });

    const contact = await contacts.getById(tenantId);
    expect(contact!.tenant_status).toBe('on_hold'); // manual pin preserved
    expect(contact!.tenant_status_source).toBe('manual');
  });
});
