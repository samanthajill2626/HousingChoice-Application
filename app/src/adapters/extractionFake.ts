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
// The payload is NOT run through parseExtractionText, so nothing here is
// validated. noteLines items are { "text": ..., "confidence": ... } (B1 spec
// D4); every value rule - the floor included - is apply.ts filterNoteLines,
// which drops a legacy string item without throwing (B1 watch item WI1). A
// marker line meant to land needs a confidence at or above
// EXTRACTION_FACT_MIN_CONFIDENCE (default 0.7).
//
// WP1 B1 payload examples (spec 2026-10-26-wp1-b1-ranking-inputs D3-D5); the
// fake passes them through as above:
//
//   EXTRACT:{"fields":{"<field key>":{"op":"write","value":"Decatur"}}}
//   EXTRACT:{"noteLines":[{"text":"<label>: on the fence - wants to see others","confidence":0.9}]}
//   EXTRACT:{"noteLines":[{"text":"Might have a cat","confidence":0.4}]}
//
// <field key> is any key of TENANT_MATCHING_INPUTS (lib/tenantMatchingInputs.ts)
// or another extractable field. <label> is the sent property's propertyLabel
// (lib/propertyLabel.ts); the second line is a feedback line (counted in
// feedbackLines when the run's PROPERTIES SENT block lists that property) and
// the third falls below the default 0.7 floor (counted in notesBelowFloor).
// The fake never reads the PROPERTIES SENT block itself.
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
//   EXTRACT:{"__fail":"truncated"}
//
// `__fail` must be one of the four real discriminants ('refusal' | 'parse' |
// 'truncated' | 'driver'); anything else is ignored and the payload extracts
// normally. `__failMessage` overrides the default message. The returned `meta`
// mirrors what the REAL driver knows at each stage (adapters/extraction.ts): a
// 'parse' failure carries rawText (the response text is the whole explanation),
// and so does 'truncated' (the partial JSON is the evidence of where the cap
// cut it), while 'driver' and 'refusal' arrive before or without a response
// body and carry none. The keys are `__`-prefixed so they can never collide with the
// extraction schema, and EXTRACTION_DRIVER=fake is refused under NODE_ENV=production.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { extractionPromptFingerprint } from '../services/extraction/prompt.js';
import type { ExtractionCall, ExtractionDriver, ExtractionInput, ExtractionMeta, ExtractionResult } from './extraction.js';

const MARKER = 'EXTRACT:';

type FakeFailureKind = 'refusal' | 'parse' | 'truncated' | 'driver';

const FAILURE_KINDS: readonly FakeFailureKind[] = ['refusal', 'parse', 'truncated', 'driver'];

const DEFAULT_FAILURE_MESSAGE: Record<FakeFailureKind, string> = {
  refusal: 'fake extraction driver: simulated refusal',
  parse: 'fake extraction driver: simulated parse failure',
  truncated: 'fake extraction driver: simulated max_tokens truncation',
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
          // Mirror the real driver's meta per stage: 'parse' and 'truncated'
          // have both seen response text (a malformed body, and a body the cap
          // cut mid-write), so both keep rawText. 'driver' and 'refusal' arrive
          // before or without one and carry none.
          const failureMeta: ExtractionMeta = failure === 'parse' || failure === 'truncated'
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
