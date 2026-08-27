import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  type APIRequestContext,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  sendAsParty,
  listThreads,
  registerParty,
  type FakeThread,
} from '../../fixtures/fakeTwilio.js';
import { dashboardUrl, fakeUrl } from '../../support/urls.js';
import { expectNoHorizontalOverflow } from '../../support/viewport.js';
// The single source of truth for automated-message copy. Import the PURE catalog
// module (no repo/AWS deps) so the media-only relay body is asserted against the
// catalog default rather than a hard-coded string.
import { MESSAGE_CATALOG } from '../../../app/src/messages/catalog.js';
import { expectTodayReady } from '../../support/today.js';

// Outbound MMS - attach + send media everywhere staff send SMS (design Sec 12).
// Drives the REAL dashboard composer against the hermetic lane stack and proves
// the feature end to end:
//   (a) a 1:1 contact send with a device-uploaded image: the fake thread records
//       an outbound leg carrying a (presigned) media URL AND the timeline renders
//       the sent attachment through the authed serve pipeline (media_attachments).
//   (b) a team group MMS: both member fake threads receive legs WITH media.
//   (c) a member's inbound photo forwards to the OTHER member WITH media.
//   (d) a media-only team group send delivers legs whose body is the
//       relay.media_only catalog copy ("<name> sent an attachment.").
//   (e) the composer attach control is usable at 360px with no horizontal overflow.
const NEXT = dashboardUrl;

// The 5-byte-ish valid PNG fixture Playwright's file picker uploads (a real file
// is required; the fake never fetches outbound media - a valid URL is enough).
const FIXTURE_PNG = fileURLToPath(new URL('../../fixtures/tiny.png', import.meta.url));

// --- 1:1 target (present in both lean + full seed) ---------------------------
const TASHA = '+15550100001'; // contact-tenant-0001's primary number
const TASHA_ID = 'contact-tenant-0001';

// --- Live relay group constants (app/src/lib/seed/live.ts, full profile) ------
const CONV_ID = 'conv-live-relay-group';
const POOL = '+15550160001';
const DIANA_ID = 'contact-live-tenant-a';
const DIANA_PHONE = '+15550170001'; // Diana Osei (tenant)
const GLORIA_PHONE = '+15550170003'; // Gloria Mensah (landlord)
const INBOX_LABEL = 'With Diana Osei & Gloria Mensah';

// The relay.media_only default is "{name} sent an attachment."; a media-only
// relay leg body must match that copy with SOME non-empty sender name. Building
// the matcher from the catalog (not a literal) keeps the assertion honest if the
// copy is edited.
const MEDIA_ONLY_TEMPLATE = MESSAGE_CATALOG['relay.media_only'].default; // "{name} sent an attachment."
const MEDIA_ONLY_SUFFIX = MEDIA_ONLY_TEMPLATE.replace('{name}', '').trim(); // "sent an attachment."

async function devLogin(page: Page): Promise<void> {
  await page.goto(`${NEXT}/`);
  await page.getByRole('button', { name: /Continue as dev user/i }).click();
  // EXACT. The Today page's own group heading is "Tours today", so the loose
  // name matches TWO headings the moment any tour lands in that group and the
  // wait fails on a strict-mode violation rather than on anything this spec is
  // about. Same correction ba1df280 already made in the group-text specs.
  await expectTodayReady(page);
}

/** Attach the fixture image on the shared composer and wait for the upload to
 *  finish (Send re-enables only when nothing is uploading). Optionally type a
 *  body first (a 1:1 send needs body OR attachments; a media-only send does not). */
async function attachFixtureAndArmSend(page: Page, body?: string): Promise<void> {
  if (body !== undefined) {
    await page.getByRole('textbox', { name: 'Reply message' }).fill(body);
  }
  // The input is visually hidden (srOnly) but setInputFiles drives it directly.
  await page.locator('#mms-attach-input').setInputFiles(FIXTURE_PNG);
  // The chip appears immediately (aria-busy while uploading); wait for the upload
  // to complete via the Send button re-enabling (disabled while hasUploading).
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 20_000 });
}

interface ViewerTransform {
  scale: number;
  x: number;
  y: number;
}

interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readViewerScale(page: Page): Promise<number> {
  const raw = await page
    .locator('[data-image-viewer-scale]')
    .getAttribute('data-image-viewer-scale');
  const scale = Number(raw);
  if (raw === null || !Number.isFinite(scale)) throw new Error(`invalid viewer scale: ${raw}`);
  return scale;
}

async function readViewerTransform(page: Page): Promise<ViewerTransform> {
  const output = page.locator('[data-image-viewer-scale]');
  const [scaleRaw, xRaw, yRaw] = await Promise.all([
    output.getAttribute('data-image-viewer-scale'),
    output.getAttribute('data-image-viewer-x'),
    output.getAttribute('data-image-viewer-y'),
  ]);
  const transform = {
    scale: Number(scaleRaw),
    x: Number(xRaw),
    y: Number(yRaw),
  };
  if (
    scaleRaw === null ||
    xRaw === null ||
    yRaw === null ||
    !Number.isFinite(transform.scale) ||
    !Number.isFinite(transform.x) ||
    !Number.isFinite(transform.y)
  ) {
    throw new Error(`invalid viewer transform: ${scaleRaw}/${xRaw}/${yRaw}`);
  }
  return transform;
}

async function startViewerScaleRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ownedWindow = window as typeof window & {
      __hcViewerScaleObserver?: MutationObserver;
      __hcViewerScaleSamples?: number[];
    };
    ownedWindow.__hcViewerScaleObserver?.disconnect();
    const output = document.querySelector<HTMLElement>('[data-image-viewer-scale]');
    if (output === null) throw new Error('viewer scale diagnostic not found');
    const record = (): void => {
      const value = Number(output.dataset.imageViewerScale);
      if (!Number.isFinite(value)) throw new Error('invalid viewer scale diagnostic');
      ownedWindow.__hcViewerScaleSamples?.push(value);
    };
    ownedWindow.__hcViewerScaleSamples = [];
    record();
    ownedWindow.__hcViewerScaleObserver = new MutationObserver(record);
    ownedWindow.__hcViewerScaleObserver.observe(output, {
      attributes: true,
      attributeFilter: ['data-image-viewer-scale'],
    });
  });
}

async function readViewerScaleSamples(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const ownedWindow = window as typeof window & { __hcViewerScaleSamples?: number[] };
    return [...(ownedWindow.__hcViewerScaleSamples ?? [])];
  });
}

async function expectRecordedScalesWithinBounds(page: Page, phase: string): Promise<void> {
  const samples = await readViewerScaleSamples(page);
  expect(samples.length, `${phase} recorded no scale mutations`).toBeGreaterThan(0);
  for (const scale of samples) {
    expect(scale, `${phase} transient scale fell below fit`).toBeGreaterThanOrEqual(1);
    expect(scale, `${phase} transient scale exceeded cap`).toBeLessThanOrEqual(8);
  }
}

async function requireBox(locator: Locator, label: string): Promise<ElementBox> {
  const box = await locator.boundingBox();
  expect(box, `${label} has no layout box`).not.toBeNull();
  return box!;
}

async function expectViewerImageOverlapsCanvas(
  dialog: Locator,
  canvas: Locator,
  imageName: string,
  phase: string,
): Promise<void> {
  const [canvasBox, imageBox] = await Promise.all([
    requireBox(canvas, `${phase} canvas`),
    requireBox(dialog.getByRole('img', { name: imageName }), `${phase} image`),
  ]);
  const horizontalOverlap =
    Math.min(canvasBox.x + canvasBox.width, imageBox.x + imageBox.width) -
    Math.max(canvasBox.x, imageBox.x);
  const verticalOverlap =
    Math.min(canvasBox.y + canvasBox.height, imageBox.y + imageBox.height) -
    Math.max(canvasBox.y, imageBox.y);
  expect(horizontalOverlap, `${phase} lost all image pixels horizontally`).toBeGreaterThan(0);
  expect(verticalOverlap, `${phase} lost all image pixels vertically`).toBeGreaterThan(0);
}

async function dispatchCtrlWheel(
  surface: Locator,
  deltaY: number,
  point: { x: number; y: number },
): Promise<void> {
  await surface.dispatchEvent('wheel', {
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: true,
    deltaY,
    clientX: point.x,
    clientY: point.y,
  });
}

async function touchDrag(
  session: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1, radiusX: 5, radiusY: 5 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: to.x, y: to.y, id: 1, radiusX: 5, radiusY: 5 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function markViewerTrigger(
  trigger: Locator,
  marker: string,
): Promise<void> {
  await trigger.evaluate((element, triggerMarker) => {
    (element as HTMLElement).dataset.e2eViewerTrigger = triggerMarker;
  }, marker);
}

/** Outbound legs on a member's fake thread that carry at least one media URL. */
function outboundMediaLegs(threads: FakeThread[], party: string) {
  const thread = threads.find((t) => t.partyNumber === party);
  return (thread?.messages ?? []).filter(
    (m) => m.direction === 'outbound' && (m.mediaUrls?.length ?? 0) > 0,
  );
}

test.describe('Outbound MMS - 1:1 contact composer', () => {
  test('(a) attach + send an image: the fake records media AND the timeline renders it', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let openedPages = 0;
    page.context().on('page', () => {
      openedPages += 1;
    });
    const token = `mms-1to1-${Date.now()}`;

    // Establish an open 1:1 conversation (an inbound from the tenant), exactly as
    // the comms round-trip spec does, so the composer has a single send target.
    await sendAsParty(request, { from: TASHA, body: `starting a thread ${token}` });

    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    // Upload from device via the REAL file input, then send with a text body.
    await attachFixtureAndArmSend(page, token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // (i) Proof of send: the tenant's fake thread has an outbound leg carrying a
    //     presigned media URL (the app presigns per attempt and passes it to the
    //     Twilio driver, which the fake records).
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const thread = threads.find((t) => t.partyNumber === TASHA);
          return (
            thread?.messages.some(
              (m) =>
                m.direction === 'outbound' &&
                (m.body ?? '').includes(token) &&
                (m.mediaUrls?.length ?? 0) > 0,
            ) ?? false
          );
        },
        { timeout: 20_000, message: 'no outbound media leg recorded on the tenant fake thread' },
      )
      .toBe(true);

    // (ii) The sent attachment renders in the timeline through the AUTHED serve
    //      endpoint (media_attachments bubble). Assert the image element is present
    //      AND actually loaded bytes (naturalWidth > 0) - proof the private-bucket
    //      serve pipeline streamed the uploaded object back.
    const timeline = page.getByRole('region', { name: 'Communications and activity' });
    const img = timeline.getByRole('img', { name: 'Attachment 1' }).last();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 20_000,
        message: 'the sent attachment image never loaded (authed serve pipeline)',
      })
      .toBeGreaterThan(0);

    // Open from the real Timeline only after arranging both scroll owners. This
    // makes the provider capture distinct, nonzero AppFrame + Timeline values.
    const trigger = timeline.getByRole('button', { name: 'View Attachment 1' }).last();
    const beforeUrl = page.url();
    await trigger.scrollIntoViewIfNeeded();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const expectedScroll = await trigger.evaluate((element) => {
      const appFrame = element.closest('main');
      if (!(appFrame instanceof HTMLElement)) throw new Error('AppFrame main not found');
      const routeRoot = appFrame.firstElementChild;
      if (!(routeRoot instanceof HTMLElement)) throw new Error('AppFrame route root not found');
      routeRoot.style.minHeight = `${appFrame.clientHeight + 500}px`;

      let timelineStream: HTMLElement | null = element.parentElement;
      while (timelineStream !== null && timelineStream !== appFrame) {
        if (/auto|scroll|overlay/.test(getComputedStyle(timelineStream).overflowY)) break;
        timelineStream = timelineStream.parentElement;
      }
      if (timelineStream === null || timelineStream === appFrame) {
        throw new Error('Timeline stream not found');
      }
      if (timelineStream.scrollHeight <= timelineStream.clientHeight) {
        timelineStream.style.maxHeight = '180px';
      }
      if (timelineStream.scrollHeight <= timelineStream.clientHeight) {
        throw new Error('Timeline stream could not be made scrollable');
      }

      appFrame.dataset.viewerTestAppframe = 'true';
      timelineStream.dataset.viewerTestTimeline = 'true';
      element.scrollIntoView({ block: 'center' });
      appFrame.scrollTop = Math.min(20, appFrame.scrollHeight - appFrame.clientHeight);
      timelineStream.scrollTop = Math.min(
        Math.max(10, timelineStream.scrollTop),
        timelineStream.scrollHeight - timelineStream.clientHeight,
      );
      if (appFrame.scrollTop === 0 || timelineStream.scrollTop === 0) {
        throw new Error('named scroll owners were not arranged away from zero');
      }
      const box = element.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= innerHeight) throw new Error('trigger is not visible');
      return {
        appFrame: { top: appFrame.scrollTop, left: appFrame.scrollLeft },
        timeline: { top: timelineStream.scrollTop, left: timelineStream.scrollLeft },
      };
    });
    const focusProbeMarker = `desktop-${token}`;
    await markViewerTrigger(trigger, focusProbeMarker);
    const openedTrigger = page.locator(
      `[data-e2e-viewer-trigger="${focusProbeMarker}"]`,
    );

    await trigger.click();
    expect(openedPages).toBe(0);
    const dialog = page.getByRole('dialog', { name: 'Attachment 1' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-modal-variant="media"]')).toHaveCSS('z-index', '200');
    expect(page.url()).toBe(beforeUrl);

    const close = dialog.getByRole('button', { name: 'Close' });
    const download = dialog.getByRole('link', { name: 'Download' });
    const heading = dialog.getByRole('heading', { name: 'Attachment 1' });
    const canvas = dialog.locator('[data-image-viewer-canvas="true"]');
    const viewerImage = dialog.getByRole('img', { name: 'Attachment 1' });
    await expect(close).toBeVisible();
    await expect(download).toBeVisible();
    await expect(canvas).toBeVisible();
    await expect(viewerImage).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button', { name: /Zoom|Reset|Previous|Next/i })).toHaveCount(0);

    const [dialogBox, canvasBox, headingBox, downloadBox, closeBox, imageBox] = await Promise.all([
      requireBox(dialog, 'desktop dialog'),
      requireBox(canvas, 'desktop canvas'),
      requireBox(heading, 'desktop heading'),
      requireBox(download, 'desktop Download'),
      requireBox(close, 'desktop Close'),
      requireBox(viewerImage, 'desktop fitted image'),
    ]);
    expect(dialogBox.width).toBeGreaterThanOrEqual(1280 * 0.75);
    expect(dialogBox.height).toBeGreaterThanOrEqual(900 * 0.75);
    expect(canvasBox.width).toBeGreaterThanOrEqual(dialogBox.width - 4);
    expect(canvasBox.height).toBeGreaterThanOrEqual(900 * 0.6);
    const lowestActionBottom = Math.max(
      headingBox.y + headingBox.height,
      downloadBox.y + downloadBox.height,
      closeBox.y + closeBox.height,
    );
    expect(canvasBox.y).toBeGreaterThanOrEqual(lowestActionBottom - 1);
    expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(
      dialogBox.y + dialogBox.height + 1,
    );
    expect(imageBox.x).toBeGreaterThanOrEqual(canvasBox.x - 1);
    expect(imageBox.y).toBeGreaterThanOrEqual(canvasBox.y - 1);
    expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height + 1);
    expect(Math.abs(imageBox.x + imageBox.width / 2 - (canvasBox.x + canvasBox.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBox.y + imageBox.height / 2 - (canvasBox.y + canvasBox.height / 2))).toBeLessThanOrEqual(1);
    await expect(viewerImage).toHaveCSS('object-fit', 'contain');
    await expect(page.locator('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '1.000',
    );

    // Discrete mouse-wheel zoom uses multiple levels, remains pointer anchored,
    // and never reports even a transient scale outside the hard 1..8 contract.
    const pointer = {
      x: canvasBox.x + canvasBox.width * 0.72,
      y: canvasBox.y + canvasBox.height * 0.38,
    };
    await page.mouse.move(pointer.x, pointer.y);
    await startViewerScaleRecorder(page);
    const wheelScales: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const previous = await readViewerScale(page);
      await page.mouse.wheel(0, -80);
      await expect.poll(() => readViewerScale(page)).toBeGreaterThan(previous);
      wheelScales.push(await readViewerScale(page));
    }
    expect(wheelScales[0]).toBeGreaterThan(1);
    expect(wheelScales[1]).toBeGreaterThan(wheelScales[0]!);
    expect(wheelScales[2]).toBeGreaterThan(wheelScales[1]!);
    expect(wheelScales[2]).toBeLessThan(8);
    const anchored = await readViewerTransform(page);
    expect(Math.abs(anchored.x) + Math.abs(anchored.y)).toBeGreaterThan(0);

    for (let index = 0; index < 45 && (await readViewerScale(page)) < 8; index += 1) {
      await page.mouse.wheel(0, -80);
    }
    await expect.poll(() => readViewerScale(page)).toBe(8);
    await page.mouse.wheel(0, -80);
    await expect.poll(() => readViewerScale(page)).toBe(8);
    await expectRecordedScalesWithinBounds(page, 'desktop discrete wheel');

    // Pan to every boundary at high zoom; each extreme must leave real pixels
    // intersecting the inspection canvas on both axes.
    const panTargets = [
      { x: -4000, y: pointer.y, label: 'desktop pan left bound' },
      { x: 5000, y: pointer.y, label: 'desktop pan right bound' },
      { x: pointer.x, y: -4000, label: 'desktop pan top bound' },
      { x: pointer.x, y: 5000, label: 'desktop pan bottom bound' },
    ];
    for (const target of panTargets) {
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 12 });
      await page.mouse.up();
      await expectViewerImageOverlapsCanvas(dialog, canvas, 'Attachment 1', target.label);
    }

    const scrollWhileOpen = await page.evaluate(() => {
      const appFrame = document.querySelector<HTMLElement>('[data-viewer-test-appframe]');
      const timelineStream = document.querySelector<HTMLElement>('[data-viewer-test-timeline]');
      if (appFrame === null || timelineStream === null) throw new Error('named scroll owner missing');
      return {
        appFrame: { top: appFrame.scrollTop, left: appFrame.scrollLeft },
        timeline: { top: timelineStream.scrollTop, left: timelineStream.scrollLeft },
      };
    });
    expect(scrollWhileOpen).toEqual(expectedScroll);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(openedTrigger).toBeFocused();
    expect(page.url()).toBe(beforeUrl);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const appFrame = document.querySelector<HTMLElement>('[data-viewer-test-appframe]');
          const timelineStream = document.querySelector<HTMLElement>('[data-viewer-test-timeline]');
          if (appFrame === null || timelineStream === null) {
            throw new Error('named scroll owner missing after dismissal');
          }
          return {
            appFrame: { top: appFrame.scrollTop, left: appFrame.scrollLeft },
            timeline: { top: timelineStream.scrollTop, left: timelineStream.scrollLeft },
          };
        }),
      )
      .toEqual(expectedScroll);

    // Small Ctrl-wheel deltas model trackpad pinch separately from discrete wheel.
    await openedTrigger.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '1.000',
    );
    const ctrlCanvas = dialog.locator('[data-image-viewer-canvas="true"]');
    const ctrlSurface = ctrlCanvas.locator('.react-transform-wrapper');
    await expect(ctrlSurface).toBeVisible();
    const ctrlBox = await requireBox(ctrlCanvas, 'desktop Ctrl-wheel canvas');
    const ctrlPoint = { x: ctrlBox.x + ctrlBox.width / 2, y: ctrlBox.y + ctrlBox.height / 2 };
    await startViewerScaleRecorder(page);
    await dispatchCtrlWheel(ctrlSurface, 1, ctrlPoint);
    await expect.poll(() => readViewerScale(page)).toBe(1);
    const ctrlScales: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const previous = await readViewerScale(page);
      await dispatchCtrlWheel(ctrlSurface, -1, ctrlPoint);
      await expect.poll(() => readViewerScale(page)).toBeGreaterThan(previous);
      ctrlScales.push(await readViewerScale(page));
    }
    expect(ctrlScales[0]).toBeGreaterThan(1);
    expect(ctrlScales[1]).toBeGreaterThan(ctrlScales[0]!);
    expect(ctrlScales[2]).toBeGreaterThan(ctrlScales[1]!);
    expect(ctrlScales[2]).toBeLessThan(8);
    for (let index = 0; index < 45 && (await readViewerScale(page)) < 8; index += 1) {
      await dispatchCtrlWheel(ctrlSurface, -1, ctrlPoint);
    }
    await expect.poll(() => readViewerScale(page)).toBe(8);
    await dispatchCtrlWheel(ctrlSurface, -1, ctrlPoint);
    await expect.poll(() => readViewerScale(page)).toBe(8);
    for (let index = 0; index < 45 && (await readViewerScale(page)) > 1; index += 1) {
      await dispatchCtrlWheel(ctrlSurface, 1, ctrlPoint);
    }
    await expect.poll(() => readViewerScale(page)).toBe(1);
    await dispatchCtrlWheel(ctrlSurface, 1, ctrlPoint);
    await expect.poll(() => readViewerScale(page)).toBe(1);
    await expectRecordedScalesWithinBounds(page, 'desktop Ctrl-wheel');

    await close.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '1.000',
    );
    await close.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The contact file's media index opens the same shared shell, but with its
    // deliberately generic accessible image name.
    const mediaCard = page.getByRole('heading', { name: 'Media from comms' }).locator('..');
    const galleryTrigger = mediaCard.getByRole('button', { name: 'View image attachment' }).first();
    await expect(galleryTrigger).toBeVisible({ timeout: 20_000 });
    await galleryTrigger.scrollIntoViewIfNeeded();
    await galleryTrigger.click();
    const galleryDialog = page.getByRole('dialog', { name: 'Image attachment' });
    await expect(galleryDialog).toBeVisible();
    await expect(galleryDialog.locator('[data-image-viewer-canvas="true"]')).toBeVisible();
    await expect(galleryDialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(galleryDialog.getByRole('link', { name: 'Download' })).toBeVisible();
    await expect(galleryDialog.getByRole('img', { name: 'Image attachment' })).toBeVisible({
      timeout: 20_000,
    });
    await galleryDialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('(f) the mobile viewer fills the viewport and Back closes after pinch and pan', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const session = await page.context().newCDPSession(page);
    const token = `mms-mobile-viewer-${Date.now()}`;
    await sendAsParty(request, { from: TASHA, body: `starting a mobile thread ${token}` });

    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);
    const commsPane = page.getByRole('button', { name: 'Comms', exact: true });
    await expect(commsPane).toHaveAttribute('aria-pressed', 'true');
    await attachFixtureAndArmSend(page, token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const mobileTimeline = page.getByRole('region', { name: 'Communications and activity' });
    const trigger = mobileTimeline.getByRole('button', { name: 'View Attachment 1' }).last();
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    const beforeUrl = page.url();
    const focusProbeMarker = `mobile-${token}`;
    await markViewerTrigger(trigger, focusProbeMarker);
    const openedTrigger = page.locator(
      `[data-e2e-viewer-trigger="${focusProbeMarker}"]`,
    );
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('Attachment 1');

    const longFilename = `${'a'.repeat(2048)}.png`;
    await dialog.getByRole('heading').evaluate((heading, value) => {
      heading.textContent = value;
    }, longFilename);
    await expect(dialog).toHaveAccessibleName(longFilename);

    const [dialogBox, viewport, closeBox, downloadBox] = await Promise.all([
      requireBox(dialog, 'mobile dialog'),
      page.evaluate(() => ({
        width: window.visualViewport?.width ?? innerWidth,
        height: window.visualViewport?.height ?? innerHeight,
      })),
      requireBox(dialog.getByRole('button', { name: 'Close' }), 'mobile Close'),
      requireBox(dialog.getByRole('link', { name: 'Download' }), 'mobile Download'),
    ]);
    expect(Math.abs(dialogBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialogBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialogBox.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialogBox.height - viewport.height)).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page, 'image viewer at 360px');

    for (const [box, label] of [
      [closeBox, 'Close'],
      [downloadBox, 'Download'],
    ] as const) {
      expect(box.x, `${label} starts outside the dialog`).toBeGreaterThanOrEqual(dialogBox.x - 1);
      expect(box.y, `${label} starts outside the viewport`).toBeGreaterThanOrEqual(dialogBox.y - 1);
      expect(box.x + box.width, `${label} ends outside the dialog`).toBeLessThanOrEqual(
        dialogBox.x + dialogBox.width + 1,
      );
      expect(box.y + box.height, `${label} ends outside the viewport`).toBeLessThanOrEqual(
        dialogBox.y + dialogBox.height + 1,
      );
    }

    const canvas = dialog.locator('[data-image-viewer-canvas="true"]');
    await expect(canvas).toBeVisible();
    const viewerImage = dialog.getByRole('img', { name: 'Attachment 1' });
    await expect(viewerImage).toBeVisible({ timeout: 20_000 });
    const canvasBox = await requireBox(canvas, 'mobile viewer canvas');
    expect(Math.abs(canvasBox.width - dialogBox.width)).toBeLessThanOrEqual(2);
    expect(canvasBox.height).toBeGreaterThan(viewport.height / 2);
    expect(canvasBox.y).toBeGreaterThanOrEqual(
      Math.max(closeBox.y + closeBox.height, downloadBox.y + downloadBox.height) - 1,
    );
    expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(
      dialogBox.y + dialogBox.height + 1,
    );

    const center = {
      x: Math.round(canvasBox.x + canvasBox.width / 2),
      y: Math.round(canvasBox.y + canvasBox.height / 2),
    };
    await startViewerScaleRecorder(page);
    await session.send('Input.synthesizePinchGesture', {
      x: center.x,
      y: center.y,
      scaleFactor: 0.5,
      relativeSpeed: 800,
      gestureSourceType: 'touch',
    });
    await expect.poll(() => readViewerScale(page)).toBe(1);

    await session.send('Input.synthesizePinchGesture', {
      x: center.x,
      y: center.y,
      scaleFactor: 1.25,
      relativeSpeed: 800,
      gestureSourceType: 'touch',
    });
    await expect.poll(() => readViewerScale(page)).toBeGreaterThan(1);
    const firstPinchScale = await readViewerScale(page);
    await session.send('Input.synthesizePinchGesture', {
      x: center.x,
      y: center.y,
      scaleFactor: 1.25,
      relativeSpeed: 800,
      gestureSourceType: 'touch',
    });
    await expect.poll(() => readViewerScale(page)).toBeGreaterThan(firstPinchScale);
    const secondPinchScale = await readViewerScale(page);
    expect(secondPinchScale).toBeLessThan(8);

    for (let index = 0; index < 8 && (await readViewerScale(page)) < 8; index += 1) {
      await session.send('Input.synthesizePinchGesture', {
        x: center.x,
        y: center.y,
        scaleFactor: 2,
        relativeSpeed: 800,
        gestureSourceType: 'touch',
      });
    }
    await expect.poll(() => readViewerScale(page)).toBe(8);
    await session.send('Input.synthesizePinchGesture', {
      x: center.x,
      y: center.y,
      scaleFactor: 2,
      relativeSpeed: 800,
      gestureSourceType: 'touch',
    });
    await expect.poll(() => readViewerScale(page)).toBe(8);
    await expectRecordedScalesWithinBounds(page, 'mobile pinch');

    const beforeDrag = await readViewerTransform(page);
    await touchDrag(session, center, { x: center.x + 60, y: center.y + 35 });
    await expect
      .poll(async () => {
        const after = await readViewerTransform(page);
        return Math.abs(after.x - beforeDrag.x) + Math.abs(after.y - beforeDrag.y);
      })
      .toBeGreaterThan(0);
    const afterDrag = await readViewerTransform(page);
    expect(afterDrag.scale).toBeGreaterThanOrEqual(1);
    expect(afterDrag.scale).toBeLessThanOrEqual(8);
    await expectViewerImageOverlapsCanvas(dialog, canvas, 'Attachment 1', 'mobile touch drag');

    const boundaryDrags = [
      { x: -4000, y: center.y, label: 'mobile pan left bound' },
      { x: 4000, y: center.y, label: 'mobile pan right bound' },
      { x: center.x, y: -4000, label: 'mobile pan top bound' },
      { x: center.x, y: 4000, label: 'mobile pan bottom bound' },
    ];
    for (const target of boundaryDrags) {
      await touchDrag(session, center, target);
      await expectViewerImageOverlapsCanvas(dialog, canvas, 'Attachment 1', target.label);
    }

    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(page.url()).toBe(beforeUrl);
    await expect(commsPane).toHaveAttribute('aria-pressed', 'true');
    await expect(openedTrigger).toBeVisible();
    await expect(openedTrigger).toBeFocused();

    await openedTrigger.click();
    const reopened = page.getByRole('dialog', { name: 'Attachment 1' });
    await expect(reopened).toBeVisible();
    await expect(page.locator('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '1.000',
    );
    await reopened.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('(e) the attach control is usable at 360px with no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await devLogin(page);
    await page.goto(`${NEXT}/contacts/${TASHA_ID}`);

    // Mobile lands on the Comms pane (a Comms/Profile toggle; "Details" lives under
    // Profile), so gate readiness on the composer's attach affordance itself - the
    // thing under test - which the mobile composer renders inline.
    const attach = page.getByRole('button', { name: 'Attach a file' });
    await expect(attach).toBeVisible({ timeout: 15_000 });
    const box = await attach.boundingBox();
    expect(box, 'attach button has no layout box').not.toBeNull();
    // Its right edge sits within the viewport (not clipped off-screen).
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);

    // Nothing scrolls sideways at 360px. Uses the shared helper, which measures
    // the routed `<main>` as well as the document - a hand-rolled
    // documentElement check is VACUOUS in this shell, because AppFrame clamps
    // the document to the viewport (`html, body, #root { height: 100% }` plus
    // `.main { min-width: 0 }`) and hands scrolling to an inner
    // `.content { overflow-y: auto }` box. Wide route content therefore scrolls
    // INSIDE <main> and the document never moves, so the old assertion here
    // could not fail. See docs/issues/e2e-documentelement-overflow-check-vacuous.md.
    await expectNoHorizontalOverflow(page, 'composer at 360px');
  });
});

test.describe('Outbound MMS - relay group media both directions', () => {
  /** Reseed FULL so the live relay group (full-profile only) exists. */
  async function reseedFull(request: APIRequestContext): Promise<void> {
    const res = await request.post(`${NEXT}/__dev/reseed?profile=full`);
    expect(res.ok(), `full reseed failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  }

  test.beforeEach(async ({ request }) => {
    await reseedFull(request);
  });

  // Restore the lean baseline the rest of the suite expects.
  test.afterAll(async ({ request }) => {
    const res = await request.post(`${NEXT}/__dev/reseed`);
    expect(res.ok(), `lean restore reseed failed: ${res.status()}`).toBeTruthy();
  });

  test('(b) team group MMS: both member fake threads receive legs WITH media', async ({
    page,
    request,
  }) => {
    const token = `relay-mms-${Date.now()}`;

    await devLogin(page);
    await page.goto(`${NEXT}/conversations/${CONV_ID}`);
    await expect(page.getByText(INBOX_LABEL)).toBeVisible();

    // Team send WITH text + an attachment through the group composer.
    await attachFixtureAndArmSend(page, token);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(token)).toBeVisible({ timeout: 15_000 });

    const conversationPane = page.getByRole('button', {
      name: 'Conversation',
      exact: true,
      includeHidden: true,
    });
    await expect(conversationPane).toHaveAttribute('aria-pressed', 'true');
    const sentBubble = page.getByText(token, { exact: true }).last().locator('..');
    const viewerTrigger = sentBubble.getByRole('button', { name: 'View Attachment 1' });
    await expect(viewerTrigger).toBeVisible({ timeout: 20_000 });
    await viewerTrigger.click();
    const relayDialog = page.getByRole('dialog', { name: 'Attachment 1' });
    await expect(relayDialog).toBeVisible();
    await expect(relayDialog.locator('[data-image-viewer-canvas="true"]')).toBeVisible();
    await expect(relayDialog.getByRole('img', { name: 'Attachment 1' })).toBeVisible({
      timeout: 20_000,
    });
    await relayDialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(INBOX_LABEL)).toBeVisible();
    await expect(conversationPane).toHaveAttribute('aria-pressed', 'true');

    // Each member's fake thread gets exactly this run's leg carrying media (the
    // fan-out re-presigns the hub attachment per leg). A unique token isolates
    // this run from any leftover legs on the persistent fake threads.
    for (const memberPhone of [DIANA_PHONE, GLORIA_PHONE]) {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(request);
            const thread = threads.find((t) => t.partyNumber === memberPhone);
            return (
              thread?.messages.some(
                (m) =>
                  m.direction === 'outbound' &&
                  m.from === POOL &&
                  (m.body ?? '').includes(token) &&
                  (m.mediaUrls?.length ?? 0) > 0,
              ) ?? false
            );
          },
          { timeout: 20_000, message: `no media leg fanned out to ${memberPhone}` },
        )
        .toBe(true);
    }
  });

  test('(c) a member photo forwards to the OTHER member WITH media', async ({ request }) => {
    const token = `member-photo-${Date.now()}`;

    // Diana must be a known party on the fake before she can send-as-party.
    await registerParty(request, { label: 'Diana Osei', role: 'tenant', number: DIANA_PHONE });

    // Diana texts the POOL a photo (a canned raster the app's inbound mirror
    // allowlists + mirrors to our bucket). The relay fan-out forwards it to the
    // other member (Gloria) - re-presigning the mirrored key per leg.
    await sendAsParty(request, {
      from: DIANA_PHONE,
      to: POOL,
      body: `here is a photo ${token}`,
      mediaUrls: [`${fakeUrl}/canned/room.png`],
    });

    // Gloria's fake thread receives the forwarded leg FROM the pool, carrying the
    // token body (Diana's attribution prefix rides along) AND media.
    await expect
      .poll(
        async () => {
          const threads = await listThreads(request);
          const thread = threads.find((t) => t.partyNumber === GLORIA_PHONE);
          return (
            thread?.messages.some(
              (m) =>
                m.direction === 'outbound' &&
                m.from === POOL &&
                (m.body ?? '').includes(token) &&
                (m.mediaUrls?.length ?? 0) > 0,
            ) ?? false
          );
        },
        { timeout: 20_000, message: 'the member photo was not forwarded to the other member' },
      )
      .toBe(true);
  });

  test('(d) a media-only team send delivers the relay.media_only catalog body', async ({
    page,
    request,
  }) => {
    // Snapshot the media-only legs already on each thread (the fake threads persist
    // across reseeds) so we assert THIS run added a NEW one - a media-only send has
    // no text token to isolate on.
    const before = await listThreads(request);
    const beforeCount = (party: string): number =>
      outboundMediaLegs(before, party).filter((m) => (m.body ?? '').includes(MEDIA_ONLY_SUFFIX))
        .length;
    const dianaBefore = beforeCount(DIANA_PHONE);
    const gloriaBefore = beforeCount(GLORIA_PHONE);

    await devLogin(page);
    await page.goto(`${NEXT}/conversations/${CONV_ID}`);
    await expect(page.getByText(INBOX_LABEL)).toBeVisible();

    // Media-only: attach WITHOUT typing a body; Send arms on the attachment alone.
    await attachFixtureAndArmSend(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Each member gets a NEW leg whose body is the media_only catalog copy
    // ("<name> sent an attachment.") AND carries media.
    const mediaOnlyMatch = new RegExp(`^.+ ${escapeRegExp(MEDIA_ONLY_SUFFIX)}$`);
    for (const [memberPhone, prior] of [
      [DIANA_PHONE, dianaBefore],
      [GLORIA_PHONE, gloriaBefore],
    ] as const) {
      await expect
        .poll(
          async () => {
            const threads = await listThreads(request);
            return outboundMediaLegs(threads, memberPhone).filter((m) =>
              mediaOnlyMatch.test(m.body ?? ''),
            ).length;
          },
          {
            timeout: 20_000,
            message: `no NEW media-only catalog leg fanned out to ${memberPhone}`,
          },
        )
        .toBeGreaterThan(prior);
    }
  });
});

/** Escape a literal string for use inside a RegExp (mirrors the scenarios helper). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
