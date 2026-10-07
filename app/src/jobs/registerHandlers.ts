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
import type { SendAttemptsRepo } from '../repos/sendAttemptsRepo.js';
import { registerRetrySendJobHandler } from './retrySend.js';
import { registerRelayFanOutJobHandler } from './relayFanOut.js';
import { registerRelayRetryLegJobHandler } from './relayRetryLeg.js';
import { registerBroadcastSendJobHandler } from './broadcastFanOut.js';
import { registerMissedCallAutoTextJobHandler } from './missedCallAutoText.js';
import { registerVoiceTranscriptJobHandlers } from './voiceTranscript.js';
import { registerRelayWarmJobHandler } from './relayWarm.js';
import { registerRelayNumberReadyJobHandler } from './relayNumberReady.js';
import { registerGroupRailJobHandler } from './groupRail.js';
import { registerMediaMirrorJobHandler } from './mediaMirror.js';
import { registerSendReconcileJobHandler } from './sendReconcile.js';
import { registerOrgRewriteJobHandler } from './orgRewrite.js';

export interface RegisterJobHandlersDeps {
  /** The shared A2P token bucket — every throttled outbound handler draws from it. */
  tokenBucket: TokenBucket;
  /**
   * The per-recipient send-attempt records (SOR spec D8a), passed to the four
   * send handlers (messaging.retrySend, broadcast.send, relay.fanOut,
   * relay.retryLeg) and to the send.reconcile job. Production leaves it unset
   * and each handler builds the DynamoDB repo lazily.
   */
  sendAttemptsRepo?: SendAttemptsRepo;
}

/**
 * Register every job handler. Job names produced: `messaging.retrySend`,
 * `relay.fanOut` + `relay.intro` (both from the relay registrar), `relay.retryLeg`,
 * `broadcast.send`, `send.reconcile`,
 * `call.missedAutoText`, `voice.createTranscript` + `voice.reconcileTranscript`,
 * `relay.warmNumber`, `relay.numberReady`, `groupRail.ensure`, `media.mirror`,
 * `org.rewrite`.
 * send.reconcile (SOR spec D11) resolves an ambiguous send by LOOKING IT UP at
 * the provider; it sends nothing itself (a re-drive is its owner's own send
 * job, metered there), so it draws no token.
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
  // messaging.retrySend (retry-send-adoption R2): registered WITHOUT the run-once
  // marker - it claims a send-attempt record before its provider call instead.
  registerRetrySendJobHandler({ sendAttemptsRepo: deps.sendAttemptsRepo });
  registerRelayFanOutJobHandler({ tokenBucket: deps.tokenBucket, sendAttemptsRepo: deps.sendAttemptsRepo });
  // relay.retryLeg (the 30003 ladder): one backed-off rung per failed relay leg,
  // metered by the same shared bucket - it is a real outbound SMS.
  //
  // NO backoff is passed here, and that is the point (code review R1, F5). The
  // lane's `E2E_RELAY_RETRY_BACKOFF_MS` is read inside relayRetryLeg.ts, by the
  // one chain BOTH the registration and the free `enqueueRelayRetryLeg` resolve
  // through. Parsing it here instead would reach only the process that
  // registers - and in production that is the WORKER, while every rung is
  // enqueued by the status webhook in the APP process, which registers nothing
  // (`index.ts`, `if (!config.jobsQueueUrl)`). The hermetic lane runs both in
  // one process, which is why the seam works there either way.
  registerRelayRetryLegJobHandler({ tokenBucket: deps.tokenBucket, sendAttemptsRepo: deps.sendAttemptsRepo });
  registerBroadcastSendJobHandler({ tokenBucket: deps.tokenBucket, sendAttemptsRepo: deps.sendAttemptsRepo });
  // send.reconcile (SOR D11): registered WITHOUT the run-once marker - every
  // write it makes is idempotent or fenced on the attempt record, so a
  // redelivery is a genuine retry. Both entrypoints get it through here.
  registerSendReconcileJobHandler({ sendAttemptsRepo: deps.sendAttemptsRepo });
  registerMissedCallAutoTextJobHandler({ tokenBucket: deps.tokenBucket });
  registerVoiceTranscriptJobHandlers();
  registerRelayWarmJobHandler();
  registerRelayNumberReadyJobHandler();
  // Native group texting: a Conversations rail CREATE (a Conversation plus its
  // participants). Spike F3 proved that transmits nothing to any handset, so it
  // draws no A2P token - the outbound post that follows is metered by the send
  // path, not by this handler.
  registerGroupRailJobHandler();
  // Deferred inbound-media mirror (a Twilio media fetch + an S3 put; no
  // outbound traffic, no token).
  registerMediaMirrorJobHandler();
  // Organization-name rewrite (spec 2026-10-06 D11): conditional record writes
  // only - it sends nothing, so it draws no token. It catches its own errors and
  // never rethrows, so SQS never redelivers it.
  registerOrgRewriteJobHandler();
}
