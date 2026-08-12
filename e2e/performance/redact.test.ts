import { describe, expect, it } from 'vitest';
import {
  allEndpointTemplates,
  assertEndpointTemplate,
  isEndpointTemplate,
  sanitizeRequestUrl,
} from './templates.js';
import {
  reduceCaughtFailure,
  scanArtifactText,
} from './redact.js';

const ORIGIN = 'https://dashboard.example.test';

function sanitized(rawUrl: string, method = 'GET') {
  return sanitizeRequestUrl({
    rawUrl,
    method,
    firstPartyOrigin: ORIGIN,
    resourceType: 'fetch',
  });
}

describe('request URL sanitization', () => {
  it.each([
    ['/api/contacts/contact-123/timeline?limit=10&cursor=opaque-secret', '/api/contacts/:contactId/timeline', ['cursor', 'limit']],
    ['/api/units/unit-123/media?z=secret&a=other', '/api/units/:unitId/media', ['a', 'z']],
    ['/api/tours/tour-123/roster', '/api/tours/:tourId/roster', []],
    ['/api/placements/placement-123/history?limit=50', '/api/placements/:placementId/history', ['limit']],
    ['/api/conversations/conv-123/scheduled', '/api/conversations/:conversationId/scheduled', []],
    ['/api/broadcasts/bcast-123/results', '/api/broadcasts/:broadcastId/results', []],
    ['/api/inbox/contact-123/read', '/api/inbox/:contactId/read', []],
    ['/api/inbox/read', '/api/inbox/read', []],
    ['/api/unmatched-email/um-0123456789abcdef0123456789abcdef/read', '/api/unmatched-email/:unmatchedId/read', []],
    ['/api/settings', '/api/settings', []],
    ['/api/system/errors?since=private', '/api/system/errors', ['since']],
    ['/api/contacts/contact-123/timeline', '/api/contacts/:contactId/timeline', []],
    ['/api/tours/tour-123/reminders', '/api/tours/:tourId/reminders', []],
    ['/api/placements/placement-123/nudges/nudge-123/send-now', '/api/placements/:placementId/nudges/:nudgeId/send-now', []],
    ['/api/messages/msg-123/media/2', '/api/messages/:messageId/media/:mediaIndex', []],
    ['/auth/dev-login', '/auth/dev-login', []],
    ['/__dev/performance/reseed', '/__dev/performance/reseed', []],
  ] as const)('maps %s to a checked-in template', (path, expected, queryKeys) => {
    const result = sanitized(`${ORIGIN}${path}`);
    expect(result.endpointTemplate).toBe(expected);
    expect(result.queryKeys).toEqual(queryKeys);
    expect(JSON.stringify(result)).not.toContain('opaque-secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reduces unknown first-party API paths without retaining any raw segment', () => {
    const secret = 'contact-550e8400-e29b-41d4-a716-446655440000';
    const result = sanitized(`${ORIGIN}/api/private/${secret}/records?cursor=${secret}`, 'PATCH');
    expect(result).toEqual({
      originClass: 'first_party',
      resourceClass: 'api',
      endpointTemplate: 'unmatched_api',
      queryKeys: ['cursor'],
      unmatchedApi: true,
      segmentCount: 4,
      method: 'PATCH',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('closes unknown methods and invalid URLs without retaining their input', () => {
    const method = 'private.person@example.com';
    expect(sanitizeRequestUrl({
      rawUrl: `${ORIGIN}/api/private/value`,
      method,
      firstPartyOrigin: ORIGIN,
    }).method).toBe('OTHER');
    expect(sanitizeRequestUrl({
      rawUrl: 'not a URL private.person@example.com',
      method: 'GET',
      firstPartyOrigin: ORIGIN,
    })).toEqual({
      originClass: 'third_party',
      resourceClass: 'other',
      endpointTemplate: 'invalid_url',
      queryKeys: [],
      unmatchedApi: false,
    });
  });

  it('templates entity-bearing non-API paths', () => {
    const unit = 'unit-550e8400-e29b-41d4-a716-446655440000';
    const media = '550e8400-e29b-41d4-a716-446655440001';
    const result = sanitized(`${ORIGIN}/unit-media/${unit}/${media}`);
    expect(result.endpointTemplate).toBe('/unit-media/:unitId/:mediaKey');
    expect(JSON.stringify(result)).not.toContain(unit);
    expect(JSON.stringify(result)).not.toContain(media);

    expect(sanitized(`${ORIGIN}/public/units/${unit}/flyer`).endpointTemplate)
      .toBe('/public/units/:unitId/flyer');
    expect(sanitized(`${ORIGIN}/public/housing-fair`).endpointTemplate)
      .toBe('/public/housing-fair');
  });

  it.each([
    ['contact-550e8400-e29b-41d4-a716-446655440000', '/api/contacts/:value/timeline'],
    ['unit-550e8400-e29b-41d4-a716-446655440000', '/api/units/:value/activity'],
    ['tour-550e8400-e29b-41d4-a716-446655440000', '/api/tours/:value/roster'],
    ['placement-550e8400-e29b-41d4-a716-446655440000', '/api/placements/:value/history'],
    ['conv-550e8400-e29b-41d4-a716-446655440000', '/api/conversations/:value/scheduled'],
    ['bcast-550e8400-e29b-41d4-a716-446655440000', '/api/broadcasts/:value/results'],
    ['contact-550e8400-e29b-41d4-a716-446655440000', '/api/inbox/:value/read'],
    ['um-0123456789abcdef0123456789abcdef', '/api/unmatched-email/:value/read'],
    ['msg-550e8400-e29b-41d4-a716-446655440000', '/api/messages/:value/media/0'],
    ['user-550e8400-e29b-41d4-a716-446655440000', '/api/users/:value/role'],
    ['perf-private-import-row', '/api/ai-runs/:value'],
  ])('never retains the dynamic input %s', (value, pathTemplate) => {
    const rawPath = pathTemplate.replace(':value', encodeURIComponent(value));
    expect(JSON.stringify(sanitized(`${ORIGIN}${rawPath}`))).not.toContain(value);
  });

  it.each([
    ['/index.html', 'document'],
    ['/assets/app.js', 'script'],
    ['/assets/app.css', 'style'],
    ['/assets/app.woff2', 'font'],
    ['/assets/logo.png', 'image'],
    ['/assets/data.bin', 'other'],
  ])('reduces %s to the %s asset class', (path, resourceClass) => {
    const result = sanitized(`${ORIGIN}${path}`);
    expect(result).toEqual({
      originClass: 'first_party',
      resourceClass,
      endpointTemplate: resourceClass,
      queryKeys: [],
      unmatchedApi: false,
    });
  });

  it('reduces third-party URLs without host or path', () => {
    const secret = 'contact-550e8400-e29b-41d4-a716-446655440000';
    const result = sanitized(`https://uploads.example.test/${secret}?token=${secret}`, 'POST');
    expect(result).toEqual({
      originClass: 'third_party',
      resourceClass: 'other',
      endpointTemplate: 'third_party',
      queryKeys: [],
      unmatchedApi: false,
    });
    expect(JSON.stringify(result)).not.toContain('uploads.example.test');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('serializes every checked-in template without tripping the final scan', () => {
    expect(scanArtifactText(JSON.stringify(allEndpointTemplates()))).toEqual([]);
  });

  it('closes the checked-in endpoint registry to declared templates', () => {
    expect(isEndpointTemplate('/api/contacts/:contactId/timeline')).toBe(true);
    expect(isEndpointTemplate('/api/synthetic/private')).toBe(false);
    expect(() => assertEndpointTemplate('/api/synthetic/private')).toThrowError(
      'undeclared_endpoint_template',
    );
  });
});

describe('artifact privacy scan', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const idCases = [
    ['contact production', `contact-${uuid}`],
    ['contact seed', 'contact-tenant-0001'],
    ['unit production', `unit-${uuid}`],
    ['unit seed', 'unit-0001'],
    ['conversation production', `conv-${uuid}`],
    ['conversation seed', 'conv-relay-0001'],
    ['tour production', `tour-${uuid}`],
    ['tour seed', 'tour-0001'],
    ['placement production', `placement-${uuid}`],
    ['placement seed', 'placement-0001'],
    ['broadcast production', `bcast-${uuid}`],
    ['broadcast seed', 'broadcast-0001'],
    ['user production', `user-${uuid}`],
    ['user seed', 'user-admin-0001'],
    ['message production', `msg-${uuid}`],
    ['message seed', 'msg-0001'],
    ['unmatched email', 'um-0123456789abcdef0123456789abcdef'],
    ['performance seed', 'perf-contact-000001'],
    ['reminder production', `reminder-${uuid}`],
    ['nudge production', `nudge-${uuid}`],
    ['activity production', `evt-${uuid}`],
    ['bare uuid', uuid],
    ['ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['slug-tail', 'contact-private-import-row'],
    ['single-digit seed', 'contact-1'],
    ['hex-tail seed', 'unit-deadbeef'],
    ['opaque slug seed', 'conv-privateopaquevalue'],
  ] as const;

  it.each(idCases)('rejects %s IDs', (_label, value) => {
    expect(scanArtifactText(`prefix-${value}-suffix`)).not.toEqual([]);
  });

  it.each([
    ['phone', '+15551234567'],
    ['email', 'private.person@example.com'],
    ['cookie', 'Set-Cookie: session=privatevalue'],
    ['authorization', 'Authorization: Bearer privatevalue'],
    ['token', 'access_token=privatevalue'],
    ['JSON cookie', '{"cookie":"privatevalue"}'],
    ['JSON authorization', '{"authorization":"Bearer privatevalue"}'],
    ['JSON cursor', '{"cursor":"privateopaquevalue"}'],
    ['encoded email', 'private.person%40example.com'],
    ['encoded phone', '%2B15551234567'],
    ['encoded uuid', '550e8400%2De29b%2D41d4%2Da716%2D446655440000'],
    ['HTML encoded email', 'private.person&#64;example.com'],
    ['JSON encoded email', 'private.person\\u0040example.com'],
    ['base64 encoded email', 'cHJpdmF0ZS5wZXJzb25AZXhhbXBsZS5jb20='],
  ])('rejects %s patterns', (_label, value) => {
    expect(scanArtifactText(`safe-prefix ${value} safe-suffix`)).not.toEqual([]);
  });

  it('exempts only exact checked-in templates and placeholder tokens', () => {
    expect(scanArtifactText('/unit-media/:unitId/:mediaKey')).toEqual([]);
    expect(scanArtifactText(':contactId')).toEqual([]);
    expect(scanArtifactText('/unit-media/:unitId/private-unit-0001')).not.toEqual([]);
  });

  it('does not lose matches across repeated scanner calls', () => {
    const value = 'contact-550e8400-e29b-41d4-a716-446655440000';
    const first = scanArtifactText(value);
    const second = scanArtifactText(value);
    const third = scanArtifactText(`${value} ${value}`);
    expect(first).toContain('entity_id');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe('caught failure reduction', () => {
  it.each([
    'target',
    'resolver',
    'collector',
    'cleanup',
    'report',
  ] as const)('reduces adversarial %s errors to allowlisted facts', (seam) => {
    const secret = `contact-550e8400-e29b-41d4-a716-446655440000 private@example.com +15551234567`;
    const error = Object.assign(new Error(secret), {
      stack: `${secret} at C:\\private\\run.ts`,
      statusCode: 503,
      timeoutMs: 4321,
      exitCode: 7,
      url: `https://private.example/${secret}`,
      body: secret,
      command: `node --token=${secret}`,
    });
    const safe = reduceCaughtFailure(seam, error);
    expect(safe).toEqual({
      reason:
        seam === 'target'
          ? 'target_proof_failed'
          : seam === 'collector'
            ? 'browser_failure'
            : seam === 'cleanup'
              ? 'cleanup_failed'
              : 'unexpected_failure',
      statusCode: 503,
      timeoutMs: 4321,
      exitCode: 7,
    });
    expect(scanArtifactText(JSON.stringify(safe))).toEqual([]);
    expect(JSON.stringify(safe)).not.toContain(secret);
  });

  it('keeps partial, quarantine, and stdout-equivalent shapes raw-free', () => {
    const secret = 'private.person@example.com contact-550e8400-e29b-41d4-a716-446655440000';
    const error = Object.assign(new Error(secret), { statusCode: 500, path: secret });
    const partial = { status: 'failed', failure: reduceCaughtFailure('collector', error) };
    const quarantine = { status: 'quarantined', failure: reduceCaughtFailure('report', error) };
    const stderr = JSON.stringify(reduceCaughtFailure('cleanup', error));
    const serialized = JSON.stringify({ partial, quarantine, stderr });
    expect(serialized).not.toContain(secret);
    expect(scanArtifactText(serialized)).toEqual([]);
  });
});
