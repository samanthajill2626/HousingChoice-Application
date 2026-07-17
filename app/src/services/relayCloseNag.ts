// Relay close-nag arming (D5 safety net, relay-number-lifecycle AF-1/CF-1).
//
// The D5 nag ("this group text is still open - close it?") must surface on Today
// for ANY group left OPEN past a terminal event (placement lost/moved_in, tour
// canceled/not_a_fit) - NOT only for groups whose inline "Also close the group
// text?" ask was explicitly deferred. The dashboard dialog is dismissable (one
// Escape) and can fail to load, so the robust seam is a BACKEND arm at the
// terminal transition itself: it survives the operator closing the tab before
// answering.
//
// SET-IF-ABSENT: an existing/deferred nag is never shortened or extended by a
// new terminal event (the "Keep it open" defer at now+28d and the close-clear
// both still own the field). Best-effort: NEVER throws out of the caller - a
// nag-arm failure must not fail the transition it rides on.
//
// PII (doc section 9): logs the conversationId only.
import { CLOSE_NAG_INTERVAL_MS, type ConversationsRepo } from '../repos/conversationsRepo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

export interface ArmRelayCloseNagDeps {
  conversationsRepo: ConversationsRepo;
  logger?: Logger;
  /** Injectable epoch-ms clock (tests); defaults to Date.now. */
  now?: () => number;
}

/**
 * Arm the 28-day close-nag on a linked relay group left OPEN past a terminal
 * event, IF it does not already carry a nag. No-op (never throws) when the
 * group reference is absent, the conversation is missing / not a relay group /
 * already closed, or a nag is already set. `context` is a log-safe label
 * ('placement' | 'tour') for the arm message.
 */
export async function armRelayCloseNagIfOpen(
  deps: ArmRelayCloseNagDeps,
  groupThreadId: string | undefined,
  context: 'placement' | 'tour',
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  if (typeof groupThreadId !== 'string' || groupThreadId.length === 0) return;
  try {
    const conversation = await deps.conversationsRepo.getById(groupThreadId);
    if (
      !conversation ||
      conversation.type !== 'relay_group' ||
      conversation.status !== 'open' ||
      conversation.close_nag_next_at !== undefined
    ) {
      // Missing / not a relay group / already closed / already nagging: leave it.
      return;
    }
    const nowMs = deps.now !== undefined ? deps.now() : Date.now();
    const nextAt = new Date(nowMs + CLOSE_NAG_INTERVAL_MS).toISOString();
    await deps.conversationsRepo.setCloseNagNextAt(groupThreadId, nextAt);
    log.info({ conversationId: groupThreadId }, `relay close-nag armed on terminal ${context}`);
  } catch (err) {
    // Best-effort: the terminal transition already committed; never fail it.
    log.error({ err, conversationId: groupThreadId }, 'relay close-nag arm failed (best-effort)');
  }
}
