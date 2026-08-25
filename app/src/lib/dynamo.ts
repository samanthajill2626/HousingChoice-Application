// DynamoDB client factory (DocumentClient).
//
// Local vs AWS is decided by DYNAMODB_ENDPOINT: when set (dev loop:
// http://localhost:8000 -> DynamoDB Local), the client targets it and falls
// back to dummy credentials — DynamoDB Local accepts any credentials, and
// requiring real ones would break the no-.env dev boot. When unset (AWS),
// the SDK's default chain resolves the regional endpoint and the instance
// role credentials.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig, type AppConfig } from './config.js';

export interface CreateDynamoOptions {
  /** Overrides config.dynamodbEndpoint (used by tests with throwaway prefixes). */
  endpoint?: string;
  region?: string;
  config?: AppConfig;
}

/** Keys already recorded by this process - one filesystem write per key, not per client. */
const recordedLocalKeys = new Set<string>();

/**
 * Test seam. Note which DynamoDB Local database this process actually reaches,
 * so the vitest teardown can sweep the throwaway tables a crashed or
 * interrupted suite left in it.
 *
 * Since `app/test/setup/dynamoAccessKey.ts` gives each test FILE its own access
 * key - and therefore its own database - the teardown can no longer find those
 * tables by looking under one key. It cannot walk every per-file key either:
 * a ListTables under an unused key MATERIALISES that database at ~0.6-1.1 MiB
 * (heap under the old -inMemory shape; a disk file since 2026-08-24) that
 * nothing reclaims automatically. Recording the keys that
 * were really used is what makes the sweep both complete and free.
 * See app/test/helpers/dynamoKeyLedger.ts for the measurements.
 *
 * STRUCTURALLY ABSENT OUTSIDE VITEST: `HC_TEST_DYNAMO_KEY_LEDGER` is set only
 * by app/vitest.config.ts, and this is skipped entirely when no endpoint
 * override is in play - i.e. on every deployed path, which talks to real AWS.
 */
function recordLocalKeyUse(accessKeyId: string): void {
  const dir = process.env['HC_TEST_DYNAMO_KEY_LEDGER'];
  if (dir === undefined || dir === '') return;
  // The key becomes a filename. DynamoDB Local rejects a non-alphanumeric key
  // anyway once -sharedDb is off, so this excludes nothing legitimate.
  if (!/^[A-Za-z0-9]+$/.test(accessKeyId)) return;
  if (recordedLocalKeys.has(accessKeyId)) return;
  recordedLocalKeys.add(accessKeyId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, accessKeyId), '');
  } catch {
    // Best effort. A missing marker costs a leaked table, never a failed test.
  }
}

/** Low-level client. Prefer createDocumentClient() for item access. */
export function createDynamoClient(opts: CreateDynamoOptions = {}): DynamoDBClient {
  const config = opts.config ?? loadConfig();
  const endpoint = opts.endpoint ?? config.dynamodbEndpoint;
  if (!endpoint) {
    return new DynamoDBClient({ region: opts.region ?? config.awsRegion });
  }
  // DynamoDB Local needs *some* credentials but ignores their values.
  // Real env credentials still win when present (e.g. AWS CLI envs).
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'local';
  recordLocalKeyUse(accessKeyId);
  return new DynamoDBClient({
    region: opts.region ?? config.awsRegion,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
    },
  });
}

/** DocumentClient (plain-JS values in/out; document-style items per §5). */
export function createDocumentClient(opts: CreateDynamoOptions = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(createDynamoClient(opts), {
    marshallOptions: {
      // Document-style items: drop undefineds instead of erroring — this is
      // also what keeps the sparse GSIs sparse (absent attribute = not indexed).
      removeUndefinedValues: true,
    },
  });
}

let singleton: DynamoDBDocumentClient | undefined;

/**
 * Process-wide DocumentClient. Lazy so importing this module never touches
 * config/env at load time; injectable in tests via createDocumentClient().
 */
export function getDocumentClient(): DynamoDBDocumentClient {
  singleton ??= createDocumentClient();
  return singleton;
}

/** Test seam: drop the singleton so the next getDocumentClient() rebuilds it. */
export function resetDocumentClient(): void {
  singleton?.destroy();
  singleton = undefined;
}
