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
  /**
   * How OLD the served list may get before a failed refresh stops falling back
   * to it. Inside this bound a failed listAll is a blip and the cached list is
   * still worth serving; past it the list is a liability rather than a
   * fallback - it can hide a user whose only device was Gone-pruned and who
   * then re-subscribed, and it keeps delivering names and message text to an
   * offboarded user's device. 5x the TTL: long enough that every transient
   * Dynamo blip is covered, short enough that the staleness stays a stated
   * bound (D10 / section 5) rather than "for the whole outage".
   */
  const STALE_SERVE_MAX_MS = 5 * USERS_CACHE_TTL_MS;
  // `scannedAt` is the ATTEMPT-START stamp of the Scan that produced the
  // items - the write guard below compares it so an older Scan settling late
  // cannot overwrite a newer attempt's data with a fresher fetchedAt
  // (re-review R-3: overlapping attempts are legal when a Scan outlives the
  // 30s floor).
  let usersCache: { items: UserItem[]; fetchedAt: number; scannedAt: number } | undefined;
  /**
   * Floor between listAll ATTEMPTS (log-hygiene spec 6.1): one Scan attempt +
   * one ERROR/WARN per ~30s window PER INSTANCE (about six instances exist per
   * process), instead of one per inbound message. Stamped on every attempt,
   * immediately BEFORE it starts; a successful refresh naturally resets the
   * cadence, because the 60s TTL then decides when the next one is due.
   *
   * STAMPING BEFORE THE AWAIT IS WHY `refreshInFlight` EXISTS. The stamp fences
   * the calls that arrive while an attempt is STILL RUNNING, so on a cold
   * process a second sendToAll used to see no cache AND a millisecond-old
   * stamp, take the floored arm, find nothing servable, and DROP the
   * notification at debug - invisible in both deployed envs, where LOG_LEVEL is
   * info, and the window opens on every process start and every deploy, exactly
   * when a burst of queued webhooks lands. A floored caller now JOINS the
   * attempt already in flight instead of guessing: at most one Scan attempt
   * per 30s floor window PER INSTANCE, and a floored caller never drops while
   * THE ATTEMPT IT JOINED can still answer - a caller that joined attempt N
   * can still drop if N fails while a LATER attempt is in flight (it wakes to
   * an empty cache and does not re-join; accepted, the next send retries).
   * NOT "never a second Scan": a Scan that outlives the floor
   * legitimately overlaps its successor - the join slot is identity-guarded
   * so the LATEST attempt stays joinable, and the cache write is
   * ordered-by-attempt so an older Scan settling late cannot overwrite newer
   * data (see the guard at the assignment below).
   *
   * READ THE CATCH ARMS BELOW WITH THIS IN MIND: they still leave `fetchedAt`
   * untouched on failure, so the refresh IS retried and the age keeps counting
   * toward the stale bound - but the retry now waits out this floor rather than
   * riding the very next send.
   */
  const REFRESH_RETRY_FLOOR_MS = 30_000;
  let lastRefreshAttemptAt: number | undefined;
  let refreshInFlight: Promise<void> | undefined;

  /**
   * The shared per-device loop: allowlist prune, send, Gone prune, transient
   * keep. Both sendToUser and sendToAll run it so the two can never drift.
   * Returns the tally plus which endpoints were pruned, so sendToAll can keep
   * its cached user items honest. The log lines here are the EXACT lines
   * sendToUser has always emitted per device (moved, not rewritten).
   *
   * EVERY per-device fault is isolated - the send, the Gone prune write and
   * the allowlist prune write alike. One bad device is tallied and the loop
   * moves on, so this helper does not reject under any per-device fault: a
   * caller can never lose the devices already delivered or skip the ones
   * after the bad one.
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
        try {
          await users.removePushSubscription(userId, record.endpoint);
        } catch (err) {
          // The prune WRITE failed (the user row is gone, or DynamoDB
          // throttled). Book it as THIS device's failure and continue: a bad
          // repo write must never abort the rest of the user's devices,
          // discard the ones already delivered, or drop the endpoints already
          // pruned. Nothing was sent here, so the subscription stays and the
          // next send retries the prune.
          failed += 1;
          log.warn(
            { userId, kind, err },
            'push: pruning a non-allowlisted endpoint failed - kept, not sent',
          );
          continue;
        }
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
          try {
            await users.removePushSubscription(userId, record.endpoint);
          } catch (pruneErr) {
            // The SEND answered correctly (the device is definitively dead);
            // the fault is entirely ours. Its own line, so an operator chases
            // the repo write instead of the push vendor - inside the send try
            // this read as a transient SEND failure and sent them after FCM.
            // Counted the same way the allowlist prune write is: ONE device
            // failed. The subscription stays and the next send retries it.
            failed += 1;
            log.warn(
              { userId, kind, err: pruneErr },
              'push: pruning a Gone endpoint failed - kept, retried on the next send',
            );
            continue;
          }
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
        // Guarded BOTH ways (re-review R-4): optional chaining covers a
        // `throw null`, and the try covers a hostile `statusCode` ACCESSOR -
        // `?.` still invokes a getter, and the docblock above promises this
        // helper never rejects per device. The never-rejects invariant
        // outranks the diagnostic field.
        let pushStatusCode: number | undefined;
        try {
          const raw = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
          if (typeof raw === 'number') pushStatusCode = raw;
        } catch {
          pushStatusCode = undefined;
        }
        log.warn(
          {
            userId,
            kind,
            err,
            ...(pushStatusCode !== undefined && { pushStatusCode }),
          },
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
        const floored =
          lastRefreshAttemptAt !== undefined && now() - lastRefreshAttemptAt < REFRESH_RETRY_FLOOR_MS;
        if (!floored) {
          const attemptStartedAt = now();
          lastRefreshAttemptAt = attemptStartedAt;
          try {
            // The listAll CALL sits inside the try: the production repo cannot
            // throw synchronously (async fn), but this function's contract is
            // that a lookup failure NEVER escapes to the fire-and-forget
            // caller, and an injected/decorated repo must not be able to
            // reopen that structurally (adversarial review, phase 6).
            //
            // PUBLISH the attempt before awaiting it, so a floored caller has
            // something to join. The joinable copy neutralizes BOTH
            // settlements - it is not the error handler, this try/catch is -
            // so joining it can never reject into someone else's call. The
            // cleanup is IDENTITY-GUARDED: two attempts can be live at once
            // (the 30s floor is shorter than a slow Scan under throttle), and
            // an unguarded finally let the FIRST attempt's cleanup un-publish
            // its successor - a floored caller then found nothing to join and
            // dropped the broadcast, the exact window this join closes.
            const attempt = users.listAll();
            const published = attempt.then(() => undefined, () => undefined);
            refreshInFlight = published;
            void published.finally(() => {
              if (refreshInFlight === published) refreshInFlight = undefined;
            });
            const items = await attempt;
            // ORDERED-BY-ATTEMPT write (re-review R-3): only publish these
            // items when no LATER attempt has already written the cache - an
            // older Scan settling last would otherwise overwrite newer user
            // data under a fresher fetchedAt, hiding a just-added device for
            // up to an extra TTL.
            if (usersCache === undefined || usersCache.scannedAt <= attemptStartedAt) {
              usersCache = { items, fetchedAt: now(), scannedAt: attemptStartedAt };
            }
          } catch (err) {
            // A lookup failure must never break the caller (the send is
            // fire-and-forget off a webhook/ingest path): it is logged, never
            // thrown, exactly as the voice founder lookup does.
            if (usersCache === undefined) {
              // No list has ever been fetched, so there is nobody to send to:
              // log ERROR and drop the broadcast (spec 3.1).
              log.error(
                { err, kind: notification.kind },
                'push: listing users failed - broadcast not sent',
              );
              return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
            }
            const staleMs = now() - usersCache.fetchedAt;
            if (staleMs >= STALE_SERVE_MAX_MS) {
              // The cached list is past the bound, so it is no longer a
              // trustworthy recipient set: give up exactly as 3.1 says - ERROR
              // (a permanently broken Scan MUST reach the error-log alarm, per
              // this repo's 436c0388 precedent), zeroed result, never a throw.
              log.error(
                { err, kind: notification.kind, staleMs },
                'push: listing users failed and the cached list is too stale to serve - broadcast not sent',
              );
              return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
            }
            // A cached list exists and is still INSIDE the bound, so fan out to
            // it instead of dropping the notification. Deliberate, spec-amended
            // deviation from 3.1's original literal wording (see 3.1 / D10 /
            // section 5): D1 ("everyone with a subscription is notified") plus
            // the late-better-than-never posture make a slightly stale fan-out
            // strictly better than a silent drop on a transient Dynamo blip.
            // `fetchedAt` is left UNCHANGED, so the very next send retries the
            // refresh AND the age keeps counting toward the bound above.
            log.warn(
              { err, kind: notification.kind, staleMs },
              'push: refreshing the user list failed - fanning out to the cached list (stale)',
            );
          }
        } else {
          // FLOORED, which means one of two things. Either an attempt is STILL
          // IN FLIGHT - so join it and read the cache state it settles, rather
          // than guessing from a cache that has not been written yet: the
          // attempter's own continuation (the line that assigns usersCache) is
          // scheduled ahead of this join's, so the join wakes to the settled
          // state. Or the last attempt already FAILED, and its window-opening
          // line has already told the operator. Either way, what follows is the
          // same: serve the cache when it is inside the stale bound; otherwise
          // drop quietly (debug, not warn/error).
          if (refreshInFlight !== undefined) await refreshInFlight;
          if (usersCache === undefined || now() - usersCache.fetchedAt >= STALE_SERVE_MAX_MS) {
            log.debug(
              { kind: notification.kind },
              'push: refresh floored and no servable cache - broadcast dropped',
            );
            return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
          }
          log.debug(
            { kind: notification.kind },
            'push: refresh floored - fanning out to the cached list',
          );
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
          // Per-user isolation (the voice founder-loop shape, spec 3.1): one
          // failing user never aborts the fan-out. LAST-RESORT GUARD - no
          // known code path reaches it: the shared loop isolates every
          // per-device fault, prune writes included, and isAllowedPushEndpoint
          // swallows its own URL parse error, so sendToDevices is not expected
          // to reject at all. It is kept because 3.1 requires per-user
          // isolation and because an unguarded `await` added to the shared
          // loop later would otherwise take the whole broadcast down. Its
          // `failed += subs.length` tally is deliberately PESSIMISTIC: a
          // rejected sendToDevices returns no partial counts, so the loop
          // cannot know how many of this user's devices were already
          // delivered. Covered by the pushService.sendToAll test that makes
          // `record.endpoint` throw before the per-device try.
          failed += subs.length;
          log.warn(
            { userId: user.userId, kind: notification.kind, err },
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
