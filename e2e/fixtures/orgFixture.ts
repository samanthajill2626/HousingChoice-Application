// e2e/fixtures/orgFixture.ts
//
// Control-plane helpers for the organization lists - housing authorities and
// agencies (docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md;
// plan sections 3.6 and 3.12). Two kinds of call:
//   - the org API (/api/organizations...), which needs a SIGNED-IN request
//     context: pass `page.request` after a dev-login. The bare `request`
//     fixture carries no session cookie;
//   - the hermetic-only dev seam POST /__dev/org-fixture, which writes a value
//     onto a record the spec created WITHOUT the spec D5 check. It is the only
//     way a lane ever holds a "Not on the list" value: nothing off-list is
//     seeded (spec section 7).
// Every name and value a spec passes here must be RUN-UNIQUE. The list is ONE
// item per lane and a rewrite is lane-global, so a fixed name would leak between
// specs - and between runs against a reused stack, until the next reseed.
import { expect, type APIRequestContext } from '@playwright/test';
// The REAL comparison form. app/src/lib/orgNames.ts is pure (no imports), so it
// is safe in the e2e bundle - the same idiom as steps.ts's tourCopy import.
import { normalizeOrgText, type OrgEntry, type OrgKind } from '../../app/src/lib/orgNames.js';

const NEXT = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** The record fields an organization name lives in (plan 3.2 OrgRecordField). */
export type OrgRecordField = 'housingAuthority' | 'agency' | 'accepted_authorities';

/** The latest rewrite as GET /api/organizations returns it (plan 3.2
 *  OrgRewriteState - only the fields specs read). */
export interface OrgRewriteWire {
  jobId: string;
  action: string;
  fromTexts: string[];
  toName?: string;
  status: 'running' | 'done' | 'failed';
  counts?: Record<string, number>;
  error?: string;
}

export interface OrgListWire {
  version: number;
  entries: OrgEntry[];
  lastRewrite?: OrgRewriteWire;
}

/** One "Not on the list" row (plan 3.4 NotOnListRow - only what specs read). */
export interface NotOnListRowWire {
  field: OrgRecordField;
  value: string;
  count: number;
  deletedCount: number;
  resolution: { status: string };
}

/** Use counts per entry (plan 3.4 OrgUsage), keyed by orgId. */
export type OrgUsageWire = Record<
  string,
  { tenants: number; otherContacts: number; properties: number; deleted: number }
>;

/** Two texts are the same organization text under spec D4 (case, punctuation
 *  and spacing ignored) - how a rewrite's `fromTexts` are compared. */
export function sameOrgText(a: string, b: string): boolean {
  return normalizeOrgText(a) === normalizeOrgText(b);
}

/** GET /api/organizations - both lists plus the latest rewrite. */
export async function getOrgList(request: APIRequestContext): Promise<OrgListWire> {
  const res = await request.get(`${NEXT}/api/organizations`);
  expect(res.ok(), `GET /api/organizations: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as OrgListWire;
}

/** POST /api/organizations - add an entry (everyone may, spec D10). */
export async function addOrg(
  request: APIRequestContext,
  input: { kind: OrgKind; name: string; notes?: string },
): Promise<OrgEntry> {
  const res = await request.post(`${NEXT}/api/organizations`, { data: input });
  expect(res.status(), `add "${input.name}": ${await res.text()}`).toBe(201);
  return ((await res.json()) as { entry: OrgEntry }).entry;
}

/** The entry with exactly this name (a failed expectation when absent). */
export async function requireOrg(request: APIRequestContext, name: string): Promise<OrgEntry> {
  const entry = (await getOrgList(request)).entries.find((e) => e.name === name);
  expect(entry, `organization list entry "${name}"`).toBeDefined();
  return entry as OrgEntry;
}

/** GET /api/organizations/usage - use counts per entry (spec D3, D10). */
export async function getOrgUsage(request: APIRequestContext): Promise<OrgUsageWire> {
  const res = await request.get(`${NEXT}/api/organizations/usage`);
  expect(res.ok(), `GET /api/organizations/usage: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { usage: OrgUsageWire }).usage;
}

/** GET /api/organizations/not-on-list - every stored value not on the list. */
export async function getNotOnList(request: APIRequestContext): Promise<NotOnListRowWire[]> {
  const res = await request.get(`${NEXT}/api/organizations/not-on-list`);
  expect(res.ok(), `GET /api/organizations/not-on-list: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { rows: NotOnListRowWire[] }).rows;
}

/**
 * POST /__dev/org-fixture (plan 3.12): write `value` onto a record the spec
 * created, BYPASSING the D5 check - a contact's field is SET, a unit's value is
 * APPENDED to `accepted_authorities` (pass that field with a `unitId`).
 * Relative path: the lane's Vite server proxies /__dev to the app (reseed.ts).
 */
export async function setOffListValue(
  request: APIRequestContext,
  input: { contactId?: string; unitId?: string; field: OrgRecordField; value: string },
): Promise<void> {
  const res = await request.post('/__dev/org-fixture', { data: input });
  if (!res.ok()) throw new Error(`/__dev/org-fixture failed: ${res.status()} ${await res.text()}`);
}

/**
 * Wait for the rewrite `matches` picks out to finish (spec D11). The lane runs
 * jobs in-process in the app, DEFERRED to a macrotask, so a 202 means started,
 * never done: poll until the latest rewrite is the one asked for and has left
 * `running`. Fails with the job's error on `failed`. Returns the rewrite.
 */
export async function waitForRewrite(
  request: APIRequestContext,
  matches: (rewrite: OrgRewriteWire) => boolean,
  timeout = 30_000,
): Promise<OrgRewriteWire> {
  const seen: { rewrite?: OrgRewriteWire } = {};
  await expect
    .poll(
      async () => {
        const res = await request.get(`${NEXT}/api/organizations`);
        if (!res.ok()) return `GET /api/organizations answered ${res.status()}`;
        const latest = ((await res.json()) as OrgListWire).lastRewrite;
        if (latest === undefined || !matches(latest)) return 'not started yet';
        seen.rewrite = latest;
        return latest.status;
      },
      { timeout, message: 'the organization rewrite job should finish' },
    )
    .toMatch(/^(done|failed)$/);
  const rewrite = seen.rewrite as OrgRewriteWire;
  expect(rewrite.status, `rewrite ${rewrite.action} failed: ${rewrite.error ?? ''}`).toBe('done');
  return rewrite;
}
