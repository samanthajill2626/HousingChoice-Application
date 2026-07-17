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

export interface TranscriptUtterance {
  speaker: 'staff' | 'client';
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

export interface ExtractionResult {
  fields: Partial<Record<ExtractableField, ExtractionFieldOp>>;
  statusAdvance?: { suggest: boolean; reason?: string };
  typeSuggestion?: { value: 'tenant' | 'landlord'; reason?: string };
  phoneAddition?: { phone: string; label?: string; reason?: string };
  noteLines?: string[];
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

  constructor(opts: { apiKey: string; apiBaseUrl?: string; model: string }) {
    // Constructed once per driver instance (mirrors the Twilio adapter).
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.apiBaseUrl ? { baseURL: opts.apiBaseUrl } : {}) });
    this.model = opts.model;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
      system: buildExtractionSystemPrompt(),
      messages: [{ role: 'user', content: buildExtractionUserContent(input) }],
    });
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
        model: cfg.model,
      });
    }
    default: {
      const exhaustive: never = cfg.driver;
      throw new Error(`createExtractionDriver: unknown driver ${String(exhaustive)}`);
    }
  }
}
