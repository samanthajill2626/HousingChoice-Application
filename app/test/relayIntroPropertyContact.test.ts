// The relay INTRO names the property contact through resolveTourContactNames,
// so it inherits the shared lookup (primary-contact-integrity spec 4.1): a
// soft-deleted or missing primary is never named in the intro - the walk
// resolves past it to the landlord of record, or to nobody (the general
// intro). Preview and send share resolveRelayComposeInputs, so this pins both.
// PURE - in-memory repos, no DynamoDB.
import { describe, expect, it } from 'vitest';
import {
  composeIntroBody,
  resolveRelayComposeInputs,
  type RelayComposeDeps,
} from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const DELETED_AT = '2026-10-01T00:00:00.000Z';
/** 2026-09-08 15:00 New York; "now" is the day before, so the DATED tour variant. */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
const DAY_BEFORE_NOW = '2026-09-07T13:00:00.000Z';

const CONTACTS: Record<string, ContactItem> = {
  'c-tenant': { contactId: 'c-tenant', type: 'tenant', firstName: 'Alicia', lastName: 'Reyes' },
  'c-landlord': { contactId: 'c-landlord', type: 'landlord', firstName: 'Marcus', lastName: 'Webb' },
  'c-pm-deleted': {
    contactId: 'c-pm-deleted',
    type: 'landlord',
    firstName: 'Dana',
    lastName: 'Ortiz',
    deleted_at: DELETED_AT,
  },
};

function unitWith(over: Record<string, unknown>): UnitItem {
  return {
    unitId: 'unit-1',
    status: 'available',
    address: { line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  } as unknown as UnitItem;
}

function depsFor(unit: UnitItem): RelayComposeDeps {
  return {
    toursRepo: {
      get: async () =>
        ({ tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1', scheduledAt: TOUR_AT }) as never,
    },
    placementsRepo: {
      getById: async () => ({ placementId: 'plc-1', tenantId: 'c-tenant', unitId: 'unit-1' }) as never,
    },
    unitsRepo: { getById: async () => unit },
    contactsRepo: { getById: async (id: string) => CONTACTS[id] },
    settingsRepo: { getOrgSettings: async () => ({ timezone: 'America/New_York' }) as never },
    nowIso: DAY_BEFORE_NOW,
    logger: createLogger({ destination: createLogCapture().stream }),
  };
}

/** A deleted PM flagged primary next to a live landlord of record. */
const DELETED_PM_PRIMARY = unitWith({
  landlordId: 'c-landlord',
  contacts: [
    { contactId: 'c-landlord', role: 'landlord', primaryContact: false },
    { contactId: 'c-pm-deleted', role: 'pm', primaryContact: true },
  ],
});

describe('the relay intro skips a deleted property contact (spec 4.1)', () => {
  it('a DELETED primary: the tour intro names the landlord of record, never the deleted contact', async () => {
    const inputs = await resolveRelayComposeInputs({ type: 'tour', id: 'tour-1' }, depsFor(DELETED_PM_PRIMARY));
    expect(inputs.variant).toBe('tour');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
    const body = composeIntroBody(inputs, ['Alicia Reyes', 'Marcus Webb']);
    expect(body).toContain('Marcus');
    expect(body).not.toContain('Dana');
  });

  it('a DELETED primary: the placement intro does the same', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'placement', id: 'plc-1' },
      depsFor(DELETED_PM_PRIMARY),
    );
    expect(inputs.variant).toBe('placement');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
  });

  it('a deleted SOLE primary with no landlord of record: the general intro, never naming it', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      depsFor(unitWith({ contacts: [{ contactId: 'c-pm-deleted', role: 'pm', primaryContact: true }] })),
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.propertyContactFirstName).toBeUndefined();
    expect(composeIntroBody(inputs, ['Alicia Reyes'])).not.toContain('Dana');
  });

  it('a primary with NO record falls through to the landlord of record', async () => {
    const inputs = await resolveRelayComposeInputs(
      { type: 'tour', id: 'tour-1' },
      depsFor(
        unitWith({
          landlordId: 'c-landlord',
          contacts: [
            { contactId: 'c-landlord', role: 'landlord', primaryContact: false },
            { contactId: 'c-gone', role: 'pm', primaryContact: true },
          ],
        }),
      ),
    );
    expect(inputs.variant).toBe('tour');
    expect(inputs.propertyContactFirstName).toBe('Marcus');
  });
});
