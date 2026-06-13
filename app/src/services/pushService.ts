// pushService — send a Web Push notification to all of a user's devices
// (M1.4). Loads the user's stored push_subscriptions, sends to each via the
// webPush adapter, and PRUNES any the push service reports Gone (404/410) by
// removing them from the user record.
//
// PII posture (doc §9 / M1.4 brief): notification payloads carry a contact's
// name + address (the CO2 §7.1 pre-ring / missed-call context). This service
// NEVER logs the payload body — log lines carry userId + a notification
// `kind` (e.g. 'missed_call', 'test') + counts, never names/addresses. The
// caller passes `kind` separately from the payload for exactly this reason.
//
// Push is a FEATURE, not core: when VAPID is unconfigured the service is a
// no-op that WARNs once per call and returns a zeroed result. Texting/calls
// never depend on this — the founder still gets her texts even with push off.
import {
  createWebPushAdapter,
  isAllowedPushEndpoint,
  type PushSubscription,
  type WebPushAdapter,
} from '../adapters/webPush.js';
import { isPushConfigured, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createUsersRepo,
  type PushSubscriptionRecord,
  type UsersRepo,
} from '../repos/usersRepo.js';

/** What a caller asks pushService to deliver. `kind` is the only thing logged. */
export interface PushNotification {
  /**
   * A short, NON-PII classification of the notification used for logging
   * (e.g. 'missed_call', 'pre_ring', 'test'). NEVER a name/address.
   */
  kind: string;
  /**
   * The notification body the service worker renders, e.g.
   * { title, body, data:{ url, callId } }. Serialized as-is and handed to the
   * push service ENCRYPTED — but it contains PII, so it is never logged.
   */
  payload: Record<string, unknown>;
}

/** Per-call outcome: how many devices we sent to, and how many dead ones we pruned. */
export interface SendToUserResult {
  /** True when VAPID was configured and the send actually ran. */
  configured: boolean;
  /** Subscriptions the user had when the send started. */
  attempted: number;
  /** Accepted by the push service (2xx). */
  sent: number;
  /** Reported Gone (404/410) and pruned from the user record. */
  pruned: number;
  /** Transient failures (non-Gone errors) — logged, not pruned, not thrown. */
  failed: number;
}

export interface PushService {
  /**
   * Send to every device of a user. Loads subscriptions, sends each, prunes
   * the Gone ones. Never throws on a single dead/failing device — push is
   * best-effort. Returns a per-call tally.
   */
  sendToUser(userId: string, notification: PushNotification): Promise<SendToUserResult>;
}

export interface PushServiceDeps {
  config: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  /** Injected in tests; defaults to the VAPID-configured web-push adapter (undefined when off). */
  adapter?: WebPushAdapter;
}

function toBrowserSubscription(record: PushSubscriptionRecord): PushSubscription {
  return { endpoint: record.endpoint, keys: record.keys };
}

export function createPushService(deps: PushServiceDeps): PushService {
  const log = deps.logger ?? defaultLogger;
  const { config } = deps;
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  // The adapter is undefined when VAPID is unconfigured (push off).
  const adapter = deps.adapter ?? createWebPushAdapter(config);

  return {
    async sendToUser(userId, notification) {
      if (adapter === undefined || !isPushConfigured(config)) {
        // No-op: push is a feature, not core. WARN (not ERROR) so it doesn't
        // trip the error-log alarm — an unconfigured stack is a known state.
        log.warn(
          { userId, kind: notification.kind },
          'push not configured (VAPID unset) — notification skipped (no-op)',
        );
        return { configured: false, attempted: 0, sent: 0, pruned: 0, failed: 0 };
      }

      const user = await users.findById(userId);
      const subscriptions = user?.push_subscriptions ?? [];
      if (subscriptions.length === 0) {
        log.info(
          { userId, kind: notification.kind },
          'push: user has no subscriptions — nothing to send',
        );
        return { configured: true, attempted: 0, sent: 0, pruned: 0, failed: 0 };
      }

      // Serialize ONCE. The body holds PII (name/address) — never logged.
      const body = JSON.stringify(notification.payload);
      let sent = 0;
      let pruned = 0;
      let failed = 0;

      // Send sequentially: a founder has at most a few devices (cap 10), so
      // there's no fan-out worth parallelizing, and serial keeps prune
      // read-modify-writes from racing each other on the one user item.
      for (const record of subscriptions) {
        // SSRF defense in depth (C1): never send to an endpoint that isn't a
        // known web-push vendor host. A bad endpoint stored before the
        // subscribe-time guard existed is pruned here, BEFORE any POST — so the
        // server is never aimed at an internal/attacker address.
        if (!isAllowedPushEndpoint(record.endpoint)) {
          await users.removePushSubscription(userId, record.endpoint);
          pruned += 1;
          log.warn(
            { userId, kind: notification.kind },
            'push: stored endpoint failed the host allowlist — pruned, not sent',
          );
          continue;
        }
        try {
          const outcome = await adapter.sendToSubscription(toBrowserSubscription(record), body);
          if (outcome.result === 'gone') {
            await users.removePushSubscription(userId, record.endpoint);
            pruned += 1;
          } else {
            sent += 1;
          }
        } catch (err) {
          // A transient failure (5xx/network) — NOT a prune signal. Log
          // correlated (the logger mixin stamps the correlationId) and move
          // on; one dead device must not fail the whole notification.
          failed += 1;
          log.warn(
            { userId, kind: notification.kind, err: (err as Error).message },
            'push: send to one device failed (transient) — kept subscription',
          );
        }
      }

      log.info(
        { userId, kind: notification.kind, attempted: subscriptions.length, sent, pruned, failed },
        'push: sendToUser complete',
      );
      return { configured: true, attempted: subscriptions.length, sent, pruned, failed };
    },
  };
}
