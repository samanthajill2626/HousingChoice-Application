// Structural gate (§6 layer 3) for the dev-only endpoints: the dev router module
// is dynamically imported ONLY when the gates pass, so a normal production
// process never even loads the code. config.ts already fails fast if the flag is
// set in production; this is the second, structural layer. Lives at the
// composition root so buildApp can stay synchronous.
import type { Router } from 'express';
import type { AppConfig } from './config.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export async function maybeLoadDevRouter(
  config: AppConfig,
  logger: Logger = defaultLogger,
): Promise<Router | undefined> {
  if (!config.devAuthEnabled || config.nodeEnv === 'production') return undefined;
  const { createDevRouter } = await import('../routes/dev.js');
  return createDevRouter({ logger });
}
