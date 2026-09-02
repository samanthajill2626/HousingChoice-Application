# Clickable Communications Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: v1 - DRAFT for adversarial review
Date: 2026-09-02
Branch: `feat/comms-clickable-links`
Worktree: `W:\\tmp\\comms-clickable-links`
Base: `main` at `b45e6fdca1ca9fc986df02e9d7b768c6aad1de19`
Baseline: bare `npm test` exited 0 before implementation

**Goal:** Render safe, clickable HTTP(S) links in every approved dashboard
communications body while preserving plain-text security, message behavior, and
email-snippet presentation.

**Architecture:** A new design-system component owns one module-scoped
`linkify-it` parser, converts untrusted source text into ordered text/link tokens,
normalizes inferred destinations to HTTPS, and passes every destination through
`safeHttpUrl`. The shared Timeline adopts it for SMS/MMS/group bodies and
plain-text email, while `UnmatchedRow` adopts it only for opened full email detail.

**Tech Stack:** React 19, TypeScript ESM, CSS Modules, `linkify-it` 6.1.0,
`tlds` 1.261.0, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md`

## Global Constraints

- Add `linkify-it` 6.1.0 and `tlds` 1.261.0 only to
  `dashboard/package.json` runtime dependencies. Resolve exact versions in the root
  `package-lock.json`; never import the older transitive `linkify-it` 5.0.2 copy.
- Configure the v6 named `LinkifyIt` export with `fuzzyLink: true`,
  `fuzzyEmail: false`, `fuzzyIP: false`, `urlAuth: false`, and the full `tlds`
  list. Disable `ftp:` and `mailto:` schemas explicitly.
- Keep communications bodies as React text nodes and anchors. Never generate HTML
  strings or use `dangerouslySetInnerHTML`.
- Preserve explicit HTTP and HTTPS. Normalize `//` with `https:` and fuzzy `www`
  or bare-domain matches with `https://`. Pass the result through `safeHttpUrl`;
  rejection means the original matched source stays text.
- Bare `localhost` and other bare single-label hosts remain text. Explicit
  `http://localhost`, `https://localhost`, and `//localhost` remain eligible.
- Render anchors with `target="_blank"`, `rel="noopener noreferrer"`, and click
  propagation stopped. Keep visible source text unchanged.
- Preserve Timeline email snippets as
  `bodyText.slice(0, 140).trimEnd() + '...'` when truncated, but compute a crossing
  link's `href` from the complete match in the complete source.
- Linkify expanded `UnmatchedRow` detail only. Do not put anchors in its collapsed
  row-toggle button or any other preview.
- No backend, provider, worker, persistence, API, message-catalog, infrastructure,
  feature-flag, deployment, production, or real-environment changes.
- New or touched lines are ASCII-only. Before every commit read bare `git status`
  and verify no `MERGE_HEAD`; stage only the explicit paths named by that task.
- Every agent-authored commit includes
  `Co-Authored-By: OpenAI GPT-5.6 Sol <codex@openai.com>`.
- Do not run a full e2e suite while an interactive e2e session is live in this
  worktree. Use only the root `npm run e2e` entry point for Playwright.

## File Structure

- Create `dashboard/src/ui/LinkifiedText.tsx`: parser configuration, safe token
  construction, the exported renderer, and its public types.
- Create `dashboard/src/ui/LinkifiedText.module.css`: anchor, wrapping, focus, and
  visited-state presentation.
- Create `dashboard/src/ui/LinkifiedText.test.tsx`: parser, normalization,
  clipping, escaping, and anchor-attribute contract.
- Modify `dashboard/src/ui/index.ts`: export the component and token helper/types.
- Modify `dashboard/src/routes/contact/Timeline.tsx`: replace the three approved
  plain-text body render sites and preserve the email snippet algorithm.
- Create `dashboard/src/routes/contact/Timeline.linkified.test.tsx`: focused shared
  Timeline integration for direction, MMS, group attribution, email, and bubbling.
- Modify `dashboard/src/routes/email/UnmatchedRow.tsx`: linkify only loaded detail
  text.
- Create `dashboard/src/routes/email/UnmatchedRow.test.tsx`: detail linkification
  and non-interactive preview regression coverage.
- Modify `dashboard/package.json` and `package-lock.json`: direct dependency graph.
- Create `e2e/tests/dashboard-next/comms-clickable-links.spec.ts`: hermetic real
  dashboard and API proof.
- Write implementation/review/handback records under
  `docs/superpowers/reviews/2026-09-02-comms-clickable-links/` as the mission
  produces them; `.superpowers/` contains only ignored run state and logs.

---

### Task 1 (S1): Direct dependencies and the shared safe text tokenizer

**Files:**

- Modify: `dashboard/package.json`
- Modify: `package-lock.json`
- Create: `dashboard/src/ui/LinkifiedText.tsx`
- Create: `dashboard/src/ui/LinkifiedText.module.css`
- Create: `dashboard/src/ui/LinkifiedText.test.tsx`
- Modify: `dashboard/src/ui/index.ts`

**Interfaces:**

- Consumes: `safeHttpUrl(url: string | null | undefined): string | null` from
  `dashboard/src/lib/safeUrl.ts`; `LinkifyIt` and its inferred match type from
  `linkify-it`; the default TLD array from `tlds`.
- Produces:

```ts
export type LinkifiedToken =
  | { kind: 'text'; start: number; end: number; text: string }
  | { kind: 'link'; start: number; end: number; text: string; href: string };

export interface LinkifiedTextProps {
  text: string;
  displayEnd?: number;
  suffix?: string;
}

export function tokenizeLinkifiedText(text: string, displayEnd?: number): LinkifiedToken[];
export function LinkifiedText(props: LinkifiedTextProps): React.JSX.Element;
```

- The `displayEnd` offset clips visible text only. A link token crossing that offset
  retains an `href` normalized from the complete parser match.

- [ ] **Step 1: Install only the approved direct runtime dependencies**

Run from the repository root:

```powershell
npm install --save-exact --workspace @housingchoice/dashboard linkify-it@6.1.0 tlds@1.261.0
```

Expected: `dashboard/package.json` contains exact `6.1.0` and `1.261.0` dependency
values; `package-lock.json` resolves `linkify-it` 6.1.0 for the dashboard and
`uc.micro` 3.x beneath it. The mailparser-owned 5.0.2 resolution may remain as a
separate transitive node.

- [ ] **Step 2: Prove the dependency boundary before importing it**

Run:

```powershell
npm ls --workspace @housingchoice/dashboard linkify-it tlds uc.micro
node -e "for (const n of ['linkify-it','tlds','uc.micro']) { const p=require('./node_modules/'+n+'/package.json'); const lifecycle=['preinstall','install','postinstall'].filter(k=>p.scripts?.[k]); console.log(n,p.version,p.license,lifecycle.join(',')||'no-install-scripts',p.os||'all-os',p.cpu||'all-cpu',p.optionalDependencies||'no-optional-deps') }"
```

Expected: dashboard resolves `linkify-it@6.1.0` and `tlds@1.261.0`; all three
runtime packages report MIT, no install lifecycle scripts, no OS/CPU restriction,
and no optional native dependency.

Run the target-architecture package smoke independently of the Windows tree:

```powershell
docker run --rm --platform linux/arm64 node:24-slim sh -lc "mkdir /probe && cd /probe && npm init -y >/dev/null && npm install --ignore-scripts --save-exact linkify-it@6.1.0 tlds@1.261.0 >/dev/null && node --input-type=module -e \"import { LinkifyIt } from 'linkify-it'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const tlds=require('tlds'); const parser=new LinkifyIt({ fuzzyLink:true, fuzzyEmail:false, fuzzyIP:false, urlAuth:false, tlds }); if (!parser.test('example.com/path')) process.exit(1); console.log('linux-arm64-linkifier-ok')\""
```

Expected: `linux-arm64-linkifier-ok`. This probe may download packages but writes
only inside the disposable container.

- [ ] **Step 3: Write the failing tokenizer and renderer tests**

Create `dashboard/src/ui/LinkifiedText.test.tsx`. Use direct token assertions for
normalization and Testing Library role assertions for rendering. The test file must
include these concrete cases:

```ts
const linkTokens = (text: string, displayEnd?: number) =>
  tokenizeLinkifiedText(text, displayEnd).filter(
    (token): token is Extract<LinkifiedToken, { kind: 'link' }> => token.kind === 'link',
  );

it.each([
  ['https://example.com/a?x=1#top', 'https://example.com/a?x=1#top'],
  ['http://example.com/a', 'http://example.com/a'],
  ['//example.com/a', 'https://example.com/a'],
  ['www.example.com/a', 'https://www.example.com/a'],
  ['example.com:8443/a?x=1#top', 'https://example.com:8443/a?x=1#top'],
])('normalizes %s to %s', (source, href) => {
  expect(linkTokens(source)).toEqual([
    expect.objectContaining({ kind: 'link', text: source, href }),
  ]);
});

it('keeps the complete href when the display boundary cuts through a URL', () => {
  const prefix = 'x'.repeat(126);
  const url = 'example.com/a/complete/path?unit=2#photos';
  const text = `${prefix}${url} after`;
  expect(linkTokens(text, 140)).toEqual([
    expect.objectContaining({
      text: text.slice(126, 140),
      href: 'https://example.com/a/complete/path?unit=2#photos',
    }),
  ]);
});
```

Also assert, with explicit expected token/href arrays:

- two links in one string retain their order and repeated identical URLs retain
  distinct offsets;
- a trailing period/comma and balanced parentheses are excluded according to the
  parser match;
- `housing.museum/path` and an international domain assembled with `\u` escapes
  are recognized through the full TLD list;
- bare `localhost`, `server`, `192.0.2.1`, `renter@example.com`, and
  `+1-555-010-0001` produce no link tokens;
- `http://localhost:5174/a`, `https://localhost/a`, and `//localhost/a` do produce
  safe link tokens;
- unsupported schemes never appear in `href`; lock the selected parser behavior
  for `javascript:example.com`, `mailto:renter@example.com`, `ftp://example.com`,
  and the independent `example.com` match after the comma in
  `data:text/html,example.com`;
- rendering `<img src=x onerror=alert(1)> example.com` creates no `img`, preserves
  that literal text, and creates exactly one safe anchor;
- rendered anchors have the original accessible name, normalized `href`,
  `target="_blank"`, and `rel="noopener noreferrer"`.

- [ ] **Step 4: Run the new test and verify the red state**

Run:

```powershell
npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx
```

Expected: FAIL because `LinkifiedText.js` and its exports do not exist. A failure
caused by package resolution is not the intended red state; correct the dependency
installation first.

- [ ] **Step 5: Implement the module-scoped parser and token renderer**

Create `dashboard/src/ui/LinkifiedText.tsx` with this structure and behavior:

```tsx
import { LinkifyIt } from 'linkify-it';
import tlds from 'tlds';
import { safeHttpUrl } from '../lib/safeUrl.js';
import styles from './LinkifiedText.module.css';

export type LinkifiedToken =
  | { kind: 'text'; start: number; end: number; text: string }
  | { kind: 'link'; start: number; end: number; text: string; href: string };

export interface LinkifiedTextProps {
  text: string;
  displayEnd?: number;
  suffix?: string;
}

const parser = new LinkifyIt({
  fuzzyLink: true,
  fuzzyEmail: false,
  fuzzyIP: false,
  urlAuth: false,
  tlds,
});
parser.add('ftp:', null).add('mailto:', null);

type LinkMatch = NonNullable<ReturnType<LinkifyIt['match']>>[number];

function normalizedHref(match: LinkMatch): string | null {
  const candidate =
    match.schema === ''
      ? `https://${match.raw}`
      : match.schema === '//'
        ? `https:${match.raw}`
        : match.url;
  return safeHttpUrl(candidate);
}

export function tokenizeLinkifiedText(text: string, displayEnd?: number): LinkifiedToken[] {
  const visibleEnd = Math.max(
    0,
    Math.min(text.length, Math.trunc(displayEnd ?? text.length)),
  );
  const tokens: LinkifiedToken[] = [];
  let cursor = 0;

  for (const match of parser.match(text) ?? []) {
    if (match.index >= visibleEnd) break;
    if (cursor < match.index) {
      tokens.push({
        kind: 'text',
        start: cursor,
        end: match.index,
        text: text.slice(cursor, match.index),
      });
    }

    const end = Math.min(match.lastIndex, visibleEnd);
    const href = normalizedHref(match);
    const visible = text.slice(match.index, end);
    tokens.push(
      href === null
        ? { kind: 'text', start: match.index, end, text: visible }
        : { kind: 'link', start: match.index, end, text: visible, href },
    );
    cursor = end;
  }

  if (cursor < visibleEnd) {
    tokens.push({ kind: 'text', start: cursor, end: visibleEnd, text: text.slice(cursor, visibleEnd) });
  }
  return tokens;
}

export function LinkifiedText({ text, displayEnd, suffix }: LinkifiedTextProps): React.JSX.Element {
  const tokens = tokenizeLinkifiedText(text, displayEnd);
  return (
    <>
      {tokens.map((token) =>
        token.kind === 'text' ? (
          token.text
        ) : (
          <a
            key={`${token.start}-${token.end}`}
            className={styles.link}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {token.text}
          </a>
        ),
      )}
      {suffix}
    </>
  );
}
```

During implementation, give text tokens stable keyed fragments if React reports a
missing-key warning; do not wrap all output in a new visible DOM element. Ensure an
empty string or `displayEnd={0}` returns no tokens and does not reintroduce hidden
text after the loop.

Create `dashboard/src/ui/LinkifiedText.module.css`:

```css
.link {
  color: inherit;
  overflow-wrap: anywhere;
  text-decoration: underline;
  text-decoration-thickness: from-font;
  text-underline-offset: 0.12em;
}

.link:visited {
  color: inherit;
}

.link:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
  border-radius: 2px;
}
```

Export `LinkifiedText`, `tokenizeLinkifiedText`, `LinkifiedTextProps`, and
`LinkifiedToken` from `dashboard/src/ui/index.ts`.

- [ ] **Step 6: Run focused proof and the production dashboard build**

Run as separate bare commands:

```powershell
npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx
npm run typecheck --workspace @housingchoice/dashboard
npm run build --workspace @housingchoice/dashboard
```

Expected: all exit 0. The build is the browser-bundling proof for the package's ESM
entry and the `tlds` data import.

- [ ] **Step 7: Commit S1**

Run bare `git status`, verify `git rev-parse --git-path MERGE_HEAD` does not exist,
then stage only:

```powershell
git add -- dashboard/package.json package-lock.json dashboard/src/ui/LinkifiedText.tsx dashboard/src/ui/LinkifiedText.module.css dashboard/src/ui/LinkifiedText.test.tsx dashboard/src/ui/index.ts
git commit -m "feat(dashboard): add safe communications linkifier" -m "Co-Authored-By: OpenAI GPT-5.6 Sol <codex@openai.com>"
```

---

### Task 2 (S2): Adopt linkification across the shared Timeline

**Files:**

- Modify: `dashboard/src/routes/contact/Timeline.tsx`
- Create: `dashboard/src/routes/contact/Timeline.linkified.test.tsx`

**Interfaces:**

- Consumes: `LinkifiedText` from `dashboard/src/ui/index.ts`.
- Produces: no new public API. The existing `Timeline` renders approved message and
  email body text through the shared component for every current caller:
  `ContactCommsPane`, `PlacementConversation`, `TourConversation`,
  `ConversationDetail`, and `GroupTextView`.

- [ ] **Step 1: Write focused failing Timeline tests**

Create `Timeline.linkified.test.tsx` with the same `MemoryRouter` and `Timeline`
render helper used in `Timeline.email.test.tsx`. Define ordinary inbound/outbound
messages from these exact fields:

```ts
const message = (
  direction: 'inbound' | 'outbound',
  type: 'sms' | 'mms' = 'sms',
): TimelineItem => ({
  kind: 'message',
  id: `${direction}-${type}`,
  at: '2026-09-02T12:00:00.000Z',
  conversationId: 'conv-1',
  tsMsgId: `${direction}-${type}`,
  direction,
  author: direction === 'inbound' ? 'tenant' : 'teammate',
  type,
  delivery_status: 'delivered',
  body: 'Open https://example.com/explicit and example.com/bare/path.',
  ...(direction === 'inbound' ? { fromPhone: '+15550100001' } : { toPhone: '+15550100001' }),
  ...(type === 'mms'
    ? { media_attachments: [{ s3Key: 'attachment', contentType: 'application/pdf' }] }
    : {}),
});
```

Assert the following observable behavior:

- an `it.each` over inbound/outbound and SMS/MMS finds both anchors and their exact
  normalized `href` values;
- the MMS still renders its attachment independently;
- a message with `relay_sender_key: 'team'` still shows `Team` beside its linkified
  body;
- clicking the bare-domain anchor leaves the nearest bubble without its generated
  `revealed` class, while clicking the body outside the anchor adds that class;
- all links carry `_blank` and `noopener noreferrer`.

Add email cases with this boundary fixture:

```ts
const prefix = 'x'.repeat(126);
const completeUrl = 'example.com/a/complete/path?unit=2#photos';
const body = `${prefix}${completeUrl} after`;
```

Assert the collapsed link name equals `body.slice(126, 140)`, its `href` is the
complete normalized URL, and the collapsed snippet's full `textContent` equals
`${body.slice(0, 140).trimEnd()}...`. Open `View full email` and assert its scoped
body contains the full-label link with the same destination. Add a second fixture
whose first 140 characters end in two spaces and assert there is no whitespace
between the final visible character and `...`.

- [ ] **Step 2: Run the Timeline test and verify the red state**

Run:

```powershell
npm test --workspace @housingchoice/dashboard -- src/routes/contact/Timeline.linkified.test.tsx
```

Expected: FAIL because Timeline still renders the body and snippet as raw text and
has no anchors.

- [ ] **Step 3: Replace only the approved Timeline text sites**

Import `LinkifiedText` beside `Spinner` from `../../ui/index.js`.

Replace the `MessageBubble` body expression with:

```tsx
{msg.body ? (
  <div className={styles.body}>
    <LinkifiedText text={msg.body} />
  </div>
) : null}
```

Replace the current prebuilt `snippet` string with offsets that preserve the
existing trim rule:

```ts
const truncated = bodyText.length > EMAIL_SNIPPET_CHARS;
const snippetEnd = truncated
  ? bodyText.slice(0, EMAIL_SNIPPET_CHARS).trimEnd().length
  : bodyText.length;
```

Replace the collapsed snippet and expanded body expressions with:

```tsx
{snippetEnd > 0 ? (
  <div className={styles.emailSnippet}>
    <LinkifiedText text={bodyText} displayEnd={snippetEnd} suffix={truncated ? '...' : undefined} />
  </div>
) : null}
```

```tsx
{bodyText ? (
  <p className={styles.emailBody}>
    <LinkifiedText text={bodyText} />
  </p>
) : null}
```

Do not change `EmailHtmlFrame`, subject/address/cc fields, attachment labels,
scheduled cards, transcripts, composers, or Timeline callers.

- [ ] **Step 4: Run focused Timeline and neighboring regression tests**

Run as separate commands:

```powershell
npm test --workspace @housingchoice/dashboard -- src/routes/contact/Timeline.linkified.test.tsx
npm test --workspace @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.delivery.test.tsx
npm run typecheck --workspace @housingchoice/dashboard
```

Expected: all exit 0, with no React key warning from `LinkifiedText`.

- [ ] **Step 5: Commit S2**

Read bare status and verify no merge is in progress, then stage only:

```powershell
git add -- dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.linkified.test.tsx
git commit -m "feat(dashboard): linkify shared Timeline bodies" -m "Co-Authored-By: OpenAI GPT-5.6 Sol <codex@openai.com>"
```

---

### Task 3 (S3): Adopt linkification in opened unmatched-email detail

**Files:**

- Modify: `dashboard/src/routes/email/UnmatchedRow.tsx`
- Create: `dashboard/src/routes/email/UnmatchedRow.test.tsx`

**Interfaces:**

- Consumes: `LinkifiedText` from the design-system barrel.
- Produces: no new public API. Only `detail.text` changes presentation; `row.snippet`
  remains raw text inside the existing row-toggle button.

- [ ] **Step 1: Write the failing UnmatchedRow tests**

Mock `getUnmatchedEmailDetail` while retaining the real API types. Render one
`UnmatchedRow` with no-op callbacks and this row/detail pair:

```ts
const row: UnmatchedEmailRow = {
  unmatchedId: 'mail-1',
  status: 'unmatched',
  from: { address: 'sender@example.com' },
  subject: 'Property details',
  snippet: 'Collapsed example.com/preview stays plain',
  attachments_meta: [],
  received_at: '2026-09-02T12:00:00.000Z',
  read: false,
};

const detail: UnmatchedEmailItem = {
  ...row,
  text: 'Open https://example.com/full and example.com/bare/path.',
};
```

Before opening, assert the row button has the snippet text and contains no anchor.
Click the row button, await the mocked detail, then assert the two anchors have the
expected HTTP(S) destinations, `_blank`, and `noopener noreferrer`. Assert the
literal trailing period remains outside the bare-domain `href`. Also assert the row
button is still the only interactive element in the collapsed header and that
opening detail still calls `onMarkRead('mail-1')` once.

- [ ] **Step 2: Run the test and verify the red state**

Run:

```powershell
npm test --workspace @housingchoice/dashboard -- src/routes/email/UnmatchedRow.test.tsx
```

Expected: FAIL because the loaded full body contains no anchors.

- [ ] **Step 3: Linkify only the expanded detail body**

Add `LinkifiedText` to the existing design-system import and replace only the
expanded body:

```tsx
<div className={styles.body}>
  <LinkifiedText text={detail.text} />
</div>
```

Leave this collapsed line unchanged:

```tsx
{row.snippet.length > 0 ? <span className={styles.snippet}>{row.snippet}</span> : null}
```

Do not change fetching, read-state mutation, actions, sanitized HTML, or attachment
presentation.

- [ ] **Step 4: Run focused and neighboring tests**

Run separately:

```powershell
npm test --workspace @housingchoice/dashboard -- src/routes/email/UnmatchedRow.test.tsx
npm test --workspace @housingchoice/dashboard -- src/routes/email/useUnmatchedEmail.test.tsx src/routes/contact/EmailHtmlFrame.test.tsx
npm run typecheck --workspace @housingchoice/dashboard
```

Expected: all exit 0.

- [ ] **Step 5: Commit S3**

Read bare status and verify no merge is in progress, then stage only:

```powershell
git add -- dashboard/src/routes/email/UnmatchedRow.tsx dashboard/src/routes/email/UnmatchedRow.test.tsx
git commit -m "feat(dashboard): linkify opened unmatched email" -m "Co-Authored-By: OpenAI GPT-5.6 Sol <codex@openai.com>"
```

---

### Task 4 (E1): Prove real dashboard behavior in the hermetic browser stack

**Files:**

- Create: `e2e/tests/dashboard-next/comms-clickable-links.spec.ts`

**Interfaces:**

- Consumes: dev-only `POST /__dev/reseed`,
  `POST /__dev/extraction/message-fixture`, the seeded direct conversation
  `conv-0001`, contact `contact-tenant-0001`, and the shared Timeline route.
- Produces: one isolated Playwright acceptance scenario with no public Internet
  dependency and no production seam.

- [ ] **Step 1: Write the failing browser acceptance spec**

Create the spec with this concrete flow:

```ts
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

async function plantMessage(request: APIRequestContext, body: string): Promise<void> {
  const response = await request.post(`${NEXT}/__dev/extraction/message-fixture`, {
    data: {
      conversationId: 'conv-0001',
      body,
      createdAt: new Date().toISOString(),
      direction: 'inbound',
      transport: { mode: 'legacy' },
    },
  });
  expect(response.ok(), `fixture failed: ${response.status()} ${await response.text()}`).toBeTruthy();
}

test('communications body links are safe, complete, and do not toggle bubble metadata', async ({
  context,
  page,
  request,
}) => {
  const reseed = await request.post(`${NEXT}/__dev/reseed`);
  expect(reseed.ok(), `reseed failed: ${reseed.status()} ${await reseed.text()}`).toBeTruthy();

  const explicitText = 'https://example.com/explicit?x=1#top';
  const bareText = 'example.com/bare/path?unit=2#photos';
  const body = `Open ${explicitText}, then (${bareText}).`;
  await plantMessage(request, body);

  await context.route('https://example.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Hermetic target</title>' });
  });
  await devLogin(page);
  await page.goto(`${NEXT}/contacts/contact-tenant-0001`);

  const explicit = page.getByRole('link', { name: explicitText, exact: true });
  const bare = page.getByRole('link', { name: bareText, exact: true });
  await expect(explicit).toHaveAttribute('href', explicitText);
  await expect(bare).toHaveAttribute('href', `https://${bareText}`);
  await expect(explicit).toHaveAttribute('target', '_blank');
  await expect(bare).toHaveAttribute('rel', 'noopener noreferrer');

  const bubble = explicit.locator('xpath=ancestor::*[contains(@class, "bubble")][1]');
  await expect(bubble).not.toHaveClass(/revealed/);
  const [popup] = await Promise.all([page.waitForEvent('popup'), explicit.click()]);
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(explicitText);
  await popup.close();
  await expect(page).toHaveURL(/\/contacts\/contact-tenant-0001$/);
  await expect(bubble).not.toHaveClass(/revealed/);
});
```

If the fixture route requires the full seed profile in the current live code, use
`POST /__dev/reseed?profile=full` and restore the lean profile in `afterAll`, matching
`message-transport-fidelity.spec.ts`. Do not introduce a new dev endpoint.

- [ ] **Step 2: Run the targeted browser spec and verify the red state**

First verify no interactive session is live in this worktree. Then run only through
the sanctioned root entry point:

```powershell
npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts
```

Expected before integration: FAIL because the communication contains no link roles.
No `E2E_CHILD_LOG_DIR` is needed; this is not a content-loss investigation or a
timing-sensitive symptom.

- [ ] **Step 3: Re-run the targeted browser spec after S1-S3**

Run the same bare command:

```powershell
npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts
```

Expected: exit 0. Confirm Playwright tears its stack down and no listener survives
on that lane before another run.

- [ ] **Step 4: Commit E1**

Read bare status and verify no merge is in progress, then stage only:

```powershell
git add -- e2e/tests/dashboard-next/comms-clickable-links.spec.ts
git commit -m "test(e2e): prove clickable communications links" -m "Co-Authored-By: OpenAI GPT-5.6 Sol <codex@openai.com>"
```

---

### Task 5 (E2): Focused proof, adversarial review input, and final-gate readiness

**Files:**

- Modify only files required by evidence-backed review fixes.
- Create mission records under
  `docs/superpowers/reviews/2026-09-02-comms-clickable-links/` as required by the
  workflow.

**Interfaces:**

- Consumes: completed S1-S3 and E1 commits.
- Produces: a quiet, committed tree with focused proof suitable for the
  build-orchestrator's independent review and final full gates.

- [ ] **Step 1: Run the exact focused implementation proof**

Run each command bare and record its real exit code:

```powershell
npm run typecheck --workspace @housingchoice/dashboard
npm test --workspace @housingchoice/dashboard -- src/ui/LinkifiedText.test.tsx src/routes/contact/Timeline.linkified.test.tsx src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.delivery.test.tsx src/routes/email/UnmatchedRow.test.tsx src/routes/email/useUnmatchedEmail.test.tsx src/routes/contact/EmailHtmlFrame.test.tsx
npm run build --workspace @housingchoice/dashboard
npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts
```

Expected: all exit 0.

- [ ] **Step 2: Audit the complete reader list and diff boundary**

Run:

```powershell
rg -n "msg\.body|bodyText|detail\.text|row\.snippet|scheduledBody|transcriptBody" dashboard/src/routes
git diff --stat b45e6fdca1ca9fc986df02e9d7b768c6aad1de19...HEAD
git diff --check b45e6fdca1ca9fc986df02e9d7b768c6aad1de19...HEAD
```

Confirm the only behavior changes are the three Timeline text sites and expanded
`UnmatchedRow` detail. Confirm previews, scheduled text, transcripts, composers,
metadata, and HTML email remain untouched. Confirm all Timeline callers continue to
use the shared component without per-caller forks.

- [ ] **Step 3: Provide the completed work map to implementation review**

The work map must state:

- S1: exact dependencies, parser options, token API, safety fallback, clipping,
  accessibility, CSS, package/ARM proof;
- S2: inbound/outbound SMS and MMS, direct/placement/tour/Relay/native-group shared
  renderer, bubble propagation, Timeline email snippet/full body;
- S3: expanded unmatched-email body and deliberately unchanged row preview;
- E1: real dashboard/API anchor semantics, punctuation, new tab, no bubble toggle;
  and
- E2: focused exit codes and the reader/diff audit.

Do not describe the final full-suite gates as complete at this point. The
build-orchestrator first runs adversarial implementation review and any fix wave on
a quiet tree. After review fixes, rerun every affected focused check.

- [ ] **Step 4: Prepare for the repository completion gates**

Before final gates, compare current `main` with the branch base. If it has advanced,
sync it once only after verifying there is no overlap with active work and no
conflict with this branch. Preserve both sides' intent and commit the sync. Then the
build-orchestrator runs the required bare commands, in order, from this worktree:

```powershell
npm run typecheck
npm test
npm run smoke
npm run e2e
$files = git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'
if ($files.Count -gt 0) { npx eslint $files }
```

If the filtered list is empty, skip ESLint. If ESLint reports errors, compare the
same paths at the merge base and block only newly introduced errors. Never replace
these with repo-wide lint or a whole-file clean requirement.

- [ ] **Step 5: Finish records and hand back without merging**

On the final reviewed commit, record focused proof, full bare gate exit codes, the
live hermetic browser result, reviewer findings and adjudications, dependency proof,
current `main` drift, and post-merge obligations. Expected post-merge obligations:
none. State explicitly that the branch is unmerged and that merge/deploy/production
actions remain human-owned.

## Plan Self-Review

- Spec coverage: sections 1-8 map to S1-S3; unit/component tests map to S1-S3;
  browser proof maps to E1; review and gates map to E2. No approved reader or
  excluded preview depends on builder inference.
- Reader enumeration: direct contact, placement, tour, Relay, and native group all
  consume `Timeline`; opened unmatched email is the one independent body reader.
  Inbox/unmatched row previews, schedules, transcripts, composers, metadata, and
  `EmailHtmlFrame` are explicit watch items.
- Type consistency: S1 exports `LinkifiedText`, `LinkifiedTextProps`,
  `LinkifiedToken`, and `tokenizeLinkifiedText`; S2 and S3 import only
  `LinkifiedText`; tests import the pure helper/types from the same module.
- Ordering: S1 creates the API; S2 and S3 consume it; E1 proves the integrated
  reader; E2 starts only after every implementation commit is quiet.
- Dependency boundary: exact dashboard runtime versions, Windows install,
  manifest/license/lifecycle proof, browser production build, and disposable Linux
  ARM64 runtime import are all explicit.
- Placeholder scan: every task names exact files, commands, red states, expected
  outcomes, and observable assertions.
