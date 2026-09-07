# S1 build report - canonical maintenance page

Date: 2026-09-07
Slice: S1 canonical static page and actual-template rendering

## Delivered

- Added the standalone five-field edge catalog at `app/src/messages/edgeMaintenance.json`.
- Added one self-contained CloudFront Terraform template at `infra/modules/cloudfront/templates/maintenance.html.tftpl`.
- Added `readMaintenanceCopy(): MaintenanceCopy` and `renderMaintenancePage(copy?: MaintenanceCopy): string` in `e2e/support/maintenancePage.ts`.
- Added focused tests for canonical document content, forbidden dependencies, escaping, and malformed copy rejection.

The renderer reads the catalog and actual `.tftpl` source by repository-relative path, writes only an owned temporary `copy.json`, and invokes `terraform console -no-color` with `templatefile(...)`. The focused test passed all three cases through that real Terraform renderer, including the hostile text case and copy-validation cases. The renderer reports a clear error when Terraform cannot run and removes only its verified `hc-maintenance-render-*` scratch directory.

## TDD and checks

- RED: `npm run test -w @housingchoice/e2e -- support/maintenancePage.test.ts` exited 1 because `./maintenancePage.js` was absent. An initial sandboxed invocation also exited 1 before collection because Vite could not create its temporary directory; the permitted re-run produced the expected missing-helper failure.
- GREEN: `npm run test -w @housingchoice/e2e -- support/maintenancePage.test.ts` exited 0: 1 test file passed, 3 tests passed.
- Typecheck: `npm run typecheck -w @housingchoice/e2e` exited 0.

No application message catalog or outbound-message export changed. No dependency was added.
