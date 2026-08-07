// Deterministic fake extraction driver - the seam e2e/tests drive. Imports ONLY
// TYPES from extraction.ts (erased at runtime), so there is no runtime import
// cycle: extraction.ts imports the class below as a value; this module imports
// nothing from it at runtime.
//
// Protocol: scan the transcript NEWEST-first for the first CLIENT utterance that
// contains a line starting with `EXTRACT:`. The rest of that line is JSON,
// parsed as Partial<ExtractionResult> and merged over an empty result. Staff
// utterances and older markers are ignored. Malformed JSON or no marker ->
// empty result (warn, never throw). config refuses driver 'fake' in production.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ExtractionCall, ExtractionDriver, ExtractionInput, ExtractionMeta, ExtractionResult } from './extraction.js';

const MARKER = 'EXTRACT:';

export class FakeExtractionDriver implements ExtractionDriver {
  readonly kind = 'fake' as const;
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? defaultLogger;
  }

  async extract(input: ExtractionInput): Promise<ExtractionCall> {
    // Newest-first by timestamp (robust to caller ordering).
    const newestFirst = [...input.transcript].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const utterance of newestFirst) {
      if (utterance.speaker !== 'client') continue;
      const markerLine = utterance.text.split(/\r?\n/).find((line) => line.startsWith(MARKER));
      if (markerLine === undefined) continue;
      // The marker PAYLOAD only - real JSON, never the EXTRACT:-prefixed line.
      // parseExtractionOps reads this, and a leaked prefix would make it return
      // the empty view and record every decision as not_addressed (design 7.1).
      const json = markerLine.slice(MARKER.length);
      const meta: ExtractionMeta = { driver: 'fake', rawText: json };
      try {
        const partial = JSON.parse(json) as Partial<ExtractionResult>;
        return { ok: true, meta, result: { fields: {}, ...partial } };
      } catch (err) {
        // Behavior UNCHANGED: a malformed marker is an EMPTY result, never a
        // failure and never a throw. rawText still rides along.
        this.log.warn({ err }, 'fake extraction driver: malformed EXTRACT marker JSON, returning empty result');
        return { ok: true, meta, result: { fields: {} } };
      }
    }
    return { ok: true, meta: { driver: 'fake' }, result: { fields: {} } };
  }
}
