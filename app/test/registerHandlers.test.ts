import { describe, it, expect } from 'vitest';
import { registerAllJobHandlers } from '../src/jobs/registerHandlers.js';
import { registeredJobNames } from '../src/jobs/jobs.js';
import { TokenBucket } from '../src/lib/tokenBucket.js';

// Regression guard for the two-site drift that broke local dev: the app's
// in-process path (index.ts) and the worker (worker.ts) BOTH call
// registerAllJobHandlers, so locking the full set here catches any handler that
// gets added to one entrypoint but not the other (M1.8 broadcast.send + M1.9
// call.missedAutoText were added to the worker only → "no handler registered for
// job 'broadcast.send'" the moment the app dispatched a broadcast in-process).
describe('registerAllJobHandlers', () => {
  it('registers the COMPLETE job-handler set (so worker + app in-process never drift)', () => {
    // Fresh per-file module registry (vitest isolate) — nothing registered yet.
    expect(registeredJobNames()).toEqual([]);

    registerAllJobHandlers({ tokenBucket: new TokenBucket({ capacity: 1, refillPerSec: 1 }) });

    expect([...registeredJobNames()].sort()).toEqual(
      [
        'broadcast.send',
        'call.missedAutoText',
        'messaging.retrySend',
        'relay.fanOut',
        'relay.intro',
        'relay.memberAdded',
        'voice.createTranscript',
        'voice.reconcileTranscript',
      ].sort(),
    );
  });
});
