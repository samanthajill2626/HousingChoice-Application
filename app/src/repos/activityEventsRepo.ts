// activity-events repo (BE2/C2) — the person-centric milestone log.
//
// Each row records ONE milestone for a contact (a placement opened/closed, a stage
// change, a property sent, a number added, group-text membership, …). The
// contact-timeline endpoint (GET /api/contacts/:id/timeline) MERGES these with
// the contact's messages/calls into one chronological feed; the milestone is a
// link-out marker (refType/refId) — it never inlines content.
//
// SK shape: `<ISO at>#<eventId>` — mirroring the messages repo's
// `<ISO ts>#<msgId>` so a Query is naturally chronological and pages backward
// with a `tsEventId < :before` exclusive bound (newest-first). `eventId` is a
// fresh random UUID per record, so no append is ever a redelivery — there is no
// conditional/idempotency dance here (unlike messages, where the provider SID
// is the dedupe key); a Put suffices.
//
// Items stay flexible documents; only the two key attrs (contactId, tsEventId)
// are contractual (lib/tables.ts).
//
// PII (doc §9): NEVER log the label (it can carry a name/tag) — IDs/type only.
import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * The milestone/activity types (C2 `TimelineMilestoneType`, VERBATIM — the
 * frontend imports the identical union). `listing_reviewed` is part of the
 * contract but emitted by a LATER slice (BE4); the type is included here so the
 * timeline can render it once that lands. Do NOT rename any member.
 */
export type ActivityEventType =
  | 'placement_opened'
  | 'placement_closed'
  | 'listing_sent'
  | 'listing_reviewed'
  | 'tour_scheduled'
  | 'tour_took_place'
  | 'stage_changed'
  | 'number_added'
  | 'added_to_group_text'
  | 'removed_from_group_text';

/** What a milestone can deep-link out to (C2 `TimelineMilestone.refType`). */
export type ActivityEventRefType = 'placement' | 'unit' | 'conversation' | 'broadcast' | 'tour';

/** One stored activity event. Flexible document — these are the read fields. */
export interface ActivityEventItem {
  /** PK — the contact this milestone belongs to. */
  contactId: string;
  /** SK — `<ISO at>#<eventId>` (chronological, paginates backward). */
  tsEventId: string;
  /** The opaque event id (`evt-<uuid>`); also the C2 TimelineMilestone.id. */
  eventId: string;
  /** ISO 8601 — when the milestone happened (the timeline sort key). */
  at: string;
  type: ActivityEventType;
  /** Human text, e.g. "Tour took place · Toured". May carry a name — never logged. */
  label: string;
  /** Deep-link target type (link-out only; never inline content). */
  refType?: ActivityEventRefType;
  refId?: string;
  /** ISO 8601 — when the row was written (audit furniture). */
  created_at: string;
  [key: string]: unknown;
}

/** record() input — `at` defaults to now; ids are repo-generated. */
export interface RecordActivityEventInput {
  contactId: string;
  type: ActivityEventType;
  label: string;
  refType?: ActivityEventRefType;
  refId?: string;
  /** ISO 8601 override (defaults to now). */
  at?: string;
}

export interface ListByContactOptions {
  limit?: number;
  /** Exclusive upper bound on tsEventId — pass the oldest seen key to page back. */
  before?: string;
}

export interface ActivityEventsRepo {
  /** Append one milestone for a contact; returns the stored item. */
  record(input: RecordActivityEventInput): Promise<ActivityEventItem>;
  /** Newest-first page of a contact's milestone log. */
  listByContact(
    contactId: string,
    opts?: ListByContactOptions,
  ): Promise<{ items: ActivityEventItem[] }>;
}

const DEFAULT_PAGE_LIMIT = 50;

/** Deterministic SK builder (mirrors messages' buildTsMsgId). */
export function buildTsEventId(at: string, eventId: string): string {
  return `${at}#${eventId}`;
}

export function createActivityEventsRepo(deps: RepoDeps = {}): ActivityEventsRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('activity_events', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async record(input) {
      const at = input.at ?? new Date().toISOString();
      const eventId = `evt-${randomUUID()}`;
      const tsEventId = buildTsEventId(at, eventId);
      const item: ActivityEventItem = {
        contactId: input.contactId,
        tsEventId,
        eventId,
        at,
        type: input.type,
        label: input.label,
        created_at: new Date().toISOString(),
        ...(input.refType !== undefined && { refType: input.refType }),
        ...(input.refId !== undefined && { refId: input.refId }),
      };
      // Fresh random eventId → the SK is unique; no conditional needed.
      await doc.send(new PutCommand({ TableName: table, Item: item }));
      // PII (doc §9): log the FACT + type/refs, never the label.
      log.info(
        { contactId: input.contactId, type: input.type, refType: input.refType, refId: input.refId },
        'activity event recorded',
      );
      return item;
    },

    async listByContact(contactId, opts = {}) {
      const { Items } = await doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: opts.before
            ? 'contactId = :c AND tsEventId < :before'
            : 'contactId = :c',
          ExpressionAttributeValues: {
            ':c': contactId,
            ...(opts.before && { ':before': opts.before }),
          },
          ScanIndexForward: false, // newest-first
          Limit: opts.limit ?? DEFAULT_PAGE_LIMIT,
        }),
      );
      return { items: (Items ?? []) as ActivityEventItem[] };
    },
  };
}
