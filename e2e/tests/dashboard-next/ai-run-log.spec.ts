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
import { expectTodayReady } from "../../support/today.js";

const NEXT = process.env["E2E_DASHBOARD_URL"] ?? "http://127.0.0.1:5174";

async function devLoginAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${NEXT}/auth/dev-login`, {
    data: { email },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`${NEXT}/`);
  await expectTodayReady(page);
}

let sequence = 0;
function uniquePhone(): string {
  sequence += 1;
  return `+1555${`${Date.now()}`.slice(-5)}${String(sequence).padStart(2, "0")}`;
}

function formatPhoneDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
  if (local.length !== 10) return e164;
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
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
//
// `fields` MERGES over the eight schema-shaped declines. A trailing
// `...overrides` spread used to REPLACE the merged map wholesale, so any call
// that touched `fields` silently dropped the other seven declines and made
// those targets ABSENT - which is how the not-addressed assertion below passed
// for the wrong reason (conf P3-15).
//
// A `null` override OMITS its key, at either level. That is the ONLY way to
// make a target genuinely not_addressed from a schema-shaped marker: a full
// marker addresses all twelve (the eight `fields` plus address, statusAdvance,
// typeSuggestion, phoneAddition), and buildDecisions maps op 'none' to
// no_finding and an absent key to not_addressed.
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
  const { fields: fieldOverrides, ...rest } = overrides;
  const dropNulls = (source: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(source).filter(([, value]) => value !== null),
    );
  return dropNulls({
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
    ...rest,
    fields: dropNulls({ ...baseFields, ...fieldOverrides }),
  });
}

async function openRunFor(
  page: Page,
  contactId: string,
  outcome: RegExp,
): Promise<void> {
  const contactResponse = await page.request.get(`${NEXT}/api/contacts/${contactId}`);
  expect(contactResponse.ok(), "load contact display identity").toBeTruthy();
  const contact = (await contactResponse.json()).contact as {
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  const name = [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean).join(" ");
  const displayEvidence = name || (contact.phone ? formatPhoneDisplay(contact.phone) : contactId);
  await page.goto(
    `${NEXT}/settings/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`,
  );
  await expect(page.getByRole("heading", { name: "AI run log" })).toBeVisible();
  // Scope to the list: the row is named by its own CONTENT (no runId
  // aria-label), and `Load more` / the error-block `Retry` sit outside the <ul>.
  const row = page.getByRole("list", { name: "AI runs" }).getByRole("button");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(outcome);
  await expect(row).toContainText(displayEvidence);
  if (displayEvidence !== contactId) await expect(row).not.toContainText(contactId);
  await row.click();
  const detail = page.getByRole("region", { name: "AI run detail" });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(displayEvidence);
  if (displayEvidence !== contactId) await expect(detail).not.toContainText(contactId);
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
        // Deliberately OMITTED from the marker, so the model never mentioned
        // it. This is the only honest source of a not_addressed decision.
        evictions: null,
      },
    }),
  );
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /applied/i);
  // By ROLE: `getByLabel` alone also passes on a role=generic <span>, whose
  // aria-label assistive tech never exposes.
  await expect(
    page.getByRole("listitem", { name: "Extraction driver: fake" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "AI run detail" }),
  ).toContainText(/Prompt fingerprint: [0-9a-f]{12}/);
  const window = page.getByRole("table", { name: "Window messages" });
  await expect(window).toContainText("new");
  await expect(window).toContainText("EXTRACT:");
  await expect(decisionRow(page, "pets")).toContainText("wrote");
  await expect(decisionRow(page, "tenure")).toContainText(
    /no finding/i,
  );
  // housingAuthority is one of the eight schema-shaped declines the helper
  // merges in. It reads "no finding" ONLY while that merge survives the
  // overrides spread; a regression there makes it "not addressed" again.
  await expect(decisionRow(page, "housingAuthority")).toContainText(
    /no finding/i,
  );
  await expect(decisionRow(page, "evictions")).toContainText(
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

test("a driver failure records a failed run with its error kind and attempts", async ({
  page,
  request,
}) => {
  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Failing");
  // The fake driver's dev-only failure marker (app/src/adapters/extractionFake.ts).
  // Without it the ok:false arm - outcome failed, the error block, burned
  // attempts, parking - has no hermetic reachability at all.
  await sendExtractSms(
    request,
    phone,
    marker({ __fail: "parse", __failMessage: "simulated schema violation" }),
  );
  const tick = await extractionTick(request);
  expect(tick.failed).toBeGreaterThan(0);

  await openRunFor(page, contactId, /failed/i);
  const detail = page.getByRole("region", { name: "AI run detail" });
  await expect(detail).toContainText(/failed/i);

  // The pane does not render the error block today, so the kind, message,
  // attempts and park state are asserted on the admin API that does expose
  // them. No UI feature is invented here.
  const list = await page.request.get(
    `${NEXT}/api/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`,
  );
  expect(list.ok(), "list failed run").toBeTruthy();
  const rows = (await list.json()).runs as Array<{
    runId: string;
    outcome: string;
    errorKind?: string;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome: "failed", errorKind: "parse" });

  const detailResponse = await page.request.get(
    `${NEXT}/api/ai-runs/${rows[0]!.runId}`,
  );
  expect(detailResponse.ok(), "read failed run detail").toBeTruthy();
  const run = (await detailResponse.json()).run as {
    outcome: string;
    driver: string;
    promptFingerprint?: string;
    error?: { kind: string; message: string; attempts: number; parked: boolean };
  };
  expect(run.outcome).toBe("failed");
  expect(run.driver).toBe("fake");
  expect(run.promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
  // attempts counts the attempts BEFORE this one, so a first failure re-arms
  // with backoff rather than parking (jobs/extraction.ts:616-621).
  expect(run.error).toMatchObject({
    kind: "parse",
    message: "simulated schema violation",
    attempts: 0,
    parked: false,
  });
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
  const pendingResponse = await page.request.get(
    `${NEXT}/api/contacts/${contactId}/suggestions`,
  );
  const pending = await pendingResponse.json() as {
    suggestions: { target: string; revision?: string; createdAt: string; runId?: string }[];
  };
  const pets = pending.suggestions.find((suggestion) => suggestion.target === "pets");
  expect(pets, "pending pets suggestion identity").toBeDefined();
  const accept = await page.request.post(
    `${NEXT}/api/contacts/${contactId}/suggestions/pets/accept`,
    {
      data: {
        revision: pets?.revision,
        createdAt: pets?.createdAt,
        runId: pets?.runId,
      },
    },
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
