// A plan MATERIALIZED from the property default (services/rosterEdits.ts
// applyRosterPlanEdit - the first People-card edit) inherits the shared
// property-contact lookup (primary-contact-integrity spec 4.1): a deleted
// primary is never written into the plan, and a property-contact read that
// THROWS keeps its bare entry, so the plan never silently loses the property
// contact. PURE - in-memory repos and an in-memory plan store, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  applyRosterPlanEdit,
  type RosterPlanEditRequest,
  type RosterPlanState,
  type RosterPlanStore,
} from '../src/services/rosterEdits.js';
import { createLogger } from '../src/lib/logger.js';
import type { RosterEntry, RosterResolutionDeps } from '../src/lib/rosterResolution.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
const UNIT: UnitItem = {
  unitId: 'unit-1',
  landlordId: 'c-owner',
  status: 'available',
  contacts: [
    { contactId: 'c-owner', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm', role: 'pm', primaryContact: true },
  ],
  primary_contact: 'c-pm',
};

function person(contactId: string, phone: string, firstName: string, over: Partial<ContactItem> = {}): ContactItem {
  return { contactId, type: 'landlord', phone, firstName, ...over };
}

function depsFor(records: Record<string, ContactItem>, throwing: string[] = []): RosterResolutionDeps {
  return {
    conversations: { getById: async () => undefined },
    units: { getById: async () => UNIT },
    contacts: {
      getById: async (contactId: string) => {
        if (throwing.includes(contactId)) throw new Error('dynamodb: ProvisionedThroughputExceededException');
        return records[contactId];
      },
    },
    log: createLogger({ destination: createLogCapture().stream }),
  };
}

/** An in-memory plan store recording every setRoster write, in order. */
function memoryStore(): { store: RosterPlanStore; writes: RosterEntry[][] } {
  const writes: RosterEntry[][] = [];
  let state: RosterPlanState = {};
  return {
    writes,
    store: {
      async reload() {
        return state;
      },
      async setRoster(roster, expectedVersion) {
        writes.push(roster);
        state = { roster, rosterVersion: (expectedVersion ?? 0) + 1 };
        return state;
      },
      async clearRoster() {
        state = {};
      },
    },
  };
}

const ADD_CASEWORKER: RosterPlanEditRequest = {
  owner: { type: 'tour', id: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1' },
  state: {},
  edit: { kind: 'add', entry: { contactId: 'c-caseworker' } },
  notFoundError: 'tour_not_found',
};

describe('materializing the property default into a plan (spec 4.1)', () => {
  it('a DELETED primary is never written into the plan - the landlord of record is', async () => {
    const { store, writes } = memoryStore();
    const outcome = await applyRosterPlanEdit(
      depsFor({
        'c-tenant': person('c-tenant', '+15550100001', 'Tina', { type: 'tenant' }),
        'c-pm': person('c-pm', '+15550100002', 'Pat', { deleted_at: DELETED_AT }),
        'c-owner': person('c-owner', '+15550100004', 'Olive'),
      }),
      store,
      ADD_CASEWORKER,
    );
    expect(outcome).toEqual({ ok: true });
    // writes[0] is the MATERIALIZE, writes[1] the add applied on top of it.
    expect(writes[0]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-owner' }]);
    expect(writes[1]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-owner' }, { contactId: 'c-caseworker' }]);
  });

  it('(PIN) a THROWING property-contact read keeps the candidate as a bare entry - the plan never loses it', async () => {
    const { store, writes } = memoryStore();
    const outcome = await applyRosterPlanEdit(
      depsFor(
        {
          'c-tenant': person('c-tenant', '+15550100001', 'Tina', { type: 'tenant' }),
          'c-owner': person('c-owner', '+15550100004', 'Olive'),
        },
        ['c-pm'],
      ),
      store,
      ADD_CASEWORKER,
    );
    expect(outcome).toEqual({ ok: true });
    expect(writes[0]).toEqual([{ contactId: 'c-tenant' }, { contactId: 'c-pm' }]);
  });
});
