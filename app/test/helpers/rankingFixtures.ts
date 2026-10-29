// WP1 B2a S3 (plan section 7): records and an in-memory world for the ranking
// suites. The fakes implement EXACTLY the repo methods services/ranking/pool.ts
// and assemble.ts call (their deps are Pick types), behaving as the repos do:
// listByType / listByStatus page (two items a page here, so every walk
// pages) and hide soft-deleted rows; listByContact returns only LISTED rows
// (counted and carrying sentAt, listingSendsRepo isListed); getManyByIds
// answers the ids it found and, with requireComplete, THROWS
// IncompleteBatchReadError for an id in `incompleteIds` (keys left
// unprocessed after the retries). Made-up people and addresses only; no
// DynamoDB, no network.
import { createLogger } from '../../src/lib/logger.js';
import type { OrgEntry } from '../../src/lib/orgNames.js';
import {
  IncompleteBatchReadError,
  type ContactItem,
  type ContactType,
  type ContactsPage,
  type ListContactsOpts,
} from '../../src/repos/contactsRepo.js';
import type { ListingSendItem, ShareLedgerEntry } from '../../src/repos/listingSendsRepo.js';
import type { OrgListItem } from '../../src/repos/orgListRepo.js';
import type { TourItem } from '../../src/repos/toursRepo.js';
import type { ListUnitsOpts, UnitItem, UnitsPage } from '../../src/repos/unitsRepo.js';
import { ATLANTA, AUGUSTA, DCA, STEP_UP, VASH } from './orgFixtures.js';

export const NOW = new Date('2026-10-28T12:00:00.000Z');
export const DAY_MS = 86_400_000;
/** The org fixtures: AHA is a spelling Atlanta and Augusta share (ambiguous). */
export const ORG_ENTRIES: readonly OrgEntry[] = [ATLANTA, AUGUSTA, DCA, VASH, STEP_UP];

/** ISO instant `days` before NOW (a negative value is after NOW). */
export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** A searching, sendable, consented tenant of voucher size 2 with the Atlanta authority, heard from 3 days ago. */
export function tenant(contactId: string, extra: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId,
    type: 'tenant',
    status: 'searching',
    phone: '+14045550100',
    firstName: 'Pat',
    lastName: contactId,
    voucherSize: 2,
    housingAuthority: ATLANTA.name,
    consent_method: 'verbal_phone',
    created_at: daysAgo(40),
    last_heard_from_at: daysAgo(3),
    ...extra,
  };
}

/** An available 2-bed unit accepting the Atlanta authority, labeled `<unitId> Main St, Decatur`. */
export function unit(unitId: string, extra: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId,
    landlordId: 'contact-landlord-1',
    status: 'available',
    address: { line1: `${unitId} Main St`, city: 'Decatur', state: 'GA', zip: '30030' },
    beds: 2,
    accepted_authorities: [ATLANTA.name],
    rent_min: 1400,
    rent_max: 1500,
    created_at: daysAgo(60),
    ...extra,
  };
}

/** A listed listing_sends row with one counted share per entry (`key` defaults to a broadcast id; FLYER_SHARE_KEY for a sign-up). */
export function sendRow(
  unitId: string,
  contactId: string,
  shares: readonly { at: string; key?: string }[],
  extra: Partial<ListingSendItem> = {},
): ListingSendItem {
  const entries: Record<string, ShareLedgerEntry> = {};
  shares.forEach((share, index) => {
    entries[share.key ?? `bcast-${index + 1}`] = {
      attempt: `${share.at}#a${index + 1}`,
      state: 'counted',
      by: 'acceptance',
      countedAt: share.at,
    };
  });
  const instants = shares.map((share) => share.at).sort();
  const latest = instants[instants.length - 1];
  return {
    unitId,
    contactId,
    via: 'broadcast',
    created_at: instants[0] ?? NOW.toISOString(),
    updated_at: latest ?? NOW.toISOString(),
    counted: true,
    shares: entries,
    ...(latest !== undefined && { sentAt: latest }),
    ...extra,
  };
}

/** A legacy row: no share memory, `sentAt` only (reads as counted). */
export function legacySendRow(unitId: string, contactId: string, sentAt: string, extra: Partial<ListingSendItem> = {}): ListingSendItem {
  return { unitId, contactId, via: 'individual', sentAt, created_at: sentAt, updated_at: sentAt, ...extra };
}

/** A scheduled landlord-led tour created 5 days ago for 2 days ahead. */
export function tourRow(tourId: string, tenantId: string, unitId: string, extra: Partial<TourItem> = {}): TourItem {
  return {
    tourId,
    tenantId,
    unitId,
    _schedPartition: 'tours',
    tourType: 'landlord_led',
    status: 'scheduled',
    scheduledAt: daysAgo(-2),
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
    ...extra,
  };
}

/** The ranking config fields the pool and the gatherer read (AppConfig names, plan PR4). */
export interface RankingTestConfig {
  rankingPoolWindowDays: number;
  rankingMaxPool: number;
  rankingReadConcurrency: number;
  rankingSeenMax: number;
  rankingLandlordCard: boolean;
}

export const DEFAULT_TEST_CONFIG: RankingTestConfig = Object.freeze({
  rankingPoolWindowDays: 90,
  rankingMaxPool: 300,
  rankingReadConcurrency: 4,
  rankingSeenMax: 8,
  rankingLandlordCard: false,
});

export interface WorldSeed {
  contacts?: readonly ContactItem[];
  units?: readonly UnitItem[];
  sends?: readonly ListingSendItem[];
  tours?: readonly TourItem[];
  /** Active placements: the unit is committed to `tenantId`. */
  activePlacements?: readonly { unitId: string; tenantId: string }[];
  orgEntries?: readonly OrgEntry[];
  config?: Partial<RankingTestConfig>;
}

function isGone(row: { deleted_at?: unknown }): boolean {
  return typeof row.deleted_at === 'string' && row.deleted_at.length > 0;
}

function page<T>(rows: readonly T[], opts: { limit?: number; exclusiveStartKey?: Record<string, unknown> }): { items: T[]; lastEvaluatedKey?: Record<string, unknown> } {
  const raw = opts.exclusiveStartKey?.['offset'];
  const start = typeof raw === 'number' ? raw : 0;
  const size = Math.min(opts.limit ?? 2, 2);
  const next = start + size;
  return { items: rows.slice(start, next), ...(next < rows.length && { lastEvaluatedKey: { offset: next } }) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-memory world: mutate `state` to stage a case, read `calls` to assert what was read. */
export function rankingWorld(seed: WorldSeed = {}) {
  const state = {
    contacts: new Map((seed.contacts ?? []).map((c) => [c.contactId, c] as const)),
    units: new Map((seed.units ?? []).map((u) => [u.unitId, u] as const)),
    sends: [...(seed.sends ?? [])],
    tours: [...(seed.tours ?? [])],
    activePlacements: [...(seed.activePlacements ?? [])],
    orgEntries: [...(seed.orgEntries ?? ORG_ENTRIES)],
    /** Ids (unit or contact) a requireComplete batch read cannot finish. */
    incompleteIds: new Set<string>(),
    /** Contact ids whose listByContact throws. */
    failingSendReads: new Set<string>(),
    /** Tenant ids whose listByTenant throws. */
    failingTourReads: new Set<string>(),
    orgListFails: false,
    /** true: the list fakes hand back soft-deleted rows too (the pool's belt). */
    leakDeletedInLists: false,
    /** A delay inside every listByContact, so concurrency can be observed. */
    sendReadDelayMs: 0,
  };
  const calls = {
    placementChecks: [] as [string, string][],
    listByContact: [] as string[],
    unitBatchReads: [] as string[][],
    contactBatchReads: [] as string[][],
    inFlightSendReads: 0,
    maxInFlightSendReads: 0,
  };
  const config: RankingTestConfig = { ...DEFAULT_TEST_CONFIG, ...seed.config };

  const deps = {
    contacts: {
      async getById(contactId: string): Promise<ContactItem | undefined> {
        return state.contacts.get(contactId);
      },
      async listByType(type: ContactType, opts: ListContactsOpts = {}): Promise<ContactsPage> {
        const rows = [...state.contacts.values()].filter(
          (c) => c.type === type && (opts.status === undefined || c.status === opts.status) && (state.leakDeletedInLists || !isGone(c)),
        );
        return page(rows, opts);
      },
      async getManyByIds(ids: string[], opts?: { requireComplete?: boolean }): Promise<Map<string, ContactItem>> {
        calls.contactBatchReads.push([...ids]);
        if (opts?.requireComplete === true && ids.some((id) => state.incompleteIds.has(id))) {
          throw new IncompleteBatchReadError(1, ids.length);
        }
        const out = new Map<string, ContactItem>();
        for (const id of ids) {
          const found = state.contacts.get(id);
          if (found !== undefined && !state.incompleteIds.has(id)) out.set(id, found);
        }
        return out;
      },
    },
    units: {
      async getById(unitId: string): Promise<UnitItem | undefined> {
        return state.units.get(unitId);
      },
      async listByStatus(status: string, opts: ListUnitsOpts = {}): Promise<UnitsPage> {
        const rows = [...state.units.values()].filter((u) => u.status === status && (state.leakDeletedInLists || !isGone(u)));
        return page(rows, opts);
      },
      async getManyByIds(ids: string[], opts?: { requireComplete?: boolean }): Promise<Map<string, UnitItem>> {
        calls.unitBatchReads.push([...ids]);
        if (opts?.requireComplete === true && ids.some((id) => state.incompleteIds.has(id))) {
          throw new IncompleteBatchReadError(1, ids.length, 'units');
        }
        const out = new Map<string, UnitItem>();
        for (const id of ids) {
          const found = state.units.get(id);
          if (found !== undefined && !state.incompleteIds.has(id)) out.set(id, found);
        }
        return out;
      },
    },
    placements: {
      async hasActivePlacementForOtherTenant(unitId: string, tenantId: string): Promise<boolean> {
        calls.placementChecks.push([unitId, tenantId]);
        return state.activePlacements.some((p) => p.unitId === unitId && p.tenantId !== tenantId);
      },
    },
    listingSends: {
      async listByContact(contactId: string): Promise<ListingSendItem[]> {
        calls.listByContact.push(contactId);
        calls.inFlightSendReads += 1;
        calls.maxInFlightSendReads = Math.max(calls.maxInFlightSendReads, calls.inFlightSendReads);
        try {
          if (state.sendReadDelayMs > 0) await sleep(state.sendReadDelayMs);
          if (state.failingSendReads.has(contactId)) throw new Error('listByContact failed');
          return state.sends.filter((r) => r.contactId === contactId && r.counted !== false && typeof r.sentAt === 'string');
        } finally {
          calls.inFlightSendReads -= 1;
        }
      },
    },
    tours: {
      async listByTenant(tenantId: string): Promise<TourItem[]> {
        if (state.failingTourReads.has(tenantId)) throw new Error('listByTenant failed');
        return state.tours.filter((t) => t.tenantId === tenantId);
      },
    },
    orgNames: {
      async read(): Promise<OrgListItem> {
        if (state.orgListFails) throw new Error('organization list read failed');
        return { settingId: 'org-list', version: 1, entries: [...state.orgEntries] };
      },
    },
    config,
    logger: createLogger({ level: 'silent' }),
  };
  return { state, calls, deps };
}
