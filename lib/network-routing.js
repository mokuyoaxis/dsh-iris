// Instance-owned routing. CONNECT preflight never sends a business request.
import net from 'node:net';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readNetworkConfig } from './network-config-service.js';
import { networkNodeCredentialStatus, NETWORK_ROUTING_CONFIG_VERSION } from './network-config.js';
import { checkedNetworkRequirement, networkPolicyError, createNetworkAttemptBudget } from './network-policy.js';
import { createProviderNetworkClient, inheritedProviderFetch } from './provider-network.js';
import { ProviderContractError } from './provider-contract.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authority = url => `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
const nodeUri = node => `${node.protocol}://${net.isIP(node.host) === 6 ? '[' + node.host + ']' : node.host}:${node.port}`;
const PREFLIGHT_ERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ENOTFOUND',
  'ETIMEDOUT', 'EPIPE', 'EADDRNOTAVAIL', 'EACCES', 'EPERM', 'IRIS_NETWORK_CONNECT_REJECTED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_HEADERS_OVERFLOW', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_PRX_TLS',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT'
]);
const preflightUnavailable = error => PREFLIGHT_ERRORS.has(error.code) || /^(?:ERR_SSL_|HPE_)[A-Z0-9_]+$/.test(error.code || '')
  || ['AbortError', 'TimeoutError'].includes(error.name);
function failure(context, code, message, category = 'network') {
  const operation = context.operation || 'submit';
  const notAccepted = ['submit', 'prepareInput', 'discover', 'vision'].includes(operation);
  return Object.assign(new ProviderContractError(message, { providerCode: code, category, stage: notAccepted ? 'prepare' : operation,
    acceptance: notAccepted ? 'not_accepted' : 'accepted' }), { code });
}

async function directPreflight(url, signal, timeoutMs) {
  signal?.throwIfAborted();
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
    const aborted = () => socket.destroy(combined.reason);
    combined.addEventListener('abort', aborted, { once: true });
    const cleanup = () => combined.removeEventListener('abort', aborted);
    socket.once('error', error => { cleanup(); reject(error); });
    socket.once('connect', () => { cleanup(); socket.destroy(); resolve(); });
    if (combined.aborted) aborted();
  });
}

function transportFetchInput(transport, input, options) {
  // Node's built-in fetch and the installed Undici use different Web IDL brands.
  // Convert only at the explicit transport boundary; inherited fetch stays native.
  if (input instanceof Request) {
    const request = new Request(input, options);
    return { input: new transport.Request(request.url, request), options: { signal: request.signal } };
  }
  if (options.body instanceof FormData) {
    const body = new transport.FormData();
    for (const [name, value] of options.body) body.append(name, value);
    return { input, options: { ...options, body } };
  }
  return { input, options };
}

export function createProviderNetworkManager({ networkConfigPath, onRoute, tls, proxyTls, scheduler, preflightTimeoutMs = 3000,
  loadTransport = () => {
    // Initialize Node's own fetch classes/default dispatcher without a request.
    // Undici must inherit an existing dispatcher rather than create its own default.
    void globalThis.Request;
    return import('undici');
  } } = {}) {
  if (onRoute !== undefined && typeof onRoute !== 'function') throw new TypeError('onRoute 必须是函数');
  if (typeof loadTransport !== 'function' || !Number.isInteger(preflightTimeoutMs) || preflightTimeoutMs < 1 || preflightTimeoutMs > 30000) throw new TypeError('网络客户端装配参数无效');
  const clients = new Map(), retiring = new Set();
  let closing = false, disposal, transport, revision, cleanupFailed = false;
  function retire(client) {
    const pending = client.dispose();
    retiring.add(pending);
    void pending.then(() => retiring.delete(pending), () => { cleanupFailed = true; retiring.delete(pending); });
  }
  function remember(slot, key, client, routed = false) {
    const previous = clients.get(slot);
    clients.set(slot, { key, client, routed });
    if (previous) retire(previous.client);
    return client;
  }
  const library = () => transport ||= Promise.resolve().then(loadTransport).catch(() => {
    throw failure({ operation: 'discover' }, 'IRIS_NETWORK_CLIENT_UNAVAILABLE', '代理客户端未安装或无法加载；请使用包含所需生产依赖的完整 Iris 安装，不会退回直连', 'invalid_request');
  });
  async function scheduledFetch(fetch, dispatcher, input, options, context) {
    const managed = scheduler.dispatcher(dispatcher, context, options.signal);
    try { return await fetch(input, { ...options, dispatcher: managed }); }
    catch (error) {
      const queuedFailure = [error, error.cause].some(value => typeof value?.code === 'string' && value.code.startsWith('IRIS_SCHEDULER_'));
      if (managed.dispatches === 0 && (queuedFailure || options.signal?.aborted)) {
        const original = typeof error.cause?.code === 'string' && error.cause.code.startsWith('IRIS_SCHEDULER_') ? error.cause : error;
        throw failure(context, typeof original.code === 'string' && original.code.startsWith('IRIS_SCHEDULER_') ? original.code : 'IRIS_SCHEDULER_ABORTED',
          '请求在本地调度期间停止，业务请求尚未派发', options.signal?.aborted ? 'aborted' : 'rate_limit');
      }
      throw error;
    }
  }

  function resolveProviderNetwork({ providerId, modelRef, networkRequirement } = {}) {
    if (closing) throw networkPolicyError('IRIS_PROVIDER_NETWORK_CLOSED', '网络管理实例已关闭');
    if (networkRequirement === undefined) {
      if (!scheduler) return undefined;
      const key = JSON.stringify(['scheduled-inherit', providerId, modelRef]);
      if (clients.has(key)) return clients.get(key).client;
      const scope = new AsyncLocalStorage();
      const base = createProviderNetworkClient({ async fetchPort(input, options = {}) {
        const context = scope.getStore();
        if (!context) throw networkPolicyError('IRIS_NETWORK_OPERATION_REQUIRED', '调度客户端必须在完整操作内调用');
        const { getGlobalDispatcher } = await library();
        return scheduledFetch(inheritedProviderFetch, getGlobalDispatcher(), input, options, context);
      } });
      const client = Object.freeze({ ...base, run(action, context = {}) {
        return base.run(fetch => scope.run({ providerId, modelRef, ...context }, () => action(fetch)));
      } });
      return remember(key, key, client);
    }
    const requirement = Object.freeze(checkedNetworkRequirement(networkRequirement));
    if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256 || /[\x00-\x1f\x7f]/.test(providerId)) throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '网络解析需要明确的供应商身份');
    if (!networkConfigPath) throw networkPolicyError('IRIS_NETWORK_CONTEXT_REQUIRED', '此供应商配置需要明确的 network-config，不会使用默认出口');
    const saved = readNetworkConfig(networkConfigPath), config = saved.config;
    if (config.schemaVersion !== NETWORK_ROUTING_CONFIG_VERSION || config.configId !== requirement.configId) {
      throw networkPolicyError('IRIS_NETWORK_CONFIG_MISMATCH', '网络配置版本或身份与供应商目录不符，不会借用其他配置');
    }
    if (revision !== saved.revision) {
      revision = saved.revision;
      for (const [slot, entry] of clients) if (entry.routed) {
        clients.delete(slot); retire(entry.client);
      }
    }
    const binding = config.bindings.find(value => value.catalogId === requirement.catalogId && value.providerId === providerId);
    const pool = binding ? config.pools.find(value => value.id === binding.poolId) : undefined;
    if (binding && (!pool?.enabled || !pool.candidates.length)) throw networkPolicyError('IRIS_NETWORK_POOL_UNAVAILABLE', '显式绑定的出口池为空或已停用，不会隐式继承或直连');
    const secrets = pool ? pool.candidates.flatMap(candidate => {
      const node = candidate.kind === 'node' && config.nodes.find(value => value.id === candidate.nodeId);
      return node?.auth ? [process.env[node.auth.usernameEnv], process.env[node.auth.passwordEnv]] : [];
    }) : [];
    const slot = hash([requirement, providerId, ...(scheduler ? [modelRef] : [])]);
    const key = hash([saved.revision, requirement, providerId, ...(scheduler ? [modelRef] : []), secrets]);
    const cached = clients.get(slot);
    if (cached?.key === key) return cached.client;
    const scope = new AsyncLocalStorage(), dispatchers = new Map();
    // Capture only this client's explicitly referenced values; later resolutions
    // use a new client if credentials rotate, while admitted operations can drain.
    const nodeIds = new Set(pool?.candidates.filter(candidate => candidate.kind === 'node').map(candidate => candidate.nodeId) || []);
    const nodes = new Map(config.nodes.filter(node => nodeIds.has(node.id)).map(node => [node.id, { ...node, credentialStatus: networkNodeCredentialStatus(node),
      ...(node.auth ? { token: `Basic ${Buffer.from(`${process.env[node.auth.usernameEnv] || ''}:${process.env[node.auth.passwordEnv] || ''}`).toString('base64')}` } : {}) }]));

    async function choose(url, options, context) {
      if (!pool) return { route: 'inherit' };
      const budget = context.networkBudget || createNetworkAttemptBudget();
      for (const candidate of pool.candidates) {
        if (options.signal?.aborted) throw failure(context, 'IRIS_NETWORK_ABORTED', '业务请求发送前已取消出口预检', 'aborted');
        const probeKey = JSON.stringify([key, url.origin, candidate]);
        if (budget.probes.has(probeKey)) {
          const previous = await budget.probes.get(probeKey);
          if (previous) return previous;
          continue;
        }
        const node = candidate.kind === 'node' ? nodes.get(candidate.nodeId) : undefined;
        if (candidate.kind === 'node' && (!node?.enabled || !['none', 'ready'].includes(node.credentialStatus))) {
          budget.probes.set(probeKey, Promise.resolve(null)); continue;
        }
        if (!budget.remaining) continue;
        budget.remaining--;
        let complete;
        const result = new Promise(resolve => { complete = resolve; });
        budget.probes.set(probeKey, result);
        try {
          if (candidate.kind === 'direct') {
            await directPreflight(url, options.signal, preflightTimeoutMs);
            const selected = { route: 'direct', poolId: pool.id }; complete(selected); return selected;
          }
          const { Client } = await library();
          const probe = new Client(nodeUri(node), { connect: proxyTls, connectTimeout: preflightTimeoutMs });
          try {
            const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(preflightTimeoutMs)]) : AbortSignal.timeout(preflightTimeoutMs);
            const connected = await probe.connect({ path: authority(url), signal,
              headers: { ...(node.token ? { 'proxy-authorization': node.token } : {}), host: authority(url) } });
            connected.socket.destroy();
            if (connected.statusCode !== 200) throw Object.assign(new Error('CONNECT rejected'), { code: 'IRIS_NETWORK_CONNECT_REJECTED' });
          } finally { await probe.destroy(); }
          const selected = { route: 'proxy', poolId: pool.id, nodeId: node.id }; complete(selected); return selected;
        } catch (error) {
          complete(null);
          if (options.signal?.aborted) throw failure(context, 'IRIS_NETWORK_ABORTED', '业务请求发送前已取消出口预检', 'aborted');
          if (error.code === 'IRIS_NETWORK_CLIENT_UNAVAILABLE') throw error;
          if (!preflightUnavailable(error)) throw error;
          // Only the independent connection preflight may select another route.
        }
      }
      throw failure(context, 'IRIS_NETWORK_POOL_EXHAUSTED', '出口池没有通过连接预检的候选；未发送业务请求，也未隐式直连');
    }

    async function dispatcherFor(selected) {
      const id = selected.nodeId || 'direct';
      if (!dispatchers.has(id)) {
        const pending = library().then(({ Agent, ProxyAgent }) => {
          const node = selected.nodeId && nodes.get(selected.nodeId);
          return node ? new ProxyAgent({ uri: nodeUri(node), token: node.token, requestTls: tls, proxyTls,
            connectTimeout: preflightTimeoutMs, proxyTunnel: true }) : new Agent({ connect: tls, connectTimeout: preflightTimeoutMs });
        });
        dispatchers.set(id, pending);
        void pending.catch(() => { if (dispatchers.get(id) === pending) dispatchers.delete(id); });
      }
      return dispatchers.get(id);
    }

    const base = createProviderNetworkClient({
      async fetchPort(input, options = {}) {
        const state = scope.getStore();
        if (!state) throw networkPolicyError('IRIS_NETWORK_OPERATION_REQUIRED', '显式网络客户端必须在完整操作内调用');
        if (state.context.taskId && typeof state.context.recordNetworkRoute !== 'function') {
          throw failure(state.context, 'IRIS_NETWORK_EVIDENCE_REQUIRED', 'Task 出站需要 Core 提供路线持久化端口，已停止派发', 'local_io');
        }
        if (input instanceof Request && options.signal === undefined) options = { ...options, signal: input.signal };
        const url = new URL(input instanceof Request ? input.url : input);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure(state.context, 'IRIS_NETWORK_TARGET_INVALID', '出站目标需要不含认证信息的 HTTP(S) 地址', 'invalid_request');
        state.selection ||= choose(url, options, state.context);
        const selected = await state.selection;
        const dispatcher = selected.route === 'inherit' ? undefined : await dispatcherFor(selected);
        const fact = { ...requirement, configGeneration: config.generation, configRevision: saved.revision, providerId,
          operation: state.context.operation || 'discover', ...selected, ...(state.context.attemptId ? { attemptId: state.context.attemptId } : {}) };
        if (state.context.recordNetworkRoute) {
          try { await state.context.recordNetworkRoute(fact); }
          catch (error) {
            throw failure(state.context, /^IRIS_(?:TASK|NETWORK)_/.test(error.code || '') ? error.code : 'IRIS_NETWORK_ROUTE_WRITE_FAILED',
              error.code === 'IRIS_NETWORK_ROUTE_LIMIT' ? '原 Task 的路线事实已达限额，已停止派发并保留历史'
                : '路线事实未能持久化，已停止出站；请检查存储和原 Task 身份', 'local_io');
          }
        }
        if (onRoute) {
          try { await onRoute(fact, state.context); }
          catch (error) {
            if (!/^IRIS_(?:TASK|NETWORK)_/.test(error.code || '')) throw error;
            throw failure(state.context, error.code, error.code === 'IRIS_NETWORK_ROUTE_LIMIT'
              ? '原 Task 的路线事实已达限额，已停止派发并保留历史'
              : '路线事实未能持久化，已停止出站；请检查存储和原 Task 身份', 'local_io');
          }
        }
        // Once business dispatch starts, errors remain conservatively ambiguous.
        // Neither the next proxy nor a direct connection may replay this request.
        try {
          if (!dispatcher) {
            if (!scheduler) return await inheritedProviderFetch(input, options);
            const { getGlobalDispatcher } = await library();
            return await scheduledFetch(inheritedProviderFetch, getGlobalDispatcher(), input, options, { providerId, modelRef, ...state.context });
          }
          const transport = await library(), request = transportFetchInput(transport, input, options);
          if (scheduler) return await scheduledFetch(transport.fetch, dispatcher, request.input, request.options, { providerId, modelRef, ...state.context });
          return await transport.fetch(request.input, { ...request.options, dispatcher });
        } catch (error) {
          if (typeof error.code === 'string' && error.code.startsWith('IRIS_SCHEDULER_')) throw error;
          if (options.signal?.aborted) throw options.signal.reason;
          throw Object.assign(new TypeError('出站请求失败；出口已选定，未自动重放请求'), { code: 'IRIS_NETWORK_TRANSPORT', cause: error });
        }
      },
      async close() {
        const results = await Promise.allSettled([...dispatchers.values()].map(async value => (await value).close()));
        if (results.some(value => value.status === 'rejected')) throw new Error('部分网络连接未能正常释放');
      }
    });
    const client = Object.freeze({ ...base, networkRequirement: requirement, providerId, ...(pool ? { poolId: pool.id } : {}),
      run(action, context = {}) {
        return base.run(fetch => scope.run({ context, selection: null }, () => action(fetch)));
      } });
    return remember(slot, key, client, true);
  }

  function dispose() {
    if (!disposal) {
      closing = true;
      disposal = (async () => {
        const results = await Promise.allSettled([
          ...[...clients.values()].map(entry => entry.client.dispose()), ...retiring
        ]);
        clients.clear();
        if (cleanupFailed || results.some(value => value.status === 'rejected')) throw new Error('网络管理实例释放失败');
      })();
    }
    return disposal;
  }
  return Object.freeze({ resolveProviderNetwork, dispose, scheduler });
}
