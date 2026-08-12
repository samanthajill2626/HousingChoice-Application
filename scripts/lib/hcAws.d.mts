// Hand-written declarations for hcAws.mjs (the devMode/secretsCore convention:
// plain-node .mjs ops helpers get a .d.mts so app-side TypeScript can import
// them under the typecheck gate).
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

/** The ONLY AWS account HousingChoice tooling is allowed to touch. */
export const HC_ACCOUNT_ID: string;
/** Named CLI profile holding the HousingChoice IAM user credentials. */
export const HC_PROFILE: string;
export const HC_REGION: string;
export const STACK_ENVS: string[];
export function stateBucketName(env: string): string;
/** Credentials provider bound to the named profile — never the default chain. */
export function hcCredentials(): AwsCredentialIdentityProvider;
/**
 * Hard gate: resolve the profile's identity and fail unless it is the pinned
 * HousingChoice account. Call FIRST in every script that can mutate AWS.
 */
export function assertHousingChoiceAccount(): Promise<{ Account?: string; Arn?: string }>;
