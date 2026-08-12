// import:apply (M1.6) - write the reviewed workbook + raw exports into DynamoDB.
//
//   npm run import:apply -- --quo <dir> --airtable <dir> --review <dir> [--dry-run]
//
// Idempotent: every write is keyed on a value derived from the source data, so
// re-running against the cutover export converges rather than duplicating
// (spec §3.2). Only import-owned fields are written, so a re-run after cutover
// does not revert work Sam has done in the app since (see apply.ts header).
//
// TARGETS WHATEVER DYNAMODB_ENDPOINT / TABLE_PREFIX POINT AT. There is no
// built-in "prod" mode and no AWS credential handling here on purpose: the
// operator points it at a stage deliberately, exactly as db:seed does.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { runApply } from '../src/lib/import/apply.js';
import {
  assertGroupIdentityEnvDeclared,
  assertGroupIdentityParity,
  GroupIdentityEnvUndeclaredError,
  GroupIdentityParityError,
  PoolNumbersUnavailableError,
  readPoolNumbersForParity,
} from '../src/lib/import/convertGroups.js';
import { runPlan } from '../src/lib/import/plan.js';
import { parseWorkbook, CONTACTS_FILE, GROUPS_FILE, UNITS_FILE } from '../src/lib/import/workbook.js';
import { createPoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const quoDir = arg('--quo');
const airtableDir = arg('--airtable');
const reviewDir = arg('--review');
const dryRun = process.argv.includes('--dry-run');
const yes = process.argv.includes('--yes');

if (!quoDir || !airtableDir || !reviewDir) {
  console.error(
    'Usage: npm run import:apply -- --quo <dir> --airtable <dir> --review <dir> [--dry-run] [--yes]\n\n' +
      '  --quo       directory holding the three unpacked Quo export jobs\n' +
      '  --airtable  directory holding the Airtable CSV exports\n' +
      '  --review    the REVIEWED workbook directory (contacts.csv, groups.csv, units.csv)\n' +
      '  --dry-run   report what would be written, write nothing\n' +
      '  --yes       skip the confirmation prompt (for scripted runs)',
  );
  process.exit(2);
}

for (const [label, dir] of [
  ['--quo', quoDir],
  ['--airtable', airtableDir],
  ['--review', reviewDir],
] as const) {
  if (!existsSync(dir)) {
    console.error(`${label} directory does not exist: ${dir}`);
    process.exit(1);
  }
}

const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
const contactsCsv = read(join(reviewDir, CONTACTS_FILE));
if (!contactsCsv) {
  console.error(`--review directory has no ${CONTACTS_FILE}: ${reviewDir}`);
  process.exit(1);
}

const review = parseWorkbook({
  contacts: contactsCsv,
  groups: read(join(reviewDir, GROUPS_FILE)),
  units: read(join(reviewDir, UNITS_FILE)),
});

console.log('import:apply - re-planning from the exports to rebuild the mechanical data...');
const plan = runPlan({ quoDir, airtableDir });

// The workbook must have been generated from THESE exports. A row_key set that
// disagrees means she reviewed a different plan, and applying it would attach her
// decisions to the wrong people (spec §5).
const planKeys = new Set(plan.merge.people.map((p) => p.rowKey));
const reviewKeys = new Set(review.contacts.keys());
const missing = [...planKeys].filter((k) => !reviewKeys.has(k));
const extra = [...reviewKeys].filter((k) => !planKeys.has(k));

if (missing.length > 0 || extra.length > 0) {
  console.error(
    `\nREFUSED: the reviewed workbook does not match these exports.\n` +
      `  rows in the plan but not the workbook: ${missing.length}\n` +
      `  rows in the workbook but not the plan: ${extra.length}\n\n` +
      `Re-run import:plan with --prior ${reviewDir} to carry her edits onto the current\n` +
      `export, have her review the rows marked "new"/"conflict", then apply that.`,
  );
  process.exit(1);
}

// Identity check: a row_key is position-derived, so a changed export can slide a
// different person onto the same key. The phone column is how we catch it.
const phoneMismatches: string[] = [];
for (const person of plan.merge.people) {
  const reviewed = review.contacts.get(person.rowKey);
  const reviewedPhone = (reviewed?.phone ?? '').trim();
  if (!reviewedPhone) continue;
  // Excel eats the leading + on an E.164 cell; compare on digits only.
  if (reviewedPhone.replace(/\D/g, '') !== person.phone.replace(/\D/g, '')) {
    phoneMismatches.push(`${person.rowKey}: workbook ${reviewedPhone} vs export ${person.phone}`);
  }
}
if (phoneMismatches.length > 0) {
  console.error(
    `\nREFUSED: ${phoneMismatches.length} row(s) point at a different phone than the export.\n` +
      `Applying would attach her decisions to the wrong people.\n\n` +
      phoneMismatches.slice(0, 10).map((m) => `  ${m}`).join('\n') +
      (phoneMismatches.length > 10 ? `\n  ...and ${phoneMismatches.length - 10} more` : ''),
  );
  process.exit(1);
}

const endpoint = process.env.DYNAMODB_ENDPOINT ?? '(AWS default)';
const prefix = process.env.TABLE_PREFIX ?? 'hc-local-';
console.log(`\ntarget endpoint : ${endpoint}`);
console.log(`table prefix    : ${prefix}`);
console.log(`mode            : ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

const doc = getDocumentClient();

// GROUP-IDENTITY PARITY, BEFORE THE FIRST WRITE (adversarial finding 6).
//
// A group thread's conversationId is derived from its roster, and the roster is
// whatever is left after our own org numbers are subtracted. If the export's
// `ownNumbers` and the deployed GROUP_IDENTITY_EXCLUDED_NUMBERS disagree, every
// group id this run is about to write is a DIFFERENT id from the one detection
// will derive for the same carrier group. This check already existed - but only
// downstream in import:convert-groups, i.e. after apply had written 132 group
// conversations and all of their history, and the conversion then refused to
// touch any of it. There is no group-thread retraction path
// (docs/issues/import-group-thread-retraction.md), so those rows would be
// permanent orphans in the staff inbox. It is the SAME exported function, run
// here first. Deliberately before the write confirmation, so a --dry-run
// rehearsal surfaces the mismatch too.
//
// THE GATE'S OWN PRECONDITION FIRST (adversarial finding 1). loadConfig() reads
// ambient process.env and there is no dotenv here, so an unset
// GROUP_IDENTITY_EXCLUDED_NUMBERS silently means "compare against nothing" and
// refuses EVERY documented invocation, dry run included. Both vars must be
// declared in THIS shell, and the refusal says which and where the value comes
// from.
try {
  assertGroupIdentityEnvDeclared(process.env);
} catch (err) {
  if (!(err instanceof GroupIdentityEnvUndeclaredError)) throw err;
  console.error(`\n${err.message}`);
  console.error('\nNOTHING WAS WRITTEN.');
  process.exit(1);
}

let poolNumbers: string[] = [];
try {
  // Retried rather than degraded to `[]` (adversarial finding 22): pool numbers
  // are subtracted from BOTH sides, so comparing without them turns any pool
  // number in either list into a FALSE mismatch - a new single point of refusal
  // on cutover day, and on the rehearsal dry run that is supposed to de-risk it.
  poolNumbers = await readPoolNumbersForParity(() => createPoolNumbersRepo({ doc }).listActive(), {
    onRetry: (attempt, err) =>
      console.warn(
        `  ! pool-number read failed (attempt ${attempt}): ` +
          `${err instanceof Error ? err.message : String(err)} - retrying`,
      ),
  });
} catch (err) {
  if (!(err instanceof PoolNumbersUnavailableError)) throw err;
  console.error(`\n${err.message}`);
  console.error('\nNOTHING WAS WRITTEN.');
  process.exit(1);
}

try {
  const config = loadConfig();
  assertGroupIdentityParity(plan.quo.ownNumbers, {
    businessPhoneNumber: config.businessPhoneNumber,
    poolNumbers,
    configuredNumbers: config.groupIdentityExcludedNumbers,
  });
} catch (err) {
  if (!(err instanceof GroupIdentityParityError)) throw err;
  console.error(`\n${err.message}`);
  console.error(
    'NOTHING WAS WRITTEN. Fix GROUP_IDENTITY_EXCLUDED_NUMBERS (or the export) so the two lists\n' +
      'agree, then re-run - applying now would write every group thread under an id the\n' +
      'conversion and live detection will not recognise, and group threads cannot be retracted.\n' +
      'Both lists above came from THIS shell, not from the deployed stack: set them to the\n' +
      'values the target stage is deployed with (RUNBOOK, cutover checklist step 1).',
  );
  process.exit(1);
}

if (!dryRun && !yes) {
  console.log(
    '\nThis will write to the tables above. Re-run with --dry-run to preview, or --yes to proceed.',
  );
  process.exit(1);
}

const importedAt = new Date().toISOString();

let lastLabel = '';
const report = await runApply({
  doc,
  plan,
  review: { contacts: review.contacts, groups: review.groups, units: review.units },
  importedAt,
  dryRun,
  onProgress: (label, done, total) => {
    if (label !== lastLabel) {
      if (lastLabel) process.stdout.write('\n');
      lastLabel = label;
    }
    if (done % 50 === 0 || done === total) {
      process.stdout.write(`\r  ${label}: ${done}/${total}   `);
    }
  },
});
process.stdout.write('\n');

console.log('\n=== import:apply complete ===');
console.log(`  contacts written        : ${report.contacts.written}`);
console.log(`    dropped by review     : ${report.contacts.skippedDropped}`);
console.log(`    status preserved      : ${report.contacts.statusPreserved} (a human/automation had already decided)`);
console.log(`  conversations written   : ${report.conversations.written}`);
console.log(`    relay groups          : ${report.conversations.groups}`);
console.log(`    flagged connect-day-1 : ${report.conversations.connectedDayOne}`);
console.log(`    dropped by review     : ${report.conversations.droppedGroups}`);
console.log(
  `    drops KEPT on a group : ${report.conversations.groupRosterDropsKept} (a group roster is its thread identity - see the warnings)`,
);
// Print the reconciliation, not just the total, so a short count is never left
// looking like data loss (spec §5).
const unroutable = plan.threads.unroutable;
console.log(
  `  messages written        : ${report.messages.written} of ${plan.quo.messages.length} in the export`,
);
if (unroutable.messages.length > 0) {
  console.log(`    not importable        : ${unroutable.messages.length} (no outside participant)`);
}
console.log(
  `  calls written           : ${report.calls.written} of ${plan.quo.calls.length} in the export`,
);
if (unroutable.calls.length > 0) {
  console.log(
    `    not importable        : ${unroutable.calls.length} ` +
      `(${unroutable.anonymousCalls} withheld caller ID)`,
  );
}
console.log(`  units written           : ${report.units.written}`);
console.log(`    dropped by review     : ${report.units.skippedDropped}`);

if (report.warnings.length > 0) {
  console.log(`\n--- warnings (${report.warnings.length}) ---`);
  for (const w of report.warnings) console.log(`  ! ${w}`);
}

if (report.conversations.connectedDayOne > 0) {
  console.log(
    `\nNOTE: ${report.conversations.connectedDayOne} group(s) are marked connect-day-one. They are\n` +
      `imported as \`connecting\` and carry import_connect_requested. Provisioning a pool number\n` +
      `is a separate, deliberate step - the import never buys a Twilio number by itself.`,
  );
}

if (dryRun) console.log('\nDRY RUN - nothing was written.');
