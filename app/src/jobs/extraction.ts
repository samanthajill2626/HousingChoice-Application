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
import type {
  ExtractionDriver,
  ExtractionProfileSnapshot,
  TranscriptUtterance,
} from '../adapters/extraction.js';
import { applyExtraction, type ApplyDeps } from '../services/extraction/apply.js';
import { contactAddressToParts, formatAddressParts } from '../services/extraction/address.js';

/** Consecutive failures before an item is PARKED (no further auto-retries). */
export const MAX_EXTRACTION_ATTEMPTS = 5;
/** Newest N messages pulled per conversation for the transcript window. */
export const MAX_TRANSCRIPT_MESSAGES = 50;
/** Messages older than this are dropped from the transcript window. */
export const MAX_TRANSCRIPT_AGE_DAYS = 30;

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
}

/** Read a string field off the flexible contact document, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Build the ExtractionProfileSnapshot the model reconciles against. */
function toProfile(contact: ContactItem): ExtractionProfileSnapshot {
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
function toUtterances(m: MessageItem): TranscriptUtterance[] {
  if (m.type === 'call') {
    if (m.transcript_status !== 'completed' || !m.transcript) return [];
    const at = m.created_at;
    const utterances: TranscriptUtterance[] = [];
    for (const line of m.transcript.split('\n')) {
      if (line.length === 0) continue; // drop empty lines
      const staff = /^Staff: (.*)$/.exec(line);
      if (staff) {
        utterances.push({ speaker: 'staff', text: staff[1]!, at, channel: 'voice' });
        continue;
      }
      const client = /^Client: (.*)$/.exec(line);
      if (client) {
        utterances.push({ speaker: 'client', text: client[1]!, at, channel: 'voice' });
        continue;
      }
      if (/^Speaker \d+: /.test(line)) {
        utterances.push({ speaker: 'unknown', text: line, at, channel: 'voice' });
        continue;
      }
      utterances.push({ speaker: 'client', text: line, at, channel: 'voice' });
    }
    return utterances;
  }
  if (m.type === 'email') {
    return [
      {
        speaker: m.direction === 'inbound' ? 'client' : 'staff',
        text: m.body ?? '',
        at: m.created_at,
        channel: 'email',
      },
    ];
  }
  return [
    {
      speaker: m.direction === 'inbound' ? 'client' : 'staff',
      text: m.body ?? '[media]',
      at: m.created_at,
      channel: 'sms',
    },
  ];
}

/**
 * Process ONE due row end-to-end. Throws on driver/apply failure so the caller
 * can route it through the backoff/park failure path; returns a discriminator
 * so the caller can count processed vs nothing-to-do runs.
 */
async function processRow(
  row: DueExtractionItem,
  nowIso: string,
  deps: ExtractionJobDeps,
): Promise<'processed' | 'skipped'> {
  const { repo, conversations, messages, contacts, driver, applyDeps, logger } = deps;
  const conversationId = row.conversationId;
  const cursor = row.cursor ?? '';

  // Claim BEFORE any work: the conditional `dueAt = listedDueAt` guard means a
  // row that slid forward (a newer inbound re-scheduled it) loses here, so a
  // debounce burst yields exactly one run at the final dueAt.
  const listedDueAt = row.dueAt;
  if (listedDueAt === undefined) return 'skipped'; // defensive; listed rows carry it
  const claimed = await repo.claim(conversationId, nowIso, listedDueAt);
  if (!claimed) {
    logger.debug({ conversationId }, 'extraction claim lost (slid or already claimed) - skipping');
    return 'skipped';
  }

  // Resolve the conversation + its 1:1 contact.
  const conv = await conversations.getById(conversationId);
  const participant = conv?.participants?.[0];
  let contact: ContactItem | undefined;
  if (conv) {
    if (participant?.contactId) {
      contact = await contacts.getById(participant.contactId);
    } else {
      const phone = participant?.phone ?? conv.participant_phone;
      if (phone) contact = await contacts.findByPhone(phone);
    }
  }

  // Nothing to extract for: a missing conversation/contact, a landlord/partner/
  // team_member contact, or a bare phone-ref pointer item. Complete with the
  // EXISTING cursor (never fail forever) so the row leaves the due index.
  if (
    !conv ||
    !contact ||
    contact.contactId.startsWith(PHONE_REF_PREFIX) ||
    contact.type === 'landlord' ||
    contact.type === 'partner' ||
    contact.type === 'team_member'
  ) {
    logger.debug({ conversationId }, 'extraction: nothing to extract (missing/ineligible contact) - completing');
    await repo.complete(conversationId, cursor, nowIso);
    return 'skipped';
  }

  // Transcript window: newest N messages, REVERSED to chronological, with rows
  // older than MAX_TRANSCRIPT_AGE_DAYS dropped. The window deliberately INCLUDES
  // messages at/before the cursor for context - the cursor marks progress, not a
  // hard filter; we only RUN when a client utterance is newer than the cursor.
  const newestFirst = await messages.listByConversation(conversationId, { limit: MAX_TRANSCRIPT_MESSAGES });
  const cutoff = new Date(Date.parse(nowIso) - MAX_TRANSCRIPT_AGE_DAYS * DAY_MS).toISOString();
  const fresh = [...newestFirst].reverse().filter((m) => m.created_at >= cutoff);

  // Freshness gate. A voice- or triage-triggered run BYPASSES it entirely -
  // both are signals for content the cursor logic can't see:
  //   - voice: a transcript persists minutes after the call row's tsMsgId, so an
  //     SMS-triggered run may already have advanced the cursor past the call row.
  //   - triage: a human just flipped the contact to tenant, so tenant-only facts
  //     (voucherSize/housingAuthority/...) the apply layer previously IGNORED
  //     for the unknown type are now applicable - re-read the existing window.
  // On an SMS-triggered run, a fresh COMPLETED-transcript call also counts as
  // new client-side content: it carries the client's speech regardless of the
  // call row's stored direction.
  const hasNewClient =
    row.channel === 'voice' ||
    row.channel === 'triage' ||
    fresh.some(
      (m) =>
        m.tsMsgId > cursor &&
        (m.direction === 'inbound' || (m.type === 'call' && m.transcript_status === 'completed')),
    );
  if (!hasNewClient) {
    logger.debug({ conversationId }, 'extraction: no new client messages since cursor - completing');
    await repo.complete(conversationId, cursor, nowIso);
    return 'skipped';
  }

  // A voice-/triage-triggered run bypasses the client-freshness early-exit
  // above, so an empty window (nothing survived the 30-day / newest-50 cutoff)
  // would fall through to fresh[fresh.length - 1] and throw. Guard it
  // explicitly: nothing to extract -> complete with the existing cursor. (An
  // SMS run already early-exits on an empty window via hasNewClient=false.)
  if (fresh.length === 0) {
    logger.debug({ conversationId }, 'extraction: empty transcript window - completing');
    await repo.complete(conversationId, cursor, nowIso);
    return 'skipped';
  }

  const newestTsMsgId = fresh[fresh.length - 1]!.tsMsgId;
  const transcript = fresh.flatMap(toUtterances);
  // Spec Layer 3: any unknown-speaker (Speaker N) call line demotes the whole
  // run to suggest-only in apply.
  const hasInferredRoleContent = transcript.some((u) => u.speaker === 'unknown');

  const result = await driver.extract({ transcript, profile: toProfile(contact) });
  await applyExtraction(applyDeps, {
    contact,
    conversationId,
    cursorTsMsgId: newestTsMsgId,
    result,
    hasInferredRoleContent,
  });
  // Keep the cursor MONOTONIC: a voice-triggered run's newestTsMsgId can be OLDER
  // than the current cursor (the call row predates a cursor an SMS run already
  // advanced), and complete() writes the cursor unconditionally - advancing to
  // max(newest, cursor) prevents a regression that would make a later SMS run
  // re-examine already-processed messages.
  const nextCursor = newestTsMsgId > cursor ? newestTsMsgId : cursor;
  await repo.complete(conversationId, nextCursor, nowIso);
  logger.info({ conversationId }, 'extraction run complete');
  return 'processed';
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
    try {
      const outcome = await processRow(row, nowIso, deps);
      if (outcome === 'processed') processed += 1;
    } catch (err) {
      failed += 1;
      // The driver or apply threw (incl. ExtractionRefusedError). Re-arm with
      // exponential backoff off the CURRENT attempt count, or PARK once the
      // next attempt would reach MAX_EXTRACTION_ATTEMPTS. Isolated per row.
      const attempts = row.attempts ?? 0;
      const nextDueAt =
        attempts + 1 >= MAX_EXTRACTION_ATTEMPTS
          ? null
          : new Date(
              Date.parse(nowIso) + Math.min(config.aiExtractionDebounceMs * 2 ** attempts, MAX_BACKOFF_MS),
            ).toISOString();
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ conversationId: row.conversationId, attempts, parked: nextDueAt === null }, 'extraction poll: row failed');
      try {
        await repo.fail(row.conversationId, message, nextDueAt);
      } catch (failErr) {
        logger.error({ conversationId: row.conversationId, err: failErr }, 'extraction poll: fail() write errored');
      }
    }
  }

  return { processed, failed };
}
