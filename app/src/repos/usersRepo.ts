// users repo — the team (doc §5: PK userId, byEmail GSI, Google identity
// sub + email, role). M1.3: INVITE-FIRST access (an admin pre-creates a user;
// the login path can never mint a user), session lookups, and the user:invite
// / user:role ops scripts' runtime counterpart.
//
// Roles are 'admin' | 'va' (renamed from the doc's role names by operator
// preference, semantics identical — see the README deviations table 2026-06-12).
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
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { CELL_VERIFY_MAX_ATTEMPTS } from '../lib/cellVerification.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** Team roles — 'admin' | 'va' (renamed from the doc's role names; README deviations). */
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
  /**
   * Freeform Google profile display name. Trimmed here before write; length-capped
   * by the auth adapter at capture. Absent until a login carries the name claim.
   * Never lowercased; never logged.
   */
  name?: string;
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
  /**
   * Voice Phase 1 (spec §4). The user's OWN phone (E.164) — their outbound
   * masked-call bridge leg. NEVER dialed unless `cell_verified_at` is set
   * (an unverified cell could silently bridge a stranger into a call). Stored
   * as data (fine) but NEVER logged (PII, spec §9).
   */
  cell?: string;
  /** Voice Phase 1: ISO 8601 stamped when `cell` passed verification (§7). Unverified = never dialed. */
  cell_verified_at?: string;
  /**
   * Voice Phase 1 (spec §6): the single "Inbound voice line" designation. The
   * holder is now stored as ONE authoritative pointer (the HOLDER_POINTER_KEY
   * sentinel row) and this boolean is DERIVED in the views for the dashboard
   * mirror — the repo NEVER writes it. That holder's verified `cell` is what
   * inbound calls ring (there is no env-var fallback). Kept on the type only so
   * the derived view JSON has a home.
   */
  inbound_voice_line?: boolean;
  /**
   * Voice Phase 1 (spec §7) pending-verification storage — the OTP flow lives
   * on the user item (no new table). `cell_pending` is the not-yet-trusted
   * candidate cell; `cell_verify_code_hash` is sha256(code) (NEVER plaintext);
   * `cell_verify_expires_at` is the TTL deadline (ISO 8601); `cell_verify_attempts`
   * counts confirm tries for lockout. All are cleared on a successful confirm.
   */
  cell_pending?: string;
  cell_verify_code_hash?: string;
  cell_verify_expires_at?: string;
  cell_verify_attempts?: number;
  created_at: string;
  last_login_at?: string;
  [key: string]: unknown;
}

/** The user's current session epoch — legacy items without the attribute read as 1. */
export function sessionEpochOf(item: UserItem): number {
  return typeof item.session_epoch === 'number' ? item.session_epoch : 1;
}

/**
 * Canonical display-name resolver: name (trimmed, if non-blank) → email → userId.
 * Use this everywhere a human-readable label is needed — never inline the fallback chain.
 * name is freeform (never normalized/lowercased). NEVER pass the result to log.*  (PII).
 * email is optional in the input shape so callers can pass partial records.
 */
export function displayNameOf(user: {
  name?: string;
  email?: string;
  userId: string;
}): string {
  return (typeof user.name === 'string' && user.name.trim().length > 0 ? user.name.trim() : '') ||
    (user.email ?? '') ||
    user.userId;
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

/**
 * confirmCellVerification() result (Voice Phase 1, spec §7). On success the
 * candidate cell is promoted (`cell` = the now-verified number, stamped
 * `cell_verified_at`). On failure a machine-readable `reason` tells the route
 * which 4xx/message to surface (never leaks the code or the number).
 */
export type ConfirmResult =
  | { ok: true; cell: string; cell_verified_at: string }
  | { ok: false; reason: 'no_pending' | 'expired' | 'mismatch' | 'too_many_attempts' };

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
   * Hard-delete a user row (DeleteCommand). IDEMPOTENT: deleting an absent
   * userId is a no-op. Because userId is deterministic from the email, the key
   * is freed for a clean re-invite of the same email afterward. The CALLER
   * enforces the self / last-admin / voice-line-holder guards BEFORE calling
   * this -- the repo just deletes.
   */
  remove(userId: string): Promise<void>;
  /**
   * Re-put a full user row (unconditional PutCommand). Used ONLY by the DELETE
   * route's verify-after-write-and-rollback: when a removal turns out to have
   * emptied the admin set, the just-deleted `target` item is restored exactly.
   * Unconditional (no attribute_not_exists) so it overwrites/re-creates.
   */
  restore(item: UserItem): Promise<void>;
  /**
   * Activate an invited user on their first login: write google_sub, flip
   * status → 'active', stamp last_login_at — in ONE update. The google_sub
   * write is conditional-safe so two concurrent first logins don't clobber.
   * When `name` is a non-empty trimmed string, also SETs `name` (present-only:
   * a missing/blank claim never clobbers a previously stored name).
   * Throws if the user does not exist (the caller must have found it first).
   */
  activateOnLogin(userId: string, googleSub: string, name?: string, at?: string): Promise<void>;
  /**
   * Stamp last_login_at (ISO 8601); throws if the user does not exist.
   * When `name` is a non-empty trimmed string, also SETs `name` (present-only).
   */
  touchLastLogin(userId: string, name?: string, at?: string): Promise<void>;
  /** Flip the role; throws if the user does not exist (ops script path). */
  setRole(userId: string, role: UserRole): Promise<void>;
  /**
   * Flip the role AND bump session_epoch in ONE conditional update (M1.4 H1):
   * a role change and the session revocation that must accompany it can never
   * partially apply (role changed but sessions not revoked). Mirrors the ops
   * script's combined update (scripts/lib/userRoleCore.mjs buildRoleUpdate)
   * byte-for-byte. Returns the NEW session epoch. Throws if the user does not
   * exist. Use this from the in-app PATCH role route instead of a separate
   * setRole + bumpSessionEpoch pair.
   */
  setRoleAndRevoke(userId: string, role: UserRole): Promise<number>;
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
   * List users with a given role (M1.9b call-triage: resolve "the founder" =
   * the admin user(s) to push the pre-ring / missed-call notifications to).
   * Built on listAll() + an in-memory filter — the users table is tiny and
   * bounded, so this stays within the existing scan economy (no new GSI).
   */
  listByRole(role: UserRole): Promise<UserItem[]>;
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

  // --- Voice Phase 1: per-user cell verification (spec §7) ------------------
  /**
   * Begin verifying a candidate cell: SET the pending fields (`cell_pending`,
   * `cell_verify_code_hash`, `cell_verify_expires_at`) and RESET
   * `cell_verify_attempts` to 0. Deliberately does NOT touch `cell`/
   * `cell_verified_at` — the cell is not trusted until confirmCellVerification
   * matches the code. Throws if the user does not exist. Never logs the code
   * (it is passed pre-hashed) or the number (PII, §9).
   */
  startCellVerification(
    userId: string,
    cell: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<void>;
  /**
   * Confirm a pending cell against a submitted code hash (spec §7). Loads the
   * user and, in order: no pending code → `no_pending`; past
   * `cell_verify_expires_at` → `expired`; attempts already at the cap →
   * `too_many_attempts`; hash mismatch → increment attempts, return `mismatch`;
   * on match → promote (`cell` = `cell_pending`, `cell_verified_at` = now),
   * REMOVE the 4 pending fields, return { ok, cell, cell_verified_at }. A
   * read-modify-write (per-user, low-frequency op). `now` is ISO 8601.
   */
  confirmCellVerification(userId: string, codeHash: string, now: string): Promise<ConfirmResult>;

  // --- Voice Phase 1: single inbound-voice-line holder (spec §6) ------------
  /**
   * Assign the single inbound-voice-line holder to `userId`: one unconditional
   * write to the authoritative sentinel pointer (last-writer-wins). Because the
   * holder is ONE field, at most one holder ever exists — two concurrent assigns
   * can't both win (the single-holder invariant is structural, not enforced by a
   * scan). Does NOT enforce the verified-cell precondition — the CALLER (Phase 2
   * route) must ensure the target has a verified cell (it returns 409 otherwise)
   * before assigning.
   */
  assignInboundVoiceLine(userId: string): Promise<void>;
  /**
   * Unassign: REMOVE the pointer ONLY IF `userId` is the current holder
   * (conditional) — clearing a non-holder is a no-op, so it never clobbers a
   * concurrent reassignment.
   */
  clearInboundVoiceLine(userId: string): Promise<void>;
  /**
   * The single user the pointer designates, or undefined when none is set (or
   * the pointer dangles at a deleted user). Reads the pointer, then findById —
   * no scan, no invariant-violation branch (one field ⇒ one holder).
   */
  getInboundVoiceLineHolder(): Promise<UserItem | undefined>;
}

/**
 * Voice Phase 1 (spec §6): the inbound-voice-line holder is stored as ONE
 * authoritative pointer — a sentinel singleton row in the users table keyed by
 * this reserved id. Real user ids are `usr_<hash>` (userIdForEmail), so this
 * sentinel can never collide with a user. The pointer item is
 * `{ userId: HOLDER_POINTER_KEY, holder_user_id?: string }`; at most one user
 * is ever the holder because there is exactly one field. The per-user
 * `inbound_voice_line` boolean is DERIVED in the views from this pointer — the
 * repo never writes it (single field ⇒ the two-concurrent-assigns race is
 * structurally impossible). listAll() filters this row out so no user-list
 * consumer ever sees it.
 */
export const HOLDER_POINTER_KEY = 'singleton#inbound_voice_line';

/** The sentinel pointer item shape (users table). */
interface HolderPointerItem {
  userId: string;
  holder_user_id?: string;
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

    async remove(userId) {
      // Hard delete. Unconditional so it is idempotent (deleting an absent id
      // is a no-op, not an error) -- the route has already run the guards.
      await doc.send(new DeleteCommand({ TableName: table, Key: { userId } }));
      log.info({ userId }, 'user removed');
    },

    async restore(item) {
      // Unconditional re-put of the full item (rollback resurrect). No condition:
      // the row was just deleted, so we are re-creating it exactly as it was.
      await doc.send(new PutCommand({ TableName: table, Item: item }));
      log.info({ userId: item.userId }, 'user restored (rollback)');
    },

    async activateOnLogin(userId, googleSub, name, at = new Date().toISOString()) {
      // `name` is a DynamoDB reserved word — always alias it via ExpressionAttributeNames.
      // Present-only SET: append name clause only when the caller provided a non-empty
      // trimmed string; a missing/blank claim must never clobber a previously stored name.
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const hasName = trimmedName.length > 0;
      // One write: set google_sub (conditional-safe — only if absent, so
      // a racing second first-login is a harmless no-op rather than a
      // clobber), flip status → active, stamp last_login_at.
      const updateExpr =
        'SET google_sub = if_not_exists(google_sub, :sub), #status = :active, last_login_at = :at' +
        (hasName ? ', #name = :name' : '');
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression: updateExpr,
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: hasName
            ? { '#status': 'status', '#name': 'name' }
            : { '#status': 'status' },
          ExpressionAttributeValues: hasName
            ? { ':sub': googleSub, ':active': 'active', ':at': at, ':name': trimmedName }
            : { ':sub': googleSub, ':active': 'active', ':at': at },
        }),
      );
    },

    async touchLastLogin(userId, name, at = new Date().toISOString()) {
      // Present-only SET: append name clause only when caller provides a non-empty trimmed string.
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const hasName = trimmedName.length > 0;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression: 'SET last_login_at = :at' + (hasName ? ', #name = :name' : ''),
          ConditionExpression: 'attribute_exists(userId)',
          ...(hasName
            ? {
                ExpressionAttributeNames: { '#name': 'name' },
                ExpressionAttributeValues: { ':at': at, ':name': trimmedName },
              }
            : { ExpressionAttributeValues: { ':at': at } }),
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

    async setRoleAndRevoke(userId, role) {
      // ONE update: SET role AND bump session_epoch — atomic, so a role change
      // can never land without revoking the user's sessions (H1). The epoch
      // expression mirrors bumpSessionEpoch + the ops-script buildRoleUpdate
      // exactly: if_not_exists(…, 1) + 1 (NOT ADD), so a legacy item lacking
      // the attribute (read as epoch 1) first bumps to 2.
      const { Attributes } = await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression:
            'SET #role = :role, session_epoch = if_not_exists(session_epoch, :base) + :one',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':role': role, ':base': 1, ':one': 1 },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      const epoch = (Attributes as Pick<UserItem, 'session_epoch'> | undefined)?.session_epoch;
      if (typeof epoch !== 'number') {
        throw new Error(`setRoleAndRevoke(${userId}): UPDATED_NEW returned no session_epoch`);
      }
      log.info(
        { userId, role, sessionEpoch: epoch },
        'user role set + session epoch bumped — all prior sessions revoked',
      );
      return epoch;
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
      // items that actually carry a role, defensively. Also exclude the
      // inbound-voice-line sentinel pointer row (HOLDER_POINTER_KEY) — it is
      // repo-internal bookkeeping, not a user, and must never appear in any
      // user list (listByRole, resolveFounders, the admin GET /api/users route).
      return items.filter((u) => u.userId !== HOLDER_POINTER_KEY && isUserRole(u.role));
    },

    async listByRole(role) {
      // Reuse the bounded scan + filter in memory (the team is tiny). Keeps the
      // founder-resolution lookup inside the existing read economy — no GSI.
      // SCALE NOTE (accepted): this SCANs the users table and is hit on the
      // call path (founder triage resolves admins per inbound call). Acceptable
      // at the current bounded team size; revisit with a byRole GSI if the users
      // table grows past a single Scan page / the call volume makes the scan hot.
      const all = await repo.listAll();
      return all.filter((u) => u.role === role);
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

    // --- Voice Phase 1: cell verification (spec §7) ------------------------
    async startCellVerification(userId, cell, codeHash, expiresAt) {
      // SET the pending fields + RESET attempts. Deliberately leaves cell /
      // cell_verified_at untouched — the candidate is not trusted until a
      // matching confirm. `cell`/`codeHash` are never logged (PII/secret).
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression:
            'SET cell_pending = :pending, cell_verify_code_hash = :hash, ' +
            'cell_verify_expires_at = :exp, cell_verify_attempts = :zero',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: {
            ':pending': cell,
            ':hash': codeHash,
            ':exp': expiresAt,
            ':zero': 0,
          },
        }),
      );
      log.info({ userId }, 'cell verification started');
    },

    async confirmCellVerification(userId, codeHash, now) {
      // Read-modify-write: per-user, low-frequency; the contention window is a
      // single person confirming their own code, so a plain RMW is fine.
      const current = await repo.findById(userId);
      if (!current) throw new Error(`confirmCellVerification: no user ${userId}`);

      const pending = current.cell_pending;
      const storedHash = current.cell_verify_code_hash;
      if (typeof pending !== 'string' || typeof storedHash !== 'string') {
        return { ok: false, reason: 'no_pending' };
      }
      const expiresAt = current.cell_verify_expires_at;
      if (typeof expiresAt === 'string' && now > expiresAt) {
        return { ok: false, reason: 'expired' };
      }
      const attempts =
        typeof current.cell_verify_attempts === 'number' ? current.cell_verify_attempts : 0;
      if (attempts >= CELL_VERIFY_MAX_ATTEMPTS) {
        return { ok: false, reason: 'too_many_attempts' };
      }
      if (codeHash !== storedHash) {
        // Wrong code — burn an attempt (RMW increment; the cap above gates the
        // NEXT try). Guard existence so a deleted user is not resurrected.
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { userId },
            UpdateExpression: 'SET cell_verify_attempts = :next',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':next': attempts + 1 },
          }),
        );
        log.info({ userId, attempts: attempts + 1 }, 'cell verification code mismatch');
        return { ok: false, reason: 'mismatch' };
      }
      // Match — promote the candidate to the verified cell and clear the pending
      // fields in ONE write.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId },
          UpdateExpression:
            'SET cell = :cell, cell_verified_at = :now ' +
            'REMOVE cell_pending, cell_verify_code_hash, cell_verify_expires_at, cell_verify_attempts',
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeValues: { ':cell': pending, ':now': now },
        }),
      );
      log.info({ userId }, 'cell verified');
      return { ok: true, cell: pending, cell_verified_at: now };
    },

    // --- Voice Phase 1: single inbound-voice-line holder (spec §6) ---------
    // The holder is ONE authoritative pointer (the HOLDER_POINTER_KEY sentinel
    // row's holder_user_id). A single field means at most one holder ever — two
    // concurrent assigns can't both "win" a boolean; the race is gone by design.
    async assignInboundVoiceLine(userId) {
      // ONE unconditional write to the pointer (last-writer-wins). No scan, no
      // per-user boolean. NOTE: the CALLER must ensure the target has a verified
      // cell (the Phase 2 route 409s otherwise) — not enforced here.
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { userId: HOLDER_POINTER_KEY },
          UpdateExpression: 'SET holder_user_id = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
      );
      log.info({ userId }, 'inbound voice line assigned');
    },

    async clearInboundVoiceLine(userId) {
      // REMOVE the pointer ONLY when `userId` is the current holder — clearing a
      // non-holder is a no-op (conditional guards against clobbering someone
      // else's assignment). A failed condition just means the target wasn't the
      // holder; swallow it.
      try {
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { userId: HOLDER_POINTER_KEY },
            UpdateExpression: 'REMOVE holder_user_id',
            ConditionExpression: 'holder_user_id = :uid',
            ExpressionAttributeValues: { ':uid': userId },
          }),
        );
        log.info({ userId }, 'inbound voice line cleared');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return; // not the holder — no-op
        throw err;
      }
    },

    async getInboundVoiceLineHolder() {
      const { Item } = await doc.send(
        new GetCommand({ TableName: table, Key: { userId: HOLDER_POINTER_KEY } }),
      );
      const holderUserId = (Item as HolderPointerItem | undefined)?.holder_user_id;
      if (typeof holderUserId !== 'string' || holderUserId.length === 0) return undefined;
      // Resolve the pointer to the live user. A dangling pointer (user deleted)
      // degrades gracefully to undefined rather than a phantom holder.
      return repo.findById(holderUserId);
    },
  };

  return repo;
}
