<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-24).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Environment Visual Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every non-production HousingChoice runtime a Sunflower navigation and yellow `HC` platform identity while production keeps its existing navy navigation and gains a blue `HC` icon.

**Architecture:** `config.appEnv` remains the runtime authority inside one promotable image. A public read-only `/app-identity` router projects a fixed production/non-production identity, dynamic manifest, and icon redirects; a renderless dashboard provider reads that identity once per document and scopes Sunflower tokens to the existing `AppFrame` shell. Static blue/yellow icon families ship together, while the existing service worker, performance request ledger, and Playwright harness verify every runtime reader.

**Tech Stack:** TypeScript, Express 5, React 19, CSS Modules, Vite 7, Vitest 3, Supertest, Playwright, Sharp, Docker.

**Spec:** `docs/superpowers/specs/2026-08-21-environment-visual-identity-design.md`

## Global Constraints

- Production navigation layout, resting colors, hover/active colors, and focus behavior remain unchanged.
- Production platform artwork becomes blue `#1f6feb` with a white centered `HC`.
- `dev`, `local`, hermetic, and any future non-`prod` runtime use Sunflower `#f4c542` with charcoal `#292415` `HC` artwork.
- Add no banner, label, badge, wrapper, page section, or visible environment copy.
- Keep the existing mobile top bar white; only its surrounding browser/PWA theme and the opened drawer become environment-specific.
- Define `--c-nav-focus-ring: #174ea6` only in the non-production shell and override only `outline-color` for nav-field readers; do not alter production focus selectors.
- Keep the account popover and collapsed tooltip white; keep the collapsed Contacts navigation flyout on the nav palette.
- Keep semantic colors, unread badges, type dots, page content tokens, and `badge-72.png` unchanged.
- Keep `/join` and `/p/:unitId` outside `AuthProvider` and free of `/auth/me`; Login retains the existing auth probe that resolves 401 before rendering.
- The config identity response exposes only `variant` and `themeColor`, never raw environment names, user data, table prefixes, or infrastructure identifiers.
- The same container bytes must serve both yellow dev and blue prod from runtime config; no Vite build-time environment switch.
- Do not add dependencies, mutate infrastructure, edit real `.env.*`, deploy, merge into `main`, or clean up the worktree.
- New and touched lines are ASCII-only.
- Stage explicit paths only. Before every commit, run bare `git status` and check `.git/MERGE_HEAD`.
- Every agent-authored commit needs a `Co-Authored-By` trailer naming the actual authoring model. Command examples use the current `Codex GPT-5` convention; change the trailer if the executing model differs.

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `app/src/routes/appIdentity.ts` | Pure runtime variant selection, fixed config JSON, dynamic manifest, and safe local icon redirects. |
| `app/src/app.ts` | Mount `/app-identity` in the locked route stage, classify it read-only at the edge, and reserve it from SPA fallback. |
| `app/test/appIdentity.test.ts` | Variant, headers, redirect, origin-secret, and fallback-reservation route contract. |
| `app/test/appIdentityAssets.test.ts` | PNG dimensions, formats, field colors, HC contrast, safe zone, and variant byte differences. |
| `app/test/staticSmoke.test.ts` | Mounted built-dashboard proof for runtime identity responses and headers. |
| `app/scripts/generate-app-identity-icons.ts` | Deterministically rasterize path-based SVG sources with the app's locked Sharp version. |
| `dashboard/src/api/endpoints.ts` | Typed raw read for `/app-identity/config.json`. |
| `dashboard/src/app/EnvironmentIdentity.tsx` | Validation, production-safe fallback, per-document request memoization, context, and existing meta update. |
| `dashboard/src/app/EnvironmentIdentity.test.tsx` | Production/non-production validation, StrictMode one-read behavior, meta reuse, and failure fallback. |
| `dashboard/src/App.tsx` | Wrap both public and catch-all route trees with the renderless identity provider. |
| `dashboard/src/app/AppFrame.tsx` | Read identity context and add one conditional class to the existing shell element. |
| `dashboard/src/app/AppFrame.module.css` | Sunflower token scope and non-production-only focus color readers. |
| `dashboard/src/app/AppFrame.styles.test.ts` | Source-level reader and production-preservation contract because Vitest disables CSS. |
| `dashboard/src/app/AppFrame.test.tsx` | Shell class/no-copy behavior without weakening existing frame tests. |
| `dashboard/index.html` | Runtime manifest/favicon/touch-icon selectors and production-safe initial theme meta. |
| `dashboard/public/icons/*` | Checked-in production/non-production HC SVG sources and six shipped PNGs. |
| `dashboard/src/sw/display.ts` | Runtime notification main icon selector. |
| `dashboard/public/sw.js` | Shipped classic-worker mirror of the notification icon selector. |
| `dashboard/src/sw/display.test.ts` and `mirror.test.ts` | Source and shipped-worker icon/badge synchronization. |
| `dashboard/public/manifest.webmanifest` | Removed so no static blue manifest bypasses runtime selection. |
| `dashboard/vite.config.ts` | Proxy `/app-identity` in Vite/local/hermetic sessions. |
| `Dockerfile` and `.dockerignore` | Ship both icon families and assert their built-image presence without requiring the removed static manifest. |
| `e2e/performance/templates.ts` | Register and classify the identity config read as first-party API work. |
| `e2e/performance/routes.ts` | Add the identity read to the exact cold-shell contract. |
| `e2e/performance/types.ts` | Bump only the endpoint registry version from 2 to 3. |
| `e2e/performance/*.test.ts` | Lock template, route-shape, and compatibility/version behavior. |
| `e2e/tests/dashboard-next/environment-identity.spec.ts` | Live runtime, responsive nav, focus, public/auth, manifest/icon, and no-label proof. |

---

### Task 1: Runtime app-identity router and edge reservation

**Files:**
- Create: `app/src/routes/appIdentity.ts`
- Create: `app/test/appIdentity.test.ts`
- Modify: `app/src/app.ts`
- Test: `app/test/cloudfrontBehaviors.test.ts`

**Interfaces:**
- Consumes: `AppConfig.appEnv: string` from `app/src/lib/config.ts`.
- Produces: `AppIdentity`, `selectAppIdentity(appEnv: string): AppIdentity`, and `createAppIdentityRouter(deps?: { config?: AppConfig }): Router`.
- Produces routes: `GET /app-identity/config.json`, `GET /app-identity/manifest.webmanifest`, and the three fixed icon-selector redirects.
- Produces edge classification: `EDGE_EXEMPT_PREFIXES['/app-identity']` and inclusion in `RESERVED_PREFIXES`.

- [ ] **Step 1: Write the failing router and selection tests**

Create `app/test/appIdentity.test.ts` with table-driven selection and full-app route assertions. Use `loadConfig({ NODE_ENV: 'test', HC_ENV, CF_ORIGIN_SECRET: SECRET })` so the test exercises the real environment resolver.

```ts
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
  ] as const)('serves no-store config for %s', async (appEnv, variant, themeColor) => {
    const res = await request(appFor(appEnv))
      .get('/app-identity/config.json')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ variant, themeColor });
    expect(Object.keys(res.body).sort()).toEqual(['themeColor', 'variant']);
  });

  it('serves a runtime manifest with selector URLs and no-cache', async () => {
    const res = await request(appFor('dev'))
      .get('/app-identity/manifest.webmanifest')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body.description).toBe('Tenant placement, text-first \u2014 the HousingChoice conversation hub.');
    expect(res.body.theme_color).toBe('#f4c542');
    expect(res.body.icons.map((row: { src: string }) => row.src)).toEqual([
      '/app-identity/icon-192.png',
      '/app-identity/icon-512.png',
      '/app-identity/icon-maskable-512.png',
    ]);
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

  it('404s an unknown identity path instead of returning an SPA document', async () => {
    const res = await request(appFor('dev'))
      .get('/app-identity/not-a-real-asset')
      .set('x-origin-verify', SECRET);
    expect(res.status).toBe(404);
    expect(res.headers['content-type'] ?? '').not.toContain('text/html');
  });
});
```

- [ ] **Step 2: Run the focused app tests and verify the missing module/routes fail**

Run:

```powershell
npm test -w @housingchoice/app -- test/appIdentity.test.ts test/cloudfrontBehaviors.test.ts
```

Expected: FAIL because `routes/appIdentity.ts`, the mount, and the edge classification do not exist.

- [ ] **Step 3: Implement the pure identity projection and fixed router**

Create `app/src/routes/appIdentity.ts`. Keep every destination a literal local path; never derive a redirect from request input.

```ts
import { Router } from 'express';
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

function iconPath(variant: AppIdentityVariant, file: string): string {
  const prefix = variant === 'production' ? 'icon' : 'icon-nonprod';
  return `/icons/${prefix}-${file}.png`;
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
        { src: '/app-identity/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });

  const redirect = (file: string) => (_req: unknown, res: import('express').Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(307, iconPath(identity.variant, file));
  };
  router.get('/icon-192.png', redirect('192'));
  router.get('/icon-512.png', redirect('512'));
  router.get('/icon-maskable-512.png', redirect('maskable-512'));
  router.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return router;
}
```

If TypeScript rejects the inline redirect handler typing, import `type Response` from Express and use `(_req, res: Response): void`; do not weaken it to `any`.

- [ ] **Step 4: Mount and reserve the router without changing middleware order**

In `app/src/app.ts`:

1. Import `createAppIdentityRouter`.
2. Add `'/app-identity': 'read-only runtime presentation identity; GET/HEAD only through the default edge behavior'` to `EDGE_EXEMPT_PREFIXES`.
3. Mount `app.use('/app-identity', createAppIdentityRouter({ config }))` in route stage 4 after the public/unit-media reads and before `/auth` and dashboard static fallback.
4. Do not add a CloudFront Terraform behavior: the default behavior already forwards GET/HEAD/OPTIONS, and the guard must prove this mount is classified exactly once.

- [ ] **Step 5: Run focused backend proof**

Run:

```powershell
npm test -w @housingchoice/app -- test/appIdentity.test.ts test/cloudfrontBehaviors.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both commands exit 0. Confirm the route tests cover `prod`, `dev`, `local`, and a future non-prod value, the full-app origin header, response headers, redirects, and unknown-path 404.

- [ ] **Step 6: Commit Task 1**

Before committing, run `git status` and confirm `.git/MERGE_HEAD` is absent. Stage only these paths:

```powershell
git add -- app/src/routes/appIdentity.ts app/src/app.ts app/test/appIdentity.test.ts app/test/cloudfrontBehaviors.test.ts
git commit -m "feat(app): serve runtime environment identity" -m "Co-Authored-By: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 2: Renderless dashboard identity and Sunflower shell scope

**Files:**
- Create: `dashboard/src/app/EnvironmentIdentity.tsx`
- Create: `dashboard/src/app/EnvironmentIdentity.test.tsx`
- Create: `dashboard/src/app/AppFrame.styles.test.ts`
- Modify: `dashboard/src/api/endpoints.ts`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/App.test.tsx`
- Modify: `dashboard/src/app/AppFrame.tsx`
- Modify: `dashboard/src/app/AppFrame.module.css`
- Modify: `dashboard/src/app/AppFrame.test.tsx`

**Interfaces:**
- Consumes: `getAppIdentityRaw(): Promise<unknown>` from the dashboard API barrel.
- Produces: `EnvironmentIdentity`, `EnvironmentIdentityLoader`, `PRODUCTION_IDENTITY`, `parseEnvironmentIdentity(value: unknown)`, `createEnvironmentIdentityLoader(read: () => Promise<unknown>)`, `EnvironmentIdentityProvider`, and `useEnvironmentIdentity()`.
- Produces a test seam: optional `App.loadIdentity` passed directly to the root provider; production `main.tsx` continues to render `<App />` and therefore uses the one-per-document default singleton.
- Produces shell class: `styles.nonProduction` on the existing `.shell` only when `variant === 'non-production'`.

- [ ] **Step 1: Write failing provider tests**

Create `dashboard/src/app/EnvironmentIdentity.test.tsx` with an existing theme meta installed in `beforeEach` and removed in `afterEach`. The tests must exercise StrictMode rather than merely calling the parser.

```tsx
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppIdentityRaw } from '../api/index.js';
import {
  EnvironmentIdentityProvider,
  createEnvironmentIdentityLoader,
  parseEnvironmentIdentity,
  useEnvironmentIdentity,
} from './EnvironmentIdentity.js';

vi.mock('../api/index.js', () => ({ getAppIdentityRaw: vi.fn() }));

function Probe(): React.JSX.Element {
  const identity = useEnvironmentIdentity();
  return <span>{identity.variant}:{identity.themeColor}</span>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#1f6feb';
  document.head.append(meta);
});

afterEach(() => {
  document.querySelector('meta[name="theme-color"]')?.remove();
  vi.restoreAllMocks();
});

describe('environment identity', () => {
  it('uses the default singleton once under StrictMode', async () => {
    vi.mocked(getAppIdentityRaw).mockResolvedValue({ variant: 'non-production', themeColor: '#f4c542' });
    render(
      <StrictMode>
        <EnvironmentIdentityProvider><Probe /></EnvironmentIdentityProvider>
      </StrictMode>,
    );
    await screen.findByText('non-production:#f4c542');
    expect(getAppIdentityRaw).toHaveBeenCalledTimes(1);
  });

  it('accepts only the two exact server projections', () => {
    expect(parseEnvironmentIdentity({ variant: 'production', themeColor: '#1f6feb' }).variant).toBe('production');
    expect(parseEnvironmentIdentity({ variant: 'non-production', themeColor: '#f4c542' }).variant).toBe('non-production');
    expect(parseEnvironmentIdentity({ variant: 'non-production', themeColor: '#1f6feb' }).variant).toBe('production');
    expect(parseEnvironmentIdentity({ variant: 'dev', themeColor: '#f4c542' }).variant).toBe('production');
  });

  it('shares one read under StrictMode and updates the existing meta', async () => {
    const read = vi.fn(async () => ({ variant: 'non-production', themeColor: '#f4c542' }));
    const loader = createEnvironmentIdentityLoader(read);
    render(
      <StrictMode>
        <EnvironmentIdentityProvider loadIdentity={loader}>
          <Probe />
        </EnvironmentIdentityProvider>
      </StrictMode>,
    );
    await screen.findByText('non-production:#f4c542');
    expect(read).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#f4c542');
  });

  it('renders immediately and falls back to production after a failed read', async () => {
    const loader = createEnvironmentIdentityLoader(async () => Promise.reject(new Error('offline')));
    render(<EnvironmentIdentityProvider loadIdentity={loader}><Probe /></EnvironmentIdentityProvider>);
    expect(screen.getByText('production:#1f6feb')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#1f6feb'));
  });
});
```

- [ ] **Step 2: Run the provider test and verify it fails**

Run:

```powershell
npm test -w @housingchoice/dashboard -- src/app/EnvironmentIdentity.test.tsx
```

Expected: FAIL because the provider module does not exist.

- [ ] **Step 3: Implement the API read, strict validator, memoized loader, and provider**

Add to `dashboard/src/api/endpoints.ts` near the auth reads:

```ts
export function getAppIdentityRaw(): Promise<unknown> {
  return request<unknown>('/app-identity/config.json');
}
```

Create `dashboard/src/app/EnvironmentIdentity.tsx` with these contracts:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getAppIdentityRaw } from '../api/index.js';

export type EnvironmentIdentity =
  | { variant: 'production'; themeColor: '#1f6feb' }
  | { variant: 'non-production'; themeColor: '#f4c542' };

export type EnvironmentIdentityLoader = () => Promise<EnvironmentIdentity>;

export const PRODUCTION_IDENTITY: EnvironmentIdentity = Object.freeze({
  variant: 'production',
  themeColor: '#1f6feb',
});

export function parseEnvironmentIdentity(value: unknown): EnvironmentIdentity {
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (row['variant'] === 'production' && row['themeColor'] === '#1f6feb') {
      return { variant: 'production', themeColor: '#1f6feb' };
    }
    if (row['variant'] === 'non-production' && row['themeColor'] === '#f4c542') {
      return { variant: 'non-production', themeColor: '#f4c542' };
    }
  }
  return PRODUCTION_IDENTITY;
}

export function createEnvironmentIdentityLoader(
  read: () => Promise<unknown>,
): EnvironmentIdentityLoader {
  let pending: Promise<EnvironmentIdentity> | undefined;
  return () => {
    pending ??= read().then(parseEnvironmentIdentity).catch(() => PRODUCTION_IDENTITY);
    return pending;
  };
}

const loadEnvironmentIdentity = createEnvironmentIdentityLoader(getAppIdentityRaw);
const EnvironmentIdentityContext = createContext<EnvironmentIdentity>(PRODUCTION_IDENTITY);

export function EnvironmentIdentityProvider({
  children,
  loadIdentity = loadEnvironmentIdentity,
}: {
  children: ReactNode;
  loadIdentity?: EnvironmentIdentityLoader;
}): React.JSX.Element {
  const [identity, setIdentity] = useState<EnvironmentIdentity>(PRODUCTION_IDENTITY);
  useEffect(() => {
    let active = true;
    void loadIdentity().then((next) => {
      if (!active) return;
      setIdentity(next);
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', next.themeColor);
    });
    return () => { active = false; };
  }, [loadIdentity]);
  return <EnvironmentIdentityContext.Provider value={identity}>{children}</EnvironmentIdentityContext.Provider>;
}

export function useEnvironmentIdentity(): EnvironmentIdentity {
  return useContext(EnvironmentIdentityContext);
}
```

Do not create a meta element, loading element, wrapper, error message, retry timer, or raw environment field.

- [ ] **Step 4: Wrap both route branches and prove the auth boundary**

In `dashboard/src/App.tsx`, import `type EnvironmentIdentityLoader` and change the root signature to `export default function App({ loadIdentity }: { loadIdentity?: EnvironmentIdentityLoader }): React.JSX.Element`. Wrap the existing `<Routes>` in `<EnvironmentIdentityProvider loadIdentity={loadIdentity}>`, and keep `/p/:unitId` and `/join` as siblings of the catch-all `AuthedApp`. Do not move `AuthProvider` upward. `main.tsx` stays unchanged and renders `<App />`, so production uses the default memoized loader.

Extend `dashboard/src/App.test.tsx` with fetch-call tests that:

1. Change `renderAt` to accept a fresh `EnvironmentIdentityLoader` and pass it as `<App loadIdentity={loadIdentity}>`; do not rely on resetting the module singleton between tests.
2. Return non-production config for `/app-identity/config.json` only in the test that explicitly exercises the default provider path.
3. Append one production-blue `meta[name="theme-color"]` before render and remove it after the test, because Vitest does not load `dashboard/index.html`.
4. Render `/join` and `/p/missing-unit` with fresh injected loaders and assert no fetch URL contains `/auth/me`.
5. Render `/` with a fresh injected loader and assert `/auth/me` still occurs before Login or the authenticated shell.
6. Assert `document.querySelectorAll('meta[name="theme-color"]')` remains length 1.

- [ ] **Step 5: Add the conditional class and Sunflower token scope**

In `dashboard/src/app/AppFrame.tsx`, read the context once and change only the existing outer element:

```tsx
const identity = useEnvironmentIdentity();
const shellClass = `${styles.shell} ${identity.variant === 'non-production' ? styles.nonProduction : ''}`;
```

Use `shellClass` as the `className` of the already-present outer `<div>`; leave all of its children byte-for-byte structurally unchanged.

In `dashboard/src/app/AppFrame.module.css`, add the non-production scope directly after `.shell`:

```css
.nonProduction {
  --c-nav-bg: #f4c542;
  --c-nav-brand: #292415;
  --c-nav-label: #67510e;
  --c-nav-text: #403714;
  --c-nav-hover-bg: #e8b72c;
  --c-nav-active-bg: #dbaa1c;
  --c-nav-active-text: #201c0d;
  --c-nav-border: #d1a11b;
  --c-nav-focus-ring: #174ea6;
}

.nonProduction .brand:focus-visible,
.nonProduction .link:focus-visible,
.nonProduction .collapseToggle:focus-visible,
.nonProduction .accountTrigger:focus-visible {
  outline-color: var(--c-nav-focus-ring);
}
```

The shared `.collapseToggle` covers desktop collapse and mobile drawer close. Do not include `.hamburger`, `.topbarBrand`, the popover button, or any general token in this selector.

- [ ] **Step 6: Write the stylesheet and frame regressions**

Create `dashboard/src/app/AppFrame.styles.test.ts` using `readFileSync`, `fileURLToPath`, and `import.meta.url`, following the service-worker mirror test path pattern. Assert:

- The `.nonProduction` block contains every locked token/value.
- One non-production-scoped focus selector contains `.brand`, `.link`, `.collapseToggle`, and `.accountTrigger`, and its body contains `outline-color: var(--c-nav-focus-ring)`.
- No unscoped production selector body was rewritten from `var(--c-brand)` in `dashboard/src/index.css` or from `var(--c-focus-ring)` in the existing control rules.
- The source does not contain an environment label string or selectors for `.hamburger`/`.topbarBrand` in the nav-focus group.
- A small sRGB relative-luminance helper computes and asserts these exact minimum ratios: `#67510e` on `#f4c542` >= 4.5, `#403714` on `#f4c542` >= 4.5, `#201c0d` on `#dbaa1c` >= 4.5, and `#174ea6` against both `#f4c542` and `#dbaa1c` >= 3.0.

Extend `AppFrame.test.tsx` so `renderAuthedApp` accepts a fresh injected `EnvironmentIdentityLoader` and passes it to `<App loadIdentity={loadIdentity}>`. Use separate production and non-production loaders to assert the existing shell parent of `<main>` gains `styles.nonProduction` only for non-production. Do not try to reset or restub the default singleton between tests. Also assert no exact visible text `DEV`, `LOCAL`, or `environment` is introduced.

- [ ] **Step 7: Run focused dashboard proof**

Run:

```powershell
npm test -w @housingchoice/dashboard -- src/app/EnvironmentIdentity.test.tsx src/App.test.tsx src/app/AppFrame.test.tsx src/app/AppFrame.styles.test.ts
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0. If unrelated fetch mocks now see the identity read, add the exact `/app-identity/config.json` branch or allow the documented production fallback; do not make the provider skip existing tests through an environment-only shortcut.

- [ ] **Step 8: Commit Task 2**

Run `git status`, check `.git/MERGE_HEAD`, and stage only Task 2 paths:

```powershell
git add -- dashboard/src/api/endpoints.ts dashboard/src/app/EnvironmentIdentity.tsx dashboard/src/app/EnvironmentIdentity.test.tsx dashboard/src/App.tsx dashboard/src/App.test.tsx dashboard/src/app/AppFrame.tsx dashboard/src/app/AppFrame.module.css dashboard/src/app/AppFrame.styles.test.ts dashboard/src/app/AppFrame.test.tsx
git commit -m "feat(dashboard): apply non-production nav identity" -m "Co-Authored-By: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 3: HC artwork, runtime PWA readers, notification mirror, and container contract

**Files:**
- Create: `dashboard/public/icons/icon-source.svg`
- Create: `dashboard/public/icons/icon-nonprod-source.svg`
- Replace: `dashboard/public/icons/icon-192.png`
- Replace: `dashboard/public/icons/icon-512.png`
- Replace: `dashboard/public/icons/icon-maskable-512.png`
- Create: `dashboard/public/icons/icon-nonprod-192.png`
- Create: `dashboard/public/icons/icon-nonprod-512.png`
- Create: `dashboard/public/icons/icon-nonprod-maskable-512.png`
- Create: `app/scripts/generate-app-identity-icons.ts`
- Remove: `dashboard/public/manifest.webmanifest`
- Create: `app/test/appIdentityAssets.test.ts`
- Modify: `dashboard/index.html`
- Modify: `dashboard/vite.config.ts`
- Modify: `dashboard/src/sw/display.ts`
- Modify: `dashboard/src/sw/display.test.ts`
- Modify: `dashboard/src/sw/mirror.test.ts`
- Modify: `dashboard/public/sw.js`
- Modify: `app/test/staticSmoke.test.ts`
- Modify: `Dockerfile`
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: Task 1 selector routes and Task 2 Vite client.
- Produces: exact production and non-production static icon families plus runtime references from HTML, manifest, and notifications.
- Preserves: `/icons/badge-72.png` byte-for-byte.

- [ ] **Step 1: Write failing notification and asset contract tests**

In `dashboard/src/sw/display.test.ts`, add:

```ts
it('uses runtime identity for the main icon and preserves the monochrome badge', () => {
  const built = buildNotificationOptions({ kind: 'message', conversationId: 'conv-1' });
  expect(built.options.icon).toBe('/app-identity/icon-192.png');
  expect(built.options.badge).toBe('/icons/badge-72.png');
});
```

In `dashboard/src/sw/mirror.test.ts`, add a mirror assertion that the shipped worker contains both exact string literals and no longer contains `icon: '/icons/icon-192.png'`.

Create `app/test/appIdentityAssets.test.ts`. Use `sharp` and `node:crypto` with this concrete structure:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const iconDir = path.resolve(import.meta.dirname, '../../dashboard/public/icons');
const cases = [
  ['icon-192.png', 192, '#1f6feb', '#ffffff'],
  ['icon-512.png', 512, '#1f6feb', '#ffffff'],
  ['icon-maskable-512.png', 512, '#1f6feb', '#ffffff'],
  ['icon-nonprod-192.png', 192, '#f4c542', '#292415'],
  ['icon-nonprod-512.png', 512, '#f4c542', '#292415'],
  ['icon-nonprod-maskable-512.png', 512, '#f4c542', '#292415'],
] as const;

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(path.join(iconDir, file))).digest('hex');
}

describe('environment HC icon assets', () => {
  it.each(cases)('%s has the locked field, HC pixels, and geometry', async (file, size, backgroundHex, foregroundHex) => {
    const source = sharp(path.join(iconDir, file));
    const metadata = await source.metadata();
    expect(metadata).toMatchObject({ format: 'png', width: size, height: size });
    expect([3, 4]).toContain(metadata.channels);

    const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = rgb(backgroundHex);
    const foreground = rgb(foregroundHex);
    expect([...data.subarray(0, 3)]).toEqual(background);

    const foregroundPoints: Array<[number, number]> = [];
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset] === foreground[0] && data[offset + 1] === foreground[1] && data[offset + 2] === foreground[2]) {
          foregroundPoints.push([x, y]);
        }
      }
    }
    expect(foregroundPoints.length).toBeGreaterThan(size * size * 0.02);
    const pixelAtSourceCoordinate = (sourceX: number, sourceY: number): number[] => {
      const x = Math.round(sourceX * size / 512);
      const y = Math.round(sourceY * size / 512);
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    for (const point of [[120, 170], [174, 250], [220, 170], [350, 170], [300, 256], [350, 340]] as const) {
      expect(pixelAtSourceCoordinate(...point), `${file} foreground sample ${point.join(',')}`).toEqual(foreground);
    }
    expect(pixelAtSourceCoordinate(390, 256), `${file} must keep the C aperture open`).toEqual(background);

    const minX = Math.min(...foregroundPoints.map(([x]) => x));
    const maxX = Math.max(...foregroundPoints.map(([x]) => x));
    const minY = Math.min(...foregroundPoints.map(([, y]) => y));
    const maxY = Math.max(...foregroundPoints.map(([, y]) => y));
    expect(Math.abs((minX + maxX) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(size * 0.015);
    expect(Math.abs((minY + maxY) / 2 - (size - 1) / 2)).toBeLessThanOrEqual(size * 0.015);
    if (file.includes('maskable')) {
      expect(minX).toBeGreaterThanOrEqual(51);
      expect(maxX).toBeLessThanOrEqual(460);
      expect(minY).toBeGreaterThanOrEqual(51);
      expect(maxY).toBeLessThanOrEqual(460);
    }
  });

  it.each([
    ['icon-192.png', 'icon-nonprod-192.png'],
    ['icon-512.png', 'icon-nonprod-512.png'],
    ['icon-maskable-512.png', 'icon-nonprod-maskable-512.png'],
  ] as const)('%s and %s are different bytes', async (production, nonProduction) => {
    expect(await digest(production)).not.toBe(await digest(nonProduction));
  });

  it('does not modify the existing monochrome notification badge', async () => {
    expect(await digest('badge-72.png')).toBe('eb34bfbb34d698dd935a8756e71da9c9ae7d687acab418b0b92168d8fd84ce0e');
  });
});
```

The 51..460 maskable bounds are the central 80 percent square around the platform safe circle. Keep the existing badge hash exact.

- [ ] **Step 2: Run tests and verify old static icons fail the new contract**

Run:

```powershell
npm test -w @housingchoice/dashboard -- src/sw/display.test.ts src/sw/mirror.test.ts
npm test -w @housingchoice/app -- test/appIdentityAssets.test.ts
```

Expected: FAIL because notification code still uses the static blue path, non-production icons do not exist, and production icons have no HC monogram.

- [ ] **Step 3: Add reviewable SVG sources and rasterize six checked-in PNGs**

Use full-bleed 512x512 SVG sources with a centered geometric bold `HC`, no pale inset, no external/system font, and generous mask-safe margins. The two files differ only in background and foreground:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#1f6feb"/>
  <path fill="#ffffff" d="M104 150h44v84h52v-84h44v212h-44v-84h-52v84h-44z"/>
  <path fill="#ffffff" d="M408 150h-54c-45 0-70 30-70 76v60c0 46 25 76 70 76h54v-44h-50c-20 0-30-12-30-36v-52c0-24 10-36 30-36h50z"/>
</svg>
```

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#f4c542"/>
  <path fill="#292415" d="M104 150h44v84h52v-84h44v212h-44v-84h-52v84h-44z"/>
  <path fill="#292415" d="M408 150h-54c-45 0-70 30-70 76v60c0 46 25 76 70 76h54v-44h-50c-20 0-30-12-30-36v-52c0-24 10-36 30-36h50z"/>
</svg>
```

Create `app/scripts/generate-app-identity-icons.ts` so generation is repeatable through the app workspace's locked `sharp` dependency:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const iconDir = path.resolve(import.meta.dirname, '../../dashboard/public/icons');
const variants = [
  { source: 'icon-source.svg', prefix: 'icon' },
  { source: 'icon-nonprod-source.svg', prefix: 'icon-nonprod' },
] as const;
const targets = [
  { file: '192', size: 192 },
  { file: '512', size: 512 },
  { file: 'maskable-512', size: 512 },
] as const;

await mkdir(iconDir, { recursive: true });
for (const variant of variants) {
  for (const target of targets) {
    await sharp(path.join(iconDir, variant.source))
      .resize(target.size, target.size, { fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toFile(path.join(iconDir, `${variant.prefix}-${target.file}.png`));
  }
}
```

Run the generator exactly as follows from the repository root:

```powershell
npm exec -- tsx app/scripts/generate-app-identity-icons.ts
```

Use the same 512 path source for the maskable file because the monogram is inside the central safe zone. Do not add `sharp` to another package or generate at application startup.

After generation, inspect both 512 variants and both maskable variants visually, then run the asset test. If geometry fails, correct the checked-in SVG paths and regenerate; do not relax the HC sample, centering, or safe-zone tests around a malformed result.

- [ ] **Step 4: Move every browser/PWA reader to runtime selectors**

Change `dashboard/index.html` to retain one initial blue theme meta but use:

```html
<link rel="manifest" href="/app-identity/manifest.webmanifest" />
<link rel="icon" href="/app-identity/icon-192.png" />
<link rel="apple-touch-icon" href="/app-identity/icon-192.png" />
```

Remove `dashboard/public/manifest.webmanifest`.

Add `'/app-identity': appProxy` to `dashboard/vite.config.ts` with a comment that the runtime identity routes are public but remain behind the app's origin-secret validator.

Change the main notification icon in both `dashboard/src/sw/display.ts` and `dashboard/public/sw.js` to `/app-identity/icon-192.png`. Leave `/icons/badge-72.png` untouched. Update the source comment from static-manifest reuse to runtime environment selection.

- [ ] **Step 5: Update static smoke and Docker build assertions**

In `app/test/staticSmoke.test.ts`, add a built-app test that requests `/app-identity/config.json` with the origin header and asserts status 200, JSON content type, `Cache-Control: no-store`, and the local/non-prod projection. Also request the manifest and an icon selector, proving these mounted routes win before `express.static` and SPA fallback.

Extend the existing index assertion to require the exact runtime manifest/favicon/touch-icon hrefs and reject the old exact `href="/manifest.webmanifest"` and `href="/icons/icon-192.png"` references. This proves the Vite output did not retain a static identity reader.

In `Dockerfile`:

- Replace the old `manifest.webmanifest` file assertion.
- Require `sw.js`, all three production icons, and all three non-production icons under `dashboard/dist/icons/`.
- Keep `COPY dashboard/public ./dashboard/public` and the runtime `COPY --from=build` unchanged.

In `.dockerignore`, rewrite only the PWA comment: the manifest is runtime-owned by `/app-identity`, while `public/` owns the service worker, badge, and both static destination families.

- [ ] **Step 6: Run notification, asset, build, static-smoke, and container-stage proof**

Run in this order:

```powershell
npm test -w @housingchoice/dashboard -- src/sw/display.test.ts src/sw/mirror.test.ts
npm test -w @housingchoice/app -- test/appIdentity.test.ts test/appIdentityAssets.test.ts
npm run build -w @housingchoice/dashboard
npm test -w @housingchoice/app -- test/staticSmoke.test.ts
docker build --target build -t housingchoice-environment-visual-identity-build .
```

Expected: every command exits 0; `staticSmoke.test.ts` must run rather than skip because the preceding dashboard build created `dashboard/dist/index.html`. Record the exact Docker exit code. Do not push the image or run either deploy script.

- [ ] **Step 7: Commit Task 3**

Run `git status`, check `.git/MERGE_HEAD`, and stage every asset explicitly. Confirm `dashboard/public/manifest.webmanifest` is the only deletion and `badge-72.png` is not modified.

```powershell
git add -- app/scripts/generate-app-identity-icons.ts dashboard/public/icons/icon-source.svg dashboard/public/icons/icon-nonprod-source.svg dashboard/public/icons/icon-192.png dashboard/public/icons/icon-512.png dashboard/public/icons/icon-maskable-512.png dashboard/public/icons/icon-nonprod-192.png dashboard/public/icons/icon-nonprod-512.png dashboard/public/icons/icon-nonprod-maskable-512.png dashboard/index.html dashboard/vite.config.ts dashboard/src/sw/display.ts dashboard/src/sw/display.test.ts dashboard/src/sw/mirror.test.ts dashboard/public/sw.js app/test/appIdentityAssets.test.ts app/test/staticSmoke.test.ts Dockerfile .dockerignore
git add -u -- dashboard/public/manifest.webmanifest
git commit -m "feat(pwa): ship runtime HC identity artwork" -m "Co-Authored-By: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 4: Declare identity boot work in the performance contract

**Files:**
- Modify: `e2e/performance/templates.ts`
- Modify: `e2e/performance/routes.ts`
- Modify: `e2e/performance/types.ts`
- Modify: `e2e/performance/redact.test.ts`
- Modify: `e2e/performance/routes.test.ts`
- Modify: `e2e/performance/report.test.ts`
- Modify: `e2e/performance/compare.test.ts`

**Interfaces:**
- Consumes: exact `GET /app-identity/config.json` from Task 1 and one-per-document loader from Task 2.
- Produces: endpoint template/resource class `api`, one required cold-shell shape, and `PERFORMANCE_REGISTRY_VERSION = 3`.
- Preserves: schema version 2, workload version 2, and interception-scope version 3.

- [ ] **Step 1: Write failing template, route, and version expectations**

Add to `e2e/performance/redact.test.ts`:

```ts
it('classifies the runtime identity config as a declared first-party API read', () => {
  expect(sanitized('http://127.0.0.1:9111/app-identity/config.json')).toEqual({
    originClass: 'first_party',
    resourceClass: 'api',
    endpointTemplate: '/app-identity/config.json',
    queryKeys: [],
    unmatchedApi: false,
  });
});
```

Add `'/app-identity/config.json?#required'` to `SHELL_SHAPES` in `routes.test.ts`. Keep the existing exact cold/warm loop: it must now prove every cold route contains the identity read and every warm route omits shell bootstrap work.

Update version expectations:

- `report.test.ts`: summary `{ schemaVersion: 2, registryVersion: 3, workloadVersion: 2 }`.
- `compare.test.ts`: base environment `registryVersion: 3`; registry mismatch fixture changes it to 4.

- [ ] **Step 2: Run focused performance tests and verify they fail**

Run:

```powershell
npm test -w @housingchoice/e2e -- performance/redact.test.ts performance/routes.test.ts performance/report.test.ts performance/compare.test.ts
```

Expected: FAIL because the identity path is unregistered/`other`, the cold-shell shape lacks it, and the registry constant is still 2.

- [ ] **Step 3: Register and classify the exact config endpoint**

In `e2e/performance/templates.ts`:

1. Add `'/app-identity/config.json'` to `ENDPOINT_TEMPLATES` near `/auth/me`.
2. In the matched-template resource classifier, add exact equality `url.pathname === '/app-identity/config.json'` to the existing `/api`, `/auth`, and `/__dev` API conditions.
3. Do not classify the whole `/app-identity` prefix as API: the manifest and icons are browser assets, not required API endpoint shapes.

In `e2e/performance/routes.ts`, add `required('/app-identity/config.json')` once at the start of `COLD_SHELL_GETS`.

In `e2e/performance/types.ts`, change only:

```ts
export const PERFORMANCE_REGISTRY_VERSION = 3 as const;
```

- [ ] **Step 4: Run the focused performance contract and E2E workspace typecheck**

Run:

```powershell
npm test -w @housingchoice/e2e -- performance/redact.test.ts performance/routes.test.ts performance/collect.test.ts performance/selfQa.test.ts performance/report.test.ts performance/compare.test.ts
npm run typecheck -w @housingchoice/e2e
```

Expected: both commands exit 0. Confirm route-shape assertions contain the identity endpoint only in cold mode and the privacy scanner accepts the exact registered template.

- [ ] **Step 5: Commit Task 4**

Run `git status`, check `.git/MERGE_HEAD`, and stage only these paths:

```powershell
git add -- e2e/performance/templates.ts e2e/performance/routes.ts e2e/performance/types.ts e2e/performance/redact.test.ts e2e/performance/routes.test.ts e2e/performance/report.test.ts e2e/performance/compare.test.ts
git commit -m "test(performance): declare identity shell request" -m "Co-Authored-By: Codex GPT-5 <noreply@openai.com>"
```

---

### Task 5: Hermetic responsive proof, final sync, and completion gates

**Files:**
- Create: `e2e/tests/dashboard-next/environment-identity.spec.ts`

**Interfaces:**
- Consumes: all runtime routes, provider state, CSS tokens, assets, and performance contracts from Tasks 1-4.
- Produces: one focused accessibility-first end-to-end contract plus final feature-gate evidence.

- [ ] **Step 1: Write the focused Playwright spec**

Create `e2e/tests/dashboard-next/environment-identity.spec.ts` with two tests.

The anonymous/public test must:

1. Listen for requests/responses to `/app-identity/config.json` and `/auth/me` before navigation.
2. Navigate to `/`; wait for Login; assert the existing meta becomes `#f4c542`; assert at least one existing `/auth/me` response is 401 and the identity read is exactly one despite StrictMode.
3. Open fresh `/join` and `/p/missing-unit` pages/contexts; assert the same Sunflower meta and zero `/auth/me` requests on each.
4. Assert there is no exact visible `DEV`, `LOCAL`, or environment banner text.
5. Request the runtime manifest and assert `theme_color === '#f4c542'`, the three selector URLs, manifest content type, and `Cache-Control: no-cache`.
6. Request each selector with redirects disabled and assert status 307, `Cache-Control: no-store`, and the `icon-nonprod-*` destination.

The authenticated/responsive test must:

1. Use the existing `Continue as dev user` button and `expectTodayReady`.
2. Assert the visible desktop `aside[aria-label="Primary"]` background is `rgb(244, 197, 66)`.
3. Assert keyboard/programmatic focus on the desktop brand, Today link, Tenants child link, collapse control, and account trigger computes `outline-color: rgb(23, 78, 166)`.
4. Collapse the rail; assert the Today hover/focus label surface is white, the Contacts child flyout is Sunflower, and the account popover is white.
5. Resize to `{ width: 390, height: 844 }`; assert the mobile topbar parent of `Open navigation` is white.
6. Open the drawer; assert the visible drawer is Sunflower, the close control has the locked focus color, and accessible nav links remain operable.

Use accessibility-first locators, `exact: true` for overlapping role names, and `toHaveCSS` for computed colors. Do not use CSS module hash names. Use structural CSS only where no role exists, such as `aside[aria-label="Primary"]:visible`.

- [ ] **Step 2: Run the focused E2E spec**

Run only through the e2e workspace:

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/environment-identity.spec.ts
```

Expected: exit 0. If a focus assertion fails, first prove whether the element matches `:focus-visible`; fix selector/focus mechanics or the CSS reader, not the expected locked color.

- [ ] **Step 3: Run the affected targeted checks after implementation review fixes**

Run:

```powershell
npm run typecheck -w @housingchoice/app
npm run typecheck -w @housingchoice/dashboard
npm run typecheck -w @housingchoice/e2e
npm test -w @housingchoice/app -- test/appIdentity.test.ts test/appIdentityAssets.test.ts test/cloudfrontBehaviors.test.ts test/staticSmoke.test.ts
npm test -w @housingchoice/dashboard -- src/app/EnvironmentIdentity.test.tsx src/App.test.tsx src/app/AppFrame.test.tsx src/app/AppFrame.styles.test.ts src/sw/display.test.ts src/sw/mirror.test.ts
npm test -w @housingchoice/e2e -- performance/redact.test.ts performance/routes.test.ts performance/collect.test.ts performance/selfQa.test.ts performance/report.test.ts performance/compare.test.ts
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/environment-identity.spec.ts
docker build --target build -t housingchoice-environment-visual-identity-build .
```

Expected: every command exits 0. Record exact exit codes and whether `staticSmoke.test.ts` ran or skipped; if skipped, rebuild dashboard and rerun it before proceeding.

- [ ] **Step 4: Commit the E2E contract**

Run `git status`, check `.git/MERGE_HEAD`, and stage only the new spec:

```powershell
git add -- e2e/tests/dashboard-next/environment-identity.spec.ts
git commit -m "test(e2e): prove environment visual identity" -m "Co-Authored-By: Codex GPT-5 <noreply@openai.com>"
```

- [ ] **Step 5: Sync current `main` into the feature branch exactly once**

From the feature worktree, inspect current state and main drift:

```powershell
git status
git rev-parse HEAD
git rev-parse main
git log --oneline --left-right HEAD...main
```

If `main` advanced, merge it into `feat/environment-visual-identity`, preserving both sides. Do not move the shared main checkout and do not merge the feature branch into `main`.

```powershell
git merge main
```

If the merge conflicts with active/unrelated work, stop and report exact paths rather than guessing. After a clean merge, run `git status` and check `.git/MERGE_HEAD` before any conflict-resolution commit.

- [ ] **Step 6: Run the three bare feature-mission gates from the final synced commit**

Run each command bare, unpiped, and record its real exit code:

```powershell
npm run typecheck
npm test
npm run e2e
```

Expected: all three exit 0. For either documented known flake, rerun the affected test once and report both results exactly; do not silently relabel a deterministic failure as a flake.

- [ ] **Step 7: Perform final live QA and independent handback review**

Use a hermetic `npm run e2e:session` lane, never the human's `:5174`/`:8080` live dashboard. Verify and capture screenshots under `.playwright-mcp/` for:

- Login with Sunflower browser theme and no label.
- Desktop expanded Sunflower sidebar.
- Desktop collapsed Sunflower rail, yellow Contacts flyout, white tooltip, and white account popover.
- Mobile white topbar and opened Sunflower drawer.
- Yellow HC favicon/manifest selector and notification main-icon response.

Stop the session with `npm run e2e:stop`. Then provide the final branch commit, exact gate results, Docker build result, reviewer verdict, any known platform icon-refresh limitation, and human-owned merge command. Do not deploy, merge, or clean up.

---

## Completion evidence checklist

- [ ] Production selection tests prove navy tokens remain untouched and blue HC assets are selected.
- [ ] Non-production tests prove Sunflower nav, yellow HC assets, blue focus ring, white mobile topbar, and white transient overlays.
- [ ] Public routes remain session-free; Login retains its existing 401 auth probe.
- [ ] Config/manifest/redirect headers prevent cross-runtime cache pinning.
- [ ] Static manifest is removed; HTML, service worker, installed PWA, and notification readers all use runtime selectors.
- [ ] Both icon families survive Vite and Docker build context/copy assertions.
- [ ] Performance registry 3 declares the exact cold-shell identity read without changing schema/workload/interception versions.
- [ ] No visible environment UI, dependency, infra, secret, `.env.*`, deployment, or main-branch mutation was introduced.
- [ ] Final synced commit passes bare `npm run typecheck`, `npm test`, and `npm run e2e`.
