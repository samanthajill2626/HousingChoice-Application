import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  extractionTick,
  planTranscribedCall,
  sendExtractSms,
} from "../../fixtures/extraction.js";
import { postInboundSms } from "../../fixtures/fakeTwilio.js";
import { reseed } from "../../fixtures/reseed.js";

const NEXT = process.env["E2E_DASHBOARD_URL"] ?? "http://127.0.0.1:5174";

async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, {
    data: { email },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
}

let sequence = 0;
function uniquePhone(): string {
  sequence += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(sequence).padStart(2, "0")}`;
}

async function createContact(
  request: APIRequestContext,
  input: { firstName: string; type: "tenant" | "unknown" },
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: {
      type: input.type,
      firstName: input.firstName,
      lastName: "Runlog",
      phone,
    },
  });
  expect(res.ok(), `create ${input.type} ${input.firstName}`).toBeTruthy();
  return { contactId: (await res.json()).contact.contactId as string, phone };
}

async function createTenant(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  return createContact(request, { firstName, type: "tenant" });
}

async function createUnknown(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  return createContact(request, { firstName, type: "unknown" });
}

async function findUnknownContactId(
  request: APIRequestContext,
  phone: string,
): Promise<string> {
  let contactId: string | undefined;
  await expect
    .poll(async () => {
      const res = await request.get(`${NEXT}/api/contacts?type=unknown`);
      if (!res.ok()) return false;
      contactId = (
        (await res.json()).contacts as Array<{
          contactId: string;
          phone?: string;
        }>
      ).find((contact) => contact.phone === phone)?.contactId;
      return contactId !== undefined;
    })
    .toBe(true);
  return contactId!;
}

async function sendPlainSms(
  request: APIRequestContext,
  phone: string,
  body: string,
): Promise<void> {
  const result = await postInboundSms(request, {
    from: phone,
    body,
    messageSid: `SMrun${Date.now()}${sequence}`,
  });
  expect(result.status, result.body).toBe(200);
}

async function conversationIdFor(
  request: APIRequestContext,
  contactId: string,
): Promise<string> {
  const res = await request.post(
    `${NEXT}/api/contacts/${contactId}/conversation`,
  );
  expect(res.ok(), "create contact conversation").toBeTruthy();
  return (await res.json()).conversation.conversationId as string;
}

async function tsMsgIdForCallSid(
  request: APIRequestContext,
  conversationId: string,
  callSid: string,
): Promise<string> {
  const res = await request.get(
    `${NEXT}/api/conversations/${conversationId}/messages`,
  );
  expect(res.ok(), "read planted call").toBeTruthy();
  const messages = (await res.json()).messages as Array<{
    provider_sid?: string;
    tsMsgId: string;
  }>;
  const call = messages.find((message) => message.provider_sid === callSid);
  expect(call, `find planted call ${callSid}`).toBeDefined();
  return call!.tsMsgId;
}

type MarkerOverrides = { fields?: Record<string, unknown> } & Record<
  string,
  unknown
>;

// The fake driver returns marker JSON as rawText. Keep every marker schema-shaped
// so parseExtractionOps sees explicit declines rather than absent fields.
function marker(overrides: MarkerOverrides = {}): Record<string, unknown> {
  const baseFields = Object.fromEntries(
    [
      "firstName",
      "lastName",
      "voucherSize",
      "housingAuthority",
      "pets",
      "evictions",
      "tenure",
      "porting",
    ].map((field) => [field, { op: "none", value: "", reason: "" }]),
  );
  return {
    fields: { ...baseFields, ...overrides.fields },
    statusAdvance: { suggest: false, reason: "" },
    typeSuggestion: { value: "none", reason: "" },
    phoneAddition: { phone: "", label: "", reason: "" },
    noteLines: [],
    speakerRoles: [],
    address: {
      op: "none",
      line1: "",
      line2: "",
      city: "",
      state: "",
      zip: "",
      reason: "",
    },
    ...overrides,
  };
}

async function openRunFor(
  page: Page,
  contactId: string,
  outcome: RegExp,
): Promise<void> {
  await page.goto(
    `${NEXT}/settings/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`,
  );
  await expect(page.getByRole("heading", { name: "AI run log" })).toBeVisible();
  const row = page.getByRole("button", { name: /^Run / });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(outcome);
  await row.click();
  await expect(
    page.getByRole("region", { name: "AI run detail" }),
  ).toBeVisible();
}

function decisionRow(page: Page, target: string) {
  return page
    .getByRole("table", { name: "Decisions" })
    .getByRole("row", { name: new RegExp(`^${target}\\b`, "i") });
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("an applied run shows rehydrated text and every decision state", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Applied");
  await sendExtractSms(
    request,
    phone,
    marker({
      fields: {
        pets: { op: "write", value: "two cats", reason: "said so" },
        tenure: { op: "none", value: "", reason: "" },
      },
    }),
  );
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /applied/i);
  await expect(page.getByLabel("Extraction driver: fake")).toBeVisible();
  const window = page.getByRole("table", { name: "Window messages" });
  await expect(window).toContainText("new");
  await expect(window).toContainText("EXTRACT:");
  await expect(decisionRow(page, "pets")).toContainText("wrote");
  await expect(decisionRow(page, "tenure")).toContainText(
    /no finding/i,
  );
  await expect(decisionRow(page, "housingAuthority")).toContainText(
    /not addressed/i,
  );
});

test("a char budget exclusion is recorded with its cause", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Budget");
  const filler = "x".repeat(30_000);
  await sendPlainSms(request, phone, `${filler}1`);
  await sendPlainSms(request, phone, `${filler}2`);
  await sendExtractSms(
    request,
    phone,
    marker({ fields: { pets: { op: "write", value: "two cats", reason: "said so" } } }),
  );
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /applied/i);
  await expect(
    page.getByRole("region", { name: "Excluded messages" }),
  ).toContainText("char_budget");
});

test("an empty call transcript is noContent and is never listed as read", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Silent");
  await sendExtractSms(request, phone, marker());
  const conversationId = await conversationIdFor(page.request, contactId);
  const callSid = `CAempty${Date.now()}`;
  await planTranscribedCall(request, {
    conversationId,
    callSid,
    sentences: [{ text: "", mediaChannel: 1 }],
  });
  const callTsMsgId = await tsMsgIdForCallSid(page.request, conversationId, callSid);
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /applied|no op/i);
  await expect(page.getByRole("region", { name: "No content" })).toContainText(
    callTsMsgId,
  );
  await expect(
    page.getByRole("table", { name: "Window messages" }),
  ).not.toContainText(callTsMsgId);
});

test("an empty conversation triage records a light skip with no decisions", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId } = await createUnknown(page.request, "Empty");
  await conversationIdFor(page.request, contactId);
  const triage = await page.request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { type: "tenant" },
  });
  expect(triage.ok(), "triage unknown contact").toBeTruthy();
  const tick = await extractionTick(request);
  // Skips write their run record but intentionally increment neither counter.
  expect(tick).toMatchObject({ processed: 0, failed: 0 });

  await openRunFor(page, contactId, /skipped/i);
  await expect(page.getByRole("heading", { name: "Skip window" })).toBeVisible();
  await expect(page.getByText(/no byte-level message evidence/i)).toBeVisible();
  await expect(page.getByRole("table", { name: "Decisions" })).toHaveCount(0);
});

test("accepting a suggestion stamps accepted on its run", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Accept");
  await sendExtractSms(
    request,
    phone,
    marker({
      fields: {
        pets: { op: "suggest", value: "three dogs", reason: "conflicts" },
      },
    }),
  );
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /applied/i);
  await expect(decisionRow(page, "pets")).toContainText(/pending/i);
  const accept = await page.request.post(
    `${NEXT}/api/contacts/${contactId}/suggestions/pets/accept`,
  );
  expect(accept.ok(), "accept pets suggestion").toBeTruthy();
  await openRunFor(page, contactId, /applied/i);
  await expect(decisionRow(page, "pets")).toContainText(/accepted/i);
});

test("a PATCH supersedes a pending suggestion", async ({ page, request }) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Superseded");
  await sendExtractSms(
    request,
    phone,
    marker({
      fields: {
        pets: { op: "suggest", value: "three dogs", reason: "conflicts" },
      },
    }),
  );
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);
  const patch = await page.request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { pets: "one hamster" },
  });
  expect(patch.ok(), "human pets edit").toBeTruthy();

  await openRunFor(page, contactId, /applied/i);
  await expect(decisionRow(page, "pets")).toContainText(
    /superseded by human edit/i,
  );
});

test("a type PATCH that differs from the suggestion records rejection semantics", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const phone = uniquePhone();
  await sendExtractSms(
    request,
    phone,
    marker({
      typeSuggestion: { value: "tenant", reason: "asked about vouchers" },
    }),
  );
  const contactId = await findUnknownContactId(page.request, phone);
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);
  const patch = await page.request.patch(`${NEXT}/api/contacts/${contactId}`, {
    data: { type: "landlord" },
  });
  expect(patch.ok(), "different human type").toBeTruthy();

  await openRunFor(page, contactId, /applied/i);
  await expect(decisionRow(page, "type")).toContainText(
    /superseded by human edit/i,
  );
});

test("only admins can reach the tab, route, and API", async ({ page }) => {
  await devLoginAs(page, "founder@example.com");
  await page.goto(`${NEXT}/settings/ai-runs`);
  await expect(page.getByRole("tab", { name: "AI run log" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI run log" })).toBeVisible();

  await devLoginAs(page, "va@example.com");
  await page.goto(`${NEXT}/settings/ai-runs`);
  await expect(page).toHaveURL(/\/settings\/templates$/);
  await expect(page.getByRole("heading", { name: "AI run log" })).toHaveCount(
    0,
  );
  const api = await page.request.get(`${NEXT}/api/ai-runs`);
  expect(api.status()).toBe(403);
});
