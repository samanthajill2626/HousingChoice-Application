// Shared AWS plumbing for ALL ops scripts (bootstrap, plan, apply, drift,
// deploy:*). Two jobs: pin WHICH account we may touch, and build SDK clients
// bound to the dedicated CLI profile.
//
// Cameron's machine has default-chain credentials for an UNRELATED account
// (ABT Industries). Nothing here may ever fall back to the default chain:
// every client is bound to the named profile, and every mutating script must
// call assertHousingChoiceAccount() before doing anything.

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';

/** The ONLY AWS account HousingChoice tooling is allowed to touch. */
export const HC_ACCOUNT_ID = '938565869261';

/** Named CLI profile holding the HousingChoice IAM user credentials. */
export const HC_PROFILE = process.env.HC_AWS_PROFILE ?? 'housingchoice';

export const HC_REGION = 'us-east-1';

export const STACK_ENVS = ['dev', 'prod'];

/** Per-env Terraform state bucket (separate buckets = per-stack IAM isolation). */
export function stateBucketName(env) {
  if (!STACK_ENVS.includes(env)) throw new Error(`Unknown env: ${env}`);
  return `hc-${env}-tfstate-${HC_ACCOUNT_ID}`;
}

/** Credentials provider bound to the named profile — never the default chain. */
export function hcCredentials() {
  return fromIni({ profile: HC_PROFILE });
}

/**
 * Hard gate: resolve the profile's identity and fail unless it is the pinned
 * HousingChoice account. Call this FIRST in every script that can mutate AWS.
 * Returns the caller identity for logging.
 */
export async function assertHousingChoiceAccount() {
  const sts = new STSClient({ region: HC_REGION, credentials: hcCredentials() });
  let identity;
  try {
    identity = await sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    throw new Error(
      `Could not resolve AWS identity for profile "${HC_PROFILE}". ` +
        `Is the profile configured? (aws configure --profile ${HC_PROFILE})\n  cause: ${err.message}`,
    );
  }
  if (identity.Account !== HC_ACCOUNT_ID) {
    throw new Error(
      `ACCOUNT GUARD: profile "${HC_PROFILE}" resolves to account ${identity.Account}, ` +
        `but HousingChoice is pinned to ${HC_ACCOUNT_ID}. Refusing to continue.`,
    );
  }
  return identity;
}
