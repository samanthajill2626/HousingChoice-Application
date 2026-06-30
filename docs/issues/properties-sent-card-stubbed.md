---
id: properties-sent-card-stubbed
title: Tenant page "Properties sent" card never renders its rows (hardcoded empty state)
type: bug
severity: low
status: resolved
area: dashboard
created: 2026-06-30
resolved: 2026-06-30
refs: dashboard/src/routes/contact/TenantFile.tsx:148, dashboard/src/routes/contact/ContactDetail.tsx:374, dashboard/src/api/endpoints.ts:463
---

**Problem.** On a tenant's contact page, the **"Properties sent"** card always shows
"No properties sent yet." even after a property HAS been sent to that tenant. The card
body only has two branches — a pending panel or the empty row — and **no branch that
renders the listing-send rows**:

```tsx
// dashboard/src/routes/contact/TenantFile.tsx:148
<Card title="Properties sent">
  {listingsSentPending ? <PendingPanel /> : <EmptyRow>No properties sent yet.</EmptyRow>}
</Card>
```

The rows aren't even available to the component: `TenantFile` is passed only
`listingsSentPending: boolean` (the C4 slice STATUS), not the `ListingSendRow[]` itself
(`ContactDetail.tsx:374` passes `listingsSentPending={file.listingsSent.status !== 'ready'}`).
So the backend slice loads (`getContactListingsSent` → `GET /api/contacts/:id/listings-sent`
returns `{ sent: [...] }`, `endpoints.ts:463`), but the card discards it.

**Evidence (2026-06-30, live `--mock --local`).** Broadcast an available unit to a tenant
(records a `listing_send` row). Then:
- `GET /api/contacts/<id>/listings-sent` → `{ "sent": [{ contactId, unitId, via:'broadcast', response:'no_reply', ... }] }` (data IS there).
- The contact **timeline** shows a "Property sent" item linking to `/listings/<unitId>` (a SEPARATE code path that works).
- The dedicated **"Properties sent" card** still reads "No properties sent yet."

So the send is visible in the timeline but the card that exists to summarize it is a stub.

**Impact.** Low — the timeline and the broadcast Results page both surface sends; this is a
redundant summary card. But it's misleading (reads as "nothing sent" when properties were).

**Fix sketch.** Thread the `ListingSendRow[]` (already fetched in the C4 slice) through to
`TenantFile` and render one `Row` per send (label = unit address, `to={/listings/<unitId>}`),
mirroring the adjacent **Tours**/**Placements** cards which already map their arrays. Add a
`files.test.tsx` case asserting a sent row renders.

**Note.** Discovered during the sending-unit e2e conformance audit. NOT a blocker for that
suite — the scenarios assert listing delivery via the fake-twilio thread (proof-of-send),
the `listings-sent` API, and the timeline "Property sent" item, none of which depend on this
card. Filed for follow-up.

**Resolution (2026-06-30).** Threaded the `ListingSendRow[]` through to `TenantFile`
(`ContactDetail` now passes `listingsSent` alongside `listingsSentPending`) and gave the
"Properties sent" card a row-rendering branch — one `Row` per send linking to
`/listings/<unitId>` with the tenant's response (Interested / Not a fit / No reply), plus a
count `aside`, mirroring the adjacent Tours/Placements cards. Pending → `PendingPanel`,
ready-but-empty → "No properties sent yet.", ready-with-rows → the rows. Backed by a new
`files.test.tsx` case (sent row renders + links + shows the response) and an empty-state
case; dashboard typecheck + 255 contact tests green.
