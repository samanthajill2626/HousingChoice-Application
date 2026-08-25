// Log-hygiene spec section 4: E.164 masking at the REQUEST-PATH log sinks.
// A phone-bearing route (`/api/contacts/:contactId/phones/:phone`,
// `phone:<E164>` memberKeys) puts a real number in `req.path`, and every
// middleware that logs the path copied it verbatim into CloudWatch.
//
// Every sink is pinned here, not just the ones that were easy to reach: the
// request logger's pair of lines, all three express-error-handler arms, and one
// representative sink in each of the four middleware files that log a path. One
// case per file is enough where a file's sinks share the import-and-wrap
// pattern, because what a regression would drop is the `maskPhonesInText` call
// itself. Each case drives the real middleware over a minimal phone-bearing req
// fake, satisfying whatever guard that middleware needs to reach its log line.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/lib/logger.js';
import { createExpressErrorHandler } from '../src/lib/errors.js';
import { requestLoggerMiddleware } from '../src/middleware/requestLogger.js';
import { createRateLimit } from '../src/middleware/rateLimit.js';
import { csrfOriginMiddleware } from '../src/middleware/csrfOrigin.js';
import { originSecretMiddleware } from '../src/middleware/originSecret.js';
import {
  twilioSignatureMiddleware,
  twilioJsonSignatureMiddleware,
} from '../src/middleware/twilioSignature.js';

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

/** A DELETE on the phone-bearing contacts route, and what its mask looks like. */
const PHONE_PATH = '/api/contacts/c1/phones/+14045551234';
const MASKED_PATH = '/api/contacts/c1/phones/+1...34';

/** A logger writing into a fresh capture, plus the lines it produced. */
function loggerCapture(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const { lines, stream } = capture();
  return { lines, log: createLogger({ destination: stream, level: 'info' }) };
}

/**
 * The whole assertion, both halves: the masked form is PRESENT (so a sink that
 * logged nothing cannot pass vacuously) and the raw run is ABSENT anywhere on
 * the line - including in any other field the sink happens to carry.
 */
function expectMasked(lines: string[]): void {
  const joined = lines.join('');
  expect(joined).toContain(MASKED_PATH);
  expect(joined).not.toContain('14045551234');
}

/** A res fake for the reject-with-a-status middleware below. */
function rejectingRes(): unknown {
  return { setHeader: () => {}, status: () => ({ json: () => {} }) };
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

  it('masks the path on the headersSent arm, which delegates to express', () => {
    // Reached only when the response is already streaming, so this arm logs and
    // hands the error on rather than answering - a `next` spy is the proof it
    // took THIS arm and not the ordinary 500 one below.
    const { lines, log } = loggerCapture();
    const handler = createExpressErrorHandler(log);
    let delegated: unknown;
    handler(
      new Error('boom mid-stream'),
      { method: 'PATCH', path: PHONE_PATH } as never,
      { headersSent: true } as never,
      ((err: unknown) => {
        delegated = err;
      }) as never,
    );

    expect(delegated).toBeInstanceOf(Error);
    expectMasked(lines);
  });

  it('masks the path on the URIError arm (a malformed %-escape, answered 400)', () => {
    // Express's route matcher throws URIError from decodeURIComponent BEFORE
    // any handler runs, so this arm sees paths nobody else ever logs.
    const { lines, log } = loggerCapture();
    const handler = createExpressErrorHandler(log);
    handler(
      new URIError('URI malformed'),
      { method: 'DELETE', path: PHONE_PATH } as never,
      { headersSent: false, status: () => ({ json: () => {} }) } as never,
      () => {},
    );

    expectMasked(lines);
  });
});

describe('middleware phone masking: the rejection sinks', () => {
  it('rateLimit: the limit-exceeded WARN carries a masked path', () => {
    const { lines, log } = loggerCapture();
    // max 1 so the SECOND request through the same key trips the limit; a fixed
    // keyOf keeps the case off the IP resolver.
    const middleware = createRateLimit({ max: 1, windowMs: 60_000, logger: log, keyOf: () => 'k' });
    const req = { method: 'DELETE', path: PHONE_PATH } as never;

    middleware(req, rejectingRes() as never, () => {});
    middleware(req, rejectingRes() as never, () => {});

    expectMasked(lines);
  });

  it('csrfOrigin: the cross-origin rejection WARN carries a masked path', () => {
    const { lines, log } = loggerCapture();
    // Mutating method + a PRESENT, non-matching Origin: an absent Origin is
    // allowed through on purpose, so it has to be set to reach the sink.
    const middleware = csrfOriginMiddleware({
      config: { publicBaseUrl: 'https://app.example.com' } as never,
      logger: log,
    });

    middleware(
      { method: 'DELETE', path: PHONE_PATH, headers: { origin: 'https://evil.example.com' } } as never,
      rejectingRes() as never,
      () => {},
    );

    expectMasked(lines);
  });

  it('originSecret: the rejected-request WARN carries a masked path', () => {
    const { lines, log } = loggerCapture();
    const middleware = originSecretMiddleware({ secret: 'cf-origin-secret', logger: log });

    // No x-origin-verify header, and a path that is neither /health nor /__dev/.
    middleware(
      {
        method: 'DELETE',
        path: PHONE_PATH,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as never,
      rejectingRes() as never,
      () => {},
    );

    expectMasked(lines);
  });

  it('twilioSignature (form): the signature-rejected WARN carries a masked path', () => {
    const { lines, log } = loggerCapture();
    // CONFIGURED, so the middleware reaches its validation branch; the missing
    // signature header short-circuits validation to false without any crypto.
    const middleware = twilioSignatureMiddleware({
      authToken: 'test-auth-token',
      publicBaseUrl: 'https://app.example.com',
      nodeEnv: 'test',
      logger: log,
    });

    middleware(
      {
        method: 'POST',
        path: PHONE_PATH,
        originalUrl: PHONE_PATH,
        headers: {},
        body: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as never,
      rejectingRes() as never,
      () => {},
    );

    expectMasked(lines);
  });

  it('twilioSignature (json): the signature-rejected WARN carries a masked path', () => {
    const { lines, log } = loggerCapture();
    const middleware = twilioJsonSignatureMiddleware({
      authToken: 'test-auth-token',
      publicBaseUrl: 'https://app.example.com',
      nodeEnv: 'test',
      logger: log,
    });

    middleware(
      {
        method: 'POST',
        path: PHONE_PATH,
        originalUrl: `${PHONE_PATH}?bodySHA256=deadbeef`,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as never,
      rejectingRes() as never,
      () => {},
    );

    expectMasked(lines);
  });
});
