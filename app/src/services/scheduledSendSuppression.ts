export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours' | 'paused';
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
