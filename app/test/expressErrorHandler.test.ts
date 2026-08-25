// The Express error middleware's LOG MESSAGES. The first test is the point of
// the file: `req.path` can carry a raw E.164 (routes/contacts.ts,
// routes/relayGroups.ts mount `:phone` as a path segment), so the message uses
// the route TEMPLATE. `path` stays a structured field; only its promotion into
// the low-cardinality `msg` is refused.
import { describe, expect, it } from 'vitest';
import { createExpressErrorHandler } from '../src/lib/errors.js';
import { type Logger } from '../src/lib/logger.js';

interface Line {
  obj: Record<string, unknown>;
  msg: string;
}

function capture(): { lines: Line[]; log: Logger } {
  const lines: Line[] = [];
  const log = {
    error: (obj: Record<string, unknown>, msg: string) => {
      lines.push({ obj, msg });
    },
    warn: (obj: Record<string, unknown>, msg: string) => {
      lines.push({ obj, msg });
    },
  };
  return { lines, log: log as unknown as Logger };
}

interface FakeRes {
  headersSent: boolean;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}

// Typed FIRST and then assigned: `const res = { status: () => res }` is a
// TS7022 self-referential initializer and will not compile.
function fakeRes(headersSent: boolean): FakeRes {
  const res: FakeRes = {
    headersSent,
    status: () => res,
    json: () => res,
  };
  return res;
}

describe('express error handler messages', () => {
  it('does NOT put a concrete phone-bearing path in msg - it uses the route template', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = {
      method: 'DELETE',
      path: '/api/contacts/c-1/phones/+14045551234',
      baseUrl: '/api/contacts',
      route: { path: '/:contactId/phones/:phone' },
    };
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    const line = lines[0];
    expect(line).toBeDefined();
    expect(line!.msg).not.toContain('+14045551234');
    expect(line!.msg).toContain('/api/contacts/:contactId/phones/:phone');
    expect(line!.msg).toContain('DELETE');
    // path REMAINS a structured field - only its promotion into msg is refused.
    expect(line!.obj['path']).toBe('/api/contacts/c-1/phones/+14045551234');
  });

  it('uses the (unrouted) token when req.route is unset', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'POST', path: '/api/whatever', baseUrl: '' };
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    expect(lines[0]!.msg).toContain('(unrouted)');
  });

  it('gives the headers-already-sent branch a DISTINCT message', () => {
    const { lines, log } = capture();
    const handler = createExpressErrorHandler(log);
    const req = { method: 'GET', path: '/api/x', baseUrl: '' };
    handler(new Error('boom'), req as never, fakeRes(true) as never, () => {});
    handler(new Error('boom'), req as never, fakeRes(false) as never, () => {});
    expect(lines).toHaveLength(2);
    expect(lines[0]!.msg).not.toBe(lines[1]!.msg);
  });
});
