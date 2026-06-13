// users repo — the team (doc §5: PK userId, byEmail GSI, Google identity
// sub + email, role). M1.3: auto-provisioning on first allowlisted login,
// session lookups, and the user:role ops script's runtime counterpart.
//
// Roles are 'admin' | 'va' (README deviations table 2026-06-12: the doc's
// founder_admin | va renamed by operator preference, semantics identical).
//
// RACE SAFETY: userId is DETERMINISTIC from the lowercased email
// (userIdForEmail), so two concurrent first logins for one email mint the
// SAME key and the attribute_not_exists(userId) conditional write lets
// exactly one create win — the same conditional-create discipline as
// contactsRepo, but with the identity baked into the key so no duplicate
// users can exist per email (the byEmail GSI is a lookup, not a guard).
import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

export interface UserItem {
  userId: string;
  /** Lowercased login email — the byEmail GSI key. */
  email: string;
  /** Google OIDC subject (stable account id) recorded at provisioning. */
  google_sub: string;
  role: UserRole;
  /**
   * Server-side session kill switch: sealed into every session cookie at
   * login and re-checked by sessionMiddleware. Bumping it (logout, role
   * change) revokes ALL of the user's sessions everywhere. Provisioning
   * writes 1; items provisioned before the field existed read as 1 via
   * sessionEpochOf().
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
 * Deterministic userId for an email: `usr_<sha256(lowercased email) hex/24>`.
 * This is what makes auto-provisioning race-safe (see module header) — and
 * it lets a losing racer re-read the winner's item by id without a GSI read
 * (GSIs are eventually consistent; the base-table Get is not).
 */
export function userIdForEmail(email: string): string {
  return `usr_${createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 24)}`;
}

export interface UsersRepo {
  /** Lowercases the input; byEmail GSI Query; undefined when unknown. */
  findByEmail(email: string): Promise<UserItem | undefined>;
  findById(userId: string): Promise<UserItem | undefined>;
  /**
   * Conditional create (attribute_not_exists(userId)): true when THIS call
   * created the item, false when the user already existed. Existing items
   * are never overwritten.
   */
  createIfAbsent(item: UserItem): Promise<boolean>;
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
}

export function createUsersRepo(deps: RepoDeps = {}): UsersRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('users', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async findByEmail(email) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'byEmail',
          KeyConditionExpression: 'email = :e',
          ExpressionAttributeValues: { ':e': email.trim().toLowerCase() },
        }),
      );
      // Deterministic userIds make duplicate emails impossible; [0] is THE user.
      return (Items as UserItem[] | undefined)?.[0];
    },

    async findById(userId) {
      const { Item } = await doc.send(new GetCommand({ TableName: table, Key: { userId } }));
      return Item as UserItem | undefined;
    },

    async createIfAbsent(item) {
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
          return false; // lost the race / already provisioned — never overwrite
        }
        throw err;
      }
      // IDs + role only — emails stay out of logs (PII posture, doc §9).
      log.info({ userId: item.userId, role: item.role }, 'user created');
      return true;
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
  };
}
