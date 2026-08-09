// Deterministic fake extraction driver - the seam e2e/tests drive. Imports ONLY
// TYPES from extraction.ts (erased at runtime), so there is no runtime import
// cycle: extraction.ts imports the class below as a value; this module imports
// nothing from it at runtime. The one runtime import, prompt.js, imports only a
// TYPE from extraction.ts, so it closes no cycle either.
//
// Protocol: scan the transcript NEWEST-first for the first CLIENT utterance that
// contains a line starting with `EXTRACT:`. The rest of that line is JSON,
// parsed as Partial<ExtractionResult> and merged over an empty result. Staff
// utterances and older markers are ignored. Malformed JSON or no marker ->
// empty result (warn, never throw). config refuses driver 'fake' in production.
//
// FAILURE MARKER (dev/test only, F7c). The driver's discriminated `ok: false`
// arm - the one that produces outcome 'failed', an error block, a burned
// attempt and eventually a parked row - had NO hermetic reachability, because
// every exit above returns ok:true. A marker payload carrying the dev-only key
// `__fail` therefore drives that arm directly:
//
//   EXTRACT:{"__fail":"parse"}
//   EXTRACT:{"__fail":"driver","__failMessage":"connect ECONNREFUSED"}
//   EXTRACT:{"__fail":"refusal"}
//
// `__fail` must be one of the three real discriminants ('refusal' | 'parse' |
// 'driver'); anything else is ignored and the payload extracts normally.
// `__failMessage` overrides the default message. The returned `meta` mirrors
// what the REAL driver knows at each stage (adapters/extraction.ts:195-260): a
// 'parse' failure carries rawText (the response text is the whole explanation),
// while 'driver' and 'refusal' arrive before or without a response body and
// carry none. The keys are `__`-prefixed so they can never collide with the
// extraction schema, and EXTRACTION_DRIVER=fake is refused under NODE_ENV=production.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { extractionPromptFingerprint } from '../services/extraction/prompt.js';
import type { ExtractionCall, ExtractionDriver, ExtractionInput, ExtractionMeta, ExtractionResult } from './extraction.js';

const MARKER = 'EXTRACT:';

type FakeFailureKind = 'refusal' | 'parse' | 'driver';

const FAILURE_KINDS: readonly FakeFailureKind[] = ['refusal', 'parse', 'driver'];

const DEFAULT_FAILURE_MESSAGE: Record<FakeFailureKind, string> = {
  refusal: 'fake extraction driver: simulated refusal',
  parse: 'fake extraction driver: simulated parse failure',
  driver: 'fake extraction driver: simulated driver failure',
};

interface FailureMarker {
  __fail?: unknown;
  __failMessage?: unknown;
}

function failureKind(value: unknown): FakeFailureKind | undefined {
  return FAILURE_KINDS.find((kind) => kind === value);
}

export class FakeExtractionDriver implements ExtractionDriver {
  readonly kind = 'fake' as const;
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? defaultLogger;
  }

  async extract(input: ExtractionInput): Promise<ExtractionCall> {
    // Newest-first by timestamp (robust to caller ordering).
    const newestFirst = [...input.transcript].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    // The real driver stamps the fingerprint on the meta it assembles FIRST, on
    // every exit (adapters/extraction.ts:189-193), so the run log's fingerprint
    // plumbing is only exercisable if the fake does the same.
    const fingerprint = extractionPromptFingerprint();
    for (const utterance of newestFirst) {
      if (utterance.speaker !== 'client') continue;
      const markerLine = utterance.text.split(/\r?\n/).find((line) => line.startsWith(MARKER));
      if (markerLine === undefined) continue;
      // The marker PAYLOAD only - real JSON, never the EXTRACT:-prefixed line.
      // parseExtractionOps reads this, and a leaked prefix would make it return
      // the empty view and record every decision as not_addressed (design 7.1).
      const json = markerLine.slice(MARKER.length);
      const meta: ExtractionMeta = { driver: 'fake', promptFingerprint: fingerprint, rawText: json };
      try {
        const partial = JSON.parse(json) as Partial<ExtractionResult> & FailureMarker;
        const failure = failureKind(partial.__fail);
        if (failure !== undefined) {
          const message = typeof partial.__failMessage === 'string'
            ? partial.__failMessage
            : DEFAULT_FAILURE_MESSAGE[failure];
          // Mirror the real driver's meta per stage: only 'parse' has seen a
          // response body, so only 'parse' keeps rawText.
          const failureMeta: ExtractionMeta = failure === 'parse'
            ? meta
            : { driver: 'fake', promptFingerprint: fingerprint };
          this.log.warn(
            { failure },
            'fake extraction driver: simulated failure marker',
          );
          return { ok: false, meta: failureMeta, failure, message };
        }
        return { ok: true, meta, result: { fields: {}, ...partial } };
      } catch (err) {
        // Behavior UNCHANGED: a malformed marker is an EMPTY result, never a
        // failure and never a throw. rawText still rides along.
        this.log.warn({ err }, 'fake extraction driver: malformed EXTRACT marker JSON, returning empty result');
        return { ok: true, meta, result: { fields: {} } };
      }
    }
    return { ok: true, meta: { driver: 'fake', promptFingerprint: fingerprint }, result: { fields: {} } };
  }
}
