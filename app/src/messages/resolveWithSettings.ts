// Async, settings-aware resolver convenience. Split out of resolve.ts so THAT
// module can stay pure: this one VALUE-imports createSettingsRepo, which pulls
// lib/dynamo.js and @aws-sdk/client-dynamodb. Anything that only needs to
// compose a body (the tour-copy composer, and through it the e2e harness)
// imports resolve.js / catalog.js and never touches the SDK.
import type { MessageId } from './catalog.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { resolveMessage, settingsToOverrides } from './resolve.js';

/**
 * Async convenience: read OrgSettings, adapt to overrides, resolve. Reads
 * defensively - any settings-read failure falls back to `{}` overrides (-> the
 * catalog default), exactly today's behavior for welcomeText / quick-replies. A
 * settings-read failure must never break a send.
 *
 * `deps.settingsRepo` lets a caller that already owns an (injected/fake) repo
 * reuse it - call-sites without one self-provision the real repo.
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
    // best-effort: a settings-read failure must NOT break a send - fall back to
    // the catalog default (no override).
    overrides = {};
  }
  return resolveMessage(id, vars, overrides);
}
