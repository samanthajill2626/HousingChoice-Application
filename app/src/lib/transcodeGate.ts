// The process-wide transcode concurrency gate - ONE instance shared by every
// confirm-time transcoder (MMS attachments + unit photos). The bound exists to
// cap PEAK PROCESS MEMORY from concurrent sharp rasters; two routers each
// holding their own 2-slot gate would silently double it to 4 rasters.
import { createSemaphore, type Semaphore } from './semaphore.js';
import { MMS_TRANSCODE_MAX_CONCURRENT } from './outboundMediaLimits.js';

// Test-safety of this process-wide singleton rests on release() staying inside a finally on every acquiring path (no cross-test slot leak) plus a fresh module registry per test file - which vitest gives by DEFAULT (isolate defaults to true; app/vitest.config.ts does not pin it, so this leans on that default rather than an explicit setting).
export const sharedTranscodeGate: Semaphore = createSemaphore(MMS_TRANSCODE_MAX_CONCURRENT);
