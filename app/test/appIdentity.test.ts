import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { selectAppIdentity } from '../src/routes/appIdentity.js';

const SECRET = 'test-origin-secret';

function appFor(appEnv: string) {
  return buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      HC_ENV: appEnv,
      CF_ORIGIN_SECRET: SECRET,
    } as NodeJS.ProcessEnv),
  });
}

describe('selectAppIdentity', () => {
  it.each([
    ['prod', 'production', '#1f6feb'],
    ['dev', 'non-production', '#f4c542'],
    ['local', 'non-production', '#f4c542'],
    ['staging-next', 'non-production', '#f4c542'],
  ] as const)('%s selects %s', (appEnv, variant, themeColor) => {
    expect(selectAppIdentity(appEnv)).toEqual({ variant, themeColor });
  });
});

describe('/app-identity', () => {
  it.each([
    ['prod', 'production', '#1f6feb'],
    ['dev', 'non-production', '#f4c542'],
    ['local', 'non-production', '#f4c542'],
    ['staging-next', 'non-production', '#f4c542'],
  ] as const)('serves exact no-store config for %s', async (appEnv, variant, themeColor) => {
    const res = await request(appFor(appEnv))
      .get('/app-identity/config.json')
      .set('x-origin-verify', SECRET);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ variant, themeColor });
    expect(Object.keys(res.body).sort()).toEqual(['themeColor', 'variant']);
  });

  it.each([
    ['prod', '#1f6feb'],
    ['dev', '#f4c542'],
    ['local', '#f4c542'],
    ['staging-next', '#f4c542'],
  ] as const)('serves the preserved runtime manifest for %s', async (appEnv, themeColor) => {
    const res = await request(appFor(appEnv))
      .get('/app-identity/manifest.webmanifest')
      .set('x-origin-verify', SECRET);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toEqual({
      name: 'HousingChoice',
      short_name: 'HousingChoice',
      description: 'Tenant placement, text-first \u2014 the HousingChoice conversation hub.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f7f8fa',
      theme_color: themeColor,
      icons: [
        {
          src: '/app-identity/icon-192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/app-identity/icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/app-identity/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    });
  });

  it.each([
    ['prod', '/app-identity/icon-192.png', '/icons/icon-192.png'],
    ['dev', '/app-identity/icon-192.png', '/icons/icon-nonprod-192.png'],
    ['prod', '/app-identity/icon-512.png', '/icons/icon-512.png'],
    ['dev', '/app-identity/icon-512.png', '/icons/icon-nonprod-512.png'],
    ['prod', '/app-identity/icon-maskable-512.png', '/icons/icon-maskable-512.png'],
    ['dev', '/app-identity/icon-maskable-512.png', '/icons/icon-nonprod-maskable-512.png'],
  ] as const)('%s redirects %s to %s', async (appEnv, source, destination) => {
    const res = await request(appFor(appEnv)).get(source).set('x-origin-verify', SECRET);

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(destination);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('stays behind the origin-secret validator', async () => {
    expect((await request(appFor('dev')).get('/app-identity/config.json')).status).toBe(403);
  });

  it('returns JSON 404 for an unknown identity path', async () => {
    const res = await request(appFor('dev'))
      .get('/app-identity/not-a-real-asset')
      .set('x-origin-verify', SECRET);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'not_found' });
    expect(res.headers['content-type']).not.toContain('text/html');
  });
});
