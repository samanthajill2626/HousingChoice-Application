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
  /** Append one audit event. Payload lives in DynamoDB, never in logs. */
  append(entityKey: string, eventType: string, payload?: Record<string, unknown>): Promise<void>;
}

export function createAuditRepo(deps: RepoDeps = {}): AuditRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('audit_events', deps.env);
  const log = deps.logger ?? defaultLogger;

  return {
    async append(entityKey, eventType, payload) {
      const ts = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            entityKey,
            ts,
            event_type: eventType,
            ...(payload !== undefined && { payload }),
          },
        }),
      );
      // IDs only — audit payloads may reference messages but never log bodies.
      log.info({ entityKey, eventType }, 'audit event appended');
    },
  };
}
