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
//   POST /public/housing-fair  { firstName, lastName, phone, voucherSize?, unitId?, housingAuthority? }
//        → 200 { ok: true }   (creates/dedupes a tenant contact, sends the
//          welcome text on FIRST capture only; leaks NO internal IDs/PII. A
//          present + shareable unitId stamps capture_source:'flyer' +
//          unit_of_interest on the CREATED contact instead of 'housing_fair'.
//          join-housing-authority: housingAuthority (absent/null = none) must
//          be the exact name of a listed housing authority, else 400
//          housing_authority_not_listed; sent WITH a unitId it is the generic
//          400. A new contact from a request with NO unitId starts
//          'onboarding' and holds the authority; WITH a unitId it starts
//          'needs_review'. Every new contact carries housing_fair_signup_v2;
//          an existing contact is never changed beyond the welcome flag.)
//   GET  /public/units/:unitId/flyer
//        -> 200 { flyer }   (the FULL public payload upfront + contact_number)
//        -> 404 { error, contact_number }   (missing/deleted/not-shareable;
//           flyer-full-info: the teaser/reveal split + the /details route are gone)
//   GET  /public/housing-authorities   (join-housing-authority D1/D2; built by
//        createPublicHousingAuthoritiesRouter below and mounted in app.ts AHEAD
//        of this router, with its own 60-per-minute per-IP limit)
//        -> 200 { names: string[] }   (the housing authority names on the org
//           list, sorted; Cache-Control: no-store; never writes the list)
//
// Money note: housing-fair sends an SMS (real cost in prod). Idempotency +
// rate limiting are what keep this from being an SMS-spend abuse vector.
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { KINDS_FOR_FIELD, ORG_NAME_MAX, isOnListFor } from '../lib/orgNames.js';
import { normalizeToE164 } from '../lib/phone.js';
import { CONSENT_VERSION, WELCOME_SMS } from '../lib/smsCompliance.js';
import { resolveWithSettings } from '../messages/index.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import { SHAREABLE_STATUSES, isDeleted } from '../repos/unitsRepo.js';
import { toUnitFlyer } from '../lib/unitFields.js';
import { resolveUnitMedia } from '../lib/unitMedia.js';
import type { EventBus } from '../lib/events.js';
import { conversationTypeFor } from '../lib/voiceMasking.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createContactsRepo, isDeleted as isContactDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo, type ConversationsRepo } from '../repos/conversationsRepo.js';
import type { ListingSendsRepo } from '../repos/listingSendsRepo.js';
import { createOrgListRepo, type OrgListRepo } from '../repos/orgListRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { createUnitsRepo, type UnitItem, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  PUBLIC_LIST_RATE_LIMIT,
  housingAuthorityNames,
  loadPublicOrgEntries,
} from '../services/publicOrgList.js';

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
  /** join-housing-authority D3: the /join form's choice; shape-checked here, list-checked in the handler. */
  housingAuthority?: string;
}

/**
 * Validate the housing-fair body. Generic messages (never echo back which
 * field/why in detail beyond the field name) and strict shapes: names are
 * non-empty and length-capped, phone normalizes to valid E.164 or it's
 * rejected, voucherSize (optional) is an integer 0..12, housingAuthority
 * (optional; join-housing-authority D3) is a string of 1 to ORG_NAME_MAX
 * characters after the app-wide body trim - whether it is ON the list is the
 * handler's check - and a request carrying both a unitId and a
 * housingAuthority is refused outright (D4).
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

  // join-housing-authority D3: the optional housing authority the /join form
  // chose. Absent or null = none. Present: a string of 1 to ORG_NAME_MAX
  // characters AFTER the app-wide JSON body trim (app.ts trimJsonBody), else
  // the generic error. Whether it is ON the list is decided in the handler,
  // before any write - not here.
  let housingAuthority: string | undefined;
  if ('housingAuthority' in b && b['housingAuthority'] !== undefined && b['housingAuthority'] !== null) {
    const h = b['housingAuthority'];
    if (typeof h !== 'string' || h.length === 0 || h.length > ORG_NAME_MAX) {
      return { error: 'invalid request' };
    }
    housingAuthority = h;
  }

  // D4: a flyer sign-up (a present, non-null unitId) never carries a housing
  // authority - the flyer page shows no select. Refused with the generic error,
  // keyed on the PRESENCE of unitId and decided before the unit is ever read,
  // so the refusal reveals nothing about whether the unit exists or is shareable.
  if (unitId !== undefined && housingAuthority !== undefined) {
    return { error: 'invalid request' };
  }

  return {
    firstName,
    lastName,
    phone,
    ...(voucherSize !== undefined && { voucherSize }),
    ...(unitId !== undefined && { unitId }),
    ...(housingAuthority !== undefined && { housingAuthority }),
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
   * join-housing-authority D1/D3: the organization list. The sign-up's housing
   * authority check reads it (peek only - the public surface never creates
   * it). Default createOrgListRepo(). When one is injected (deps.public in
   * app.ts - the tests), app.ts hands that same repo to
   * createPublicHousingAuthoritiesRouter too; otherwise each router builds its
   * own default, which reads the same stored item the same way (one
   * consistent read per call, nothing cached).
   */
  orgListRepo?: OrgListRepo;
  /**
   * flyer-full-info: the public-facing texting number shown on the flyer (the
   * "I'm interested - text us" CTA) - config.businessPhoneNumber, the SAME main
   * number all 1:1 Twilio traffic uses. Absent -> the page degrades to
   * reply-prompt copy (never a broken button).
   */
  contactNumber?: string;
  /**
   * flyer-leads D6 (plan 2.6): the sign-up's `signed_up` thread pin and its
   * 24-hour repeat read (hasEventSince). Default createActivityEventsRepo().
   */
  activityEventsRepo?: Pick<ActivityEventsRepo, 'record' | 'hasEventSince'>;
  /**
   * flyer-leads D7 (plan 2.6): the properties-sent ledger a flyer sign-up's
   * `flyer` share entry is written through (services/shareLedger.ts
   * applyFlyerShareEntry). Default createListingSendsRepo().
   */
  listingSendsRepo?: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>;
  /**
   * flyer-leads D6: the bus the sign-up's unread mark emits its ONE
   * conversation.updated on, so open dashboards re-sort the bumped row.
   * Default appEvents (the process-wide bus the SSE route listens on).
   */
  events?: EventBus;
  /**
   * flyer-leads AR3: the clock (epoch ms) - the ONLY time source for the
   * 24-hour repeat window, the pin and touch instant and the flyer attempt
   * key, so tests are deterministic. Default Date.now.
   */
  now?: () => number;
}

export function createPublicRouter(deps: PublicRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  // join-housing-authority D3: the list a sign-up's housing authority is checked
  // against (read with peek() only - the public surface never creates it).
  const orgList = deps.orgListRepo ?? createOrgListRepo({ logger: deps.logger });
  // flyer-full-info: config.businessPhoneNumber (or null when unconfigured). Rides
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

  // unit-photos (design 2026-07-21): resolve the unit's photos to stable
  // same-origin /unit-media URLs for the PUBLIC surface. The wire shape stays
  // string[] (a url list the public flyer page (FlyerPage) renders as-is);
  // foreign / out-of-namespace entries resolve to no url and are OMITTED - only
  // this unit's own keys (and legacy absolute URLs) ever reach the public flyer.
  function resolvePublicMedia(unit: UnitItem): string[] {
    return resolveUnitMedia(unit, { logger: log })
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
    const { firstName, lastName, phone, voucherSize, unitId, housingAuthority } = parsed;
    const marker = phoneMarker(phone);
    mergeContext({}); // keep this request's log lines correlated (no PII added)

    // join-housing-authority D3: the list check, BEFORE the unit or contact
    // reads and before any write, for a new and an existing phone alike. The
    // list is read ONLY when an authority was sent, from the source the public
    // list read serves (peek, else the starting list in memory - never a
    // write). The value must be character-for-character the name of a
    // housing_authority entry: no case, spelling or agency resolution. The
    // distinct code lets the /join form recover; the list is public, so the
    // code reveals nothing. A read failure propagates: the generic 500.
    if (housingAuthority !== undefined) {
      const entries = await loadPublicOrgEntries(orgList);
      if (!isOnListFor(entries, housingAuthority, KINDS_FOR_FIELD.housingAuthority)) {
        res.status(400).json({ error: HOUSING_AUTHORITY_NOT_LISTED });
        return;
      }
    }

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

    // (1) Who is signing up (flyer-leads D4). contacts.findByPhone stays the
    // ONE lookup - the same routing read the inbox, the unread feed and a
    // staff reply's gates use - so the thread pin, the unread mark and those
    // gates always judge the SAME contact. A live holder (any type) is an
    // EXISTING contact and is never changed by a sign-up (no name, type,
    // status, voucher size, housing authority, consent or welcome flag); a
    // soft-deleted holder takes the deleted path below; no holder creates a
    // new tenant, as before.
    const existing = await contacts.findByPhone(phone);

    // (1a) The deleted path (D4): no conversation, no send, no pin, no unread
    // mark, no sent-list entry - only the audit event on THAT contact (the
    // trace docs/issues/deleted-contact-web-signup-silent.md relies on) and
    // the generic { ok: true }.
    if (existing !== undefined && isContactDeleted(existing)) {
      await audit.append(`contacts#${existing.contactId}`, 'housing_fair_signup', {
        marker,
        isNew: false,
        welcomeSent: false,
        viaFlyer,
        signupVersion: 2,
        housingAuthority: housingAuthority ?? null,
      });
      log.info(
        { marker, isNew: false, welcomeSent: false, viaFlyer, withAuthority: housingAuthority !== undefined },
        'housing-fair signup captured',
      );
      res.json({ ok: true });
      return;
    }

    const isNew = existing === undefined;
    let contact: ContactItem;
    if (existing !== undefined) {
      contact = existing;
    } else {
      // Status (join-housing-authority D5). A request with NO unitId - the /join
      // form, filled in by staff at housing fairs and by the public - starts the
      // tenant lifecycle at 'onboarding', like a manual create in
      // routes/contacts.ts (identity is asserted by the form). No status_source
      // is stamped, so a later placement transition can still derive the
      // lifecycle forward. A request WITH a unitId (the flyer's sign-up box)
      // keeps 'needs_review' and stores no authority, even when the unit is
      // missing or not shareable. type 'tenant': the form is a tenant intake,
      // asserted by the form, not a guess from an unknown inbound.
      contact = await contacts.create({
        type: 'tenant',
        status: unitId === undefined ? 'onboarding' : 'needs_review',
        phone,
        firstName,
        lastName,
        ...(voucherSize !== undefined && { voucherSize }),
        // D5: the /join answer, on a create from a request with no unitId only
        // (D4 already refused a request carrying both), exactly as the list
        // check accepted it. Absent when none was chosen.
        ...(unitId === undefined && housingAuthority !== undefined && { housingAuthority }),
        // Flyer signups are attributed to the originating home; a plain fair
        // signup (no/non-shareable unit) keeps the generic source. Only stamped
        // on CREATE (matching how capture_source is set), never on a deduped
        // existing contact.
        capture_source: viaFlyer ? 'flyer' : 'housing_fair',
        ...(viaFlyer && unitId !== undefined && { unit_of_interest: unitId }),
        captured_at: new Date().toISOString(),
        housing_fair_welcomed: false,
        // D5: EVERY contact this endpoint creates from now on - /join and flyer
        // alike - carries the marker: "created after the housing authority
        // question shipped" (not "saw the select"). The lead backfill
        // (scripts/backfill-join-housing-authority.ts) never touches a contact
        // holding it. Never written to an existing contact (D6).
        housing_fair_signup_v2: true,
        // A2P/CTIA consent (spec §3.1): the required checkbox was checked (the
        // server gate above enforced it), so this signup carries a documented
        // web-form opt-in. consent_version pins the disclosure copy version.
        consent_method: 'web_form',
        consent_at: new Date().toISOString(),
        consent_version: CONSENT_VERSION,
      });
    }
    const contactId = contact.contactId;

    // (2) Conversation: create or get the contact's 1:1 thread, TYPED for the
    // contact (D6: conversationTypeFor - a landlord, partner or unknown
    // contact with no thread yet gets a correctly typed one; a new contact is
    // a tenant, so tenant_1to1 as before), and link the contact, so the
    // welcome text, any reply and the sign-up's unread mark land on one thread.
    const conversation = await conversations.createOrGetByParticipantPhone(phone, conversationTypeFor(contact));
    await conversations.setParticipantsIfAbsent(conversation.conversationId, [{ contactId, phone }]);

    // (3) Welcome text - ONLY when this request CREATED the contact (D5). An
    // existing contact never gets it, from either form, whatever
    // housing_fair_welcomed says (that rule texted landlords, caseworkers and
    // long-time tenants the tenant welcome mid-conversation). A new contact
    // whose welcome fails is not re-welcomed by a later sign-up.
    let welcomeSent = false;
    if (isNew) {
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
        // D5: still recorded after a successful welcome. It no longer gates a
        // later welcome (no existing contact is ever welcomed); a failure here
        // lands in the catch below and costs only the flag.
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
    // join-housing-authority D7: every event from now on carries
    // signupVersion 2 (the lead backfill reads it: a pre-change lead who
    // signed up again after the change is left alone) and the authority the
    // REQUEST carried, else null - an organization name, not PII - recorded
    // for an existing contact too, though D6 writes nothing to it.
    await audit.append(`contacts#${contactId}`, 'housing_fair_signup', {
      marker,
      isNew: existing === undefined,
      welcomeSent,
      viaFlyer,
      signupVersion: 2,
      housingAuthority: housingAuthority ?? null,
    });
    // Log a hashed marker only — NEVER the name or phone (doc §9 / kickoff).
    // viaFlyer is a non-PII boolean (whether a shareable unit was attributed);
    // withAuthority (D7) is a boolean too - the name itself stays out of logs.
    log.info(
      {
        marker,
        isNew: existing === undefined,
        welcomeSent,
        viaFlyer,
        withAuthority: housingAuthority !== undefined,
      },
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
    // unit-photos: replace the raw media pass-through with same-origin
    // /unit-media URLs (unresolvable entries omitted). contact_number is config
    // (the main 1:1 business number), added here like media - NOT part of the projection.
    const media = resolvePublicMedia(unit);
    res.json({ flyer: { ...toUnitFlyer(unit), media, contact_number: contactNumber } });
  });

  return router;
}

export interface PublicHousingAuthoritiesDeps {
  logger?: Logger;
  orgListRepo?: OrgListRepo;
  /** Test seam: the limiter's client-key resolver. */
  rateLimitKeyOf?: (req: Request) => string;
}

/**
 * GET /public/housing-authorities (join-housing-authority D1, D2) - the /join
 * form's housing authority dropdown. Its OWN router so app.ts can mount it
 * IMMEDIATELY BEFORE the shared /public mount: it defines this one GET route,
 * with a hard-coded 60-per-minute per-IP limiter on the route alone, so the
 * read never consumes - and is never blocked by - the shared limiter in front
 * of createPublicRouter. Every other request matches nothing here and falls
 * through to that mount unchanged.
 *
 * 200 { names }: the exact stored names of the housing authority entries,
 * sorted (services/publicOrgList.ts). Nothing else leaves: no ids, spellings,
 * notes, audit fields or agencies. It never writes the list item (peek, else
 * the starting list in memory). A read failure propagates to the app's error
 * handler: the generic 500. no-store: nothing may cache a stale list.
 */
export function createPublicHousingAuthoritiesRouter(deps: PublicHousingAuthoritiesDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const orgList = deps.orgListRepo ?? createOrgListRepo({ logger: deps.logger });
  const router = Router();
  router.get(
    '/housing-authorities',
    createRateLimit({ ...PUBLIC_LIST_RATE_LIMIT, logger: log, keyOf: deps.rateLimitKeyOf }),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const entries = await loadPublicOrgEntries(orgList);
      res.json({ names: housingAuthorityNames(entries) });
    },
  );
  return router;
}
