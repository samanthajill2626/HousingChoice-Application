// SINGLE SOURCE OF TRUTH for the DynamoDB table definitions (the doc §5
// 9-table model + `settings`, added in M1.4 — see the README deviations row
// 2026-06-12: CO2's founder-editable templates need a DB home).
//
// CONTRACTUAL (architecture doc v2.12 §5, p.11-12): table base names, key
// schemas (PK/SK), GSI names, stream settings (messages, placements), and the
// matches TTL. Everything else about items is a flexible document — only keys
// and GSI key attributes are contractual; schema churn needs no migrations.
//
// TERRAFORM — this module is consumed LITERALLY: `npm run gen:tables`
// (app/scripts/gen-tables.ts) generates infra/envs/{dev,prod}/
// tables.auto.tfvars.json from TABLES, terraform auto-loads it, and the
// dynamodb module for_eaches over the map (one aws_dynamodb_table per entry;
// GSI projection ALL, stream view NEW_AND_OLD_IMAGES, and on-demand billing
// stay fixed in the module). `npm run plan`/`drift` fail when the generated
// JSON is stale, so the two can never disagree. NEVER hand-edit the JSON —
// change THIS file, run `npm run gen:tables`, commit both, plan/apply. Any
// change here is still a contract change: log it in the README "Deviations"
// table.
//
// Table NAME resolution: physical names are `${TABLE_PREFIX}${baseName}` —
// hc-local- on dev machines (default), hc-dev- / hc-prod- from Terraform in
// M0.4. Use tableName() from config.ts; never hardcode a physical name.
//
// GSI key attribute naming. The doc (§5) is the source for GSI NAMES but only
// names a few key ATTRIBUTES (audit SK ts, messages SK value shape ts#msgId);
// the rest are judgment calls locked HERE, by these conventions (not deviations
// — the doc is silent; this module decides):
//   - ID references reuse the owning table's key name: tenantId, unitId,
//     landlordId (a contacts contactId), actorId (a users userId).
//   - Data attributes follow the doc's snake_case item-attribute style.
//   - Sparse GSIs (byTourDate) are sparse purely by data convention: the key
//     attributes are simply ABSENT unless set.

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

/**
 * The tables. Order matches the architecture doc's table (§5, p.11); `settings`
 * (M1.4, a deviation — see the module header) is appended last.
 */
export const TABLES: readonly TableSpec[] = [
  {
    // Every external person: tenant | landlord | team_member.
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
        hashKey: { name: 'housingAuthority', type: 'S' },
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
      // BE3/C3 (new-dashboard): the property/building group siblings index. A
      // `property` is the PARENT of units (a duplex/building) — NOT a single
      // dwelling (GLOSSARY); units in the same building share a `propertyId`.
      // Sparse by data convention: only units the operator has grouped carry
      // propertyId, so ungrouped units never index here (and the related-units
      // same_property lookup is a single-partition Query, never a Scan).
      { indexName: 'byProperty', hashKey: { name: 'propertyId', type: 'S' }, sparse: true },
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
      // Relay routing (M1.7): pool number → the active relay_group thread.
      // The inbound SMS webhook reads To via this index (cheap point query,
      // never a scan) and treats "found" as "this To is one of our pool
      // numbers". Sparse by data convention — only relay_group items carry
      // pool_number, so 1:1 threads never index here. One ACTIVE relay per
      // pool number (a closed relay releases its number to quarantine).
      {
        indexName: 'byPoolNumber',
        hashKey: { name: 'pool_number', type: 'S' },
        sparse: true,
      },
      // Relay-group inbox/roster read (relay-inbox-open-groups-truncation fix):
      // relay groups in ONE status partition, newest-activity-first. HASH is
      // `relay_status` = `relay_group#<status>` (`relay_group#open` /
      // `relay_group#closed`), written ONLY on relay_group items — 1:1 threads
      // never carry it, so this GSI is sparse and holds relay groups ONLY. This
      // makes listRelayGroups(status) a DIRECT query (no post-Limit type filter),
      // so a relay group can no longer be diluted out of the byLastActivity
      // 'open' partition by the TOTAL volume of open 1:1 threads ordered ahead of
      // it (DynamoDB applies FilterExpression AFTER Limit). SORT is
      // last_activity_at (ISO 8601) so results come back newest-activity-first.
      {
        indexName: 'byRelayStatus',
        hashKey: { name: 'relay_status', type: 'S' },
        rangeKey: { name: 'last_activity_at', type: 'S' },
        sparse: true,
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
    baseName: 'placements',
    hashKey: { name: 'placementId', type: 'S' },
    gsis: [
      { indexName: 'byTenant', hashKey: { name: 'tenantId', type: 'S' } },
      { indexName: 'byUnit', hashKey: { name: 'unitId', type: 'S' } },
      { indexName: 'byStage', hashKey: { name: 'stage', type: 'S' } },
      // Sparse: only placements with a scheduled tour carry tour_date (YYYY-MM-DD).
      {
        indexName: 'byTourDate',
        hashKey: { name: 'tour_date', type: 'S' },
        sparse: true,
      },
      // NOTE: the overloaded single next_deadline slot + its byNextDeadline GSI
      // were RETIRED (placement-deadline-model refactor): deadlines are now
      // first-class placementDeadlines items (below), and the internal "stuck"
      // signal is DERIVED from time-in-stage — the two no longer compete for one
      // slot. "What needs attention right now?" is answered by the
      // placementDeadlines.byDueAt query.
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
  {
    // NEW in M1.4 (NOT in the doc §5 9-table model — README deviation
    // 2026-06-12): a DB home for the founder-editable settings CO2 introduced
    // (missed-call auto-text + quick replies). Flexible document keyed by a
    // singleton id (`org`); PK `settingId` keeps the shape open to per-user
    // rows later. No GSIs — every read is a point GetItem on a known id.
    baseName: 'settings',
    hashKey: { name: 'settingId', type: 'S' },
    gsis: [],
  },
  {
    // NEW in M1.7 (NOT in the doc §5 9-table model — README deviation
    // 2026-06-13): the pool-number lifecycle pool for relay group threads.
    // A pool number is provisioned voice+sms-capable (M1.7 pre-wires voice
    // for the M1.9 masked-calling bridge), claimed by exactly one active
    // relay_group conversation, and released to a 30-day quarantine when the
    // relay closes (carriers recycle freed numbers; quarantine stops us
    // re-handing a number whose prior conversants might still text it).
    // PK is the E.164 number itself. Item is a flexible document; only the
    // key + the byLifecycleState GSI attrs are contractual (lib/tables.ts).
    baseName: 'pool_numbers',
    hashKey: { name: 'poolNumber', type: 'S' },
    gsis: [
      // Available-pool query (lifecycle_state='available') + quarantine
      // reclaim sweep (lifecycle_state='quarantined' AND quarantine_until <=
      // now): partition by lifecycle_state, sort by quarantine_until.
      //
      // NOT sparse: a DynamoDB GSI indexes an item only when BOTH key attrs
      // are present, so quarantine_until is written on EVERY pool_numbers
      // item (the repo sets a past-time sentinel for available/assigned and
      // the real future timestamp once quarantined) — otherwise findAvailable
      // could not query the 'available' partition. The reclaim sweep reads
      // only the 'quarantined' partition, where the value is the live release
      // deadline; sentinels in other partitions are never compared against.
      {
        indexName: 'byLifecycleState',
        hashKey: { name: 'lifecycle_state', type: 'S' },
        rangeKey: { name: 'quarantine_until', type: 'S' },
      },
    ],
  },
  {
    // NEW in M1.8a (NOT in the doc §5 9-table model — README deviation
    // 2026-06-13): the filtered share-broadcast ("Share Properties") record.
    // The operator picks a unit + bedroom-size/housing-authority filter and
    // texts the matching tenants the unit's flyer; this row is the draft →
    // sending → sent/failed lifecycle + the audience snapshot, per-recipient
    // delivery map, and rolled-up stats the results view reads.
    //
    // PK is broadcastId. Item is a flexible document; only the key + the two
    // GSI key attrs are contractual (lib/tables.ts). The recipients map is
    // bounded (a Phase-1 filtered tenant set, low hundreds) and lives on the
    // item — the broadcastsRepo notes the 400KB item ceiling.
    baseName: 'broadcasts',
    hashKey: { name: 'broadcastId', type: 'S' },
    gsis: [
      // List by lifecycle state (draft/sending/sent/failed) — the results
      // dashboard's "in-flight / recent broadcasts" view.
      { indexName: 'byStatus', hashKey: { name: 'status', type: 'S' } },
      // List a creator's broadcasts newest-first: partition by created_by,
      // sort on created_at (ISO 8601).
      {
        indexName: 'byCreatedAt',
        hashKey: { name: 'created_by', type: 'S' },
        rangeKey: { name: 'created_at', type: 'S' },
      },
      // Prior-recipients lookup (Broadcasts dashboard): partition by unitId so a
      // unit's prior sent/sending broadcasts come back in one Query (never a
      // Scan) — the composer flags tenants already broadcast for this property.
      // Sparse by data convention: only broadcasts WITH a unitId index here, so
      // a unit-less broadcast never appears (and the lookup degrades to empty
      // when the GSI is absent on an un-applied env).
      { indexName: 'byUnit', hashKey: { name: 'unitId', type: 'S' }, sparse: true },
    ],
  },
  {
    // NEW in BE2/C2 (NOT in the doc §5 9-table model — new-dashboard build): the
    // person-centric activity-event log. Each row is one milestone (a case
    // opened/closed, a stage change, a property sent, a number added, group-text
    // membership, …) for a contact, so the contact-timeline endpoint can MERGE
    // these with the contact's messages/calls into one chronological feed.
    //
    // PK is contactId; SK is `<ISO at>#<eventId>` — mirroring the messages SK
    // (`<ISO ts>#<msgId>`) so a Query is naturally chronological and pages
    // backward with a `tsEventId < :before` bound. Item is a flexible document;
    // only the two key attrs are contractual (this module). No GSIs (the only
    // read is "events for THIS contact, newest-first"), no stream.
    baseName: 'activity_events',
    hashKey: { name: 'contactId', type: 'S' },
    rangeKey: { name: 'tsEventId', type: 'S' },
    gsis: [],
  },
  {
    // NEW in BE4/C4 (NOT in the doc §5 9-table model — new-dashboard build): the
    // listing-send record. ONE row per unit↔contact pairing captures that a
    // property (a `unit`, tenant-facing "home") was sent to a tenant and the
    // tenant's response (interested / not_a_fit / no_reply). Two read directions
    // share these rows: GET /api/units/:id/recipients ("Sent to tenants") reads
    // the base table by unitId; GET /api/contacts/:id/listings-sent reads the
    // byContact GSI by contactId.
    //
    // PK is unitId; SK is contactId (one upsert-keyed row per pairing, so a
    // re-send never duplicates). GSI byContact inverts the direction: PK
    // contactId, SK sentAt — so a contact's listings-sent comes back newest-first
    // by sentAt (one Query, never a scan). Item is a flexible document; only the
    // key + the byContact GSI key attrs are contractual (this module). No stream.
    baseName: 'listing_sends',
    hashKey: { name: 'unitId', type: 'S' },
    rangeKey: { name: 'contactId', type: 'S' },
    gsis: [
      {
        indexName: 'byContact',
        hashKey: { name: 'contactId', type: 'S' },
        rangeKey: { name: 'sentAt', type: 'S' },
      },
    ],
  },
  {
    // NEW in Tours feature (Tasks 4+): durable reminder rows for the
    // tour-reminder poll job. The poll queries byDueAt (fixed 'reminders'
    // partition, range=dueAt) for rows due at or before now; byTour lets
    // cancel-for-tour enumerate all a tour's rows efficiently.
    baseName: 'tourReminders',
    hashKey: { name: 'reminderId', type: 'S' },
    gsis: [
      { indexName: 'byTour', hashKey: { name: 'tourId', type: 'S' } },
      {
        // Poll query: all pending reminders due at or before now.
        // Fixed partition 'reminders' so a single-partition Query covers all rows.
        indexName: 'byDueAt',
        hashKey: { name: '_reminderPartition', type: 'S' },
        rangeKey: { name: 'dueAt', type: 'S' },
      },
    ],
  },
  {
    // NEW in Post-Tour & Application feature: durable nudge rows for the
    // placement-nudge poll job (the stage-keyed application chase ladder).
    // Clones the tourReminders shape exactly: the poll queries byDueAt (fixed
    // 'nudges' partition, range=dueAt) for rows due at or before now; byPlacement
    // lets cancel-for-placement enumerate all a placement's rows efficiently.
    baseName: 'placementNudges',
    hashKey: { name: 'nudgeId', type: 'S' },
    gsis: [
      { indexName: 'byPlacement', hashKey: { name: 'placementId', type: 'S' } },
      {
        // Poll query: all pending nudges due at or before now.
        // Fixed partition 'nudges' so a single-partition Query covers all rows.
        indexName: 'byDueAt',
        hashKey: { name: '_nudgePartition', type: 'S' },
        rangeKey: { name: 'dueAt', type: 'S' },
      },
    ],
  },
  {
    // NEW in the placement-deadline-model refactor: first-class placement
    // DEADLINE rows — one item per (placement, type), so a placement can track
    // SEVERAL real due-dates at once (rta_window / voucher_expiration /
    // follow_up) and readers surface whichever is soonest. Retires the
    // overloaded single next_deadline slot + the placements.byNextDeadline GSI.
    // Clones the placementNudges/tours byDueAt shape exactly.
    //
    // PK deadlineId is DETERMINISTIC (`${placementId}#${type}`) so arming is an
    // idempotent upsert and retiring is a DeleteItem by key — no duplicates, no
    // read-before-write. byPlacement enumerates a placement's deadlines (display
    // + terminal clear); byDueAt (fixed 'deadlines' partition, range=at) answers
    // "all due deadlines" in one soonest-first Query.
    baseName: 'placementDeadlines',
    hashKey: { name: 'deadlineId', type: 'S' },
    gsis: [
      { indexName: 'byPlacement', hashKey: { name: 'placementId', type: 'S' } },
      {
        indexName: 'byDueAt',
        hashKey: { name: '_deadlinePartition', type: 'S' },
        rangeKey: { name: 'at', type: 'S' },
      },
    ],
  },
  {
    // NEW in Tours feature (NOT in the doc §5 9-table model — README deviation):
    // first-class Tour entity (a scheduled visit by a tenant to a unit). Separate
    // from placements — a tenant stays `searching`; no touring stage. Four read
    // directions share the GSIs: byTenant (all a tenant's tours), byUnit (all
    // tours for a property), byScheduledAt (windowed time queries — "tours today",
    // reminder/no-show clocks), byStatus (dashboard queue — all 'requested' tours,
    // all 'scheduled' tours, etc.). A fixed global partition key ('tours') on
    // byScheduledAt makes a datetime-range Query possible without a scatter-gather
    // Scan; keep it sparse so items without a scheduledAt never index there.
    baseName: 'tours',
    hashKey: { name: 'tourId', type: 'S' },
    gsis: [
      // All tours for a tenant — powers the contact-file tours card.
      { indexName: 'byTenant', hashKey: { name: 'tenantId', type: 'S' } },
      // All tours for a unit — powers the property-file tours card.
      { indexName: 'byUnit', hashKey: { name: 'unitId', type: 'S' } },
      // Time-windowed tour queries (today's tours, no-show sweep, reminder job).
      // Hash partition is the constant string 'tours' (all live tours share one
      // partition); range key is scheduledAt (ISO 8601) so BETWEEN/>=/<= works.
      // Sparse: items without scheduledAt never appear here.
      {
        indexName: 'byScheduledAt',
        hashKey: { name: '_schedPartition', type: 'S' },
        rangeKey: { name: 'scheduledAt', type: 'S' },
        sparse: true,
      },
      // Status-based queue (dashboard Tasks 2+): partition by status, sort by
      // createdAt (ISO 8601). Powers listByStatus() — e.g. all 'requested' tours
      // awaiting scheduling, all 'scheduled' tours for the day's agenda.
      {
        indexName: 'byStatus',
        hashKey: { name: 'status', type: 'S' },
        rangeKey: { name: 'createdAt', type: 'S' },
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
