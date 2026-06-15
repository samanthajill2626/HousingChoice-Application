import { buildFakeTwilioApp } from './server.js';
import { loadFakeConfig } from './config.js';

const config = loadFakeConfig(); // throws if NODE_ENV=production (boot guard)
const app = buildFakeTwilioApp({ config });
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`fake-twilio listening on :${config.port} → app ${config.appBaseUrl}`);
});
