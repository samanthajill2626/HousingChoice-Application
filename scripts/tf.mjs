// Terraform driver for the two stacks. Powers:
//   npm run plan  [-- dev|prod]   plan -> saves infra/envs/<env>/tfplan
//   npm run apply [-- dev|prod]   applies ONLY a previously saved tfplan
//   npm run drift [-- dev|prod]   plan -detailed-exitcode drift report
// Default env is dev. Pass --reconfigure to force `terraform init -reconfigure`.
//
// Safety model (in order):
//   1. assertHousingChoiceAccount() — refuses unless the `housingchoice`
//      profile resolves to the pinned account (the default chain is an
//      UNRELATED account and is never consulted).
//   2. AWS_PROFILE=housingchoice is forced into the child env — belt and
//      braces with the profile already pinned inside backend + provider HCL.
//   3. apply NEVER plans for itself: it requires the tfplan file from a prior
//      `npm run plan`, and deletes it afterwards so a stale plan can't be
//      applied twice or after the world has moved.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertHousingChoiceAccount,
  HC_PROFILE,
  STACK_ENVS,
} from './lib/hcAws.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: node scripts/tf.mjs <plan|apply|drift> [dev|prod] [--reconfigure]
  (via npm: npm run plan -- prod, npm run apply -- dev, npm run drift)`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// --- argv ------------------------------------------------------------------
const args = process.argv.slice(2);
const mode = args.shift();
if (!['plan', 'apply', 'drift'].includes(mode ?? '')) fail(USAGE);

let env = 'dev';
let reconfigure = false;
for (const arg of args) {
  if (arg === '--reconfigure' || arg === '-reconfigure') reconfigure = true;
  else if (STACK_ENVS.includes(arg)) env = arg;
  else fail(`Unknown argument "${arg}".\n${USAGE}`);
}

const envDir = path.join(repoRoot, 'infra', 'envs', env);
const chdirArg = `-chdir=${envDir}`;
const planFile = path.join(envDir, 'tfplan');

// --- terraform runner --------------------------------------------------------
function terraform(tfArgs) {
  const result = spawnSync('terraform', [chdirArg, ...tfArgs], {
    cwd: repoRoot,
    stdio: 'inherit', // stream plan/apply output live
    shell: false,
    env: { ...process.env, AWS_PROFILE: HC_PROFILE }, // belt + braces
  });
  if (result.error) fail(`Failed to run terraform: ${result.error.message}`);
  return result.status ?? 1;
}

function terraformOrDie(tfArgs) {
  const status = terraform(tfArgs);
  if (status !== 0) process.exit(status);
}

function initIfNeeded() {
  if (reconfigure || !existsSync(path.join(envDir, '.terraform'))) {
    console.error(`[tf] terraform init (${env})...`);
    terraformOrDie(['init', '-input=false', ...(reconfigure ? ['-reconfigure'] : [])]);
  }
}

// --- go ----------------------------------------------------------------------
// 1. Account guard FIRST — nothing touches AWS unless the profile resolves to
//    the pinned HousingChoice account.
const identity = await assertHousingChoiceAccount();
console.error(`[tf] account guard OK: ${identity.Arn} (${identity.Account})`);
console.error(`[tf] ${mode} for stack hc-${env} (${envDir})`);

if (mode === 'plan') {
  initIfNeeded();
  terraformOrDie(['plan', '-input=false', `-out=${planFile}`]);
  console.error(
    `\n[tf] plan saved to infra/envs/${env}/tfplan — review above, then ` +
      `\`npm run apply -- ${env}\` applies EXACTLY this plan.`,
  );
} else if (mode === 'apply') {
  if (!existsSync(planFile)) {
    fail(
      `[tf] No saved plan for "${env}" (infra/envs/${env}/tfplan not found).\n` +
        `Run \`npm run plan -- ${env}\` first and review it — apply only ever ` +
        `executes a previously reviewed plan.`,
    );
  }
  initIfNeeded();
  const status = terraform(['apply', '-input=false', planFile]);
  // Consume the plan either way: after a successful apply it is satisfied;
  // after a failed one it is stale. Either way, re-plan before re-applying.
  rmSync(planFile, { force: true });
  console.error(
    status === 0
      ? `[tf] apply complete; saved plan consumed (deleted).`
      : `[tf] apply FAILED; saved plan deleted — run \`npm run plan -- ${env}\` again.`,
  );
  process.exit(status);
} else {
  // drift: plan without -out; -detailed-exitcode => 0 clean, 2 drift, 1 error.
  initIfNeeded();
  const status = terraform(['plan', '-detailed-exitcode', '-input=false']);
  if (status === 0) {
    console.error(`[tf] no drift: hc-${env} matches state and configuration.`);
  } else if (status === 2) {
    console.error(
      `[tf] DRIFT DETECTED for hc-${env} — see diff above. ` +
        `Reconcile via \`npm run plan -- ${env}\` + \`npm run apply -- ${env}\` ` +
        `(or fix whatever was changed in the console; console is read-only by policy).`,
    );
    process.exit(2);
  } else {
    fail(`[tf] drift check errored (terraform exit ${status}).`);
  }
}
