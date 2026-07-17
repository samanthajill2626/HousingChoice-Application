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
import {
  createConversationsRepo,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createTourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { createToursRepo } from '../repos/toursRepo.js';
import { createMessagesRepo } from '../repos/messagesRepo.js';
import { createSendMessageService } from '../services/sendMessage.js';
import { runDueTourReminders, type RunDueTourRemindersDeps } from '../jobs/tourReminders.js';
import { createPlacementNudgesRepo } from '../repos/placementNudgesRepo.js';
import {
  createPlacementsRepo,
  isPlacementDeadlineType,
  type PlacementDeadlineType,
} from '../repos/placementsRepo.js';
import { createPlacementDeadlinesRepo } from '../repos/placementDeadlinesRepo.js';
import { createUnitsRepo } from '../repos/unitsRepo.js';
import { runDuePlacementNudges, type RunDuePlacementNudgesDeps } from '../jobs/placementNudges.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { RELAY_INTRO_JOB } from '../jobs/relayFanOut.js';
import { createExtractionRepo } from '../repos/extractionRepo.js';
import { createAuditRepo } from '../repos/auditRepo.js';
import { createExtractionDriver } from '../adapters/extraction.js';
import { appEvents } from '../lib/events.js';
import { runDueExtractions, type ExtractionJobDeps } from '../jobs/extraction.js';

/** Deps for POST /__dev/relay/replay-intros. The route LISTS open relay groups
 *  and ENQUEUES the real relay.intro job per well-formed one — so it needs only
 *  a read repo + an enqueue seam (no send/persist path of its own). */
export interface RelayReplayDeps {
  conversationsRepo: ConversationsRepo;
  /** Enqueue the REAL relay.intro job for one relay conversation. Defaults to
   *  enqueueImmediate(RELAY_INTRO_JOB, …) (relayProvisioning.ts's enqueue);
   *  injected in tests to spy or drive the job inline. */
  enqueueIntro: (relayConversationId: string) => Promise<void>;
}

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
  /** Poll deps for POST /__dev/extraction/tick - injected in tests (the world
   *  fakes); defaults to the worker's construction (worker.ts). */
  extractionTickDeps?: ExtractionJobDeps;
  /** Deps for POST /__dev/relay/replay-intros — injected in tests; defaults to
   *  the real conversations repo + relay.intro enqueue. */
  relayReplayDeps?: RelayReplayDeps;
}

/**
 * A relay group is REPLAYABLE iff it has a pool number AND a well-formed
 * participants roster - member OBJECTS carrying non-empty phones. Seed rosters
 * are now full ConversationParticipant objects (seed/cast.ts and seed/matrix.ts
 * both carry tenant+landlord phones), so this is a DEFENSIVE runtime guard: the
 * declared `participants` type is ConversationParticipant[], but a stray legacy
 * or hand-written row could still carry bare contactId strings or an empty
 * roster (no phone to intro), so it screens `unknown` entries out rather than
 * crashing the replay.
 */
function isReplayableRelayGroup(conv: ConversationItem): boolean {
  const pool = conv.pool_number;
  if (typeof pool !== 'string' || pool.length === 0) return false;
  const roster: unknown = conv.participants;
  return (
    Array.isArray(roster) &&
    roster.length > 0 &&
    roster.every(
      (p): boolean =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as { phone?: unknown }).phone === 'string' &&
        (p as { phone: string }).phone.length > 0,
    )
  );
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

  // POST /__dev/reseed[?profile=full] — wipe local tables (incl. outbox) and
  // re-seed. `profile` defaults to 'lean' (the byte-stable e2e/dev world);
  // `?profile=full` additionally seeds the extended cast + matrix + live items,
  // which the relay-group-view e2e needs for the live relay group
  // (`conv-live-relay-group`). Dev-only surface (triple-gated), additive.
  router.post('/__dev/reseed', async (req, res) => {
    const profile = req.query['profile'] === 'full' ? 'full' : 'lean';
    await resetLocalData({ config, logger: log, profile });
    // The users table was wiped + reseeded, so every cached epoch is now stale
    // (a prior sign-out may have bumped one). Drop them all, else a freshly-minted
    // post-reseed dev-login session is rejected (cookie epoch ≠ stale cached epoch).
    deps.sessionEpochCache?.clear();
    res.status(200).json({ ok: true, profile });
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
      messagesRepo: createMessagesRepo({ logger: log }),
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

  // POST /__dev/extraction/tick - the deterministic e2e seam for the worker's
  // 60s conversation-fact-extraction poll (worker.ts): one POST runs ONE
  // runDueExtractions pass instead of waiting for the wall-clock setInterval.
  // Same triple-gate/hermetic-LOCAL-only construction as the tick seams above.
  //
  // The tick clock is pushed to `now + debounce + 1s` so a JUST-scheduled due
  // item (an inbound text posted by the test moments earlier) is already past
  // its sliding dueAt - the test need NOT wait out the real debounce window.
  //
  // SINGLE-INSTANCE SEAM: because this tick runs IN THE APP PROCESS, apply.ts's
  // `suggestion.updated` emit DOES reach app SSE clients here (unlike the worker
  // poll). That is exactly why the dashboard's live v1 path is dev-tick +
  // accept/dismiss; a worker-poller-driven change surfaces only on next fetch.
  let extractionTickDeps = deps.extractionTickDeps;
  const extractionDeps = (): ExtractionJobDeps => {
    // Built lazily on the first tick - mirrors worker.ts's extraction deps
    // construction exactly (driver selected from config; the same repo instance
    // backs both the job and its applyDeps.extraction).
    if (extractionTickDeps === undefined) {
      const extractionRepo = createExtractionRepo({ logger: log });
      const contactsRepo = createContactsRepo({ logger: log });
      extractionTickDeps = {
        repo: extractionRepo,
        conversations: createConversationsRepo({ logger: log }),
        messages: createMessagesRepo({ logger: log }),
        contacts: contactsRepo,
        driver: createExtractionDriver({
          driver: config.extractionDriver,
          model: config.aiExtractionModel,
          ...(config.anthropicApiKey !== undefined && { apiKey: config.anthropicApiKey }),
          ...(config.anthropicApiBaseUrl !== undefined && { apiBaseUrl: config.anthropicApiBaseUrl }),
        }),
        applyDeps: {
          contacts: contactsRepo,
          extraction: extractionRepo,
          audit: createAuditRepo({ logger: log }),
          events: appEvents,
          logger: log,
          now: () => new Date().toISOString(),
        },
        config,
        logger: log,
      };
    }
    return extractionTickDeps;
  };
  router.post('/__dev/extraction/tick', json(), async (_req, res) => {
    // tests need not wait out the debounce - jump the clock past a just-slid dueAt.
    const nowIso = new Date(Date.now() + config.aiExtractionDebounceMs + 1000).toISOString();
    const { processed, failed } = await runDueExtractions(nowIso, extractionDeps());
    log.info({ now: nowIso, processed, failed }, 'dev extraction tick ran');
    res.status(200).json({ processed, failed });
  });

  // POST /__dev/placements/:placementId/deadline-fixture — hermetic e2e-only seam
  // to shape a placement's DEADLINE MODEL directly (placement-deadline-model),
  // bypassing the product gates a test cannot otherwise satisfy:
  //   - the manual /api/placements/:id/deadline route is follow_up-ONLY (the system
  //     clocks rta_window/voucher_expiration are off-limits there), and
  //   - rta_window is armed by the transition service off the WALL clock at +48h,
  //     which an e2e cannot advance.
  // Two independent knobs (either/both):
  //   { deadline: { type, at } } → arm ANY deadline type at an arbitrary instant
  //        (e.g. force rta_window overdue: type:'rta_window', at:<past ISO>).
  //   { stageEnteredAt: <ISO> }  → backdate stage_entered_at so the DERIVED stuck
  //        flag (time-in-stage vs STAGE_STUCK_THRESHOLDS) fires without waiting days.
  // Same triple-gate/hermetic-LOCAL-only construction as the tick seams above (the
  // dev router only mounts behind lib/devRoutes.ts, structurally absent in every
  // deployed env); json() is scoped to this route only.
  let fixtureRepos: { placements: ReturnType<typeof createPlacementsRepo>; deadlines: ReturnType<typeof createPlacementDeadlinesRepo> } | undefined;
  const deadlineFixtureRepos = () => {
    fixtureRepos ??= {
      placements: createPlacementsRepo({ logger: log }),
      deadlines: createPlacementDeadlinesRepo({ logger: log }),
    };
    return fixtureRepos;
  };
  router.post('/__dev/placements/:placementId/deadline-fixture', json(), async (req, res) => {
    const placementId = String(req.params['placementId'] ?? '');
    const body = (req.body ?? {}) as { deadline?: unknown; stageEnteredAt?: unknown };

    // Validate the (optional) deadline arm — type must be a live PlacementDeadlineType
    // and `at` a parseable ISO 8601 instant (NORMALIZED like the tick seams).
    let armType: PlacementDeadlineType | undefined;
    let armAt: string | undefined;
    if (body.deadline !== undefined) {
      const d = body.deadline as { type?: unknown; at?: unknown };
      if (!isPlacementDeadlineType(d.type) || typeof d.at !== 'string' || Number.isNaN(Date.parse(d.at))) {
        res.status(400).json({ error: 'deadline must be { type: PlacementDeadlineType, at: ISO 8601 }' });
        return;
      }
      armType = d.type;
      armAt = new Date(d.at).toISOString();
    }
    // Validate the (optional) stage_entered_at backdate.
    let stageEnteredAt: string | undefined;
    if (body.stageEnteredAt !== undefined) {
      if (typeof body.stageEnteredAt !== 'string' || Number.isNaN(Date.parse(body.stageEnteredAt))) {
        res.status(400).json({ error: 'stageEnteredAt must be a valid ISO 8601 datetime' });
        return;
      }
      stageEnteredAt = new Date(body.stageEnteredAt).toISOString();
    }

    const { placements, deadlines } = deadlineFixtureRepos();
    const placement = await placements.getById(placementId);
    if (!placement) {
      res.status(404).json({ error: 'placement_not_found' });
      return;
    }
    if (armType !== undefined && armAt !== undefined) {
      await deadlines.arm(placementId, armType, armAt);
    }
    if (stageEnteredAt !== undefined) {
      await placements.update(placementId, { stage_entered_at: stageEnteredAt });
    }
    log.info(
      { placementId, deadlineType: armType ?? null, backdatedStage: stageEnteredAt !== undefined },
      'dev deadline-fixture applied',
    );
    res.status(200).json({ ok: true });
  });

  // POST /__dev/relay/replay-intros — re-fire the REAL relay.intro job for every
  // OPEN relay_group conversation that has a pool number AND a well-formed
  // participants roster. This materializes the seeded live relay group
  // (conv-live-relay-group) in the fake-phones UI at startup: the intro legs flow
  // FROM the pool number through the real fan-out adapter, and the fake infers
  // the group from that traffic (pure dynamic inference — no static mirror). The
  // dev.mjs boot POSTs this once under `--mock --seeded` (NOT wired into
  // /__dev/reseed — that keeps the e2e outbox byte-stable).
  //
  // The replay enqueues the intro with persist:false (LEGS-ONLY): a REAL
  // provisioning intro persists a system-announcement row in the thread
  // (services/relayAnnouncements.ts), but the replay sends only the per-member
  // legs — putJobExecutionMarker is its only write (an idempotency marker, not
  // a message), so the seeded DB stays byte-stable. A repeat POST re-fires the
  // intros (more fake legs) — acceptable for a dev tool, and it never
  // duplicates anything in the DB. Cast/matrix seeds' bare-id or
  // empty rosters, and (via the 'open' query) closed groups, are skipped
  // gracefully and counted. Same triple-gate/hermetic-LOCAL-only construction as
  // the tick seams above (the dev router only mounts behind lib/devRoutes.ts).
  let replayDeps = deps.relayReplayDeps;
  const relayReplayDeps = (): RelayReplayDeps => {
    replayDeps ??= {
      conversationsRepo: createConversationsRepo({ logger: log }),
      enqueueIntro: async (relayConversationId) => {
        // persist:false — the replay is a fake-phones materialization tool; a
        // real provisioning intro persists a thread row, but a per-boot replay
        // must never grow the seeded threads (byte-stable seeded DB).
        await enqueueImmediate(RELAY_INTRO_JOB, { relayConversationId, persist: false });
      },
    };
    return replayDeps;
  };
  router.post('/__dev/relay/replay-intros', async (_req, res) => {
    const { conversationsRepo, enqueueIntro } = relayReplayDeps();
    const { items } = await conversationsRepo.listRelayGroups('open');
    let replayed = 0;
    let skipped = 0;
    for (const conv of items) {
      if (isReplayableRelayGroup(conv)) {
        await enqueueIntro(conv.conversationId);
        replayed += 1;
      } else {
        skipped += 1;
      }
    }
    log.info({ replayed, skipped }, 'dev relay intro-replay ran');
    res.status(200).json({ replayed, skipped });
  });

  return router;
}
