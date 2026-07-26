// Single source of truth for WHICH job handlers exist + their token-bucket wiring.
//
// Called by BOTH entrypoints:
//   - worker.ts  — the worker dispatches these off the SQS consumer (production).
//   - index.ts   — the app's LOCAL in-process path (JOBS_QUEUE_URL unset) dispatches
//                  immediate/short-backoff jobs IN-PROCESS, so it must register the
//                  same handlers itself (the worker process is separate locally).
//
// One registration site = the two processes can never drift. (They did: M1.8's
// broadcast.send and M1.9's call.missedAutoText were added to the worker but missed
// in the app's local branch, so local `npm run dev` failed every immediate broadcast/
// auto-text with "no handler registered" while production — which dispatches in the
// worker — was fine.)
import type { TokenBucket } from '../lib/tokenBucket.js';
import { registerRetrySendJobHandler } from './retrySend.js';
import { registerRelayFanOutJobHandler } from './relayFanOut.js';
import { registerBroadcastSendJobHandler } from './broadcastFanOut.js';
import { registerMissedCallAutoTextJobHandler } from './missedCallAutoText.js';
import { registerVoiceTranscriptJobHandlers } from './voiceTranscript.js';
import { registerRelayWarmJobHandler } from './relayWarm.js';
import { registerRelayNumberReadyJobHandler } from './relayNumberReady.js';

export interface RegisterJobHandlersDeps {
  /** The shared A2P token bucket — every throttled outbound handler draws from it. */
  tokenBucket: TokenBucket;
}

/**
 * Register every job handler. Job names produced: `messaging.retrySend`,
 * `relay.fanOut` + `relay.intro` (both from the relay registrar), `broadcast.send`,
 * `call.missedAutoText`, `voice.createTranscript` + `voice.reconcileTranscript`,
 * `relay.warmNumber`, `relay.numberReady`.
 * retrySend is a single low-volume send and is intentionally not throttled; the
 * SMS handlers share `tokenBucket` so the COMBINED outbound rate stays under the
 * registered A2P tier. The voice-transcript jobs make VI API calls (no outbound
 * SMS), so they draw no token and lazily build their own config/adapter/repos.
 * relay.warmNumber is an SDK provision + messaging-service attach (a number
 * PURCHASE, not an outbound SMS), so it likewise draws no token. relay.numberReady
 * (connect-when-ready) is a burn + status flip + intro enqueue - it draws no
 * token either (the intro it enqueues is metered by relay.intro's own handler).
 */
export function registerAllJobHandlers(deps: RegisterJobHandlersDeps): void {
  registerRetrySendJobHandler();
  registerRelayFanOutJobHandler({ tokenBucket: deps.tokenBucket });
  registerBroadcastSendJobHandler({ tokenBucket: deps.tokenBucket });
  registerMissedCallAutoTextJobHandler({ tokenBucket: deps.tokenBucket });
  registerVoiceTranscriptJobHandlers();
  registerRelayWarmJobHandler();
  registerRelayNumberReadyJobHandler();
}
