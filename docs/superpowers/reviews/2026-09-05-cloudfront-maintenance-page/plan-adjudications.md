# Maintenance plan adjudications

Date: 2026-09-07
Plan: docs/superpowers/plans/2026-09-07-cloudfront-maintenance-page.md
Spec: docs/superpowers/specs/2026-09-05-cloudfront-maintenance-page-design.md
R1 baseline: f5ce2556

## R1 decisions

- A1 HIGH - ACCEPT. e2e/support/viewport.guard.test.ts:55-70 rejects the proposed inline documentElement measurement. The existing expectNoHorizontalOverflow(page, where) helper in e2e/support/viewport.ts:69-85 measures document and main; S3 now imports it for both original and enlarged text. The static page does not have the dashboard shell's exact vacuity problem, but the enforced source guard still makes the original plan fail.
- A2 MEDIUM - ACCEPT. The mocked preservation assertions omitted the media OAC and default policies. S2 now covers those plus HTTPS/cached methods/compression and proves two new faults: removed media OAC and removed default origin forwarding.
- B1 HIGH - ACCEPT, overlapping A2. The app origin's secret and HTTP configuration are also explicit existing boundaries (infra/modules/cloudfront/main.tf:105-121); S2 now asserts the app custom header, origin settings, and complete existing method/cache/forwarding fields in the selected behaviors.
- B2 MEDIUM - ACCEPT. A module-only validate is not full root-composition proof. The runner now copies only Terraform configuration/template/JSON files, excludes provider caches/state, compares shared stack.tf and outputs.tf, and performs backend-disabled init/validate in both disposable roots using their own lockfiles. It never runs root plan/apply/test or provisioners. Current dev/prod stack.tf comparison exited 0 during planning; the real root validation remains build-time work.
- B3 MEDIUM - ACCEPT. S1 now asserts rendered brand text and the complete viewport meta element from the actual template.
- B4 MEDIUM - ACCEPT. Hostile copy now reaches all five fields; each exact text/title site must contain its fully escaped value. The present template already escaped those fields, but its proof was incomplete.

Counts: 6 findings accepted (5 distinct concerns after overlap); 0 rejected; 0 deferred. The product design and non-goals are unchanged. Continue reviewer B for R2 because B supplied four accepted findings, including the broader parity omission.

## Planner self-review and bounded probes

- The provider-free Terraform console mechanism rendered HTML escaping successfully before drafting. A second console probe confirmed primitive string type comparisons reject number/boolean values and the exact key-set comparison succeeds. No provider, backend, app or cloud was used.
- All four initial HCL code snippets parsed with terraform fmt in an owned temporary directory, and the initial checker .mjs snippet passed node --check. These are syntax/feasibility checks of plan examples, not implementation gates.
- Current dev/prod main.tf values confirm the documented canonical hostnames; stack.tf files are byte-identical and both instantiate ../../modules/cloudfront. Existing source remains unchanged.
- The initial plan passed ASCII and placeholder scans. S1-S4 cover the spec's page/copy, independent infrastructure, preserved status contracts, navigation, and operator proof/rollback. Subsequent review corrections are subject to R2; no implementation or cloud action has started.

## R2 - terminal

- B1 MEDIUM - ACCEPT as precision. The test oracle previously read expected brand/title/body/action from the catalog under test. S1 now asserts the full literal five-key object already required by the approved spec, then retains the rendering assertions. This does not change what gets built, add/remove a surface, or move an invariant; it makes the existing exact-copy requirement explicit in its test oracle.

R1's corrections were reviewed and no remaining R1 defect was reported. R2 changes no design or implementation decision, so this precision-only round is terminal under the feature-mission stop rule. The canonical-object assertion is folded into the plan. No further review round is required by that rule.

Totals across plan rounds: 7 findings accepted (6 distinct concerns after overlap), 0 rejected, 0 deferred. No unresolved finding remains. The plan is ready for the explicit AUTO/MANUAL launch gate; no build, merge, deployment, AWS mutation or cleanup has been performed.

The revised R1 HCL snippets also parsed with terraform fmt and the revised checker passed node --check in a disposable syntax-probe directory; all five snippet checks exited 0. The R2 precision correction is a literal TypeScript expected-value object and was checked for copy/spec identity and ASCII. These remain plan feasibility checks, not feature completion gates.
