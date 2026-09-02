import { isE164 } from '../lib/phone.js';
import type { MessageTransport } from '../lib/messageTransport.js';

export interface TwilioTransportEvidenceInput {
  direction: 'inbound' | 'outbound';
  requestedTransport?: MessageTransport;
  messageSid?: string;
  from?: string;
  to?: string;
  channelPrefix?: string;
  channelMetadata?: string;
  authenticatedProviderTraffic: boolean;
}

export type NormalizedTransportEvidence =
  | { kind: 'observed'; transport: MessageTransport; source: string }
  | { kind: 'missing'; source: string }
  | {
      kind: 'conflict';
      source: string;
      safeFacts: { sidPrefix?: string; fromScheme?: string; channelScheme?: string };
    };

const MESSAGE_SID_RE = /^(SM|MM)[0-9a-fA-F]{32}$/;
const PROVIDER_SHAPED_SID_RE = /^([A-Za-z]{2})[0-9a-fA-F]{32}$/;
const SAFE_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}$/;

type ChannelMetadataEvidence = 'absent' | 'rcs' | 'unknown' | 'malformed';

function parseChannelMetadata(raw: string | undefined): ChannelMetadataEvidence {
  if (raw === undefined || raw.trim().length === 0) return 'absent';

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'unknown';
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === 'rcs') return 'rcs';
    return 'unknown';
  } catch {
    return 'malformed';
  }
}

function safeScheme(value: string | undefined, requireColon: boolean): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const colon = trimmed.indexOf(':');
  if (requireColon && colon <= 0) return undefined;
  const scheme = (colon < 0 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  return SAFE_SCHEME_RE.test(scheme) ? scheme : undefined;
}

function safeSidPrefix(messageSid: string | undefined): string | undefined {
  if (messageSid === undefined) return undefined;
  return PROVIDER_SHAPED_SID_RE.exec(messageSid)?.[1]?.toUpperCase();
}

function conflict(
  input: TwilioTransportEvidenceInput,
  source: string,
): NormalizedTransportEvidence {
  if (!input.authenticatedProviderTraffic) {
    return { kind: 'missing', source: 'unauthenticated-provider-evidence' };
  }

  const safeFacts = {
    sidPrefix: safeSidPrefix(input.messageSid),
    fromScheme: safeScheme(input.from, true),
    channelScheme: safeScheme(input.channelPrefix, false),
  };

  return {
    kind: 'conflict',
    source,
    safeFacts: Object.fromEntries(
      Object.entries(safeFacts).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };
}

function messageSidTransport(messageSid: string | undefined): MessageTransport | undefined {
  const match = messageSid === undefined ? null : MESSAGE_SID_RE.exec(messageSid);
  if (match?.[1] === 'SM') return 'sms';
  if (match?.[1] === 'MM') return 'mms';
  return undefined;
}

/**
 * Normalizes only provider-documented evidence. The SID rule is corroborated by:
 * https://www.twilio.com/docs/rcs/send-an-rcs-message
 * https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url
 * https://www.twilio.com/docs/messaging/guides/webhook-request
 * https://help.twilio.com/articles/223134387
 *
 * SM/MM classify Twilio Message-resource creation, not general delivery transport.
 */
export function normalizeTwilioTransportEvidence(
  input: TwilioTransportEvidenceInput,
): NormalizedTransportEvidence {
  const metadata = parseChannelMetadata(input.channelMetadata);
  const hasChannelMetadata = input.channelMetadata !== undefined && input.channelMetadata.trim().length > 0;
  const channelPrefix = input.channelPrefix?.trim();
  const hasChannelPrefix = channelPrefix !== undefined && channelPrefix.length > 0;
  const fromScheme = safeScheme(input.from, true);

  if (metadata === 'malformed') {
    return conflict(input, 'malformed-channel-metadata');
  }
  if (metadata === 'unknown') {
    return conflict(input, 'unknown-rich-channel-evidence');
  }
  if (hasChannelPrefix && channelPrefix !== 'rcs') {
    return conflict(input, 'unknown-rich-channel-evidence');
  }
  if (fromScheme !== undefined && fromScheme !== 'rcs') {
    return conflict(input, 'unknown-rich-channel-evidence');
  }

  if (metadata === 'rcs') {
    return { kind: 'observed', transport: 'rcs', source: 'channel-metadata' };
  }
  if (fromScheme === 'rcs') {
    return { kind: 'observed', transport: 'rcs', source: 'from' };
  }
  if (channelPrefix === 'rcs') {
    if (input.from === undefined || input.from.trim().length === 0) {
      return { kind: 'observed', transport: 'rcs', source: 'channel-prefix' };
    }
    return conflict(input, 'contradictory-rich-channel-evidence');
  }

  const sidTransport = messageSidTransport(input.messageSid);
  if (sidTransport === undefined) {
    if (safeSidPrefix(input.messageSid) !== undefined) {
      return conflict(input, 'unknown-message-sid');
    }
    return {
      kind: 'missing',
      source: input.messageSid === undefined ? 'missing-provider-evidence' : 'fixture-message-sid',
    };
  }

  if (hasChannelPrefix || hasChannelMetadata) {
    return { kind: 'missing', source: 'unresolved-channel-evidence' };
  }

  if (input.direction === 'inbound') {
    if (input.to === undefined || input.to.trim().length === 0) {
      return { kind: 'missing', source: 'missing-inbound-endpoint' };
    }
    if (!isE164(input.to)) {
      return conflict(input, 'invalid-inbound-endpoint');
    }
    return { kind: 'observed', transport: sidTransport, source: 'message-sid' };
  }

  if (input.requestedTransport === 'sms' || input.requestedTransport === 'mms') {
    return { kind: 'observed', transport: sidTransport, source: 'message-sid' };
  }
  if (input.requestedTransport !== 'rcs') {
    return { kind: 'missing', source: 'missing-request-context' };
  }
  if (input.from === undefined || input.from.trim().length === 0) {
    return { kind: 'missing', source: 'ambiguous-rcs-fallback' };
  }
  if (!isE164(input.from)) {
    return conflict(input, 'invalid-fallback-endpoint');
  }
  return { kind: 'observed', transport: sidTransport, source: 'message-sid' };
}
