import {
  PROVIDER_OPERATIONS,
  ProviderOperationError,
  hasProviderOperation,
  invokeProviderOperation,
  providerAdapterSnapshot,
  requireProviderOperation
} from '../../lib/provider-adapter.js';
import { redactProviderMessage } from '../../lib/provider-contract.js';

const DEFAULT_SECRET = 'sk-conformance-secret-123456';

function freezeReport(report) {
  return Object.freeze({
    adapter: Object.freeze({ ...report.adapter }),
    checks: Object.freeze(report.checks.map((item) => Object.freeze({ ...item }))),
    failures: Object.freeze(report.failures.map((item) => Object.freeze({ ...item }))),
    ok: report.failures.length === 0
  });
}

/**
 * 零网络 Provider conformance runner。网络与供应商行为必须由 Adapter 构造时
 * 注入的 fixture transport 提供；runner 本身只验证契约与场景。
 */
export async function runProviderConformance(adapter, {
  cases = [],
  secretMarkers = [],
  requireCasesForSupported = true
} = {}) {
  const snapshot = providerAdapterSnapshot(adapter);
  const report = {
    adapter: { id: snapshot.provider.id, protocol: snapshot.provider.protocol },
    checks: [],
    failures: []
  };
  const safeDetail = (value) => {
    let text = redactProviderMessage(value);
    for (const secret of [DEFAULT_SECRET, ...secretMarkers].filter(Boolean)) {
      text = text.split(String(secret)).join('[REDACTED]');
    }
    return text;
  };
  const check = (name, condition, detail = '') => {
    const item = { name, ok: Boolean(condition), ...(detail ? { detail: safeDetail(detail) } : {}) };
    report.checks.push(item);
    if (!item.ok) report.failures.push(item);
  };

  const serialized = JSON.stringify(snapshot);
  check('snapshot.serializable', Boolean(serialized) && !serialized.includes('function'));
  for (const secret of [DEFAULT_SECRET, ...secretMarkers].filter(Boolean)) {
    check('snapshot.redacts:' + String(secret).slice(0, 8), !serialized.includes(String(secret)));
  }

  for (const operation of PROVIDER_OPERATIONS) {
    const supported = hasProviderOperation(adapter, operation);
    const status = snapshot.operations[operation]?.status;
    check('operation.accounted:' + operation,
      status === (supported ? 'supported' : 'unsupported'), status || 'missing');
    if (!supported) {
      let error;
      try { requireProviderOperation(adapter, operation); } catch (caught) { error = caught; }
      check('operation.unsupported:' + operation,
        error instanceof ProviderOperationError && error.operation === operation,
        error?.message);
    } else if (requireCasesForSupported && operation !== 'mapError') {
      check('operation.covered:' + operation,
        cases.some((item) => item.operation === operation),
        'supported operation lacks a conformance case');
    }
  }

  const mapped = await invokeProviderOperation(adapter, 'mapError',
    new Error('fixture ' + DEFAULT_SECRET + ' /home/private/result.png'),
    { stage: 'submit', acceptance: 'unknown' });
  const mappedText = JSON.stringify(mapped);
  check('mapError.shape', mapped.stage === 'submit' && mapped.acceptance === 'unknown');
  check('mapError.redaction',
    !mappedText.includes(DEFAULT_SECRET) && !mappedText.includes('/home/private/result.png'), mappedText);

  for (const item of cases) {
    const label = String(item.name || item.operation || 'unnamed');
    try {
      const result = await invokeProviderOperation(adapter, item.operation, item.input, item.context);
      const verdict = typeof item.expect === 'function' ? item.expect(result) : true;
      check('case:' + label, verdict === true, verdict === true ? '' : JSON.stringify(result));
    } catch (error) {
      check('case:' + label, false, error?.message || error);
    }
  }

  return freezeReport(report);
}

export function assertProviderConformance(report) {
  if (!report?.ok) {
    const details = (report?.failures || []).map((item) => item.name + (item.detail ? ': ' + item.detail : '')).join('\n');
    throw new Error('Provider conformance failed for ' + (report?.adapter?.id || 'unknown') + '\n' + details);
  }
  return report;
}
