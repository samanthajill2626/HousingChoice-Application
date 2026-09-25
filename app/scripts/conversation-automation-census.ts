// conversation-automation-census - READ-ONLY census of the per-conversation
// `ai_mode` switch (share-skip-fix spec D1). Counts only: no names, phones or
// bodies are ever logged or reported. Conversation ids ARE reported (the
// breaker list is for the operator to review one by one).
//
// It answers, for one stage:
//   - every conversation row by type and switch state (pointer items excluded,
//     rows with no type reported as their own group);
//   - switched-off rows by cause, in this precedence: group thread (off by
//     design), breaker trip (a `mode_changed` audit event with reason
//     `breaker_trip`), imported (the import stamp), other;
//   - the breaker-tripped rows, individually;
//   - pending tour-reminder rungs, routed the way the reminder job routes them
//     (jobs/tourReminders.ts resolveReminderTarget): discontinued kinds, tours
//     already started and superseded ladders retire without sending; a
//     non-self_guided tour with a USABLE group goes to the group; everything
//     else goes to the tenant's one-to-one conversation, reported by that
//     conversation's switch state - `oneToOneSwitchedOff` is what the bulk
//     fix script RELEASES (an UPPER BOUND: the job's later gates are not
//     replayed - the quiet-hours deferral, the conversion-claim deferral and
//     stall retire, the pending open-group wait, the tenant-roster retire, and
//     the wrapper's own opt-out / deleted refusals after the claim - each of
//     which can still hold or retire a rung this count includes),
//     `oneToOneBreakerTripped` is what the bulk run leaves alone;
//   - pending placement nudges, reported separately: they are held manual-only
//     today and the fix script releases none of them;
//   - imported one-to-one rows whose phone claim points at a DIFFERENT row (a
//     missing claim is the normal state for an imported row).
//
// TARGET: `--env local|dev|prod` (required) resolves the tables and the
// credentials through scripts/lib/stageClient.ts; dev/prod run the account
// guard first and never touch the default credential chain. An agent runs
// this ONLY with `--env local --lane <L>` against a hermetic e2e lane it
// started; a bare `--env local` is the human's live local stack. NO AGENT
// RUNS THIS AGAINST A REAL ENVIRONMENT; the human does.
//
// Run: npx tsx app/scripts/conversation-automation-census.ts --env dev
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DISCONTINUED_REMINDER_KINDS,
  resolveUsableGroup,
  retiredByTourStart,
  type RunDueTourRemindersDeps,
} from '../src/jobs/tourReminders.js';
import { tableName } from '../src/lib/config.js';
import { queryAll } from '../src/lib/dynamoPaging.js';
import { isSupersededRung } from '../src/lib/ladderPointer.js';
import { createLogger, logger } from '../src/lib/logger.js';
import { isOneToOneBucket } from '../src/lib/unreadFeed.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createPlacementNudgesRepo } from '../src/repos/placementNudgesRepo.js';
import { createTourRemindersRepo } from '../src/repos/tourRemindersRepo.js';
import { createToursRepo, type TourItem } from '../src/repos/toursRepo.js';
import { parseStageArgs, resolveStageClient } from './lib/stageClient.js';

/** Pointer partitions in the conversations table (claims + reply tokens). They
 *  carry only a key and a ref - never a conversation. Mirrors the private list
 *  in lib/unreadFeed.ts. */
export const POINTER_PREFIXES = ['phone#', 'email#', 'token#'] as const;

/** A dueAt bound past every real rung: listDue(FAR_FUTURE) = every pending row. */
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

export type SwitchState = 'auto' | 'manual' | 'unset';

export interface AutomationCensus {
  scannedRows: number;
  pointerRows: number;
  byType: Record<string, Record<SwitchState, number>>;
  manualByCause: { groupThread: number; breakerTrip: number; imported: number; other: number };
  breakerTripped: Array<{ conversationId: string; type: string; trippedAt: string }>;
  pendingTourRungs: {
    /** Would send once the bulk fix script runs. */
    oneToOneSwitchedOff: number;
    /** Held by a breaker-tripped conversation; the bulk run leaves these off. */
    oneToOneBreakerTripped: number;
    oneToOneSwitchedOn: number;
    /** Routed to a usable relay group; the switch never applies. */
    groupRouted: number;
    tourPast: number;
    superseded: number;
    discontinued: number;
    unresolvable: number;
  };
  pendingNudgesHeldManualOnly: number;
  importedOneToOneRows: number;
  importClaimMismatches: number;
}

export function switchStateOf(row: Pick<ConversationItem, 'ai_mode'>): SwitchState {
  if (row.ai_mode === 'manual') return 'manual';
  if (row.ai_mode === 'auto') return 'auto';
  return 'unset';
}

export function isPointerRow(conversationId: string): boolean {
  return POINTER_PREFIXES.some((p) => conversationId.startsWith(p));
}

/** The breaker trip on record for a conversation, newest first, or undefined.
 *  A PAGED, FILTERED query: the audit partition also holds one `message_sent`
 *  per send, so an old trip can sit behind many newer events and
 *  auditRepo.listByEntity's single page would miss it. */
export async function findBreakerTrip(
  doc: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  conversationId: string,
): Promise<AuditEvent | undefined> {
  const events = await queryAll<AuditEvent>(doc, {
    TableName: tableName('audit_events', env),
    KeyConditionExpression: '#e = :e',
    FilterExpression: '#t = :t',
    ExpressionAttributeNames: { '#e': 'entityKey', '#t': 'event_type' },
    ExpressionAttributeValues: { ':e': `conversations#${conversationId}`, ':t': 'mode_changed' },
    ScanIndexForward: false,
  });
  return events.find((e) => (e.payload as { reason?: unknown } | undefined)?.reason === 'breaker_trip');
}

export interface CensusOpts {
  doc: DynamoDBDocumentClient;
  env: NodeJS.ProcessEnv;
  /** The instant "tour already started" is judged against. Defaults to now. */
  now?: string;
  /** Scan page bound (tests exercise the paging loop with it). */
  scanLimit?: number;
}

export async function runConversationAutomationCensus(opts: CensusOpts): Promise<AutomationCensus> {
  const { doc, env } = opts;
  const now = opts.now ?? new Date().toISOString();
  const census: AutomationCensus = {
    scannedRows: 0,
    pointerRows: 0,
    byType: {},
    manualByCause: { groupThread: 0, breakerTrip: 0, imported: 0, other: 0 },
    breakerTripped: [],
    pendingTourRungs: {
      oneToOneSwitchedOff: 0,
      oneToOneBreakerTripped: 0,
      oneToOneSwitchedOn: 0,
      groupRouted: 0,
      tourPast: 0,
      superseded: 0,
      discontinued: 0,
      unresolvable: 0,
    },
    pendingNudgesHeldManualOnly: 0,
    importedOneToOneRows: 0,
    importClaimMismatches: 0,
  };

  // ---- Conversations: one Scan, every row classified; claims collected ------
  const phoneClaims = new Map<string, string>();
  const importedOneToOne: Array<{ conversationId: string; phone: string }> = [];
  const breakerTrippedIds = new Set<string>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName('conversations', env),
        ...(opts.scanLimit !== undefined && { Limit: opts.scanLimit }),
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const raw of (page.Items ?? []) as ConversationItem[]) {
      census.scannedRows += 1;
      if (isPointerRow(raw.conversationId)) {
        census.pointerRows += 1;
        if (raw.conversationId.startsWith('phone#') && typeof raw.ref_conversationId === 'string') {
          phoneClaims.set(raw.conversationId.slice('phone#'.length), raw.ref_conversationId);
        }
        continue;
      }
      const typeKey = typeof raw.type === 'string' ? raw.type : '(none)';
      const bucket = (census.byType[typeKey] ??= { auto: 0, manual: 0, unset: 0 });
      const state = switchStateOf(raw);
      bucket[state] += 1;
      const imported = typeof raw.imported_from === 'string';
      if (isOneToOneBucket(raw) && imported && typeof raw.participant_phone === 'string') {
        importedOneToOne.push({ conversationId: raw.conversationId, phone: raw.participant_phone });
      }
      if (state !== 'manual') continue;
      if (!isOneToOneBucket(raw)) {
        census.manualByCause.groupThread += 1;
        continue;
      }
      const trip = await findBreakerTrip(doc, env, raw.conversationId);
      if (trip !== undefined) {
        census.manualByCause.breakerTrip += 1;
        breakerTrippedIds.add(raw.conversationId);
        census.breakerTripped.push({
          conversationId: raw.conversationId,
          type: typeKey,
          trippedAt: trip.ts.split('#')[0] ?? trip.ts,
        });
        continue;
      }
      if (imported) census.manualByCause.imported += 1;
      else census.manualByCause.other += 1;
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  census.importedOneToOneRows = importedOneToOne.length;
  for (const row of importedOneToOne) {
    const claim = phoneClaims.get(row.phone);
    if (claim !== undefined && claim !== row.conversationId) census.importClaimMismatches += 1;
  }

  // ---- Pending tour rungs: replay the job's target resolution -------------
  const tours = createToursRepo({ doc, env });
  const reminders = createTourRemindersRepo({ doc, env });
  const contacts = createContactsRepo({ doc, env });
  const conversations = createConversationsRepo({ doc, env });
  // resolveUsableGroup reads only deps.conversationsRepo (tourReminders.ts:1496-1530);
  // the cast hands it that one dependency rather than a whole job wiring. It
  // also logs the JOB's "falling back to tenant 1:1" WARN on an unusable group,
  // which would read as an action in a read-only report - so it gets a silent
  // logger; the census reports the outcome in its own counts.
  const usabilityDeps = { conversationsRepo: conversations } as unknown as RunDueTourRemindersDeps;
  const silent = createLogger({ level: 'silent' });
  const tourCache = new Map<string, TourItem | undefined>();
  const tourFor = async (tourId: string): Promise<TourItem | undefined> => {
    if (tourCache.has(tourId)) return tourCache.get(tourId);
    const tour = await tours.get(tourId);
    tourCache.set(tourId, tour);
    return tour;
  };
  for (const rung of await reminders.listDue(FAR_FUTURE)) {
    const r = census.pendingTourRungs;
    if (DISCONTINUED_REMINDER_KINDS.has(rung.kind)) {
      r.discontinued += 1;
      continue;
    }
    const tour = await tourFor(rung.tourId);
    if (!tour) {
      r.unresolvable += 1;
      continue;
    }
    if (retiredByTourStart(rung, tour.scheduledAt, now)) {
      r.tourPast += 1;
      continue;
    }
    if (isSupersededRung(rung, tour)) {
      r.superseded += 1;
      continue;
    }
    if (tour.tourType !== 'self_guided') {
      const group = await resolveUsableGroup(tour, rung, usabilityDeps, silent);
      if (group !== undefined) {
        r.groupRouted += 1;
        continue;
      }
      // Unusable group: the job falls back to the tenant 1:1 - so does this.
    }
    const contact = await contacts.getById(tour.tenantId);
    const phone = contact?.phone;
    if (typeof phone !== 'string' || phone.length === 0) {
      r.unresolvable += 1;
      continue;
    }
    const convs = await conversations.findByParticipantPhone(phone);
    const conv = convs.find((c) => c.type === 'tenant_1to1' || c.type === 'unknown_1to1');
    if (!conv) {
      r.unresolvable += 1;
      continue;
    }
    if (conv.ai_mode !== 'manual') r.oneToOneSwitchedOn += 1;
    else if (breakerTrippedIds.has(conv.conversationId)) r.oneToOneBreakerTripped += 1;
    else r.oneToOneSwitchedOff += 1;
  }

  // ---- Pending nudges: held manual-only, unaffected by the fix script ------
  const nudges = createPlacementNudgesRepo({ doc, env });
  census.pendingNudgesHeldManualOnly = (await nudges.listDue(FAR_FUTURE)).length;

  return census;
}

/** Log the census (counts + the breaker list) and return the exit code. */
export function reportCensus(census: AutomationCensus): 0 {
  logger.info({ ...census, breakerTripped: undefined }, 'conversation-automation-census - counts');
  for (const trip of census.breakerTripped) {
    logger.info(trip, 'conversation-automation-census - breaker-tripped conversation (review before enabling)');
  }
  logger.info(
    {
      breakerTripped: census.breakerTripped.length,
      rungsReleasedByBulkEnable: census.pendingTourRungs.oneToOneSwitchedOff,
      rungsHeldByBreakerTrips: census.pendingTourRungs.oneToOneBreakerTripped,
      pendingNudgesHeldManualOnly: census.pendingNudgesHeldManualOnly,
    },
    'conversation-automation-census - done (read-only; nothing written). rungsReleasedByBulkEnable is an UPPER BOUND on what starts sending after the bulk apply (the job\'s later gates - quiet hours, conversion claims, open-group waits, roster, opt-out/deleted - are not replayed); breaker-held rungs move only after a single-conversation resume. Pending nudges are held manual-only today and are NOT released by the fix script.',
  );
  return 0;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('conversation-automation-census.ts');
if (invokedDirectly) {
  const parsed = parseStageArgs(process.argv.slice(2), { values: [], flags: [] });
  if ('usage' in parsed) {
    console.error(
      'Usage: npx tsx app/scripts/conversation-automation-census.ts --env local|dev|prod [--lane <L>]\n' +
        '  --lane selects a hermetic e2e lane (local only; the only local target an agent may use).',
    );
    process.exit(2);
  }
  resolveStageClient(parsed.target, {}, parsed.lane !== undefined ? { lane: parsed.lane } : {})
    .then(async (stage) => {
      logger.info(
        { target: parsed.target, endpoint: stage.describe, prefix: stage.prefix },
        'conversation-automation-census - target resolved (read-only)',
      );
      const census = await runConversationAutomationCensus({ doc: stage.doc, env: stage.env });
      process.exitCode = reportCensus(census);
      stage.doc.destroy();
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'conversation-automation-census - FAILED');
      process.exitCode = 1;
    });
}
