// WP1 B2a ranking engine - the shared shapes (spec
// docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md; plan
// PR3). A LEAF: it imports nothing, so every ranking module, the drivers in
// app/src/adapters and the scripts share it without a cycle. Persisted record
// shapes live in their repos (matchesRepo, rankingRunsRepo), never here.

/** Which side of the ranking the anchor is on: a property (`unit`) or a tenant. */
export type AnchorKind = 'unit' | 'tenant';

export interface AnchorRef {
  kind: AnchorKind;
  id: string;
}

/** Spec D1: why the anchor would not itself be in a pool. Never refuses a ranking. */
export type AnchorNote = 'not_searching' | 'not_sendable' | 'not_available';

/** A card: a plain JSON object in registry key order (spec D2.2). */
export type Card = Record<string, unknown>;

/** Spec D3: one completeness gap - a stable key and its staff label. */
export interface MissingFlag {
  key: string;
  label: string;
}

/** Spec D2.3: the ONLY tour facts that reach a card, a pair history or a fingerprint. */
export interface TourProjection {
  status: string;
  outcome: string | null;
  scheduledAt: string | null;
}

/** One counted send of a pair: its instant and whether it was a send or a flyer sign-up. */
export interface SendFact {
  at: string;
  kind: 'sent' | 'signed_up';
}

/** Spec D2.5 (charter 6.3): this tenant and this property only, from stored facts. */
export interface PairHistory {
  sends: SendFact[];
  declined: { by: string; at: string } | null;
  tours: TourProjection[];
  daysSinceLastSend: number | null;
}

/** Spec D13: the three fingerprints a match stores. */
export interface CardFingerprints {
  tenantCard: string;
  unitCard: string;
  pairHistory: string;
}

export type Direction = 'tenants_for_property' | 'properties_for_tenant';

/** Spec D1: a property's recorded authorities mapped through the organization list. */
export interface AuthorityMapping {
  mapped: string[];
  unmapped: string[];
}

/**
 * Charter section 20 item 18: the ONE authority fact a pair carries to the
 * model in place of the authority names (off both cards). "matched": the pool
 * fenced on authority and this pair passed it. "unconfirmed": the pool did
 * not fence on authority, because the property has no recorded authority the
 * organization list maps (pool.ts authorityFilters).
 */
export type AuthorityFact = 'matched' | 'unconfirmed';
