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
import { runPlan } from '../src/lib/import/plan.js';
import { parseWorkbook, CONTACTS_FILE, GROUPS_FILE, UNITS_FILE } from '../src/lib/import/workbook.js';

interface Args {
  quo: string;
  airtable: string;
  out: string;
  prior?: string;
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
        '  --prior     a previously reviewed workbook directory; her edits carry forward',
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

const prior = args.prior
  ? parseWorkbook({
      contacts: readIfPresent(join(args.prior, CONTACTS_FILE)),
      groups: readIfPresent(join(args.prior, GROUPS_FILE)),
      units: readIfPresent(join(args.prior, UNITS_FILE)),
    })
  : undefined;

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
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
console.log(`  messages                        : ${s.messages}`);
console.log(`  calls                           : ${s.calls}`);
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
