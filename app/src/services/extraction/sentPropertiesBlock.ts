// The PROPERTIES SENT block of the extraction USER content (WP1 B1 spec
// docs/superpowers/specs/2026-10-26-wp1-b1-ranking-inputs-design.md D5.1),
// built like the organization list block (orgListBlock.ts). The job renders it
// ONCE per run from the contact's listing_sends rows and the units' labels and
// hands the text to the driver through ExtractionInput.sentPropertiesBlock;
// `fingerprint` (sha256 hex of the text) is the run record's
// sentPropertiesFingerprint. The probe script renders its cases' blocks with
// this same function, so the never-written gate certifies this code.
//
// Rules:
//   - one line per property, `- <label> - sent <date>`, or `- <label> - signed
//     up <date>` when the row's LATEST counted share is the flyer entry
//     (lib/shareLedgerKeys.ts latestCountedShareKey - the rule
//     listingSendOutcome's `signed_up` reads). <date> is the row's sentAt as
//     YYYY-MM-DD (UTC). Newest first. The label is lib/propertyLabel.ts
//     propertyLabel - the SAME function B2's tenant card uses;
//   - a property with no label (line 1 or the city empty) is left out and
//     counted in `unlabeled` (no WARN); two properties whose labels are
//     identical render ONCE (the newest send);
//   - prompt.ts places the block BEFORE the TRANSCRIPT header, and the block
//     never contains that word: a line holding it, in any case, is left out
//     and counted in `dropped.transcript` (the job WARNs);
//   - a 4,000-character budget, header and line breaks included. Over it the
//     OLDEST lines are left out: newest-first fill, and once a line does not
//     fit, it and every older line are dropped, counted in `dropped.budget`
//     (the job WARNs);
//   - no line at all renders `PROPERTIES SENT: none`.
// The newest-20 row limit is selectSentRows', applied BEFORE the units read.
//
// countFeedbackLines is the D5.3 run-record count over the lines a run
// appended. Counts only: nothing is dropped or rewritten on it.
import { createHash } from 'node:crypto';
import { hasStreetAddress, labelMatches, propertyLabel, type PropertyLabelSource } from '../../lib/propertyLabel.js';
import { FLYER_SHARE_KEY, latestCountedShareKey } from '../../lib/shareLedgerKeys.js';
import type { ListingSendItem } from '../../repos/listingSendsRepo.js';

/** The block's first line - the name the system prompt gives it. */
export const SENT_PROPERTIES_BLOCK_HEADER = 'PROPERTIES SENT';
/** Spec D5.1: the block's character budget. */
export const SENT_PROPERTIES_BLOCK_BUDGET = 4_000;
/** Spec D5.1: the newest N listed rows the block is built from. */
export const SENT_PROPERTIES_MAX_ROWS = 20;

/** One listed row, reduced to what the block needs. */
export interface SentRow {
  unitId: string;
  sentAt: string;
  /** The row's latest counted share is the flyer entry. */
  signedUp: boolean;
}

/** One property to render: its unit (for the label), when, and how. */
export interface SentPropertyEntry {
  unit: PropertyLabelSource;
  sentAt: string;
  signedUp: boolean;
}

export interface SentPropertiesBlock {
  text: string;
  /** sha256 hex of `text` - the run record's sentPropertiesFingerprint. */
  fingerprint: string;
  /** The labels rendered, in block order - what countFeedbackLines matches against. */
  labels: string[];
  /** Properties left out that had a label: holding the word TRANSCRIPT, or over the budget (the job WARNs on both). */
  dropped: { transcript: number; budget: number };
  /** Properties left out for having no label (line 1 or city empty). No WARN. */
  unlabeled: number;
}

/** Newest first by sentAt (ISO strings compare as instants). */
function newestFirst(a: { sentAt: string }, b: { sentAt: string }): number {
  return a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0;
}

/**
 * The newest `max` rows by sentAt from a contact's listingSendsRepo.listByContact
 * answer. listByContact already returns LISTED rows only (its isListed filter);
 * a row with no string sentAt is skipped here only to narrow the type.
 */
export function selectSentRows(
  rows: readonly Pick<ListingSendItem, 'unitId' | 'sentAt' | 'shares'>[],
  max: number = SENT_PROPERTIES_MAX_ROWS,
): SentRow[] {
  const listed: SentRow[] = [];
  for (const row of rows) {
    if (typeof row.sentAt !== 'string') continue;
    listed.push({
      unitId: row.unitId,
      sentAt: row.sentAt,
      signedUp: latestCountedShareKey(row.shares) === FLYER_SHARE_KEY,
    });
  }
  return listed.sort(newestFirst).slice(0, max);
}

export function renderSentPropertiesBlock(
  entries: readonly SentPropertyEntry[],
  opts: { budget?: number } = {},
): SentPropertiesBlock {
  const budget = opts.budget ?? SENT_PROPERTIES_BLOCK_BUDGET;
  let unlabeled = 0;
  let transcript = 0;
  const seen = new Set<string>();
  const candidates: Array<{ label: string; line: string }> = [];
  for (const entry of [...entries].sort(newestFirst)) {
    const label = propertyLabel(entry.unit);
    if (label === undefined) {
      unlabeled += 1;
      continue;
    }
    if (seen.has(label)) continue; // identical labels render once - the newest
    seen.add(label);
    const line = `- ${label} - ${entry.signedUp ? 'signed up' : 'sent'} ${entry.sentAt.slice(0, 10)}`;
    if (/transcript/i.test(line)) {
      transcript += 1;
      continue;
    }
    candidates.push({ label, line });
  }

  // The header line; every added line costs its length plus one newline.
  let used = SENT_PROPERTIES_BLOCK_HEADER.length;
  const kept: Array<{ label: string; line: string }> = [];
  let overBudget = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (used + 1 + candidate.line.length > budget) {
      overBudget = candidates.length - i; // this line and every older one
      break;
    }
    used += 1 + candidate.line.length;
    kept.push(candidate);
  }

  const text = kept.length === 0
    ? `${SENT_PROPERTIES_BLOCK_HEADER}: none`
    : [SENT_PROPERTIES_BLOCK_HEADER, ...kept.map((k) => k.line)].join('\n');
  return {
    text,
    fingerprint: createHash('sha256').update(text, 'utf8').digest('hex'),
    labels: kept.map((k) => k.label),
    dropped: { transcript, budget: overBudget },
    unlabeled,
  };
}

/**
 * Spec D5.3, over the lines a run APPENDED (bare text, no `[Auto - <date>]`
 * prefix): `feedbackLines` - lines naming any block label (labelMatches);
 * `unlabeledAddressLines` - lines naming none of them that carry a street
 * address (hasStreetAddress), which makes an attach miss visible. A line
 * counts at most once.
 */
export function countFeedbackLines(
  lines: readonly string[],
  labels: readonly string[],
): { feedbackLines: number; unlabeledAddressLines: number } {
  let feedbackLines = 0;
  let unlabeledAddressLines = 0;
  for (const line of lines) {
    if (labels.some((label) => labelMatches(line, label))) feedbackLines += 1;
    else if (hasStreetAddress(line)) unlabeledAddressLines += 1;
  }
  return { feedbackLines, unlabeledAddressLines };
}
