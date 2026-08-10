// import:plan (M1.6) - read the Quo + Airtable exports and emit the review
// workbook the founder edits. Writes NO database (spec §3.1).
//
//   npm run import:plan -- --quo <dir> --airtable <dir> --out <dir> [--prior <dir>]
//
// PII: the workbook holds 543 real people's names and phone numbers. It is
// REFUSED if the output path is inside the repository working tree - the remote
// is Azure DevOps and a commit would publish it (spec §3.8).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadAirtableExport } from '../src/lib/import/airtableSource.js';
import { interpretReviewNotes, stripUnchangedFromBaseline } from '../src/lib/import/reviewNotes.js';
import { runPlan } from '../src/lib/import/plan.js';
import { parseWorkbook, CONTACTS_FILE, GROUPS_FILE, UNITS_FILE } from '../src/lib/import/workbook.js';

interface Args {
  quo: string;
  airtable: string;
  out: string;
  prior?: string;
  /** A reviewed contacts CSV by itself (any filename) - overrides --prior's contacts.csv. */
  priorContacts?: string;
  /** Translate the founder's notes-column answers into the proper columns. */
  interpretNotes: boolean;
  /** The workbook she STARTED from - values equal to it are pre-fills, not edits. */
  baselineContacts?: string;
  activeWindowDays?: number;
  allowRepoOutput: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const quo = get('--quo');
  const airtable = get('--airtable');
  const out = get('--out');
  if (!quo || !airtable || !out) {
    console.error(
      'Usage: npm run import:plan -- --quo <dir> --airtable <dir> --out <dir> [--prior <dir>]\n' +
        '                            [--active-window-days N] [--allow-repo-output]\n\n' +
        '  --quo       directory holding the three unpacked Quo export jobs\n' +
        '  --airtable  directory holding the Airtable CSV exports\n' +
        '  --out       where to write the review workbook (MUST be outside the repo)\n' +
        '  --prior     a previously reviewed workbook directory; her edits carry forward\n' +
        '  --prior-contacts <file>  a reviewed contacts CSV on its own (any filename)\n' +
        '  --interpret-notes        translate notes-column answers into the proper columns',
    );
    process.exit(2);
  }
  const windowRaw = get('--active-window-days');
  const parsedWindow = windowRaw === undefined ? undefined : Number.parseInt(windowRaw, 10);
  return {
    quo: resolve(quo),
    airtable: resolve(airtable),
    out: resolve(out),
    ...(get('--prior') && { prior: resolve(get('--prior')!) }),
    ...(get('--prior-contacts') && { priorContacts: resolve(get('--prior-contacts')!) }),
    ...(get('--baseline-contacts') && { baselineContacts: resolve(get('--baseline-contacts')!) }),
    interpretNotes: argv.includes('--interpret-notes'),
    ...(parsedWindow !== undefined && Number.isFinite(parsedWindow) && {
      activeWindowDays: parsedWindow,
    }),
    allowRepoOutput: argv.includes('--allow-repo-output'),
  };
}

/**
 * Refuse to write PII inside the repo working tree.
 *
 * The .gitignore entry is a second line of defence; this is the first. The
 * escape hatch exists only so the test suite can write to a temp dir that
 * happens to sit under the repo on some CI layouts.
 */
function assertOutsideRepo(outDir: string, allow: boolean): void {
  if (allow) return;
  const repoRoot = resolve(import.meta.dirname, '../..');
  const rel = relative(repoRoot, outDir);
  const inside = rel !== '' && !rel.startsWith('..') && !resolve(outDir).match(/^[a-z]:\\?$/i);
  if (inside) {
    console.error(
      `REFUSED: ${outDir} is inside the repository (${repoRoot}).\n\n` +
        'The workbook contains real contact names and phone numbers, and this repo pushes to\n' +
        'Azure DevOps. Write it somewhere outside the working tree - alongside the exports is\n' +
        'the usual place. Override with --allow-repo-output only if you know why.',
    );
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));
assertOutsideRepo(args.out, args.allowRepoOutput);

for (const [label, dir] of [
  ['--quo', args.quo],
  ['--airtable', args.airtable],
] as const) {
  if (!existsSync(dir)) {
    console.error(`${label} directory does not exist: ${dir}`);
    process.exit(1);
  }
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

const priorContactsText = args.priorContacts
  ? readFileSync(args.priorContacts, 'utf8')
  : args.prior
    ? readIfPresent(join(args.prior, CONTACTS_FILE))
    : undefined;

const prior =
  priorContactsText !== undefined || args.prior
    ? parseWorkbook({
        ...(priorContactsText !== undefined && { contacts: priorContactsText }),
        ...(args.prior && {
          groups: readIfPresent(join(args.prior, GROUPS_FILE)),
          units: readIfPresent(join(args.prior, UNITS_FILE)),
        }),
      })
    : undefined;

// --- strip pre-filled suggestions so only her real edits carry forward ------
if (args.baselineContacts && prior) {
  const baseline = parseWorkbook({ contacts: readFileSync(args.baselineContacts, 'utf8') });
  const { edited, stripped } = stripUnchangedFromBaseline(
    prior.contacts.values(),
    baseline.contacts,
    ['name', 'type', 'voucher_beds', 'status', 'drop', 'notes'],
  );
  console.log(
    `
baseline strip: ${stripped} pre-filled values cleared; ${edited} rows carry real edits`,
  );
}

// --- interpret the founder's notes-column answers (2026-08-09) --------------
if (args.interpretNotes && prior) {
  // Airtable overrules a numeric voucher note, so the interpreter needs the
  // sizes up front. Loading the export twice is cheap and keeps runPlan pure.
  const airtableForNotes = loadAirtableExport(args.airtable);
  const sizeByPhone = new Map<string, number>();
  for (const t of airtableForNotes.tenants) {
    const digits = (t.phone ?? '').replace(/\D/g, '');
    const n = Number.parseInt(t.voucherSize, 10);
    if (digits && Number.isInteger(n) && n > 0 && n <= 9 && !sizeByPhone.has(digits)) {
      sizeByPhone.set(digits, n);
    }
  }
  const result = interpretReviewNotes(prior.contacts.values(), sizeByPhone);
  console.log('\n=== note interpretation (her answers -> the right columns) ===');
  console.log(`  interpreted   : ${result.interpreted.length}`);
  console.log(`  acknowledged  : ${result.acknowledged.length} (N/a - question answered, nothing to record)`);
  console.log(`  left verbatim : ${result.kept.length}`);
  for (const a of result.interpreted) console.log(`    ${a.rowKey}  ${a.action}`);
  if (result.kept.length > 0) {
    console.log('  still needing a human:');
    for (const a of result.kept) console.log(`    ${a.rowKey}  note=${JSON.stringify(a.note)}`);
  }
}

const result = runPlan({
  quoDir: args.quo,
  airtableDir: args.airtable,
  ...(prior && { prior }),
  ...(args.activeWindowDays !== undefined && { activeWindowDays: args.activeWindowDays }),
});

mkdirSync(args.out, { recursive: true });
for (const [name, text] of Object.entries(result.files)) {
  writeFileSync(join(args.out, name), text, 'utf8');
}

// ---------------------------------------------------------------------------
// Operator-facing report. Every skipped or flagged row is counted out loud —
// silent truncation is the one failure mode that reads as success (spec §5).
// ---------------------------------------------------------------------------
const s = result.summary;
const pct = (n: number, d: number): string => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

console.log('\n=== import:plan ===');
console.log(`clock (newest activity in export) : ${s.asOf}`);
console.log(`active window                     : ${s.activeWindowDays} days`);

console.log('\n--- people ---');
console.log(`  Quo contact rows                : ${s.quoContactRows}`);
console.log(`  merged people (one per phone)   : ${s.mergedPeople}`);
console.log(`    duplicate rows collapsed      : ${s.duplicateRowsCollapsed}`);
console.log(`    added from traffic (no record): ${s.orphansAdded}`);
console.log(`    added from Airtable only      : ${s.airtableOnlyAdded}`);
console.log(`  by suggested type               : ${fmt(s.byType)}`);
console.log(`  by suggested status             : ${fmt(s.byStatus)}`);
console.log(
  `  NEEDS FOUNDER INPUT             : ${s.needsReview} of ${s.mergedPeople} (${pct(s.needsReview, s.mergedPeople)})`,
);
console.log(`  SMS suppressed (sent STOP)      : ${s.optedOut}`);

console.log('\n--- conversations ---');
console.log(`  messages in export              : ${s.messages}`);
console.log(`  calls in export                 : ${s.calls}`);
// State the reconciliation explicitly. "17,852 of 17,854 imported" with no
// explanation is indistinguishable from a bug (spec §5).
console.log(
  `  will import                     : ${s.messages - s.unroutableMessages} messages, ` +
    `${s.calls - s.unroutableCalls} calls`,
);
if (s.unroutableMessages > 0 || s.unroutableCalls > 0) {
  console.log(
    `  NOT importable                  : ${s.unroutableMessages} messages, ${s.unroutableCalls} calls ` +
      `(no outside participant — see warnings)`,
  );
}
console.log(`  threads                         : ${s.threads}`);
console.log(`  ...of which multi-party groups  : ${s.groupThreads}`);

console.log('\n--- properties ---');
console.log(`  from Airtable                   : ${s.airtableProperties}`);
console.log(`  mined from sent texts           : ${s.minedAddresses}`);

if (result.warnings.length > 0) {
  console.log(`\n--- warnings (${result.warnings.length}) ---`);
  for (const w of result.warnings) console.log(`  ! ${w}`);
}

console.log(`\nworkbook written to ${args.out}`);
console.log(`  ${CONTACTS_FILE}  ${result.sheets.contacts.length} rows`);
console.log(`  ${GROUPS_FILE}    ${result.sheets.groups.length} rows`);
console.log(`  ${UNITS_FILE}     ${result.sheets.units.length} rows`);

function fmt(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}
