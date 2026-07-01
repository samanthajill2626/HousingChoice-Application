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
import { hashCellVerifyCode } from '../src/lib/cellVerification.js';
import { createUsersRepo, displayNameOf, userIdForEmail } from '../src/repos/usersRepo.js';
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

  // Task 3 integration: displayNameOf present-only name refresh over real DynamoDB.
  // Verifies: name stored on first login, NOT clobbered when absent, refreshed when changed.
  it('displayNameOf: first login stores name; absent claim does NOT clobber; changed name refreshes', async () => {
    const email = 'name-refresh@housingchoice.org';
    await users.invite({ email, role: 'va' });
    const userId = userIdForEmail(email);
    const deps = { usersRepo: users, auditRepo: audit, logger };

    // First login WITH a name — name should be stored.
    const { user: user1 } = await resolveInvitedUser(deps, {
      sub: 'sub-name-refresh',
      email,
      emailVerified: true,
      name: 'Sam Rivera',
    });
    expect(user1.name).toBe('Sam Rivera');
    expect(displayNameOf(user1)).toBe('Sam Rivera');
    const stored1 = await users.findById(userId);
    expect(stored1?.name).toBe('Sam Rivera');

    // Second login WITHOUT a name claim — stored name must be PRESERVED (present-only).
    const { user: user2 } = await resolveInvitedUser(deps, {
      sub: 'sub-name-refresh',
      email,
      emailVerified: true,
      // name absent intentionally
    });
    // The returned user merges the stored name (already present in the item).
    const stored2 = await users.findById(userId);
    expect(stored2?.name).toBe('Sam Rivera'); // DynamoDB value unchanged
    expect(displayNameOf(stored2!)).toBe('Sam Rivera');
    // The service return value for the no-claim login reflects existing stored name.
    expect(displayNameOf(user2)).toBe('Sam Rivera');

    // Third login WITH a CHANGED name — stored name should refresh.
    const { user: user3 } = await resolveInvitedUser(deps, {
      sub: 'sub-name-refresh',
      email,
      emailVerified: true,
      name: 'Samantha Rivera',
    });
    expect(user3.name).toBe('Samantha Rivera');
    expect(displayNameOf(user3)).toBe('Samantha Rivera');
    const stored3 = await users.findById(userId);
    expect(stored3?.name).toBe('Samantha Rivera');
    expect(displayNameOf(stored3!)).toBe('Samantha Rivera');
  });

  // -------------------------------------------------------------------------
  // Voice Phase 1 (spec §7): cell verification
  // -------------------------------------------------------------------------
  const hash = (code: string) => hashCellVerifyCode(code);

  it('startCellVerification sets pending fields + resets attempts, leaving cell/verified_at untouched', async () => {
    const { user } = await users.invite({ email: 'cellstart@housingchoice.org', role: 'va' });
    await users.startCellVerification(user.userId, '+15550123456', hash('123456'), '2030-01-01T00:00:00.000Z');
    const item = (await users.findById(user.userId))!;
    expect(item.cell_pending).toBe('+15550123456');
    expect(item.cell_verify_code_hash).toBe(hash('123456'));
    expect(item.cell_verify_expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(item.cell_verify_attempts).toBe(0);
    // Not trusted yet — cell + cell_verified_at must remain absent.
    expect(item.cell).toBeUndefined();
    expect(item.cell_verified_at).toBeUndefined();
  });

  it('confirmCellVerification: success promotes cell, stamps verified_at, clears pending', async () => {
    const { user } = await users.invite({ email: 'cellok@housingchoice.org', role: 'va' });
    await users.startCellVerification(user.userId, '+15550100200', hash('654321'), '2030-01-01T00:00:00.000Z');
    const res = await users.confirmCellVerification(user.userId, hash('654321'), '2026-07-01T10:00:00.000Z');
    expect(res).toEqual({ ok: true, cell: '+15550100200', cell_verified_at: '2026-07-01T10:00:00.000Z' });
    const item = (await users.findById(user.userId))!;
    expect(item.cell).toBe('+15550100200');
    expect(item.cell_verified_at).toBe('2026-07-01T10:00:00.000Z');
    expect(item.cell_pending).toBeUndefined();
    expect(item.cell_verify_code_hash).toBeUndefined();
    expect(item.cell_verify_expires_at).toBeUndefined();
    expect(item.cell_verify_attempts).toBeUndefined();
  });

  it('confirmCellVerification: no_pending when nothing is pending', async () => {
    const { user } = await users.invite({ email: 'cellnopending@housingchoice.org', role: 'va' });
    const res = await users.confirmCellVerification(user.userId, hash('000000'), '2026-07-01T10:00:00.000Z');
    expect(res).toEqual({ ok: false, reason: 'no_pending' });
  });

  it('confirmCellVerification: expired when now is past the deadline (no cell promotion)', async () => {
    const { user } = await users.invite({ email: 'cellexpired@housingchoice.org', role: 'va' });
    await users.startCellVerification(user.userId, '+15550100300', hash('222222'), '2026-07-01T09:00:00.000Z');
    const res = await users.confirmCellVerification(user.userId, hash('222222'), '2026-07-01T10:00:00.000Z');
    expect(res).toEqual({ ok: false, reason: 'expired' });
    expect((await users.findById(user.userId))!.cell).toBeUndefined();
  });

  it('confirmCellVerification: mismatch increments attempts; too_many_attempts after the cap', async () => {
    const { user } = await users.invite({ email: 'cellmismatch@housingchoice.org', role: 'va' });
    await users.startCellVerification(user.userId, '+15550100400', hash('333333'), '2030-01-01T00:00:00.000Z');
    // 5 wrong tries — each a mismatch, incrementing attempts to 5.
    for (let i = 0; i < 5; i++) {
      const res = await users.confirmCellVerification(user.userId, hash('999999'), '2026-07-01T10:00:00.000Z');
      expect(res).toEqual({ ok: false, reason: 'mismatch' });
    }
    expect((await users.findById(user.userId))!.cell_verify_attempts).toBe(5);
    // The 6th try (even with the RIGHT code) is locked out.
    const locked = await users.confirmCellVerification(user.userId, hash('333333'), '2026-07-01T10:00:00.000Z');
    expect(locked).toEqual({ ok: false, reason: 'too_many_attempts' });
    expect((await users.findById(user.userId))!.cell).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Voice Phase 1 (spec §6): single inbound-voice-line holder
  // -------------------------------------------------------------------------
  it('assignInboundVoiceLine is single-holder: assigning B clears A; getInboundVoiceLineHolder tracks it', async () => {
    const a = (await users.invite({ email: 'lineA@housingchoice.org', role: 'admin' })).user;
    const b = (await users.invite({ email: 'lineB@housingchoice.org', role: 'admin' })).user;

    await users.assignInboundVoiceLine(a.userId);
    expect((await users.findById(a.userId))!.inbound_voice_line).toBe(true);
    expect((await users.getInboundVoiceLineHolder())!.userId).toBe(a.userId);

    // Reassign to B — the single-holder invariant clears A.
    await users.assignInboundVoiceLine(b.userId);
    expect((await users.findById(a.userId))!.inbound_voice_line).toBeUndefined();
    expect((await users.findById(b.userId))!.inbound_voice_line).toBe(true);
    expect((await users.getInboundVoiceLineHolder())!.userId).toBe(b.userId);

    // Clear B — no holder remains.
    await users.clearInboundVoiceLine(b.userId);
    expect((await users.findById(b.userId))!.inbound_voice_line).toBeUndefined();
    expect(await users.getInboundVoiceLineHolder()).toBeUndefined();
  });
});
