// Test session-cookie factory (M1.3). Mints REAL sealed session cookies with
// the dev placeholder secret loadConfig() resolves for non-production
// NODE_ENVs — exactly what harness-built apps verify against, so the /api
// auth gate is exercised for real (never bypassed) at one header per request.
//
// Since the session-epoch revocation hardening, EVERY authenticated request
// validates the cookie's sealed epoch against the users table (through the
// 60s cache) — so apps under test need a users repo that actually KNOWS the
// session user: seed makeFakeUsersRepo with testUserItem().
import { DEV_SESSION_SECRET_DEFAULT } from '../../src/lib/config.js';
import { seal, SESSION_COOKIE_NAME } from '../../src/lib/sessionCookie.js';
import { SESSION_TTL_MS, type SessionUser } from '../../src/middleware/auth.js';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  normalizeEmail,
  sessionEpochOf,
  userIdForEmail,
  type UserItem,
  type UsersRepo,
} from '../../src/repos/usersRepo.js';

export const TEST_SESSION_USER: SessionUser = {
  userId: 'usr_testva00000000000000000',
  email: 'test-va@housingchoice.org',
  role: 'va',
};

/**
 * An ADMIN session user — the first requireRole('admin') surfaces land in
 * M1.4 (admin user-management, the settings PUT), so the suites need an admin
 * cookie next to the existing 'va' one.
 */
export const TEST_ADMIN_USER: SessionUser = {
  userId: 'usr_testadmin000000000000000',
  email: 'test-admin@housingchoice.org',
  role: 'admin',
};

/** A users-table item for TEST_ADMIN_USER (active, epoch 1). */
export function adminUserItem(overrides: Partial<UserItem> = {}): UserItem {
  return {
    userId: TEST_ADMIN_USER.userId,
    email: TEST_ADMIN_USER.email,
    google_sub: 'test-google-sub-admin',
    role: 'admin',
    status: 'active',
    session_epoch: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A users-table item for TEST_SESSION_USER (epoch 1) — the standard seed. The
 * user is 'active' (invite-first: seeded users must have completed a login so
 * the api/webhook auth gates still authenticate them).
 */
export function testUserItem(overrides: Partial<UserItem> = {}): UserItem {
  return {
    userId: TEST_SESSION_USER.userId,
    email: TEST_SESSION_USER.email,
    google_sub: 'test-google-sub',
    role: TEST_SESSION_USER.role,
    status: 'active',
    session_epoch: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/** An 'invited' record (no google_sub yet) — the pre-login state. */
export function invitedUserItem(overrides: Partial<UserItem> = {}): UserItem {
  return {
    userId: TEST_SESSION_USER.userId,
    email: TEST_SESSION_USER.email,
    role: TEST_SESSION_USER.role,
    status: 'invited',
    session_epoch: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

export interface SessionCookieOptions {
  /** Defaults to the dev placeholder every non-production loadConfig() uses. */
  secret?: string;
  ttlMs?: number;
  /** Sealed session epoch; defaults to 1 (what provisioning writes). */
  epoch?: number;
  /** Clock override (epoch ms) — e.g. backdate iat to trigger the rolling refresh. */
  now?: number;
}

/** A `hc_session=<sealed token>` Cookie-header value for the given user. */
export function sessionCookieFor(
  user: Partial<SessionUser> = {},
  opts: SessionCookieOptions = {},
): string {
  const token = seal(
    { ...TEST_SESSION_USER, ...user, epoch: opts.epoch ?? 1 },
    {
      secret: opts.secret ?? DEV_SESSION_SECRET_DEFAULT,
      purpose: 'session',
      ttlMs: opts.ttlMs ?? SESSION_TTL_MS,
      ...(opts.now !== undefined && { now: opts.now }),
    },
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/** The shared authed Cookie header for the /api suites (a fresh 'va' session). */
export const TEST_SESSION_COOKIE = sessionCookieFor();

/** An admin Cookie header (the requireRole('admin') suites — M1.4). */
export const TEST_ADMIN_COOKIE = sessionCookieFor(TEST_ADMIN_USER);

export interface FakeUsersRepo {
  users: Map<string, UserItem>;
  /** userIds actually CREATED by invite (the winning conditional put), in order. */
  creates: string[];
  /** userIds activated by activateOnLogin (first-login flip), in order. */
  activations: string[];
  /** Every findById call, in order — asserts the epoch cache's read economy. */
  findByIdCalls: string[];
  /**
   * Recorded activateOnLogin calls — each entry holds the name argument as
   * passed (undefined when absent), for PII-forwarding assertions in Task 2 tests.
   */
  activateCalls: { userId: string; name: string | undefined }[];
  /**
   * Recorded touchLastLogin calls — each entry holds the name argument as
   * passed (undefined when absent).
   */
  touchCalls: { userId: string; name: string | undefined }[];
  repo: UsersRepo;
}

/** In-memory UsersRepo mirroring the real conditional-write semantics. */
export function makeFakeUsersRepo(seed: UserItem[] = []): FakeUsersRepo {
  const users = new Map<string, UserItem>(seed.map((u) => [u.userId, { ...u }]));
  const creates: string[] = [];
  const activations: string[] = [];
  const findByIdCalls: string[] = [];
  const activateCalls: { userId: string; name: string | undefined }[] = [];
  const touchCalls: { userId: string; name: string | undefined }[] = [];
  const repo: UsersRepo = {
    async findByEmail(email) {
      const e = normalizeEmail(email);
      return [...users.values()].find((u) => u.email === e);
    },
    async findById(userId) {
      findByIdCalls.push(userId);
      return users.get(userId);
    },
    async invite({ email, role }) {
      const normalized = normalizeEmail(email);
      const userId = userIdForEmail(normalized);
      const existing = users.get(userId);
      if (existing) return { created: false, user: existing }; // idempotent no-op
      const item: UserItem = {
        userId,
        email: normalized,
        role,
        status: 'invited',
        session_epoch: 1,
        created_at: new Date().toISOString(),
      };
      users.set(userId, { ...item });
      creates.push(userId);
      return { created: true, user: item };
    },
    async activateOnLogin(userId, googleSub, name, at = new Date().toISOString()) {
      const user = users.get(userId);
      if (!user) throw new Error(`activateOnLogin: no user ${userId}`);
      // if_not_exists(google_sub): a racing second activation never clobbers.
      if (user.google_sub === undefined) user.google_sub = googleSub;
      user.status = 'active';
      user.last_login_at = at;
      if (name !== undefined) user.name = name;
      activations.push(userId);
      activateCalls.push({ userId, name });
    },
    async touchLastLogin(userId, name, at = new Date().toISOString()) {
      const user = users.get(userId);
      if (!user) throw new Error(`touchLastLogin: no user ${userId}`);
      user.last_login_at = at;
      if (name !== undefined) user.name = name;
      touchCalls.push({ userId, name });
    },
    async setRole(userId, role) {
      const user = users.get(userId);
      if (!user) throw new Error(`setRole: no user ${userId}`);
      user.role = role;
    },
    async setRoleAndRevoke(userId, role) {
      // ONE write changes both (mirrors the real repo's atomic update, H1).
      const user = users.get(userId);
      if (!user) throw new Error(`setRoleAndRevoke: no user ${userId}`);
      user.role = role;
      user.session_epoch = sessionEpochOf(user) + 1;
      return user.session_epoch;
    },
    async bumpSessionEpoch(userId) {
      const user = users.get(userId);
      if (!user) throw new Error(`bumpSessionEpoch: no user ${userId}`);
      user.session_epoch = sessionEpochOf(user) + 1;
      return user.session_epoch;
    },
    async listAll() {
      return [...users.values()].map((u) => ({ ...u }));
    },
    async listByRole(role) {
      return [...users.values()].filter((u) => u.role === role).map((u) => ({ ...u }));
    },
    async addPushSubscription(userId, sub) {
      const user = users.get(userId);
      if (!user) throw new Error(`addPushSubscription: no user ${userId}`);
      const existing = user.push_subscriptions ?? [];
      const deduped = existing.filter((s) => s.endpoint !== sub.endpoint);
      deduped.push(sub);
      const capped = deduped
        .slice()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, MAX_PUSH_SUBSCRIPTIONS);
      user.push_subscriptions = capped;
      return capped;
    },
    async removePushSubscription(userId, endpoint) {
      const user = users.get(userId);
      if (!user) throw new Error(`removePushSubscription: no user ${userId}`);
      const remaining = (user.push_subscriptions ?? []).filter((s) => s.endpoint !== endpoint);
      user.push_subscriptions = remaining;
      return remaining;
    },
    // --- Voice Phase 1: cell verification + inbound-voice-line (mirrors real) --
    async startCellVerification(userId, cell, codeHash, expiresAt) {
      const user = users.get(userId);
      if (!user) throw new Error(`startCellVerification: no user ${userId}`);
      user.cell_pending = cell;
      user.cell_verify_code_hash = codeHash;
      user.cell_verify_expires_at = expiresAt;
      user.cell_verify_attempts = 0;
    },
    async confirmCellVerification(userId, codeHash, now) {
      const user = users.get(userId);
      if (!user) throw new Error(`confirmCellVerification: no user ${userId}`);
      const pending = user.cell_pending;
      const storedHash = user.cell_verify_code_hash;
      if (typeof pending !== 'string' || typeof storedHash !== 'string') {
        return { ok: false, reason: 'no_pending' };
      }
      if (typeof user.cell_verify_expires_at === 'string' && now > user.cell_verify_expires_at) {
        return { ok: false, reason: 'expired' };
      }
      const attempts =
        typeof user.cell_verify_attempts === 'number' ? user.cell_verify_attempts : 0;
      if (attempts >= 5) return { ok: false, reason: 'too_many_attempts' };
      if (codeHash !== storedHash) {
        user.cell_verify_attempts = attempts + 1;
        return { ok: false, reason: 'mismatch' };
      }
      user.cell = pending;
      user.cell_verified_at = now;
      delete user.cell_pending;
      delete user.cell_verify_code_hash;
      delete user.cell_verify_expires_at;
      delete user.cell_verify_attempts;
      return { ok: true, cell: pending, cell_verified_at: now };
    },
    async assignInboundVoiceLine(userId) {
      const target = users.get(userId);
      if (!target) throw new Error(`assignInboundVoiceLine: no user ${userId}`);
      for (const u of users.values()) {
        if (u.inbound_voice_line === true && u.userId !== userId) delete u.inbound_voice_line;
      }
      target.inbound_voice_line = true;
    },
    async clearInboundVoiceLine(userId) {
      const user = users.get(userId);
      if (!user) throw new Error(`clearInboundVoiceLine: no user ${userId}`);
      delete user.inbound_voice_line;
    },
    async getInboundVoiceLineHolder() {
      const holders = [...users.values()].filter((u) => u.inbound_voice_line === true);
      return holders.length > 0 ? { ...holders[0]! } : undefined;
    },
  };
  return { users, creates, activations, findByIdCalls, activateCalls, touchCalls, repo };
}
