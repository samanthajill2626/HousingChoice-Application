// SINGLE SOURCE OF TRUTH for the 9 DynamoDB table definitions.
//
// CONTRACTUAL (architecture doc v2.12 §5, p.11–12): table base names, key
// schemas (PK/SK), GSI names, stream settings (messages, cases), and the
// matches TTL. Everything else about items is a flexible document — only keys
// and GSI key attributes are contractual; schema churn needs no migrations.
//
// M0.4 NOTE — Terraform must MIRROR this module exactly (one aws_dynamodb_table
// per entry: same keys, same GSIs with ALL projection, same stream/TTL
// settings). If this module and Terraform ever disagree, this module wins and
// Terraform is wrong. Any change here is a contract change: log it in the
// README "Deviations" table and update both places in the same change.
//
// Table NAME resolution: physical names are `${TABLE_PREFIX}${baseName}` —
// hc-local- on dev machines (default), hc-dev- / hc-prod- from Terraform in
// M0.4. Use tableName() from config.ts; never hardcode a physical name.
//
// GSI key attribute naming. The doc (§5) is the source for GSI NAMES but only
// names a few key ATTRIBUTES (next_deadline_at/type, audit SK ts, messages SK
// value shape ts#msgId); the rest are judgment calls locked HERE, by these
// conventions (not deviations — the doc is silent; this module decides):
//   - ID references reuse the owning table's key name: tenantId, unitId,
//     landlordId (a contacts contactId), actorId (a users userId).
//   - Data attributes follow the doc's snake_case item-attribute style
//     (next_deadline_at and next_deadline_type are doc-specified §5 p.11).
//   - Sparse GSIs (byTourDate, byNextDeadline) are sparse purely by data
//     convention: the key attributes are simply ABSENT unless set.

/** DynamoDB scalar types usable as key attributes. */
export type KeyAttributeType = 'S' | 'N' | 'B';

export interface KeyAttribute {
  name: string;
  type: KeyAttributeType;
}

export interface GsiSpec {
  /** CONTRACTUAL index name. */
  indexName: string;
  hashKey: KeyAttribute;
  rangeKey?: KeyAttribute;
  /**
   * Sparse by data convention: items only appear in this index when the key
   * attribute(s) are present. No schema-level enforcement exists or is needed.
   */
  sparse?: boolean;
}

export interface TableSpec {
  /** Base name WITHOUT prefix; physical name = `${TABLE_PREFIX}${baseName}`. */
  baseName: string;
  hashKey: KeyAttribute;
  rangeKey?: KeyAttribute;
  /** All GSIs project ALL (document-style items; index-only reads everywhere). */
  gsis: GsiSpec[];
  /** DynamoDB Streams view type, when the table feeds side effects. */
  stream?: 'NEW_AND_OLD_IMAGES';
  /**
   * TTL attribute name (epoch seconds). Only matches uses TTL: engine output
   * is volatile and bulk-regenerated; stale rows TTL away (doc §5).
   */
  ttlAttribute?: string;
}

/** The 9 tables. Order matches the architecture doc's table (§5, p.11). */
export const TABLES: readonly TableSpec[] = [
  {
    // Every external person: tenant | landlord | pm | team_member.
    baseName: 'contacts',
    hashKey: { name: 'contactId', type: 'S' },
    gsis: [
      // Hottest lookup in the system: inbound phone -> person.
      { indexName: 'byPhone', hashKey: { name: 'phone', type: 'S' } },
      // Composite: all contacts of a type, optionally narrowed by status
      // (e.g. landlords by lead_status value).
      {
        indexName: 'byTypeStatus',
        hashKey: { name: 'type', type: 'S' },
        rangeKey: { name: 'status', type: 'S' },
      },
      // Tenants only — a voucher is administered by exactly one authority at
      // a time (doc §5), so this is single-attribute and tenant-sparse.
      {
        indexName: 'byHousingAuthority',
        hashKey: { name: 'housing_authority', type: 'S' },
      },
    ],
  },
  {
    baseName: 'units',
    hashKey: { name: 'unitId', type: 'S' },
    gsis: [
      { indexName: 'byLandlord', hashKey: { name: 'landlordId', type: 'S' } },
      { indexName: 'byStatus', hashKey: { name: 'status', type: 'S' } },
      { indexName: 'byJurisdiction', hashKey: { name: 'jurisdiction', type: 'S' } },
    ],
  },
  {
    // Thread header + inbox index.
    baseName: 'conversations',
    hashKey: { name: 'conversationId', type: 'S' },
    gsis: [
      {
        indexName: 'byParticipantPhone',
        hashKey: { name: 'participant_phone', type: 'S' },
      },
      // Inbox: open threads newest-first — partition by conversation status,
      // sort on the denormalized last-activity timestamp (ISO 8601).
      {
        indexName: 'byLastActivity',
        hashKey: { name: 'status', type: 'S' },
        rangeKey: { name: 'last_activity_at', type: 'S' },
      },
    ],
  },
  {
    // Append-only log, texts and calls interleaved. SK value shape is
    // `<ISO ts>#<msgId>` (doc: "SK ts#msgId") for stable chronological order.
    baseName: 'messages',
    hashKey: { name: 'conversationId', type: 'S' },
    rangeKey: { name: 'tsMsgId', type: 'S' },
    gsis: [],
    stream: 'NEW_AND_OLD_IMAGES', // feeds side effects (doc §5)
  },
  {
    // Volatile engine output; bulk-regenerated; stale rows TTL away.
    baseName: 'matches',
    hashKey: { name: 'tenantId', type: 'S' },
    rangeKey: { name: 'unitId', type: 'S' },
    gsis: [
      // Reverse lookup: who matched this unit.
      {
        indexName: 'byUnit',
        hashKey: { name: 'unitId', type: 'S' },
        rangeKey: { name: 'tenantId', type: 'S' },
      },
    ],
    ttlAttribute: 'expires_at',
  },
  {
    // One deal, tour-interest -> move-in (stage ladder).
    baseName: 'cases',
    hashKey: { name: 'caseId', type: 'S' },
    gsis: [
      { indexName: 'byTenant', hashKey: { name: 'tenantId', type: 'S' } },
      { indexName: 'byUnit', hashKey: { name: 'unitId', type: 'S' } },
      { indexName: 'byStage', hashKey: { name: 'stage', type: 'S' } },
      // Sparse: only cases with a scheduled tour carry tour_date (YYYY-MM-DD).
      {
        indexName: 'byTourDate',
        hashKey: { name: 'tour_date', type: 'S' },
        sparse: true,
      },
      // Sparse: every clock in the business hangs off next_deadline_at/type
      // (doc §5) — "what needs attention right now?".
      {
        indexName: 'byNextDeadline',
        hashKey: { name: 'next_deadline_type', type: 'S' },
        rangeKey: { name: 'next_deadline_at', type: 'S' },
        sparse: true,
      },
    ],
    stream: 'NEW_AND_OLD_IMAGES', // stage transitions feed side effects (doc §5)
  },
  {
    baseName: 'invoices',
    hashKey: { name: 'invoiceId', type: 'S' },
    gsis: [
      { indexName: 'byLandlord', hashKey: { name: 'landlordId', type: 'S' } },
      { indexName: 'byStatus', hashKey: { name: 'status', type: 'S' } },
    ],
  },
  {
    // The team (RBAC home once Cognito is out).
    baseName: 'users',
    hashKey: { name: 'userId', type: 'S' },
    gsis: [{ indexName: 'byEmail', hashKey: { name: 'email', type: 'S' } }],
  },
  {
    // Append-only audit trail. entityKey is `<table>#<id>` by convention.
    baseName: 'audit_events',
    hashKey: { name: 'entityKey', type: 'S' },
    rangeKey: { name: 'ts', type: 'S' },
    gsis: [
      {
        indexName: 'byActor',
        hashKey: { name: 'actorId', type: 'S' },
        rangeKey: { name: 'ts', type: 'S' },
      },
    ],
  },
] as const;

/** Lookup by base name; throws on unknown names so typos fail fast. */
export function getTableSpec(baseName: string): TableSpec {
  const spec = TABLES.find((t) => t.baseName === baseName);
  if (!spec) {
    throw new Error(
      `Unknown table base name: ${baseName} (known: ${TABLES.map((t) => t.baseName).join(', ')})`,
    );
  }
  return spec;
}
