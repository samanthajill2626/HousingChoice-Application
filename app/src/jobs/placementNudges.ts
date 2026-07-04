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
//   entities ⇒ warn + skip. Mirrors tourReminders' processReminderRow EXACTLY for
//   the claim/error semantics.
//
// PII (doc §9): NEVER log a phone number/name/body. Log only
// nudgeId/placementId/tenantId/unitId/kind/stage.
import type { EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { PlacementStage } from '../lib/statusModel.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type {
  NudgeKind,
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

  const dueAt = new Date(Date.parse(nowIso) + rung.delayMs).toISOString();
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
  logger?: Logger;
}

/**
 * The stateless poll handler. Queries all pending nudges due at or before `now`,
 * then per row: resolves the placement, retires the row if its stage has moved
 * on, else routes to the recipient party's 1:1 conversation and sends.
 *
 * Idempotent: listDue filters out sentAt/canceledAt rows; claimSend atomically
 * stamps sentAt BEFORE the send (and blocks canceledAt rows) → exactly-once.
 *
 * Error handling (mirrors jobs/tourReminders.ts EXACTLY):
 * - SendRefusedError → warn + return (claim already stamped — no retry).
 * - Other send error → error + rethrow into the per-row catch (claim stamped).
 * - Missing placement/unit/contact/phone → warn + skip. A missing 1:1
 *   conversation is NOT a skip — it is created on demand and the send proceeds.
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

  for (const row of dueRows) {
    try {
      await processNudgeRow(row, nowIso, deps, log);
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

async function processNudgeRow(
  row: PlacementNudgeItem,
  nowIso: string,
  deps: RunDuePlacementNudgesDeps,
  log: Logger,
): Promise<void> {
  // Resolve the placement.
  const placement = await deps.placementsRepo.getById(row.placementId);
  if (!placement) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId },
      'placement nudge: placement not found — skipping',
    );
    return;
  }

  const rungStage = STAGE_BY_KIND[row.kind];
  const rung = rungStage ? NUDGE_RUNGS[rungStage] : undefined;
  if (!rungStage || !rung) {
    // A row with an unknown kind (no rung) — retire it so it never reappears.
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind },
      'placement nudge: no rung for kind — retiring row (claimed, not sent)',
    );
    await deps.placementNudgesRepo.claimSend(row.nudgeId, nowIso);
    return;
  }

  // STALE-STAGE GUARD: the placement already LEFT the stage this row chases. Claim
  // the row to retire it (so it never reappears) and do NOT send — a late row for
  // a stage the placement has moved past is canceled, not delivered.
  if (placement.stage !== rungStage) {
    await deps.placementNudgesRepo.claimSend(row.nudgeId, nowIso);
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, kind: row.kind, currentStage: placement.stage, rungStage },
      'placement nudge: stage moved on — stale row retired (claimed, not sent)',
    );
    return;
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
        'placement nudge: unit not found — skipping',
      );
      return;
    }
    if (typeof unit.landlordId !== 'string' || unit.landlordId.length === 0) {
      log.warn(
        { nudgeId: row.nudgeId, placementId: row.placementId, unitId: placement.unitId, kind: row.kind },
        'placement nudge: unit has no landlordId — skipping',
      );
      return;
    }
    contactId = unit.landlordId;
  }

  const contact = await deps.contactsRepo.getById(contactId);
  if (!contact) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
      'placement nudge: recipient contact not found — skipping',
    );
    return;
  }

  // Primary phone (scalar back-compat, never logged).
  const phone = contact.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    log.warn(
      { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
      'placement nudge: recipient contact has no phone — skipping',
    );
    return;
  }

  // Find (or create) the recipient's 1:1 conversation via phone lookup. A tenant
  // rung routes to tenant_1to1 (or an unresolved unknown_1to1); a landlord rung to
  // landlord_1to1 (or unknown_1to1). NEVER the masked group (founder 2026-07-02).
  const convs = await deps.conversationsRepo.findByParticipantPhone(phone);
  const wantedType = rung.recipient === 'tenant' ? 'tenant_1to1' : 'landlord_1to1';
  let conv = convs.find((c) => c.type === wantedType || c.type === 'unknown_1to1');
  if (!conv) {
    // No usable 1:1 yet — CREATE it on demand and proceed to send. This unblocks
    // the DESIGNED landlord flow where all prior traffic went through the masked
    // pool number, so no landlord_1to1 was ever minted (approval_check /
    // rta_window_closing used to silently skip). Thread existence is NOT a consent
    // mechanism: every gate (sms_sending_disabled, opt-out, JIT consent, breaker,
    // manual mode) is enforced by sendMessageService at send time and still fires.
    // Mirrors the contacts "text a brand-new contact" fix (9a45085):
    // createOrGetByParticipantPhone is the same one-active-conversation-per-phone
    // claim every inbound path uses, so a racing inbound never creates a duplicate.
    conv = await deps.conversationsRepo.createOrGetByParticipantPhone(
      phone,
      conversationTypeFor(contact),
    );
    // Best-effort display-name denorm so the NEW inbox row shows the person, not a
    // bare phone (mirrors 9a45085). A failure here must NEVER block the send — and
    // no explicit event emit is needed: the send below emits conversation.updated
    // from touchLastActivity's ALL_NEW, which carries this name to the live inbox.
    const displayName = contactDisplayName(contact);
    if (displayName !== null && conv.participant_display_name !== displayName) {
      try {
        conv = await deps.conversationsRepo.applyTriage(conv.conversationId, { displayName });
      } catch (err) {
        log.warn(
          { err, nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind },
          'placement nudge: display-name denorm failed (best-effort) — sending anyway',
        );
      }
    }
    log.info(
      { nudgeId: row.nudgeId, placementId: row.placementId, contactId, kind: row.kind, recipient: rung.recipient, conversationId: conv.conversationId },
      'placement nudge: no 1:1 conversation — created on demand',
    );
  }

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
