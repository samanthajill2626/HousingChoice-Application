// email-channel B4: the fake-SES INBOUND path. The fake hand-rolls a MIME message
// (no mailparser - ADJ-10/D4), writes it to MinIO INBOUND_MAIL_BUCKET, and POSTs an
// SNS-shaped receipt notification to the app's /webhooks/ses/inbound with
// x-origin-verify. Unit-tested with a STUBBED S3 putter + STUBBED fetch (no network,
// no MinIO - the brief requires no real I/O in these unit tests).
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MailEngine, buildInboundMime } from '../src/engine/mailEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';
import { createSesControlRouter } from '../src/routes/sesControl.js';

function stubInbound(over: Record<string, unknown> = {}) {
  const puts: Array<{ key: string; body: Buffer; contentType: string }> = [];
  const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const putObject = vi.fn(async (key: string, body: Buffer, contentType: string) => {
    puts.push({ key, body, contentType });
  });
  const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    posts.push({ url, headers: init.headers, body: init.body });
    return { status: 200 };
  });
  return {
    puts,
    posts,
    putObject,
    fetchImpl,
    inbound: {
      appBaseUrl: 'http://app.local:8080',
      originSecret: 'the-secret',
      bucket: 'hc-local-inbound-mail-1',
      s3Endpoint: 'http://minio:9000',
      putObject,
      fetchImpl,
      ...over,
    },
  };
}

describe('buildInboundMime (hand-rolled MIME)', () => {
  it('builds a text/plain message with the required top-level headers + CRLF endings', () => {
    const mime = buildInboundMime({
      from: 'Marcus Bell <marcus@example.com>',
      to: ['inbound@mail.local.test'],
      subject: 'Question about the unit',
      text: 'Is it still available?',
      messageId: '<in-1@fake.inbound>',
    });
    expect(mime).toContain('From: Marcus Bell <marcus@example.com>');
    expect(mime).toContain('To: inbound@mail.local.test');
    expect(mime).toContain('Subject: Question about the unit');
    expect(mime).toContain('Message-ID: <in-1@fake.inbound>');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toMatch(/^Date: /m);
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).toContain('Is it still available?');
    // CRLF line endings throughout (a bare \n not preceded by \r would fail).
    expect(mime).toContain('\r\n');
    expect(mime).not.toMatch(/[^\r]\n/);
  });

  it('emits multipart/alternative with BOTH text and html parts when html is given', () => {
    const mime = buildInboundMime({
      from: 'a@b.c',
      to: ['inbound@mail.local.test'],
      subject: 'HTML mail',
      text: 'plain body',
      html: '<p>rich body</p>',
      messageId: '<in-2@fake.inbound>',
    });
    expect(mime).toContain('multipart/alternative');
    expect(mime).toMatch(/boundary="alternative_[0-9a-f]+"/);
    expect(mime).toContain('Content-Type: text/plain');
    expect(mime).toContain('Content-Type: text/html');
    expect(mime).toContain('<p>rich body</p>');
  });

  it('wraps attachments in multipart/mixed with a base64, disposition-attachment part', () => {
    const b64 = Buffer.from('hello attachment payload that is long enough to consider chunking '.repeat(3)).toString('base64');
    const mime = buildInboundMime({
      from: 'a@b.c',
      to: ['inbound@mail.local.test'],
      subject: 'With attachment',
      text: 'see attached',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', base64: b64 }],
      messageId: '<in-3@fake.inbound>',
    });
    expect(mime).toContain('multipart/mixed');
    expect(mime).toMatch(/boundary="mixed_[0-9a-f]+"/);
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain('Content-Disposition: attachment; filename="notes.txt"');
    // base64 lines are chunked at <= 76 chars.
    const longLine = mime.split('\r\n').find((l) => l.length > 76);
    expect(longLine).toBeUndefined();
  });
});

describe('MailEngine.sendInbound', () => {
  it('writes the MIME to MinIO and POSTs an SNS-shaped receipt with x-origin-verify', async () => {
    const s = stubInbound();
    const engine = new MailEngine({ hub: new EventHub(), inbound: s.inbound });
    const result = await engine.sendInbound({ from: 'sender@example.com', subject: 'Hi', text: 'body' });

    // 1. Wrote raw MIME to the inbound bucket under an inbound/<n>-<uuid>.eml key.
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.key).toMatch(/^inbound\/\d+-[0-9a-f-]+\.eml$/);
    expect(Buffer.isBuffer(s.puts[0]!.body)).toBe(true);
    expect(s.puts[0]!.body.toString('utf8')).toContain('Subject: Hi');
    expect(s.puts[0]!.contentType).toBe('message/rfc822');

    // 2. POSTed the SNS envelope to the app webhook with the origin secret.
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe('http://app.local:8080/webhooks/ses/inbound');
    expect(s.posts[0]!.headers['x-origin-verify']).toBe('the-secret');
    expect(s.posts[0]!.headers['content-type']).toMatch(/json/);
    const sns = JSON.parse(s.posts[0]!.body) as { Type: string; Message: string };
    expect(sns.Type).toBe('Notification');
    const inner = JSON.parse(sns.Message) as {
      notificationType: string;
      receipt: { action: { bucketName: string; objectKey: string }; spamVerdict: { status: string }; virusVerdict: { status: string } };
    };
    expect(inner.notificationType).toBe('Received');
    expect(inner.receipt.action.bucketName).toBe('hc-local-inbound-mail-1');
    expect(inner.receipt.action.objectKey).toBe(s.puts[0]!.key);
    expect(inner.receipt.spamVerdict.status).toBe('PASS');
    expect(inner.receipt.virusVerdict.status).toBe('PASS');

    // 3. Surfaces the app's response status for debuggability.
    expect(result).toMatchObject({ bucket: 'hc-local-inbound-mail-1', posted: true, appStatus: 200 });
    expect(result.key).toBe(s.puts[0]!.key);
  });

  it('passes spam/virus verdicts through to the SNS receipt', async () => {
    const s = stubInbound();
    const engine = new MailEngine({ hub: new EventHub(), inbound: s.inbound });
    await engine.sendInbound({ from: 'x@y.z', subject: 'Spammy', text: 'buy now', spamVerdict: 'FAIL', virusVerdict: 'FAIL' });
    const inner = JSON.parse((JSON.parse(s.posts[0]!.body) as { Message: string }).Message) as {
      receipt: { spamVerdict: { status: string }; virusVerdict: { status: string } };
    };
    expect(inner.receipt.spamVerdict.status).toBe('FAIL');
    expect(inner.receipt.virusVerdict.status).toBe('FAIL');
  });

  it('emits a mail.inbound hub event carrying the stored record', async () => {
    const s = stubInbound();
    const hub = new EventHub();
    const events: EngineEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const engine = new MailEngine({ hub, inbound: s.inbound });
    await engine.sendInbound({ from: 'a@b.c', subject: 'Hi', text: 'b' });
    const ev = events.find((e) => e.type === 'mail.inbound');
    expect(ev).toBeDefined();
    if (ev?.type === 'mail.inbound') {
      expect(ev.mail.from).toBe('a@b.c');
      expect(ev.mail.appStatus).toBe(200);
    }
  });

  it('throws when the inbound bucket is not configured', async () => {
    const s = stubInbound({ bucket: undefined });
    const engine = new MailEngine({ hub: new EventHub(), inbound: s.inbound });
    await expect(engine.sendInbound({ from: 'a@b.c', subject: 'x', text: 'y' })).rejects.toThrow();
  });
});

describe('POST /control/send-inbound-email', () => {
  function appWith(inbound: Record<string, unknown>) {
    const engine = new MailEngine({ hub: new EventHub(), inbound: inbound as never });
    const app = express();
    app.use(express.json());
    app.use(createSesControlRouter(engine));
    return app;
  }

  it('sends an inbound email and returns 200 { bucket, key, posted, appStatus }', async () => {
    const s = stubInbound();
    const res = await request(appWith(s.inbound))
      .post('/control/send-inbound-email')
      .send({ from: 'sender@example.com', subject: 'Hello', text: 'hi there' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bucket: 'hc-local-inbound-mail-1', posted: true, appStatus: 200 });
    expect(res.body.key).toMatch(/^inbound\//);
    expect(s.puts).toHaveLength(1);
    expect(s.posts).toHaveLength(1);
  });

  it('400s when from is missing', async () => {
    const s = stubInbound();
    const res = await request(appWith(s.inbound)).post('/control/send-inbound-email').send({ subject: 'x', text: 'y' });
    expect(res.status).toBe(400);
    expect(s.puts).toHaveLength(0);
  });

  it('502s when the send fails downstream (S3 put throws)', async () => {
    const s = stubInbound();
    s.inbound.putObject = vi.fn(async () => {
      throw new Error('minio unreachable');
    });
    const res = await request(appWith(s.inbound)).post('/control/send-inbound-email').send({ from: 'a@b.c', subject: 'x', text: 'y' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('minio');
  });
});

describe('MailEngine.emailDeliveryOutcome + POST /control/email-delivery-outcome', () => {
  function appWith(inbound: Record<string, unknown>) {
    const engine = new MailEngine({ hub: new EventHub(), inbound: inbound as never });
    const app = express();
    app.use(express.json());
    app.use(createSesControlRouter(engine));
    return app;
  }

  it('POSTs a Bounce SNS event (default Permanent) with x-origin-verify, no MinIO write', async () => {
    const s = stubInbound();
    const engine = new MailEngine({ hub: new EventHub(), inbound: s.inbound });
    const result = await engine.emailDeliveryOutcome({ sesMessageId: 'ses-fake-7', outcome: 'bounce' });

    expect(s.puts).toHaveLength(0); // an event carries no raw MIME
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe('http://app.local:8080/webhooks/ses/inbound');
    expect(s.posts[0]!.headers['x-origin-verify']).toBe('the-secret');
    const inner = JSON.parse((JSON.parse(s.posts[0]!.body) as { Message: string }).Message) as {
      eventType: string;
      mail: { messageId: string };
      bounce: { bounceType: string };
    };
    expect(inner.eventType).toBe('Bounce');
    expect(inner.mail.messageId).toBe('ses-fake-7');
    expect(inner.bounce.bounceType).toBe('Permanent');
    expect(result).toEqual({ posted: true, appStatus: 200 });
  });

  it('honors an explicit bounceType and maps delivered/complaint to the right eventType', async () => {
    const s = stubInbound();
    const engine = new MailEngine({ hub: new EventHub(), inbound: s.inbound });
    await engine.emailDeliveryOutcome({ sesMessageId: 'ses-1', outcome: 'bounce', bounceType: 'Transient' });
    await engine.emailDeliveryOutcome({ sesMessageId: 'ses-2', outcome: 'delivered' });
    await engine.emailDeliveryOutcome({ sesMessageId: 'ses-3', outcome: 'complaint' });
    const types = s.posts.map((p) => (JSON.parse((JSON.parse(p.body) as { Message: string }).Message) as { eventType: string }).eventType);
    expect(types).toEqual(['Bounce', 'Delivery', 'Complaint']);
    const bounceInner = JSON.parse((JSON.parse(s.posts[0]!.body) as { Message: string }).Message) as { bounce: { bounceType: string } };
    expect(bounceInner.bounce.bounceType).toBe('Transient');
  });

  it('route returns 200 { posted, appStatus }', async () => {
    const s = stubInbound();
    const res = await request(appWith(s.inbound))
      .post('/control/email-delivery-outcome')
      .send({ sesMessageId: 'ses-fake-1', outcome: 'bounce' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ posted: true, appStatus: 200 });
  });

  it('route 400s on a missing sesMessageId or a bad outcome', async () => {
    const s = stubInbound();
    const bad1 = await request(appWith(s.inbound)).post('/control/email-delivery-outcome').send({ outcome: 'bounce' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(appWith(s.inbound)).post('/control/email-delivery-outcome').send({ sesMessageId: 'ses-1', outcome: 'nope' });
    expect(bad2.status).toBe(400);
    expect(s.posts).toHaveLength(0);
  });
});
