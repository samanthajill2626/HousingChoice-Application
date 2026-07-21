// fake-twilio/src/routes/sesControl.ts
//
// The fake-SES CONTROL surface - the scripted-test / e2e seam that reads what the
// app "sent" through the fake-SES REST surface and clears it. Mirrors control.ts
// (route factory + the `400 {error}` bad-input convention).
//
// It shares the `/control` prefix with the SMS + voice control routers but owns
// DISJOINT subpaths (`/control/emails`, `/control/reset-mail`) so neither router
// shadows the other - Express matches the first router whose path matches, and the
// path sets are disjoint (the voiceControl.ts precedent). It deliberately does NOT
// reuse the SMS `/control/reset` (that clears the messaging engine): mail is a
// SEPARATE engine, and createControlRouter(engine) exposes no callback seam to fold
// mail-clearing into the main reset without changing a shared router outside this
// slice's scope. The e2e fixture (fakeEmail.resetMail) calls `/control/reset-mail`
// explicitly for a clean slate; see .superpowers/sdd/slice-A7-report.md.
import { Router } from 'express';
import type { MailEngine } from '../engine/mailEngine.js';

export function createSesControlRouter(mailEngine: MailEngine): Router {
  const router = Router();

  // GET /control/emails - every email the app has "sent", newest first.
  router.get('/control/emails', (_req, res) => {
    res.status(200).json({ emails: mailEngine.list() });
  });

  // POST /control/reset-mail - clear the captured emails (disjoint from the SMS
  // /control/reset, which this router must NOT collide with).
  router.post('/control/reset-mail', (_req, res) => {
    try {
      mailEngine.reset();
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
