import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config.js';
import { createDocumentClient } from './dynamo.js';
import {
  createTableNamespace,
  resetLocalData,
  type TableNamespace,
} from './devReset.js';
import type { Logger } from './logger.js';
import {
  generatePerformanceSeed,
  resolvePerformanceSeedConfig,
  type PerformanceSeedInput,
  type PerformanceSeedManifest,
  type PerformanceSeedTables,
} from './seed/performance.js';
import { createContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo } from '../repos/unitsRepo.js';
import { createPlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo } from '../repos/toursRepo.js';
import { createConversationsRepo } from '../repos/conversationsRepo.js';
import { createMessagesRepo } from '../repos/messagesRepo.js';
import { createBroadcastsRepo } from '../repos/broadcastsRepo.js';
import { createUnmatchedEmailRepo } from '../repos/unmatchedEmailRepo.js';
import { createUsersRepo } from '../repos/usersRepo.js';
import { createSettingsRepo } from '../repos/settingsRepo.js';
import { createAiRunsRepo } from '../repos/aiRunsRepo.js';
import { createPoolNumbersRepo } from '../repos/poolNumbersRepo.js';
import { createPlacementNudgesRepo } from '../repos/placementNudgesRepo.js';
import { createPlacementDeadlinesRepo } from '../repos/placementDeadlinesRepo.js';
import { createTourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { createActivityEventsRepo } from '../repos/activityEventsRepo.js';
import { createListingSendsRepo } from '../repos/listingSendsRepo.js';
import { createPendingRosterActionsRepo } from '../repos/pendingRosterActionsRepo.js';
import { createSuggestionResolutionRepo } from '../repos/suggestionResolutionRepo.js';
import { createAuditRepo } from '../repos/auditRepo.js';
import { createContactVocabularyRepo } from '../repos/contactVocabularyRepo.js';
import { createExtractionRepo } from '../repos/extractionRepo.js';

const TABLE_BASES: Readonly<Record<keyof PerformanceSeedTables, string>> = Object.freeze({
  contacts: 'contacts',
  units: 'units',
  placements: 'placements',
  tours: 'tours',
  conversations: 'conversations',
  messages: 'messages',
  broadcasts: 'broadcasts',
  unmatched_email: 'unmatched_email',
});

type Sleep = (milliseconds: number) => Promise<void>;
type DocumentWriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function assertPerformanceBoundary(config: AppConfig): void {
  if (
    !config.dynamodbEndpoint ||
    !isLocalEndpoint(config.dynamodbEndpoint) ||
    !/^hc-local-[1-9]\d*-$/.test(config.tablePrefix)
  ) {
    throw new Error('performance_seed_reset_refused');
  }
}

export { createTableNamespace };
export type { TableNamespace };

export function createPerformanceSeedReaders(deps: {
  doc: DynamoDBDocumentClient;
  config: AppConfig;
}) {
  if (!deps?.config || !deps.config.tablePrefix) throw new Error('performance_seed_reader_config_required');
  const env = Object.freeze({ TABLE_PREFIX: deps.config.tablePrefix }) as NodeJS.ProcessEnv;
  const repoDeps = { doc: deps.doc, env };
  return Object.freeze({
    contacts: createContactsRepo(repoDeps),
    units: createUnitsRepo(repoDeps),
    placements: createPlacementsRepo(repoDeps),
    tours: createToursRepo(repoDeps),
    conversations: createConversationsRepo(repoDeps),
    messages: createMessagesRepo(repoDeps),
    broadcasts: createBroadcastsRepo(repoDeps),
    unmatchedEmail: createUnmatchedEmailRepo(repoDeps),
    users: createUsersRepo(repoDeps),
    settings: createSettingsRepo(repoDeps),
    aiRuns: createAiRunsRepo(repoDeps),
    poolNumbers: createPoolNumbersRepo(repoDeps),
    placementNudges: createPlacementNudgesRepo(repoDeps),
    placementDeadlines: createPlacementDeadlinesRepo(repoDeps),
    tourReminders: createTourRemindersRepo(repoDeps),
    activityEvents: createActivityEventsRepo(repoDeps),
    listingSends: createListingSendsRepo(repoDeps),
    pendingRosterActions: createPendingRosterActionsRepo(repoDeps),
    suggestionResolution: createSuggestionResolutionRepo(repoDeps),
    audit: createAuditRepo(repoDeps),
    contactVocabulary: createContactVocabularyRepo(repoDeps),
    extraction: createExtractionRepo(repoDeps),
  });
}

export async function writePerformanceSeed(deps: {
  config: AppConfig;
  namespace: TableNamespace;
  tables: PerformanceSeedTables;
  maxAttempts?: number;
  doc?: DynamoDBDocumentClient;
  sleep?: Sleep;
}): Promise<number> {
  if (deps.namespace.tablePrefix !== deps.config.tablePrefix) {
    throw new Error('performance_seed_namespace_mismatch');
  }
  const maxAttempts = deps.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('performance_seed_invalid_max_attempts');
  }
  const doc = deps.doc ?? createDocumentClient({ config: deps.config });
  const ownsDoc = deps.doc === undefined;
  const sleep = deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const batches: Array<Record<string, DocumentWriteRequest[]>> = [];
  let current: Record<string, DocumentWriteRequest[]> = {};
  let currentSize = 0;
  let written = 0;
  for (const [key, items] of Object.entries(deps.tables) as Array<[keyof PerformanceSeedTables, Array<Record<string, unknown>>]>) {
    const table = deps.namespace.tableNameFor(TABLE_BASES[key]);
    for (const item of items) {
      if (currentSize === 25) {
        batches.push(current);
        current = {};
        currentSize = 0;
      }
      (current[table] ??= []).push({ PutRequest: { Item: item } });
      currentSize += 1;
      written += 1;
    }
  }
  if (currentSize > 0) batches.push(current);

  try {
    for (const batch of batches) {
      let pending = batch;
      for (let attempt = 1; ; attempt += 1) {
        const response = await doc.send(new BatchWriteCommand({ RequestItems: pending }));
        pending = (response.UnprocessedItems ?? {}) as Record<string, DocumentWriteRequest[]>;
        const remaining = Object.values(pending).reduce((sum, requests) => sum + requests.length, 0);
        if (remaining === 0) break;
        if (attempt >= maxAttempts) {
          throw new Error(`performance_seed_batch_exhausted attempts=${attempt} remaining=${remaining}`);
        }
        await sleep(Math.min(25 * 2 ** (attempt - 1), 400));
      }
    }
    return written;
  } finally {
    if (ownsDoc) doc.destroy();
  }
}

export async function resetPerformanceData(deps: {
  config: AppConfig;
  logger?: Logger;
  input: PerformanceSeedInput;
  anchor: string;
  reset?: typeof resetLocalData;
  doc?: DynamoDBDocumentClient;
}): Promise<PerformanceSeedManifest> {
  const resolved = resolvePerformanceSeedConfig(deps.input, deps.anchor);
  assertPerformanceBoundary(deps.config);
  const namespace = createTableNamespace(deps.config);
  const reset = deps.reset ?? resetLocalData;
  await reset({ config: deps.config, logger: deps.logger, profile: 'lean', namespace });
  const generated = generatePerformanceSeed(resolved);
  await writePerformanceSeed({
    config: deps.config,
    namespace,
    tables: generated.tables,
    ...(deps.doc !== undefined && { doc: deps.doc }),
  });
  return generated.manifest;
}
