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
//
// Also one structured-output CLIENT (createStructuredOutputClient, end of
// file): a one-shot JSON answer against a CALLER's system prompt, user content
// and schema, for code that is not extraction but must call the same model
// family - today only the never-written test's grader
// (app/scripts/extraction-prompt-probe.ts, WP1 B1 spec D7). It lives here so
// this file stays the only Anthropic SDK importer, and it reuses the driver's
// client construction, output cap and thinking-off form.
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
// Type-only, erased at runtime: the one list of tenant matching inputs (B1
// spec D1), a leaf that imports nothing.
import type { TENANT_MATCHING_INPUTS, TenantMatchingInputKey } from '../lib/tenantMatchingInputs.js';

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
  | 'porting'
  // B1 spec D1/D3: the tenant matching inputs, from their one list.
  | TenantMatchingInputKey;

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

export type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';

/** One model Notes line (B1 spec D4): the line and how sure the model is (0..1). */
export interface ExtractionNoteLine {
  text: string;
  confidence: number;
}

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: SuggestedContactKind; reason?: string };
  phoneAddition?: { phone: string; label?: string; reason?: string };
  /** The client's current address as structured parts (parsed from the wire's
   *  all-required address block; absent when op "none" or no usable parts). */
  address?: ExtractionAddress;
  /** B1 spec D4: up to 20 structurally valid lines, unfiltered. Every value
   *  rule (clamp, floor, guard, cap, demotion) is apply.ts filterNoteLines. */
  noteLines?: ExtractionNoteLine[];
  // The model's role attribution for `Speaker N`-labeled (unknown) call lines:
  // each Speaker label mapped to client/staff/uncertain (spec Layer 2). Keyed by
  // the raw label (e.g. "Speaker 1"). Absent when the window had no unknown
  // speakers. On the wire it is an array of {speaker,role} pairs (schema.ts);
  // parseExtractionText folds it to this Record.
  speakerRoles?: Record<string, 'client' | 'staff' | 'uncertain'>;
}

/**
 * The tenant matching inputs on the profile (B1 spec D1/D3): text kinds as
 * strings, the dollars kind as a whole number - the types toProfile gives them.
 * Mapped from the one list, so no reader names the four.
 */
export type TenantMatchingProfile = {
  [Entry in (typeof TENANT_MATCHING_INPUTS)[number] as Entry['key']]?: Entry['kind'] extends 'dollars'
    ? number
    : string;
};

export interface ExtractionProfileSnapshot extends TenantMatchingProfile {
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
  /**
   * The rendered ORGANIZATION LIST block (spec 2026-10-06 D8;
   * services/extraction/orgListBlock.ts), placed in the user content BEFORE
   * the TRANSCRIPT header. The job renders it once per run from the stored
   * list; '' renders no block. Drivers never log it.
   */
  orgListBlock: string;
  /**
   * The rendered PROPERTIES SENT block (WP1 B1 spec D5.1;
   * services/extraction/sentPropertiesBlock.ts): the properties staff sent
   * this contact, or it signed up for through a flyer, each named by its
   * label, so a feedback noteLine can name the property. Placed in the user
   * content after the ORGANIZATION LIST block and BEFORE the TRANSCRIPT
   * header. The job always renders it ("PROPERTIES SENT: none" for no sends);
   * '' renders no block (tests only). Drivers never log it.
   */
  sentPropertiesBlock: string;
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
 * This budget must cover the WHOLE all-required wire object: twelve field ops at
 * op+value+reason each, statusAdvance, typeSuggestion, phoneAddition, the
 * address parts block, noteLines, and one speakerRoles pair per `Speaker N`
 * label. A `voice` run is the largest of those by construction.
 *
 * HEADROOM, not the fix. Run 4bf0cf42 measured it: 2048 output tokens billed
 * against ~500 characters of emitted JSON - order of 150 tokens of text, with
 * the other ~1900 spent on thinking the request never asked for and never saw.
 * 2048 was always ample for the JSON alone; thinkingOff() below is what
 * actually reclaims it. 4096 just means a verbose future model has somewhere to
 * go before it truncates again.
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
 *
 * The OFF switch itself is per-model, and a wrong one is a 400 on EVERY run.
 * claude-sonnet-5-5 refuses `disabled`; its lowest setting is `between_tools`,
 * which on a request with no tools (this one) returns text only, exactly what
 * `disabled` does on the models before it - and every one of those refuses
 * `between_tools`. A model missing from this set gets `disabled`, so check a
 * new model's accepted thinking settings before pointing AI_EXTRACTION_MODEL at
 * it. claude-opus-5-5 and the Fable/Mythos models accept neither: thinking
 * cannot be turned off there at all, and this driver does not support them.
 */
const BETWEEN_TOOLS_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-5-5']);

function thinkingOff(model: string) {
  return BETWEEN_TOOLS_MODELS.has(model) ? ({ type: 'between_tools' } as const) : ({ type: 'disabled' } as const);
}

/** The ONE Anthropic client construction: the extraction driver and the structured-output client. */
function newAnthropicClient(apiKey: string, apiBaseUrl?: string): Anthropic {
  return new Anthropic({ apiKey, ...(apiBaseUrl ? { baseURL: apiBaseUrl } : {}) });
}

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
    this.client = newAnthropicClient(opts.apiKey, opts.apiBaseUrl);
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
        thinking: thinkingOff(this.model),
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

// ---------------------------------------------------------------------------
// Structured-output client - a one-shot JSON answer against a caller's schema.
// ---------------------------------------------------------------------------

/** What a structured-output caller sends: its own system prompt, user content and JSON schema. */
export interface StructuredOutputRequest {
  system: string;
  user: string;
  /** A structured-outputs json_schema: every object level `additionalProperties: false`, all keys required. */
  schema: Record<string, unknown>;
}

/**
 * A DISCRIMINATED result, never a throw (as ExtractionCall). `text` is the
 * model's response text VERBATIM; parsing it is the caller's job (the caller
 * decides what an unparseable answer means).
 */
export type StructuredOutputCall =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } }
  | {
      ok: false;
      failure: 'refusal' | 'truncated' | 'driver';
      message: string;
      /** Present when the provider billed the call. */
      usage?: { inputTokens: number; outputTokens: number };
    };

export interface StructuredOutputClient {
  readonly model: string;
  call(request: StructuredOutputRequest): Promise<StructuredOutputCall>;
}

class AnthropicStructuredOutputClient implements StructuredOutputClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(opts: { apiKey: string; apiBaseUrl?: string; model: string }) {
    this.client = newAnthropicClient(opts.apiKey, opts.apiBaseUrl);
    this.model = opts.model;
  }

  async call(request: StructuredOutputRequest): Promise<StructuredOutputCall> {
    let message: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: thinkingOff(this.model),
        output_config: { format: { type: 'json_schema', schema: request.schema } },
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      });
    } catch (err) {
      return { ok: false, failure: 'driver', message: err instanceof Error ? err.message : String(err) };
    }
    // The same defensive reading as AnthropicExtractionDriver.extract: a
    // response missing what its type promises is a 'driver' failure, never a
    // TypeError, and stop_reason is read before the usage guard.
    const raw: typeof message.usage | undefined = message?.usage;
    const usage =
      typeof raw?.input_tokens === 'number' && typeof raw.output_tokens === 'number'
        ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens }
        : undefined;
    const billed = usage === undefined ? {} : { usage };
    if (message?.stop_reason === 'refusal') {
      return { ok: false, failure: 'refusal', message: 'Anthropic declined to answer (stop_reason: refusal)', ...billed };
    }
    if (message?.stop_reason === 'max_tokens') {
      return {
        ok: false, failure: 'truncated', ...billed,
        message: `Anthropic hit the ${MAX_OUTPUT_TOKENS}-token output cap and returned an incomplete response (stop_reason: max_tokens)`,
      };
    }
    if (usage === undefined) return { ok: false, failure: 'driver', message: 'Anthropic response carried no usage counts' };
    const content: typeof message.content | undefined = message.content;
    if (!Array.isArray(content)) {
      return { ok: false, failure: 'driver', message: 'Anthropic response contained no content blocks', usage };
    }
    const textBlock = content.find(
      (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
    );
    if (!textBlock) return { ok: false, failure: 'driver', message: 'Anthropic response contained no text block', usage };
    return { ok: true, text: textBlock.text, usage };
  }
}

/**
 * A structured-output client on `model` (anthropic only - there is no console
 * or fake form; callers inject a stub in tests). Like the extraction driver it
 * cannot run claude-opus-5-5 or the Fable/Mythos models (thinkingOff).
 */
export function createStructuredOutputClient(cfg: { model: string; apiKey: string; apiBaseUrl?: string }): StructuredOutputClient {
  if (!cfg.apiKey) throw new Error('createStructuredOutputClient: an apiKey is required');
  return new AnthropicStructuredOutputClient({
    apiKey: cfg.apiKey,
    model: cfg.model,
    ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
  });
}
