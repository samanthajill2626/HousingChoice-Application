export const PERFORMANCE_SEED_BOUNDS = Object.freeze({
  scale: Object.freeze({ min: 1, max: 100 }),
  entityCount: Object.freeze({ min: 0, max: 20_000 }),
  messagesPerConversation: Object.freeze({ min: 0, max: 100 }),
  recipientsPerBroadcast: Object.freeze({ min: 0, max: 1_000 }),
  relayGroups: Object.freeze({ max: 1_000 }),
  totalItems: Object.freeze({ max: 250_000 }),
});

export const PERFORMANCE_SEED_BASE = Object.freeze({
  contacts: 100,
  units: 25,
  placements: 50,
  tours: 50,
  conversations: 100,
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
  messagesPerConversation?: number;
  broadcasts?: number;
  recipientsPerBroadcast?: number;
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
  messagesPerConversation: number;
  broadcasts: number;
  recipientsPerBroadcast: number;
  messageCount: number;
  requestedRecipientCount: number;
  resolvedRecipientsPerBroadcast: number;
  resolvedRecipientCount: number;
  requestedRelayGroupCount: number;
  relayGroupCount: number;
  clippedRelayGroupCount: number;
  fixedUnmatchedEmailCount: 4;
  physicalItemCount: number;
  totalItemCount: number;
  fallbacks: PerformanceSeedFallbacks;
}

export type PerformanceSeedManifest = ResolvedPerformanceSeedConfig;

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
  const recipientsPerBroadcast = boundedInteger(
    'recipientsPerBroadcast',
    input.recipientsPerBroadcast ?? PERFORMANCE_SEED_BASE.recipientsPerBroadcast,
    PERFORMANCE_SEED_BOUNDS.recipientsPerBroadcast.min,
    PERFORMANCE_SEED_BOUNDS.recipientsPerBroadcast.max,
  );

  const messageCount = conversations * messagesPerConversation;
  const requestedRecipientCount = broadcasts * recipientsPerBroadcast;
  const recipientPoolSize = contacts === 0 ? 1 : contacts;
  const resolvedRecipientsPerBroadcast = Math.min(recipientsPerBroadcast, recipientPoolSize);
  const resolvedRecipientCount = broadcasts * resolvedRecipientsPerBroadcast;
  const requestedRelayGroupCount = Math.floor(conversations / 5);
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
    conversations +
    messageCount +
    broadcasts +
    FIXED_UNMATCHED_EMAIL_COUNT;
  const totalItemCount = physicalItemCount + resolvedRecipientCount;
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
    messagesPerConversation,
    broadcasts,
    recipientsPerBroadcast,
    messageCount,
    requestedRecipientCount,
    resolvedRecipientsPerBroadcast,
    resolvedRecipientCount,
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
    messagesPerConversation: config.messagesPerConversation,
    broadcasts: config.broadcasts,
    recipientsPerBroadcast: config.recipientsPerBroadcast,
    messageCount: config.messageCount,
    requestedRecipientCount: config.requestedRecipientCount,
    resolvedRecipientsPerBroadcast: config.resolvedRecipientsPerBroadcast,
    resolvedRecipientCount: config.resolvedRecipientCount,
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

export function generatePerformanceSeed(_config: ResolvedPerformanceSeedConfig): never {
  throw new Error('performance row generation not implemented');
}

export function resolvePerformanceSelfQaFixtures(_config: ResolvedPerformanceSeedConfig): never {
  throw new Error('performance self-QA fixtures not implemented');
}
