// users repo — the team (doc §5: PK userId, byEmail GSI, Google identity
// sub + email, role). M1.3: INVITE-FIRST access (an admin pre-creates a user;
// the login path can never mint a user), session lookups, and the user:invite
// / user:role ops scripts' runtime counterpart.
//
// Roles are 'admin' | 'va' (README deviations table 2026-06-12: the doc's
// founder_admin | va renamed by operator preference, semantics identical).
//
// LIFECYCLE (status): an invited record carries email + role + status
// 'invited' + created_at + session_epoch 1, but NO google_sub yet. The user's
// FIRST successful login activates the record (writes google_sub, flips status
// → 'active', stamps last_login_at). A login for an email with no record is
// REFUSED — there is no auto-provision (README deviations 2026-06-12: access
// is invite-gated, the domain allowlist is retained only as defense-in-depth).
//
// RACE SAFETY: userId is DETERMINISTIC from the normalized email
// (userIdForEmail), so a re-invite of the same email targets the SAME key and
// the attribute_not_exists(userId) conditional write makes invite idempotent
// (the second caller never overwrites the first). Two concurrent first logins
// for one invited user issue conditional google_sub writes — exactly one wins
// the activation; the loser is a harmless no-op (its google_sub equals the
// winner's). The byEmail GSI is a lookup, not a guard.
import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** Team roles (doc §5 founder_admin|va → admin|va, README deviations). */
export type UserRole = 'admin' | 'va';

export const USER_ROLES: readonly UserRole[] = ['admin', 'va'] as const;

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'va';
}

/**
 * User lifecycle status. 'invited' = pre-created by an admin, never signed in
 * (no google_sub). 'active' = has completed a first login (google_sub written).
 * Items created before this field existed have no status; activateOnLogin
 * still flips them to 'active' on their next login.
 */
export type UserStatus = 'invited' | 'active';

/**
 * A stored Web Push subscription (M1.4) — the browser PushSubscription shape
 * a device hands us via POST /api/push/subscriptions. Identified by its
 * endpoint URL (dedupe key). Multiple per user (one per device); capped at
 * MAX_PUSH_SUBSCRIPTIONS so a churning device can't grow the item unbounded.
 */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** When this device subscribed (ISO 8601) — the LRU key for the cap. */
  created_at: string;
}

/** Per-user device cap: oldest subscriptions are dropped past this (LRU by created_at). */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

export interface UserItem {
  userId: string;
  /** Normalized login email — the byEmail GSI key (normalizeEmail). */
  email: string;
  /**
   * Google OIDC subject (stable account id). Recorded on first login when an
   * invited record is activated — ABSENT on an 'invited' record.
   */
  google_sub?: string;
  role: UserRole;
  /** Lifecycle status (see UserStatus). */
  status?: UserStatus;
  /**
   * Web Push subscriptions, one per device (M1.4). ABSENT until the user
   * subscribes a device. Capped at MAX_PUSH_SUBSCRIPTIONS, deduped by
   * endpoint. NEVER returned by the admin GET /api/users list (device
   * endpoints are not admin-relevant and are not someone else's business).
   */
  push_subscriptions?: PushSubscriptionRecord[];
  /**
   * Server-side session kill switch: sealed into every session cookie at
   * login and re-checked by sessionMiddleware. Bumping it (logout, role
   * change) revokes ALL of the user's sessions everywhere. Invite writes 1;
   * items provisioned before the field existed read as 1 via sessionEpochOf().
   */
  session_epoch?: number;
  created_at: string;
  last_login_at?: string;
  [key: string]: unknown;
}

/** The user's current session epoch — legacy items without the attribute read as 1. */
export function sessionEpochOf(item: UserItem): number {
  return typeof item.session_epoch === 'number' ? item.session_epoch : 1;
}

/**
 * The ONE email normalization used everywhere an email is hashed to an id or
 * queried (invite, login lookup, the ops scripts mirror this exactly in
 * scripts/lib/userInviteCore.mjs / userRoleCore.mjs): lowercase + trim. Keep
 * this and the ops-script normalizeEmail() byte-for-byte identical — they
 * compute the same byEmail GSI key and the same deterministic userId.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deterministic userId for an email: `usr_<sha256(normalized email) hex/24>`.
 * This is what makes invite idempotent and activation race-safe (see module
 * header) — and it lets a caller re-read a winner's item by id without a GSI
 * read (GSIs are eventually consistent; the base-table Get is not).
 */
export function userIdForEmail(email: string): string {
  return `usr_${createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex').slice(0, 24)}`;
}

/** invite() result: created=true when THIS call minted the invited record. */
export interface InviteResult {
  created: boolean;
  user: UserItem;
}

export interface UsersRepo {
  /** Normalizes the input; byEmail GSI Query; undefined when unknown. */
  findByEmail(email: string): Promise<UserItem | undefined>;
  findById(userId: string): Promise<UserItem | undefined>;
  /**
   * Pre-create ("invite") a user: conditional put at the deterministic id
   * (attribute_not_exists(userId)). IDEMPOTENT — re-inviting an existing user
   * is a no-op that returns the existing record UNCHANGED (role/status/epoch
   * are never reset). Returns { created, user }.
   */
  invite(input: { email: string; role: UserRole }): Promise<InviteResult>;
  /**
   * Activate an invited user on their first login: write google_sub, flip
   * status → 'active', stamp last_login_at — in ONE update. The google_sub
   * write is conditional-safe so two concurrent first logins don't clobber.
   * Throws if the user does not exist (the caller must have found it first).
   */
  activateOnLogin(userId: string, googleSub: string, at?: string): Promise<void>;
  /** Stamp last_login_at (ISO 8601); throws if the user does not exist. */
  touchLastLogin(userId: string, at?: string): Promise<void>;
  /** Flip the role; throws if the user does not exist (ops script path). */
  setRole(userId: string, role: UserRole): Promise<void>;
  /**
   * +1 the session epoch and return the NEW value — revokes every session
   * sealed with the old epoch (effective within the middleware's 60s epoch
   * cache). Throws if the user does not exist.
   */
  bumpSessionEpoch(userId: string): Promise<number>;
  /**
   * List every user (M1.4 admin user-management). A SCAN — acceptable because
   * the users table is TINY and bounded (the team: a founder + a handful of
   * VAs). Returns full items; the route projects out secrets (google_sub,
   * push_subscriptions) before responding.
   */
  listAll(): Promise<UserItem[]>;
  /**
   * Add a Web Push subscription to a user (M1.4), deduped by endpoint and
   * capped at MAX_PUSH_SUBSCRIPTIONS (oldest dropped, LRU by created_at).
   * Read-modify-write under attribute_exists(userId); returns the new list.
   * Throws if the user does not exist.
   */
  addPushSubscription(userId: string, sub: PushSubscriptionRecord): Promise<PushSubscriptionRecord[]>;
  /**
   * Remove a Web Push subscription by endpoint (M1.4 — explicit unsubscribe
   * OR pushService pruning a Gone subscription). Idempotent: removing an
   * absent endpoint is a no-op. Returns the new list. Throws if the user does
   * not exist.
   */
  removePushSubscription(userId: string, endpoint: string): Promise<PushSubscriptionRecord[]>;
}

export function createUsersRepo(deps: RepoDeps = {}): UsersRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('users', deps.env);
  const log = deps.logger ?? defaultLogger;

  const repo: UsersRepo = {
    async findByEmail(email) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byEmail',
          KeyConditionExpression: 'email = :e',
          ExpressionAttributeValues: { ':e': normalizeEmail(email) },
        }),
      );
      // Deterministic userIds make duplicate emails impossible; [0] is THE user.
      return (Items as UserItem[] | undefined)?.[0];
    },

    async findById(userId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { userId } }));
      return Item as UserItem | undefined;
    },

    async invite({ email, role }) {
      const normalized = normalizeEmail(email);
      const item: UserItem = {
        userId: userIdForEmail(normalized),
        email: normalized,
        role,
        status: 'invited', // no google_sub yet — written on first login
        session_epoch: 1, // the kill switch starts at 1 (bumpSessionEpoch)
        created_at: new Date().toISOString(),
      };
      try {
        await doc.send(
          new PutCommand({
            TableName: table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(userId)',
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already invited (or active) — idempotent: return the existing
          // record UNCHANGED. Never reset role/status/epoch.
          const existing = await repo.findById(item.userId);
          if (!existing) {
            throw new Error(
              `invite(${item.userId}): conditional create failed but the user is not readable`,
            );
          }
          return { created: false, user: existing };
        }
        throw err;
      }
      // IDs + role only — emails stay out of steady-state logs (PII posture,
      // doc §9). The admin-facing invite AUDIT event (services layer) records
      // the email; that is an audit-relevant operator action.
      log.info({ userId: item.userId, role: item.role }, 'user invited');
      return { created: true, user: item };
    },

    async activateOnLogin(userId, googleSub, at = new Date().toISOString()) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          // One write: set google_sub (conditional-safe — only if absent, so
          // a racing second first-login is a harmless no-op rather than a
          // clobber), flip status → active, stamp last_login_at.
          UpdateExpression:
            'SET google_sub = if_not_exists(google_sub, :sub), #status = :active, last_login_at = :at',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':sub': googleSub, ':active': 'active', ':at': at },
        }),
      );
    },

    async touchLastLogin(userId, at = new Date().toISOString()) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression: 'SET last_login_at = :at',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':at': at },
        }),
      );
    },

    async setRole(userId, role) {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression: 'SET #role = :role',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':role': role },
        }),
      );
      log.info({ userId, role }, 'user role set');
    },

    async bumpSessionEpoch(userId) {
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          // if_not_exists(…, 1) + 1, NOT ADD: legacy items lacking the
          // attribute read as epoch 1 (sessionEpochOf), so their first bump
          // must land on 2 — ADD would mint 1 and revoke nothing.
          UpdateExpression: 'SET session_epoch = if_not_exists(session_epoch, :base) + :one',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':base': 1, ':one': 1 },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const epoch = (Attributes as Pick<UserItem, 'session_epoch'> | undefined)?.session_epoch;
      if (typeof epoch !== 'number') {
        throw new Error(`bumpSessionEpoch(${userId}): UPDATED_NEW returned no session_epoch`);
      }
      log.info({ userId, sessionEpoch: epoch }, 'session epoch bumped — all prior sessions revoked');
      return epoch;
    },

    async listAll() {
      // SCAN is acceptable here ONLY because the users table is tiny and
      // bounded (the team — a founder + a handful of VAs). Paginate anyway so
      // a future >1MB page (never expected at team size) is not silently
      // truncated.
      const items: UserItem[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(
          new ScanCommand({
            TableName: table,
            ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
          }),
        );
        items.push(...((page.Items as UserItem[] | undefined) ?? []));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      // The byEmail GSI's claim-style items don't exist for users (users have
      // no claim pattern) — every base-table item is a real user. Filter to
      // items that actually carry a role, defensively.
      return items.filter((u) => isUserRole(u.role));
    },

    async addPushSubscription(userId, sub) {
      // Read-modify-write: dedupe by endpoint, then cap at the device limit
      // (drop OLDEST by created_at — LRU). The condition keeps a deleted user
      // from getting a resurrected push list. Device-count contention on one
      // user is not a real concern (a person adds devices serially), so a
      // plain RMW is fine; no optimistic-version loop needed.
      const current = await repo.findById(userId);
      if (!current) throw new Error(`addPushSubscription: no user ${userId}`);
      const existing = current.push_subscriptions ?? [];
      // Dedupe: replace any prior record for the same endpoint (refreshes keys).
      const deduped = existing.filter((s) => s.endpoint !== sub.endpoint);
      deduped.push(sub);
      // Cap: keep the most-recent MAX_PUSH_SUBSCRIPTIONS by created_at.
      const capped = deduped
        .slice()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, MAX_PUSH_SUBSCRIPTIONS);
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression: 'SET push_subscriptions = :subs',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':subs': capped },
        }),
      );
      // IDs + count only — never the endpoint (a push-service URL with a token).
      log.info({ userId, subscriptionCount: capped.length }, 'push subscription added');
      return capped;
    },

    async removePushSubscription(userId, endpoint) {
      const current = await repo.findById(userId);
      if (!current) throw new Error(`removePushSubscription: no user ${userId}`);
      const existing = current.push_subscriptions ?? [];
      const remaining = existing.filter((s) => s.endpoint !== endpoint);
      // No-op when nothing changed (idempotent unsubscribe / prune).
      if (remaining.length !== existing.length) {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { userId },
            UpdateExpression: 'SET push_subscriptions = :subs',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':subs': remaining },
          }),
        );
        log.info({ userId, subscriptionCount: remaining.length }, 'push subscription removed');
      }
      return remaining;
    },
  };

  return repo;
}
