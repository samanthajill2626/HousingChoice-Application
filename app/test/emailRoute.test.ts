// A5 route tests: POST /api/conversations/:id/email - payload validation, the
// contact-by-address resolution + session identity threaded into the service,
// the 202 { message } envelope, and typed-refusal -> HTTP status mapping (ADJ-6:
// email_sending_disabled is 409, not 503). The service is a fake injected via
// buildApp; the route sits behind the origin-secret + requireAuth gates.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactsRepo } from '../src/repos/contactsRepo.js';
import {
  EmailSendRefusedError,
  type SendEmailInput,
} from '../src/services/sendEmailMessage.js';
import {
  makeFakeUsersRepo,
  testUserItem,
  TEST_SESSION_USER,
  TEST_SESSION_COOKIE,
} from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';

const SECRET = 'test-origin-secret';
const logger = createLogger({ destination: createLogCapture().stream });

function makeApp(behavior?: (input: SendEmailInput) => never, senderName?: string) {
  const calls: SendEmailInput[] = [];
  const userItem = senderName !== undefined ? testUserItem({ name: senderName }) : testUserItem();
  const usersRepo = makeFakeUsersRepo([userItem]).repo;
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }),
    logger,
    auth: { usersRepo },
    api: {
      // The email route resolves the sender's display name from the users
      // table (the session user carries no `name`).
      usersRepo,
      contactsRepo: {
        async findByEmail(email: string) {
          return { contactId: 'c1', type: 'tenant', email, emails: [{ email, primary: true }] };
        },
      } as unknown as ContactsRepo,
      sendEmailService: async (input) => {
        calls.push(input);
        behavior?.(input);
        return {
          conversationId: input.conversationId,
          tsMsgId: '2026-07-20T12:00:00.000Z#hc-x@mail.test',
          providerSid: 'hc-x@mail.test',
          sesMessageId: 'ses-1',
          emailMessageId: '<hc-x@mail.test>',
          status: 'sent',
          redirected: false,
        };
      },
    },
  });
  return { app, calls };
}

const OK_BODY = { to: 'tenant@x.com', subject: 'Hi', body: 'A body' };

describe('POST /api/conversations/:conversationId/email', () => {
  it('202 { message } on success, threading the resolved contact + session identity', async () => {
    const { app, calls } = makeApp(undefined, 'Sam Rivera');
    const res = await request(app)
      .post('/api/conversations/conv-1/email')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ ...OK_BODY, cc: ['peer@x.com'], attachmentKeys: ['email-media/u/aaaa-0000'] });

    expect(res.status).toBe(202);
    expect(res.body.message).toMatchObject({ status: 'sent', conversationId: 'conv-1', sesMessageId: 'ses-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: 'conv-1',
      contactId: 'c1', // resolved via contacts.findByEmail(to)
      to: 'tenant@x.com',
      cc: ['peer@x.com'],
      subject: 'Hi',
      body: 'A body',
      // Back-compat: a legacy attachmentKeys[] body normalizes to {key} attachments.
      attachments: [{ key: 'email-media/u/aaaa-0000' }],
      sentByUserId: TEST_SESSION_USER.userId,
      // Resolved from the USERS TABLE record (the session has no name field);
      // recipient-visible From line reads "Sam Rivera at Housing Choice".
      sentByName: 'Sam Rivera',
    });
  });

  it('falls back to the session email for sentByName when the user record has no name', async () => {
    const { app, calls } = makeApp(); // testUserItem() has no name
    const res = await request(app)
      .post('/api/conversations/conv-1/email')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send(OK_BODY);
    expect(res.status).toBe(202);
    expect(calls[0]).toMatchObject({ sentByName: TEST_SESSION_USER.email });
  });

  it('threads {key, filename} attachments through to the service (m4)', async () => {
    const { app, calls } = makeApp();
    const res = await request(app)
      .post('/api/conversations/conv-1/email')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ ...OK_BODY, attachments: [{ key: 'email-media/u/bbbb-1111', filename: 'lease.pdf' }] });

    expect(res.status).toBe(202);
    expect(calls[0]).toMatchObject({
      attachments: [{ key: 'email-media/u/bbbb-1111', filename: 'lease.pdf' }],
    });
  });

  it('400s when to, subject, or body is missing/blank', async () => {
    const { app, calls } = makeApp();
    for (const payload of [{}, { to: 'a@b.com' }, { to: 'a@b.com', subject: 'S' }, { ...OK_BODY, subject: '  ' }]) {
      const res = await request(app)
        .post('/api/conversations/conv-1/email')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(payload);
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('maps typed refusals onto HTTP statuses (404 / 409 / 400)', async () => {
    const cases = [
      { code: 'conversation_not_found', status: 404 },
      { code: 'email_sending_disabled', status: 409 }, // ADJ-6: 409, not 503
      { code: 'email_suppressed', status: 409 },
      { code: 'email_attachments_too_large', status: 409 },
      { code: 'contact_email_missing', status: 409 },
      { code: 'invalid_cc', status: 400 },
      { code: 'invalid_attachment', status: 400 },
    ] as const;
    for (const { code, status } of cases) {
      const { app } = makeApp(() => {
        throw new EmailSendRefusedError('refused', code);
      });
      const res = await request(app)
        .post('/api/conversations/conv-1/email')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send(OK_BODY);
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: code });
    }
  });

  it('stays behind the origin-secret gate (403 with no secret)', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/conversations/conv-1/email').send(OK_BODY);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('401s without a session cookie', async () => {
    const { app, calls } = makeApp();
    const res = await request(app)
      .post('/api/conversations/conv-1/email')
      .set('x-origin-verify', SECRET)
      .send(OK_BODY);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
