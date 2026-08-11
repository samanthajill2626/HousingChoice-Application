// Group identity (spec 4.1) - the ONE function that turns a carrier-group
// envelope into {roster, conversationId}.
//
// The id is uuidv5 over the SORTED outside roster, derived through the
// importer's `conversationIdForGroup` (imported, never moved or copied): the
// import and the runtime MUST agree, or the same carrier group yields two
// threads (invariant 13.5). The exclusion set is part of that identity contract
// and is fixed at deploy - see config.groupIdentityExcludedNumbers.
//
// INPUT SET (adjudication A5): `From + To + OtherRecipients`, the spike's
// formula, NOT the spec's `From + OtherRecipients`. The two are identical
// whenever exclusion is healthy (`To` is our business number, which the
// exclusion set removes). Taking the wider set makes a MISCONFIGURED exclusion
// list observable instead of silent: the business number then survives into the
// roster, where this module alarms on it.
//
// PII (doc 9): phones are DATA here, never log output. Every log line below
// carries counts and flags only.
import { conversationIdForGroup } from '../lib/import/ids.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';

/**
 * The numbers subtracted from an envelope before the roster is derived: our
 * business number, every relay pool number (cached read - resolution happens in
 * the caller, this module stays pure), and the deploy-fixed config list.
 */
export interface GroupExclusionSet {
  businessPhoneNumber?: string | undefined;
  poolNumbers?: readonly string[] | undefined;
  configuredNumbers?: readonly string[] | undefined;
}

export interface GroupIdentityResult {
  /** The outside members, normalized E.164, deduped, SORTED (the id's input). */
  roster: string[];
  /** uuidv5 over the sorted roster - the group thread's conversationId. */
  conversationId: string;
  /**
   * Envelope addresses `normalizeToE164` could not canonicalize, VERBATIM.
   * Never silently dropped: dropping one would make a 3-person group derive the
   * same id as a genuine 2-person one (spec 5.3(c) corrupt-shape branch).
   */
  unparseable: string[];
  /**
   * Pool numbers seen in an OUTSIDE-roster position (From / OtherRecipients).
   * They are excluded like any org number, but their presence is genuinely
   * anomalous, so it is warned + surfaced (spec 4.1).
   */
  poolNumbersInEnvelope: string[];
  /**
   * TRUE when the address the group arrived on (`To`, our business number by
   * construction) survived exclusion - i.e. the exclusion set is MISCONFIGURED
   * and every id derived in this state carries a phantom member. Alarmed.
   */
  businessNumberSurvived: boolean;
  /**
   * Fewer than two outside members. The caller decides what that means (spec 5
   * files it as a 1:1 with the extraction marker) - this module never decides
   * for it.
   */
  collapsed: boolean;
}

/** Normalize, dropping anything unparseable (used for the exclusion inputs). */
function normalizedSet(values: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of values ?? []) {
    const e164 = normalizeToE164(raw);
    if (e164 !== undefined) out.add(e164);
  }
  return out;
}

/**
 * Derive a carrier group's roster + deterministic conversationId.
 *
 * @param from  envelope From (the sending member)
 * @param to    envelope To (our business number - the group branch is gated on it)
 * @param others envelope OtherRecipients
 */
export function groupIdentity(
  from: string,
  to: string,
  others: readonly string[],
  exclusions: GroupExclusionSet,
  deps: { logger?: Logger } = {},
): GroupIdentityResult {
  const log = deps.logger ?? defaultLogger;

  const poolNumbers = normalizedSet(exclusions.poolNumbers);
  const excluded = new Set<string>([
    ...normalizedSet(
      exclusions.businessPhoneNumber !== undefined ? [exclusions.businessPhoneNumber] : [],
    ),
    ...poolNumbers,
    ...normalizedSet(exclusions.configuredNumbers),
  ]);

  const unparseable: string[] = [];
  const normalized: string[] = [];
  for (const raw of [from, to, ...others]) {
    const e164 = normalizeToE164(raw);
    if (e164 === undefined) {
      unparseable.push(raw);
      continue;
    }
    normalized.push(e164);
  }

  // Pool numbers in an OUTSIDE position only (From / OtherRecipients). `To` is
  // our own number by construction, so it is not an anomaly signal.
  const outside = new Set<string>();
  for (const raw of [from, ...others]) {
    const e164 = normalizeToE164(raw);
    if (e164 !== undefined && poolNumbers.has(e164)) outside.add(e164);
  }
  const poolNumbersInEnvelope = [...outside].sort();

  const roster = [...new Set(normalized.filter((n) => !excluded.has(n)))].sort();

  // The address the group arrived on is our business number by construction, so
  // its survival IS the misconfiguration signal - and it works even when config
  // carries no business number at all (the exact failure this detects).
  const normalizedTo = normalizeToE164(to);
  const businessNumberSurvived = normalizedTo !== undefined && roster.includes(normalizedTo);

  if (businessNumberSurvived) {
    // Un-ignorable: every id derived in this state carries a phantom member, so
    // the whole group thread population would fork the moment it is fixed.
    log.error(
      { rosterSize: roster.length },
      'group identity: business number survived group exclusion - GROUP_IDENTITY_EXCLUDED_NUMBERS / BUSINESS_PHONE_NUMBER is misconfigured and derived group ids are WRONG',
    );
  }
  if (poolNumbersInEnvelope.length > 0) {
    log.warn(
      { poolNumberCount: poolNumbersInEnvelope.length, rosterSize: roster.length },
      'group identity: relay pool number in a carrier group outside-roster position',
    );
  }

  return {
    roster,
    conversationId: conversationIdForGroup(roster),
    unparseable,
    poolNumbersInEnvelope,
    businessNumberSurvived,
    collapsed: roster.length < 2,
  };
}
