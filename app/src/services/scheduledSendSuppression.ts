export type ScheduledSuppressionReason =
  | 'sms_sending_disabled' | 'contact_opted_out' | 'manual_mode' | 'stale_stage';
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
 *  Deliberately omits JIT-consent (never applies to automated) and live-breaker (unevaluable). */
export function evaluateScheduledSendSuppression(input: {
  smsSendingEnabled: boolean | undefined;
  convOptOut: boolean | undefined;
  contactOptOut: boolean | undefined;
  aiMode: string | undefined;
  staleStage?: boolean;
}): ScheduledSuppression | undefined {
  if (isKillSwitchOff(input.smsSendingEnabled)) return { reason: 'sms_sending_disabled' };
  if (isOptedOut(input.convOptOut, input.contactOptOut)) return { reason: 'contact_opted_out' };
  if (isManualMode(input.aiMode)) return { reason: 'manual_mode' };
  if (input.staleStage === true) return { reason: 'stale_stage' };
  return undefined;
}
