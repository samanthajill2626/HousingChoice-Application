import type { SampleMode } from './types.js';
import { assertEndpointTemplate, type EndpointTemplate } from './templates.js';

export type EndpointRequirement = 'required' | 'conditional';

export interface EndpointContract {
  endpointTemplate: EndpointTemplate;
  queryKeys: readonly string[];
  requirement: EndpointRequirement;
}

export type RouteContractBranch =
  | { kind: 'none' }
  | { kind: 'contact_detail'; contactType: 'tenant' | 'landlord' | 'other'; landlordUnitCount: number }
  | { kind: 'unit_detail'; hasLandlord: boolean }
  | { kind: 'thread_detail'; thread: 'group_thread' | 'person_thread' };

export type LocatorExactness = 'exact' | 'prefix' | 'contains' | 'regex' | 'role_only';

export interface LocatorContract {
  role: string;
  exactness: LocatorExactness;
  name?: string;
  scope?: string;
}

export interface TerminalContract {
  viewportDependency: 'desktop_chrome';
  structure: readonly LocatorContract[];
  populated: readonly LocatorContract[];
  empty: readonly LocatorContract[];
  error: readonly LocatorContract[];
  combine: 'any' | 'all';
}

export interface WarmSourceContract {
  path: string;
  ready: LocatorContract;
  click: LocatorContract;
  href: string;
  exactHref: true;
  viewportDependency: 'desktop_chrome';
  gets: readonly EndpointContract[];
}

export type ResolverName = 'static' | 'contact' | 'unit' | 'tour' | 'placement' | 'conversation' | 'broadcast';

export interface RouteDefinition {
  key: string;
  label: string;
  pathTemplate: string;
  requiredRole: 'staff' | 'admin';
  viewportDependency: 'desktop_chrome';
  resolver: ResolverName;
  source: WarmSourceContract;
  terminal: TerminalContract;
  gets: readonly EndpointContract[];
  surfaceScaleBearing: boolean;
  sourceLoadScaleBearing: boolean;
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
): EndpointContract {
  assertEndpointTemplate(endpointTemplate);
  return Object.freeze({
    endpointTemplate,
    queryKeys: Object.freeze([...queryKeys].sort()),
    requirement,
  });
}

function required(path: EndpointTemplate, queryKeys: readonly string[] = []): EndpointContract {
  return endpoint(path, queryKeys, 'required');
}

function conditional(path: EndpointTemplate, queryKeys: readonly string[] = []): EndpointContract {
  return endpoint(path, queryKeys, 'conditional');
}

function locator(
  role: string,
  name?: string,
  exactness: LocatorExactness = 'exact',
  scope?: string,
): LocatorContract {
  return Object.freeze({ role, exactness, ...(name !== undefined && { name }), ...(scope !== undefined && { scope }) });
}

function terminal(
  populated: readonly LocatorContract[],
  empty: readonly LocatorContract[],
  error: readonly LocatorContract[],
  structure: readonly LocatorContract[] = [],
  combine: 'any' | 'all' = 'any',
): TerminalContract {
  return Object.freeze({
    viewportDependency: 'desktop_chrome' as const,
    structure: Object.freeze([...structure]),
    populated: Object.freeze([...populated]),
    empty: Object.freeze([...empty]),
    error: Object.freeze([...error]),
    combine,
  });
}

const COLD_SHELL_GETS = Object.freeze([
  required('/auth/me'),
  required('/api/inbox', ['filter', 'limit']),
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
const INBOX_GETS = Object.freeze([required('/api/inbox', ['filter', 'limit'])]);
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
  required('/api/contacts/:contactId/relay-groups'), ...CONTACT_LIVE_WALK,
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
  'all',
);
const TOUR_CLOSED_TERMINAL = terminal([locator('list', 'Closed tours list')], [locator('text', 'No closed or canceled tours yet.')], [L.alert]);
const PLACEMENT_TERMINAL = terminal(
  [locator('list', undefined, 'role_only')], [locator('text', 'No active placements.')],
  [locator('alert', "We couldn't load placements. Please try again.")], [locator('searchbox', 'Search placements')],
);
const INBOX_TERMINAL = terminal(
  [locator('list', 'Conversations')],
  [locator('text', 'No conversations yet'), locator('text', 'The inbox turns on with its backend')], [L.alert],
);
function emailTerminal(quarantine: boolean): TerminalContract {
  return terminal(
    [locator('list', quarantine ? 'Quarantined email' : 'Unmatched email')],
    [locator('text', quarantine ? 'Quarantine is empty' : 'No unmatched email'), locator('text', 'Email triage turns on with its backend')],
    [L.alert],
  );
}
const BROADCAST_TERMINAL = terminal([locator('list', 'Property sends')], [locator('text', 'No sends yet')], [L.alert]);
const TEAM_TERMINAL = terminal([locator('table', undefined, 'role_only')], [locator('text', '^No teammates yet', 'prefix')], [L.alert]);
const TEMPLATE_TERMINAL = terminal([locator('textbox', '^Missed-call auto-text [0-9]+/320$', 'regex')], [], [L.alert]);
const NOTIFICATION_TERMINAL = terminal([locator('heading', 'Notifications')], [], [L.alert]);
const VOICE_TERMINAL = terminal(
  [locator('textbox', 'Your mobile number'), locator('text', 'Your cell'), locator('status', undefined, 'role_only')], [], [L.alert], [], 'any',
);
const SYSTEM_TERMINAL = terminal(
  [
    locator('checkbox', 'Pause automated messages overnight'),
    locator('listitem', '^Environment: ', 'prefix'),
    locator('list', undefined, 'role_only', 'Alarms'),
    locator('text', 'Available in deployed environments.', 'exact', 'Alarms'),
    locator('text', 'No alarms configured for this environment.', 'exact', 'Alarms'),
    locator('list', undefined, 'role_only', 'Recent errors'),
    locator('text', 'Available in deployed environments.', 'exact', 'Recent errors'),
    locator('text', 'No recent errors in this window.', 'exact', 'Recent errors'),
  ], [], [L.alert], [locator('heading', 'Alarms'), locator('heading', 'Recent errors')], 'all',
);
const AI_RUN_TERMINAL = terminal([locator('list', 'AI runs')], [locator('text', 'No extraction runs match this scope.')], [L.alert]);
const NUMBER_TERMINAL = terminal(
  [
    locator('text', 'Not set', 'exact', 'Our number'),
    locator('text', '^(?:\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}|\\+[0-9]{8,15})$', 'regex', 'Our number'),
    locator('list', 'Pool number counts'),
  ],
  [locator('text', 'No group text numbers yet - a number is provisioned with the first group text.')],
  [locator('text', "Couldn't load our number."), L.alert],
  [locator('heading', 'Our number'), locator('heading', 'Group text numbers')],
  'all',
);
const CONTACT_DETAIL_TERMINAL = terminal(
  [locator('heading', '^Details(?: Edit)?$', 'regex'), locator('region', 'Communications and activity')], [], [L.alert], [], 'all',
);
const UNIT_DETAIL_TERMINAL = terminal([locator('heading', undefined, 'role_only'), locator('heading', 'Photos')], [], [L.alert], [], 'all');
const TOUR_DETAIL_TERMINAL = terminal([locator('link', 'Back to tours')], [], [L.alert]);
const PLACEMENT_DETAIL_TERMINAL = terminal([locator('link', 'Back to placements')], [], [L.alert]);
const CONVERSATION_DETAIL_TERMINAL = terminal([locator('text', 'Group text'), locator('link', 'Back to inbox')], [], [L.alert], [], 'all');
const BROADCAST_DETAIL_TERMINAL = terminal(
  [locator('heading', 'Recipients'), locator('list', undefined, 'role_only', 'Recipients')],
  [locator('text', 'No recipients recorded yet.')], [L.alert], [locator('heading', 'Recipients')],
);

function source(
  path: string,
  ready: LocatorContract,
  clickRole: string,
  clickName: string,
  href: string,
  gets: readonly EndpointContract[],
): WarmSourceContract {
  return Object.freeze({
    path,
    ready,
    click: locator(clickRole, clickName),
    href,
    exactHref: true as const,
    viewportDependency: 'desktop_chrome' as const,
    gets,
  });
}

interface RowInput {
  key: string;
  label: string;
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
    key: input.key,
    label: input.label,
    pathTemplate: input.key,
    requiredRole: input.requiredRole ?? 'staff',
    viewportDependency: 'desktop_chrome' as const,
    resolver: input.resolver ?? 'static',
    source: input.source,
    terminal: input.terminal,
    gets: input.gets,
    surfaceScaleBearing: input.surfaceScaleBearing,
    sourceLoadScaleBearing: input.loadScaleBearing,
    targetStructuralNote: input.targetStructuralNote ?? null,
    streamExclusions: NEVER_STREAM,
    blockedSurface: input.blockedSurface ?? 'none',
  });
}

const NAV_TODAY = (target: string, label: string, gets: readonly EndpointContract[]) => source('/', L.today, 'link', label, target, gets);
const CONTACT_SOURCE = (target: string, label: string, gets: readonly EndpointContract[]) => source('/contacts', L.contacts, 'link', label, target, gets);
const SETTINGS_SOURCE = (target: string, label: string, from = '/settings/templates', gets: readonly EndpointContract[] = TEMPLATE_GETS) =>
  source(from, L.settings, 'tab', label, target, gets);

export const ROUTES: readonly RouteDefinition[] = Object.freeze([
  row({ key: '/', label: 'Today', source: source('/contacts', L.contacts, 'link', 'Today', '/', CONTACT_LIVE_WALK), terminal: TODAY_TERMINAL, gets: TODAY_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/contacts', label: 'Contacts', source: NAV_TODAY('/contacts', 'Contacts', TODAY_GETS), terminal: contactListTerminal('Contacts'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/contacts/tenants', label: 'Tenants', source: CONTACT_SOURCE('/contacts/tenants', 'Tenants', CONTACT_LIVE_WALK), terminal: contactListTerminal('Tenants'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/contacts/landlords', label: 'Landlords', source: CONTACT_SOURCE('/contacts/landlords', 'Landlords', CONTACT_LIVE_WALK), terminal: contactListTerminal('Landlords'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/contacts/unknown', label: 'Unknown', source: CONTACT_SOURCE('/contacts/unknown', 'Unknown', CONTACT_LIVE_WALK), terminal: contactListTerminal('Unknown'), gets: CONTACT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/contacts/deleted', label: 'Deleted contacts', source: CONTACT_SOURCE('/contacts/deleted', 'Deleted', CONTACT_LIVE_WALK), terminal: contactListTerminal('Deleted'), gets: CONTACT_DELETED_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/listings', label: 'Properties', source: NAV_TODAY('/listings', 'Properties', TODAY_GETS), terminal: unitListTerminal(false), gets: UNIT_LIVE_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/listings/deleted', label: 'Deleted properties', source: source('/listings', L.properties, 'link', 'Deleted', '/listings/deleted', UNIT_LIVE_WALK), terminal: unitListTerminal(true), gets: UNIT_DELETED_WALK, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/tours', label: 'Tours', source: NAV_TODAY('/tours', 'Tours', TODAY_GETS), terminal: TOUR_ACTIVE_TERMINAL, gets: TOUR_LIST_ACTIVE_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/tours/closed', label: 'Closed tours', source: source('/tours', L.tours, 'link', 'Closed', '/tours/closed', TOUR_LIST_ACTIVE_GETS), terminal: TOUR_CLOSED_TERMINAL, gets: TOUR_LIST_CLOSED_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/placements', label: 'Placements', source: NAV_TODAY('/placements', 'Placements', TODAY_GETS), terminal: PLACEMENT_TERMINAL, gets: PLACEMENT_LIST_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/inbox', label: 'Inbox', source: NAV_TODAY('/inbox', 'Inbox', TODAY_GETS), terminal: INBOX_TERMINAL, gets: INBOX_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/email', label: 'Email', source: NAV_TODAY('/email', 'Email', TODAY_GETS), terminal: emailTerminal(false), gets: EMAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ key: '/email/quarantine', label: 'Quarantined email', source: source('/email', L.email, 'link', 'Quarantine', '/email/quarantine', EMAIL_GETS), terminal: emailTerminal(true), gets: EMAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ key: '/broadcasts', label: 'Matching', source: NAV_TODAY('/broadcasts', 'Matching', TODAY_GETS), terminal: BROADCAST_TERMINAL, gets: BROADCAST_LIST_GETS, surfaceScaleBearing: true, loadScaleBearing: true }),
  row({ key: '/settings/team', label: 'Team', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/team', 'Team'), terminal: TEAM_TERMINAL, gets: TEAM_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/settings/templates', label: 'Templates', source: SETTINGS_SOURCE('/settings/templates', 'Templates', '/settings/team', TEAM_GETS), terminal: TEMPLATE_TERMINAL, gets: TEMPLATE_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/settings/notifications', label: 'Notifications', source: SETTINGS_SOURCE('/settings/notifications', 'Notifications'), terminal: NOTIFICATION_TERMINAL, gets: NOTIFICATION_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/settings/voice', label: 'Voice', source: SETTINGS_SOURCE('/settings/voice', 'Voice'), terminal: VOICE_TERMINAL, gets: VOICE_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/settings/system', label: 'System status', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/system', 'System status'), terminal: SYSTEM_TERMINAL, gets: SYSTEM_GETS, surfaceScaleBearing: false, loadScaleBearing: false, targetStructuralNote: 'alarms_and_errors_differ_by_target' }),
  row({ key: '/settings/ai-runs', label: 'AI run log', requiredRole: 'admin', source: SETTINGS_SOURCE('/settings/ai-runs', 'AI run log'), terminal: AI_RUN_TERMINAL, gets: AI_RUN_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/settings/numbers', label: 'Phone numbers', source: SETTINGS_SOURCE('/settings/numbers', 'Phone numbers'), terminal: NUMBER_TERMINAL, gets: NUMBER_GETS, surfaceScaleBearing: false, loadScaleBearing: false }),
  row({ key: '/contacts/:contactId', label: 'Contact detail', resolver: 'contact', source: source('/contacts/tenants', locator('heading', 'Tenants'), 'link', 'resolved_exact_href', ':warmHref', CONTACT_LIVE_WALK), terminal: CONTACT_DETAIL_TERMINAL, gets: CONTACT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: true, blockedSurface: 'contact_detail' }),
  row({ key: '/listings/:unitId', label: 'Property detail', resolver: 'unit', source: source('/listings', L.properties, 'link', 'resolved_exact_href', ':warmHref', UNIT_LIVE_WALK), terminal: UNIT_DETAIL_TERMINAL, gets: UNIT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: true }),
  row({ key: '/tours/:tourId', label: 'Tour detail', resolver: 'tour', source: source('/tours', L.tours, 'link', 'resolved_exact_href', ':warmHref', TOUR_LIST_ACTIVE_GETS), terminal: TOUR_DETAIL_TERMINAL, gets: TOUR_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: false, blockedSurface: 'thread_detail' }),
  row({ key: '/placements/:placementId', label: 'Placement detail', resolver: 'placement', source: source('/placements', L.placements, 'link', 'resolved_exact_href', ':warmHref', PLACEMENT_LIST_GETS), terminal: PLACEMENT_DETAIL_TERMINAL, gets: PLACEMENT_DETAIL_BASE_GETS, surfaceScaleBearing: false, loadScaleBearing: false, blockedSurface: 'thread_detail' }),
  row({ key: '/conversations/:conversationId', label: 'Relay conversation detail', resolver: 'conversation', source: source('/inbox', L.inbox, 'link', 'resolved_exact_href', ':warmHref', INBOX_GETS), terminal: CONVERSATION_DETAIL_TERMINAL, gets: CONVERSATION_DETAIL_GETS, surfaceScaleBearing: false, loadScaleBearing: true, blockedSurface: 'conversation_detail' }),
  row({ key: '/broadcasts/:broadcastId', label: 'Broadcast results', resolver: 'broadcast', source: source('/broadcasts', L.matching, 'link', 'resolved_exact_href', ':warmHref', BROADCAST_LIST_GETS), terminal: BROADCAST_DETAIL_TERMINAL, gets: BROADCAST_DETAIL_GETS, surfaceScaleBearing: true, loadScaleBearing: false }),
]);

export const CONTACT_INBOX_PROBE: ProbeDefinition = Object.freeze({ key: 'contact_inbox_probe', blockedSurface: 'contact_inbox_probe' });
export const UNMATCHED_EMAIL_PROBE: ProbeDefinition = Object.freeze({ key: 'unmatched_email_probe', blockedSurface: 'unmatched_email_probe' });

function contractKey(contract: EndpointContract): string {
  return `${contract.endpointTemplate}?${contract.queryKeys.join('&')}#${contract.requirement}`;
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
  if (route.key === '/contacts/:contactId') {
    if (branch.kind !== 'contact_detail') throw new Error('route_branch_mismatch');
    if (branch.contactType === 'tenant') return [...route.gets, required('/api/tours', ['tenantId'])];
    if (branch.contactType === 'landlord' && branch.landlordUnitCount > 0) {
      return [...route.gets, required('/api/tours', ['unitId'])];
    }
    return route.gets;
  }
  if (route.key === '/listings/:unitId') {
    if (branch.kind !== 'unit_detail') throw new Error('route_branch_mismatch');
    return branch.hasLandlord ? [...route.gets, required('/api/contacts/:contactId')] : route.gets;
  }
  if (route.key === '/tours/:tourId' || route.key === '/placements/:placementId') {
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
  const destination = selectedDestination(route, branch);
  return freezeContracts(mode === 'cold' ? [...COLD_SHELL_GETS, ...destination] : destination);
}

export function assertObservedGets(
  declared: readonly EndpointContract[],
  observed: readonly ObservedEndpointContract[],
): { missingRequired: EndpointContract[]; undeclared: EndpointContract[] } {
  const declarationShapes = new Set(declared.map((contract) => `${contract.endpointTemplate}?${contract.queryKeys.join('&')}`));
  const observedShapes = new Set(observed
    .filter((contract) => contract.outcome !== 'aborted')
    .map((contract) => `${contract.endpointTemplate}?${[...contract.queryKeys].sort().join('&')}`));
  return {
    missingRequired: declared.filter((contract) => contract.requirement === 'required' && !observedShapes.has(`${contract.endpointTemplate}?${contract.queryKeys.join('&')}`)),
    undeclared: observed.filter((contract) => !declarationShapes.has(`${contract.endpointTemplate}?${[...contract.queryKeys].sort().join('&')}`)),
  };
}

export interface ObservedEndpointContract extends EndpointContract {
  readonly outcome?: 'finished' | 'failed' | 'aborted';
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
    rows.push(branch.thread === 'group_thread'
      ? tuple('group_thread', '/api/conversations/:conversationId/read', 'destination_mount')
      : tuple('person_thread', '/api/inbox/:contactId/read', 'destination_mount'));
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
  | { kind: 'resolved'; coldPath: string; warmHref: string; branch: RouteContractBranch }
  | { kind: 'skip'; reason: 'fixture_absent' | 'fixture_not_navigable' | 'source_not_ready' };

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
  return { kind: 'resolved', coldPath: href, warmHref: href, branch };
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

export async function resolveTourDetail(api: ResolverApi, dom: ResolverDom): Promise<ResolverResult> {
  const range = computeTourWindow(await dom.browserNow());
  const page = object(await api.get('/api/tours', range));
  const match = rowsFrom(page, 'tours')
    .filter((row) => row.status === 'scheduled' && stringField(row, 'tourId') !== undefined)
    .sort((left, right) => (stringField(left, 'scheduledAt') ?? '').localeCompare(stringField(right, 'scheduledAt') ?? ''))[0];
  if (match === undefined) return { kind: 'skip', reason: 'fixture_absent' };
  return bindResolved(dom, `/tours/${stringField(match, 'tourId')!}`, {
    kind: 'thread_detail', thread: stringField(match, 'groupThreadId') !== undefined ? 'group_thread' : 'person_thread',
  });
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
      return bindResolved(dom, `/placements/${stringField(match, 'placementId')!}`, {
        kind: 'thread_detail', thread: stringField(match, 'group_thread') !== undefined ? 'group_thread' : 'person_thread',
      });
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
