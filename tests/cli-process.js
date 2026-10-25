import assert from 'node:assert/strict';

// Test-only boundary: command arguments, output and Error text may contain secrets.
export function assertCliProcess(result, { testFile, stage, timeoutMs, elapsedMs, expectedStatus = 0 }) {
  if (!result.error && !result.signal && result.status === expectedStatus) return result;
  const context = {
    testFile, stage, childPid: result.pid || null, timeoutMs, elapsedMs: Math.round(elapsedMs),
    expectedStatus, status: result.status, signal: result.signal ?? null,
    errorCode: result.error?.code ?? null, errno: result.error?.errno ?? null,
    failureType: result.error ? 'process_error' : result.signal ? 'signal' : 'exit_status'
  };
  console.error('CLI_PROCESS_FAILURE ' + JSON.stringify(context));
  assert.fail(`${testFile}: ${stage} (${context.failureType}; see CLI_PROCESS_FAILURE)`);
}
