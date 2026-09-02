# Clickable links in communications - design specification

Status: v6 - REVISED after Autolinker amendment review; pending re-review
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
   `localhost`, protocol-relative `//localhost`, or other single-label host names
   in this mission. Explicit `http://localhost` and `https://localhost` remain
   eligible HTTP(S) URLs. Non-web schemes are never destinations.
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

Add `autolinker` 4.1.5 as the direct runtime dependency of the
`@housingchoice/dashboard` workspace. The install command is scoped to
`dashboard/package.json`; the root lockfile records the resolved dependency graph.

`autolinker` core is selected because its URL-only `parse` API is a mature
plain-text parser with Unicode and international-domain support, parser-owned
punctuation and nested-delimiter rules, source offsets, browser support, an MIT
license, and bundled TypeScript declarations. With URL matching configured
narrowly, it natively returns one public bare-domain match for
`example.com:8443/a?x=1#top`, includes protocol-relative public-domain URLs, and
keeps U+3002, U+FF0C, U+3001, ASCII/full-width brackets, and ordinary sentence
punctuation outside the match. It also recognizes current suffixes such as `.zip`
and international domains. It has one pure-JavaScript runtime dependency,
`tslib`, with no native or optional binary dependency.

The S1 spike rejected the prior `linkify-it` 6.1.0 plus `tlds` design: under its
required configuration it returned no match for the required bare-domain port/path
form. Extending that parser with a repository URL grammar would violate the locked
no-competing-regexp boundary, so both uncommitted dependency additions are removed.

`linkify-react` is not selected: this feature still needs custom URL safety, scheme
normalization, snippet-boundary handling, and event control, so a React adapter
would not remove the application-specific renderer. `linkifyjs` core is not
selected: its protocol-relative handling and U+3002 boundary behavior require an
application-owned Unicode boundary grammar to satisfy the locked visible-text
contract. The feature uses only Autolinker's plain-text `parseText()` match API,
never its HTML-aware `parse()`/renderer path, anchor builder, `link()` method, or
replacement callback.

Before the dependency commit is accepted, the build must prove:

- the exact direct dependency and resolved graph in `package-lock.json`;
- successful clean workspace installation on Windows;
- a successful production dashboard build, which proves browser bundling and the
  imported `autolinker` parse/match API shape;
- package licenses from the installed manifests; and
- absence of install scripts, native/optional binaries, and a target-architecture
  install/import failure, so Linux ARM64 deployment has no platform-specific path
  to exercise.

No vulnerability remediation outside this dependency delta belongs to this mission.

## 6. Recognition and normalization contract

Keep one Autolinker instance with URL-only options module scoped rather than
constructing configuration during each React render. Call its plain-text
`parseText(text)` method, never HTML-aware `parse(text)`, with:

```ts
{
  urls: { schemeMatches: true, tldMatches: true, ipV4Matches: false },
  email: false,
  phone: false,
  mention: false,
  hashtag: false,
}
```

Then retain only results whose
`type` is `url`. Use `getOffset()`, `getMatchedText()`, and `getUrlMatchType()` as
the parser-owned source/range/classification input. This keeps email addresses,
phone numbers, fuzzy IPs, bare single-label hosts, and protocol-relative local-only
targets outside the rendered-link input without treating a sender body as HTML.

For every parser result:

1. Preserve exact source characters for display using the parser-owned source range.
2. Prefix a parser-owned source beginning with `//` with `https:`. When
   `getUrlMatchType()` reports `www` or `tld`, prefix the exact matched source with
   `https://`. Otherwise use `getAnchorHref()` as the candidate, which preserves
   explicit HTTP(S) and allows the final safety boundary to reject an unsupported
   parsed scheme.
3. Pass the candidate through `safeHttpUrl`.
4. Emit an anchor only when that check returns a destination. Otherwise emit the
   original source characters as text.

This makes `safeHttpUrl`, not the parser, the final destination-scheme authority.
An unsupported parsed scheme is rejected by that final boundary and remains exact
source text. The parser may independently recognize a public bare domain after a
delimiter in surrounding text; if so, that independent match follows the ordinary
HTTPS normalization and safety check. Tests lock the selected parser's observed
source ranges and safe rendered behavior rather than imposing a second
application-authored scheme or punctuation grammar.

The parser owns boundaries for ordinary sentence punctuation, balanced
parentheses/brackets, U+3002, U+FF0C, U+3001, ASCII/full-width brackets, multiple
links, ports, paths, query strings, and fragments. Application code must not trim
punctuation with a second regular expression, maintain a competing suffix list, or
add bespoke local-host recognition. Consequently bare `localhost`, `//localhost`,
and other single-label/local-only targets remain text; explicit `http://localhost`
and `https://localhost` remain eligible after `safeHttpUrl`.


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
- current and international top-level domains recognized by `autolinker`, including
  `.zip`;
- repeated identical links with distinct source offsets;
- email addresses, phone numbers, fuzzy IP addresses, bare `localhost`, and other
  bare single-label hosts remaining text;
- explicit HTTP(S) localhost URLs remaining eligible while `//localhost` remains
  literal text;
- unsupported schemes never becoming an anchor destination, and parser-observed
  behavior for any separately recognized public bare domain after their delimiters;
- U+3002, U+FF0C, U+3001, and ASCII/full-width brackets remaining literal boundary
  characters;
- literal `script`, anchor, and comment-shaped source text retaining parser-visible
  URLs as text-plus-link tokens rather than receiving HTML-aware suppression; and
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
