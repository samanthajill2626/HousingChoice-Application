// The caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D19, D21, D22; plan 3.4). ONE server function behind ONE route
// (routes/caseworkerReview.ts), and the ONLY way an existing contact becomes a
// caseworker - a `partner` whose role satisfies isCaseworkerRole. The contacts
// PATCH refuses that write (409 caseworker_use_conversion), so this service
// owns its whole write: the refusals, the fenced commit, the suggestions, the
// threads, and the PATCH's side effects. `preview` runs the same reads and
// writes nothing. Errors are codes; the dashboard owns every sentence (D22).
import { KINDS_FOR_FIELD, ORG_NAME_MAX, normalizeOrgText, resolveOrgText, type OrgEntry } from '../lib/orgNames.js';
import { conversationsForContact } from '../lib/contactThreads.js';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { CASEWORKER_ROLE } from './extraction/contactKinds.js';
import { isCaseworker, type PossibleSignal } from '../lib/caseworkers.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { TERMINAL_STAGES } from '../lib/statusModel.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createAiRunsRepo, type AiRunsRepo } from '../repos/aiRunsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactVocabularyRepo, type ContactVocabularyRepo } from '../repos/contactVocabularyRepo.js';
import {
  createContactsRepo,
  isDeleted,
  type CaseworkerConversionRecord,
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
import { createExtractionRepo, type ExtractionRepo, type SuggestionItem } from '../repos/extractionRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import { createUnitsRepo, unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { displayNameOf, drainTypeSuggestion, supersedePendingSuggestion, type SuggestionEffectDeps } from './contactClassification.js';
import { createOrgNamesService, hasOrgControlChar, type OrgNamesService } from './orgNames.js';

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

/** The one-to-one types the conversion re-types (partner_1to1 is already done; groups never). */
const RETYPABLE_TYPES: ReadonlySet<string> = new Set(['tenant_1to1', 'landlord_1to1', 'unknown_1to1']);

/** A stored string attribute, or undefined when absent or empty. */
function held(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * R2-F7: carried text passes D13's limits - no control or invisible
 * characters, at most ORG_NAME_MAX, not empty after normalization. NOT
 * checkNewOrgName: a TAKEN or COMPOUND text is carried (settled later with
 * Use or Clear in Settings' "Not on the list").
 */
function carriable(text: string): boolean {
  return !hasOrgControlChar(text) && text.length <= ORG_NAME_MAX && normalizeOrgText(text) !== '';
}

/** D19 derivation from one text: a list match over both kinds, else carried, else none. */
function deriveOrganization(
  entries: readonly OrgEntry[],
  text: string,
): { value?: string; source: 'list_match' | 'carried' | 'none' } {
  const r = resolveOrgText(entries, text, KINDS_FOR_FIELD.organization);
  if (r.status === 'match') return { value: r.entry.name, source: 'list_match' };
  return carriable(text) ? { value: text, source: 'carried' } : { source: 'none' };
}

/**
 * One clause of the commit guard (D19 step 1, R1-F3): the attribute AS READ -
 * its raw value (a number for the revision, never the folded 0 of
 * contactClassificationRevision), or null = attribute_not_exists when absent.
 * Any other stored shape becomes null, which fails the condition: a loud 409,
 * never a silent overwrite.
 */
function clause(attr: string, raw: unknown): { attr: string; value: string | number | null } {
  return { attr, value: typeof raw === 'string' || typeof raw === 'number' ? raw : null };
}

/** The milestone arrow, kept out of the source as a character code (ASCII rule). */
const ARROW = String.fromCharCode(0x2192);

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

  /**
   * Rule 4 without a request: the stored organization; else the agency text
   * whenever the contact has one (the employer is the helper organization -
   * Cameron 2026-10-07); only with no agency, the housing authority text.
   * One list read, only when deriving.
   */
  async function storedOrDerived(
    c: ContactItem,
  ): Promise<{ value?: string; source: Exclude<OrganizationSource, 'request'> }> {
    const stored = held(c['organization']);
    if (stored !== undefined) return { value: stored, source: 'stored' };
    // C2: D19 carries raw text as written; invalid nonempty agency never falls back.
    const agency = held(c['agency']);
    const authority = held(c['housingAuthority']);
    const text = agency ?? authority;
    if (text === undefined || text === '') return { source: 'none' };
    const { entries } = await orgNames.read();
    return deriveOrganization(entries, text);
  }

  /**
   * D21's conversion rule, read-only: the contact's OPEN one-to-one threads on
   * EVERY phone and email (conversationsForContact) not yet partner_1to1.
   * A thread is the contact's own only when its participant contactId, when
   * set, is the contact AND no other live contact holds its phone or address
   * (findAllByPhone / findAllByEmail: every holder, pointer rows resolved,
   * deleted excluded - findByPhone returns ONE arbitrary holder and cannot
   * decide this). A type-less open row is left and counted (R1-F15). The
   * read type is captured so the write is conditional on it.
   */
  async function planThreads(c: ContactItem): Promise<ThreadPlan> {
    const plan: ThreadPlan = { retype: [], leftShared: 0, leftOther: 0 };
    for (const conv of await conversationsForContact(c, conversations)) {
      if (conv.status !== 'open') continue;
      const readType: unknown = conv.type;
      if (typeof readType !== 'string' || readType === '') {
        plan.leftOther += 1;
        continue;
      }
      if (!RETYPABLE_TYPES.has(readType)) continue;
      const participantId = conv.participants?.[0]?.contactId;
      if (typeof participantId === 'string' && participantId !== '' && participantId !== c.contactId) {
        plan.leftShared += 1;
        continue;
      }
      if (await heldByAnother(conv, c.contactId)) {
        plan.leftShared += 1;
        continue;
      }
      plan.retype.push({ conv, readType: readType as ConversationType });
    }
    return plan;
  }

  /** Another LIVE contact holds the thread's phone or address. */
  async function heldByAnother(conv: ConversationItem, contactId: string): Promise<boolean> {
    const phone = conv.participant_phone;
    if (typeof phone === 'string' && phone !== '') {
      if ((await contacts.findAllByPhone(phone)).some((h) => h.contactId !== contactId)) return true;
    }
    const email = conv.participant_email;
    if (typeof email === 'string' && email !== '') {
      if ((await contacts.findAllByEmail(email)).some((h) => h.contactId !== contactId)) return true;
    }
    return false;
  }

  /** Rule 4 with a request: '' = absent; non-empty = D5 against both kinds (422 as A's shape). */
  async function requestedOrganization(
    c: ContactItem,
    requested: string,
  ): Promise<{ value?: string; source: OrganizationSource }> {
    const next = requested.trim();
    if (next === '') return { source: 'request' };
    const check = await orgNames.checkScalar('organization', next, held(c['organization']));
    if (!check.ok) {
      const { error, ...body } = check.error;
      throw new CaseworkerReviewError(422, error, body);
    }
    return check.value === null ? { source: 'request' } : { value: check.value, source: 'request' };
  }

  /**
   * Steps 2-4 after the commit (or alone, on the repair path). Every failure is
   * logged at error level and swallowed: the contact is already converted and
   * its removed values are safe in caseworker_conversion; `make` again re-runs
   * these steps (RUNBOOK).
   */
  async function followOn(
    contactId: string,
    committed: ContactItem,
    ctx: {
      actor: string;
      repair: boolean;
      priorStatus: string | undefined;
      fields: string[];
      record?: CaseworkerConversionRecord;
      pendingTypeBefore: SuggestionItem | undefined;
    },
  ): Promise<void> {
    const verdictAt = now().toISOString();
    const suggestionDeps: SuggestionEffectDeps = {
      extraction, aiRuns, log,
      // C1: shared helpers swallow failures, so report them here at error.
      reportFailure(fields, message) {
        log.error(
          { ...fields, conversion: 'caseworker', repair: ctx.repair },
          'caseworker conversion: ' + message + ' (make again repairs)',
        );
      },
    };

    // Step 2: the type suggestion through the PATCH's revision-guarded drain
    // (canonicalSuggestedContactKind(converted) is 'partner' for the exact
    // Caseworker preset, so an AI partner suggestion records accepted, D16),
    // then every other pending suggestion superseded with the PATCH's stamps
    // (a partner is never extracted again, so none would ever resolve).
    let suggestionsChanged = false;
    try {
      if (await drainTypeSuggestion(suggestionDeps, {
        contactId, committed, pendingTypeBefore: ctx.pendingTypeBefore, verdictAt, actor: ctx.actor,
      })) suggestionsChanged = true;
      for (const pending of await extraction.listSuggestionsByContact(contactId)) {
        if (pending.target === 'type') continue;
        if (await supersedePendingSuggestion(suggestionDeps, {
          contactId, target: pending.target, pending, verdict: 'superseded_by_human_edit', verdictAt, actor: ctx.actor,
        })) suggestionsChanged = true;
      }
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: suggestion sweep failed after the commit (make again repairs)');
    }
    if (suggestionsChanged) events.emit('suggestion.updated', { contactId });

    // Step 3: re-type the contact's OWN open one-to-one threads (D21), each
    // conditional on the type the plan read; a lost condition is skipped and
    // logged, never thrown. The display name rides the same write (R1-F15).
    let retyped = 0;
    try {
      const plan = await planThreads(committed);
      const displayName = displayNameOf(committed);
      for (const { conv, readType } of plan.retype) {
        try {
          const result = await conversations.setTypeIfCurrent(conv.conversationId, readType, 'partner_1to1', displayName);
          if (result.outcome === 'skipped') {
            log.info({ contactId, conversationId: conv.conversationId }, 'caseworker conversion: thread type changed since the read; left as is');
            continue;
          }
          retyped += 1;
          // Built from the UPDATED row setTypeIfCurrent returns (plan 3.3).
          events.emit('conversation.updated', toConversationUpdatedEvent(result.conversation));
        } catch (err) {
          log.error({ err, contactId, conversationId: conv.conversationId }, 'caseworker conversion: thread re-type failed after the commit (make again repairs)');
        }
      }
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: thread plan failed after the commit (make again repairs)');
    }
    try {
      await audit.append(`contacts#${contactId}`, 'contact_updated', {
        fields: ctx.fields,
        actor: ctx.actor,
        conversion: 'caseworker',
        ...(ctx.repair && { repair: true }),
        ...(ctx.record !== undefined && { caseworker_conversion: ctx.record }),
        ...(retyped > 0 && { propagatedConversations: retyped, conversationType: 'partner_1to1' }),
      });
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: audit failed after the commit (make again repairs)');
    }
    // R1-F12: labelled by the NEW type (partner -> "Active"); the PATCH's own
    // milestone keeps labelling by the stored type.
    if (!ctx.repair && ctx.priorStatus !== 'active') {
      try {
        await activityEvents.record({ contactId, type: 'contact_status_changed', label: `Status ${ARROW} Active` });
      } catch (err) {
        log.error({ err, contactId }, 'caseworker conversion: status milestone failed after the commit');
      }
    }
    try {
      await vocabulary.add({ roles: [CASEWORKER_ROLE] });
    } catch (err) {
      log.error({ err, contactId }, 'caseworker conversion: role vocabulary add failed after the commit');
    }
  }

  /** Consistent snapshot before a fresh commit, or within post-commit repair. */
  async function readTypeSuggestion(contactId: string, repair = false): Promise<SuggestionItem | undefined> {
    try {
      return await extraction.getSuggestion(contactId, 'type', { consistentRead: true });
    } catch (err) {
      if (repair) {
        log.error(
          { err, contactId, conversion: 'caseworker', repair },
          'caseworker conversion: repair type suggestion read failed (best-effort)',
        );
      } else {
        log.warn({ err, contactId }, 'type suggestion pre-write read failed (best-effort)');
      }
      return undefined;
    }
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

    async make(contactId, input) {
      const c = await readSubject(contactId);
      const actor = input.actor;
      // The read, as primitives, BEFORE any write: a repo may hand back a live
      // object the write then mutates (the FakeWorld does).
      const read = {
        type: c.type,
        role: held(c['role']),
        status: typeof c.status === 'string' ? c.status : undefined,
        revision: c.classification_revision as unknown,
        housingAuthority: c['housingAuthority'],
        agency: c['agency'],
        organization: c['organization'],
      };

      if (isCaseworker(c)) {
        // Rule 2, the repair path: steps 2-4 only. A request organization is
        // ignored here (no commit runs). readSubject re-checked deletion.
        await followOn(contactId, c, { actor, repair: true, priorStatus: read.status, fields: [],
          pendingTypeBefore: await readTypeSuggestion(contactId, true),
        });
        return c;
      }

      const refusals = await collectRefusals(contactId);
      if (refusals.length > 0) {
        throw new CaseworkerReviewError(409, refusals[0]!.code, { refusals });
      }

      const organization = input.organization !== undefined
        ? await requestedOrganization(c, input.organization)
        : await storedOrDerived(c);

      const removedAuthority = held(read.housingAuthority);
      const clearedAgency = held(read.agency);
      const record: CaseworkerConversionRecord = {
        at: now().toISOString(),
        by: actor,
        fromType: read.type,
        ...(read.role !== undefined && { fromRole: read.role }),
        ...(removedAuthority !== undefined && { housingAuthority: removedAuthority }),
        ...(clearedAgency !== undefined && { agency: clearedAgency }),
      };
      // Step 1, the commit point. `role` in the patch bumps
      // classification_revision through the repo's fence; '' clears agency
      // (R1-F13, every machine clear); null REMOVEs.
      const patch: Record<string, unknown> = {
        type: 'partner',
        role: CASEWORKER_ROLE,
        status: 'active',
        type_source: 'manual',
        organization: organization.value ?? null,
        agency: '',
        housingAuthority: null,
        housingAuthority_source: null,
        caseworker_conversion: record,
      };
      const pendingTypeBefore = await readTypeSuggestion(contactId);
      let converted: ContactItem;
      try {
        converted = await contacts.update(contactId, patch, {
          expect: [
            clause('classification_revision', read.revision),
            clause('housingAuthority', read.housingAuthority),
            clause('agency', read.agency),
            clause('organization', read.organization),
          ],
          notDeleted: true,
        });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          const current = await contacts.getById(contactId, { consistentRead: true });
          if (current === undefined || isDeleted(current)) throw new CaseworkerReviewError(404, 'contact_not_found');
          log.info({ contactId }, 'caseworker conversion refused: the contact changed since the read');
          throw new CaseworkerReviewError(409, 'contact_changed');
        }
        throw err;
      }
      log.info(
        { contactId, fromType: read.type, organizationSource: organization.source, actor },
        'caseworker conversion committed',
      );
      await followOn(contactId, converted, {
        actor, repair: false, priorStatus: read.status, fields: Object.keys(patch), record, pendingTypeBefore,
      });
      return converted;
    },

    async dismiss(contactId, actor) {
      const c = await readSubject(contactId);
      // An unknown is triaged, not dismissed; a caseworker is not "possible".
      if (c.type === 'unknown' || isCaseworker(c)) {
        throw new CaseworkerReviewError(400, 'caseworker_dismiss_not_allowed');
      }
      // Not a classification: no type/role in the patch, so no revision bump
      // (a concurrent make does not 409 on it - fine, D22).
      let updated: ContactItem;
      try {
        updated = await contacts.update(contactId, { caseworker_review: 'dismissed' }, { notDeleted: true });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) throw new CaseworkerReviewError(404, 'contact_not_found');
        throw err;
      }
      await audit.append(`contacts#${contactId}`, 'contact_updated', { fields: ['caseworker_review'], actor });
      log.info({ contactId, actor }, 'possible caseworker dismissed');
      return updated;
    },
  };
}
