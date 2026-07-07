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

  // Traffic-inferred relay groups (spec §5). Response shape (see GroupSnapshot
  // in engine/types.ts):
  //   { groups: [{ poolNumber, members: [{ number, label }],
  //                entries: [ { kind:'inbound', id, from, fromLabel, body?, mediaUrls?, at }
  //                         | { kind:'outbound', id, body?, mediaUrls?, at,
  //                             recipients: [{ number, sid, state, errorCode? }] } ],
  //                lastActivityAt }] }
  // Live updates stream as 'group.updated' SSE frames on /control/events,
  // each carrying the whole recomputed group ({ type, group }).
  router.get('/control/groups', (_req, res) => {
    res.status(200).json({ groups: engine.listGroups() });
  });

  router.post('/control/delivery-outcome', (req, res) => {
    try {
      engine.setDeliveryOutcome(req.body as SetDeliveryOutcomeInput);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/control/reset', (_req, res) => {
    try {
      engine.reset();
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Adversarial-review addition: surface the engine's dispatch-error ring buffer so
  // scripted tests can assert a signing/middleware regression (recorded as a failed
  // webhook dispatch) is observable, not swallowed.
  router.get('/control/dispatch-errors', (_req, res) => {
    try {
      res.status(200).json({ errors: engine.getDispatchErrors() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
