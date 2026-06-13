// audit_events repo — MINIMAL for M1.1: append-only trail entries for
// compliance-relevant messaging events (STOP/START opt-out recording, 21610
// suppression confirmations). Table keys are contractual (lib/tables.ts):
// PK entityKey (`<table>#<id>` by convention), SK ts.
//
// SK shape: `<ISO ts>#<random suffix>` — the suffix keeps two same-millisecond
// events from colliding while preserving chronological string sort (the same
// trick as the messages `ts#msgId` SK).
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { RepoDeps } from './conversationsRepo.js';

export interface AuditRepo {
  /**
   * Append one audit event. Payload lives in DynamoDB, never in logs.
   * entityKey convention (BINDING for all call sites): `<table>#<id>` —
   * e.g. `conversations#conv-…`, `contacts#contact-…` — never a bare id,
   * so one partition reads back every event for an entity unambiguously.
   */
  append(entityKey: string, eventType: string, payload?: Record<string, unknown>): Promise<void>;
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
  };
}
