import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  APP_NUMBER,
  getOutboundTo,
  postInboundSms,
  postStatusCallback,
} from '../../fixtures/fakeTwilio.js';
import { conversationIdForGroup } from '../../../app/src/lib/import/ids.js';
import { expectTodayReady } from '../../support/today.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';
const DIRECT_CONVERSATION = 'conv-0001';
const DIRECT_CONTACT = 'contact-tenant-0001';
const DIRECT_PHONE = '+15550100001';
const RELAY_CONVERSATION = 'conv-live-relay-group';
const NATIVE_GROUP = conversationIdForGroup(['+15550100001', '+15550100002']);

type Transport = 'sms' | 'mms' | 'rcs';
type AggregationState = 'planned' | 'attempted' | 'excluded';

interface FixtureRecipient {
  status: 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';
  errorCode?: string;
  requested?: Transport;
  actual?: Transport;
  aggregationState?: AggregationState;
}

interface TransportFixtureInput {
  conversationId: string;
  body: string;
  createdAt: string;
  direction: 'inbound' | 'outbound';
  providerSid?: string;
  relaySenderKey?: string;
  transport:
    | { mode: 'legacy' }
    | {
        mode: 'versioned';
        requested?: Transport;
        actual?: Transport;
        recipients?: Record<string, FixtureRecipient>;
      };
}

function providerSid(prefix: 'SM' | 'MM'): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

function displayPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match === null ? e164 : `(${match[1]}) ${match[2]}-${match[3]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

async function plantTransportFixture(
  request: APIRequestContext,
  input: TransportFixtureInput,
): Promise<string> {
  const response = await request.post(`${NEXT}/__dev/extraction/message-fixture`, { data: input });
  expect(
    response.ok(),
    `transport fixture failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
  return (await response.json()).tsMsgId as string;
}

async function revealMessage(page: Page, body: string) {
  const bodyLocator = page.getByText(body, { exact: true });
  await expect(bodyLocator).toBeVisible({ timeout: 15_000 });
  await bodyLocator.click();
  return bodyLocator.locator('..');
}

async function expectTransport(page: Page, body: string, transport: string) {
  const bubble = await revealMessage(page, body);
  await expect(
    bubble.getByText(new RegExp(`^${escapeRegExp(transport)} - `)),
  ).toBeVisible({ timeout: 15_000 });
  return bubble;
}

async function expectNoTransportTransition(bubble: ReturnType<Page['locator']>, requested: string) {
  await expect(bubble.getByText(new RegExp(`^${escapeRegExp(requested)} -> `))).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await reseed(request, 'full');
});

test.afterAll(async ({ request }) => {
  await reseed(request);
});

test('requested and actual carrier transports stay faithful across dashboard message hosts', async ({
  page,
  request,
}) => {
  test.slow();
  const stamp = Date.now();
  const at = (offset: number): string => new Date(stamp + offset).toISOString();

  const callbackBody = `Pending callback transport ${stamp}`;
  const callbackSid = providerSid('SM');
  await plantTransportFixture(request, {
    conversationId: DIRECT_CONVERSATION,
    body: callbackBody,
    createdAt: at(1),
    direction: 'outbound',
    providerSid: callbackSid,
    transport: { mode: 'versioned', requested: 'rcs' },
  });

  const mixedBody = `Complete mixed transport ${stamp}`;
  await plantTransportFixture(request, {
    conversationId: DIRECT_CONVERSATION,
    body: mixedBody,
    createdAt: at(2),
    direction: 'outbound',
    transport: {
      mode: 'versioned',
      requested: 'rcs',
      recipients: {
        'phone#+15550910001': {
          status: 'delivered',
          requested: 'rcs',
          actual: 'rcs',
          aggregationState: 'attempted',
        },
        'phone#+15550910002': {
          status: 'delivered',
          requested: 'rcs',
          actual: 'sms',
          aggregationState: 'attempted',
        },
      },
    },
  });

  const incompleteBody = `Incomplete attempted transport ${stamp}`;
  await plantTransportFixture(request, {
    conversationId: DIRECT_CONVERSATION,
    body: incompleteBody,
    createdAt: at(3),
    direction: 'outbound',
    transport: {
      mode: 'versioned',
      requested: 'rcs',
      recipients: {
        'phone#+15550910003': {
          status: 'delivered',
          requested: 'rcs',
          actual: 'rcs',
          aggregationState: 'attempted',
        },
        'phone#+15550910004': {
          status: 'sent',
          requested: 'rcs',
          aggregationState: 'attempted',
        },
      },
    },
  });

  const excludedBody = `Excluded recipient transport ${stamp}`;
  const excludedPhone = '+15550910005';
  const stateAbsentPhone = '+15550910006';
  const optedOutPhone = '+15550910007';
  await plantTransportFixture(request, {
    conversationId: DIRECT_CONVERSATION,
    body: excludedBody,
    createdAt: at(4),
    direction: 'outbound',
    transport: {
      mode: 'versioned',
      requested: 'rcs',
      recipients: {
        [`phone#${excludedPhone}`]: {
          status: 'queued',
          requested: 'rcs',
          aggregationState: 'excluded',
        },
        [`phone#${stateAbsentPhone}`]: {
          status: 'queued',
          requested: 'rcs',
        },
        [`phone#${optedOutPhone}`]: {
          status: 'failed',
          errorCode: 'contact_opted_out',
          requested: 'rcs',
          aggregationState: 'excluded',
        },
      },
    },
  });

  const inboundRelayBody = `Inbound relay transport ${stamp}`;
  await plantTransportFixture(request, {
    conversationId: RELAY_CONVERSATION,
    body: inboundRelayBody,
    createdAt: at(5),
    direction: 'inbound',
    relaySenderKey: 'contact-live-tenant-a',
    transport: {
      mode: 'versioned',
      actual: 'sms',
      recipients: {
        'contact-live-landlord-a': {
          status: 'delivered',
          requested: 'rcs',
          actual: 'sms',
          aggregationState: 'attempted',
        },
      },
    },
  });

  const inboundSmsBody = `Explicit inbound SMS ${stamp}`;
  const inboundMmsBody = `Explicit inbound MMS ${stamp}`;
  const inboundRcsBody = `Explicit inbound RCS ${stamp}`;
  for (const inbound of [
    { body: inboundSmsBody, sid: providerSid('SM') },
    { body: inboundMmsBody, sid: providerSid('MM') },
    { body: inboundRcsBody, sid: providerSid('SM'), channelMetadata: { type: 'rcs' } },
  ]) {
    const result = await postInboundSms(request, {
      from: DIRECT_PHONE,
      body: inbound.body,
      messageSid: inbound.sid,
      ...(inbound.channelMetadata !== undefined && { channelMetadata: inbound.channelMetadata }),
    });
    expect(result.status, result.body).toBe(200);
  }

  await devLogin(page);
  await page.goto(`${NEXT}/contacts/${DIRECT_CONTACT}`);
  await expect(page.getByRole('region', { name: 'Communications and activity' })).toBeVisible({
    timeout: 15_000,
  });

  // A versioned RCS request stays pending until signed provider evidence arrives.
  const callbackBubble = await expectTransport(page, callbackBody, 'RCS');
  await expectNoTransportTransition(callbackBubble, 'RCS');
  const callbackResult = await postStatusCallback(request, {
    messageSid: callbackSid,
    status: 'delivered',
    from: APP_NUMBER,
    to: DIRECT_PHONE,
  });
  expect(callbackResult.status, callbackResult.body).toBe(200);
  await expect(callbackBubble.getByText(/^RCS -> SMS - /)).toBeVisible({ timeout: 20_000 });

  const mixedBubble = await expectTransport(page, mixedBody, 'RCS -> Mixed');
  const mixedList = mixedBubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(mixedList).toBeVisible();
  await expect(mixedList.getByRole('listitem')).toHaveCount(2);
  await expect(mixedList.getByRole('listitem', { name: / - RCS(?: - |$)/ })).toHaveCount(1);
  await expect(mixedList.getByRole('listitem', { name: /RCS -> SMS/ })).toHaveCount(1);

  const incompleteBubble = await expectTransport(page, incompleteBody, 'RCS');
  await expectNoTransportTransition(incompleteBubble, 'RCS');
  await expect(incompleteBubble).not.toContainText('Mixed');
  await expect(
    incompleteBubble.getByRole('list', { name: 'Delivery by recipient' }).getByRole('listitem'),
  ).toHaveCount(2);

  await expectTransport(page, inboundSmsBody, 'SMS');
  await expectTransport(page, inboundMmsBody, 'MMS');
  await expectTransport(page, inboundRcsBody, 'RCS');
  await expectTransport(page, 'Unresolved inbound fixture.', 'Unknown');
  await expectTransport(page, 'Legacy fixture.', 'SMS');

  const excludedBubble = await expectTransport(page, excludedBody, 'RCS');
  const excludedList = excludedBubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(excludedList.getByRole('listitem')).toHaveCount(2);
  await expect(
    excludedList.getByRole('listitem', {
      name: new RegExp(`^${escapeRegExp(displayPhone(stateAbsentPhone))} - .*RCS`),
    }),
  ).toHaveCount(1);
  await expect(
    excludedList.getByRole('listitem', {
      name: new RegExp(`^${escapeRegExp(displayPhone(optedOutPhone))} - Not sent - opted out - RCS`),
    }),
  ).toHaveCount(1);
  await expect(
    excludedList.getByRole('listitem', {
      name: new RegExp(`^${escapeRegExp(displayPhone(excludedPhone))} - `),
    }),
  ).toHaveCount(0);

  // Hold the real POST so the optimistic carrier row can be inspected before any
  // provider-backed response or refetch replaces it.
  const optimisticBody = `Optimistic proof ${stamp}`;
  let releasePost!: () => void;
  let noteIntercepted!: () => void;
  const postReleased = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const postIntercepted = new Promise<void>((resolve) => {
    noteIntercepted = resolve;
  });
  await page.route(
    new RegExp(`/api/conversations/${DIRECT_CONVERSATION}/messages$`),
    async (route) => {
      noteIntercepted();
      await postReleased;
      await route.continue();
    },
    { times: 1 },
  );
  const sentAfter = new Date().toISOString();
  await page.getByRole('textbox', { name: 'Reply message' }).fill(optimisticBody);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await postIntercepted;
  const optimisticBubble = page.getByText(optimisticBody, { exact: true }).locator('..');
  await expect(optimisticBubble).toBeVisible();
  await expect(optimisticBubble).not.toContainText(/\b(?:SMS|MMS|RCS|Unknown)\b/);
  releasePost();
  await expect
    .poll(
      async () =>
        (await getOutboundTo(request, { to: DIRECT_PHONE, since: sentAfter })).filter(
          (message) => message.body === optimisticBody,
        ).length,
      { timeout: 20_000, message: 'the direct SMS never reached the fake provider' },
    )
    .toBe(1);
  await expect(optimisticBubble).toContainText(/SMS - to \(555\) 010-0001 - /, {
    timeout: 20_000,
  });
  await expectNoTransportTransition(optimisticBubble, 'SMS');

  await page.goto(`${NEXT}/conversations/${NATIVE_GROUP}`);
  await expect(page.getByText(/Everyone in this group text sees everyone's real number/)).toBeVisible({
    timeout: 15_000,
  });
  const nativeBubble = await expectTransport(
    page,
    'Saturday 10am works on our side - confirming with the owner.',
    'MMS',
  );
  await expectNoTransportTransition(nativeBubble, 'MMS');

  await page.goto(`${NEXT}/conversations/${RELAY_CONVERSATION}`);
  await expect(page.getByText('With Diana Osei & Gloria Mensah')).toBeVisible({ timeout: 15_000 });
  const relayBubble = await expectTransport(page, inboundRelayBody, 'SMS');
  await expect(relayBubble).not.toContainText('Mixed');
  const relayList = relayBubble.getByRole('list', { name: 'Delivery by recipient' });
  await expect(relayList).toBeVisible();
  await expect(relayList.getByRole('listitem', { name: /Gloria Mensah - .*RCS -> SMS/ })).toHaveCount(1);
});
