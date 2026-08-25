/**
 * Measures how often the `byUnread` walk can resolve a contact WITHOUT a
 * per-item GSI Query - the one number cluster C1's badge fix depends on.
 *
 * WHY THIS IS A SEPARATE SCRIPT, not a flag on `profile-inbox.ts`: that harness
 * is deliberately hard-gated to `localhost:8000` + `hc-local-` tables, and the
 * whole point of THIS measurement is that a seeded lane answers with the
 * fixture coverage we are trying to distrust. Loosening that gate to reuse the
 * harness would remove a guard that exists for good reasons. This script is
 * read-only, human-run, and gated differently: it names its target out loud and
 * refuses to run without `--confirm`.
 *
 * IT IS READ-ONLY. It issues Queries against the byUnread index and BatchGets
 * against the contacts table. It writes nothing, anywhere.
 *
 * IT PRINTS NO PII. Phones, emails, contact ids and conversation ids never
 * reach the output - only counts, percentages, and a verdict. That is
 * deliberate: the output is meant to be pasteable into a design discussion.
 *
 * Usage:
 *   DYNAMODB_ENDPOINT=... TABLE_PREFIX=... \
 *     npx tsx app/scripts/measure-unread-contact-coverage.ts --confirm [--budget 5000]
 *
 * Omit DYNAMODB_ENDPOINT to use the AWS default resolution for the profile the
 * shell is already authenticated as. Check `aws sts get-caller-identity` first;
 * the default credential chain has pointed at the wrong account here before.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import pino from 'pino';

import { iterateUnreadConversations } from '../src/lib/unreadFeed.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationItem,
} from '../src/repos/conversationsRepo.js';

const argv = process.argv.slice(2);
if (!argv.includes('--confirm')) {
  console.error(
    [
      'Refusing to run without --confirm.',
      '',
      'This script reads REAL data if you point it at a real environment.',
      'It writes nothing and prints no PII, but you should know which',
      'environment you are measuring before the numbers mean anything.',
      '',
      `  endpoint:     ${(process.env.DYNAMODB_ENDPOINT ?? '').trim() === '' ? '(AWS default resolution)' : process.env.DYNAMODB_ENDPOINT}`,
      `  table prefix: ${process.env.TABLE_PREFIX ?? '(unset)'}`,
      '',
      'Re-run with --confirm once that is the target you meant.',
    ].join('\n'),
  );
  process.exit(2);
}

const budgetArgIndex = argv.indexOf('--budget');
const budget =
  budgetArgIndex === -1 ? 5000 : Number.parseInt(argv[budgetArgIndex + 1] ?? '', 10);
if (!Number.isInteger(budget) || budget < 1) {
  console.error('--budget must be a positive integer');
  process.exit(2);
}

// An EMPTY string is treated as unset, not as an endpoint. This matters: the
// most likely way to run this wrong is from a shell that still has
// DYNAMODB_ENDPOINT set from local work, and the natural way to clear it in
// PowerShell (`$env:DYNAMODB_ENDPOINT = ''`) leaves an empty string behind. An
// empty endpoint would otherwise be handed to the SDK as a real one.
const rawEndpoint = process.env.DYNAMODB_ENDPOINT;
const endpoint = rawEndpoint === undefined || rawEndpoint.trim() === '' ? undefined : rawEndpoint;
const tablePrefix = process.env.TABLE_PREFIX;
if (tablePrefix === undefined || tablePrefix === '') {
  console.error('TABLE_PREFIX must be set explicitly - refusing to guess.');
  process.exit(2);
}

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  ...(endpoint === undefined ? {} : { endpoint }),
});
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const logger = pino({ level: 'silent' });
const env = { ...process.env, TABLE_PREFIX: tablePrefix };

const conversations = createConversationsRepo({ doc, env, logger });
const contacts = createContactsRepo({ doc, env, logger });

/** Every bucket is mutually exclusive; they sum to `scanned`. */
const tally = {
  scanned: 0,
  group: 0,
  oneToOnePhone: 0,
  oneToOneEmail: 0,
  noParticipantsArray: 0,
  noEntryForKey: 0,
  ambiguousEntries: 0,
  emptyContactId: 0,
  hasContactId: 0,
};

const candidateIds: string[] = [];

/**
 * The selection rule the C1 spec's 4.1.b condition 1 prescribes, implemented
 * here so the measurement answers the question the FIX will ask - not an
 * easier one. Selecting by `participants[0]` would report better coverage than
 * the fix can actually achieve on any row where the entry is not first.
 */
function selectEntry(conv: ConversationItem): { kind: string; contactId?: string } {
  const entries = conv.participants;
  if (!Array.isArray(entries) || entries.length === 0) return { kind: 'noParticipantsArray' };

  // A row can carry BOTH keys: attachEmailToConversation stamps
  // `participant_email` onto an existing PHONE thread by design. So this is a
  // phone-then-email CHAIN, not a per-kind branch - which is how the two live
  // readers already do it. Branching on kind would classify a dual-key row's
  // resolvable contact as a miss and under-report coverage.
  const phone = conv.participant_phone;
  if (typeof phone === 'string' && phone !== '') {
    const hit = entries.find((p) => p.phone === phone);
    if (hit !== undefined) return { kind: 'entry', contactId: hit.contactId };
    // Fall through to the email rule rather than giving up: on a dual-key row
    // the entry may be keyed the other way.
  }

  const email = conv.participant_email;
  const hasEmail = typeof email === 'string' && email !== '';
  if (hasEmail || phone === undefined || phone === '') {
    // Email side: the shape is `{contactId, phone: ''}` and there should be
    // exactly one entry. More than one means we cannot pick, and the spec says
    // fall back rather than guess - counted as a miss, not as coverage.
    if (entries.length > 1) return { kind: 'ambiguousEntries' };
    return { kind: 'entry', contactId: entries[0]?.contactId };
  }

  return { kind: 'noEntryForKey' };
}

/**
 * `--audit-index` mode. A coverage figure taken over a handful of rows means
 * nothing, and the first real run returned 0 rows in dev and 2 in prod - so the
 * question stopped being "what fraction resolve" and became "is the sparse
 * index actually near-empty, or is it UNDER-REPORTING".
 *
 * Those are different problems with the same appearance. A thread carrying
 * `unread_count > 0` with no `unread_flag` is invisible to the walk, is the
 * counter-only class the mark-read fan-out fix was warned about, and would make
 * every coverage number taken here a measurement of the wrong population.
 *
 * This is a full table Scan, so it is opt-in and not part of the default run.
 * Counts only - no PII, same as everything else here.
 */
async function auditIndex(): Promise<void> {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const table = `${tablePrefix}conversations`;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  const n = {
    total: 0,
    flagPresent: 0,
    counterPositive: 0,
    consistentUnread: 0,
    counterOnly: 0,
    flagOnly: 0,
  };
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'unread_flag, unread_count',
        ...(ExclusiveStartKey === undefined ? {} : { ExclusiveStartKey }),
      }),
    );
    for (const item of page.Items ?? []) {
      n.total += 1;
      const hasFlag = item.unread_flag !== undefined && item.unread_flag !== null;
      const count = Number(item.unread_count ?? 0);
      if (hasFlag) n.flagPresent += 1;
      if (count > 0) n.counterPositive += 1;
      if (hasFlag && count > 0) n.consistentUnread += 1;
      if (!hasFlag && count > 0) n.counterOnly += 1;
      if (hasFlag && count <= 0) n.flagOnly += 1;
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey !== undefined);

  console.log(
    [
      '',
      'byUnread index consistency audit',
      '================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      '',
      `  conversations       ${n.total}`,
      `  unread_flag set     ${n.flagPresent}   <- what the walk can see`,
      `  unread_count > 0    ${n.counterPositive}`,
      '',
      `  consistent unread   ${n.consistentUnread}  (flag AND counter)`,
      `  COUNTER-ONLY        ${n.counterOnly}  <- INVISIBLE to the walk; the class`,
      '                            the mark-read fan-out fix was warned about',
      `  flag-only           ${n.flagOnly}  (flag with a zero/absent counter)`,
      '',
      n.counterOnly === 0
        ? '  VERDICT  Index agrees with the counters. A small walk means the'
        : '  VERDICT  UNDER-REPORTING. The walk cannot see every unread thread,',
      n.counterOnly === 0
        ? '           inbox really is near-empty, not that the index is lying.'
        : '           so any coverage figure taken here measures the wrong population.',
      '',
    ].join('\n'),
  );
}

/**
 * `--audit-walk` mode. Sizes the OPEN-PARTITION walk that backs the inbox's
 * All and Unknown tabs - a different read from the sparse unread index, and the
 * one `inbox-filter-tabs-full-walk` is about.
 *
 * This exists because the badge measurement taught an expensive lesson: a cost
 * filed as high can turn out to be entirely hypothetical. The Unknown tab is
 * now the cluster's candidate for "the read that actually costs something", so
 * it gets measured BEFORE anything is built for it, not after.
 *
 * What matters is the number of rows the walk must HYDRATE, not the number it
 * ends up showing: the walk resolves a contact per open conversation to decide
 * whether the row belongs on the tab at all.
 *
 * Full Scan, counts only, no PII.
 */
async function auditWalk(): Promise<void> {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
  const table = `${tablePrefix}conversations`;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  const openByType = new Map<string, number>();
  let total = 0;
  let openTotal = 0;

  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };

  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: '#s, #t',
        ExpressionAttributeNames: { '#s': 'status', '#t': 'type' },
        ...(ExclusiveStartKey === undefined ? {} : { ExclusiveStartKey }),
      }),
    );
    for (const item of page.Items ?? []) {
      total += 1;
      const status = typeof item.status === 'string' ? item.status : '(none)';
      const type = typeof item.type === 'string' ? item.type : '(none)';
      bump(byStatus, status);
      bump(byType, type);
      if (status === 'open') {
        openTotal += 1;
        bump(openByType, type);
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey !== undefined);

  const rows = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${k.padEnd(22)}${v}`);

  console.log(
    [
      '',
      'open-partition walk size (All / Unknown tabs)',
      '============================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      '',
      `  conversations       ${total}`,
      '',
      '  by status:',
      ...rows(byStatus),
      '',
      '  by type:',
      ...rows(byType),
      '',
      `  OPEN partition      ${openTotal}   <- the walk's UPPER BOUND, not its cost`,
      '  open, by type:',
      ...rows(openByType),
      '',
      `  VERDICT  UPPER BOUND ONLY - ${openTotal} is the worst case, not the bill.`,
      '           The pager BREAKS when the page fills, so it only walks this far',
      '           when FEW rows match. Run --audit-unknown-page for the real',
      '           per-render cost.',
      '',
      '  This verdict used to read "REAL COST" off this number alone. That was',
      '  wrong in exactly the way the badge issue was wrong - an upper bound',
      '  reported as a cost - so it now refuses to draw the conclusion and',
      '  points at the measurement that can.',
      '',
    ].join('\n'),
  );
}

/**
 * `--audit-unknown-page` mode. THE measurement for
 * `inbox-filter-tabs-full-walk`, and it exists because `--audit-walk` reported
 * an UPPER BOUND as if it were the cost.
 *
 * The pager BREAKS when the page fills (`if (rows.length === limit) break
 * pager`), so it does not walk the whole open partition unconditionally. What
 * it costs is: conversations scanned - and contact lookups paid - until `limit`
 * matching rows accumulate. The full walk happens only when FEW rows match.
 *
 * That inverts the issue's assumption: a BACKLOGGED Unknown tab is cheap
 * (fills immediately) and a CLEARED one is expensive (scans everything to find
 * nothing). Whichever it is has to be measured, not reasoned about - that being
 * the whole lesson of this cluster.
 *
 * This replicates the pager: same partition, same order, same per-conversation
 * contact resolution, same break condition. Counts only, no PII.
 */
async function auditUnknownPage(pageLimit: number): Promise<void> {
  let scanned = 0;
  let lookups = 0;
  let matched = 0;
  let chunkStartKey: Record<string, unknown> | undefined;
  let filled = false;
  let exhausted = false;

  outer: for (;;) {
    const chunk = await conversations.listByLastActivity({
      status: 'open',
      limit: 100,
      ...(chunkStartKey === undefined ? {} : { exclusiveStartKey: chunkStartKey }),
    });
    for (const conv of chunk.items) {
      scanned += 1;
      // roleFromContact returns 'unknown' for a MISSING contact as well as for
      // a contact typed 'unknown', and needsTriage is `role === 'unknown'`.
      let contact;
      const entry = conv.participants?.find(
        (pt) => pt.phone === conv.participant_phone && pt.contactId !== '',
      );
      if (entry?.contactId !== undefined && entry.contactId !== '') {
        const found = await contacts.getManyByIds([entry.contactId]);
        lookups += 1;
        contact = found.get(entry.contactId);
      } else if (typeof conv.participant_phone === 'string' && conv.participant_phone !== '') {
        contact = await contacts.findByPhone(conv.participant_phone);
        lookups += 1;
      }
      const type = contact?.type;
      const needsTriage = type !== 'tenant' && type !== 'landlord' && type !== 'partner';
      if (needsTriage) matched += 1;
      if (matched === pageLimit) {
        filled = true;
        break outer;
      }
    }
    if (chunk.lastEvaluatedKey === undefined) {
      exhausted = true;
      break;
    }
    chunkStartKey = chunk.lastEvaluatedKey;
  }

  console.log(
    [
      '',
      'Unknown-tab: cost of ONE page render',
      '====================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      `  page limit          ${pageLimit}   (the dashboard's own PAGE_LIMIT)`,
      '',
      `  conversations scanned  ${scanned}`,
      `  contact lookups paid   ${lookups}   <- THE COST, per page render`,
      `  matching rows found    ${matched}`,
      `  outcome                ${filled ? 'page FILLED' : exhausted ? 'partition EXHAUSTED before filling' : 'stopped'}`,
      '',
      filled && lookups <= pageLimit * 3
        ? '  VERDICT  CHEAP. The page fills quickly, so the "full walk" is an\n' +
          '           upper bound this data does not reach. Do not scope the\n' +
          '           unbounded-walk fix off a number nobody is paying.'
        : '  VERDICT  REAL. The walk goes deep before it can answer, so the\n' +
          '           unbounded read is being paid on every debounced SSE event\n' +
          '           while an operator sits on this tab.',
      '',
      '  NOTE the inversion: this is EXPENSIVE when few rows match (a cleared',
      '  tab) and CHEAP when many do (a backlog). Re-measure after any triage',
      '  push, not just after data growth.',
      '',
    ].join('\n'),
  );
}

if (argv.includes('--audit-index')) {
  await auditIndex();
  process.exit(0);
}

if (argv.includes('--audit-unknown-page')) {
  await auditUnknownPage(30);
  process.exit(0);
}

if (argv.includes('--audit-walk')) {
  await auditWalk();
  process.exit(0);
}

const state = { scanExhausted: false, scanned: 0 };
for await (const conv of iterateUnreadConversations({ conversations, logger }, { budget }, state)) {
  tally.scanned += 1;

  if (conv.type === 'relay_group' || conv.type === 'group_text') {
    tally.group += 1;
    continue;
  }

  const isEmail =
    typeof conv.participant_email === 'string' &&
    conv.participant_email !== '' &&
    (conv.participant_phone === undefined || conv.participant_phone === '');
  if (isEmail) tally.oneToOneEmail += 1;
  else tally.oneToOnePhone += 1;

  const selected = selectEntry(conv);
  if (selected.kind === 'noParticipantsArray') tally.noParticipantsArray += 1;
  else if (selected.kind === 'noEntryForKey') tally.noEntryForKey += 1;
  else if (selected.kind === 'ambiguousEntries') tally.ambiguousEntries += 1;
  else if (typeof selected.contactId !== 'string' || selected.contactId === '') {
    tally.emptyContactId += 1;
  } else {
    tally.hasContactId += 1;
    candidateIds.push(selected.contactId);
  }
}

// A non-empty id is not the same as a USABLE one: the read-through only saves a
// Query if the id actually resolves. Deliberately WITHOUT requireComplete - a
// dangling id is exactly what we are trying to count, not an error to throw on.
let resolved = 0;
for (let i = 0; i < candidateIds.length; i += 100) {
  const chunk = candidateIds.slice(i, i + 100);
  const found = await contacts.getManyByIds(chunk);
  resolved += chunk.filter((id) => found.has(id)).length;
}
const dangling = candidateIds.length - resolved;

const oneToOne = tally.oneToOnePhone + tally.oneToOneEmail;
const pct = (n: number): string =>
  oneToOne === 0 ? 'n/a' : `${((n / oneToOne) * 100).toFixed(1)}%`;

const coverage = oneToOne === 0 ? 0 : (resolved / oneToOne) * 100;
/**
 * MINIMUM SAMPLE. The thresholds were fixed in advance so the number could not
 * be rationalised afterwards - but a threshold with no minimum sample is not a
 * guard, it is a confident-sounding coin flip. The first real run returned 2
 * rows in prod and printed "HIGH", which is exactly the failure this constant
 * now prevents: 2 of 2 resolving tells you nothing about 2000.
 *
 * 30 is a convention, not a calculation, and it is deliberately stated as such.
 * Below it the script reports the counts and refuses to render a verdict.
 */
const MIN_SAMPLE = 30;

const verdict =
  oneToOne === 0
    ? 'NO DATA - the walk returned no 1:1 unread rows; this number means nothing'
    : oneToOne < MIN_SAMPLE
      ? `INSUFFICIENT SAMPLE - ${oneToOne} row(s) cannot support any verdict (min ${MIN_SAMPLE}).\n` +
        '           Run --audit-index to find out whether the index is genuinely\n' +
        '           near-empty or under-reporting; those need different answers.'
      : coverage >= 95
        ? 'HIGH - build the read-through; the fallback is a tail case'
        : coverage <= 80
          ? 'LOW - fix the capture paths and backfill FIRST (needs its own go)'
          : 'MIXED - escalate with this number rather than picking';

console.log(
  [
    '',
    'byUnread contact-resolution coverage',
    '===================================',
    `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
    `  table prefix        ${tablePrefix}`,
    `  walk budget         ${budget}${state.scanExhausted ? '' : '  <- BUDGET SPENT, not a full walk'}`,
    '',
    `  scanned             ${tally.scanned}`,
    `  group rows          ${tally.group}  (not applicable - no contact to resolve)`,
    `  1:1 rows            ${oneToOne}   (phone ${tally.oneToOnePhone}, email ${tally.oneToOneEmail})`,
    '',
    '  Of the 1:1 rows:',
    `    resolvable        ${resolved}  ${pct(resolved)}   <- the coverage figure`,
    `    dangling id       ${dangling}  ${pct(dangling)}`,
    `    empty contactId   ${tally.emptyContactId}  ${pct(tally.emptyContactId)}`,
    `    no entry for key  ${tally.noEntryForKey}  ${pct(tally.noEntryForKey)}`,
    `    no participants   ${tally.noParticipantsArray}  ${pct(tally.noParticipantsArray)}`,
    `    ambiguous entries ${tally.ambiguousEntries}  ${pct(tally.ambiguousEntries)}`,
    '',
    `  VERDICT  ${verdict}`,
    '',
    '  Thresholds are the C1 spec 4.1.a proposal (>=95 high, <=80 low), fixed',
    '  in advance so the number cannot be rationalised after the fact.',
    '',
  ].join('\n'),
);

if (!state.scanExhausted) {
  console.log(
    '  NOTE: the budget was spent before the index ran out, so this samples\n' +
      '  the most recently active unread rows rather than all of them. Re-run\n' +
      '  with a larger --budget if the tail is likely to differ.\n',
  );
}
