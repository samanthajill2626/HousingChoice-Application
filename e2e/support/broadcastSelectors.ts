import type { Locator, Page } from '@playwright/test';

// Reads on the broadcast results page (/broadcasts/:broadcastId), shared by the
// specs that assert on it. Moved here from broadcasts.spec.ts unchanged when a
// second file needed them (send-outcome-reconcile.spec.ts), so the two
// collision rules below live in ONE place:
//
// - The StatChips labels repeat recipient-row text. "Sent", "Delivered",
//   "Failed" and, since send-outcome-reconcile (D22), "Not confirmed" are both
//   a chip <dt> AND a DeliveryBadge label on a recipient row, so an unscoped
//   getByText is a strict-mode violation - or, worse, a vacuous pass. Chip reads
//   go through statValue (scoped to the "Delivery stats" <dl>); row reads are
//   scoped to getByRole('list', { name: 'Recipients' }).
// - The lifecycle pill shares its label with a chip: "Sent" is always a chip
//   <dt>, so a bare page-level getByText('Sent') passes whether or not the pill
//   ever flipped. statusPill scopes to the results <header>.

/**
 * Read one StatChips value by its label. The chips render as a
 * <dl aria-label="Delivery stats"> of <div><dt>{label}</dt><dd>{value}</dd></div>;
 * scope to that dl (so a recipient DeliveryBadge like "Sent"/"Delivered" can't
 * collide) and match the label's <dt> EXACTLY, then read its sibling <dd>.
 * Call it once the chips are on screen (wait on getByLabel('Delivery stats')):
 * before that the read waits for the element to attach.
 */
export async function statValue(page: Page, label: string): Promise<number> {
  const chip = page
    .getByLabel('Delivery stats')
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) });
  const text = (await chip.locator('dd').textContent()) ?? '';
  return Number(text.trim());
}

/**
 * The lifecycle pill, scoped to the results <header> (the one holding the page
 * h1). Scoping matters: the StatChips row ALWAYS renders a "Sent" <dt>, so a
 * bare page-level getByText('Sent') can match the chip label and pass VACUOUSLY
 * even if the pill never flipped.
 */
export function statusPill(page: Page, label: string): Locator {
  return page
    .locator('header')
    .filter({ has: page.getByRole('heading', { level: 1 }) })
    .getByText(label, { exact: true });
}
