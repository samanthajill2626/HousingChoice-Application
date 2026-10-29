// rankingRunsRepo.listRuns against a stub DocumentClient (WP1 B2a PR34): the
// summary projection on every BatchGet, the unprocessed retries, and an
// unread run reported - an `unavailable` entry plus `incomplete: true` on the
// page - never silently dropped from the runs list or the cost totals.
import {
  BatchGetCommand,
  QueryCommand,
  type BatchGetCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  RANKING_RUN_SUMMARY_FIELDS,
  createRankingRunsRepo,
  rankingRunEntityKey,
  rankingRunSortKey,
} from '../src/repos/rankingRunsRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const TABLE = 'hc-test-x-ai_runs';
const ENTITY = rankingRunEntityKey();
const STARTED = '2026-10-28T11:00:00.000Z';

type Key = { itemId: string };

/** One Query page of pointers for `runIds`, then BatchGets answered by `withhold` (keys left unprocessed). */
function stubDoc(runIds: string[], withhold: (keys: Key[], call: number) => number) {
  const batchRequests: BatchGetCommandInput[] = [];
  const doc = {
    async send(command: unknown) {
      if (command instanceof QueryCommand) {
        return {
          Items: runIds.map((runId) => ({
            itemId: `ptr#${ENTITY}#${rankingRunSortKey(STARTED, runId)}`,
            entityKey: ENTITY,
            sortKey: rankingRunSortKey(STARTED, runId),
            runId,
          })),
        };
      }
      if (command instanceof BatchGetCommand) {
        batchRequests.push(command.input);
        const keys = (command.input.RequestItems?.[TABLE]?.Keys ?? []) as Key[];
        const n = withhold(keys, batchRequests.length);
        const served = keys.slice(0, keys.length - n);
        const left = keys.slice(keys.length - n);
        return {
          Responses: {
            [TABLE]: served.map((k) => ({ runId: k.itemId.slice('rrun#'.length), kind: 'ranking', costUsd: 0.01 })),
          },
          ...(left.length > 0 && { UnprocessedKeys: { [TABLE]: { Keys: left } } }),
        };
      }
      throw new Error('stub: unexpected command');
    },
  };
  return { doc: doc as unknown as DynamoDBDocumentClient, batchRequests };
}

function makeRepo(doc: DynamoDBDocumentClient) {
  const capture = createLogCapture();
  const logger = createLogger({ destination: capture.stream });
  return { repo: createRankingRunsRepo({ doc, env: { TABLE_PREFIX: 'hc-test-x-' }, logger }), capture };
}

describe('rankingRunsRepo.listRuns (stub client; PR34)', () => {
  it('every BatchGet projects exactly the summary fields, through aliases', async () => {
    const { doc, batchRequests } = stubDoc(['r1', 'r2'], () => 0);
    const { repo } = makeRepo(doc);

    await repo.listRuns({ entityKey: ENTITY });

    for (const request of batchRequests) {
      const entry = request.RequestItems![TABLE]!;
      const tokens = String(entry.ProjectionExpression)
        .split(',')
        .map((token) => token.trim());
      expect(tokens.every((token) => token.startsWith('#'))).toBe(true);
      expect(tokens.map((token) => entry.ExpressionAttributeNames?.[token]).sort()).toEqual(
        [...RANKING_RUN_SUMMARY_FIELDS].sort(),
      );
    }
    for (const heavy of ['rawText', 'inputGzip', 'handles', 'results']) {
      expect(RANKING_RUN_SUMMARY_FIELDS as readonly string[]).not.toContain(heavy);
    }
  });

  it('unprocessed keys are retried; a healed read is complete', async () => {
    const { doc, batchRequests } = stubDoc(['r1', 'r2', 'r3'], (_keys, call) => (call === 1 ? 2 : 0));
    const { repo } = makeRepo(doc);

    const page = await repo.listRuns({ entityKey: ENTITY });

    expect(batchRequests).toHaveLength(2);
    expect(page.entries.every((e) => !e.expired)).toBe(true);
    expect(page.incomplete).toBeUndefined();
  });

  it('a run still unread after 4 attempts is an unavailable entry and the page says incomplete', async () => {
    const { doc, batchRequests } = stubDoc(['r1', 'r2', 'r3'], (keys) => (keys.length > 0 ? 1 : 0));
    const { repo, capture } = makeRepo(doc);

    const page = await repo.listRuns({ entityKey: ENTITY });

    expect(batchRequests).toHaveLength(4);
    expect(page.incomplete).toBe(true);
    const unread = page.entries.filter((e) => e.expired);
    expect(unread).toEqual([
      { runId: 'r3', sortKey: rankingRunSortKey(STARTED, 'r3'), expired: true, unavailable: true },
    ]);
    expect(page.entries.filter((e) => !e.expired)).toHaveLength(2);
    expect(capture.atLevel(40)).toHaveLength(1);
  });
});
