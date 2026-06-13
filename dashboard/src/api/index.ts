// The api barrel — the ONE import surface for feature agents:
//   import { listConversations, useApi, ApiError, type Message } from '../api';
// Feature agents IMPORT from here and NEVER edit anything under src/api/.
export * from './types.js';
export { ApiError } from './client.js';
export * from './endpoints.js';
export { useApi, type UseApiResult } from './useApi.js';
export { useEventStream, type EventStreamHandlers } from './useEventStream.js';
