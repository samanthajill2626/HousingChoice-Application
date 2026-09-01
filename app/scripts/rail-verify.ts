// rail:verify - walk every native group text and put its Conversations rail
// through the ONE authoritative ensureGroupRail, so a rail that cannot be
// posted to as the CURRENT business number is repaired now rather than on the
// first staff reply that hits it.
//
//   npm run rail:verify -- --env local|dev|prod [--yes]
//
// WHY THIS EXISTS (prod incident 2026-08-17). 135 of 136 prod rails carried no
// projected-address participant for +16782842537 - 132 imported rails never got
// one (the individual-add fallback's business add was refused and nothing
// looked), and 3 pre-port rails carried the released temp number - so every
// staff group reply was Twilio 50513 -> a 503, while inbound kept flowing through
// the SMS webhook. `ensureGroupRail` now verifies the author before it trusts a
// stored rail, and `groupSend` routes an unverified rail through it before
// posting, so each thread self-heals on its first send. This command does all
// of them up front, and reports what it found.
//
// CONVERGENT and read-mostly: a rail already verified for the current number is
// returned as `existing` with no Twilio call; anything else is re-read from
// Twilio and repaired through the same claim/fence protocol every other caller
// uses. Re-run until every row is `verified` or a listed refusal.
//
// STAGE TARGETING mirrors import:apply: `--env` picks the tables and the
// credentials (dev/prod through the pinned `housingchoice` profile behind the
// account guard), and loads the stage's operator env file (.env / .env.dev /
// .env.prod) for BUSINESS_PHONE_NUMBER and the Twilio credentials. Shell values
// win over the file - so run it from a FRESH shell, exactly as import:apply
// wants, or a stale local-lane BUSINESS_PHONE_NUMBER verifies every rail
// against the wrong number.
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
import { loadConfig } from '../src/lib/config.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { createGroupRailService, railAuthorVerified } from '../src/services/groupRail.js';

type TargetEnv = 'local' | 'dev' | 'prod';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const targetEnv = arg('--env');
const yes = process.argv.includes('--yes');

if (targetEnv !== 'local' && targetEnv !== 'dev' && targetEnv !== 'prod') {
  console.error(
    'Usage: npm run rail:verify -- --env local|dev|prod [--yes]\n\n' +
      '  --env   which stage to verify (dev/prod use the pinned housingchoice profile)\n' +
      '  --yes   perform the repairs (without it: report only, no Twilio writes)',
  );
  process.exit(2);
}
const target = targetEnv as TargetEnv;

// ---------------------------------------------------------------------------
// Stage config file - the same block import-apply.ts carries, for the same
// reason: BUSINESS_PHONE_NUMBER and the Twilio credentials must be the values
// the target stage is DEPLOYED with. Shell wins on overlap.
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
  const overridden: string[] = [];
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    } else if (process.env[key] !== value) {
      overridden.push(key);
    }
  }
  console.log(
    `stage config: ${stageFile.file} (${applied} value(s) loaded; shell env wins on overlap)`,
  );
  // The 2026-08-17 trigger, named out loud: a shell value shadowing the stage
  // file's BUSINESS_PHONE_NUMBER verifies every rail against the wrong number.
  if (overridden.includes('BUSINESS_PHONE_NUMBER')) {
    console.error(
      `\nREFUSED: the shell's BUSINESS_PHONE_NUMBER differs from ${stageFile.file}. This command ` +
        `verifies every rail against the business number, so it must be the one the ${target} stack ` +
        `is deployed with. Run it from a fresh shell.`,
    );
    process.exit(1);
  }
} else if (stageFile.required) {
  console.error(
    `--env ${target} reads ${stageFile.file} at the repo root, and it does not exist.\n` +
      `In a feature WORKTREE it is absent by default (gitignored files do not carry over): copy it\n` +
      `from the main checkout.`,
  );
  process.exit(1);
}
if (target !== 'local' && process.env.MESSAGING_DRIVER === undefined) {
  process.env.MESSAGING_DRIVER = 'twilio';
}

// ---------------------------------------------------------------------------
// Stage resolution - no ambient env vars, same as import:apply.
// ---------------------------------------------------------------------------
const LOCAL_ENDPOINT = 'http://localhost:8000';
const prefix = `hc-${target}-`;

let doc: DynamoDBDocumentClient;
if (target === 'local') {
  doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: HC_REGION,
      endpoint: LOCAL_ENDPOINT,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
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
const stageEnv = { ...process.env, TABLE_PREFIX: prefix };

const config = loadConfig();
const businessNumber = config.businessPhoneNumber;
if (businessNumber === undefined || businessNumber.length === 0) {
  console.error('\nREFUSED: BUSINESS_PHONE_NUMBER is not set - there is no author to verify the rails for.');
  process.exit(1);
}

console.log(`\ntarget stage    : ${target}${target === 'prod' ? '  *** PRODUCTION ***' : ''}`);
console.log(`table prefix    : ${prefix}`);
console.log(`business number : ${businessNumber}`);
console.log(`mode            : ${yes ? 'VERIFY + REPAIR' : 'REPORT ONLY (no Twilio writes)'}`);

const conversationsRepo = createConversationsRepo({ doc, env: stageEnv });

// Walk the whole group partition. `truncated` is a per-call page budget, not
// the end of the partition, so keep going while a cursor comes back.
const threads: ConversationItem[] = [];
let cursor: string | undefined;
do {
  const page = await conversationsRepo.listGroupTexts({ cursor, limit: 100 });
  threads.push(...page.items);
  cursor = page.nextCursor;
} while (cursor !== undefined);

const railed = threads.filter((t) => typeof t.twilio_conversation_sid === 'string');
const unverified = railed.filter((t) => !railAuthorVerified(t, businessNumber));
console.log(`\ngroup threads   : ${threads.length}`);
console.log(`  with a rail   : ${railed.length}`);
console.log(`  verified for ${businessNumber}: ${railed.length - unverified.length}`);
console.log(`  NOT verified  : ${unverified.length}`);
console.log(`  no rail yet   : ${threads.length - railed.length} (left to detection / the send backstop)`);

if (!yes) {
  console.log('\nREPORT ONLY - nothing was verified against Twilio. Re-run with --yes to repair.');
  process.exit(unverified.length === 0 ? 0 : 1);
}

// The STAGE repo must be injected (import-apply.ts learned this the hard way):
// left to its default the rail service builds its own repo on the ambient
// client + hc-local- prefix and every getById fails on dev/prod.
const rail = createGroupRailService({ config, conversationsRepo });

const totals = { verified: 0, repaired: 0, failed: 0 };
const failures: { conversationId: string; reason: string }[] = [];
let done = 0;
for (const thread of railed) {
  const result = await rail.ensureGroupRail({
    conversationId: thread.conversationId,
    members: thread.participants ?? [],
    // An operator run has no latency budget. Note this is largely INERT here:
    // every thread this script iterates already carries a rail sid, so it
    // adopts, and the ladder is skipped on an adopted rail. It bites only on the
    // delete-and-recreate branch, when the rail behind the sid turned out to be
    // closed - which is precisely when a re-created rail is seconds old.
    awaitBindingPropagation: true,
  });
  if (result.status === 'existing') totals.verified += 1;
  else if (result.status === 'created') totals.repaired += 1;
  else {
    totals.failed += 1;
    failures.push({ conversationId: thread.conversationId, reason: result.reason ?? result.status });
  }
  done += 1;
  if (done % 10 === 0 || done === railed.length) {
    process.stdout.write(`\r  verifying: ${done}/${railed.length}   `);
  }
}
process.stdout.write('\n');

console.log('\n=== rail:verify complete ===');
console.log(`  already verified : ${totals.verified}`);
console.log(`  REPAIRED         : ${totals.repaired} (re-read from Twilio, author attached/replaced as needed, re-stamped)`);
console.log(`  FAILED           : ${totals.failed}`);
for (const f of failures) console.log(`    ${f.conversationId}: ${f.reason}`);

if (totals.failed > 0) {
  console.error(
    '\nINCOMPLETE: some rails could not be verified. Fix the causes above and re-run; this command is convergent.',
  );
  process.exit(1);
}
console.log(`\nCOMPLETE: every railed group thread is verified for ${businessNumber}.`);
