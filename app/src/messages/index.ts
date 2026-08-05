// Message catalog — public surface. The catalog is the single registry of
// automated-message defaults; the resolver picks override-or-default and
// interpolates. See catalog.ts / resolve.ts.
export {
  MESSAGE_CATALOG,
  type MessageId,
  type MessageDef,
  type MessageClass,
} from './catalog.js';
export { resolveMessage, settingsToOverrides } from './resolve.js';
export { resolveWithSettings } from './resolveWithSettings.js';
