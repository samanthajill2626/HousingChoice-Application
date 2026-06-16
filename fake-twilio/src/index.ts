import { buildFakeTwilioApp } from './server.js';
import { loadFakeConfig } from './config.js';

const config = loadFakeConfig(); // throws if NODE_ENV=production (boot guard)
const app = buildFakeTwilioApp({ config });
const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`fake-twilio listening on :${config.port} → app ${config.appBaseUrl}`);
});
// Fail loudly if the port can't actually be bound (e.g. an orphan already holds
// it). Without this the listen error is swallowed, the event loop empties, and
// the process exits 0 — masquerading as a clean shutdown to any launcher that
// tracks it. Exit non-zero so the failure is observable instead.
server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error(`fake-twilio failed to bind :${config.port}: ${String(err)}`);
  process.exit(1);
});
