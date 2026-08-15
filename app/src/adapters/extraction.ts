// ExtractionDriver - the ONLY place the Anthropic SDK is imported (adapter rule,
// mirroring adapters/messaging.ts for the Twilio SDK). Everything downstream
// depends on the driver interface + the shared types declared here, never on
// @anthropic-ai/sdk directly.
//
// Three drivers:
// - anthropic: one structured-outputs messages.create call (prod).
// - console:   logs a one-line summary and returns EMPTY_EXTRACTION so
//              `npm run dev` stays fully offline.
// - fake:      deterministic EXTRACT: marker protocol for tests/e2e (in
//              extractionFake.ts; config refuses driver 'fake' in production).
import Anthropic from '@anthropic-ai/sdk';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  buildExtractionSystemPrompt,
  buildExtractionUserContent,
  extractionPromptFingerprint,
} from '../services/extraction/prompt.js';
import { EXTRACTION_SCHEMA, parseExtractionText } from '../services/extraction/schema.js';
import { FakeExtractionDriver } from './extractionFake.js';
// Type-only import (erased at runtime) keeps the fake-driver no-runtime-cycle
// rule intact - address.ts is a pure leaf and nothing here imports it at runtime.
import type { ExtractionAddressParts } from '../services/extraction/address.js';

export interface TranscriptUtterance {
  /**
   * The tsMsgId of the stored message this utterance came from. REQUIRED, not
   * optional: an optional id would let a construction site omit it and silently
   * produce a message the run log cannot hash (design 2026-08-06 section 6.1).
   * A call transcript yields many utterances - all share the call row's id.
   * NEVER rendered into the prompt (services/extraction/prompt.ts).
   */
  tsMsgId: string;
  // 'unknown' is a call line labeled `Speaker N:` (legacy/underivable role) -
  // the extraction job assigns it (adapters/extractionFake skips non-client
  // speakers; the prompt renders the label verbatim).
  speaker: 'staff' | 'client' | 'unknown';
  text: string;
  at: string; // ISO 8601
  // NOTE (ADJ-13): this is the TRANSCRIPT channel - a different union from the
  // extraction-repo SCHEDULING channel ('sms'|'voice'|'triage'|'email').
  // 'triage' is a scheduling trigger, never transcript content - do not add it.
  channel: 'sms' | 'voice' | 'email';
}

export type ExtractableField =
  | 'firstName'
  | 'lastName'
  | 'voucherSize'
  | 'housingAuthority'
  | 'pets'
  | 'evictions'
  | 'tenure'
  | 'porting';

export interface ExtractionFieldOp {
  op: 'none' | 'write' | 'suggest';
  value?: string; // always a string; the apply-layer coerces per field
  reason?: string;
}

/** Re-export the parts shape so downstream (schema parse, apply, accept route,
 *  dashboard types) has ONE import site for it. */
export type { ExtractionAddressParts };

/** The ninth extraction target: the client's CURRENT address as structured parts. */
export interface ExtractionAddress {
  op: 'write' | 'suggest';
  parts: ExtractionAddressParts; // only non-empty trimmed parts
  reason?: string;
}

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: 'tenant' | 'landlord'; reason?: string };
  phoneAddition?: { phone: string; label?: string; reason?: string };
  /** The client's current address as structured parts (parsed from the wire's
   *  all-required address block; absent when op "none" or no usable parts). */
  address?: ExtractionAddress;
  noteLines?: string[];
  // The model's role attribution for `Speaker N`-labeled (unknown) call lines:
  // each Speaker label mapped to client/staff/uncertain (spec Layer 2). Keyed by
  // the raw label (e.g. "Speaker 1"). Absent when the window had no unknown
  // speakers. On the wire it is an array of {speaker,role} pairs (schema.ts);
  // parseExtractionText folds it to this Record.
  speakerRoles?: Record<string, 'client' | 'staff' | 'uncertain'>;
}

export interface ExtractionProfileSnapshot {
  contactType: string;
  status?: string;
  firstName?: string;
  lastName?: string;
  voucherSize?: number;
  housingAuthority?: string;
  pets?: string;
  evictions?: string;
  tenure?: string;
  porting?: boolean;
  notes?: string;
  /** Single-line formatted current address ("line1, line2, city, state, zip"). */
  address?: string;
  phones: string[];
}

export interface ExtractionInput {
  transcript: TranscriptUtterance[];
  profile: ExtractionProfileSnapshot;
}

/** Everything about the CALL, independent of whether it succeeded. */
export interface ExtractionMeta {
  driver: 'anthropic' | 'console' | 'fake';
  /** The model id actually called. Absent on console/fake. */
  model?: string;
  /** The model's response text, VERBATIM, pre-parse. REAL JSON - on the fake
   *  driver this is the EXTRACT: marker PAYLOAD, never the prefixed line, so
   *  parseExtractionOps can read it. Absent on console, and on a driver failure
   *  before a response arrived. PII by design. */
  rawText?: string;
  usage?: { inputTokens: number; outputTokens: number };
  promptFingerprint?: string;
}

/**
 * A DISCRIMINATED result rather than a throw, for two reasons (design 6.4): the
 * caller must know WHICH STAGE failed, and a thrown error carrying rawText
 * would put contact PII on the one object type this codebase's loggers
 * serialize wholesale (`logger.error({ err })`).
 *
 * It also saves the case a throwing parse loses outright: meta is assembled
 * FIRST, so rawText survives a parse failure - the single failure mode where
 * the response text is the entire answer to "what went wrong".
 */
export type ExtractionCall =
  | { ok: true; meta: ExtractionMeta; result: ExtractionResult }
  | {
      ok: false;
      meta: ExtractionMeta;
      failure: 'refusal' | 'parse' | 'truncated' | 'driver';
      message: string;
    };

export interface ExtractionDriver {
  readonly kind: 'anthropic' | 'console' | 'fake';
  extract(input: ExtractionInput): Promise<ExtractionCall>;
}

/** The model declined to answer. The anthropic driver now RETURNS { ok:false, failure:'refusal' } instead of throwing this; the class survives as the error the job's temporary unwrap raises and as a stable instanceof for callers. */
export class ExtractionRefusedError extends Error {}

/** The canonical "nothing to do" result. */
export const EMPTY_EXTRACTION: ExtractionResult = Object.freeze({ fields: {} }) as ExtractionResult;

/**
 * Output-token ceiling for one extraction call.
 *
 * This budget must cover the WHOLE all-required wire object: eight field ops at
 * op+value+reason each, statusAdvance, typeSuggestion, phoneAddition, the
 * address parts block, noteLines, and one speakerRoles pair per `Speaker N`
 * label. A `voice` run is the largest of those by construction, and 2048 left
 * it no headroom - the model hit the cap mid-object and the run failed.
 *
 * Raised to 4096 with THINKING_CONFIG below, not instead of it: the cap is only
 * a meaningful "JSON only" budget while thinking is off, because max_tokens
 * bounds thinking plus response text together.
 */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Thinking is pinned OFF, explicitly, on every call.
 *
 * NEVER omit this parameter. What omission MEANS is per-model and changed under
 * us: on claude-opus-4-8 (the model this driver was written and tested against)
 * an absent `thinking` runs with thinking off, but on claude-sonnet-5 the same
 * absent parameter runs ADAPTIVE thinking. Because max_tokens caps thinking and
 * response text together, swapping AI_EXTRACTION_MODEL to sonnet-5 silently
 * handed the JSON budget to reasoning tokens and truncated every large run -
 * the model string was the only thing that changed.
 *
 * Extraction is mechanical structured output against a fixed schema, so there
 * is nothing here for thinking to buy. Stating it explicitly makes the budget
 * mean the same thing on whatever model AI_EXTRACTION_MODEL names next.
 */
const THINKING_CONFIG = { type: 'disabled' } as const;

class ConsoleExtractionDriver implements ExtractionDriver {
  readonly kind = 'console' as const;
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? defaultLogger;
  }

  async extract(input: ExtractionInput): Promise<ExtractionCall> {
    this.log.info(
      { transcriptLength: input.transcript.length, contactType: input.profile.contactType },
      'console extraction driver: returning empty result (offline)',
    );
    // No model, no response text, no usage - it never called anything. The run
    // log records `driver: console` and leaves the rest absent, and with no
    // rawText NO target may be recorded as no_finding (design 7.1).
    return { ok: true, meta: { driver: 'console' }, result: EMPTY_EXTRACTION };
  }
}

class AnthropicExtractionDriver implements ExtractionDriver {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly log: Logger;

  constructor(opts: { apiKey: string; apiBaseUrl?: string; model: string; logger?: Logger }) {
    // Constructed once per driver instance (mirrors the Twilio adapter).
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.apiBaseUrl ? { baseURL: opts.apiBaseUrl } : {}) });
    this.model = opts.model;
    this.log = opts.logger ?? defaultLogger;
  }

  async extract(input: ExtractionInput): Promise<ExtractionCall> {
    // Meta is assembled INCREMENTALLY and returned on every path, so a failure
    // never discards what we already learned (design 6.4).
    const meta: ExtractionMeta = {
      driver: 'anthropic',
      model: this.model,
      promptFingerprint: extractionPromptFingerprint(),
    };
    let message: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: THINKING_CONFIG,
        output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
        system: buildExtractionSystemPrompt(),
        messages: [{ role: 'user', content: buildExtractionUserContent(input) }],
      });
    } catch (err) {
      return { ok: false, meta, failure: 'driver', message: err instanceof Error ? err.message : String(err) };
    }
    // Everything below dereferences the RESPONSE. The types promise `usage` and
    // `content`, but a stubbed/proxied client, a future SDK version or a
    // streaming variant can hand back a shape that lacks them - and a TypeError
    // escaping extract() would defeat the discriminated return entirely: its one
    // caller (jobs/extraction.ts) does not wrap it, so the job's backstop would
    // record errorKind 'repo' for a driver fault, and a thrown Error is the one
    // object type this codebase's loggers serialize wholesale (rawText is PII).
    // A malformed response is therefore a 'driver' FAILURE, never a throw.
    const usage: typeof message.usage | undefined = message?.usage;
    const usageOk =
      typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number';
    if (usageOk) {
      meta.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      // Per-run token spend (cost observability for the input caps). Counts
      // only - never transcript text (PII). Stays with the stamp so a BILLED
      // refusal is still costed - the refusal return below is not a reason to
      // stop accounting for tokens the provider charged us for.
      this.log.info(
        {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          transcriptUtterances: input.transcript.length,
        },
        'anthropic extraction usage',
      );
    }
    // A refusal is the model DECLINING, not the transport breaking. Its
    // discriminator is stop_reason, which arrives on a 200 regardless of the
    // usage shape - a pre-output classifier decline is not billed at all, so
    // it can carry no counts. Classify it BEFORE the usage guard, or an honest
    // refusal is filed as errorKind 'driver'. Usage is stamped above first, so
    // a billed refusal still keeps its counts.
    if (message?.stop_reason === 'refusal') {
      return {
        ok: false, meta, failure: 'refusal',
        message: 'Anthropic declined to extract (stop_reason: refusal)',
      };
    }
    // A max_tokens stop is a TRUNCATION, not a malformed response: the model was
    // still writing when the budget ran out. It is classified here, beside the
    // refusal arm and BEFORE the content/parse arms below, or it lands as
    // whichever of those the wreckage happens to trip - 'driver' ("no text
    // block") when the cap was spent before any JSON was emitted, 'parse'
    // (SyntaxError) when it was spent mid-object. Both of those name a symptom
    // and send the reader looking for a broken response; only the stop reason
    // names the cause, and only this arm can tell an operator to raise the cap.
    if (message?.stop_reason === 'max_tokens') {
      // Best-effort partial text: on a mid-object cut this IS the evidence, and
      // the arm that normally stamps rawText sits below this early return.
      const partial = Array.isArray(message.content)
        ? message.content.find(
            (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
          )
        : undefined;
      if (partial !== undefined) meta.rawText = partial.text;
      const spent = meta.usage?.outputTokens;
      return {
        ok: false, meta, failure: 'truncated',
        message:
          `Anthropic extraction hit the ${MAX_OUTPUT_TOKENS}-token output cap` +
          (spent === undefined ? '' : ` (${spent} output tokens)`) +
          ' and returned an incomplete response (stop_reason: max_tokens)',
      };
    }
    if (!usageOk) {
      return {
        ok: false, meta, failure: 'driver',
        message: 'Anthropic extraction response carried no usage counts',
      };
    }
    const content: typeof message.content | undefined = message.content;
    if (!Array.isArray(content)) {
      return {
        ok: false, meta, failure: 'driver',
        message: 'Anthropic extraction response contained no content blocks',
      };
    }
    const textBlock = content.find(
      (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
    );
    if (!textBlock) {
      return {
        ok: false, meta, failure: 'driver',
        message: 'Anthropic extraction response contained no text block',
      };
    }
    // rawText is stamped BEFORE the parse, so a malformed response still carries
    // the text that explains it.
    meta.rawText = textBlock.text;
    try {
      return { ok: true, meta, result: parseExtractionText(textBlock.text) };
    } catch (err) {
      return { ok: false, meta, failure: 'parse', message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createExtractionDriver(cfg: {
  driver: 'anthropic' | 'console' | 'fake';
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
  logger?: Logger;
}): ExtractionDriver {
  switch (cfg.driver) {
    case 'console':
      return new ConsoleExtractionDriver();
    case 'fake':
      return new FakeExtractionDriver();
    case 'anthropic': {
      if (!cfg.apiKey) {
        throw new Error('createExtractionDriver: driver "anthropic" requires an apiKey');
      }
      return new AnthropicExtractionDriver({
        apiKey: cfg.apiKey,
        ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
        ...(cfg.logger ? { logger: cfg.logger } : {}),
        model: cfg.model,
      });
    }
    default: {
      const exhaustive: never = cfg.driver;
      throw new Error(`createExtractionDriver: unknown driver ${String(exhaustive)}`);
    }
  }
}
