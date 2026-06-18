<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Fake-Phones Web UI Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. UI-building tasks should additionally use **superpowers:frontend-design** for polish. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A polished, dev-only "fake-phones" web UI where a human (or agent) acts as any seeded/ad-hoc party — sends/receives texts, attaches canned MMS, toggles delivery outcomes — and watches the real app react live, on top of Plan 1's fake-twilio control API.

**Architecture:** A standalone React 19 + Vite app at `fake-twilio/web/`, served as a static build by the existing fake-twilio Express host on port 8889 (matching design spec §6). It talks to the Plan-1 control API (`/control/*`) and live-updates over a new Server-Sent Events endpoint (`GET /control/events`) fed by a new event-emitter on the engine. The UI mirrors the dashboard's design system (`tokens.css`, CSS Modules, `useEventStream` idiom) for a consistent, quality-bar look. Dev/e2e-only — never deployed (fake-twilio is absent from the Docker image and refuses to boot in production).

**Tech Stack:** React 19, Vite 7, TypeScript (strict, `tsconfig.base.json`), Vitest + @testing-library/react (jsdom) for component tests, Playwright for one live smoke. Express 5 host additions. All versions pinned to match `dashboard/package.json`.

**Depends on:** Plan 1 (branch `fake-twilio-mock`). Build on that branch/worktree.

---

## Reference facts (verified against the worktree — these drive the code below)

- **Engine** (`fake-twilio/src/engine/engine.ts`): single instance built in `buildFakeTwilioApp`. State changes happen at: `sendAsParty` → `store.append(input.from, msg)` (inbound); `recordOutboundFromApp` → `store.append(input.to, msg)` (outbound, state `queued`) then scheduled `store.updateState(sid, state)` + `updated.updatedAt = clock.nowIso()` per delivery transition; `addAdHoc` → registry; `setDeliveryOutcome` → `nextProfile`; `reset` → cancels timers + clears. **No event-emitter exists yet** — Phase A adds one.
- **Types** (`fake-twilio/src/engine/types.ts`): `Role = 'landlord'|'tenant'|'pm'|'staff'`; `DeliveryState = 'queued'|'sent'|'delivered'|'undelivered'|'failed'`; `Persona { id,label,role,number,seededRef?,adHoc }`; `ThreadMessage { sid,direction,from,to,body?,mediaUrls?,state,createdAt,updatedAt }`; `Thread { partyNumber, messages }`; `DeliveryProfile { kind:'normal'|'stall'|'fail', stallAt?, failState?, errorCode? }`.
- **Control API** (`fake-twilio/src/routes/control.ts`): `GET /control/personas → {personas:Persona[]}`; `POST /control/personas/ad-hoc` (body `AddAdHocInput`) `→ Persona|{error}`; `POST /control/send-as-party` (body `SendAsPartyInput`) `→ {sid}|{error}`; `GET /control/threads → {threads:Thread[]}`; `POST /control/delivery-outcome` (body `SetDeliveryOutcomeInput`) `→ {ok}|{error}`; `POST /control/reset → {ok}`; `GET /control/dispatch-errors → {errors:DispatchError[]}`.
- **Host** (`fake-twilio/src/server.ts`): builds engine, `express.urlencoded`+`express.json`, `/health`, `createRestRouter`, `createControlRouter`. No static serving / SSE yet. NODE_ENV-prod guard already present.
- **Config** (`fake-twilio/src/config.ts`): `FakeTwilioConfig { port, appBaseUrl, appPublicBaseUrl, authToken, originSecret }`, `loadFakeConfig(env)`.
- **App SSE pattern to mirror** (`app/src/routes/api.ts` `GET /api/events`): `res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'})`; `res.write(': connected\n\n')`; frames `event: <name>\ndata: <json>\n\n`; 25s heartbeat `: heartbeat\n\n` with `heartbeat.unref()`; connection cap → 503; cleanup on `res.on('close')` (decrement, clearInterval, unsubscribe, `res.end()`).
- **Static + SPA fallback to mirror** (`app/src/app.ts`): CSP headers middleware, `express.static(distDir)`, then SPA fallback that bypasses reserved prefixes and `sendFile(index.html)` for other GET/HEAD.
- **Dashboard design system to mirror**: `dashboard/src/ui/tokens.css` (the `--hc-*` custom properties incl. the delivery palette: neutral/info/success/warning/danger + `-bg` variants), CSS Modules idiom (`dashboard/src/ui/Button.tsx` + `Button.module.css`), SSE client (`dashboard/src/api/useEventStream.ts` — handlers-in-ref, EventSource, exponential backoff 1s→30s). Versions: react ^19, react-dom ^19, @vitejs/plugin-react ^5, vite ^7, vitest ^3.2, @testing-library/react ^16.1, @testing-library/jest-dom ^6.6, jsdom ^25. Dashboard `tsconfig.json` (ES2022, DOM libs, `jsx: react-jsx`, `moduleResolution: bundler`, types `vite/client`/`vitest/globals`/`jest-dom`).
- **e2e stack** (`scripts/e2e-session.mjs`): `startFakeTwilio()` reaps :8889 then spawns the host; `restartBackend()` bounces app+worker+fake-twilio; Vite (`startVite`) serves the dashboard on :5173 and survives restarts.

---

## File structure (Plan 2)

**Backend additions (fake-twilio package):**
- `fake-twilio/src/engine/engine.ts` — add `subscribe()` + `emit()` + `EngineEvent` type.
- `fake-twilio/src/routes/events.ts` — **new**: `createEventsRouter(engine, opts)` → `GET /control/events` (SSE).
- `fake-twilio/src/server.ts` — mount events router; add static-serve + SPA fallback when `uiDistDir` is set.
- `fake-twilio/src/config.ts` — add `uiDistDir?: string` (from `FAKE_TWILIO_UI_DIST`).

**New standalone UI app `fake-twilio/web/`:**
- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/test/setup.ts`
- `src/index.css` (imports tokens), `src/styles/tokens.css` (copied from dashboard)
- `src/api/types.ts` (wire types mirroring engine), `src/api/client.ts` (control fetchers), `src/api/useFakeEvents.ts` (SSE hook)
- `src/state/useFakePhones.ts` (data hook: initial load + live merge)
- `src/ui/` components: `App.tsx`, `RosterRail.tsx`, `PhonePanel.tsx`, `MessageBubble.tsx`, `StatusChip.tsx`, `Composer.tsx`, `AdHocDialog.tsx`, `DevBanner.tsx` + co-located `*.module.css`
- `src/assets/canned/` — a few small committed dev images for MMS
- `src/**/*.test.tsx` — component + hook tests

**Root + e2e:**
- root `package.json` — add `fake-twilio/web` to workspaces.
- `scripts/e2e-session.mjs` — build the UI once + serve via the host (set `FAKE_TWILIO_UI_DIST`); log the URL.
- `e2e/tests/flows/fake-phones-ui.spec.ts` — one live smoke (code; live run is the joint step).
- `RUNBOOK.md` — document opening the fake-phones UI.

---

## Phase A — Engine event-emitter

### Task A.1: Add `subscribe()`/`emit()` and emit on every state change

**Files:** Modify `fake-twilio/src/engine/engine.ts`; Test `fake-twilio/test/engineEvents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/engineEvents.test.ts
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine, type EngineEvent } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';

function makeEngine() {
  const events: EngineEvent[] = [];
  const engine = new FakeTwilioEngine({
    clock: new ManualClock('2026-06-15T00:00:00.000Z'),
    dispatcher: { post: async () => 200 },
  });
  const unsub = engine.subscribe((e) => events.push(e));
  return { engine, events, unsub };
}

describe('engine events', () => {
  it('emits message.appended for an inbound send-as-party', async () => {
    const { engine, events } = makeEngine();
    await engine.sendAsParty({ from: '+15550100001', body: 'hi' });
    const ev = events.find((e) => e.type === 'message.appended');
    expect(ev).toMatchObject({ type: 'message.appended', partyNumber: '+15550100001' });
    if (ev?.type === 'message.appended') expect(ev.message.direction).toBe('inbound');
  });

  it('emits message.appended then message.updated for an outbound + status progression', () => {
    const { engine, events } = makeEngine();
    const clock = (engine as unknown as { clock: ManualClock }).clock;
    engine.recordOutboundFromApp({ to: '+15550100001', from: '+15550009999', body: 'yo' });
    clock.flush();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message.appended');
    expect(types).toContain('message.updated');
  });

  it('emits persona.added and reset', () => {
    const { engine, events } = makeEngine();
    engine.addAdHoc({ label: 'X', role: 'tenant' });
    engine.reset();
    expect(events.some((e) => e.type === 'persona.added')).toBe(true);
    expect(events.some((e) => e.type === 'reset')).toBe(true);
  });

  it('unsubscribe stops delivery; a throwing listener does not break emit', async () => {
    const { engine, events, unsub } = makeEngine();
    engine.subscribe(() => { throw new Error('bad listener'); });
    await engine.sendAsParty({ from: '+15550100001', body: 'a' }); // must not throw
    unsub();
    await engine.sendAsParty({ from: '+15550100002', body: 'b' });
    expect(events.filter((e) => e.type === 'message.appended')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it; confirm it fails** — `npm run test -w @housingchoice/fake-twilio -- engineEvents` → FAIL (`subscribe`/`EngineEvent` missing).

- [ ] **Step 3: Implement**

Add to `engine.ts` (near the top-level exports):

```ts
import type { Persona, ThreadMessage } from './types.js';

export type EngineEvent =
  | { type: 'message.appended'; partyNumber: string; message: ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: ThreadMessage }
  | { type: 'persona.added'; persona: Persona }
  | { type: 'reset' };

export type EngineListener = (event: EngineEvent) => void;
```

In the `FakeTwilioEngine` class add a listener set + methods:

```ts
  private readonly listeners = new Set<EngineListener>();

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A misbehaving subscriber (e.g. a dead SSE socket) must never break the engine.
      }
    }
  }
```

Then emit at each state change (use the existing local `message`/`persona` variables — do NOT re-read the store):
- In `sendAsParty`, right after `this.store.append(input.from, message)`:
  `this.emit({ type: 'message.appended', partyNumber: input.from, message });`
- In `recordOutboundFromApp`, right after `this.store.append(input.to, message)`:
  `this.emit({ type: 'message.appended', partyNumber: input.to, message });`
- In the scheduled status callback, right after `updated.updatedAt = this.clock.nowIso();`:
  `this.emit({ type: 'message.updated', partyNumber: input.to, message: updated });`
- In `addAdHoc`, after the registry call returns `persona`:
  `this.emit({ type: 'persona.added', persona });`
- In `reset`, after clearing state:
  `this.emit({ type: 'reset' });`

- [ ] **Step 4: Run the test; green.** Then the full suite `npm run test -w @housingchoice/fake-twilio` + `npm run typecheck -w @housingchoice/fake-twilio` — all clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(fake-twilio): engine event-emitter for live UI updates"`

---

## Phase B — SSE endpoint `GET /control/events`

### Task B.1: Stream engine events as SSE (mirror the app's pattern)

**Files:** Create `fake-twilio/src/routes/events.ts`; Modify `fake-twilio/src/server.ts`; Test `fake-twilio/test/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/events.test.ts
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { ManualClock } from '../src/engine/clock.js';

function cfg() {
  return loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't' });
}

describe('GET /control/events (SSE)', () => {
  it('sends the connected comment then an event when the engine emits', async () => {
    const engine = new FakeTwilioEngine({ clock: new ManualClock('2026-06-15T00:00:00.000Z'), dispatcher: { post: async () => 200 } });
    const app = buildFakeTwilioApp({ config: cfg(), engine });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');

    const chunks: string[] = [];
    const req = http.get({ port: addr.port, path: '/control/events' });
    const body: string = await new Promise((resolve) => {
      req.on('response', (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          // Trigger an engine event after the stream opens.
          if (chunks.join('').includes(': connected')) {
            void engine.sendAsParty({ from: '+15550100001', body: 'hi' });
          }
          if (chunks.join('').includes('message.appended')) {
            req.destroy();
            resolve(chunks.join(''));
          }
        });
      });
    });
    server.close();

    expect(body).toContain(': connected');
    expect(body).toContain('event: message.appended');
    expect(body).toContain('"partyNumber":"+15550100001"');
  });
});
```

- [ ] **Step 2: Run it; confirm it fails** (route missing).

- [ ] **Step 3: Implement `events.ts`**

```ts
// fake-twilio/src/routes/events.ts
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';

const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS = 25;

/** SSE stream of engine events for the fake-phones UI. Mirrors the app's /api/events. */
export function createEventsRouter(engine: FakeTwilioEngine): Router {
  const router = Router();
  let connections = 0;

  router.get('/control/events', (_req, res) => {
    if (connections >= MAX_CONNECTIONS) {
      res.status(503).json({ error: 'too many event streams' });
      return;
    }
    connections += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const unsubscribe = engine.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    heartbeat.unref();

    res.on('close', () => {
      connections -= 1;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
```

- [ ] **Step 4: Mount it in `server.ts`** — after `app.use(createControlRouter(engine));`:

```ts
import { createEventsRouter } from './routes/events.js';
// ...
app.use(createEventsRouter(engine));
```

- [ ] **Step 5: Run the test; green.** Full suite + typecheck clean.

- [ ] **Step 6: Commit** — `git commit -m "feat(fake-twilio): SSE /control/events for live UI updates"`

---

## Phase C — Host static-serving for the built UI

### Task C.1: Serve `fake-twilio/web/dist` when `FAKE_TWILIO_UI_DIST` is set

**Files:** Modify `fake-twilio/src/config.ts`, `fake-twilio/src/server.ts`; Test `fake-twilio/test/uiServe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// fake-twilio/test/uiServe.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { buildFakeTwilioApp } from '../src/server.js';
import { loadFakeConfig } from '../src/config.js';
import { FakeTwilioEngine } from '../src/engine/engine.js';
import { RealClock } from '../src/engine/clock.js';

let distDir: string;
beforeAll(() => {
  distDir = mkdtempSync(path.join(tmpdir(), 'ftui-'));
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>fake-phones</title>');
  writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log(1)');
});
afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function app() {
  const config = loadFakeConfig({ NODE_ENV: 'test', TWILIO_AUTH_TOKEN: 't', FAKE_TWILIO_UI_DIST: distDir });
  const engine = new FakeTwilioEngine({ clock: new RealClock(), dispatcher: { post: async () => 200 } });
  return buildFakeTwilioApp({ config, engine });
}

describe('UI static serving', () => {
  it('serves index.html at /', async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fake-phones');
  });
  it('serves built assets', async () => {
    const res = await request(app()).get('/assets/app.js');
    expect(res.status).toBe(200);
  });
  it('SPA-falls-back unknown GETs to index.html', async () => {
    const res = await request(app()).get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('fake-phones');
  });
  it('does NOT hijack the control API or health', async () => {
    expect((await request(app()).get('/health')).body).toMatchObject({ ok: true });
    expect((await request(app()).get('/control/threads')).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it; confirm it fails.**

- [ ] **Step 3: Add `uiDistDir` to config** — in `config.ts`, add `uiDistDir?: string;` to `FakeTwilioConfig` and in `loadFakeConfig` return object: `...(env.FAKE_TWILIO_UI_DIST ? { uiDistDir: env.FAKE_TWILIO_UI_DIST } : {})`.

- [ ] **Step 4: Add static-serve + SPA fallback in `server.ts`** — after the events router mount, before `return app`:

```ts
import path from 'node:path';
// ...
  if (deps.config.uiDistDir) {
    const distDir = path.resolve(deps.config.uiDistDir);
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', csp);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      const reserved = ['/control', '/health', '/2010-04-01', '/webhooks'].some(
        (p) => req.path === p || req.path.startsWith(`${p}/`),
      );
      if ((req.method !== 'GET' && req.method !== 'HEAD') || reserved) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  }
```

> Place the CSP middleware + static + fallback AFTER all API routers so reserved prefixes are matched by their routers first; the fallback only catches the remainder.

- [ ] **Step 5: Run the test; green.** Full suite + typecheck clean. (The existing server tests run without `FAKE_TWILIO_UI_DIST`, so static serving is inert there.)

- [ ] **Step 6: Commit** — `git commit -m "feat(fake-twilio): serve the fake-phones UI build (static + SPA fallback)"`

---

## Phase D — Scaffold the `fake-twilio/web/` React+Vite app

### Task D.1: Package, build config, entry, design tokens, test setup

**Files:** Create `fake-twilio/web/{package.json,tsconfig.json,vite.config.ts,index.html}`, `fake-twilio/web/src/{main.tsx,index.css,test/setup.ts}`, `fake-twilio/web/src/styles/tokens.css`; Modify root `package.json` (workspaces). Test: `fake-twilio/web/src/ui/App.test.tsx` (smoke).

- [ ] **Step 1: Read `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/vite.config.ts`, `dashboard/src/test/setup.ts`** to copy exact versions/conventions.

- [ ] **Step 2: Write `fake-twilio/web/package.json`** (pin versions to the dashboard's):

```json
{
  "name": "@housingchoice/fake-twilio-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^25.0.0",
    "vite": "^7.0.0",
    "vitest": "^3.2.0"
  }
}
```

(Reconcile every version against the actual `dashboard/package.json` in Step 1; add `@testing-library/user-event` at the version already in the lockfile if present, else the latest 14.x.)

- [ ] **Step 3: Write `fake-twilio/web/tsconfig.json`** — mirror `dashboard/tsconfig.json` (extends `../../tsconfig.base.json`, ES2022 + DOM libs, `jsx: react-jsx`, `moduleResolution: bundler`, `noEmit`, types `vite/client`,`vitest/globals`,`@testing-library/jest-dom`, `include: ["src","vite.config.ts"]`).

- [ ] **Step 4: Write `fake-twilio/web/vite.config.ts`** — dev server on a fixed port, proxying the control API + SSE + health to the host on :8889:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = { target: 'http://localhost:8889' };

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, open: false, proxy: { '/control': host, '/health': host } },
  build: { modulePreload: { polyfill: false } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 15000,
  },
});
```

- [ ] **Step 5: Write `index.html`, `src/main.tsx`, `src/test/setup.ts`** (mirror dashboard): `main.tsx` mounts `<App/>` into `#root` and imports `./index.css`; `test/setup.ts` is `import '@testing-library/jest-dom/vitest'; import { cleanup } from '@testing-library/react'; import { afterEach } from 'vitest'; afterEach(cleanup);`.

- [ ] **Step 6: Copy `dashboard/src/ui/tokens.css` → `fake-twilio/web/src/styles/tokens.css`**, and `src/index.css` imports it + a minimal reset + `body { background: var(--hc-color-bg); color: var(--hc-color-text); font-family: var(--hc-font-sans); margin: 0; }`.

- [ ] **Step 7: Write a smoke `App.tsx` + test**

```tsx
// fake-twilio/web/src/ui/App.tsx (smoke version — fleshed out in Phase F/G)
export function App(): React.JSX.Element {
  return <div><h1>Fake Phones</h1></div>;
}
```

```tsx
// fake-twilio/web/src/ui/App.test.tsx
import { render, screen } from '@testing-library/react';
import { App } from './App.js';
test('renders the app heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /fake phones/i })).toBeVisible();
});
```

- [ ] **Step 8: Add `"fake-twilio/web"` to the root `package.json` workspaces; `npm install`; run `npm run test -w @housingchoice/fake-twilio-web` (green) + `npm run typecheck -w @housingchoice/fake-twilio-web` (clean).**

- [ ] **Step 9: Commit** — `git commit -m "chore(fake-phones): scaffold standalone React+Vite UI app"`

---

## Phase E — Data layer: types, control client, SSE hook

### Task E.1: Wire types + control-API client

**Files:** Create `fake-twilio/web/src/api/types.ts`, `fake-twilio/web/src/api/client.ts`; Test `fake-twilio/web/src/api/client.test.ts`

- [ ] **Step 1: Write `types.ts`** — copy the wire shapes (`Role`, `DeliveryState`, `DeliveryProfile`, `Persona`, `ThreadMessage`, `Thread`) verbatim from `fake-twilio/src/engine/types.ts` (the UI is a separate package, so re-declare them; add a comment that they mirror the engine types).

- [ ] **Step 2: Write the failing client test** (mock `fetch`)

```ts
// fake-twilio/web/src/api/client.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { getPersonas, sendAsParty, addAdHoc } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('control client', () => {
  it('getPersonas GETs /control/personas and returns the array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ personas: [{ id: 'a', label: 'A', role: 'tenant', number: '+15550100001', adHoc: false }] }), { status: 200 })));
    const personas = await getPersonas();
    expect(personas[0]?.number).toBe('+15550100001');
  });
  it('sendAsParty POSTs the body and returns sid', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: 'SMx' }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const sid = await sendAsParty({ from: '+15550100001', body: 'hi' });
    expect(sid).toBe('SMx');
    expect(f).toHaveBeenCalledWith('/control/send-as-party', expect.objectContaining({ method: 'POST' }));
  });
  it('addAdHoc throws with the server error message on 400', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad number' }), { status: 400 })));
    await expect(addAdHoc({ label: 'x', role: 'tenant', number: 'nope' })).rejects.toThrow(/bad number/);
  });
});
```

- [ ] **Step 3: Implement `client.ts`**

```ts
// fake-twilio/web/src/api/client.ts
import type { AddAdHocInput, DeliveryProfile, Persona, SendAsPartyInput, Thread } from './types.js';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json['error'] === 'string' ? json['error'] : `${path} failed: ${res.status}`);
  return json as T;
}
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getPersonas(): Promise<Persona[]> {
  return (await get<{ personas: Persona[] }>('/control/personas')).personas;
}
export async function getThreads(): Promise<Thread[]> {
  return (await get<{ threads: Thread[] }>('/control/threads')).threads;
}
export async function sendAsParty(input: SendAsPartyInput): Promise<string> {
  return (await post<{ sid: string }>('/control/send-as-party', input)).sid;
}
export async function addAdHoc(input: AddAdHocInput): Promise<Persona> {
  return post<Persona>('/control/personas/ad-hoc', input);
}
export async function setDeliveryOutcome(partyNumber: string, profile: DeliveryProfile): Promise<void> {
  await post('/control/delivery-outcome', { partyNumber, profile });
}
export async function resetAll(): Promise<void> {
  await post('/control/reset', {});
}
```

(Define `AddAdHocInput`/`SendAsPartyInput`/`SetDeliveryOutcomeInput` in `types.ts` to match the engine DTOs.)

- [ ] **Step 4: Green + typecheck. Commit** — `git commit -m "feat(fake-phones): control-API client + wire types"`

### Task E.2: SSE hook `useFakeEvents`

**Files:** Create `fake-twilio/web/src/api/useFakeEvents.ts`; Test `fake-twilio/web/src/api/useFakeEvents.test.tsx`

- [ ] **Step 1: Write the failing test** — render a tiny component using the hook; stub `EventSource` with a fake that lets the test dispatch a `message.appended` event; assert the handler fires. (Mirror the dashboard's `useEventStream` test approach; if none exists, use a minimal `class FakeEventSource` stub assigned to `globalThis.EventSource` that records `addEventListener` handlers and exposes a `emit(type, data)` helper.)

- [ ] **Step 2: Implement `useFakeEvents.ts`** — adapt `dashboard/src/api/useEventStream.ts` exactly (handlers-in-ref, exponential backoff 1s→30s, cleanup on unmount), but:
  - connect to `new EventSource('/control/events')` (no credentials needed — same origin, no cookies),
  - listen for the four engine event types and a generic fallback:

```ts
import { useEffect, useRef } from 'react';
import type { EngineEvent } from './types.js'; // add EngineEvent union to types.ts mirroring engine.ts

export interface FakeEventHandlers {
  onEvent: (event: EngineEvent) => void;
  onOpen?: () => void;
  enabled?: boolean;
}
// ...same lifecycle/backoff shape as useEventStream, but a single listener loop:
//   for (const t of ['message.appended','message.updated','persona.added','reset'])
//     source.addEventListener(t, (ev) => { const d = parse<EngineEvent>((ev as MessageEvent).data); if (d) handlersRef.current.onEvent(d); });
```

Add `EngineEvent` (the same union as `fake-twilio/src/engine/engine.ts`) to `types.ts`.

- [ ] **Step 3: Green + typecheck. Commit** — `git commit -m "feat(fake-phones): SSE hook for live engine events"`

### Task E.3: Data hook `useFakePhones` (initial load + live merge)

**Files:** Create `fake-twilio/web/src/state/useFakePhones.ts`; Test `...useFakePhones.test.tsx`

- [ ] **Step 1: Write the failing test** — mock `client.getPersonas`/`getThreads` + the SSE hook; assert: initial state loads personas+threads; a `message.appended` event appends to the right thread (creating it if absent); a `message.updated` event patches the message's `state` by sid; `reset` clears threads; `persona.added` appends to personas.

- [ ] **Step 2: Implement** — a hook returning `{ personas, threads, unreadByNumber, selected, select, refresh }` plus actions wired to the client. It calls `getPersonas()`+`getThreads()` on mount, then `useFakeEvents({ onEvent })` to merge live. Track unread counts per party number (increment on inbound `message.appended` for a non-selected party; clear on `select`). Keep merge logic pure and unit-tested.

- [ ] **Step 3: Green + typecheck. Commit** — `git commit -m "feat(fake-phones): live data hook (initial load + SSE merge)"`

---

## Phase F — Presentational components

> Implementers: use **superpowers:frontend-design** for these. Match the dashboard idiom EXACTLY — CSS Modules, `--hc-*` tokens, `getByRole`/`getByLabel`-friendly accessible markup (this is the same accessibility-first bar as `e2e/support/selectors.md`). Each component gets a co-located `.module.css` and a `*.test.tsx`. **Never** use `dangerouslySetInnerHTML`; render message bodies as text (React escapes — this is the XSS guard). The reference idiom is `dashboard/src/ui/Button.tsx` + `Button.module.css`.

### Task F.1: `StatusChip`
A small pill showing a `DeliveryState`. Map state → token palette: `queued`→neutral, `sent`→info, `delivered`→success, `undelivered`/`failed`→danger; show the `ErrorCode`/state label as accessible text. Test: each state renders the right label + an accessible name.

### Task F.2: `MessageBubble`
One message: inbound (left, neutral surface) vs outbound (right, brand). Shows body text (escaped), optional media thumbnail(s) for `mediaUrls` (render an `<img>` of the canned asset — same-origin, from `src/assets/canned/`), a timestamp, and (outbound only) a `StatusChip`. Test: inbound vs outbound styling/role; body text; status chip present only for outbound.

### Task F.3: `RosterRail`
Left rail. Personas grouped by `role` (Landlord / Tenant / PM / Staff headings), each row a button showing label + number + an unread badge. A **＋ Ad-hoc number** button at the bottom opens `AdHocDialog`. The selected persona is visually active and `aria-current`. Test: grouping by role; clicking a row calls `onSelect`; unread badge renders; the ad-hoc button is present.

### Task F.4: `AdHocDialog`
A small modal/inline form: label + role select (+ optional number) → calls `addAdHoc`. Accessible dialog (`role="dialog"`, labelled, Esc/close). Test: submitting calls the action with the entered values; validation error from the server is surfaced inline.

### Task F.5: `Composer`
Bottom bar of the phone panel: a textarea (`aria-label="Message"`), a **Send** button, a small **canned-image** picker (a few buttons selecting an MMS asset → adds to the outgoing `mediaUrls`), and a **delivery-profile toggle** (segmented control: Normal / Stall at sent / Fail → calls `setDeliveryOutcome` for the selected party before/with the send). Enter sends, Shift+Enter newlines (mirror the dashboard composer). Test: typing + Send calls `sendAsParty` with body (and media when a canned image is picked); the profile toggle calls `setDeliveryOutcome`.

### Task F.6: `DevBanner`
A persistent, subtle top banner: "DEV — fake Twilio (no real messages are sent)". Test: renders the warning text.

For EACH component: failing test first → implement component + CSS module → green. Commit per component (or per 2-3 related), e.g. `git commit -m "feat(fake-phones): StatusChip + MessageBubble"`.

---

## Phase G — Compose the App + live wiring

### Task G.1: `App` shell ties it together

**Files:** Replace the smoke `fake-twilio/web/src/ui/App.tsx`; `App.module.css`; Test `App.test.tsx` (expand)

- [ ] **Step 1: Write the failing integration-ish test** — mock the client + SSE; render `<App/>`; assert: the dev banner shows; the roster lists a seeded persona; selecting it shows the `PhonePanel` with its thread; typing in the composer + Send calls `sendAsParty`; a simulated `message.updated` SSE event flips the message's `StatusChip` to `delivered`.

- [ ] **Step 2: Implement `App`** — layout: `DevBanner` on top; a two-pane body (`RosterRail` left, `PhonePanel` right) using the `--hc-*` tokens (mirror the dashboard hub layout proportions, `--hc-hub-list-width`). Wire `useFakePhones()`; pass selected persona's thread to `PhonePanel`; render an empty-state when nothing is selected. `PhonePanel` = header (persona label + number) + a scrollable `role="log"`-labelled message list of `MessageBubble`s + `Composer`.

- [ ] **Step 3: Green + typecheck. Commit** — `git commit -m "feat(fake-phones): app shell with live roster + thread + composer"`

---

## Phase H — Serve in the stack + live smoke

### Task H.1: Build + serve the UI in the e2e session

**Files:** Modify `scripts/e2e-session.mjs`

- [ ] **Step 1:** Before `startFakeTwilio()`, build the UI once: run `npm run build -w @housingchoice/fake-twilio-web` (spawn, await success; log timing). Compute its `dist` path.
- [ ] **Step 2:** Pass `FAKE_TWILIO_UI_DIST=<abs path to fake-twilio/web/dist>` in the `startFakeTwilio()` env override so the host serves it. Log the URL: `fake-phones UI → http://localhost:8889/`.
- [ ] **Step 3:** `node --check scripts/e2e-session.mjs`. Do NOT boot the full stack here (joint step). Commit — `git commit -m "feat(e2e): build + serve the fake-phones UI from the fake-twilio host"`

### Task H.2: Playwright smoke (code; live run is the joint step)

**Files:** Create `e2e/tests/flows/fake-phones-ui.spec.ts`

- [ ] **Step 1: Write the spec** — navigate to `http://localhost:8889/` (add `FAKE_PHONES_URL ?? 'http://localhost:8889'`), assert the dev banner + roster are visible, select the seeded tenant, type a message + Send, and assert the new outbound bubble appears in the thread with a `StatusChip` that reaches `delivered` (poll). Use accessibility-first selectors (`getByRole('textbox',{name:'Message'})`, `getByRole('button',{name:'Send'})`, `getByRole('log')`). This is the interactive-UI counterpart to the control-API spec from Plan 1.
- [ ] **Step 2:** e2e typecheck clean (`npm run typecheck -w @housingchoice/e2e`). Do NOT run it live. Commit — `git commit -m "test(e2e): fake-phones UI smoke spec (code; live run deferred)"`

---

## Phase I — Final verification + docs

### Task I.1: Green sweep + RUNBOOK

- [ ] **Step 1:** `npm run test -w @housingchoice/fake-twilio` (backend additions green), `npm run test -w @housingchoice/fake-twilio-web` (UI green), both `typecheck`s clean, `npm run typecheck -w @housingchoice/e2e` clean, `node --check scripts/e2e-session.mjs`.
- [ ] **Step 2:** Add a "Fake-phones UI" subsection to the existing fake-twilio RUNBOOK section: how to open it (`http://localhost:8889/` during `e2e:session`), how to iterate on the UI standalone (`npm run dev -w @housingchoice/fake-twilio-web` on :5174, proxying to a running :8889), and that it's dev-only (served only when `FAKE_TWILIO_UI_DIST` is set; never deployed). Commit.
- [ ] **Step 3:** Report readiness for the JOINT live run (`npm run e2e:session` → open `http://localhost:8889/` → drive a few parties; plus `npm run e2e -- fake-phones-ui`).

---

## Self-review notes (for the implementer)

- **Spec §6 coverage:** roster rail grouped by role + unread + ad-hoc (F.3/F.4) ✓; phone panel with bubbles + status chips (F.1/F.2) ✓; composer with text + canned MMS + delivery-profile toggle (F.5) ✓; SSE live updates (B, E.2, G) ✓; dev banner (F.6) ✓; staff intentionally not a panel (the UI only shows party personas; staff is the real dashboard) ✓; "served by the fake-twilio host" (C, H.1) ✓.
- **Deliberate refinement to flag at review:** the UI is served as a static build from the host on :8889 (spec-faithful), with a separate Vite dev server (:5174, proxy to :8889) for UI iteration only — not a second deployed surface.
- **Security:** message bodies/labels rendered as text (no `dangerouslySetInnerHTML`); media restricted to committed same-origin canned assets; host adds CSP/`nosniff`/`X-Frame-Options` on the UI; SSE has a connection cap; engine emit is exception-isolated. (Note: this is the *mock's* UI — the real-app media XSS in `docs/KNOWN_ISSUES.md` is separate.)
- **Type parity:** the UI re-declares the engine's wire types in `web/src/api/types.ts`; if the engine types change, update both (they're in separate packages by design).
- **Reconciliation points:** exact dep versions vs `dashboard/package.json` (D.2); the `useFakeEvents` test's `EventSource` stub; the e2e UI-build timing in `e2e-session.mjs` (keep it from slowing session boot — build is cached by Vite between runs).
```
