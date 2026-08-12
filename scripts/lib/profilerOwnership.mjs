const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const REVISION_PATTERN = /^[a-f0-9]{7,40}$/u;

export function profilerOwnerToken(value) {
  if (value === undefined) return null;
  if (!TOKEN_PATTERN.test(value)) throw new Error('profiler_owner_token_invalid');
  return value;
}

export function assertProfilerPingIdentity(input) {
  if (
    !REVISION_PATTERN.test(input.expectedCommit)
    || input.body?.appCommit !== input.expectedCommit
  ) {
    throw new Error('profiler_commit_identity_mismatch');
  }
  if (input.body?.profilerOwnerToken !== input.expectedOwnerToken) {
    throw new Error('profiler_owner_identity_mismatch');
  }
}

export function sendProfilerReady(ownerToken, send) {
  if (ownerToken === null) return;
  if (typeof send !== 'function') throw new Error('profiler_ipc_unavailable');
  send({ type: 'e2e-session-ready' });
}
