const MARKER_KEY = '__hcImageViewer';
const PRIOR_STATE_KEY = '__hcImageViewerPriorState';

export interface ImageViewerMarker {
  token: string;
  returnLocationKey: string;
}

type PriorMarker = { present: false } | { present: true; value: unknown };

type StoredImageViewerMarker = ImageViewerMarker & {
  version: 1;
  priorStateKind: 'record' | 'non-record';
  priorMarker: PriorMarker;
};

interface WrappedPriorState {
  ownerToken: string;
  value: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readPriorMarker(value: unknown): PriorMarker | undefined {
  if (!isPlainRecord(value) || typeof value.present !== 'boolean') return undefined;
  if (!value.present) return { present: false };
  if (!hasOwn(value, 'value')) return undefined;
  return { present: true, value: value.value };
}

function readStoredImageViewerMarker(
  state: Record<string, unknown>,
): StoredImageViewerMarker | undefined {
  const value = state[MARKER_KEY];
  if (!isPlainRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.priorStateKind !== 'record' && value.priorStateKind !== 'non-record') {
    return undefined;
  }
  if (!isNonemptyString(value.token) || !isNonemptyString(value.returnLocationKey)) {
    return undefined;
  }
  const priorMarker = readPriorMarker(value.priorMarker);
  if (priorMarker === undefined) return undefined;
  if (value.priorStateKind === 'non-record' && priorMarker.present) return undefined;
  return {
    token: value.token,
    returnLocationKey: value.returnLocationKey,
    version: 1,
    priorStateKind: value.priorStateKind,
    priorMarker,
  };
}

function isWrappedPriorState(value: unknown): value is WrappedPriorState {
  return (
    isPlainRecord(value) &&
    isNonemptyString(value.ownerToken) &&
    hasOwn(value, 'value')
  );
}

export function readImageViewerMarker(state: unknown): ImageViewerMarker | undefined {
  if (!isPlainRecord(state)) return undefined;
  const stored = readStoredImageViewerMarker(state);
  if (stored === undefined) return undefined;
  return {
    token: stored.token,
    returnLocationKey: stored.returnLocationKey,
  };
}

export function addImageViewerMarker(
  state: unknown,
  marker: ImageViewerMarker,
): Record<string, unknown> {
  if (isPlainRecord(state)) {
    const present = hasOwn(state, MARKER_KEY);
    const stored: StoredImageViewerMarker = {
      ...marker,
      version: 1,
      priorStateKind: 'record',
      priorMarker: present
        ? { present: true, value: state[MARKER_KEY] }
        : { present: false },
    };
    return { ...state, [MARKER_KEY]: stored };
  }

  const stored: StoredImageViewerMarker = {
    ...marker,
    version: 1,
    priorStateKind: 'non-record',
    priorMarker: { present: false },
  };
  const prior: WrappedPriorState = { ownerToken: marker.token, value: state };
  return { [PRIOR_STATE_KEY]: prior, [MARKER_KEY]: stored };
}

export function removeImageViewerMarker(state: unknown): unknown {
  if (!isPlainRecord(state)) return state;
  const stored = readStoredImageViewerMarker(state);
  if (stored === undefined) return state;

  if (stored.priorStateKind === 'non-record') {
    const prior = state[PRIOR_STATE_KEY];
    if (isWrappedPriorState(prior) && prior.ownerToken === stored.token) {
      return prior.value;
    }
  }

  const next = { ...state };
  if (stored.priorMarker.present) next[MARKER_KEY] = stored.priorMarker.value;
  else delete next[MARKER_KEY];
  return next;
}
