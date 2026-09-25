// The ONE stage resolver for the share-skip-fix ops scripts (the census and
// the fix script). Mirrors import-apply.ts / rail-verify.ts: `--env` picks the
// tables AND the credentials, no ambient env vars decide anything.
//
//   local          -> hc-local-*     at DynamoDB Local, access key `local`
//                     (= the human's live `npm run dev -- --local` stack;
//                     an AGENT NEVER TARGETS THIS - AGENTS.md)
//   local --lane L -> hc-local-L-*   at DynamoDB Local, access key `hclaneL`
//                     (a hermetic e2e lane: the ONLY local target an agent
//                     may use; see e2e/support/lane.mjs laneAccessKeyId)
//   dev            -> hc-dev-*       on AWS via the pinned `housingchoice` profile
//   prod           -> hc-prod-*      on AWS via the pinned `housingchoice` profile
//
// WHY THE LANE SETS THE KEY: DynamoDB Local runs WITHOUT -sharedDb, so each
// (accessKeyId, region) pair is its own database (scripts/db.mjs). A lane's
// tables exist only inside database `hclane<L>`; the same prefix under key
// `local` is a different database (and the live one). The two are therefore
// derived from ONE `--lane` argument and never set separately.
//
// THE ACCOUNT GUARD MUST BIND TO THE CLIENT THE SCRIPT WRITES THROUGH. On the
// operator machine the default credential chain belongs to an UNRELATED
// account (scripts/lib/hcAws.mjs), so asserting the account and then building
// a client from the default chain would prove an account the writes never
// touch. Every dev/prod client here is built from `hcCredentials()`, and the
// guard is re-checked here (not only inside assertHousingChoiceAccount) so a
// test can inject a wrong-account identity and prove the refusal. It is also
// built with an EXPLICIT regional endpoint (AWS_DYNAMODB_ENDPOINT), which
// outranks every ambient source: without it, an `endpoint_url` in the shared
// AWS config file (on the profile, or in a `services` entry for dynamodb)
// would redirect the client while the target line says AWS - and the guard,
// which checks only the account, would pass.
//
// NO AMBIENT ENDPOINT VARIABLE: the SDK also honors `AWS_ENDPOINT_URL` and
// `AWS_ENDPOINT_URL_<SERVICE>` from the shell. The pinned endpoint outranks
// them too, so one would be silently ignored - yet a variable someone set says
// they meant another target (DynamoDB Local, say). So a dev/prod run REFUSES
// to start while any AWS_ENDPOINT_URL* variable is set: a clear refusal beats
// a silent override.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import {
  assertHousingChoiceAccount,
  hcCredentials,
  HC_ACCOUNT_ID,
  HC_PROFILE,
  HC_REGION,
} from '../../../scripts/lib/hcAws.mjs';

export const STAGE_TARGETS = ['local', 'dev', 'prod'] as const;
export type StageTarget = (typeof STAGE_TARGETS)[number];

export const LOCAL_ENDPOINT = 'http://localhost:8000';

/** The regional AWS endpoint every dev/prod client is PINNED to (see the header). */
export const AWS_DYNAMODB_ENDPOINT = `https://dynamodb.${HC_REGION}.amazonaws.com`;

export interface StageClientDeps {
  /** Test seam: the identity check. Defaults to the real STS call on the profile. */
  assertAccount?: () => Promise<{ Account?: string; Arn?: string }>;
  /** Test seam: the credentials the dev/prod client is built from. */
  credentials?: () => AwsCredentialIdentityProvider;
}

export interface StageClientOpts {
  /**
   * LOCAL ONLY: the hermetic e2e lane to target (a positive integer). Sets
   * BOTH the table prefix `hc-local-<L>-` and the DynamoDB Local access key
   * `hclane<L>` (e2e/support/lane.mjs laneAccessKeyId - the format is pinned
   * by stageClient.test.ts). Refused for dev/prod: there the stage alone
   * picks the tables, so a typo can never point a prod run at another prefix.
   */
  lane?: number;
}

export interface StageClient {
  doc: DynamoDBDocumentClient;
  /** Env carrying the stage's TABLE_PREFIX (and the lane key) - hand it to every repo/tableName call. */
  env: NodeJS.ProcessEnv;
  /** The endpoint the client is pinned to: DynamoDB Local for local, the regional AWS endpoint for dev/prod. */
  endpoint: string;
  prefix: string;
  /** The DynamoDB Local access key (selects the database); undefined on AWS. */
  accessKeyId: string | undefined;
  /** For the target line the scripts log first. */
  describe: string;
}

export function parseStageTarget(raw: string | undefined): StageTarget | undefined {
  return STAGE_TARGETS.includes(raw as StageTarget) ? (raw as StageTarget) : undefined;
}

/** A lane number: a positive integer. Lane 0 is the live dev stack, which has
 *  no key of its own (it rides the `local` fallback) - not a lane here. */
export function parseLane(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

/** Mirrors e2e/support/lane.mjs laneAccessKeyId - alphanumeric only (DynamoDB
 *  Local rejects `-`/`_` in a key once -sharedDb is off). */
export function laneAccessKeyId(lane: number): string {
  return `hclane${lane}`;
}

/** The AWS_ENDPOINT_URL* variables set in this environment (compared without
 *  case: Windows environment names are case-insensitive to the SDK too). */
export function ambientEndpointVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => k.toUpperCase().startsWith('AWS_ENDPOINT_URL') && env[k] !== undefined);
}

export async function resolveStageClient(
  target: StageTarget,
  deps: StageClientDeps = {},
  opts: StageClientOpts = {},
): Promise<StageClient> {
  // Defense in depth: parseStageArgs already refuses this as a usage error.
  if (opts.lane !== undefined && target !== 'local') {
    throw new Error(`--lane is accepted with --env local only (got --env ${target}); refusing to continue.`);
  }
  const marshallOptions = { removeUndefinedValues: true };
  if (target === 'local') {
    const prefix = opts.lane !== undefined ? `hc-local-${opts.lane}-` : 'hc-local-';
    const accessKeyId = opts.lane !== undefined ? laneAccessKeyId(opts.lane) : 'local';
    const env: NodeJS.ProcessEnv = { ...process.env, TABLE_PREFIX: prefix, AWS_ACCESS_KEY_ID: accessKeyId };
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: HC_REGION,
        endpoint: LOCAL_ENDPOINT,
        credentials: { accessKeyId, secretAccessKey: 'local' },
      }),
      { marshallOptions },
    );
    return {
      doc,
      env,
      endpoint: LOCAL_ENDPOINT,
      prefix,
      accessKeyId,
      describe: `DynamoDB Local ${LOCAL_ENDPOINT} database ${accessKeyId}${opts.lane !== undefined ? ` (e2e lane ${opts.lane})` : ' (the live local dev stack)'}`,
    };
  }
  const endpointVariables = ambientEndpointVariables();
  if (endpointVariables.length > 0) {
    throw new Error(
      `${endpointVariables.join(', ')} ${endpointVariables.length === 1 ? 'is' : 'are'} set in this shell: the ${target} ` +
        `client is pinned to ${AWS_DYNAMODB_ENDPOINT} and would silently ignore ${endpointVariables.length === 1 ? 'it' : 'them'}, ` +
        `so the run refuses rather than guess which target was meant. Unset ` +
        `${endpointVariables.map((v) => `Env:${v}`).join(', ')} (PowerShell: Remove-Item) and re-run. Refusing to continue.`,
    );
  }
  const prefix = `hc-${target}-`;
  const env: NodeJS.ProcessEnv = { ...process.env, TABLE_PREFIX: prefix };
  const identity = await (deps.assertAccount ?? assertHousingChoiceAccount)();
  if (identity.Account !== HC_ACCOUNT_ID) {
    throw new Error(
      `ACCOUNT GUARD: profile "${HC_PROFILE}" resolves to account ${identity.Account}, ` +
        `but HousingChoice is pinned to ${HC_ACCOUNT_ID}. Refusing to continue.`,
    );
  }
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: HC_REGION,
      endpoint: AWS_DYNAMODB_ENDPOINT,
      credentials: (deps.credentials ?? hcCredentials)(),
    }),
    { marshallOptions },
  );
  return {
    doc,
    env,
    endpoint: AWS_DYNAMODB_ENDPOINT,
    prefix,
    accessKeyId: undefined,
    describe: `AWS ${HC_REGION} account ${identity.Account} (profile ${HC_PROFILE}) at ${AWS_DYNAMODB_ENDPOINT}`,
  };
}

/** Shared CLI parsing for the two scripts: `--env` (required), `--lane`
 *  (local only), plus the caller's own value/flag names. Unknown arguments are
 *  REFUSED, never ignored - a mistyped flag must never turn a rehearsal into a
 *  live apply, nor the reverse. So is an argument given TWICE (the last value
 *  would silently win: `--env dev ... --env prod` would target prod, and dev
 *  and prod share one account, so the guard cannot catch it), and `--lane`
 *  with any `--env` but local. */
export function parseStageArgs(
  argv: string[],
  known: { values: string[]; flags: string[] },
): { target: StageTarget; lane: number | undefined; values: Map<string, string>; flags: Set<string> } | { usage: true } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueNames = new Set(['--env', '--lane', ...known.values]);
  const flagNames = new Set(known.flags);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (values.has(a) || flags.has(a)) return { usage: true };
    if (valueNames.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { usage: true };
      values.set(a, v);
      i += 1;
    } else if (flagNames.has(a)) flags.add(a);
    else return { usage: true };
  }
  const target = parseStageTarget(values.get('--env'));
  if (target === undefined) return { usage: true };
  const rawLane = values.get('--lane');
  if (rawLane !== undefined && target !== 'local') return { usage: true };
  const lane = parseLane(rawLane);
  if (rawLane !== undefined && lane === undefined) return { usage: true };
  return { target, lane, values, flags };
}
