// activity-events repo (BE2/C2) — the person-centric milestone log.
//
// Each row records ONE milestone for a contact (a placement opened/closed, a stage
// change, a property sent, a number added, relay-group membership, ...). The
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
// flyer-leads D6: hasEventSince is the public sign-up's repeat check - one
// key-range Query on the contact's partition (`tsEventId > :since`), filtered
// to one type and one ref (or no ref), walked to the end of the window.
//
// PII (doc §9): NEVER log the label (it can carry a name/tag) — IDs/type only.
import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { queryAll } from '../lib/dynamoPaging.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/**
 * The milestone/activity types (C2 `TimelineMilestoneType`, VERBATIM — the
 * frontend imports the identical union). Do NOT rename any member.
 */
export type ActivityEventType =
  | 'placement_opened'
  | 'placement_closed'
  | 'listing_sent'
  | 'tour_scheduled'
  | 'tour_took_place'
  | 'tour_canceled'
  | 'tour_no_show'
  | 'tour_outcome'
  | 'tour_group_opened'
  | 'placement_group_opened'
  | 'tour_converted'
  | 'tour_auto_closed'
  | 'tour_reopened'
  | 'stage_changed'
  | 'contact_status_changed'
  | 'opt_out_changed'
  | 'number_added'
  // NAME COLLISION, ADJUDICATED - DO NOT RENAME. These two predate the native
  // `group_text` conversation type and have nothing to do with it: they mean
  // "added to / removed from a RELAY GROUP" (relayMembers.ts) and, since the
  // unit-contact reuse, "added to / removed from a PROPERTY's contact list"
  // (routes/contactTimeline.ts). S1 renamed the staff-facing COPY to "relay
  // group" and deliberately renamed NO identifiers, because these strings are
  // PERSISTED on every historical activity-event row: renaming them is a data
  // migration, and a partial rename would silently split the feed. The label is
  // where the meaning lives; the dashboard consumes the type only for a colour
  // switch (Timeline.tsx). Anything genuinely about a group_text thread gets
  // its own new kind.
  | 'added_to_group_text'
  | 'removed_from_group_text'
  // last-heard-from spec 5.4: the send-outcome route's three events, written
  // by lib/listingOutcomeEvents.ts (refType 'unit', the CONTACT's feed only).
  | 'listing_declined'
  | 'listing_decline_cleared'
  | 'listing_interested'
  // flyer-leads D6: a public sign-up (the flyer's sign-up box or /join) by an
  // existing or new contact, pinned in its thread. refType 'unit' + refId the
  // unitId when the flyer's property was public (every status but setup -
  // permanent-flyer-links D5); NO ref for /join and any other flyer - the one
  // shared "no property" source of the 24-hour repeat check (hasEventSince).
  | 'signed_up';

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
  /** Human text, e.g. "Tour took place - Toured". May carry a name — never logged. */
  label: string;
  /** Deep-link target type (link-out only; never inline content). */
  refType?: ActivityEventRefType;
  refId?: string;
  /**
   * share-sent-outcome D6: the share a `listing_sent` milestone records (a
   * plain attribute; the SK and the projection are unchanged). Absent on
   * every other milestone and on a milestone written before the field.
   */
  broadcastId?: string;
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
  /** share-sent-outcome D6: the share a `listing_sent` milestone records (stored as `broadcastId`). */
  broadcastId?: string;
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
  /**
   * flyer-leads D6: whether the contact has an event of `type` recorded at or
   * after `sinceIso` whose refId is `refId` (undefined = an event with NO
   * refId). Query PK contactId, KeyCondition `tsEventId > :since` (sinceIso as
   * the bound), FilterExpression on `#type = :type` and on the ref
   * (`refId = :ref` or `attribute_not_exists(refId)`), `ConsistentRead: true`
   * (AR12 - a sign-up that starts after another's pin was written sees that
   * pin), paginated to the end of the window (lib/dynamoPaging queryAll).
   * Throws on a DynamoDB error. A READ, not a claim: two OVERLAPPING
   * same-source sign-ups can both answer false and each pin and bump, so the
   * public sign-up's burst bound is the per-IP /public limiter, not this read
   * (docs/issues/public-signup-abuse-hardening.md).
   */
  hasEventSince(
    contactId: string,
    type: ActivityEventType,
    sinceIso: string,
    refId: string | undefined,
  ): Promise<boolean>;
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
        ...(input.broadcastId !== undefined && { broadcastId: input.broadcastId }),
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

    async hasEventSince(contactId, type, sinceIso, refId) {
      // flyer-leads D6. The bare ISO bounds `<ISO at>#<eventId>` keys, so an
      // event AT sinceIso is inside the window. A FilterExpression is applied
      // after each page is read, so the walk follows the cursor to the end
      // (queryAll) and never stops at an empty or filtered-out page. AR12:
      // strongly consistent (a base-table Query allows it), so a sign-up that
      // starts after another's pin was written sees that pin; one that
      // OVERLAPS it can still miss it (a read, not a claim - see the interface
      // note). `type` is a DynamoDB reserved word, hence #type. PII (doc
      // section 9): no label is read into a log line.
      const items = await queryAll<ActivityEventItem>(
        doc,
        {
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: 'contactId = :c AND tsEventId > :since',
          FilterExpression:
            refId === undefined
              ? '#type = :type AND attribute_not_exists(refId)'
              : '#type = :type AND refId = :ref',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: {
            ':c': contactId,
            ':since': sinceIso,
            ':type': type,
            ...(refId !== undefined && { ':ref': refId }),
          },
        },
        { logger: log },
      );
      return items.length > 0;
    },
  };
}
