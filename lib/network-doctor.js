// Explicit GET diagnostics in the caller's Core process, never a media probe.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { loadProviderCatalog } from './provider-catalog.js';
import { providerMediaBaseUrl } from './provider-protocol.js';
import { networkManagementSettings } from './network-management.js';
import { networkFields } from './network-config.js';
import { providerNetworkRequirement, sameNetworkRequirement, networkPolicyError } from './network-policy.js';
import { inheritedProviderFetch } from './provider-network.js';
import { readProviderText } from './provider-response.js';
import { settingsRevision } from './provider-config-service.js';

export const NETWORK_PROBE_TIMEOUT_MS = 8000, NETWORK_PROBE_MAX_BYTES = 16 * 1024;
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
export function networkEnvironmentFacts({ env = process.env, execArgv = process.execArgv } = {}) {
  const nodeFlagRequested = execArgv.includes('--use-env-proxy') || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS || '') || env.NODE_USE_ENV_PROXY === '1';
  return { variables: Object.fromEntries(proxyNames.map(name => [name, Boolean(env[name])])), nodeFlagRequested,
    inheritedPolicy: 'unknown', systemTunnel: 'unknown',
    note: '变量存在或Node开关被请求不等于所有请求已代理；宿主fetch/dispatcher和系统TUN的实际路径未由静态检查证明。' };
}
export function networkDoctor(options) {
  const report = { contractVersion: 0, observedAt: new Date().toISOString(), source: 'core-process',
    process: { node: process.version, platform: process.platform, arch: process.arch },
    environment: networkEnvironmentFacts(), networkTested: false };
  try { return { ...report, settings: networkManagementSettings(options), configuration: { state: 'readable' } }; }
  catch (error) {
    if (!/^IRIS_(?:NETWORK|PROVIDER)_/.test(error.code || '')) throw error;
    return { ...report, settings: null, configuration: { state: 'invalid', issue: error.code,
      message: '指定的网络或供应商配置无法读取；请核对文件版本、格式、权限与错误码。未自动修复或联网。' } };
  }
}

export async function probeNetworkRoute(options, input, { signal } = {}) {
  const fields = ['expectedRevision', 'expectedProviderRevision', 'providerId', 'target', ...(input?.target === 'provider' ? [] : ['url'])];
  networkFields(input, fields, fields);
  if (!['provider', 'custom', 'ip'].includes(input.target)) throw networkPolicyError('IRIS_NETWORK_PROBE_INVALID', '请选择供应商地址、自定义GET或IP观察');
  if (input.target !== 'provider' && (typeof input.url !== 'string' || !input.url || input.url.length > 2048)) throw networkPolicyError('IRIS_NETWORK_PROBE_INVALID', '测试URL须为最多2048字符的文本');
  const settings = networkManagementSettings(options);
  if (input.expectedRevision !== settings.network?.revision || input.expectedProviderRevision !== settings.catalog.revision) {
    throw networkPolicyError('IRIS_NETWORK_CONFIG_CHANGED', '网络或供应商目录已变化，请重新读取后测试');
  }
  if (['mismatch', 'missing_network'].includes(settings.catalog.state)) throw networkPolicyError('IRIS_NETWORK_CONFIG_MISMATCH', '供应商与网络配置不匹配，未进行测试');
  if (!settings.providers.some(provider => provider.id === input.providerId)) throw networkPolicyError('IRIS_NETWORK_PROVIDER_NOT_FOUND', '测试需要当前目录中的明确供应商');
  const catalog = loadProviderCatalog(options.providerConfigPath), provider = catalog.providers.find(item => item.id === input.providerId);
  if (settingsRevision(catalog) !== input.expectedProviderRevision) throw networkPolicyError('IRIS_NETWORK_PROVIDER_CHANGED', '供应商目录已变化，未进行测试');
  if (!provider) throw networkPolicyError('IRIS_NETWORK_PROVIDER_NOT_FOUND', '测试需要当前目录中的明确供应商');
  let target;
  try { target = new URL(input.target === 'provider' ? providerMediaBaseUrl(provider) : input.url); }
  catch (_) { throw networkPolicyError('IRIS_NETWORK_PROBE_INVALID', '测试地址需要有效的HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
    throw networkPolicyError('IRIS_NETWORK_PROBE_INVALID', '测试地址只接受不含认证信息或片段的HTTP(S) URL');
  }
  // Own the deadline: Node 22.1.0 can collect the timeout source of
  // AbortSignal.any(), leaving a live request without its advertised limit.
  const controller = new AbortController(), combined = controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException('Network probe timed out', 'TimeoutError')), NETWORK_PROBE_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const started = performance.now(); let route = null, dispatchStarted = false, status = null, responseReceived = false;
  const report = () => ({ contractVersion: 0, source: 'core-process', observedAt: new Date().toISOString(),
    providerId: provider.id, target: { kind: input.target, origin: target.origin }, elapsedMs: Math.round(performance.now() - started),
    timeoutMs: NETWORK_PROBE_TIMEOUT_MS, maxBytes: NETWORK_PROBE_MAX_BYTES, requestLimit: 1, requestLimitKind: 'application_get',
    dispatchStarted, responseReceived, httpStatus: status, route,
    note: '只表示本次目标与路线；不证明其他服务、所有任务或系统TUN行为。不携带供应商Key，不生成媒体。' });
  try {
    const requirement = providerNetworkRequirement(provider);
    const network = requirement ? options.resolveProviderNetwork?.({ providerId: provider.id, networkRequirement: requirement }) : undefined;
    if (requirement && (!network || network.providerId !== provider.id || !sameNetworkRequirement(requirement, network.networkRequirement))) throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '测试需要匹配的Core网络上下文，不会静默直连');
    const action = async fetch => {
      combined.throwIfAborted();
      if (!network) { dispatchStarted = true; route = { route: 'inherit', providerId: provider.id, legacy: true }; }
      const response = await fetch(target.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { Accept: input.target === 'ip' ? 'application/json' : '*/*' } });
      status = response.status; responseReceived = true;
      const text = await readProviderText(response, { maxBytes: NETWORK_PROBE_MAX_BYTES, stage: 'discover', acceptance: 'not_accepted' });
      let observedIp;
      if (input.target === 'ip' && response.ok) {
        let value; try { value = JSON.parse(text); } catch (_) { /* Report a limited observation, never the response body. */ }
        if (value && typeof value.ip === 'string' && net.isIP(value.ip)) observedIp = value.ip;
        else return { ...report(), ok: false, reachable: true, issue: 'IRIS_NETWORK_IP_NOT_OBSERVED' };
      }
      return { ...report(), ok: response.ok, reachable: true, ...(observedIp ? { observedIp } : {}),
        ...(!response.ok ? { issue: 'IRIS_NETWORK_TARGET_HTTP_ERROR' } : {}) };
    };
    return network ? await network.run(action, { operation: 'discover', recordNetworkRoute: fact => {
      dispatchStarted = true;
      route = { route: fact.route, providerId: fact.providerId, ...(fact.poolId ? { poolId: fact.poolId } : {}),
        ...(fact.nodeId ? { nodeId: fact.nodeId } : {}), configGeneration: fact.configGeneration, configRevision: fact.configRevision };
    } }) : await action(inheritedProviderFetch);
  } catch (error) {
    signal?.throwIfAborted();
    const code = error.providerCode || error.code;
    if (!(error instanceof TypeError && !error.code) && !['AbortError', 'TimeoutError'].includes(error.name)
        && !/^IRIS_NETWORK_/.test(code || '') && code !== 'IRIS_PROVIDER_RESPONSE_TOO_LARGE') throw error;
    return { ...report(), ok: false, reachable: responseReceived,
      issue: combined.aborted ? 'IRIS_NETWORK_PROBE_TIMEOUT' : code === 'IRIS_PROVIDER_RESPONSE_TOO_LARGE' ? 'IRIS_NETWORK_PROBE_TOO_LARGE'
        : /^IRIS_NETWORK_/.test(code || '') ? code : 'IRIS_NETWORK_PROBE_FAILED' };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
