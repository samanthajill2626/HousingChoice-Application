// pool:retire - manual relay pool-number retirement sweep (D7).
//
// Builds the poolNumbers service from the ambient config and runs
// retireEligible(): every ACTIVE pool number with ZERO open groups whose newest
// group closed more than the 180-day grace ago is DELETEd at Twilio and marked
// released. GATED by RELAY_NUMBER_RELEASE_ENABLED=true (off by default
// everywhere) - when off this is a no-op that prints nothing to release.
//
// The same sweep runs lazily at the top of every provisionForGroup; this script
// is the on-demand ops entry point. It prints the released numbers + count for
// the operator (operator-facing stdout, not the app log stream). RUNBOOK: run
// against the intended stage's AWS/DynamoDB + messaging-driver config.
import { loadConfig } from '../src/lib/config.js';
import { createPoolNumbersService } from '../src/services/poolNumbers.js';

const config = loadConfig();
if (!config.relayNumberReleaseEnabled) {
  console.log('pool:retire - RELAY_NUMBER_RELEASE_ENABLED is not true; no-op (nothing released).');
  process.exit(0);
}

const service = createPoolNumbersService({ config });
try {
  const released = await service.retireEligible();
  console.log(`pool:retire - released ${released.length} number(s)`);
  for (const n of released) console.log(`  released: ${n}`);
} catch (err) {
  console.error('pool:retire failed');
  console.error(err);
  process.exit(1);
}
