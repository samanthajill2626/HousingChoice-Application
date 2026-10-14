// Unit tests for lib/propertyContact.ts part 1 (primary-contact-integrity spec
// 4.2 / 4.3, plan contract 2.1): the automatic-routing eligibility rule (moved
// verbatim from routes/units.ts), the ids the liveness read covers, and the
// liveness read itself. PURE - in-memory fakes, no DynamoDB.
import { describe, expect, it, vi } from 'vitest';
import {
  isAutoRoutingEligible,
  readRosterContacts,
  rosterContactIds,
} from '../src/lib/propertyContact.js';
import { createLogger } from '../src/lib/logger.js';
import { IncompleteBatchReadError, type ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

type RosterUnit = Pick<UnitItem, 'contacts' | 'landlordId'>;
const contact = (o: Record<string, unknown>): ContactItem => o as unknown as ContactItem;
const unit = (o: Record<string, unknown>): RosterUnit => o as unknown as RosterUnit;

describe('isAutoRoutingEligible (spec 4.3 - the ONE automatic-routing rule)', () => {
  it('is true for an existing, live, landlord-typed, non-pointer contact', () => {
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'landlord' }))).toBe(true);
    // An EMPTY deleted_at stamp is not a soft delete (contactsRepo isDeleted).
    expect(
      isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'landlord', deleted_at: '' })),
    ).toBe(true);
  });

  it('is false for a missing, soft-deleted, non-landlord or routing-pointer contact', () => {
    expect(isAutoRoutingEligible(undefined)).toBe(false);
    expect(
      isAutoRoutingEligible(
        contact({ contactId: 'c-1', type: 'landlord', deleted_at: '2026-10-01T00:00:00.000Z' }),
      ),
    ).toBe(false);
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'tenant' }))).toBe(false);
    expect(
      isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'partner', role: 'Caseworker' })),
    ).toBe(false);
    expect(isAutoRoutingEligible(contact({ contactId: 'c-1', type: 'unknown' }))).toBe(false);
    expect(
      isAutoRoutingEligible(
        contact({ contactId: 'phoneref#+15550100001', type: 'landlord', phone_ref: true }),
      ),
    ).toBe(false);
    expect(
      isAutoRoutingEligible(contact({ contactId: 'emailref#a@b.co', type: 'landlord', email_ref: true })),
    ).toBe(false);
  });
});

describe('rosterContactIds (spec 4.2 - the ids the liveness read covers)', () => {
  it('lists every roster row in order, then an OFF-roster landlord of record', () => {
    expect(
      rosterContactIds(
        unit({
          landlordId: 'c-ll',
          contacts: [
            { contactId: 'c-pm', role: 'pm', primaryContact: true },
            { contactId: 'c-owner', role: 'owner', primaryContact: false },
          ],
        }),
      ),
    ).toEqual(['c-pm', 'c-owner', 'c-ll']);
  });

  it('de-duplicates a landlord of record that already has a row', () => {
    expect(
      rosterContactIds(
        unit({
          landlordId: 'c-ll',
          contacts: [
            { contactId: 'c-ll', role: 'landlord', primaryContact: true },
            { contactId: 'c-pm', role: 'pm', primaryContact: false },
          ],
        }),
      ),
    ).toEqual(['c-ll', 'c-pm']);
  });

  it('covers a landlord-only unit through its DERIVED row (no stored roster)', () => {
    expect(rosterContactIds(unit({ landlordId: 'c-ll' }))).toEqual(['c-ll']);
  });

  it('drops an empty or absent landlordId', () => {
    expect(rosterContactIds(unit({ landlordId: '', contacts: [] }))).toEqual([]);
    expect(
      rosterContactIds(unit({ contacts: [{ contactId: 'c-pm', role: 'pm', primaryContact: false }] })),
    ).toEqual(['c-pm']);
  });
});

describe('readRosterContacts (spec 4.2 - ONE complete batch read; ANY throw = unknown)', () => {
  it('reads the de-duplicated, non-empty ids ONCE with requireComplete', async () => {
    const ll = contact({ contactId: 'c-ll', type: 'landlord' });
    const getManyByIds = vi.fn(
      async (_ids: string[], _opts?: { requireComplete?: boolean }) => new Map([['c-ll', ll]]),
    );
    const read = await readRosterContacts({ getManyByIds }, ['c-ll', undefined, '', 'c-pm', 'c-ll']);
    expect(getManyByIds).toHaveBeenCalledTimes(1);
    expect(getManyByIds).toHaveBeenCalledWith(['c-ll', 'c-pm'], { requireComplete: true });
    expect(read).toEqual({ ok: true, byId: new Map([['c-ll', ll]]) });
  });

  // Planner fix wave F5a (Cameron 2026-10-13): the restore paths ask for a
  // STRONGLY CONSISTENT read; every other caller keeps the default above.
  it('passes consistentRead to the batch read when asked - and only then', async () => {
    const getManyByIds = vi.fn(
      async (_ids: string[], _opts?: { requireComplete?: boolean; consistentRead?: boolean }) =>
        new Map<string, ContactItem>(),
    );
    await readRosterContacts({ getManyByIds }, ['c-ll'], undefined, { consistentRead: true });
    await readRosterContacts({ getManyByIds }, ['c-ll'], undefined, { consistentRead: false });
    await readRosterContacts({ getManyByIds }, ['c-ll'], undefined, {});
    await readRosterContacts({ getManyByIds }, ['c-ll']);
    expect(getManyByIds.mock.calls).toStrictEqual([
      [['c-ll'], { requireComplete: true, consistentRead: true }],
      [['c-ll'], { requireComplete: true }],
      [['c-ll'], { requireComplete: true }],
      [['c-ll'], { requireComplete: true }],
    ]);
  });

  it('reads nothing at all for no usable ids', async () => {
    const getManyByIds = vi.fn(
      async (_ids: string[], _opts?: { requireComplete?: boolean }) => new Map<string, ContactItem>(),
    );
    expect(await readRosterContacts({ getManyByIds }, [undefined, ''])).toEqual({
      ok: true,
      byId: new Map(),
    });
    expect(getManyByIds).not.toHaveBeenCalled();
  });

  it('a RAW chunk error is liveness UNKNOWN (ok: false), never a throw - logged with a count only', async () => {
    const capture = createLogCapture();
    const read = await readRosterContacts(
      {
        getManyByIds: async () => {
          throw new Error('dynamodb: ProvisionedThroughputExceededException');
        },
      },
      ['c-ll'],
      createLogger({ destination: capture.stream }),
    );
    expect(read).toEqual({ ok: false });
    const warns = capture.atLevel(40);
    expect(warns.map((line) => line['msg'])).toEqual([
      'property contact: roster liveness read failed - liveness unknown',
    ]);
    expect(warns[0]?.['requested']).toBe(1);
  });

  it('an IncompleteBatchReadError is liveness UNKNOWN too (spec 4.2: BOTH failure shapes)', async () => {
    const read = await readRosterContacts(
      {
        getManyByIds: async () => {
          throw new IncompleteBatchReadError(1, 2);
        },
      },
      ['c-ll', 'c-pm'],
      createLogger({ destination: createLogCapture().stream }),
    );
    expect(read).toEqual({ ok: false });
  });
});
