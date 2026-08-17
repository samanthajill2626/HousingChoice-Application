// Conversation-fact-extraction poll job (T7, spec 4.1/4.2/4.4).
//
// runDueExtractions is the stateless poll handler mirroring runDueTourReminders:
// it queries listDue(now), then for each row CLAIMS it (sliding-debounce guard)
// BEFORE doing any work. On a won claim it assembles a channel-neutral transcript
// from stored messages, calls the extraction driver, and applies the result via
// the guarded apply service. Designed to be called by a setInterval in worker.ts
// and by the deterministic dev tick (routes/dev.ts).
//
// *** CROSS-PROCESS BRIDGE (load-bearing) ***
// When this poll runs in the WORKER process, apply.ts's `suggestion.updated`
// emit lands on the worker's in-process event bus and - when EVENT_BRIDGE_URL is
// set (all deployed envs + local runners) - crosses to the app's SSE clients via
// lib/eventBridge.ts (fire-and-forget POST /internal/events, routes/internal.ts
// re-emits), so an open contact page updates live with no reload. Bare unset-URL
// runs keep the old behavior: the change appears on the next dashboard fetch.
//
// PII (doc section 9): NEVER log message bodies or phone numbers. Log only
// conversationId / contactId / counts.
import type { AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { createExtractionRepo, DueExtractionItem } from '../repos/extractionRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import { contactPhones, PHONE_REF_PREFIX } from '../repos/contactsRepo.js';
import type { MessageItem, MessagesRepo } from '../repos/messagesRepo.js';
import { randomUUID } from 'node:crypto';
import type {
  ExtractionDriver,
  ExtractionProfileSnapshot,
  ExtractionResult,
  TranscriptUtterance,
} from '../adapters/extraction.js';
import { applyExtraction, type ApplyDeps } from '../services/extraction/apply.js';
import { contactAddressToParts, formatAddressParts } from '../services/extraction/address.js';
import type {
  AiRunRecordInput,
  AiRunsRepo,
  RunErrorKind,
  RunOutcome,
  RunTrigger,
  SkipReason,
} from '../repos/aiRunsRepo.js';
import { isDecisionTarget, type DecisionTarget, type RunDecision, type RunWindow } from '../services/extraction/runTypes.js';
import { buildFullRunWindow, buildLightRunWindow, type WindowMessagePieces } from '../services/extraction/runWindow.js';
import { buildDecisions } from '../services/extraction/decisions.js';
import { parseExtractionOps } from '../services/extraction/schema.js';

/** Consecutive failures before an item is PARKED (no further auto-retries). */
export const MAX_EXTRACTION_ATTEMPTS = 5;
/** Newest N messages pulled per conversation for the transcript window. */
export const MAX_TRANSCRIPT_MESSAGES = 50;
/** Messages older than this are dropped from the transcript window. */
export const MAX_TRANSCRIPT_AGE_DAYS = 30;

// Input-size caps (cost control, 2026-07-20). The window is re-sent on EVERY
// run, so one long transcript/email would otherwise re-bill its full text for
// up to 49 subsequent runs. Tiered per-MESSAGE caps keyed off the cursor:
// a message NEWER than the cursor is being extracted for the first time - this
// run is its one full-fidelity read; a message at/below the cursor was already
// extracted and stays only as reconciliation context. A whole-window budget
// bounds pathological pileups (worst-case run input ~15k tokens).
/** Per-message char cap for not-yet-extracted (post-cursor) messages. */
export const NEW_MESSAGE_CHAR_CAP = 30_000;
/** Per-message char cap for already-extracted (at/below-cursor) messages. */
export const SEEN_MESSAGE_CHAR_CAP = 2_000;
/** Whole-window char budget - oldest messages drop first (newest-first fill). */
export const WINDOW_CHAR_BUDGET = 60_000;
/** Marker inserted where clamped text was removed. */
export const TRUNCATION_MARKER = '[... truncated ...]';

/** Backoff is never longer than one hour. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExtractionJobDeps {
  repo: ReturnType<typeof createExtractionRepo>;
  conversations: Pick<ConversationsRepo, 'getById'>;
  messages: Pick<MessagesRepo, 'listByConversation'>;
  contacts: Pick<ContactsRepo, 'getById' | 'findByPhone' | 'update' | 'addPhone'>;
  driver: ExtractionDriver;
  /** Built once by the caller (worker.ts / dev tick) and reused per row. */
  applyDeps: ApplyDeps;
  config: Pick<AppConfig, 'aiExtractionDebounceMs'>;
  logger: Logger;
  /**
   * The run-log writer. REQUIRED so a missed construction site is a typecheck
   * failure, not a silently empty log. All three sites must supply it:
   * worker.ts (the worker poll), routes/dev.ts (the deterministic dev tick), and
   * the unit-test harness. Missing the dev tick would leave the log permanently
   * empty in e2e and local development - the exact place this feature is first
   * exercised (design 8).
   */
  aiRuns: Pick<AiRunsRepo, 'beginFinalization' | 'putRun' | 'setVerdict'>;
  /**
   * REAL WALL-CLOCK now, for the run record's timestamps ONLY (design section 6,
   * as amended). NOT the poll's nowIso: the dev tick runs a SIMULATED FUTURE
   * clock (routes/dev.ts:432 advances by the debounce window), so the poll clock
   * would stamp dev and e2e runs about one debounce into the future and mis-sort
   * the log against real time. All domain logic - cursor comparisons, the age
   * cutoff, claim/complete/fail - keeps using nowIso, unchanged. Injected so
   * tests can pin it.
   */
  now(): string;
}

/** Read a string field off the flexible contact document, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Build the ExtractionProfileSnapshot the model reconciles against. */
export function toProfile(contact: ContactItem): ExtractionProfileSnapshot {
  const profile: ExtractionProfileSnapshot = {
    contactType: contact.type,
    phones: contactPhones(contact).map((p) => p.phone),
  };
  const status = str(contact.status);
  if (status !== undefined) profile.status = status;
  const firstName = str(contact['firstName']);
  if (firstName !== undefined) profile.firstName = firstName;
  const lastName = str(contact['lastName']);
  if (lastName !== undefined) profile.lastName = lastName;
  if (typeof contact['voucherSize'] === 'number') profile.voucherSize = contact['voucherSize'];
  const housingAuthority = str(contact['housingAuthority']);
  if (housingAuthority !== undefined) profile.housingAuthority = housingAuthority;
  const pets = str(contact['pets']);
  if (pets !== undefined) profile.pets = pets;
  const evictions = str(contact['evictions']);
  if (evictions !== undefined) profile.evictions = evictions;
  const tenure = str(contact['tenure']);
  if (tenure !== undefined) profile.tenure = tenure;
  if (typeof contact.porting === 'boolean') profile.porting = contact.porting;
  const notes = str(contact['notes']);
  if (notes !== undefined) profile.notes = notes;
  // Single-line current address for reconciliation (object doc -> formatted
  // string; contactAddressToParts also tolerates a legacy plain-string address).
  const address = formatAddressParts(contactAddressToParts(contact['address']));
  if (address.length > 0) profile.address = address;
  return profile;
}

/** EXPORTED for the run log + run-detail view. Reimplementing any of
 *  toUtterances / capUtterances / clampHeadTail / toProfile would guarantee the
 *  hash mismatch the window hash exists to detect (design 6.4). */
/**
 * Map a stored message to zero or more channel-tagged transcript utterances.
 *
 * - sms/mms: exactly one utterance - speaker from direction, channel 'sms'.
 * - email: exactly one utterance - speaker from direction (inbound -> client,
 *   outbound teammate -> staff, exactly the sms mapping), channel 'email',
 *   text = the message BODY ONLY (already quote-trimmed at ingest by
 *   visibleReplyText; the subject is metadata and NEVER transcript content).
 * - call WITH a completed, non-empty transcript: one utterance per NON-EMPTY
 *   line, all sharing the call row's timestamp, channel 'voice'. Per-line
 *   speaker attribution (the prefixes are baked in by joinViSentences at save
 *   time - Layer 1):
 *     - 'Staff: ' / 'Client: ' -> known role, prefix STRIPPED.
 *     - 'Speaker N: '           -> speaker 'unknown', prefix KEPT so the model
 *                                  can track who is who across the call's lines.
 *     - otherwise (voicemail / single-channel, unprefixed) -> 'client' (the
 *       caller is the client by construction).
 * - call WITHOUT a completed transcript, or with an empty one: nothing.
 */
export function toUtterances(m: MessageItem): TranscriptUtterance[] {
  if (m.type === 'call') {
    if (m.transcript_status !== 'completed' || !m.transcript) return [];
    const at = m.created_at;
    const utterances: TranscriptUtterance[] = [];
    for (const line of m.transcript.split('\n')) {
      if (line.length === 0) continue; // drop empty lines
      const staff = /^Staff: (.*)$/.exec(line);
      if (staff) {
        utterances.push({ tsMsgId: m.tsMsgId, speaker: 'staff', text: staff[1]!, at, channel: 'voice' });
        continue;
      }
      const client = /^Client: (.*)$/.exec(line);
      if (client) {
        utterances.push({ tsMsgId: m.tsMsgId, speaker: 'client', text: client[1]!, at, channel: 'voice' });
        continue;
      }
      if (/^Speaker \d+: /.test(line)) {
        utterances.push({ tsMsgId: m.tsMsgId, speaker: 'unknown', text: line, at, channel: 'voice' });
        continue;
      }
      utterances.push({ tsMsgId: m.tsMsgId, speaker: 'client', text: line, at, channel: 'voice' });
    }
    return utterances;
  }
  if (m.type === 'email') {
    return [
      {
        tsMsgId: m.tsMsgId,
        speaker: m.direction === 'inbound' ? 'client' : 'staff',
        text: m.body ?? '',
        at: m.created_at,
        channel: 'email',
      },
    ];
  }
  return [
    {
      tsMsgId: m.tsMsgId,
      speaker: m.direction === 'inbound' ? 'client' : 'staff',
      text: m.body ?? '[media]',
      at: m.created_at,
      channel: 'sms',
    },
  ];
}

/** `head [marker] tail` with total length <= cap (facts cluster at the edges). */
export function clampHeadTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const usable = cap - TRUNCATION_MARKER.length - 2; // two joining spaces
  const head = Math.floor(usable * 0.7);
  const tail = usable - head;
  return `${text.slice(0, head)} ${TRUNCATION_MARKER} ${text.slice(text.length - tail)}`;
}

/**
 * Cap ONE message's utterances to `cap` total chars. Single-utterance messages
 * (sms/mms/voicemail) clamp head+tail inside the string. Multi-utterance
 * messages (call transcripts, one utterance per line) clamp at LINE
 * granularity - whole head lines + whole tail lines, middle dropped - so the
 * per-line speaker attribution (Layer 1) is never orphaned mid-line. The
 * marker is appended to the last kept head utterance.
 */
export function capUtterances(utterances: TranscriptUtterance[], cap: number): TranscriptUtterance[] {
  const total = utterances.reduce((n, u) => n + u.text.length, 0);
  if (total <= cap) return utterances;
  if (utterances.length === 1) {
    const u = utterances[0]!;
    return [{ ...u, text: clampHeadTail(u.text, cap) }];
  }
  const usable = cap - TRUNCATION_MARKER.length - 1; // one joining space
  const headBudget = Math.floor(usable * 0.7);
  const tailBudget = usable - headBudget;

  const head: TranscriptUtterance[] = [];
  let used = 0;
  let i = 0;
  while (i < utterances.length && used + utterances[i]!.text.length <= headBudget) {
    head.push(utterances[i]!);
    used += utterances[i]!.text.length;
    i += 1;
  }
  if (head.length === 0) {
    // The first utterance alone exceeds the head budget - keep its head slice
    // (attribution intact) so a clamp can never empty a message.
    const u = utterances[0]!;
    head.push({ ...u, text: u.text.slice(0, headBudget) });
    i = 1;
  }

  const tail: TranscriptUtterance[] = [];
  used = 0;
  let j = utterances.length - 1;
  while (j >= i && used + utterances[j]!.text.length <= tailBudget) {
    tail.unshift(utterances[j]!);
    used += utterances[j]!.text.length;
    j -= 1;
  }
  if (tail.length === 0 && utterances.length - 1 >= i) {
    const u = utterances[utterances.length - 1]!;
    tail.unshift({ ...u, text: u.text.slice(u.text.length - tailBudget) });
  }

  const last = head[head.length - 1]!;
  head[head.length - 1] = { ...last, text: `${last.text} ${TRUNCATION_MARKER}` };
  return [...head, ...tail];
}

/** The run record under construction, owned by runDueExtractions. */
export interface RunDraft {
  runId: string;
  startedAt: string;
  conversationId: string;
  contactId?: string;
  trigger: RunTrigger;
  skipReason?: SkipReason;
  error?: { kind: RunErrorKind; message: string; attempts?: number; parked?: boolean };
  driver?: 'anthropic' | 'console' | 'fake';
  model?: string;
  promptFingerprint?: string;
  usage?: { inputTokens: number; outputTokens: number };
  window?: RunWindow;
  profileFieldsPopulated?: string[];
  rawText?: string;
  rawResult?: ExtractionResult;
  decisions?: Partial<Record<DecisionTarget, RunDecision>>;
  notedLines?: number;
  displaced: Array<{ target: string; runId: string; createdAt: string }>;
}

/** Allocate a draft before processing so the outer backstop retains all evidence. */
export function newRunDraft(row: DueExtractionItem, startedAt: string): RunDraft {
  return { runId: randomUUID(), startedAt, conversationId: row.conversationId, trigger: row.channel, displaced: [] };
}

/** Only a lost claim and a defensive malformed due row are deliberately unrecorded. */
export type ProcessRowResult = { record: false } | { record: true; outcome: RunOutcome };

/** Record populated field names, never a profile snapshot. */
function profileFieldNames(profile: ExtractionProfileSnapshot): string[] {
  const names = Object.entries(profile)
    .filter(([key, value]) => key !== 'phones' && key !== 'contactType' && value !== undefined)
    .map(([key]) => key);
  if (profile.phones.length > 0) names.push('phones');
  return names.sort();
}

/**
 * Build ONE piece of the run-log draft, best-effort (design section 8: "The
 * recorder is strictly best-effort ... It must never fail an extraction run,
 * re-arm a due row, or burn a retry attempt.").
 *
 * The builders below (window, decisions) are pure assembly for the run RECORD -
 * nothing downstream of extraction reads them. A throw from one used to unwind
 * into runDueExtractions' per-row backstop, which stamped outcome 'failed',
 * called repo.fail(), burned an attempt and re-armed the row - so observability
 * broke what it observed. On a throw this logs ids-only and returns undefined;
 * the caller leaves its draft field as it was and continues on the exact same
 * path (same gates, same outcome, same cursor advance, same complete/fail
 * routing). Fields are optional on RunDraft and recordRun already defaults the
 * absent shapes, so no degraded record is malformed.
 */
function draftPiece<T>(logger: Logger, draft: RunDraft, build: () => T): T | undefined {
  try {
    return build();
  } catch (err) {
    logger.warn(
      { conversationId: draft.conversationId, runId: draft.runId, err },
      'ai run draft assembly failed (best-effort)',
    );
    return undefined;
  }
}

/** Process one due row, filling the caller-owned draft on every known path. */
async function processRow(
  row: DueExtractionItem,
  nowIso: string,
  deps: ExtractionJobDeps,
  draft: RunDraft,
): Promise<ProcessRowResult> {
  const { repo, conversations, messages, contacts, driver, applyDeps, logger } = deps;
  const conversationId = row.conversationId;
  const cursor = row.cursor ?? '';
  const failed = (kind: RunErrorKind, err: unknown): ProcessRowResult => {
    draft.error = { kind, message: err instanceof Error ? err.message : String(err) };
    return { record: true, outcome: 'failed' };
  };
  const completeOrFail = async (nextCursor: string): Promise<ProcessRowResult | undefined> => {
    try {
      await repo.complete(conversationId, nextCursor, nowIso);
      return undefined;
    } catch (err) {
      return failed('complete', err);
    }
  };

  const listedDueAt = row.dueAt;
  if (listedDueAt === undefined) return { record: false };
  let claimed: boolean;
  try {
    claimed = await repo.claim(conversationId, nowIso, listedDueAt);
  } catch (err) {
    return failed('repo', err);
  }
  if (!claimed) {
    logger.debug({ conversationId }, 'extraction claim lost (slid or already claimed) - skipping');
    return { record: false };
  }

  let conv: Awaited<ReturnType<typeof conversations.getById>>;
  let contact: ContactItem | undefined;
  try {
    conv = await conversations.getById(conversationId);
    const participant = conv?.participants?.[0];
    if (conv) {
      if (participant?.contactId) contact = await contacts.getById(participant.contactId);
      else {
        const phone = participant?.phone ?? conv.participant_phone;
        if (phone) contact = await contacts.findByPhone(phone);
      }
    }
  } catch (err) {
    return failed('repo', err);
  }

  if (!conv || !contact || contact.contactId.startsWith(PHONE_REF_PREFIX)) {
    logger.debug({ conversationId }, 'extraction: nothing to extract (missing contact) - completing');
    draft.skipReason = 'no_contact';
    const failure = await completeOrFail(cursor);
    return failure ?? { record: true, outcome: 'skipped' };
  }
  // A resolved contact is still useful audit context when its type is ineligible.
  // Set this before the eligibility exit so the run gets its contacts# pointer.
  draft.contactId = contact.contactId;
  if (contact.type === 'landlord' || contact.type === 'partner' || contact.type === 'team_member') {
    logger.debug({ conversationId, contactType: contact.type }, 'extraction: ineligible contact type - completing');
    draft.skipReason = 'ineligible_type';
    const failure = await completeOrFail(cursor);
    return failure ?? { record: true, outcome: 'skipped' };
  }
  let newestFirst: MessageItem[];
  try {
    newestFirst = await messages.listByConversation(conversationId, { limit: MAX_TRANSCRIPT_MESSAGES });
  } catch (err) {
    return failed('repo', err);
  }
  // Group texting (spec 5.4 / T3.7): messages filed 1:1 by a FAIL-OPEN group
  // path (the envelope tripwire, the corrupt-shape branch, the collapsed
  // roster) carry `group_ambiguous_origin`. Their bodies may be group content,
  // so they must never be attributed to this contact as 1:1 facts. The filter
  // sits on the fetched page BECAUSE that is the single funnel: chronological,
  // fresh, agedOutTsMsgIds, newestTsMsgId, hasNewClient, perMessage, the
  // transcript and BOTH run-window builders all derive from it. Filtering any
  // later would still let a marked message trigger (and bill) a run.
  //
  // `fetchedCount` deliberately keeps the RAW page size: it feeds
  // windowCappedAtLimit, which means "the READ hit the limit, there may be
  // unseen history" - a claim about the query, not about the window.
  const fetchedCount = newestFirst.length;
  newestFirst = newestFirst.filter((m) => m.group_ambiguous_origin !== true);
  if (newestFirst.length !== fetchedCount) {
    logger.debug(
      { conversationId, excludedCount: fetchedCount - newestFirst.length },
      'extraction: excluded possibly-group-origin messages from the transcript window',
    );
  }
  const cutoff = new Date(Date.parse(nowIso) - MAX_TRANSCRIPT_AGE_DAYS * DAY_MS).toISOString();
  const chronological = [...newestFirst].reverse();
  const fresh = chronological.filter((m) => m.created_at >= cutoff);
  const agedOutTsMsgIds = chronological.filter((m) => m.created_at < cutoff).map((m) => m.tsMsgId);
  const newestTsMsgId = fresh[fresh.length - 1]?.tsMsgId;
  const lightWindow = draftPiece(logger, draft, () => buildLightRunWindow({
    cursor,
    fetchedCount,
    agedOutTsMsgIds,
    messages: fresh.map((m) => ({ tsMsgId: m.tsMsgId, type: m.type, direction: m.direction })),
    ...(newestTsMsgId !== undefined && { newestTsMsgId }),
  }));
  // A partial RunWindow is not expressible, so a failed build omits the window
  // entirely rather than storing half of one.
  if (lightWindow !== undefined) draft.window = lightWindow;

  const hasNewClient = row.channel === 'voice' || row.channel === 'triage' || fresh.some(
    (m) => m.tsMsgId > cursor && (m.direction === 'inbound' || (m.type === 'call' && m.transcript_status === 'completed')),
  );
  if (!hasNewClient) {
    logger.debug({ conversationId }, 'extraction: no new client messages since cursor - completing');
    draft.skipReason = 'no_new_client';
    const failure = await completeOrFail(cursor);
    return failure ?? { record: true, outcome: 'skipped' };
  }
  if (fresh.length === 0) {
    logger.debug({ conversationId }, 'extraction: empty transcript window - completing');
    draft.skipReason = 'empty_window';
    const failure = await completeOrFail(cursor);
    return failure ?? { record: true, outcome: 'skipped' };
  }

  const perMessage: WindowMessagePieces[] = fresh.map((m) => {
    const raw = toUtterances(m);
    const capChars = m.tsMsgId > cursor ? NEW_MESSAGE_CHAR_CAP : SEEN_MESSAGE_CHAR_CAP;
    return { tsMsgId: m.tsMsgId, type: m.type, direction: m.direction, raw, capped: capUtterances(raw, capChars), capChars };
  });
  const included = new Set<string>();
  let windowChars = 0;
  for (let k = perMessage.length - 1; k >= 0; k -= 1) {
    const size = perMessage[k]!.capped.reduce((n, u) => n + u.text.length, 0);
    if (windowChars + size > WINDOW_CHAR_BUDGET) break;
    windowChars += size;
    included.add(perMessage[k]!.tsMsgId);
  }
  const transcript = perMessage.filter((p) => included.has(p.tsMsgId)).flatMap((p) => p.capped);
  const hasInferredRoleContent = transcript.some((u) => u.speaker === 'unknown');
  // A failed upgrade keeps the LIGHT window already assembled above: it built
  // successfully from the same data, so retaining it degrades nothing.
  const fullWindow = draftPiece(logger, draft, () => buildFullRunWindow({
    cursor, fetchedCount, agedOutTsMsgIds, perMessage, included, hasInferredRoleContent,
    ...(newestTsMsgId !== undefined && { newestTsMsgId }),
  }));
  if (fullWindow !== undefined) draft.window = fullWindow;

  const profile = toProfile(contact);
  const profileFields = draftPiece(logger, draft, () => profileFieldNames(profile));
  if (profileFields !== undefined) draft.profileFieldsPopulated = profileFields;
  const call = await driver.extract({ transcript, profile });
  draft.driver = call.meta.driver;
  if (call.meta.model !== undefined) draft.model = call.meta.model;
  if (call.meta.promptFingerprint !== undefined) draft.promptFingerprint = call.meta.promptFingerprint;
  if (call.meta.usage !== undefined) draft.usage = call.meta.usage;
  if (call.meta.rawText !== undefined) draft.rawText = call.meta.rawText;
  const warnUnexplained = (target: DecisionTarget): void => {
    logger.error({ conversationId, target }, 'ai run log: unexplained dropped decision');
  };
  if (!call.ok) {
    const failureDecisions = draftPiece(logger, draft, () => buildDecisions({
      ops: parseExtractionOps(call.meta.rawText), rawTextPresent: call.meta.rawText !== undefined,
      applyDecisions: [], onUnexplained: warnUnexplained,
    }));
    if (failureDecisions !== undefined) draft.decisions = failureDecisions;
    draft.notedLines = 0;
    return failed(call.failure, new Error(call.message));
  }
  draft.rawResult = call.result;

  // applyExtraction guards its known effects. An unexpected throw is intentionally
  // left to runDueExtractions' per-row backstop, which keeps the same draft.
  try {
    await deps.aiRuns.beginFinalization(draft.runId, draft.startedAt);
  } catch (err) {
    // The marker only protects optional observability linkage; extraction must continue.
    logger.warn({ conversationId, runId: draft.runId, err }, 'ai run finalization marker failed (best-effort)');
  }
  const applyOutcome = await applyExtraction(applyDeps, {
    contact, conversationId, cursorTsMsgId: newestTsMsgId, result: call.result, hasInferredRoleContent,
    runId: draft.runId,
  });
  // The most damaging site: applyExtraction has ALREADY committed the contact
  // write. A throw here used to skip completeOrFail below, so the cursor never
  // advanced, the backstop burned an attempt, and the next poll re-billed the
  // model for the same window. recordRun defaults absent decisions to {}.
  const appliedDecisions = draftPiece(logger, draft, () => buildDecisions({
    ops: parseExtractionOps(call.meta.rawText), rawTextPresent: call.meta.rawText !== undefined,
    applyDecisions: applyOutcome.decisions, onUnexplained: warnUnexplained,
  }));
  if (appliedDecisions !== undefined) draft.decisions = appliedDecisions;
  draft.notedLines = applyOutcome.notedLines;
  draft.displaced = applyOutcome.displaced;
  const nextCursor = newestTsMsgId !== undefined && newestTsMsgId > cursor ? newestTsMsgId : cursor;
  const completeFailure = await completeOrFail(nextCursor);
  if (completeFailure) return completeFailure;
  logger.info({ conversationId }, 'extraction run complete');
  const touched = applyOutcome.wrote.length > 0 || applyOutcome.suggested.length > 0 || applyOutcome.notedLines > 0;
  return { record: true, outcome: touched ? 'applied' : 'no_op' };
}

/** The single, strictly best-effort run-record write. */
async function recordRun(deps: ExtractionJobDeps, outcome: RunOutcome, draft: RunDraft): Promise<void> {
  try {
    const finishedAt = deps.now();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(draft.startedAt));
    const record: AiRunRecordInput = {
      runId: draft.runId,
      startedAt: draft.startedAt,
      finishedAt,
      durationMs,
      conversationId: draft.conversationId,
      ...(draft.contactId !== undefined && { contactId: draft.contactId }),
      trigger: draft.trigger,
      outcome,
      ...(draft.skipReason !== undefined && { skipReason: draft.skipReason }),
      ...(draft.error !== undefined && { error: {
        kind: draft.error.kind, message: draft.error.message,
        attempts: draft.error.attempts ?? 0, parked: draft.error.parked ?? false,
      } }),
      driver: draft.driver ?? deps.driver.kind,
      ...(draft.model !== undefined && { model: draft.model }),
      ...(draft.promptFingerprint !== undefined && { promptFingerprint: draft.promptFingerprint }),
      ...(draft.usage !== undefined && { usage: draft.usage }),
      ...(draft.window !== undefined && { window: draft.window }),
      ...(draft.profileFieldsPopulated !== undefined && { profileFieldsPopulated: draft.profileFieldsPopulated }),
      ...(draft.rawText !== undefined && { rawText: draft.rawText }),
      ...(draft.rawResult !== undefined && { rawResult: draft.rawResult }),
      decisions: draft.decisions ?? {},
      notedLines: draft.notedLines ?? 0,
    };
    await deps.aiRuns.putRun(record);
  } catch (err) {
    deps.logger.warn(
      { conversationId: draft.conversationId, runId: draft.runId, err },
      'ai run log write failed (best-effort - extraction unaffected)',
    );
  }
}

/**
 * Stamp superseded on every earlier run whose pending suggestion this run
 * displaced. This belongs in the job, not apply.ts, so a run-log failure cannot
 * turn a successful suggestion replacement into a suggestion failure.
 */
async function stampSuperseded(deps: ExtractionJobDeps, draft: RunDraft): Promise<void> {
  for (const { target, runId, createdAt } of draft.displaced) {
    if (!isDecisionTarget(target)) continue;
    try {
      // Inside the per-item backstop: this was the run log's last unguarded
      // clock read, and stampSuperseded's call site is itself unguarded, so a
      // throw here escaped the whole poll loop. Now per-item rather than one
      // shared value - no invariant depends on the stamps being equal.
      const at = deps.now();
      await deps.aiRuns.setVerdict(runId, target, 'superseded', { at, expectedVerdict: 'pending', freshSuggestionCreatedAt: createdAt });
    } catch (err) {
      deps.logger.warn(
        { conversationId: draft.conversationId, runId, target, err },
        'ai run superseded stamp failed (best-effort)',
      );
    }
  }
}

/**
 * The stateless poll handler. Queries all due rows at/before `nowIso` and
 * processes each in isolation (a per-row error is logged + routed through the
 * backoff/park failure path, never blocking the rest of the batch).
 */
export async function runDueExtractions(
  nowIso: string,
  deps: ExtractionJobDeps,
): Promise<{ processed: number; failed: number }> {
  const { repo, config, logger } = deps;
  let processed = 0;
  let failed = 0;

  const dueRows = await repo.listDue(nowIso);
  if (dueRows.length === 0) return { processed, failed };

  logger.info({ count: dueRows.length }, 'extraction poll: processing due rows');

  for (const row of dueRows) {
    // The only statement that used to sit outside the per-row backstop. A clock
    // or uuid fault here has no runId to record under and never claimed the
    // row, so the honest outcome is to skip THIS row and let the next poll
    // retry it - never to abort the rest of the batch. Deliberately NOT counted
    // as `failed` and NOT routed through repo.fail(): the row was never
    // claimed, so burning an attempt for an observability fault is exactly the
    // anti-pattern the draft helpers exist to prevent.
    let draft: RunDraft;
    try {
      draft = newRunDraft(row, deps.now());
    } catch (err) {
      logger.error(
        { conversationId: row.conversationId, err },
        'extraction poll: run draft allocation failed - row skipped',
      );
      continue;
    }
    let result: ProcessRowResult;
    try {
      result = await processRow(row, nowIso, deps, draft);
    } catch (err) {
      if (draft.error === undefined) {
        draft.error = { kind: 'repo', message: err instanceof Error ? err.message : String(err) };
      }
      result = { record: true, outcome: 'failed' };
    }
    if (!result.record) continue;

    const { outcome } = result;
    if (outcome === 'applied' || outcome === 'no_op') processed += 1;
    if (outcome === 'failed') {
      failed += 1;
      const attempts = row.attempts ?? 0;
      const parked = attempts + 1 >= MAX_EXTRACTION_ATTEMPTS;
      const nextDueAt = parked ? null : new Date(
        Date.parse(nowIso) + Math.min(config.aiExtractionDebounceMs * 2 ** attempts, MAX_BACKOFF_MS),
      ).toISOString();
      logger.error({ conversationId: row.conversationId, attempts, parked }, 'extraction poll: row failed');
      if (draft.error !== undefined) draft.error = { ...draft.error, attempts, parked };
      try {
        await repo.fail(row.conversationId, draft.error?.message ?? 'unknown', nextDueAt);
      } catch (failErr) {
        logger.error({ conversationId: row.conversationId, err: failErr }, 'extraction poll: fail() write errored');
      }
    }
    await recordRun(deps, outcome, draft);
    await stampSuperseded(deps, draft);
  }

  return { processed, failed };
}
