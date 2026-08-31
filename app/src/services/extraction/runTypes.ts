// Shared vocabulary for the AI run log (design 2026-08-06, sections 6-7).
// Leaf module by design: this file imports nothing.

/** The twelve targets a run can decide about. Order is the display order. */
export const DECISION_TARGETS = [
  'firstName', 'lastName', 'voucherSize', 'housingAuthority',
  'pets', 'evictions', 'tenure', 'porting',
  'address', 'status', 'type', 'phone',
] as const;

export type DecisionTarget = (typeof DECISION_TARGETS)[number];

/** True when `value` is one of the twelve targets (route/param validation). */
export function isDecisionTarget(value: unknown): value is DecisionTarget {
  return typeof value === 'string' && (DECISION_TARGETS as readonly string[]).includes(value);
}

/** What the model said for a target before folding or downgrading. */
export type ProposedOp = 'write' | 'suggest' | 'none' | 'absent';

/** What the application did with the target. */
export type DecisionOutcome = 'wrote' | 'suggested' | 'dropped' | 'no_finding' | 'not_addressed';

/** Every discard branch a run can record. */
export const DROP_REASONS = [
  'wrong_contact_type',
  'invalid_value',
  'equal_to_current',
  'status_not_onboarding_tenant',
  'type_already_classified',
  'type_classification_changed',
  'phone_not_canonicalizable',
  'phone_already_owned',
  'phone_owned_by_other',
  'dismissed_before',
  'repo_error',
  'empty_value_at_parse',
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

export type Verdict =
  | 'auto_applied'
  | 'pending'
  | 'accepted'
  | 'dismissed'
  | 'superseded'
  | 'superseded_by_human_edit'
  | 'not_presented';

/** One target's complete proposed, applied, and reviewed story. */
export interface RunDecision {
  proposedOp: ProposedOp;
  proposedValue?: string;
  coercedValue?: unknown;
  previousValue?: string;
  reason?: string;
  demotedFrom?: 'write';
  outcome: DecisionOutcome;
  dropReason?: DropReason;
  verdict: Verdict;
  verdictAt?: string;
  verdictBy?: string;
}

/** One message in the run window. Byte fields are present on full windows only. */
export interface RunWindowMessage {
  tsMsgId: string;
  type: string;
  direction: string;
  tier: 'new' | 'seen';
  capChars?: number;
  truncated?: boolean;
  chars?: number;
  hash?: string;
}

/** A fetched message that did not reach the model. */
export interface RunWindowExcluded {
  tsMsgId: string;
  cause: 'age_30d' | 'char_budget';
}

/** Byte-affecting constants recorded on full windows. */
export interface RunWindowParams {
  newMessageCharCap: number;
  seenMessageCharCap: number;
  windowCharBudget: number;
  maxTranscriptMessages: number;
  /** The floor this run actually applied; null when waived (a manual run).
   *  Legacy stored records always carry a number. */
  maxTranscriptAgeDays: number | null;
  truncationMarker: string;
}

export interface RunWindow {
  detail: 'light' | 'full';
  cursor: string;
  newestTsMsgId?: string;
  hasInferredRoleContent?: boolean;
  totalChars?: number;
  windowCappedAtLimit: boolean;
  windowParams?: RunWindowParams;
  messages: RunWindowMessage[];
  excluded: RunWindowExcluded[];
  noContent?: string[];
}
