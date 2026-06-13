// M1.4 unit tests: the admin user-management routes (the FIRST
// requireRole('admin') surface) —
//   GET   /api/users
//   POST  /api/users   { email, role }
//   PATCH /api/users/:userId/role { role }
// Asserts the list shape EXCLUDES secrets (google_sub, push_subscriptions),
// idempotent invite + audit, role change + session-epoch bump, the
// self-demotion + last-admin lockout guards, and VA-forbidden 403.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  adminUserItem,
  TEST_ADMIN_COOKIE,
  TEST_ADMIN_USER,
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
} from './helpers/authSession.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';
import { userIdForEmail } from '../src/repos/usersRepo.js';

const SECRET = ORIGIN_SECRET;

describe('GET /api/users', () => {
  it('lists users with NO google_sub / push_subscriptions in the response', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    // Seed a user carrying secrets — they must not leak.
    fakeUsers.users.set('usr_secretholder', {
      userId: 'usr_secretholder',
      email: 'holder@housingchoice.org',
      google_sub: 'super-secret-sub',
      role: 'va',
      status: 'active',
      session_epoch: 1,
      created_at: '2026-06-01T00:00:00.000Z',
      push_subscriptions: [
        { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' }, created_at: '2026-06-01T00:00:00.000Z' },
      ],
    });

    const res = await request(app)
      .get('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('super-secret-sub');
    expect(serialized).not.toContain('push_subscriptions');
    expect(serialized).not.toContain('push.example');
    const holder = res.body.users.find((u: { userId: string }) => u.userId === 'usr_secretholder');
    expect(Object.keys(holder).sort()).toEqual([
      'created_at',
      'email',
      'last_login_at',
      'role',
      'status',
      'userId',
    ]);
  });

  it('VA is forbidden (403)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .get('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(res.status).toBe(403);
  });
});

describe('POST /api/users — invite', () => {
  it('invites a new user (201), audits user_invited with the actor', async () => {
    const { app, world, fakeUsers } = makeWebhookHarness();
    const res = await request(app)
      .post('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ email: 'New.Hire@HousingChoice.org', role: 'va' });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.user).toMatchObject({ email: 'new.hire@housingchoice.org', role: 'va', status: 'invited' });
    expect(fakeUsers.users.has(userIdForEmail('new.hire@housingchoice.org'))).toBe(true);

    const audit = world.auditEvents.find((e) => e.eventType === 'user_invited');
    expect(audit?.payload).toMatchObject({
      email: 'new.hire@housingchoice.org',
      role: 'va',
      actor: TEST_ADMIN_USER.userId,
    });
  });

  it('is idempotent — re-inviting returns created:false', async () => {
    const { app } = makeWebhookHarness();
    const send = () =>
      request(app)
        .post('/api/users')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ email: 'dup@housingchoice.org', role: 'va' });
    expect((await send()).body.created).toBe(true);
    const second = await send();
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(false);
  });

  it('400s an invalid email or role', async () => {
    const { app } = makeWebhookHarness();
    for (const body of [
      { email: 'not-an-email', role: 'va' },
      { email: 'ok@housingchoice.org', role: 'superuser' },
      { email: 'ok@housingchoice.org' },
      { role: 'va' },
    ]) {
      const res = await request(app)
        .post('/api/users')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('PATCH /api/users/:userId/role', () => {
  it('promotes a VA to admin, bumps the session epoch, audits role_changed', async () => {
    const { app, world, fakeUsers } = makeWebhookHarness();
    const epochBefore = fakeUsers.users.get(TEST_SESSION_USER.userId)?.session_epoch;
    const res = await request(app)
      .patch(`/api/users/${TEST_SESSION_USER.userId}/role`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.user.role).toBe('admin');
    // Epoch bumped → the target's sessions are revoked within the cache TTL.
    expect(fakeUsers.users.get(TEST_SESSION_USER.userId)?.session_epoch).toBe((epochBefore ?? 1) + 1);

    const audit = world.auditEvents.find((e) => e.eventType === 'role_changed');
    expect(audit?.payload).toMatchObject({ from: 'va', to: 'admin', actor: TEST_ADMIN_USER.userId });
  });

  it('a NON-last admin demoting themselves is refused (409 cannot_demote_self)', async () => {
    // Two admins present (harness admin + a second), so the last-admin guard
    // does NOT fire — the SELF guard is what catches it.
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .patch(`/api/users/${TEST_ADMIN_USER.userId}/role`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE) // self
      .send({ role: 'va' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_demote_self' });
  });

  it('refuses demoting the LAST remaining admin (409 cannot_demote_last_admin)', async () => {
    // Harness seeds exactly ONE admin (TEST_ADMIN_USER). Demoting them — even
    // by themselves — would leave zero admins: the last-admin guard fires
    // (it is checked before the self guard, being the more fundamental
    // invariant: the table must never reach zero admins).
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .patch(`/api/users/${TEST_ADMIN_USER.userId}/role`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ role: 'va' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_demote_last_admin' });
  });

  it('demoting one of TWO admins (a distinct target) is allowed', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .patch('/api/users/usr_secondadmin/role')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE) // distinct actor
      .send({ role: 'va' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(fakeUsers.users.get('usr_secondadmin')?.role).toBe('va');
  });

  it('404s an unknown target user', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .patch('/api/users/usr_does_not_exist/role')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ role: 'va' });
    expect(res.status).toBe(404);
  });

  it('VA is forbidden (403)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .patch(`/api/users/${TEST_ADMIN_USER.userId}/role`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE) // VA
      .send({ role: 'va' });
    expect(res.status).toBe(403);
  });
});
