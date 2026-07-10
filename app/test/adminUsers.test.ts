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
  sessionCookieFor,
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
      'name',
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

    const audit = world.auditEvents.find((e) => e.event_type === 'user_invited');
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

    const audit = world.auditEvents.find((e) => e.event_type === 'role_changed');
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

  it('promoting a VA to admin changes role AND bumps the epoch in ONE write (H1 atomic)', async () => {
    // The fake's setRoleAndRevoke does both in one call — assert the route uses
    // it (role flipped, epoch +1) rather than a role-set with no revocation.
    const { app, fakeUsers } = makeWebhookHarness();
    const before = fakeUsers.users.get(TEST_SESSION_USER.userId);
    expect(before?.role).toBe('va');
    const epochBefore = before?.session_epoch ?? 1;

    const res = await request(app)
      .patch(`/api/users/${TEST_SESSION_USER.userId}/role`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    const after = fakeUsers.users.get(TEST_SESSION_USER.userId);
    // BOTH changed together: role and the revocation epoch.
    expect(after?.role).toBe('admin');
    expect(after?.session_epoch).toBe(epochBefore + 1);
  });

  it('concurrent cross-demotion of two admins never reaches zero admins (C2 verify-after-rollback)', async () => {
    // Exactly TWO admins (A = the harness admin, B = a second). Each demotes the
    // OTHER concurrently — both pass the pre-write last-admin guard (each sees
    // the other still admin), so WITHOUT the verify-after-write-and-rollback the
    // table races to ZERO admins. The post-write re-check must heal it.
    //
    // We first WARM the session-epoch cache for both A and B with a cheap authed
    // GET: a cross-demote bumps each victim's epoch, which would otherwise
    // revoke that victim's own in-flight session (a 401 auth artifact, not the
    // invariant under test). With the cache warmed (epoch 1, 60s TTL) both PATCH
    // auth checks pass, so the race actually reaches the route logic.
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const secondAdminCookie = sessionCookieFor({
      userId: 'usr_secondadmin',
      email: 'a2@housingchoice.org',
      role: 'admin',
    });

    // Warm the epoch cache for BOTH admins (so the mid-flight epoch bumps don't
    // revoke either actor's own session).
    await request(app).get('/api/users').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    await request(app).get('/api/users').set('x-origin-verify', SECRET).set('cookie', secondAdminCookie);

    // A demotes B; B demotes A — fired together so they interleave at awaits.
    const [resAdemotesB, resBdemotesA] = await Promise.all([
      request(app)
        .patch('/api/users/usr_secondadmin/role')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE)
        .send({ role: 'va' }),
      request(app)
        .patch(`/api/users/${TEST_ADMIN_USER.userId}/role`)
        .set('x-origin-verify', SECRET)
        .set('cookie', secondAdminCookie)
        .send({ role: 'va' }),
    ]);

    // Both requests authenticated past the gate (warmed cache).
    expect([resAdemotesB.status, resBdemotesA.status].every((s) => s === 200 || s === 409)).toBe(true);
    // INVARIANT (the C2 fix): at least one admin remains — no zero-admin end
    // state, even though both demotions passed the pre-write guard.
    const adminsRemaining = [...fakeUsers.users.values()].filter((u) => u.role === 'admin');
    expect(adminsRemaining.length).toBeGreaterThanOrEqual(1);
    // And the heal returned a 409 on the demotion that would have emptied it.
    expect([resAdemotesB.status, resBdemotesA.status]).toContain(409);
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

describe('DELETE /api/users/:userId', () => {
  it('removes a VA target (200), deletes the row, audits user_removed with actor + email', async () => {
    const { app, world, fakeUsers } = makeWebhookHarness();
    // The harness seeds the VA (TEST_SESSION_USER) and the admin (TEST_ADMIN_USER).
    const res = await request(app)
      .delete(`/api/users/${TEST_SESSION_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    // Row is gone.
    expect(fakeUsers.users.has(TEST_SESSION_USER.userId)).toBe(false);
    // Audit event with the acting admin + the target's email/role.
    const audit = world.auditEvents.find((e) => e.event_type === 'user_removed');
    expect(audit?.payload).toMatchObject({
      email: TEST_SESSION_USER.email,
      role: 'va',
      actor: TEST_ADMIN_USER.userId,
    });
  });

  it('refuses removing the LAST admin (409 cannot_remove_last_admin)', async () => {
    // Harness seeds exactly ONE admin (TEST_ADMIN_USER). Removing them (self)
    // would leave zero admins -> the last-admin guard fires first.
    const { app, fakeUsers } = makeWebhookHarness();
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_remove_last_admin' });
    // The admin is still there.
    expect(fakeUsers.users.has(TEST_ADMIN_USER.userId)).toBe(true);
  });

  it('a non-last admin removing THEMSELVES is refused (409 cannot_remove_self)', async () => {
    // Two admins present, so the last-admin guard does NOT fire -- the self
    // guard is what catches an admin removing their own account.
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE); // self
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'cannot_remove_self' });
    // Still present (not removed).
    expect(fakeUsers.users.has(TEST_ADMIN_USER.userId)).toBe(true);
  });

  it('removing one of TWO admins (a distinct target) is allowed (200)', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const res = await request(app)
      .delete('/api/users/usr_secondadmin')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE); // distinct actor
    expect(res.status).toBe(200);
    expect(fakeUsers.users.has('usr_secondadmin')).toBe(false);
  });

  it('refuses removing the inbound-voice-line holder (409 voice_line_assigned)', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    // Make the VA target the current inbound-voice-line holder.
    await fakeUsers.repo.assignInboundVoiceLine(TEST_SESSION_USER.userId);
    const res = await request(app)
      .delete(`/api/users/${TEST_SESSION_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'voice_line_assigned' });
    // Still present (not removed).
    expect(fakeUsers.users.has(TEST_SESSION_USER.userId)).toBe(true);
  });

  it('concurrent cross-removal of two admins never reaches zero admins (verify-after-rollback)', async () => {
    // Exactly TWO admins (A = the harness admin, B = a second). Each REMOVES the
    // OTHER concurrently -- both pass the pre-check last-admin guard (each sees
    // the other still admin), so WITHOUT the verify-after-write-and-rollback the
    // table races to ZERO admins. The post-delete re-check must heal it by
    // resurrecting the row the emptying delete removed.
    //
    // Warm the session-epoch cache for BOTH admins first with a cheap authed GET
    // (same technique the PATCH C2 test uses): removal doesn't bump epochs, but a
    // deleted-mid-flight actor's own session would otherwise fail the users-table
    // epoch check (findById returns undefined) and 401 -- warming keeps both
    // actors authenticated so the race reaches the route logic.
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set(
      'usr_secondadmin',
      adminUserItem({ userId: 'usr_secondadmin', email: 'a2@housingchoice.org' }),
    );
    const secondAdminCookie = sessionCookieFor({
      userId: 'usr_secondadmin',
      email: 'a2@housingchoice.org',
      role: 'admin',
    });

    // Warm the epoch cache for BOTH admins.
    await request(app).get('/api/users').set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
    await request(app).get('/api/users').set('x-origin-verify', SECRET).set('cookie', secondAdminCookie);

    // A removes B; B removes A -- fired together so they interleave at awaits.
    const [resAremovesB, resBremovesA] = await Promise.all([
      request(app)
        .delete('/api/users/usr_secondadmin')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_ADMIN_COOKIE),
      request(app)
        .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
        .set('x-origin-verify', SECRET)
        .set('cookie', secondAdminCookie),
    ]);

    // Both requests authenticated past the gate (warmed cache).
    expect([resAremovesB.status, resBremovesA.status].every((s) => s === 200 || s === 409)).toBe(true);
    // INVARIANT (the fix): at least one admin remains -- no zero-admin end state,
    // even though both removals passed the pre-check last-admin guard.
    const adminsRemaining = [...fakeUsers.users.values()].filter((u) => u.role === 'admin');
    expect(adminsRemaining.length).toBeGreaterThanOrEqual(1);
    // And the heal returned a 409 on the removal that would have emptied the set.
    expect([resAremovesB.status, resBremovesA.status]).toContain(409);
  });

  it('404s an unknown target user', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .delete('/api/users/usr_does_not_exist')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'user_not_found' });
  });

  it('VA is forbidden (403)', async () => {
    const { app } = makeWebhookHarness();
    const res = await request(app)
      .delete(`/api/users/${TEST_ADMIN_USER.userId}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE); // VA
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — GET /api/users projection includes name via displayNameOf
// ---------------------------------------------------------------------------

describe('GET /api/users — name field via displayNameOf', () => {
  it('a user with a name shows the name in the projection', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set('usr_named', {
      userId: 'usr_named',
      email: 'named@housingchoice.org',
      role: 'va',
      status: 'active',
      session_epoch: 1,
      created_at: '2026-06-01T00:00:00.000Z',
      name: 'Jordan Avery',
    });

    const res = await request(app)
      .get('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);

    expect(res.status).toBe(200);
    const named = res.body.users.find((u: { userId: string }) => u.userId === 'usr_named');
    expect(named?.name).toBe('Jordan Avery');
  });

  it('a user without a name shows the email as the name (displayNameOf fallback)', async () => {
    const { app, fakeUsers } = makeWebhookHarness();
    fakeUsers.users.set('usr_noname', {
      userId: 'usr_noname',
      email: 'noname@housingchoice.org',
      role: 'va',
      status: 'active',
      session_epoch: 1,
      created_at: '2026-06-01T00:00:00.000Z',
    });

    const res = await request(app)
      .get('/api/users')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_ADMIN_COOKIE);

    expect(res.status).toBe(200);
    const noname = res.body.users.find((u: { userId: string }) => u.userId === 'usr_noname');
    expect(noname?.name).toBe('noname@housingchoice.org');
  });
});
