---
id: e2e-today-heading-selector-ambiguous
title: 38 e2e specs wait on a non-exact "Today" heading that the Today page can match twice
type: debt
severity: med
status: open
area: e2e
created: 2026-08-12
refs: e2e/tests/dashboard-next/outbound-mms.spec.ts:51, dashboard/src/routes/today/Today.tsx:28
---

**Problem.** Most `dashboard-next` specs land their dev-login helper on
`expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()`. That name
is a SUBSTRING match, and the Today page renders its own group heading
`Tours today` (`dashboard/src/routes/today/Today.tsx:28`) whenever a tour falls
in that group. When it does, the locator resolves to two headings and Playwright
fails the wait with a strict-mode violation - in the LOGIN helper, so the spec
reports a failure that has nothing to do with what it tests.

This is time- and state-dependent, not deterministic: the lean seed is
now-relative and specs earlier in a run can create a tour for today, so the same
suite passes for weeks and then fails in one file. It cost one red `npm run e2e`
during fix wave 3 (`outbound-mms.spec.ts`, "(d) a media-only team send delivers
the relay.media_only catalog body"); that one file is now fixed, and 38 others
carry the same latent form.

`exact: true` is already the established correction here - `ba1df280` applied it
to the group-text specs, and `composer-mobile`, `deleted-contact-resurfacing`
and `group-text-stop` carry it today.

**Suggested fix.** Mechanical sweep: `{ name: 'Today' }` ->
`{ name: 'Today', exact: true }` in every `dashboard-next` spec's login helper,
or better, one shared `devLogin` helper in `e2e/support` that every spec calls,
so the selector exists once. Worth doing in a quiet moment rather than inside a
feature branch, because it touches ~38 files that concurrent branches also edit.
