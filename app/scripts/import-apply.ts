// import:apply (M1.6) - write the reviewed workbook + raw exports into DynamoDB.
//
//   npm run import:apply -- --quo <dir> --airtable <dir> --review <dir> [--dry-run]
//
// Idempotent: every write is keyed on a value derived from the source data, so
// re-running against the cutover export converges rather than duplicating
// (spec §3.2). Only import-owned fields are written, so a re-run after cutover
// does not revert work Sam has done in the app since (see apply.ts header).
//
// STAGE TARGETING: `--env local|dev|prod` (required). No environment variables:
//   local -> hc-local-* at DynamoDB Local (http://localhost:8000, fake creds)
//   dev   -> hc-dev-*  on AWS via the pinned `housingchoice` profile
//   prod  -> hc-prod-* on AWS via the pinned `housingchoice` profile
// dev/prod run assertHousingChoiceAccount() FIRST (scripts/lib/hcAws.mjs) - the
// default credential chain on this machine belongs to an UNRELATED account and
// is never used.
//
// STAGE CONFIG: each stage also loads its operator env file (.env for local,
// .env.dev / .env.prod for the AWS stages - required there), so the parity
// gate's identity vars and phase 2's Twilio credentials come from the same
// gitignored files the rest of the tooling uses. Shell values win over the
// file. See the stage-config block below.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  assertHousingChoiceAccount,
  hcCredentials,
  HC_PROFILE,
  HC_REGION,
} from '../../scripts/lib/hcAws.mjs';
import { parseDotenv } from '../../scripts/lib/secretsCore.mjs';
// Retained from the group-texting side: the pre-write group-identity parity
// gate below reads config. `getDocumentClient` is NOT retained - main's --env
// stage resolution builds the client with the account guard instead.
import { loadConfig } from '../src/lib/config.js';
import { groupReviewRowsByConversationId, runApply } from '../src/lib/import/apply.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createGroupRailService } from '../src/services/groupRail.js';
import {
  assertGroupIdentityEnvDeclared,
  assertGroupIdentityParity,
  GroupIdentityEnvUndeclaredError,
  GroupIdentityParityError,
  PoolNumbersUnavailableError,
  readPoolNumbersForParity,
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
import { createPoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const quoDir = arg('--quo');
const airtableDir = arg('--airtable');
const reviewDir = arg('--review');
const targetEnv = arg('--env');
const dryRun = process.argv.includes('--dry-run');
const yes = process.argv.includes('--yes');
// One-command posture (Cameron, 2026-08-13): apply CHAINS the group conversion
// unless told not to. The standalone import:convert-groups remains for the
// convergent re-run tail.
const skipConvert = process.argv.includes('--skip-convert');

const TARGETS = ['local', 'dev', 'prod'] as const;
type TargetEnv = (typeof TARGETS)[number];

if (!quoDir || !airtableDir || !reviewDir || !TARGETS.includes(targetEnv as TargetEnv)) {
  console.error(
    'Usage: npm run import:apply -- --env <local|dev|prod> --quo <dir> --airtable <dir> --review <dir> [--dry-run] [--yes]\n\n' +
      '  --env       REQUIRED target stage: local (DynamoDB Local), dev, or prod\n' +
      '  --quo       directory holding the three unpacked Quo export jobs\n' +
      '  --airtable  directory holding the Airtable CSV exports\n' +
      '  --review    the REVIEWED workbook directory (contacts.csv, groups.csv, units.csv)\n' +
      '  --dry-run   report what would be written, write nothing\n' +
      '  --yes       skip the confirmation prompt (for scripted runs)',
  );
  process.exit(2);
}
const target = targetEnv as TargetEnv;

// ---------------------------------------------------------------------------
// Stage config file (Cameron 2026-08-13). Each stage reads the same gitignored
// operator env file the rest of the tooling uses, so the identity/Twilio
// config does not have to be re-declared on the command line every run:
//   local -> .env       (optional local overrides)
//   dev   -> .env.dev   (required - the dev stack's operator config, the same
//   prod  -> .env.prod    values secrets:push mirrors to Parameter Store)
// Precedence mirrors scripts/lib/devMode.mjs: real environment > file > stage
// default. Only the SHELL can override a file value, so what this run compares
// in the parity gate is what the target stage is actually deployed with.
//
// The DB target is unaffected: endpoint/prefix/credentials come from --env in
// the stage-resolution block below, and .env.dev/.env.prod never carry
// TABLE_PREFIX or DYNAMODB_ENDPOINT (Terraform-owned, secrets denylist).
//
// dev/prod also default MESSAGING_DRIVER=twilio, exactly like the dev loop's
// live mode: deployed stacks inherit `twilio` from NODE_ENV=production, which
// a locally-run CLI does not have. Without this, phase 2 would silently build
// its rail service on the CONSOLE driver and report all 132 rails failed.
// ---------------------------------------------------------------------------
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const STAGE_ENV_FILES: Record<TargetEnv, { file: string; required: boolean }> = {
  local: { file: '.env', required: false },
  dev: { file: '.env.dev', required: true },
  prod: { file: '.env.prod', required: true },
};
const stageFile = STAGE_ENV_FILES[target];
const stageFilePath = join(repoRoot, stageFile.file);
if (existsSync(stageFilePath)) {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseDotenv(readFileSync(stageFilePath, 'utf8'));
  } catch (err) {
    console.error(
      `${stageFile.file} is not valid dotenv: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  let applied = 0;
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  console.log(
    `stage config: ${stageFile.file} (${applied} value(s) loaded; shell env wins on overlap)`,
  );
} else if (stageFile.required) {
  console.error(
    `--env ${target} reads ${stageFile.file} at the repo root, and it does not exist.\n` +
      `It holds the ${target} stack's operator config (TWILIO_* credentials, BUSINESS_PHONE_NUMBER,\n` +
      `GROUP_IDENTITY_EXCLUDED_NUMBERS - the same values secrets:push mirrors to Parameter Store).\n` +
      `In a feature WORKTREE it is absent by default (gitignored files do not carry over): copy it\n` +
      `from the main checkout, or copy ${stageFile.file}.example and fill it in.`,
  );
  process.exit(1);
}
if (target !== 'local' && process.env.MESSAGING_DRIVER === undefined) {
  process.env.MESSAGING_DRIVER = 'twilio';
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

// ---------------------------------------------------------------------------
// Stage resolution — no environment variables. Local gets DynamoDB Local with
// fake credentials; dev/prod get the pinned profile AND the account guard, so
// the machine's default (wrong-account) credential chain can never be used.
// ---------------------------------------------------------------------------
const LOCAL_ENDPOINT = 'http://localhost:8000';
const prefix = `hc-${target}-`;
const endpoint = target === 'local' ? LOCAL_ENDPOINT : undefined;

let doc: DynamoDBDocumentClient;
if (target === 'local') {
  doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: HC_REGION,
      endpoint: LOCAL_ENDPOINT,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    // Must match lib/dynamo.ts createDocumentClient: dropping undefineds is
    // what keeps the sparse GSIs sparse.
    { marshallOptions: { removeUndefinedValues: true } },
  );
} else {
  const identity = await assertHousingChoiceAccount();
  console.log(
    `account guard OK: profile "${HC_PROFILE}" -> account ${identity.Account} (${identity.Arn})`,
  );
  doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: HC_REGION, credentials: hcCredentials() }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

// Physical table names come from the RESOLVED stage, never ambient env vars.
// ONE definition, used by every repo/read below: the parity gate's pool-number
// read once omitted it and silently queried the DEFAULT hc-local- prefix on
// AWS - "Requested resource not found" on every dev/prod run, dry runs
// included.
const stageEnv = { ...process.env, TABLE_PREFIX: prefix };

console.log(`\ntarget stage    : ${target}${target === 'prod' ? '  *** PRODUCTION ***' : ''}`);
console.log(`target endpoint : ${endpoint ?? `AWS ${HC_REGION} (profile ${HC_PROFILE})`}`);
console.log(`table prefix    : ${prefix}`);
console.log(`mode            : ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

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
// ambient process.env, and an unset GROUP_IDENTITY_EXCLUDED_NUMBERS silently
// means "compare against nothing" and refuses EVERY documented invocation, dry
// run included. Both vars normally arrive via the stage env file loaded above
// (.env.dev / .env.prod hold the deployed values); the shell can override, and
// the refusal says which var is missing and where the value comes from.
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
  poolNumbers = await readPoolNumbersForParity(
    () => createPoolNumbersRepo({ doc, env: stageEnv }).listActive(),
    {
      onRetry: (attempt, err) =>
        console.warn(
          `  ! pool-number read failed (attempt ${attempt}): ` +
            `${err instanceof Error ? err.message : String(err)} - retrying`,
        ),
    },
  );
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
  env: stageEnv,
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

// ---------------------------------------------------------------------------
// Phase 2: group conversion, CHAINED (Cameron 2026-08-13 - "one command that
// imports everything properly"). Same machinery as import:convert-groups, same
// gates (asserted at the top of this script), same stage resolution as the
// writes above. Skipped on dry runs (rails are real provider resources) and
// with --skip-convert. The standalone command remains the convergent re-run
// tail: a partial conversion here exits 1, and either command continues it.
// ---------------------------------------------------------------------------
if (!dryRun && !skipConvert) {
  console.log('\nphase 2: converting group threads to native group texts');

  const conversationsRepo = createConversationsRepo({ doc, env: stageEnv });
  const contactsRepo = createContactsRepo({ doc, env: stageEnv });

  const droppedPhones = new Set<string>();
  for (const person of plan.merge.people) {
    const contactRow = review.contacts.get(person.rowKey);
    if (contactRow && isDropped(contactRow)) droppedPhones.add(person.phone);
  }
  const groupRows = groupReviewRowsByConversationId(plan, review.groups);
  const expected: ExpectedGroup[] = [];
  plan.threads.threads
    .filter((t) => t.isGroup)
    .forEach((thread, idx) => {
      const rowKey = `GRP-${String(idx + 1).padStart(4, '0')}`;
      const groupRow = groupRows.get(thread.conversationId);
      const everyoneDropped = thread.participants.every((p) => droppedPhones.has(p));
      if ((groupRow !== undefined && isDropped(groupRow)) || everyoneDropped) return;
      expected.push({ conversationId: thread.conversationId, rowKey });
    });

  const config = loadConfig();
  let poolNumbers: string[] = [];
  try {
    poolNumbers = await readPoolNumbersForParity(
      () => createPoolNumbersRepo({ doc, env: stageEnv }).listActive(),
      {
        onRetry: (attempt, err) =>
          console.warn(
            `  ! pool-number read failed (attempt ${attempt}): ` +
              `${err instanceof Error ? err.message : String(err)} - retrying`,
          ),
      },
    );
  } catch (err) {
    if (!(err instanceof PoolNumbersUnavailableError)) throw err;
    console.error(`\n${err.message}`);
    console.error('\nApply SUCCEEDED; conversion did not run. Re-run this command or');
    console.error('import:convert-groups once the pool-number read is healthy.');
    process.exit(1);
  }

  const convertReport = await runConvertGroups({
    conversationsRepo,
    contactsRepo,
    expected,
    // The STAGE repo must be injected: left to its default, the rail service
    // builds its own conversations repo on the ambient doc client + default
    // hc-local- prefix, and its first getById throws "Requested resource not
    // found" on every dev/prod row - before Twilio is ever contacted, and
    // before recordRailFailure can stamp a reason.
    rail: createGroupRailService({ config, conversationsRepo }),
    ownNumbers: plan.quo.ownNumbers,
    exclusions: {
      businessPhoneNumber: config.businessPhoneNumber,
      poolNumbers,
      configuredNumbers: config.groupIdentityExcludedNumbers,
    },
    at: new Date().toISOString(),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  converging: ${done}/${total}   `);
      }
    },
  });
  process.stdout.write('\n');

  const t = convertReport.totals;
  console.log(`  converted              : ${t.converted}`);
  console.log(`  already converted      : ${t.alreadyConverted}`);
  console.log(`  refused                : ${t.refused}`);
  console.log(`  rails created          : ${t.railsCreated}`);
  console.log(`  rails already present  : ${t.railsExisting}`);
  console.log(`  rails FAILED           : ${t.railsFailed}`);
  if (t.railAdjudicationRequired > 0) {
    console.log(`  ADJUDICATION REQUIRED  : ${t.railAdjudicationRequired}`);
  }

  if (!convertReport.complete) {
    console.error(
      '\nCONVERSION INCOMPLETE - apply succeeded, but some group rows are refused or ' +
        'rail-less. CONVERGENT: re-run this same command (or import:convert-groups) until ' +
        'it reports complete.',
    );
    process.exit(1);
  }
  console.log('\ngroup conversion COMPLETE - all group threads are native group texts.');
} else if (dryRun && !skipConvert) {
  console.log(
    '\nNOTE: group conversion does not run on a dry run (rails are real provider ' +
      'resources). The real run converts automatically.',
  );
}
