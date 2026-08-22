import { Router, type Response } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';

export type AppIdentityVariant = 'production' | 'non-production';

export interface AppIdentity {
  variant: AppIdentityVariant;
  themeColor: '#1f6feb' | '#f4c542';
}

const PRODUCTION: AppIdentity = Object.freeze({
  variant: 'production',
  themeColor: '#1f6feb',
});

const NON_PRODUCTION: AppIdentity = Object.freeze({
  variant: 'non-production',
  themeColor: '#f4c542',
});

export function selectAppIdentity(appEnv: string): AppIdentity {
  return appEnv === 'prod' ? PRODUCTION : NON_PRODUCTION;
}

export function createAppIdentityRouter(deps: { config?: AppConfig } = {}): Router {
  const config = deps.config ?? loadConfig();
  const identity = selectAppIdentity(config.appEnv);
  const router = Router();

  router.get('/config.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(identity);
  });

  router.get('/manifest.webmanifest', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'HousingChoice',
      short_name: 'HousingChoice',
      description: 'Tenant placement, text-first \u2014 the HousingChoice conversation hub.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f7f8fa',
      theme_color: identity.themeColor,
      icons: [
        { src: '/app-identity/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/app-identity/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/app-identity/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    }));
  });

  const redirect = (productionPath: string, nonProductionPath: string) =>
    (_req: unknown, res: Response): void => {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(307, identity.variant === 'production' ? productionPath : nonProductionPath);
    };

  router.get('/icon-192.png', redirect('/icons/icon-192.png', '/icons/icon-nonprod-192.png'));
  router.get('/icon-512.png', redirect('/icons/icon-512.png', '/icons/icon-nonprod-512.png'));
  router.get(
    '/icon-maskable-512.png',
    redirect('/icons/icon-maskable-512.png', '/icons/icon-nonprod-maskable-512.png'),
  );

  router.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return router;
}
