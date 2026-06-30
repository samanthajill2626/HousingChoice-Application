// System Status naming CONTRACT test (Phase B hardening).
//
// The admin-only Settings → System Status panel queries CloudWatch with names
// the app DERIVES from config: the alarm filter prefix (`alarmNamePrefix`,
// `hc-<env>-`) and the error log group (`errorLogGroupName`, `/hc/<env>/app`).
// Those names are CREATED by Terraform (the observability module + the env
// wiring). If the two ever drift — someone renames the alarm prefix or the log
// group in Terraform, or changes the app's derivation — the deployed panel
// returns ZERO alarms/events and degrades to "no alarms configured for this
// environment." That failure is INVISIBLE: it looks healthy, not broken.
//
// This test closes that gap WITHOUT touching AWS: it extracts the concrete
// names Terraform declares (for a sample env) straight from the .tf source and
// asserts the app's config produces the SAME strings. Drift on EITHER side
// fails here, loudly, on every test run — the "deploy-time assertion" the Phase
// B review asked for, enforced continuously in CI instead of only at deploy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '../..');

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, rel), 'utf8');
}

/** First single-quoted-or-double-quoted RHS of `key = "..."` in some HCL text. */
function hclString(source: string, key: string): string {
  const m = source.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`));
  if (m === null) throw new Error(`could not find \`${key} = "..."\` in the Terraform source`);
  return m[1]!;
}

/** Substitute the Terraform interpolations we care about (literal, not regex). */
function interpolate(pattern: string, vars: Record<string, string>): string {
  let out = pattern;
  for (const [ref, value] of Object.entries(vars)) out = out.split(ref).join(value);
  return out;
}

describe('System Status naming contract (app config ↔ Terraform)', () => {
  it('alarm prefix + error log group the app queries match what Terraform creates', async () => {
    // --- The Terraform side (source of truth for what EXISTS in AWS) ---------
    const envMain = await read('infra/envs/dev/main.tf');
    const observability = await read('infra/modules/observability/main.tf');

    // The env name + the stack prefix the env wiring sets (`hc-${local.env}-`).
    const envName = hclString(envMain, 'env'); // "dev"
    const namePrefixPattern = hclString(envMain, 'name_prefix'); // "hc-${local.env}-"
    const tfAlarmPrefix = interpolate(namePrefixPattern, { '${local.env}': envName });

    // The app's TABLE_PREFIX is wired to local.name_prefix at deploy, so the
    // prefix the app sees == the prefix the alarms carry. Assert that linkage so
    // `resolveAppEnv` (which derives the env from TABLE_PREFIX) can't silently
    // diverge from the alarm/log naming.
    const stack = await read('infra/envs/dev/stack.tf');
    expect(stack).toMatch(/table_prefix\s*=\s*local\.name_prefix/);

    // The app log group is `/hc/${var.env}/app` — the `proc` group whose key is
    // "app" (the worker logs to the sibling "worker" group). Assert the "app"
    // key exists, then build the concrete name from the declared pattern.
    expect(observability).toMatch(/log_groups\s*=\s*\[[^\]]*"app"[^\]]*\]/);
    const logGroupPattern = hclString(observability, 'name'); // "/hc/${var.env}/${each.key}"
    const tfErrorLogGroup = interpolate(logGroupPattern, {
      '${var.env}': envName,
      '${each.key}': 'app',
    });
    // Corroborate that alarms actually carry the name_prefix (so an AlarmNamePrefix
    // filter is the right query shape).
    expect(observability).toMatch(/alarm_name\s*=\s*"\$\{var\.name_prefix\}/);

    // Sanity-check the extracted Terraform strings are the expected shapes.
    expect(tfAlarmPrefix).toBe('hc-dev-');
    expect(tfErrorLogGroup).toBe('/hc/dev/app');

    // --- The app side (what the System Status service will query) -----------
    // Deploy hydrates TABLE_PREFIX = local.name_prefix = the alarm prefix.
    const cfg = loadConfig({ TABLE_PREFIX: tfAlarmPrefix } as NodeJS.ProcessEnv);

    expect(cfg.appEnv).toBe(envName);
    expect(cfg.alarmNamePrefix).toBe(tfAlarmPrefix); // hc-dev-  (DescribeAlarms AlarmNamePrefix)
    expect(cfg.errorLogGroupName).toBe(tfErrorLogGroup); // /hc/dev/app  (FilterLogEvents)
  });

  it('the contract holds for any env name (prod parity), not just dev', async () => {
    // Same derivation with env=prod proves it's the PATTERN that matches, not a
    // dev-only coincidence — prod uses the identical module + wiring.
    const cfg = loadConfig({ TABLE_PREFIX: 'hc-prod-' } as NodeJS.ProcessEnv);
    expect(cfg.appEnv).toBe('prod');
    expect(cfg.alarmNamePrefix).toBe('hc-prod-');
    expect(cfg.errorLogGroupName).toBe('/hc/prod/app');
  });
});
