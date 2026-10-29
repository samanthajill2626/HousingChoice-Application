// The ONE construction of the ranking job's deps (WP1 B2a spec D7; PR27),
// shared by the worker's ranking poll (worker.ts) and the hermetic dev tick
// (routes/dev.ts POST /__dev/ranking/tick), so the two runners cannot drift -
// the drift the extraction tick's "mirrors worker.ts exactly" comment can
// only warn about. Each call builds its OWN slots: the in-process job limit
// (RANKING_MAX_CONCURRENT_JOBS) is per process, and the worker and the app
// each call this once. Construction opens no connection: the repositories and
// the driver are client objects until first used.
import { createRankingDriver } from '../../adapters/ranking.js';
import type { AppConfig } from '../../lib/config.js';
import type { EventBus } from '../../lib/events.js';
import type { Logger } from '../../lib/logger.js';
import { createMatchesRepo } from '../../repos/matchesRepo.js';
import { createRankingRunsRepo } from '../../repos/rankingRunsRepo.js';
import { assembleRanking, createAssembleDeps } from './assemble.js';
import { createRankingSlots, type RankingJobDeps } from './job.js';

export interface RankingJobWiringOptions {
  config: AppConfig;
  logger: Logger;
  /** The process's bus: the worker's (bridged to the app) or the app's own (dev tick). */
  events: Pick<EventBus, 'emit'>;
}

export function createRankingJobDeps(opts: RankingJobWiringOptions): RankingJobDeps {
  const { config, logger } = opts;
  const assembleDeps = createAssembleDeps({ config, logger });
  return {
    jobs: createRankingRunsRepo({ logger }),
    matches: createMatchesRepo({ logger }),
    driver: createRankingDriver(config, logger),
    assemble: (anchor, assembleOpts) => assembleRanking(anchor, assembleOpts, assembleDeps),
    events: opts.events,
    slots: createRankingSlots(config.rankingMaxConcurrentJobs),
    config,
    logger,
    now: () => new Date().toISOString(),
  };
}
