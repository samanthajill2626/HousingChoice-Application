/**
 * Type declarations for e2e/support/laneLease.mjs
 *
 * Hand-written, matching the lane.d.ts convention in this directory - .ts
 * importers get accurate types without a build step.
 */

/** The on-disk shape of a lane record. */
export interface LaneLeaseRecord {
  version: 1;
  lane: number;
  /** 32 hex chars. The only thing that proves ownership. */
  ownerToken: string;
  /** `reserved` = resolver picked it; `held` = a long-lived launcher owns it. */
  state: 'reserved' | 'held';
  /** Pid of the (ephemeral) resolver that reserved it. */
  reservedByPid: number;
  reservedAt: string;
  /** Pid of the launcher, once claimed. */
  pid?: number;
  claimedAt?: string;
  gitDir?: string | null;
  appCommit?: string | null;
}

export interface ReserveLaneOpts {
  gitDir?: string;
  /** Supply a token instead of minting one (tests, and the adopt path). */
  ownerToken?: string;
  /** Inject the clock. */
  nowMs?: number;
}

export interface ClaimLaneOpts {
  nowMs?: number;
  appCommit?: string | null;
}

/** Machine-global registry directory: os.tmpdir()/hc-e2e-lanes. */
export declare const LEASE_DIR: string;

/** Grace window before a dead reserver's lease can be taken (ms). */
export declare const RESERVE_GRACE_MS: number;

/** Backstop age for a held lease whose pid may have been recycled (ms). */
export declare const HELD_MAX_AGE_MS: number;

/** Mint a fresh 32-hex owner token. */
export function newOwnerToken(): string;

/** Validate a token or throw `lane_lease_token_invalid`. */
export function assertOwnerToken(value: unknown): string;

/** Absolute path to a lane's record file. */
export function leasePathFor(lane: number): string;

/**
 * Read a lane's record. null ONLY when the file is absent; a present-but-corrupt
 * file returns `{ raw, record: null }` so the caller can still
 * compare-before-delete against the raw bytes.
 */
export function readLease(lane: number): { raw: string; record: LaneLeaseRecord | null } | null;

/** Is this record's owner demonstrably gone? */
export function isReclaimable(record: unknown, nowMs: number): boolean;

/** Compare-before-delete removal. True if it removed the file. */
export function removeIfUnchanged(lane: number, expectedRaw: string): boolean;

/**
 * Phase 1 - atomically reserve a lane. Returns the owner token, or null when
 * another live owner holds it.
 */
export function reserveLane(lane: number, opts?: ReserveLaneOpts): string | null;

/**
 * Phase 2 - a long-lived process claims a lane it was handed the token for.
 * Re-entrant: claiming one you already hold is a no-op success.
 */
export function claimLane(lane: number, ownerToken: string, opts?: ClaimLaneOpts): boolean;

/** Do we hold this lane under this token? Gate for anything destructive. */
export function holdsLane(lane: number, ownerToken: string | null | undefined): boolean;

/** Release a lane we hold. Never removes someone else's lease. */
export function releaseLane(lane: number, ownerToken: string | null | undefined): boolean;

