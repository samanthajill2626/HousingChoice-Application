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
import { interpretTwiml, type DialNumber, type TwimlPlan } from './twimlInterpreter.js';
import {
  buildInboundVoiceParams,
  buildWhisperGateParams,
  buildDialStatusParams,
  buildRecordingParams,
  buildTranscriptionParams,
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
  /** Origin the fake recording host serves `.mp3` files from. The RecordingUrl the
   *  engine posts is `${recordingServeBase}/recordings/${callSid}/${recordingSid}.mp3`;
   *  in integration this is set to the app's apiBaseUrl origin so the app's
   *  getRecordingStream fetch (via the Phase-1 SSRF dev-override) resolves here.
   *  Injectable so unit tests assert against an explicit base. */
  recordingServeBase?: string;
}

export interface PlaceCallInput {
  from: string;
  to: string;
  scenario?: CallScenario;
}

/** Whether the dialed bridge records, and where to POST the recording callback. */
type RecordingContext = { enabled: true; callbackUrl: string } | { enabled: false };

/** Click-to-call outbound origination input (Phase 6 Calls.json calls this). */
export interface OriginateCallInput {
  to: string;
  from: string;
  /** The app TwiML url to fetch (any TwiML it returns is interpreted generically). */
  url: string;
  scenario?: CallScenario;
}

/** Per-call dial context the step methods (pressDigit/answerLeg/hangup) advance.
 *  Stored once placeCall/originateCall has interpreted the inbound <Dial> TwiML and
 *  built the legs; cleared once a terminal status is posted. This is the seam that
 *  lets the auto-run (scenario runner) and the manual step API share ONE advance
 *  path through runDialChain. */
interface PendingDial {
  answering: DialNumber;
  actionUrl: string | undefined;
  recording: RecordingContext;
  scenario: CallScenario;
  /** Guard so a call advances through the dial chain exactly once. */
  resolved: boolean;
  /**
   * Voice Phase 1 OUTBOUND masked-bridge shape: when the FIRST TwiML the
   * originating (navigator) leg receives is a whisper Gather (press-1 gate) rather
   * than a direct <Dial>, the <Dial> to the target is produced only AFTER the gate
   * is POSTed with the accept digit. This holds that gate's action URL; on advance,
   * the engine POSTs it, interprets the resulting <Dial>, builds the target leg,
   * and runs the normal dial chain (status + recording). Undefined for the classic
   * top-level-<Dial> flow (inbound bridges + the click-to-call originate test).
   */
  preDialGateUrl?: string;
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
  private readonly recordingServeBase: string;
  readonly hub: EventHub;

  private readonly calls = new Map<string, CallState>();
  /** Per-call dial context awaiting a step (manual API) or scheduled auto-run. */
  private readonly pendingDials = new Map<string, PendingDial>();
  private sidSeq = 0;
  /** Deterministic RecordingSid counter (no Date.now()/Math.random()). */
  private recordingSeq = 0;
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
    this.recordingServeBase = deps.recordingServeBase ?? 'http://localhost:8889';
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

  private mintRecordingSid(): string {
    this.recordingSeq += 1;
    return `REfake${String(this.recordingSeq).padStart(8, '0')}`;
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
   * dials) build the legs. WITH a scenario, schedule the whisper→gate→status chain
   * (auto-run, expressed via the same step internals). WITHOUT a scenario, pause
   * after interpret — the call awaits explicit step calls (pressDigit/hangup).
   */
  async placeCall(input: PlaceCallInput): Promise<CallState> {
    const kind: CallKind = this.registry.isPool(input.to) ? 'masked' : 'founder';
    return this.beginCall({
      from: input.from,
      to: input.to,
      kind,
      inboundPath: '/webhooks/twilio/voice',
      scenario: input.scenario,
    });
  }

  /**
   * Click-to-call: originate an OUTBOUND call by fetching the app TwiML at `url`
   * (POST CallSid/From/To/CallStatus, exactly like an inbound webhook), then drive
   * it through the SAME interpret→whisper→gate→outcome→(recording) lifecycle as
   * placeCall. Generic — whatever TwiML `url` returns is interpreted, not hardcoded.
   * This is the seam Phase 6's Calls.json uses for the dashboard click-to-call.
   */
  async originateCall(input: OriginateCallInput): Promise<CallState> {
    return this.beginCall({
      from: input.from,
      to: input.to,
      kind: 'outbound',
      inboundPath: this.pathOf(input.url),
      scenario: input.scenario,
    });
  }

  /** Shared origination core for placeCall + originateCall. */
  private async beginCall(args: {
    from: string;
    to: string;
    kind: CallKind;
    inboundPath: string;
    scenario: CallScenario | undefined;
  }): Promise<CallState> {
    const callSid = this.mintCallSid();
    const hasScenario = args.scenario !== undefined;
    const scenario = args.scenario ?? {};
    const now = this.clock.nowIso();
    const call: CallState = {
      callSid,
      from: args.from,
      to: args.to,
      kind: args.kind,
      status: 'ringing',
      legs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.calls.set(callSid, call);
    this.hub.emit({ type: 'call.placed', call });

    const { body } = await this.dispatcher.postForResponse(
      args.inboundPath,
      buildInboundVoiceParams({ callSid, from: args.from, to: args.to }),
    );
    const plan = interpretTwiml(body);

    // Voice Phase 1 OUTBOUND masked bridge: the navigator leg's FIRST TwiML is a
    // whisper Gather (press-1 to connect), NOT a <Dial>. The <Dial> to the target is
    // produced by the gate action only after the accept digit is POSTed. Stash the
    // gate URL as a pre-dial gate so pressDigit resolves the <Dial> then continues.
    if (plan.kind === 'gather' && plan.actionUrl !== undefined) {
      this.pendingDials.set(callSid, {
        // Placeholder answering leg — the REAL target leg is discovered from the
        // gate's <Dial> on advance. No whisper on it (the gate already gated).
        answering: { phone: '' },
        actionUrl: undefined,
        recording: { enabled: false },
        scenario,
        resolved: false,
        preDialGateUrl: plan.actionUrl,
      });
      if (!hasScenario) return call; // step-API: await pressDigit/hangup
      return this.scheduleAutoRun(callSid, scenario);
    }

    if (plan.kind !== 'dial' || plan.numbers.length === 0) {
      // No dial instruction (or no dialable number) — nothing to bridge. Terminal.
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

    // Stash the dial context so BOTH the scenario auto-run and the manual step API
    // advance the call through the SAME runDialChain path.
    this.pendingDials.set(callSid, {
      answering,
      actionUrl: plan.actionUrl,
      recording: this.recordingContextOf(plan),
      scenario,
      resolved: false,
    });

    if (!hasScenario) {
      // Step-API mode: pause here. The call awaits pressDigit/answerLeg/hangup.
      return call;
    }
    return this.scheduleAutoRun(callSid, scenario);
  }

  /** Scenario auto-run: schedule a tick that invokes the step methods in order on
   *  the injected clock (deterministic). The auto-run is just the step API driven
   *  by the scenario — keeping the webhook sequence + status identical. */
  private scheduleAutoRun(callSid: string, scenario: CallScenario): CallState {
    const call = this.calls.get(callSid)!;
    const delayMs = scenario.ringMs ?? (this.scheduleSeq += 1);
    const stepPromise = new Promise<void>((resolve) => {
      this.clock.schedule(delayMs, () => {
        this.runScenario(callSid, scenario)
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

  /** Drive a paused call to its terminal state per the scenario, by invoking the
   *  SAME step methods the manual API uses. `digit === null` (no press) → hangup;
   *  otherwise pressDigit(digit). */
  private async runScenario(callSid: string, scenario: CallScenario): Promise<void> {
    if (scenario.digit === null) {
      await this.hangup(callSid);
      return;
    }
    await this.pressDigit(callSid, scenario.digit ?? '1');
  }

  /** Step API: inject a DTMF digit on the answering leg's whisper gate, then run the
   *  bridge outcome + <Dial action> status (+ recording/transcription). */
  async pressDigit(callSid: string, digit: '0' | '1' | string): Promise<void> {
    const pd = this.pendingDials.get(callSid);
    const call = this.calls.get(callSid);
    if (!pd || !call || pd.resolved) return;
    await this.advanceDial(call, pd, digit);
  }

  /** Step API: mark a leg answered without a whisper gate (bare/team dial), then run
   *  the bridge outcome + status. `legSelector` matches a leg phone, or defaults to
   *  the answering leg. */
  async answerLeg(callSid: string, legSelector?: string): Promise<void> {
    const pd = this.pendingDials.get(callSid);
    const call = this.calls.get(callSid);
    if (!pd || !call || pd.resolved) return;
    const phone = legSelector ?? pd.answering.phone;
    // Treat an explicit answer as accepting the leg with no whisper to play.
    await this.advanceDial(call, { ...pd, answering: { ...pd.answering, whisperUrl: undefined } }, undefined, phone);
  }

  /** Step API: caller/callee hangs up before answering → no-answer terminal. */
  async hangup(callSid: string): Promise<void> {
    const pd = this.pendingDials.get(callSid);
    const call = this.calls.get(callSid);
    if (!pd || !call || pd.resolved) return;
    // digit === null models "no press" → the gate times out → no-answer.
    await this.advanceDial(call, pd, null);
  }

  /** Single advance path shared by the scenario runner and the step API: play the
   *  answering leg's whisper (if any) with the given gate digit, then post the
   *  <Dial action> summary, finalize status, and fire recording/transcription. */
  private async advanceDial(
    call: CallState,
    pd: PendingDial,
    digit: string | null | undefined,
    answeredPhone?: string,
  ): Promise<void> {
    const live = this.pendingDials.get(call.callSid);
    if (live) live.resolved = true;
    try {
      // OUTBOUND pre-dial gate (Voice Phase 1): POST the navigator-leg whisper-gate
      // with the accept digit FIRST — its response is the <Dial> to the target. On
      // no-press (digit === null) the gate times out → no dial, no-answer terminal.
      const resolvedPd = pd.preDialGateUrl !== undefined
        ? await this.resolvePreDialGate(call, pd, digit)
        : pd;
      if (resolvedPd === undefined) return; // no dial produced (timeout/hangup) — already finalized
      const nextDigit = pd.preDialGateUrl !== undefined ? undefined : digit;
      await this.runDialChain(
        call,
        resolvedPd.answering,
        resolvedPd.actionUrl,
        resolvedPd.scenario,
        resolvedPd.recording,
        nextDigit,
        pd.preDialGateUrl !== undefined ? resolvedPd.answering.phone : answeredPhone,
      );
    } finally {
      // Always drop the pending-dial entry — even if a webhook in the chain throws —
      // so a rejected dispatcher call can never leak the map entry (the scheduled
      // callback's .catch() prevents a crash but would otherwise strand this entry).
      this.pendingDials.delete(call.callSid);
    }
  }

  /**
   * OUTBOUND masked-bridge pre-dial gate (Voice Phase 1): POST the navigator-leg
   * whisper-gate action with the accept digit; its TwiML response is the <Dial> to
   * the target. Build the target leg (no per-leg whisper — the gate already gated)
   * and return a resolved PendingDial carrying the dial's action/recording context.
   * A no-press (digit === null) or a non-<Dial> gate response (Hangup) is a
   * no-answer terminal: finalize the call here and return undefined.
   */
  private async resolvePreDialGate(
    call: CallState,
    pd: PendingDial,
    digit: string | null | undefined,
  ): Promise<PendingDial | undefined> {
    const gateUrl = pd.preDialGateUrl!;
    // No-press → the navigator never accepted; the outbound bridge is no-answer.
    if (digit === null) {
      call.status = 'no-answer';
      this.touch(call);
      this.hub.emit({ type: 'call.completed', call });
      return undefined;
    }
    const acceptDigit = digit ?? '1';
    const { body } = await this.dispatcher.postForResponse(
      this.pathOf(gateUrl),
      buildWhisperGateParams({ callSid: call.callSid, digits: acceptDigit }),
    );
    call.digit = acceptDigit;
    const plan = interpretTwiml(body);
    if (plan.kind !== 'dial' || plan.numbers.length === 0) {
      // The gate hung up (e.g. an unresolved target) — no bridge. Terminal no-answer.
      call.status = 'no-answer';
      this.touch(call);
      this.hub.emit({ type: 'call.completed', call });
      return undefined;
    }
    // Build the target leg(s) from the gate's <Dial>. The target rides ONLY inside
    // <Number> (never a URL param) — mirror it onto the call for leg assertions.
    for (const n of plan.numbers) {
      const leg: CallLeg = { phone: n.phone, answered: false };
      if (n.whisperUrl !== undefined) leg.whisperUrl = n.whisperUrl;
      call.legs.push(leg);
    }
    const answering = plan.numbers[0] as DialNumber;
    return {
      // No whisper on the target leg — the navigator gate already accepted, so the
      // target bridges directly (runDialChain marks it answered).
      answering: { phone: answering.phone },
      actionUrl: plan.actionUrl,
      recording: this.recordingContextOf(plan),
      scenario: pd.scenario,
      resolved: true,
    };
  }

  /** The dial-level recording instruction extracted from the inbound TwiML plan.
   *  `enabled` is true only for the founder dual-channel record-from-answer flow
   *  WITH a recordingStatusCallback; masked (`record='do-not-record'`, no callback)
   *  yields enabled:false so neither recording nor transcription fires. */
  private recordingContextOf(plan: TwimlPlan): RecordingContext {
    if (
      plan.kind === 'dial' &&
      plan.record === 'record-from-answer-dual' &&
      plan.recordingStatusCallback !== undefined
    ) {
      return { enabled: true, callbackUrl: plan.recordingStatusCallback };
    }
    return { enabled: false };
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
    recording: RecordingContext = { enabled: false },
    digit: string | null | undefined = scenario.digit,
    answeredPhone?: string,
  ): Promise<void> {
    let accepted = false;

    if (answering.whisperUrl !== undefined) {
      accepted = await this.advanceWhisper(call, answering, digit);
    } else {
      // No whisper on this leg (e.g. a bare team dial / explicit answerLeg): answered.
      this.markAnswered(call, answeredPhone ?? answering.phone);
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

    // After the bridge answered + the <Dial action> status posted, fire the
    // founder-bridge recording (and then transcription) when the TwiML asked to
    // record AND the bridge actually answered. Masked (record='do-not-record', no
    // recordingStatusCallback) yields recording.enabled === false → skip both.
    if (recording.enabled && accepted && dialStatus === 'completed') {
      await this.fireRecordingAndTranscription(call, recording.callbackUrl, scenario);
    }
  }

  /**
   * Post the recording callback (RecordingUrl ending in `.mp3` at the fake
   * recording host) and, if the scenario carries a transcript, the transcription
   * callback. Mints a deterministic RE… recordingSid and updates CallState +
   * emits call.recording / call.transcript.
   */
  private async fireRecordingAndTranscription(
    call: CallState,
    recordingCallbackUrl: string,
    scenario: CallScenario,
  ): Promise<void> {
    const recordingSid = this.mintRecordingSid();
    // CRITICAL: the URL MUST already end in `.mp3` — the app's getRecordingStream
    // appends `.mp3` only when the URL lacks `.mp3/.wav`, and Phase 6's
    // recording-serve route matches exactly this shape.
    const recordingUrl = `${this.recordingServeBase}/recordings/${call.callSid}/${recordingSid}.mp3`;

    await this.dispatcher.post(
      this.pathOf(recordingCallbackUrl),
      buildRecordingParams({ callSid: call.callSid, recordingSid, recordingUrl, durationSec: 1 }),
    );
    call.recordingSid = recordingSid;
    call.recordingUrl = recordingUrl;
    this.touch(call);
    this.hub.emit({ type: 'call.recording', call });

    if (scenario.transcript !== undefined) {
      // There is no TwiML-carried transcription callback URL; the app's
      // transcription route is the fixed path below.
      await this.dispatcher.post(
        '/webhooks/twilio/voice/transcription',
        buildTranscriptionParams({ callSid: call.callSid, transcript: scenario.transcript }),
      );
      call.transcript = scenario.transcript;
      this.touch(call);
      this.hub.emit({ type: 'call.transcript', call });
    }
  }

  /**
   * Play the whisper Gather to a leg and inject the DTMF gate digit. Returns true
   * if the gate accepted (Pause) or followed a press-0 team dial; false on
   * hangup/timeout (no-answer). Emits call.whisper / call.answered.
   */
  private async advanceWhisper(
    call: CallState,
    leg: DialNumber,
    gateDigit: string | null | undefined,
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
    if (gateDigit === null) {
      return false;
    }
    const digit = gateDigit ?? '1';

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
        // Mirror markAnswered's status transition so the call.answered event
        // payload is consistent with the normal accept path (status='in-progress',
        // not the stale 'ringing') BEFORE the event is emitted.
        call.status = 'in-progress';
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
