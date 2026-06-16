// Quick-reply action-id scheme — the contract between the missed-call push
// (Android notification `actions[].action` ids, set by the server in M1.9) and
// this view's auto-send. The server has NOT yet been built to send these (calls
// + push triggers are M1.9), so this module DEFINES the ids the push must use;
// the view resolves an incoming `#action=<id>` (or SW postMessage action) to a
// concrete reply body using these helpers.
//
// Scheme (stable, index-based so it survives template edits positionally):
//   'auto'  → the missedCallAutoText (the zero-tap default reply)
//   'qr-<n>'→ quickReplies[n]   (n = 0-based index into the settings array)
//
// Rationale: OrgSettings.quickReplies is a bare string[] with no server-side
// ids, so an index-based id is the only deterministic handle we can form on the
// client. M1.9's push builder MUST emit notification action ids in this exact
// shape (one action per quick reply it surfaces, plus optionally 'auto') for the
// Android action-button path to auto-send the right template here.
import type { OrgSettings } from '../../api/index.js';

/** A resolved quick-reply option: a stable id + the body text to send. */
export interface QuickReplyOption {
  /** Stable action id ('auto' | 'qr-<index>'). Matches the push action id. */
  id: string;
  /** The message body that gets sent. */
  body: string;
  /** A short human label for the option (currently the body itself). */
  label: string;
  /** True for the missed-call auto-text option (rendered distinctly). */
  isAuto: boolean;
}

/** The action id for the missed-call auto-text option. */
export const AUTO_TEXT_ACTION_ID = 'auto';

/** Build the action id for the Nth quick reply. */
export function quickReplyActionId(index: number): string {
  return `qr-${index}`;
}

/**
 * Derive the ordered list of canned-reply options from org settings: the
 * configured quick replies, plus the missed-call auto-text as one more option
 * when it is set (it leads, since it is the zero-tap default). Blank/whitespace
 * templates are dropped so we never render an empty tap target.
 */
export function buildOptions(settings: OrgSettings): QuickReplyOption[] {
  const options: QuickReplyOption[] = [];

  const autoText = settings.missedCallAutoText.trim();
  if (autoText.length > 0) {
    options.push({ id: AUTO_TEXT_ACTION_ID, body: autoText, label: autoText, isAuto: true });
  }

  settings.quickReplies.forEach((reply, index) => {
    const body = reply.trim();
    if (body.length === 0) return;
    options.push({ id: quickReplyActionId(index), body, label: body, isAuto: false });
  });

  return options;
}

/** Find the option matching an incoming action id, or undefined if none. */
export function optionForAction(
  options: QuickReplyOption[],
  actionId: string | null | undefined,
): QuickReplyOption | undefined {
  if (actionId === null || actionId === undefined || actionId === '') return undefined;
  return options.find((o) => o.id === actionId);
}
