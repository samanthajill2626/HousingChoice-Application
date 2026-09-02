# Clickable links in communications - design specification

Status: v2 - DRAFT after adversarial review round 1
Date: 2026-09-02
Revised: 2026-09-02
Branch: `feat/comms-clickable-links`
Worktree: `W:\\tmp\\comms-clickable-links`
Base: `main` at `b45e6fdca1ca9fc986df02e9d7b768c6aad1de19`

## 1. Outcome

Web links written in communications are clickable everywhere those communications
are read in the dashboard Timeline. This covers inbound and outbound SMS, MMS,
Relay messages, native group messages, and the plain-text presentation of inbound
and outbound email. It also covers the full plain-text body after an operator opens
an inbound email in unmatched-email triage. List-row previews remain previews and
are not interactive content.

Recognition follows the mature linkification behavior users already know from
handsets and email clients. It includes explicit `https://` and `http://` URLs,
protocol-relative URLs, `www` URLs, and bare public domains when they form a valid
web URL, including ports, paths, query strings, and fragments. The implementation
does not invent a repository-specific URL regular expression.

Every generated destination is still accepted only if the dashboard's existing
`safeHttpUrl` boundary validates it as an absolute HTTP or HTTPS URL. Links open in
a new browser tab and do not toggle the surrounding message bubble's hidden
metadata.

## 2. Current behavior and shared surface

`dashboard/src/routes/contact/Timeline.tsx` is the common renderer for the
communications readers in scope:

- the contact Comms pane through `ContactCommsPane`;
- placement and tour conversations through `PlacementConversation` and
  `TourConversation`;
- Relay conversations through `ConversationDetail`; and
- native group messages through `GroupTextView`.

`MessageBubble` currently places `msg.body` directly in a text-only `div` for
SMS/MMS and the two group paths. `EmailCard` similarly renders a roughly
140-character plain-text snippet and the full plain-text body as escaped React
text. `dashboard/src/routes/email/UnmatchedRow.tsx` is a separate inbound-email
reader: its expanded detail renders the full plain-text body directly, outside the
Timeline. None of these body presentations creates anchors.

The shared renderer is the correct seam. Linkifying at each caller would duplicate
behavior and create drift between direct, placement, tour, Relay, and native group
readers.

## 3. Locked product decisions

The following decisions were made during the approved brainstorm:

1. Cover both inbound and outbound communications.
2. Cover SMS, MMS, Relay messages, native group messages, and plain-text email.
3. Use established linkification rules rather than collecting bespoke decisions
   for individual punctuation, path, or domain cases.
4. Recognize explicit HTTP and HTTPS URLs, protocol-relative URLs, `www` URLs, and
   bare domains with a valid public top-level domain. A domain remains one URL when
   followed by a port, path, query string, or fragment.
5. Do not linkify email addresses, phone numbers, fuzzy IP addresses, bare
   `localhost`, other bare single-label host names, or non-web schemes in this
   mission. An explicit `http://localhost`, `https://localhost`, or
   `//localhost` is an explicit web URL and follows the normal HTTP(S) contract.
6. Preserve explicit `http://` and `https://` destinations. Normalize
   protocol-relative, `www`, and other bare-domain matches to `https://` before the
   final safety check.
7. Open generated links in a new tab with `target="_blank"` and
   `rel="noopener noreferrer"`.
8. A link click is link interaction only. It must not bubble to `MessageBubble`
   and reveal or hide transport metadata.
9. Keep all unlinked content as text nodes. Do not use `dangerouslySetInnerHTML`
   or accept HTML from a communications body.
10. Preserve the current Timeline email snippet contract: take at most 140 source
    characters, remove trailing whitespace from that visible slice, and append
    three ASCII periods when truncated. A URL that crosses the resulting display
    boundary remains clickable for its visible portion and retains the complete
    original URL as its destination.
11. In unmatched-email triage, linkify only the full plain-text body shown after the
    operator opens a row. The collapsed snippet stays non-interactive inside its
    existing row-toggle button, matching the non-interactive Inbox preview rule.

## 4. Scope boundaries

### 4.1 In scope

- `MessageBubble` message bodies in the shared Timeline, irrespective of message
  direction or whether the type is SMS or MMS.
- The collapsed plain-text snippet in `EmailCard`.
- The expanded plain-text body in `EmailCard`.
- The expanded plain-text body in `UnmatchedRow` after its detail has loaded.
- The direct, placement, tour, Relay, and native group readers that receive those
  renderers through the shared Timeline.
- Styling required for readable, wrapping, keyboard-focusable anchors inside the
  existing body and card treatments.

### 4.2 Out of scope

- Inbox row previews, the collapsed unmatched-email row snippet, scheduled-message
  previews, quick-reply/template editors, call transcripts, voicemail transcripts,
  notes, and other text that is not an opened sent or received communication body.
- Email subject, from/to/cc address lines, attachment names, delivery explanations,
  and message metadata.
- The server-sanitized original HTML email shown in `EmailHtmlFrame`. That content
  remains behind its existing sandbox and content security policy; this mission
  does not rewrite or post-process it.
- Composers and editing experiences. A URL becomes interactive when read, not while
  it is being typed.
- Backend parsing, persistence, migration, API, worker, provider, or delivery
  changes.
- Markdown rendering, rich previews, page-title fetching, URL shortening, visit
  tracking, and link reputation checks.

## 5. Dependency decision

Add `linkify-it` 6.1.0 and `tlds` 1.261.0 as direct runtime dependencies of the
`@housingchoice/dashboard` workspace. The install command is scoped to
`dashboard/package.json`; the root lockfile records the resolved dependency graph.

`linkify-it` is selected because it is a focused plain-text URL tokenizer with
Unicode and international-domain support, punctuation and nested-delimiter rules,
custom normalization, browser support, an MIT license, and no native component.
Version 6.1.0 includes TypeScript declarations and has one small pure-JavaScript
runtime dependency, `uc.micro`. The repository already resolves an older 5.0.2
copy transitively through email parsing, but the dashboard must declare and resolve
the approved 6.1.0 API directly instead of importing an incidental transitive
dependency.

The complete `tlds` list replaces `linkify-it`'s intentionally short built-in list
so bare domains with current public top-level domains behave like URLs. It is also
MIT licensed, pure data/JavaScript, and already present transitively in the lockfile;
the dashboard still declares it directly because its parser configuration imports
it at runtime.

`linkifyjs` is not selected: its React adapter is convenient, but this feature needs
custom URL safety, scheme normalization, snippet-boundary handling, and event
control, so the adapter would not remove the application-specific renderer.
`autolinker` is not selected: its additional phone, email, mention, hashtag, and
HTML-oriented surface is broader than this HTTP(S)-only requirement. A small
tokenizer plus ordinary React nodes is the narrower dependency and trust boundary.

Before the dependency commit is accepted, the build must prove:

- the exact direct dependencies and transitive graph in `package-lock.json`;
- successful clean workspace installation on Windows;
- a successful production dashboard build, which proves browser bundling and the
  imported `tlds` data shape;
- package licenses from the installed manifests; and
- absence of install scripts or native/optional binaries, so Linux ARM64 deployment
  has no platform-specific path to exercise.

No vulnerability remediation outside this dependency delta belongs to this mission.

## 6. Recognition and normalization contract

Create one module-scoped parser instance rather than constructing a parser during
each React render. Configure it explicitly so upstream defaults cannot silently
broaden the contract:

- load the full `tlds` list;
- enable fuzzy web links;
- disable fuzzy email addresses;
- disable fuzzy IP addresses;
- disable `ftp:` and `mailto:` schemas; and
- accept only matches that can become an HTTP or HTTPS destination.

For every parser match:

1. Preserve the exact matched source characters for display.
2. Preserve an explicit `http://` or `https://` destination as parsed.
3. Prefix a protocol-relative match with `https:`.
4. Prefix a fuzzy `www` or bare-domain match with `https://`, replacing the
   parser's default inferred scheme rather than exposing an inferred HTTP link.
5. Pass the resulting string through `safeHttpUrl`.
6. Emit an anchor only when that check returns a destination. Otherwise emit the
   original source characters as text.

This makes `safeHttpUrl`, not the parser, the final destination-scheme authority.
The unsupported-scheme token and target in `javascript:`, `data:`, `vbscript:`,
`file:`, `ftp:`, and `mailto:` do not become destinations using those schemes.
The parser may still independently recognize a valid bare domain after a delimiter
inside surrounding text, such as the `example.com` after the comma in
`data:text/html,example.com`; if so, that independent match follows the ordinary
HTTPS normalization and safety check. Tests lock this established parser behavior
instead of imposing a second application-authored URL grammar.

The parser owns boundaries for ordinary sentence punctuation, balanced
parentheses/brackets, Unicode punctuation, multiple links, query strings, and
fragments. Application code must not trim punctuation with a second regular
expression. The full TLD list owns fuzzy-domain validity; application code must not
maintain a competing suffix list.

## 7. Rendering design

### 7.1 Text model

Add a small shared `LinkifiedText` React component and a pure tokenization helper
under `dashboard/src/ui/`. The pure helper accepts the original source text and an
optional display-character limit, and returns an ordered set of plain-text and
safe-link tokens. It never returns markup strings.

Tokens preserve source offsets. Text before, between, and after matches is emitted
unchanged. React performs normal text escaping. Stable keys derive from source
offsets rather than link text, so repeated identical URLs are supported.

### 7.2 Full message bodies

`MessageBubble`, expanded `EmailCard`, and expanded `UnmatchedRow` bodies call
`LinkifiedText` without a display limit. Newlines and spacing continue to rely on
the existing `white-space: pre-wrap` body styles. Long URLs continue to wrap using
`overflow-wrap: anywhere`.

### 7.3 Email snippets

The collapsed Timeline email presentation calls the same component with a
source-character limit of 140 and requests the existing three-period suffix when
the original body is longer. Before tokens are clipped, it computes the actual
display end as `bodyText.slice(0, 140).trimEnd().length`; this preserves the current
trailing-whitespace behavior without trimming the complete source used to resolve
link destinations.

Parsing occurs against the complete original body before the display range is
applied. If a matched URL begins before character 140 and ends after it, the token's
visible label is clipped at the boundary but its destination is normalized from the
complete match. This avoids a visually truncated link navigating to a truncated or
different URL. A match that begins at or after the boundary is not rendered in the
snippet.

The 140-character measure remains JavaScript source-string length, matching the
existing behavior. This mission does not redefine snippet length by grapheme.

### 7.4 Anchor behavior and style

Each safe link renders as a real `<a>` with:

- `href` set to the normalized, safety-checked destination;
- `target="_blank"`;
- `rel="noopener noreferrer"`; and
- an `onClick` handler that stops propagation.

The default browser keyboard contract is retained. Link styling is visibly
distinguishable in inbound bubbles, outbound bubbles, and email cards, includes a
focus-visible outline using the existing focus-ring token, and does not remove the
underline as the sole non-color cue. Visited styling must not reveal sensitive
browsing history through a materially different presentation.

## 8. Security and privacy invariants

- Communications bodies stay untrusted plain text.
- No raw HTML is generated, injected, parsed, or mounted.
- No URL is fetched, resolved, previewed, or contacted during rendering.
- Only an explicit operator activation navigates away from the dashboard.
- Only absolute HTTP(S) URLs accepted by `safeHttpUrl` become anchors.
- The displayed text remains the sender's original text, including the original
  scheme or absence of one. Normalization changes `href`, not the displayed claim.
- A malformed or rejected match degrades to literal text without deleting or
  reordering source characters.
- The existing sandboxed HTML-email path is unchanged.

## 9. Tests and verification

### 9.1 Focused unit tests

Add pure-helper tests that establish the contract for:

- explicit HTTPS and HTTP;
- protocol-relative, `www`, and bare public-domain URLs;
- a bare domain with port, path, query, and fragment;
- multiple links in one body;
- sentence punctuation, balanced parentheses, brackets, and Unicode punctuation;
- modern and international top-level domains supplied by `tlds`;
- repeated identical links with distinct source offsets;
- email addresses, phone numbers, fuzzy IP addresses, bare `localhost`, and other
  bare single-label hosts remaining text;
- explicit HTTP(S) and protocol-relative localhost URLs remaining eligible;
- unsupported schemes never becoming an anchor destination, plus parser-owned
  behavior for a valid bare domain after a delimiter in unsupported-scheme text;
- HTML-looking content remaining escaped text;
- HTTP(S) safety rejection degrading to the exact original text; and
- a URL crossing the 140-character snippet boundary retaining its complete `href`
  while displaying only the in-range source characters plus the suffix.

Add or extend shared Timeline component tests for:

- inbound and outbound message bubbles;
- SMS text and an MMS body with attachments still rendering independently;
- Relay/native-group sender attribution remaining intact around linkified text;
- collapsed and expanded plain-text email bodies;
- expanded unmatched-email plain-text detail while its collapsed row snippet stays
  non-interactive;
- safe `href`, `target`, and `rel` values;
- link activation not toggling `MessageBubble` metadata; and
- ordinary bubble activation still toggling metadata.

Tests should query anchors by accessible role and name. They must not assert parser
internals where observable rendered behavior is sufficient.

### 9.2 Focused browser proof

Add or extend a dashboard-next Playwright spec in the hermetic e2e workspace. The
test must inject or send a communication containing both an explicit URL and a bare
domain-with-path, then prove in the real dashboard that:

- the Timeline shows two anchors with the expected complete destinations;
- surrounding punctuation is not part of the destinations;
- the link opens a new page/tab rather than navigating the dashboard in place; and
- clicking it does not reveal the bubble metadata.

Use a controlled hermetic destination or inspect the new-page URL without depending
on the public Internet. Component coverage proves email-specific truncation and all
shared-reader variants; the browser proof exercises the common production renderer
through one real dashboard communications path without multiplying equivalent e2e
cases.

### 9.3 Mission gates

The implementation inner loop uses the narrow dashboard typecheck, focused Vitest
files, and the targeted browser spec. After adversarial implementation review and
its fixes, rerun those affected focused checks.

Because this is a feature mission, final completion follows the repository's full
workflow: sync `main` into the branch once, then run the bare required gates from
this worktree:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. touched-file ESLint over `main...HEAD`, skipped only if the filtered file list is
   empty

Finish with independent handback review and live self-QA in the hermetic browser
lane. Merge, deploy, infrastructure changes, feature flags, and production testing
remain human-owned.

## 10. Acceptance criteria

The feature is accepted when:

- every in-scope Timeline reader renders the shared SMS/MMS/group and plain-text
  email presentations through the same linkification contract, and the expanded
  unmatched-email plain-text reader uses that component directly;
- explicit HTTP(S), protocol-relative, `www`, and valid bare-domain web URLs are
  clickable in both inbound and outbound content;
- inferred destinations use HTTPS and explicit schemes are preserved;
- only safety-checked HTTP(S) destinations become anchors, including any valid bare
  domain independently recognized after punctuation in otherwise unsupported-
  scheme text;
- link labels preserve the sender's source text and all other content remains
  escaped text;
- punctuation and delimiter handling match the selected parser rather than a local
  regular expression;
- Timeline email snippets keep the current 140-character and trailing-whitespace
  presentation without corrupting a crossing URL destination;
- links open in a new tab with the required relationship attributes and do not
  toggle bubble metadata;
- out-of-scope previews, including the unmatched-email row snippet, plus composers,
  transcripts, metadata, and original HTML email remain unchanged;
- focused tests, the targeted hermetic browser proof, full feature gates,
  adversarial review, and live self-QA all pass; and
- the branch is handed back unmerged with no deployment or production mutation.
