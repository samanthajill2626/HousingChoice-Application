// Message resolver — picks an override-or-default from the catalog and
// interpolates {token} placeholders. `resolveMessage` is PURE; the async
// `resolveWithSettings` convenience reads OrgSettings defensively (a settings-
// read failure must NEVER break a send → falls back to the catalog default).
import { MESSAGE_CATALOG, type MessageId } from './catalog.js';
import {
  createSettingsRepo,
  type OrgSettings,
  type SettingsRepo,
} from '../repos/settingsRepo.js';

/**
 * Substitute `{token}` for each ALLOWED token that actually appears in the
 * template. A declared token present in the template but missing from `vars` is
 * a DEFECT (throws — never silently blanks). Tokens NOT in `allowed` are left
 * untouched. A declared token that does not appear in the template needs no
 * value (e.g. welcome.sms declares {firstName} for override use, but the default
 * copy does not personalize).
 */
function interpolate(
  template: string,
  vars: Record<string, string> | undefined,
  allowed: readonly string[],
): string {
  let out = template;
  for (const token of allowed) {
    const needle = `{${token}}`;
    if (!out.includes(needle)) continue;
    const value = vars?.[token];
    if (typeof value !== 'string') {
      throw new Error(`resolveMessage: missing interpolation var "${token}"`);
    }
    out = out.split(needle).join(value);
  }
  return out;
}

/**
 * Resolve a message to its sent text. An `editable` entry honors a matching
 * override (non-empty string); a non-editable entry ignores overrides entirely.
 * Pure — no I/O.
 */
export function resolveMessage(
  id: MessageId,
  vars?: Record<string, string>,
  overrides?: Partial<Record<MessageId, string>>,
): string {
  const def = MESSAGE_CATALOG[id];
  const override = def.editable ? overrides?.[id] : undefined;
  const template =
    typeof override === 'string' && override.length > 0 ? override : def.default;
  return interpolate(template, vars, def.vars);
}

/**
 * Adapter: OrgSettings → the generic override map. This pass maps ONLY the
 * legacy editable fields (welcomeText → welcome.sms, missedCallAutoText →
 * missed_call.autotext). `quickReplies` is list-typed — NOT a catalog message —
 * and stays on OrgSettings, read as today. The day the generic Templates UI
 * lands, a `messageOverrides` map spreads in here (see the filed issue).
 */
export function settingsToOverrides(s: OrgSettings): Partial<Record<MessageId, string>> {
  return {
    ...(s.welcomeText ? { 'welcome.sms': s.welcomeText } : {}),
    ...(s.missedCallAutoText ? { 'missed_call.autotext': s.missedCallAutoText } : {}),
  };
}

/**
 * Async convenience: read OrgSettings, adapt to overrides, resolve. Reads
 * defensively — any settings-read failure falls back to `{}` overrides (→ the
 * catalog default), exactly today's behavior for welcomeText / quick-replies. A
 * settings-read failure must never break a send.
 *
 * `deps.settingsRepo` lets a caller that already owns an (injected/fake) repo
 * reuse it — call-sites without one self-provision the real repo.
 */
export async function resolveWithSettings(
  id: MessageId,
  vars?: Record<string, string>,
  deps?: { settingsRepo?: Pick<SettingsRepo, 'getOrgSettings'> },
): Promise<string> {
  let overrides: Partial<Record<MessageId, string>> = {};
  try {
    const repo = deps?.settingsRepo ?? createSettingsRepo();
    const s = await repo.getOrgSettings();
    overrides = settingsToOverrides(s);
  } catch {
    // best-effort: a settings-read failure must NOT break a send — fall back to
    // the catalog default (no override).
    overrides = {};
  }
  return resolveMessage(id, vars, overrides);
}
