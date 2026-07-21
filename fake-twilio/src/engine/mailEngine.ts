// fake-twilio/src/engine/mailEngine.ts
//
// The fake-SES engine: captures the app's outbound SESv2 SendEmail (raw MIME),
// string-scans the top-level headers we care about (To/Cc/Subject/Message-ID),
// stores the record, and emits a `mail.outbound` hub event. Constructed with the
// SAME shared EventHub as the messaging + call engines (server.ts) so its events
// reach the SSE stream by construction.
//
// A deliberately DUMB, deterministic test double: NO mailparser (ADJ-10 - it is an
// app-only dep, unreachable here), header parsing is a minimal string scan with
// just enough folding / addr-spec handling for the nodemailer-composed MIME the app
// sends. sesMessageId is a monotonic `ses-fake-<n>` counter so tests are stable.
import type { EventHub } from './eventHub.js';
import { MailStore, type StoredEmail } from './mailStore.js';

/** Unfold the TOP-LEVEL header block of a raw MIME string into one line per header.
 *  Headers end at the FIRST blank line; anything after (the body, including a MIME
 *  part's own `Content-Type: image/png`) is NOT scanned as a top-level header. RFC
 *  5322 folding: a line beginning with WSP (space/tab) continues the previous
 *  header, so it is joined back on. */
function topLevelHeaderLines(rawMime: string): string[] {
  const normalized = rawMime.replace(/\r\n/g, '\n');
  const blank = normalized.indexOf('\n\n');
  const headerBlock = blank === -1 ? normalized : normalized.slice(0, blank);
  const unfolded: string[] = [];
  for (const line of headerBlock.split('\n')) {
    const prevIndex = unfolded.length - 1;
    const prev = unfolded[prevIndex];
    if (/^[ \t]/.test(line) && prev !== undefined) {
      unfolded[prevIndex] = `${prev} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** First header value matching `name` (case-insensitive), or undefined. */
function headerValue(lines: string[], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === lower) {
      return line.slice(idx + 1).trim();
    }
  }
  return undefined;
}

/** Comma-split an address header into bare addr-specs. Pulls the `<addr>` out of a
 *  `Name <addr>` form; otherwise takes the trimmed token. Empty entries dropped.
 *  Pragmatic (a display name containing a literal comma would over-split) - fine
 *  for a local test double; the app never composes such addresses in e2e. */
function splitAddresses(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((part) => {
      const inner = part.match(/<([^>]+)>/)?.[1];
      return (inner ?? part).trim();
    })
    .filter((addr) => addr.length > 0);
}

export interface MailEngineDeps {
  /** The shared event bus - `mail.outbound` events reach the SSE stream through it. */
  hub: EventHub;
  /** Injectable for tests; defaults to a fresh store. */
  store?: MailStore;
}

export class MailEngine {
  private readonly hub: EventHub;
  private readonly store: MailStore;
  private seq = 0;

  constructor(deps: MailEngineDeps) {
    this.hub = deps.hub;
    this.store = deps.store ?? new MailStore();
  }

  /** Capture an outbound SESv2 SendEmail whose Content.Raw.Data is `rawMimeBase64`.
   *  Decodes it, string-scans the headers, stores the record, emits `mail.outbound`,
   *  and returns the stored record (its sesMessageId is echoed back as MessageId). */
  recordOutbound(rawMimeBase64: string): StoredEmail {
    const rawMime = Buffer.from(rawMimeBase64, 'base64').toString('utf8');
    const headers = topLevelHeaderLines(rawMime);
    const messageIdHeader = headerValue(headers, 'message-id');
    this.seq += 1;
    const email: StoredEmail = {
      sesMessageId: `ses-fake-${this.seq}`,
      rawMime,
      to: splitAddresses(headerValue(headers, 'to')),
      cc: splitAddresses(headerValue(headers, 'cc')),
      subject: headerValue(headers, 'subject') ?? '',
      ...(messageIdHeader !== undefined && { messageIdHeader }),
      receivedAt: new Date().toISOString(),
      state: 'sent',
    };
    this.store.add(email);
    this.hub.emit({ type: 'mail.outbound', mail: email });
    return email;
  }

  /** All captured emails, newest first (the `GET /control/emails` payload). */
  list(): StoredEmail[] {
    return this.store.list();
  }

  /** Clear the mail store - the DISJOINT `POST /control/reset-mail` surface. */
  reset(): void {
    this.store.reset();
  }
}
