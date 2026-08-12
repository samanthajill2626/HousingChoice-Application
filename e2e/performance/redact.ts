import type { FailureReasonCode } from './types.js';
import { allEndpointTemplates } from './templates.js';

export type FailureSeam =
  | 'network'
  | 'browser'
  | 'target'
  | 'resolver'
  | 'readiness'
  | 'collector'
  | 'cleanup'
  | 'filesystem'
  | 'report'
  | 'cli';

export interface SafeFailure {
  reason: FailureReasonCode;
  statusCode?: number;
  timeoutMs?: number;
  exitCode?: number;
}

export type PrivacyViolationCode =
  | 'authorization_material'
  | 'cookie_material'
  | 'cursor_value'
  | 'email_address'
  | 'entity_id'
  | 'phone_number'
  | 'token_material'
  | 'ulid'
  | 'uuid';

function safeNumericFact(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function readNumericFact(value: unknown, key: string, min: number, max: number): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return safeNumericFact((value as Record<string, unknown>)[key], min, max);
  } catch {
    return undefined;
  }
}

export function reduceCaughtFailure(seam: FailureSeam, caught: unknown): SafeFailure {
  const reason: FailureReasonCode =
    seam === 'target'
      ? 'target_proof_failed'
      : seam === 'browser' || seam === 'collector'
        ? 'browser_failure'
        : seam === 'cleanup'
          ? 'cleanup_failed'
          : 'unexpected_failure';
  const statusCode =
    readNumericFact(caught, 'statusCode', 100, 599) ??
    readNumericFact(caught, 'status', 100, 599);
  const timeoutMs = readNumericFact(caught, 'timeoutMs', 0, Number.MAX_SAFE_INTEGER);
  const exitCode = readNumericFact(caught, 'exitCode', -255, 255);
  return {
    reason,
    ...(statusCode !== undefined && { statusCode }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(exitCode !== undefined && { exitCode }),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TEMPLATE_PATTERNS = [...allEndpointTemplates()]
  .sort((left, right) => right.length - left.length)
  .map((template) => new RegExp(`(?<![A-Za-z0-9:_/\\-])${escapeRegExp(template)}(?=$|[^A-Za-z0-9:_/\\-])`, 'g'));

function maskAllowlistedTemplates(value: string): string {
  let masked = value;
  for (const pattern of TEMPLATE_PATTERNS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, '[template]');
  }
  return masked.replace(/(?<![A-Za-z0-9_:]):[A-Za-z][A-Za-z0-9]*(?![A-Za-z0-9_])/g, '[placeholder]');
}

function decodedCandidates(value: string): string[] {
  const candidates = [value];
  const escaped = value
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)));
  if (escaped !== value) candidates.push(escaped);
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current.replace(/\+/g, '%20'));
    } catch {
      break;
    }
    if (decoded === current) break;
    candidates.push(decoded);
    current = decoded;
  }
  for (const match of value.matchAll(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/])/g)) {
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf8');
      if (decoded.length > 0 && !decoded.includes('\uFFFD')) candidates.push(decoded);
    } catch {
      // Invalid base64 is not retained and needs no scan candidate.
    }
  }
  return candidates;
}

const DETECTORS: ReadonlyArray<readonly [PrivacyViolationCode, RegExp]> = [
  ['authorization_material', /\b(?:authorization|proxy-authorization)["']?\s*[:=]|\bbearer\s+[a-z0-9._~+/-]+/i],
  ['cookie_material', /\b(?:set-cookie|cookie)["']?\s*[:=]|\bsession(?:id)?["']?\s*[:=]\s*["']?[a-z0-9._~+/-]{6,}/i],
  ['token_material', /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|csrf[_-]?token|api[_-]?key|token)["']?\s*[:=]\s*["']?[a-z0-9._~+/-]{6,}/i],
  ['cursor_value', /\b(?:cursor|nextCursor)["']?\s*[:=]\s*["']?[a-z0-9+/_=-]{8,}/i],
  ['email_address', /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/i],
  ['phone_number', /(?<!\d)\+[1-9]\d{7,14}(?!\d)/],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ['ulid', /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/i],
  ['entity_id', /\bum-[0-9a-f]{32}\b/i],
  ['entity_id', /\b(?:contact|unit|conv|tour|placement|bcast|broadcast|user|msg|perf|reminder|nudge|evt)-(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[a-z0-9]{12,}|[a-z0-9]+(?:-[a-z0-9]+)+)\b/i],
];

export function scanArtifactText(text: string): PrivacyViolationCode[] {
  const violations = new Set<PrivacyViolationCode>();
  for (const candidate of decodedCandidates(maskAllowlistedTemplates(text))) {
    for (const [code, pattern] of DETECTORS) {
      pattern.lastIndex = 0;
      if (pattern.test(candidate)) violations.add(code);
    }
  }
  return [...violations].sort();
}
