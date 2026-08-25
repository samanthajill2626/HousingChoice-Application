// Log-hygiene spec section 4: E.164 masking at the REQUEST-PATH log sinks.
// A phone-bearing route (`/api/contacts/:contactId/phones/:phone`,
// `phone:<E164>` memberKeys) puts a real number in `req.path`, and every
// middleware that logs the path copied it verbatim into CloudWatch. These two
// cases pin the two sinks that had no direct test coverage at all: the request
// logger's pair of lines, and the express error handler's arms.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/lib/logger.js';
import { createExpressErrorHandler } from '../src/lib/errors.js';
import { requestLoggerMiddleware } from '../src/middleware/requestLogger.js';

function capture(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(line: string) {
        lines.push(line);
      },
    },
  };
}

describe('requestLogger phone masking', () => {
  it('masks E.164 segments in the logged path on both lines', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'info' });
    const middleware = requestLoggerMiddleware(log);
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    const req = {
      method: 'DELETE',
      path: '/api/contacts/c1/phones/+14045551234',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    middleware(req as never, res as never, () => {});
    res.emit('finish');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).not.toContain('14045551234');
    }
    expect(lines[0]).toContain('/api/contacts/c1/phones/+1...34');
    expect(lines[1]).toContain('/api/contacts/c1/phones/+1...34');
  });

  it('masks the path on the express error handler line too', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'info' });
    const handler = createExpressErrorHandler(log);
    const resFake = { headersSent: false, status: () => ({ json: () => {} }) };
    handler(
      new Error('boom'),
      { method: 'PATCH', path: '/api/contacts/c1/phones/+14045551234' } as never,
      resFake as never,
      () => {},
    );
    const joined = lines.join('');
    expect(joined).toContain('/api/contacts/c1/phones/+1...34');
    expect(joined).not.toContain('14045551234');
  });
});
