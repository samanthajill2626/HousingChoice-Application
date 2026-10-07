// The housing authority + agency lists - ONE item, `settingId: 'org-list'`,
// in the existing `settings` table (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D1, D2, D11, D13; plan sections 3.2-3.3). No new table, no Terraform. A
// sibling of settingsRepo.ts and contactVocabularyRepo.ts, not part of either:
// settingsRepo's helpers are closed per-id APIs, not a record store.
//
// READS are ALWAYS one strongly consistent GetItem, and nothing is cached
// (D1) - unlike the settings getters, which are eventually consistent and must
// not be copied here. The FIRST read in an environment with no item writes the
// starting list (lib/orgStartingList.ts) under a create-only condition and
// returns it; a reader that loses that race re-reads the winner (the
// settingsRepo claimGroupIdentityFingerprint idiom). From then on the stored
// item is the only source: editing the starting list in code changes nothing
// in an environment that already has its item (D2). peek() is the
// NON-creating read for the importer CLI and the cleanup script; putForSeed()
// is the seeds' unconditional overwrite.
//
// WRITES are read-and-bump (D1; the aiRunsRepo.putRun precedent): read as
// get() does, apply the change, Put the whole item conditioned on the version
// that was read and carrying version + 1; on a lost condition, re-read and
// re-apply - at most ORG_LIST_MAX_ATTEMPTS times, then OrgListBusyError. The
// change may run more than once, so it must be pure. A write that would make
// the item larger than ORG_LIST_MAX_BYTES is refused (OrgListFullError) before
// anything is sent (D13).
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../lib/config.js';
import { getDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { OrgEntry } from '../lib/orgNames.js';
import { buildStartingEntries } from '../lib/orgStartingList.js';
import type { RepoDeps } from './conversationsRepo.js';

export type OrgRewriteAction =
  | 'rename' | 'merge' | 'use' | 'move_to_agency'
  | 'move_to_housing_authority' | 'split' | 'clear' | 'cleanup';

/** The record fields a rewrite may touch (branch A). */
export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';

export interface OrgRewriteState {
  jobId: string;
  action: OrgRewriteAction;
  /** Stored texts to rewrite, compared NORMALIZED (D4) by the job. */
  fromTexts: string[];
  /** The one field a value action targets; absent for rename/merge (all fields of the kind). */
  field?: OrgRecordField;
  /** The record fields the rewrite runs one pass over each (spec 5.1), FIXED
   *  when it starts: a value action's `[field]`; a rename/merge, every field
   *  of the target entry's kind at that moment; the cleanup lock, all three.
   *  The job and Run again read it - never a run-time lookup of the target. */
  fields: OrgRecordField[];
  toName?: string;
  /** Split only: the agency half. */
  agencyName?: string;
  status: 'running' | 'done' | 'failed';
  heartbeatAt: string;
  /** Keys: `housingAuthority`, `agency`, `accepted_authorities` (records
   *  rewritten per field), `skipped` (a record changed meanwhile),
   *  `conflicts` (Move/Split blocked by a value already in the target field). */
  counts?: Record<string, number>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
}

export interface OrgListItem {
  settingId: 'org-list';
  version: number;
  entries: OrgEntry[];
  lastRewrite?: OrgRewriteState;
}

export const ORG_LIST_SETTING_ID = 'org-list';
export const ORG_LIST_MAX_BYTES = 300 * 1024;
export const ORG_REWRITE_STALE_MS = 15 * 60 * 1000;

/** Read-and-bump attempts before OrgListBusyError (plan 3.3). */
export const ORG_LIST_MAX_ATTEMPTS = 5;

/** The write would make the item larger than ORG_LIST_MAX_BYTES (D13 -> 409 org_list_full). */
export class OrgListFullError extends Error {
  constructor(message = `the organization list would exceed ${ORG_LIST_MAX_BYTES} bytes`) {
    super(message);
    this.name = 'OrgListFullError';
  }
}

/** The version race was lost ORG_LIST_MAX_ATTEMPTS times in a row (-> 503 org_list_busy). */
export class OrgListBusyError extends Error {
  constructor(message = `the organization list changed during ${ORG_LIST_MAX_ATTEMPTS} write attempts; retry`) {
    super(message);
    this.name = 'OrgListBusyError';
  }
}

/**
 * The size the D13 cap measures: UTF-8 bytes of the item's JSON (the
 * adapters/cloudwatch.ts entryCost precedent). DynamoDB counts attribute names
 * and values; JSON is a close, slightly generous stand-in, and the cap sits
 * 100 KB under DynamoDB's own 400 KB item limit. Exported so the test fake
 * measures the same way.
 */
export function orgListItemBytes(item: OrgListItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export interface OrgListRepo {
  /** One consistent GetItem. Absent item: create the starting list with a
   *  create-only put (attribute_not_exists), then return the stored item
   *  (re-read on a lost create). Never caches. */
  get(): Promise<OrgListItem>;
  /** Read-and-bump: read (as get()), run `change`, write the result
   *  conditionally on `version = :expected` with version + 1; retry the whole
   *  cycle on a lost condition, at most 5 attempts (then OrgListBusyError).
   *  Refuses (OrgListFullError) when the serialized item exceeds the cap.
   *  `change` may throw a domain error, which propagates unchanged. A change
   *  that returns the SAME object it was given writes nothing (no version
   *  bump) - heartbeat()/finish() use that to do nothing for a stale run. */
  mutate<T>(change: (current: OrgListItem) => { next: OrgListItem; result: T }): Promise<T>;
  /** Seeds and tests only: unconditional put of a whole item. */
  putForSeed(item: OrgListItem): Promise<void>;
  /** NON-creating consistent read (the importer CLI and the cleanup script):
   *  the stored item, or null when absent. Callers fall back to
   *  buildStartingEntries() in memory and never write. */
  peek(): Promise<OrgListItem | null>;
}

/**
 * The stored item, projected defensively. Only this repo and the seeds write
 * it, so this is belt-and-braces: a missing version reads as 0 and a missing
 * entries list as empty, rather than a TypeError deep inside a service.
 */
function toItem(raw: Record<string, unknown>): OrgListItem {
  const version = raw['version'];
  const entries = raw['entries'];
  const lastRewrite = raw['lastRewrite'];
  return {
    settingId: ORG_LIST_SETTING_ID,
    version: typeof version === 'number' ? version : 0,
    entries: Array.isArray(entries) ? (entries as OrgEntry[]) : [],
    ...(typeof lastRewrite === 'object' &&
      lastRewrite !== null && { lastRewrite: lastRewrite as OrgRewriteState }),
  };
}

export function createOrgListRepo(
  deps: RepoDeps & { now?: () => string; newId?: () => string } = {},
): OrgListRepo {
  const doc = deps.doc ?? getDocumentClient();
  const table = tableName('settings', deps.env);
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const newId = deps.newId ?? ((): string => randomUUID());
  const key = { settingId: ORG_LIST_SETTING_ID };

  /** One strongly consistent GetItem (D1). */
  async function read(): Promise<OrgListItem | null> {
    const { Item } = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return Item === undefined ? null : toItem(Item as Record<string, unknown>);
  }

  async function get(): Promise<OrgListItem> {
    const stored = await read();
    if (stored !== null) return stored;
    const created: OrgListItem = {
      settingId: ORG_LIST_SETTING_ID,
      version: 1,
      entries: buildStartingEntries(now(), newId),
    };
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: created,
          // D2: the starting list seeds an EMPTY store exactly once.
          ConditionExpression: 'attribute_not_exists(settingId)',
        }),
      );
      log.info({ entries: created.entries.length }, 'org list created from the starting list');
      return created;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Another reader created it first - the house "loser re-reads" idiom.
      const winner = await read();
      if (winner === null) throw new Error('org list: the create-only write lost, yet no item exists');
      return winner;
    }
  }

  return {
    get,
    async mutate(change) {
      for (let attempt = 1; attempt <= ORG_LIST_MAX_ATTEMPTS; attempt += 1) {
        const current = await get();
        const { next, result } = change(current);
        if (next === current) return result;
        const stored: OrgListItem = { ...next, settingId: ORG_LIST_SETTING_ID, version: current.version + 1 };
        if (orgListItemBytes(stored) > ORG_LIST_MAX_BYTES) throw new OrgListFullError();
        try {
          await doc.send(
            new PutCommand({
              TableName: table,
              Item: stored,
              // "absent OR equal": the conversationsRepo roster-version shape,
              // so an item written without a version can still be bumped.
              ConditionExpression: 'attribute_not_exists(#version) OR #version = :expected',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expected': current.version },
            }),
          );
          return result;
        } catch (err) {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
          log.info({ attempt }, 'org list write lost a version race - retrying');
        }
      }
      throw new OrgListBusyError();
    },
    async peek() {
      return read();
    },
    async putForSeed(item) {
      await doc.send(new PutCommand({ TableName: table, Item: { ...item, settingId: ORG_LIST_SETTING_ID } }));
      log.info({ entries: item.entries.length, version: item.version }, 'org list written (seed)');
    },
  };
}
