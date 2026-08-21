// The api barrel — the ONE import surface for components:
//   import { getMe, ApiError, type Me } from '../api/index.js';
export * from './types.js';
export { ApiError } from './client.js';
export * from './endpoints.js';
export { fetchAllPages, MAX_PAGES, PAGE_LIMIT } from './paging.js';
export { useEventStream, type EventStreamHandlers } from './useEventStream.js';
export { EventStreamProvider } from './EventStreamProvider.js';
