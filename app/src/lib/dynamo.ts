// DynamoDB client factory (DocumentClient).
//
// Local vs AWS is decided by DYNAMODB_ENDPOINT: when set (dev loop:
// http://localhost:8000 -> DynamoDB Local), the client targets it and falls
// back to dummy credentials — DynamoDB Local accepts any credentials, and
// requiring real ones would break the no-.env dev boot. When unset (AWS),
// the SDK's default chain resolves the regional endpoint and the instance
// role credentials.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig, type AppConfig } from './config.js';

export interface CreateDynamoOptions {
  /** Overrides config.dynamodbEndpoint (used by tests with throwaway prefixes). */
  endpoint?: string;
  region?: string;
  config?: AppConfig;
}

/** Low-level client. Prefer createDocumentClient() for item access. */
export function createDynamoClient(opts: CreateDynamoOptions = {}): DynamoDBClient {
  const config = opts.config ?? loadConfig();
  const endpoint = opts.endpoint ?? config.dynamodbEndpoint;
  return new DynamoDBClient({
    region: opts.region ?? config.awsRegion,
    ...(endpoint
      ? {
          endpoint,
          // DynamoDB Local needs *some* credentials but ignores their values.
          // Real env credentials still win when present (e.g. AWS CLI envs).
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
          },
        }
      : {}),
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
