// M1.3 integration tests against DynamoDB Local — usersRepo's conditional
// writes (invite idempotency, activate-on-login), the byEmail GSI lookup,
// touchLastLogin/setRole guards, and the full resolveInvitedUser flow on real
// conditional writes (invite-gated access; first-login activation race).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createUsersRepo, userIdForEmail } from '../src/repos/usersRepo.js';
import { AccessDeniedError, resolveInvitedUser } from '../src/services/resolveInvitedUser.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[usersRepo.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('usersRepo against DynamoDB Local (throwaway prefix)', () => {
  // Throwaway prefix so this suite never touches hc-local-* dev data.
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const users = createUsersRepo(repoDeps);
  const audit = createAuditRepo(repoDeps);

  const bases = ['users', 'audit_events'] as const;

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('userIdForEmail is deterministic, case/whitespace-insensitive, and distinct per email', () => {
    expect(userIdForEmail('a@x.org')).toBe(userIdForEmail('a@x.org'));
    expect(userIdForEmail(' A@X.ORG ')).toBe(userIdForEmail('a@x.org'));
    expect(userIdForEmail('a@x.org')).not.toBe(userIdForEmail('b@x.org'));
    expect(userIdForEmail('a@x.org')).toMatch(/^usr_[0-9a-f]{24}$/);
  });

  it('invite creates an invited record (status invited, epoch 1, no google_sub)', async () => {
    const email = 'first@housingchoice.org';
    const { created, user } = await users.invite({ email, role: 'va' });
    expect(created).toBe(true);
    expect(user).toMatchObject({
      userId: userIdForEmail(email),
      email,
      role: 'va',
      status: 'invited',
      session_epoch: 1,
    });
    expect(user.google_sub).toBeUndefined();
  });

  it('invite is IDEMPOTENT: re-inviting returns the existing record and changes NOTHING', async () => {
    const email = 'idempotent@housingchoice.org';
    const first = await users.invite({ email, role: 'va' });
    expect(first.created).toBe(true);
    // Re-invite with a DIFFERENT role — must be a no-op that returns the existing 'va'.
    const second = await users.invite({ email, role: 'admin' });
    expect(second.created).toBe(false);
    expect(second.user.role).toBe('va'); // unchanged
    expect(second.user.status).toBe('invited');
    expect((await users.findById(userIdForEmail(email)))!.role).toBe('va'); // untouched on disk
  });

  it('two CONCURRENT invites for one email yield exactly one create (the race anchor)', async () => {
    const email = 'race@housingchoice.org';
    const [a, b] = await Promise.all([
      users.invite({ email, role: 'va' }),
      users.invite({ email, role: 'va' }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await users.findById(userIdForEmail(email))).toBeDefined();
  });

  it('activateOnLogin flips status → active, writes google_sub, stamps last_login; re-activation never clobbers the sub', async () => {
    const email = 'activate@housingchoice.org';
    await users.invite({ email, role: 'va' });
    const userId = userIdForEmail(email);

    await users.activateOnLogin(userId, 'sub-first', undefined, '2026-06-12T12:34:56.000Z');
    const activated = (await users.findById(userId))!;
    expect(activated.status).toBe('active');
    expect(activated.google_sub).toBe('sub-first');
    expect(activated.last_login_at).toBe('2026-06-12T12:34:56.000Z');
    expect(activated.role).toBe('va'); // untouched

    // A racing second activation must NOT clobber the google_sub (if_not_exists).
    await users.activateOnLogin(userId, 'sub-second', undefined, '2026-06-12T13:00:00.000Z');
    expect((await users.findById(userId))!.google_sub).toBe('sub-first');

    await expect(users.activateOnLogin('usr_doesnotexist0000000000', 'x')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('findByEmail queries the byEmail GSI and normalizes its input', async () => {
    const { user } = await users.invite({ email: 'Lookup@HousingChoice.org', role: 'va' });
    const found = await users.findByEmail('  LOOKUP@housingchoice.ORG ');
    expect(found?.userId).toBe(user.userId);
    expect(await users.findByEmail('nobody@housingchoice.org')).toBeUndefined();
  });

  it('touchLastLogin stamps the time and throws for unknown users', async () => {
    const { user } = await users.invite({ email: 'touch@housingchoice.org', role: 'va' });
    await users.touchLastLogin(user.userId, undefined, '2026-06-12T12:34:56.000Z');
    expect((await users.findById(user.userId))!.last_login_at).toBe('2026-06-12T12:34:56.000Z');

    await expect(users.touchLastLogin('usr_doesnotexist0000000000')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('setRole flips va → admin (the user:role script path) and throws for unknown users', async () => {
    const { user } = await users.invite({ email: 'promote@housingchoice.org', role: 'va' });
    await users.setRole(user.userId, 'admin');
    expect((await users.findById(user.userId))!.role).toBe('admin');

    await expect(users.setRole('usr_doesnotexist0000000000', 'va')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('bumpSessionEpoch increments and returns the new epoch; legacy items (no attribute) land on 2', async () => {
    // Invited-shaped item: explicit session_epoch 1.
    const fresh = await users.invite({ email: 'epoch-fresh@housingchoice.org', role: 'va' });
    expect(await users.bumpSessionEpoch(fresh.user.userId)).toBe(2);
    expect(await users.bumpSessionEpoch(fresh.user.userId)).toBe(3);
    expect((await users.findById(fresh.user.userId))!.session_epoch).toBe(3);

    // Legacy item WITHOUT the attribute (predates session_epoch): a direct put,
    // since invite always writes 1. It reads as epoch 1 in the app
    // (sessionEpochOf), so the FIRST bump must land on 2 — never 1.
    const legacyId = userIdForEmail('epoch-legacy@housingchoice.org');
    await doc.send(
      new PutCommand({
        TableName: tableName('users', testEnv),
        Item: {
          userId: legacyId,
          email: 'epoch-legacy@housingchoice.org',
          role: 'va',
          created_at: '2026-06-12T00:00:00.000Z',
        },
      }),
    );
    expect(await users.bumpSessionEpoch(legacyId)).toBe(2);

    await expect(users.bumpSessionEpoch('usr_doesnotexist0000000000')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('resolveInvitedUser REFUSES an un-invited identity (no auto-provision)', async () => {
    const identity = {
      sub: 'sub-uninvited',
      email: 'uninvited@housingchoice.org',
      emailVerified: true,
    };
    const deps = { usersRepo: users, auditRepo: audit, logger };
    await expect(resolveInvitedUser(deps, identity)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await users.findById(userIdForEmail(identity.email))).toBeUndefined();
  });

  it('resolveInvitedUser activation race on REAL conditional writes: one activation, both same id, sub preserved', async () => {
    const identity = {
      sub: 'sub-race-svc',
      email: 'svc-race@housingchoice.org',
      emailVerified: true,
    };
    await users.invite({ email: identity.email, role: 'va' }); // invite-first
    const deps = { usersRepo: users, auditRepo: audit, logger };
    const [a, b] = await Promise.all([
      resolveInvitedUser(deps, identity),
      resolveInvitedUser(deps, identity),
    ]);
    expect(a.user.userId).toBe(b.user.userId);
    const item = await users.findById(userIdForEmail(identity.email));
    expect(item).toMatchObject({
      email: identity.email,
      google_sub: 'sub-race-svc', // if_not_exists: neither racer clobbers
      role: 'va',
      status: 'active',
      session_epoch: 1, // the kill switch starts at 1 on invite
    });
  });
});
