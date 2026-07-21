// EmailAdapter - the ONLY place `@aws-sdk/client-sesv2` and
// `nodemailer/lib/mail-composer` are imported (adapter rule, mirroring
// adapters/extraction.ts for the Anthropic SDK and adapters/messaging.ts for
// the Twilio SDK). Everything downstream depends on the EmailAdapter interface
// + the OutboundEmail type declared here, never on the SES SDK or nodemailer
// directly.
//
// Two drivers:
// - ses:     composes raw MIME (mail-composer) with the threading headers set
//            EXPLICITLY, then SESv2 SendEmail with Content.Raw (SES derives the
//            envelope from the MIME headers). Prod path.
// - console: logs a one-line COUNT-only summary (no body/subject/addresses -
//            PII posture, mirroring ConsoleMessagingDriver) and returns a fake
//            SESconsole-<uuid> id so `npm run dev` stays fully offline.
import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand, type SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** One outbound email, provider-agnostic. Addresses are already normalized by
 *  the caller (Phase A5); this adapter only composes + sends. */
export interface OutboundEmail {
  from: { name: string; address: string };
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  /** Plain-text body (v1 outbound is text-only; inbound HTML is Phase B). */
  text: string;
  /** RFC Message-ID header, WITH angle brackets, e.g. `<hc-<ulid>@domain>`. */
  messageIdHeader: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

export interface EmailAdapter {
  readonly kind: 'ses' | 'console';
  send(mail: OutboundEmail): Promise<{ providerMessageId: string }>;
}

/** The minimal SESv2 send surface the ses driver needs - lets tests inject a
 *  capturing stub without reaching for the SDK. The real SESv2Client satisfies
 *  it (its `send` accepts any command and resolves that command's output). */
export interface SesSendClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

/** Compose the full raw MIME message. Threading + Reply-To headers are set
 *  EXPLICITLY via mail-composer's options (it maps them to Message-ID /
 *  In-Reply-To / References / Reply-To headers); From renders as the display
 *  name + address; attachments carry filename + content-type + bytes.
 *  Exported so the header-injection test (Q1) can exercise the real composer. */
export async function composeRawMime(mail: OutboundEmail): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: mail.from.name, address: mail.from.address },
    to: mail.to,
    ...(mail.cc && mail.cc.length > 0 ? { cc: mail.cc } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    subject: mail.subject,
    text: mail.text,
    messageId: mail.messageIdHeader,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
    ...(mail.references && mail.references.length > 0 ? { references: mail.references } : {}),
    ...(mail.attachments && mail.attachments.length > 0
      ? {
          attachments: mail.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
          })),
        }
      : {}),
  });
  return composer.compile().build();
}

class SesEmailDriver implements EmailAdapter {
  readonly kind = 'ses' as const;
  private readonly client: SesSendClient;
  private readonly log: Logger;

  constructor(opts: { config: AppConfig; logger?: Logger; client?: SesSendClient }) {
    this.log = opts.logger ?? defaultLogger;
    // Constructed ONCE per driver instance (mirrors the Twilio/Anthropic
    // adapters). The endpoint override redirects to the fake-SES host locally;
    // config rejects SES_API_BASE_URL in production, so it is undefined there.
    this.client =
      opts.client ??
      new SESv2Client({
        region: opts.config.awsRegion,
        ...(opts.config.sesApiBaseUrl ? { endpoint: opts.config.sesApiBaseUrl } : {}),
      });
  }

  async send(mail: OutboundEmail): Promise<{ providerMessageId: string }> {
    const raw = await composeRawMime(mail);
    const result = await this.client.send(new SendEmailCommand({ Content: { Raw: { Data: raw } } }));
    if (!result.MessageId) {
      // A 2xx SendEmail without a MessageId is anomalous; fail loudly rather
      // than persist an empty provider id (A5 marks the message failed).
      throw new Error('SES SendEmail returned no MessageId');
    }
    return { providerMessageId: result.MessageId };
  }
}

class ConsoleEmailDriver implements EmailAdapter {
  readonly kind = 'console' as const;
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? defaultLogger;
  }

  async send(mail: OutboundEmail): Promise<{ providerMessageId: string }> {
    // Redacted by design: COUNTS + lengths only - never the addresses,
    // subject, or body (PII), mirroring ConsoleMessagingDriver.
    this.log.info(
      {
        toCount: mail.to.length,
        ccCount: mail.cc?.length ?? 0,
        subjectLength: mail.subject.length,
        attachmentCount: mail.attachments?.length ?? 0,
        bodyLength: mail.text.length,
      },
      'console email driver: email "sent"',
    );
    return { providerMessageId: `SESconsole-${randomUUID()}` };
  }
}

export function createEmailAdapter(deps: {
  config: AppConfig;
  logger: Logger;
  /** Optional injected SES client (tests supply a capturing stub); the ses
   *  driver constructs a real SESv2Client when absent. */
  sesClient?: SesSendClient;
}): EmailAdapter {
  const { config, logger } = deps;
  switch (config.emailDriver) {
    case 'console':
      return new ConsoleEmailDriver({ logger });
    case 'ses': {
      // loadConfig already gates the ses driver on both values; throw
      // defensively so a hand-built config can never yield a From-less driver.
      if (!config.emailFromAddress || !config.emailSenderDomain) {
        throw new Error(
          'createEmailAdapter: driver "ses" requires config.emailFromAddress + config.emailSenderDomain',
        );
      }
      return new SesEmailDriver({
        config,
        logger,
        ...(deps.sesClient ? { client: deps.sesClient } : {}),
      });
    }
    default: {
      const exhaustive: never = config.emailDriver;
      throw new Error(`createEmailAdapter: unknown email driver ${String(exhaustive)}`);
    }
  }
}
