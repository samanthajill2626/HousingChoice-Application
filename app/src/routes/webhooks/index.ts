// Webhooks router — SEAM ONLY in Phase 0. Twilio (and other provider)
// webhooks mount here in Phase 1; Twilio HMAC validation will use the raw
// body captured onto req.rawBody by the JSON body parser in app.ts.
import { Router } from 'express';

export const webhooksRouter: Router = Router();

webhooksRouter.use((_req, res) => {
  res.status(404).json({ error: 'not implemented' });
});
