// One-off scripted verification of the live seed output.
// Run: npx tsx app/scripts/verify-live-seed.ts
// Requires: npm run db:start && SEED_PROFILE=full npx tsx app/scripts/db-seed.ts
import { createDocumentClient } from '../src/lib/dynamo.js';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const prefix = process.env.TABLE_PREFIX ?? 'hc-local-';

const doc = createDocumentClient({ endpoint });

function tn(base: string): string {
  return `${prefix}${base}`;
}

let allOk = true;
const fail = (msg: string): void => {
  console.error('FAIL:', msg);
  allOk = false;
};

// 1. Tomorrow tour — 5 reminders, dueAts in the future
const { Items: tomorrowReminders } = await doc.send(
  new QueryCommand({
    TableName: tn('tourReminders'),
    IndexName: 'byTour',
    KeyConditionExpression: '#tid = :tid',
    ExpressionAttributeNames: { '#tid': 'tourId' },
    ExpressionAttributeValues: { ':tid': 'tour-live-tomorrow' },
  }),
);
console.log(`[1] Tomorrow tour reminders: ${tomorrowReminders?.length} (expect 5)`);
if (tomorrowReminders?.length !== 5) fail('expected 5 tomorrow reminders');
for (const r of tomorrowReminders ?? []) {
  console.log(`    kind=${r['kind']} dueAt=${r['dueAt']}`);
}

// 2. Today tour — at least 1 reminder (confirmation always fires)
const { Items: todayReminders } = await doc.send(
  new QueryCommand({
    TableName: tn('tourReminders'),
    IndexName: 'byTour',
    KeyConditionExpression: '#tid = :tid',
    ExpressionAttributeNames: { '#tid': 'tourId' },
    ExpressionAttributeValues: { ':tid': 'tour-live-today' },
  }),
);
console.log(`[2] Today tour reminders: ${todayReminders?.length} (expect ≥1)`);
if ((todayReminders?.length ?? 0) < 1) fail('expected at least 1 today reminder');

// 3. Overdue RTA placement: next_deadline_at < now
const { Item: rtaPlacement } = await doc.send(
  new GetCommand({ TableName: tn('placements'), Key: { placementId: 'placement-live-overdue-rta' } }),
);
const now = new Date();
if (!rtaPlacement) {
  fail('overdue-rta placement not found');
} else {
  const deadlineAt = rtaPlacement['next_deadline_at'] as string;
  const isOverdue = new Date(deadlineAt) < now;
  console.log(`[3] Overdue RTA deadline: ${deadlineAt} < now=${now.toISOString()} → ${isOverdue ? 'OK' : 'FAIL'}`);
  if (!isOverdue) fail('RTA deadline must be in the past');
}

// 4. Follow-up placement: next_deadline_at <= now
const { Item: followUp } = await doc.send(
  new GetCommand({ TableName: tn('placements'), Key: { placementId: 'placement-live-follow-up' } }),
);
if (!followUp) {
  fail('follow-up placement not found');
} else {
  const deadlineAt = followUp['next_deadline_at'] as string;
  const isDue = new Date(deadlineAt) <= now;
  console.log(`[4] Follow-up deadline: ${deadlineAt} <= now=${now.toISOString()} → ${isDue ? 'OK' : 'FAIL'}`);
  if (!isDue) fail('follow-up deadline must be at/before now');
}

// 5. Derived statuses
const { Item: tenantA } = await doc.send(
  new GetCommand({ TableName: tn('contacts'), Key: { contactId: 'contact-live-tenant-a' } }),
);
console.log(`[5] Tenant A status: ${tenantA?.['status']} (expect 'placing') ${tenantA?.['status'] === 'placing' ? 'OK' : 'FAIL'}`);
if (tenantA?.['status'] !== 'placing') fail('tenant A status must be placing');

const { Item: unitA } = await doc.send(
  new GetCommand({ TableName: tn('units'), Key: { unitId: 'unit-live-a' } }),
);
console.log(`[6] Unit A status: ${unitA?.['status']} (expect 'under_application') ${unitA?.['status'] === 'under_application' ? 'OK' : 'FAIL'}`);
if (unitA?.['status'] !== 'under_application') fail('unit A status must be under_application');

doc.destroy();
console.log('\nResult:', allOk ? 'ALL OK' : 'SOME FAILURES');
process.exit(allOk ? 0 : 1);
