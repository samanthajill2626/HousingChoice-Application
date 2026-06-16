// fake-twilio/src/routes/control.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';
import type { AddAdHocInput, SendAsPartyInput, SetDeliveryOutcomeInput } from '../engine/types.js';

/** The control surface shared by scripted tests and (in Plan 2) the fake-phones UI. */
export function createControlRouter(engine: FakeTwilioEngine): Router {
  const router = Router();

  router.get('/control/personas', (_req, res) => {
    res.status(200).json({ personas: engine.list() });
  });

  router.post('/control/personas/ad-hoc', (req, res) => {
    try {
      const persona = engine.addAdHoc(req.body as AddAdHocInput);
      res.status(201).json(persona);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/control/send-as-party', async (req, res) => {
    try {
      const sid = await engine.sendAsParty(req.body as SendAsPartyInput);
      res.status(200).json({ sid });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/control/threads', (_req, res) => {
    res.status(200).json({ threads: engine.listThreads() });
  });

  router.post('/control/delivery-outcome', (req, res) => {
    engine.setDeliveryOutcome(req.body as SetDeliveryOutcomeInput);
    res.status(200).json({ ok: true });
  });

  router.post('/control/reset', (_req, res) => {
    engine.reset();
    res.status(200).json({ ok: true });
  });

  // Adversarial-review addition: surface the engine's dispatch-error ring buffer so
  // scripted tests can assert a signing/middleware regression (recorded as a failed
  // webhook dispatch) is observable, not swallowed.
  router.get('/control/dispatch-errors', (_req, res) => {
    res.status(200).json({ errors: engine.getDispatchErrors() });
  });

  return router;
}
