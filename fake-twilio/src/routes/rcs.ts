// fake-twilio/src/routes/rcs.ts
//
// Task 7.2: thin RCS 501 SEAMS — RCS (Rich Communication Services, Twilio's
// Content API rich-card/RBM channel) is NOT wired in this fake. Rather than let
// an RCS attempt fall through to a silent 404, these seams answer 501 with a
// JSON pointer to docs/RCS-integration-contract.md, which spells out exactly
// what the APP must add before RCS can be mocked here.
//
// YAGNI: NO engine logic, NO webhook builders, NO UI — just the on-ramp. When
// RCS is actually built, replace these 501s per the contract doc (a real Content
// API impersonation + webhook builders + control endpoints, mirroring the SMS
// and voice surfaces).
import { Router } from 'express';

const CONTRACT_PATH = 'docs/RCS-integration-contract.md';

export function createRcsRouter(): Router {
  const router = Router();

  // Twilio Content API REST seam (rich-card / RCS template create+send lives
  // under the Content API, distinct from the SMS Messaging Service path). Any
  // attempt is a deliberate 501 — the fake does not impersonate it yet.
  router.all('/v1/Content', (_req, res) => {
    res.status(501).json({
      message: 'rcs-not-wired-yet',
      detail: 'The fake does not impersonate the Twilio Content API (RCS) yet.',
      see: CONTRACT_PATH,
    });
  });

  // Control seam the fake-phones UI / scripted tests would call to inject an
  // inbound RCS event once wired. 501 with the contract pointer until then.
  router.post('/control/send-rcs', (_req, res) => {
    res.status(501).json({
      error: 'RCS not implemented — see the RCS contract',
      see: CONTRACT_PATH,
    });
  });

  return router;
}
