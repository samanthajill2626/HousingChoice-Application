// PUBLIC router (M1.5) — the ONLY unauthenticated surface in the app.
//
// *** requireAuth IS INTENTIONALLY ABSENT HERE ***
// Mounted at /public in app.ts AFTER the locked chain's origin-secret validator
// + body parsers, but BEFORE (and outside of) the /api requireAuth gate — the
// housing-fair form is filled in by the public, who have no session. Because
// there is no auth fence, this surface is EXTRA strict: every route is
// rate-limited (the abuse fence), every input is validated with generic error
// messages, the SMS-sending path is idempotent per phone (never double-charge),
// and NO PII is ever logged (names/phones are hashed/truncated to a marker).
//
// Routes:
//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId? }
//        → 200 { ok: true }   (creates/dedupes a tenant contact, sends the
//          welcome text on FIRST capture only; leaks NO internal IDs/PII. A
//          present + shareable unitId stamps capture_source:'flyer' +
//          unit_of_interest on the CREATED contact instead of 'housing_fair'.)
//   GET  /public/units/:unitId/flyer
//        → 200 { flyer }      (ONLY the shareable teaser field set) | 404
//   GET  /public/units/:unitId/details
//        → 200 { details }    (the richer post-intake reveal allowlist) | 404
//
// Money note: housing-fair sends an SMS (real cost in prod). Idempotency +
// rate limiting are what keep this from being an SMS-spend abuse vector.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import { SHAREABLE_STATUSES, isDeleted } from '../repos/unitsRepo.js';
import { toUnitFlyer, toUnitFlyerDetails } from '../lib/unitFields.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';

/**
 * The §11.3 "housing-fair form → auto welcome text" DEFAULT copy. A named
 * constant that is the bulletproof fallback: the operator can override it via
 * the settings `welcomeText` field (resolved per-request below), but ANY
 * settings-read failure falls back to THIS constant so intake never breaks.
 * {firstName} is interpolated; nothing else.
 */
export const WELCOME_TEXT_TEMPLATE =
  'Hi {firstName}, thanks for stopping by! This is HousingChoice — reply here anytime about housing options.';

/** Render a welcome body from a template (the constant or the operator's
 *  override), interpolating {firstName}. Pure. */
function renderWelcome(template: string, firstName: string): string {
  return template.replace('{firstName}', firstName);
}

/**
 * A non-reversible, non-PII marker for a phone — a short hash prefix used in
 * log lines so a signup can be correlated/deduped in logs WITHOUT ever logging
 * the real number (doc §9). 10 hex chars is plenty to disambiguate at this
 * scale and reveals nothing.
 */
function phoneMarker(phone: string): string {
  return createHash('sha256').update(phone).digest('hex').slice(0, 10);
}

/** Generic field caps so the public body can't be used to store huge blobs. */
const MAX_NAME_LEN = 100;
/** A unitId is an opaque id; cap it so it can't smuggle a blob through the body. */
const MAX_UNIT_ID_LEN = 200;

interface HousingFairFields {
  firstName: string;
  lastName: string;
  phone: string;
  voucherSize?: number;
  /** Optional flyer unit-of-interest (validated as shareable in the handler). */
  unitId?: string;
}

/**
 * Validate the housing-fair body. Generic messages (never echo back which
 * field/why in detail beyond the field name) and strict shapes: names are
 * non-empty and length-capped, phone normalizes to valid E.164 or it's
 * rejected, voucherSize (optional) is an integer 0..12.
 */
function parseHousingFairBody(body: unknown): HousingFairFields | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid request' };
  }
  const b = body as Record<string, unknown>;

  const firstName = typeof b['firstName'] === 'string' ? b['firstName'].trim() : '';
  const lastName = typeof b['lastName'] === 'string' ? b['lastName'].trim() : '';
  if (firstName.length === 0 || firstName.length > MAX_NAME_LEN) {
    return { error: 'invalid request' };
  }
  if (lastName.length === 0 || lastName.length > MAX_NAME_LEN) {
    return { error: 'invalid request' };
  }

  if (typeof b['phone'] !== 'string') return { error: 'invalid request' };
  const phone = normalizeToE164(b['phone']);
  if (phone === undefined) return { error: 'invalid request' };

  let voucherSize: number | undefined;
  if ('voucherSize' in b && b['voucherSize'] !== undefined && b['voucherSize'] !== null) {
    const v = b['voucherSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'invalid request' };
    }
    voucherSize = v;
  }

  // Optional unitId: the flyer the signup came from. Absent is fine; present
  // must be a non-empty, length-capped string (a present-but-non-string is a
  // malformed request → the same generic error). Whether the unit is actually
  // shareable is decided in the handler (a non-shareable id just degrades to a
  // plain housing-fair signup — never an existence oracle).
  let unitId: string | undefined;
  if ('unitId' in b && b['unitId'] !== undefined && b['unitId'] !== null) {
    const u = b['unitId'];
    if (typeof u !== 'string' || u.length === 0 || u.length > MAX_UNIT_ID_LEN) {
      return { error: 'invalid request' };
    }
    unitId = u;
  }

  return {
    firstName,
    lastName,
    phone,
    ...(voucherSize !== undefined && { voucherSize }),
    ...(unitId !== undefined && { unitId }),
  };
}

export interface PublicRouterDeps {
  logger?: Logger;
  contactsRepo?: ContactsRepo;
  conversationsRepo?: ConversationsRepo;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  settingsRepo?: SettingsRepo;
  sendMessageService?: SendMessageService;
}

export function createPublicRouter(deps: PublicRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const sendMessage =
    deps.sendMessageService ??
    createSendMessageService({
      logger: deps.logger,
      conversationsRepo: conversations,
      auditRepo: audit,
      contactsRepo: contacts,
    });

  const router = Router();

  // POST /public/housing-fair — public intake → auto welcome text (§11.3).
  router.post('/housing-fair', async (req, res) => {
    const parsed = parseHousingFairBody(req.body);
    if ('error' in parsed) {
      // Generic message — never reveal which validation tripped on a public,
      // abuse-prone surface.
      res.status(400).json({ error: 'invalid request' });
      return;
    }
    const { firstName, lastName, phone, voucherSize, unitId } = parsed;
    const marker = phoneMarker(phone);
    mergeContext({}); // keep this request's log lines correlated (no PII added)

    // Flyer attribution: when the signup carries a unitId for a SHAREABLE unit,
    // stamp the created contact with capture_source:'flyer' + unit_of_interest so
    // staff see which home prompted the signup. A missing/non-shareable unit
    // (or no unitId) keeps today's plain 'housing_fair' source (no oracle — we
    // never reveal whether the id existed). unitId is NOT PII, so logging its
    // presence as a boolean is fine.
    let viaFlyer = false;
    if (unitId !== undefined) {
      const flyerUnit = await units.getById(unitId);
      // A soft-deleted unit is not publicly shareable (it's hidden everywhere),
      // so it must not earn flyer attribution either — mirror the flyer/details
      // gate exactly.
      if (flyerUnit && !isDeleted(flyerUnit) && SHAREABLE_STATUSES.has(flyerUnit.status)) {
        viaFlyer = true;
      }
    }

    // (1) Dedupe by phone. A fair signup for an existing phone must NOT create
    // a second contact and must NOT re-send the welcome (idempotent — the
    // money/abuse guard). `housing_fair_welcomed` is the dedupe flag.
    const existing = await contacts.findByPhone(phone);
    let contactId: string;
    let alreadyWelcomed: boolean;
    if (existing) {
      contactId = existing.contactId;
      alreadyWelcomed = existing['housing_fair_welcomed'] === true;
    } else {
      // status 'needs_review' (review decision): fair signups go to the human
      // triage queue (type=tenant, status=needs_review on byTypeStatus) — the
      // team confirms before treating them as fully active. type 'tenant'
      // (the fair is a tenant intake — this is asserted by the form, not a
      // guess from an unknown inbound).
      const created = await contacts.create({
        type: 'tenant',
        status: 'needs_review',
        phone,
        firstName,
        lastName,
        ...(voucherSize !== undefined && { voucherSize }),
        // Flyer signups are attributed to the originating home; a plain fair
        // signup (no/non-shareable unit) keeps the generic source. Only stamped
        // on CREATE (matching how capture_source is set), never on a deduped
        // existing contact.
        capture_source: viaFlyer ? 'flyer' : 'housing_fair',
        ...(viaFlyer && unitId !== undefined && { unit_of_interest: unitId }),
        captured_at: new Date().toISOString(),
        housing_fair_welcomed: false,
      });
      contactId = created.contactId;
      alreadyWelcomed = false;
    }

    // (2) Conversation: create or get the 1:1 tenant thread and link the
    // contact, so the welcome text and any reply land on one thread.
    const conversation = await conversations.createOrGetByParticipantPhone(phone, 'tenant_1to1');
    await conversations.setParticipantsIfAbsent(conversation.conversationId, [{ contactId, phone }]);

    // (3) Welcome text — ONLY on the FIRST capture of this phone (idempotent).
    // A repeat signup never re-sends (no SMS spend, no spam).
    let welcomeSent = false;
    if (!alreadyWelcomed) {
      // Resolve the welcome template defensively: the operator's settings
      // welcomeText when set, else the constant. A settings-read failure must
      // NOT break intake — the send is best-effort — so fall back to the
      // constant on ANY error. NO PII logged (marker only).
      let template = WELCOME_TEXT_TEMPLATE;
      try {
        const s = await settings.getOrgSettings();
        if (typeof s.welcomeText === 'string' && s.welcomeText.length > 0) template = s.welcomeText;
      } catch {
        // best-effort: a settings-read failure must NOT break intake — fall back to the constant.
        log.warn({ marker }, 'welcomeText read failed; using default template');
      }
      try {
        await sendMessage({
          conversationId: conversation.conversationId,
          body: renderWelcome(template, firstName),
          automated: true,
        });
        welcomeSent = true;
        // Flag the contact so a later signup with the same phone is a no-op
        // for the welcome. Best-effort: a failure here only risks ONE possible
        // duplicate welcome on a later signup, never a crash.
        await contacts.update(contactId, { housing_fair_welcomed: true });
      } catch (err) {
        // A refused send (opted out, breaker, etc.) must NOT fail the public
        // request — the signup itself succeeded. Log the FACT, never PII.
        if (err instanceof SendRefusedError) {
          log.warn({ marker, code: err.code }, 'housing-fair welcome text refused');
        } else {
          // Unexpected error: log without PII and still return ok (the contact
          // is captured; the team can text manually).
          log.error({ marker, err }, 'housing-fair welcome text failed to send');
        }
      }
    }

    // (4) Audit (no PII in the payload beyond the marker — the contactId is an
    // internal id, fine for the audit trail but NOT returned to the public).
    await audit.append(`contacts#${contactId}`, 'housing_fair_signup', {
      marker,
      isNew: existing === undefined,
      welcomeSent,
      viaFlyer,
    });
    // Log a hashed marker only — NEVER the name or phone (doc §9 / kickoff).
    // viaFlyer is a non-PII boolean (whether a shareable unit was attributed).
    log.info(
      { marker, isNew: existing === undefined, welcomeSent, viaFlyer },
      'housing-fair signup captured',
    );

    // (5) Minimal response — do NOT leak internal IDs or PII to the public.
    res.json({ ok: true });
  });

  // GET /public/units/:unitId/flyer — the shareable flyer view (M1.5).
  // 404 when the unit is missing, soft-deleted, OR not in a shareable status
  // (the public must never learn a non-available unit even exists). Returns ONLY
  // the allowlisted flyer fields (lib/unitFields.toUnitFlyer) — no internal leak.
  router.get('/units/:unitId/flyer', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit || isDeleted(unit) || !SHAREABLE_STATUSES.has(unit.status)) {
      // Same 404 for missing, deleted, and not-shareable — no existence oracle.
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ flyer: toUnitFlyer(unit) });
  });

  // GET /public/units/:unitId/details — the post-intake "full details" reveal.
  // SAME gate + opaque 404 as the flyer (soft reveal, NO token): missing,
  // soft-deleted, or not-shareable all 404 identically. Returns ONLY the richer
  // allowlist (lib/unitFields.toUnitFlyerDetails): the teaser fields +
  // address/utilities/video/app-fee/same-day-RTA. Internal and landlord/contact
  // fields can never leak (the allowlist IS the wall).
  router.get('/units/:unitId/details', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit || isDeleted(unit) || !SHAREABLE_STATUSES.has(unit.status)) {
      // Same 404 for missing, deleted, and not-shareable — no existence oracle.
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ details: toUnitFlyerDetails(unit) });
  });

  return router;
}
