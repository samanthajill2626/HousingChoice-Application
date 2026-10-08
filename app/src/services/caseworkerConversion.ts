// The caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D19, D21, D22; plan 3.4). ONE server function behind ONE route
// (routes/caseworkerReview.ts), and the ONLY way an existing contact becomes a
// caseworker - a `partner` whose role satisfies isCaseworkerRole. The contacts
// PATCH refuses that write (409 caseworker_use_conversion), so this service
// owns its whole write: the refusals, the fenced commit, the suggestions, the
// threads, and the PATCH's side effects. `preview` runs the same reads and
// writes nothing. Errors are codes; the dashboard owns every sentence (D22).
import { isCaseworker, type PossibleSignal } from '../lib/caseworkers.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createAiRunsRepo, type AiRunsRepo } from '../repos/aiRunsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactVocabularyRepo, type ContactVocabularyRepo } from '../repos/contactVocabularyRepo.js';
import {
  createContactsRepo,
  isDeleted,
  type ContactItem,
  type ContactsRepo,
  type ContactType,
} from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationType,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createExtractionRepo, type ExtractionRepo } from '../repos/extractionRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createUnitsRepo, unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { createOrgNamesService, type OrgNamesService } from './orgNames.js';

// --- Wire types (plan 3.2; mirrored field-for-field in dashboard/src/api/types.ts)

export type CaseworkerRefusal =
  | { code: 'caseworker_open_placement'; placementId: string }
  | { code: 'caseworker_open_tour'; tourId: string }
  | { code: 'caseworker_landlord_of_record'; unitId: string }
  | { code: 'caseworker_on_roster'; unitId: string };
// One entry per blocking record, ordered placement, tour, landlord, roster.

export type OrganizationSource = 'request' | 'stored' | 'list_match' | 'carried' | 'none';

export interface CaseworkerPreview {
  contactId: string;
  alreadyCaseworker: boolean;
  refusals: CaseworkerRefusal[];
  removes: { housingAuthority?: string; agency?: string; pendingSuggestions: number };
  threads: { retype: number; leftShared: number; leftOther: number };
  //   leftShared = another live contact holds the phone/address, or the
  //   thread's participant contactId is another contact; leftOther = an open
  //   one-to-one row with no type (R1-F15)
  organization: { value?: string; source: Exclude<OrganizationSource, 'request'> };
}

export interface PossibleCaseworkerRow {
  contactId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  type: 'tenant' | 'landlord' | 'partner';
  role?: string;
  signals: PossibleSignal[]; // non-empty, in PossibleSignal declaration order
}

export class CaseworkerReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'CaseworkerReviewError';
  }
}

export interface CaseworkerConversionService {
  preview(contactId: string): Promise<CaseworkerPreview>;
  make(contactId: string, input: { organization?: string; actor: string }): Promise<ContactItem>;
  dismiss(contactId: string, actor: string): Promise<ContactItem>;
}

/**
 * The repos and buses the contacts PATCH already uses for the same effects.
 * Every dep optional with the real default (A's createOrgNamesService idiom).
 */
export interface CaseworkerConversionDeps {
  contacts?: ContactsRepo;
  conversations?: ConversationsRepo;
  placements?: PlacementsRepo;
  tours?: ToursRepo;
  units?: UnitsRepo;
  extraction?: ExtractionRepo;
  aiRuns?: AiRunsRepo;
  audit?: AuditRepo;
  activityEvents?: ActivityEventsRepo;
  vocabulary?: ContactVocabularyRepo;
  events?: EventBus;
  orgNames?: OrgNamesService;
  logger?: Logger;
  /** The clock: caseworker_conversion.at and the verdict stamps. */
  now?: () => Date;
}

const CONTACT_TYPES: ReadonlySet<string> = new Set<ContactType>([
  'tenant', 'landlord', 'partner', 'team_member', 'unknown',
]);

/** D19: requested, scheduled, toured or no_show; canceled and closed are resolved. */
const OPEN_TOUR_STATUSES: ReadonlySet<string> = new Set(['requested', 'scheduled', 'toured', 'no_show']);

/** A stored string attribute, or undefined when absent or empty. */
function held(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The step-3 classification of the contact's threads (D21's conversion rule). */
interface ThreadPlan {
  retype: Array<{ conv: ConversationItem; readType: ConversationType }>;
  leftShared: number;
  leftOther: number;
}

export function createCaseworkerConversionService(
  deps: CaseworkerConversionDeps = {},
): CaseworkerConversionService {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contacts ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversations ?? createConversationsRepo({ logger: deps.logger });
  const placements = deps.placements ?? createPlacementsRepo({ logger: deps.logger });
  const tours = deps.tours ?? createToursRepo({ logger: deps.logger });
  const units = deps.units ?? createUnitsRepo({ logger: deps.logger });
  const extraction = deps.extraction ?? createExtractionRepo({ logger: deps.logger });
  const aiRuns = deps.aiRuns ?? createAiRunsRepo({ logger: deps.logger });
  const audit = deps.audit ?? createAuditRepo({ logger: deps.logger });
  const activityEvents = deps.activityEvents ?? createActivityEventsRepo({ logger: deps.logger });
  const vocabulary = deps.vocabulary ?? createContactVocabularyRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const orgNames = deps.orgNames ?? createOrgNamesService({ logger: deps.logger });
  const now = deps.now ?? (() => new Date());

  /**
   * Rule 1: a CONSISTENT read. Missing, a phone/email pointer row (R1-F1: a
   * routing record, never a contact - the FakeWorld's pointer sentinel type
   * 'unknown' must not let one through), a type outside ContactType, or a
   * soft-deleted contact -> 404; a team member -> 400.
   */
  async function readSubject(contactId: string): Promise<ContactItem> {
    const c = await contacts.getById(contactId, { consistentRead: true });
    if (
      c === undefined
      || c.phone_ref === true
      || c.email_ref === true
      || !CONTACT_TYPES.has(c.type as string)
      || isDeleted(c)
    ) {
      throw new CaseworkerReviewError(404, 'contact_not_found');
    }
    if (c.type === 'team_member') throw new CaseworkerReviewError(400, 'caseworker_team_member');
    return c;
  }

  /**
   * Rule 3: every blocking record, kinds in order placement, tour, landlord,
   * roster, ids ascending within a kind. Soft-deleted units count (D22): a
   * restored unit must not come back with a caseworker as its landlord or on
   * its roster. One entry per unit: a landlord of record is not ALSO a roster
   * seat (unitContacts derives a landlord row from landlordId).
   */
  async function collectRefusals(contactId: string): Promise<CaseworkerRefusal[]> {
    const placementIds: string[] = [];
    let placementKey: Record<string, unknown> | undefined;
    do {
      const page = await placements.listByTenant(contactId, {
        ...(placementKey !== undefined && { exclusiveStartKey: placementKey }),
      });
      for (const p of page.items) if (!TERMINAL_STAGES.has(p.stage)) placementIds.push(p.placementId);
      placementKey = page.lastEvaluatedKey;
    } while (placementKey !== undefined);

    const tourIds = (await tours.listByTenant(contactId))
      .filter((t) => OPEN_TOUR_STATUSES.has(t.status))
      .map((t) => t.tourId);

    const landlordUnitIds = new Set<string>();
    let landlordKey: Record<string, unknown> | undefined;
    do {
      const page = await units.listByLandlord(contactId, {
        deleted: 'any',
        ...(landlordKey !== undefined && { exclusiveStartKey: landlordKey }),
      });
      for (const u of page.items) landlordUnitIds.add(u.unitId);
      landlordKey = page.lastEvaluatedKey;
    } while (landlordKey !== undefined);

    // One Scan of every unit, live and deleted (no roster index; D19 accepts
    // the cost at today's unit count, filed in section 12).
    const rosterUnitIds: string[] = [];
    let scanKey: Record<string, unknown> | undefined;
    do {
      const page = await units.list({
        deleted: 'any',
        ...(scanKey !== undefined && { exclusiveStartKey: scanKey }),
      });
      for (const u of page.items) {
        if (landlordUnitIds.has(u.unitId)) continue;
        if (unitContacts(u).some((seat) => seat.contactId === contactId)) rosterUnitIds.push(u.unitId);
      }
      scanKey = page.lastEvaluatedKey;
    } while (scanKey !== undefined);

    const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return [
      ...placementIds.sort(byId).map((placementId) => ({ code: 'caseworker_open_placement' as const, placementId })),
      ...tourIds.sort(byId).map((tourId) => ({ code: 'caseworker_open_tour' as const, tourId })),
      ...[...landlordUnitIds].sort(byId).map((unitId) => ({ code: 'caseworker_landlord_of_record' as const, unitId })),
      ...rosterUnitIds.sort(byId).map((unitId) => ({ code: 'caseworker_on_roster' as const, unitId })),
    ];
  }

  /** Rule 4 without a request: stored, else derived (plan Task 3.3). */
  async function storedOrDerived(
    _c: ContactItem,
  ): Promise<{ value?: string; source: Exclude<OrganizationSource, 'request'> }> {
    return { source: 'none' };
  }

  /** Step 3's classification, read-only (plan Task 3.4). */
  async function planThreads(_c: ContactItem): Promise<ThreadPlan> {
    return { retype: [], leftShared: 0, leftOther: 0 };
  }

  return {
    async preview(contactId) {
      const c = await readSubject(contactId);
      const alreadyCaseworker = isCaseworker(c);
      const pendingSuggestions = (await extraction.listSuggestionsByContact(contactId)).length;
      const plan = await planThreads(c);
      const threads = { retype: plan.retype.length, leftShared: plan.leftShared, leftOther: plan.leftOther };
      if (alreadyCaseworker) {
        // make on a caseworker re-runs steps 2-4 only: no refusals, no
        // commit, so nothing but the pending suggestions is removed.
        const org = held(c['organization']);
        return {
          contactId,
          alreadyCaseworker,
          refusals: [],
          removes: { pendingSuggestions },
          threads,
          organization: org !== undefined ? { value: org, source: 'stored' } : { source: 'none' },
        };
      }
      const housingAuthority = held(c['housingAuthority']);
      const agency = held(c['agency']);
      return {
        contactId,
        alreadyCaseworker,
        refusals: await collectRefusals(contactId),
        removes: {
          ...(housingAuthority !== undefined && { housingAuthority }),
          ...(agency !== undefined && { agency }),
          pendingSuggestions,
        },
        threads,
        organization: await storedOrDerived(c),
      };
    },

    async make() {
      throw new Error('caseworker make: plan Task 3.5');
    },

    async dismiss() {
      throw new Error('caseworker dismiss: plan Task 3.7');
    },
  };
}
