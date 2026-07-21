// Inbound email MIME handling (email-channel B2) - the ONLY file importing
// mailparser, sanitize-html, and email-reply-parser (adapter rule, mirroring
// adapters/extraction.ts for the Anthropic SDK and adapters/mediaStore.ts for
// the S3 SDK). Everything downstream - the inbound-email ingestion service and
// its tests - depends on these four pure functions, never on the libraries.
//
// PII (plan F18): nothing here logs; callers must never log addresses, subjects
// or bodies (ids/keys only).
import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import sanitizeHtmlLib from 'sanitize-html';
// email-reply-parser@2.x is native ESM with a true `export default` class, so
// under NodeNext this default import IS the constructor at type-check time AND
// runtime (the quoted-reply test in emailMime.test.ts is the runtime proof).
// Older releases were CJS with an `exports.default` interop shim that needed
// `require('email-reply-parser').default`; a downgrade would fail that test.
import EmailReplyParser from 'email-reply-parser';

/**
 * simpleParser HTML-parse bound (plan F17 DoS point 2): a hostile mail with a
 * multi-hundred-MB HTML part must not be tokenized wholesale. 2 MB parsed HTML
 * is far beyond any legitimate correspondence.
 */
export const MAX_HTML_PARSE_LENGTH = 2 * 1024 * 1024;

/** The parsed shape the ingestion service routes on (plan Task B2 interface). */
export interface ParsedInboundEmail {
  /**
   * The RFC Message-ID INCLUDING angle brackets (mailparser's form), e.g.
   * `<abc@example.com>`. When the header is missing, a DETERMINISTIC synthetic
   * id `<sha256(raw)@synthesized.local>` - same bytes, same id - so the
   * rfc-level dedupe still holds across redeliveries of an id-less mail.
   */
  rfcMessageId: string;
  inReplyTo?: string;
  references: string[];
  from: { name?: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  /** Plain-text body; mailparser derives it from the HTML part when there is
   *  no text part. Empty string when the mail has neither. */
  text: string;
  /** Raw (UNSANITIZED) HTML body when present - sanitize before storing. */
  html?: string;
  attachments: { filename: string; contentType: string; content: Buffer; size: number }[];
}

/** Flatten mailparser's AddressObject (or array of them, one per header line)
 *  into a plain address list. RFC group syntax nests members one level down. */
function flattenAddresses(obj: AddressObject | AddressObject[] | undefined): string[] {
  if (obj === undefined) return [];
  const objects = Array.isArray(obj) ? obj : [obj];
  const out: string[] = [];
  for (const o of objects) {
    for (const entry of o.value) {
      if (typeof entry.address === 'string' && entry.address.length > 0) {
        out.push(entry.address);
      }
      if (Array.isArray(entry.group)) {
        for (const member of entry.group) {
          if (typeof member.address === 'string' && member.address.length > 0) {
            out.push(member.address);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Parse a raw RFC 5322 message. The caller (services/inboundEmail.ts) owns the
 * outer bounds - the 30 MB raw-size head-check, the 30 s timeout race, and the
 * 50-attachment cap; this function owns the in-parser HTML bound.
 */
export async function parseInboundMime(rawMime: Buffer): Promise<ParsedInboundEmail> {
  const parsed = await simpleParser(rawMime, { maxHtmlLengthToParse: MAX_HTML_PARSE_LENGTH });

  const rfcMessageId =
    parsed.messageId ??
    `<${createHash('sha256').update(rawMime).digest('hex')}@synthesized.local>`;

  const fromEntry = parsed.from?.value?.[0];
  const fromName = typeof fromEntry?.name === 'string' ? fromEntry.name.trim() : '';
  const from: ParsedInboundEmail['from'] = {
    address: typeof fromEntry?.address === 'string' ? fromEntry.address : '',
    ...(fromName.length > 0 && { name: fromName }),
  };

  // mailparser yields `references` as a string for ONE reference and an array
  // for several - normalize to an array.
  const references =
    parsed.references === undefined
      ? []
      : Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references];

  const attachments = parsed.attachments.map((a, i) => ({
    filename:
      typeof a.filename === 'string' && a.filename.length > 0 ? a.filename : `attachment-${i}`,
    contentType: a.contentType,
    content: a.content,
    size: a.size,
  }));

  return {
    rfcMessageId,
    ...(parsed.inReplyTo !== undefined && { inReplyTo: parsed.inReplyTo }),
    references,
    from,
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    ...(typeof parsed.html === 'string' && parsed.html.length > 0 && { html: parsed.html }),
    attachments,
  };
}

/**
 * Sanitize inbound HTML ONCE, at ingest (plan F16 defense-in-depth: the stored
 * `email_html_sanitized` is already safe; B7's sandboxed iframe + CSP is the
 * render-time guarantee). The config: sanitize-html defaults plus `img`, with
 * allowedSchemes ['data','cid'] - strips <script>, event handlers (never in any
 * allow-list) and javascript: hrefs. For images ONLY data:/cid: inline sources
 * survive; every REMOTE form is dropped so no tracker can fetch off the stored
 * copy: http(s) src by the scheme allow-list, PROTOCOL-RELATIVE `//host/x` src
 * by allowProtocolRelative:false (a scheme-less URL otherwise bypasses the
 * scheme check), and `srcset` by dropping it from img's allowed attributes (a
 * second place a remote ref hides). Note: the default allowedAttributes strip
 * `style` entirely, so no inline styling is retained here (the render CSP's
 * style-src is therefore moot - see EmailHtmlFrame).
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtmlLib(html, {
    allowedTags: sanitizeHtmlLib.defaults.allowedTags.concat(['img']),
    allowedSchemes: ['data', 'cid'],
    allowProtocolRelative: false,
    allowedAttributes: {
      ...sanitizeHtmlLib.defaults.allowedAttributes,
      // img keeps `src` (data:/cid: only) + harmless descriptors; NO `srcset`.
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
  });
}

// One parser instance - stateless (read() constructs a fresh Email each call).
const replyParser = new EmailReplyParser();

/**
 * The VISIBLE part of a reply (quoted history + signature markers stripped),
 * trimmed. Falls back to the full trimmed text when the parser yields nothing
 * (an all-quote mail must not store an empty body) or throws on hostile input.
 */
export function visibleReplyText(text: string): string {
  try {
    const visible = replyParser.read(text).getVisibleText().trim();
    if (visible.length > 0) return visible;
  } catch {
    // fall through to the full text
  }
  return text.trim();
}

/**
 * Find a conversation reply token among recipient addresses: our outbound
 * Reply-To is `relay+<token>@<senderDomain>` (A5), so an inbound reply carries
 * it in To/Cc. The `relay+` prefix and the domain match case-insensitively;
 * the token itself is returned VERBATIM (tokens are case-sensitive base64url).
 * Undefined when no recipient matches.
 */
export function extractReplyToken(addresses: string[], senderDomain: string): string | undefined {
  const domain = senderDomain.trim().toLowerCase();
  if (domain.length === 0) return undefined;
  for (const addr of addresses) {
    const at = addr.lastIndexOf('@');
    if (at <= 0) continue;
    if (addr.slice(at + 1).trim().toLowerCase() !== domain) continue;
    const local = addr.slice(0, at).trim();
    if (!/^relay\+/i.test(local)) continue;
    const token = local.slice('relay+'.length);
    if (token.length > 0) return token;
  }
  return undefined;
}
