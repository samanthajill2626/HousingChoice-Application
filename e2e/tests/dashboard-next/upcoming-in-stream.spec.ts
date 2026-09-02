// The Upcoming block rides INSIDE the message stream (supersession spec 3.6,
// acceptances 13-16). Unit tests cannot prove any of this: jsdom performs no
// layout, so every anchor assertion there runs against a hand-built geometry
// model. This is the only place the real arithmetic is exercised by an engine
// that lays out.
//
// HOST: a TOUR-OWNED relay group driven through /conversations/:id, i.e.
// ConversationDetail. That is the one production render site that carries BOTH
// a non-empty Upcoming bucket and the "New messages" pill - GroupTextView
// passes `upcoming={[]}` and cannot exercise acceptance 16, and the contact
// comms pane has no relay thread. The tour's ladder is what fills the bucket:
// routes/relayGroups.ts returns the group-routed pending rungs for the owner
// tour, so the block is live data, not a fixture.
//
// dashboard-next dialect (e2e/support/selectors.md): a local NEXT const, a local
// devLogin, raw page.request for setup, accessibility-first locators, no
// Scenario verbs. Self-clean isolation - every contact / property / tour is
// minted fresh, so NOTHING here reseeds and the lean world stays byte-stable.
//
// WHY THE ASSERTIONS ARE GEOMETRIC. Playwright's toBeVisible() means "has a
// non-empty box and is not display:none/visibility:hidden" - an element scrolled
// out of an overflow container is still VISIBLE by that definition. "Below the
// fold" therefore has to be measured: the block's box against the scroller's
// box. Same reason the "does this box scroll at all" probe is explicit
// (scrollHeight > clientHeight + 1): a thread shorter than the viewport has
// nothing to scroll and correctly shows the block, which would make every
// assertion below pass for the wrong reason.
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { registerParty, sendAsParty } from '../../fixtures/fakeTwilio.js';
import { driveConnectingGroupToOpen } from '../../fixtures/relayConnect.js';
import { NARROW_360, WIDE_RESTORE } from '../../support/viewport.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** How many inbound legs the fixture posts. Enough that the stream overflows a
 *  360x800 phone several times over, so "the block is below the fold" is a
 *  statement about the anchor and not about a short thread. */
const PROBE_MESSAGES = 12;

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  await expectTodayReady(page);
}

/** A run-unique E.164 - never a seeded number. */
function freshPhone(): string {
  return `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
}

interface Party {
  contactId: string;
  phone: string;
}

async function createContact(
  request: APIRequestContext,
  type: 'tenant' | 'landlord',
  firstName: string,
): Promise<Party> {
  const phone = freshPhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type,
      firstName,
      lastName: 'Ustream',
      phone,
      ...(type === 'tenant' && { voucherSize: 2 }),
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const contactId = ((await res.json()) as { contact: { contactId: string } }).contact.contactId;
  return { contactId, phone };
}

/** An AVAILABLE property owned by `landlordId`. The reminder bodies compose from
 *  its address, so a property with none would leave the bucket empty. */
async function createAvailableUnit(request: APIRequestContext, landlordId: string): Promise<string> {
  const line1 = `${`${Date.now()}`.slice(-6)} Upcoming Stream Way NW`;
  const res = await request.post(`${NEXT}/api/units`, {
    data: {
      landlordId,
      accepted_authorities: ['atlanta_housing'],
      beds: 2,
      rent_min: 1500,
      rent_max: 1600,
      address: { line1, city: 'Atlanta', state: 'GA', zip: '30314' },
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const unitId = ((await res.json()) as { unit: { unitId: string } }).unit.unitId;
  const pub = await request.patch(`${NEXT}/api/units/${unitId}/listing-status`, {
    data: { toStatus: 'available', source: 'manual' },
  });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  return unitId;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** boundingBox() with a message. It returns null only for a box-less element
 *  (display:none), never for one merely scrolled out of an overflow container -
 *  which is the whole point of measuring rather than asserting visibility. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${what} has no box - it is not rendered at all`).not.toBeNull();
  return box!;
}

test.describe('Upcoming block inside the scrolling stream', () => {
  test('a relay thread opens on the newest message, scrolls to the block, and pills only from above', async ({
    page,
  }) => {
    // The masked-relay connect-when-ready handshake (buy -> register -> open) is
    // multi-hop async and rides on top of a build-a-world walk plus a dozen
    // inbound legs, so this test gets an explicit, generous budget.
    test.setTimeout(240_000);
    await devLogin(page);
    const req = page.request;
    const stamp = `${Date.now()}`.slice(-6);

    // --- The world: a scheduled tour with a live ladder and a relay group ----
    const landlord = await createContact(req, 'landlord', `Usll${stamp}`);
    const unitId = await createAvailableUnit(req, landlord.contactId);
    const tenant = await createContact(req, 'tenant', `Usten${stamp}`);
    // Four days out: far enough that the whole ladder is still in the future
    // whatever the org's quiet-hours window does to a same-week rung, so the
    // bucket is non-empty for structural reasons rather than by luck.
    const scheduledAt = new Date(Date.now() + 96 * 3_600_000).toISOString();
    const tourRes = await req.post(`${NEXT}/api/tours`, {
      data: { tenantId: tenant.contactId, unitId, scheduledAt, tourType: 'landlord_led' },
    });
    expect(tourRes.ok(), await tourRes.text()).toBeTruthy();
    const tourId = ((await tourRes.json()) as { tour: { tourId: string } }).tour.tourId;

    // The REAL masked relay group through the real route (auto-resolved roster =
    // [tenant, the property's landlord]).
    const relayRes = await req.post(`${NEXT}/api/tours/${tourId}/relay`, { data: {} });
    expect(relayRes.status(), await relayRes.text()).toBe(201);
    const relay = (await relayRes.json()) as {
      conversation: { conversationId: string; status?: string; pool_number?: string };
    };
    const conversationId = relay.conversation.conversationId;
    let poolNumber = relay.conversation.pool_number ?? '';
    if (relay.conversation.status === 'connecting') {
      poolNumber = (await driveConnectingGroupToOpen(req, conversationId)).pool_number;
    }
    expect(poolNumber, 'the tour group must be open on a pool number').not.toBe('');

    // A dozen inbound legs from the tenant so the stream genuinely overflows a
    // phone. Sent BEFORE the page opens, so the thread is already long when the
    // conversation-switch anchor runs - which is the acceptance-13 case.
    await registerParty(req, { label: `Usten${stamp}`, role: 'tenant', number: tenant.phone });
    await registerParty(req, { label: `Usll${stamp}`, role: 'landlord', number: landlord.phone });
    for (let i = 0; i < PROBE_MESSAGES; i += 1) {
      await sendAsParty(req, {
        from: tenant.phone,
        to: poolNumber,
        body: `stream probe ${i} ${stamp}`,
      });
    }
    const newest = `stream probe ${PROBE_MESSAGES - 1} ${stamp}`;

    // --- Open the thread on the narrow phone (spec acceptance 14) -----------
    await page.setViewportSize(NARROW_360);
    try {
      await page.goto(`${NEXT}/conversations/${conversationId}`);

      // Reached by CSS-module class, unavoidably: the scroll container is a
      // plain <div> with no accessible role of its own. Vite scopes CSS-module
      // locals as `_<local>_<hash>_<line>`, so `_stream_` (note the trailing
      // underscore) matches `.stream` and NOT `.streamWrap`, its non-scrolling
      // flex parent. Same idiom and same reason as
      // thread-history-paging.spec.ts.
      const stream = page.locator('[class*="_stream_"]');
      await expect(stream).toHaveCount(1, { timeout: 30_000 });
      const upcoming = page.getByRole('region', { name: 'Upcoming scheduled messages' });
      const pill = page.getByRole('button', { name: 'Jump to the newest messages' });

      // The tour's ladder reaches this thread: the block exists in the DOM.
      // (Existence, not visibility - it is below the fold, which is the claim.)
      await expect(upcoming).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText(newest)).toHaveCount(1, { timeout: 30_000 });

      // --- 1. AT REST: the newest message, not the block -------------------
      // The scroller really scrolls. Without this the rest is vacuous: a thread
      // shorter than the viewport has nothing to scroll and shows everything.
      await expect
        .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight), {
          timeout: 20_000,
          message: 'the stream never overflowed - the fixture is too short to prove anything',
        })
        .toBeGreaterThan(1);

      const restStream = await boxOf(stream, 'the stream');
      const restNewest = await boxOf(page.getByText(newest), 'the newest message');
      const restBlock = await boxOf(upcoming, 'the Upcoming region');
      expect(
        restNewest.y + restNewest.height,
        'the thread did not open on the newest message',
      ).toBeLessThanOrEqual(restStream.y + restStream.height + 1);
      expect(
        restNewest.y,
        'the newest message is above the top of the stream',
      ).toBeGreaterThanOrEqual(restStream.y - 1);
      expect(
        restBlock.y,
        'the Upcoming block is in the viewport at rest - the thread opened ON it',
      ).toBeGreaterThanOrEqual(restStream.y + restStream.height - 1);
      await expect(pill).toHaveCount(0);

      // --- 2. Scrolling down reveals it; scrolling back up hides it ---------
      await stream.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(
          async () => {
            const s = await boxOf(stream, 'the stream');
            const b = await boxOf(upcoming, 'the Upcoming region');
            return b.y - (s.y + s.height);
          },
          { timeout: 10_000, message: 'scrolling to the bottom never revealed the block' },
        )
        .toBeLessThan(0);

      await stream.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect
        .poll(
          async () => {
            const s = await boxOf(stream, 'the stream');
            const b = await boxOf(upcoming, 'the Upcoming region');
            return b.y - (s.y + s.height);
          },
          { timeout: 10_000, message: 'scrolling back up never hid the block' },
        )
        .toBeGreaterThanOrEqual(0);

      // --- 3. An inbound while standing ON the block (acceptance 15) --------
      // Back to the true bottom, where the block fills the fold.
      await stream.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
          timeout: 10_000,
        })
        .toBeLessThanOrEqual(2);
      const onBlock = await boxOf(upcoming, 'the Upcoming region');
      const beforeGap = await stream.evaluate((el) => el.scrollHeight - el.scrollTop);

      const whileOnBlock = `stream probe on-block ${stamp}`;
      await sendAsParty(req, { from: landlord.phone, to: poolNumber, body: whileOnBlock });
      await expect(page.getByText(whileOnBlock)).toHaveCount(1, { timeout: 30_000 });

      // THE PROMISE is that the block does not move under the operator's eye.
      // Note the mechanism: `scrollTop` is NOT held constant - holding it would
      // let the new message push the block DOWN by its own height, which is the
      // yank the anchor exists to prevent. What is held constant is the distance
      // to the scroller's TRUE bottom (spec 3.6's `below` row), so `scrollTop`
      // moves by exactly the growth and the block stays put on screen.
      // Tolerance 2px: scrollHeight is integer-rounded while Chromium holds a
      // fractional scrollTop.
      await expect
        .poll(
          async () => {
            const b = await boxOf(upcoming, 'the Upcoming region');
            return Math.abs(b.y - onBlock.y);
          },
          { timeout: 10_000, message: 'the Upcoming block moved out from under the operator' },
        )
        .toBeLessThanOrEqual(2);
      const afterGap = await stream.evaluate((el) => el.scrollHeight - el.scrollTop);
      expect(
        Math.abs(afterGap - beforeGap),
        `distance from the true bottom moved: ${beforeGap} -> ${afterGap}`,
      ).toBeLessThanOrEqual(2);
      // Nothing is hidden from them, so nothing announces itself.
      await expect(pill).toHaveCount(0);

      // --- 4. An inbound while scrolled ABOVE the sentinel (acceptance 16) --
      await stream.evaluate((el) => {
        el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
      });
      await expect
        .poll(async () => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
          timeout: 10_000,
        })
        .toBeGreaterThan(2);

      const whileAbove = `stream probe above ${stamp}`;
      await sendAsParty(req, { from: landlord.phone, to: poolNumber, body: whileAbove });
      await expect(pill).toBeVisible({ timeout: 30_000 });

      await pill.click();
      await expect(pill).toHaveCount(0, { timeout: 10_000 });
      const landedStream = await boxOf(stream, 'the stream');
      const landedNewest = await boxOf(page.getByText(whileAbove), 'the newest message');
      const landedBlock = await boxOf(upcoming, 'the Upcoming region');
      expect(
        landedNewest.y + landedNewest.height,
        'the pill did not land on the newest message',
      ).toBeLessThanOrEqual(landedStream.y + landedStream.height + 1);
      expect(
        landedBlock.y,
        'the pill delivered the operator to the Upcoming block instead of the newest message',
      ).toBeGreaterThanOrEqual(landedStream.y + landedStream.height - 1);
    } finally {
      // Pairing is mandatory: playwright.config.ts runs workers:1 and
      // fullyParallel:false, so a narrow viewport left behind is the NEXT
      // spec's problem (e2e/support/viewport.ts).
      await page.setViewportSize(WIDE_RESTORE);
    }
  });
});
