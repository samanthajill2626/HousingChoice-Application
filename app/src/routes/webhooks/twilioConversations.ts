// Twilio Conversations webhook - ONE route, dispatched on EventType.
//
// WHY ONE ROUTE. The design carried two endpoints: `/conversations/receipts`
// for `onDeliveryUpdated` (S5) and `/conversations/events` for the guardrail
// cross-check's `onMessageAdded` (S6). The S5-PRE addendum found two things
// that collapse them:
//   1. PRECEDENCE IS REAL. Configuring a SERVICE-scoped webhook SILENCES the
//      account-global scope entirely - the global config fired zero times over
//      a 60-minute window while the service scope received everything. Shipping
//      the planned config would have killed guardrail 2 silently.
//   2. Twilio permits exactly ONE PostWebhookUrl per Conversations service. So
//      both filters (`onDeliveryUpdated` + `onMessageAdded`) point HERE, and the
//      handler splits them.
// Both halves keep their own handling; only the transport is shared.
//
// MOUNT ORDER IS LOAD-BEARING: this router must mount BEFORE
// `router.use('/twilio', ...)` in webhooks/index.ts, exactly like /twilio/voice
// and /twilio/events. The messaging router is a PREFIX mount and would
// otherwise swallow /twilio/conversations and 404 every receipt.
//
// AUTH is X-Twilio-Signature over the form body - the standard scheme the
// messaging webhook uses. NOT the shared-secret scheme at /webhooks/twilio/events:
// that one belongs to the A2P Event Streams sink and is not this route.
//
// ACK POSTURE: always 200, even for a handler failure or an unrecognized event.
// Twilio redelivers on non-2xx, and a hot retry loop against a broken handler
// makes an incident worse, not better. Failures are ERRORs, which is the alarm.
import { Router, type RequestHandler } from 'express';
import { loadConfig, type AppConfig } from '../../lib/config.js';
import { logger as defaultLogger, type Logger } from '../../lib/logger.js';
import { twilioSignatureMiddleware } from '../../middleware/twilioSignature.js';
import {
  createGroupReceiptsService,
  type GroupReceiptsService,
} from '../../services/groupReceipts.js';
import { createGroupCrossCheck } from '../../services/groupCrossCheck.js';

/**
 * A carrier-sourced `onMessageAdded` event, handed to the guardrail cross-check.
 * S6/T6.2 fills this in; the FILTER (spec 15.1 - `Source === 'SMS'` plus an
 * external-member author) belongs with the reconciliation logic, not here, so
 * every onMessageAdded is forwarded verbatim and S6 decides what to count.
 */
export interface ConversationsMessageAddedEvent {
  /** IMxx. */
  messageSid: string;
  /** CHxx. */
  conversationSid: string;
  /** MBxx of the author's participant, when Twilio supplies one. */
  participantSid?: string;
  /** The author's address (an E.164 member, or our own business number). */
  author?: string;
  /** `SMS` for carrier-sourced; `API`/`SDK` for our own posts. */
  source?: string;
  /** ISO 8601. */
  dateCreated?: string;
  /** Present on carrier-sourced events; the cross-check does not persist it. */
  body?: string;
}

/**
 * THE SEAM S6 BINDS TO. The cross-check persists + dedupes by IM SID, records
 * `group_crosscheck_last_event_at`, and alarms from the sweep on an event still
 * unmatched at its grace deadline. None of that exists yet.
 */
export interface ConversationsCrossCheck {
  recordConversationEvent(event: ConversationsMessageAddedEvent): Promise<void>;
}

/**
 * An explicitly UNWIRED cross-check. Kept after T6.2 shipped because "the
 * cross-check is not wired" and "the cross-check saw nothing" are different
 * worlds and only one of them is a guardrail failure: a caller that genuinely
 * has no cross-check passes this and gets the counter, rather than a silent
 * no-op that looks like health.
 */
export const CROSS_CHECK_NOT_WIRED: ConversationsCrossCheck = {
  async recordConversationEvent() {
    // Deliberately empty; the route logs the not-wired counter around it.
  },
};

export interface TwilioConversationsWebhookDeps {
  config?: AppConfig;
  logger?: Logger;
  /** The receipts pipeline; default-constructed over the real repos. */
  groupReceipts?: GroupReceiptsService;
  /** The guardrail cross-check (T6.2). Defaults to the real service. */
  crossCheck?: ConversationsCrossCheck;
  /** False marks the injected cross-check as a deliberate gap (counter only). */
  crossCheckWired?: boolean;
}

/** Form params are strings; missing values read as ''. */
function param(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

export function createTwilioConversationsRouter(
  deps: TwilioConversationsWebhookDeps = {},
): Router {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const receipts =
    deps.groupReceipts ??
    createGroupReceiptsService({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  // T6.6: the real cross-check is the DEFAULT now. The Source/author filter and
  // the whole ledger live in the service - this route forwards every
  // onMessageAdded verbatim, because deciding what to count is reconciliation
  // policy, not transport.
  const crossCheck =
    deps.crossCheck ??
    createGroupCrossCheck({ config, ...(deps.logger !== undefined && { logger: deps.logger }) });
  const crossCheckWired = deps.crossCheckWired ?? true;

  const router = Router();
  const verifySignature: RequestHandler = twilioSignatureMiddleware({
    authToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    nodeEnv: config.nodeEnv,
    logger: log,
  });

  router.post('/', verifySignature, async (req, res) => {
    const eventType = param(req.body, 'EventType');
    try {
      switch (eventType) {
        case 'onDeliveryUpdated': {
          const errorCode = param(req.body, 'ErrorCode');
          const channelMessageSid = param(req.body, 'ChannelMessageSid');
          const outcome = await receipts.applyReceipt({
            messageSid: param(req.body, 'MessageSid'),
            participantSid: param(req.body, 'ParticipantSid'),
            status: param(req.body, 'Status'),
            ...(errorCode.length > 0 && { errorCode }),
            ...(channelMessageSid.length > 0 && { channelMessageSid }),
            conversationSid: param(req.body, 'ConversationSid'),
          });
          res.status(200).json({ ok: true, outcome: outcome.outcome });
          return;
        }
        case 'onMessageAdded': {
          // S6/T6.2's half. Forwarded whole; the Source/author filter lives with
          // the reconciliation, not with the transport.
          const participantSid = param(req.body, 'ParticipantSid');
          const author = param(req.body, 'Author');
          const source = param(req.body, 'Source');
          const dateCreated = param(req.body, 'DateCreated');
          const body = param(req.body, 'Body');
          await crossCheck.recordConversationEvent({
            messageSid: param(req.body, 'MessageSid'),
            conversationSid: param(req.body, 'ConversationSid'),
            ...(participantSid.length > 0 && { participantSid }),
            ...(author.length > 0 && { author }),
            ...(source.length > 0 && { source }),
            ...(dateCreated.length > 0 && { dateCreated }),
            ...(body.length > 0 && { body }),
          });
          if (!crossCheckWired) {
            log.info(
              { event: 'group_crosscheck_not_wired', source },
              'conversations onMessageAdded received with no cross-check wired (S6 task T6.2)',
            );
          }
          res.status(200).json({ ok: true, handled: 'onMessageAdded' });
          return;
        }
        default: {
          // A filter someone added in the Twilio console, or a new event type.
          // WARN + counter, never a 500: Twilio would retry it forever.
          log.warn(
            { event: 'conversations_event_unrecognized', eventType },
            'unrecognized Conversations EventType acknowledged and ignored',
          );
          res.status(200).json({ ok: true, ignored: true });
          return;
        }
      }
    } catch (err) {
      // ERROR feeds the error-logs alarm; the 200 keeps Twilio from hot-looping.
      log.error(
        { err, event: 'conversations_webhook_failed', eventType },
        'conversations webhook handler failed - acknowledged so Twilio does not retry-storm',
      );
      res.status(200).json({ ok: false });
    }
  });

  return router;
}
