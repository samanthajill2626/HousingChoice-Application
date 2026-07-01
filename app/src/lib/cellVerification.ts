// Cell-verification single-source (Voice Phase 1, spec §7). Pure helpers — no
// I/O, no repo/adapter deps — so both the repo (which stores the HASHED code on
// the user item) and the route/service (which generates + SMS-sends the code)
// import the SAME code generation, hashing, TTL, and SMS body from here.
//
// This is an INTERNAL staff-line verification (a navigator proving their own
// cell before it can be dialed as an outbound bridge leg) — NOT consumer A2P
// messaging, so it is outside the A2P consent gate.
//
// PII posture (spec §9): the verification CODE is a secret — it is stored only
// as a sha256 hash on the user record and must NEVER be logged.
import { createHash, randomInt } from 'node:crypto';

/** How long a generated code is valid, in ms (10 minutes). */
export const CELL_VERIFY_TTL_MS = 10 * 60 * 1000;

/** Max confirm attempts against one pending code before it is locked out. */
export const CELL_VERIFY_MAX_ATTEMPTS = 5;

/**
 * A fresh 6-digit numeric verification code (zero-padded, e.g. "004217").
 * Uses crypto.randomInt (CSPRNG) — NOT Math.random — so codes are unguessable.
 * The range is [0, 1_000_000), padded to a fixed 6 chars.
 */
export function generateCellVerifyCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * sha256(code) as lowercase hex. Codes are stored HASHED on the user record
 * (never plaintext); confirmation re-hashes the submitted code and compares.
 * Deterministic — the same code always hashes to the same digest.
 */
export function hashCellVerifyCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * The verification SMS body sent to the navigator's own cell. Internal staff
 * verification (not A2P marketing/consumer messaging), so no opt-out footer.
 */
export function renderCellVerifySms(code: string): string {
  return `Your HousingChoice verification code is ${code}. It expires in 10 minutes.`;
}
