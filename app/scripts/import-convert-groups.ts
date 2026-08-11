// import:convert-groups - turn the imported relay groups into native group
// texts (group-texting spec section 9; run at cutover, after import:apply).
//
//   npm run import:convert-groups -- --quo <dir> --airtable <dir> --review <dir> [--yes]
//
// It takes the SAME three directories import:apply takes, and for the same
// reason: the set of group ids to converge is re-derived FROM THE EXPORT on
// every run (worklist A26). Asking the database instead would work exactly once
// - a converted row is no longer a connecting relay group, so the second run
// would find nothing and report success while leaving every half-finished
// thread (converted but unstamped, or rail-less) exactly as it was.
//
// CONVERGENT: safe and expected to re-run until it reports COMPLETE. Exit 1
// while any row is refused or has no rail, so a runbook step cannot pass with
// work outstanding.
//
// TARGETS WHATEVER DYNAMODB_ENDPOINT / TABLE_PREFIX POINT AT, exactly as
// import:apply and db:seed do. There is no built-in "prod" mode.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { groupReviewRowsByConversationId } from '../src/lib/import/apply.js';
import {
  GroupIdentityParityError,
  runConvertGroups,
  type ExpectedGroup,
} from '../src/lib/import/convertGroups.js';
import { runPlan } from '../src/lib/import/plan.js';
import {
  CONTACTS_FILE,
  GROUPS_FILE,
  UNITS_FILE,
  isDropped,
  parseWorkbook,
} from '../src/lib/import/workbook.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createPoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';
import { createGroupRailService } from '../src/services/groupRail.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const quoDir = arg('--quo');
const airtableDir = arg('--airtable');
const reviewDir = arg('--review');
const yes = process.argv.includes('--yes');

if (!quoDir || !airtableDir || !reviewDir) {
  console.error(
    'Usage: npm run import:convert-groups -- --quo <dir> --airtable <dir> --review <dir> [--yes]\n\n' +
      '  --quo       directory holding the three unpacked Quo export jobs\n' +
      '  --airtable  directory holding the Airtable CSV exports\n' +
      '  --review    the REVIEWED workbook directory (contacts.csv, groups.csv, units.csv)\n' +
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

console.log('import:convert-groups - re-planning from the exports to rebuild the group ids...');
const plan = runPlan({ quoDir, airtableDir });

// The workbook must have been generated from THESE exports - the same refusal
// import:apply makes, for the same reason: the groups tab is keyed by POSITION,
// so a workbook built from a different plan attaches her drop decisions to the
// wrong threads.
const planKeys = new Set(plan.merge.people.map((p) => p.rowKey));
const reviewKeys = new Set(review.contacts.keys());
const missing = [...planKeys].filter((k) => !reviewKeys.has(k));
const extra = [...reviewKeys].filter((k) => !planKeys.has(k));
if (missing.length > 0 || extra.length > 0) {
  console.error(
    `\nREFUSED: the reviewed workbook does not match these exports.\n` +
      `  rows in the plan but not the workbook: ${missing.length}\n` +
      `  rows in the workbook but not the plan: ${extra.length}\n\n` +
      `Convert from the SAME export you applied, or the group ids will not line up.`,
  );
  process.exit(1);
}

// The same exclusions import:apply applies, so the expected set matches what was
// actually written: a group the founder dropped was never imported, and neither
// was one whose every participant she dropped.
const droppedPhones = new Set<string>();
for (const person of plan.merge.people) {
  const row = review.contacts.get(person.rowKey);
  if (row && isDropped(row)) droppedPhones.add(person.phone);
}
const groupRows = groupReviewRowsByConversationId(plan, review.groups);
const expected: ExpectedGroup[] = [];
let skippedDropped = 0;
plan.threads.threads
  .filter((t) => t.isGroup)
  .forEach((thread, idx) => {
    const rowKey = `GRP-${String(idx + 1).padStart(4, '0')}`;
    const groupRow = groupRows.get(thread.conversationId);
    const everyoneDropped = thread.participants.every((p) => droppedPhones.has(p));
    if ((groupRow !== undefined && isDropped(groupRow)) || everyoneDropped) {
      skippedDropped += 1;
      return;
    }
    expected.push({ conversationId: thread.conversationId, rowKey });
  });

const config = loadConfig();
const endpoint = process.env.DYNAMODB_ENDPOINT ?? '(AWS default)';
const prefix = process.env.TABLE_PREFIX ?? 'hc-local-';
console.log(`\ntarget endpoint : ${endpoint}`);
console.log(`table prefix    : ${prefix}`);
console.log(`groups expected : ${expected.length} (${skippedDropped} excluded by the workbook)`);

if (!yes) {
  console.log('\nThis will convert the group threads above. Re-run with --yes to proceed.');
  process.exit(1);
}

const doc = getDocumentClient();
const conversationsRepo = createConversationsRepo({ doc });
const contactsRepo = createContactsRepo({ doc });
// Pool numbers are subtracted from BOTH sides of the parity comparison, so they
// only matter if one ever appears in the export or in the configured list.
// Reading them makes the comparison exactly the one spec 4.1 names; failing to
// read them is not fatal, because the worst case is a FALSE MISMATCH, which
// refuses the run rather than converting anything wrongly.
let poolNumbers: string[] = [];
try {
  poolNumbers = (await createPoolNumbersRepo({ doc }).listActive()).map((p) => p.poolNumber);
} catch (err) {
  console.warn(
    `  ! could not read the pool numbers (${err instanceof Error ? err.message : String(err)}). ` +
      'Comparing without them; a pool number in either list would show up as a mismatch.',
  );
}

let report;
try {
  report = await runConvertGroups({
    conversationsRepo,
    contactsRepo,
    expected,
    // T6.6(c): the rail step, SYNCHRONOUS per row. This is the whole point of
    // eager rails - a 50407-class refusal (a landline in a roster, a number
    // Twilio will not attach) lands in THIS report, at the migration window,
    // instead of surfacing weeks later as a staff reply that will not send.
    rail: createGroupRailService({ config }),
    ownNumbers: plan.quo.ownNumbers,
    exclusions: {
      businessPhoneNumber: config.businessPhoneNumber,
      poolNumbers,
      configuredNumbers: config.groupIdentityExcludedNumbers,
    },
    at: new Date().toISOString(),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stdout.write(`\r  converging: ${done}/${total}   `);
    },
  });
  process.stdout.write('\n');
} catch (err) {
  if (!(err instanceof GroupIdentityParityError)) throw err;
  // The one refusal that stops everything: nothing was converted.
  console.error(`\n${err.message}`);
  process.exit(1);
}

console.log('\n=== import:convert-groups complete ===');
// The arithmetic ties out by eye, in both directions:
//   expected  = processed + duplicate ids
//   processed = converted + already converted + REFUSED
console.log(`  expected groups        : ${report.totals.expected}`);
console.log(`    duplicate ids        : ${report.totals.duplicateIds}`);
console.log(`  processed              : ${report.totals.processed}`);
console.log(`    converted this run   : ${report.totals.converted}`);
console.log(`    already converted    : ${report.totals.alreadyConverted}`);
console.log(`    REFUSED              : ${report.totals.refused}`);
console.log(`  contactIds backfilled  : ${report.totals.contactIdsBackfilled}`);
console.log(`  member names backfilled: ${report.totals.namesBackfilled}`);
console.log(`  members stamped        : ${report.totals.membersStamped}`);
console.log(`  members with no record : ${report.totals.membersMissing}`);
console.log(`  rails created          : ${report.totals.railsCreated}`);
console.log(`  rails already present  : ${report.totals.railsExisting}`);
console.log(`  rails FAILED           : ${report.totals.railsFailed}`);
console.log(`  rails NOT ATTEMPTED    : ${report.totals.railsUnavailable}`);
console.log(
  `  connect-day-one flags  : ${report.totals.connectRequested} (reported only - they convert like the rest)`,
);

if (report.warnings.length > 0) {
  console.log(`\n--- warnings (${report.warnings.length}) ---`);
  for (const w of report.warnings) console.log(`  ! ${w}`);
}

for (const row of report.rows.filter((r) => r.outcome === 'refused' || r.rail !== 'created')) {
  if (row.outcome === 'refused' || row.rail === 'failed' || row.rail === 'unavailable') {
    console.log(
      `  ${row.rowKey ?? row.conversationId}: ${row.outcome}, rail ${row.rail}` +
        (row.railReason !== undefined ? ` (${row.railReason})` : ''),
    );
  }
}

if (!report.complete) {
  console.error(
    '\nINCOMPLETE: some group threads did not reach the full end state. This command is ' +
      'convergent - fix the causes above and run it again until it reports complete.',
  );
  process.exit(1);
}

console.log('\nCOMPLETE: every expected group thread is a native group text with a rail.');
