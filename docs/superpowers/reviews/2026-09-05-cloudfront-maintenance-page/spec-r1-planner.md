# Spec round 1 - planner source sweep

## P1 - HIGH: Mapping 503 changes existing typed refusal behavior

The initial spec says already-open dashboards retain their API error behavior while replacing every 503 body with HTML. Retaining a status does not preserve the machine-readable error contract.

Evidence: `dashboard/src/routes/contact/CreateRelayGroupModal.tsx:128` names two typed pre-provisioning refusals. `safeToRetry` at line 159 requires both status 503 and the typed code; the catch at line 351 sends other errors to `maybeCreated`. `app/src/routes/relayGroups.ts:492` and line 497 emit the two 503 bodies. `dashboard/src/routes/settings/useNotifications.ts:100` also requires `push_not_configured` to disable unavailable controls. `dashboard/src/api/client.ts:69` replaces a non-JSON body's code with `http_<status>`.

Consequence: a refused create would incorrectly enter the uncertain-creation screen, and missing push configuration would become a generic error. Neither is necessary to replace the reported gateway timeout screen.

Proposed correction: map only 502 and 504. Preserve all 503 responses and their bodies. The current source search of `app/src` finds no application-produced 502/504 HTTP response contract; the create UI already treats those gateway failures as ambiguous (`CreateRelayGroupModal.tsx:144`, tests at `CreateRelayGroupModal.test.tsx:830`). Require the static mapping guard to reject 503 entries and preserve existing typed-refusal tests. Update counts, acceptance cases, and operational caveats consistently.
