import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_ROUTE_EXCLUSIONS,
  CONTACT_INBOX_PROBE,
  CONTRACT_SOURCE_LEDGER,
  ROUTES,
  UNMATCHED_EMAIL_PROBE,
  assertObservedGets,
  computeTourWindow,
  expectedBlockedWrites,
  expectedGets,
  resolveBroadcastDetail,
  resolveContactDetail,
  resolveConversationDetail,
  resolvePlacementDetail,
  resolveTourDetail,
  resolveUnitDetail,
  resolverSkipSampleResult,
  type EndpointContract,
  type ResolverApi,
  type ResolverDom,
  type RouteContractBranch,
} from './routes.js';

const EXPECTED_KEYS = [
  '/', '/contacts', '/contacts/tenants', '/contacts/landlords', '/contacts/unknown',
  '/contacts/deleted', '/listings', '/listings/deleted', '/tours', '/tours/closed',
  '/placements', '/inbox', '/email', '/email/quarantine', '/broadcasts',
  '/settings/team', '/settings/templates', '/settings/notifications', '/settings/voice',
  '/settings/system', '/settings/ai-runs', '/settings/numbers', '/contacts/:contactId',
  '/listings/:unitId', '/tours/:tourId', '/placements/:placementId',
  '/conversations/:conversationId', '/broadcasts/:broadcastId',
] as const;

const NONE = { kind: 'none' } as const;
const THREADS: RouteContractBranch[] = [
  { kind: 'thread_detail', thread: 'group_thread' },
  { kind: 'thread_detail', thread: 'person_thread' },
];

const SHELL_SHAPES = [
  '/auth/me?#required',
  '/api/inbox?filter&limit#required',
  '/api/unmatched-email?filter#required',
] as const;
const CONTACT_SHAPES = [
  '/api/contacts?limit&type#required',
  '/api/contacts?cursor&limit&type#conditional',
] as const;
const CONTACT_DELETED_SHAPES = [
  '/api/contacts?deleted&limit&type#required',
  '/api/contacts?cursor&deleted&limit&type#conditional',
] as const;
const UNIT_SHAPES = ['/api/units?#required', '/api/units?cursor#conditional'] as const;
const UNIT_DELETED_SHAPES = ['/api/units?deleted#required', '/api/units?cursor&deleted#conditional'] as const;

const EXPECTED_WARM: Record<(typeof EXPECTED_KEYS)[number], readonly string[]> = {
  '/': [
    '/api/today?day&toursFrom&toursTo#required', '/api/placements?#conditional',
    '/api/conversations?#conditional', '/api/tours?from&to#conditional',
  ],
  '/contacts': CONTACT_SHAPES,
  '/contacts/tenants': CONTACT_SHAPES,
  '/contacts/landlords': CONTACT_SHAPES,
  '/contacts/unknown': CONTACT_SHAPES,
  '/contacts/deleted': CONTACT_DELETED_SHAPES,
  '/listings': UNIT_SHAPES,
  '/listings/deleted': UNIT_DELETED_SHAPES,
  '/tours': [
    '/api/tours?from&to#required', '/api/tours?status#required', ...CONTACT_SHAPES,
    ...CONTACT_DELETED_SHAPES, ...UNIT_SHAPES, ...UNIT_DELETED_SHAPES,
  ],
  '/tours/closed': [
    '/api/tours?from&to#conditional', '/api/tours?status#required',
    ...CONTACT_SHAPES.map((value) => value.replace('#required', '#conditional')),
    ...CONTACT_DELETED_SHAPES.map((value) => value.replace('#required', '#conditional')),
    ...UNIT_SHAPES.map((value) => value.replace('#required', '#conditional')),
    ...UNIT_DELETED_SHAPES.map((value) => value.replace('#required', '#conditional')),
  ],
  '/placements': [
    '/api/placements?#required', '/api/placements?cursor#conditional',
    '/api/contacts?type#required', '/api/contacts?cursor&type#conditional',
    '/api/contacts?deleted&type#required', '/api/contacts?cursor&deleted&type#conditional',
    ...UNIT_SHAPES, ...UNIT_DELETED_SHAPES,
  ],
  '/inbox': ['/api/inbox?filter&limit#required'],
  '/email': ['/api/unmatched-email?filter#required', ...CONTACT_SHAPES],
  '/email/quarantine': [
    '/api/unmatched-email?filter#required',
    ...CONTACT_SHAPES.map((value) => value.replace('#required', '#conditional')),
  ],
  '/broadcasts': ['/api/broadcasts?limit#required'],
  '/settings/team': ['/api/users?#required'],
  '/settings/templates': ['/api/settings?#required'],
  '/settings/notifications': [],
  '/settings/voice': ['/api/users/me?#required'],
  '/settings/system': [
    '/api/settings?#required', '/api/system/flags?#required', '/api/system/alarms?#required',
    '/api/system/errors?since#required',
  ],
  '/settings/ai-runs': ['/api/system/flags?#required', '/api/ai-runs?scope#required'],
  '/settings/numbers': ['/api/settings?#required', '/api/pool-numbers?#required'],
  '/contacts/:contactId': [
    '/api/contacts/:contactId?#required', '/api/contacts/:contactId/suggestions?#required',
    '/api/users/me?#required', '/api/contacts/:contactId/timeline?#required',
    '/api/placements?#required', '/api/units?#required',
    '/api/contacts/:contactId/listings-sent?#required', '/api/contacts/:contactId/media?#required',
    '/api/contacts/:contactId/relay-groups?#required', ...CONTACT_SHAPES,
    '/api/conversations?#conditional', '/api/conversations/:conversationId/messages?#conditional',
    '/api/tours?tenantId#required',
  ],
  '/listings/:unitId': [
    '/api/units/:unitId?#required', '/api/units?#required', '/api/placements?#required',
    '/api/units/:unitId/related?#required', '/api/units/:unitId/recipients?#required',
    '/api/units/:unitId/similar?#required', '/api/units/:unitId/activity?#required',
    '/api/tours?unitId#required', ...CONTACT_SHAPES, ...CONTACT_DELETED_SHAPES,
    '/api/contacts/:contactId?#required',
  ],
  '/tours/:tourId': [
    '/api/tours/:tourId?#required', '/api/units/:unitId?#required', '/api/contacts/:contactId?#required',
    '/api/tours/:tourId/roster?#required', '/api/conversations?#required',
    '/api/tours/:tourId/activity?limit#required', '/api/tours/:tourId/reminders?#required',
    '/api/conversations/:conversationId?#required', '/api/conversations/:conversationId/members?#required',
    '/api/conversations/:conversationId/messages?#required', '/api/conversations/:conversationId/scheduled?#required',
  ],
  '/placements/:placementId': [
    '/api/placements/:placementId?#required', '/api/units/:unitId?#required', '/api/contacts/:contactId?#required',
    '/api/placements/:placementId/roster?#required', '/api/conversations?#required',
    '/api/placements/:placementId/history?limit#required', '/api/placements/:placementId/nudges?#required',
    '/api/conversations/:conversationId?#required', '/api/conversations/:conversationId/members?#required',
    '/api/conversations/:conversationId/messages?#required', '/api/conversations/:conversationId/scheduled?#required',
  ],
  '/conversations/:conversationId': [
    '/api/conversations/:conversationId?#required', '/api/conversations/:conversationId/members?#required',
    '/api/conversations/:conversationId/messages?#required', '/api/conversations/:conversationId/scheduled?#required',
    ...CONTACT_SHAPES,
  ],
  '/broadcasts/:broadcastId': ['/api/broadcasts/:broadcastId/results?#required'],
};

function shape(contracts: readonly EndpointContract[]): string[] {
  return contracts.map((contract) =>
    `${contract.endpointTemplate}?${contract.queryKeys.join('&')}#${contract.requirement}`,
  );
}

function branchFor(key: string): RouteContractBranch {
  if (key === '/contacts/:contactId') {
    return { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 };
  }
  if (key === '/listings/:unitId') return { kind: 'unit_detail', hasLandlord: true };
  if (key === '/tours/:tourId' || key === '/placements/:placementId') return THREADS[0]!;
  return NONE;
}

class FakeApi implements ResolverApi {
  readonly calls: string[] = [];
  readonly pages = new Map<string, unknown[]>();

  async get(path: string, query: Readonly<Record<string, string>>): Promise<unknown> {
    const key = `${path}?${Object.keys(query).sort().map((name) => `${name}=${query[name]}`).join('&')}`;
    this.calls.push(key);
    const queue = this.pages.get(key);
    if (queue === undefined || queue.length === 0) throw new Error('missing_fake_response');
    return queue.shift();
  }
}

class FakeDom implements ResolverDom {
  constructor(
    private readonly hrefs: ReadonlySet<string>,
    private readonly now: Date = new Date('2026-08-12T17:00:00.000Z'),
    private readonly ready = true,
  ) {}

  async hasExactLink(href: string): Promise<boolean> {
    return this.hrefs.has(href);
  }

  async browserNow(): Promise<Date> {
    return new Date(this.now);
  }

  async sourceReady(): Promise<boolean> {
    return this.ready;
  }
}

describe('route registry completeness', () => {
  it('has exactly 28 unique template-only bindings and no excluded surface', () => {
    expect(ROUTES.map((route) => route.key)).toEqual(EXPECTED_KEYS);
    expect(new Set(ROUTES.map((route) => route.key)).size).toBe(28);
    expect(ROUTES).toHaveLength(28);
    expect(APP_ROUTE_EXCLUSIONS).toEqual([
      { route: '/p/:unitId', reason: 'public' },
      { route: '/join', reason: 'public' },
      { route: '/broadcasts/new', reason: 'create' },
      { route: '/settings', reason: 'redirect' },
      { route: '{allNavTargets().filter(({ to }) => !IMPLEMENTED.has(to)).map(...)=>:to}', reason: 'generated_placeholders_empty' },
      { route: '*', reason: 'catch_all' },
    ]);
    expect(ROUTES.every((route) => !/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(route.pathTemplate))).toBe(true);
    expect(ROUTES.every((route) => route.pathTemplate === route.key)).toBe(true);
  });

  it('mechanically matches App route elements and proves generated placeholders are empty', () => {
    const appSource = readFileSync(fileURLToPath(new URL('../../dashboard/src/App.tsx', import.meta.url)), 'utf8');
    const navSource = readFileSync(fileURLToPath(new URL('../../dashboard/src/app/nav.ts', import.meta.url)), 'utf8');
    const implementedMatch = appSource.match(/const IMPLEMENTED = new Set(?:<string>)?\(\[([\s\S]*?)\]\);/);
    expect(implementedMatch).not.toBeNull();
    const implementedSource = implementedMatch?.[1] ?? '';
    const implemented = [...implementedSource.matchAll(/^\s*['"]([^'"]+)['"],?\s*$/gm)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined);
    const navTargets = [...navSource.matchAll(/(?:to:\s*|NAV_FOOTER[^\n]*to:\s*)['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined);
    expect([...new Set(navTargets)].filter((target) => !implemented.includes(target))).toEqual([]);

    const relative = [...appSource.matchAll(/<Route(?:\s|\n)[^>]*?path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined)
      .filter((path) => path !== '/*')
      .map((path) => path.startsWith('/') || path === '*' ? path : `/${path}`);
    const indexPath = appSource.includes('<Route index element={<Today />} />') ? ['/'] : [];
    const settingsChildren = relative
      .filter((path) => ['/team', '/templates', '/notifications', '/voice', '/system', '/ai-runs', '/numbers'].includes(path))
      .map((path) => `/settings${path}`);
    const rawPaths = [...relative.filter((path) => !settingsChildren.some((child) => child.endsWith(path))), ...settingsChildren, ...indexPath];
    const excluded = new Set(['/p/:unitId', '/join', '/broadcasts/new', '/settings', '*']);
    expect([...new Set(rawPaths)].filter((path) => !excluded.has(path)).sort())
      .toEqual([...EXPECTED_KEYS].sort());
    expect(appSource).toContain('{allNavTargets()');
    expect(appSource).toContain('.filter(({ to }) => !IMPLEMENTED.has(to))');
    expect(appSource).toContain('path={to.slice(1)}');
  });

  it('declares complete Desktop Chrome source and terminal contracts with explicit exactness', () => {
    for (const route of ROUTES) {
      expect(route.label.length).toBeGreaterThan(0);
      expect(route.requiredRole).toMatch(/^(staff|admin)$/);
      expect(route.viewportDependency).toBe('desktop_chrome');
      expect(route.source.viewportDependency).toBe('desktop_chrome');
      expect(route.terminal.viewportDependency).toBe('desktop_chrome');
      expect(route.source.exactHref).toBe(true);
      for (const locator of [
        route.source.ready,
        route.source.click,
        ...route.terminal.structure,
        ...route.terminal.populated,
        ...route.terminal.empty,
        ...route.terminal.error,
      ]) {
        expect(locator).toHaveProperty('exactness');
        expect(['exact', 'prefix', 'contains', 'regex', 'role_only']).toContain(locator.exactness);
        if (locator.exactness === 'role_only') expect(locator).not.toHaveProperty('name');
      }
    }
    expect(ROUTES.find((route) => route.key === '/settings/system')?.targetStructuralNote)
      .toBe('alarms_and_errors_differ_by_target');
    expect(ROUTES.find((route) => route.key === '/tours/:tourId')?.sourceLoadScaleBearing).toBe(false);
    expect(ROUTES.find((route) => route.key === '/placements/:placementId')?.sourceLoadScaleBearing).toBe(false);
  });

  it('cites every endpoint binding, branch, terminal, resolver, blocked write, and background rule', () => {
    const citation = /^[A-Za-z0-9_./-]+\.(?:ts|tsx):\d+(?:-\d+)?(?:,[0-9-]+)*(?:; [A-Za-z0-9_./-]+\.(?:ts|tsx):\d+(?:-\d+)?(?:,[0-9-]+)*)*$/u;
    const cited = (value: string | undefined): void => {
      expect(value).toBeTypeOf('string');
      expect(value).toMatch(citation);
    };
    const endpointSources = CONTRACT_SOURCE_LEDGER.endpoints as Readonly<Record<string, { base: string }>>;
    const terminalSources = CONTRACT_SOURCE_LEDGER.terminals as Readonly<Record<string, string>>;

    for (const route of ROUTES) {
      cited(endpointSources[route.key]?.base);
      cited(terminalSources[route.key]);
      cited(CONTRACT_SOURCE_LEDGER.resolvers[route.resolver]);
    }
    expect(Object.keys(CONTRACT_SOURCE_LEDGER.warmRequirementClassifications).sort()).toEqual([
      '/email/quarantine', '/tours/closed',
    ]);
    for (const classification of Object.values(CONTRACT_SOURCE_LEDGER.warmRequirementClassifications)) {
      cited(classification.source);
      expect(classification.reason).toMatch(/passive navigation work\.$/u);
    }
    for (const branch of [
      'contact_detail_tenant', 'contact_detail_landlord_with_units', 'contact_detail_other',
      'unit_detail_with_landlord', 'unit_detail_without_landlord',
      'tour_group_thread', 'tour_person_thread',
      'placement_group_thread', 'placement_person_thread',
    ] as const) cited(CONTRACT_SOURCE_LEDGER.branches[branch]);
    for (const surface of [
      'contact_detail', 'conversation_detail', 'group_thread', 'person_thread',
      'contact_inbox_probe', 'unmatched_email_probe',
    ] as const) cited(CONTRACT_SOURCE_LEDGER.blockedWrites[surface]);
    expect(Object.keys(CONTRACT_SOURCE_LEDGER.background)).toHaveLength(12);
    for (const source of Object.values(CONTRACT_SOURCE_LEDGER.background)) cited(source);
  });

  it('models terminal alternatives without requiring mutually exclusive states together', () => {
    const tours = ROUTES.find((route) => route.key === '/tours')!;
    expect(tours.terminal.populatedAlternatives).toHaveLength(2);
    expect(tours.terminal.populatedAlternatives.every((alternative) => alternative.length === 1)).toBe(true);
    expect(tours.terminal.emptyAlternatives).toHaveLength(1);
    expect(tours.terminal.emptyAlternatives[0]).toHaveLength(2);

    const system = ROUTES.find((route) => route.key === '/settings/system')!;
    expect(system.terminal.populatedAlternatives).toHaveLength(9);
    expect(system.terminal.populatedAlternatives.every((alternative) => alternative.length === 4)).toBe(true);
    expect(system.terminal.populatedAlternatives[0]?.[1]).toMatchObject({
      role: 'listitem', name: 'Environment: ', exactness: 'prefix',
    });

    const numbers = ROUTES.find((route) => route.key === '/settings/numbers')!;
    expect(numbers.terminal.populatedAlternatives).toHaveLength(4);
    expect(numbers.terminal.populatedAlternatives.every((alternative) => alternative.length === 2)).toBe(true);

    const voice = ROUTES.find((route) => route.key === '/settings/voice')!;
    expect(voice.terminal.populatedAlternatives.map((alternative) => alternative.length)).toEqual([1, 2]);

    const broadcast = ROUTES.find((route) => route.key === '/broadcasts/:broadcastId')!;
    expect(broadcast.terminal.populatedAlternatives).toHaveLength(1);
    expect(broadcast.terminal.populatedAlternatives[0]).toHaveLength(1);
    expect(broadcast.terminal.populatedAlternatives[0]?.[0]).toMatchObject({
      role: 'list', name: 'Recipients', exactness: 'exact',
    });
    expect(broadcast.terminal.emptyAlternatives).toHaveLength(1);
  });

  it('waits for the selected settings source data branch before timing the tab click', () => {
    const templates = ROUTES.find((route) => route.key === '/settings/templates')!;
    expect(templates.source.path).toBe('/settings/team');
    expect(templates.source.ready).toMatchObject({ role: 'table', exactness: 'role_only' });
    const system = ROUTES.find((route) => route.key === '/settings/system')!;
    expect(system.source.path).toBe('/settings/templates');
    expect(system.source.ready).toMatchObject({ role: 'textbox', exactness: 'regex' });
  });
});

describe('endpoint and write contracts', () => {
  it('deep-compares exact cold and warm shapes for every route', () => {
    for (const route of ROUTES) {
      const branch = branchFor(route.key);
      const warm = expectedGets(route, 'warm', branch);
      const cold = expectedGets(route, 'cold', branch);
      const expectedWarm = EXPECTED_WARM[route.key as keyof typeof EXPECTED_WARM];
      const coldDestination = route.key === '/tours/closed'
        ? EXPECTED_WARM['/tours']
        : route.key === '/email/quarantine'
          ? EXPECTED_WARM['/email']
          : expectedWarm;
      const expectedCold = [...new Set([...SHELL_SHAPES, ...coldDestination])];
      expect(shape(warm), `${route.key} warm`).toEqual(expectedWarm);
      expect(shape(cold), `${route.key} cold`).toEqual(expectedCold);
      expect(Object.isFrozen(warm)).toBe(true);
      expect(shape(warm)).not.toEqual(expect.arrayContaining([
        '/auth/me?#required', '/api/events?#required',
      ]));
      expect(shape(warm)).not.toContain('/api/events?#required');
      expect(new Set(shape(warm)).size).toBe(warm.length);
      expect(() => (warm as EndpointContract[]).push({
        endpointTemplate: '/api/events', queryKeys: [], requirement: 'required',
      })).toThrow();
    }
  });

  it('keeps branch choices exact and required/conditional behavior closed', () => {
    const contact = ROUTES.find((route) => route.key === '/contacts/:contactId')!;
    expect(shape(expectedGets(contact, 'warm', { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 })))
      .toContain('/api/tours?tenantId#required');
    expect(shape(expectedGets(contact, 'warm', { kind: 'contact_detail', contactType: 'landlord', landlordUnitCount: 2 })))
      .toContain('/api/tours?unitId#required');
    expect(shape(expectedGets(contact, 'warm', { kind: 'contact_detail', contactType: 'other', landlordUnitCount: 0 })))
      .not.toContain('/api/tours?tenantId#required');
    const unit = ROUTES.find((route) => route.key === '/listings/:unitId')!;
    expect(shape(expectedGets(unit, 'warm', { kind: 'unit_detail', hasLandlord: true })))
      .toContain('/api/contacts/:contactId?#required');
    expect(shape(expectedGets(unit, 'warm', { kind: 'unit_detail', hasLandlord: false })))
      .not.toContain('/api/contacts/:contactId?#required');

    const required: EndpointContract = { endpointTemplate: '/api/contacts', queryKeys: ['limit', 'type'], requirement: 'required' };
    const conditional: EndpointContract = { endpointTemplate: '/api/contacts', queryKeys: ['cursor', 'limit', 'type'], requirement: 'conditional' };
    expect(assertObservedGets([required, conditional], [required])).toEqual({ missingRequired: [], undeclared: [] });
    expect(assertObservedGets([required, conditional], [conditional])).toEqual({ missingRequired: [required], undeclared: [] });
    expect(assertObservedGets([required], [{ ...required, queryKeys: ['deleted', 'limit', 'type'] }]))
      .toEqual({ missingRequired: [required], undeclared: [{ ...required, queryKeys: ['deleted', 'limit', 'type'] }] });
  });

  it('preserves exact write surfaces and legitimate two-phase multiplicity', () => {
    const conversation = ROUTES.find((route) => route.key === '/conversations/:conversationId')!;
    expect([...expectedBlockedWrites(conversation, 'cold', NONE)]).toEqual([
      'conversation_detail|POST|/api/conversations/:conversationId/read|destination_mount',
    ]);
    expect([...expectedBlockedWrites(conversation, 'warm', NONE)]).toEqual([
      'conversation_detail|POST|/api/conversations/:conversationId/read|source_click',
      'conversation_detail|POST|/api/conversations/:conversationId/read|destination_mount',
    ]);
    for (const key of ['/tours/:tourId', '/placements/:placementId']) {
      const route = ROUTES.find((candidate) => candidate.key === key)!;
      expect([...expectedBlockedWrites(route, 'cold', THREADS[0]!)]).toContain(
        'group_thread|POST|/api/conversations/:conversationId/read|destination_mount',
      );
      expect([...expectedBlockedWrites(route, 'cold', THREADS[1]!)]).toContain(
        'person_thread|POST|/api/inbox/:contactId/read|destination_mount',
      );
    }
    expect([...expectedBlockedWrites(CONTACT_INBOX_PROBE, 'warm', NONE)]).toEqual([
      'contact_inbox_probe|POST|/api/inbox/:contactId/read|source_click',
      'contact_inbox_probe|POST|/api/inbox/:contactId/read|destination_mount',
    ]);
    expect([...expectedBlockedWrites(UNMATCHED_EMAIL_PROBE, 'warm', NONE)]).toEqual([
      'unmatched_email_probe|POST|/api/unmatched-email/:unmatchedId/read|source_click',
    ]);
    const frozen = expectedBlockedWrites(conversation, 'warm', NONE);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect((frozen as unknown as { add?: unknown }).add).toBeUndefined();
    expect(ROUTES).toHaveLength(28);
  });

  it('matches the current contact detail heading including its accessible edit action', () => {
    const contact = ROUTES.find((route) => route.key === '/contacts/:contactId')!;
    expect(contact.terminal.populated[0]).toMatchObject({
      role: 'heading', name: '^Details(?: Edit contact details)?$', exactness: 'regex',
    });
  });
});

describe('representative resolvers', () => {
  it('resolves contacts by API order and exact rendered href without exporting a raw id field', async () => {
    const api = new FakeApi();
    api.pages.set('/api/contacts?limit=100&type=tenant', [{
      contacts: [{ contactId: 'contact-private-a', type: 'tenant', deleted_at: 'x' }, { contactId: 'contact-private-b', type: 'tenant' }],
      nextCursor: 'private-cursor',
    }]);
    api.pages.set('/api/contacts?cursor=private-cursor&limit=100&type=tenant', [{ contacts: [], nextCursor: null }]);
    const result = await resolveContactDetail(api, new FakeDom(new Set(['/contacts/contact-private-b'])));
    expect(result).toEqual({
      kind: 'resolved', coldPath: '/contacts/contact-private-b', warmHref: '/contacts/contact-private-b',
      branch: { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 },
    });
    expect(Object.keys(result)).not.toContain('contactId');
    expect(api.calls[0]).toBe('/api/contacts?limit=100&type=tenant');
    expect(api.calls.every((call) => !call.includes('deleted=false'))).toBe(true);
  });

  it('retains only sanitized conditional branch facts and maps closed skip reasons', () => {
    const branches: RouteContractBranch[] = [
      { kind: 'contact_detail', contactType: 'landlord', landlordUnitCount: 17 },
      { kind: 'unit_detail', hasLandlord: true },
      { kind: 'thread_detail', thread: 'group_thread' },
      { kind: 'thread_detail', thread: 'person_thread' },
    ];
    expect(branches).toEqual(branches.map((branch) => ({ ...branch })));
    expect(JSON.stringify(branches)).not.toMatch(/private|contactId|unitId|conversationId/);
    expect(resolverSkipSampleResult('/fixture', 'warm', 2, 'fixture_absent').status).toBe('skipped_no_fixture');
    expect(resolverSkipSampleResult('/fixture', 'warm', 2, 'fixture_not_navigable').status).toBe('skipped_fixture_not_navigable');
    expect(resolverSkipSampleResult('/fixture', 'warm', 2, 'source_not_ready').status).toBe('skipped_source_not_ready');
  });

  it('returns explicit skips for missing fixtures and exact-link misses without row substitution', async () => {
    const unitApi = new FakeApi();
    unitApi.pages.set('/api/units?', [{ units: [{ unitId: 'unit-private-a', landlordId: 'contact-private' }], nextCursor: null }]);
    await expect(resolveUnitDetail(unitApi, new FakeDom(new Set(['/listings/unit-different'])))).resolves.toEqual({
      kind: 'skip', reason: 'fixture_not_navigable',
    });
    const notReadyApi = new FakeApi();
    notReadyApi.pages.set('/api/units?', [{ units: [{ unitId: 'unit-private-a' }], nextCursor: null }]);
    await expect(resolveUnitDetail(notReadyApi, new FakeDom(new Set(['/listings/unit-private-a']), undefined, false))).resolves.toEqual({
      kind: 'skip', reason: 'source_not_ready',
    });

    const placementApi = new FakeApi();
    placementApi.pages.set('/api/placements?', [{ placements: [], nextCursor: null }]);
    await expect(resolvePlacementDetail(placementApi, new FakeDom(new Set()))).resolves.toEqual({
      kind: 'skip', reason: 'fixture_absent',
    });
  });

  it('selects relay inbox rows and first-50 terminal broadcasts only', async () => {
    const inboxApi = new FakeApi();
    inboxApi.pages.set('/api/inbox?filter=all&limit=30', [{ rows: [
      { kind: 'contact', contactId: 'contact-private' },
      { kind: 'relay_group', conversationId: 'conv-private' },
    ] }]);
    await expect(resolveConversationDetail(inboxApi, new FakeDom(new Set(['/conversations/conv-private']))))
      .resolves.toMatchObject({ kind: 'resolved', warmHref: '/conversations/conv-private' });

    const broadcastApi = new FakeApi();
    broadcastApi.pages.set('/api/broadcasts?limit=50', [{ broadcasts: [
      { broadcastId: 'bcast-sending', status: 'sending' },
      { broadcastId: 'bcast-private', status: 'failed' },
    ], nextCursor: 'must-not-page' }]);
    await expect(resolveBroadcastDetail(broadcastApi, new FakeDom(new Set(['/broadcasts/bcast-private']))))
      .resolves.toMatchObject({ kind: 'resolved', warmHref: '/broadcasts/bcast-private' });
    expect(broadcastApi.calls).toEqual(['/api/broadcasts?limit=50']);
  });

  it('computes the live local tour window across midnight, DST, month, and year boundaries', async () => {
    const cases = [
      new Date(2026, 2, 8, 23, 59),
      new Date(2026, 10, 1, 0, 1),
      new Date(2026, 0, 31, 12, 0),
      new Date(2026, 11, 31, 23, 59),
    ];
    for (const now of cases) {
      const range = computeTourWindow(now);
      const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      expect(range).toEqual({
        from: localMidnight.toISOString(),
        to: new Date(localMidnight.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    const resolverNow = new Date(2027, 0, 1, 0, 5);
    const range = computeTourWindow(resolverNow);
    const api = new FakeApi();
    api.pages.set(`/api/tours?from=${range.from}&to=${range.to}`, [{ tours: [
      { tourId: 'tour-canceled', status: 'canceled', scheduledAt: range.from },
      { tourId: 'tour-private', status: 'scheduled', scheduledAt: range.to, groupThreadId: 'conv-private' },
    ] }]);
    const result = await resolveTourDetail(api, new FakeDom(new Set(['/tours/tour-private']), resolverNow));
    expect(result).toMatchObject({
      kind: 'resolved', warmHref: '/tours/tour-private',
      branch: { kind: 'thread_detail', thread: 'group_thread' },
    });
    expect(api.calls[0]).toContain(range.from);
    expect(api.calls[0]).not.toContain('2026-08-11');
  });
});
