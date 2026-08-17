import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import {
  assertLocalInboxProfileTarget,
  createInboxProfilePlan,
  createTimedRepository,
  summarizeInboxTrace,
  type InboxProfilePlanEntry,
  type InboxTraceEvent,
} from '../src/lib/inboxDiagnostics.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createMessagesRepo } from '../src/repos/messagesRepo.js';
import { createPlacementsRepo } from '../src/repos/placementsRepo.js';
import { aggregateInbox, countUnreadRows, type InboxFilter } from '../src/routes/inbox.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const tablePrefix = process.env.TABLE_PREFIX ?? 'hc-local-';
assertLocalInboxProfileTarget(endpoint, tablePrefix);

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  },
});
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const env = { ...process.env, TABLE_PREFIX: tablePrefix };
const logger = pino({ level: 'silent' });

const trace: InboxTraceEvent[] = [];
// One row per executed case. The page fields and the badge fields are BOTH
// optional because the two kinds measure different calls: a page case has a
// filter/limit and reports cursor + group truncation, the badge case has
// neither and reports the count endpoint's capped/truncated posture instead.
// `rowCount` is the one field both carry (rows on the page / rows counted).
const samples: Array<{
  caseId: string;
  kind: InboxProfilePlanEntry['kind'];
  filter?: InboxFilter;
  limit?: number;
  repeat: number;
  durationMs: number;
  rowCount: number;
  hasNextCursor?: boolean;
  groupsTruncated?: boolean;
  capped?: boolean;
  truncated?: boolean;
}> = [];
try {
  for (const profileCase of createInboxProfilePlan()) {
    const { repeat } = profileCase;
    const originMs = performance.now();
    const context = {
      caseId: profileCase.caseId,
      repeat,
      originMs,
      nowMs: () => performance.now(),
      wallNow: () => new Date().toISOString(),
    };
    const repoDeps = { doc, env, logger };
    const timedCalls = (): number =>
      trace.filter((event) => event.caseId === profileCase.caseId && event.repeat === repeat).length;
    if (profileCase.kind === 'unread-badge-endpoint') {
      // The badge drives its OWN endpoint helper - no filter, no limit, no
      // hydration - through the same timing proxies, so its per-operation trace
      // is directly comparable with a page case's. countUnreadRows resolves
      // exactly three repos (conversations, contacts, messages); a placements
      // proxy would never be called, so it is not built here.
      const count = await countUnreadRows({
        logger,
        conversationsRepo: createTimedRepository(
          'conversations',
          createConversationsRepo(repoDeps),
          trace,
          context,
        ),
        contactsRepo: createTimedRepository(
          'contacts',
          createContactsRepo(repoDeps),
          trace,
          context,
        ),
        messagesRepo: createTimedRepository(
          'messages',
          createMessagesRepo(repoDeps),
          trace,
          context,
        ),
      });
      const durationMs = performance.now() - originMs;
      samples.push({
        caseId: profileCase.caseId,
        kind: profileCase.kind,
        repeat,
        durationMs,
        rowCount: count.unreadCount,
        capped: count.capped,
        truncated: count.truncated,
      });
      console.log(
        `${profileCase.caseId}: ${durationMs.toFixed(1)} ms, ` +
        `${count.unreadCount} unread rows counted, ` +
        `${timedCalls()} timed calls`,
      );
      continue;
    }
    const page = await aggregateInbox(
      { filter: profileCase.filter, limit: profileCase.limit },
      {
        logger,
        conversationsRepo: createTimedRepository(
          'conversations',
          createConversationsRepo(repoDeps),
          trace,
          context,
        ),
        contactsRepo: createTimedRepository(
          'contacts',
          createContactsRepo(repoDeps),
          trace,
          context,
        ),
        messagesRepo: createTimedRepository(
          'messages',
          createMessagesRepo(repoDeps),
          trace,
          context,
        ),
        placementsRepo: createTimedRepository(
          'placements',
          createPlacementsRepo(repoDeps),
          trace,
          context,
        ),
      },
    );
    const durationMs = performance.now() - originMs;
    samples.push({
      caseId: profileCase.caseId,
      kind: profileCase.kind,
      filter: profileCase.filter,
      limit: profileCase.limit,
      repeat,
      durationMs,
      rowCount: page.rows.length,
      hasNextCursor: page.nextCursor !== null,
      groupsTruncated: page.groupsTruncated === true,
    });
    console.log(
      `${profileCase.caseId}: ${durationMs.toFixed(1)} ms, ` +
      `${page.rows.length} rows, ` +
      `${timedCalls()} timed calls`,
    );
  }

  const runId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const artifactDir = path.join(repoRoot, 'e2e', '.artifacts', 'inbox-profile', runId);
  const summary = {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    target: { endpoint, tablePrefix },
    samples,
    operations: summarizeInboxTrace(trace),
    artifacts: { trace: 'trace.jsonl', summary: 'summary.json' },
  };

  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, 'trace.jsonl'),
    `${trace.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`artifact: ${artifactDir}`);
} finally {
  client.destroy();
}
