// retry-send-window D3a + D14 (plan Task 10): the ONE-TO-ONE 30003 retry
// decision. The status webhook calls it BEFORE it writes the failed status, so
// the failure and whether a retry will be attempted become visible together: a
// `retry` verdict rides the failure's conditional write as retry_due_at (D7), a
// `decline` leaves the failure plain. The 30003 arm then logs the verdict and,
// for a retry, enqueues it at exactly `runAt` - only on the transition, so a
// redelivered callback does nothing twice.
//
// ORDER (spec D3a) - channel checks first (D3a step 1, D11), then the send
// path's previewable gates in the send path's own order. sendMessage itself
// checks its kill switch BEFORE its channel guards; here a group_text, relay or
// phone-less thread declines for its channel even with the kill switch off
// (both are WARN, and neither stamps).
//   1. the conversation row     - missing: decline, WARN (the level it logs at today)
//   2. group_text               - no retry exists for a native group text (D11), WARN
//   3. relay_group / no phone   - not a one-to-one SMS thread, WARN
//   4. the send path's refusals - previewSendRefusal, the SAME predicates as
//      sendMessage's gates (pinned by the parity table in
//      test/sendMessage.test.ts), judged for the ORIGINAL's `automated`
//      flag (absent = automated, D14) and its recorded recipient (absent, or an
//      id that resolves to nothing = the phone-matched contact), WARN
//   5. the cap                  - retry_attempt >= MAX_SEND_RETRY_ATTEMPTS, ERROR
//   6. the window               - the retry must go out by origin + 15 minutes
//      with RETRY_JOB_GRACE_MS to spare; origin = retry_window_start ??
//      provider_ts (D2), ERROR
//   7. otherwise                - retry at now + resolveSendRetryBackoffMs(attempt)
//
// FAILURE SEMANTICS (Cameron: attempt rather than risk a text never delivered):
// a conversation or contact read that THROWS fails OPEN, and the verdict is a
// retry marked failOpen 'read_failed'. On ANY failed read EVERY send-path
// refusal is skipped - previewSendRefusal does not run at all, so the kill
// switch, the thread's own opt-out and manual mode are skipped too, although
// they need no contact. A failed conversation read also skips the channel
// checks (1-3); a failed contact read comes after them. The cap and the window
// still apply: they need no read. A missing or unparseable origin fails open
// too (failOpen 'no_origin', D5); when both happen, 'read_failed' is reported.
// The job's sendMessage re-applies every refusal at send time (a group_text
// send included, D11); the breaker is the one refusal no preview can see.
//
// No logging (the arm logs the verdict; the job WARNs on a recorded recipient
// that no longer exists) and no clock (the caller passes nowMs, spec D13).
import { MAX_SEND_RETRY_ATTEMPTS, resolveSendRetryBackoffMs } from '../jobs/retrySend.js';
import { parseRetryWindowOrigin, retryFitsSendWindow } from '../lib/retrySendWindow.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import type { ConversationItem, ConversationsRepo } from '../repos/conversationsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';
import { previewSendRefusal, type SendRefusalCode } from './sendRefusalPreview.js';

export type OneToOneRetryDeclineReason =
  | 'conversation_missing'
  | 'group_text'
  | 'not_one_to_one'
  | SendRefusalCode
  | 'cap_exhausted'
  | 'window_closed';

export type OneToOneRetryDecision =
  | { kind: 'retry'; attempt: number; runAt: Date; failOpen?: 'read_failed' | 'no_origin'; readError?: unknown }
  | { kind: 'decline'; reason: OneToOneRetryDeclineReason; level: 'warn' | 'error' };

export async function decideOneToOneRetry(args: {
  message: MessageItem;
  conversations: Pick<ConversationsRepo, 'getById'>;
  contacts: Pick<ContactsRepo, 'findByPhone' | 'getById'>;
  smsSendingEnabled: boolean | undefined;
  nowMs: number;
}): Promise<OneToOneRetryDecision> {
  const { message, conversations, contacts, smsSendingEnabled, nowMs } = args;
  let readFailed = false;
  // The first thrown read, carried on the verdict so the arm's fail-open WARN
  // can name the fault (planner ruling on plan-draft-B2 F8).
  let readError: unknown;

  let conversation: ConversationItem | undefined;
  try {
    conversation = await conversations.getById(message.conversationId);
  } catch (err) {
    readFailed = true;
    readError = err;
  }

  if (!readFailed) {
    if (conversation === undefined) {
      return { kind: 'decline', reason: 'conversation_missing', level: 'warn' };
    }
    if (conversation.type === 'group_text') {
      return { kind: 'decline', reason: 'group_text', level: 'warn' };
    }
    const participantPhone = conversation.participant_phone;
    if (conversation.type === 'relay_group' || participantPhone === undefined) {
      return { kind: 'decline', reason: 'not_one_to_one', level: 'warn' };
    }

    let phoneContact: ContactItem | undefined;
    let recipient: ContactItem | undefined;
    try {
      phoneContact = await contacts.findByPhone(participantPhone);
      const recipientContactId = message.recipient_contact_id;
      if (typeof recipientContactId === 'string' && recipientContactId.length > 0) {
        recipient = await contacts.getById(recipientContactId);
      }
    } catch (err) {
      readFailed = true;
      readError = err;
    }

    if (!readFailed) {
      const refusal = previewSendRefusal({
        smsSendingEnabled,
        conversation,
        phoneContact,
        recipient,
        automated: message.automated ?? true,
      });
      if (refusal !== undefined) return { kind: 'decline', reason: refusal, level: 'warn' };
    }
  }

  const priorAttempt = message.retry_attempt ?? 0;
  if (priorAttempt >= MAX_SEND_RETRY_ATTEMPTS) {
    return { kind: 'decline', reason: 'cap_exhausted', level: 'error' };
  }
  const attempt = priorAttempt + 1;
  const backoffMs = resolveSendRetryBackoffMs(attempt);
  const originMs = parseRetryWindowOrigin(message.retry_window_start ?? message.provider_ts);
  if (originMs !== undefined && !retryFitsSendWindow({ originMs, nowMs, backoffMs })) {
    return { kind: 'decline', reason: 'window_closed', level: 'error' };
  }
  const failOpen = readFailed ? 'read_failed' : originMs === undefined ? 'no_origin' : undefined;
  return {
    kind: 'retry',
    attempt,
    runAt: new Date(nowMs + backoffMs),
    ...(failOpen !== undefined && { failOpen }),
    ...(readError !== undefined && { readError }),
  };
}
