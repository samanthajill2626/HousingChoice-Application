import {
  LANDLORD_STATUSES,
  LISTING_STATUSES,
  PLACEMENT_STAGES,
  TENANT_STATUSES,
} from '../statusModel.js';
import { TOUR_STATUSES, TOUR_TYPES } from '../toursModel.js';
import { conversationIdForGroup } from '../import/ids.js';
import { TEAM_SENDER_KEY } from '../../jobs/relayFanOut.js';
import type { BroadcastItem, BroadcastRecipient, BroadcastStats } from '../../repos/broadcastsRepo.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationType,
} from '../../repos/conversationsRepo.js';
import type { MessageItem } from '../../repos/messagesRepo.js';
import type { PlacementItem } from '../../repos/placementsRepo.js';
import type { TourItem } from '../../repos/toursRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import type { UnmatchedEmailItem } from '../../repos/unmatchedEmailRepo.js';

export const PERFORMANCE_SEED_BOUNDS = Object.freeze({
  scale: Object.freeze({ min: 1, max: 100 }),
  entityCount: Object.freeze({ min: 0, max: 20_000 }),
  messagesPerConversation: Object.freeze({ min: 0, max: 100 }),
  longConversationMessages: Object.freeze({ min: 0, max: 20_000 }),
  recipientsPerBroadcast: Object.freeze({ min: 0, max: 1_000 }),
  largeBroadcastRecipients: Object.freeze({ min: 0, max: 1_000 }),
  nativeGroups: Object.freeze({ min: 0, max: 20_000 }),
  relayGroups: Object.freeze({ max: 1_000 }),
  totalItems: Object.freeze({ max: 250_000 }),
});

export const PERFORMANCE_SEED_BASE = Object.freeze({
  contacts: 100,
  units: 16,
  placements: 50,
  tours: 50,
  conversations: 100,
  nativeGroups: 21,
  messagesPerConversation: 10,
  broadcasts: 10,
  recipientsPerBroadcast: 25,
});

export interface PerformanceSeedInput {
  scale?: number;
  contacts?: number;
  units?: number;
  placements?: number;
  tours?: number;
  conversations?: number;
  nativeGroups?: number;
  messagesPerConversation?: number;
  longConversationMessages?: number;
  broadcasts?: number;
  recipientsPerBroadcast?: number;
  largeBroadcastRecipients?: number;
}

export interface PerformanceSeedFallbacks {
  tenant: 'lean_tenant';
  landlord: 'lean_landlord';
  unit: 'lean_unit';
}

export interface ResolvedPerformanceSeedConfig {
  anchor: string;
  scale: number;
  contacts: number;
  units: number;
  placements: number;
  tours: number;
  conversations: number;
  requestedNativeGroups: number;
  nativeGroups: number;
  nativeGroupCapacity: number;
  nativeGroupRosterSizes: readonly number[];
  nativeGroupMemberSlotCount: number;
  totalConversations: number;
  tenantCount: number;
  landlordCount: number;
  unknownCount: number;
  activeTenantCount: number;
  activeLandlordCount: number;
  activeUnknownCount: number;
  activeContactCount: number;
  deletedContactCount: number;
  messagesPerConversation: number;
  requestedLongConversationMessages: number;
  resolvedLongConversationMessages: number;
  longConversationFixturePresent: boolean;
  ordinaryMessageCount: number;
  tailMessageCount: number;
  totalMessageCount: number;
  broadcasts: number;
  recipientsPerBroadcast: number;
  requestedLargeBroadcastRecipients: number;
  resolvedLargeBroadcastRecipients: number;
  clippedLargeBroadcastRecipients: number;
  largeBroadcastFixturePresent: boolean;
  recipientPoolSize: number;
  recipientPoolSource: 'generated_tenants' | 'lean_tenant';
  messageCount: number;
  requestedRecipientCount: number;
  resolvedRecipientsPerBroadcast: number;
  requestedOrdinaryRecipientCount: number;
  resolvedOrdinaryRecipientCount: number;
  clippedOrdinaryRecipientCount: number;
  resolvedRecipientCount: number;
  totalRecipientCount: number;
  requestedRelayGroupCount: number;
  relayGroupCount: number;
  clippedRelayGroupCount: number;
  fixedUnmatchedEmailCount: 4;
  physicalItemCount: number;
  totalItemCount: number;
  fallbacks: PerformanceSeedFallbacks;
}

export type PerformanceSeedManifest = ResolvedPerformanceSeedConfig;

export interface PerformanceSeedTables {
  contacts: ContactItem[];
  units: UnitItem[];
  placements: PlacementItem[];
  tours: TourItem[];
  conversations: ConversationItem[];
  messages: MessageItem[];
  broadcasts: BroadcastItem[];
  unmatched_email: UnmatchedEmailItem[];
}

export interface GeneratedPerformanceSeed {
  tables: PerformanceSeedTables;
  manifest: PerformanceSeedManifest;
}

export interface PerformanceSelfQaFixtures {
  contact_detail: string;
  conversation_detail: string;
  inbox_row: string;
  unmatched_email: string;
  tour_group: string;
  placement_group: string;
}

const FALLBACKS: PerformanceSeedFallbacks = Object.freeze({
  tenant: 'lean_tenant',
  landlord: 'lean_landlord',
  unit: 'lean_unit',
});

const FIXED_UNMATCHED_EMAIL_COUNT = 4 as const;

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer within its allowed bounds`);
  }
  return value;
}

function normalizedAnchor(anchor: string | undefined, now: () => Date): string {
  const candidate = anchor ?? now().toISOString();
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) throw new Error('anchor must be an ISO timestamp');
  return new Date(timestamp).toISOString();
}

function scaledOrOverride(
  name: string,
  override: number | undefined,
  base: number,
  scale: number,
): number {
  return boundedInteger(
    name,
    override ?? base * scale,
    PERFORMANCE_SEED_BOUNDS.entityCount.min,
    PERFORMANCE_SEED_BOUNDS.entityCount.max,
  );
}

interface ContactTypeCounts {
  tenant: number;
  landlord: number;
  unknown: number;
}

function resolvedContactTypeCounts(contacts: number): ContactTypeCounts {
  const landlord = Math.floor((contacts * 4) / 100);
  const unknown = Math.floor(contacts / 100);
  return { tenant: contacts - landlord - unknown, landlord, unknown };
}

function deletedCount(start: number, count: number): number {
  if (count === 0) return 0;
  return Math.floor((start + count - 1) / 7) - Math.floor((start - 1) / 7);
}

export function saturatedCombination(n: number, k: number, cap: number): number {
  if (k > n) return 0;
  let value = 1n;
  const bounded = BigInt(cap);
  for (let i = 1; i <= k; i += 1) {
    value = (value * BigInt(n - k + i)) / BigInt(i);
    if (value >= bounded) return cap;
  }
  return Number(value);
}

export function nativeGroupCapacity(activeContacts: number): number {
  let total = 0;
  for (const size of [2, 3, 4] as const) {
    total = Math.min(
      PERFORMANCE_SEED_BOUNDS.entityCount.max,
      total + saturatedCombination(activeContacts, size, PERFORMANCE_SEED_BOUNDS.entityCount.max),
    );
  }
  return total;
}

function nativeGroupRosterSizes(activeContacts: number, nativeGroups: number): readonly number[] {
  const remaining = ([2, 3, 4] as const).map((size) =>
    saturatedCombination(activeContacts, size, PERFORMANCE_SEED_BOUNDS.entityCount.max),
  );
  const sizes: number[] = [];
  while (sizes.length < nativeGroups) {
    let selected = false;
    for (let index = 0; index < remaining.length && sizes.length < nativeGroups; index += 1) {
      const capacity = remaining[index] ?? 0;
      if (capacity === 0) continue;
      sizes.push(index + 2);
      remaining[index] = capacity - 1;
      selected = true;
    }
    if (!selected) break;
  }
  return Object.freeze(sizes);
}

export function resolvePerformanceSeedConfig(
  input: PerformanceSeedInput = {},
  anchor?: string,
  now: () => Date = () => new Date(),
): ResolvedPerformanceSeedConfig {
  const scale = boundedInteger(
    'scale',
    input.scale ?? 1,
    PERFORMANCE_SEED_BOUNDS.scale.min,
    PERFORMANCE_SEED_BOUNDS.scale.max,
  );
  const contacts = scaledOrOverride('contacts', input.contacts, PERFORMANCE_SEED_BASE.contacts, scale);
  const units = scaledOrOverride('units', input.units, PERFORMANCE_SEED_BASE.units, scale);
  const placements = scaledOrOverride(
    'placements',
    input.placements,
    PERFORMANCE_SEED_BASE.placements,
    scale,
  );
  const tours = scaledOrOverride('tours', input.tours, PERFORMANCE_SEED_BASE.tours, scale);
  const conversations = scaledOrOverride(
    'conversations',
    input.conversations,
    PERFORMANCE_SEED_BASE.conversations,
    scale,
  );
  const nativeGroups = scaledOrOverride(
    'nativeGroups',
    input.nativeGroups,
    PERFORMANCE_SEED_BASE.nativeGroups,
    scale,
  );
  const broadcasts = scaledOrOverride(
    'broadcasts',
    input.broadcasts,
    PERFORMANCE_SEED_BASE.broadcasts,
    scale,
  );
  const messagesPerConversation = boundedInteger(
    'messagesPerConversation',
    input.messagesPerConversation ?? PERFORMANCE_SEED_BASE.messagesPerConversation,
    PERFORMANCE_SEED_BOUNDS.messagesPerConversation.min,
    PERFORMANCE_SEED_BOUNDS.messagesPerConversation.max,
  );
  const requestedLongConversationMessages = boundedInteger(
    'longConversationMessages',
    input.longConversationMessages ?? messagesPerConversation,
    PERFORMANCE_SEED_BOUNDS.longConversationMessages.min,
    PERFORMANCE_SEED_BOUNDS.longConversationMessages.max,
  );
  if (requestedLongConversationMessages < messagesPerConversation) {
    throw new Error('longConversationMessages must be at least messagesPerConversation');
  }
  const recipientsPerBroadcast = boundedInteger(
    'recipientsPerBroadcast',
    input.recipientsPerBroadcast ?? PERFORMANCE_SEED_BASE.recipientsPerBroadcast,
    PERFORMANCE_SEED_BOUNDS.recipientsPerBroadcast.min,
    PERFORMANCE_SEED_BOUNDS.recipientsPerBroadcast.max,
  );
  const requestedLargeBroadcastRecipients = boundedInteger(
    'largeBroadcastRecipients',
    input.largeBroadcastRecipients ?? recipientsPerBroadcast,
    PERFORMANCE_SEED_BOUNDS.largeBroadcastRecipients.min,
    PERFORMANCE_SEED_BOUNDS.largeBroadcastRecipients.max,
  );
  if (requestedLargeBroadcastRecipients < recipientsPerBroadcast) {
    throw new Error('largeBroadcastRecipients must be at least recipientsPerBroadcast');
  }

  const contactTypes = resolvedContactTypeCounts(contacts);
  const deletedTenantCount = deletedCount(0, contactTypes.tenant);
  const deletedLandlordCount = deletedCount(contactTypes.tenant, contactTypes.landlord);
  const deletedUnknownCount = deletedCount(
    contactTypes.tenant + contactTypes.landlord,
    contactTypes.unknown,
  );
  const activeTenantCount = contactTypes.tenant - deletedTenantCount;
  const activeLandlordCount = contactTypes.landlord - deletedLandlordCount;
  const activeUnknownCount = contactTypes.unknown - deletedUnknownCount;
  const activeContactCount = activeTenantCount + activeLandlordCount + activeUnknownCount;
  const deletedContactCount = contacts - activeContactCount;
  const nativeGroupCapacityValue = nativeGroupCapacity(activeContactCount);
  if (nativeGroups > nativeGroupCapacityValue) {
    throw new Error('nativeGroups exceeds active generated contact roster capacity');
  }
  const nativeGroupRosterSizesValue = nativeGroupRosterSizes(activeContactCount, nativeGroups);
  const nativeGroupMemberSlotCount = nativeGroupRosterSizesValue.reduce((total, size) => total + size, 0);
  const totalConversations = conversations + nativeGroups;
  const longConversationFixturePresent = conversations > 0;
  const resolvedLongConversationMessages = longConversationFixturePresent
    ? requestedLongConversationMessages
    : 0;
  const ordinaryMessageCount =
    (totalConversations - (longConversationFixturePresent ? 1 : 0)) * messagesPerConversation;
  const tailMessageCount = resolvedLongConversationMessages;
  const totalMessageCount = ordinaryMessageCount + tailMessageCount;
  const messageCount = totalMessageCount;
  const requestedRecipientCount = broadcasts * recipientsPerBroadcast;
  const recipientPoolSize = activeTenantCount === 0 ? 1 : activeTenantCount;
  const recipientPoolSource = activeTenantCount === 0 ? 'lean_tenant' as const : 'generated_tenants' as const;
  const resolvedRecipientsPerBroadcast = Math.min(recipientsPerBroadcast, recipientPoolSize);
  const largeBroadcastFixturePresent = broadcasts > 0;
  const resolvedLargeBroadcastRecipients = largeBroadcastFixturePresent
    ? Math.min(requestedLargeBroadcastRecipients, recipientPoolSize)
    : 0;
  const clippedLargeBroadcastRecipients = requestedLargeBroadcastRecipients - resolvedLargeBroadcastRecipients;
  const totalRecipientCount = largeBroadcastFixturePresent
    ? (broadcasts - 1) * resolvedRecipientsPerBroadcast + resolvedLargeBroadcastRecipients
    : 0;
  const requestedOrdinaryRecipientCount = largeBroadcastFixturePresent
    ? (broadcasts - 1) * recipientsPerBroadcast
    : 0;
  const resolvedOrdinaryRecipientCount = largeBroadcastFixturePresent
    ? (broadcasts - 1) * resolvedRecipientsPerBroadcast
    : 0;
  const clippedOrdinaryRecipientCount =
    requestedOrdinaryRecipientCount - resolvedOrdinaryRecipientCount;
  const resolvedRecipientCount = totalRecipientCount;
  const requestedRelayGroupCount = conversations === 0 ? 0 : Math.max(1, Math.floor(conversations / 5));
  const relayGroupCount = Math.min(
    requestedRelayGroupCount,
    PERFORMANCE_SEED_BOUNDS.relayGroups.max,
  );
  const clippedRelayGroupCount = requestedRelayGroupCount - relayGroupCount;
  const physicalItemCount =
    contacts +
    units +
    placements +
    tours +
    totalConversations +
    totalMessageCount +
    broadcasts +
    FIXED_UNMATCHED_EMAIL_COUNT;
  const totalItemCount = physicalItemCount + nativeGroupMemberSlotCount + totalRecipientCount;
  if (totalItemCount > PERFORMANCE_SEED_BOUNDS.totalItems.max) {
    throw new Error('totalItemCount exceeds its allowed bound');
  }

  return Object.freeze({
    anchor: normalizedAnchor(anchor, now),
    scale,
    contacts,
    units,
    placements,
    tours,
    conversations,
    requestedNativeGroups: nativeGroups,
    nativeGroups,
    nativeGroupCapacity: nativeGroupCapacityValue,
    nativeGroupRosterSizes: nativeGroupRosterSizesValue,
    nativeGroupMemberSlotCount,
    totalConversations,
    tenantCount: contactTypes.tenant,
    landlordCount: contactTypes.landlord,
    unknownCount: contactTypes.unknown,
    activeTenantCount,
    activeLandlordCount,
    activeUnknownCount,
    activeContactCount,
    deletedContactCount,
    messagesPerConversation,
    requestedLongConversationMessages,
    resolvedLongConversationMessages,
    longConversationFixturePresent,
    ordinaryMessageCount,
    tailMessageCount,
    totalMessageCount,
    broadcasts,
    recipientsPerBroadcast,
    requestedLargeBroadcastRecipients,
    resolvedLargeBroadcastRecipients,
    clippedLargeBroadcastRecipients,
    largeBroadcastFixturePresent,
    recipientPoolSize,
    recipientPoolSource,
    messageCount,
    requestedRecipientCount,
    resolvedRecipientsPerBroadcast,
    requestedOrdinaryRecipientCount,
    resolvedOrdinaryRecipientCount,
    clippedOrdinaryRecipientCount,
    resolvedRecipientCount,
    totalRecipientCount,
    requestedRelayGroupCount,
    relayGroupCount,
    clippedRelayGroupCount,
    fixedUnmatchedEmailCount: FIXED_UNMATCHED_EMAIL_COUNT,
    physicalItemCount,
    totalItemCount,
    fallbacks: FALLBACKS,
  });
}

export function toPerformanceSeedManifest(
  config: ResolvedPerformanceSeedConfig,
): PerformanceSeedManifest {
  return {
    anchor: config.anchor,
    scale: config.scale,
    contacts: config.contacts,
    units: config.units,
    placements: config.placements,
    tours: config.tours,
    conversations: config.conversations,
    requestedNativeGroups: config.requestedNativeGroups,
    nativeGroups: config.nativeGroups,
    nativeGroupCapacity: config.nativeGroupCapacity,
    nativeGroupRosterSizes: [...config.nativeGroupRosterSizes],
    nativeGroupMemberSlotCount: config.nativeGroupMemberSlotCount,
    totalConversations: config.totalConversations,
    tenantCount: config.tenantCount,
    landlordCount: config.landlordCount,
    unknownCount: config.unknownCount,
    activeTenantCount: config.activeTenantCount,
    activeLandlordCount: config.activeLandlordCount,
    activeUnknownCount: config.activeUnknownCount,
    activeContactCount: config.activeContactCount,
    deletedContactCount: config.deletedContactCount,
    messagesPerConversation: config.messagesPerConversation,
    requestedLongConversationMessages: config.requestedLongConversationMessages,
    resolvedLongConversationMessages: config.resolvedLongConversationMessages,
    longConversationFixturePresent: config.longConversationFixturePresent,
    ordinaryMessageCount: config.ordinaryMessageCount,
    tailMessageCount: config.tailMessageCount,
    totalMessageCount: config.totalMessageCount,
    broadcasts: config.broadcasts,
    recipientsPerBroadcast: config.recipientsPerBroadcast,
    requestedLargeBroadcastRecipients: config.requestedLargeBroadcastRecipients,
    resolvedLargeBroadcastRecipients: config.resolvedLargeBroadcastRecipients,
    clippedLargeBroadcastRecipients: config.clippedLargeBroadcastRecipients,
    largeBroadcastFixturePresent: config.largeBroadcastFixturePresent,
    recipientPoolSize: config.recipientPoolSize,
    recipientPoolSource: config.recipientPoolSource,
    messageCount: config.messageCount,
    requestedRecipientCount: config.requestedRecipientCount,
    resolvedRecipientsPerBroadcast: config.resolvedRecipientsPerBroadcast,
    requestedOrdinaryRecipientCount: config.requestedOrdinaryRecipientCount,
    resolvedOrdinaryRecipientCount: config.resolvedOrdinaryRecipientCount,
    clippedOrdinaryRecipientCount: config.clippedOrdinaryRecipientCount,
    resolvedRecipientCount: config.resolvedRecipientCount,
    totalRecipientCount: config.totalRecipientCount,
    requestedRelayGroupCount: config.requestedRelayGroupCount,
    relayGroupCount: config.relayGroupCount,
    clippedRelayGroupCount: config.clippedRelayGroupCount,
    fixedUnmatchedEmailCount: config.fixedUnmatchedEmailCount,
    physicalItemCount: config.physicalItemCount,
    totalItemCount: config.totalItemCount,
    fallbacks: {
      tenant: config.fallbacks.tenant,
      landlord: config.fallbacks.landlord,
      unit: config.fallbacks.unit,
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const LEAN_TENANT_ID = 'contact-tenant-0001';
const LEAN_LANDLORD_ID = 'contact-landlord-0001';
const LEAN_UNIT_ID = 'unit-0001';
const LEAN_TENANT_PHONE = '+15550100001';
const LEAN_LANDLORD_PHONE = '+15550100002';

function padded(index: number, width = 5): string {
  return String(index).padStart(width, '0');
}

function performanceId(kind: string, index: number): string {
  return `perf-${kind}-${padded(index)}`;
}

function contactPhone(index: number): string {
  return `+1555${padded(1_000_000 + index, 7)}`;
}

function relayPhone(index: number): string {
  return `+1555${padded(2_000_000 + index, 7)}`;
}

function at(anchorMs: number, offsetMs: number): string {
  return new Date(anchorMs + offsetMs).toISOString();
}

function contactTypeAndOrdinal(index: number, counts: ContactTypeCounts): {
  type: 'tenant' | 'landlord' | 'unknown';
  ordinal: number;
} {
  if (index < counts.tenant) return { type: 'tenant', ordinal: index };
  if (index < counts.tenant + counts.landlord) {
    return { type: 'landlord', ordinal: index - counts.tenant };
  }
  return { type: 'unknown', ordinal: index - counts.tenant - counts.landlord };
}

function buildContact(index: number, anchorMs: number, counts: ContactTypeCounts): ContactItem {
  const { type, ordinal } = contactTypeAndOrdinal(index, counts);
  const phone = contactPhone(index);
  const email = `perf-contact-${padded(index)}@example.test`;
  const status =
    type === 'tenant'
      ? TENANT_STATUSES[ordinal % TENANT_STATUSES.length]!
      : type === 'landlord'
        ? LANDLORD_STATUSES[ordinal % LANDLORD_STATUSES.length]!
        : ordinal % 2 === 0
          ? 'needs_review'
          : 'active';
  return {
    contactId: performanceId('contact', index),
    type,
    status,
    phone,
    phones: [{ phone, primary: true }],
    email,
    emails: [{ email, primary: true }],
    firstName: `Perf${padded(index)}`,
    lastName: 'Contact',
    created_at: at(anchorMs, -(index + 60) * MINUTE_MS),
    ...(type === 'tenant' && {
      housingAuthority: ordinal % 2 === 0 ? 'Atlanta Housing Authority' : 'Georgia DCA',
      voucherSize: 1 + (ordinal % 4),
      consent_method: 'imported',
      consent_at: at(anchorMs, -(index + 60) * MINUTE_MS),
    }),
    ...(type === 'landlord' && {
      consent_method: 'imported',
      consent_at: at(anchorMs, -(index + 60) * MINUTE_MS),
    }),
    ...(index % 7 === 0 && { deleted_at: at(anchorMs, -index * MINUTE_MS) }),
  } satisfies ContactItem;
}

function buildUnit(
  index: number,
  anchorMs: number,
  landlordIds: readonly string[],
): UnitItem {
  const landlordId = landlordIds[index % landlordIds.length] ?? LEAN_LANDLORD_ID;
  return {
    unitId: performanceId('unit', index),
    landlordId,
    status: LISTING_STATUSES[index % LISTING_STATUSES.length]!,
    accepted_authorities: [index % 2 === 0 ? 'Atlanta Housing Authority' : 'Georgia DCA'],
    address: {
      line1: `${1000 + index} Performance Way`,
      line2: `Unit ${index + 1}`,
      city: 'Atlanta',
      state: 'GA',
      zip: padded(30_300 + (index % 600), 5),
    },
    beds: 1 + (index % 4),
    baths: 1 + (index % 3),
    rent_min: 1_100 + (index % 10) * 75,
    rent_max: 1_100 + (index % 10) * 75,
    primary_contact: landlordId,
    contacts: [{ contactId: landlordId, role: 'landlord', primaryContact: true }],
    ...(index % 5 === 0 && { propertyId: performanceId('property', Math.floor(index / 5)) }),
    ...(index % 7 === 0 && { deleted_at: at(anchorMs, -index * MINUTE_MS) }),
    created_at: at(anchorMs, -(index + 90) * MINUTE_MS),
    updated_at: at(anchorMs, -index * MINUTE_MS),
  } satisfies UnitItem;
}

function buildPlacement(
  index: number,
  anchorMs: number,
  tenantIds: readonly string[],
  unitIds: readonly string[],
): PlacementItem {
  const isStuck = index % 13 === 3;
  const stage = PLACEMENT_STAGES[index % PLACEMENT_STAGES.length]!;
  const hasAttention = stage !== 'moved_in' && stage !== 'lost' && index % 11 === 2;
  return {
    placementId: performanceId('placement', index),
    tenantId: tenantIds[index % tenantIds.length] ?? LEAN_TENANT_ID,
    unitId: unitIds[index % unitIds.length] ?? LEAN_UNIT_ID,
    stage,
    stage_entered_at: at(anchorMs, isStuck ? -45 * DAY_MS : -(index + 1) * 60 * MINUTE_MS),
    stage_source: 'manual',
    created_at: at(anchorMs, -(index + 60) * DAY_MS),
    updated_at: at(anchorMs, -index * MINUTE_MS),
    ...(hasAttention && {
      attention: { reason: 'Synthetic follow-up required', at: new Date(anchorMs).toISOString() },
    }),
    ...(index === 1 && { group_thread: performanceId('conversation', 20) }),
  } satisfies PlacementItem;
}

function buildTour(
  index: number,
  anchorMs: number,
  tenantIds: readonly string[],
  unitIds: readonly string[],
  guaranteeScheduled: boolean,
): TourItem {
  const status = guaranteeScheduled && index === 0
    ? 'scheduled'
    : TOUR_STATUSES[index % TOUR_STATUSES.length]!;
  const scheduledAt =
    (guaranteeScheduled && index === 0) || index === 1
      ? new Date(anchorMs).toISOString()
      : at(anchorMs, ((index % 29) + 1) * DAY_MS + (index % 8) * 60 * MINUTE_MS);
  return {
    tourId: performanceId('tour', index),
    tenantId: tenantIds[index % tenantIds.length] ?? LEAN_TENANT_ID,
    unitId: unitIds[index % unitIds.length] ?? LEAN_UNIT_ID,
    _schedPartition: 'tours',
    tourType: TOUR_TYPES[index % TOUR_TYPES.length]!,
    status,
    ...(status !== 'requested' && { scheduledAt }),
    ...(index === 1 && { groupThreadId: performanceId('conversation', 10) }),
    ...(status === 'closed' && {
      outcome: index % 2 === 0 ? 'move_forward' : 'not_a_fit',
      moveForward: index % 2 === 0,
      convertible: index % 2 === 0,
    }),
    createdAt: at(anchorMs, -(index + 30) * DAY_MS),
    updatedAt: at(anchorMs, -index * MINUTE_MS),
  } satisfies TourItem;
}

interface ContactReference {
  contactId: string;
  phone: string;
}

interface NativeContactReference extends ContactReference {
  type: 'tenant' | 'landlord' | 'unknown';
}

function generatedReferences(
  contacts: readonly ContactItem[],
  type: 'tenant' | 'landlord' | 'unknown',
): ContactReference[] {
  return contacts
    .filter((contact) => contact.type === type)
    .map((contact) => ({ contactId: contact.contactId, phone: contact.phone ?? LEAN_TENANT_PHONE }));
}

function activeNativeReferences(contacts: readonly ContactItem[]): NativeContactReference[] {
  return contacts.flatMap((contact) => {
    if (
      contact.deleted_at !== undefined ||
      (contact.type !== 'tenant' && contact.type !== 'landlord' && contact.type !== 'unknown') ||
      !contact.phone
    ) {
      return [];
    }
    return [{ contactId: contact.contactId, phone: contact.phone, type: contact.type }];
  });
}

interface LexicographicCombinationIterator<T> {
  readonly exhausted: boolean;
  next(): readonly T[] | undefined;
}

interface NativeRosterSelectionObserver {
  onNativeRosterVisited?(): void;
  onNativeRosterMaterialized?(roster: readonly NativeContactReference[]): void;
}

function lexicographicCombinationIterator(
  values: readonly NativeContactReference[],
  size: number,
  observer?: NativeRosterSelectionObserver,
): LexicographicCombinationIterator<NativeContactReference> {
  let indices: number[] | undefined = values.length >= size
    ? Array.from({ length: size }, (_, index) => index)
    : undefined;
  return {
    get exhausted() {
      return indices === undefined;
    },
    next() {
      if (!indices) return undefined;
      const selected = indices.map((index) => values[index]!);
      observer?.onNativeRosterVisited?.();
      observer?.onNativeRosterMaterialized?.(selected);
      let cursor = indices.length - 1;
      while (cursor >= 0 && indices[cursor] === values.length - size + cursor) cursor -= 1;
      if (cursor < 0) {
        indices = undefined;
      } else {
        indices[cursor] = (indices[cursor] ?? 0) + 1;
        for (let index = cursor + 1; index < indices.length; index += 1) {
          indices[index] = (indices[index - 1] ?? 0) + 1;
        }
      }
      return selected;
    },
  };
}

function selectNativeRosters(
  contacts: readonly NativeContactReference[],
  nativeGroups: number,
  observer?: NativeRosterSelectionObserver,
): readonly (readonly NativeContactReference[])[] {
  const rotation = ([2, 3, 4] as const)
    .map((size) => ({ size, iterator: lexicographicCombinationIterator(contacts, size, observer) }))
    .filter((entry) => !entry.iterator.exhausted);
  const rosters: (readonly NativeContactReference[])[] = [];
  let cursor = 0;
  while (rosters.length < nativeGroups && rotation.length > 0) {
    const entry = rotation[cursor]!;
    const roster = entry.iterator.next();
    if (!roster) throw new Error('native roster iterator exhausted before selection completed');
    rosters.push(roster);
    if (entry.iterator.exhausted) {
      rotation.splice(cursor, 1);
      if (rotation.length > 0) cursor %= rotation.length;
    } else {
      cursor = (cursor + 1) % rotation.length;
    }
  }
  if (rosters.length !== nativeGroups) throw new Error('native roster selection did not satisfy configuration');
  return rosters;
}

function oneToOneType(index: number): ConversationType {
  if (index === 1 || index === 2) return 'tenant_1to1';
  const types: readonly ConversationType[] = [
    'tenant_1to1',
    'landlord_1to1',
    'partner_1to1',
    'unknown_1to1',
  ];
  return types[index % types.length]!;
}

function oneToOneReference(
  index: number,
  type: ConversationType,
  tenants: readonly ContactReference[],
  landlords: readonly ContactReference[],
  unknowns: readonly ContactReference[],
): ContactReference {
  if (index === 1 && tenants[1]) return tenants[1];
  if (index === 2 && tenants[2]) return tenants[2];
  if (type === 'tenant_1to1') {
    return tenants[index % tenants.length] ?? { contactId: LEAN_TENANT_ID, phone: LEAN_TENANT_PHONE };
  }
  if (type === 'landlord_1to1') {
    return landlords[index % landlords.length] ?? {
      contactId: LEAN_LANDLORD_ID,
      phone: LEAN_LANDLORD_PHONE,
    };
  }
  return (
    unknowns[index % unknowns.length] ??
    tenants[index % tenants.length] ?? { contactId: LEAN_TENANT_ID, phone: LEAN_TENANT_PHONE }
  );
}

function buildConversation(
  index: number,
  anchorMs: number,
  relayGroupCount: number,
  contacts: readonly ContactItem[],
): ConversationItem {
  const tenants = generatedReferences(contacts, 'tenant');
  const landlords = generatedReferences(contacts, 'landlord');
  const unknowns = generatedReferences(contacts, 'unknown');
  const relayOrdinal = Math.floor(index / 5);
  const isRelay = index % 5 === 0 && relayOrdinal < relayGroupCount;
  const lastActivity = at(anchorMs, -index * MINUTE_MS);
  const common = {
    conversationId: performanceId('conversation', index),
    status: 'open',
    last_activity_at: lastActivity,
    ai_mode: 'manual',
    last_message_preview: `Synthetic message preview ${padded(index)}`,
    unread_count: index === 1 || index === 2 || index % 2 === 0 ? 2 : 0,
    created_at: at(anchorMs, -(index + 7) * DAY_MS),
  } as const;

  if (!isRelay) {
    const type = oneToOneType(index);
    const participant = oneToOneReference(index, type, tenants, landlords, unknowns);
    return {
      ...common,
      type,
      participant_phone: participant.phone,
      participant_display_name: `Synthetic participant ${padded(index)}`,
      participants: [{ contactId: participant.contactId, phone: participant.phone }],
    } satisfies ConversationItem;
  }

  const status = relayOrdinal % 2 === 0 ? 'open' : 'connecting';
  const tenant = tenants[relayOrdinal % tenants.length] ?? {
    contactId: LEAN_TENANT_ID,
    phone: LEAN_TENANT_PHONE,
  };
  const landlord = landlords[relayOrdinal % landlords.length] ?? {
    contactId: LEAN_LANDLORD_ID,
    phone: LEAN_LANDLORD_PHONE,
  };
  const participants: ConversationParticipant[] = [
    { contactId: tenant.contactId, phone: tenant.phone, name: 'Synthetic tenant' },
    { contactId: landlord.contactId, phone: landlord.phone, name: 'Synthetic landlord' },
  ];
  const owner =
    index === 10
      ? ({ type: 'tour', id: performanceId('tour', 1) } as const)
      : index === 20
        ? ({ type: 'placement', id: performanceId('placement', 1) } as const)
        : ({ type: null } as const);
  const poolNumber = relayPhone(relayOrdinal);
  return {
    ...common,
    type: 'relay_group',
    status,
    relay_status: `relay_group#${status}`,
    participants,
    participants_version: 0,
    owner,
    ...(owner.type === 'placement' && { placementId: owner.id }),
    ever_member_phones: participants.map((participant) => participant.phone),
    ...(status === 'open' && { pool_number: poolNumber, participant_phone: poolNumber }),
  } satisfies ConversationItem;
}

function buildNativeConversation(
  index: number,
  anchorMs: number,
  roster: readonly NativeContactReference[],
  conversationOffset: number,
): ConversationItem {
  const participants: ConversationParticipant[] = roster.map((contact) => ({
    contactId: contact.contactId,
    phone: contact.phone,
    name: `Synthetic ${contact.type}`,
  }));
  return {
    conversationId: conversationIdForGroup(participants.map((participant) => participant.phone)),
    type: 'group_text',
    status: 'group_open',
    ai_mode: 'manual',
    participants,
    last_activity_at: at(anchorMs, -(conversationOffset + index) * MINUTE_MS),
    last_message_preview: `Synthetic native group preview ${padded(index)}`,
    unread_count: index % 2 === 0 ? 2 : 0,
    created_at: at(anchorMs, -(index + 7) * DAY_MS),
  } satisfies ConversationItem;
}

function authorForConversation(conversation: ConversationItem, direction: 'inbound' | 'outbound'):
  MessageItem['author'] {
  if (direction === 'outbound') return 'teammate';
  if (conversation.type === 'tenant_1to1') return 'tenant';
  if (conversation.type === 'landlord_1to1') return 'landlord';
  if (conversation.type === 'partner_1to1') return 'partner';
  if (conversation.type === 'relay_group') return 'tenant';
  return 'unknown';
}

function buildMessage(
  conversation: ConversationItem,
  conversationIndex: number,
  messageIndex: number,
  messagesPerConversation: number,
): MessageItem {
  const lastActivityMs = Date.parse(conversation.last_activity_at);
  const createdAt = at(lastActivityMs, -(messagesPerConversation - messageIndex - 1) * MINUTE_MS);
  const messageId = `perf-msg-${padded(conversationIndex)}-${padded(messageIndex, 3)}`;
  const direction = messageIndex % 2 === 0 ? 'inbound' : 'outbound';
  return {
    conversationId: conversation.conversationId,
    tsMsgId: `${createdAt}#${messageId}`,
    type: 'sms',
    direction,
    author: authorForConversation(conversation, direction),
    body: `Synthetic performance message ${messageIndex + 1}`,
    provider_sid: `synthetic-provider-${padded(conversationIndex)}-${padded(messageIndex, 3)}`,
    provider_ts: createdAt,
    delivery_status: 'delivered',
    created_at: createdAt,
  } satisfies MessageItem;
}

function nativeAuthor(type: NativeContactReference['type']): MessageItem['author'] {
  if (type === 'tenant' || type === 'landlord') return type;
  return 'unknown';
}

function buildNativeMessage(
  conversation: ConversationItem,
  roster: readonly NativeContactReference[],
  conversationIndex: number,
  messageIndex: number,
  messagesPerConversation: number,
): MessageItem {
  const lastActivityMs = Date.parse(conversation.last_activity_at);
  const createdAt = at(lastActivityMs, -(messagesPerConversation - messageIndex - 1) * MINUTE_MS);
  const messageId = `perf-msg-${padded(conversationIndex)}-${padded(messageIndex, 3)}`;
  const direction = messageIndex % 2 === 0 ? 'inbound' : 'outbound';
  const sender = roster[messageIndex % roster.length];
  if (!sender) throw new Error('native conversation has no roster sender');
  return {
    conversationId: conversation.conversationId,
    tsMsgId: `${createdAt}#${messageId}`,
    type: 'sms',
    direction,
    author: direction === 'inbound' ? nativeAuthor(sender.type) : 'teammate',
    relay_sender_key: direction === 'inbound' ? `phone#${sender.phone}` : TEAM_SENDER_KEY,
    body: `Synthetic native group message ${messageIndex + 1}`,
    provider_sid: `synthetic-provider-${padded(conversationIndex)}-${padded(messageIndex, 3)}`,
    provider_ts: createdAt,
    delivery_status: 'delivered',
    created_at: createdAt,
  } satisfies MessageItem;
}

function recipientStatus(status: BroadcastItem['status']): BroadcastRecipient {
  if (status === 'sent') return { status: 'delivered' };
  if (status === 'failed') return { status: 'failed', errorCode: 'synthetic_failure' };
  return { status: 'queued' };
}

function statsForRecipients(
  status: BroadcastItem['status'],
  recipientCount: number,
): BroadcastStats {
  return {
    audience: recipientCount,
    queued: status === 'draft' || status === 'sending' ? recipientCount : 0,
    sending: 0,
    sent: 0,
    delivered: status === 'sent' ? recipientCount : 0,
    failed: status === 'failed' ? recipientCount : 0,
    skipped_opted_out: 0,
    skipped_no_consent: 0,
  };
}

function buildBroadcast(
  index: number,
  anchorMs: number,
  recipientPool: readonly string[],
  resolvedRecipientsPerBroadcast: number,
  unitIds: readonly string[],
): BroadcastItem {
  const statusCycle = ['failed', 'draft', 'sending', 'sent'] as const;
  const status = index === 0 ? 'sent' : statusCycle[(index - 1) % statusCycle.length]!;
  const recipients: Record<string, BroadcastRecipient> = {};
  for (let offset = 0; offset < resolvedRecipientsPerBroadcast; offset += 1) {
    const contactId = recipientPool[(index + offset) % recipientPool.length] ?? LEAN_TENANT_ID;
    recipients[contactId] = recipientStatus(status);
  }
  const recipientCount = Object.keys(recipients).length;
  return {
    broadcastId: performanceId('broadcast', index),
    created_by: 'user-0001',
    created_at: at(anchorMs, -index * MINUTE_MS),
    updated_at: at(anchorMs, -index * MINUTE_MS),
    _listPartition: 'broadcasts',
    status,
    unitId: unitIds[index % unitIds.length] ?? LEAN_UNIT_ID,
    audience_filter: {
      contact_type: 'tenant',
      excludeOptedOut: true,
      excludeUnreachable: true,
    },
    audience_mode: 'seeds_only',
    body_template: 'Synthetic performance property update.',
    stats: statsForRecipients(status, recipientCount),
    recipients,
    seed_contact_ids: Object.keys(recipients),
  } satisfies BroadcastItem;
}

function buildUnmatchedEmail(index: number, anchorMs: number): UnmatchedEmailItem {
  const status = index < 2 ? 'unmatched' : 'quarantined';
  return {
    unmatchedId: `um-${padded(index + 1, 32)}`,
    status,
    read: false,
    from: {
      name: `Synthetic sender ${index + 1}`,
      address: `perf-unmatched-${index + 1}@example.test`,
    },
    subject: `Synthetic unmatched message ${index + 1}`,
    snippet: 'Synthetic unmatched email preview.',
    text: 'Synthetic unmatched email body.',
    raw_ref: {
      bucket: 'synthetic-performance-mail',
      key: `performance/unmatched-${index + 1}.eml`,
    },
    attachments_meta: [],
    spam_verdict: status === 'quarantined' ? 'FAIL' : 'PASS',
    virus_verdict: 'PASS',
    received_at: at(anchorMs, -index * MINUTE_MS),
    ...(status === 'quarantined' && {
      expires_at: Math.floor((anchorMs + 90 * DAY_MS) / 1_000),
    }),
  } satisfies UnmatchedEmailItem;
}

function assertNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function validatePerformanceConversation(conversation: ConversationItem): void {
  if (
    !assertNonEmptyString(conversation.conversationId) ||
    !assertNonEmptyString(conversation.last_activity_at) ||
    !assertNonEmptyString(conversation.created_at) ||
    !Array.isArray(conversation.participants) ||
    conversation.participants.length === 0 ||
    conversation.participants.some(
      (participant) =>
        !assertNonEmptyString(participant.contactId) || !assertNonEmptyString(participant.phone),
    )
  ) {
    throw new Error('performance conversation has invalid required fields');
  }

  if (conversation.type === 'relay_group') {
    if (
      conversation.participants.length < 2 ||
      (conversation.status !== 'open' && conversation.status !== 'connecting') ||
      conversation.relay_status !== `relay_group#${conversation.status}` ||
      conversation.owner === undefined ||
      (conversation.owner.type !== null && !assertNonEmptyString(conversation.owner.id))
    ) {
      throw new Error('performance relay conversation has invalid roster or owner fields');
    }
    if (conversation.status === 'open') {
      if (
        !assertNonEmptyString(conversation.pool_number) ||
        conversation.participant_phone !== conversation.pool_number
      ) {
        throw new Error('performance relay conversation has invalid open pool fields');
      }
    } else if (
      conversation.pool_number !== undefined ||
      conversation.participant_phone !== undefined
    ) {
      throw new Error('performance relay conversation has invalid connecting pool fields');
    }
    return;
  }

  if (conversation.type === 'group_text') {
    if (
      conversation.status !== 'group_open' ||
      conversation.ai_mode !== 'manual' ||
      conversation.participants.length < 2 ||
      conversation.participant_phone !== undefined ||
      conversation.relay_status !== undefined ||
      conversation.pool_number !== undefined ||
      conversation.participants_version !== undefined ||
      conversation.relay_opted_out_members !== undefined ||
      conversation.close_nag_next_at !== undefined ||
      conversation.close_announced_at !== undefined ||
      conversation.placementId !== undefined ||
      conversation.owner !== undefined ||
      conversation.ever_member_phones !== undefined
    ) {
      throw new Error('performance native group conversation has invalid fields');
    }
    return;
  }

  if (
    conversation.status !== 'open' ||
    !assertNonEmptyString(conversation.participant_phone) ||
    conversation.relay_status !== undefined ||
    conversation.pool_number !== undefined ||
    conversation.participants.length !== 1
  ) {
    throw new Error('performance 1to1 conversation has invalid participant fields');
  }
}

export function generatePerformanceSeed(
  config: ResolvedPerformanceSeedConfig,
  observer?: NativeRosterSelectionObserver,
): GeneratedPerformanceSeed {
  const anchorMs = Date.parse(config.anchor);
  if (!Number.isFinite(anchorMs)) throw new Error('anchor must be an ISO timestamp');

  const contactTypes: ContactTypeCounts = {
    tenant: config.tenantCount,
    landlord: config.landlordCount,
    unknown: config.unknownCount,
  };
  const contacts = Array.from({ length: config.contacts }, (_, index) =>
    buildContact(index, anchorMs, contactTypes),
  );
  const tenantIds = contacts
    .filter((contact) => contact.type === 'tenant')
    .map((contact) => contact.contactId);
  const landlordIds = contacts
    .filter((contact) => contact.type === 'landlord')
    .map((contact) => contact.contactId);
  const units = Array.from({ length: config.units }, (_, index) =>
    buildUnit(index, anchorMs, landlordIds),
  );
  const unitIds = units.map((unit) => unit.unitId);
  const placements = Array.from({ length: config.placements }, (_, index) =>
    buildPlacement(index, anchorMs, tenantIds, unitIds),
  );
  const tours = Array.from({ length: config.tours }, (_, index) =>
    buildTour(index, anchorMs, tenantIds, unitIds, config.tours === 1),
  );
  const existingConversations = Array.from({ length: config.conversations }, (_, index) =>
    buildConversation(index, anchorMs, config.relayGroupCount, contacts),
  );
  const tailConversationId = config.longConversationFixturePresent
    ? existingConversations.find((conversation) => conversation.type === 'relay_group' && conversation.status === 'open')?.conversationId
    : undefined;
  const tailConversations = existingConversations.map((conversation) => {
    if (conversation.conversationId !== tailConversationId || config.resolvedLongConversationMessages === 0) {
      return conversation;
    }
    const oldestMessageMs = Date.parse(conversation.last_activity_at) -
      (config.resolvedLongConversationMessages - 1) * MINUTE_MS;
    const createdAtMs = Math.min(Date.parse(conversation.created_at), oldestMessageMs);
    return { ...conversation, created_at: at(createdAtMs, 0) } satisfies ConversationItem;
  });
  const nativeContacts = activeNativeReferences(contacts);
  const nativeRosters = selectNativeRosters(nativeContacts, config.nativeGroups, observer);
  const nativeConversations = nativeRosters.map((roster, index) =>
    buildNativeConversation(index, anchorMs, roster, tailConversations.length),
  );
  const conversations = [...tailConversations, ...nativeConversations];
  for (const conversation of conversations) validatePerformanceConversation(conversation);
  const messages: MessageItem[] = [];
  for (const [conversationIndex, conversation] of conversations.entries()) {
    const messageCount = conversation.conversationId === tailConversationId
      ? config.resolvedLongConversationMessages
      : config.messagesPerConversation;
    const nativeRoster = conversation.type === 'group_text'
      ? nativeRosters[conversationIndex - tailConversations.length]
      : undefined;
    for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
      messages.push(nativeRoster
        ? buildNativeMessage(conversation, nativeRoster, conversationIndex, messageIndex, messageCount)
        : buildMessage(conversation, conversationIndex, messageIndex, messageCount));
    }
  }
  const recipientPool = contacts
    .filter((contact) =>
      contact.type === 'tenant' &&
      contact.deleted_at === undefined &&
      contact.phone !== undefined &&
      contact.consent_method !== undefined &&
      contact.consent_at !== undefined,
    )
    .map((contact) => contact.contactId);
  if (recipientPool.length === 0) recipientPool.push(LEAN_TENANT_ID);
  const broadcasts = Array.from({ length: config.broadcasts }, (_, index) =>
    buildBroadcast(
      index,
      anchorMs,
      recipientPool,
      index === 0 ? config.resolvedLargeBroadcastRecipients : config.resolvedRecipientsPerBroadcast,
      unitIds,
    ),
  );
  const unmatchedEmail = Array.from({ length: FIXED_UNMATCHED_EMAIL_COUNT }, (_, index) =>
    buildUnmatchedEmail(index, anchorMs),
  );

  return {
    tables: {
      contacts,
      units,
      placements,
      tours,
      conversations,
      messages,
      broadcasts,
      unmatched_email: unmatchedEmail,
    },
    manifest: toPerformanceSeedManifest(config),
  };
}

export function resolvePerformanceSelfQaFixtures(
  config: ResolvedPerformanceSeedConfig,
): Readonly<PerformanceSelfQaFixtures> {
  const isDefaultScaleOne =
    config.scale === 1 &&
    config.contacts === PERFORMANCE_SEED_BASE.contacts &&
    config.units === PERFORMANCE_SEED_BASE.units &&
    config.placements === PERFORMANCE_SEED_BASE.placements &&
    config.tours === PERFORMANCE_SEED_BASE.tours &&
    config.conversations === PERFORMANCE_SEED_BASE.conversations &&
    config.nativeGroups === PERFORMANCE_SEED_BASE.nativeGroups &&
    config.messagesPerConversation === PERFORMANCE_SEED_BASE.messagesPerConversation &&
    config.requestedLongConversationMessages === config.messagesPerConversation &&
    config.broadcasts === PERFORMANCE_SEED_BASE.broadcasts &&
    config.recipientsPerBroadcast === PERFORMANCE_SEED_BASE.recipientsPerBroadcast &&
    config.requestedLargeBroadcastRecipients === config.recipientsPerBroadcast;
  if (!isDefaultScaleOne) {
    throw new Error('performance self-QA fixtures require the default scale-1 configuration');
  }
  return Object.freeze({
    contact_detail: performanceId('contact', 1),
    conversation_detail: performanceId('conversation', 0),
    inbox_row: performanceId('contact', 2),
    unmatched_email: `um-${padded(1, 32)}`,
    tour_group: performanceId('conversation', 10),
    placement_group: performanceId('conversation', 20),
  });
}
