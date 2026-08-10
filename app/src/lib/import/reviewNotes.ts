// Interpret the founder's review answers out of the `notes` column (2026-08-09).
//
// The workbook asked her to edit `voucher_beds` / `type` / `drop`, but she
// answered everything in `notes` - which is fair, the guide called it "anything
// you want to tell me". All 84 of her edits were notes: bare numbers on the
// voucher-conflict rows, "You can delete", "Please add to system", "Caseworker",
// "Glitching- landlord Raj", "N/a" on the star-marker rows.
//
// This module translates those notes into the columns the pipeline reads, so her
// review is not discarded. Rules are deliberately NARROW - anything that does not
// match a known pattern is left exactly where she put it and reported for the
// next human pass. Cameron approved interpreting them (2026-08-09), with the
// result going back to her for final review.
//
// Voucher-size precedence inside a numeric note: Airtable overrules (Cameron's
// call, same as merge.resolveVoucherBeds) - on the 12 conflict rows Airtable
// agreed with her hand answers on 8 of 11 it could check.

import type { CsvRow } from './csv.js';

export interface NoteAction {
  rowKey: string;
  phone: string;
  note: string;
  /** Human-readable description of what was done, for the operator report. */
  action: string;
}

export interface InterpretResult {
  /** Notes translated into a column write. */
  interpreted: NoteAction[];
  /** Notes recognised as "question answered, nothing to record" (N/a). */
  acknowledged: NoteAction[];
  /** Notes left verbatim for a human - no rule matched. */
  kept: NoteAction[];
}

const DELETE_RE = /^(you can )?delete\.?$/i;
/** "N/a don't add" appeared once - do-not-add is a drop, not a keep. */
const DONT_ADD_RE = /don'?t add|do not add/i;
const KEEP_RE = /(please )?(add to system|don'?t delete)/i;
const CASEWORKER_RE = /^case\s?wo?rker\.?$/i;
/** "PM- Kym": a property manager is landlord-side (the unit roster's `pm` role). */
const LANDLORD_RE = /landlord|^pm\b|property manager/i;
/** Includes her observed misspellings ("Tenent", "Tennat"). */
const TENANT_RE = /^ten(an|en|na)t\b/i;
const NA_RE = /^n\/?a\.?$/i;
const BARE_SIZE_RE = /^([0-9])\s*(bed(room)?s?)?$/i;

const digits = (phone: string): string => phone.replace(/\D/g, '');

/**
 * Interpret review notes IN PLACE on the prior workbook rows.
 *
 * `airtableSizeByPhone` maps digits-only phone -> the Airtable Voucher Size, so
 * a numeric note can be adjudicated on the spot (Airtable wins when they
 * disagree; her number is used when Airtable is silent).
 */
export function interpretReviewNotes(
  rows: Iterable<CsvRow>,
  airtableSizeByPhone: ReadonlyMap<string, number>,
): InterpretResult {
  const interpreted: NoteAction[] = [];
  const acknowledged: NoteAction[] = [];
  const kept: NoteAction[] = [];

  for (const row of rows) {
    const note = (row.notes ?? '').trim();
    if (!note) continue;
    const base: Omit<NoteAction, 'action'> = {
      rowKey: row.row_key ?? '',
      phone: row.phone ?? '',
      note,
    };

    // --- bare voucher size ("1", "4", "2 bed") -------------------------------
    const sizeMatch = note.match(BARE_SIZE_RE);
    if (sizeMatch) {
      const herSize = Number(sizeMatch[1]);
      const airtable = airtableSizeByPhone.get(digits(row.phone ?? ''));
      const final = airtable ?? herSize;
      row.voucher_beds = String(final);
      interpreted.push({
        ...base,
        action:
          airtable !== undefined && airtable !== herSize
            ? `voucher_beds=${final} (Airtable ${airtable} overrules her ${herSize})`
            : `voucher_beds=${final}`,
      });
      continue;
    }

    // --- explicit delete -----------------------------------------------------
    if (DONT_ADD_RE.test(note)) {
      row.drop = 'Y';
      interpreted.push({ ...base, action: `drop=Y (she said do not add: ${JSON.stringify(note)})` });
      continue;
    }
    if (DELETE_RE.test(note)) {
      row.drop = 'Y';
      interpreted.push({ ...base, action: 'drop=Y (she said delete)' });
      continue;
    }

    // --- explicit keep -------------------------------------------------------
    if (KEEP_RE.test(note)) {
      row.drop = '';
      interpreted.push({ ...base, action: 'kept (she said add to system / do not delete)' });
      continue;
    }

    // --- type corrections ----------------------------------------------------
    if (CASEWORKER_RE.test(note)) {
      row.type = 'partner';
      interpreted.push({ ...base, action: 'type=partner (she said caseworker)' });
      continue;
    }
    if (LANDLORD_RE.test(note)) {
      row.type = 'landlord';
      interpreted.push({ ...base, action: `type=landlord (note: ${JSON.stringify(note)})` });
      continue;
    }
    if (TENANT_RE.test(note)) {
      row.type = 'tenant';
      interpreted.push({ ...base, action: `type=tenant (note: ${JSON.stringify(note)})` });
      continue;
    }

    // --- "yes" answering a yes/no question we asked in `why` -----------------
    // Only one yes/no question exists ("...drop it?"), and she answered "yes" on
    // exactly the two test contacts it was asked of. Context-bound on purpose: a
    // bare "yes" against any other question stays uninterpreted.
    if (/^yes\.?$/i.test(note) && /drop it\?/i.test(row.why ?? '')) {
      row.drop = 'Y';
      interpreted.push({ ...base, action: 'drop=Y (she answered yes to "drop it?")' });
      continue;
    }

    // --- "N/a": the question was answered with "nothing to tell you" ---------
    // 16 of her 18 N/a rows sit on the star-marker question, which she has
    // separately answered ("no meaning"). Clear the note so it does not carry
    // forward as noise; record that it was seen.
    if (NA_RE.test(note)) {
      row.notes = '';
      acknowledged.push({ ...base, action: 'acknowledged (N/a - nothing to record)' });
      continue;
    }

    // --- everything else stays hers, verbatim -------------------------------
    kept.push({ ...base, action: 'left in notes for human review' });
  }

  return { interpreted, acknowledged, kept };
}

/**
 * Strip PRE-FILLED values from a reviewed workbook, leaving only real edits.
 *
 * The workbook ships with every editable column already filled with our
 * suggestions, so "her file" is suggestions + edits and carry-forward cannot
 * tell them apart. Untreated, v1's suggestions fossilise: the 2026-08-09 replan
 * showed 185 tenants still `on_hold` from v1's 30-day status window - impossible
 * under the founder's 180-day rule, because the export only spans ~155 days.
 * Fresh derivation lost to a frozen copy of the OLD derivation.
 *
 * The baseline is the exact workbook she started from. A value equal to its
 * baseline is a pre-fill and is cleared (fresh suggestion wins); a value that
 * differs is a real edit and stays. Rows are matched by row_key - the baseline
 * and her copy are the same generation, so keys align.
 */
export function stripUnchangedFromBaseline(
  rows: Iterable<CsvRow>,
  baselineByRowKey: ReadonlyMap<string, CsvRow>,
  editable: readonly string[],
): { edited: number; stripped: number } {
  let edited = 0;
  let stripped = 0;
  for (const row of rows) {
    const baseline = baselineByRowKey.get(row.row_key ?? '');
    if (!baseline) continue;
    let rowEdited = false;
    for (const col of editable) {
      const hers = (row[col] ?? '').trim();
      if (!hers) continue;
      if (hers === (baseline[col] ?? '').trim()) {
        row[col] = '';
        stripped += 1;
      } else {
        rowEdited = true;
      }
    }
    if (rowEdited) edited += 1;
  }
  return { edited, stripped };
}
