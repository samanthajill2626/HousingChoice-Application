import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { queryAll } from '../src/lib/dynamoPaging.js';

/** A doc client that replays the given pages in order, recording each
 *  ExclusiveStartKey it was handed. */
function fakeDoc(pages: { Items: unknown[]; LastEvaluatedKey?: Record<string, unknown> }[]): {
  doc: DynamoDBDocumentClient;
  starts: (Record<string, unknown> | undefined)[];
} {
  const starts: (Record<string, unknown> | undefined)[] = [];
  let call = 0;
  const send = vi.fn((cmd: QueryCommand) => {
    starts.push((cmd.input as QueryCommandInput).ExclusiveStartKey);
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Promise.resolve(page);
  });
  return { doc: { send } as unknown as DynamoDBDocumentClient, starts };
}

const INPUT: QueryCommandInput = { TableName: 't', KeyConditionExpression: '#h = :h' };

describe('queryAll', () => {
  it('returns a single page without an ExclusiveStartKey', async () => {
    const { doc, starts } = fakeDoc([{ Items: [{ id: 'a' }] }]);
    const items = await queryAll<{ id: string }>(doc, INPUT);
    expect(items.map((i) => i.id)).toEqual(['a']);
    expect(starts).toEqual([undefined]);
  });

  it('follows LastEvaluatedKey until the query is exhausted', async () => {
    const { doc, starts } = fakeDoc([
      { Items: [{ id: 'a' }], LastEvaluatedKey: { k: 1 } },
      { Items: [{ id: 'b' }], LastEvaluatedKey: { k: 2 } },
      { Items: [{ id: 'c' }] },
    ]);
    const items = await queryAll<{ id: string }>(doc, INPUT);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(starts).toEqual([undefined, { k: 1 }, { k: 2 }]);
  });

  it('keeps going past an EMPTY page that still carries a key', async () => {
    // DynamoDB applies Limit before any FilterExpression, so a fully-filtered
    // page comes back empty with more rows still to come.
    const { doc } = fakeDoc([{ Items: [], LastEvaluatedKey: { k: 1 } }, { Items: [{ id: 'z' }] }]);
    const items = await queryAll<{ id: string }>(doc, INPUT);
    expect(items.map((i) => i.id)).toEqual(['z']);
  });

  it('treats a missing Items array as an empty page', async () => {
    const { doc } = fakeDoc([{ Items: undefined as unknown as unknown[] }]);
    await expect(queryAll(doc, INPUT)).resolves.toEqual([]);
  });

  it('stops at the page cap rather than looping on a never-ending cursor', async () => {
    const { doc, starts } = fakeDoc([{ Items: [{ id: 'a' }], LastEvaluatedKey: { k: 1 } }]);
    const items = await queryAll<{ id: string }>(doc, INPUT, { maxPages: 4 });
    expect(items).toHaveLength(4);
    expect(starts).toHaveLength(4);
  });
});
