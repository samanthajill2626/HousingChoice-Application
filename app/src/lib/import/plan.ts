// import:plan — read the exports, decide everything decidable, emit the review
// workbook. Writes no database (spec §3.1).
//
// The plan is a PURE function of its inputs: same exports + same prior review ->
// byte-identical workbook. That is what makes the carry-forward diff meaningful
// on 8/09 (only genuinely new people show as `new`) and it is why status
// derivation anchors to the export's newest timestamp rather than wall-clock.

import { loadAirtableExport, type AirtableExport } from './airtableSource.js';
import { mineAddresses, type AddressCandidate } from './addresses.js';
import { mergePeople, type MergeResult } from './merge.js';
import { loadQuoExport, type QuoExport } from './quoSource.js';
import { buildThreadIndex, findOptOutPhones, type ThreadIndex } from './threads.js';
import { DEFAULT_ACTIVE_WINDOW_DAYS } from './status.js';
import {
  buildContactRows,
  buildGroupRows,
  buildUnitRows,
  serializeWorkbook,
  type PriorReview,
  type WorkbookSheets,
} from './workbook.js';

export interface PlanOptions {
  quoDir: string;
  airtableDir: string;
  prior?: PriorReview;
  activeWindowDays?: number;
  /** Minimum times an address must appear in sent texts to be offered. */
  minAddressSendCount?: number;
}

export interface PlanResult {
  sheets: WorkbookSheets;
  files: Record<string, string>;
  quo: QuoExport;
  airtable: AirtableExport;
  threads: ThreadIndex;
  merge: MergeResult;
  addresses: AddressCandidate[];
  warnings: string[];
  summary: PlanSummary;
}

export interface PlanSummary {
  /** The clock used for status derivation — the export's newest activity. */
  asOf: string;
  activeWindowDays: number;
  quoContactRows: number;
  mergedPeople: number;
  duplicateRowsCollapsed: number;
  orphansAdded: number;
  airtableOnlyAdded: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  needsReview: number;
  messages: number;
  calls: number;
  /** Messages/calls that belong to no importable thread — the totals reconcile. */
  unroutableMessages: number;
  unroutableCalls: number;
  threads: number;
  groupThreads: number;
  optedOut: number;
  airtableProperties: number;
  minedAddresses: number;
}

export function runPlan(options: PlanOptions): PlanResult {
  const quo = loadQuoExport(options.quoDir);
  const airtable = loadAirtableExport(options.airtableDir);

  const threads = buildThreadIndex(quo);
  const optOutPhones = findOptOutPhones(quo);

  const asOf = newestTimestamp(quo);
  const activeWindowDays = options.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;

  const merge = mergePeople(quo, airtable, threads, {
    asOf,
    activeWindowDays,
    optOutPhones,
  });

  // Mine EVERY spelling, then apply the relevance threshold per PROPERTY in
  // buildUnitRows. Thresholding here would count each spelling separately, so a
  // property she texted five times in five slightly different ways would score 1
  // on each and be dropped entirely — exactly the busy properties we most want.
  const addresses = mineAddresses(quo.messages, { minSendCount: 1 });

  const sheets: WorkbookSheets = {
    contacts: buildContactRows(merge.people, options.prior),
    groups: buildGroupRows(threads.threads, merge.people, options.prior),
    units: buildUnitRows(airtable.properties, addresses, options.prior, {
      minSendCount: options.minAddressSendCount ?? 2,
    }),
  };

  const byStatus: Record<string, number> = {};
  for (const p of merge.people) byStatus[p.suggestedStatus] = (byStatus[p.suggestedStatus] ?? 0) + 1;

  const warnings = [
    ...quo.warnings,
    ...airtable.warnings,
    ...threads.warnings,
    ...merge.warnings,
  ];

  return {
    sheets,
    files: serializeWorkbook(sheets),
    quo,
    airtable,
    threads,
    merge,
    addresses,
    warnings,
    summary: {
      asOf,
      activeWindowDays,
      quoContactRows: merge.stats.quoContactRows,
      mergedPeople: merge.stats.mergedPeople,
      duplicateRowsCollapsed: merge.stats.duplicateRowsCollapsed,
      orphansAdded: merge.stats.orphansAdded,
      airtableOnlyAdded: merge.stats.airtableOnlyAdded,
      byType: merge.stats.byType,
      byStatus,
      needsReview: merge.stats.flagged,
      messages: quo.messages.length,
      calls: quo.calls.length,
      unroutableMessages: threads.unroutable.messages.length,
      unroutableCalls: threads.unroutable.calls.length,
      threads: threads.threads.length,
      groupThreads: threads.threads.filter((t) => t.isGroup).length,
      optedOut: optOutPhones.size,
      airtableProperties: airtable.properties.length,
      minedAddresses: addresses.length,
    },
  };
}

/**
 * The export's newest timestamp — the clock for status derivation.
 *
 * Using the data's own clock rather than `Date.now()` keeps the plan pure, so
 * re-running the same export tomorrow does not reclassify anyone and fill the
 * founder's review diff with phantom changes.
 */
function newestTimestamp(quo: QuoExport): string {
  let newest = '';
  for (const m of quo.messages) if (m.createdAt > newest) newest = m.createdAt;
  for (const c of quo.calls) if (c.createdAt > newest) newest = c.createdAt;
  return newest || new Date(0).toISOString();
}
