// Manual extraction trigger - the one e2e that proves the waiver is real.
//
// WHY A DEV SEAM AND NOT A SEED ROW (design 7): lean message rows carry `ts` and
// `tsMsgId` and NO `created_at`, and `created_at` is the field the 30-day cutoff
// filters on (app/src/jobs/extraction.ts:435-436). The fixed 2026-06-01 lean
// timestamps therefore exercise the age cutoff not at all. The hermetic lane also
// runs the FAKE driver, which only extracts from an `EXTRACT:` marker the lean
// transcript does not carry. `POST /__dev/extraction/message-fixture` plants ONE
// message with a caller-supplied `created_at` and body; lean stays byte-stable.
//
// The NEGATIVE half is the load-bearing one. The automatic run is due and DOES
// run - it simply cannot see the aged message, so it produces nothing and records
// the plant as excluded for `age_30d`. Without that, the positive half could be
// passing for an unrelated reason.
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { extractionTick } from "../../fixtures/extraction.js";
import { postInboundSms } from "../../fixtures/fakeTwilio.js";
import { reseed } from "../../fixtures/reseed.js";
import { expectTodayReady } from "../../support/today.js";

const NEXT = process.env["E2E_DASHBOARD_URL"] ?? "http://127.0.0.1:5174";

/** Far outside the 30-day automatic window, in the field the cutoff reads. */
const AGED = "2026-01-05T12:00:00.000Z";

// op 'suggest', not 'write': a suggestion is what design 7 names as the witness,
// and only a suggestion renders the review CHIP. A 'write' lands the value
// silently in the Eligibility intake card with no chip at all.
const MARKER =
  'EXTRACT:{"fields":{"pets":{"op":"suggest","value":"Two cats","reason":"said so"}}}';

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

// `page.request` for every /api/... call - it shares the browser context's cookie
// jar, which is where dev-login put the session. The bare `request` fixture is
// unauthenticated and is for /__dev/... and postInboundSms only.
async function createTenant(
  request: APIRequestContext,
  firstName: string,
): Promise<{ contactId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await request.post(`${NEXT}/api/contacts`, {
    data: { type: "tenant", firstName, lastName: "Aged", phone },
  });
  expect(res.ok(), `create tenant ${firstName}`).toBeTruthy();
  return { contactId: (await res.json()).contact.contactId as string, phone };
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

async function sendPlainSms(
  request: APIRequestContext,
  phone: string,
  body: string,
): Promise<void> {
  sequence += 1;
  const result = await postInboundSms(request, {
    from: phone,
    body,
    messageSid: `SMman${Date.now()}${sequence}`,
  });
  expect(result.status, result.body).toBe(200);
}

/** Plant one aged, marker-carrying inbound message. Returns its tsMsgId. */
async function plantAgedMessage(
  request: APIRequestContext,
  input: { conversationId: string; body: string; createdAt: string },
): Promise<string> {
  const res = await request.post(`${NEXT}/__dev/extraction/message-fixture`, {
    data: { ...input, direction: "inbound" },
  });
  expect(
    res.ok(),
    `plant aged message: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()).tsMsgId as string;
}

function runRows(page: Page) {
  return page.getByRole("list", { name: "AI runs" }).getByRole("button");
}

/** The run log, deep-linked to this contact's scope (openRunFor's pattern). */
async function openRunLog(page: Page, contactId: string): Promise<void> {
  await page.goto(
    `${NEXT}/settings/ai-runs?scope=${encodeURIComponent(`contacts#${contactId}`)}`,
  );
  await expect(page.getByRole("heading", { name: "AI run log" })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await reseed(request);
});

test("a manual run reads aged history that an automatic run cannot see", async ({
  page,
  request,
}) => {
  // Two extraction passes, two run-log round trips and two contact-page loads.
  test.slow();

  await devLoginAs(page, "founder@example.com");
  const { contactId, phone } = await createTenant(page.request, "Marker");

  // An ordinary inbound creates the conversation AND arms an automatic due row.
  await sendPlainSms(request, phone, "hello");
  const conversationId = await conversationIdFor(page.request, contactId);

  const plantedTsMsgId = await plantAgedMessage(request, {
    conversationId,
    body: MARKER,
    createdAt: AGED,
  });
  expect(plantedTsMsgId.startsWith(AGED)).toBeTruthy();

  // ---- NEGATIVE: the automatic run runs, and cannot see the aged message ----
  expect((await extractionTick(request)).processed).toBeGreaterThan(0);

  await page.goto(`${NEXT}/contacts/${contactId}`);
  // Anchor on a rendered card FIRST - a bare count-0 assertion right after goto
  // passes vacuously while the page is still loading.
  await expect(
    page.getByRole("heading", { name: "Eligibility intake" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "AI suggestion for pets" }),
  ).toHaveCount(0);

  await openRunLog(page, contactId);
  await expect(runRows(page)).toHaveCount(1);
  const autoRow = runRows(page).first();
  // The trigger renders RAW; an sms-scheduled automatic row reads `sms via fake`
  // (jobs/extraction.ts: trigger = manual ? 'manual' : row.channel).
  await expect(autoRow).toContainText(/sms via fake/i);
  // It RAN (not skipped) and found nothing.
  await expect(autoRow).not.toContainText(/skipped/i);
  await expect(autoRow).toContainText("0 wrote, 0 suggested");
  await autoRow.click();
  await expect(
    page.getByRole("region", { name: "AI run detail" }),
  ).toBeVisible();
  // The plant was IN the conversation and was excluded for its age - the age
  // gate is what hid it, not its absence.
  await expect(
    page.getByRole("region", { name: "Excluded messages" }),
  ).toContainText(`${plantedTsMsgId}: age_30d`);
  await expect(
    page.getByRole("table", { name: "Window messages" }),
  ).not.toContainText("EXTRACT:");

  // ---- POSITIVE: the press waives the floor and the page updates live ----
  await page.goto(`${NEXT}/contacts/${contactId}`);
  await expect(
    page.getByRole("heading", { name: "Eligibility intake" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Run AI extraction" }).click();
  await expect(
    page.getByRole("status", { name: /ai extraction/i }),
  ).toContainText(/running ai extraction/i);

  await extractionTick(request);

  // NO reload between the tick and these assertions: the chip and the resolved
  // banner both arrive over SSE (suggestion.updated / ai_run.completed).
  const chip = page.getByRole("group", { name: "AI suggestion for pets" });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toContainText('AI heard "Two cats"');
  // The run suggested and wrote nothing, so the banner names only the half that
  // happened. It must NOT say "Updated 0 fields" - see ContactDetail's
  // extractionAppliedCopy, which live self-QA corrected.
  await expect(
    page.getByRole("status", { name: /ai extraction/i }),
  ).toContainText("1 suggestion to review.");

  // ---- And the run is recorded as manual ----
  await openRunLog(page, contactId);
  await expect(runRows(page)).toHaveCount(2);
  const manualRow = runRows(page).filter({ hasText: "manual via fake" });
  await expect(manualRow).toHaveCount(1);
  await expect(manualRow).not.toContainText(/skipped/i);
  await expect(manualRow).toContainText("0 wrote, 1 suggested");
  await manualRow.click();
  await expect(
    page.getByRole("region", { name: "AI run detail" }),
  ).toBeVisible();
  // The aged message really did reach the model on this run.
  await expect(
    page.getByRole("table", { name: "Window messages" }),
  ).toContainText(plantedTsMsgId);
});
