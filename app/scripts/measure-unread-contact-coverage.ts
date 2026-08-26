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
import { GROUP_DETECTION_ORIGIN } from '../src/services/groupMembers.js';
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
 *
 * HISTORICAL AS OF `feat/inbox-unread-cluster` (2026-08-25, round-2 ruling C1).
 * The app no longer performs this read: `filter=unknown` was moved onto the
 * (type='unknown') contacts byTypeStatus partition, so nothing in production
 * walks `byLastActivity` resolving a contact per open conversation any more.
 * This mode is RETAINED UNCHANGED, deliberately, so the before/after comparison
 * still runs against the same instrument that produced the published figures -
 * do not "modernise" it to match the new read, and do not read its output as
 * the current cost of the Unknown tab. Use `--audit-triage-partition`
 * (with `--no-status-narrow`) for what the tab reads today.
 */
async function auditUnknownPage(pageLimit: number): Promise<void> {
  // The pager's own chunk size: min(FETCH_BATCH=100, max(limit, DEFAULT=25)).
  // At PAGE_LIMIT 30 that is 30, NOT 100 - the first version used 100 and
  // under-reported the partition Query count by roughly 3x.
  const chunkSize = Math.min(100, Math.max(pageLimit, 25));

  let scanned = 0;
  let contactLookups = 0;
  let messageReads = 0;
  let skippedGroup = 0;
  let matched = 0;
  let matchedContactless = 0;
  let queries = 0;
  let chunkStartKey: Record<string, unknown> | undefined;
  let filled = false;
  let exhausted = false;
  const seenContacts = new Set<string>();

  outer: for (;;) {
    const chunk = await conversations.listByLastActivity({
      status: 'open',
      limit: chunkSize,
      ...(chunkStartKey === undefined ? {} : { exclusiveStartKey: chunkStartKey }),
    });
    queries += 1;
    for (const conv of chunk.items) {
      scanned += 1;

      // The pager drops these BEFORE any lookup (`groupKind`). The first version
      // did not, so open relay groups both PAID a lookup and COUNTED as matches -
      // which is what made prod read as 17 matching rows instead of ~8.
      if (conv.type === 'relay_group' || conv.type === 'group_text') {
        skippedGroup += 1;
        continue;
      }

      // The pager's resolver verbatim: findByPhone THEN findByEmail. NOT the
      // participants entry - the first version used that, which is a different
      // resolver with different misses.
      const phone = conv.participant_phone;
      const email = conv.participant_email;
      let contact;
      if (typeof phone === 'string' && phone !== '') {
        contact = await contacts.findByPhone(phone);
        contactLookups += 1;
      }
      if (contact === undefined && typeof email === 'string' && email !== '') {
        contact = await contacts.findByEmail(email);
        contactLookups += 1;
      }

      if (contact === undefined) {
        // No contact and no phone -> dropped. With a phone -> an untriaged
        // unknown row that ALSO pays a message read for its preview, which the
        // first version never counted.
        if (typeof phone !== 'string' || phone === '') continue;
        messageReads += 1;
        matched += 1;
        matchedContactless += 1;
      } else {
        const t = contact.type;
        if (t === 'tenant' || t === 'landlord' || t === 'partner') continue;
        // The pager emits ONE row per contact (newest conversation wins), so a
        // contact with several open threads is one row, not several.
        const key = String(contact.contactId);
        if (seenContacts.has(key)) continue;
        seenContacts.add(key);
        matched += 1;
      }

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
      `  page limit          ${pageLimit}   chunk size ${chunkSize} (the pager's own)`,
      '',
      `  partition Queries      ${queries}`,
      `  conversations scanned  ${scanned}`,
      `  group rows skipped     ${skippedGroup}  (dropped before any lookup, as the pager does)`,
      `  contact lookups paid   ${contactLookups}   <- THE COST, per page render`,
      `  message reads paid     ${messageReads}  (contactless rows fetch a preview)`,
      `  matching rows found    ${matched}  (contactless: ${matchedContactless}) - UPPER BOUND, see note`,
      `  outcome                ${filled ? 'page FILLED' : exhausted ? 'partition EXHAUSTED before filling' : 'stopped'}`,
      '',
      filled
        ? '  VERDICT  CHEAP. The page fills before the partition runs out.'
        : '  VERDICT  REAL. The partition is exhausted on every render, so the unbounded read is paid on every debounced SSE event while an operator sits on this tab.',
      '',
      '  MATCH COUNT IS AN UPPER BOUND. Cost is replicated faithfully; the match',
      '  count is not, because the pager has further drop arms this does not',
      '  implement (soft-deleted-contact resurfacing, and the newest-conversation',
      '  rule beyond the per-contact dedup above). Treat it as "no more than",',
      '  and never quote it as the size of the triage queue.',
      '',
      '  NOTE the inversion: this is EXPENSIVE when few rows match (a cleared',
      '  tab) and CHEAP when many do (a backlog). Re-measure after any triage',
      '  push, not just after data growth.',
      '',
    ].join('\n'),
  );
}

/**
 * `--audit-denorm` mode. THREE contact-derived fields are copied onto the
 * conversation row so the inbox can render without a join: the thread `type`,
 * `participant_display_name`, and the `participants[].contactId` link. All
 * three are maintained by ONE fan-out, from the contact-update route, and that
 * fan-out has known holes - it follows only the contact's scalar PRIMARY phone,
 * contact CREATE never runs it, and a demotion back to `unknown` writes nothing.
 *
 * So the question is not whether they drift but how far. A stale `type` costs
 * a walk; a stale NAME is rendered to an operator as if it were current, which
 * is worse. This measures both, plus how many rows carry a usable link at all.
 *
 * Replicates the app's own rules exactly: `conversationTypeFor` (team_member
 * and unknown map to no 1:1 type, so the honest thread type is `unknown_1to1`)
 * and `displayNameOf` (parts trimmed BEFORE the join, empty -> null).
 *
 * Full walk of the open partition, counts only, no PII - names are compared,
 * never printed.
 */
async function auditDenorm(): Promise<void> {
  const expectedTypeFor = (t: string | undefined): string =>
    t === 'tenant'
      ? 'tenant_1to1'
      : t === 'landlord'
        ? 'landlord_1to1'
        : t === 'partner'
          ? 'partner_1to1'
          : 'unknown_1to1';
  const nameOf = (c: { firstName?: unknown; lastName?: unknown } | undefined): string | null => {
    const first = typeof c?.firstName === 'string' ? c.firstName.trim() : '';
    const last = typeof c?.lastName === 'string' ? c.lastName.trim() : '';
    const joined = [first, last].filter((x) => x.length > 0).join(' ');
    return joined.length > 0 ? joined : null;
  };

  const n = {
    open: 0,
    resolvedContact: 0,
    noUsableLink: 0,
    linkViaPhoneOnly: 0,
    typeDrift: 0,
    typeDriftStaleUnknown: 0,
    typeDriftMissingTriage: 0,
    typeDriftTeamMember: 0,
    nameDrift: 0,
    nameMissingButKnown: 0,
  };
  let chunkStartKey: Record<string, unknown> | undefined;

  do {
    const chunk = await conversations.listByLastActivity({
      status: 'open',
      limit: 100,
      ...(chunkStartKey === undefined ? {} : { exclusiveStartKey: chunkStartKey }),
    });
    for (const conv of chunk.items) {
      if (conv.type === 'relay_group' || conv.type === 'group_text') continue;
      n.open += 1;
      const entry = conv.participants?.find(
        (pt) => pt.phone === conv.participant_phone && pt.contactId !== '',
      );
      let contact;
      if (entry?.contactId !== undefined && entry.contactId !== '') {
        contact = (await contacts.getManyByIds([entry.contactId])).get(entry.contactId);
      } else if (typeof conv.participant_phone === 'string' && conv.participant_phone !== '') {
        contact = await contacts.findByPhone(conv.participant_phone);
        if (contact !== undefined) n.linkViaPhoneOnly += 1;
      }
      if (contact === undefined) {
        n.noUsableLink += 1;
        continue;
      }
      n.resolvedContact += 1;

      const expected = expectedTypeFor(contact.type as string | undefined);
      if (conv.type !== expected) {
        n.typeDrift += 1;
        if (conv.type === 'unknown_1to1') n.typeDriftStaleUnknown += 1;
        else if (expected === 'unknown_1to1') {
          // SPLIT DELIBERATELY. `conversationTypeFor` maps BOTH `unknown` and
          // `team_member` to no 1:1 type, but they are not the same product
          // question: a contact explicitly set back to `unknown` is flagged
          // `needs_review` and belongs in triage, while a `team_member` is a
          // known person who almost certainly does not. Counting them together
          // would hide that distinction inside a single number.
          if (contact.type === 'team_member') n.typeDriftTeamMember += 1;
          else n.typeDriftMissingTriage += 1;
        }
      }

      const want = nameOf(contact as { firstName?: unknown; lastName?: unknown });
      const have = typeof conv.participant_display_name === 'string'
        ? conv.participant_display_name
        : null;
      if (want !== null && have === null) n.nameMissingButKnown += 1;
      else if (want !== null && have !== null && want !== have) n.nameDrift += 1;
    }
    chunkStartKey = chunk.lastEvaluatedKey as Record<string, unknown> | undefined;
  } while (chunkStartKey !== undefined);

  console.log(
    [
      '',
      'Denormalized contact data on conversations - drift audit',
      '=======================================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      '',
      `  open 1:1 threads       ${n.open}`,
      `    contact resolved     ${n.resolvedContact}`,
      `    NO usable link       ${n.noUsableLink}  <- no contactId and no contact by phone`,
      `    link only via phone  ${n.linkViaPhoneOnly}  <- participants[] carried no usable contactId`,
      '',
      '  THREAD TYPE (costs the Unknown-tab walk):',
      `    drifted              ${n.typeDrift}`,
      `      stale "unknown"    ${n.typeDriftStaleUnknown}  <- contact IS typed; thread still unknown_1to1`,
      `      missing triage     ${n.typeDriftMissingTriage}  <- contact is UNKNOWN (needs_review); thread claims resolved`,
      `      team_member        ${n.typeDriftTeamMember}  <- known person, probably should NOT be in triage; see design Q1`,
      '',
      '  DISPLAY NAME (rendered to the operator as if current):',
      `    drifted              ${n.nameDrift}  <- thread shows a DIFFERENT name than the contact`,
      `    missing but known    ${n.nameMissingButKnown}  <- contact has a name; thread falls back to phone`,
      '',
      n.typeDrift === 0 && n.nameDrift === 0 && n.nameMissingButKnown === 0
        ? '  VERDICT  IN SYNC. The fan-out is holding; a backfill would be a no-op.'
        : '  VERDICT  OUT OF SYNC. The fan-out is not holding these fields, so any\n' +
          '           read that TRUSTS them inherits the drift. Backfill, then close\n' +
          '           the holes, then re-run this as the drift detector.',
      '',
      '  The `missing triage` line is the one to read twice: those threads are',
      '  invisible to the Unknown tab TODAY, so they are a correctness bug',
      '  already, independent of any performance work.',
      '',
    ].join('\n'),
  );
}

/**
 * `--audit-triage-partition` mode. Prices the read the Unknown-tab redesign
 * proposes, which nothing in this branch measured before it was proposed.
 *
 * The design leaned on the repo's own comment - "(type=unknown,
 * status=needs_review) IS the human triage queue" - and treated it as the
 * operational reality. The one existing consumer says otherwise. `today.ts`
 * reads this exact partition and needed a bounded TEN-PAGE sequential fill
 * loop, an origin exclusion, a hard result cap, a status re-check and a
 * truncation WARN to survive it, because the partition is "thick with excluded
 * rows" ahead of the real unknowns - and its failure mode was a short block
 * reading as "nothing needs triage".
 *
 * So the question is not "how many untriaged contacts are there" but "how much
 * of this partition must be walked to find them, and what is in the way".
 *
 * Read-only. Counts only, no PII. `Limit` is applied at the index BEFORE the
 * origin FilterExpression, which is exactly why a page can come back short -
 * this measures that directly rather than assuming it away.
 */
async function auditTriagePartition(): Promise<void> {
  // `--no-status-narrow` prices the read the design ACTUALLY proposes. Draft 4's
  // requirement 1 queries type=unknown with NO status filter, because a contact
  // created as `unknown` defaults to status 'active' rather than 'needs_review'
  // - so narrowing on needs_review measures a strictly SMALLER partition than
  // the one that would be read. Every figure published before this flag existed
  // priced the narrowed shape.
  const narrow = !argv.includes('--no-status-narrow');
  const PAGE = 100;
  const MAX_PAGES = 10; // today.ts's TRIAGE_MAX_PAGES - the precedent's budget.
  let queries = 0;
  let rawRows = 0;
  let statusMismatch = 0;
  let deletedSeen = 0;
  let cursor: Record<string, unknown> | undefined;
  let exhausted = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await contacts.listByType('unknown', {
      ...(narrow ? { status: 'needs_review' } : {}),
      limit: PAGE,
      ...(cursor === undefined ? {} : { exclusiveStartKey: cursor }),
    });
    queries += 1;
    rawRows += read.items.length;
    for (const c of read.items) {
      if ((c as { deleted_at?: unknown }).deleted_at !== undefined) deletedSeen += 1;
      if (narrow && c.status !== 'needs_review') statusMismatch += 1;
    }
    cursor = read.lastEvaluatedKey;
    if (cursor === undefined) {
      exhausted = true;
      break;
    }
  }

  // The same read the precedent actually issues - with the origin exclusion -
  // so the two numbers can be compared. The gap between them IS the pollution.
  let filteredRows = 0;
  let filteredQueries = 0;
  let fcursor: Record<string, unknown> | undefined;
  let filteredExhausted = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await contacts.listByType('unknown', {
      ...(narrow ? { status: 'needs_review' } : {}),
      limit: PAGE,
      excludeOrigin: GROUP_DETECTION_ORIGIN,
      ...(fcursor === undefined ? {} : { exclusiveStartKey: fcursor }),
    });
    filteredQueries += 1;
    filteredRows += read.items.length;
    fcursor = read.lastEvaluatedKey;
    if (fcursor === undefined) {
      filteredExhausted = true;
      break;
    }
    if (filteredRows >= PAGE) break;
  }

  console.log(
    [
      '',
      'Contacts triage partition - what the redesign proposes to read',
      '=============================================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      `  page size ${PAGE}, page budget ${MAX_PAGES} (today.ts's own)`,
      '',
      `  query shape: type=unknown${narrow ? ', status=needs_review (NARROWED - NOT what the design proposes; pass --no-status-narrow)' : " (NO status narrowing - the design's actual read)"}`,
      '',
      '  UNFILTERED:',
      `    Queries issued     ${queries}`,
      `    rows returned      ${rawRows}`,
      `    partition ${exhausted ? 'EXHAUSTED within budget' : 'NOT exhausted - more rows behind the budget'}`,
      `    soft-deleted seen  ${deletedSeen}`,
      // PRINTED ONLY WHEN IT CAN MEAN SOMETHING (2026-08-25, round-2 ruling
      // C1). `statusMismatch` is incremented under `if (narrow && ...)` above,
      // so under `--no-status-narrow` it is structurally inert - and printing
      // an inert `0` next to the words "should be 0" reads as a PASSED CHECK,
      // inside the output of the very run the HIGH-1 record depends on. No
      // measured value changes; the line simply does not claim a check that
      // was never made.
      ...(narrow
        ? [`    status mismatch    ${statusMismatch}  (should be 0 - the range key is the status)`]
        : []),
      '',
      '  WITH the group-detection origin exclusion (what today.ts actually issues):',
      `    Queries issued     ${filteredQueries}`,
      `    rows returned      ${filteredRows}`,
      `    ${filteredExhausted ? 'partition EXHAUSTED within budget' : 'NOT exhausted - the fill loop would still be walking'}`,
      '',
      `  POLLUTION            ${rawRows - filteredRows} of ${rawRows} rows are excluded-origin stubs`,
      '',
      rawRows === 0
        ? '  VERDICT  EMPTY partition. The redesign has nothing to read here yet - which is itself the answer, and not a good one.'
        : filteredExhausted && filteredQueries <= 2
          ? '  VERDICT  CHEAP. The partition is small and clean enough to read directly. The redesign cost claim survives.'
          : '  VERDICT  NOT CHEAP. This partition needs the same fill loop, exclusion and truncation warning today.ts already carries. Any design that calls it "one Query per page" is wrong.',
      '',
      '  Limit is applied at the INDEX before the origin FilterExpression, so a',
      '  page can come back short with rows still behind it. That is the mechanism',
      '  behind the precedent silently rendering "nothing needs triage".',
      '',
    ].join('\n'),
  );
}

if (argv.includes('--audit-index')) {
  await auditIndex();
  process.exit(0);
}

/**
 * `--audit-tab-vs-partition` mode. The ROW-SET DIFF both round-2 reviewers
 * demanded before the Unknown tab may change its source.
 *
 * The tab today keys on contact TYPE alone (`roleFromContact(contact) ===
 * 'unknown'`). The proposed contact-side read keys on TYPE AND STATUS
 * (`type=unknown, status=needs_review`). Those are different sets, and the
 * first real measurement did not reconcile: prod showed a tab upper bound of 8
 * against a partition of 7 unfiltered / 4 filtered.
 *
 * A count comparison cannot settle it - only comparing the actual IDENTITIES
 * can, because the two sets can differ in BOTH directions at once and still
 * produce plausible totals. This walks both and diffs them by class.
 *
 * Read-only. Counts only, no PII: contact ids are compared in memory and never
 * printed. Statuses ARE printed, because a status is a schema value rather than
 * anything about a person, and knowing WHICH status a missed row carries is the
 * whole point.
 */
async function auditTabVsPartition(pageLimit: number): Promise<void> {
  // Same flag as --audit-triage-partition, and for the same reason: draft 4's
  // requirement 1 queries type=unknown with NO status narrowing. Left narrowed,
  // this diff reports every `active` unknown as "in tab, NOT in partition" -
  // losses the design would never actually incur.
  const narrow = !argv.includes('--no-status-narrow');
  // 1. Walk the open partition exactly as the pager does, collecting the
  //    contact ids the tab would show. No page limit here - we want the whole
  //    set, not the first page, because a row missing from page 3 is still
  //    missing.
  const tabContactIds = new Set<string>();
  const tabStatuses = new Map<string, number>();
  let contactlessRows = 0;
  let chunkStartKey: Record<string, unknown> | undefined;
  const chunkSize = Math.min(100, Math.max(pageLimit, 25));
  do {
    const chunk = await conversations.listByLastActivity({
      status: 'open',
      limit: chunkSize,
      ...(chunkStartKey === undefined ? {} : { exclusiveStartKey: chunkStartKey }),
    });
    for (const conv of chunk.items) {
      if (conv.type === 'relay_group' || conv.type === 'group_text') continue;
      const phone = conv.participant_phone;
      const email = conv.participant_email;
      let contact;
      if (typeof phone === 'string' && phone !== '') contact = await contacts.findByPhone(phone);
      if (contact === undefined && typeof email === 'string' && email !== '') {
        contact = await contacts.findByEmail(email);
      }
      if (contact === undefined) {
        if (typeof phone === 'string' && phone !== '') contactlessRows += 1;
        continue;
      }
      const t = contact.type;
      if (t === 'tenant' || t === 'landlord' || t === 'partner') continue;
      const id = String(contact.contactId);
      if (!tabContactIds.has(id)) {
        tabContactIds.add(id);
        const st = String(contact.status ?? '(none)');
        tabStatuses.set(st, (tabStatuses.get(st) ?? 0) + 1);
      }
    }
    chunkStartKey = chunk.lastEvaluatedKey as Record<string, unknown> | undefined;
  } while (chunkStartKey !== undefined);

  // 2. The partition the redesign proposes, both with and without the origin
  //    exclusion the existing consumer applies.
  const collect = async (excludeOrigin: boolean): Promise<Set<string>> => {
    const out = new Set<string>();
    let cursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const read = await contacts.listByType('unknown', {
        ...(narrow ? { status: 'needs_review' } : {}),
        limit: 100,
        ...(excludeOrigin ? { excludeOrigin: GROUP_DETECTION_ORIGIN } : {}),
        ...(cursor === undefined ? {} : { exclusiveStartKey: cursor }),
      });
      for (const c of read.items) out.add(String(c.contactId));
      cursor = read.lastEvaluatedKey;
      if (cursor === undefined) break;
    }
    return out;
  };
  const partitionAll = await collect(false);
  const partitionFiltered = await collect(true);

  // 3. Diff by class.
  const inTabNotPartition: string[] = [];
  const inTabOnlyExcluded: string[] = [];
  for (const id of tabContactIds) {
    if (partitionFiltered.has(id)) continue;
    if (partitionAll.has(id)) inTabOnlyExcluded.push(id);
    else inTabNotPartition.push(id);
  }
  const inPartitionNotTab = [...partitionFiltered].filter((id) => !tabContactIds.has(id));

  // What statuses do the MISSED rows carry? This is the number that decides
  // whether narrowing to needs_review is a silent regression.
  const missedStatuses = new Map<string, number>();
  // WHY a missed row is missed decides whether this is a design question or a
  // live bug. `listByType` excludes soft-deleted rows by default, so a
  // soft-deleted contact is missing for a BENIGN reason. A row that is NOT
  // soft-deleted, carries type=unknown and status=needs_review, and still does
  // not come back from the byTypeStatus partition is invisible to EVERY reader
  // of that partition - including Today's triage block.
  const missedWhy = new Map<string, number>();
  if (inTabNotPartition.length > 0) {
    const probe = inTabNotPartition.slice(0, 100);
    const found = await contacts.getManyByIds(probe);
    // The soft-deleted view of the same partition - the one `listByType`
    // suppresses unless asked.
    const deletedInPartition = new Set<string>();
    let dcursor: Record<string, unknown> | undefined;
    for (let page = 0; page < 10; page += 1) {
      const read = await contacts.listByType('unknown', {
        ...(narrow ? { status: 'needs_review' } : {}),
        limit: 100,
        deleted: true,
        ...(dcursor === undefined ? {} : { exclusiveStartKey: dcursor }),
      });
      for (const c of read.items) deletedInPartition.add(String(c.contactId));
      dcursor = read.lastEvaluatedKey;
      if (dcursor === undefined) break;
    }
    for (const id of probe) {
      const c = found.get(id);
      const st = String(c?.status ?? '(not found)');
      missedStatuses.set(st, (missedStatuses.get(st) ?? 0) + 1);
      const softDeleted = (c as { deleted_at?: unknown } | undefined)?.deleted_at !== undefined;
      const why =
        c === undefined
          ? 'contact row not found at all'
          : softDeleted && deletedInPartition.has(id)
            ? 'SOFT-DELETED (benign - listByType suppresses these)'
            : softDeleted
              ? 'soft-deleted AND absent from the deleted view too'
              : c.type !== 'unknown'
                ? `type is ${String(c.type)}, not unknown (tab and partition disagree by design)`
                : 'NOT deleted, type=unknown - INVISIBLE TO THE byTypeStatus PARTITION';
      missedWhy.set(why, (missedWhy.get(why) ?? 0) + 1);
    }
  }
  const fmt = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `      ${k.padEnd(20)}${v}`);

  console.log(
    [
      '',
      'Unknown tab vs triage partition - ROW-SET DIFF',
      '==============================================',
      `  endpoint            ${endpoint ?? '(AWS default resolution)'}`,
      `  table prefix        ${tablePrefix}`,
      `  query shape         type=unknown${narrow ? ', status=needs_review (NARROWED - NOT the design; pass --no-status-narrow)' : " (NO status narrowing - the design's read)"}`,
      '',
      `  tab would show (by contact)   ${tabContactIds.size}`,
      '    their statuses:',
      ...fmt(tabStatuses),
      `  contactless rows (no contact) ${contactlessRows}  <- invisible to ANY contact-side read`,
      '',
      `  partition, unfiltered         ${partitionAll.size}`,
      `  partition, origin-excluded    ${partitionFiltered.size}`,
      '',
      '  THE DIFF:',
      `    in tab, NOT in partition    ${inTabNotPartition.length}  <- would be SILENTLY LOST`,
      ...(missedStatuses.size > 0 ? ['      by status:', ...fmt(missedStatuses)] : []),
      ...(missedWhy.size > 0
        ? [
            '      WHY missed:',
            ...[...missedWhy.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `        ${String(v).padStart(4)}  ${k}`),
          ]
        : []),
      `    in tab, excluded by origin  ${inTabOnlyExcluded.length}  <- lost only if the exclusion is copied`,
      `    in partition, NOT in tab    ${inPartitionNotTab.length}  <- would be NEWLY SHOWN (no open thread?)`,
      '',
      // A detector that cries wolf on an EXPLAINED difference gets ignored, so
      // the verdict distinguishes "unexplained" from "explained and benign".
      // Soft-deleted rows are the benign class: the pager hides them too, and
      // only resurfaces one while an unread post-deletion inbound exists.
      ...(() => {
        const benign = missedWhy.get('SOFT-DELETED (benign - listByType suppresses these)') ?? 0;
        const unexplained = inTabNotPartition.length - benign;
        if (unexplained === 0 && contactlessRows === 0 && benign === 0) {
          return ['  VERDICT  SETS RECONCILE. A contact-side read loses nothing the tab shows today.'];
        }
        if (unexplained === 0 && contactlessRows === 0) {
          return [
            `  VERDICT  RECONCILE, WITH ONE REQUIREMENT. All ${benign} differences are`,
            '           soft-deleted contacts, which the pager hides as well - so nothing',
            '           is silently lost. BUT the pager RESURFACES a soft-deleted',
            '           contact while an unread post-deletion inbound exists, and',
            '           listByType excludes deleted rows by default. A contact-side',
            '           read must handle resurfacing EXPLICITLY or it drops that',
            '           feature. This is a design requirement, not a blocker.',
          ];
        }
        return [
          `  VERDICT  SETS DIVERGE - ${unexplained} row(s) UNEXPLAINED. Switching source`,
          '           silently changes what the operator sees, and a missed triage row',
          '           is invisible by construction. Explain every unexplained row above',
          '           before the source changes.',
        ];
      })(),
      '',
    ].join('\n'),
  );
}

if (argv.includes('--audit-triage-partition')) {
  await auditTriagePartition();
  process.exit(0);
}

if (argv.includes('--audit-tab-vs-partition')) {
  await auditTabVsPartition(30);
  process.exit(0);
}

if (argv.includes('--audit-denorm')) {
  await auditDenorm();
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
