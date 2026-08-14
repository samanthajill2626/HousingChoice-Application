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
  seedInput: PerformanceSeedInput | null;
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
  requestedSeedInput?: PerformanceSeedInput | null;
  seed: PerformanceSeedManifest | null;
}

export interface ParseRunConfigDeps {
  cwd?: string;
  now?: () => Date;
  randomRouteOrderSeed?: () => number;
}

export interface PublicOption {
  name: string;
  kind: 'value' | 'flag';
  seedInput?: keyof PerformanceSeedInput;
  help: string;
}

/** This is the single parser/help/target-restriction inventory for public options. */
export const PUBLIC_OPTION_CATALOG: readonly PublicOption[] = Object.freeze([
  { name: 'scale', kind: 'value', seedInput: 'scale', help: 'Hermetic-only dimensionless multiplier; default 1, inclusive 1..100; scales breadth defaults, while explicit overrides win and resolved work counts toward the cap.' },
  { name: 'contacts', kind: 'value', seedInput: 'contacts', help: 'Hermetic-only contact rows; default 100 times scale, inclusive 0..20000; overrides breadth and contributes physical cap work.' },
  { name: 'units', kind: 'value', seedInput: 'units', help: 'Hermetic-only unit rows; default 16 times scale, inclusive 0..20000; overrides breadth and contributes physical cap work.' },
  { name: 'placements', kind: 'value', seedInput: 'placements', help: 'Hermetic-only placement rows; default 50 times scale, inclusive 0..20000; overrides breadth and contributes physical cap work.' },
  { name: 'tours', kind: 'value', seedInput: 'tours', help: 'Hermetic-only tour rows; default 50 times scale, inclusive 0..20000; overrides breadth and contributes physical cap work.' },
  { name: 'conversations', kind: 'value', seedInput: 'conversations', help: 'Hermetic-only relay conversation rows; default 100 times scale, inclusive 0..20000; tail replacement needs one and messages contribute cap work.' },
  { name: 'native-groups', kind: 'value', seedInput: 'nativeGroups', help: 'Hermetic-only native group rows; default 21 times scale, inclusive 0..20000; needs two active generated contacts and exact roster capacity, and member slots contribute logical cap work.' },
  { name: 'messages-per-conversation', kind: 'value', seedInput: 'messagesPerConversation', help: 'Hermetic-only ordinary stored messages per conversation; default 10, inclusive 0..100; scale-invariant density and physical cap work.' },
  { name: 'long-conversation-messages', kind: 'value', seedInput: 'longConversationMessages', help: 'Hermetic-only tail stored messages; derives from ordinary density, inclusive 0..20000, at least ordinary density, and replaces one relay fixture in physical cap work.' },
  { name: 'broadcasts', kind: 'value', seedInput: 'broadcasts', help: 'Hermetic-only broadcast rows; default 10 times scale, inclusive 0..20000; large replacement needs one and contributes physical cap work.' },
  { name: 'recipients-per-broadcast', kind: 'value', seedInput: 'recipientsPerBroadcast', help: 'Hermetic-only ordinary recipients per broadcast; default 25, inclusive 0..1000; scale-invariant, clipped to tenant pool, and contributes logical cap work.' },
  { name: 'large-broadcast-recipients', kind: 'value', seedInput: 'largeBroadcastRecipients', help: 'Hermetic-only large-fixture recipients; derives from ordinary density, inclusive 0..1000, at least ordinary density, clipped to tenant pool, and contributes logical cap work.' },
  { name: 'cold-repeats', kind: 'value', help: 'Positive cold sample repeat count (default 3).' },
  { name: 'warm-repeats', kind: 'value', help: 'Positive warm sample repeat count (default 3).' },
  { name: 'ready-timeout-ms', kind: 'value', help: 'Positive readiness timeout in milliseconds.' },
  { name: 'source-timeout-ms', kind: 'value', help: 'Positive source-action timeout in milliseconds.' },
  { name: 'login-timeout-ms', kind: 'value', help: 'Positive login timeout in milliseconds.' },
  { name: 'settle-ms', kind: 'value', help: 'Positive settle window in milliseconds; at least poll interval.' },
  { name: 'poll-ms', kind: 'value', help: 'Positive readiness poll interval in milliseconds.' },
  { name: 'route-order-seed', kind: 'value', help: 'Positive deterministic route-order seed.' },
  { name: 'baseline', kind: 'value', help: 'Comparison summary path.' },
  { name: 'base-url', kind: 'value', help: 'Existing-data target URL; required outside hermetic mode.' },
  { name: 'login-email', kind: 'value', help: 'Existing local user email; forbidden for hermetic mode.' },
  { name: 'browser-channel', kind: 'value', help: 'Browser channel: chromium or chrome; hermetic uses chromium.' },
  { name: 'self-qa', kind: 'value', help: 'Diagnostic mode: narrow or full; requires default hermetic workload.' },
  { name: 'headed', kind: 'flag', help: 'Use a visible browser; required for hosted-dev.' },
  { name: 'print-config', kind: 'flag', help: 'Print resolved safe configuration without lifecycle work.' },
  { name: 'contract-checkpoint', kind: 'flag', help: 'Run the locked contract checkpoint workload.' },
  { name: 'help', kind: 'flag', help: 'Print this help without validating a target (alias: -h).' },
]);

const optionByName = new Map(PUBLIC_OPTION_CATALOG.map((option) => [option.name, option]));
const seedOptions = PUBLIC_OPTION_CATALOG.filter((option) => option.seedInput !== undefined);
const overrideOptionNames = seedOptions
  .filter((option) => option.name !== 'scale')
  .map((option) => option.name);

export function renderProfilerHelp(): string {
  const options = PUBLIC_OPTION_CATALOG.map((option) => (
    `  --${option.name}${option.kind === 'value' ? '=VALUE' : ''}\n    ${option.help}`
  )).join('\n');
  return [
    'Usage: npm run perf:pages -- <hermetic|local|hosted-dev> [options]',
    '',
    'Hermetic seed options are unavailable for local and hosted-dev. Seeded conversation depth is storage workload; samples measure passive initial readiness and never click Load more. All resolved physical rows, native member slots, and broadcast recipients count toward the total-work cap.',
    '',
    'Options:',
    options,
    '',
    'Examples:',
    '  npm run perf:pages -- hermetic --scale=7',
    '  npm run perf:pages -- hermetic --scale=1 --long-conversation-messages=2000',
    '  npm run perf:pages -- hermetic --large-broadcast-recipients=1000',
    '  npm run perf:pages -- hermetic --scale=7 --print-config',
    '  npm run perf:pages -- local --base-url=http://localhost:5174',
    '  npm run perf:pages -- hosted-dev --base-url=https://dev.example.test --headed',
    '',
  ].join('\n');
}

export type ParsedProfilerArgs =
  | { kind: 'help'; text: string }
  | { kind: 'run'; config: RunConfig };

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

    const option = optionByName.get(name);
    if (option === undefined) throw new Error(`--${name} is not supported`);

    if (option.kind === 'flag') {
      if (separator >= 0) throw new Error(`--${name} does not accept a value`);
      flags.add(name);
      continue;
    }

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
  const input: PerformanceSeedInput = {};
  for (const option of seedOptions) {
    if (option.seedInput === undefined) continue;
    const value = seedInteger(values, option.name);
    if (value !== undefined) input[option.seedInput] = value;
  }
  return input;
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
    seed.units !== 16 ||
    seed.placements !== 50 ||
    seed.tours !== 50 ||
    seed.conversations !== 100 ||
    seed.nativeGroups !== 21 ||
    seed.messagesPerConversation !== 10 ||
    seed.resolvedLongConversationMessages !== 10 ||
    seed.broadcasts !== 10 ||
    seed.recipientsPerBroadcast !== 25 ||
    seed.resolvedLargeBroadcastRecipients !== 25 ||
    coldRepeats !== 1 ||
    warmRepeats !== 1
  ) {
    throw new Error(`${modeOption} requires default scale 1 and one cold and warm repeat`);
  }
  for (const name of overrideOptionNames) {
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
    assertForbidden(explicit, [...seedOptions.map((option) => option.name), 'self-qa', 'contract-checkpoint'], target);
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
  const resolvedSeedInput = target === 'hermetic' ? seedInput(values) : null;
  const seed = resolvedSeedInput === null
    ? null
    : resolvePerformanceSeedConfig(resolvedSeedInput, undefined, deps.now ?? (() => new Date()));

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
    seedInput: resolvedSeedInput,
    seed,
  };
}

export function parseProfilerArgs(
  argv: string[],
  deps: ParseRunConfigDeps = {},
): ParsedProfilerArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help', text: renderProfilerHelp() };
  return { kind: 'run', config: parseRunConfig(argv, deps) };
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
    requestedSeedInput: config.seedInput === null ? null : copySeedInput(config.seedInput),
    seed: config.seed === null ? null : toPerformanceSeedManifest(config.seed),
  };
}

function copySeedInput(input: PerformanceSeedInput): PerformanceSeedInput {
  const copy: PerformanceSeedInput = {};
  for (const option of seedOptions) {
    if (option.seedInput === undefined) continue;
    const value = input[option.seedInput];
    if (value !== undefined) copy[option.seedInput] = value;
  }
  return copy;
}

export function toHermeticReseedPayload(config: RunConfig): {
  input: PerformanceSeedInput;
  anchor: string;
} {
  if (config.seed === null || config.seedInput === null) throw new Error('hermetic seed required');
  return { input: copySeedInput(config.seedInput), anchor: config.seed.anchor };
}
