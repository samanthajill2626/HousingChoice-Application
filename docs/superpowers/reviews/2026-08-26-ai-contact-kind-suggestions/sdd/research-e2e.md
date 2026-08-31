# E2E research - AI contact-kind suggestions

## Live seam

- `e2e/tests/flows/conversation-fact-extraction.spec.ts:21-75` logs into the hermetic dashboard, generates a unique phone, and discovers the inbound-created Unknown contact through the authenticated `/api/contacts?type=unknown` query. The `NEXT` default is only a fallback; suite execution injects a non-lane-0 URL.
- `e2e/fixtures/extraction.ts:4-61` documents the deterministic `EXTRACTION_DRIVER=fake` contract. `sendExtractSms` carries any `Partial<ExtractionResult>` as `EXTRACT:<json>` through the real signed inbound webhook and `extractionTick` drives `POST /__dev/extraction/tick`; no real model or production data is involved.
- `conversation-fact-extraction.spec.ts:268-294` is the current Tenant-only type-suggestion flow. It locates the Needs triage section, asserts `AI suggests: Tenant`, clicks `Mark as Tenant`, and waits for the action to disappear.
- `conversation-fact-extraction.spec.ts:296-325` contains the established Today queue proof: navigate back to `/`, use `expectTodayReady`, scope to the `AI suggestions to review` list, identify a contact by formatted phone, and assert no raw contact ID leaks.

## Required extension shape

1. Add fresh Unknown Partner and Property Manager cases beside the existing type flow; use `sendExtractSms` values `partner` / `property_manager` with note lines and invoke `extractionTick`.
2. Add authenticated API helpers for contact and conversation reads so assertions pin Partner `{ type: 'partner', status: 'active' }` plus `partner_1to1`, and Property Manager `{ type: 'landlord', role: 'Property Manager', status: 'interested' }` plus `landlord_1to1`.
3. Scope the UI assertions to `Needs triage`, assert all four accessible actions, click the exact new action, then prove the action disappears and the formatted phone has left the Today suggestion group.

## QA guardrails

- Run tests only through the e2e workspace command; full suite and interactive session must not overlap.
- Interactive self-QA uses `npm run e2e:session`, its resolved lane, dev login, and `npm run e2e:stop`; never use lane-0 dashboard or app ports.
- Narrow-width action wrapping needs a browser measure/screenshot in `.playwright-mcp/`, not a production or live-dashboard check.
