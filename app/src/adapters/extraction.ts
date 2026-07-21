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
import { buildExtractionSystemPrompt, buildExtractionUserContent } from '../services/extraction/prompt.js';
import { EXTRACTION_SCHEMA, parseExtractionText } from '../services/extraction/schema.js';
import { FakeExtractionDriver } from './extractionFake.js';
// Type-only import (erased at runtime) keeps the fake-driver no-runtime-cycle
// rule intact - address.ts is a pure leaf and nothing here imports it at runtime.
import type { ExtractionAddressParts } from '../services/extraction/address.js';

export interface TranscriptUtterance {
  // 'unknown' is a call line labeled `Speaker N:` (legacy/underivable role) -
  // the extraction job assigns it (adapters/extractionFake skips non-client
  // speakers; the prompt renders the label verbatim).
  speaker: 'staff' | 'client' | 'unknown';
  text: string;
  at: string; // ISO 8601
  channel: 'sms' | 'voice';
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

export interface ExtractionDriver {
  readonly kind: 'anthropic' | 'console' | 'fake';
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

/** Thrown when the model declines to answer (stop_reason 'refusal'). */
export class ExtractionRefusedError extends Error {}

/** The canonical "nothing to do" result. */
export const EMPTY_EXTRACTION: ExtractionResult = Object.freeze({ fields: {} }) as ExtractionResult;

const MAX_OUTPUT_TOKENS = 2048;

class ConsoleExtractionDriver implements ExtractionDriver {
  readonly kind = 'console' as const;
  private readonly log: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.log = opts.logger ?? defaultLogger;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    this.log.info(
      { transcriptLength: input.transcript.length, contactType: input.profile.contactType },
      'console extraction driver: returning empty result (offline)',
    );
    return EMPTY_EXTRACTION;
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

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
      system: buildExtractionSystemPrompt(),
      messages: [{ role: 'user', content: buildExtractionUserContent(input) }],
    });
    // Per-run token spend (cost observability for the input caps). Counts
    // only - never transcript text (PII).
    this.log.info(
      {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        transcriptUtterances: input.transcript.length,
      },
      'anthropic extraction usage',
    );
    if (message.stop_reason === 'refusal') {
      throw new ExtractionRefusedError('Anthropic declined to extract (stop_reason: refusal)');
    }
    const textBlock = message.content.find(
      (block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text',
    );
    if (!textBlock) {
      throw new Error('Anthropic extraction response contained no text block');
    }
    return parseExtractionText(textBlock.text);
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
