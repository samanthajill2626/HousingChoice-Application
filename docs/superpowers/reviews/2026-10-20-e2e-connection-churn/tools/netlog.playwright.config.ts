// DIAGNOSTIC ONLY (e2e connection-churn assessment, 2026-10-20). Copied
// temporarily into e2e/ for one measurement run and deleted afterwards - never
// committed. It is the suite's own config plus one Chromium flag: a NetLog of
// every socket event, so a connect that fails (ERR_ADDRESS_IN_USE,
// ERR_NO_BUFFER_SPACE) is recorded even when no test fails from it.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const netlog = process.env['CHURN_NETLOG'];
if (!netlog) throw new Error('set CHURN_NETLOG to the NetLog output path');

export default defineConfig({
  ...base,
  use: {
    ...base.use,
    launchOptions: {
      ...(base.use?.launchOptions ?? {}),
      args: [...(base.use?.launchOptions?.args ?? []), `--log-net-log=${netlog}`, '--net-log-capture-mode=Default'],
    },
  },
});
