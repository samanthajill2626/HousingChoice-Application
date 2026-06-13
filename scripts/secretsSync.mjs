// Template-first sync of a real .env.<env> against its committed template
// .env.<env>.example. Powers:
//   npm run secrets:sync -- <dev|prod>            write .env.<env> so it mirrors
//                                                 the template's COMMENTS +
//                                                 STRUCTURE, preserving the real
//                                                 file's secret VALUES; new keys
//                                                 land empty
//   npm run secrets:sync -- <dev|prod> --check    READ-ONLY: report what WOULD
//                                                 change (incl. comment drift,
//                                                 which secrets:check does NOT
//                                                 cover) — exit 0 in sync, 2
//                                                 drift, 1 error
//
// Purely LOCAL file IO: NO AWS, NO account guard (it reaches no account). The
// committed .env.<env>.example is the source of truth for comments/structure/
// key-set; the gitignored .env.<env> holds the real values. This is the
// reliable mechanism behind the template-first rule — it replaces the fragile
// hand-appending that kept missing new-key comments and comment edits.
//
// VALUES ARE NEVER PRINTED: the summary is KEY NAMES + COUNTS only. The pure,
// unit-tested transform lives in scripts/lib/secretsCore.mjs (syncEnvFromExample).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncEnvFromExample } from './lib/secretsCore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STACK_ENVS = ['dev', 'prod'];

const USAGE = `usage: node scripts/secretsSync.mjs <dev|prod> [--check]
  (via npm: npm run secrets:sync -- dev, npm run secrets:sync -- prod --check)
  default  rewrite .env.<env> to mirror .env.<env>.example's comments/structure,
           preserving your existing values; new keys appear empty (fill them)
  --check  read-only: report what WOULD change (new/extra keys, comment/structure
           drift) — exit 0 in sync, 2 drift, 1 error. Does NOT write the file.`;

/** Print a message and exit 1 (error). */
function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv ------------------------------------------------------------------------
const args = process.argv.slice(2);
const env = args.shift();
if (!STACK_ENVS.includes(env ?? '')) fail(USAGE);
const checkOnly = args[0] === '--check' ? (args.shift(), true) : false;
if (args.length > 0) fail(`Unknown argument "${args[0]}".\n${USAGE}`);

// --- resolve the template + real file at the repo root ---------------------------
const envFileName = `.env.${env}`;
const exampleFileName = `${envFileName}.example`;
const envFile = path.join(repoRoot, envFileName);
const exampleFile = path.join(repoRoot, exampleFileName);

if (!existsSync(exampleFile)) {
  fail(
    `[secrets:sync] ${exampleFileName} not found at the repo root.\n` +
      `The committed template is the source of truth for comments/structure — ` +
      `nothing to sync against.`,
  );
}

const exampleText = readFileSync(exampleFile, 'utf8');

// --- real file missing -----------------------------------------------------------
if (!existsSync(envFile)) {
  if (checkOnly) {
    console.error(
      `[secrets:sync] ${envFileName} does not exist.\n` +
        `Run \`npm run secrets:sync -- ${env}\` (no --check) to create it from ` +
        `${exampleFileName} with all values empty, then fill them in.`,
    );
    process.exit(2);
  }
  // Create it from the template: every value empty (real file = '' has no keys,
  // so every example key is "new"). EOL follows the template.
  let created;
  try {
    created = syncEnvFromExample(exampleText, '');
  } catch (err) {
    fail(`[secrets:sync] cannot sync — ${err.message}`);
  }
  writeFileSync(envFile, created.output, 'utf8'); // UTF-8, no BOM
  console.error(
    `[secrets:sync] created ${envFileName} from ${exampleFileName} ` +
      `(${created.summary.newKeys.length} key(s), all empty — fill them in, then ` +
      `\`npm run secrets:push -- ${env}\`).`,
  );
  process.exit(0);
}

const realText = readFileSync(envFile, 'utf8');

// --- compute the sync (pure; throws on malformed dotenv / denylisted template) ----
let result;
try {
  result = syncEnvFromExample(exampleText, realText);
} catch (err) {
  fail(`[secrets:sync] cannot sync — ${err.message}`);
}
const { output, summary } = result;
const { newKeys, preservedKeys, extraKeys, changed } = summary;

// --- --check: report-only, exit 2 on any drift -----------------------------------
if (checkOnly) {
  if (!changed) {
    console.error(`[secrets:sync] ${envFileName} is in sync with ${exampleFileName}.`);
    process.exit(0);
  }
  console.error(`[secrets:sync] ${envFileName} is OUT OF SYNC with ${exampleFileName}:`);
  if (newKeys.length > 0) {
    console.error(`  new keys in the template (would be added, empty): ${newKeys.join(', ')}`);
  }
  if (extraKeys.length > 0) {
    console.error(`  extra keys not in the template (would be moved under a review section): ${extraKeys.join(', ')}`);
  }
  if (newKeys.length === 0 && extraKeys.length === 0) {
    // Key sets already match, so the only difference is comments/structure —
    // exactly the drift secrets:check cannot see.
    console.error('  comments/structure differ (a comment was edited in the template)');
  }
  console.error(`  fix with: npm run secrets:sync -- ${env}`);
  process.exit(2);
}

// --- default: write the synced file ----------------------------------------------
if (!changed) {
  console.error(`[secrets:sync] ${envFileName} already in sync with ${exampleFileName} — nothing to do.`);
  process.exit(0);
}

writeFileSync(envFile, output, 'utf8'); // UTF-8, no BOM

console.error(`[secrets:sync] comments/structure synced from ${exampleFileName} into ${envFileName}.`);
console.error(`  values preserved: ${preservedKeys.length}`);
if (newKeys.length > 0) {
  console.error(`  new keys (now present, empty — fill them): ${newKeys.join(', ')}`);
}
if (extraKeys.length > 0) {
  console.error(`  extra keys not in template (review): ${extraKeys.join(', ')}`);
}
console.error(`  next: fill any new values, then \`npm run secrets:push -- ${env}\`.`);
process.exit(0);
