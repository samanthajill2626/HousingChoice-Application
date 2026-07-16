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
//        -> 200 { flyer }   (the FULL public payload upfront + contact_number)
//        -> 404 { error, contact_number }   (missing/deleted/not-shareable;
//           flyer-full-info: the teaser/reveal split + the /details route are gone)
//
// Money note: housing-fair sends an SMS (real cost in prod). Idempotency +
// rate limiting are what keep this from being an SMS-spend abuse vector.
import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import { CONSENT_VERSION, WELCOME_SMS } from '../lib/smsCompliance.js';
import { resolveWithSettings } from '../messages/index.js';
import { SHAREABLE_STATUSES, isDeleted } from '../repos/unitsRepo.js';
import { toUnitFlyer } from '../lib/unitFields.js';
import { resolveUnitMedia } from '../lib/unitMedia.js';
import type { MediaStore } from '../adapters/mediaStore.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';

/**
 * The housing-fair "auto welcome text" DEFAULT copy — the FILED A2P welcome
 * (spec §5): brand identity + opt-out language, verbatim from lib/smsCompliance.ts
 * (the single source of truth). The welcome is now resolved through the message
 * catalog (`welcome.sms`): the operator can still override it via the settings
 * `welcomeText` field, and ANY settings-read failure falls back to this default
 * so intake never breaks. Re-exported under the historical name so existing
 * importers (tests) keep working.
 */
export const WELCOME_TEXT_TEMPLATE = WELCOME_SMS;

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
 *
 * do-not-remove — A2P/CTIA consent gate (server-side). The public form gates
 * submit on a required, unchecked-by-default consent checkbox (spec §3.1); the
 * SERVER re-enforces it: a body missing `smsConsent === true` is REJECTED with
 * the distinct `consent_required` error (NOT the generic "invalid request"), so
 * the app never texts a signup with no documented opt-in. This is the second
 * fence behind the client checkbox — never remove it.
 */
function parseHousingFairBody(body: unknown): HousingFairFields | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid request' };
  }
  const b = body as Record<string, unknown>;

  // do-not-remove — A2P/CTIA consent gate (server-side). Require explicit
  // opt-in: exactly `true` (a missing/false/"true"-string value is rejected).
  if (b['smsConsent'] !== true) {
    return { error: 'consent_required' };
  }

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
  /**
   * flyer-full-info: the public-facing texting number shown on the flyer (the
   * "I'm interested - text us" CTA) - config.ourPhoneNumbers[0], the SAME main
   * number all 1:1 Twilio traffic uses. Absent -> the page degrades to
   * reply-prompt copy (never a broken button).
   */
  contactNumber?: string;
  /**
   * unit-photos: the media bucket store - the flyer resolves stored photo keys
   * to short-lived presigned URLs at render time (D1: the bucket stays private).
   * Undefined when MEDIA_BUCKET is unset - stored keys then resolve to url-absent
   * and are omitted from the public url list (only legacy absolute URLs carry
   * through).
   */
  mediaStore?: MediaStore;
}

export function createPublicRouter(deps: PublicRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const mediaStore = deps.mediaStore;
  // flyer-full-info: config.ourPhoneNumbers[0] (or null when unconfigured). Rides
  // on the flyer payload AND every opaque 404 so the page's unavailable state can
  // still offer the text-us CTA (there is no flyer payload to read it from there).
  const contactNumber = deps.contactNumber ?? null;
  const sendMessage =
    deps.sendMessageService ??
    createSendMessageService({
      logger: deps.logger,
      conversationsRepo: conversations,
      auditRepo: audit,
      contactsRepo: contacts,
    });

  const router = Router();

  // The opaque 404 - IDENTICAL for missing, soft-deleted, and not-shareable (no
  // existence oracle). It carries contact_number (config, not unit data) so the
  // public page's "unavailable" state can still offer the text-us CTA.
  function sendNotFound(res: Response): void {
    res.status(404).json({ error: 'not_found', contact_number: contactNumber });
  }

  // unit-photos S3 (D1): resolve the unit's photos to render-time presigned URLs
  // for the PUBLIC surface. The wire shape stays string[] (a url list, so
  // FlyerFunnel changes minimally); entries that fail to resolve (stored key with
  // no store / a presign failure) are OMITTED - the private bucket is never
  // exposed and a degraded photo simply doesn't appear.
  async function resolvePublicMedia(unit: UnitItem, unitId: string): Promise<string[]> {
    const display = await resolveUnitMedia(mediaStore, unit, { logger: log, unitId });
    return display
      .map((d) => d.url)
      .filter((u): u is string => typeof u === 'string');
  }

  // POST /public/housing-fair — public intake → auto welcome text (§11.3).
  router.post('/housing-fair', async (req, res) => {
    const parsed = parseHousingFairBody(req.body);
    if ('error' in parsed) {
      // The consent gate returns a DISTINCT `consent_required` (the frontend
      // surfaces "please agree to texts"); every other validation failure stays
      // the generic message — never reveal which field tripped on a public,
      // abuse-prone surface.
      res
        .status(400)
        .json({ error: parsed.error === 'consent_required' ? 'consent_required' : 'invalid request' });
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
      // so it must not earn flyer attribution either - mirror the flyer gate
      // exactly.
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
        // A2P/CTIA consent (spec §3.1): the required checkbox was checked (the
        // server gate above enforced it), so this signup carries a documented
        // web-form opt-in. consent_version pins the disclosure copy version.
        consent_method: 'web_form',
        consent_at: new Date().toISOString(),
        consent_version: CONSENT_VERSION,
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
      try {
        // Resolve the welcome through the catalog: the operator's settings
        // `welcomeText` override when set (interpolating {firstName}), else the
        // filed default. resolveWithSettings reads defensively — ANY settings-read
        // failure falls back to the default so intake never breaks. NO PII logged.
        await sendMessage({
          conversationId: conversation.conversationId,
          body: await resolveWithSettings('welcome.sms', { firstName }, { settingsRepo: settings }),
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

  // GET /public/units/:unitId/flyer - the public flyer view (flyer-full-info).
  // 404 when the unit is missing, soft-deleted, OR not in a shareable status
  // (the public must never learn a non-available unit even exists). Returns the
  // FULL public payload upfront (lib/unitFields.toUnitFlyer) + contact_number -
  // no internal leak. The teaser/reveal split (and the /details route) are gone.
  router.get('/units/:unitId/flyer', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit || isDeleted(unit) || !SHAREABLE_STATUSES.has(unit.status)) {
      // Same 404 for missing, deleted, and not-shareable - no existence oracle.
      sendNotFound(res);
      return;
    }
    // unit-photos: replace the raw media pass-through with render-time presigned
    // URLs (unresolvable entries omitted). contact_number is config (the main
    // 1:1 business number), added here like media - NOT part of the projection.
    const media = await resolvePublicMedia(unit, unitId);
    res.json({ flyer: { ...toUnitFlyer(unit), media, contact_number: contactNumber } });
  });

  return router;
}
