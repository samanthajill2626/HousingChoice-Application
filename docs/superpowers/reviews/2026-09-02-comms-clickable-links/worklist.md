# Phase 1 live-tree worklist - clickable communications links

Base examined: b45e6fdca1ca9fc986df02e9d7b768c6aad1de19
Branch start for build: ca70d310cab47ed60d5eb193f4716252c844f2f8
Merged sources: research-ui-timeline-reference.md, research-unmatched-browser-reference.md, research-dependency-safeurl-reference.md.

## S1 - Autolinker shared contract and dependency boundary

- `dashboard/package.json:10-15`: add exact runtime dependency only: `autolinker` `4.1.5`.
- The rejected uncommitted `linkify-it@6.1.0` / `tlds@1.261.0` additions and superseded `linkifyjs@4.3.3` proposal are removed. `linkify-it` returned null for `example.com:8443/a?x=1#top`; `linkifyjs` required application-owned Unicode-boundary behavior to preserve U+3002 outside the matched text.
- `dashboard/src/lib/safeUrl.ts:9-20`: `safeHttpUrl(url: string | null | undefined): string | null` returns `parsed.toString()` only for absolute `http:` or `https:` URLs and otherwise `null`. New link tokens must pass through it; no raw parser URL becomes `href`.
- Existing safe-URL consumers are `dashboard/src/routes/listing/ListingDetail.tsx:66,305` and `dashboard/src/routes/public/FlyerPage.tsx:27,211-212`; S1 adds exactly the isolated text component consumer.
- `dashboard/tsconfig.json:1-12` uses `module: ESNext` / `moduleResolution: bundler`; prove the `autolinker` ESM parse/match import through dashboard build and a disposable Linux ARM64 probe.
- Create `dashboard/src/ui/LinkifiedText.tsx`, `LinkifiedText.module.css`, and `LinkifiedText.test.tsx`; export at `dashboard/src/ui/index.ts:1-17` using `.js` barrel style.
- Token contract, byte exact:

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

- Parser contract: make a same-length parser-only copy by replacing `<`/`>` with U+FF1C/U+FF1E, then call public `Autolinker.parse`, filter `type === 'url'`, and use `getOffset()`/matched-text length/`getUrlMatchType()` without a competing regexp. Never use private `parseText` or the HTML renderer. Slice original source for display/candidates. Normalize source-leading `//` with `https:`; normalize parser `tld` classification (both bare and `www`) with `https://`; use other exact original sources as candidates, then use `safeHttpUrl`. No parser result surviving safety may rewrite its visible source.
- Test `.zip` and IDN, bare-domain port/path/query/fragment, explicit/protocol-relative public URLs, explicit/local-host exclusions, unsafe-scheme exact-text fallback, punctuation/balanced delimiters including U+3002/U+FF0C/U+3001/full-width brackets, duplicate offsets, literal HTML-looking source with `script`/anchor/comment shapes, literal `&amp;` queries, and a full-source boundary crossing a display end.
- Render true anchors only with `href`, `_blank`, `noopener noreferrer`, and stopped propagation. CSS must retain underline, wrap, focus ring, and no visited-history distinction.

## S2 - Timeline consumers and complete reader map

- Private components only: `MessageBubble` starts `dashboard/src/routes/contact/Timeline.tsx:814`; `EmailCard` starts `:1468`. Neither has external imports. `StreamItem` selects `EmailCard` when `item.type === 'email'` and `MessageBubble` otherwise at `:1538-1578`.
- Exact message body reader: `Timeline.tsx:1014-1036` currently renders `{msg.body ? <div className={styles.body}>{msg.body}</div> : null}` inside `.bubble` with `onClick={toggleMeta}`. The toggle is `Timeline.tsx:1006-1018`; anchors must stop propagation. Sender attribution precedes the body and `AttachmentGallery` follows it.
- Exact Timeline email readers: `Timeline.tsx:1477-1507`. Current snippet is `truncated ? \`${bodyText.slice(0, EMAIL_SNIPPET_CHARS).trimEnd()}...\` : bodyText`; message length is `EMAIL_SNIPPET_CHARS = 140`. The new condition must render a 141-space truncated body as `...`, even though the visible text slice is empty. Parse full `bodyText`, clip only label at `snippetEnd`, retain full normalized `href`, and append only the existing `...` suffix.
- Never modify `EmailHtmlFrame` disclosure (`Timeline.tsx:1509-1521`), scheduled cards, calls/transcripts, composers, metadata, subjects/addresses, or attachment labels.
- Exact `TimelineMessage` reader contract (`dashboard/src/api/types.ts:2434-2587`):

```ts
export interface TimelineMessage extends TimelineBase, MessageTransportFields {
  kind: 'message';
  conversationId: string;
  tsMsgId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  type: 'sms' | 'mms' | 'email';
  body?: string;
  media_attachments?: { s3Key: string; contentType: string; filename?: string }[];
  delivery_status: DeliveryStatus;
  error_code?: string;
  retry_of?: string;
  imported?: boolean;
  fromPhone?: string;
  toPhone?: string;
  subject?: string;
  email_from?: string;
  email_to?: string[];
  email_cc?: string[];
  email_new_address?: boolean;
  email_html_sanitized?: string;
  delivery_recipients?: Record<string, RelayRecipientDelivery>;
  optimistic?: boolean;
  relay_sender_key?: string;
  via_closed_group?: string;
}
```

- Production importers of `Timeline` are complete and all must retain behavior: `dashboard/src/routes/contact/ContactCommsPane.tsx:26,319-350`; `dashboard/src/routes/placements/PlacementConversation.tsx:55,320-337`; `dashboard/src/routes/tours/TourConversation.tsx:44,467-484`; `dashboard/src/routes/conversation/ConversationDetail.tsx:32,480-498`; `dashboard/src/routes/conversation/GroupTextView.tsx:21,448-469`. `RosterKind` is exactly `export type RosterKind = 'relay' | 'group_text';` at `dashboard/src/api/types.ts` and must keep native sender attribution.
- Existing neighboring tests: `Timeline.test.tsx`, `Timeline.email.test.tsx`, `Timeline.mms.test.tsx`, `Timeline.delivery.test.tsx`; create `Timeline.linkified.test.tsx`. New coverage must prove inbound/outbound SMS/MMS, independent attachment display, Relay `Team` and native `Lars Landlord` sender labels, click/no-reveal versus body/reveal, email full/snippet behavior and anchor attributes.

## S3 - unmatched-email detail seam

- `dashboard/src/routes/email/EmailTriage.tsx:235-239,344-366` is the sole production mounter/importer of `UnmatchedRow`.
- Wire split: `dashboard/src/api/types.ts:2395-2419` has `UnmatchedEmailRow.snippet: string` and `UnmatchedEmailItem extends UnmatchedEmailRow` with `text: string`; list server mapper omits `text`, detail mapper returns it at `app/src/routes/unmatchedEmail.ts:153-181`.
- `dashboard/src/routes/email/UnmatchedRow.tsx:80-117` lazy-loads detail and marks unread rows read. Change only detail body at `:177-208`, now `<div className={styles.body}>{detail.text}</div>`.
- Preserve header preview byte for byte at `UnmatchedRow.tsx:120-138`: `{row.snippet.length > 0 ? <span className={styles.snippet}>{row.snippet}</span> : null}`. It is inside the only header `<button>`; an anchor would create invalid nested interactivity.
- Preserve action buttons (`:140-166`), `getUnmatchedEmailDetail`, `onMarkRead`, `EmailHtmlFrame` disclosure (`:183-193`), and attachments (`:195-205`). The normal body CSS at `EmailTriage.module.css:283-290` already supplies pre-wrap and word-break.
- No existing `UnmatchedRow.test.tsx`; create it. Scope header-button assertions to `.main`, since action buttons are correct sibling controls. Verify preview has no anchor before opening; expanded detail has anchors/attributes/punctuation once loaded and makes exactly one mark-read call.

## E1 - hermetic production seam

- Default lean reseed supplies `conv-0001` and `contact-tenant-0001`: `app/src/lib/seed/lean.ts:35-46,224-235`; no full profile is required for E1.
- `POST /__dev/extraction/message-fixture` is live at `app/src/routes/dev.ts:813-1055`; require `conversationId`, `body`, and `createdAt`; `{ mode: 'legacy' }` succeeds and produces inbound delivered body at `:1028-1054`.
- Contact Timeline reaches the planted message through `ContactCommsPane.tsx:319-329`, `useContactTimeline.ts:148-173`, and `app/src/routes/contactTimeline.ts:405-463,438`.
- Use existing dashboard-next login idiom at `e2e/tests/dashboard-next/inbox-comms.spec.ts:14-18`: dev-user button then `expectTodayReady`. Set `context.route('https://example.com/**', ...)` before click; wait for popup. The target accepts planned marker/URLs without public network.
- Run only `npm run e2e -- tests/dashboard-next/comms-clickable-links.spec.ts`; do not use a root Playwright direct command or overlap a live interactive session. Verify owned lane ports free after teardown.

## Reader/render boundary audit

- Deliberate exclusions: scheduled `item.body` (`dashboard/src/routes/contact/ScheduledCard.tsx:131-143`); call transcript (`Timeline.tsx:1440-1453`); sandboxed original email HTML (`Timeline.tsx:1509-1521`, `UnmatchedRow.tsx:183-193`); inbox `ConversationSummary.preview` (`dashboard/src/api/types.ts:506-525`); quick replies, EmailComposer, and reminder previews.
- State mutations affected: none. This mission changes only client-side rendering of stored communication text. The relevant reader/renderer surfaces above are exhaustive; no create/update/send/delete or transport mutation should change.

## Research verdict

No spec/plan drift. Preserve the design's literal constraints; do not broaden scopes. The only live implementation hazards are parser import/data-shape proof after the S1 install, full-source snippet parsing, whitespace-only truncation, anchor propagation, and preview/button non-nesting.
