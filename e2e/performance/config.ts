import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import {
  resolvePerformanceSeedConfig,
  toPerformanceSeedManifest,
  type PerformanceSeedInput,
  type PerformanceSeedManifest,
  type ResolvedPerformanceSeedConfig,
} from '../../app/src/lib/seed/performance.js';
import type { TargetKind } from './types.js';

export type BrowserChannel = 'chromium' | 'chrome';
export type SelfQaMode = 'narrow' | 'full';

export interface RunConfig {
  target: TargetKind;
  baseUrl: string | null;
  loginEmail: string;
  baselinePath: string | null;
  browserChannel: BrowserChannel;
  headed: boolean;
  coldRepeats: number;
  warmRepeats: number;
  readyTimeoutMs: number;
  sourceTimeoutMs: number;
  loginTimeoutMs: number;
  settleMs: number;
  pollMs: number;
  routeOrderSeed: number;
  contractCheckpoint: boolean;
  selfQa: SelfQaMode | null;
  printConfig: boolean;
  seed: ResolvedPerformanceSeedConfig | null;
}

export interface SafeRunConfig {
  target: TargetKind;
  browserChannel: BrowserChannel;
  headed: boolean;
  coldRepeats: number;
  warmRepeats: number;
  readyTimeoutMs: number;
  sourceTimeoutMs: number;
  loginTimeoutMs: number;
  settleMs: number;
  pollMs: number;
  routeOrderSeed: number;
  contractCheckpoint: boolean;
  selfQa: SelfQaMode | null;
  seed: PerformanceSeedManifest | null;
}

export interface ParseRunConfigDeps {
  cwd?: string;
  now?: () => Date;
  randomRouteOrderSeed?: () => number;
}

const VALUE_OPTIONS = new Set([
  'scale',
  'contacts',
  'units',
  'placements',
  'tours',
  'conversations',
  'messages-per-conversation',
  'broadcasts',
  'recipients-per-broadcast',
  'cold-repeats',
  'warm-repeats',
  'ready-timeout-ms',
  'source-timeout-ms',
  'login-timeout-ms',
  'settle-ms',
  'poll-ms',
  'route-order-seed',
  'baseline',
  'base-url',
  'login-email',
  'browser-channel',
  'self-qa',
]);

const FLAG_OPTIONS = new Set(['headed', 'print-config', 'contract-checkpoint']);
const SEED_OPTION_NAMES = [
  'scale',
  'contacts',
  'units',
  'placements',
  'tours',
  'conversations',
  'messages-per-conversation',
  'broadcasts',
  'recipients-per-broadcast',
] as const;
const OVERRIDE_OPTION_NAMES = SEED_OPTION_NAMES.slice(1);

function parseOptions(argv: string[]): {
  target: TargetKind;
  values: Map<string, string>;
  flags: Set<string>;
  explicit: Set<string>;
} {
  const [targetValue, ...rest] = argv;
  if (!targetValue || !['hermetic', 'local', 'hosted-dev'].includes(targetValue)) {
    throw new Error('target must be hermetic, local, or hosted-dev');
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const explicit = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) throw new Error('unexpected positional argument');
    const separator = token.indexOf('=');
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (explicit.has(name)) throw new Error(`--${name} may be supplied only once`);
    explicit.add(name);

    if (FLAG_OPTIONS.has(name)) {
      if (separator >= 0) throw new Error(`--${name} does not accept a value`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`--${name} is not supported`);

    const value = separator >= 0 ? token.slice(separator + 1) : rest[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    values.set(name, value);
  }

  return { target: targetValue as TargetKind, values, flags, explicit };
}

function positiveInteger(values: Map<string, string>, name: string, fallback: number): number {
  const raw = values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function seedInteger(values: Map<string, string>, name: string): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function normalizeBaseUrl(target: TargetKind, raw: string | undefined): string | null {
  if (target === 'hermetic') return null;
  if (raw === undefined) throw new Error('--base-url is required');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('--base-url is invalid');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--base-url is invalid');
  }
  if (target === 'hosted-dev') {
    if (url.protocol !== 'https:') throw new Error('--base-url must use HTTPS');
  } else {
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !loopback || url.port !== '5174') {
      throw new Error('--base-url must be loopback port 5174');
    }
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function assertForbidden(explicit: Set<string>, names: readonly string[], context: string): void {
  for (const name of names) {
    if (explicit.has(name)) throw new Error(`--${name} is forbidden for ${context}`);
  }
}

function seedInput(values: Map<string, string>): PerformanceSeedInput {
  return {
    scale: seedInteger(values, 'scale'),
    contacts: seedInteger(values, 'contacts'),
    units: seedInteger(values, 'units'),
    placements: seedInteger(values, 'placements'),
    tours: seedInteger(values, 'tours'),
    conversations: seedInteger(values, 'conversations'),
    messagesPerConversation: seedInteger(values, 'messages-per-conversation'),
    broadcasts: seedInteger(values, 'broadcasts'),
    recipientsPerBroadcast: seedInteger(values, 'recipients-per-broadcast'),
  };
}

function assertLockedDiagnosticMode(
  modeOption: '--self-qa' | '--contract-checkpoint',
  seed: ResolvedPerformanceSeedConfig,
  coldRepeats: number,
  warmRepeats: number,
  explicit: Set<string>,
): void {
  if (
    seed.scale !== 1 ||
    seed.contacts !== 100 ||
    seed.units !== 25 ||
    seed.placements !== 50 ||
    seed.tours !== 50 ||
    seed.conversations !== 100 ||
    seed.messagesPerConversation !== 10 ||
    seed.broadcasts !== 10 ||
    seed.recipientsPerBroadcast !== 25 ||
    coldRepeats !== 1 ||
    warmRepeats !== 1
  ) {
    throw new Error(`${modeOption} requires default scale 1 and one cold and warm repeat`);
  }
  for (const name of OVERRIDE_OPTION_NAMES) {
    if (explicit.has(name)) throw new Error(`${modeOption} rejects --${name}`);
  }
}

export function parseRunConfig(argv: string[], deps: ParseRunConfigDeps = {}): RunConfig {
  const { target, values, flags, explicit } = parseOptions(argv);
  const contractCheckpoint = flags.has('contract-checkpoint');
  const selfQaValue = values.get('self-qa');
  if (selfQaValue !== undefined && selfQaValue !== 'narrow' && selfQaValue !== 'full') {
    throw new Error('--self-qa must be narrow or full');
  }
  const selfQa = (selfQaValue ?? null) as SelfQaMode | null;
  if (contractCheckpoint && selfQa !== null) {
    throw new Error('--contract-checkpoint and --self-qa are mutually exclusive');
  }

  if (target !== 'hermetic') {
    assertForbidden(explicit, [...SEED_OPTION_NAMES, 'self-qa', 'contract-checkpoint'], target);
  } else {
    assertForbidden(explicit, ['base-url', 'login-email', 'headed'], target);
  }

  const channelValue = values.get('browser-channel') ?? 'chromium';
  if (channelValue !== 'chromium' && channelValue !== 'chrome') {
    throw new Error('--browser-channel must name a supported channel');
  }
  const browserChannel = channelValue as BrowserChannel;
  if (target === 'hermetic' && browserChannel !== 'chromium') {
    throw new Error('--browser-channel is forbidden for hermetic');
  }

  const headed = flags.has('headed');
  if (target === 'hosted-dev' && !headed) throw new Error('--headed is required for hosted-dev');

  const coldRepeats = positiveInteger(values, 'cold-repeats', 3);
  const warmRepeats = positiveInteger(values, 'warm-repeats', 3);
  const readyTimeoutMs = positiveInteger(values, 'ready-timeout-ms', 120_000);
  const sourceTimeoutMs = positiveInteger(values, 'source-timeout-ms', 120_000);
  const loginTimeoutMs = positiveInteger(values, 'login-timeout-ms', 300_000);
  const settleMs = positiveInteger(values, 'settle-ms', 500);
  const pollMs = positiveInteger(values, 'poll-ms', 100);
  if (settleMs < pollMs) throw new Error('--settle-ms must be at least --poll-ms');
  const routeOrderSeed = positiveInteger(
    values,
    'route-order-seed',
    (deps.randomRouteOrderSeed ?? (() => randomInt(1, 2_147_483_647)))(),
  );
  const seed =
    target === 'hermetic'
      ? resolvePerformanceSeedConfig(seedInput(values), undefined, deps.now ?? (() => new Date()))
      : null;

  if (seed && selfQa !== null) {
    assertLockedDiagnosticMode('--self-qa', seed, coldRepeats, warmRepeats, explicit);
  }
  if (seed && contractCheckpoint) {
    assertLockedDiagnosticMode('--contract-checkpoint', seed, coldRepeats, warmRepeats, explicit);
  }

  return {
    target,
    baseUrl: normalizeBaseUrl(target, values.get('base-url')),
    loginEmail: values.get('login-email') ?? 'founder@example.com',
    baselinePath: values.has('baseline')
      ? resolve(deps.cwd ?? process.cwd(), values.get('baseline')!)
      : null,
    browserChannel,
    headed,
    coldRepeats,
    warmRepeats,
    readyTimeoutMs,
    sourceTimeoutMs,
    loginTimeoutMs,
    settleMs,
    pollMs,
    routeOrderSeed,
    contractCheckpoint,
    selfQa,
    printConfig: flags.has('print-config'),
    seed,
  };
}

export function toSafeRunConfig(config: RunConfig): SafeRunConfig {
  return {
    target: config.target,
    browserChannel: config.browserChannel,
    headed: config.headed,
    coldRepeats: config.coldRepeats,
    warmRepeats: config.warmRepeats,
    readyTimeoutMs: config.readyTimeoutMs,
    sourceTimeoutMs: config.sourceTimeoutMs,
    loginTimeoutMs: config.loginTimeoutMs,
    settleMs: config.settleMs,
    pollMs: config.pollMs,
    routeOrderSeed: config.routeOrderSeed,
    contractCheckpoint: config.contractCheckpoint,
    selfQa: config.selfQa,
    seed: config.seed === null ? null : toPerformanceSeedManifest(config.seed),
  };
}
