// Spec 2026-10-12 D1 (docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md
// sections 2 and 8): the R2-ADV-1 schedules against the REAL repositories on
// DynamoDB Local - the resolution service and the caseworker conversion built
// over prefixed throwaway tables, as the planner's executed reproduction ran
// them (docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md
// section 4). There is no router here, so the suggestion.updated emit is
// asserted by the FakeWorld twin (suggestionReclassification.test.ts); the
// commit-site cases are in suggestionResolutionRepo.integration.test.ts.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJournalSweep } from '../src/jobs/journalSweep.js';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createEventBus } from '../src/lib/events.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createActivityEventsRepo } from '../src/repos/activityEventsRepo.js';
import { createAiRunsRepo } from '../src/repos/aiRunsRepo.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactVocabularyRepo } from '../src/repos/contactVocabularyRepo.js';
import { createContactsRepo, type ContactItem } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createExtractionRepo } from '../src/repos/extractionRepo.js';
import { createOrgListRepo } from '../src/repos/orgListRepo.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import {
  createSuggestionResolutionRepo,
  resolutionItemId,
  type SuggestionResolutionItem,
} from '../src/repos/suggestionResolutionRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createUnitsRepo } from '../src/repos/unitsRepo.js';
import { createCaseworkerConversionService } from '../src/services/caseworkerConversion.js';
import { createOrgNamesService } from '../src/services/orgNames.js';
import {
  createSuggestionResolutionService,
  type SuggestionRequestIdentity,
  type SuggestionResolutionHooks,
} from '../src/services/suggestionResolution.js';
import { quietLogger } from './helpers/orgFixtures.js';

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
  console.warn(`[suggestionReclassification.integration] DynamoDB Local is required at ${endpoint}`);
}

/** The plan reads the contact and claims here. */
const T0 = '2026-10-12T12:00:00.000Z';
/** Past the 30s default lease, so a read-path recovery can take the journal over. */
const LATER = '2026-10-12T12:05:00.000Z';
/** Past the daily sweep's 24h claim-age gate. */
const DAY_LATER = '2026-10-13T13:00:00.000Z';
const ACTOR = 'usr_testreclass00000000000';
const AUTHORITY = 'Atlanta Housing Authority';
const BASES = [
  'contacts', 'conversations', 'placements', 'tours', 'units',
  'ai_extraction', 'ai_runs', 'audit_events', 'activity_events', 'settings',
] as const;

describe.skipIf(!reachable)('D1 schedules on the real repositories (DynamoDB Local)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = quietLogger();
  const deps = { doc, env: testEnv, logger };
  const contacts = createContactsRepo(deps);
  const extraction = createExtractionRepo(deps);
  const aiRuns = createAiRunsRepo(deps);
  const resolutions = createSuggestionResolutionRepo(deps);
  const orgNames = createOrgNamesService({ orgListRepo: createOrgListRepo(deps), logger });
  const events = createEventBus({ logger });
  const conversion = createCaseworkerConversionService({
    contacts,
    conversations: createConversationsRepo(deps),
    placements: createPlacementsRepo(deps),
    tours: createToursRepo(deps),
    units: createUnitsRepo(deps),
    extraction,
    aiRuns,
    audit: createAuditRepo(deps),
    activityEvents: createActivityEventsRepo(deps),
    vocabulary: createContactVocabularyRepo(deps),
    events,
    orgNames,
    logger,
  });
  const contactsTable = tableName('contacts', testEnv);
  const extractionTable = tableName('ai_extraction', testEnv);

  beforeAll(async () => {
    for (const base of BASES) await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
  }, 120_000);

  afterAll(async () => {
    for (const base of BASES) await deleteTableIfExists(client, tableName(base, testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  function resolutionService(now: string, hooks?: SuggestionResolutionHooks) {
    return createSuggestionResolutionService({
      contactsRepo: contacts,
      extractionRepo: extraction,
      aiRunsRepo: aiRuns,
      resolutionRepo: resolutions,
      orgNamesService: orgNames,
      logger,
      now: () => now,
      ...(hooks !== undefined && { hooks }),
    });
  }

  async function seedTenant(contactId: string): Promise<void> {
    await doc.send(new PutCommand({
      TableName: contactsTable,
      Item: {
        contactId, type: 'tenant', status: 'onboarding', firstName: 'Ana', lastName: 'Ruiz',
        created_at: '2026-07-01T10:00:00.000Z',
      },
    }));
  }

  async function seedAuthoritySuggestion(contactId: string): Promise<SuggestionRequestIdentity> {
    const { item } = await extraction.putSuggestion({
      ownerContactId: contactId,
      target: 'housingAuthority',
      suggestedValue: AUTHORITY,
      conversationId: `conv-${contactId}`,
      createdAt: '2026-10-12T11:00:00.000Z',
    });
    return { createdAt: item.createdAt, ...(item.revision !== undefined && { revision: item.revision }) };
  }

  /** A pending suggestion for any other target (the voucherSize and status cases). */
  async function seedTargetSuggestion(
    contactId: string,
    target: string,
    suggestedValue: string,
  ): Promise<SuggestionRequestIdentity> {
    const { item } = await extraction.putSuggestion({
      ownerContactId: contactId,
      target,
      suggestedValue,
      conversationId: `conv-${contactId}`,
      createdAt: '2026-10-12T11:00:00.000Z',
    });
    return { createdAt: item.createdAt, ...(item.revision !== undefined && { revision: item.revision }) };
  }

  async function readContact(contactId: string): Promise<ContactItem | undefined> {
    const { Item } = await doc.send(new GetCommand({
      TableName: contactsTable, Key: { contactId }, ConsistentRead: true,
    }));
    return Item as ContactItem | undefined;
  }

  /** The claim lands, then the process dies before the domain commit. */
  async function crashAfterClaim(contactId: string, identity: SuggestionRequestIdentity): Promise<void> {
    const crashing = resolutionService(T0, {
      afterBoundary: (boundary) => {
        if (boundary === 'claimed') throw new Error('simulated termination after claim');
      },
    });
    await expect(crashing.resolve({
      contactId, target: 'housingAuthority', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toThrow('simulated termination after claim');
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('active');
  }

  function guardKeys(item: SuggestionResolutionItem | undefined): string[] {
    if (item?.state !== 'active') throw new Error('expected an active journal');
    const plan = item.plan;
    if (plan.kind !== 'contact' && plan.kind !== 'status') throw new Error('expected a contact plan');
    return Object.keys(plan.guard).sort();
  }

  /** Make the stored journal look claimed before the deploy: no classification_revision in its guard. */
  async function stripRevision(contactId: string): Promise<void> {
    await doc.send(new UpdateCommand({
      TableName: extractionTable,
      Key: { itemId: resolutionItemId(contactId, 'housingAuthority') },
      UpdateExpression: 'REMOVE #plan.#guard.#revision',
      ConditionExpression: '#state = :active',
      ExpressionAttributeNames: {
        '#plan': 'plan', '#guard': 'guard', '#revision': 'classification_revision', '#state': 'state',
      },
      ExpressionAttributeValues: { ':active': 'active' },
    }));
  }

  async function expectNoAuthority(contactId: string): Promise<void> {
    const contact = await readContact(contactId);
    expect(contact).toMatchObject({ type: 'partner', role: 'Caseworker' });
    expect(contact?.['housingAuthority']).toBeUndefined();
    expect(contact?.['housingAuthority_source']).toBeUndefined();
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('completed');
  }

  it('A: an accept paused at claimed, then a conversion, answers 409 suggestion_contact_reclassified and writes no authority', async () => {
    const contactId = `reclass-a-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    // The hook IS the pause: the conversion commits between the claim and the
    // contact effect, exactly where R2-ADV-1 put it.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await conversion.make(contactId, { actor: ACTOR });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'housingAuthority', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    await expectNoAuthority(contactId);
  });

  // Plan review R1 row 8 (spec 8 "D1, real AND fake": the generic re-type and
  // the status tie also run on DynamoDB Local, not only on the FakeWorld).
  it('A: a voucherSize accept spanning a generic tenant -> landlord re-type answers 409 suggestion_contact_reclassified and writes no voucher size', async () => {
    const contactId = `reclass-v-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedTargetSuggestion(contactId, 'voucherSize', '3');
    // Not the conversion: an ordinary type change through the REAL
    // contactsRepo.update, whose UpdateExpression bumps classification_revision
    // in the same write (what the contacts PATCH calls) - the fence must see it.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await contacts.update(contactId, { type: 'landlord' });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'voucherSize', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    const contact = await readContact(contactId);
    // Seeded with no revision, so the re-type's bump made it 1.
    expect(contact).toMatchObject({ type: 'landlord', classification_revision: 1 });
    expect(contact?.['voucherSize']).toBeUndefined();
    expect(contact?.['voucherSize_source']).toBeUndefined();
    expect((await resolutions.get(contactId, 'voucherSize'))?.state).toBe('completed');
  });

  it('A: a status accept spanning a conversion answers 409 suggestion_contact_reclassified - classification wins the tie with status', async () => {
    const contactId = `reclass-st-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId); // status 'onboarding'
    const identity = await seedTargetSuggestion(contactId, 'status', 'searching');
    // The conversion changes BOTH the guarded status (to 'active') and the
    // classification, so the commit's mismatch is a tie the repository must
    // answer as a reclassification.
    const paused = resolutionService(T0, {
      afterBoundary: async (boundary) => {
        if (boundary === 'claimed') await conversion.make(contactId, { actor: ACTOR });
      },
    });

    await expect(paused.resolve({
      contactId, target: 'status', action: 'accept', identity, actorId: ACTOR,
    })).rejects.toMatchObject({ status: 409, code: 'suggestion_contact_reclassified' });

    // The conversion's own status stands; the accepted 'searching' was never written.
    expect(await readContact(contactId)).toMatchObject({ type: 'partner', role: 'Caseworker', status: 'active' });
    expect((await resolutions.get(contactId, 'status'))?.state).toBe('completed');
  });

  it('B (read): a crashed claim recovered after a conversion writes no authority (PIN)', async () => {
    const contactId = `reclass-b-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await conversion.make(contactId, { actor: ACTOR });

    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    await expectNoAuthority(contactId);
  });

  it('B (sweep): a crashed claim recovered by the daily journal sweep after a conversion writes no authority (PIN)', async () => {
    const contactId = `reclass-s-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await conversion.make(contactId, { actor: ACTOR });

    const outcome = await runJournalSweep(DAY_LATER, {
      settingsRepo: {
        claimGroupPeriod: async () => true,
        getJournalSweepCursor: async () => undefined,
        putJournalSweepCursor: async () => {},
      },
      // The table is shared by every case in this file: the sweep sees only
      // this case's journal.
      resolutionRepo: {
        async listActiveResolutionRows(opts) {
          const page = await resolutions.listActiveResolutionRows(opts);
          return { ...page, rows: page.rows.filter((row) => row.contactId === contactId) };
        },
        listJournals: (id) => resolutions.listJournals(id),
      },
      resolutionService: resolutionService(DAY_LATER),
      events,
      logger,
    }, { force: true });

    expect(outcome.recovered).toBe(1);
    await expectNoAuthority(contactId);
  });

  it('a pre-deploy journal recovered onto a converted contact ends superseded, not stale (PIN)', async () => {
    const contactId = `reclass-l-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await stripRevision(contactId);
    expect(guardKeys(await resolutions.get(contactId, 'housingAuthority')))
      .toEqual(['housingAuthority', 'housingAuthority_source']);
    await conversion.make(contactId, { actor: ACTOR });

    // `stale` would throw inside recovery (logged, recovered: 0) and leave the
    // journal active forever - the loop effectiveGuard exists to prevent.
    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    await expectNoAuthority(contactId);
  });

  it('the same pre-deploy journal recovered onto an unconverted tenant still commits (PIN)', async () => {
    const contactId = `reclass-lt-${randomUUID().slice(0, 8)}`;
    await seedTenant(contactId);
    const identity = await seedAuthoritySuggestion(contactId);
    await crashAfterClaim(contactId, identity);
    await stripRevision(contactId);

    expect(await resolutionService(LATER).recoverAbandoned(contactId)).toEqual({ recovered: 1, stateChanged: true });

    const contact = await readContact(contactId);
    expect(contact).toMatchObject({ type: 'tenant', housingAuthority: AUTHORITY });
    expect((await resolutions.get(contactId, 'housingAuthority'))?.state).toBe('completed');
  });
});
