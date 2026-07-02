// Founder settings routes (M1.4), mounted under /api (behind requireAuth):
//
//   GET /api/settings   → { settings }                 (requireAuth — VAs may VIEW)
//   PUT /api/settings   { patch } → { settings }        (requireRole('admin') — only admins EDIT)
//
// Stores the founder-editable templates Change Order 2 introduced (missed-call
// auto-text + quick replies). M1.4 only stores/edits them — they are CONSUMED
// in M1.9 (the voice/call-triage milestone). See repos/settingsRepo.ts.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { templateHasOptOutLanguage, WELCOME_SMS } from '../lib/smsCompliance.js';
import { requireRole, type AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createSettingsRepo,
  ORG_SETTINGS_ENTITY_KEY,
  type OrgSettings,
  type SettingsRepo,
} from '../repos/settingsRepo.js';

export interface SettingsRouterDeps {
  logger?: Logger;
  settingsRepo?: SettingsRepo;
  auditRepo?: AuditRepo;
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
/** The validated patch. `welcomeText` may be `null` — an explicit CLEAR that the
 *  repo turns into a DynamoDB REMOVE (revert to the WELCOME_TEXT_TEMPLATE
 *  default); every other field keeps its OrgSettings type. */
type SettingsPatch = Partial<Omit<OrgSettings, 'welcomeText'>> & { welcomeText?: string | null };

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
    // do-not-remove — A2P/CTIA compliance floor. A first-contact template MUST
    // keep opt-out language ("Reply STOP…") — an admin must never be able to
    // strip it, or the app would text people with no documented way to opt out.
    if (!templateHasOptOutLanguage(v)) {
      return { error: 'missing_opt_out_language' };
    }
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

export function createSettingsRouter(deps: SettingsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });

  const router = Router();

  // GET /api/settings — VAs may view (requireAuth, mounted upstream).
  // `welcomeTextDefault` rides ALONGSIDE the settings (not inside them — it is
  // read-only, never patchable): the exact welcome body sent when welcomeText is
  // unset, so the Settings UI can SHOW the admin what "the default" actually says
  // instead of asking them to trust a blank box.
  router.get('/', async (_req, res) => {
    const current = await settings.getOrgSettings();
    res.json({ settings: current, welcomeTextDefault: WELCOME_SMS });
  });

  // PUT /api/settings — only admins may edit.
  router.put('/', requireRole('admin'), async (req: AuthedRequest, res) => {
    const parsed = parsePatch(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
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
    res.json({ settings: updated, welcomeTextDefault: WELCOME_SMS });
  });

  return router;
}
