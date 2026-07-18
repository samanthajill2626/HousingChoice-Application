# Selector conventions

Accessibility-first, in priority order. These double as the snapshot the
Playwright MCP reads, and they pressure the UI toward accessibility.

1. **`getByRole(role, { name })`** — buttons, links, headings, textboxes.
2. **`getByLabel(text)`** — form fields associated with a `<label>` / `Field`.
3. **`getByText(text)`** — visible copy / status messages.
4. **`getByPlaceholder(text)`** — only when no label exists.
5. **`data-testid`** — last resort, ONLY when none of the above can identify an
   element. None are needed today; add one (and note it here) if a future
   element is genuinely unaddressable.

## Key selectors this harness relies on
| Surface | Element | Selector |
|---------|---------|----------|
| Login | sign-in affordance | `getByText('Sign in with Google')` |
| Inbox | heading | `getByRole('heading', { name: 'Inbox' })` |
| Inbox | a conversation row | `getByRole('link').filter({ hasText: <preview/name> })` |
| Public form | fields | `getByLabel('First name'|'Last name'|'Phone')` |
| Public form | submit | `getByRole('button', { name: 'Sign me up' })` |
| Public form | success | `getByText("Thanks, we'll text you!")` |
| Thread | reply box | `getByRole('textbox', { name: 'Message' })` — `getByLabel('Message')` would also match the timeline `role=log` and message bubbles whose `aria-label` contains "Message", causing a strict-mode violation |
| Thread | send | `getByRole('button', { name: 'Send', exact: true })` — non-exact name matching is substring-based, so a bare `{ name: 'Send' }` also matches the tenant contact page's "+ Send" card action (aria-label "Send a property to this tenant"): a strict-mode violation |
| Contact (AI extraction) | AI provenance badge | `getByRole('img', { name: 'Auto' })` - the AutoBadge on a field written from an extraction; scope to the card (`section` filtered by heading "Details" / "Eligibility intake") to disambiguate |
| Contact (AI extraction) | review chip | `getByRole('group', { name: 'AI suggestion for <label>' })` - labels: `voucher size`, `housing authority`, `pets`, `evictions`, `time at current address`, `porting`, `phone`, `status`, `type`; inner text `AI heard "<value>"`; buttons `getByRole('button', { name: 'Accept'\|'Dismiss' })` scoped to the group |
| Contact (AI extraction) | chip "View conversation" link | `getByRole('link', { name: 'View conversation' })` scoped to the review chip group - the third action; the voice-extraction chip-wrap spec asserts it stays visible + the action row wraps (no horizontal overflow) at the desktop Details-card width |
| Contact (AI extraction) | status advance chip | `getByRole('group', { name: 'AI suggestion for status' })` - text `AI heard "searching"`; header pill re-labels to `getByRole('button', { name: 'Contact status: Searching' })` after Accept |
| Unknown file (AI extraction) | type recommendation | `getByText(/AI suggests: Tenant/)` inside the `Needs triage` card; the `Mark as Tenant` button remains the action |
| Today (AI extraction) | suggestions group | `getByRole('list', { name: 'AI suggestions to review' })` - the group's `<ul>`; `getByRole('listitem')` within it counts distinct contacts with pending suggestions. NOTE the Today queue is the dashboard HOME route `/`, not `/today` |

## Dev-only assertions (not UI)
- Outbox: `getOutbox(request, { to, since })` → `GET /__dev/outbox`.
- Reset: `reseed(request)` → `POST /__dev/reseed`.
- Stack identity: `GET /__dev/ping` → `{ dev: true }`.
