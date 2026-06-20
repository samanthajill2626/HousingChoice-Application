// audit_events repo — MINIMAL for M1.1: append-only trail entries for
// compliance-relevant messaging events (STOP/START opt-out recording, 21610
// suppression confirmations). Table keys are contractual (lib/tables.ts):
// PK entityKey (`<table>#<id>` by convention), SK ts.
//
// SK shape: `<ISO ts>#<random suffix>` — the suffix keeps two same-millisecond
// events from colliding while preserving chronological string sort (the same
// trick as the messages `ts#msgId` SK).
import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

/** One stored audit event (the base-table item shape; payload lives in Dynamo, never logs). */
export interface AuditEvent {
  entityKey: string;
  /** SK: `<ISO ts>#<random suffix>` — chronological string sort, collision-safe. */
  ts: string;
  event_type: string;
  /** byActor GSI hash (hoisted from payload.actor); absent for system actions. */
  actorId?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Options for the per-entity history read. */
export interface ListByEntityOpts {
  /** Page size (Dynamo Limit). */
  limit?: number;
  /** Exclusive upper bound on the SK (`ts`) — page backward through history. */
  before?: string;
}

export interface AuditRepo {
  /**
   * Append one audit event. Payload lives in DynamoDB, never in logs.
   * entityKey convention (BINDING for all call sites): `<table>#<id>` —
   * e.g. `conversations#conv-…`, `contacts#contact-…` — never a bare id,
   * so one partition reads back every event for an entity unambiguously.
   */
  append(entityKey: string, eventType: string, payload?: Record<string, unknown>): Promise<void>;
  /**
   * Read an entity's provenance trail NEWEST-FIRST — one bounded Query on the
   * base-table PK (entityKey), descending by the `ts` SK. `before` is an
   * exclusive SK upper bound (page backward). No table/schema change: it reads
   * the same items `append` writes. entityKey follows the `<table>#<id>`
   * convention (e.g. `placements#placement-…`).
   */
  listByEntity(entityKey: string, opts?: ListByEntityOpts): Promise<AuditEvent[]>;
}

export function createAuditRepo(deps: RepoDeps = {}): AuditRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('audit_events', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async append(entityKey, eventType, payload) {
      const ts = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;
      // M1.4 M1: lift the acting user up to a TOP-LEVEL `actorId` so the
      // byActor GSI (hash key actorId) is populated and "all actions by actor
      // X" is queryable (§9). Call sites pass the actor inside the payload as
      // `actor` (the established convention across M1.1/M1.2/M1.4); we hoist
      // that single field here, centrally, so no call site has to change. The
      // actor stays in the payload too (callers/tests read it there); only the
      // GSI key is added. A non-string/absent actor simply leaves the item off
      // the GSI (sparse) — exactly the right behavior for a system action.
      const actor = payload?.['actor'];
      const actorId = typeof actor === 'string' ? actor : undefined;
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            entityKey,
            ts,
            event_type: eventType,
            ...(actorId !== undefined && { actorId }),
            ...(payload !== undefined && { payload }),
          },
        }),
      );
      // IDs only — audit payloads may reference messages but never log bodies.
      log.info({ entityKey, eventType }, 'audit event appended');
    },

    async listByEntity(entityKey, opts = {}) {
      const hasBefore = typeof opts.before === 'string' && opts.before.length > 0;
      const input: QueryCommandInput = {
        TableName: table,
        KeyConditionExpression: hasBefore ? '#e = :e AND #ts < :before' : '#e = :e',
        ExpressionAttributeNames: hasBefore
          ? { '#e': 'entityKey', '#ts': 'ts' }
          : { '#e': 'entityKey' },
        ExpressionAttributeValues: hasBefore
          ? { ':e': entityKey, ':before': opts.before }
          : { ':e': entityKey },
        // Newest-first: descending by the `ts` SK.
        ScanIndexForward: false,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
      };
      const { Items } = await doc.send(new QueryCommand(input));
      // IDs/count only — never the payloads.
      log.info({ entityKey, count: Items?.length ?? 0 }, 'audit history read');
      return (Items ?? []) as AuditEvent[];
    },
  };
}
