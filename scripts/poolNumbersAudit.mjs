// Pool-number audit - reconcile Twilio's actual phone-number inventory against
// the hc-<env>-pool_numbers DynamoDB table. Powers:
//
//   npm run pool:audit -- <dev|prod>              READ-ONLY report (default)
//   npm run pool:audit -- <dev|prod> --reimport   also RE-CREATE missing rows
//
// WHY: a data wipe (npm run wipe:dev) empties pool_numbers like every table,
// but the purchased Twilio numbers still exist - owned, billed, attached to
// the Messaging Service, webhooked at us - with no DB record. The app then
// can't route inbound SMS on them and a fresh relay group buys ANOTHER number.
// This script makes the drift visible and (with --reimport) restores the rows.
//
// HOW relay numbers are identified (there is no Twilio-side tag): every pool
// number is bought AND attached to our Messaging Service by the warm-pool
// driver (services/poolNumbers.ts), and the business line(s) are the
// OUR_PHONE_NUMBERS list in .env.<env>. So:
//
//   relay pool number  =  attached to the Messaging Service
//                         AND NOT in OUR_PHONE_NUMBERS
//
// The report classifies every number the Twilio ACCOUNT owns:
//   - business        in OUR_PHONE_NUMBERS (never touched)
//   - pool, tracked   MS-attached, has a pool_numbers row -> OK
//   - pool, STRANDED  MS-attached, NO pool_numbers row -> the post-wipe case;
//                     --reimport fixes exactly these
//   - unattached      owned but not MS-attached and not business - a
//                     half-provisioned buy (crash between purchase and
//                     attach) or something console-created; review manually
// ...and every pool_numbers row without a live account number:
//   - released rows   expected (release hands the number back to Twilio)
//   - other rows      ORPHAN - record says we own it, Twilio says we don't
//
// --reimport writes rows ONLY for the STRANDED class, as:
//   lifecycle_state 'active', empty burn set, voice/sms capabilities from
//   Twilio, the PN SID, provisioned_via 'twilio', + reimported_at provenance.
// Post-wipe this is faithful: the old burn sets referenced contacts the wipe
// deleted anyway, so an empty burn is correct, and 'active' matches a number
// that completed A2P registration (a number wiped mid-warming re-enters as
// assignable - acceptable for dev; prod should not be wiped at all).
// Conditional put (attribute_not_exists) - an existing row is NEVER stomped.
//
// Auth: Twilio creds + TWILIO_MESSAGING_SERVICE_SID + OUR_PHONE_NUMBERS come
// from .env.<env> (template-first, gitignored). AWS goes through the pinned
// housingchoice profile with the account guard, like every hc script.
//
// PII note: this is an OPERATOR review tool - it prints phone numbers to the
// terminal by design (same information the Settings pool-inventory page
// shows). Nothing here goes to structured logs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DynamoDBClient, ScanCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

import { assertHousingChoiceAccount, hcCredentials, HC_REGION, STACK_ENVS } from './lib/hcAws.mjs';
import { parseDotenv } from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/poolNumbersAudit.mjs <dev|prod> [--reimport]
  (via npm: npm run pool:audit -- dev)
  Reconciles the Twilio number inventory (account + Messaging Service) against
  the hc-<env>-pool_numbers table. Read-only by default; --reimport re-creates
  rows for Messaging-Service-attached non-business numbers that have no row
  (the post-wipe recovery), never touching existing rows.`;

// Mirrors NOT_QUARANTINED_SENTINEL in app/src/repos/poolNumbersRepo.ts: the
// byLifecycleState GSI range key must be present on every row (a GSI only
// indexes items carrying BOTH key attrs), so rows carry this fixed past-time
// sentinel that is never compared against.
const NOT_QUARANTINED_SENTINEL = '0000-00-00T00:00:00.000Z';

class ExitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const fail = (message) => {
  throw new ExitError(message, 1);
};

/** GET a Twilio REST URL (basic auth), returning parsed JSON or throwing. */
async function twilioGet(url, authHeader) {
  let res;
  try {
    // Connection: close - no keep-alive socket lingers, so the event loop
    // drains and the process exits promptly (same as twilioVi.mjs).
    res = await fetch(url, { headers: { Authorization: authHeader, Connection: 'close' } });
  } catch (err) {
    fail(`[pool:audit] network error calling Twilio (${url}): ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(`[pool:audit] Twilio ${res.status} on ${url}: ${body.message ?? JSON.stringify(body)}`);
  }
  return body;
}

/** All IncomingPhoneNumbers the ACCOUNT owns (2010-04-01 API, next_page_uri paging). */
async function listAccountNumbers(accountSid, authHeader) {
  const numbers = [];
  let pageUri = `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=100`;
  while (pageUri) {
    const body = await twilioGet(`https://api.twilio.com${pageUri}`, authHeader);
    for (const n of body.incoming_phone_numbers ?? []) {
      numbers.push({
        phoneNumber: n.phone_number, // E.164
        sid: n.sid, // PN...
        voice: Boolean(n.capabilities?.voice),
        sms: Boolean(n.capabilities?.sms),
      });
    }
    pageUri = body.next_page_uri ?? null;
  }
  return numbers;
}

/** E.164 set of numbers attached to the Messaging Service (v1 API, meta.next_page_url paging). */
async function listMessagingServiceNumbers(messagingServiceSid, authHeader) {
  const attached = new Set();
  let url = `https://messaging.twilio.com/v1/Services/${messagingServiceSid}/PhoneNumbers?PageSize=100`;
  while (url) {
    const body = await twilioGet(url, authHeader);
    for (const n of body.phone_numbers ?? []) attached.add(n.phone_number);
    url = body.meta?.next_page_url ?? null;
  }
  return attached;
}

/** Every pool_numbers row (poolNumber, lifecycle_state, sid) - the table is small. */
async function listPoolRows(ddb, table) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'poolNumber, lifecycle_state, sid',
        ...(ExclusiveStartKey && { ExclusiveStartKey }),
      }),
    );
    for (const item of page.Items ?? []) {
      rows.push({
        poolNumber: item.poolNumber?.S,
        state: item.lifecycle_state?.S ?? '(none)',
        sid: item.sid?.S,
      });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const env = args.shift();
  if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);
  let reimport = false;
  for (const arg of args) {
    if (arg === '--reimport') reimport = true;
    else fail(`Unknown argument "${arg}".\n${USAGE}`);
  }

  // --- .env.<env>: Twilio creds + Messaging Service + business numbers ---------
  const envFile = path.join(repoRoot, `.env.${env}`);
  if (!existsSync(envFile)) fail(`[pool:audit] .env.${env} not found at the repo root.`);
  const entries = parseDotenv(readFileSync(envFile, 'utf8'));

  const accountSid = entries.TWILIO_ACCOUNT_SID;
  const authToken = entries.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = entries.TWILIO_MESSAGING_SERVICE_SID;
  if (!accountSid || !authToken) {
    fail(`[pool:audit] .env.${env} must define TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.`);
  }
  if (!messagingServiceSid) {
    fail(
      `[pool:audit] .env.${env} does not define TWILIO_MESSAGING_SERVICE_SID - without it ` +
        `relay numbers cannot be told apart from anything else. Nothing was read or written.`,
    );
  }
  const businessNumbers = new Set(
    (entries.OUR_PHONE_NUMBERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  // --- AWS side (account guard first, like every hc script) --------------------
  const identity = await assertHousingChoiceAccount();
  const table = `hc-${env}-pool_numbers`;
  const ddb = new DynamoDBClient({ region: HC_REGION, credentials: hcCredentials() });

  process.stdout.write(
    `\npool-number audit - ${reimport ? 'REIMPORT (writes missing rows)' : 'READ-ONLY report'}\n` +
      `  aws account : ${identity.Account} (pinned HousingChoice)\n` +
      `  table       : ${table}\n` +
      `  twilio      : ${accountSid} / messaging service ${messagingServiceSid}\n` +
      `  business    : ${businessNumbers.size ? [...businessNumbers].join(', ') : '(OUR_PHONE_NUMBERS is empty!)'}\n`,
  );

  const [accountNumbers, msAttached, poolRows] = await Promise.all([
    listAccountNumbers(accountSid, authHeader),
    listMessagingServiceNumbers(messagingServiceSid, authHeader),
    listPoolRows(ddb, table),
  ]);
  const rowByNumber = new Map(poolRows.map((r) => [r.poolNumber, r]));
  const ownedNumbers = new Set(accountNumbers.map((n) => n.phoneNumber));

  // --- classify every number the account owns ----------------------------------
  const business = [];
  const tracked = [];
  const stranded = [];
  const unattached = [];
  for (const n of accountNumbers) {
    const inMs = msAttached.has(n.phoneNumber);
    if (businessNumbers.has(n.phoneNumber)) business.push({ ...n, inMs });
    else if (!inMs) unattached.push(n);
    else if (rowByNumber.has(n.phoneNumber)) tracked.push({ ...n, row: rowByNumber.get(n.phoneNumber) });
    else stranded.push(n);
  }

  process.stdout.write(`\nTwilio account owns ${accountNumbers.length} number(s):\n`);
  process.stdout.write(`\n  Business (OUR_PHONE_NUMBERS - never pool, never touched):\n`);
  if (!business.length) process.stdout.write(`    (none of the owned numbers is listed in OUR_PHONE_NUMBERS)\n`);
  for (const n of business) {
    process.stdout.write(
      `    ${n.phoneNumber}  ${n.sid}` +
        (n.inMs ? '\n' : '  [NOT attached to the messaging service - check A2P wiring]\n'),
    );
  }

  process.stdout.write(`\n  Relay pool - tracked (messaging-service-attached, row present):\n`);
  if (!tracked.length) process.stdout.write(`    (none)\n`);
  for (const n of tracked) {
    process.stdout.write(`    ${n.phoneNumber}  ${n.sid}  [db: ${n.row.state}]\n`);
  }

  process.stdout.write(`\n  Relay pool - STRANDED (messaging-service-attached, NO pool_numbers row):\n`);
  if (!stranded.length) process.stdout.write(`    (none)\n`);
  for (const n of stranded) {
    process.stdout.write(`    ${n.phoneNumber}  ${n.sid}  <- unroutable + invisible to the app\n`);
  }

  if (unattached.length) {
    process.stdout.write(
      `\n  Owned but NOT messaging-service-attached and NOT business (half-provisioned ` +
        `buy or console-created - review in the Twilio console):\n`,
    );
    for (const n of unattached) process.stdout.write(`    ${n.phoneNumber}  ${n.sid}\n`);
  }

  // --- rows whose number Twilio no longer owns ---------------------------------
  const rowsWithoutNumber = poolRows.filter((r) => r.poolNumber && !ownedNumbers.has(r.poolNumber));
  const expectedReleased = rowsWithoutNumber.filter((r) => r.state === 'released');
  const orphans = rowsWithoutNumber.filter((r) => r.state !== 'released');
  if (expectedReleased.length) {
    process.stdout.write(`\n  Released rows (number handed back to Twilio - expected): ${expectedReleased.length}\n`);
  }
  if (orphans.length) {
    process.stdout.write(`\n  ORPHAN rows (db says we hold the number, Twilio says we do not):\n`);
    for (const r of orphans) process.stdout.write(`    ${r.poolNumber}  [db: ${r.state}]\n`);
  }

  // --- reimport ----------------------------------------------------------------
  if (!reimport) {
    if (stranded.length) {
      process.stdout.write(
        `\n${stranded.length} stranded number(s). Re-create their rows with:\n` +
          `  npm run pool:audit -- ${env} --reimport\n`,
      );
    } else {
      process.stdout.write(`\nNo stranded numbers - Twilio and ${table} agree.\n`);
    }
    return;
  }

  process.stdout.write(`\nReimporting ${stranded.length} stranded number(s) into ${table}:\n`);
  if (!stranded.length) process.stdout.write(`  (nothing to do)\n`);
  const nowIso = new Date().toISOString();
  for (const n of stranded) {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            poolNumber: { S: n.phoneNumber },
            lifecycle_state: { S: 'active' },
            quarantine_until: { S: NOT_QUARANTINED_SENTINEL },
            voice_capable: { BOOL: n.voice },
            sms_capable: { BOOL: n.sms },
            provisioned_via: { S: 'twilio' },
            sid: { S: n.sid },
            provisioned_at: { S: nowIso },
            // Provenance: this row was reconstructed from Twilio, not bought
            // fresh - burn history from before the wipe is gone (correctly:
            // the contacts it referenced were wiped too).
            reimported_at: { S: nowIso },
          },
          ConditionExpression: 'attribute_not_exists(poolNumber)',
        }),
      );
      process.stdout.write(`  - ${n.phoneNumber}: reimported as 'active' (empty burn, sid ${n.sid})\n`);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        process.stdout.write(`  - ${n.phoneNumber}: row appeared since the scan - left unchanged\n`);
      } else {
        throw err;
      }
    }
  }
  process.stdout.write(`\nDone. Re-run without --reimport to verify a clean report.\n`);
}

main().catch((err) => {
  process.stderr.write(`\npool:audit FAILED: ${err.message}\n`);
  process.exitCode = err instanceof ExitError ? err.code : 1;
});
