// import:apply — write the reviewed workbook + raw exports into DynamoDB
// (spec §3.1, §3.2).
//
// WHY THIS IS NOT A BLIND OVERWRITE.
//
// The obvious implementation — Put every item and let re-runs overwrite — is
// wrong in exactly the situation the re-run exists for. The sequence is:
//
//   8/09  apply to dev (rehearsal)
//   8/10  number ports, apply to prod, Sam starts working
//   8/1x  re-apply because something was wrong
//
// By the third step real traffic has landed and Sam has changed statuses,
// renamed people and triaged the unknowns. A blind Put reverts all of it, which
// would make "re-runnable after cutover" a claim we could not honour.
//
// So each entity declares which fields the IMPORT owns, and apply writes only
// those. Two extra rules protect live state:
//
//   - Status is only rewritten when WE wrote the one that is stored
//     (`status_source === 'import'`). A tenant Sam moved to `placed` by hand
//     stays placed. See upsertContact for why this does NOT use
//     SOURCE_PRECEDENCE.
//   - `last_activity_at` moves forward only. A conversation that received a real
//     message after the import keeps the newer timestamp.
//
// Messages and calls ARE blind Puts: they are immutable historical records keyed
// on their own source id, so re-writing one reproduces it byte for byte.

import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { tableName } from '../config.js';
import type { TransitionSource } from '../statusModel.js';
import type { ContactType } from '../../repos/contactsRepo.js';
import { conversationIdFor1to1, tsMsgId, unitIdForAddress } from './ids.js';
import { normalizeAddress } from './addresses.js';
import type { CsvRow } from './csv.js';
import type { MergedPerson } from './merge.js';
import type { PlanResult } from './plan.js';
import { isDropped, wantsDayOneConnect } from './workbook.js';

/** Stamped on every item this importer writes, for provenance and for cleanup. */
export const IMPORT_SOURCE = 'quo-airtable-import';

/** The `status_source` value the import stamps (statusModel TransitionSource). */
const IMPORT_STATUS_SOURCE: TransitionSource = 'import';

export interface ApplyOptions {
  doc: DynamoDBDocumentClient;
  plan: PlanResult;
  /** The reviewed workbook, indexed by row_key. */
  review: {
    contacts: Map<string, CsvRow>;
    groups: Map<string, CsvRow>;
    units: Map<string, CsvRow>;
  };
  /** ISO 8601 stamp recorded as the import instant on every item. */
  importedAt: string;
  /** Report what WOULD be written without writing it. */
  dryRun?: boolean;
  onProgress?: (label: string, done: number, total: number) => void;
  /**
   * Env used to resolve physical table names (TABLE_PREFIX). Defaults to
   * process.env, which is what the CLI wants. Integration tests pass a unique
   * prefix so they can create and drop their OWN tables — vitest runs files in
   * parallel, and dropping the shared `hc-local-` tables mid-run breaks whatever
   * neighbouring suite is using them (it broke devOutbox.integration).
   */
  env?: NodeJS.ProcessEnv;
}

export interface ApplyReport {
  contacts: { written: number; skippedDropped: number; statusPreserved: number };
  conversations: { written: number; groups: number; connectedDayOne: number };
  messages: { written: number };
  calls: { written: number };
  units: { written: number; skippedDropped: number };
  warnings: string[];
}

const VALID_TYPES: ReadonlySet<string> = new Set<ContactType>([
  'tenant',
  'landlord',
  'partner',
  'team_member',
  'unknown',
]);

export async function runApply(options: ApplyOptions): Promise<ApplyReport> {
  const { doc, plan, review, importedAt, dryRun = false } = options;
  const env = options.env ?? process.env;
  const table = (base: string): string => tableName(base, env);
  const warnings: string[] = [];

  const report: ApplyReport = {
    contacts: { written: 0, skippedDropped: 0, statusPreserved: 0 },
    conversations: { written: 0, groups: 0, connectedDayOne: 0 },
    messages: { written: 0 },
    calls: { written: 0 },
    units: { written: 0, skippedDropped: 0 },
    warnings,
  };

  // ---------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------
  const contactsTable = table('contacts');
  /** phone -> the contactId we actually wrote, for conversation participants. */
  const contactIdByPhone = new Map<string, string>();
  /** row_keys the founder dropped — their threads and messages are skipped too. */
  const droppedPhones = new Set<string>();

  const people = plan.merge.people;
  let i = 0;
  for (const person of people) {
    options.onProgress?.('contacts', ++i, people.length);
    const row = review.contacts.get(person.rowKey);

    if (row && isDropped(row)) {
      droppedPhones.add(person.phone);
      report.contacts.skippedDropped += 1;
      // Skipping the write is not enough. If an EARLIER run already imported
      // this person and she dropped them in a later review, leaving the row
      // behind means "drop" quietly did nothing — and she would have no way to
      // tell. So remove what the import created, and only that.
      if (!dryRun) await retractImported(doc, person, warnings, env);
      continue;
    }

    const resolved = resolvePerson(person, row, warnings);
    contactIdByPhone.set(person.phone, person.contactId);
    if (dryRun) {
      report.contacts.written += 1;
      continue;
    }

    const preserved = await upsertContact(doc, contactsTable, person, resolved, importedAt);
    if (preserved) report.contacts.statusPreserved += 1;
    report.contacts.written += 1;
  }

  // ---------------------------------------------------------------------
  // Conversations, messages and calls
  // ---------------------------------------------------------------------
  const conversationsTable = table('conversations');
  const messagesTable = table('messages');
  const ownNumbers = plan.quo.ownNumbers;

  const groupRowByConversationId = new Map<string, CsvRow>();
  {
    const groupThreads = plan.threads.threads.filter((t) => t.isGroup);
    groupThreads.forEach((t, idx) => {
      const key = `GRP-${String(idx + 1).padStart(4, '0')}`;
      const row = review.groups.get(key);
      if (row) groupRowByConversationId.set(t.conversationId, row);
    });
  }

  const messageBatch = new BatchWriter(doc, messagesTable, dryRun);

  let t = 0;
  for (const thread of plan.threads.threads) {
    options.onProgress?.('threads', ++t, plan.threads.threads.length);

    // A thread every participant of which was dropped has nothing to import.
    const live = thread.participants.filter((p) => !droppedPhones.has(p));
    if (live.length === 0) continue;

    const groupRow = groupRowByConversationId.get(thread.conversationId);
    const connectDayOne = groupRow !== undefined && wantsDayOneConnect(groupRow);
    if (connectDayOne) report.conversations.connectedDayOne += 1;

    if (!dryRun) {
      await upsertConversation(doc, conversationsTable, {
        conversationId: thread.conversationId,
        isGroup: thread.isGroup,
        participants: live.map((phone) => ({
          contactId: contactIdByPhone.get(phone) ?? '',
          phone,
        })),
        lastActivityAt: thread.lastActivityAt,
        createdAt: thread.firstActivityAt,
        importedAt,
        // A group with no pool number is `connecting`: full history and roster,
        // no Twilio number burned, no A2P cost. The founder connects the ones
        // she needs on demand (spec §3.6). `connect_day_one` is recorded as
        // intent here; provisioning is a separate, deliberate operator step.
        wantsConnect: connectDayOne,
      });
    }
    report.conversations.written += 1;
    if (thread.isGroup) report.conversations.groups += 1;

    for (const m of thread.messages) {
      const authorPhone = m.direction === 'incoming' ? normalizeFrom(m.from) : undefined;
      await messageBatch.put({
        conversationId: thread.conversationId,
        tsMsgId: tsMsgId(m.createdAt, m.id),
        type: 'sms',
        direction: m.direction === 'incoming' ? 'inbound' : 'outbound',
        author: m.direction === 'incoming' ? 'contact' : 'staff',
        body: m.body,
        provider_sid: m.id,
        provider_ts: m.createdAt,
        // Historical fact: it was sent and the conversation continued. We do not
        // have per-message delivery receipts in the export and will not invent
        // finer-grained status than the source supports.
        delivery_status: m.direction === 'incoming' ? 'received' : 'sent',
        created_at: m.createdAt,
        imported_from: IMPORT_SOURCE,
        imported_at: importedAt,
        ...(authorPhone && { imported_sender_phone: authorPhone }),
      });
      report.messages.written += 1;
    }

    for (const c of thread.calls) {
      await messageBatch.put({
        conversationId: thread.conversationId,
        tsMsgId: tsMsgId(c.createdAt, c.id),
        type: 'call',
        direction: c.direction === 'incoming' ? 'inbound' : 'outbound',
        author: c.direction === 'incoming' ? 'contact' : 'staff',
        provider_sid: c.id,
        provider_ts: c.createdAt,
        delivery_status: 'sent',
        created_at: c.createdAt,
        call_duration_seconds: c.durationSeconds,
        // Zero duration on an inbound call is a missed call, which is a
        // meaningful business event and the one call outcome the export supports.
        call_outcome: c.durationSeconds === 0 ? 'no_answer' : 'completed',
        imported_from: IMPORT_SOURCE,
        imported_at: importedAt,
      });
      report.calls.written += 1;
    }
  }
  await messageBatch.flush();

  if (ownNumbers.size > 1) {
    warnings.push(
      `Quo export lists ${ownNumbers.size} org numbers; threads were resolved against all of them.`,
    );
  }

  // ---------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------
  const unitsTable = table('units');
  for (const [, row] of review.units) {
    const address = (row.address ?? '').trim();
    if (!address) continue;
    if (isDropped(row)) {
      report.units.skippedDropped += 1;
      continue;
    }
    if (!dryRun) {
      await upsertUnit(doc, unitsTable, row, importedAt, contactIdByPhone, plan);
    }
    report.units.written += 1;
  }

  return report;
}

/**
 * Undo a previous import of one person, for a `drop` marked in a later review.
 *
 * SAFETY RULE: only items this importer created are removed, verified by the
 * `imported_from` stamp. If the contact, the thread, or any message in it shows
 * non-import activity — a real message that arrived after cutover, a record a
 * human created — nothing is deleted and the operator is told. Dropping a row in
 * a spreadsheet must never be able to destroy live conversation history.
 *
 * Group threads are never dismantled: their history belongs to the other members
 * too. The person is reported instead.
 */
async function retractImported(
  doc: DynamoDBDocumentClient,
  person: MergedPerson,
  warnings: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const contactsTable = tableName('contacts', env);
  const conversationsTable = tableName('conversations', env);
  const messagesTable = tableName('messages', env);

  const existing = await doc.send(
    new GetCommand({ TableName: contactsTable, Key: { contactId: person.contactId } }),
  );
  if (!existing.Item) return; // never imported, or already retracted

  if (existing.Item.imported_from !== IMPORT_SOURCE) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but its contact record was not created ` +
        `by the import — left untouched.`,
    );
    return;
  }

  const conversationId = conversationIdFor1to1(person.phone);
  const messages = await doc.send(
    new QueryCommand({
      TableName: messagesTable,
      KeyConditionExpression: 'conversationId = :c',
      ExpressionAttributeValues: { ':c': conversationId },
    }),
  );
  const items = messages.Items ?? [];
  const foreign = items.filter((m) => m.imported_from !== IMPORT_SOURCE);
  if (foreign.length > 0) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but their thread has ${foreign.length} ` +
        `message(s) this import did not create — the contact was removed, the thread was KEPT.`,
    );
  } else {
    for (const m of items) {
      await doc.send(
        new DeleteCommand({
          TableName: messagesTable,
          Key: { conversationId, tsMsgId: m.tsMsgId },
        }),
      );
    }
    const conv = await doc.send(
      new GetCommand({ TableName: conversationsTable, Key: { conversationId } }),
    );
    if (conv.Item?.imported_from === IMPORT_SOURCE) {
      await doc.send(
        new DeleteCommand({ TableName: conversationsTable, Key: { conversationId } }),
      );
    }
  }

  await doc.send(
    new DeleteCommand({ TableName: contactsTable, Key: { contactId: person.contactId } }),
  );
}

// ---------------------------------------------------------------------------
// Field resolution: the workbook wins over our suggestion, always.
// ---------------------------------------------------------------------------

interface ResolvedPerson {
  name: string;
  type: ContactType;
  voucherBeds?: number;
  status: string;
  notes?: string;
}

function resolvePerson(
  person: MergedPerson,
  row: CsvRow | undefined,
  warnings: string[],
): ResolvedPerson {
  const name = (row?.name ?? '').trim() || person.suggestedName;

  let type: ContactType = person.suggestedType;
  const rawType = (row?.type ?? '').trim().toLowerCase();
  if (rawType) {
    if (VALID_TYPES.has(rawType)) type = rawType as ContactType;
    else {
      warnings.push(
        `${person.rowKey}: type ${JSON.stringify(rawType)} is not one of ` +
          `${[...VALID_TYPES].join('/')} — kept our suggestion (${person.suggestedType}).`,
      );
    }
  }

  let voucherBeds = person.suggestedVoucherBeds;
  const rawBeds = (row?.voucher_beds ?? '').trim();
  if (rawBeds) {
    const n = Number.parseInt(rawBeds, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 9) voucherBeds = n;
    else {
      warnings.push(
        `${person.rowKey}: voucher_beds ${JSON.stringify(rawBeds)} is not a number 0-9 — ignored.`,
      );
    }
  }

  const status = (row?.status ?? '').trim() || person.suggestedStatus;
  const notes = (row?.notes ?? '').trim();

  return {
    name,
    type,
    ...(voucherBeds !== undefined && { voucherBeds }),
    status,
    ...(notes && { notes }),
  };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Upsert one contact, writing ONLY import-owned fields.
 *
 * Returns true when an existing status was PRESERVED because its provenance
 * outranks `import` — i.e. a human or the automation had already decided, and
 * the import deferred rather than reverting them.
 */
async function upsertContact(
  doc: DynamoDBDocumentClient,
  table: string,
  person: MergedPerson,
  resolved: ResolvedPerson,
  importedAt: string,
): Promise<boolean> {
  const existing = await doc.send(
    new GetCommand({ TableName: table, Key: { contactId: person.contactId } }),
  );
  const prior = existing.Item as { status_source?: string; status?: string } | undefined;

  // THE IMPORT OWNS A STATUS ONLY UNTIL SOMETHING ELSE TOUCHES IT.
  //
  // Note this deliberately does NOT consult SOURCE_PRECEDENCE. In this codebase
  // that rank is provenance/audit metadata only — `derived` is 0 and every
  // non-derived source (import, automation, ai, manual) is an equal 1, so
  // "outranks import" is never true and a precedence test would silently
  // preserve nothing. Gating is state-based instead (isTenantOverrideStatus).
  //
  // The rule that actually holds: re-write the status only when WE wrote the one
  // that is there. Any other provenance means a human or the automation has since
  // decided, and a re-run must defer to them. A stored status with no provenance
  // at all is also left alone — conservative, since we cannot tell who set it.
  const preserveStatus =
    prior !== undefined &&
    prior.status !== undefined &&
    prior.status_source !== IMPORT_STATUS_SOURCE;

  const sets: string[] = [
    '#type = :type',
    'phone = :phone',
    'phones = :phones',
    'created_at = if_not_exists(created_at, :createdAt)',
    'imported_from = :importSource',
    'imported_at = :importedAt',
    'quo_contact_ids = :quoIds',
  ];
  const values: Record<string, unknown> = {
    ':type': resolved.type,
    ':phone': person.phone,
    ':phones': [{ phone: person.phone, primary: true }],
    ':createdAt': importedAt,
    ':importSource': IMPORT_SOURCE,
    ':importedAt': importedAt,
    ':quoIds': person.quoContactIds,
  };
  const names: Record<string, string> = { '#type': 'type' };

  if (resolved.name) {
    sets.push('display_name = :name');
    values[':name'] = resolved.name;
  }
  if (resolved.voucherBeds !== undefined) {
    sets.push('voucherSize = :beds');
    values[':beds'] = resolved.voucherBeds;
  }
  if (resolved.notes) {
    sets.push('notes = :notes');
    values[':notes'] = resolved.notes;
  }
  if (!preserveStatus) {
    sets.push('#status = :status', 'status_source = :statusSource');
    names['#status'] = 'status';
    values[':status'] = resolved.status;
    values[':statusSource'] = 'import' satisfies TransitionSource;
  }
  if (person.optedOut) {
    // A STOP is a legal instruction, not a suggestion — it is set on every run
    // and never cleared by the import.
    sets.push('sms_opt_out = :true');
    values[':true'] = true;
  } else {
    // Consent basis is the existing two-way conversation (spec §3.7). Only
    // stamped where the person actually texted us first.
    if (person.traffic.inboundMessageCount > 0) {
      sets.push('consent_method = if_not_exists(consent_method, :consent)');
      values[':consent'] = 'import';
    }
  }

  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { contactId: person.contactId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
  return preserveStatus;
}

interface ConversationUpsert {
  conversationId: string;
  isGroup: boolean;
  participants: { contactId: string; phone: string }[];
  lastActivityAt: string;
  createdAt: string;
  importedAt: string;
  wantsConnect: boolean;
}

async function upsertConversation(
  doc: DynamoDBDocumentClient,
  table: string,
  input: ConversationUpsert,
): Promise<void> {
  const type = input.isGroup ? 'relay_group' : 'unknown_1to1';
  const status = input.isGroup ? 'connecting' : 'open';

  const sets: string[] = [
    '#type = if_not_exists(#type, :type)',
    '#status = if_not_exists(#status, :status)',
    'ai_mode = if_not_exists(ai_mode, :aiMode)',
    'created_at = if_not_exists(created_at, :createdAt)',
    'participants = :participants',
    'imported_from = :importSource',
    'imported_at = :importedAt',
    // Move last_activity_at FORWARD ONLY: a real message that arrived after the
    // import must not be rewound to the export's timestamp, or the thread jumps
    // backwards in the inbox.
    'last_activity_at = if_not_exists(last_activity_at, :lastActivity)',
  ];
  const names: Record<string, string> = { '#type': 'type', '#status': 'status' };
  const values: Record<string, unknown> = {
    ':type': type,
    ':status': status,
    ':aiMode': 'manual',
    ':createdAt': input.createdAt,
    ':participants': input.participants,
    ':lastActivity': input.lastActivityAt,
    ':importSource': IMPORT_SOURCE,
    ':importedAt': input.importedAt,
  };

  if (!input.isGroup) {
    const phone = input.participants[0]?.phone;
    if (phone) {
      sets.push('participant_phone = :participantPhone');
      values[':participantPhone'] = phone;
    }
  } else {
    sets.push('relay_status = if_not_exists(relay_status, :relayStatus)');
    values[':relayStatus'] = `relay_group#${status}`;
    if (input.wantsConnect) {
      // Recorded as INTENT only. Provisioning a pool number is a deliberate
      // operator action with real Twilio and A2P consequences, so the import
      // never buys a number as a side effect of a spreadsheet cell.
      sets.push('import_connect_requested = :true');
      values[':true'] = true;
    }
  }

  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { conversationId: input.conversationId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  // Second write: advance last_activity_at only when the export is NEWER than
  // what is stored. Expressed as a guarded update rather than folded above,
  // because DynamoDB has no "max()" in an update expression.
  await doc
    .send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId: input.conversationId },
        UpdateExpression: 'SET last_activity_at = :lastActivity',
        ConditionExpression:
          'attribute_not_exists(last_activity_at) OR last_activity_at < :lastActivity',
        ExpressionAttributeValues: { ':lastActivity': input.lastActivityAt },
      }),
    )
    .catch((err: unknown) => {
      // ConditionalCheckFailed is the EXPECTED outcome when stored is newer.
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
}

async function upsertUnit(
  doc: DynamoDBDocumentClient,
  table: string,
  row: CsvRow,
  importedAt: string,
  contactIdByPhone: ReadonlyMap<string, string>,
  plan: PlanResult,
): Promise<void> {
  const address = (row.address ?? '').trim();
  const unitId = unitIdForAddress(normalizeAddress(address));

  const sets: string[] = [
    'address = :address',
    '#status = if_not_exists(#status, :status)',
    'created_at = if_not_exists(created_at, :createdAt)',
    'imported_from = :importSource',
    'imported_at = :importedAt',
  ];
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = {
    ':address': address,
    ':status': mapUnitStatus(row.status ?? ''),
    ':createdAt': importedAt,
    ':importSource': IMPORT_SOURCE,
    ':importedAt': importedAt,
  };

  const beds = Number.parseInt((row.beds ?? '').replace(/\D/g, ''), 10);
  if (Number.isInteger(beds) && beds > 0) {
    sets.push('bedrooms = :beds');
    values[':beds'] = beds;
  }
  const baths = Number.parseFloat((row.baths ?? '').replace(/[^\d.]/g, ''));
  if (Number.isFinite(baths) && baths > 0) {
    sets.push('bathrooms = :baths');
    values[':baths'] = baths;
  }
  const jurisdiction = (row.housing_authority ?? '').trim();
  if (jurisdiction) {
    sets.push('jurisdiction = :jurisdiction');
    values[':jurisdiction'] = jurisdiction;
  }
  const notes = (row.notes ?? '').trim();
  if (notes) {
    sets.push('notes = :notes');
    values[':notes'] = notes;
  }

  // Resolve the landlord by name against the imported people, so the unit lands
  // on the byLandlord GSI when we can be confident. Ambiguous or unmatched names
  // are left unset rather than guessed — an incorrectly attributed property is
  // worse than an unattributed one.
  const landlordName = (row.landlord_name ?? '').trim();
  if (landlordName) {
    const matches = plan.merge.people.filter(
      (p) =>
        p.suggestedType === 'landlord' &&
        p.suggestedName.toLowerCase() === landlordName.toLowerCase() &&
        contactIdByPhone.has(p.phone),
    );
    if (matches.length === 1) {
      sets.push('landlordId = :landlordId');
      values[':landlordId'] = matches[0]!.contactId;
    }
    sets.push('imported_landlord_name = :landlordName');
    values[':landlordName'] = landlordName;
  }

  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { unitId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/** Airtable's "Available Status" vocabulary -> our LISTING_STATUSES. */
function mapUnitStatus(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === 'available') return 'available';
  if (v === 'placed') return 'occupied';
  if (v === 'coming soon') return 'setup';
  // Anything unrecognized (including empty) starts in `setup` — visible to the
  // operator, never publicly shareable.
  return 'setup';
}

function normalizeFrom(raw: string): string {
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Batched writer for the ~19.4k immutable message/call items.
// ---------------------------------------------------------------------------

/**
 * BatchWriteItem accumulator with UnprocessedItems retry.
 *
 * DynamoDB caps a batch at 25 items and may return some unprocessed under
 * throttling; retrying those with backoff is required for a 19,000-item run to
 * complete without silently losing rows.
 */
class BatchWriter {
  private buffer: Record<string, unknown>[] = [];

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly dryRun: boolean,
  ) {}

  async put(item: Record<string, unknown>): Promise<void> {
    if (this.dryRun) return;
    this.buffer.push(item);
    if (this.buffer.length >= 25) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.dryRun || this.buffer.length === 0) return;
    let requests = this.buffer.map((Item) => ({ PutRequest: { Item } }));
    this.buffer = [];

    for (let attempt = 0; attempt < 8 && requests.length > 0; attempt++) {
      const result = await this.doc.send(
        new BatchWriteCommand({ RequestItems: { [this.table]: requests } }),
      );
      const unprocessed = result.UnprocessedItems?.[this.table] ?? [];
      if (unprocessed.length === 0) return;
      requests = unprocessed as typeof requests;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
    if (requests.length > 0) {
      throw new Error(
        `BatchWrite to ${this.table} left ${requests.length} items unprocessed after retries. ` +
          `Re-run the import — it is idempotent, so completed items are simply rewritten.`,
      );
    }
  }
}

/** Re-export for the CLI so it can build the same PutCommand shape in tests. */
export { PutCommand };
