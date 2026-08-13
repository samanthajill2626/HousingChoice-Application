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
import { normalizeToE164 } from '../phone.js';
import type { TransitionSource } from '../statusModel.js';
import type { ContactType } from '../../repos/contactsRepo.js';
import { GROUP_TEXT_STATUS } from '../../repos/conversationsRepo.js';
import { groupMemberKey } from '../../services/groupMembers.js';
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

/**
 * The native group-text conversation type (group-texting spec section 4.2).
 *
 * A local literal, but one that cannot drift silently: the wire assertion in
 * importGroupGuards.test.ts pins the exact `:groupText` value the guarded
 * upsert binds, so changing this string fails that test.
 */
const GROUP_TEXT_TYPE = 'group_text';

/*
 * The byLastActivity partition native group threads live in is
 * conversationsRepo's GROUP_TEXT_STATUS, imported at the top of this file.
 *
 * It used to be a private local literal here, mirroring GROUP_TEXT_TYPE. That
 * was wrong: nothing compared the two, and `retractImported` uses the value as
 * a KeyConditionExpression binding. A drifted literal would query an empty
 * partition, find zero group rosters, and silently un-guard every contact
 * delete in an import run - the exact failure the guard exists to prevent. A
 * duplicate that cannot drift needs no alarm, so the duplicate is gone.
 */

/**
 * `contacts.origin` written by group-text detection when it mints a member stub
 * for a silent participant (group-texting spec section 5). Such a contact was
 * never import-owned and must survive a `drop`.
 */
const GROUP_DETECTION_ORIGIN = 'group_detection';

/**
 * `relay_sender_key` for a STAFF-authored message on a group thread - the same
 * `team` sentinel every live outbound group/relay send writes (`TEAM_SENDER_KEY`
 * in jobs/relayFanOut.ts, read by the dashboard's `senderLabel` as "Team").
 *
 * A LOCAL LITERAL ON PURPOSE, mirroring GROUP_TEXT_TYPE above: importing
 * jobs/relayFanOut.js would pull the messaging/media adapters and register job
 * handlers as a side effect of running the import CLI. It cannot drift silently
 * - importGroupAttribution.test.ts imports the real constant and pins it to this
 * value.
 */
const TEAM_SENDER_KEY = 'team';

/**
 * Attribution for one imported message (adversarial finding 1).
 *
 * The importer used to record an inbound author ONLY as `imported_sender_phone`,
 * a field with exactly one write and ZERO readers. Every multi-party surface in
 * this app - the group thread view, the relay view, both seed profiles - resolves
 * "who said this" from `relay_sender_key`, so all 132 migrated group transcripts
 * rendered with no sender at all on the one view whose entire purpose is telling
 * three people apart. Writing the key here (rather than teaching the dashboard a
 * second convention) keeps ONE attribution field in the data model and makes
 * imported history byte-identical in shape to live traffic:
 *   - inbound  -> `phone#<E164>`, exactly `groupMemberKey(normalizeToE164(From)
 *     ?? From)` as webhooks/twilio.ts writes it (spec 15.6: PHONE-scoped always,
 *     never relayMemberKey, or two numbers of one contact collapse into one slot)
 *   - outbound -> the `team` sentinel, as api.ts/groupSend write for a staff post
 *
 * GROUP THREADS ONLY. A 1:1 bubble has no multi-party attribution and must stay
 * byte-for-byte what it was; `relay_sender_key` on a 1:1 row would be a new,
 * unread field at best and a stray "Team" chip at worst.
 */
function importedGroupSenderKey(
  isGroup: boolean,
  direction: 'incoming' | 'outgoing',
  from: string,
): string | undefined {
  if (!isGroup) return undefined;
  if (direction !== 'incoming') return TEAM_SENDER_KEY;
  // ACCEPTED PARITY BEHAVIOUR, recorded so it is not re-found (adversarial
  // finding 36). An un-normalizable `from` ("Anonymous", a short code) falls
  // back to the raw string, so this stores a key like `phone#Anonymous` for a
  // message whose sender `counterpartiesOf` already dropped from the roster
  // (quoSource.ts) while `buildThreadIndex` still files the message
  // (threads.ts). `senderLabel` finds no roster match and returns undefined, so
  // the bubble renders EXACTLY as it did before this field existed - and LIVE
  // does the identical thing, because webhooks/twilio.ts writes the same
  // `groupMemberKey(normalizeToE164(From) ?? From)`. Byte parity with live is
  // the contract here; inventing a different fallback would break it.
  return groupMemberKey(normalizeToE164(from) ?? from);
}

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
  conversations: {
    written: number;
    groups: number;
    connectedDayOne: number;
    /** Groups the founder marked drop=Y - thread AND messages skipped. */
    droppedGroups: number;
    /**
     * Members marked drop=Y who were KEPT on a group roster. A group thread's
     * conversationId is derived from its full member set, so truncating the
     * roster would leave a row that cannot describe its own thread; the drop is
     * reported here (and in `warnings`) instead of applied.
     */
    groupRosterDropsKept: number;
  };
  messages: { written: number };
  calls: { written: number };
  units: { written: number; skippedDropped: number };
  warnings: string[];
}

/**
 * Group threads keyed by conversationId -> their reviewed workbook row.
 *
 * The workbook's groups tab is keyed by POSITION (`GRP-0001` is the first group
 * thread the plan produced), so this ordering is the join and both the apply and
 * the group-conversion runner must derive it identically - hence one exported
 * function rather than two copies of the same forEach.
 */
export function groupReviewRowsByConversationId(
  plan: PlanResult,
  reviewGroups: Map<string, CsvRow>,
): Map<string, CsvRow> {
  const byConversationId = new Map<string, CsvRow>();
  plan.threads.threads
    .filter((t) => t.isGroup)
    .forEach((t, idx) => {
      const row = reviewGroups.get(`GRP-${String(idx + 1).padStart(4, '0')}`);
      if (row) byConversationId.set(t.conversationId, row);
    });
  return byConversationId;
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
    conversations: {
      written: 0,
      groups: 0,
      connectedDayOne: 0,
      droppedGroups: 0,
      groupRosterDropsKept: 0,
    },
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
  /**
   * Every contactId a native group_text roster references, read ONCE per run and
   * only when a retract is actually about to happen (see the drop branch below).
   */
  let groupRosterIds: Set<string> | undefined;

  const people = plan.merge.people;
  /** Free-field authority values written verbatim (no canonical spelling). */
  const authorityPassthroughs = new Map<string, number>();
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
      // Built LAZILY and exactly once: a run with no drops must not pay a
      // partition walk, and a dry run never reads it at all (it never deletes).
      if (!dryRun) {
        groupRosterIds ??= await groupTextRosterContactIds(doc, table('conversations'));
        await retractImported(doc, person, warnings, env, groupRosterIds, importedAt);
      }
      continue;
    }

    const resolved = resolvePerson(person, row, warnings);
    contactIdByPhone.set(person.phone, person.contactId);
    if (dryRun) {
      report.contacts.written += 1;
      continue;
    }

    if (resolved.housingAuthority && !KNOWN_AUTHORITIES.has(resolved.housingAuthority)) {
      authorityPassthroughs.set(
        resolved.housingAuthority,
        (authorityPassthroughs.get(resolved.housingAuthority) ?? 0) + 1,
      );
    }

    const preserved = await upsertContact(doc, contactsTable, person, resolved, importedAt);
    if (preserved) report.contacts.statusPreserved += 1;
    report.contacts.written += 1;
  }

  // Free-field posture (2026-08-09): unknown authority spellings are WRITTEN,
  // not dropped - but say so once per distinct value, because each new spelling
  // is its own broadcast audience and a typo here quietly splits one.
  for (const [value, n] of authorityPassthroughs) {
    warnings.push(
      `housingAuthority ${JSON.stringify(value)} (x${n}) has no canonical spelling - written ` +
        `verbatim. Fine if intentional; a variant spelling of an existing authority would ` +
        `split the broadcast audience.`,
    );
  }

  // ---------------------------------------------------------------------
  // Conversations, messages and calls
  // ---------------------------------------------------------------------
  const conversationsTable = table('conversations');
  const messagesTable = table('messages');
  const ownNumbers = plan.quo.ownNumbers;

  const groupRowByConversationId = groupReviewRowsByConversationId(plan, review.groups);

  const messageBatch = new BatchWriter(doc, messagesTable, dryRun);

  let t = 0;
  for (const thread of plan.threads.threads) {
    options.onProgress?.('threads', ++t, plan.threads.threads.length);

    // A thread every participant of which was dropped has nothing to import.
    const live = thread.participants.filter((p) => !droppedPhones.has(p));
    if (live.length === 0) continue;

    const groupRow = groupRowByConversationId.get(thread.conversationId);

    // Founder-excluded group: the whole thread stays out - conversation,
    // messages and calls. Counted, never silent.
    if (groupRow !== undefined && isDropped(groupRow)) {
      report.conversations.droppedGroups += 1;
      continue;
    }

    const connectDayOne = groupRow !== undefined && wantsDayOneConnect(groupRow);
    if (connectDayOne) report.conversations.connectedDayOne += 1;

    // A GROUP ROSTER IS NEVER TRUNCATED BY A WORKBOOK `drop`.
    //
    // A group thread's IDENTITY IS ITS FULL SORTED ROSTER (the conversationId is
    // uuidv5 over it - lib/import/ids.ts), so writing a roster with a member
    // filtered out produces a row that cannot describe its own thread: the
    // conversion refuses it (`roster_id_mismatch`), the runtime inline
    // auto-convert refuses it through the same precondition, and every inbound
    // to that carrier group then scatters into individual 1:1s. This line was
    // the ONE known producer of that state.
    //
    // It also contradicts the policy this same file already enforces for the
    // same decision: `retractImported` refuses to delete a dropped contact who
    // sits on a group roster, because "deleting it would orphan their member
    // chips and delivery records in a conversation that belongs to the other
    // members too". A `drop` is a statement about a CONTACT RECORD, and post
    // conversion it is already inert for group members (adjudication A27). So
    // the roster keeps them, and the drop is REPORTED rather than applied - the
    // founder sees the adjudication instead of a wall of refusals on cutover
    // day. 1:1 threads keep today's semantics exactly.
    const droppedOnGroupRoster = thread.isGroup
      ? thread.participants.filter((p) => droppedPhones.has(p))
      : [];
    if (droppedOnGroupRoster.length > 0) {
      report.conversations.groupRosterDropsKept += droppedOnGroupRoster.length;
      warnings.push(
        `${thread.conversationId}: ${droppedOnGroupRoster.length} member(s) marked drop are on a ` +
          `GROUP roster - they were KEPT ON THE GROUP ROSTER. A group thread's identity IS its ` +
          `full member set, so removing one would leave a roster that cannot describe its own ` +
          `thread. The contact records are handled by the drop rules as usual; drop the whole ` +
          `group row to remove the thread itself.`,
      );
    }
    const roster = thread.isGroup ? thread.participants : live;

    if (!dryRun) {
      await upsertConversation(doc, conversationsTable, {
        conversationId: thread.conversationId,
        isGroup: thread.isGroup,
        participants: roster.map((phone) => ({
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
      const senderKey = importedGroupSenderKey(thread.isGroup, m.direction, m.from);
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
        // The READ field (see importedGroupSenderKey). `imported_sender_phone`
        // stays beside it as import PROVENANCE - it is the raw `from` the export
        // carried, unnormalized, which is worth keeping for a later forensic
        // question that the derived key can no longer answer.
        ...(senderKey !== undefined && { relay_sender_key: senderKey }),
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
 * The founder's Airtable "voucher program" spellings -> ONE canonical spelling
 * each. FREE FIELD, not a closed vocabulary (Cameron, 2026-08-09): the field is
 * a flexible document attribute and nothing requires membership in the AI
 * extractor's list. What DOES matter is spelling CONSISTENCY - broadcast
 * audience resolution does an exact hash match on the byHousingAuthority GSI, so
 * "Dekalb Housing" and "Dekalb County Housing" would be two audiences invisible
 * to each other. Known variants therefore normalize to one spelling (aligned
 * with `HOUSING_AUTHORITY_VOCAB` where an entry exists, so AI-extracted and
 * imported values agree); UNKNOWN values pass through verbatim rather than being
 * dropped.
 *
 * The full 2026-08-09 tenants table (666 rows) is where most of these spellings
 * come from - e.g. "Atlanta, aha, Atlanta housing" x450. Note the founder's
 * taxonomy (email 2026-08-09): agencies/non-profits (HUD VASH, Hope Atlanta,
 * Claratel, Step Up) are DIFFERENT things from housing authorities (AHA, JHA,
 * DCA, ...) and one person can hold both. The single field cannot represent
 * the pair; that model gap is docs/issues/housing-authority-free-text-drift.md,
 * not this importer's to solve.
 */
const CANONICAL_AUTHORITY: Readonly<Record<string, string>> = {
  'atlanta, aha, atlanta housing': 'Atlanta (AHA)',
  'atlanta housing': 'Atlanta (AHA)',
  'jonesboro, jha, jonesboro housing': 'Jonesboro (JHA)',
  'jonesboro housing': 'Jonesboro (JHA)',
  'dekalb county housing': 'Dekalb County Housing',
  'dekalb housing': 'Dekalb County Housing',
  'georgia housing voucher, ghv': 'Georgia Housing Voucher (GHV)',
  'georgia housing voucher (ghv)': 'Georgia Housing Voucher (GHV)',
  ghv: 'Georgia Housing Voucher (GHV)',
  'dca, department of community affairs': 'DCA',
  dca: 'DCA',
  'fulton, fulton county': 'Fulton County',
  'fulton county': 'Fulton County',
  clayton: 'Clayton County',
  'clayton county': 'Clayton County',
  'eastpoint housing authority': 'East Point',
  'east point': 'East Point',
  'mcdonough housing authority': 'McDonough',
  mcdonough: 'McDonough',
  'hud vash': 'HUD VASH',
  claratel: 'Claratel',
  'hope atlanta': 'Hope Atlanta',
  'step up': 'Step Up',
};

/** The canonical spellings this importer emits (for the passthrough report). */
export const KNOWN_AUTHORITIES: ReadonlySet<string> = new Set(
  Object.values(CANONICAL_AUTHORITY),
);

/**
 * Normalize an Airtable program value: canonical spelling when known, verbatim
 * (whitespace-collapsed) when not, undefined only when empty.
 */
export function housingAuthorityFor(rawProgram: string | undefined): string | undefined {
  if (!rawProgram) return undefined;
  const cleaned = rawProgram.trim().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  return CANONICAL_AUTHORITY[cleaned.toLowerCase()] ?? cleaned;
}

/** Honorifics that must not become someone's first name (spelt with or without a dot). */
const HONORIFIC_RE = /^(mr|mrs|ms|miss|dr|rev|pastor|sir|madam)\.?$/i;

/**
 * Split a founder-reviewed name into the `firstName` / `lastName` the app reads.
 *
 * Two consumers, and they want different things from the same split:
 *   - DISPLAY (`contactDisplayName` in the dashboard, `displayNameOf` in the API)
 *     re-joins both parts, so any split renders identically. Display cannot be
 *     got wrong here.
 *   - BROADCASTS (`lib/mergeFields.ts` renderBody) substitute `[TenantName]` with
 *     **firstName ALONE**. That is what makes the split consequential: a wrong
 *     first token greets a real tenant badly in a real text message.
 *
 * So the rule is first-token-is-the-first-name, EXCEPT when that token is an
 * honorific. "Ms. Cooper" split naively greets her "Hi Ms." — keeping the
 * honorific attached to the following token yields firstName "Ms. Cooper",
 * which renders the same and greets her "Hi Ms. Cooper". Ten of the founder's
 * 478 named tenants are titled this way.
 */
export function splitReviewedName(raw: string): { firstName: string; lastName: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  // Honorific + at least one more token: keep them together as the first name.
  if (tokens.length > 1 && HONORIFIC_RE.test(tokens[0]!)) {
    return { firstName: `${tokens[0]} ${tokens[1]}`, lastName: tokens.slice(2).join(' ') };
  }
  return { firstName: tokens[0]!, lastName: tokens.slice(1).join(' ') };
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
 *
 * NATIVE GROUP TEXTS (group-texting spec section 9). A contact referenced by a
 * group_text roster is NOT deletable: every member chip, delivery slot and
 * suppression record in those threads keys on the contactId, so removing it
 * would orphan history that belongs to the other members. Three layers, in
 * order of how early they can answer:
 *   1. the detection origin marker (the contact was never import-owned),
 *   2. the roster set walked once per run (covers every member, imported or not),
 *   3. an ATOMIC ConditionExpression evaluated at DynamoDB
 *      (`attribute_not_exists(group_participation_at)`), which is what closes
 *      the read-then-delete race against live detection.
 * Every refusal is reported, never thrown.
 *
 * DESTRUCTION ORDER: MESSAGES -> THREAD -> CONTACT. DO NOT RE-INVERT IT.
 * (adversarial finding 7 = conformance F7.) Deleting the contact first makes the
 * REFUSAL path tidy but the FAILURE path unrecoverable: a throttle, 5xx or crash
 * on the message Query below - after the contact row is already gone - leaves the
 * 1:1 conversation and every message in it orphaned, and the next run's contact
 * GetCommand finds nothing, returns early, and never sees that residue again.
 * The contact row is the ONLY thing that makes an unfinished retract findable, so
 * it is destroyed LAST and every intermediate failure stays idempotently
 * retryable. The refusal is still atomic and still evaluated FIRST, because
 * layer 3 is a CONDITIONAL MARKER WRITE (below) rather than the delete itself -
 * it destroys nothing when it loses, and the delete keeps the same condition as
 * defence in depth.
 */
async function retractImported(
  doc: DynamoDBDocumentClient,
  person: MergedPerson,
  warnings: string[],
  env: NodeJS.ProcessEnv,
  groupRosterContactIds: ReadonlySet<string>,
  importedAt: string,
): Promise<void> {
  const contactsTable = tableName('contacts', env);
  const conversationsTable = tableName('conversations', env);
  const messagesTable = tableName('messages', env);

  const existing = await doc.send(
    new GetCommand({ TableName: contactsTable, Key: { contactId: person.contactId } }),
  );
  if (!existing.Item) return; // never imported, or already retracted

  // Checked BEFORE the import-provenance rule so the operator is told the real
  // reason: a detection stub also fails that rule, but "we did not create it"
  // hides the fact that this person is in a live group conversation.
  if (existing.Item.origin === GROUP_DETECTION_ORIGIN) {
    // ATTRIBUTION, CORRECTED (adversarial finding 37). This used to say "created
    // by group text detection, NOT by the import" - which is false for the
    // commonest producer of this exact row: `import:convert-groups` RE-MINTS a
    // dropped group member as a group-scoped stub carrying this same origin, so
    // the import's own cutover step wrote it. The refusal is right either way
    // (the row is now a live group member's contact); what it may not do is send
    // the operator looking for a detection event that never happened. Say the
    // consequence instead, because it is the part that is surprising: from here
    // on, this drop can never be applied to this person again.
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but their contact record is a ` +
        `group-scoped stub (origin group_detection - minted by group text detection or by this ` +
        `import's own convert-groups step when the drop removed a group member) - left untouched ` +
        `(GROUP MEMBER). This drop is PERMANENTLY INOPERATIVE for them: every future run stops ` +
        `here. Contact soft-delete in the app is the remaining lever.`,
    );
    return;
  }

  if (existing.Item.imported_from !== IMPORT_SOURCE) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but its contact record was not created ` +
        `by the import — left untouched.`,
    );
    return;
  }

  if (groupRosterContactIds.has(person.contactId)) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but they are on a native group text ` +
        `roster - the contact was KEPT (GROUP MEMBER). Deleting it would orphan their member ` +
        `chips and delivery records in a conversation that belongs to the other members too.`,
    );
    return;
  }

  // THE MARKER'S READER (conformance F6 / adversarial finding 35). The field
  // used to be a write with zero readers - the exact defect class this same
  // change indicted `imported_sender_phone` for - while its own comment
  // promised that "a contact carrying `import_retract_started_at` and still
  // having a thread is exactly a retract that died halfway". This is that
  // check: the run that finds one says so and RESUMES it, rather than leaving
  // the operator to discover a half-destroyed person by accident. (Resuming is
  // what the code below already does; what was missing was saying it.)
  //
  // READ HERE, REPORTED BELOW (fix wave 4, item 6). The sentence used to be
  // pushed at this point, which is BEFORE the guarded write that can refuse the
  // whole retract - so a person who had joined a native group text got a report
  // saying "RESUMING it now, their imported thread and messages are being
  // removed again" immediately followed by "the contact was KEPT (GROUP
  // MEMBER)": two contradictory sentences about one person, the first of them
  // false, in the document the founder reads to decide whether the import went
  // right. It is exactly the rule this same commit states thirty lines below -
  // record the outcome, state it once, when it is a fact.
  const startedEarlier =
    typeof existing.Item.import_retract_started_at === 'string'
      ? existing.Item.import_retract_started_at
      : undefined;

  // ATOMIC GUARD, FIRST AND NON-DESTRUCTIVE. The roster set above was read before
  // this loop started, so a group thread created since then would slip past it;
  // this condition is evaluated by DynamoDB and cannot be raced. It is a MARKER
  // WRITE rather than the contact delete so the refusal still happens before
  // anything is destroyed WITHOUT making the contact the first casualty (see the
  // ordering rationale in the doc comment).
  //
  // `attribute_exists(contactId)` IS LOAD-BEARING (adversarial finding 14).
  // DynamoDB's UpdateItem CREATES an absent item, and `attribute_not_exists`
  // alone is satisfied by one - so with two overlapping runs (the RUNBOOK says
  // re-running is safe and expected) A could hard-delete this contact between
  // our GetCommand above and this write, and B would MINT a phantom carrying
  // nothing but `{contactId, import_retract_started_at}`. With no phone, type
  // or status it sits on neither GSI, and every future run's `imported_from`
  // check refuses to touch it: permanent residue that no run can ever see.
  try {
    await doc.send(
      new UpdateCommand({
        TableName: contactsTable,
        Key: { contactId: person.contactId },
        UpdateExpression: 'SET import_retract_started_at = :retractAt',
        ConditionExpression:
          'attribute_exists(contactId) AND attribute_not_exists(group_participation_at)',
        ExpressionAttributeValues: { ':retractAt': importedAt },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // TWO CAUSES NOW, and they are different events: the row is GONE (another
    // run finished this retract first - nothing to report, and nothing to warn
    // about) or it is still there carrying a group stamp. Re-read rather than
    // asserting the one that used to be the only possibility.
    const current = await doc.send(
      new GetCommand({ TableName: contactsTable, Key: { contactId: person.contactId } }),
    );
    if (current.Item !== undefined) {
      warnings.push(
        `${person.rowKey} (${person.phone}) is marked drop but they joined a native group text ` +
          `while this import was running - the contact was KEPT (GROUP MEMBER) and their thread ` +
          `was left untouched.`,
      );
    }
    return;
  }

  // THE GUARD HELD, so the resume is now a fact rather than a prediction.
  if (startedEarlier !== undefined) {
    warnings.push(
      `${person.rowKey} (${person.phone}) carries an import retract that did NOT finish ` +
        `(started ${startedEarlier}) - RESUMING it now. Their imported thread and messages are ` +
        `being removed again; anything this import did not create is still kept.`,
    );
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
  // WARNINGS ARE WRITTEN AFTER THE FACT, NEVER BEFORE IT (adversarial finding
  // 25). The contact delete now happens ~30 lines below this point and can
  // REFUSE, so a sentence written here about what happened to the contact is a
  // PREDICTION - and the reorder made two of them predictions that can be
  // false. Record the outcomes; state them once, at the bottom, when they are
  // facts.
  let threadRemoved = false;
  if (foreign.length > 0) {
    // nothing destroyed on this path - see the summary at the end.
  } else {
    threadRemoved = true;
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

  // LAST. Everything above is re-derivable from the export on a re-run; the
  // contact row is what tells the NEXT run there is still a retract to finish,
  // so it goes only once the rest is gone. It keeps the same atomic condition:
  // a stamp that lands inside this narrow window still refuses, and the residue
  // it leaves (a contact with no thread) is visible and re-runnable, unlike the
  // orphan the old ordering produced.
  let contactRemoved = true;
  try {
    await doc.send(
      new DeleteCommand({
        TableName: contactsTable,
        Key: { contactId: person.contactId },
        ConditionExpression: 'attribute_not_exists(group_participation_at)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    contactRemoved = false;
  }

  if (!contactRemoved) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but they joined a native group text ` +
        `while their retract was running - the contact was KEPT (GROUP MEMBER). ` +
        (threadRemoved
          ? `Their imported 1:1 thread was already removed; nothing that belongs to the group was ` +
            `touched.`
          : `Their imported 1:1 thread was KEPT as well - it holds ${foreign.length} message(s) ` +
            `this import did not create. Nothing that belongs to the group was touched.`),
    );
    // AND THE MARKER GOES (adversarial finding 35). It is residue that means
    // "a retract is in progress", and this retract is over: the person is a
    // live group member now, so leaving it stamped on their contact forever
    // would make every future run report a half-finished retract that is not
    // one. Conditional so it cannot mint the phantom finding 14 is about.
    try {
      await doc.send(
        new UpdateCommand({
          TableName: contactsTable,
          Key: { contactId: person.contactId },
          UpdateExpression: 'REMOVE import_retract_started_at',
          ConditionExpression: 'attribute_exists(contactId)',
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  } else if (foreign.length > 0) {
    warnings.push(
      `${person.rowKey} (${person.phone}) is marked drop but their thread has ${foreign.length} ` +
        `message(s) this import did not create - the thread was KEPT and the contact WAS removed.`,
    );
  }
}

/**
 * Every contactId referenced by a native group_text roster, from ONE full
 * pagination pass of the `group_open` byLastActivity partition.
 *
 * Read once per run and consulted per drop candidate: the alternative (a query
 * per candidate) would be hundreds of queries for the same answer. A failure
 * here is LOUD - an empty result is indistinguishable from "no group threads
 * exist", and treating a read error as empty would silently un-guard every
 * delete this run performs.
 */
async function groupTextRosterContactIds(
  doc: DynamoDBDocumentClient,
  conversationsTable: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: conversationsTable,
        IndexName: 'byLastActivity',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status', '#p': 'participants' },
        ExpressionAttributeValues: { ':status': GROUP_TEXT_STATUS },
        ProjectionExpression: '#p',
        ...(startKey !== undefined && { ExclusiveStartKey: startKey }),
      }),
    );
    for (const item of page.Items ?? []) {
      const members = (item.participants ?? []) as { contactId?: unknown }[];
      for (const member of members) {
        if (typeof member.contactId === 'string' && member.contactId.length > 0) {
          ids.add(member.contactId);
        }
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return ids;
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
  /** Exact HOUSING_AUTHORITY_VOCAB string, when her Airtable program maps to one. */
  housingAuthority?: string;
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

  const housingAuthority = housingAuthorityFor(person.airtableTenant?.voucherProgram);

  return {
    name,
    type,
    ...(voucherBeds !== undefined && { voucherBeds }),
    status,
    ...(notes && { notes }),
    ...(housingAuthority !== undefined && { housingAuthority }),
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
    // WRITE THE FIELDS THE APP ACTUALLY READS: firstName + lastName.
    //
    // An earlier version wrote a single `display_name`, which nothing in the
    // codebase reads — `routes/contacts.ts` displayNameOf() joins firstName and
    // lastName and returns null when both are absent, and a null name renders as
    // the phone number ("a name is NEVER invented"). So every imported contact
    // would have shown as a bare phone number, silently discarding all 539
    // resolved names — including the ~117 the founder reviews by hand. The whole
    // review would have evaporated at the last step.
    //
    // Split on the first token, matching lib/contactName.ts's own convention
    // (tokens[0] is the first name, the remainder joins as the last name, so
    // multi-word and hyphenated surnames survive). A single-token name — 122 of
    // hers are first-name-only — yields an empty lastName, which displayNameOf
    // filters out before joining, rendering just "Angela".
    const { firstName, lastName } = splitReviewedName(resolved.name);
    sets.push('firstName = :firstName', 'lastName = :lastName');
    values[':firstName'] = firstName;
    values[':lastName'] = lastName;
  }
  if (resolved.voucherBeds !== undefined) {
    sets.push('voucherSize = :beds');
    values[':beds'] = resolved.voucherBeds;
  }
  if (resolved.notes) {
    sets.push('notes = :notes');
    values[':notes'] = resolved.notes;
  }
  // Contact-side housing authority (the byHousingAuthority GSI that broadcast
  // audience resolution queries). Without it an imported tenant can never be
  // reached by an authority-filtered broadcast - see the
  // housing-authority-free-text-drift issue, consequence 4.
  if (resolved.housingAuthority) {
    sets.push('housingAuthority = :housingAuthority');
    values[':housingAuthority'] = resolved.housingAuthority;
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

/**
 * Drop `#name` / `:value` bindings the expression no longer references.
 *
 * DynamoDB rejects the WHOLE request when ExpressionAttributeValues (or Names)
 * carries an unused entry, so a reduced expression that keeps its original
 * bindings is a ValidationException rather than a smaller write.
 */
function pruneBindings<T>(expression: string, bindings: Record<string, T>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(bindings)) {
    // Word boundary so `:import` cannot be mistaken for a reference by
    // `:importSource` (and vice versa).
    if (new RegExp(`${key}\\b`).test(expression)) kept[key] = value;
  }
  return kept;
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

  /**
   * Group-path SET clauses that must NEVER be re-applied to a row that has
   * already become a native `group_text` thread (group-texting spec section 9).
   * Kept as the literal clause strings so this list and the expression it
   * filters cannot drift apart.
   */
  const groupUnsafeClauses = new Set<string>();

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
      groupUnsafeClauses.add('import_connect_requested = :true');
    }
    // `participants` would re-key the roster detection/conversion filled in
    // (imported entries carry `contactId: ''`), breaking every member chip.
    groupUnsafeClauses.add('participants = :participants');
    // Stamping these would make a live thread look import-owned, exposing it to
    // the retract paths below.
    groupUnsafeClauses.add('imported_from = :importSource');
    groupUnsafeClauses.add('imported_at = :importedAt');
    // THE SUBTLE ONE: `relay_status = if_not_exists(...)` is NOT self-protecting
    // on a group_text row. A group_text thread deliberately carries NO
    // relay_status (spec 4.2), so `if_not_exists` finds nothing to protect and
    // SEEDS `relay_group#connecting` - which writes the thread into the sparse
    // byRelayStatus GSI and makes it show up in listRelayGroups('connecting'),
    // i.e. as a relay group in the inbox. The other if_not_exists clauses
    // (type/status/ai_mode/created_at/last_activity_at) really are safe: a
    // converted row has all of them.
    groupUnsafeClauses.add('relay_status = if_not_exists(relay_status, :relayStatus)');
  }

  const fullExpression = `SET ${sets.join(', ')}`;

  if (!input.isGroup) {
    // Unchanged: a 1:1 id is derived from a single counterparty phone and can
    // never collide with a group id, so there is nothing here to guard against.
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { conversationId: input.conversationId },
        UpdateExpression: fullExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } else {
    // CONDITIONAL WRITE, not read-then-write: a Get-then-Update would race live
    // detection during the import's own supported re-run-under-traffic scenario
    // (the re-run exists precisely for the window when real traffic is landing).
    values[':groupText'] = GROUP_TEXT_TYPE;
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: input.conversationId },
          UpdateExpression: fullExpression,
          ConditionExpression: 'attribute_not_exists(#type) OR #type <> :groupText',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // The row IS a native group thread. Re-import only what a converted or
      // detected thread can absorb without losing anything it owns.
      const reducedExpression = `SET ${sets.filter((s) => !groupUnsafeClauses.has(s)).join(', ')}`;
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { conversationId: input.conversationId },
          UpdateExpression: reducedExpression,
          ExpressionAttributeNames: pruneBindings(reducedExpression, names),
          ExpressionAttributeValues: pruneBindings(reducedExpression, values),
        }),
      );
    }
  }

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
  // The unit's accepted authorities (spec section 8): ONE list field, canonically
  // spelled through the SAME normalizer the contact side uses. The workbook cell
  // is the founder's authority-named "Voucher Type", so a raw write would spell
  // one authority two ways ("Atlanta Housing" here, "Atlanta (AHA)" on her
  // tenants) and split it into two chips in the properties facet. The retired
  // `jurisdiction` string is not written; legacy rows are synthesized at read
  // time (authoritiesOf).
  const authority = housingAuthorityFor(row.housing_authority);
  if (authority !== undefined) {
    sets.push('accepted_authorities = :acceptedAuthorities');
    values[':acceptedAuthorities'] = [authority];
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
