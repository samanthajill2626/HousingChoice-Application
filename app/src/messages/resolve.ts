// Message resolver - picks an override-or-default from the catalog and
// interpolates {token} placeholders. This module is PURE: no repos, no I/O and
// no value import of anything that reaches the AWS SDK, so it is safe to import
// from any layer (including the Playwright harness, via messages/tourCopy.ts).
// The async settings-aware convenience lives next door in resolveWithSettings.ts.
import { MESSAGE_CATALOG, type MessageId } from './catalog.js';
import type { OrgSettings } from '../repos/settingsRepo.js';

/**
 * Substitute `{token}` for each ALLOWED token that actually appears in the
 * template. Tokens NOT in `allowed` are left untouched. A declared token that
 * does not appear in the template needs no value (e.g. welcome.sms declares
 * {firstName} for override use, but the default copy does not personalize).
 *
 * A declared token present in the template but missing from `vars`:
 * - in a catalog DEFAULT (`strict`): a genuine coding defect — throws. A default
 *   is code-controlled; if it declares a token the call site must supply it, and
 *   the tests catch a forgotten one.
 * - in an operator OVERRIDE (`!strict`): degrades to empty. Operator template
 *   data must NEVER crash a send path — a personalized welcomeText that uses
 *   {firstName} can fire on a path with no name (the START/keyword reply), and
 *   the confirmation must still go out rather than silently throwing.
 *
 * SINGLE PASS. The scan runs ONCE over the ORIGINAL template, so a substituted
 * VALUE is never part of the string being scanned and can never re-open a token
 * (message-interpolate-token-reexpansion): a name, or a relayed body, that
 * happens to contain "{names}" stays literal text instead of expanding into
 * another variable's value. The replacement is a CALLBACK, never a string -
 * String.replace with a string argument interprets $&/$1/$`/$' inside the VALUE,
 * which would trade token re-expansion for $-expansion. The token charset in the
 * regex is guarded STRUCTURALLY by a test that iterates MESSAGE_CATALOG (grep
 * cannot see it - several vars arrays are spread-built), because a declared var
 * outside that charset would silently never substitute.
 */
function interpolate(
  template: string,
  vars: Record<string, string> | undefined,
  allowed: readonly string[],
  strict: boolean,
): string {
  const allowedSet = new Set(allowed);
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, token: string) => {
    if (!allowedSet.has(token)) return match; // undeclared -> literal, as before
    const value = vars?.[token];
    if (typeof value !== 'string') {
      if (strict) {
        throw new Error(`resolveMessage: missing interpolation var "${token}"`);
      }
      return ''; // operator override degrades, never crashes a send path
    }
    return value;
  });
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
  const usingOverride = typeof override === 'string' && override.length > 0;
  const template = usingOverride ? override : def.default;
  // Strict (throw on a missing declared token) only for code-controlled
  // DEFAULTS; operator OVERRIDES degrade gracefully so their template can never
  // crash a send path (see interpolate).
  return interpolate(template, vars, def.vars, !usingOverride);
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
