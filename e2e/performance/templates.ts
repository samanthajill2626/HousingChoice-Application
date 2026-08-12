import type { ResourceClass } from './types.js';

export interface SanitizeRequestUrlInput {
  rawUrl: string;
  method: string;
  firstPartyOrigin: string;
  resourceType?: string;
}

export interface SanitizedRequestUrl {
  originClass: 'first_party' | 'third_party';
  resourceClass: ResourceClass;
  endpointTemplate: string;
  queryKeys: string[];
  unmatchedApi: boolean;
  method?: string;
  segmentCount?: number;
}

const ENDPOINT_TEMPLATES = Object.freeze([
  '/auth/dev-login',
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/__dev/outbox',
  '/__dev/performance/reseed',
  '/__dev/ping',
  '/__dev/reseed',
  '/api/events',
  '/api/today',
  '/api/placements/from-tour',
  '/api/placements/:placementId/history',
  '/api/placements/:placementId/nudges/:nudgeId/send-now',
  '/api/placements/:placementId/nudges/:nudgeId',
  '/api/placements/:placementId/nudges',
  '/api/placements/:placementId/deadline',
  '/api/placements/:placementId/relay',
  '/api/placements/:placementId/transition',
  '/api/placements/:placementId/roster/pending/:actionId/apply-now',
  '/api/placements/:placementId/roster/pending/:actionId/cancel',
  '/api/placements/:placementId/roster/pending/:actionId/dismiss',
  '/api/placements/:placementId/roster/live-members/:memberKey',
  '/api/placements/:placementId/roster/live-members',
  '/api/placements/:placementId/roster/members/:memberKey',
  '/api/placements/:placementId/roster/members',
  '/api/placements/:placementId/roster/preview-add',
  '/api/placements/:placementId/roster/preview-open',
  '/api/placements/:placementId/roster/reset',
  '/api/placements/:placementId/roster',
  '/api/placements/:placementId',
  '/api/placements',
  '/api/tours/:tourId/reminders/:reminderId/send-now',
  '/api/tours/:tourId/reminders/:reminderId',
  '/api/tours/:tourId/reminders',
  '/api/tours/:tourId/no-show-checkin-draft',
  '/api/tours/:tourId/activity',
  '/api/tours/:tourId/relay',
  '/api/tours/:tourId/roster/pending/:actionId/apply-now',
  '/api/tours/:tourId/roster/pending/:actionId/cancel',
  '/api/tours/:tourId/roster/pending/:actionId/dismiss',
  '/api/tours/:tourId/roster/live-members/:memberKey',
  '/api/tours/:tourId/roster/live-members',
  '/api/tours/:tourId/roster/members/:memberKey',
  '/api/tours/:tourId/roster/members',
  '/api/tours/:tourId/roster/preview-add',
  '/api/tours/:tourId/roster/preview-open',
  '/api/tours/:tourId/roster/reset',
  '/api/tours/:tourId/roster',
  '/api/tours/:tourId',
  '/api/tours',
  '/api/contacts/vocabulary',
  '/api/contacts/:contactId/suggestions/:target/accept',
  '/api/contacts/:contactId/suggestions/:target/dismiss',
  '/api/contacts/:contactId/suggestions',
  '/api/contacts/:contactId/listings-sent',
  '/api/contacts/:contactId/relay-groups',
  '/api/contacts/:contactId/email-conversation',
  '/api/contacts/:contactId/conversation',
  '/api/contacts/:contactId/emails/:emailKey',
  '/api/contacts/:contactId/emails',
  '/api/contacts/:contactId/phones/:phoneKey',
  '/api/contacts/:contactId/phones',
  '/api/contacts/:contactId/tenant-status',
  '/api/contacts/:contactId/voice-opt-out',
  '/api/contacts/:contactId/opt-out',
  '/api/contacts/:contactId/timeline',
  '/api/contacts/:contactId/media',
  '/api/contacts/:contactId/restore',
  '/api/contacts/:contactId/call',
  '/api/contacts/:contactId',
  '/api/contacts',
  '/api/units/:unitId/photos/presign',
  '/api/units/:unitId/photos/confirm',
  '/api/units/:unitId/photos/cover',
  '/api/units/:unitId/photos',
  '/api/units/:unitId/contacts/:contactId',
  '/api/units/:unitId/contacts',
  '/api/units/:unitId/listing-status',
  '/api/units/:unitId/recipients',
  '/api/units/:unitId/related',
  '/api/units/:unitId/similar',
  '/api/units/:unitId/activity',
  '/api/units/:unitId/media',
  '/api/units/:unitId/restore',
  '/api/units/:unitId',
  '/api/units',
  '/api/conversations/:conversationId/messages/:messageId/retry',
  '/api/conversations/:conversationId/messages',
  '/api/conversations/:conversationId/scheduled',
  '/api/conversations/:conversationId/members/:memberKey',
  '/api/conversations/:conversationId/members',
  '/api/conversations/:conversationId/close-nag/defer',
  '/api/conversations/:conversationId/close',
  '/api/conversations/:conversationId/email',
  '/api/conversations/:conversationId/read',
  '/api/conversations/:conversationId',
  '/api/conversations',
  '/api/inbox/read',
  '/api/inbox/:contactId/read',
  '/api/inbox',
  '/api/unmatched-email/:unmatchedId/create-contact',
  '/api/unmatched-email/:unmatchedId/dismiss',
  '/api/unmatched-email/:unmatchedId/release',
  '/api/unmatched-email/:unmatchedId/spam',
  '/api/unmatched-email/:unmatchedId/link',
  '/api/unmatched-email/:unmatchedId/read',
  '/api/unmatched-email/:unmatchedId',
  '/api/unmatched-email',
  '/api/broadcasts/:broadcastId/results',
  '/api/broadcasts/:broadcastId/preview',
  '/api/broadcasts/:broadcastId/send',
  '/api/broadcasts/:broadcastId',
  '/api/broadcasts',
  '/api/messages/:messageId/media/:mediaIndex',
  '/api/calls/:callId/recording',
  '/api/media/presign',
  '/api/media/confirm',
  '/api/email-media/presign',
  '/api/email-media/confirm',
  '/api/settings',
  '/api/users/me/cell/verify-start',
  '/api/users/me/cell/verify-confirm',
  '/api/users/me',
  '/api/users/:userId/inbound-voice-line',
  '/api/users/:userId/role',
  '/api/users/:userId',
  '/api/users',
  '/api/system/flags',
  '/api/system/alarms',
  '/api/system/errors',
  '/api/ai-runs/:runId',
  '/api/ai-runs',
  '/api/pool-numbers',
  '/api/push/subscriptions',
  '/api/push/vapid-public-key',
  '/api/push/test',
  '/public/units/:unitId/flyer',
  '/public/housing-fair',
  '/unit-media/:unitId/:mediaKey',
] as const);

export type EndpointTemplate = (typeof ENDPOINT_TEMPLATES)[number];

interface CompiledTemplate {
  template: EndpointTemplate;
  segments: readonly string[];
  literalSegments: number;
}

const COMPILED_TEMPLATES: readonly CompiledTemplate[] = Object.freeze(
  ENDPOINT_TEMPLATES.map((template) => {
    const segments = template.split('/').filter(Boolean);
    return {
      template,
      segments,
      literalSegments: segments.filter((segment) => !segment.startsWith(':')).length,
    };
  }).sort((left, right) =>
    right.segments.length - left.segments.length ||
    right.literalSegments - left.literalSegments ||
    right.template.length - left.template.length,
  ),
);

export function allEndpointTemplates(): readonly EndpointTemplate[] {
  return ENDPOINT_TEMPLATES;
}

function matchTemplate(pathname: string): EndpointTemplate | null {
  const segments = pathname.split('/').filter(Boolean);
  for (const candidate of COMPILED_TEMPLATES) {
    if (segments.length !== candidate.segments.length) continue;
    if (candidate.segments.every((segment, index) => segment.startsWith(':') || segment === segments[index])) {
      return candidate.template;
    }
  }
  return null;
}

function assetClass(pathname: string, resourceType?: string): Exclude<ResourceClass, 'api'> {
  const normalizedType = resourceType?.toLowerCase();
  if (normalizedType === 'document') return 'document';
  if (normalizedType === 'script') return 'script';
  if (normalizedType === 'stylesheet') return 'style';
  if (normalizedType === 'font') return 'font';
  if (normalizedType === 'image') return 'image';
  if (pathname === '/' || /\.html?$/i.test(pathname)) return 'document';
  if (/\.(?:[cm]?js|jsx|ts|tsx)$/i.test(pathname)) return 'script';
  if (/\.css$/i.test(pathname)) return 'style';
  if (/\.(?:woff2?|ttf|otf|eot)$/i.test(pathname)) return 'font';
  if (/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(pathname)) return 'image';
  return 'other';
}

function sortedQueryKeys(url: URL): string[] {
  return [...new Set([...url.searchParams.keys()])].sort((left, right) => left.localeCompare(right));
}

function safeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalized)
    ? normalized
    : 'OTHER';
}

export function sanitizeRequestUrl(input: SanitizeRequestUrlInput): SanitizedRequestUrl {
  let url: URL;
  let firstParty: URL;
  try {
    url = new URL(input.rawUrl);
    firstParty = new URL(input.firstPartyOrigin);
  } catch {
    return {
      originClass: 'third_party',
      resourceClass: 'other',
      endpointTemplate: 'invalid_url',
      queryKeys: [],
      unmatchedApi: false,
    };
  }

  if (url.origin !== firstParty.origin) {
    return {
      originClass: 'third_party',
      resourceClass: 'other',
      endpointTemplate: 'third_party',
      queryKeys: [],
      unmatchedApi: false,
    };
  }

  const queryKeys = sortedQueryKeys(url);
  const matched = matchTemplate(url.pathname);
  if (matched !== null) {
    return {
      originClass: 'first_party',
      resourceClass:
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/auth/') ||
        url.pathname.startsWith('/__dev/')
          ? 'api'
          : assetClass(url.pathname, input.resourceType),
      endpointTemplate: matched,
      queryKeys,
      unmatchedApi: false,
    };
  }

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    return {
      originClass: 'first_party',
      resourceClass: 'api',
      endpointTemplate: 'unmatched_api',
      queryKeys,
      unmatchedApi: true,
      segmentCount: url.pathname.split('/').filter(Boolean).length,
      method: safeMethod(input.method),
    };
  }

  const resourceClass = assetClass(url.pathname, input.resourceType);
  return {
    originClass: 'first_party',
    resourceClass,
    endpointTemplate: resourceClass,
    queryKeys: [],
    unmatchedApi: false,
  };
}
