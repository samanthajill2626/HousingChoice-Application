// `discontinued` is in the UNION but is deliberately NOT produced by the
// evaluator below: it is terminal and outranks every reason here, so the
// callers that know about a retired KIND short-circuit ahead of the evaluator
// (routes/tourReminders.ts, routes/contactTimeline.ts, routes/relayGroups.ts).
// Ranking it inside would be wrong twice: the ladder's rationale is that a
// HARDER reason wins, and a discontinued rung is not something a harder reason
// should override - and the evaluator is never built at all for a group-routed
// tour, which is exactly where a retired kind would then read "sending shortly".
//
// `superseded` (supersession 2026-09-01) follows that precedent EXACTLY, and
// for the same three reasons: it is terminal, it is CALLER knowledge (the rung's
// ladderId against its tour's currentLadderId - lib/ladderPointer.ts, which this
// clock-free module has no tour to compare), and the same three callers
// short-circuit ahead of the evaluator on it. Nothing below produces it.
export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours' | 'paused' | 'discontinued' | 'superseded';
export interface ScheduledSuppression { reason: ScheduledSuppressionReason; }

/** kill-switch is off only on an explicit `false` (mirrors sendMessage's `=== false`). */
export function isKillSwitchOff(smsSendingEnabled: boolean | undefined): boolean {
  return smsSendingEnabled === false;
}
export function isOptedOut(convOptOut: boolean | undefined, contactOptOut: boolean | undefined): boolean {
  return convOptOut === true || contactOptOut === true;
}
export function isManualMode(aiMode: string | undefined): boolean {
  return aiMode === 'manual';
}

/** Read-only preview of whether a scheduled (automated) send will be suppressed.
 *  Precedence matches sendMessage's gate order: kill-switch → opt-out → manual.
 *  stale_stage is nudge-only and lowest precedence (the send would be retired unsent).
 *  `paused` (the manual-only hold-back) is a function of the rung KIND, not of
 *  recipient state, so callers derive it themselves and pass it in - but it is
 *  RANKED here so the whole precedence ladder stays in one place. NOTE: a caller
 *  that never reaches this function (the group-routed tours, whose preview needs
 *  no recipient IO) must still emit `paused` on its own.
 *  Deliberately omits JIT-consent (never applies to automated), live-breaker (unevaluable),
 *  and sendMessage's soft-deleted-contact gate (2026-08-03) - that gate is deliberately
 *  ENFORCEMENT-ONLY: sends to a soft-deleted contact are refused at send time but are NOT
 *  previewed here (docs/issues/scheduled-sends-to-deleted-contacts-silent-burn.md). */
export function evaluateScheduledSendSuppression(input: {
  smsSendingEnabled: boolean | undefined;
  convOptOut: boolean | undefined;
  contactOptOut: boolean | undefined;
  aiMode: string | undefined;
  staleStage?: boolean;
  /** Will quiet hours hold THIS row: its due instant is inside a window
   *  occurrence, or it is due now while the window is active? Callers compute
   *  it (lib/quietHours.ts isQuietTime); this module stays clock-free. */
  quietNow?: boolean;
  /** Is THIS row's kind held back from automatic sending (the manual-only
   *  hold-back)? Callers derive it from the kind; this module just ranks it. */
  paused?: boolean;
}): ScheduledSuppression | undefined {
  if (isKillSwitchOff(input.smsSendingEnabled)) return { reason: 'sms_sending_disabled' };
  if (isOptedOut(input.convOptOut, input.contactOptOut)) return { reason: 'contact_opted_out' };
  if (isManualMode(input.aiMode)) return { reason: 'manual_mode' };
  if (input.staleStage === true) return { reason: 'stale_stage' };
  // BELOW every reason above, because all of them refuse a HUMAN send too: a
  // paused rung invites "Send now", and telling the operator to send manually
  // when the contact has opted out (or the kill switch is off) would send them
  // into a refusal we could have named up front.
  //
  // ABOVE quiet hours, because quiet hours promises the rung goes out at
  // quiet-end. Nothing releases a paused rung but a person, so "Will wait" would
  // be a promise about a send that is not coming.
  if (input.paused === true) return { reason: 'paused' };
  // LAST / least severe (quiet-hours spec 2026-08-03): every reason above DROPS
  // or refuses the send; quiet hours only DEFERS it to quiet-end, so it must
  // never mask a harder reason.
  if (input.quietNow === true) return { reason: 'quiet_hours' };
  return undefined;
}
