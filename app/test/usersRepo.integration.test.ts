// M1.3 integration tests against DynamoDB Local — usersRepo's conditional
// writes (the auto-provisioning race anchor), the byEmail GSI lookup,
// touchLastLogin/setRole guards, and the full findOrCreateUser race on real
// conditional writes.
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createUsersRepo, userIdForEmail, type UserItem } from '../src/repos/usersRepo.js';
import { findOrCreateUser } from '../src/services/userProvisioning.js';
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

function makeUser(email: string, overrides: Partial<UserItem> = {}): UserItem {
  return {
    userId: userIdForEmail(email),
    email: email.toLowerCase(),
    google_sub: `sub-${email}`,
    role: 'va',
    created_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
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

  it('createIfAbsent: first write wins, second returns false and overwrites NOTHING', async () => {
    const user = makeUser('first@housingchoice.org');
    expect(await users.createIfAbsent(user)).toBe(true);
    expect(await users.createIfAbsent({ ...user, role: 'admin' })).toBe(false);
    expect((await users.findById(user.userId))!.role).toBe('va'); // untouched
  });

  it('two CONCURRENT creates for one email yield exactly one item (the race anchor)', async () => {
    const email = 'race@housingchoice.org';
    const [a, b] = await Promise.all([
      users.createIfAbsent(makeUser(email)),
      users.createIfAbsent(makeUser(email)),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await users.findById(userIdForEmail(email))).toBeDefined();
  });

  it('findByEmail queries the byEmail GSI and lowercases its input', async () => {
    const user = makeUser('Lookup@HousingChoice.org'); // stored lowercased
    await users.createIfAbsent(user);
    const found = await users.findByEmail('LOOKUP@housingchoice.ORG');
    expect(found?.userId).toBe(user.userId);
    expect(await users.findByEmail('nobody@housingchoice.org')).toBeUndefined();
  });

  it('touchLastLogin stamps the time and throws for unknown users', async () => {
    const user = makeUser('touch@housingchoice.org');
    await users.createIfAbsent(user);
    await users.touchLastLogin(user.userId, '2026-06-12T12:34:56.000Z');
    expect((await users.findById(user.userId))!.last_login_at).toBe('2026-06-12T12:34:56.000Z');

    await expect(users.touchLastLogin('usr_doesnotexist0000000000')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('setRole flips va → admin (the user:role script path) and throws for unknown users', async () => {
    const user = makeUser('promote@housingchoice.org');
    await users.createIfAbsent(user);
    await users.setRole(user.userId, 'admin');
    expect((await users.findById(user.userId))!.role).toBe('admin');

    await expect(users.setRole('usr_doesnotexist0000000000', 'va')).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it('findOrCreateUser race on REAL conditional writes: one user, one created:true, both same id', async () => {
    const identity = {
      sub: 'sub-race-svc',
      email: 'svc-race@housingchoice.org',
      emailVerified: true,
    };
    const deps = { usersRepo: users, auditRepo: audit, logger };
    const [a, b] = await Promise.all([
      findOrCreateUser(deps, identity),
      findOrCreateUser(deps, identity),
    ]);
    expect(a.user.userId).toBe(b.user.userId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const item = await users.findById(userIdForEmail(identity.email));
    expect(item).toMatchObject({ email: identity.email, google_sub: 'sub-race-svc', role: 'va' });
  });
});
