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
  type UserItem,
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
  /**
   * Optional queue lifetime (seconds) at the push service - see
   * WebPushSendOptions.ttlSeconds. Set it on TIME-SENSITIVE kinds (pre_ring)
   * whose notification is worthless once its moment passes; leave unset for
   * kinds where late is better than never (missed_call, voicemail).
   */
  ttlSeconds?: number;
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

/** Aggregate outcome of a send-to-all fan-out. */
export interface SendToAllResult {
  /** True when VAPID was configured and the fan-out actually ran. */
  configured: boolean;
  /** Users that had at least one subscription (zero-subscription users are skipped). */
  users: number;
  /** Subscriptions across those users when the fan-out started. */
  attempted: number;
  /** Accepted by the push service (2xx). */
  sent: number;
  /** Reported Gone (404/410) and pruned from the user record. */
  pruned: number;
  /** Transient failures (non-Gone errors) - logged, not pruned, not thrown. */
  failed: number;
}

export interface PushService {
  /**
   * Send to every device of a user. Loads subscriptions, sends each, prunes
   * the Gone ones. Never throws on a single dead/failing device — push is
   * best-effort. Returns a per-call tally.
   */
  sendToUser(userId: string, notification: PushNotification): Promise<SendToUserResult>;
  /**
   * Send to every device of EVERY user (inbound-message notifications: staff
   * are alerted as a team, with no owner/assignment filtering). Subscription
   * PRESENCE is the recipient filter, so a user who never enabled push costs
   * nothing. Reads the user list from a short-lived in-process cache rather
   * than scanning per message. Never throws: one failing device, or one
   * failing user, never aborts the fan-out. Logs ONE aggregate line, never
   * one per user, and never the payload.
   */
  sendToAll(notification: PushNotification): Promise<SendToAllResult>;
}

export interface PushServiceDeps {
  config: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  /** Injected in tests; defaults to the VAPID-configured web-push adapter (undefined when off). */
  adapter?: WebPushAdapter;
  /** Test clock for the sendToAll user-list TTL cache; defaults to Date.now. */
  now?: () => number;
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
  const now = deps.now ?? Date.now;
  /**
   * How long sendToAll reuses one listAll() result. Users are added/removed
   * rarely and notification fan-out is a non-mission-critical consumer, so a
   * per-message Scan of the users table is not worth it. Staleness bound: a
   * just-subscribed device can lag up to this long. Per INSTANCE (each
   * process holds its own), never module-global.
   */
  const USERS_CACHE_TTL_MS = 60_000;
  let usersCache: { items: UserItem[]; fetchedAt: number } | undefined;

  /**
   * The shared per-device loop: allowlist prune, send, Gone prune, transient
   * keep. Both sendToUser and sendToAll run it so the two can never drift.
   * Returns the tally plus which endpoints were pruned, so sendToAll can keep
   * its cached user items honest. The log lines here are the EXACT lines
   * sendToUser has always emitted per device (moved, not rewritten).
   *
   * It swallows per-DEVICE failures but can still reject: the allowlist prune
   * write sits outside the inner try, so a repo failure there propagates to
   * the caller, which is why sendToAll keeps a per-user catch.
   */
  async function sendToDevices(
    userId: string,
    subscriptions: PushSubscriptionRecord[],
    body: string,
    kind: string,
    options: { ttlSeconds: number } | undefined,
  ): Promise<{ sent: number; pruned: number; failed: number; prunedEndpoints: string[] }> {
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    const prunedEndpoints: string[] = [];

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
        prunedEndpoints.push(record.endpoint);
        log.warn(
          { userId, kind },
          'push: stored endpoint failed the host allowlist — pruned, not sent',
        );
        continue;
      }
      try {
        const outcome = await adapter!.sendToSubscription(
          toBrowserSubscription(record),
          body,
          options,
        );
        if (outcome.result === 'gone') {
          await users.removePushSubscription(userId, record.endpoint);
          pruned += 1;
          prunedEndpoints.push(record.endpoint);
        } else {
          sent += 1;
        }
      } catch (err) {
        // A transient failure (5xx/network) — NOT a prune signal. Log
        // correlated (the logger mixin stamps the correlationId) and move
        // on; one dead device must not fail the whole notification.
        failed += 1;
        log.warn(
          { userId, kind, err: (err as Error).message },
          'push: send to one device failed (transient) — kept subscription',
        );
      }
    }
    return { sent, pruned, failed, prunedEndpoints };
  }

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
      const { sent, pruned, failed } = await sendToDevices(
        userId,
        subscriptions,
        body,
        notification.kind,
        notification.ttlSeconds === undefined ? undefined : { ttlSeconds: notification.ttlSeconds },
      );

      log.info(
        { userId, kind: notification.kind, attempted: subscriptions.length, sent, pruned, failed },
        'push: sendToUser complete',
      );
      return { configured: true, attempted: subscriptions.length, sent, pruned, failed };
    },

    async sendToAll(notification) {
      if (adapter === undefined || !isPushConfigured(config)) {
        // Same known-state posture as sendToUser: WARN once for the whole
        // broadcast, never one line per user.
        log.warn(
          { kind: notification.kind },
          'push not configured (VAPID unset) - broadcast skipped (no-op)',
        );
        return { configured: false, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
      }

      if (usersCache === undefined || now() - usersCache.fetchedAt >= USERS_CACHE_TTL_MS) {
        try {
          usersCache = { items: await users.listAll(), fetchedAt: now() };
        } catch (err) {
          // A lookup failure must never break the caller (the send is
          // fire-and-forget off a webhook/ingest path): log and push to
          // nobody, exactly as the voice founder lookup does.
          log.error(
            { err, kind: notification.kind },
            'push: listing users failed - broadcast not sent',
          );
          return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
        }
      }

      // Serialize ONCE for the whole fan-out. Holds PII - never logged.
      const body = JSON.stringify(notification.payload);
      const options =
        notification.ttlSeconds === undefined ? undefined : { ttlSeconds: notification.ttlSeconds };
      let usersWithSubs = 0;
      let attempted = 0;
      let sent = 0;
      let pruned = 0;
      let failed = 0;
      for (const user of usersCache.items) {
        const subs = user.push_subscriptions ?? [];
        // Silent skip: subscription presence IS the recipient filter, so an
        // invited-but-never-subscribed user costs no I/O and no log noise.
        if (subs.length === 0) continue;
        usersWithSubs += 1;
        attempted += subs.length;
        try {
          const result = await sendToDevices(user.userId, subs, body, notification.kind, options);
          sent += result.sent;
          pruned += result.pruned;
          failed += result.failed;
          if (result.prunedEndpoints.length > 0) {
            // Keep the cached item honest so repeat sends within the TTL do
            // not re-attempt a known-dead endpoint.
            user.push_subscriptions = subs.filter(
              (s) => !result.prunedEndpoints.includes(s.endpoint),
            );
          }
        } catch (err) {
          // Per-user isolation (the voice founder-loop shape): one failing
          // user never aborts the fan-out. Reachable because the shared
          // loop's allowlist prune write is outside its per-device try.
          failed += subs.length;
          log.warn(
            { userId: user.userId, kind: notification.kind, err: (err as Error).message },
            'push: broadcast to one user failed - continuing',
          );
        }
      }

      log.info(
        { kind: notification.kind, users: usersWithSubs, attempted, sent, pruned, failed },
        'push: sendToAll complete',
      );
      return { configured: true, users: usersWithSubs, attempted, sent, pruned, failed };
    },
  };
}
