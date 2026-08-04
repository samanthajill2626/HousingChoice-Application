export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage'
  | 'quiet_hours';
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
  /** Is the evaluation instant inside the org's quiet-hours window
   *  (lib/quietHours.ts isQuietTime)? Callers compute it; this module stays
   *  clock-free. */
  quietNow?: boolean;
}): ScheduledSuppression | undefined {
  if (isKillSwitchOff(input.smsSendingEnabled)) return { reason: 'sms_sending_disabled' };
  if (isOptedOut(input.convOptOut, input.contactOptOut)) return { reason: 'contact_opted_out' };
  if (isManualMode(input.aiMode)) return { reason: 'manual_mode' };
  if (input.staleStage === true) return { reason: 'stale_stage' };
  // LAST / least severe (quiet-hours spec 2026-08-03): every reason above DROPS
  // or refuses the send; quiet hours only DEFERS it to quiet-end, so it must
  // never mask a harder reason.
  if (input.quietNow === true) return { reason: 'quiet_hours' };
  return undefined;
}
