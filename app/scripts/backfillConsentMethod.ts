// backfill:consent-method — one-time, IDEMPOTENT backfill that derives a
// `consent_method` for pre-existing contacts from their legacy `capture_source`
// (spec §2 backfill rule):
//
//   capture_source = 'inbound_sms'          → consent_method = 'inbound_text'
//   capture_source = 'housing_fair' | 'flyer' → consent_method = 'web_form'
//                                               (+ consent_version = CONSENT_VERSION)
//
// `consent_at` is set to the contact's existing `captured_at` (else `created_at`,
// else now). Contacts that ALREADY have a `consent_method` are skipped — so
// re-running is always safe (idempotent). Contacts whose capture_source implies
// no method are left untouched (the JIT gate catches them later).
//
// Targets DYNAMODB_ENDPOINT (default DynamoDB Local). Against a deployed env it
// resolves the physical table via lib/config.tableName (respects TABLE_PREFIX).
//
// PII: logs COUNTS and contactIds/markers only — never names/phones/notes/bodies.
//
// Run (from repo root, tsx): `tsx app/scripts/backfillConsentMethod.ts`
//   --dry-run   scan + report the plan (counts only); write NOTHING.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../src/lib/config.js';
import { getDocumentClient } from '../src/lib/dynamo.js';
import { logger } from '../src/lib/logger.js';
import {
  CONSENT_VERSION,
  consentMethodFromCaptureSource,
  type ConsentMethod,
} from '../src/lib/smsCompliance.js';

/** The consent write a single contact needs, or null when it needs no backfill. */
export interface ConsentBackfillPlan {
  consent_method: ConsentMethod;
  consent_at: string;
  /** Only set for web_form (the disclosure version); omitted otherwise. */
  consent_version?: string;
}

/**
 * PURE mapping — decide what (if anything) to write for one contact.
 * Returns null when the contact should be SKIPPED:
 *   - it already has a consent_method (idempotency), OR
 *   - its capture_source implies no method.
 * Otherwise returns the fields to SET. Factored out so it's unit-testable
 * without a database (see smsComplianceBackfill.test.ts).
 */
export function planConsentBackfill(contact: {
  consent_method?: unknown;
  capture_source?: string;
  captured_at?: string;
  created_at?: string;
}): ConsentBackfillPlan | null {
  // Idempotent: never touch a contact that already has consent recorded.
  if (typeof contact.consent_method === 'string' && contact.consent_method.length > 0) {
    return null;
  }
  const method = consentMethodFromCaptureSource(contact.capture_source);
  if (method === undefined) return null;

  const consent_at =
    (typeof contact.captured_at === 'string' && contact.captured_at) ||
    (typeof contact.created_at === 'string' && contact.created_at) ||
    new Date().toISOString();

  return {
    consent_method: method,
    consent_at,
    // web_form came through the public form → stamp the disclosure version.
    ...(method === 'web_form' && { consent_version: CONSENT_VERSION }),
  };
}

interface BackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Scan the contacts table and apply planConsentBackfill to each real contact
 * (phone-pointer items — phone_ref — carry no capture_source and are skipped).
 * When dryRun, computes the plan and counts but writes nothing.
 */
export async function backfillConsentMethod(opts: {
  endpoint?: string;
  dryRun?: boolean;
} = {}): Promise<BackfillResult> {
  const doc = getDocumentClient();
  const table = tableName('contacts');
  const dryRun = opts.dryRun === true;

  const result: BackfillResult = { scanned: 0, updated: 0, skipped: 0 };
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new ScanCommand({
        TableName: table,
        ...(exclusiveStartKey !== undefined && { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    for (const item of (Items ?? []) as Array<Record<string, unknown>>) {
      // Skip phone-pointer items (no contact identity / capture_source).
      if (item['phone_ref'] === true) continue;
      result.scanned += 1;
      const plan = planConsentBackfill(item);
      if (plan === null) {
        result.skipped += 1;
        continue;
      }
      if (!dryRun) {
        const names: Record<string, string> = {
          '#m': 'consent_method',
          '#a': 'consent_at',
        };
        const values: Record<string, unknown> = {
          ':m': plan.consent_method,
          ':a': plan.consent_at,
        };
        let expr = 'SET #m = :m, #a = :a';
        if (plan.consent_version !== undefined) {
          names['#v'] = 'consent_version';
          values[':v'] = plan.consent_version;
          expr += ', #v = :v';
        }
        await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { contactId: item['contactId'] },
            UpdateExpression: expr,
            // Belt-and-braces idempotency at the WRITE (a concurrent run can't
            // double-stamp): only set when consent_method is still absent.
            ConditionExpression: 'attribute_not_exists(consent_method)',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
      }
      result.updated += 1;
    }
    exclusiveStartKey = LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);

  return result;
}

// --- Runnable entrypoint (skipped when imported by tests) ------------------
// tsx runs this file as the process entry; import.meta guards the side effects.
const isEntrypoint = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('backfillConsentMethod.ts');
if (isEntrypoint) {
  const dryRun = process.argv.includes('--dry-run');
  logger.info({ dryRun }, 'backfill:consent-method — starting');
  backfillConsentMethod({ dryRun })
    .then((r) => {
      logger.info(
        { scanned: r.scanned, updated: r.updated, skipped: r.skipped, dryRun },
        `backfill:consent-method — done${dryRun ? ' (DRY RUN — nothing written)' : ''}`,
      );
    })
    .catch((err) => {
      logger.error({ err }, 'backfill:consent-method — FAILED');
      process.exit(1);
    });
}
