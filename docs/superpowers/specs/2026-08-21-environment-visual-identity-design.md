# Environment visual identity - design

**Status:** draft for adversarial document review and human approval.
**Date:** 2026-08-21.
**Lane:** full feature mission.
**Branch:** `feat/environment-visual-identity`.
**Baseline:** `main` at `7ba4bb50`.

## Summary

HousingChoice production, deployed development, local development, and hermetic
test sessions currently share the same dark navy application navigation and the
same blue browser, installed-PWA, and notification artwork. The screens can be
connected to different data and messaging rails while looking identical.

This feature gives every non-production environment one Sunflower identity while
leaving the existing interface structure intact:

- Production keeps the current navy navigation and receives a blue `HC` icon.
- Deployed `dev`, local development, and hermetic E2E use Sunflower navigation
  and a yellow `HC` icon.
- The existing mobile app top bar stays white. Supported browser/PWA chrome uses
  the environment theme color, the hamburger drawer uses the environment nav
  palette, and the installed-app and notification artwork uses the environment
  icon.
- No banner, environment label, badge, wrapper, page section, or other visible
  feature is added.

The implementation is runtime-selected. HousingChoice can promote the exact same
container image from dev to prod, so a Vite build-time environment flag would be
incorrect by construction.

## Problem and evidence

The authenticated shell is `dashboard/src/app/AppFrame.tsx`. On desktop it renders
the persistent sidebar or collapsed rail. Below 768px it renders a white mobile
top bar and an off-canvas drawer. Both sidebar and drawer consume the root nav
tokens from `dashboard/src/ui/tokens.css`; there is no environment-specific token
scope today.

The existing runtime authority already exists on the backend:

- `config.appEnv` resolves from explicit `HC_ENV`, then the deployed table prefix.
- `hc-dev-` resolves to `dev`, `hc-prod-` resolves to `prod`, and other/default
  prefixes resolve to `local`.
- The same value already drives System Status and environment-qualified Twilio
  resource names.

The current browser/PWA assets are static:

- `dashboard/index.html` has blue `theme-color` and points its favicon and Apple
  touch icon at `/icons/icon-192.png`.
- `dashboard/public/manifest.webmanifest` has blue `theme_color` and the same
  static icon family.
- notification display code uses `/icons/icon-192.png`; Android's separate badge
  image stays `/icons/badge-72.png`.
- the current blue icon is a blue field with a pale rounded inset and no `HC`
  monogram.

The deploy workflow can promote a dev image into the prod ECR repository without
rebuilding it. Static build-time branding therefore cannot distinguish those two
runtime environments.

## Goals

1. Make a non-production authenticated page distinguishable from production at a
   glance without adding a new UI element.
2. Keep the entire existing production page layout and navy navigation unchanged.
3. Give deployed dev, local development, and hermetic E2E the same Sunflower nav
   treatment.
4. Apply the non-production nav treatment consistently to the desktop sidebar,
   collapsed icon rail, rail flyouts, and mobile drawer.
5. Keep the mobile hamburger/wordmark top bar white while giving supported
   browser/PWA chrome an environment-specific theme color.
6. Replace the current icon art with a centered `HC` monogram in both production
   blue and non-production yellow variants.
7. Select favicon, Apple touch, install manifest, installed-PWA, and notification
   artwork from runtime `appEnv`, including in local Vite sessions.
8. Preserve the same-image dev-to-prod promotion workflow.
9. Keep environment identity public, read-only, dependency-free, and free of
   user/contact data.
10. Prove the runtime selection, image properties, responsive shell treatment,
    and absence of new environment UI with automated and live browser checks.

## Non-goals

- No banner, environment badge, `DEV`/`LOCAL` label, tooltip, page header, or new
  wrapper element.
- No recoloring of page content, cards, forms, buttons, status chips, type dots,
  unread badges, semantic warning/success/danger colors, or the white mobile top
  bar.
- No production navigation redesign.
- No environment chooser, environment switching, query parameter, cookie, or
  per-user preference.
- No new environment value. Hermetic sessions continue to identify as `local`.
- No infrastructure, deploy, secret, SSM, CloudFront, or `.env.*` mutation.
- No new runtime or development dependency.
- No attempt to force an operating system to refresh an already-installed home
  screen icon immediately. Manifest/icon refresh timing is platform-owned; a
  refresh or reinstall may be required for an existing installation.
- No promise that the tiny operating-system notification status glyph is colored.
  Platforms may mask/tint the badge. The notification's main icon artwork is in
  scope.

## Decisions

### D1. Runtime environment authority

`config.appEnv` remains the single server authority. A public, fixed-shape
identity response exposes only the presentation decision derived from it:

```text
GET /app-identity/config.json
  -> { variant: "production", themeColor: "#1f6feb" }
  -> { variant: "non-production", themeColor: "#f4c542" }
```

The response does not expose a user, raw environment name, table prefix, contact,
secret, or infrastructure identifier. A root-level `EnvironmentIdentityProvider`
fetches it once and renders only its existing children. The provider wraps both
the public-route branch and the authenticated/login branch, so `/join`,
`/p/:unitId`, Login, and the staff shell all update the same existing
`meta[name="theme-color"]` element without making a session request. This
preserves the deliberate rule that public pages never call `/auth/me`.

The frontend trusts only the two fixed variants and their expected paired theme
colors:

```text
missing, failed, or malformed response -> production presentation fallback
variant == "production"                -> production presentation
variant == "non-production"            -> non-production presentation
```

The fallback preserves today's production presentation for initial paint, a
network failure, or a temporarily mismatched frontend/backend. The provider does
not block routing or render a loading surface. The real same-image deployment
returns the identity immediately, so deployed `dev`, local, hermetic, and future
non-prod runtimes take the non-production branch on public, login, and
authenticated pages.

The identity loader memoizes one in-flight/resolved request for the lifetime of
the document. React StrictMode's development effect replay and multiple context
consumers therefore share one network read rather than duplicating cold-shell
work. A failed or invalid read resolves to the production fallback for that page
load; a normal reload may try again.

The public app-identity routes use the same server-side rule against the always
present `config.appEnv`: exactly `prod` selects production; every other runtime
value selects non-production.

### D2. Existing-shell class, not new markup

`AppFrame` adds a CSS module class to its existing outer `.shell` element when
the environment-identity context is non-production. No element, attribute
carrying display copy, or environment label is added.

That class overrides only these existing custom properties for its descendants:

| Token | Non-production value | Purpose |
| --- | --- | --- |
| `--c-nav-bg` | `#f4c542` | Sunflower nav field |
| `--c-nav-brand` | `#292415` | HousingChoice wordmark / `HC` rail mark |
| `--c-nav-label` | `#67510e` | Group labels |
| `--c-nav-text` | `#403714` | Inactive nav text/icons |
| `--c-nav-hover-bg` | `#e8b72c` | Hover background |
| `--c-nav-active-bg` | `#dbaa1c` | Active link and account monogram |
| `--c-nav-active-text` | `#201c0d` | Active/hover text |
| `--c-nav-border` | `#d1a11b` | Nav dividers and flyout border |
| `--c-nav-focus-ring` | `#174ea6` | Opaque blue nav-only focus outline |

The root nav-focus token aliases today's focus color so production stays visually
unchanged. General tokens such as `--c-bg`, `--c-surface`, `--c-brand`,
`--c-danger`, type-dot colors, and `--c-focus-ring` are not overridden. Component
CSS explicitly applies `--c-nav-focus-ring` to every focusable element on a nav
field: the sidebar/drawer `.brand`, every `.link` (including child links), the
collapse toggle, drawer close control, and account trigger. The mobile
`.topbarBrand` and hamburger remain on the white top bar and continue to use the
general focus rule. This confines the change to existing nav chrome while
preserving semantic meaning and focus visibility.

Because the desktop sidebar, collapsed rail, collapsed Contacts child flyout,
and mobile drawer are all descendants of the same shell and consume nav tokens,
they stay in sync without parallel component branches. The mobile `.topbar`
continues consuming general surface/text tokens and remains white.

Two transient overlays intentionally remain white: the collapsed-rail hover/focus
tooltip and the account popover. They use general surface/text/border tokens today
and are not nav fields. The collapsed Contacts child flyout is a continuation of
the navigation and does consume the Sunflower nav palette. Browser proof checks
the yellow nav/Contacts flyout and the unchanged white tooltip/account popover so
a builder does not guess in either direction.

### D3. Mobile closed-page cue

The closed mobile page has no visible sidebar; the sidebar's mobile analog is the
off-canvas drawer. The always-visible environment cue comes from the browser/PWA
theme color where the platform exposes it:

- Production theme color: brand blue `#1f6feb`.
- Non-production theme color: Sunflower `#f4c542`.

The runtime manifest supplies the correct launch/install theme before
authentication. The root environment-identity provider updates the content of
the existing `meta[name="theme-color"]` element on public, login, and
authenticated pages. It adds one small public identity request and no head/body
node or visible UI. This keeps browser/PWA chrome aligned with the loaded
environment while leaving the app's white mobile top bar alone.

Browser and OS chrome rendering varies by platform. The contract is that
HousingChoice supplies the correct runtime theme values, not that every platform
colors the same physical pixels.

### D4. Runtime app-identity surface

A small unauthenticated, read-only router mounts at `/app-identity` before the
dashboard static server and SPA fallback. It exposes only fixed-shape identity
assets:

```text
GET /app-identity/manifest.webmanifest
GET /app-identity/config.json
GET /app-identity/icon-192.png
GET /app-identity/icon-512.png
GET /app-identity/icon-maskable-512.png
```

The config response contains only the fixed `variant` and exact `themeColor`
pair described in D1. It is `no-store` so a promoted image or changed backend
target cannot retain the previous runtime's decision.

Because that config read is a required first-party request on every cold page,
the performance endpoint registry classifies the exact path as `api` and adds it
to `COLD_SHELL_GETS`. It is not left as an untracked `.json` resource. The
performance registry version increments from 2 to 3 because the endpoint registry
and cold-shell request contract change; schema, workload, and interception-scope
versions remain unchanged because report shape, synthetic data workload, and
request interception do not change.

The manifest response contains the existing name, short name, description,
start/scope/display/orientation, and background color. It selects the runtime
`theme_color` and lists the three selector icon URLs above. It has manifest JSON
content type and a revalidation/no-cache posture so a release is not pinned behind
an old manifest response.

Each icon selector returns a temporary redirect with a no-store posture to one of
two variant-specific static families:

```text
production:     /icons/icon-192.png
                /icons/icon-512.png
                /icons/icon-maskable-512.png

non-production: /icons/icon-nonprod-192.png
                /icons/icon-nonprod-512.png
                /icons/icon-nonprod-maskable-512.png
```

Redirecting instead of reading files in the app router lets the normal static
owner serve the bytes in both modes: Vite serves `dashboard/public` locally, and
Express serves the built dashboard directory in deployed images. The app router
never needs a source/build asset-directory heuristic.

`/app-identity` is added to the read-only edge-exempt/reserved-prefix registry.
It needs no custom CloudFront behavior because it is GET/HEAD-only, but unmatched
paths under the prefix must return a normal 404 rather than the SPA HTML fallback.

Vite proxies `/app-identity` to the app process with the existing origin-secret
placeholder, just like the current public read surfaces. Deployed CloudFront uses
its default GET path and stamps the real origin secret. There is no auth or CSRF
state on these reads.

### D5. Icon artwork

Both environments use the same simple mark:

- A square color field with platform-appropriate rounded presentation.
- A centered, bold sans-serif `HC` monogram.
- Production uses blue `#1f6feb` with white `HC`.
- Non-production uses Sunflower `#f4c542` with charcoal `#292415` `HC`.
- Maskable artwork keeps the monogram inside the platform safe zone so circle,
  squircle, and other masks do not crop it.

The checked-in deliverables are 192x192 `any`, 512x512 `any`, and 512x512
`maskable` PNGs for each environment. A small SVG source may be kept beside the
PNGs to make the geometry/colors reviewable; generated PNGs remain the shipped
assets. Existing production filenames are replaced so old direct consumers also
receive the blue `HC` improvement.

The separate `badge-72.png` remains unchanged. Notification display changes its
main `icon` URL to `/app-identity/icon-192.png`; the badge remains the
platform-maskable monochrome cue. Both the TypeScript notification projection and
the shipped public service worker stay in sync.

### D6. Static references and build contract

`dashboard/index.html` points its manifest, favicon, and Apple touch links at the
runtime selector surface. The existing theme-color meta remains one element and
starts at the production-safe blue value; the first identity-config result
updates its content per D3 on public, login, and authenticated routes.

The old static `dashboard/public/manifest.webmanifest` is removed so it cannot
drift from the runtime manifest or bypass environment selection. Docker build
assertions change from requiring that static manifest to requiring the service
worker plus both complete icon families. Static smoke coverage proves the runtime
manifest route instead. The PWA explanation in `.dockerignore` is updated with
the new runtime-manifest/static-icon ownership so it does not keep directing a
future maintainer toward the removed file.

The dynamic route and all referenced static images ship in the same container
image. Promotion changes only runtime config, so dev returns yellow and prod
returns blue from identical bytes.

## Data and request flow

### Page identity and authenticated shell

```text
App boot
  -> GET /app-identity/config.json
  -> server classifies config.appEnv and returns a fixed presentation variant
  -> EnvironmentIdentityProvider updates the existing theme-color meta
  -> public and Login pages stop here without a session request
  -> authenticated flow independently performs existing GET /auth/me
  -> AppFrame reads the identity context
  -> existing shell gets zero or one CSS module class
  -> existing nav descendants inherit navy or Sunflower tokens
```

The identity request is public, contains no principal data, and does not change
the existing authentication flow.

### Browser/PWA identity

```text
Browser reads /app-identity/manifest.webmanifest
  -> server selects theme from config.appEnv
  -> manifest names /app-identity/icon-*.png
  -> selector redirects to blue or yellow static PNG
  -> Vite (local) or Express static (deployed) serves bytes

Notification display
  -> service worker requests /app-identity/icon-192.png
  -> same runtime selector chooses blue or yellow main artwork
```

There is no user, role, contact, message, or persistence dependency in this flow.

## Error and cache behavior

- `/auth/me` retains its current request, response, and 401 behavior. Public pages
  remain outside `AuthProvider` and do not gain a session fetch.
- A missing or invalid identity response falls back to current production/navy
  CSS and blue meta color; it never throws or blocks navigation.
- The server always has `config.appEnv`. Exactly `prod` is blue; any other value
  is yellow.
- Unknown `/app-identity/*` paths 404 and never return `index.html`.
- Icon selector redirects are fixed local paths, never caller-controlled input,
  filesystem input, or external URLs.
- Manifest/icon identity failures do not affect API or page data. Standard app
  error handling applies; there is no fallback to embedded contact or secret
  data.
- Selector responses are not stored across runtime decisions. Destination static
  files use distinct production/non-production URLs, avoiding a same-URL
  cross-variant cache collision.
- Existing installed-PWA icon refresh behavior is browser/OS controlled. The
  feature guarantees correct responses for new fetches and installs.

## Accessibility and responsive behavior

- The change adds no focusable element, accessible name, live region, or reading
  order entry.
- Existing link text and SVG nav icons remain the accessible content.
- Charcoal-on-Sunflower combinations must meet WCAG AA for normal nav text; the
  implementation verifies the exact approved pairs rather than relying on visual
  inspection alone.
- Non-production nav focus uses opaque blue `#174ea6`, which remains distinct
  from the Sunflower field and the darker active fill. It is not replaced with a
  low-contrast yellow-on-yellow ring. Production keeps its current focus color.
- The locked minimum ratios are: group label on Sunflower at 4.68:1, inactive
  text on Sunflower at 7.28:1, active text on active fill at 7.93:1, and the
  nav-only focus ring at 4.82:1 against Sunflower and 3.65:1 against active fill.
- Active, hover, focus, unread badge, account popover, collapsed tooltip, and
  Contacts flyout states remain operable against or above the Sunflower nav.
- Desktop expanded, desktop collapsed, mobile drawer open, and mobile drawer
  closed are all explicit live-QA states.
- The white mobile top bar remains byte-for-byte structurally identical and
  visually white. Only supported outer browser/PWA chrome changes theme color.

## Testing and verification

### Backend unit/route coverage

- Identity config selects the exact fixed variant/theme pair for `prod`, `dev`,
  `local`, and an arbitrary future non-prod name without reading a repository.
  Both variant branches assert an `application/json` content type and exact
  `Cache-Control: no-store` behavior.
- `/auth/me` retains its existing authenticated and anonymous contracts.
- Runtime identity manifests select exact blue/yellow theme colors for `prod`,
  `dev`, `local`, and an arbitrary future non-prod name.
- All selector icon routes choose the correct destination family and carry the
  intended redirect/cache/content behavior.
- Unknown identity routes return 404 rather than SPA HTML.
- CloudFront/reserved-prefix registry coverage classifies `/app-identity` as
  read-only and keeps the default behavior safe.
- Static/deployed-route smoke coverage proves that the config response preserves
  its JSON content type and `no-store` header through the mounted app surface.

### Dashboard unit coverage

- Production identity leaves the shell on existing production classes/tokens.
- Non-production identity applies the non-production class to the existing shell.
- The provider updates the one existing theme meta on public, Login, and
  authenticated routes; a failed or malformed identity response takes the
  production fallback without blocking route rendering.
- A provider mounted under React StrictMode performs exactly one identity-config
  network request and resolves all consumers from the shared result.
- Public routes still do not mount `AuthProvider` or request `/auth/me`.
- No `DEV`, `LOCAL`, `environment`, or other new visible identity copy renders.
- Existing AppFrame navigation, account, collapse, drawer, focus, push reconcile,
  and sign-out tests remain green.
- A focused stylesheet contract test reads `AppFrame.module.css` as source and
  fails unless `.brand`, every `.link`, the collapse control, drawer-close
  control, and account trigger explicitly consume `--c-nav-focus-ring`. This is
  required because dashboard Vitest runs with CSS disabled and render tests alone
  cannot prove the reader wiring.
- Notification projection expects the runtime main-icon selector and unchanged
  badge path.
- `dashboard/src/sw/mirror.test.ts` reads the shipped
  `dashboard/public/sw.js` and asserts that it uses the same runtime main-icon
  selector and unchanged badge path as the TypeScript projection. A one-sided
  source update must fail.

### Asset and build coverage

- All six PNGs exist at the expected dimensions and color modes.
- Pixel/metadata checks prove the blue and Sunflower fields, contrasting `HC`
  foreground, non-blank monograms, and maskable safe-zone geometry.
- The production and non-production bytes are not identical.
- Built `index.html` references only the runtime manifest/icon selectors.
- Docker build guards require the service worker and both complete icon families.
- Static smoke tests prove the app serves the runtime identity surface alongside
  the built dashboard.
- A targeted Docker build-stage run must pass from the worktree so `.dockerignore`,
  Docker `COPY`, Vite public-directory copying, and the in-image asset assertions
  are exercised together. A local Vite build alone is not sufficient proof.

### Performance contract coverage

- `/app-identity/config.json` is a declared endpoint template and sanitizes as a
  required first-party `api` request, not `other` or `unmatched_api`.
- Every cold route contract contains exactly one required identity-config read;
  warm route contracts do not add one unless the destination itself initiates it.
- Registry/version tests expect performance registry version 3 and continue to
  expect the existing schema, workload, and interception-scope versions.
- Existing endpoint-registry closure, exact cold/warm route-shape, collection,
  self-QA, and report tests remain green, so a missing, duplicate, or undeclared
  identity boot read cannot disappear from the performance alarm.

### Playwright and live QA

A focused accessibility-first E2E spec on the hermetic `local` environment proves:

1. The existing desktop sidebar has computed background `rgb(244, 197, 66)`.
2. The expanded and collapsed desktop nav remain usable by accessible link name.
3. At mobile width the top bar remains white.
4. Opening the hamburger reveals a Sunflower drawer and all links remain usable.
5. The existing theme-color meta becomes `#f4c542` after authentication.
6. The runtime manifest reports Sunflower and its icon selector returns the
   non-production asset.
7. On Login and each public route, the public identity response makes the same
   existing meta Sunflower without requesting `/auth/me` or rendering a label.
8. Keyboard focus on the desktop brand, an ordinary link, a child link, collapse
   control, and account trigger, plus the mobile drawer-close control, computes
   the locked opaque outline color `rgb(23, 78, 166)`.
9. No visible environment label/banner exists.

The feature-mission completion gates remain the bare commands from the isolated
worktree after the one final sync with current `main`:

```text
npm run typecheck
npm test
npm run e2e
```

Independent handback review also includes a live browser pass at desktop expanded,
desktop collapsed, and mobile drawer states. Production selection is proven by
unit/route coverage because project rules forbid using a real production UI as a
test target.

## Expected implementation surfaces

Backend and route contract:

- `app/src/routes/appIdentity.ts` (new)
- `app/src/app.ts`
- app-identity, reserved-prefix, and static-smoke tests under `app/test/`

Dashboard runtime and shell:

- `dashboard/src/App.tsx`
- a focused environment-identity provider/context and tests
- `dashboard/src/app/AppFrame.tsx`
- `dashboard/src/app/AppFrame.module.css`
- `dashboard/src/app/AppFrame.test.tsx`
- a focused AppFrame stylesheet contract test

PWA/static identity:

- `dashboard/index.html`
- `dashboard/vite.config.ts`
- `dashboard/src/sw/display.ts`, `display.test.ts`, and `mirror.test.ts`
- `dashboard/public/sw.js`
- `dashboard/public/manifest.webmanifest` (remove)
- `dashboard/public/icons/*` blue/yellow icon families and optional SVG sources
- `Dockerfile`
- `.dockerignore`

Performance request contract:

- `e2e/performance/templates.ts` and focused tests
- `e2e/performance/routes.ts` and focused tests
- `e2e/performance/types.ts` plus version/report compatibility tests

End-to-end proof:

- a focused spec under `e2e/tests/dashboard-next/`

The implementation plan may refine exact test filenames and helper placement, but
it must not widen the visible UI or move environment authority away from
`config.appEnv`.

## Alternatives considered

### Separate Vite builds per environment

Rejected. Production promotion deliberately copies the exact dev image digest.
Build-time color selection would either make prod yellow or force a rebuild that
breaks the promotion invariant.

### Put environment identity only on `/auth/me`

Rejected. It would avoid one request in the authenticated shell, but the public
`/join` and `/p/:unitId` routes intentionally never mount auth or perform a
session fetch. A small public identity response is the one mechanism that covers
public, Login, and authenticated routes without weakening that boundary.

### Reuse admin-only `/api/system/flags`

Rejected. The nav is visible to admin and VA users, while System Status flags are
admin-only and contain unrelated operational data. Broadening that endpoint would
mix concerns and still add a shell request.

### Inject or rewrite built HTML per request

Rejected. Rewriting static `index.html` complicates CSP/static caching and SPA
fallback behavior. The runtime manifest plus the existing meta node updated from
the public identity response provides the approved identity without a server-side
HTML templating path.

### Banner, label, or colored mobile app top bar

Rejected by product decision. The visible interface must remain structurally the
same; only existing nav colors and platform identity surfaces change. The app's
mobile top bar stays white.

## Rollout and operations

- No dependency install, data migration, config key, secret, Terraform change, or
  other infrastructure action is expected.
- A normal app deployment ships both static variants and the runtime selector.
- The same image can be promoted to prod unchanged.
- Existing installed PWA icons may refresh on the platform's schedule. If a device
  retains the old icon, refresh/reinstall is a user-device remedy, not an
  infrastructure change.
- Merge, deploy, and any device reinstall remain human-owned.

## Acceptance criteria

The feature is complete when all of the following are true:

1. Production navigation remains visually unchanged and the production icon is a
   blue `HC` mark.
2. Dev, local, hermetic, and any explicitly named non-prod runtime use Sunflower
   nav tokens and yellow `HC` identity assets.
3. No new environment UI element or visible copy exists.
4. The white mobile app top bar and all page content colors remain unchanged.
5. Supported browser/PWA chrome receives the correct runtime theme color.
6. Favicon, Apple touch icon, install manifest icons, installed-PWA artwork, and
   notification main icon use runtime selection.
7. Desktop sidebar, collapsed rail, collapsed Contacts flyout, and mobile drawer
   share the environment nav treatment; the approved tooltip/account overlays
   and mobile top bar remain white.
8. `/app-identity` is public/read-only, Vite-proxied locally, reserved from SPA
   fallback, and free of user/contact data.
9. One identical container image digest can serve yellow dev and blue prod based
   only on runtime config.
10. Targeted unit/build/E2E proof, live responsive QA, independent review, and all
    three bare feature gates pass on the final commit.
