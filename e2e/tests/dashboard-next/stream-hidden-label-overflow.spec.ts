import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectTodayReady } from '../../support/today.js';

// Regression: an inbound Relay bubble carries a visually hidden
// "Delivery by recipient" group (position: absolute). While the scrolling
// .stream was unpositioned, that element's containing block sat OUTSIDE the
// scroller, so it escaped the stream's clip, kept its unscrolled offset, and
// stretched the AppFrame <main> - a third, page-level scrollbar over about one
// stream-height of blank space (seen live on a long placement group thread).
// The page must scroll only inside its panes, never in <main>.

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const RELAY_CONVERSATION = 'conv-live-relay-group';
const MESSAGE_COUNT = 30;

async function reseed(request: APIRequestContext, profile?: 'full'): Promise<void> {
  const suffix = profile === undefined ? '' : `?profile=${profile}`;
  const response = await request.post(`${NEXT}/__dev/reseed${suffix}`);
  expect(response.ok(), `reseed failed: ${response.status()} ${await response.text()}`).toBeTruthy();
}

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

test.beforeEach(async ({ request }) => {
  await reseed(request, 'full');
});

test.afterAll(async ({ request }) => {
  await reseed(request);
});

test('hidden recipient groups in a long relay stream do not scroll the page', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const bodies: string[] = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const body = `Overflow probe ${i} ${stamp}`;
    bodies.push(body);
    const response = await request.post(`${NEXT}/__dev/extraction/message-fixture`, {
      data: {
        conversationId: RELAY_CONVERSATION,
        body,
        createdAt: new Date(stamp - (MESSAGE_COUNT - i) * 60_000).toISOString(),
        direction: 'inbound',
        relaySenderKey: 'contact-live-tenant-a',
        transport: {
          mode: 'versioned',
          actual: 'sms',
          recipients: {
            'contact-live-landlord-a': {
              status: 'delivered',
              requested: 'sms',
              actual: 'sms',
              aggregationState: 'attempted',
            },
          },
        },
      },
    });
    expect(response.ok(), `fixture failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  }

  await page.setViewportSize({ width: 1600, height: 900 });
  await devLogin(page);
  await page.goto(`${NEXT}/conversations/${RELAY_CONVERSATION}`);
  await expect(page.getByText(bodies[MESSAGE_COUNT - 1]!, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Precondition: the hidden groups really render, and the stream really
  // overflows - otherwise a clean <main> would prove nothing.
  await expect
    .poll(async () => page.getByRole('group', { name: /^Delivery by recipient/ }).count())
    .toBeGreaterThanOrEqual(MESSAGE_COUNT);
  const streamOverflow = await page
    .getByText(bodies[0]!, { exact: true })
    .evaluate((el) => {
      let node: HTMLElement | null = el.parentElement;
      while (node !== null && node.tagName !== 'MAIN') {
        const style = getComputedStyle(node);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return node.scrollHeight - node.clientHeight;
        }
        node = node.parentElement;
      }
      return 0;
    });
  expect(streamOverflow, 'the stream should scroll on its own').toBeGreaterThan(200);

  const main = page.getByRole('main');
  await expect
    .poll(async () => main.evaluate((el) => el.scrollHeight - el.clientHeight), {
      message: 'the AppFrame <main> grew a page-level scroll',
    })
    .toBeLessThanOrEqual(0);
});
