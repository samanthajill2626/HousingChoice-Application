// fake-twilio/test/sesRest.test.ts
//
// The fake AWS SESv2 SendEmail REST surface (POST /v2/email/outbound-emails) + the
// disjoint mail CONTROL subpaths (GET /control/emails, POST /control/reset-mail).
// Drives them through buildFakeTwilioApp with supertest, exactly like control.test.ts,
// so the whole mount + body-parser + engine wiring is exercised end to end.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';

function makeApp() {
  const config = loadFakeConfig({
    NODE_ENV: 'test',
    TWILIO_AUTH_TOKEN: 't',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: 'http://localhost:5173',
  });
  return buildFakeTwilioApp({ config });
}

/** A hand-built multipart/mixed MIME (a text part + a png attachment), base64'd the
 *  way nodemailer/mail-composer output rides in SESv2 Content.Raw.Data. Headers use
 *  CRLF; the blank line separates the top-level header block from the body. */
function rawMimeBase64(
  over: { to?: string; cc?: string; subject?: string; messageId?: string } = {},
): string {
  const to = over.to ?? 'Marcus Bell <marcus.bell@example.com>';
  const subject = over.subject ?? 'Welcome';
  const messageId = over.messageId ?? '<hc-abc123@mail.local.test>';
  const lines = [
    'From: "Team at Housing Choice" <team@mail.local.test>',
    `To: ${to}`,
    ...(over.cc !== undefined ? [`Cc: ${over.cc}`] : []),
    'Reply-To: relay+tok123@mail.local.test',
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B0undary"',
    '',
    '--B0undary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello there.',
    '--B0undary',
    'Content-Type: image/png; name="tiny.png"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="tiny.png"',
    '',
    'iVBORw0KGgo=',
    '--B0undary--',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
}

describe('fake SESv2 REST: POST /v2/email/outbound-emails', () => {
  it('accepts a base64 MIME, stores the parsed headers + raw, and returns a MessageId', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v2/email/outbound-emails')
      .send({
        FromEmailAddress: 'team@mail.local.test',
        Destination: { ToAddresses: ['marcus.bell@example.com'] },
        Content: { Raw: { Data: rawMimeBase64({ cc: 'boss@example.com, assistant@example.com' }) } },
      });
    expect(res.status).toBe(200);
    expect(res.body.MessageId).toBe('ses-fake-1');

    const list = await request(app).get('/control/emails');
    expect(list.status).toBe(200);
    expect(list.body.emails).toHaveLength(1);
    const email = list.body.emails[0];
    expect(email.sesMessageId).toBe('ses-fake-1');
    expect(email.to).toEqual(['marcus.bell@example.com']);
    expect(email.cc).toEqual(['boss@example.com', 'assistant@example.com']);
    expect(email.subject).toBe('Welcome');
    expect(email.messageIdHeader).toBe('<hc-abc123@mail.local.test>');
    expect(email.state).toBe('sent');
    expect(typeof email.receivedAt).toBe('string');
    // The full raw MIME is retained verbatim, so the attachment part is observable.
    expect(email.rawMime).toContain('Content-Type: image/png');
    expect(email.rawMime).toContain('Subject: Welcome');
  });

  it('400s when Content.Raw.Data is missing (garbage body)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v2/email/outbound-emails')
      .send({ FromEmailAddress: 'team@mail.local.test' });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe('BadRequestException');
    expect(typeof res.body.message).toBe('string');
    // Nothing was stored.
    const list = await request(app).get('/control/emails');
    expect(list.body.emails).toHaveLength(0);
  });

  it('400s when Content.Raw.Data is not a string', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/v2/email/outbound-emails')
      .send({ Content: { Raw: { Data: 123 } } });
    expect(res.status).toBe(400);
  });
});

describe('fake SES control: GET /control/emails + POST /control/reset-mail', () => {
  it('lists captured emails NEWEST FIRST', async () => {
    const app = makeApp();
    await request(app).post('/v2/email/outbound-emails').send({ Content: { Raw: { Data: rawMimeBase64({ subject: 'First' }) } } });
    await request(app).post('/v2/email/outbound-emails').send({ Content: { Raw: { Data: rawMimeBase64({ subject: 'Second' }) } } });
    const list = await request(app).get('/control/emails');
    expect(list.body.emails.map((e: { subject: string }) => e.subject)).toEqual(['Second', 'First']);
  });

  it('reset-mail clears the store', async () => {
    const app = makeApp();
    await request(app).post('/v2/email/outbound-emails').send({ Content: { Raw: { Data: rawMimeBase64() } } });
    expect((await request(app).get('/control/emails')).body.emails).toHaveLength(1);

    const reset = await request(app).post('/control/reset-mail').send({});
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);
    expect((await request(app).get('/control/emails')).body.emails).toHaveLength(0);
  });

  it('leaves the SMS /control/reset working independently (no shadowing)', async () => {
    const app = makeApp();
    // The mail control router shares the /control prefix but disjoint subpaths, so
    // the SMS /control/reset still resolves to the messaging engine.
    const res = await request(app).post('/control/reset').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
