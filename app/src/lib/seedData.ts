// Idempotent local seed data for DynamoDB Local.
//
// Extracted from app/scripts/db-seed.ts so it can be imported from within
// app/src/ (e.g. devReset.ts) without crossing tsconfig rootDir boundaries.
// The db-seed.ts script re-exports from here and adds the top-level runner.
//
// Fixed IDs + plain PutItem = safe to re-run forever (same items overwrite
// themselves; no duplicates). Data is realistic-but-fake (+1555 phones,
// example.com emails). Targets DYNAMODB_ENDPOINT — never AWS.
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient } from './dynamo.js';
import { tableName } from './config.js';

export const LOCAL_DEFAULT_ENDPOINT = 'http://localhost:8000';

// Stable timestamps so re-runs write byte-identical items.
const T0 = '2026-06-01T14:00:00.000Z';
const T1 = '2026-06-01T14:02:10.000Z';
const T2 = '2026-06-01T14:05:45.000Z';
// matches TTL: epoch seconds for 2026-09-01T00:00:00Z (far enough out that
// DynamoDB Local's TTL sweep never deletes it mid-demo).
const MATCH_EXPIRES_AT = 1_787_270_400;

const IDS = {
  tenant: 'contact-tenant-0001',
  landlord: 'contact-landlord-0001',
  haStaffer: 'contact-hastaff-0001',
  unitA: 'unit-0001',
  unitB: 'unit-0002',
  conversation: 'conv-0001',
  case: 'case-0001',
  invoice: 'invoice-0001',
  founder: 'user-0001',
  va: 'user-0002',
} as const;

/** table base name -> items. Document-style: only keys/GSI attrs contractual. */
const SEED: Record<string, Record<string, unknown>[]> = {
  contacts: [
    {
      contactId: IDS.tenant,
      type: 'tenant', // byTypeStatus HASH
      status: 'active', // byTypeStatus RANGE
      phone: '+15550100001', // byPhone
      housing_authority: 'atlanta_housing', // byHousingAuthority (tenants only)
      first_name: 'Tasha',
      last_name: 'Nguyen',
      voucher_size: 2,
      voucher_program: 'HCV',
      rta_in_hand: true,
      rta_expiration_date: '2026-08-15',
      caseworker: 'D. Okafor',
      preferences_notes: 'Ground floor preferred; near MARTA.',
      created_at: T0,
    },
    {
      contactId: IDS.landlord,
      type: 'landlord',
      status: 'active',
      phone: '+15550100002',
      first_name: 'Marcus',
      last_name: 'Bell',
      lead_status: 'registered',
      contract_status: 'signed',
      authorities_served: ['atlanta_housing', 'ga_dca'],
      created_at: T0,
    },
    {
      contactId: IDS.haStaffer,
      type: 'housing_authority_staff',
      status: 'active',
      phone: '+15550100003',
      first_name: 'Renee',
      last_name: 'Carter',
      housing_authority: 'atlanta_housing',
      role_title: 'HCV Program Specialist',
      created_at: T0,
    },
  ],
  units: [
    {
      unitId: IDS.unitA,
      landlordId: IDS.landlord, // byLandlord
      status: 'active', // byStatus
      jurisdiction: 'atlanta_housing', // byJurisdiction
      address: '1450 Joseph E. Boone Blvd NW, Atlanta, GA 30314',
      bedrooms: 2,
      rent: 1650,
      deposit: 1650,
      pets_allowed: false,
      tour_process: 'Text landlord; lockbox tours weekdays 9-5.',
      created_at: T0,
    },
    {
      unitId: IDS.unitB,
      landlordId: IDS.landlord,
      status: 'pending_inspection',
      jurisdiction: 'ga_dca',
      address: '88 Sycamore St, Decatur, GA 30030',
      bedrooms: 3,
      rent: 1975,
      deposit: 1975,
      pets_allowed: true,
      created_at: T0,
    },
  ],
  conversations: [
    {
      conversationId: IDS.conversation,
      participant_phone: '+15550100001', // byParticipantPhone (the tenant)
      status: 'open', // byLastActivity HASH
      last_activity_at: T2, // byLastActivity RANGE
      type: 'tenant_1to1',
      participants: [IDS.tenant],
      last_message_preview: 'Saturday morning works great, thank you!',
      created_at: T0,
    },
  ],
  messages: [
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T0}#msg-0001`, // SK value shape: <ISO ts>#<msgId> (doc: ts#msgId)
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Hi Tasha! A 2BR near MARTA just opened up — want to tour it this week?',
      ts: T0,
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T1}#msg-0002`,
      type: 'sms',
      direction: 'inbound',
      author: 'tenant',
      body: 'Yes! Could we do Saturday morning?',
      ts: T1,
    },
    {
      conversationId: IDS.conversation,
      tsMsgId: `${T2}#msg-0003`,
      type: 'sms',
      direction: 'outbound',
      author: 'teammate',
      body: 'Booked: Saturday 6/13 at 10am. Address: 1450 Joseph E. Boone Blvd NW.',
      ts: T2,
    },
  ],
  matches: [
    {
      tenantId: IDS.tenant,
      unitId: IDS.unitA, // byUnit
      fit_score: 0.91,
      approval_likelihood: 0.84,
      rank: 1,
      status: 'shared',
      portability_required: false,
      expires_at: MATCH_EXPIRES_AT, // TTL attribute (epoch seconds)
      generated_at: T0,
    },
  ],
  cases: [
    {
      caseId: IDS.case,
      tenantId: IDS.tenant, // byTenant
      unitId: IDS.unitA, // byUnit
      stage: 'touring', // byStage
      tour_date: '2026-06-13', // byTourDate (sparse — present because scheduled)
      next_deadline_type: 'tour_reminder', // byNextDeadline HASH (sparse)
      next_deadline_at: '2026-06-13T13:00:00.000Z', // byNextDeadline RANGE
      group_thread: IDS.conversation,
      tour_history: [{ scheduled_for: '2026-06-13T14:00:00.000Z', status: 'scheduled' }],
      created_at: T2,
    },
  ],
  invoices: [
    {
      invoiceId: IDS.invoice,
      landlordId: IDS.landlord, // byLandlord
      status: 'sent', // byStatus
      amount_cents: 165000, // one month's determined rent
      caseId: IDS.case,
      due_at: '2026-07-01',
      sent_at: T2,
    },
  ],
  users: [
    {
      userId: IDS.founder,
      email: 'founder@example.com', // byEmail
      role: 'founder_admin',
      google_sub: 'google-oauth2|seed-founder',
      scopes: ['*'],
      created_at: T0,
    },
    {
      userId: IDS.va,
      email: 'va@example.com',
      role: 'va',
      google_sub: 'google-oauth2|seed-va',
      scopes: ['conversations:rw', 'contacts:rw'],
      created_at: T0,
    },
  ],
  audit_events: [
    {
      entityKey: `cases#${IDS.case}`,
      ts: T2, // table SK + byActor RANGE
      actorId: IDS.founder, // byActor HASH
      action: 'case.stage_changed',
      detail: { from: 'interested', to: 'touring' },
    },
    {
      entityKey: `contacts#${IDS.tenant}`,
      ts: T1,
      actorId: IDS.va,
      action: 'contact.profile_edited',
      detail: { field: 'preferences_notes' },
    },
  ],
};

export async function seedAll(endpoint: string): Promise<number> {
  const doc = createDocumentClient({ endpoint });
  let count = 0;
  try {
    for (const [base, items] of Object.entries(SEED)) {
      const physicalName = tableName(base);
      for (const item of items) {
        await doc.send(new PutCommand({ TableName: physicalName, Item: item }));
        count += 1;
      }
      console.log(`  seeded   ${physicalName}: ${items.length} item${items.length === 1 ? '' : 's'}`);
    }
  } finally {
    doc.destroy();
  }
  return count;
}
