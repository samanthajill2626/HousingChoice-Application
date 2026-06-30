// Structural gate (§6 layer 3) for the dev-only endpoints: the dev router module
// is dynamically imported ONLY when the gates pass, so a normal production
// process never even loads the code. config.ts already fails fast if the flag is
// set in production; this is the second, structural layer. Lives at the
// composition root so buildApp can stay synchronous.
import type { Router } from 'express';
import type { AppConfig } from './config.js';
import type { SessionEpochCache } from '../middleware/auth.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export async function maybeLoadDevRouter(
  config: AppConfig,
  logger: Logger = defaultLogger,
  sessionEpochCache?: SessionEpochCache,
): Promise<Router | undefined> {
  // Dev endpoints are unauthenticated, so they only mount on a hermetic local
  // stack. A DYNAMODB_ENDPOINT is only set for DynamoDB Local; cloud stacks use
  // the default AWS endpoint and have it unset.
  if (!config.devAuthEnabled || config.nodeEnv === 'production' || !config.dynamodbEndpoint) return undefined;
  const { createDevRouter } = await import('../routes/dev.js');
  // Share the app's epoch cache so /__dev/reseed can clear it (the reseed wipes
  // the users table; a stale cached epoch would otherwise reject post-reseed sessions).
  return createDevRouter({ config, logger, sessionEpochCache });
}
