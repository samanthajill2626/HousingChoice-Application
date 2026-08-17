// backfill:unread-flag - one-time, IDEMPOTENT backfill bringing LEGACY
// conversation rows onto the byUnread invariant (design 2026-08-16, section
// 7.2): `unread_flag` exists IFF that row's unread is meant to be > 0.
//
// The sparse byUnread GSI is keyed on `unread_flag`, so a pre-migration row
// carrying unread_count > 0 with no flag is INVISIBLE to every unread read (the
// inbox Unread tab, the nav badge, Today). This stamps them. It also applies
// the two retroactive RESET rules the human ruled at the spec gate, which the
// runtime now enforces going forward:
//   - a relay group CLOSED while unread keeps no unread (setRelayStatus zeroes
//     it on close now; legacy closed groups are cleaned here);
//   - a soft-deleted contact's threads keep no unread (the delete handler fans
//     out resetUnread now; legacy deleted-contact threads are cleaned here) -
//     EXCEPT where the thread genuinely RESURFACED, which is decided by the
//     SAME predicate the runtime uses (routes/inbox.ts): the newest message is
//     inbound AND its created_at is after the contact's deleted_at.
//
// That last rule costs one messages read per deleted-contact thread with
// unread. It is deliberately NOT short-circuited on last_activity_at: that
// attribute is the PROVIDER clock while created_at is OUR ingest clock, so
// comparing them against deleted_at is not clock-safe. A one-shot probe on a
// bounded population is the accepted price for never silently zeroing a genuine
// resurfacing.
//
// Rows already in the right state are skipped, and every write is conditional
// on the state the PLANNER DECIDED FROM - not merely on the attribute it is
// about to change - so re-running is always safe, a concurrent run cannot
// double-apply, and a row that moved under the runner is skipped and left for
// the next run rather than written from a stale decision. See `stamp` and
// `reset` below for the two races that shape those conditions.
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local). Against a deployed env it
// resolves the physical tables via lib/config.tableName (respects TABLE_PREFIX).
// There is NO local-only guard, deliberately and by precedent: this is an ops
// script the human runs against dev and prod per the RUNBOOK, exactly like
// backfill-broadcast-list-partition.ts. (db-update-gsis.ts is the opposite case
// and IS localhost-guarded.)
//
// PII: logs COUNTS and conversationIds only - never phones, emails or bodies.
//
// Run (from repo root, tsx): `tsx app/scripts/backfill-unread-flag.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import {
  contactEmails,
  contactPhones,
  isDeleted,
  type ContactItem,
} from '../src/repos/contactsRepo.js';
import { UNREAD_FLAG_VALUE } from '../src/repos/conversationsRepo.js';
import { createMessagesRepo, type MessagesRepo } from '../src/repos/messagesRepo.js';

/** Partition prefixes of the key-only pointer/claim rows a Scan also returns. */
const POINTER_PREFIXES = ['phone#', 'email#', 'token#'] as const;

/**
 * What one conversation row needs.
 *
 * `probe` is not a write - it means "this is a deleted-contact thread carrying
 * unread; the runner must read the newest message before it can decide", and it
 * resolves to `stamp` (genuine resurfacing) or `reset`.
 */
export type BackfillAction =
  | { kind: 'stamp' }
  | { kind: 'remove' }
  | { kind: 'skip' }
  | { kind: 'reset' } // zero count + remove flag (closed relay / stable-no deleted)
  | { kind: 'probe' }; // deleted-contact thread - needs the message read first

/**
 * The soft-deleted-contact participant keys, built by the contacts pre-pass.
 * `deletedAtByKey` maps each phone/email back to its contact's `deleted_at`,
 * which the resurfacing probe compares the newest message against.
 */
export interface DeletedContactKeys {
  phones: ReadonlySet<string>;
  emails: ReadonlySet<string>;
  deletedAtByKey: ReadonlyMap<string, string>;
}

/** An empty deleted-contact set (no soft-deleted contacts in the table). */
export const NO_DELETED_CONTACTS: DeletedContactKeys = {
  phones: new Set(),
  emails: new Set(),
  deletedAtByKey: new Map(),
};

function isPointerPartition(conversationId: unknown): boolean {
  return (
    typeof conversationId === 'string' &&
    POINTER_PREFIXES.some((prefix) => conversationId.startsWith(prefix))
  );
}

function unreadCountOf(item: Record<string, unknown>): number {
  const count = item['unread_count'];
  return typeof count === 'number' ? count : 0;
}

/**
 * The `deleted_at` of the soft-deleted contact owning this thread, or undefined
 * when no participant of it is deleted.
 *
 * PHONE FIRST, then email - the same resolution order the runtime hydration
 * uses (contactThreads.conversationsForContact, routes/inbox.ts). Exported so
 * the planner and the runner's probe agree by construction rather than by two
 * copies of the same rule.
 */
export function deletedAtForItem(
  item: Record<string, unknown>,
  keys: DeletedContactKeys,
): string | undefined {
  const phone = item['participant_phone'];
  if (typeof phone === 'string' && keys.phones.has(phone)) {
    return keys.deletedAtByKey.get(phone);
  }
  const email = item['participant_email'];
  if (typeof email === 'string' && keys.emails.has(email)) {
    return keys.deletedAtByKey.get(email);
  }
  return undefined;
}

/**
 * PURE mapping - decide what (if anything) one conversation row needs.
 * No I/O, no clock. Factored out so every rule is unit-testable without a
 * database (see app/test/backfillUnreadFlag.test.ts).
 *
 * The rules are PRECEDENCE-ORDERED (spec 7.2); the order is the contract:
 *   1. pointer/claim partitions              -> skip  (never carry unread)
 *   2. unread > 0 on a CLOSED relay_group    -> reset (retroactive close rule)
 *   3. unread > 0 on a deleted-contact thread-> probe (retroactive delete rule)
 *   4. unread > 0 with the flag absent       -> stamp (the migration proper)
 *   5. flag present with count 0/absent      -> remove
 *   6. anything else                         -> skip  (already correct)
 *
 * 2 and 3 sit ABOVE 4 on purpose: those rows are legacy invisible residents,
 * and stamping them would make accrued unread that no reader was ever meant to
 * see suddenly appear in the badge.
 */
export function planUnreadBackfill(
  item: Record<string, unknown>,
  deletedContactKeys: DeletedContactKeys,
): BackfillAction {
  // 1. Pointer/claim rows carry ONLY the key + ref_conversationId, so they can
  // never enter the index. Counted as scanned+skipped rather than filtered out
  // before counting, so the scan total matches the table.
  if (isPointerPartition(item['conversationId'])) return { kind: 'skip' };

  const unread = unreadCountOf(item);
  const flagged = 'unread_flag' in item;

  if (unread > 0) {
    // 2. A relay group closed while unread. Every reader already ignores it;
    // the runtime now zeroes on close, so clean the legacy ones the same way.
    if (item['type'] === 'relay_group' && item['status'] === 'closed') {
      return { kind: 'reset' };
    }
    // 3. A soft-deleted contact's thread. Whether it stays unread depends on
    // the newest MESSAGE, which the planner cannot read - hand it to the runner.
    if (deletedAtForItem(item, deletedContactKeys) !== undefined) {
      return { kind: 'probe' };
    }
    // 4. The migration proper: genuinely unread, simply not in the index yet.
    if (!flagged) return { kind: 'stamp' };
    return { kind: 'skip' }; // already flagged and genuinely unread
  }

  // 5. Flag left behind on a read row (or a hand-written/legacy stray).
  if (flagged) return { kind: 'remove' };

  // 6. Correct as it stands.
  return { kind: 'skip' };
}

/**
 * Resolve a `probe` once the newest message is in hand: the SAME resurfacing
 * predicate the runtime uses (routes/inbox.ts isFreshInbound) - the newest
 * message is inbound AND landed after the delete.
 */
export function resolveProbe(
  latest: { direction?: unknown; created_at?: unknown } | undefined,
  deletedAt: string,
): { kind: 'stamp' } | { kind: 'reset' } {
  if (
    latest !== undefined &&
    latest.direction === 'inbound' &&
    typeof latest.created_at === 'string' &&
    // CLOCK CAVEAT (mirrored from routes/inbox.ts): created_at is OUR ingest
    // timestamp, so skew around the delete can hide a resurfaced row until the
    // next inbound lands. Never compare last_activity_at here - that is the
    // PROVIDER clock and the two are not comparable.
    latest.created_at > deletedAt
  ) {
    return { kind: 'stamp' };
  }
  return { kind: 'reset' };
}

export interface BackfillResult {
  scanned: number;
  stamped: number;
  removed: number;
  skipped: number;
  /** Rows reset by rule 2 (relay group closed while unread). */
  closedReset: number;
  /** Rows reset by rule 3 after the probe said "no resurfacing". */
  deletedReset: number;
  /** Deleted-contact threads that needed a message read (stamped + deletedReset). */
  probed: number;
}

/**
 * Scan the contacts table and collect the phones/emails of every SOFT-DELETED
 * contact, with the `deleted_at` the resurfacing probe compares against.
 * Pointer rows (phone_ref / email_ref) carry no contact identity and are
 * skipped.
 */
export async function collectDeletedContactKeys(
  doc: DynamoDBDocumentClient,
  table: string,
): Promise<DeletedContactKeys> {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const deletedAtByKey = new Map<string, string>();

  /** Keep the EARLIEST deleted_at when a key somehow maps to two deleted
   *  contacts: the earlier the delete, the more likely a later inbound counts
   *  as a resurfacing, and KEEPING unread is the conservative outcome here. */
  const note = (key: string, deletedAt: string): void => {
    const existing = deletedAtByKey.get(key);
    if (existing === undefined || deletedAt < existing) deletedAtByKey.set(key, deletedAt);
  };

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (Items ?? []) as Array<Record<string, unknown>>) {
      // Skip phone/email-pointer items (no contact identity, no deleted_at).
      if (item['phone_ref'] === true || item['email_ref'] === true) continue;
      const contact = item as unknown as ContactItem;
      if (!isDeleted(contact)) continue;
      const deletedAt = contact.deleted_at;
      if (typeof deletedAt !== 'string' || deletedAt.length === 0) continue;
      for (const entry of contactPhones(contact)) {
        phones.add(entry.phone);
        note(entry.phone, deletedAt);
      }
      for (const entry of contactEmails(contact)) {
        emails.add(entry.email);
        note(entry.email, deletedAt);
      }
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return { phones, emails, deletedAtByKey };
}

/**
 * Apply the backfill to every conversation row. When dryRun, the plan is
 * computed (INCLUDING the probe reads, so the reported counts are truthful) but
 * nothing is written.
 *
 * The `doc` / `env` / `messagesRepo` options are a TEST SEAM only - production
 * resolves the ambient env exactly like the sibling backfills (adjudication A7).
 */
export async function backfillUnreadFlag(
  opts: {
    dryRun?: boolean;
    doc?: DynamoDBDocumentClient;
    env?: NodeJS.ProcessEnv;
    messagesRepo?: Pick<MessagesRepo, 'listByConversation'>;
  } = {},
): Promise<BackfillResult> {
  const doc = opts.doc ?? getDocumentClient();
  const env = opts.env ?? process.env;
  const table = tableName('conversations', env);
  const contactsTable = tableName('contacts', env);
  const messages = opts.messagesRepo ?? createMessagesRepo({ doc, env });
  const dryRun = opts.dryRun === true;

  // PRE-PASS: which participants belong to soft-deleted contacts.
  const deletedContactKeys = await collectDeletedContactKeys(doc, contactsTable);

  const result: BackfillResult = {
    scanned: 0,
    stamped: 0,
    removed: 0,
    skipped: 0,
    closedReset: 0,
    deletedReset: 0,
    probed: 0,
  };

  /** SET the flag; conditional on it still being absent AND the row still
   *  carrying unread (idempotent write). */
  const stamp = async (conversationId: unknown): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId },
        UpdateExpression: 'SET unread_flag = :flag',
        // Guards the state this transitions FROM: a concurrent run cannot
        // double-stamp, and a row already flagged is a silent no-op.
        //
        // `unread_count > :zero` IS LOAD-BEARING, not belt-and-braces. The
        // planner decided `stamp` from the Scan image; the flag's absence alone
        // does NOT preserve that decision, because the window between the Scan
        // page read and this write is long (awaited writes, plus a
        // listByConversation per deleted-contact probe, for every row of the
        // page). A VA marking the thread read inside that window leaves the row
        // at count 0 with the flag STILL absent - so without this clause the
        // condition passes and the migration stamps a flag onto a READ row.
        // That row - {unread_count: 0, unread_flag: 'unread'} - is a member of
        // the sparse GSI (the flag is the HASH) that isUnreadVisible rejects
        // forever, and NO runtime path removes it: resetUnread is the only
        // REMOVE and it will not run again for an already-read thread. A
        // permanent invisible resident, burning scan budget on every nav-badge
        // request, reported as `stamped` SUCCESS. planUnreadBackfill rule 5
        // calls that state `remove`; the migration must not manufacture it.
        // Losing this condition just means the row is already correct.
        ConditionExpression:
          'attribute_exists(conversationId) AND attribute_not_exists(unread_flag) AND unread_count > :zero',
        ExpressionAttributeValues: { ':flag': UNREAD_FLAG_VALUE, ':zero': 0 },
      }),
    );
  };

  /** REMOVE a flag left on a read row; conditional on it still being present. */
  const remove = async (conversationId: unknown): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId },
        UpdateExpression: 'REMOVE unread_flag',
        ConditionExpression: 'attribute_exists(conversationId) AND attribute_exists(unread_flag)',
      }),
    );
  };

  /**
   * Zero the count AND drop the flag in ONE write, exactly like the runtime's
   * resetUnread - conditional on the STATE THE DECISION WAS MADE FROM, not
   * merely on "still carries some unread".
   *
   * `unread_count > :zero` was the wrong question. It asks "does this row still
   * carry ANY unread", when the runner needs "does it still carry the unread I
   * decided about". The two differ exactly where it matters:
   *
   * - DELETED-CONTACT reset (rule 3, after the probe): the decision point is the
   *   listByConversation probe. A genuine POST-deletion INBOUND landing after
   *   that probe - precisely the event the resurfacing rule exists to surface -
   *   satisfies `> 0`, so the reset fired and zeroed it. The message survived in
   *   the thread but the contact never resurfaced in the inbox and never reached
   *   the badge: the operator was never told the person wrote back.
   * - CLOSED-RELAY reset (rule 2): an inbound on a closed relay group increments
   *   unread AND (via touchLastActivity) can flip status back to 'open'. `> 0`
   *   let the runner zero a group that is no longer closed.
   *
   * So both callers condition on the OBSERVED count, and the closed-relay caller
   * additionally re-asserts the type/status its rule selected on. A row that
   * moved under the runner fails the condition, is skipped (the losing write is
   * swallowed as always), and is left for a re-run - which re-reads it and
   * decides again from fresh state. Conservative in the right direction: the
   * cost of skipping is one more run; the cost of firing is a destroyed
   * resurfacing.
   *
   * NOT fully precise, and deliberately so: the deleted-contact decision also
   * rests on the contact's `deleted_at` from the pre-pass, which lives in
   * ANOTHER table and therefore cannot enter a single-item ConditionExpression.
   * A contact RESTORED between the pre-pass and this write still has its threads
   * zeroed. That gap is inherent to a non-transactional cross-table decision, is
   * bounded by one run, and is the same exposure the pre-pass has always had.
   */
  const reset = async (
    conversationId: unknown,
    expected: { count: number; closedRelay: boolean },
  ): Promise<void> => {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId },
        UpdateExpression: 'SET unread_count = :zero REMOVE unread_flag',
        ConditionExpression: expected.closedRelay
          ? 'attribute_exists(conversationId) AND unread_count = :seen AND #type = :relay AND #status = :closed'
          : 'attribute_exists(conversationId) AND unread_count = :seen',
        // `type` and `status` are both DynamoDB reserved words - names, not
        // literals. Only supplied on the branch that references them.
        ...(expected.closedRelay && {
          ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
        }),
        ExpressionAttributeValues: {
          ':zero': 0,
          ':seen': expected.count,
          ...(expected.closedRelay && { ':relay': 'relay_group', ':closed': 'closed' }),
        },
      }),
    );
  };

  /** A losing conditional write means another actor already reached the target
   *  state - the whole point of an idempotent backfill, never an error. */
  const write = async (fn: () => Promise<void>): Promise<void> => {
    if (dryRun) return;
    try {
      await fn();
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  };

  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (Items ?? []) as Array<Record<string, unknown>>) {
      result.scanned += 1;
      const conversationId = item['conversationId'];
      const planned = planUnreadBackfill(item, deletedContactKeys);

      // Resolve a `probe` into a terminal action FIRST, so the switch below
      // only ever sees the four write-or-skip kinds. A probe resolving to
      // `reset` is counted as deletedReset, never closedReset - the two
      // retroactive rules stay distinguishable in the run report.
      let action: Exclude<BackfillAction, { kind: 'probe' }>;
      let resetBucket: 'closedReset' | 'deletedReset' = 'closedReset';

      if (planned.kind === 'probe') {
        result.probed += 1;
        const deletedAt = deletedAtForItem(item, deletedContactKeys);
        if (deletedAt === undefined) {
          // Unreachable: the same helper is what decided 'probe'. Narrow rather
          // than assert, and leave the row untouched if it ever happens.
          action = { kind: 'skip' };
        } else {
          const page = await messages.listByConversation(String(conversationId), { limit: 1 });
          action = resolveProbe(page[0], deletedAt);
          resetBucket = 'deletedReset';
        }
      } else {
        action = planned;
      }

      switch (action.kind) {
        case 'stamp':
          await write(() => stamp(conversationId));
          result.stamped += 1;
          break;
        case 'remove':
          await write(() => remove(conversationId));
          result.removed += 1;
          break;
        case 'reset':
          // `planned.kind === 'reset'` is EXACTLY rule 2 (a closed relay group);
          // every other reset arrived through the probe. Derived from the plan
          // rather than from `resetBucket` so the extra type/status guard cannot
          // drift away from the rule that asked for it.
          await write(() =>
            reset(conversationId, {
              count: unreadCountOf(item),
              closedRelay: planned.kind === 'reset',
            }),
          );
          result[resetBucket] += 1;
          break;
        case 'skip':
          result.skipped += 1;
          break;
      }
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

// --- Runnable entrypoint (skipped when imported by tests) ------------------
// tsx runs this file as the process entry; import.meta guards the side effects.
const isEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfill-unread-flag.ts');
if (isEntrypoint) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:unread-flag - starting');
  backfillUnreadFlag({ dryRun })
    .then((r) => {
      logger.info(
        {
          scanned: r.scanned,
          stamped: r.stamped,
          removed: r.removed,
          skipped: r.skipped,
          closedReset: r.closedReset,
          deletedReset: r.deletedReset,
          probed: r.probed,
          dryRun,
        },
        `backfill:unread-flag - done${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      );
    })
    .catch((err) => {
      logger.error({ err }, 'backfill:unread-flag - FAILED');
      process.exit(1);
    });
}
