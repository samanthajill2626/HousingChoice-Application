// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Exposes a liveness probe and a dev-login
// that mints a REAL session for a seeded user, mirroring the OAuth callback.
// Also exposes the recorded-message outbox, reseed, and a deterministic
// tour-reminder tick for e2e testing.
import { Router, json } from 'express';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig, tableName, type AppConfig } from '../lib/config.js';
import { createDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { sealSession, sessionCookieOptions, type SessionEpochCache } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import {
  createUsersRepo,
  normalizeEmail,
  sessionEpochOf,
  type UserRole,
  type UsersRepo,
} from '../repos/usersRepo.js';
import { OUTBOX_TABLE_BASE, type OutboxRecord } from '../adapters/recordingMessaging.js';
import { resetLocalData } from '../lib/devReset.js';
import { createMessagingAdapter } from '../adapters/messaging.js';
import { createContactsRepo } from '../repos/contactsRepo.js';
import { createConversationsRepo } from '../repos/conversationsRepo.js';
import { createTourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { createToursRepo } from '../repos/toursRepo.js';
import { createSendMessageService } from '../services/sendMessage.js';
import { runDueTourReminders, type RunDueTourRemindersDeps } from '../jobs/tourReminders.js';
import { createPlacementNudgesRepo } from '../repos/placementNudgesRepo.js';
import { createPlacementsRepo } from '../repos/placementsRepo.js';
import { createUnitsRepo } from '../repos/unitsRepo.js';
import { runDuePlacementNudges, type RunDuePlacementNudgesDeps } from '../jobs/placementNudges.js';

export interface DevRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  usersRepo?: UsersRepo;
  doc?: DynamoDBDocumentClient;
  /** The app's shared session-epoch cache, so /__dev/reseed can clear it after
   *  wiping + reseeding the users table (a stale cached epoch — e.g. one bumped by
   *  a prior sign-out — would otherwise reject a freshly-minted post-reseed session). */
  sessionEpochCache?: SessionEpochCache;
  /** Poll deps for POST /__dev/tour-reminders/tick — injected in tests (the
   *  world fakes); defaults to the worker's construction (worker.ts). */
  tourReminderDeps?: RunDueTourRemindersDeps;
  /** Poll deps for POST /__dev/placement-nudges/tick — injected in tests (the
   *  world fakes); defaults to the worker's construction (worker.ts). */
  placementNudgeDeps?: RunDuePlacementNudgesDeps;
}

// Role assigned when dev-login auto-provisions a missing user. The seed
// personas (app/src/lib/seedData.ts) keep their roles so seeded and unseeded
// runs behave identically; every other email defaults to admin.
const DEV_LOGIN_PERSONA_ROLES: Record<string, UserRole> = {
  'founder@example.com': 'admin',
  'va@example.com': 'va',
};

function devLoginRoleFor(email: string): UserRole {
  return DEV_LOGIN_PERSONA_ROLES[normalizeEmail(email)] ?? 'admin';
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const doc = deps.doc ?? createDocumentClient({ config });
  const router = Router();

  // GET /__dev/ping — confirms the dev endpoints are active (stack-identity
  // probe) AND surfaces the hermetic-stack config flags the e2e preflight
  // (e2e/support/preflight.ts) asserts on. This is what catches a STALE or
  // hand-started stack being silently reused via Playwright's
  // reuseExistingServer: an app booted WITHOUT MESSAGING_RECORD_OUTBOX=1 has no
  // outbox-recording wrapper, so every send skips the dev-outbox and outbox.spec
  // fails with a baffling `Received: 0`. Flags only — booleans/enum/prefix,
  // never secrets or PII.
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({
      dev: true,
      recordOutbox: config.recordOutbox,
      messagingDriver: config.messagingDriver,
      smsSendingEnabled: config.smsSendingEnabled,
      tablePrefix: config.tablePrefix,
      // Launch commit (set by scripts/e2e-session.mjs) — the e2e preflight compares
      // it to the checkout to catch a stale reused backend. null when unstamped.
      appCommit: process.env['E2E_APP_COMMIT'] ?? null,
    });
  });

  // POST /auth/dev-login — mint a session for a dev user without Google.
  // Mirrors the OAuth callback's session minting exactly (same seal + cookie
  // options), so the resulting session is indistinguishable from a real login.
  // json() is scoped to this route only — no global body-parsing side-effects.
  //
  // Auto-provisions a missing user so dev-login works on an UNSEEDED DB
  // (`npm run dev -- --mock --local` without `--seeded` starts with an empty
  // users table). This deliberately relaxes the repo's invite-first invariant
  // ("login never mints a user") — but ONLY in this router, which is already a
  // hard-gated, non-prod, OAuth-bypassing dev seam (config.ts fails fast if the
  // flag is ever set in production). The real OAuth callback is untouched and
  // stays invite-first.
  router.post('/auth/dev-login', json(), async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' && body.email.trim() ? body.email : 'va@example.com';
    let user = await users.findByEmail(email);
    if (!user) {
      // Known seed personas keep their roles (va@example.com → va, the default
      // dev-login identity); any other deliberately-typed email defaults to
      // admin for full dashboard visibility.
      ({ user } = await users.invite({ email, role: devLoginRoleFor(email) }));
      log.info({ email: user.email, role: user.role }, 'dev-login auto-provisioned a user');
    }
    res.cookie(
      SESSION_COOKIE_NAME,
      sealSession({ userId: user.userId, email: user.email, role: user.role }, config, {
        epoch: sessionEpochOf(user),
      }),
      sessionCookieOptions(config),
    );
    log.info({ email: user.email, role: user.role }, 'dev-login minted a session');
    res.status(200).json({ userId: user.userId, email: user.email, role: user.role });
  });

  // DEPRECATED proof-of-send log — outbound-only. New tests should assert against
  // the fake-twilio thread store (GET /control/threads on the fake-twilio service),
  // which captures both directions + delivery status. Retained only so the three
  // pre-existing green specs don't churn; do not extend.
  // TODO(remove-dev-outbox-proof-of-send): migrate those 3 specs, then delete this + the driver.
  // GET /__dev/outbox?to=&since= — recorded outbound messages (newest last).
  router.get('/__dev/outbox', async (req, res) => {
    const table = tableName(OUTBOX_TABLE_BASE);
    let items: OutboxRecord[] = [];
    try {
      const out = await doc.send(new ScanCommand({ TableName: table }));
      items = (out.Items ?? []) as OutboxRecord[];
    } catch {
      items = []; // table not created yet (nothing sent) — empty outbox
    }
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : undefined;
    const since = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
    if (to) items = items.filter((m) => m.to === to);
    if (since) items = items.filter((m) => m.createdAt >= since);
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    res.status(200).json({ messages: items });
  });

  // POST /__dev/reseed — wipe local tables (incl. outbox) and re-seed.
  router.post('/__dev/reseed', async (_req, res) => {
    await resetLocalData({ config, logger: log });
    // The users table was wiped + reseeded, so every cached epoch is now stale
    // (a prior sign-out may have bumped one). Drop them all, else a freshly-minted
    // post-reseed dev-login session is rejected (cookie epoch ≠ stale cached epoch).
    deps.sessionEpochCache?.clear();
    res.status(200).json({ ok: true });
  });

  // POST /__dev/tour-reminders/tick { now? } — the deterministic e2e seam for
  // the worker's 60s tour-reminder poll (worker.ts): one POST runs ONE
  // runDueTourReminders(now) pass instead of waiting for the wall-clock
  // setInterval. Hermetic-LOCAL-only: the dev router only loads behind the
  // triple gate (lib/devRoutes.ts), so this is structurally absent in every
  // deployed env. json() is scoped to this route only (mirrors dev-login).
  //
  // `now` (optional) must be a parseable ISO 8601 datetime; it is NORMALIZED
  // via new Date(x).toISOString() because the reminder ladder compares ISO
  // strings LEXICOGRAPHICALLY — '…00Z' vs '…00.000Z' inputs must collapse to
  // the one canonical full-milliseconds form. Defaults to the wall clock.
  let tickDeps = deps.tourReminderDeps;
  const tourReminderDeps = (): RunDueTourRemindersDeps => {
    // Built lazily on the first tick — mirrors worker.ts's tourReminderDeps
    // construction exactly (createMessagingAdapter honors
    // MESSAGING_RECORD_OUTBOX, so hermetic-e2e sends stay outbox-visible).
    tickDeps ??= {
      tourRemindersRepo: createTourRemindersRepo({ logger: log }),
      toursRepo: createToursRepo({ logger: log }),
      contactsRepo: createContactsRepo({ logger: log }),
      conversationsRepo: createConversationsRepo({ logger: log }),
      sendMessageService: createSendMessageService({ config, logger: log }),
      adapter: createMessagingAdapter({ config, logger: log }),
      logger: log,
    };
    return tickDeps;
  };
  router.post('/__dev/tour-reminders/tick', json(), async (req, res) => {
    const body = (req.body ?? {}) as { now?: unknown };
    let nowIso = new Date().toISOString();
    if (body.now !== undefined) {
      if (typeof body.now !== 'string' || !Number.isFinite(Date.parse(body.now))) {
        res.status(400).json({ error: 'now must be a valid ISO 8601 datetime' });
        return;
      }
      nowIso = new Date(body.now).toISOString();
    }
    await runDueTourReminders(nowIso, tourReminderDeps());
    log.info({ now: nowIso }, 'dev tour-reminder tick ran');
    res.status(200).json({ ok: true, now: nowIso });
  });

  // POST /__dev/placement-nudges/tick { now? } — the deterministic e2e seam for
  // the worker's 60s placement-nudge poll (worker.ts): one POST runs ONE
  // runDuePlacementNudges(now) pass instead of waiting for the wall-clock
  // setInterval. Same triple-gate/hermetic-LOCAL-only construction as the
  // tour-reminder tick above; json() is scoped to this route only.
  //
  // `now` (optional) must be a parseable ISO 8601 datetime; it is NORMALIZED
  // via new Date(x).toISOString() because the nudge ladder compares ISO strings
  // LEXICOGRAPHICALLY — '…00Z' vs '…00.000Z' inputs must collapse to the one
  // canonical full-milliseconds form. Defaults to the wall clock.
  let nudgeTickDeps = deps.placementNudgeDeps;
  const placementNudgeDeps = (): RunDuePlacementNudgesDeps => {
    // Built lazily on the first tick — mirrors worker.ts's placementNudgeDeps
    // construction exactly (createMessagingAdapter honors MESSAGING_RECORD_OUTBOX
    // via the send service, so hermetic-e2e sends stay outbox-visible).
    nudgeTickDeps ??= {
      placementNudgesRepo: createPlacementNudgesRepo({ logger: log }),
      placementsRepo: createPlacementsRepo({ logger: log }),
      contactsRepo: createContactsRepo({ logger: log }),
      unitsRepo: createUnitsRepo({ logger: log }),
      conversationsRepo: createConversationsRepo({ logger: log }),
      sendMessageService: createSendMessageService({ config, logger: log }),
      logger: log,
    };
    return nudgeTickDeps;
  };
  router.post('/__dev/placement-nudges/tick', json(), async (req, res) => {
    const body = (req.body ?? {}) as { now?: unknown };
    let nowIso = new Date().toISOString();
    if (body.now !== undefined) {
      if (typeof body.now !== 'string' || !Number.isFinite(Date.parse(body.now))) {
        res.status(400).json({ error: 'now must be a valid ISO 8601 datetime' });
        return;
      }
      nowIso = new Date(body.now).toISOString();
    }
    await runDuePlacementNudges(nowIso, placementNudgeDeps());
    log.info({ now: nowIso }, 'dev placement-nudge tick ran');
    res.status(200).json({ ok: true, now: nowIso });
  });

  return router;
}
