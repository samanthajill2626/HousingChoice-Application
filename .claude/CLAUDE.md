## Claude Code

## Terminology (read before naming domain concepts)

One entity, three labels by audience. The "single dwelling a single household can
lease and move into" is **always `unit` in code/data**. Human-facing copy uses:

- **Tenant →** "home"
- **Landlord →** "listing"
- **Staff / navigator (dashboard) →** "listing"
- **Code / data / internal →** "unit" (`unitId`, `unitsRepo`, `UnitItem`)

`unit` is the HUD/Section 8 term and is **structure-agnostic** (a house, townhome,
or apartment is all a "dwelling unit") — it is not apartment-specific. Do **not**
use "property" for this entity (in PM systems a property is the *parent* of units);
normalize stray "property" wording that means a single dwelling back to `unit`.
Keep `listing_link` / "public listing" (the external listing URL) and the
JS object-property sense of "property" as-is.

Full rationale, the audience→noun table, and the future-AI mapping:
[documentation/GLOSSARY.md](../documentation/GLOSSARY.md). Update it in the same
change whenever you add a domain noun or fix drift.

## UI testing & verification (self-QA UI changes — don't hand them to the human)

This repo has a Playwright end-to-end harness so you can drive the real dashboard
and API yourself. **After changing any UI or user-facing flow, verify it with the
harness before claiming the work is done** — and add/extend a spec for new behavior.

- **Full suite** (boots a hermetic stack, runs, tears down): `npm run e2e`.
- **Interactive inner loop:** `npm run e2e:session` (persistent stack) + the
  Playwright **MCP** to navigate/click/snapshot/screenshot the live UI. After a
  backend change run `npm run e2e:restart` (app+worker only; the browser keeps its
  page); `npm run e2e:reseed` for a clean slate; `npm run e2e:stop` to end.
- **Dev-only, hermetic-LOCAL-only helpers** the harness exposes (gated OFF in every
  deployed env — never reachable in prod): `POST /auth/dev-login` (log in as seeded
  `va@example.com`, no Google), `GET /__dev/outbox` (assert what SMS *would* have
  been sent), `POST /__dev/reseed`, `GET /__dev/ping`.
- Write specs with accessibility-first selectors (`getByRole`/`getByLabel`) — see
  [e2e/support/selectors.md](../e2e/support/selectors.md). Requires Docker (DynamoDB Local).
- The Playwright MCP is registered in [.mcp.json](../.mcp.json) (`--browser
  chromium`; the chrome channel needs admin on Windows).

Full workflow, modes, and how to add tests: **[e2e/README.md](../e2e/README.md)**.
