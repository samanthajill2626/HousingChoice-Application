// fake-twilio/src/routes/rest.ts
import { Router } from 'express';
import { messageResourceFrom, type FakeTwilioEngine } from '../engine/engine.js';
import type { ThreadMessage } from '../engine/types.js';

/** First string value of a param that may arrive as a string or (repeated) string[]. */
function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === 'string');
  return undefined;
}

/**
 * Normalize the MediaUrl param to a string[]. The Twilio SDK sends ONE MediaUrl
 * param per attachment; Express's urlencoded parser surfaces a single value as a
 * string and repeated values as a string[]. Accept both so a multi-attachment
 * send records every URL faithfully (single string still works). Returns
 * undefined when there is no media so num_media stays '0'.
 */
export function normalizeMediaUrls(v: string | string[] | undefined): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) {
    const urls = v.filter((x): x is string => typeof x === 'string');
    return urls.length > 0 ? urls : undefined;
  }
  return undefined;
}

/**
 * The punctuation Twilio's Smart Encoding rewrites in a STORED message body
 * (send-outcome spec Sec 1: ON for the Messaging Service, so the reconcile
 * compares bodies after a lossy normalization, D13). Applied ONLY when a list
 * or fetch serializes a resource: the create response echoes what was
 * submitted, and the thread store (the phones UI, e2e getOutboundTo) keeps the
 * submitted body verbatim.
 */
const SMART_ENCODING: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u00a0': ' ',
};
const SMART_ENCODED_CHAR = new RegExp(`[${Object.keys(SMART_ENCODING).join('')}]`, 'g');

/** A body as Twilio stores it under Smart Encoding (the table above). */
export function smartEncode(body: string): string {
  return body.replace(SMART_ENCODED_CHAR, (c) => SMART_ENCODING[c] ?? c);
}

/** RFC 2822 in Twilio's spelling ("Mon, 15 Jun 2026 00:00:00 +0000"), whole seconds. */
export function rfc2822(iso: string): string {
  return new Date(iso).toUTCString().replace(/GMT$/, '+0000');
}

function accountPath(accountSid: string): string {
  return `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
}

/**
 * A stored message as a Twilio Message resource (snake_case, the shape
 * twilio-node deserializes; build-research spike "Task 11" rules 5-7). ONE
 * clock per message: `date_created` is the stored createdAt and `date_sent`
 * the stored sentAt - an EXPLICIT null while queued, because twilio-node reads
 * an omitted date as NOW. `num_media` is a string, `error_code` an int or null.
 * The body is Smart-Encoded the way Twilio stores it.
 */
export function toMessageResource(m: ThreadMessage, accountSid: string): Record<string, unknown> {
  const inbound = m.direction === 'inbound';
  const errorCode = Number(m.errorCode);
  // An inbound message was received, never queued: its createdAt is its date_sent.
  const sentAt = m.sentAt ?? (inbound ? m.createdAt : undefined);
  return {
    sid: m.sid,
    account_sid: accountSid,
    status: inbound ? 'received' : m.state,
    to: m.to,
    from: messageResourceFrom(m),
    body: smartEncode(m.body ?? ''),
    num_media: String(m.mediaUrls?.length ?? 0),
    error_code: m.errorCode !== undefined && Number.isInteger(errorCode) && errorCode > 0 ? errorCode : null,
    date_created: rfc2822(m.createdAt),
    date_sent: sentAt === undefined ? null : rfc2822(sentAt),
    date_updated: rfc2822(m.updatedAt),
    messaging_service_sid: m.messagingServiceSid ?? null,
    direction: inbound ? 'inbound' : 'outbound-api',
    uri: `${accountPath(accountSid)}/Messages/${encodeURIComponent(m.sid)}.json`,
  };
}

/** Twilio's Messages list page size: 50 unless asked, at most 1000. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;

/** The effective page size: PageSize when it is a positive integer (capped), else the default. */
function pageSizeOf(v: unknown): number {
  const raw = firstString(v);
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

/** PageToken: the fake's own integer offset into the newest-first list (0 when absent). */
function pageTokenOf(v: unknown): number {
  const raw = firstString(v);
  const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

/** fail-next-send `reject` without a chosen code: Twilio's "invalid To number". */
const DEFAULT_REJECT_CODE = 21211;

/** What an armed fail-list list or fetch answers (a RestException 500 / 20500 to the SDK). */
const FAIL_LIST_ERROR = {
  code: 20500,
  message: 'fail-list: provider unavailable',
  more_info: 'https://www.twilio.com/docs/errors/20500',
  status: 500,
} as const;

/**
 * Twilio REST impersonation: only the subset the app's driver calls. Every
 * error body is `{ code, message, more_info, status }`, which twilio-node turns
 * into a RestException with a numeric code and status (never give one a string
 * `type` AND `title`: the SDK then throws a different exception class).
 */
export function createRestRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  // POST /2010-04-01/Accounts/:accountSid/Messages.json  (messages.create)
  router.post('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    // Body values are usually strings, but a MULTI-attachment send repeats the
    // MediaUrl param, which Express's urlencoded parser collapses into an array.
    const body = (req.body ?? {}) as Record<string, string | string[]>;
    const to = firstString(body['To']);
    if (!to) {
      // Twilio-shaped error: the real SDK builds a RestException from { code,
      // message, more_info, status } on non-2xx. `more_info` keeps its parser happy.
      res.status(400).json({
        code: 21604,
        message: "A 'To' phone number is required.",
        more_info: 'https://www.twilio.com/docs/errors/21604',
        status: 400,
      });
      return;
    }
    // fail-next-send (spec D19): one arming is consumed per create TO the armed
    // party. reject and drop_before_create end the create before anything is
    // recorded (a delivery profile armed for the party stays armed, T11-6).
    const failure = engine.takeFailNextSend(to);
    if (failure?.mode === 'reject') {
      const code = failure.code ?? DEFAULT_REJECT_CODE;
      res.status(400).json({
        code,
        message: 'fail-next-send: rejected by the fake',
        more_info: `https://www.twilio.com/docs/errors/${code}`,
        status: 400,
      });
      return;
    }
    if (failure?.mode === 'drop_before_create') {
      // No response: the client sees ECONNRESET 'socket hang up' with no
      // status (the app's `unknown`), and the provider holds nothing.
      req.socket.destroy();
      return;
    }
    const from = firstString(body['From']);
    const messageBody = firstString(body['Body']);
    const messagingServiceSid = firstString(body['MessagingServiceSid']);
    const mediaUrls = normalizeMediaUrls(body['MediaUrl']);
    const sid = engine.recordOutboundFromApp({
      to,
      ...(from !== undefined && { from }),
      ...(messageBody !== undefined && { body: messageBody }),
      ...(mediaUrls !== undefined && { mediaUrls }),
      ...(messagingServiceSid !== undefined && { messagingServiceSid }),
    });
    if (failure?.mode === 'accept_then_drop') {
      // Recorded - its status callbacks fire as normal - then dropped with no
      // response: the app sees `unknown`, and the reconcile finds the message.
      req.socket.destroy();
      return;
    }
    const stored = engine.getMessageBySid(sid);
    if (stored === undefined) throw new Error(`fake-twilio: message ${sid} missing right after it was recorded`);
    // The create response is a Message resource like the list's and the
    // fetch's, from the SAME stored clock - but it ECHOES the submitted body:
    // Smart Encoding shows only when the message is read back.
    res.status(201).json({ ...toMessageResource(stored, req.params.accountSid), body: messageBody ?? null });
  });

  // GET /2010-04-01/Accounts/:accountSid/Messages.json  (messages.page / getPage)
  // The reconcile's lookup (spec D17, D19): filtered by To and From, NEWEST
  // FIRST, `messages` the one non-meta key, answered 200 exactly (twilio-node's
  // Page throws on any other status, 201 included). PageToken is the fake's
  // integer offset; next_page_uri is a PATH the SDK prefixes with the API
  // origin, built with URLSearchParams so a '+' travels as %2B - a raw '+'
  // decodes as a space and silently empties the next page.
  router.get('/2010-04-01/Accounts/:accountSid/Messages.json', (req, res) => {
    const { accountSid } = req.params;
    const to = firstString(req.query['To']);
    const from = firstString(req.query['From']);
    if (to !== undefined && engine.takeFailList(to)) {
      res.status(500).json(FAIL_LIST_ERROR);
      return;
    }
    const pageSize = pageSizeOf(req.query['PageSize']);
    const offset = pageTokenOf(req.query['PageToken']);
    const matching = engine.listMessages({
      ...(to !== undefined && { to }),
      ...(from !== undefined && { from }),
    });
    const page = matching.slice(offset, offset + pageSize);
    const pageUri = (start: number): string => {
      const params = new URLSearchParams();
      if (to !== undefined) params.set('To', to);
      if (from !== undefined) params.set('From', from);
      params.set('PageSize', String(pageSize));
      params.set('Page', String(Math.floor(start / pageSize)));
      if (start > 0) params.set('PageToken', String(start));
      return `${accountPath(accountSid)}/Messages.json?${params.toString()}`;
    };
    res.status(200).json({
      messages: page.map((m) => toMessageResource(m, accountSid)),
      next_page_uri: offset + pageSize < matching.length ? pageUri(offset + pageSize) : null,
      page: Math.floor(offset / pageSize),
      page_size: pageSize,
      first_page_uri: pageUri(0),
      previous_page_uri: offset > 0 ? pageUri(Math.max(0, offset - pageSize)) : null,
      uri: pageUri(offset),
      start: offset,
      end: offset + Math.max(page.length - 1, 0),
    });
  });

  // GET /2010-04-01/Accounts/:accountSid/Messages/:sid.json  (messages(sid).fetch)
  // The reconcile's known-SID read. An unknown SID is Twilio's 404 / 20404,
  // which the driver maps to "no such message"; an armed fail-list keyed on
  // the message's `to` answers 500 (a 404 consumes no arming).
  router.get('/2010-04-01/Accounts/:accountSid/Messages/:sid.json', (req, res) => {
    const { accountSid, sid } = req.params;
    const message = engine.getMessageBySid(sid);
    if (message === undefined) {
      res.status(404).json({
        code: 20404,
        message: `The requested resource ${accountPath(accountSid)}/Messages/${sid}.json was not found`,
        more_info: 'https://www.twilio.com/docs/errors/20404',
        status: 404,
      });
      return;
    }
    if (engine.takeFailList(message.to)) {
      res.status(500).json(FAIL_LIST_ERROR);
      return;
    }
    res.status(200).json(toMessageResource(message, accountSid));
  });

  // Voice + number-provisioning (Calls.json, AvailablePhoneNumbers,
  // IncomingPhoneNumbers) are handled by the voiceRest router (Phase 6) - the
  // former 501 stubs here are gone now that those routes are real.

  return router;
}
