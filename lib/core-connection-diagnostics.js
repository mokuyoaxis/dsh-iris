const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stages = new Set(['configuration', 'transport', 'handshake', 'authorization', 'input', 'tool', 'response', 'startup', 'disconnect', 'shutdown']);

/** Bounded public diagnosis. Never copy exception messages, bodies, URLs, headers or private paths. */
export function coreConnectionDiagnostic(error, { stage = 'tool', references = {} } = {}) {
  const code = /^IRIS_[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'IRIS_MCP_REQUEST_FAILED';
  stage = stages.has(error?.diagnostic?.stage) ? error.diagnostic.stage : stages.has(stage) ? stage : 'tool';
  let message = 'Core request failed.', action = 'Inspect the original Run/Operation and request key before another write. Do not regenerate automatically.';
  if (['IRIS_CORE_SERVICE_UNAVAILABLE', 'IRIS_CORE_SERVICE_TIMEOUT'].includes(code)) {
    stage = 'transport'; message = code.endsWith('TIMEOUT') ? 'Core request timed out.' : 'Core service could not be reached or the response was interrupted.';
    action = 'Check the explicitly started Core service and configured loopback port. Reconnect explicitly, then recover the original request key; do not create a replacement task.';
  } else if (['IRIS_CONNECTION_AUTH_REQUIRED', 'IRIS_API_AUTH_REQUIRED', 'IRIS_CONNECTION_REVOKED'].includes(code)) {
    stage = 'authorization'; message = 'This connection credential is unavailable, expired or revoked.';
    action = 'Ask the owner to inspect this connection and explicitly export its current configuration. An owner login token cannot replace an MCP connection credential.';
  } else if (['IRIS_CONNECTION_CAPABILITY_DENIED', 'IRIS_API_READ_ONLY', 'IRIS_PLUGIN_OPERATION_DENIED'].includes(code)) {
    stage = 'authorization'; message = 'The selected capability, tool or service scope does not allow this request.';
    action = 'Have the owner compare the saved tool selection with the running service. Do not bypass this grant with CLI, shell or another connection.';
  } else if (code === 'IRIS_CONNECTION_HANDSHAKE_REQUIRED' || code === 'IRIS_CORE_SERVICE_DISCONNECTED') {
    stage = 'handshake'; message = 'The original Core connection is not currently negotiated.';
    action = 'Reconnect explicitly to the configured Core. Read the original Operation/request key before any write.';
  } else if (code === 'IRIS_CONNECTION_CONFIG_INVALID' || stage === 'configuration') {
    stage = 'configuration'; message = 'The explicit private client connection configuration is invalid or unavailable.';
    action = 'Select an existing Iris MCP client.json with private permissions, or export it again through the owner connection page. Do not use server-grants.json or an owner token file.';
  } else if (code === 'IRIS_CORE_SERVICE_RESPONSE_INVALID' || code === 'IRIS_CONNECTION_CONFIG_CHANGED') {
    message = 'Core identity, configuration revision or response contract does not match.';
    action = 'Verify the original root and connection identity and current configuration. Keep the original task and request key; do not silently switch roots.';
  } else if (code === 'IRIS_API_RUN_CHANGED' || code === 'IRIS_FLOW_REVISION_CONFLICT') {
    message = 'The Run revision changed.'; action = 'Read the original Run and its current revision, recover the original request key, then decide whether a new explicit operation is needed.';
  } else if (code === 'IRIS_CORE_SERVICE_ABORTED' || code === 'IRIS_MCP_CLOSED') {
    message = 'Local connection waiting stopped.'; action = 'Core may have accepted the operation. Keep its original key and read its saved state after reconnecting; local disconnect does not cancel provider billing.';
  } else if (['IRIS_PLUGIN_CLOSED', 'IRIS_PLUGIN_CONTRIBUTION_MISSING', 'IRIS_PLUGIN_DEPENDENCY_MISMATCH'].includes(code)) {
    message = 'The selected plugin business is missing, closed or has a different exact version.';
    action = 'Read the original Operation and actual catalog dependency. Ask the owner to restore the exact plugin or explicitly select a new version; never silently substitute or replay a write.';
  } else if (code === 'IRIS_OPERATION_KEY_CONFLICT') {
    stage = 'input'; message = 'This request UUID is already bound to different business input or dependency.';
    action = 'Look up the ORIGINAL request UUID. Keep its saved input and result; use a new UUID only for a newly requested operation.';
  } else if (['IRIS_CONNECTION_INPUT_INVALID', 'IRIS_API_INPUT_INVALID', 'IRIS_PLUGIN_INPUT_INVALID'].includes(code)) {
    stage = 'input'; message = 'The request does not match the selected input contract.'; action = 'Check the current tool schema, original IDs and explicit template/format selection. Do not add arbitrary commands or configuration fields.';
  }
  const requestId = error?.requestId ?? error?.diagnostic?.requestId;
  const recovery = Object.fromEntries(Object.entries(references).filter(([key, value]) => typeof value === 'string' && (key === 'key' ? UUID.test(value)
    : key === 'runId' ? /^run_[a-f0-9]{24}$/.test(value) : key === 'operationId' && /^op_[a-f0-9]{64}$/.test(value))));
  return { code, stage, message, action, ...(UUID.test(requestId) ? { requestId } : {}), ...(Object.keys(recovery).length ? { recovery } : {}) };
}

export function annotateCoreConnectionError(error, stage) {
  error.diagnostic = coreConnectionDiagnostic(error, { stage });
  return error;
}
