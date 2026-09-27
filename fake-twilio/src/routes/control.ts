// fake-twilio/src/routes/control.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';
import type { NumberRegistry } from '../engine/numberRegistry.js';
import type {
  AddAdHocInput, FailListInput, FailNextSendInput, SendAsPartyInput, SetDeliveryOutcomeInput,
} from '../engine/types.js';

/** CloudEvents `type` (schema v1) for a successful A2P number-registration - the
 *  signal the app's events sink promotes a `warming` pool number on (mirrors app T3). */
const REGISTRATION_SUCCESS_TYPE =
  'com.twilio.messaging.compliance.number-registration.successful';
/** Cosmetic MG sid stamped on the emitted event. The app correlates by PN sid (D2),
 *  so the messaging-service sid is not load-bearing here - a placeholder is fine. */
const PLACEHOLDER_MG_SID = 'MGfake00000000000000000000000000';

/**
 * Extra wiring for the T9 register-number simulation. Both are supplied by
 * buildFakeTwilioApp (the shared registry + a WebhookDispatcher.postEventsBatch),
 * and injectable in tests. Optional so the pre-T9 `createControlRouter(engine)`
 * call sites keep compiling; the route guards when they are absent.
 */
export interface ControlRouterDeps {
  /** The shared pool-number registry: maps a provisioned phoneNumber to the PN sid
   *  the fake minted (= the sid the app stored when it warmed the number), so the
   *  emitted registration event correlates by that SAME sid (D2). */
  registry?: NumberRegistry;
  /** POSTs a CloudEvents batch to the app's events sink (JSON, x-origin-verify, NO
   *  Twilio signature). Injectable for tests; WebhookDispatcher.postEventsBatch in prod. */
  postEventsBatch?: (path: string, batch: unknown) => Promise<number>;
  /** MG sid to stamp on the emitted event (cosmetic; defaults to a placeholder). */
  messagingServiceSid?: string;
}

/** The control surface shared by scripted tests and (in Plan 2) the fake-phones UI. */
export function createControlRouter(
  engine: FakeTwilioEngine,
  deps: ControlRouterDeps = {},
): Router {
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

  // Send-outcome seams (spec D19). Both are armings keyed by PARTY number and
  // consumed per call, like /control/delivery-outcome, and both survive until
  // consumed or until /control/reset - which runs ONCE per e2e suite - so a
  // spec arms per-run-unique numbers. Body errors answer 400 { error }.
  //
  // POST /control/fail-next-send { partyNumber, mode, code?, count? } -> { ok: true }
  // The next `count` (default 1) Messages creates TO partyNumber:
  //   reject             -> 400 { code: code ?? 21211, message, more_info, status: 400 };
  //                         nothing recorded
  //   drop_before_create -> the socket is destroyed, no response; nothing recorded
  //   accept_then_drop   -> recorded (its status callbacks fire as normal), then
  //                         the socket is destroyed with no response
  // reject and drop_before_create end the create BEFORE it is recorded, so a
  // /control/delivery-outcome profile armed for the same party is NOT consumed
  // and applies to the next create that goes through (the re-drive), and a
  // never-seen number is not auto-registered as a persona. Do not arm a
  // delivery-outcome profile beside a reject or drop_before_create for one
  // party unless the re-drive is meant to get it (T11-6). Arming fail-list
  // beside any of the three is fine.
  router.post('/control/fail-next-send', (req, res) => {
    try {
      engine.setFailNextSend(req.body as FailNextSendInput);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /control/fail-list { partyNumber, count? } -> { ok: true }
  // The next `count` (default 1) Messages LIST calls whose To is partyNumber,
  // and FETCHes of a message whose `to` is partyNumber, answer
  // 500 { code: 20500, message: 'fail-list: provider unavailable', more_info, status: 500 }.
  // A list with no To, another party's list or fetch, and a 404 fetch consume
  // nothing. This is how the e2e and the self-QA drive `unresolved`.
  router.post('/control/fail-list', (req, res) => {
    try {
      engine.setFailList(req.body as FailListInput);
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

  // relay-number-buying T9: simulate Twilio's A2P Event Streams
  // "number-registration.successful" signal for a PREVIOUSLY-PROVISIONED pool number,
  // so the connect-when-ready path can be driven end-to-end without real Twilio. The
  // number was minted by the fake when the app provisioned it, so we look up its PN
  // sid in the SAME shared registry the voice REST provisioning route writes to, and
  // stamp it as data.phonenumbersid - the exact key the app's events sink correlates
  // on (D2) to promote the matching `warming` record to `active`. This is NOT the
  // classic form-signed webhook: it POSTs a raw CloudEvents batch (JSON array, D3) via
  // postEventsBatch (x-origin-verify only, no signature). Hermetic-only (the whole
  // fake refuses NODE_ENV=production - no extra gating needed).
  router.post('/control/register-number', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { phoneNumber?: unknown };
      const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';
      if (phoneNumber.length === 0) {
        res.status(400).json({ error: 'register-number: phoneNumber is required' });
        return;
      }
      if (deps.registry === undefined || deps.postEventsBatch === undefined) {
        res.status(400).json({
          error: 'register-number: not wired (registry / events dispatcher missing)',
        });
        return;
      }
      const record = deps.registry.get(phoneNumber);
      if (record === undefined) {
        res
          .status(400)
          .json({ error: `register-number: ${phoneNumber} is not a provisioned pool number` });
        return;
      }
      // Real Event Streams payload carries the number as bare digits, NO leading '+'
      // (D1). The app correlates by PN sid regardless, but mirror the true shape.
      const bareDigits = phoneNumber.replace(/^\+/, '');
      const now = new Date().toISOString();
      const batch = [
        {
          specversion: '1.0',
          type: REGISTRATION_SUCCESS_TYPE,
          source: '/2010-04-01/Accounts/ACfake0000000000000000000000000000',
          id: `CEfake-${record.sid}`,
          dataschema:
            'https://events-schemas.twilio.com/Messaging.ComplianceNumberRegistration/1',
          datacontenttype: 'application/json',
          time: now,
          data: {
            accountsid: 'ACfake0000000000000000000000000000',
            timestamp: now,
            phonenumbersid: record.sid, // D2 correlation key: the minted PN sid
            phonenumber: bareDigits,
            messagingservicesid: deps.messagingServiceSid ?? PLACEHOLDER_MG_SID,
          },
        },
      ];
      const status = await deps.postEventsBatch('/webhooks/twilio/events', batch);
      if (status < 200 || status >= 300) {
        // Surface a rejected batch instead of a false success - this is exactly the
        // integration seam T12 depends on (mirrors sendAsParty's non-2xx handling).
        throw new Error(`register-number: app events sink returned ${status}`);
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
