import type { SampleMode, SampleResult } from './types.js';
import { assertEndpointTemplate, type EndpointTemplate } from './templates.js';

export type EndpointRequirement = 'required' | 'conditional';

export interface EndpointContract {
  endpointTemplate: EndpointTemplate;
  queryKeys: readonly string[];
  requirement: EndpointRequirement;
  inboxRequestClass?: InboxRequestClass;
}

export type InboxRequestClass =
  | 'inbox_page_all'
  | 'inbox_page_unread'
  | 'inbox_page_unknown'
  | 'inbox_page_groups'
  | 'inbox_badge'
  | 'inbox_endpoint_contract_failure';

export type RouteContractBranch =
  | { kind: 'none' }
  | { kind: 'contact_detail'; contactType: 'tenant' | 'landlord' | 'other'; landlordUnitCount: number }
  | { kind: 'unit_detail'; hasLandlord: boolean }
  | {
      kind: 'thread_detail';
      thread: 'group_thread' | 'person_thread';
      expectsMountWrite: boolean;
    };

export type LocatorExactness = 'exact' | 'prefix' | 'contains' | 'regex' | 'role_only';

export interface LocatorContract {
  role: string;
  exactness: LocatorExactness;
  name?: string;
  scope?: string;
  selected?: true;
}

export interface TerminalContract {
  viewportDependency: 'desktop_chrome';
  structure: readonly LocatorContract[];
  populated: readonly LocatorContract[];
  empty: readonly LocatorContract[];
  error: readonly LocatorContract[];
  populatedAlternatives: readonly (readonly LocatorContract[])[];
  emptyAlternatives: readonly (readonly LocatorContract[])[];
}

export type InboxFilterQuery = 'unread' | 'unknown' | 'groups';

export type ExactQueryState =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'fixed'; values: Readonly<{ filter: InboxFilterQuery }> }>;

export interface ExactBrowserTarget {
  path: string;
  query: ExactQueryState;
}

export type WarmAction =
  | Readonly<{ kind: 'link'; href: string }>
  | Readonly<{ kind: 'tab'; name: string }>;

export interface WarmSourceContract {
  target: ExactBrowserTarget;
  ready: LocatorContract;
  sourceTerminal?: TerminalContract;
  sourceSelected?: LocatorContract;
  action: WarmAction;
  viewportDependency: 'desktop_chrome';
  gets: readonly EndpointContract[];
}

export type ResolverName = 'static' | 'contact' | 'unit' | 'tour' | 'placement' | 'conversation' | 'broadcast';
export type BehaviorFamily = 'standard' | 'inbox';
export type ColdTarget = Readonly<{ kind: 'static'; path: string }> | Readonly<{ kind: 'resolved' }>;

export interface RouteDefinition {
  surfaceId: string;
  label: string;
  pathTemplate: string;
  coldTarget: ColdTarget;
  behaviorFamily: BehaviorFamily;
  requiredRole: 'staff' | 'admin';
  viewportDependency: 'desktop_chrome';
  resolver: ResolverName;
  source: WarmSourceContract;
  terminal: TerminalContract;
  gets: readonly EndpointContract[];
  surfaceScaleBearing: boolean;
  loadScaleBearing: boolean;
  targetStructuralNote: string | null;
  streamExclusions: readonly ['/api/events'];
  blockedSurface: 'none' | 'contact_detail' | 'conversation_detail' | 'thread_detail';
}

export interface ProbeDefinition {
  key: string;
  blockedSurface: 'contact_inbox_probe' | 'unmatched_email_probe';
}

export type BlockedWriteSurface =
  | 'contact_detail'
  | 'conversation_detail'
  | 'group_thread'
  | 'person_thread'
  | 'contact_inbox_probe'
  | 'unmatched_email_probe';
export type BlockedWriteTuple = `${BlockedWriteSurface}|POST|${string}|${'source_click' | 'destination_mount'}`;

export const APP_ROUTE_EXCLUSIONS = Object.freeze([
  { route: '/p/:unitId', reason: 'public' },
  { route: '/join', reason: 'public' },
  { route: '/broadcasts/new', reason: 'create' },
  { route: '/settings', reason: 'redirect' },
  { route: '{allNavTargets().filter(({ to }) => !IMPLEMENTED.has(to)).map(...)=>:to}', reason: 'generated_placeholders_empty' },
  { route: '*', reason: 'catch_all' },
] as const);

export const CONTRACT_SOURCES = Object.freeze({
  registry: 'dashboard/src/App.tsx:117-249; dashboard/src/app/nav.ts:55-100',
  shell: 'dashboard/src/app/AuthContext.tsx:27-48; dashboard/src/app/UnreadContext.tsx:27-117',
  contacts: 'dashboard/src/routes/contacts/useContacts.ts:14-99',
  units: 'dashboard/src/routes/listings/useListings.ts:10-60',
  today: 'dashboard/src/routes/today/useToday.ts:41-74',
  tours: 'dashboard/src/routes/tours/useTours.ts:37-123',
  placements: 'dashboard/src/routes/placements/usePlacements.ts:50-128,214-225',
  details: 'dashboard/src/routes/contact/ContactDetail.tsx:111-140; dashboard/src/routes/listing/useListing.ts:110-185',
  threads: 'dashboard/src/routes/tours/useTourChannels.ts:164-289; dashboard/src/routes/placements/usePlacementChannels.ts:165-299',
  writes: 'dashboard/src/routes/contact/useMarkContactRead.ts:15-47; dashboard/src/routes/inbox/useInbox.ts:180-212',
} as const);

const NEVER_STREAM = Object.freeze(['/api/events'] as const);

function endpoint(
  endpointTemplate: EndpointTemplate,
  queryKeys: readonly string[] = [],
  requirement: EndpointRequirement = 'required',
  inboxRequestClass?: Exclude<InboxRequestClass, 'inbox_endpoint_contract_failure'>,
): EndpointContract {
  assertEndpointTemplate(endpointTemplate);
  return Object.freeze({
    endpointTemplate,
    queryKeys: Object.freeze([...queryKeys].sort()),
    requirement,
    ...(inboxRequestClass !== undefined && { inboxRequestClass }),
  });
}

function required(
  path: EndpointTemplate,
  queryKeys: readonly string[] = [],
  inboxRequestClass?: Exclude<InboxRequestClass, 'inbox_endpoint_contract_failure'>,
): EndpointContract {
  return endpoint(path, queryKeys, 'required', inboxRequestClass);
}

function conditional(path: EndpointTemplate, queryKeys: readonly string[] = []): EndpointContract {
  return endpoint(path, queryKeys, 'conditional');
}

function locator(
  role: string,
  name?: string,
  exactness: LocatorExactness = 'exact',
  scope?: string,
  selected?: true,
): LocatorContract {
  return Object.freeze({
    role, exactness, ...(name !== undefined && { name }), ...(scope !== undefined && { scope }),
    ...(selected !== undefined && { selected }),
  });
}

function terminal(
  populated: readonly LocatorContract[],
  empty: readonly LocatorContract[],
  error: readonly LocatorContract[],
  structure: readonly LocatorContract[] = [],
  populatedCombine: 'any' | 'all' = 'any',
  emptyCombine: 'any' | 'all' = populatedCombine,
): TerminalContract {
  const alternatives = (
    contracts: readonly LocatorContract[],
    combine: 'any' | 'all',
  ): readonly (readonly LocatorContract[])[] => Object.freeze(
    combine === 'all'
      ? [Object.freeze([...contracts])]
      : contracts.map((contract) => Object.freeze([contract])),
  );
  return Object.freeze({
    viewportDependency: 'desktop_chrome' as const,
    structure: Object.freeze([...structure]),
    populated: Object.freeze([...populated]),
    empty: Object.freeze([...empty]),
    error: Object.freeze([...error]),
    populatedAlternatives: alternatives(populated, populatedCombine),
    emptyAlternatives: alternatives(empty, emptyCombine),
  });
}

function terminalAlternatives(
  populatedAlternatives: readonly (readonly LocatorContract[])[],
  emptyAlternatives: readonly (readonly LocatorContract[])[],
  error: readonly LocatorContract[],
  structure: readonly LocatorContract[] = [],
): TerminalContract {
  const populated = populatedAlternatives.flat();
  const empty = emptyAlternatives.flat();
  return Object.freeze({
    viewportDependency: 'desktop_chrome' as const,
    structure: Object.freeze([...structure]),
    populated: Object.freeze([...populated]),
    empty: Object.freeze([...empty]),
    error: Object.freeze([...error]),
    populatedAlternatives: Object.freeze(populatedAlternatives.map((row) => Object.freeze([...row]))),
    emptyAlternatives: Object.freeze(emptyAlternatives.map((row) => Object.freeze([...row]))),
  });
}

function crossProduct(
  fixed: readonly LocatorContract[],
  ...choices: readonly (readonly LocatorContract[])[]
): readonly (readonly LocatorContract[])[] {
  let rows: LocatorContract[][] = [[...fixed]];
  for (const choice of choices) {
    rows = rows.flatMap((row) => choice.map((contract) => [...row, contract]));
  }
  return rows;
}

const COLD_SHELL_GETS = Object.freeze([
  required('/auth/me'),
  required('/api/inbox', ['filter', 'limit'], 'inbox_badge'),
  required('/api/unmatched-email', ['filter']),
]);

const CONTACT_LIVE_WALK = Object.freeze([
  required('/api/contacts', ['limit', 'type']),
  conditional('/api/contacts', ['cursor', 'limit', 'type']),
]);
const CONTACT_DELETED_WALK = Object.freeze([
  required('/api/contacts', ['deleted', 'limit', 'type']),
  conditional('/api/contacts', ['cursor', 'deleted', 'limit', 'type']),
]);
const PLACEMENT_CONTACT_LIVE_WALK = Object.freeze([
  required('/api/contacts', ['type']),
  conditional('/api/contacts', ['cursor', 'type']),
]);
const PLACEMENT_CONTACT_DELETED_WALK = Object.freeze([
  required('/api/contacts', ['deleted', 'type']),
  conditional('/api/contacts', ['cursor', 'deleted', 'type']),
]);
const UNIT_LIVE_WALK = Object.freeze([
  required('/api/units'),
  conditional('/api/units', ['cursor']),
]);
const UNIT_DELETED_WALK = Object.freeze([
  required('/api/units', ['deleted']),
  conditional('/api/units', ['cursor', 'deleted']),
]);
const TODAY_GETS = Object.freeze([
  required('/api/today', ['day', 'toursFrom', 'toursTo']),
  conditional('/api/placements'),
  conditional('/api/conversations'),
  conditional('/api/tours', ['from', 'to']),
]);
const TOUR_LIST_ACTIVE_GETS = Object.freeze([
  required('/api/tours', ['from', 'to']),
  required('/api/tours', ['status']),
  ...CONTACT_LIVE_WALK,
  ...CONTACT_DELETED_WALK,
  ...UNIT_LIVE_WALK,
  ...UNIT_DELETED_WALK,
]);
const TOUR_LIST_CLOSED_GETS = TOUR_LIST_ACTIVE_GETS;
const PLACEMENT_LIST_GETS = Object.freeze([
  required('/api/placements'),
  conditional('/api/placements', ['cursor']),
  ...PLACEMENT_CONTACT_LIVE_WALK,
  ...PLACEMENT_CONTACT_DELETED_WALK,
  ...UNIT_LIVE_WALK,
  ...UNIT_DELETED_WALK,
]);
function inboxGets(requestClass: Extract<InboxRequestClass, `inbox_page_${string}`>): readonly EndpointContract[] {
  return Object.freeze([required('/api/inbox', ['filter', 'limit'], requestClass)]);
}
const EMAIL_GETS = Object.freeze([required('/api/unmatched-email', ['filter']), ...CONTACT_LIVE_WALK]);
const BROADCAST_LIST_GETS = Object.freeze([required('/api/broadcasts', ['limit'])]);

const TEAM_GETS = Object.freeze([required('/api/users')]);
const TEMPLATE_GETS = Object.freeze([required('/api/settings')]);
const NOTIFICATION_GETS = Object.freeze([] as EndpointContract[]);
const VOICE_GETS = Object.freeze([required('/api/users/me')]);
const SYSTEM_GETS = Object.freeze([
  required('/api/settings'), required('/api/system/flags'), required('/api/system/alarms'),
  required('/api/system/errors', ['since']),
]);
const AI_RUN_GETS = Object.freeze([required('/api/system/flags'), required('/api/ai-runs', ['scope'])]);
const NUMBER_GETS = Object.freeze([required('/api/settings'), required('/api/pool-numbers')]);

const CONTACT_DETAIL_BASE_GETS = Object.freeze([
  required('/api/contacts/:contactId'), required('/api/contacts/:contactId/suggestions'),
  required('/api/users/me'), required('/api/contacts/:contactId/timeline'),
  required('/api/placements'), required('/api/units'),
  required('/api/contacts/:contactId/listings-sent'), required('/api/contacts/:contactId/media'),
  required('/api/contacts/:contactId/relay-groups'), required('/api/contacts/:contactId/group-threads'),
  ...CONTACT_LIVE_WALK,
  conditional('/api/conversations'), conditional('/api/conversations/:conversationId/messages'),
]);
const UNIT_DETAIL_BASE_GETS = Object.freeze([
  required('/api/units/:unitId'), required('/api/units'), required('/api/placements'),
  required('/api/units/:unitId/related'), required('/api/units/:unitId/recipients'),
  required('/api/units/:unitId/similar'), required('/api/units/:unitId/activity'),
  required('/api/tours', ['unitId']), ...CONTACT_LIVE_WALK, ...CONTACT_DELETED_WALK,
]);
const TOUR_DETAIL_BASE_GETS = Object.freeze([
  required('/api/tours/:tourId'), required('/api/units/:unitId'), required('/api/contacts/:contactId'),
  required('/api/tours/:tourId/roster'), required('/api/conversations'),
  required('/api/tours/:tourId/activity', ['limit']), required('/api/tours/:tourId/reminders'),
]);
const PLACEMENT_DETAIL_BASE_GETS = Object.freeze([
  required('/api/placements/:placementId'), required('/api/units/:unitId'), required('/api/contacts/:contactId'),
  required('/api/placements/:placementId/roster'), required('/api/conversations'),
  required('/api/placements/:placementId/history', ['limit']), required('/api/placements/:placementId/nudges'),
]);
const GROUP_THREAD_GETS = Object.freeze([
  required('/api/conversations/:conversationId'), required('/api/conversations/:conversationId/members'),
  required('/api/conversations/:conversationId/messages'), required('/api/conversations/:conversationId/scheduled'),
]);
const PERSON_THREAD_GETS = Object.freeze([
  required('/api/contacts/:contactId/timeline'), conditional('/api/conversations'),
  conditional('/api/conversations/:conversationId/messages'),
]);
const CONVERSATION_DETAIL_GETS = Object.freeze([
  required('/api/conversations/:conversationId'), required('/api/conversations/:conversationId/members'),
  required('/api/conversations/:conversationId/messages'), required('/api/conversations/:conversationId/scheduled'),
  ...CONTACT_LIVE_WALK,
]);
const BROADCAST_DETAIL_GETS = Object.freeze([required('/api/broadcasts/:broadcastId/results')]);

const L = {
  alert: locator('alert', undefined, 'role_only'),
  today: locator('heading', 'Today'),
  contacts: locator('heading', 'Contacts'),
  properties: locator('heading', 'Properties'),
  tours: locator('heading', 'Tours'),
  placements: locator('heading', 'Placements'),
  inbox: locator('heading', 'Inbox'),
  email: locator('heading', 'Email'),
  matching: locator('heading', 'Matching'),
  settings: locator('heading', 'Settings'),
};

const TODAY_TERMINAL = terminal(
  ['Group texts to close', 'Needs you now', 'Tours today', 'Unreplied', 'Follow-ups due', 'AI suggestions to review']
    .map((name) => locator('list', name)),
  [locator('text', 'All caught up')],
  [locator('alert', "We couldn't load your queue", 'contains')],
);
function contactListTerminal(heading: string): TerminalContract {
  return terminal([locator('list', heading)], [locator('text', `No ${heading.toLowerCase()} yet`)], [L.alert]);
}
function unitListTerminal(deleted: boolean): TerminalContract {
  return terminal([locator('list', 'Properties')], [locator('text', deleted ? 'No deleted properties' : 'No properties yet')], [L.alert]);
}
const TOUR_ACTIVE_TERMINAL = terminal(
  [locator('list', undefined, 'role_only', 'Upcoming tours'), locator('list', undefined, 'role_only', 'Needs booking')],
  [locator('text', 'No tours scheduled in the next 30 days.'), locator('text', 'No unbooked tour requests.')],
  [L.alert],
  [locator('region', 'Upcoming tours'), locator('region', 'Needs booking')],
  'any',
  'all',
);
const TOUR_CLOSED_TERMINAL = terminal([locator('list', 'Closed tours list')], [locator('text', 'No closed or canceled tours yet.')], [L.alert]);
const PLACEMENT_TERMINAL = terminal(
  [locator('list', undefined, 'role_only')], [locator('text', 'No active placements.')],
  [locator('alert', "We couldn't load placements. Please try again.")], [locator('searchbox', 'Search placements')],
);
function inboxTerminal(emptyTitle: string): TerminalContract {
  return terminal([locator('list', 'Conversations')], [locator('text', emptyTitle)], [L.alert]);
}
function emailTerminal(quarantine: boolean): TerminalContract {
  return terminal(
    [locator('list', quarantine ? 'Quarantined email' : 'Unmatched email')],
    [locator('text', quarantine ? 'Quarantine is empty' : 'No unmatched email'), locator('text', 'Email triage turns on with its backend')],
    [L.alert],
  );
}
const BROADCAST_TERMINAL = terminal([locator('list', 'Property sends')], [locator('text', 'No sends yet')], [L.alert]);
const TEAM_TERMINAL = terminal([locator('table', undefined, 'role_only')], [locator('text', 'No teammates yet', 'prefix')], [L.alert]);
const TEMPLATE_TERMINAL = terminal([locator('textbox', '^Missed-call auto-text [0-9]+/320$', 'regex')], [], [L.alert]);
const NOTIFICATION_TERMINAL = terminal([locator('heading', 'Notifications')], [], [L.alert]);
const VOICE_TERMINAL = terminalAlternatives(
  [
    [locator('textbox', 'Your mobile number')],
    [locator('text', 'Your cell'), locator('status', undefined, 'role_only')],
  ],
  [],
  [L.alert],
);
const SYSTEM_CHECKBOX = locator('checkbox', 'Pause automated messages overnight');
const SYSTEM_ENVIRONMENT = locator('listitem', 'Environment: ', 'prefix');
const SYSTEM_ALARM_STATES = [
  locator('list', undefined, 'role_only', 'Alarms'),
  locator('text', 'Available in deployed environments.', 'exact', 'Alarms'),
  locator('text', 'No alarms configured for this environment.', 'exact', 'Alarms'),
] as const;
const SYSTEM_ERROR_STATES = [
  locator('list', undefined, 'role_only', 'Recent errors'),
  locator('text', 'Available in deployed environments.', 'exact', 'Recent errors'),
  locator('text', 'No recent errors in this window.', 'exact', 'Recent errors'),
] as const;
const SYSTEM_TERMINAL = terminalAlternatives(
  crossProduct([SYSTEM_CHECKBOX, SYSTEM_ENVIRONMENT], SYSTEM_ALARM_STATES, SYSTEM_ERROR_STATES),
  [],
  [L.alert],
  [locator('heading', 'Alarms'), locator('heading', 'Recent errors')],
);
const AI_RUN_TERMINAL = terminal([locator('list', 'AI runs')], [locator('text', 'No extraction runs match this scope.')], [L.alert]);
const NUMBER_STATES = [
  locator('text', 'Not set', 'exact', 'Our number'),
  locator('text', '^(?:\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}|\\+[0-9]{8,15})$', 'regex', 'Our number'),
] as const;
const NUMBER_TERMINAL = terminalAlternatives(
  crossProduct([], NUMBER_STATES, [locator('list', 'Pool number counts')]),
  crossProduct([], NUMBER_STATES, [
    locator('text', 'No relay group numbers yet - a number is provisioned with the first relay group.'),
  ]),
  [locator('text', "Couldn't load our number."), L.alert],
  [locator('heading', 'Our number'), locator('heading', 'Relay group numbers')],
);
const CONTACT_DETAIL_TERMINAL = terminal(
  [locator('heading', '^Details(?: Edit contact details)?$', 'regex'), locator('region', 'Communications and activity')], [], [L.alert], [], 'all',
);
const UNIT_DETAIL_TERMINAL = terminal([locator('heading', undefined, 'role_only'), locator('heading', 'Photos')], [], [L.alert], [], 'all');
const TOUR_DETAIL_TERMINAL = terminal([locator('link', 'Back to tours')], [], [L.alert]);
const PLACEMENT_DETAIL_TERMINAL = terminal([locator('link', 'Back to placements')], [], [L.alert]);
const CONVERSATION_DETAIL_TERMINAL = terminal([locator('text', 'Relay group'), locator('link', 'Back to inbox')], [], [L.alert], [], 'all');
const BROADCAST_DETAIL_TERMINAL = terminal(
  [locator('list', 'Recipients')],
  [locator('text', 'No recipients recorded yet.')], [L.alert], [locator('heading', 'Recipients')],
);

function exactTarget(path: string): ExactBrowserTarget {
  return Object.freeze({ path, query: Object.freeze({ kind: 'absent' as const }) });
}

export function exactTargetFromPath(path: string): ExactBrowserTarget {
  const parsed = new URL(path, 'http://target.invalid');
  const entries = [...parsed.searchParams.entries()];
  if (entries.length === 0) return exactTarget(parsed.pathname);
  if (entries.length === 1 && entries[0]?.[0] === 'filter'
    && (entries[0][1] === 'unread' || entries[0][1] === 'unknown' || entries[0][1] === 'groups')) {
    return Object.freeze({
      path: parsed.pathname,
      query: Object.freeze({ kind: 'fixed' as const, values: Object.freeze({ filter: entries[0][1] }) }),
    });
  }
  throw new Error('invalid_exact_query_state');
}

function source(
  path: string,
  ready: LocatorContract,
  action: WarmAction,
  gets: readonly EndpointContract[],
  sourceTerminal?: TerminalContract,
  sourceSelected?: LocatorContract,
): WarmSourceContract {
  return Object.freeze({
    target: exactTargetFromPath(path),
    ready,
    ...(sourceTerminal !== undefined && { sourceTerminal }),
    ...(sourceSelected !== undefined && { sourceSelected }),
    action,
    viewportDependency: 'desktop_chrome' as const,
    gets,
  });
}

interface RowInput {
  surfaceId: string;
  label: string;
  pathTemplate?: string;
  coldTarget?: ColdTarget;
  behaviorFamily?: BehaviorFamily;
  requiredRole?: 'staff' | 'admin';
  resolver?: ResolverName;
  source: WarmSourceContract;
  terminal: TerminalContract;
  gets: readonly EndpointContract[];
  surfaceScaleBearing: boolean;
  loadScaleBearing: boolean;
  targetStructuralNote?: string;
  blockedSurface?: RouteDefinition['blockedSurface'];
}

function row(input: RowInput): RouteDefinition {
  return Object.freeze({
    surfaceId: input.surfaceId,
    label: input.label,
    pathTemplate: input.pathTemplate ?? input.surfaceId,
    coldTarget: input.coldTarget ?? (input.resolver === undefined || input.resolver === 'static'
      ? Object.freeze({ kind: 'static' as const, path: input.surfaceId })
      : Object.freeze({ kind: 'resolved' as const })),
    behaviorFamily: input.behaviorFamily ?? 'standard',
    requiredRole: input.requiredRole ?? 'staff',
    viewportDependency: 'desktop_chrome' as const,
    resolver: input.resolver ?? 'static',
    source: input.source,
    terminal: input.terminal,
    gets: input.gets,
    surfaceScaleBearing: input.surfaceScaleBearing,
    loadScaleBearing: input.loadScaleBearing,
    targetStructuralNote: input.targetStructuralNote ?? null,
    streamExclusions: NEVER_STREAM,
    blockedSurface: input.blockedSurface ?? 'none',
  });
}

const link = (href: string): WarmAction => Object.freeze({ kind: 'link', href });
const tab = (name: string): WarmAction => Object.freeze({ kind: 'tab', name });
const NAV_TODAY = (target: string, label: string, gets: readonly EndpointContract[]) => source('/', L.today, link(target), gets);
const CONTACT_SOURCE = (target: string, label: string, gets: readonly EndpointContract[]) => source('/contacts', L.contacts, link(target), gets);
const SETTINGS_SOURCE = (target: string, label: string, from = '/settings/templates', gets: readonly EndpointContract[] = TEMPLATE_GETS) =>
  source(
    from,
    from === '/settings/team'
      ? locator('table', undefined, 'role_only')
      : locator('textbox', '^Missed-call auto-text [0-9]+/320$', 'regex'),
    tab(label),
    gets,
  );
const INBOX_ALL_SOURCE_TERMINAL = inboxTerminal('No conversations yet');
const INBOX_ALL_SOURCE_SELECTED = locator('tab', 'All', 'exact', undefined, true);
const INBOX_SOURCE = (label: string, gets: readonly EndpointContract[]) =>
  source('/inbox', L.inbox, tab(label), gets, INBOX_ALL_SOURCE_TERMINAL, INBOX_ALL_SOURCE_SELECTED);
const INBOX_DETAIL_SOURCE = (gets: readonly EndpointContract[]) =>
  source('/inbox', L.inbox, link(':resolved_cold_target'), gets, INBOX_ALL_SOURCE_TERMINAL, INBOX_ALL_SOURCE_SELECTED);

export const ROUTES: readonly RouteDefinition[] = Object.freeze([
  row({ surfaceId: '/', label: 'Today', source: source('/contacts', L.contacts, link('/'), CONTACT_LIVE_WALK), terminal: TODAY_TERMINAL, gets: TODAY_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/contacts', label: 'Contacts', source: NAV_TODAY('/contacts', 'Contacts', TODAY_GETS), terminal: contactListTerminal('Contacts'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/contacts/tenants', label: 'Tenants', source: CONTACT_SOURCE('/contacts/tenants', 'Tenants', CONTACT_LIVE_WALK), terminal: contactListTerminal('Tenants'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/contacts/landlords', label: 'Landlords', source: CONTACT_SOURCE('/contacts/landlords', 'Landlords', CONTACT_LIVE_WALK), terminal: contactListTerminal('Landlords'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/contacts/unknown', label: 'Unknown', source: CONTACT_SOURCE('/contacts/unknown', 'Unknown', CONTACT_LIVE_WALK), terminal: contactListTerminal('Unknown'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/contacts/deleted', label: 'Deleted contacts', source: CONTACT_SOURCE('/contacts/deleted', 'Deleted', CONTACT_LIVE_WALK), terminal: contactListTerminal('Deleted'), gets: CONTACT_DELETED_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/listings', label: 'Properties', source: NAV_TODAY('/listings', 'Properties', TODAY_GETS), terminal: unitListTerminal(false), gets: UNIT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/listings/deleted', label: 'Deleted properties', source: source('/listings', L.properties, link('/listings/deleted'), UNIT_LIVE_WALK), terminal: unitListTerminal(true), gets: UNIT_DELETED_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/tours', label: 'Tours', source: NAV_TODAY('/tours', 'Tours', TODAY_GETS), terminal: TOUR_ACTIVE_TERMINAL, gets: TOUR_LIST_ACTIVE_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/tours/closed', label: 'Closed tours', source: source('/tours', L.tours, link('/tours/closed'), TOUR_LIST_ACTIVE_GETS), terminal: TOUR_CLOSED_TERMINAL, gets: TOUR_LIST_CLOSED_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/placements', label: 'Placements', source: NAV_TODAY('/placements', 'Placements', TODAY_GETS), terminal: PLACEMENT_TERMINAL, gets: PLACEMENT_LIST_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: 'inbox-all', label: 'Inbox: All', pathTemplate: '/inbox', coldTarget: Object.freeze({ kind: 'static' as const, path: '/inbox' }), behaviorFamily: 'inbox', source: INBOX_SOURCE('All', inboxGets('inbox_page_all')), terminal: inboxTerminal('No conversations yet'), gets: inboxGets('inbox_page_all'), surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: 'inbox-unread', label: 'Inbox: Unread', pathTemplate: '/inbox', coldTarget: Object.freeze({ kind: 'static' as const, path: '/inbox?filter=unread' }), behaviorFamily: 'inbox', source: INBOX_SOURCE('Unread', inboxGets('inbox_page_unread')), terminal: inboxTerminal("You're all caught up"), gets: inboxGets('inbox_page_unread'), surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: 'inbox-unknown', label: 'Inbox: Unknown', pathTemplate: '/inbox', coldTarget: Object.freeze({ kind: 'static' as const, path: '/inbox?filter=unknown' }), behaviorFamily: 'inbox', source: INBOX_SOURCE('Unknown', inboxGets('inbox_page_unknown')), terminal: inboxTerminal('No unknown numbers'), gets: inboxGets('inbox_page_unknown'), surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: 'inbox-groups', label: 'Inbox: Groups', pathTemplate: '/inbox', coldTarget: Object.freeze({ kind: 'static' as const, path: '/inbox?filter=groups' }), behaviorFamily: 'inbox', source: INBOX_SOURCE('Groups', inboxGets('inbox_page_groups')), terminal: inboxTerminal('No group texts yet'), gets: inboxGets('inbox_page_groups'), surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/email', label: 'Email', source: NAV_TODAY('/email', 'Email', TODAY_GETS), terminal: emailTerminal(false), gets: EMAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ surfaceId: '/email/quarantine', label: 'Quarantined email', source: source('/email', L.email, link('/email/quarantine'), EMAIL_GETS), terminal: emailTerminal(true), gets: EMAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ surfaceId: '/broadcasts', label: 'Matching', source: NAV_TODAY('/broadcasts', 'Matching', TODAY_GETS), terminal: BROADCAST_TERMINAL, gets: BROADCAST_LIST_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ surfaceId: '/settings/team', label: 'Team', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/team', 'Team'), terminal: TEAM_TERMINAL, gets: TEAM_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/settings/templates', label: 'Templates', source: SETTINGS_SOURCE('/settings/templates', 'Templates', '/settings/team', TEAM_GETS), terminal: TEMPLATE_TERMINAL, gets: TEMPLATE_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/settings/notifications', label: 'Notifications', source: SETTINGS_SOURCE('/settings/notifications', 'Notifications'), terminal: NOTIFICATION_TERMINAL, gets: NOTIFICATION_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/settings/voice', label: 'Voice', source: SETTINGS_SOURCE('/settings/voice', 'Voice'), terminal: VOICE_TERMINAL, gets: VOICE_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/settings/system', label: 'System status', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/system', 'System status'), terminal: SYSTEM_TERMINAL, gets: SYSTEM_GETS, surfaceScaleBearing: false, loadScaleBearing: false, targetStructuralNote: 'alarms_and_errors_differ_by_target' }),
  row({ surfaceId: '/settings/ai-runs', label: 'AI run log', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/ai-runs', 'AI run log'), terminal: AI_RUN_TERMINAL, gets: AI_RUN_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/settings/numbers', label: 'Phone numbers', source: SETTINGS_SOURCE('/settings/numbers', 'Phone numbers'), terminal: NUMBER_TERMINAL, gets: NUMBER_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ surfaceId: '/contacts/:contactId', label: 'Contact detail', resolver: 'contact', source: source('/contacts/tenants', locator('heading', 'Tenants'), link(':resolved_cold_target'), CONTACT_LIVE_WALK), terminal: CONTACT_DETAIL_TERMINAL, gets: CONTACT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: true, blockedSurface: 'contact_detail' }),
  row({ surfaceId: '/listings/:unitId', label: 'Property detail', resolver: 'unit', source: source('/listings', L.properties, link(':resolved_cold_target'), UNIT_LIVE_WALK), terminal: UNIT_DETAIL_TERMINAL, gets: UNIT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ surfaceId: '/tours/:tourId', label: 'Tour detail', resolver: 'tour', source: source('/tours', L.tours, link(':resolved_cold_target'), TOUR_LIST_ACTIVE_GETS), terminal: TOUR_DETAIL_TERMINAL, gets: TOUR_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: false, blockedSurface: 'thread_detail' }),
  row({ surfaceId: '/placements/:placementId', label: 'Placement detail', resolver: 'placement', source: source('/placements', L.placements, link(':resolved_cold_target'), PLACEMENT_LIST_GETS), terminal: PLACEMENT_DETAIL_TERMINAL, gets: PLACEMENT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: false, blockedSurface: 'thread_detail' }),
  row({ surfaceId: '/conversations/:conversationId', label: 'Relay conversation detail', resolver: 'conversation', source: INBOX_DETAIL_SOURCE(inboxGets('inbox_page_all')), terminal: CONVERSATION_DETAIL_TERMINAL, gets: CONVERSATION_DETAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true, blockedSurface: 'conversation_detail' }),
  row({ surfaceId: '/broadcasts/:broadcastId', label: 'Broadcast results', resolver: 'broadcast', source: source('/broadcasts', L.matching, link(':resolved_cold_target'), BROADCAST_LIST_GETS), terminal: BROADCAST_DETAIL_TERMINAL, gets: BROADCAST_DETAIL_GETS, surfaceScaleBearing: true, loadScaleBearing: false }),
]);

export function assertRouteRegistry(routes: readonly RouteDefinition[]): void {
  const assertSelectedLocator = (locator: LocatorContract): void => {
    if (locator.selected === true && (locator.role !== 'tab' || locator.exactness !== 'exact')) {
      throw new Error('selected_locator_must_be_exact_tab');
    }
  };
  const assertTerminalLocators = (terminal: TerminalContract): void => {
    for (const locator of [
      ...terminal.structure,
      ...terminal.populated,
      ...terminal.empty,
      ...terminal.error,
      ...terminal.populatedAlternatives.flat(),
      ...terminal.emptyAlternatives.flat(),
    ]) assertSelectedLocator(locator);
  };
  const surfaceIds = new Set<string>();
  for (const route of routes) {
    if (surfaceIds.has(route.surfaceId)) throw new Error('duplicate_surface_id');
    surfaceIds.add(route.surfaceId);
    if (route.resolver === 'static' && route.coldTarget.kind !== 'static') {
      throw new Error('static_cold_target_required');
    }
    if (route.resolver !== 'static' && route.coldTarget.kind !== 'resolved') {
      throw new Error('resolved_cold_target_required');
    }
    if (route.source.target.query.kind === 'fixed'
      && !['unread', 'unknown', 'groups'].includes(route.source.target.query.values.filter)) {
      throw new Error('invalid_exact_query_state');
    }
    if (route.source.action.kind === 'tab' && route.source.action.name.length === 0) {
      throw new Error('tab_action_name_required');
    }
    if (route.source.action.kind === 'link' && route.source.action.href.length === 0) {
      throw new Error('link_action_href_required');
    }
    if (route.source.action.kind === 'link' && route.coldTarget.kind === 'static'
      && route.source.action.href !== route.coldTarget.path) {
      throw new Error('static_link_target_required');
    }
    if (route.source.action.kind === 'link' && route.coldTarget.kind === 'resolved'
      && route.source.action.href !== ':resolved_cold_target') {
      throw new Error('resolved_link_target_required');
    }
    assertSelectedLocator(route.source.ready);
    if (route.source.sourceSelected !== undefined) assertSelectedLocator(route.source.sourceSelected);
    if (route.source.sourceTerminal !== undefined) assertTerminalLocators(route.source.sourceTerminal);
    assertTerminalLocators(route.terminal);
  }
}

assertRouteRegistry(ROUTES);

export const CONTRACT_SOURCE_LEDGER = Object.freeze({
  endpoints: Object.freeze({
    '/': { base: 'dashboard/src/routes/today/useToday.ts:41-74' },
    '/contacts': { base: 'dashboard/src/routes/contacts/useContacts.ts:14-99' },
    '/contacts/tenants': { base: 'dashboard/src/routes/contacts/useContacts.ts:14-99' },
    '/contacts/landlords': { base: 'dashboard/src/routes/contacts/useContacts.ts:14-99' },
    '/contacts/unknown': { base: 'dashboard/src/routes/contacts/useContacts.ts:14-99' },
    '/contacts/deleted': { base: 'dashboard/src/routes/contacts/useContacts.ts:14-99' },
    '/listings': { base: 'dashboard/src/routes/listings/useListings.ts:10-60' },
    '/listings/deleted': { base: 'dashboard/src/routes/listings/useListings.ts:10-60' },
    '/tours': { base: 'dashboard/src/routes/tours/useTours.ts:37-123; dashboard/src/routes/tours/ToursPage.tsx:181-185' },
    '/tours/closed': { base: 'dashboard/src/routes/tours/useTours.ts:37-123; dashboard/src/routes/tours/ToursPage.tsx:181-185' },
    '/placements': { base: 'dashboard/src/routes/placements/usePlacements.ts:50-128,214-225' },
    'inbox-all': { base: 'dashboard/src/routes/inbox/useInbox.ts:46-65,139-155' },
    'inbox-unread': { base: 'dashboard/src/routes/inbox/useInbox.ts:46-65,139-155' },
    'inbox-unknown': { base: 'dashboard/src/routes/inbox/useInbox.ts:46-65,139-155' },
    'inbox-groups': { base: 'dashboard/src/routes/inbox/useInbox.ts:46-65,139-155' },
    '/email': { base: 'dashboard/src/routes/email/EmailTriage.tsx:237-238; dashboard/src/routes/email/useUnmatchedEmail.ts:69-158' },
    '/email/quarantine': { base: 'dashboard/src/routes/email/EmailTriage.tsx:237-238; dashboard/src/routes/email/useUnmatchedEmail.ts:69-158' },
    '/broadcasts': { base: 'dashboard/src/routes/broadcasts/useBroadcastsList.ts:29-52,85-108' },
    '/settings/team': { base: 'dashboard/src/routes/settings/useTeam.ts:16-37' },
    '/settings/templates': { base: 'dashboard/src/routes/settings/useSettings.ts:18-62' },
    '/settings/notifications': { base: 'dashboard/src/routes/settings/NotificationsSection.tsx:22-100' },
    '/settings/voice': { base: 'dashboard/src/routes/settings/VoiceSection.tsx:93-127,176' },
    '/settings/system': { base: 'dashboard/src/routes/settings/useSettings.ts:18-62; dashboard/src/routes/settings/useSystemStatus.ts:77-132' },
    '/settings/ai-runs': { base: 'dashboard/src/routes/settings/aiRuns/useAiRuns.ts:32-105' },
    '/settings/numbers': { base: 'dashboard/src/routes/settings/NumbersSection.tsx:89-164,207-244' },
    '/contacts/:contactId': { base: 'dashboard/src/routes/contact/useContactFile.ts:115-136; dashboard/src/api/endpoints.ts:1228-1239; dashboard/src/routes/contact/useContactTimeline.ts:130-185,320-337' },
    '/listings/:unitId': { base: 'dashboard/src/routes/listing/useListing.ts:110-185; dashboard/src/routes/listing/ListingDetail.tsx:184-185' },
    '/tours/:tourId': { base: 'dashboard/src/routes/tours/useTourChannels.ts:100-289; dashboard/src/routes/shared/useRoster.ts:75-137' },
    '/placements/:placementId': { base: 'dashboard/src/routes/placements/usePlacementChannels.ts:101-299; dashboard/src/routes/shared/useRoster.ts:75-137' },
    '/conversations/:conversationId': { base: 'dashboard/src/routes/conversation/ConversationDetail.tsx:173-214' },
    '/broadcasts/:broadcastId': { base: 'dashboard/src/routes/broadcasts/useBroadcastResults.ts:41-155' },
  } as const),
  warmRequirementClassifications: Object.freeze({
    '/email/quarantine': Object.freeze({
      source: 'dashboard/src/routes/email/EmailTriage.tsx:237-239; dashboard/src/routes/email/useUnmatchedEmail.ts:82-118',
      reason: 'The sibling route changes the unmatched-email filter while the same EmailTriage tree keeps the contacts hook mounted, so only the filtered unmatched-email request is passive navigation work.',
    }),
    '/tours/closed': Object.freeze({
      source: 'dashboard/src/routes/tours/ToursPage.tsx:181-198; dashboard/src/routes/tours/useTours.ts:112-149',
      reason: 'The sibling route enables useClosedTours while the active-tour and cross-reference hooks remain mounted, so only the status-filtered closed-tour request is passive navigation work.',
    }),
  } as const),
  branches: Object.freeze({
    contact_detail_tenant: 'dashboard/src/routes/contact/useContactFile.ts:101-165',
    contact_detail_landlord_with_units: 'dashboard/src/routes/contact/useContactFile.ts:101-165',
    contact_detail_other: 'dashboard/src/routes/contact/useContactFile.ts:101-165',
    unit_detail_with_landlord: 'dashboard/src/routes/listing/useListing.ts:110-185',
    unit_detail_without_landlord: 'dashboard/src/routes/listing/useListing.ts:110-185',
    tour_group_thread: 'dashboard/src/routes/tours/useTourChannels.ts:106-152,181-205,252-289',
    tour_person_thread: 'dashboard/src/routes/tours/useTourChannels.ts:106-152,181-205,252-289',
    placement_group_thread: 'dashboard/src/routes/placements/usePlacementChannels.ts:107-153,182-206,262-299',
    placement_person_thread: 'dashboard/src/routes/placements/usePlacementChannels.ts:107-153,182-206,262-299',
  } as const),
  terminals: Object.freeze({
    '/': 'dashboard/src/routes/today/Today.tsx:27-31,172-188',
    '/contacts': 'dashboard/src/routes/contacts/ContactsList.tsx:232,290-301',
    '/contacts/tenants': 'dashboard/src/routes/contacts/ContactsList.tsx:232,290-301',
    '/contacts/landlords': 'dashboard/src/routes/contacts/ContactsList.tsx:232,290-301',
    '/contacts/unknown': 'dashboard/src/routes/contacts/ContactsList.tsx:232,290-301',
    '/contacts/deleted': 'dashboard/src/routes/contacts/ContactsList.tsx:232,290-301',
    '/listings': 'dashboard/src/routes/listings/ListingsList.tsx:144,248-257',
    '/listings/deleted': 'dashboard/src/routes/listings/ListingsList.tsx:144,248-257',
    '/tours': 'dashboard/src/routes/tours/ToursPage.tsx:250-346',
    '/tours/closed': 'dashboard/src/routes/tours/ToursPage.tsx:250-346',
    '/placements': 'dashboard/src/routes/placements/PlacementsPage.tsx:128-176',
    'inbox-all': 'dashboard/src/routes/inbox/Inbox.tsx:53-75',
    'inbox-unread': 'dashboard/src/routes/inbox/Inbox.tsx:53-75',
    'inbox-unknown': 'dashboard/src/routes/inbox/Inbox.tsx:53-75',
    'inbox-groups': 'dashboard/src/routes/inbox/Inbox.tsx:53-75',
    '/email': 'dashboard/src/routes/email/EmailTriage.tsx:276-348',
    '/email/quarantine': 'dashboard/src/routes/email/EmailTriage.tsx:276-348',
    '/broadcasts': 'dashboard/src/routes/broadcasts/BroadcastsList.tsx:130-140',
    '/settings/team': 'dashboard/src/routes/settings/TeamSection.tsx:42-91',
    '/settings/templates': 'dashboard/src/routes/settings/TemplatesSection.tsx:62-108',
    '/settings/notifications': 'dashboard/src/routes/settings/NotificationsSection.tsx:22-100',
    '/settings/voice': 'dashboard/src/routes/settings/VoiceSection.tsx:93-127,176',
    '/settings/system': 'dashboard/src/routes/settings/QuietHoursSection.tsx:135-155; dashboard/src/routes/settings/FlagPills.tsx:41-69; dashboard/src/routes/settings/AlarmGrid.tsx:43-95; dashboard/src/routes/settings/RecentErrors.tsx:69-129',
    '/settings/ai-runs': 'dashboard/src/routes/settings/aiRuns/AiRunList.tsx:43-47',
    '/settings/numbers': 'dashboard/src/routes/settings/NumbersSection.tsx:150-164,207-244',
    '/contacts/:contactId': 'dashboard/src/routes/contact/ContactDetail.tsx:151-164; dashboard/src/routes/contact/TenantFile.tsx:152; dashboard/src/routes/contact/Card.tsx:18-25',
    '/listings/:unitId': 'dashboard/src/routes/listing/ListingDetail.tsx:1180-1187',
    '/tours/:tourId': 'dashboard/src/routes/tours/TourDetail.tsx:551',
    '/placements/:placementId': 'dashboard/src/routes/placements/PlacementDetail.tsx:515',
    '/conversations/:conversationId': 'dashboard/src/routes/conversation/ConversationDetail.tsx:397-402',
    '/broadcasts/:broadcastId': 'dashboard/src/routes/broadcasts/BroadcastResults.tsx:159-162',
  } as const),
  resolvers: Object.freeze({
    static: 'dashboard/src/App.tsx:117-249; dashboard/src/app/nav.ts:55-100',
    contact: 'dashboard/src/routes/contacts/useContacts.ts:14-99',
    unit: 'dashboard/src/routes/listings/useListings.ts:10-60',
    tour: 'dashboard/src/routes/tours/useTours.ts:37-72',
    placement: 'dashboard/src/routes/placements/usePlacements.ts:50-64,214-225',
    conversation: 'dashboard/src/routes/inbox/useInbox.ts:46-103',
    broadcast: 'dashboard/src/routes/broadcasts/useBroadcastsList.ts:29-52,85-108',
  } as const),
  blockedWrites: Object.freeze({
    contact_detail: 'dashboard/src/routes/contact/useMarkContactRead.ts:15-47; dashboard/src/api/endpoints.ts:1493-1503',
    conversation_detail: 'dashboard/src/routes/conversation/ConversationDetail.tsx:210-214; dashboard/src/api/endpoints.ts:822-830',
    group_thread: 'dashboard/src/routes/tours/useTourChannels.ts:252-289; dashboard/src/routes/placements/usePlacementChannels.ts:262-299',
    person_thread: 'dashboard/src/routes/tours/useTourChannels.ts:252-289; dashboard/src/routes/placements/usePlacementChannels.ts:262-299',
    contact_inbox_probe: 'dashboard/src/routes/inbox/InboxRow.tsx:73; dashboard/src/routes/inbox/useInbox.ts:180-212',
    unmatched_email_probe: 'dashboard/src/routes/email/UnmatchedRow.tsx:98-116; dashboard/src/routes/email/useUnmatchedEmail.ts:181-195',
  } as const),
  background: Object.freeze({
    systemAlarms: 'dashboard/src/routes/settings/useSystemStatus.ts:124-132',
    tourReminders: 'dashboard/src/routes/tours/RemindersPanel.tsx:188-208',
    placementNudges: 'dashboard/src/routes/placements/usePlacementNudges.ts:96-116',
    unreadShell: 'dashboard/src/app/UnreadContext.tsx:19,52-115',
    today: 'dashboard/src/routes/today/useToday.ts:39,126-145',
    inbox: 'dashboard/src/routes/inbox/useInbox.ts:49,139-155',
    unmatchedEmail: 'dashboard/src/routes/email/useUnmatchedEmail.ts:69,142-158',
    roster: 'dashboard/src/routes/shared/useRoster.ts:98-137',
    tourChannels: 'dashboard/src/routes/tours/useTourChannels.ts:100,221-241',
    placementChannels: 'dashboard/src/routes/placements/usePlacementChannels.ts:101,229-249',
    contactTimeline: 'dashboard/src/routes/contact/useContactTimeline.ts:91,320-337',
    broadcastResults: 'dashboard/src/routes/broadcasts/useBroadcastResults.ts:41,120-138',
  } as const),
});

export const CONTACT_INBOX_PROBE: ProbeDefinition = Object.freeze({ key: 'contact_inbox_probe', blockedSurface: 'contact_inbox_probe' });
export const UNMATCHED_EMAIL_PROBE: ProbeDefinition = Object.freeze({ key: 'unmatched_email_probe', blockedSurface: 'unmatched_email_probe' });

function contractKey(contract: EndpointContract): string {
  return `${contract.endpointTemplate}?${contract.queryKeys.join('&')}#${contract.requirement}#${contract.inboxRequestClass ?? ''}`;
}

function freezeContracts(contracts: readonly EndpointContract[]): readonly EndpointContract[] {
  const seen = new Set<string>();
  return Object.freeze(contracts.filter((contract) => {
    const key = contractKey(contract);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((contract) => Object.freeze({ ...contract, queryKeys: Object.freeze([...contract.queryKeys]) })));
}

function selectedDestination(route: RouteDefinition, branch: RouteContractBranch): readonly EndpointContract[] {
  if (route.surfaceId === '/contacts/:contactId') {
    if (branch.kind !== 'contact_detail') throw new Error('route_branch_mismatch');
    if (branch.contactType === 'tenant') return [...route.gets, required('/api/tours', ['tenantId'])];
    if (branch.contactType === 'landlord' && branch.landlordUnitCount > 0) {
      return [...route.gets, required('/api/tours', ['unitId'])];
    }
    return route.gets;
  }
  if (route.surfaceId === '/listings/:unitId') {
    if (branch.kind !== 'unit_detail') throw new Error('route_branch_mismatch');
    return branch.hasLandlord ? [...route.gets, required('/api/contacts/:contactId')] : route.gets;
  }
  if (route.surfaceId === '/tours/:tourId' || route.surfaceId === '/placements/:placementId') {
    if (branch.kind !== 'thread_detail') throw new Error('route_branch_mismatch');
    return [...route.gets, ...(branch.thread === 'group_thread' ? GROUP_THREAD_GETS : PERSON_THREAD_GETS)];
  }
  if (branch.kind !== 'none') throw new Error('route_branch_mismatch');
  return route.gets;
}

export function expectedGets(
  route: RouteDefinition,
  mode: SampleMode,
  branch: RouteContractBranch,
): readonly EndpointContract[] {
  let destination = selectedDestination(route, branch);
  // These two warm-only class changes are audited in
  // CONTRACT_SOURCE_LEDGER.warmRequirementClassifications. They model sibling
  // route persistence; they are not checkpoint-driven contract weakening.
  if (mode === 'warm' && route.surfaceId === '/email/quarantine') {
    destination = destination.map((contract) => contract.endpointTemplate === '/api/unmatched-email'
      ? contract
      : { ...contract, requirement: 'conditional' });
  } else if (mode === 'warm' && route.surfaceId === '/tours/closed') {
    destination = destination.map((contract) => contract.endpointTemplate === '/api/tours'
      && contract.queryKeys.length === 1
      && contract.queryKeys[0] === 'status'
      ? contract
      : { ...contract, requirement: 'conditional' });
  }
  return freezeContracts(mode === 'cold' ? [...COLD_SHELL_GETS, ...destination] : destination);
}

export function assertObservedGets(
  declared: readonly EndpointContract[],
  observed: readonly ObservedEndpointContract[],
): { missingRequired: EndpointContract[]; undeclared: EndpointContract[] } {
  const endpointShape = (contract: Pick<EndpointContract, 'endpointTemplate' | 'queryKeys' | 'inboxRequestClass'>): string =>
    `${contract.endpointTemplate}?${[...contract.queryKeys].sort().join('&')}#${contract.inboxRequestClass ?? ''}`;
  const declarationShapes = new Set(declared.map(endpointShape));
  const observedShapes = new Set(observed
    .filter((contract) =>
      (contract.outcome === undefined || contract.outcome === 'finished')
      && (contract.status === undefined || contract.status === null
        || (contract.status >= 200 && contract.status < 300)))
    .map(endpointShape));
  return {
    missingRequired: declared.filter((contract) => contract.requirement === 'required' && !observedShapes.has(endpointShape(contract))),
    undeclared: observed.filter((contract) => !declarationShapes.has(endpointShape(contract))),
  };
}

export interface ObservedEndpointContract extends EndpointContract {
  readonly outcome?: 'finished' | 'failed' | 'aborted';
  readonly status?: number | null;
}

function tuple(surface: BlockedWriteSurface, path: EndpointTemplate, phase: 'source_click' | 'destination_mount'): BlockedWriteTuple {
  return `${surface}|POST|${path}|${phase}`;
}

export function expectedBlockedWrites(
  route: RouteDefinition | ProbeDefinition,
  mode: SampleMode,
  branch: RouteContractBranch,
): ReadonlySet<BlockedWriteTuple> {
  const rows: BlockedWriteTuple[] = [];
  if (route.blockedSurface === 'contact_detail') {
    rows.push(tuple('contact_detail', '/api/inbox/:contactId/read', 'destination_mount'));
  } else if (route.blockedSurface === 'conversation_detail') {
    if (mode === 'warm') rows.push(tuple('conversation_detail', '/api/conversations/:conversationId/read', 'source_click'));
    rows.push(tuple('conversation_detail', '/api/conversations/:conversationId/read', 'destination_mount'));
  } else if (route.blockedSurface === 'thread_detail') {
    if (branch.kind !== 'thread_detail') throw new Error('route_branch_mismatch');
    if (branch.expectsMountWrite) {
      rows.push(branch.thread === 'group_thread'
        ? tuple('group_thread', '/api/conversations/:conversationId/read', 'destination_mount')
        : tuple('person_thread', '/api/inbox/:contactId/read', 'destination_mount'));
    }
  } else if (route.blockedSurface === 'contact_inbox_probe') {
    if (mode === 'warm') rows.push(tuple('contact_inbox_probe', '/api/inbox/:contactId/read', 'source_click'));
    rows.push(tuple('contact_inbox_probe', '/api/inbox/:contactId/read', 'destination_mount'));
  } else if (route.blockedSurface === 'unmatched_email_probe') {
    rows.push(tuple('unmatched_email_probe', '/api/unmatched-email/:unmatchedId/read', 'source_click'));
  }
  return new FrozenReadonlySet(rows);
}

class FrozenReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  has(value: T): boolean { return this.#values.has(value); }
  entries(): SetIterator<[T, T]> { return this.#values.entries(); }
  keys(): SetIterator<T> { return this.#values.keys(); }
  values(): SetIterator<T> { return this.#values.values(); }
  [Symbol.iterator](): SetIterator<T> { return this.values(); }
  get [Symbol.toStringTag](): string { return 'Set'; }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#values.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
}

export interface ResolverApi {
  get(path: string, query: Readonly<Record<string, string>>): Promise<unknown>;
}

export interface ResolverDom {
  hasExactLink(href: string): Promise<boolean>;
  browserNow(): Promise<Date>;
  sourceReady?(): Promise<boolean>;
}

export type ResolverResult =
  | { kind: 'resolved'; coldPath: string; warmTarget: ExactBrowserTarget; branch: RouteContractBranch }
  | { kind: 'skip'; reason: 'fixture_absent' | 'fixture_not_navigable' | 'required_action_missing' | 'source_not_ready' | 'unresolved_branch' };

export function resolverSkipSampleResult(
  surfaceId: string,
  mode: SampleMode,
  repeat: number,
  reason: Extract<ResolverResult, { kind: 'skip' }>['reason'],
): SampleResult {
  const status = reason === 'fixture_absent'
    ? 'skipped_no_fixture'
    : reason === 'fixture_not_navigable'
      ? 'skipped_fixture_not_navigable'
      : reason === 'required_action_missing'
        ? 'skipped_required_action_missing'
      : reason === 'source_not_ready'
        ? 'skipped_source_not_ready'
        : 'skipped_unresolved_branch';
  return {
    surfaceId,
    mode,
    repeat,
    status,
    readyMs: null,
    navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    paint: { fcpMs: null, lcpMs: null },
    longTasks: { totalMs: 0, maxMs: 0, count: 0 },
    domElements: null,
    apiRequestCount: 0,
    apiTransferBytes: 0,
    resourceRequestCount: 0,
    resourceTransferBytes: 0,
    resourceCountsByClass: { document: 0, script: 0, style: 0, font: 0, image: 0, api: 0, other: 0 },
    backgroundRequestCount: 0,
    backgroundTransferBytes: 0,
    blockedWrites: [],
    consoleCategories: {},
    clientTruncated: false,
    terminalState: 'unknown',
    surfaceEvidence: null,
    reason,
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function rowsFrom(value: unknown, key: string): Record<string, unknown>[] {
  const rows = object(value)[key];
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : [];
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function bindResolved(
  dom: ResolverDom,
  href: string,
  branch: RouteContractBranch,
): Promise<ResolverResult> {
  if (dom.sourceReady !== undefined && !await dom.sourceReady()) {
    return { kind: 'skip', reason: 'source_not_ready' };
  }
  if (!await dom.hasExactLink(href)) return { kind: 'skip', reason: 'fixture_not_navigable' };
  return { kind: 'resolved', coldPath: href, warmTarget: exactTargetFromPath(href), branch };
}

export interface BoundSelfQaFixtures {
  contact_detail: string;
  conversation_detail: string;
  tour_id: string;
  placement_id: string;
}

export function resolveBoundSelfQaDetail(
  surfaceId: string,
  fixtures: Readonly<BoundSelfQaFixtures>,
  dom: ResolverDom,
): Promise<ResolverResult> {
  if (surfaceId === '/contacts/:contactId') {
    return bindResolved(dom, `/contacts/${fixtures.contact_detail}`, {
      kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0,
    });
  }
  if (surfaceId === '/conversations/:conversationId') {
    return bindResolved(dom, `/conversations/${fixtures.conversation_detail}`, { kind: 'none' });
  }
  if (surfaceId === '/tours/:tourId') {
    return bindResolved(dom, `/tours/${fixtures.tour_id}`, {
      kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true,
    });
  }
  if (surfaceId === '/placements/:placementId') {
    return bindResolved(dom, `/placements/${fixtures.placement_id}`, {
      kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true,
    });
  }
  throw new Error('self_qa_bound_route_invalid');
}

export async function resolveContactDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  let cursor: string | undefined;
  do {
    const page = object(await api.get('/api/contacts', { type: 'tenant', limit: '100', ...(cursor !== undefined && { cursor }) }));
    const match = rowsFrom(page, 'contacts').find((row) => row.deleted_at === undefined && stringField(row, 'contactId') !== undefined);
    if (match !== undefined) {
      return bindResolved(dom, `/contacts/${stringField(match, 'contactId')!}`, {
        kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0,
      });
    }
    cursor = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return { kind: 'skip', reason: 'fixture_absent' };
}

export async function resolveUnitDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  let cursor: string | undefined;
  do {
    const page = object(await api.get('/api/units', { ...(cursor !== undefined && { cursor }) }));
    const match = rowsFrom(page, 'units').find((row) => row.deleted_at === undefined && stringField(row, 'unitId') !== undefined);
    if (match !== undefined) {
      return bindResolved(dom, `/listings/${stringField(match, 'unitId')!}`, {
        kind: 'unit_detail', hasLandlord: stringField(match, 'landlordId') !== undefined,
      });
    }
    cursor = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return { kind: 'skip', reason: 'fixture_absent' };
}

// Parity with dashboard/src/routes/tours/useTours.ts:37-42. The resolver owns the live clock.
export function computeTourWindow(now: Date): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function positiveUnread(row: Record<string, unknown>): boolean {
  return typeof row.unread_count === 'number'
    && Number.isSafeInteger(row.unread_count)
    && row.unread_count > 0;
}

function conversationInvolves(row: Record<string, unknown>, contactId: string): boolean {
  return Array.isArray(row.participants) && row.participants.some((participant) => {
    if (typeof participant === 'string') return participant === contactId;
    const value = object(participant);
    return value.contactId === contactId;
  });
}

async function threadDetailBranch(
  api: ResolverApi,
  row: Record<string, unknown>,
  groupField: 'groupThreadId' | 'group_thread',
): Promise<RouteContractBranch | Extract<ResolverResult, { kind: 'skip' }>> {
  const groupId = stringField(row, groupField);
  const tenantId = stringField(row, 'tenantId');
  let page: Record<string, unknown>;
  try {
    page = object(await api.get('/api/conversations', {}));
  } catch {
    return { kind: 'skip', reason: 'unresolved_branch' };
  }
  if (!Array.isArray(page.conversations)) return { kind: 'skip', reason: 'unresolved_branch' };
  const conversations = rowsFrom(page, 'conversations');
  if (groupId !== undefined) {
    return {
      kind: 'thread_detail',
      thread: 'group_thread',
      expectsMountWrite: conversations.some((conversation) =>
        stringField(conversation, 'conversationId') === groupId && positiveUnread(conversation)),
    };
  }
  return {
    kind: 'thread_detail',
    thread: 'person_thread',
    expectsMountWrite: tenantId !== undefined && conversations.some((conversation) =>
      conversation.type !== 'relay_group'
      && positiveUnread(conversation)
      && conversationInvolves(conversation, tenantId)),
  };
}

export async function resolveTourDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  const range = computeTourWindow(await dom.browserNow());
  const page = object(await api.get('/api/tours', range));
  const match = rowsFrom(page, 'tours')
    .filter((row) => row.status === 'scheduled' && stringField(row, 'tourId') !== undefined)
    .sort((left, right) => (stringField(left, 'scheduledAt') ?? '').localeCompare(stringField(right, 'scheduledAt') ?? ''))[0];
  if (match === undefined) return { kind: 'skip', reason: 'fixture_absent' };
  const branch = await threadDetailBranch(api, match, 'groupThreadId');
  if (branch.kind === 'skip') return branch;
  return bindResolved(
    dom,
    `/tours/${stringField(match, 'tourId')!}`,
    branch,
  );
}

export async function resolvePlacementDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  let cursor: string | undefined;
  do {
    const page = object(await api.get('/api/placements', { ...(cursor !== undefined && { cursor }) }));
    const match = rowsFrom(page, 'placements').find((row) => {
      const stage = stringField(row, 'stage');
      return stringField(row, 'placementId') !== undefined && stage !== 'moved_in' && stage !== 'lost';
    });
    if (match !== undefined) {
      const branch = await threadDetailBranch(api, match, 'group_thread');
      if (branch.kind === 'skip') return branch;
      return bindResolved(
        dom,
        `/placements/${stringField(match, 'placementId')!}`,
        branch,
      );
    }
    cursor = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return { kind: 'skip', reason: 'fixture_absent' };
}

export async function resolveConversationDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  const page = await api.get('/api/inbox', { filter: 'all', limit: '30' });
  const match = rowsFrom(page, 'rows').find((row) => row.kind === 'relay_group' && stringField(row, 'conversationId') !== undefined);
  if (match === undefined) return { kind: 'skip', reason: 'fixture_absent' };
  return bindResolved(dom, `/conversations/${stringField(match, 'conversationId')!}`, { kind: 'none' });
}

export async function resolveBroadcastDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  const page = await api.get('/api/broadcasts', { limit: '50' });
  const match = rowsFrom(page, 'broadcasts').find((row) =>
    (row.status === 'sent' || row.status === 'failed') && stringField(row, 'broadcastId') !== undefined,
  );
  if (match === undefined) return { kind: 'skip', reason: 'fixture_absent' };
  return bindResolved(dom, `/broadcasts/${stringField(match, 'broadcastId')!}`, { kind: 'none' });
}
