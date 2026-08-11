import { test, expect } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';

// Tenant facets on the Contacts list (spec sections 5/6/10 of
// docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md). Proves the
// promise the feature was built for, end to end against the real backend: pick a
// voucher size AND a housing authority, the list narrows to the tenants matching
// BOTH, the row states the same two facts, and a reload restores the selection
// from the URL.
//
// Self-contained: the lean seed world holds exactly ONE tenant (Tasha, 2-BR /
// atlanta_housing), so nothing in it can make a facet discriminate - the spec
// creates its own three tenants with run-unique names. DCA and Fulton County are
// used by no other spec, so the "exactly one row" assertion is stable in a full
// suite run (other specs' phoneless tenants land in the Not-recorded buckets).
//
// Chip accessible names carry a LIVE COUNT ("2-BR (3)"), and the count moves with
// whatever earlier specs left in the lane - so every chip locator here is a REGEX
// anchored on the label, never an exact string.
//
// NOT covered here, by necessity: the PORTING facet. `porting` is written through
// PATCH /api/contacts/:id/tenant-status (a lifecycle write), not through the
// identity fields `teamCreatesTenant` sets, and lean's one tenant is
// `porting: false` - so `showPorting` is false and the group never renders in a
// lean lane. Adding a status seam for it is out of scope (worklist adjudication
// A18); the porting chip is covered by the component suite and by live self-QA
// against the `full` profile.
const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

// The row separator is U+00B7 with spaces. ONE construction form, in the source
// AND here: String.fromCharCode(0xB7) - never a literal middot, never an HTML
// entity (an entity inside a JS string renders literally as text). Keeps this
// spec's lines ASCII, exactly as selectors.md's em-dash row mandates.
const SEP = ' ' + String.fromCharCode(0xB7) + ' ';

test('tenant facets narrow the list, state the row facts, and survive a reload', async ({
  page,
  request,
}) => {
  test.slow(); // three tenants, each a create dialog PLUS an edit-dialog round trip.
  const flow = new Scenario(page, request);
  const match = freshTenant('FacetMatch'); // 2-BR / DCA  - the single survivor
  const otherSize = freshTenant('FacetSize'); // 3-BR / DCA  - excluded by the voucher facet
  const otherAuth = freshTenant('FacetAuth'); // 2-BR / Fulton County - excluded by the authority facet

  await flow.login();
  for (const t of [
    { who: match, voucherSize: 2, housingAuthority: 'DCA' },
    { who: otherSize, voucherSize: 3, housingAuthority: 'DCA' },
    { who: otherAuth, voucherSize: 2, housingAuthority: 'Fulton County' },
  ]) {
    await flow.teamCreatesTenant({
      firstName: t.who.firstName,
      lastName: t.who.lastName,
      voucherSize: t.voucherSize,
      housingAuthority: t.housingAuthority,
      consent: false, // no phone and nothing is ever sent: skip the consent section.
    });
  }

  await page.goto(`${NEXT}/contacts/tenants`);
  const rows = page.getByRole('list', { name: 'Tenants' }).getByRole('listitem');
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: otherSize.firstName })).toHaveCount(1);
  await expect(rows.filter({ hasText: otherAuth.firstName })).toHaveCount(1);

  // Chips are scoped to their own group: both facets end in a "Not recorded"
  // chip, so an unscoped name would be a strict-mode collision.
  const voucherFacet = page.getByRole('group', { name: 'Voucher size' });
  const authorityFacet = page.getByRole('group', { name: 'Housing authority' });
  const twoBr = voucherFacet.getByRole('button', { name: /^2-BR \(/ });
  const dca = authorityFacet.getByRole('button', { name: /^DCA \(/ });

  await twoBr.click();
  await dca.click();

  // AND across facets: only the 2-BR tenant whose authority is DCA survives.
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);

  // The row states the same two facts, exact (never bucketed - "2 BR", not
  // "2-BR"), joined by the middot, with the full value on `title`.
  const facts = `2 BR${SEP}DCA`;
  const row = rows.first();
  await expect(row.getByText(facts, { exact: true })).toBeVisible();
  await expect(row.getByTitle(facts)).toBeVisible();

  // The URL is the only state carrier (repeated params, normalized authority key).
  await expect(page).toHaveURL(/[?&]voucher=2(&|$)/);
  await expect(page).toHaveURL(/[?&]ha=dca(&|$)/);

  await page.reload();

  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: match.firstName })).toHaveCount(1);
  await expect(twoBr).toHaveAttribute('aria-pressed', 'true');
  await expect(dca).toHaveAttribute('aria-pressed', 'true');
});
