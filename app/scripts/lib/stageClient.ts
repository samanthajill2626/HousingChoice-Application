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
// test can inject a wrong-account identity and prove the refusal.
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
  /** Set for local only; undefined means real AWS. */
  endpoint: string | undefined;
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

export async function resolveStageClient(
  target: StageTarget,
  deps: StageClientDeps = {},
  opts: StageClientOpts = {},
): Promise<StageClient> {
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
    new DynamoDBClient({ region: HC_REGION, credentials: (deps.credentials ?? hcCredentials)() }),
    { marshallOptions },
  );
  return {
    doc,
    env,
    endpoint: undefined,
    prefix,
    accessKeyId: undefined,
    describe: `AWS ${HC_REGION} account ${identity.Account} (profile ${HC_PROFILE})`,
  };
}

/** Shared CLI parsing for the two scripts: `--env` (required), `--lane`
 *  (local only), plus the caller's own value/flag names. Unknown arguments are
 *  REFUSED, never ignored - a mistyped flag must never turn a rehearsal into a
 *  live apply, nor the reverse. */
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
  const lane = parseLane(rawLane);
  if (rawLane !== undefined && lane === undefined) return { usage: true };
  return { target, lane, values, flags };
}
