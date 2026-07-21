// app/test/emailAdapter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import {
  composeRawMime,
  createEmailAdapter,
  type OutboundEmail,
  type SesSendClient,
} from '../src/adapters/email.js';
import type { Logger } from '../src/lib/logger.js';

// A ses-driver config (dev NODE_ENV + explicit driver + sender identity so the
// boot gate passes). No real SES client is ever constructed - the test injects
// a capturing stub.
function sesConfig() {
  return loadConfig({
    CF_ORIGIN_SECRET: 's',
    NODE_ENV: 'development',
    EMAIL_DRIVER: 'ses',
    EMAIL_SENDER_DOMAIN: 'mail.local.test',
    EMAIL_FROM_ADDRESS: 'team@mail.local.test',
  });
}

// Default console driver (dev NODE_ENV, no EMAIL_DRIVER override).
function consoleConfig() {
  return loadConfig({ CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' });
}

const ATTACHMENT_BYTES = Buffer.from('%PDF-1.4 fake pdf bytes');

const baseMail: OutboundEmail = {
  from: { name: 'Sam at Housing Choice', address: 'team@mail.local.test' },
  to: ['landlord@example.com', 'second@example.com'],
  cc: ['cc1@example.com'],
  replyTo: 'relay+tok123@mail.local.test',
  subject: 'Welcome to the unit',
  text: 'Hello here is the info you asked for.',
  messageIdHeader: '<hc-01ABCXYZ@mail.local.test>',
  inReplyTo: '<their-prior-id@gmail.com>',
  references: ['<root-thread@gmail.com>', '<their-prior-id@gmail.com>'],
  attachments: [{ filename: 'lease.pdf', contentType: 'application/pdf', content: ATTACHMENT_BYTES }],
};

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('createEmailAdapter - ses driver', () => {
  it('composes raw MIME with every header + the attachment and returns the SES MessageId', async () => {
    let captured: Parameters<SesSendClient['send']>[0] | undefined;
    const stub: SesSendClient = {
      send: async (command) => {
        captured = command;
        return { MessageId: 'ses-msg-0001', $metadata: {} };
      },
    };
    const adapter = createEmailAdapter({ config: sesConfig(), logger: silentLogger, sesClient: stub });
    expect(adapter.kind).toBe('ses');

    const result = await adapter.send(baseMail);
    expect(result.providerMessageId).toBe('ses-msg-0001');

    expect(captured).toBeDefined();
    const data = captured?.input.Content?.Raw?.Data;
    expect(data).toBeDefined();
    const mime = Buffer.from(data as Uint8Array).toString('utf8');

    // Explicit headers set by the adapter.
    expect(mime).toContain('Subject: Welcome to the unit');
    expect(mime).toContain('Message-ID: <hc-01ABCXYZ@mail.local.test>');
    expect(mime).toContain('In-Reply-To: <their-prior-id@gmail.com>');
    expect(mime).toContain('References:');
    expect(mime).toContain('<root-thread@gmail.com>');
    expect(mime).toContain('Reply-To: relay+tok123@mail.local.test');

    // From carries the display name + address.
    expect(mime).toContain('Sam at Housing Choice');
    expect(mime).toContain('team@mail.local.test');

    // Multiple To recipients + Cc.
    expect(mime).toContain('landlord@example.com');
    expect(mime).toContain('second@example.com');
    expect(mime).toContain('cc1@example.com');

    // Attachment: content-type + filename + base64 content all present.
    expect(mime).toContain('application/pdf');
    expect(mime).toContain('lease.pdf');
    expect(mime).toContain(ATTACHMENT_BYTES.toString('base64'));

    // Text body.
    expect(mime).toContain('Hello here is the info you asked for.');
  });

  it('sends ONLY Content.Raw.Data (SES derives the envelope from the MIME headers)', async () => {
    let captured: Parameters<SesSendClient['send']>[0] | undefined;
    const stub: SesSendClient = {
      send: async (command) => {
        captured = command;
        return { MessageId: 'ses-msg-0002', $metadata: {} };
      },
    };
    const adapter = createEmailAdapter({ config: sesConfig(), logger: silentLogger, sesClient: stub });
    await adapter.send({ ...baseMail, cc: undefined, inReplyTo: undefined, references: undefined, attachments: undefined });
    expect(captured?.input.Content?.Raw).toBeDefined();
    expect(captured?.input.Content?.Simple).toBeUndefined();
  });

  it('throws when SES returns no MessageId', async () => {
    const stub: SesSendClient = { send: async () => ({ $metadata: {} }) };
    const adapter = createEmailAdapter({ config: sesConfig(), logger: silentLogger, sesClient: stub });
    await expect(adapter.send(baseMail)).rejects.toThrow(/MessageId/);
  });
});

describe('createEmailAdapter - ses driver ConfigurationSetName (email-channel B5)', () => {
  it('sets ConfigurationSetName on SendEmail when config.emailConfigurationSet is present', async () => {
    let captured: Parameters<SesSendClient['send']>[0] | undefined;
    const stub: SesSendClient = {
      send: async (command) => {
        captured = command;
        return { MessageId: 'ses-msg-cs', $metadata: {} };
      },
    };
    const config = { ...sesConfig(), emailConfigurationSet: 'hc-dev-mail' };
    const adapter = createEmailAdapter({ config, logger: silentLogger, sesClient: stub });
    await adapter.send(baseMail);
    // The configuration set routes bounce/complaint/delivery events to the SNS
    // topic - without it the B5 event pipeline never receives anything.
    expect(captured?.input.ConfigurationSetName).toBe('hc-dev-mail');
  });

  it('omits ConfigurationSetName when config.emailConfigurationSet is unset', async () => {
    let captured: Parameters<SesSendClient['send']>[0] | undefined;
    const stub: SesSendClient = {
      send: async (command) => {
        captured = command;
        return { MessageId: 'ses-msg-nocs', $metadata: {} };
      },
    };
    const adapter = createEmailAdapter({ config: sesConfig(), logger: silentLogger, sesClient: stub });
    await adapter.send(baseMail);
    expect(captured?.input.ConfigurationSetName).toBeUndefined();
  });
});

describe('composeRawMime - header injection (Q1)', () => {
  it('never lets CR/LF in subject or from.name inject a header line', async () => {
    const raw = await composeRawMime({
      from: { name: 'A\r\nX-Evil: 1', address: 'team@mail.local.test' },
      to: ['a@b.co'],
      subject: 'Hi\r\nBcc: victim@x.com',
      text: 'x',
      messageIdHeader: '<i@mail.local.test>',
    });
    const mime = raw.toString('utf8');
    // No line in the built MIME may START with an injected header the attacker
    // tried to smuggle in via a bare CR/LF in a header value.
    for (const line of mime.split(/\r?\n/)) {
      expect(line.startsWith('Bcc:')).toBe(false);
      expect(line.startsWith('X-Evil:')).toBe(false);
    }
  });
});

describe('createEmailAdapter - console driver', () => {
  it('returns an SESconsole-* id and logs COUNTS ONLY (no body/subject/address PII)', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const adapter = createEmailAdapter({ config: consoleConfig(), logger });
    expect(adapter.kind).toBe('console');

    const result = await adapter.send(baseMail);
    expect(result.providerMessageId).toMatch(/^SESconsole-/);

    expect(info).toHaveBeenCalledTimes(1);
    const payload = info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      toCount: 2,
      ccCount: 1,
      subjectLength: baseMail.subject.length,
      attachmentCount: 1,
      bodyLength: baseMail.text.length,
    });

    // PII posture: the logged object carries NO addresses, subject, or body.
    expect(payload).not.toHaveProperty('to');
    expect(payload).not.toHaveProperty('cc');
    expect(payload).not.toHaveProperty('subject');
    expect(payload).not.toHaveProperty('text');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('landlord@example.com');
    expect(serialized).not.toContain('cc1@example.com');
    expect(serialized).not.toContain('Welcome to the unit');
    expect(serialized).not.toContain('Hello here is the info');
  });

  it('mints a distinct providerMessageId per send', async () => {
    const adapter = createEmailAdapter({ config: consoleConfig(), logger: silentLogger });
    const a = await adapter.send(baseMail);
    const b = await adapter.send(baseMail);
    expect(a.providerMessageId).not.toBe(b.providerMessageId);
  });
});
