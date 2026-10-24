/**
 * The Today-page readiness assertion - ONE definition of "the dashboard is up",
 * shared by every sign-in helper and every mid-test navigation back to `/`.
 *
 * WHY A SHARED MODULE. This assertion was copy-pasted into 60 call sites across
 * 54 files, and 41 of those copies were WRONG in the same way:
 *
 *   await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
 *
 * `getByRole` name matching is a SUBSTRING match by default, so that locator
 * also matches the Today page's own `Tours today` heading (an <h3> under the
 * "At a glance" <h2> since tracker #31; an <h2> before it). The page renders
 * that group whenever a tour is scheduled for the current day - at which point
 * the locator resolves to TWO elements and Playwright's strict mode throws
 * rather than guessing.
 *
 * The failure that produces is unusually expensive to diagnose:
 *   - it fires during SIGN-IN, so the test dies before touching its subject and
 *     the error names none of what the spec was written to check;
 *   - it depends on LANE state, not on the failing spec - one spec leaving a
 *     tour on today's date breaks whichever innocent spec runs next;
 *   - so the failing set shifts between runs and goes away on a re-run in
 *     isolation, which reads exactly like flaky infrastructure.
 *
 * That was mis-blamed on a feature branch on 2026-08-19 (three unrelated specs,
 * a different three on the serial re-run, all green alone). About a dozen specs
 * had already been patched to `exact: true` individually over the preceding
 * months - each fixing its own symptom and leaving the trap set everywhere else.
 * The selector living in one place is the actual fix; see
 * docs/issues/today-heading-selector-ambiguity.md.
 *
 * Deliberately NOT a `signIn(page)` helper. The suite has several legitimate
 * ways in (the dev-user button, a POST to /auth/dev-login, a persona login) plus
 * plain navigations back to `/` mid-test - collapsing those would flatten real
 * differences. What every one of them shares is this one assertion.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { dashboardUrl } from './urls.js';

/**
 * The Today landing page has rendered. `exact: true` is load-bearing - see the
 * module header. `timeout` overrides the default for the slower entries (a
 * cold-boot sign-in behind a reseed).
 */
export async function expectTodayReady(page: Page, opts?: { timeout?: number }): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible(
    opts?.timeout !== undefined ? { timeout: opts.timeout } : undefined,
  );
}

/** The accessible name of the OPENED AI suggestions list (tracker #31). */
export const AI_SUGGESTIONS_LIST = 'AI suggestions';

/**
 * A Today section's list. Since tracker #31 (spec
 * docs/superpowers/specs/2026-10-23-today-checklist-design.md section 2,
 * plan PR33, PR102) every list's accessible name is its section heading
 * (headings carry no count), so the match is exact: 'Needs you now',
 * 'Identify these contacts', 'Past tours needing an outcome', 'Tours to book',
 * 'Quiet shares', 'Relay groups to close', 'Placements', and under At a glance
 * 'Tours today'.
 */
export function todayList(page: Page, name: string): Locator {
  return page.getByRole('list', { name, exact: true });
}

/** The `<section>` around that list (its nearest section ancestor), which
 *  holds the heading, the help line and the Show all / Show fewer button. */
export function todaySection(page: Page, name: string): Locator {
  return todayList(page, name).locator('xpath=ancestor::section[1]');
}

/**
 * Every Today section shows its first 5 rows; past that a "Show all N"
 * button expands it in place. A spec whose row can sit past the fifth (a
 * shared lane it does not reseed, an oldest-first order where its row is the
 * newest) expands the section first. A no-op when the section has 5 or fewer.
 */
export async function showAllIn(page: Page, name: string): Promise<void> {
  await expect(todayList(page, name)).toBeVisible({ timeout: 10_000 });
  const more = todaySection(page, name).getByRole('button', { name: /^Show all \d+/ });
  if ((await more.count()) > 0) await more.click();
}

/** The At a glance AI line: ONE collapsed button (spec 2.4). */
export function aiSuggestionsLine(page: Page): Locator {
  return page.getByRole('button', { name: /^AI suggestions for \d+ contacts?$/ });
}

/**
 * Opens the AI line (when collapsed) and returns its list. The list is not
 * in the accessibility tree until the line is open, so never count rows on
 * it without this. The worlds that call it hold at most 5 AI contacts, so no
 * Show all is needed.
 */
export async function openAiSuggestions(page: Page): Promise<Locator> {
  const line = aiSuggestionsLine(page);
  await expect(line).toBeVisible({ timeout: 10_000 });
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('list', { name: AI_SUGGESTIONS_LIST, exact: true });
  await expect(list).toBeVisible();
  return list;
}

interface TodayWireRow {
  group: string;
  refType: string;
  refId: string;
}

/**
 * The contact has no AI suggestions row on Today - asserted on server truth
 * first (GET /api/today; a non-200 throws, so a failed read never passes),
 * then on a freshly loaded page: when the server holds NO AI rows at all the
 * line itself must be ABSENT (tracker #31: the list is hidden until opened,
 * so a zero count on it would be vacuous); otherwise the line must name the
 * server's count and the opened list must hold no row matching `rowText`.
 * Leaves the page on Today.
 */
export async function expectNoAiSuggestionFor(page: Page, contactId: string, rowText: string): Promise<void> {
  let aiIds: string[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${dashboardUrl}/api/today`);
        if (res.status() !== 200) throw new Error(`GET /api/today: ${res.status()} ${await res.text()}`);
        const { items } = (await res.json()) as { items: TodayWireRow[] };
        aiIds = items.filter((i) => i.group === 'ai_suggestions').map((i) => i.refId);
        return aiIds.includes(contactId);
      },
      { timeout: 10_000, message: `contact ${contactId} still has an AI suggestions row on Today` },
    )
    .toBe(false);
  const loaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/today' && r.status() === 200,
  );
  await page.goto(`${dashboardUrl}/`);
  await loaded;
  await expectTodayReady(page);
  // The response has landed; the page spinner (mounted before the fetch went
  // out) is gone only once the page has rendered it, so an absence below
  // cannot pass on a page that has not drawn the queue yet.
  await expect(page.getByRole('main').getByRole('status', { name: 'Loading', exact: true })).toHaveCount(0, {
    timeout: 10_000,
  });
  if (aiIds.length === 0) {
    await expect(aiSuggestionsLine(page)).toHaveCount(0);
    return;
  }
  await expect(aiSuggestionsLine(page)).toHaveAccessibleName(
    `AI suggestions for ${aiIds.length} ${aiIds.length === 1 ? 'contact' : 'contacts'}`,
  );
  const list = await openAiSuggestions(page);
  await expect(list.getByRole('listitem')).toHaveCount(Math.min(aiIds.length, 5));
  await expect(list.getByRole('listitem').filter({ hasText: rowText })).toHaveCount(0);
}
