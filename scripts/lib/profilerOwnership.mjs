const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const REVISION_PATTERN = /^[a-f0-9]{7,40}$/u;
const LAUNCHER_FAILURE_REASONS = new Set([
  'profiler_existing_session_live',
  'profiler_app_port_occupied',
  'profiler_dashboard_port_occupied',
  'profiler_fake_port_occupied',
  'profiler_public_base_port_occupied',
  'profiler_ping_failed',
  'profiler_commit_identity_mismatch',
  'profiler_owner_identity_mismatch',
  'profiler_ipc_unavailable',
]);

function normalizedRevision(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return REVISION_PATTERN.test(normalized) ? normalized : null;
}

export function profilerOwnerToken(value) {
  if (value === undefined) return null;
  if (!TOKEN_PATTERN.test(value)) throw new Error('profiler_owner_token_invalid');
  return value;
}

export function assertProfilerPingIdentity(input) {
  const expectedCommit = normalizedRevision(input.expectedCommit);
  const targetAppCommit = normalizedRevision(input.body?.appCommit);
  if (input.allowUnverifiedRevision === true) {
    if (expectedCommit !== null && targetAppCommit !== null && expectedCommit !== targetAppCommit) {
      throw new Error('profiler_commit_identity_mismatch');
    }
  } else if (expectedCommit === null || targetAppCommit === null || targetAppCommit !== expectedCommit) {
    throw new Error('profiler_commit_identity_mismatch');
  }
  if (
    !TOKEN_PATTERN.test(input.expectedOwnerToken)
    || !TOKEN_PATTERN.test(input.body?.profilerOwnerToken)
    || input.body.profilerOwnerToken !== input.expectedOwnerToken
  ) {
    throw new Error('profiler_owner_identity_mismatch');
  }
  return {
    expectedCommit,
    targetAppCommit,
    targetVersionStatus: expectedCommit !== null && targetAppCommit !== null ? 'verified' : 'unverified',
  };
}

export function sendProfilerReady(ownerToken, send) {
  if (ownerToken === null) return;
  if (typeof send !== 'function') throw new Error('profiler_ipc_unavailable');
  send({ type: 'e2e-session-ready' });
}

export function sendProfilerFailure(ownerToken, error, send) {
  if (ownerToken === null || typeof send !== 'function') return;
  const reason = error instanceof Error && LAUNCHER_FAILURE_REASONS.has(error.message)
    ? error.message
    : 'launcher_failed_before_ready';
  send({ type: 'e2e-session-failed', reason });
}
