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
| Thread | reply box | `getByRole('textbox', { name: 'Reply message' })` — `getByLabel('Message')` would also match the timeline `role=log` and message bubbles whose `aria-label` contains "Message", causing a strict-mode violation |
| Thread | send | `getByRole('button', { name: 'Send', exact: true })` — non-exact name matching is substring-based, so a bare `{ name: 'Send' }` also matches the tenant contact page's "+ Send" card action (aria-label "Send a property to this tenant"): a strict-mode violation |
| Contact (AI extraction) | AI provenance badge | `getByRole('img', { name: 'Auto' })` - the AutoBadge on a field written from an extraction; scope to the card (`section` filtered by heading "Details" / "Eligibility intake") to disambiguate |
| Contact (AI extraction) | review chip | `getByRole('group', { name: 'AI suggestion for <label>' })` - labels: `voucher size`, `housing authority`, `pets`, `evictions`, `time at current address`, `porting`, `phone`, `status`, `type`; inner text `AI heard "<value>"`; buttons `getByRole('button', { name: 'Accept'\|'Dismiss' })` scoped to the group |
| Contact (AI extraction) | chip "View conversation" link | `getByRole('link', { name: 'View conversation' })` scoped to the review chip group - the third action; the voice-extraction chip-wrap spec asserts it stays visible + the action row wraps (no horizontal overflow) at the desktop Details-card width |
| Contact (AI extraction) | status advance chip | `getByRole('group', { name: 'AI suggestion for status' })` - text `AI heard "searching"`; header pill re-labels to `getByRole('button', { name: 'Contact status: Searching' })` after Accept |
| Unknown file (AI extraction) | type recommendation | `getByText(/AI suggests: Tenant/)` inside the `Needs triage` card; the `Mark as Tenant` button remains the action |
| Today (AI extraction) | suggestions group | `getByRole('list', { name: 'AI suggestions to review' })` - the group's `<ul>`; `getByRole('listitem')` within it counts distinct contacts with pending suggestions. NOTE the Today queue is the dashboard HOME route `/`, not `/today` |
| Settings (Quiet hours) | the section | `getByRole('region', { name: 'Quiet hours' })` - its `<section>` is `aria-labelledby` its own `<h2>`, so it exposes a NAMED region. Scope EVERY control below to it: the tab hosts a second `<h2>` ("System status"), and `locator('section').filter({ has: heading })` would also match the SettingsPage wrapper `<section>` (strict-mode violation). Admin-only route (`/settings/system`) - dev-login as `founder@example.com` |
| Settings (Quiet hours) | on/off | `getByLabel('Pause automated messages overnight')` - the checkbox. Wait on THIS (not the heading): the heading renders immediately, the controls only after the section's own `GET /api/settings` resolves |
| Settings (Quiet hours) | window start / end | `getByLabel('Start')` / `getByLabel('End')` - `<input type="time">`; `fill('08:30')` takes a bare "HH:MM" |
| Settings (Quiet hours) | save + confirmation | `getByRole('button', { name: 'Save' })` (DISABLED until a field actually changes) and `getByRole('status')` -> "Saved" |
| Settings (Quiet hours) | timezone | `getByText('Eastern - America/New_York')` - fixed COPY, not a control: `getByLabel(/Timezone/i)` finds nothing by design |
| Tour Reminders panel | Send now | `getByRole('button', { name: 'Send <Kind label> reminder now' })` - e.g. `Send Day before reminder now` (kind labels: Confirmation, Day before, Morning of, En route, No-show check-in). A bare `{ name: 'Send now' }` matches one button PER pending rung and substring-collides with the contact page's "+ Send": a strict-mode violation |
| Placement nudges card | Send now | `getByRole('button', { name: 'Send <Kind label> nudge now' })` - e.g. `Send Receipt check nudge now` (kind labels: Receipt check, Completion check, Approval check, RTA window closing). Same strict-mode caveat as the reminder button |
| Tour Reminders panel | quiet-hours deferral note | the rung `listitem` contains `Will wait <U+2014 EM DASH> quiet hours` - quiet hours DEFERS a send, so the lead is "Will wait"; every other suppression reason still reads "Will be skipped". Build the separator with `String.fromCharCode(0x2014)` so the spec source stays ASCII (see quiet-hours.spec.ts) |
| Tour / placement hub | person 1:1 channel tab | `getByRole('tab', { name: new RegExp('^' + firstName + '\\b') })` - person tabs are labeled by the contact's DISPLAY NAME, never a role word ("Tenant"/"Landlord"/"PM" died with contact-rosters slice 2); anchor on the run-unique firstName. The unread dot appends srOnly ` unread` to the accessible name; `Group text` stays a fixed label |
| Tour / placement hub | the People card roster | `getByRole('list', { name: 'Roster' })` - the PeopleCard's `<ul>`. SCOPE every member assertion to it: a member's name also appears in the page's 1:1 tab labels and its comms pane, so an unscoped `getByRole('link', { name })` is a strict-mode violation. Members are links only when the row has a live contactId (bare-phone / deleted-contact rows render plain text) |
| Property page (Contacts card) | edit toggle | `getByRole('button', { name: 'Edit contacts' })` / `getByRole('button', { name: 'Done editing contacts' })` - the CardAction reads "Edit"/"Done" but carries the disambiguating aria-label (the page hosts three other "Edit" card actions) |
| Property page (Contacts card) | per-row controls | `getByRole('button', { name: 'Remove <Full Name> from this property' })`, `getByRole('button', { name: 'Make <Full Name> the primary contact' })`, `getByRole('combobox', { name: 'Role for <Full Name>' })` (a `<select>`, `selectOption('landlord'\|'pm'\|'owner'\|'other')`). The landlord-of-record row's Remove is DISABLED and the row carries the reason text; the current primary has no make-primary control |
| Property page (Contacts card) | add a contact | `getByRole('button', { name: '+ Add contact' })` opens the form, then `getByRole('combobox', { name: 'Add contact' })` (committed-pick typeahead - `fill()` then click `getByRole('option', { name: <Full Name> })`; typing alone never carries a contactId), `getByRole('combobox', { name: 'Role for the new contact' })`, and `getByRole('button', { name: 'Add contact to this property' })`. The button's visible text is just "Add" - the aria-label is what keeps it off the Photos card's "+ Add" |
| Property page (Contacts card) | remove-the-primary confirm | `getByRole('dialog', { name: 'Remove the primary contact?' })`, whose body NAMES the promotion: `<Landlord of record> becomes the primary contact - calls and new group texts for this property will go to them.` (or `This property will have no primary contact - tours fall back to the landlord of record.` when the property has no landlordId). Confirm with `getByRole('button', { name: 'Remove contact' })` SCOPED to the dialog - the card behind it still holds every row's Remove |
| Tour / placement hub (People card) | edit toggle | `getByRole('button', { name: 'Edit people' })` / `getByRole('button', { name: 'Done editing people' })` - the CardAction reads "Edit"/"Done" but carries the disambiguating aria-label (the page hosts other "Edit" card actions). Absent while the roster is loading or unreadable - there is nothing to edit |
| Tour / placement hub (People card) | per-row remove | `getByRole('button', { name: 'Remove <Full Name> from this tour' })` (`...this placement` on the placement hub). The name is exactly what the row renders, so a bare-phone row is `Remove Number ending 0199 from this tour`. The LAST remaining member's control is DISABLED and the row carries the reason `A roster needs at least one member. Add someone else before removing this one.` |
| Tour / placement hub (People card) | inline suggestions | text `Also on this property: <Full Name> - <role>[ - primary contact]` and `On this tour: <Full Name> - tenant` (`On this placement:` on the placement hub); the action is `getByRole('button', { name: 'Add <Full Name> to this tour' })`. Roles read `landlord` / `PM` / `owner` / `contact` |
| Tour / placement hub (People card) | add any contact | `getByRole('button', { name: '+ Add any contact' })` opens the form, then `getByRole('combobox', { name: 'Add any contact' })` (committed-pick typeahead - `fill()` then click `getByRole('option', { name: <Full Name> })`), then `getByRole('button', { name: 'Add contact to this tour' })`. The button's visible text is just "Add" |
| Tour / placement hub (People card) | reset | `getByRole('button', { name: 'Reset to property default' })` - rendered only when the roster is `customized`; DISABLED once a group text exists, with the reason `members are on a live group text - add or remove them individually` |
| Tour / placement hub | pre-open confirm | `getByRole('dialog', { name: 'Open the group text?' })`. [Open group text] (kebab menuitem OR the Group tab's empty-state button) only PREVIEWS - the dialog's own `getByRole('button', { name: 'Open group text' })`, scoped to the dialog, is what provisions |
| Tour / placement hub | add-to-live-group confirm | `getByRole('dialog', { name: 'Add <Full Name> to the group text?' })` -> `getByRole('button', { name: 'Add and notify' })` scoped to the dialog. Only when a group text already exists; pre-open adds are silent |
| Roster confirm dialogs (both) | preview contents | `getByRole('region', { name: 'Message preview' })` holds the SERVER-composed body verbatim; `getByRole('list', { name: 'Recipients' })` lists everyone the send touches (a suppressed leg reads `not receiving - opted out` / `not receiving - no mobile number`); the count line is `<n> recipients will receive this.` (`1 recipient ...` singular). A quiet-hours note reads `Quiet hours until <time> - this will still send now.` |

## Dev-only assertions (not UI)
- Outbox: `getOutbox(request, { to, since })` → `GET /__dev/outbox`.
- Reset: `reseed(request)` → `POST /__dev/reseed`.
- Stack identity: `GET /__dev/ping` → `{ dev: true }`.
