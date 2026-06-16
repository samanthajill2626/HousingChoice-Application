// fake-twilio/src/routes/voiceControl.ts
//
// Task 7.1: the voice CONTROL API over HTTP — the scripted-test (and, later,
// fake-phones-UI) surface that drives the CallEngine the same way control.ts
// drives the messaging engine. Mirrors control.ts exactly: a route factory, the
// `400 {error}` bad-input convention, and reaching the engine directly.
//
// Endpoints:
//   POST /control/place-call          {from,to,scenario?} → {callSid}
//   GET  /control/calls               → {calls: CallState[]}
//   POST /control/calls/:sid/press    {digit}             → {call}
//   POST /control/calls/:sid/answer   {leg?}              → {call}
//   POST /control/calls/:sid/hangup                       → {call}
//
// These paths share the `/control` prefix with the SMS control router but use
// DISTINCT subpaths (`/control/place-call`, `/control/calls`) so neither router
// shadows the other — both are mounted with app.use() and Express matches the
// first router whose path matches; the path sets are disjoint, so order is moot.
//
// Determinism note: WITH a scenario, placeCall schedules its auto-run on the
// injected clock and we return {callSid} promptly WITHOUT awaiting the bridge
// (Twilio returns immediately too). A scripted test injects a ManualClock and
// drives clock.flush()+engine.settle() to complete the call. The step endpoints,
// by contrast, await the engine's step method (which runs synchronously off the
// pending dial context) before responding, so the response reflects the result.
import { Router } from 'express';
import type { CallEngine } from '../engine/callEngine.js';
import type { Clock } from '../engine/clock.js';
import type { CallScenario } from '../engine/voiceTypes.js';

export interface VoiceControlDeps {
  callEngine: CallEngine;
  /** Reserved for parity with the messaging control surface / future flush hooks;
   *  not required to drive the engine (tests hold the clock they injected). */
  clock?: Clock;
}

const ANSWER_LEGS = new Set(['callee', 'founder', 'team']);
const DIGITS = new Set(['0', '1']);
const OUTCOMES = new Set(['answered', 'no-answer', 'busy']);

/** Lenient shape-check: reject obviously-bad types but fill no defaults (the
 *  engine does). Returns a validated CallScenario or throws with a message that
 *  matches /scenario/i so the handler maps it to a 400 {error}. */
function validateScenario(raw: unknown): CallScenario {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('scenario must be an object');
  }
  const s = raw as Record<string, unknown>;
  if (s['answerLeg'] !== undefined && !ANSWER_LEGS.has(s['answerLeg'] as string)) {
    throw new Error(`scenario.answerLeg must be one of callee|founder|team`);
  }
  // digit may be null (models "no press"); otherwise it must be an allowed DTMF.
  if (s['digit'] !== undefined && s['digit'] !== null && !DIGITS.has(s['digit'] as string)) {
    throw new Error(`scenario.digit must be '0', '1', or null`);
  }
  if (s['outcome'] !== undefined && !OUTCOMES.has(s['outcome'] as string)) {
    throw new Error(`scenario.outcome must be one of answered|no-answer|busy`);
  }
  if (s['ringMs'] !== undefined && typeof s['ringMs'] !== 'number') {
    throw new Error('scenario.ringMs must be a number');
  }
  if (s['record'] !== undefined && typeof s['record'] !== 'boolean') {
    throw new Error('scenario.record must be a boolean');
  }
  if (s['transcript'] !== undefined && typeof s['transcript'] !== 'string') {
    throw new Error('scenario.transcript must be a string');
  }
  return raw as CallScenario;
}

export function createVoiceControlRouter(deps: VoiceControlDeps): Router {
  const { callEngine } = deps;
  const router = Router();

  // POST /control/place-call {from,to,scenario?} — place a masked/founder call.
  router.post('/control/place-call', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const from = body['from'];
      const to = body['to'];
      if (typeof from !== 'string' || from.length === 0) {
        res.status(400).json({ error: "place-call requires a 'from' phone number" });
        return;
      }
      if (typeof to !== 'string' || to.length === 0) {
        res.status(400).json({ error: "place-call requires a 'to' phone number" });
        return;
      }
      const scenario = body['scenario'] !== undefined ? validateScenario(body['scenario']) : undefined;
      // Kick off placeCall. WITHOUT a scenario it pauses after interpret and
      // resolves once the inbound TwiML is fetched — await so the call exists +
      // is paused before we respond. WITH a scenario the auto-run is scheduled on
      // the clock (NOT awaited here); we still await placeCall's own promise,
      // which returns after scheduling without running the bridge.
      const call = await callEngine.placeCall({
        from,
        to,
        ...(scenario !== undefined && { scenario }),
      });
      res.status(200).json({ callSid: call.callSid });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // GET /control/calls — the full call list (callSid, status, legs, …).
  router.get('/control/calls', (_req, res) => {
    res.status(200).json({ calls: callEngine.getCalls() });
  });

  // POST /control/calls/:sid/press {digit} — inject a DTMF gate digit, advancing
  // a paused call. Awaited so the response reflects the resulting terminal state.
  router.post('/control/calls/:sid/press', async (req, res) => {
    try {
      const sid = req.params['sid'];
      const body = (req.body ?? {}) as Record<string, unknown>;
      const digit = body['digit'];
      if (typeof sid !== 'string' || callEngine.getCall(sid) === undefined) {
        res.status(400).json({ error: `no call with sid ${sid ?? ''}` });
        return;
      }
      if (typeof digit !== 'string' || digit.length === 0) {
        res.status(400).json({ error: "press requires a 'digit'" });
        return;
      }
      await callEngine.pressDigit(sid, digit);
      res.status(200).json({ call: callEngine.getCall(sid) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /control/calls/:sid/answer {leg?} — mark a leg answered (bare/team dial).
  router.post('/control/calls/:sid/answer', async (req, res) => {
    try {
      const sid = req.params['sid'];
      const body = (req.body ?? {}) as Record<string, unknown>;
      const leg = body['leg'];
      if (typeof sid !== 'string' || callEngine.getCall(sid) === undefined) {
        res.status(400).json({ error: `no call with sid ${sid ?? ''}` });
        return;
      }
      if (leg !== undefined && typeof leg !== 'string') {
        res.status(400).json({ error: "answer 'leg' must be a string" });
        return;
      }
      await callEngine.answerLeg(sid, leg);
      res.status(200).json({ call: callEngine.getCall(sid) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /control/calls/:sid/hangup — caller/callee hangs up before answer → no-answer.
  router.post('/control/calls/:sid/hangup', async (req, res) => {
    try {
      const sid = req.params['sid'];
      if (typeof sid !== 'string' || callEngine.getCall(sid) === undefined) {
        res.status(400).json({ error: `no call with sid ${sid ?? ''}` });
        return;
      }
      await callEngine.hangup(sid);
      res.status(200).json({ call: callEngine.getCall(sid) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
