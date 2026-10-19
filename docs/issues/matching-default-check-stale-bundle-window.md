---
id: matching-default-check-stale-bundle-window
title: A dashboard tab open across the matching-blast-rules deploy keeps the old default-check rule, so tour-held tenants start checked
type: bug
severity: med
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: app/src/routes/broadcasts.ts:815, app/src/routes/broadcasts.ts:1087-1090, dashboard/src/routes/broadcasts/RecipientPreview.tsx:142-143, dashboard/src/App.tsx, app/test/broadcastApi.test.ts:3838, docs/issues/optional-call-outcome-breaks-already-loaded-bundles.md
---

**Problem.** `feat/matching-blast-rules` (tracker #6) moves the Review
recipients default-check rule to the server: the preview computes
`checkedByDefault` for every candidate (`app/src/routes/broadcasts.ts:815`)
and sends it with the tenant's `tourHold` (`:1087-1090`), and the new bundle
starts each row from it (`dashboard/src/routes/broadcasts/RecipientPreview.tsx:142-143`).
A tab still running the PRE-deploy bundle recomputes the old rule locally,
with no tour input: main's `defaultChecked` (`RecipientPreview.tsx:99` on
main, applied at `:132` and by Select all at `:244`) is
`hasConsent && (seeded || (!alreadySent && !declined))`.

Trigger: staff have the dashboard open on the old bundle; the deploy rolls the
image (API and dashboard ship together); in the SAME tab staff open Send a
property and Preview. The new server answers a tour-held tenant with
`tourHold` and `checkedByDefault: false`; the old bundle checks the row anyway;
Send posts the checked ids through send path (a), which by design never
re-applies holds (pinned by `app/test/broadcastApi.test.ts:3838`, "(PIN) path
(a), the explicit list the dashboard sends, is unchanged: a checked held or
declined tenant is sent"). Effect, until that tab is reloaded: tour-held
tenants start checked and are texted if staff send what is shown, and the tab
shows the new server's "Reaches N" (the default-checked count) beside a list
that checks more than N. Routes are imported statically
(`dashboard/src/App.tsx`), the SPA never reloads itself, and `dashboard/src`
has no build-version check.

Not a regression against the pre-deploy product - the old tab behaves exactly
as it did before the deploy, old UI and old rule - but the feature's central
rule (held tenants listed unchecked) does not hold for the length of the
window, and the same window opens on every deploy that moves a client-computed
rule to the server. It is the already-loaded-bundle class recorded in
[optional-call-outcome-breaks-already-loaded-bundles](./optional-call-outcome-breaks-already-loaded-bundles.md).

Post-merge mitigation (in the branch's handback post-merge notes): reload
every open dashboard tab after the deploy.

Code review R1 ADV-1
(`docs/superpowers/reviews/2026-10-14-matching-blast-rules/code-review/r1-adversarial.md`),
ruled FILE in `r1-adjudications.md` (same folder): a version handshake is a
new cross-cutting protocol beyond the spec.

**Suggested fix.** The review's options, narrowest first:

- Operational: a RUNBOOK release step to reload open dashboards after every
  deploy.
- Targeted: the dashboard sends a marker on `POST /api/broadcasts/:id/preview`
  (a body field such as `clientRules: 1`, or a header); the server answers 409
  `reload_required` when it is absent, so a stale bundle shows an error (the
  old composer prints `err.message`) instead of a list built on the old rule.
  Regression test: a preview without the marker is 409 `reload_required` and
  serves no candidates; with it, 200. A marker covers this window only if it
  ships in the same deploy as the rule move.
- Broader: a build-id handshake - the server stamps the image tag on
  responses, and the dashboard compares it with its own and asks for a
  reload. This is the precedent issue's build-stamp check; it closes the
  whole class.
