// e2e/tests/scenarios/selfcheck.spec.ts
//
// Proves the step() wrapper + verbs behave before scenarios rely on them: a real
// verb that PASSES against live behavior, and a REAL verb pointed at absent behavior
// that must FAIL loudly (asserted with rejects.toThrow) rather than silently pass.
import { test, expect } from '@playwright/test';
import { Scenario, freshTenant } from '../../scenarios/steps.js';

test('framework: a real verb passes and a wrong assertion fails loudly', async ({ page, request }) => {
  const flow = new Scenario(page, request);
  const tenant = freshTenant('Selfcheck');

  // PASS path: a real inbound auto-captures an unknown the App surfaces to Team.
  await flow.tenantTexts(tenant, `selfcheck inbound ${tenant.name}`);
  await flow.login();
  await flow.expectUnknownCaptured(tenant);

  // FAIL path: a REAL verb pointed at absent behavior must throw, not silently pass.
  // expectTypedTenant on a fresh Scenario with no triaged/created contact must fail
  // loudly (there is no active contact to assert), proving the harness surfaces a
  // wrong assertion instead of passing it.
  const ghost = new Scenario(page, request);
  await expect(ghost.expectTypedTenant()).rejects.toThrow();
});
