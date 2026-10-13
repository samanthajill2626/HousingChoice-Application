// primary-contact-integrity spec 5.1 (plan S3.1): resolveRelayComposeInputs
// explains a general intro. For an OWNED conversation (tour or placement) that
// resolves to the general ("naked") intro, `introFallback` carries EVERY
// reason, in the spec's order, plus the ids the open-group dialog links to.
// An ownerless conversation never carries it; the variant rule is unchanged.
import { describe, expect, it } from 'vitest';
import { resolveRelayComposeInputs, type RelayComposeDeps } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { RelayOwner } from '../src/repos/conversationsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const NY = 'America/New_York';
/** 2026-09-08 15:00 New York (19:00Z, EDT). */
const TOUR_AT = '2026-09-08T19:00:00.000Z';
/** 09:00 New York the day BEFORE the tour: the dated tour variant. */
const DAY_BEFORE_NOW = '2026-09-07T13:00:00.000Z';
/** 09:00 New York the day AFTER the tour: the tour has started. */
const DAY_AFTER_NOW = '2026-09-09T13:00:00.000Z';
const DELETED_AT = '2026-10-01T12:00:00.000Z';

const TOUR: RelayOwner = { type: 'tour', id: 'tour-1' };
const PLACEMENT: RelayOwner = { type: 'placement', id: 'plc-1' };

const TENANT = {
  contactId: 'c-tenant',
  type: 'tenant',
  firstName: 'Alicia',
  lastName: 'Reyes',
} as ContactItem;
const LANDLORD = {
  contactId: 'c-landlord',
  type: 'landlord',
  firstName: 'Marcus',
  lastName: 'Webb',
} as ContactItem;
const DELETED_LANDLORD = { ...LANDLORD, deleted_at: DELETED_AT } as ContactItem;
const NAMELESS_LANDLORD = { contactId: 'c-landlord', type: 'landlord', lastName: 'Webb' } as ContactItem;

const SCHEDULED_TOUR = { tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1', scheduledAt: TOUR_AT };
const UNSCHEDULED_TOUR = { tourId: 'tour-1', tenantId: 'c-tenant', unitId: 'unit-1' };
/** No flagged primary row and no landlord of record: P1 answers nobody / none. */
const NO_CONTACT_UNIT = { landlordId: undefined, contacts: [] };

const quietLogger = createLogger({ destination: createLogCapture().stream });

function unitWith(over: Record<string, unknown> = {}): UnitItem {
  return {
    unitId: 'unit-1',
    landlordId: 'c-landlord',
    status: 'available',
    address: { line1: '412 Oak St', city: 'Atlanta', state: 'GA', zip: '30314' },
    contacts: [{ contactId: 'c-landlord', role: 'landlord', primaryContact: true }],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  } as UnitItem;
}

function contactsOf(...rows: ContactItem[]): NonNullable<RelayComposeDeps['contactsRepo']> {
  return { getById: async (id: string) => rows.find((c) => c.contactId === id) as never };
}

/** The tenant reads fine; the PROPERTY contact's read throws (P1 read_failed). */
const LANDLORD_READ_THROWS: NonNullable<RelayComposeDeps['contactsRepo']> = {
  getById: async (id: string) => {
    if (id === 'c-landlord') throw new Error('contacts-boom');
    return (id === 'c-tenant' ? TENANT : undefined) as never;
  },
};

function throws(label: string): () => Promise<never> {
  return async () => {
    throw new Error(`${label}-boom`);
  };
}

/** Deps whose every read succeeds: a future tour on a unit with a named landlord. */
function deps(
  over: Partial<RelayComposeDeps> = {},
  unit: UnitItem = unitWith(),
  tour: Record<string, unknown> = SCHEDULED_TOUR,
): RelayComposeDeps {
  return {
    toursRepo: { get: async () => tour as never },
    placementsRepo: {
      getById: async () =>
        ({ placementId: 'plc-1', tenantId: 'c-tenant', unitId: 'unit-1' }) as never,
    },
    unitsRepo: { getById: async () => unit as never },
    contactsRepo: contactsOf(TENANT, LANDLORD),
    settingsRepo: { getOrgSettings: async () => ({ timezone: NY }) as never },
    nowIso: DAY_BEFORE_NOW,
    logger: quietLogger,
    ...over,
  };
}

const OWNER_UNREADABLE = { variant: 'naked', introFallback: { reasons: ['lookup_failed'] } };

describe('resolveRelayComposeInputs - introFallback (primary-contact-integrity spec 5.1)', () => {
  describe('absent when there is nothing to explain', () => {
    it('a tour that composes its own intro carries no introFallback', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps());
      expect(inputs.variant).toBe('tour');
      expect(inputs.introFallback).toBeUndefined();
    });

    it('a placement that composes its own intro carries no introFallback', async () => {
      const inputs = await resolveRelayComposeInputs(PLACEMENT, deps());
      expect(inputs.variant).toBe('placement');
      expect(inputs.introFallback).toBeUndefined();
    });

    it('an ownerless conversation never carries it: the general intro is its only intro', async () => {
      const inputs = await resolveRelayComposeInputs(
        { type: null },
        deps({ toursRepo: { get: throws('tours') } }),
      );
      expect(inputs).toEqual({ variant: 'naked' });
    });

    it('a deleted primary next to a live landlord of record resolves past it (P1): the tour intro', async () => {
      const unit = unitWith({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: true }] });
      const deletedPm = {
        contactId: 'c-pm',
        type: 'landlord',
        firstName: 'Pat',
        deleted_at: DELETED_AT,
      } as ContactItem;
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, LANDLORD, deletedPm) }, unit),
      );
      expect(inputs.variant).toBe('tour');
      expect(inputs.propertyContactFirstName).toBe('Marcus');
      expect(inputs.introFallback).toBeUndefined();
    });
  });

  describe('the owner read decides first', () => {
    it('an owner read that THROWS is lookup_failed ALONE - and nothing else is read', async () => {
      for (const owner of [TOUR, PLACEMENT]) {
        let reads = 0;
        const count = async (): Promise<never> => {
          reads += 1;
          return undefined as never;
        };
        const inputs = await resolveRelayComposeInputs(
          owner,
          deps({
            toursRepo: { get: throws('tours') },
            placementsRepo: { getById: throws('placements') },
            unitsRepo: { getById: count },
            settingsRepo: { getOrgSettings: count },
          }),
        );
        expect(inputs, String(owner.type)).toEqual(OWNER_UNREADABLE);
        expect(reads, String(owner.type)).toBe(0);
      }
    });

    it('an owner that is MISSING, or has no repo wired, is the same: lookup_failed alone', async () => {
      const rows: [string, RelayOwner, RelayComposeDeps][] = [
        ['the tour row is gone', TOUR, deps({ toursRepo: { get: async () => undefined as never } })],
        [
          'the placement row is gone',
          PLACEMENT,
          deps({ placementsRepo: { getById: async () => undefined as never } }),
        ],
        ['no tours repo wired', TOUR, deps({ toursRepo: undefined })],
        ['no placements repo wired', PLACEMENT, deps({ placementsRepo: undefined })],
      ];
      for (const [why, owner, d] of rows) {
        expect(await resolveRelayComposeInputs(owner, d), why).toEqual(OWNER_UNREADABLE);
      }
    });
  });

  describe('an unknown unit still decides the tour reasons', () => {
    it('a unit read that THROWS: lookup_failed, with the unitId the owner named', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') } }),
      );
      expect(inputs.variant).toBe('naked');
      expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
    });

    it('a failed unit read keeps tour_not_scheduled / tour_started beside lookup_failed', async () => {
      const unscheduled = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') } }, unitWith(), UNSCHEDULED_TOUR),
      );
      expect(unscheduled.introFallback).toEqual({
        reasons: ['tour_not_scheduled', 'lookup_failed'],
        unitId: 'unit-1',
      });
      const started = await resolveRelayComposeInputs(
        TOUR,
        deps({ unitsRepo: { getById: throws('units') }, nowIso: DAY_AFTER_NOW }),
      );
      expect(started.introFallback).toEqual({
        reasons: ['tour_started', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('a MISSING unit, or no units repo wired, reads like a failed unit read', async () => {
      for (const unitsRepo of [{ getById: async () => undefined as never }, undefined]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ unitsRepo }));
        expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
      }
    });

    it('a placement on an unknown unit carries NO tour reason', async () => {
      const inputs = await resolveRelayComposeInputs(
        PLACEMENT,
        deps({ unitsRepo: { getById: throws('units') } }),
      );
      expect(inputs.introFallback).toEqual({ reasons: ['lookup_failed'], unitId: 'unit-1' });
    });
  });

  describe('each reason alone', () => {
    it('no_property_contact: no flagged primary and no landlord of record (P1 none)', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith(NO_CONTACT_UNIT)));
      expect(inputs.variant).toBe('naked');
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_deleted: the only candidate is soft-deleted', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, DELETED_LANDLORD) }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_deleted: a candidate with NO contact record reads like a deleted one', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: contactsOf(TENANT) }));
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_is_tenant: the flagged primary IS the tenant (no fall-through to the landlord)', async () => {
      const unit = unitWith({
        contacts: [{ contactId: 'c-tenant', role: 'other', primaryContact: true }],
      });
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unit));
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_is_tenant'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('property_contact_no_first_name: P1 found a contact with no first name - its id rides along', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, NAMELESS_LANDLORD) }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_no_first_name'],
        unitId: 'unit-1',
        street: '412 Oak St',
        propertyContactId: 'c-landlord',
      });
    });

    it('no_street_address: the unit has no street - and no `street` field', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith({ address: undefined })));
      expect(inputs.introFallback).toEqual({ reasons: ['no_street_address'], unitId: 'unit-1' });
    });

    it('tour_not_scheduled: a requested tour has no time', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({}, unitWith(), UNSCHEDULED_TOUR));
      expect(inputs.introFallback).toEqual({
        reasons: ['tour_not_scheduled'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('tour_started: at or after the start instant', async () => {
      for (const nowIso of [TOUR_AT, DAY_AFTER_NOW]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ nowIso }));
        expect(inputs.introFallback, nowIso).toEqual({
          reasons: ['tour_started'],
          unitId: 'unit-1',
          street: '412 Oak St',
        });
      }
    });

    it('lookup_failed: a THROWN property-contact read (P1 read_failed) is never read as absence', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: LANDLORD_READ_THROWS }));
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('lookup_failed: no contacts repo wired (the lookup cannot run)', async () => {
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo: undefined }));
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('lookup_failed: the settings read THROWS, answers nothing, or is not wired', async () => {
      for (const settingsRepo of [
        { getOrgSettings: throws('settings') },
        { getOrgSettings: async () => undefined as never },
        undefined,
      ]) {
        const inputs = await resolveRelayComposeInputs(TOUR, deps({ settingsRepo }));
        expect(inputs.introFallback).toEqual({
          reasons: ['lookup_failed'],
          unitId: 'unit-1',
          street: '412 Oak St',
        });
      }
    });

    it('lookup_failed: an unformattable tour time', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({}, unitWith(), { ...SCHEDULED_TOUR, scheduledAt: 'not-a-date' }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('a failed TENANT read is NOT a reason: the tour intro still composes', async () => {
      const contactsRepo: NonNullable<RelayComposeDeps['contactsRepo']> = {
        getById: async (id: string) => {
          if (id === 'c-tenant') throw new Error('tenant-boom');
          return (id === 'c-landlord' ? LANDLORD : undefined) as never;
        },
      };
      const inputs = await resolveRelayComposeInputs(TOUR, deps({ contactsRepo }));
      expect(inputs.variant).toBe('tour');
      expect(inputs.tenantFirstName).toBeUndefined();
      expect(inputs.introFallback).toBeUndefined();
    });
  });

  describe('every check is evaluated, reported in the spec order', () => {
    it('reports in SPEC order, not evaluation order', async () => {
      // Evaluated: tour_started first (the owner read), lookup_failed next (P1),
      // no_street_address last. Reported: the spec's order.
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: LANDLORD_READ_THROWS, nowIso: DAY_AFTER_NOW }, unitWith({ address: undefined })),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_street_address', 'tour_started', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('does not stop at the first miss: no contact AND a failed settings read are both reported', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ settingsRepo: { getOrgSettings: throws('settings') } }, unitWith(NO_CONTACT_UNIT)),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact', 'lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });

    it('no first name + no street + not scheduled', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({ contactsRepo: contactsOf(TENANT, NAMELESS_LANDLORD) }, unitWith({ address: undefined }), UNSCHEDULED_TOUR),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_no_first_name', 'no_street_address', 'tour_not_scheduled'],
        unitId: 'unit-1',
        propertyContactId: 'c-landlord',
      });
    });

    it('a deleted contact + no street + an unformattable time', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps(
          { contactsRepo: contactsOf(TENANT, DELETED_LANDLORD) },
          unitWith({ address: undefined }),
          { ...SCHEDULED_TOUR, scheduledAt: 'not-a-date' },
        ),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['property_contact_deleted', 'no_street_address', 'lookup_failed'],
        unitId: 'unit-1',
      });
    });

    it('lookup_failed is reported ONCE however many reads fail', async () => {
      const inputs = await resolveRelayComposeInputs(
        TOUR,
        deps({
          contactsRepo: { getById: throws('contacts') },
          settingsRepo: { getOrgSettings: throws('settings') },
        }),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['lookup_failed'],
        unitId: 'unit-1',
        street: '412 Oak St',
      });
    });
  });

  describe('placements', () => {
    it('never carry a tour reason, and never read settings', async () => {
      let settingsReads = 0;
      const inputs = await resolveRelayComposeInputs(
        PLACEMENT,
        deps(
          {
            settingsRepo: {
              getOrgSettings: async () => {
                settingsReads += 1;
                return { timezone: NY } as never;
              },
            },
            nowIso: DAY_AFTER_NOW,
          },
          unitWith({ ...NO_CONTACT_UNIT, address: undefined }),
        ),
      );
      expect(inputs.introFallback).toEqual({
        reasons: ['no_property_contact', 'no_street_address'],
        unitId: 'unit-1',
      });
      expect(settingsReads).toBe(0);
    });
  });

  it('the member-added role is still resolved when the intro falls back', async () => {
    const inputs = await resolveRelayComposeInputs(
      TOUR,
      deps({}, unitWith({ address: undefined })),
      'c-landlord',
    );
    expect(inputs.variant).toBe('naked');
    expect(inputs.role).toBe('landlord');
  });

  it('NEVER throws: every read failing at once answers lookup_failed', async () => {
    const allThrow: Partial<RelayComposeDeps> = {
      toursRepo: { get: throws('tours') },
      placementsRepo: { getById: throws('placements') },
      unitsRepo: { getById: throws('units') },
      contactsRepo: { getById: throws('contacts') },
      settingsRepo: { getOrgSettings: throws('settings') },
    };
    for (const owner of [TOUR, PLACEMENT]) {
      expect(await resolveRelayComposeInputs(owner, deps(allThrow)), String(owner.type)).toEqual(
        OWNER_UNREADABLE,
      );
    }
  });
});
