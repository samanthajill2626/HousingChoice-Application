// /api router — dashboard-facing REST (M1.1: outbound send only).
//
// TODO(M1.3): AUTH — this router currently trusts anything that clears the
// CloudFront origin-secret middleware. Google OAuth + RBAC land in M1.3 and
// must gate every /api route; until then the dashboard API is origin-secret
// protected only.
import { Router } from 'express';
import type { AppConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import {
  createSendMessageService,
  SendRefusedError,
  type SendMessageService,
} from '../services/sendMessage.js';

/** Refusal code → HTTP status for the send endpoint. */
const REFUSAL_STATUS: Record<SendRefusedError['code'], number> = {
  conversation_not_found: 404,
  contact_opted_out: 409,
  manual_mode: 409,
  breaker_open: 429,
};

export interface ApiRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected service (no DynamoDB/provider). */
  sendMessageService?: SendMessageService;
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const sendMessage =
    deps.sendMessageService ??
    createSendMessageService({ config: deps.config, logger: deps.logger });

  const router = Router();

  // POST /api/conversations/:conversationId/messages  { body?, mediaUrls? }
  // A manual human send (automated sends come from jobs, not this route).
  router.post('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    const payload = (req.body ?? {}) as { body?: unknown; mediaUrls?: unknown };

    const body = typeof payload.body === 'string' && payload.body.length > 0 ? payload.body : undefined;
    const mediaUrls =
      Array.isArray(payload.mediaUrls) &&
      payload.mediaUrls.length > 0 &&
      payload.mediaUrls.every((u): u is string => typeof u === 'string')
        ? payload.mediaUrls
        : undefined;
    if (body === undefined && mediaUrls === undefined) {
      res.status(400).json({ error: 'body (non-empty string) or mediaUrls (string[]) is required' });
      return;
    }

    try {
      const outcome = await sendMessage({
        conversationId,
        ...(body !== undefined && { body }),
        ...(mediaUrls !== undefined && { mediaUrls }),
        automated: false,
      });
      res.status(201).json(outcome);
    } catch (err) {
      if (err instanceof SendRefusedError) {
        res.status(REFUSAL_STATUS[err.code]).json({ error: err.code });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
  });

  return router;
}
