// Founder settings routes (M1.4), mounted under /api (behind requireAuth):
//
//   GET /api/settings   → { settings }                 (requireAuth — VAs may VIEW)
//   PUT /api/settings   { patch } → { settings }        (requireRole('admin') — only admins EDIT)
//
// BOTH responses also carry two READ-ONLY, env/code-sourced siblings that ride
// ALONGSIDE the settings and are never patchable: `welcomeTextDefault` and
// `businessPhoneNumber` (omitted when unconfigured).
//
// Stores the founder-editable templates Change Order 2 introduced (missed-call
// auto-text + quick replies). M1.4 only stores/edits them — they are CONSUMED
// in M1.9 (the voice/call-triage milestone). See repos/settingsRepo.ts.
//
// The recorded voicemail greeting (spec 2026-09-26 sections 4.3-4.5) lives on
// the same mount:
//   PUT    /api/settings/voicemail-greeting        raw MP3/WAV body -> { voicemailGreeting }  (admin)
//   DELETE /api/settings/voicemail-greeting        -> 204                                     (admin)
//   GET    /api/settings/voicemail-greeting/audio  -> the stored audio (any logged-in user)
import { Router } from 'express';
import type { MediaStore } from '../adapters/mediaStore.js';
import { type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { isValidHhMm, isValidIanaTimezone } from '../lib/quietHours.js';
import { templateHasOptOutLanguage, WELCOME_SMS } from '../lib/smsCompliance.js';
import {
  GreetingRejectedError,
  GreetingUploadGate,
  normalizeGreetingContentType,
  sanitizeGreetingFileName,
  VOICEMAIL_GREETING_FILE_NAME_HEADER,
  VOICEMAIL_GREETING_MAX_BYTES,
  VOICEMAIL_GREETING_REJECT_MESSAGE,
  VOICEMAIL_GREETING_S3_KEY,
} from '../lib/voicemailGreeting.js';
import { requireRole, type AuthedRequest } from '../middleware/auth.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createSettingsRepo,
  ORG_SETTINGS_ENTITY_KEY,
  type OrgSettings,
  type SettingsRepo,
  type VoicemailGreeting,
} from '../repos/settingsRepo.js';
import { serveMediaObject } from './serveMediaObject.js';

export interface SettingsRouterDeps {
  logger?: Logger;
  settingsRepo?: SettingsRepo;
  auditRepo?: AuditRepo;
  /**
   * Read-only source of the env-sourced business number. It rides ALONGSIDE the
   * settings on both responses and is NEVER patchable (parsePatch does not
   * accept it) - it comes from BUSINESS_PHONE_NUMBER, not the settings item.
   *
   * REQUIRED, deliberately: a `?? loadConfig()` fallback would be a SECOND
   * source of truth, re-reading process.env and possibly reporting a business
   * number that differs from the one the app booted with and sends from. One
   * number, one source - the caller passes the config it booted with.
   */
  config: AppConfig;
  /** Media store for the voicemail greeting routes; undefined when MEDIA_BUCKET is unset (503 then). */
  mediaStore?: MediaStore;
}

/** Quick replies: each non-empty string, the whole array <= this many, each <= this long. */
const MAX_QUICK_REPLIES = 10;
const MAX_TEMPLATE_CHARS = 320; // ~2 SMS segments — a canned reply, not an essay
/** Pre-ring pause (founder call-triage): whole seconds, a sane bound. */
const MIN_PRE_RING_PAUSE_SECONDS = 0;
const MAX_PRE_RING_PAUSE_SECONDS = 10;

/**
 * Validate + extract a settings patch from the request body. Returns the patch
 * (only the supplied, valid fields) or an error message. An empty patch is
 * valid (a no-op PUT returns the current settings).
 */
/** The validated patch. `welcomeText` may be `null` (an explicit CLEAR the repo
 *  turns into a DynamoDB REMOVE). `voicemailGreeting` is Omitted on purpose:
 *  parsePatch never produces it - only the greeting routes below write it. */
type SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText' | 'voicemailGreeting'>> & { welcomeText?: string | null };

function parsePatch(body: unknown): { patch: SettingsPatch } | { error: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const patch: SettingsPatch = {};

  if ('missedCallAutoText' in b) {
    const v = b['missedCallAutoText'];
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEMPLATE_CHARS) {
      return { error: `missedCallAutoText must be a 1..${MAX_TEMPLATE_CHARS}-char string` };
    }
    // FOUNDER DECISION, 2026-08-18: the opt-out gate is LIFTED for this ONE
    // field. It used to reject any missed-call auto-text without "Reply STOP...",
    // which is why the founder's wording could not be saved here at all. The
    // rationale and the attribution live on FOUNDER_MISSED_CALL_AUTOTEXT
    // (lib/smsCompliance.ts) - engineering advised keeping the gate and was
    // overruled.
    //
    // NOTE THE ASYMMETRY, IT IS INTENTIONAL: welcomeText below STILL enforces
    // templateHasOptOutLanguage. Only the missed-call auto-text was cleared, so
    // do not "tidy" the two branches into one shared check.
    patch.missedCallAutoText = v;
  }
  if ('missedCallAutoTextEnabled' in b) {
    const v = b['missedCallAutoTextEnabled'];
    if (typeof v !== 'boolean') {
      return { error: 'missedCallAutoTextEnabled must be a boolean' };
    }
    patch.missedCallAutoTextEnabled = v;
  }
  if ('quickReplies' in b) {
    const v = b['quickReplies'];
    if (
      !Array.isArray(v) ||
      v.length > MAX_QUICK_REPLIES ||
      !v.every((r): r is string => typeof r === 'string' && r.length > 0 && r.length <= MAX_TEMPLATE_CHARS)
    ) {
      return {
        error: `quickReplies must be an array of up to ${MAX_QUICK_REPLIES} non-empty strings (<= ${MAX_TEMPLATE_CHARS} chars each)`,
      };
    }
    patch.quickReplies = v;
  }
  if ('preRingPauseSeconds' in b) {
    const v = b['preRingPauseSeconds'];
    if (
      typeof v !== 'number' ||
      !Number.isInteger(v) ||
      v < MIN_PRE_RING_PAUSE_SECONDS ||
      v > MAX_PRE_RING_PAUSE_SECONDS
    ) {
      return {
        error: `preRingPauseSeconds must be an integer between ${MIN_PRE_RING_PAUSE_SECONDS} and ${MAX_PRE_RING_PAUSE_SECONDS}`,
      };
    }
    patch.preRingPauseSeconds = v;
  }
  // Quiet hours (spec 2026-08-03 section 3). Shape only here; the MERGED
  // start === end rejection needs the stored settings and lives in the handler.
  if ('quietHoursEnabled' in b) {
    const v = b['quietHoursEnabled'];
    if (typeof v !== 'boolean') return { error: 'quietHoursEnabled must be a boolean' };
    patch.quietHoursEnabled = v;
  }
  if ('quietHoursStart' in b) {
    const v = b['quietHoursStart'];
    if (typeof v !== 'string' || !isValidHhMm(v)) {
      return { error: 'quietHoursStart must be "HH:MM" (24-hour)' };
    }
    patch.quietHoursStart = v;
  }
  if ('quietHoursEnd' in b) {
    const v = b['quietHoursEnd'];
    if (typeof v !== 'string' || !isValidHhMm(v)) {
      return { error: 'quietHoursEnd must be "HH:MM" (24-hour)' };
    }
    patch.quietHoursEnd = v;
  }
  if ('timezone' in b) {
    const v = b['timezone'];
    if (typeof v !== 'string' || !isValidIanaTimezone(v)) {
      return { error: 'timezone must be a valid IANA timezone id' };
    }
    patch.timezone = v;
  }
  if ('welcomeText' in b) {
    const v = b['welcomeText'];
    if (v === null) {
      // Explicit CLEAR — revert to the WELCOME_TEXT_TEMPLATE default (repo REMOVE).
      patch.welcomeText = null;
    } else if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEMPLATE_CHARS) {
      return { error: `welcomeText must be a 1..${MAX_TEMPLATE_CHARS}-char string` };
    } else if (!templateHasOptOutLanguage(v)) {
      // do-not-remove — A2P/CTIA compliance floor. The welcome is a first-contact
      // template: its override must keep opt-out language (clearing to null,
      // handled above, is fine — it reverts to the compliant WELCOME_SMS default).
      return { error: 'missing_opt_out_language' };
    } else {
      patch.welcomeText = v;
    }
  }
  return { patch };
}

/** A request-side failure captured from `req` itself (error, abort, close before
 *  complete) and used to destroy the gate - so the route can tell "the client
 *  went away" from "the gate refused the file" by the ERROR alone. */
class GreetingClientAbortedError extends Error {
  constructor() {
    super('client aborted the greeting upload');
    this.name = 'GreetingClientAbortedError';
  }
}

/** The declared body length, or undefined when absent or not a whole number. */
function parseContentLength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Decode the URI-encoded display-name header; a bad encoding reads as absent. */
function decodeFileNameHeader(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const log = deps.logger ?? defaultLogger;
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const { config } = deps;
  const mediaStore = deps.mediaStore;
  // Same per-user mint fence shape as the MMS presign route: cheap abuse
  // protection on an admin-only route. ONE instance per router.
  const uploadLimiter = createUserRateLimit({
    routeKey: 'voicemail_greeting_upload',
    max: 10,
    windowMs: 60_000,
    logger: log,
  });

  const router = Router();

  // GET /api/settings — VAs may view (requireAuth, mounted upstream).
  // `welcomeTextDefault` rides ALONGSIDE the settings (not inside them — it is
  // read-only, never patchable): the exact welcome body sent when welcomeText is
  // unset, so the Settings UI can SHOW the admin what "the default" actually says
  // instead of asking them to trust a blank box.
  router.get('/', async (_req, res) => {
    const current = await settings.getOrgSettings();
    res.json({
      settings: current,
      welcomeTextDefault: WELCOME_SMS,
      // Env-sourced and READ-ONLY (never patchable), the same shape as
      // welcomeTextDefault above: the Settings UI shows the number this app
      // sends from without implying it can be edited here. OMITTED when
      // unconfigured (the repo's conditional-spread idiom) rather than null -
      // "not configured" is `=== undefined` on the wire, and the same
      // convention holds on /api/system/flags, whose payload is asserted to
      // hold primitives only.
      ...(config.businessPhoneNumber !== undefined && {
        businessPhoneNumber: config.businessPhoneNumber,
      }),
    });
  });

  // PUT /api/settings — only admins may edit.
  router.put('/', requireRole('admin'), async (req: AuthedRequest, res) => {
    const parsed = parsePatch(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // A zero-length window (start === end) is meaningless and would silently
    // disable the gate, so it is rejected - the way to turn quiet hours off is
    // quietHoursEnabled: false. The check merges the patch over the STORED
    // settings (an extra read, deliberately AFTER parsePatch so a malformed
    // body never costs one), because a ONE-field patch could otherwise sneak a
    // zero-length window past a patch-only check.
    if (parsed.patch.quietHoursStart !== undefined || parsed.patch.quietHoursEnd !== undefined) {
      const current = await settings.getOrgSettings();
      const start = parsed.patch.quietHoursStart ?? current.quietHoursStart;
      const end = parsed.patch.quietHoursEnd ?? current.quietHoursEnd;
      if (start === end) {
        res.status(400).json({ error: 'quiet_hours_zero_length' });
        return;
      }
    }
    const updated = await settings.putOrgSettings(parsed.patch);
    await audit.append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', {
      fields: Object.keys(parsed.patch),
      actor: req.user?.userId,
    });
    log.info(
      { actor: req.user?.userId, fields: Object.keys(parsed.patch) },
      'org settings updated via API',
    );
    // The SAME three keys as the GET: SettingsResponse is shared by both calls
    // and the dashboard re-sets its state from THIS response, so a GET-only
    // field would make the shared type lie - the PUT would answer with the key
    // absent, which the client reads as "unconfigured". No surface loses the
    // number today (the only reader, the Phone numbers block, never saves), so
    // this is contract consistency rather than a live bug: keep the two
    // responses the same shape and a future saver-plus-reader page cannot
    // regress into one.
    res.json({
      settings: updated,
      welcomeTextDefault: WELCOME_SMS,
      ...(config.businessPhoneNumber !== undefined && {
        businessPhoneNumber: config.businessPhoneNumber,
      }),
    });
  });

  // PUT /api/settings/voicemail-greeting (voicemail-greeting spec 4.3): the RAW
  // file bytes as the body, streamed through the sniff-and-cap gate into the
  // media store under the fixed key, then the record SET on the org settings.
  // Memory bound (spec assumption G): this route holds no buffer, but the
  // store's lib-storage upload holds the accepted greeting in memory - at most
  // one 5 MiB part, which at this cap is the whole file - before sending it as
  // a single PutObject once the gate ends. lib-storage's part concatenation
  // also makes a transient copy (Buffer.concat while the chunk list is still
  // referenced), so the peak per upload is about twice the accepted file:
  // about 10 MiB at the 5 MiB cap.
  // A refusal must REACH the browser as JSON and leave the connection usable,
  // which is why this uses req.pipe plus a drain - never stream.pipeline and
  // never Connection: close. Measured on Node 24: pipeline destroys req on a
  // gate error and never reads the rest of the body, so the keep-alive
  // connection sits stuck until the server's keep-alive timeout resets it;
  // closing a connection the client is still uploading on resets that client
  // before it reads the 4xx JSON. The route tests pin both through connection
  // reuse. A refused body is DRAINED (req.resume) so the response can be
  // read: bounded by the Content-Length check below for a known-length body
  // (at most 5 MiB reaches the gate); a chunked body over the cap - which
  // browsers never send for a Blob - drains until the client stops or Node's
  // default 300 s requestTimeout ends it (never set requestTimeout: 0).
  // Destroying the request after the response "finishes" was measured to
  // reset the client before it reads the 413, so nothing here destroys req.
  // See docs/issues/mms-upload-endpoint-hardening.md for the same trade-off
  // on the retired MMS endpoint.
  router.put('/voicemail-greeting', requireRole('admin'), uploadLimiter, async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const normalized = normalizeGreetingContentType(req.headers['content-type']);
    if (normalized === undefined) {
      res.status(400).json({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
      return;
    }
    const declaredLength = parseContentLength(req.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > VOICEMAIL_GREETING_MAX_BYTES) {
      res.status(413).json({ error: 'file_too_large', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
      return;
    }
    if (declaredLength === 0) {
      res.status(400).json({ error: 'empty_file' });
      return;
    }

    const gate = new GreetingUploadGate({ format: normalized.format, maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
    // A gate error must never surface as an unhandled 'error' event in the gap
    // before lib-storage attaches its consumer; put() rejects with it anyway.
    gate.on('error', () => {});
    const abortGate = () => gate.destroy(new GreetingClientAbortedError());
    req.on('error', abortGate);
    req.on('aborted', abortGate);
    req.on('close', () => {
      if (!req.complete) abortGate();
    });
    // A request that died BEFORE this handler ran (the client left during the
    // async session check while the server was still reading) has already
    // emitted 'aborted' and 'close': the listeners above can never hear it and
    // the pipe below would never end, leaving put() waiting forever. Take the
    // same client_aborted path now. This only detects a request that is
    // already gone; put's outcome below is still classified by its ERROR alone.
    if (req.destroyed) abortGate();
    req.pipe(gate);
    const putPromise = mediaStore.put(VOICEMAIL_GREETING_S3_KEY, gate, normalized.contentType);

    let sizeBytes: number;
    try {
      await putPromise;
      sizeBytes = gate.bytesSeen;
    } catch (err) {
      if (err instanceof GreetingRejectedError) {
        req.unpipe(gate);
        // Drain what is left so the response can be READ by the client. For a
        // known length this is bounded (step 3 refused anything over 5 MiB);
        // for a chunked over-cap body it is not, and that is accepted: browsers
        // never send a Blob chunked, and destroying the request after the
        // response "finishes" was measured to RESET the client before it reads
        // the 413 (spec 4.3).
        req.resume();
        if (err.reason === 'invalid_format') {
          res.status(400).json({ error: 'unsupported_media_type', message: VOICEMAIL_GREETING_REJECT_MESSAGE });
        } else if (err.reason === 'too_large') {
          res.status(413).json({ error: 'file_too_large', maxBytes: VOICEMAIL_GREETING_MAX_BYTES });
        } else {
          res.status(400).json({ error: 'empty_file' });
        }
        return;
      }
      if (err instanceof GreetingClientAbortedError) {
        log.warn({ actor, reason: 'client_aborted' }, 'voicemail greeting upload aborted by the client');
        if (!res.headersSent) res.destroy();
        return;
      }
      log.error({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting upload failed');
      res.status(500).json({ error: 'upload_failed' });
      return;
    }

    const record: VoicemailGreeting = {
      s3Key: VOICEMAIL_GREETING_S3_KEY,
      contentType: normalized.contentType,
      fileName: sanitizeGreetingFileName(decodeFileNameHeader(req.headers[VOICEMAIL_GREETING_FILE_NAME_HEADER]), normalized.format),
      sizeBytes,
      uploadedAt: new Date().toISOString(),
      uploadedByUserId: req.user?.userId ?? '',
      uploadedByEmail: req.user?.email ?? '',
    };
    try {
      await settings.putOrgSettings({ voicemailGreeting: record });
    } catch (err) {
      // The object under the fixed key already holds the NEW bytes. Two cases,
      // neither a broken call: on a REPLACE the record still describes the
      // previous upload (name, type, size, uploadedAt) while the webhook offers
      // the fixed key, so callers hear the new file under a stale description
      // and the dashboard's player URL (`?v=<old uploadedAt>`) serves the new
      // bytes; on a FIRST upload no record exists, the webhook stops at
      // "absent", and callers keep the built-in prompt. The distinct error code
      // lets the dashboard re-fetch and show what the server holds; the next
      // successful upload rewrites both (spec 4.3, planner review AD1).
      log.error({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting stored but the settings record write failed');
      res.status(500).json({ error: 'greeting_record_failed' });
      return;
    }
    // Best effort: the greeting is LIVE (the object is stored and the record
    // now matches it); a 500 here would tell the admin the upload failed while
    // callers already hear it.
    await audit
      .append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', { fields: ['voicemailGreeting'], action: 'uploaded', actor })
      .catch((err: unknown) => log.error({ err, actor }, 'voicemail greeting audit append failed'));
    // PII posture: the file name is never logged.
    log.info({ actor, s3Key: VOICEMAIL_GREETING_S3_KEY, contentType: normalized.contentType, sizeBytes }, 'voicemail greeting uploaded');
    res.json({ voicemailGreeting: record });
  });

  // DELETE /api/settings/voicemail-greeting (spec 4.4): the RECORD is the
  // authority - clear it first, then best-effort delete the object (a leftover
  // object under the fixed key is unreferenced and overwritten by the next
  // upload; on the versioned bucket this writes a delete marker).
  router.delete('/voicemail-greeting', requireRole('admin'), async (req: AuthedRequest, res) => {
    const actor = req.user?.userId;
    await settings.putOrgSettings({ voicemailGreeting: null });
    if (mediaStore) {
      await mediaStore
        .deleteObject(VOICEMAIL_GREETING_S3_KEY)
        .catch((err: unknown) =>
          log.warn({ err, actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting object delete failed - record already cleared'),
        );
    }
    await audit
      .append(ORG_SETTINGS_ENTITY_KEY, 'settings_updated', { fields: ['voicemailGreeting'], action: 'removed', actor })
      .catch((err: unknown) => log.error({ err, actor }, 'voicemail greeting audit append failed'));
    log.info({ actor, s3Key: VOICEMAIL_GREETING_S3_KEY }, 'voicemail greeting removed');
    res.status(204).end();
  });

  // GET /api/settings/voicemail-greeting/audio (spec 4.5): any logged-in user
  // (requireAuth from the /api mount) may play it; same streaming, range and
  // cache posture as GET /api/calls/:callId/recording. It streams the FIXED
  // key, never the record's s3Key: the projection already accepts only that
  // key, and reading the constant here (defense in depth) means no projection
  // change or second writer of the map can make this any-user route serve a
  // call recording or an MMS object.
  router.get('/voicemail-greeting/audio', async (req, res) => {
    const current = await settings.getOrgSettings();
    const greeting = current.voicemailGreeting;
    if (greeting === undefined || !mediaStore) {
      res.status(404).json({ error: 'greeting_not_found' });
      return;
    }
    await serveMediaObject(req, res, {
      mediaStore,
      key: VOICEMAIL_GREETING_S3_KEY,
      defaultContentType: greeting.contentType,
      cacheControl: 'private, max-age=3600',
      notFoundError: 'greeting_not_found',
      log,
      logContext: { s3Key: VOICEMAIL_GREETING_S3_KEY },
      messages: {
        missing: 'voicemail greeting record present but object not found in the media store',
        streaming: 'streaming the voicemail greeting to the dashboard',
        errored: 'voicemail greeting stream errored mid-flight',
      },
    });
  });

  return router;
}
