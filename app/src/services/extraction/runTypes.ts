// Shared vocabulary for the AI run log (design 2026-08-06, sections 6-7).
// A leaf by design: this file imports ONLY lib/tenantMatchingInputs.ts, itself
// a leaf that imports nothing (B1 spec D1, watch item WI13), so the resolution
// repository and the extraction services share it without an import cycle.
// extractionRunTypes.test.ts pins that. Keep it so.
import { TENANT_MATCHING_INPUTS } from '../../lib/tenantMatchingInputs.js';

/**
 * The sixteen targets a run can decide about. Order is the display order:
 * the eight original scalars, the tenant matching inputs in their list order
 * (B1 spec D3), then the compound and special targets.
 */
export const DECISION_TARGETS = [
  'firstName', 'lastName', 'voucherSize', 'housingAuthority',
  'pets', 'evictions', 'tenure', 'porting',
  ...TENANT_MATCHING_INPUTS.map((input) => input.key),
  'address', 'status', 'type', 'phone',
] as const;

export type DecisionTarget = (typeof DECISION_TARGETS)[number];

/** True when `value` is one of the sixteen targets (route/param validation). */
export function isDecisionTarget(value: unknown): value is DecisionTarget {
  return typeof value === 'string' && (DECISION_TARGETS as readonly string[]).includes(value);
}

/**
 * Spec 2026-10-12 D1 (I1): the targets whose facts belong to a tenant only. An
 * accept of one is refused on a contact not typed tenant (409
 * suggestion_contact_not_tenant, before the claim) and is fenced on the
 * contact's classification_revision. The neutral targets (firstName, lastName,
 * phone, address) are never refused or fenced; `type` cannot be accepted at
 * all. Defined in this leaf module so the resolution service AND the resolution
 * repository (effectiveGuard) share one definition without an import cycle;
 * services/suggestionResolution.ts re-exports it.
 */
export const TENANT_ONLY_TARGETS: ReadonlySet<string> = new Set<string>([
  'housingAuthority', 'voucherSize', 'pets', 'evictions', 'tenure', 'porting', 'status',
  // B1 spec D3: the tenant matching inputs are tenant facts.
  ...TENANT_MATCHING_INPUTS.map((input) => input.key),
]);

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
  // Spec 2026-10-06 D8: an agency name proposed as a housing authority.
  'agency_not_authority',
  // B1 spec D3: a `write` on a text tenant matching input that already holds
  // a value. Not a suggestion and not a Layer-3 demotion: an added fact goes
  // to a Notes line, a contradiction comes as a `suggest`.
  'text_field_filled',
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
