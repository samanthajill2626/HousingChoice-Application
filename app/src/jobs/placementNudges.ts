// Placement application-nudge arm/cancel/poll (Post-Tour & Application, Task 4).
//
// The stage-keyed application nudge ladder. A placement's stage is the single
// source of truth for what (if anything) to chase: entering a rung'd stage arms
// ONE durable nudge row due `delayMs` later; leaving it cancels that row. The v1
// ladder is a SINGLE nudge per stage (no repeats) — the EXISTING stuck_placement
// machinery is the escalation.
//
// armNudgeForStage — ALWAYS cancelForPlacement first (the stage moved on ⇒ any
//   prior chase is moot), then create the new stage's row IFF NUDGE_RUNGS has an
//   entry for that stage. Terminal / rung-less stages = cancel-only.
//
// runDuePlacementNudges — stateless poll (clone of jobs/tourReminders.ts): query
//   listDue(now), then per row (isolated try/catch): resolve the placement; if it
//   already LEFT the rung's stage the row is STALE — claim it to retire it and do
//   NOT send; else resolve the recipient (tenant = placement.tenantId; landlord =
//   unit.landlordId) → phone → 1:1 conversation (created on demand when none
//   exists yet — thread existence is not consent, the send gates still apply) →
//   CLAIM the row BEFORE sending →
//   sendMessageService. SendRefusedError ⇒ claim kept, warn, no retry. Missing
//   entities and stale/unknown rows ⇒ CLAIM-SKIP (stamp skippedAt + skipReason)
//   so the row leaves listDue exactly once — never a bare warn+return, which
//   would re-list the row every poll tick forever (the perpetual "sending
//   shortly" bug tour reminders already fixed). Mirrors tourReminders'
//   processReminderRow for the claim/skip/error semantics.
//
// PII (doc §9): NEVER log a phone number/name/body. Log only
// nudgeId/placementId/tenantId/unitId/kind/stage.
import type { EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { PlacementStage } from '../lib/statusModel.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { isKillSwitchOff, isOptedOut } from '../services/scheduledSendSuppression.js';
import type {
  NudgeKind,
  NudgeSkipReason,
  PlacementNudgeItem,
  PlacementNudgesRepo,
} from '../repos/placementNudgesRepo.js';
import type { PlacementItem, PlacementsRepo } from '../repos/placementsRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';
import {
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import { resolveMessage } from '../messages/index.js';
import {
  clampOutOfQuietHours,
  isQuietTime,
  type QuietHoursWindow,
} from '../lib/quietHours.js';
import type { SettingsRepo } from '../repos/settingsRepo.js';
// The quiet-hours window reader is single-sourced with the tour-reminder armer
// (same defensive fallback, same log line) - not a new copy here.
import { readQuietHoursWindow } from './tourReminders.js';

// ---------------------------------------------------------------------------
// The ladder: stage → the single nudge rung armed on entry.
// ---------------------------------------------------------------------------

interface NudgeRung {
  kind: NudgeKind;
  recipient: 'tenant' | 'landlord';
  delayMs: number;
}

const HOUR = 60 * 60 * 1000;

// The nudge BODY now lives in the message catalog (id `nudge.<kind>`); the rung
// keeps only its routing/timing (kind/recipient/delayMs). Resolve the body via
// resolveMessage(`nudge.${rung.kind}`) at the send/preview sites.
export const NUDGE_RUNGS: Partial<Record<PlacementStage, NudgeRung>> = {
  awaiting_receipt: {
    kind: 'receipt_check',
    recipient: 'tenant',
    delayMs: 24 * HOUR,
  },
  awaiting_completion: {
    kind: 'completion_check',
    recipient: 'tenant',
    delayMs: 24 * HOUR,
  },
  awaiting_approval: {
    kind: 'approval_check',
    recipient: 'landlord',
    delayMs: 24 * HOUR,
  },
  awaiting_landlord_submission: {
    kind: 'rta_window_closing',
    recipient: 'landlord',
    delayMs: 36 * HOUR,
  },
};

/**
 * Reverse index kind → the stage whose rung it belongs to. Used by the poller to
 * decide whether a due row is still relevant to the placement's CURRENT stage.
 */
const STAGE_BY_KIND: Partial<Record<NudgeKind, PlacementStage>> = Object.fromEntries(
  (Object.entries(NUDGE_RUNGS) as Array<[PlacementStage, NudgeRung]>).map(
    ([stage, rung]) => [rung.kind, stage],
  ),
) as Partial<Record<NudgeKind, PlacementStage>>;

/**
 * The denormalized inbox display name from a contact's resolved fields —
 * `firstName lastName` trimmed → a non-empty string, else null (HONEST: a name is
 * never invented). Mirrors the contacts-route helper of the same shape. PII
 * (doc §9): the name is DATA (denorm'd onto the thread), NEVER logged here.
 */
function contactDisplayName(contact: ContactItem): string | null {
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : null;
}

// ---------------------------------------------------------------------------
// armNudgeForStage
// ---------------------------------------------------------------------------

export interface ArmNudgeForStageDeps {
  placementNudgesRepo: PlacementNudgesRepo;
  /**
   * Quiet-hours source (REQUIRED so every call site is forced to supply one -
   * an unclamped armer would schedule a 2am chase). Narrow read-only shape (the
   * `resolveWithSettings` precedent) so tests stub one method.
   */
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
  /**
   * Optional event bus (scheduled-message-visibility Task 6). When present, a
   * best-effort `scheduled.updated` is emitted after every arm/cancel so the
   * contact timeline's pinned "Upcoming" section refetches live. NEVER throws /
   * fails the stage transition — a broken emit is swallowed.
   */
  events?: EventBus;
  logger?: Logger;
}

/**
 * Re-key the placement's nudge to its new stage. ALWAYS cancels the prior
 * pending row(s) first (the old chase is moot the instant the stage moves), then
 * arms the new stage's rung IFF one exists. Rung-less / terminal stages are
 * cancel-only. One row per stage entry (v1 has no repeats).
 */
export async function armNudgeForStage(
  placement: PlacementItem,
  toStage: PlacementStage,
  nowIso: string,
  deps: ArmNudgeForStageDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;

  // Best-effort live-update poke: the ladder is about to change (arm and/or
  // cancel), so tell the contact timeline's pinned "Upcoming" section to
  // refetch. NEVER let a broken emit throw into — and fail — the stage
  // transition (scheduled-message-visibility Task 6). ID-only, advisory payload;
  // a landlord-recipient rung is deliberately NOT resolved (the client refetches
  // unconditionally, so tenantId is enough of a hint).
  const pokeTimeline = (): void => {
    if (deps.events === undefined) return;
    try {
      deps.events.emit('scheduled.updated', { contactId: placement.tenantId });
    } catch (err) {
      log.error(
        { err, placementId: placement.placementId },
        'placement nudge: scheduled.updated emit failed (best-effort, ignored)',
      );
    }
  };

  // Cancel first — the stage moved on, so any pending chase for the old stage is
  // moot (and a late poll must never fire it).
  await deps.placementNudgesRepo.cancelForPlacement(placement.placementId);

  const rung = NUDGE_RUNGS[toStage];
  if (!rung) {
    log.info(
      { placementId: placement.placementId, stage: toStage },
      'placement nudge: stage has no rung (terminal/rung-less) — canceled only',
    );
    pokeTimeline();
    return;
  }

  // Quiet hours (spec 2026-08-03): clamp BEFORE the row is written, so the
  // stored dueAt is the real send time (a rung is never re-timed later). One
  // rung per stage, so there is nothing to supersede here.
  const window = await readQuietHoursWindow(deps.settingsRepo, log);
  const dueAt = clampOutOfQuietHours(
    new Date(Date.parse(nowIso) + rung.delayMs).toISOString(),
    window,
  );
  const row = await deps.placementNudgesRepo.create({
    placementId: placement.placementId,
    kind: rung.kind,
    dueAt,
  });
  log.info(
    { placementId: placement.placementId, stage: toStage, kind: rung.kind, dueAt, nudgeId: row.nudgeId },
    'placement nudge armed',
  );
  pokeTimeline();
}

// ---------------------------------------------------------------------------
// runDuePlacementNudges
// ---------------------------------------------------------------------------

export interface RunDuePlacementNudgesDeps {
  placementNudgesRepo: PlacementNudgesRepo;
  placementsRepo: PlacementsRepo;
  contactsRepo: ContactsRepo;
  unitsRepo: UnitsRepo;
  conversationsRepo: ConversationsRepo;
  sendMessageService: SendMessageService;
  /**
   * Quiet-hours source for the FIRE-TIME BACKSTOP (REQUIRED - an unfenced
   * poller would still fire every legacy overnight row). Read ONCE per tick.
   * Narrow read-only shape (the `resolveWithSettings` precedent) so tests stub
   * one method.
   */
  settingsRepo: Pick<SettingsRepo, 'getOrgSettings'>;
  /** Live-update bus: a claim-skip retires a rung the panels show as upcoming,
   *  so poke them to refetch (best-effort; mirrors tourReminders' claimSkipRow).
   *  Optional, but worker.ts now passes appEvents so these pokes cross the event
   *  bridge (lib/eventBridge.ts) to app SSE clients when EVENT_BRIDGE_URL is set;
   *  the dev tick seam continues to inject its own bus. */
  events?: EventBus;
  logger?: Logger;
}

/**
 * Retire a rung the poll cannot deliver (claim-skip): stamps skippedAt +
 * skipReason so the row leaves listDue exactly once (instead of being re-listed
 * and re-warned every poll tick forever), and tells live surfaces to refetch so
 * the Deadlines-and-nudges card flips to its "Skipped" chip.
 */
async function claimSkipRow(
  row: PlacementNudgeItem,
  reason: NudgeSkipReason,
  nowIso: string,
  deps: RunDuePlacementNudgesDeps,
  tenantId?: string,
): Promise<void> {
  const claimed = await deps.placementNudgesRepo.claimSkip(row.nudgeId, nowIso, reason);
  if (claimed && deps.events !== undefined) {
    try {
      deps.events.emit('scheduled.updated', {
        ...(tenantId !== undefined && { contactId: tenantId }),
      });
    } catch {
      // Best-effort poke only — never let a broken emit fail the poll row.
    }
  }
}

/**
 * The stateless poll handler. Queries all pending nudges due at or before `now`,
 * then per row: resolves the placement, retires the row if its stage has moved
 * on, else routes to the recipient party's 1:1 conversation and sends.
 *
 * Idempotent: listDue filters out sentAt/canceledAt rows; claimSend atomically
 * stamps sentAt BEFORE the send (and blocks canceledAt rows) → exactly-once.
 *
 * Error handling (mirrors jobs/tourReminders.ts):
 * - SendRefusedError → warn + return (claim already stamped — no retry).
 * - Other send error → error + rethrow into the per-row catch (claim stamped).
 * - Missing placement/unit/landlord/contact/phone and stale/unknown rows →
 *   CLAIM-SKIP (skippedAt + skipReason), so the row retires exactly once and
 *   the dashboard card shows an honest "Skipped" instead of a perpetual
 *   "upcoming" (or a false "Sent"). A missing 1:1 conversation is NOT a skip —
 *   it is created on demand and the send proceeds.
 * Designed to be called by a setInterval in worker.ts.
 */
export async function runDuePlacementNudges(
  nowIso: string,
  deps: RunDuePlacementNudgesDeps,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;

  const dueRows = await deps.placementNudgesRepo.listDue(nowIso);
  if (dueRows.length === 0) return;

  log.info({ count: dueRows.length, now: nowIso }, 'placement nudge poll: processing due rows');

  // ONE settings read per tick (not per row) - the window is the same for every
  // row in the batch, and a settings failure falls back to the defaults.
  const window = await readQuietHoursWindow(deps.settingsRepo, log);

  for (const row of dueRows) {
    try {
      await processNudgeRow(row, nowIso, window, deps, log);
    } catch (err) {
      // Per-row errors are isolated: log + continue so one bad row doesn't block
      // the rest of the batch.
      log.error(
        { err, nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
        'placement nudge poll: unexpected error processing row',
      );
    }
  }
}

/** The resolved recipient of one due rung (no claim, no send, no side effects). */
interface NudgeTarget {
  placement: PlacementItem;
  rung: NudgeRung;
  rungStage: PlacementStage;
  contactId: string;
  contact: ContactItem;
  phone: string;
}

/**
 * Resolve a rung's recipient: placement -> rung -> STALENESS -> tenant/landlord
 * contact -> phone. Read-only (it deliberately stops SHORT of the on-demand
 * conversation mint) so each caller decides what "unresolvable" MEANS: the poll
 * retires the row with a claim-skip carrying exactly the returned reason, a
 * human force-send refuses and leaves it pending. Every failure value is a
 * NudgeSkipReason, so the poll's behavior is unchanged.
 */
async function resolveNudgeTarget(
  row: PlacementNudgeItem,
  deps: RunDuePlacementNudgesDeps,
  log: Logger,
): Promise<NudgeTarget | { unresolvable: NudgeSkipReason; tenantId?: string }> {
  const placement = await deps.placementsRepo.getById(row.placementId);
  if (!placement) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId },
      'placement nudge: placement not found',
    );
    return { unresolvable: 'placement_missing' };
  }

  const rungStage = STAGE_BY_KIND[row.kind];
  const rung = rungStage ? NUDGE_RUNGS[rungStage] : undefined;
  if (!rungStage || !rung) {
    // A row with an unknown kind (no rung).
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
      'placement nudge: no rung for kind',
    );
    return { unresolvable: 'unknown_kind', tenantId: placement.tenantId };
  }

  // STALE-STAGE GUARD: the placement already LEFT the stage this row chases, so
  // its copy is stale. The poll retires it (claim-skip) WITHOUT sending - and
  // without stamping sentAt, which would make the card report "Sent" for a text
  // the recipient never got; a force-send refuses rather than send stale copy.
  if (placement.stage !== rungStage) {
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind, currentStage: placement.stage, rungStage },
      'placement nudge: stage moved on - stale row',
    );
    return { unresolvable: 'stage_moved', tenantId: placement.tenantId };
  }

  // Resolve the recipient contact: tenant = placement.tenantId; landlord =
  // unit.landlordId (the legacy primary-landlord field on the unit).
  let contactId: string;
  if (rung.recipient === 'tenant') {
    contactId = placement.tenantId;
  } else {
    const unit = await deps.unitsRepo.getById(placement.unitId);
    if (!unit) {
      log.warn(
        { nudgeId: row.nudgeId, placementId: row.placementId, unitId: placement.unitId, kind: row.kind },
        'placement nudge: unit not found',
      );
      return { unresolvable: 'unit_missing', tenantId: placement.tenantId };
    }
    if (typeof unit.landlordId !== 'string' || unit.landlordId.length === 0) {
      log.warn(
        { nudgeId: row.nudgeId, placementId: row.placementId, unitId: placement.unitId, kind: row.kind },
        'placement nudge: unit has no landlordId',
      );
      return { unresolvable: 'no_landlord', tenantId: placement.tenantId };
    }
    contactId = unit.landlordId;
  }

  const contact = await deps.contactsRepo.getById(contactId);
  if (!contact) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
      'placement nudge: recipient contact not found',
    );
    return { unresolvable: 'contact_missing', tenantId: placement.tenantId };
  }

  // Primary phone (scalar back-compat, never logged).
  const phone = contact.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
      'placement nudge: recipient contact has no phone',
    );
    return { unresolvable: 'contact_no_phone', tenantId: placement.tenantId };
  }

  return { placement, rung, rungStage, contactId, contact, phone };
}

/**
 * The recipient's existing 1:1 among the phone's conversations. A tenant rung
 * routes to tenant_1to1 (or an unresolved unknown_1to1); a landlord rung to
 * landlord_1to1 (or unknown_1to1). NEVER the masked group (founder 2026-07-02).
 */
function findNudgeConversation(
  convs: ConversationItem[],
  rung: NudgeRung,
): ConversationItem | undefined {
  const wantedType = rung.recipient === 'tenant' ? 'tenant_1to1' : 'landlord_1to1';
  return convs.find((c) => c.type === wantedType || c.type === 'unknown_1to1');
}

/**
 * No usable 1:1 yet - CREATE it on demand so the send can proceed. This unblocks
 * the DESIGNED landlord flow where all prior traffic went through the masked
 * pool number, so no landlord_1to1 was ever minted (approval_check /
 * rta_window_closing used to silently skip). Thread existence is NOT a consent
 * mechanism: every gate (sms_sending_disabled, opt-out, JIT consent, breaker,
 * manual mode) is enforced by sendMessageService at send time and still fires.
 * Mirrors the contacts "text a brand-new contact" fix (9a45085):
 * createOrGetByParticipantPhone is the same one-active-conversation-per-phone
 * claim every inbound path uses, so a racing inbound never creates a duplicate.
 *
 * SIDE-EFFECTING by design, so callers invoke it only once a send is actually
 * going to be attempted (forceSendNudge runs its refusal gates first).
 */
async function mintNudgeConversation(
  row: PlacementNudgeItem,
  contact: ContactItem,
  phone: string,
  contactId: string,
  rung: NudgeRung,
  deps: RunDuePlacementNudgesDeps,
  log: Logger,
): Promise<ConversationItem> {
  let conv = await deps.conversationsRepo.createOrGetByParticipantPhone(
    phone,
    conversationTypeFor(contact),
  );
  // Best-effort display-name denorm so the NEW inbox row shows the person, not a
  // bare phone (mirrors 9a45085). A failure here must NEVER block the send - and
  // no explicit event emit is needed: the send emits conversation.updated from
  // touchLastActivity's ALL_NEW, which carries this name to the live inbox.
  const displayName = contactDisplayName(contact);
  if (displayName !== null && conv.participant_display_name !== displayName) {
    try {
      conv = await deps.conversationsRepo.applyTriage(conv.conversationId, { displayName });
    } catch (err) {
      log.warn(
        { err, nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
        'placement nudge: display-name denorm failed (best-effort) - sending anyway',
      );
    }
  }
  log.info(
    { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind, recipient: rung.recipient, conversationId: conv.conversationId },
    'placement nudge: no 1:1 conversation - created on demand',
  );
  return conv;
}

async function processNudgeRow(
  row: PlacementNudgeItem,
  nowIso: string,
  window: QuietHoursWindow,
  deps: RunDuePlacementNudgesDeps,
  log: Logger,
): Promise<void> {
  // QUIET-HOURS BACKSTOP (spec 2026-08-03 section 6), PRE-CLAIM and FIRST.
  // Normal rows are clamped at arm time, so this only fires for legacy rows and
  // worker-downtime catch-up. Returning WITHOUT claiming leaves the row in
  // listDue - it re-fires within one poll tick of quiet-end. This must NEVER
  // become a post-claim refusal: claimSend IS the sentAt stamp, so a refusal
  // after it would destroy the message permanently. No supersession twin here -
  // the ladder arms ONE rung per stage, so a nudge cannot self-collide.
  if (isQuietTime(nowIso, window)) {
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
      'placement nudge due during quiet hours - deferred (not claimed)',
    );
    return;
  }

  // Resolve the recipient (placement -> rung -> staleness -> contact -> phone).
  // Shared with forceSendNudge so a human send can never route differently from
  // the poll; the POLL retires an unresolvable row with the same claim-skip
  // reasons it always used - including 'stage_moved'.
  const target = await resolveNudgeTarget(row, deps, log);
  if ('unresolvable' in target) {
    log.info(
      {
        nudgeId: row.nudgeId,
        placementId: row.placementId,
        kind: row.kind,
        reason: target.unresolvable,
      },
      'placement nudge undeliverable - retiring (claim-skipped)',
    );
    await claimSkipRow(row, target.unresolvable, nowIso, deps, target.tenantId);
    return;
  }
  const { rung, contactId, contact, phone } = target;

  // Find (or create) the recipient's 1:1 conversation.
  const conv =
    findNudgeConversation(await deps.conversationsRepo.findByParticipantPhone(phone), rung) ??
    (await mintNudgeConversation(row, contact, phone, contactId, rung, deps, log));

  // CLAIM-BEFORE-SEND: atomically stamp sentAt BEFORE the outbound send so two
  // concurrent poll ticks both see the same due row but only the first to claim
  // wins. The claim condition also blocks canceledAt rows, closing the
  // cancel-then-poll TOCTOU race. A lost claim (concurrent tick / cancel) is a
  // benign no-op — skip silently.
  const claimed = await deps.placementNudgesRepo.claimSend(row.nudgeId, nowIso);
  if (!claimed) {
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
      'placement nudge claim lost (concurrent tick or canceled) — skipping',
    );
    return;
  }

  // Claim succeeded — now send. A crash after this point drops this one nudge
  // (same accepted tradeoff as tourReminders / missedCallAutoText).
  try {
    await deps.sendMessageService({
      conversationId: conv.conversationId,
      body: resolveMessage(`nudge.${rung.kind}`),
      author: 'teammate',
      automated: true,
    });
    log.info(
      {
        nudgeId: row.nudgeId,
        placementId: row.placementId,
        contactId,
        kind: row.kind,
        recipient: rung.recipient,
        route: `${rung.recipient}_1to1`,
      },
      'placement nudge sent',
    );
  } catch (err) {
    if (err instanceof SendRefusedError) {
      // By-design refusal (opt-out / breaker / manual mode): the claim is already
      // stamped so no retry will fire. Same pattern as tourReminders.
      log.warn(
        {
          nudgeId: row.nudgeId,
          placementId: row.placementId,
          contactId,
          kind: row.kind,
          refusal: err.code,
        },
        'placement nudge refused (opt-out/breaker/manual) — claim already stamped, not retried',
      );
      return;
    }
    // Non-refusal error: the claim is already stamped (sentAt set), so this nudge
    // will NOT retry on the next poll — accepted tradeoff (mirrors tourReminders).
    log.error(
      { err, nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
      'placement nudge send failed (non-refusal) — claim already stamped, not retried',
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// forceSendNudge (Send now - quiet-hours spec section 7)
// ---------------------------------------------------------------------------

/** Why a human force-send was refused BEFORE the row was claimed. */
export type NudgeForceSendRefusal =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'no_consent'
  | NudgeSkipReason;

export type NudgeForceSendResult =
  /** Claimed and handed to the send path. */
  | { outcome: 'sent' }
  /** Already sent/canceled/skipped, or the poll won the claim race. */
  | { outcome: 'not_pending' }
  /** Refused PRE-claim: the row is untouched and still pending. */
  | { outcome: 'refused'; reason: NudgeForceSendRefusal }
  /** The narrow post-claim race (see forceSendNudge): claim KEPT, nothing sent. */
  | { outcome: 'refused_post_claim'; reason: SendRefusedError['code'] };

/**
 * Send ONE pending nudge immediately, on a human's click. The twin of
 * forceSendReminder (jobs/tourReminders.ts) - same contract:
 *
 * - BYPASSES quiet hours, manual mode and the per-conversation breaker (the send
 *   goes out with `automated: false`).
 * - RESPECTS the kill switch, opt-out, JIT consent AND the staleness check (a
 *   nudge whose placement has moved on refuses rather than sending stale copy).
 * - EVERY gate runs BEFORE `claimSend`, because the claim IS the sentAt stamp: a
 *   refusal after it would leave the row claimed-but-unsent. A refusal therefore
 *   leaves the row exactly as it found it - still pending. In particular a stale
 *   row is NOT claim-skipped here: retiring stale rows is the POLL's job, on its
 *   own ticks, so a human refusal never consumes the row.
 * - The gates also run BEFORE the on-demand conversation mint, so a refused
 *   force-send never leaves a brand-new empty thread behind. A send that DOES
 *   proceed mints exactly like the poll (accepted, poller parity).
 *
 * The one surviving race (an opt-out or breaker trip landing between the
 * pre-check and the provider call) surfaces as a post-claim SendRefusedError:
 * the claim is KEPT (poller parity) and reported as `refused_post_claim` so the
 * route can show an honest error instead of a false "sent".
 *
 * PII (doc s9): log ids/kinds/refusal codes only - never a phone/name/body.
 */
export async function forceSendNudge(
  nudgeId: string,
  placementId: string,
  nowIso: string,
  smsSendingEnabled: boolean | undefined,
  deps: RunDuePlacementNudgesDeps,
): Promise<NudgeForceSendResult> {
  const log = deps.logger ?? defaultLogger;

  const rows = await deps.placementNudgesRepo.listByPlacement(placementId);
  const row = rows.find((r) => r.nudgeId === nudgeId);
  if (row === undefined) return { outcome: 'refused', reason: 'placement_missing' };
  if (row.sentAt !== undefined || row.canceledAt !== undefined || row.skippedAt !== undefined) {
    return { outcome: 'not_pending' };
  }

  const refuse = (reason: NudgeForceSendRefusal): NudgeForceSendResult => {
    log.warn(
      { nudgeId, placementId, kind: row.kind, reason },
      'placement nudge force-send refused (pre-claim) - row left pending',
    );
    return { outcome: 'refused', reason };
  };

  const target = await resolveNudgeTarget(row, deps, log);
  if ('unresolvable' in target) return refuse(target.unresolvable);

  // PRE-CLAIM ABSOLUTE GATES, and BEFORE the conversation mint. Manual mode and
  // the breaker are deliberately NOT checked - this is a human send.
  if (isKillSwitchOff(smsSendingEnabled)) return refuse('sms_sending_disabled');
  // Opt-out is absolute; consent is required because `automated: false` is
  // subject to the JIT consent gate (services/sendMessage.ts) - checking it here
  // is what keeps that gate from firing AFTER the claim. A recipient with no
  // thread yet has no conversation-level flag to read (undefined), exactly as
  // the evaluator expects.
  const existing = findNudgeConversation(
    await deps.conversationsRepo.findByParticipantPhone(target.phone),
    target.rung,
  );
  if (isOptedOut(existing?.sms_opt_out, target.contact.sms_opt_out === true)) {
    return refuse('contact_opted_out');
  }
  if (!hasSmsConsent(target.contact)) return refuse('no_consent');

  const conv =
    existing ??
    (await mintNudgeConversation(
      row,
      target.contact,
      target.phone,
      target.contactId,
      target.rung,
      deps,
      log,
    ));

  const claimed = await deps.placementNudgesRepo.claimSend(row.nudgeId, nowIso);
  if (!claimed) {
    log.info(
      { nudgeId, placementId, kind: row.kind },
      'placement nudge force-send claim lost (concurrent poll tick or cancel)',
    );
    return { outcome: 'not_pending' };
  }

  try {
    await deps.sendMessageService({
      conversationId: conv.conversationId,
      body: resolveMessage(`nudge.${target.rung.kind}`),
      author: 'teammate',
      // Human force-send: bypasses manual mode + the breaker (and IS subject to
      // the JIT consent gate pre-checked above).
      automated: false,
    });
    log.info(
      {
        nudgeId,
        placementId,
        contactId: target.contactId,
        kind: row.kind,
        recipient: target.rung.recipient,
        route: `${target.rung.recipient}_1to1`,
      },
      'placement nudge force-sent',
    );
    return { outcome: 'sent' };
  } catch (err) {
    if (err instanceof SendRefusedError) {
      log.warn(
        { nudgeId, placementId, kind: row.kind, refusal: err.code },
        'placement nudge force-send refused POST-claim (race) - claim kept, not retried',
      );
      return { outcome: 'refused_post_claim', reason: err.code };
    }
    // Non-refusal error: the claim is already stamped, so this rung will NOT
    // retry - same accepted tradeoff as the poll. Surface it as a 500.
    log.error(
      { err, nudgeId, placementId, kind: row.kind },
      'placement nudge force-send failed (non-refusal) - claim already stamped, not retried',
    );
    throw err;
  }
}
