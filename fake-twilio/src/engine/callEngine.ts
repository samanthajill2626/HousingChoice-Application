// fake-twilio/src/engine/callEngine.ts
//
// The CallEngine drives a placed voice call end-to-end against the real app
// webhooks, exactly the way Twilio's voice runtime would: it POSTs the inbound
// /voice webhook, interprets the returned TwiML, plays the whisper Gather to the
// answering leg, injects the DTMF gate digit, and finally posts the <Dial action>
// summary. Everything is deterministic: ids come from a counter, all timing rides
// the injected Clock, and a scripted CallScenario chooses which leg answers, the
// gate digit, ring time, and the terminal bridge outcome.
//
// Phase 5.2 scope: place + inbound + interpret + whisper + gate + bridge outcome,
// masked + founder routing. Recording/transcription (5.3) and the standalone
// step API / originateCall (5.4) are deliberately NOT here — but advanceWhisper()
// is factored out so those tasks can reuse the per-leg step logic.

import type { Clock } from './clock.js';
import type { EventHub } from './eventHub.js';
import { interpretTwiml, type DialNumber } from './twimlInterpreter.js';
import {
  buildInboundVoiceParams,
  buildWhisperGateParams,
  buildDialStatusParams,
  type WebhookParams,
} from './signer.js';
import type { NumberRegistry } from './numberRegistry.js';
import type { CallState, CallKind, CallStatus, CallScenario, CallLeg } from './voiceTypes.js';

/** The dispatcher surface the CallEngine needs (real WebhookDispatcher in prod,
 *  a stub in tests). TwiML-returning webhooks use postForResponse; fire-and-read
 *  callbacks (the <Dial action> summary) use post. */
export interface VoiceDispatcher {
  postForResponse(path: string, params: WebhookParams): Promise<{ status: number; body: string }>;
  post(path: string, params: WebhookParams): Promise<number>;
}

export interface CallEngineDeps {
  clock: Clock;
  dispatcher: VoiceDispatcher;
  hub: EventHub;
  registry: NumberRegistry;
  /** Optional hook to recognize an app/business number for routing. Reserved for
   *  future use (founder-cell business-number recognition); pool membership is the
   *  primary masked-vs-founder signal today. */
  appNumberFor?: (number: string) => string | undefined;
}

export interface PlaceCallInput {
  from: string;
  to: string;
  scenario?: CallScenario;
}

/** Map a scenario outcome to Twilio's DialCallStatus vocabulary. */
function outcomeToDialStatus(outcome: NonNullable<CallScenario['outcome']>): CallStatus {
  switch (outcome) {
    case 'answered':
      return 'completed';
    case 'no-answer':
      return 'no-answer';
    case 'busy':
      return 'busy';
  }
}

export class CallEngine {
  private readonly clock: Clock;
  private readonly dispatcher: VoiceDispatcher;
  private readonly registry: NumberRegistry;
  private readonly appNumberFor: ((number: string) => string | undefined) | undefined;
  readonly hub: EventHub;

  private readonly calls = new Map<string, CallState>();
  private sidSeq = 0;
  /** Per-call step delay so scheduled whisper callbacks fire in a deterministic
   *  ascending order under ManualClock.flush(). */
  private scheduleSeq = 0;
  /** In-flight step promises kept so tests can await deterministic settling after
   *  clock.flush() runs the scheduled (async) callbacks. */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: CallEngineDeps) {
    this.clock = deps.clock;
    this.dispatcher = deps.dispatcher;
    this.hub = deps.hub;
    this.registry = deps.registry;
    this.appNumberFor = deps.appNumberFor;
  }

  getCalls(): CallState[] {
    return [...this.calls.values()];
  }

  getCall(sid: string): CallState | undefined {
    return this.calls.get(sid);
  }

  /** Await every in-flight scheduled step (the whisper/gate/status chain). Tests
   *  call this after clock.flush() to settle the async work deterministically. */
  async settle(): Promise<void> {
    // Steps may schedule nothing further here (the whole chain runs inside one
    // scheduled callback), but loop defensively in case a step enqueues another.
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private mintCallSid(): string {
    this.sidSeq += 1;
    return `CAfake${String(this.sidSeq).padStart(8, '0')}`;
  }

  /** Extract pathname+search from an absolute TwiML url. The dispatcher prepends
   *  appBaseUrl, so only the path (with its query string) must be passed through —
   *  the query carries the app's per-leg context (callerLabel/leg/parentCallSid). */
  private pathOf(url: string): string {
    const u = new URL(url);
    return u.pathname + u.search;
  }

  private touch(call: CallState): void {
    call.updatedAt = this.clock.nowIso();
  }

  /**
   * Place a call: POST the inbound /voice webhook, interpret the TwiML, and (if it
   * dials) schedule the whisper→gate→status chain for the answering leg.
   */
  async placeCall(input: PlaceCallInput): Promise<CallState> {
    const callSid = this.mintCallSid();
    const scenario = input.scenario ?? {};
    const kind: CallKind = this.registry.isPool(input.to) ? 'masked' : 'founder';
    const now = this.clock.nowIso();
    const call: CallState = {
      callSid,
      from: input.from,
      to: input.to,
      kind,
      status: 'ringing',
      legs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.calls.set(callSid, call);
    this.hub.emit({ type: 'call.placed', call });

    const { body } = await this.dispatcher.postForResponse(
      '/webhooks/twilio/voice',
      buildInboundVoiceParams({ callSid, from: input.from, to: input.to }),
    );
    const plan = interpretTwiml(body);

    if (plan.kind !== 'dial') {
      // No dial instruction — nothing to bridge. Terminal no-op.
      call.status = 'completed';
      this.touch(call);
      this.hub.emit({ type: 'call.completed', call });
      return call;
    }

    // Adversarial-review guard: never index numbers[0] blindly.
    if (plan.numbers.length === 0) {
      call.status = 'completed';
      this.touch(call);
      this.hub.emit({ type: 'call.completed', call });
      return call;
    }

    // Build a leg per dialed number; choose the answering one per scenario.answerLeg.
    for (const n of plan.numbers) {
      const leg: CallLeg = { phone: n.phone, answered: false };
      if (n.whisperUrl !== undefined) leg.whisperUrl = n.whisperUrl;
      call.legs.push(leg);
    }
    const answering = this.chooseAnsweringLeg(plan.numbers, scenario);
    const actionUrl = plan.actionUrl;

    // Schedule the whisper/gate/status chain on the injected clock so timing is
    // deterministic (ManualClock.flush() runs it). Honor scenario.ringMs.
    const delayMs = scenario.ringMs ?? (this.scheduleSeq += 1);
    const stepPromise = new Promise<void>((resolve) => {
      this.clock.schedule(delayMs, () => {
        this.runDialChain(call, answering, actionUrl, scenario)
          .catch(() => {
            /* a step failure must not leave settle() hanging */
          })
          .finally(() => resolve());
      });
    });
    this.pending.add(stepPromise);
    void stepPromise.finally(() => this.pending.delete(stepPromise));

    return call;
  }

  /** Pick which dialed leg "answers" per the scenario. Defaults to the first leg. */
  private chooseAnsweringLeg(numbers: DialNumber[], scenario: CallScenario): DialNumber {
    // For 'callee'/'founder'/'team' we currently model a single answering leg; the
    // first dialed number is the default. (Group/parallel dial fan-out is a future
    // extension — the leg array already supports it.)
    return numbers[0] as DialNumber;
  }

  /**
   * Run the answering leg's whisper Gather, inject the gate digit, then post the
   * <Dial action> summary and finalize the call's terminal status. Factored out so
   * Task 5.3/5.4 step methods can reuse the per-leg advance logic.
   */
  private async runDialChain(
    call: CallState,
    answering: DialNumber,
    actionUrl: string | undefined,
    scenario: CallScenario,
  ): Promise<void> {
    let accepted = false;

    if (answering.whisperUrl !== undefined) {
      accepted = await this.advanceWhisper(call, answering, scenario);
    } else {
      // No whisper on this leg (e.g. a bare team dial): treat as answered.
      this.markAnswered(call, answering.phone);
      accepted = true;
    }

    // Determine the terminal DialCallStatus: explicit scenario.outcome wins;
    // otherwise derive from whether the gate accepted.
    const dialStatus: CallStatus = scenario.outcome
      ? outcomeToDialStatus(scenario.outcome)
      : accepted
        ? 'completed'
        : 'no-answer';

    if (actionUrl !== undefined) {
      await this.dispatcher.post(
        this.pathOf(actionUrl),
        buildDialStatusParams({
          callSid: call.callSid,
          dialCallStatus: dialStatus,
          dialCallDuration: dialStatus === 'completed' ? 1 : 0,
        }),
      );
    }

    call.status = dialStatus;
    this.touch(call);
    this.hub.emit({ type: 'call.completed', call });
  }

  /**
   * Play the whisper Gather to a leg and inject the DTMF gate digit. Returns true
   * if the gate accepted (Pause) or followed a press-0 team dial; false on
   * hangup/timeout (no-answer). Emits call.whisper / call.answered.
   */
  private async advanceWhisper(
    call: CallState,
    leg: DialNumber,
    scenario: CallScenario,
  ): Promise<boolean> {
    const whisperUrl = leg.whisperUrl;
    if (whisperUrl === undefined) return false;

    this.hub.emit({ type: 'call.whisper', call });

    const { body: whisperBody } = await this.dispatcher.postForResponse(
      this.pathOf(whisperUrl),
      buildInboundVoiceParams({ callSid: call.callSid, from: call.from, to: leg.phone }),
    );
    const whisperPlan = interpretTwiml(whisperBody);
    if (whisperPlan.kind !== 'gather' || whisperPlan.actionUrl === undefined) {
      return false;
    }

    // Model "no press" (digit === null) as a Gather timeout → no-answer. We do NOT
    // POST a gate accept; the call falls through to no-answer.
    if (scenario.digit === null) {
      return false;
    }
    const digit = scenario.digit ?? '1';

    const { body: gateBody } = await this.dispatcher.postForResponse(
      this.pathOf(whisperPlan.actionUrl),
      buildWhisperGateParams({ callSid: call.callSid, digits: digit }),
    );
    call.digit = digit;
    const gatePlan = interpretTwiml(gateBody);

    if (gatePlan.kind === 'pause') {
      // Accept: the answering leg bridges.
      this.markAnswered(call, leg.phone);
      return true;
    }
    if (gatePlan.kind === 'dial') {
      // Press-0 team escape: follow the team leg. For this task we mark it answered
      // and proceed; the team <Dial action> summary is posted by runDialChain.
      if (gatePlan.numbers.length > 0) {
        const teamPhone = (gatePlan.numbers[0] as DialNumber).phone;
        const teamLeg: CallLeg = { phone: teamPhone, answered: true };
        call.legs.push(teamLeg);
        this.touch(call);
        this.hub.emit({ type: 'call.answered', call });
      }
      return true;
    }
    // hangup / anything else → no-answer.
    return false;
  }

  private markAnswered(call: CallState, phone: string): void {
    const leg = call.legs.find((l) => l.phone === phone);
    if (leg) leg.answered = true;
    call.status = 'in-progress';
    this.touch(call);
    this.hub.emit({ type: 'call.answered', call });
  }
}
