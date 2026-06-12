// Middleware (0) in the LOCKED chain: correlation-ID injection.
// Creates the AsyncLocalStorage correlation context for the request, echoes
// the requestId back as x-request-id, and honors an inbound W3C traceparent.
import type { RequestHandler } from 'express';
import {
  isValidTraceparent,
  newRequestId,
  runWithContext,
  type CorrelationContext,
} from '../lib/context.js';

export function correlationMiddleware(): RequestHandler {
  return (req, res, next) => {
    const requestId = newRequestId();
    const ctx: CorrelationContext = { requestId };

    const inboundTraceparent = req.headers['traceparent'];
    if (typeof inboundTraceparent === 'string' && isValidTraceparent(inboundTraceparent)) {
      ctx.traceparent = inboundTraceparent;
    }

    res.setHeader('x-request-id', requestId);
    runWithContext(ctx, () => next());
  };
}
