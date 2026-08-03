// Placement nudges endpoints (placement-detail-hub, Task 2).
//
//   GET   /api/placements/:placementId/nudges
//        -> { nudges: PlacementNudgeView[] }  (sorted dueAt DESCENDING)
//   PATCH /api/placements/:placementId/nudges/:nudgeId  { canceled: boolean }
//        -> { nudge: PlacementNudgeView } | 409 (already sent, or the cancel/
//           restore raced the poll's claim -> the honest current state returns)
//   POST  /api/placements/:placementId/nudges/:nudgeId/send-now
//        -> { nudge: PlacementNudgeView } | 409 { error, nudge } - "Send now"
//           (quiet-hours spec section 7): a human sends ONE pending rung
//           immediately through the poll's own resolve/claim/send path.
//
// Mounted under /api/placements (behind requireAuth via the /api mount), a
// SIBLING router to the placements CRUD router: its only paths are the
// /:placementId/nudges* segments, DISTINCT from the placements router's
// /:placementId (a single-segment match, never /:placementId/nudges), so the two
// never collide — the same split tourReminders.ts uses under /api/tours.
//
// GET surfaces each armed application-nudge rung's state
// (upcoming|sent|canceled|skipped) so the detail hub can show WHAT scheduled
// texts are queued, which fired, and which the poll retired unsent.
// PATCH is the operator's per-rung cancel/un-cancel: atomic conditional writes
// (repo cancel/uncancel), so a cancel racing the poll's send claim resolves to
// exactly one outcome — a lost race 409s with the row's real state instead of
// lying. Restoring a PAST-DUE rung is allowed and fires on the next poll tick.
//
// SUPPRESSION ESTIMATE (GET, upcoming rungs only - quiet-hours spec
// 2026-08-03): an honest preview of whether the automated send would be
// DEFERRED or refused at fire time, in the SAME shape the tour-reminder view
// uses (TourReminderView.suppression) so the dashboard renders one chip for
// both ladders. Fed only the inputs this read already has in hand: the
// quiet-hours window (server wall clock), the kill switch (config) and the
// stale-stage check (the placement is already loaded). Per-recipient opt-out
// and per-conversation manual mode are deliberately NOT resolved - they need a
// new per-row contact/conversation lookup whose recipient differs per rung -
// so this estimate is a SUBSET of the tour view's. Gap tracked in
// docs/issues/placement-nudge-suppression-opt-out-parity.md.
//
// recipient is DERIVED from kind per the nudge ladder (NUDGE_RUNGS in
// jobs/placementNudges.ts): the approval_check + rta_window_closing rungs route
// to the landlord, every other rung to the tenant. The cancel/restore emit keys
// scheduled.updated on the RECIPIENT's contactId (tenant -> placement.tenantId;
// landlord -> unit.landlordId via a best-effort unitsRepo lookup, falling back to
// the tenant when unresolvable — the dashboard panels refetch on ANY
// scheduled.updated regardless).
//
// PII (doc §9): the response carries state/ids to the authed client; log lines
// stay ids/counts only.
import { json, Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isQuietTime } from '../lib/quietHours.js';
import type { PlacementStage } from '../lib/statusModel.js';
import {
  forceSendNudge,
  NUDGE_RUNGS,
  type RunDuePlacementNudgesDeps,
} from '../jobs/placementNudges.js';
import { readQuietHoursWindow } from '../jobs/tourReminders.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createSendMessageService, type SendMessageService } from '../services/sendMessage.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  evaluateScheduledSendSuppression,
  type ScheduledSuppression,
} from '../services/scheduledSendSuppression.js';
import {
  createPlacementNudgesRepo,
  type NudgeKind,
  type NudgeSkipReason,
  type PlacementNudgeItem,
  type PlacementNudgesRepo,
} from '../repos/placementNudgesRepo.js';
import { createPlacementsRepo, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';

export interface PlacementNudgesRouterDeps {
  logger?: Logger;
  /** Kill-switch input for the suppression estimate (config.smsSendingEnabled). */
  config?: AppConfig;
  placementsRepo?: PlacementsRepo;
  placementNudgesRepo?: PlacementNudgesRepo;
  /** Landlord resolution: a landlord-routed nudge keys its emit on unit.landlordId. */
  unitsRepo?: UnitsRepo;
  /** Quiet-hours window source for the suppression estimate (narrow read-only
   *  shape - the `resolveWithSettings` precedent). */
  settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'>;
  // ---- Send-now deps (quiet-hours spec section 7) --------------------------
  // The force-send reuses the poll's resolve/claim/send path, so this router
  // needs the poll's recipient + send deps too. All optional with factory
  // defaults, mirroring the dev.ts tick builders; api.ts threads the
  // process-wide instances so tests that inject fakes keep talking to fakes.
  /** Recipient resolution: tenant contact / landlord contact for the rung. */
  contactsRepo?: ContactsRepo;
  /** The recipient's 1:1 thread (found, or minted on demand at send time). */
  conversationsRepo?: ConversationsRepo;
  /** The shared send service (force-sends use automated: false). */
  sendMessageService?: SendMessageService;
  /** Records WHO clicked Send now (`nudge_force_sent` on `placements#<id>`). */
  auditRepo?: AuditRepo;
  /** Live-update bus (defaults to appEvents): a cancel/restore emits
   *  scheduled.updated so the Deadlines-and-nudges card + the timelines' Upcoming
   *  buckets refetch. */
  events?: EventBus;
}

/** One nudge rung as the dashboard renders it. */
export interface PlacementNudgeView {
  nudgeId: string;
  placementId: string;
  kind: NudgeKind;
  /** The party a rung's automated text goes to, derived from kind (NUDGE_RUNGS). */
  recipient: 'tenant' | 'landlord';
  /** ISO 8601 — when the rung is/was scheduled to fire. */
  dueAt: string;
  /** 'skipped' = the poll retired the rung UNSENT (stale stage / undeliverable
   *  recipient) — see skipReason. Distinct from 'sent' so the card never
   *  reports a text the recipient did not get. */
  state: 'upcoming' | 'sent' | 'canceled' | 'skipped';
  sentAt?: string;
  canceledAt?: string;
  skippedAt?: string;
  skipReason?: NudgeSkipReason;
  /** Only computed for `upcoming` rungs on GET (see the SUPPRESSION ESTIMATE
   *  note in the file header). Same shape as TourReminderView.suppression so
   *  the dashboard renders both ladders through one chip. */
  suppression?: ScheduledSuppression;
}

// kind -> the stage whose rung it is, derived ONCE from the single-source nudge
// ladder (mirrors the poller's private STAGE_BY_KIND) so the stale-stage
// estimate can never drift from the stale-stage claim-skip.
const STAGE_BY_KIND = Object.fromEntries(
  (Object.entries(NUDGE_RUNGS) as Array<[PlacementStage, { kind: NudgeKind } | undefined]>)
    .filter((entry): entry is [PlacementStage, { kind: NudgeKind }] => entry[1] !== undefined)
    .map(([stage, rung]) => [rung.kind, stage]),
) as Partial<Record<NudgeKind, PlacementStage>>;

// kind -> recipient, derived ONCE from the single-source nudge ladder so it can
// never drift from the poll's routing (jobs/placementNudges.ts). A kind absent
// from the ladder falls back to 'tenant' (the ladder's default routing).
const RECIPIENT_BY_KIND = Object.fromEntries(
  Object.values(NUDGE_RUNGS)
    .filter(
      (rung): rung is { kind: NudgeKind; recipient: 'tenant' | 'landlord'; delayMs: number } =>
        rung !== undefined,
    )
    .map((rung) => [rung.kind, rung.recipient]),
) as Partial<Record<NudgeKind, 'tenant' | 'landlord'>>;

const recipientOf = (kind: NudgeKind): 'tenant' | 'landlord' => RECIPIENT_BY_KIND[kind] ?? 'tenant';

/** canceledAt wins over sentAt/skippedAt (terminal markers are mutually
 *  exclusive by the repo's conditional writes, but be safe). */
function stateOf(row: PlacementNudgeItem): PlacementNudgeView['state'] {
  if (row.canceledAt !== undefined) return 'canceled';
  if (row.skippedAt !== undefined) return 'skipped';
  if (row.sentAt !== undefined) return 'sent';
  return 'upcoming';
}

/** Project one stored row -> its wire view. */
function viewOf(row: PlacementNudgeItem): PlacementNudgeView {
  return {
    nudgeId: row.nudgeId,
    placementId: row.placementId,
    kind: row.kind,
    recipient: recipientOf(row.kind),
    dueAt: row.dueAt,
    state: stateOf(row),
    ...(row.sentAt !== undefined && { sentAt: row.sentAt }),
    ...(row.canceledAt !== undefined && { canceledAt: row.canceledAt }),
    ...(row.skippedAt !== undefined && { skippedAt: row.skippedAt }),
    ...(row.skipReason !== undefined && { skipReason: row.skipReason }),
  };
}

export function createPlacementNudgesRouter(deps: PlacementNudgesRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const nudges = deps.placementNudgesRepo ?? createPlacementNudgesRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;

  // Send-now (POST /:placementId/nudges/:nudgeId/send-now) runs the SAME
  // resolve/claim/send path the worker poll runs, so it takes the poll's dep
  // bundle. Assembled ONCE at router creation (the dev.ts tick-builder shape):
  // every factory below only builds a client object, no network at construction.
  const pollerDeps: RunDuePlacementNudgesDeps = {
    placementNudgesRepo: nudges,
    placementsRepo: placements,
    contactsRepo: deps.contactsRepo ?? createContactsRepo({ logger: deps.logger }),
    unitsRepo: units,
    conversationsRepo: deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger }),
    sendMessageService:
      deps.sendMessageService ?? createSendMessageService({ config, logger: deps.logger }),
    settingsRepo: settings,
    events,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  };

  const router = Router();

  /**
   * Resolve the RECIPIENT contactId a cancel/restore emit keys on: a tenant rung
   * -> placement.tenantId; a landlord rung -> unit.landlordId (best-effort lookup).
   * Falls back to the tenant when the unit/landlord is unresolvable — the panels
   * refetch on ANY scheduled.updated, so the tenantId is a sufficient hint.
   */
  async function recipientContactId(
    row: PlacementNudgeItem,
    placement: { tenantId: string; unitId: string },
  ): Promise<string> {
    if (recipientOf(row.kind) === 'tenant') return placement.tenantId;
    try {
      const unit = await units.getById(placement.unitId);
      if (unit && typeof unit.landlordId === 'string' && unit.landlordId.length > 0) {
        return unit.landlordId;
      }
    } catch (err) {
      log.warn(
        { err, placementId: row.placementId, kind: row.kind },
        'placement nudge: landlord lookup failed for emit — falling back to tenant',
      );
    }
    return placement.tenantId;
  }

  // PATCH /:placementId/nudges/:nudgeId { canceled } — operator cancel/restore of
  // ONE rung (see file header for race + past-due semantics).
  router.patch('/:placementId/nudges/:nudgeId', json(), async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    const nudgeId = String(req.params['nudgeId'] ?? '');
    const canceled = (req.body as { canceled?: unknown } | undefined)?.canceled;
    if (typeof canceled !== 'boolean') {
      res.status(400).json({ error: 'canceled (boolean) is required' });
      return;
    }

    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const rows = await nudges.listByPlacement(placementId);
    if (!rows.some((r) => r.nudgeId === nudgeId)) {
      res.status(404).json({ error: 'nudge_not_found' });
      return;
    }

    const won = canceled
      ? await nudges.cancel(nudgeId, new Date().toISOString())
      : await nudges.uncancel(nudgeId);

    // Re-read for the HONEST post-write state (also what a lost race reports:
    // e.g. the poll claimed the row between our list and the conditional write).
    const after = (await nudges.listByPlacement(placementId)).find((r) => r.nudgeId === nudgeId)!;
    if (!won) {
      log.info(
        { placementId, nudgeId, wanted: canceled ? 'cancel' : 'restore', state: stateOf(after) },
        'placement nudge cancel/restore lost the claim — reporting current state',
      );
      res.status(409).json({
        error: canceled ? 'nudge_not_cancelable' : 'nudge_not_restorable',
        nudge: viewOf(after),
      });
      return;
    }

    // Same live-surface nudge the poll's claim emits: the card + the timelines'
    // Upcoming buckets refetch. Keyed on the RECIPIENT's contactId.
    const contactId = await recipientContactId(after, placement);
    events.emit('scheduled.updated', { contactId });
    log.info(
      { placementId, nudgeId, kind: after.kind, canceled },
      canceled ? 'placement nudge canceled via api' : 'placement nudge restored via api',
    );
    res.json({ nudge: viewOf(after) });
  });

  // POST /:placementId/nudges/:nudgeId/send-now - "Send now" (quiet-hours spec
  // section 7), the twin of the tour-reminder endpoint. Human-triggered, so it
  // bypasses quiet hours / manual mode / the breaker but respects the kill
  // switch, opt-out, JIT consent AND the stale-stage check - all checked BEFORE
  // the claim inside forceSendNudge, so a refusal leaves the rung pending (a
  // stale row is retired by the POLL, never by a human refusal). Auth: any
  // authed staff role via the /api mount.
  //
  // 200 { nudge } on success; 409 { error, nudge } for every refusal or lost
  // race, ALWAYS with the re-read (honest) view; 404 for an unknown
  // placement / rung.
  router.post('/:placementId/nudges/:nudgeId/send-now', json(), async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    const nudgeId = String(req.params['nudgeId'] ?? '');
    const actor = (req as AuthedRequest).user?.userId;

    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    const rows = await nudges.listByPlacement(placementId);
    if (!rows.some((r) => r.nudgeId === nudgeId)) {
      res.status(404).json({ error: 'nudge_not_found' });
      return;
    }

    const result = await forceSendNudge(
      nudgeId,
      placementId,
      new Date().toISOString(),
      config.smsSendingEnabled,
      pollerDeps,
    );

    // Re-read for the HONEST post-write state (the send may have raced the poll).
    const after = (await nudges.listByPlacement(placementId)).find((r) => r.nudgeId === nudgeId)!;

    if (result.outcome === 'sent') {
      await audit.append(`placements#${placementId}`, 'nudge_force_sent', {
        nudgeId,
        kind: after.kind,
        ...(actor !== undefined && { actor }),
      });
      log.info({ placementId, nudgeId, kind: after.kind }, 'placement nudge force-sent via api');
      res.json({ nudge: viewOf(after) });
      return;
    }

    // 'not_pending' (already terminal / lost claim) vs a refusal reason vs the
    // post-claim race - the UI shows the reason verbatim, never a silent no-op.
    const error = result.outcome === 'not_pending' ? 'nudge_not_pending' : result.reason;
    log.info(
      { placementId, nudgeId, kind: after.kind, outcome: result.outcome, error },
      'placement nudge send-now refused',
    );
    res.status(409).json({ error, nudge: viewOf(after) });
  });

  // GET /:placementId/nudges — the detail hub's read of the armed rung ladder.
  router.get('/:placementId/nudges', async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');

    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }

    const rows = await nudges.listByPlacement(placementId);

    // SUPPRESSION ESTIMATE (upcoming rungs only) - see the file header for what
    // is and is NOT evaluated here. The quiet-hours window is read once per
    // request and only when something could still fire.
    const hasUpcoming = rows.some((r) => stateOf(r) === 'upcoming');
    let quietNow = false;
    if (hasUpcoming) {
      const window = await readQuietHoursWindow(settings, log);
      quietNow = isQuietTime(new Date().toISOString(), window);
    }
    const suppressionFor = (row: PlacementNudgeItem): ScheduledSuppression | undefined => {
      const rungStage = STAGE_BY_KIND[row.kind];
      return evaluateScheduledSendSuppression({
        smsSendingEnabled: config.smsSendingEnabled,
        // Per-recipient opt-out and per-conversation manual mode are NOT
        // evaluated here: both live on the RECIPIENT's 1:1 conversation/contact
        // and a tenant rung and a landlord rung target different people, so
        // reading them is a new per-row IO chain this endpoint does not do
        // today. Tracked in
        // docs/issues/placement-nudge-suppression-opt-out-parity.md.
        convOptOut: undefined,
        contactOptOut: undefined,
        aiMode: undefined,
        staleStage: rungStage !== undefined && rungStage !== placement.stage,
        quietNow,
      });
    };

    const nudgeViews: PlacementNudgeView[] = rows
      .map((row) => {
        const view = viewOf(row);
        if (view.state !== 'upcoming') return view;
        const suppression = suppressionFor(row);
        return suppression === undefined ? view : { ...view, suppression };
      })
      // DESCENDING by dueAt (newest-due first — the card leads with the latest rung).
      .sort((a, b) => (a.dueAt < b.dueAt ? 1 : a.dueAt > b.dueAt ? -1 : 0));

    log.info(
      { placementId, count: nudgeViews.length, quietNow },
      'placement nudges read',
    );
    res.json({ nudges: nudgeViews });
  });

  return router;
}
