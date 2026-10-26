import crypto from 'node:crypto';
import { checkedClientConnection, readPrivateConnectionJson, connectionFail } from './core-connections.js';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN = /^run_[a-f0-9]{24}$/, OP = /^op_[a-f0-9]{64}$/, ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const input = () => connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'Core 服务工具输入无效');
function reference(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) input(); return value; }

/** A bounded client of one explicitly authorized Core. It never owns a Core writer or falls back. */
export function createCoreServiceClient({ connectionFile, connection, requestedScopes = ['read'], requestedCapabilities, requestedTools,
  harnessVersion = 'unknown', fetch: fetchImpl = globalThis.fetch } = {}) {
  if (connectionFile !== undefined && connection !== undefined) throw new TypeError('连接配置只能明确提供一种来源');
  const runtimeInstanceId = crypto.randomUUID(), lifetime = new AbortController();
  let state = 'new', config, negotiated, connectionPromise, metadataPromise, metadataKey, metadataAt = 0;
  async function request(route, { method = 'GET', value, bytes, key, mediaType, binary = false, signal, handshake = false } = {}) {
    if (state !== 'open' && !(handshake && state === 'connecting')) connectionFail('IRIS_CORE_SERVICE_DISCONNECTED', 'Core 服务尚未连接，请显式连接');
    const headers = { Authorization: 'Bearer ' + config.accessToken, 'Iris-Connection-Id': config.connectionId, 'Iris-Runtime-Id': runtimeInstanceId };
    if (key !== undefined) headers['Idempotency-Key'] = reference(key, UUID);
    if (value !== undefined || bytes !== undefined) headers['Content-Type'] = mediaType || 'application/json';
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetchImpl(config.origin + route, { method, headers, redirect: 'error', signal: combined,
        ...(value !== undefined ? { body: JSON.stringify(value) } : bytes !== undefined ? { body: bytes } : {}) });
    } catch (error) {
      if (signal?.aborted || lifetime.signal.aborted) throw Object.assign(new Error('Core 请求等待已停止；已接收操作需按原 Key 查询'), { name: 'AbortError', code: 'IRIS_CORE_SERVICE_ABORTED' });
      connectionFail('IRIS_CORE_SERVICE_UNAVAILABLE', 'Core 服务无法连接，请检查服务状态；没有切换到本地生成');
    }
    const limit = binary && response.ok ? 64 * 1024 * 1024 : 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 响应超过有界大小'); }
    const chunks = []; let size = 0;
    try {
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 响应超过有界大小');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error.code === 'IRIS_CORE_SERVICE_RESPONSE_INVALID') throw error;
      connectionFail('IRIS_CORE_SERVICE_UNAVAILABLE', 'Core 响应中断；请读取原 Operation，不要自动再次提交');
    }
    const result = Buffer.concat(chunks, size);
    if (binary && response.ok) {
      const mediaType = response.headers.get('content-type');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 返回的作品不是支持的静态图片');
      return { bytes: result, mediaType };
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)); }
    catch (_) { connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 返回无效 JSON'); }
    if (!response.ok) {
      const code = /^IRIS_[A-Z_]+$/.test(body?.error?.code) ? body.error.code : 'IRIS_CORE_SERVICE_REJECTED';
      throw Object.assign(new Error('Core 服务拒绝本次请求；请检查授权、原操作及服务状态'), { code, status: response.status });
    }
    if (body?.contractVersion !== 0) connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 响应契约不受支持');
    return body;
  }
  function connect() {
    if (state === 'closed') return Promise.reject(Object.assign(new Error('Core 连接已关闭'), { code: 'IRIS_CORE_SERVICE_DISCONNECTED' }));
    if (connectionPromise) return connectionPromise;
    connectionPromise = (async () => {
      config = checkedClientConnection(connection ?? readPrivateConnectionJson(connectionFile));
      state = 'connecting';
      try {
        const result = await request('/api/v0/connections/' + config.connectionId + '/handshake', { method: 'POST', handshake: true,
          value: { contractVersion: 0, adapterId: config.adapterId, harnessKind: config.harnessKind, runtimeInstanceId,
            harnessVersion, requestedScopes, requestedCapabilities: requestedCapabilities ?? config.capabilities,
            requestedTools: requestedTools ?? config.tools } });
        if (result.rootId !== config.rootId || result.connectionId !== config.connectionId || result.instance?.runtimeInstanceId !== runtimeInstanceId
            || !Array.isArray(result.instance.scopes) || result.instance.scopes.some(scope => !requestedScopes.includes(scope))
            || !Array.isArray(result.instance.capabilities) || result.instance.capabilities.some(id => !(requestedCapabilities ?? config.capabilities).includes(id))
            || !Array.isArray(result.instance.tools) || result.instance.tools.some(name => !(requestedTools ?? config.tools).includes(name))) {
          connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 数据空间或协商身份不一致');
        }
        negotiated = result; metadataKey = null; metadataAt = 0; state = 'open'; return structuredClone(result);
      } catch (error) { state = 'disconnected'; throw error; }
    })();
    void connectionPromise.then(() => { connectionPromise = null; }, () => { connectionPromise = null; });
    return connectionPromise;
  }
  function snapshot() {
    return { contractVersion: 0, state, ...(config ? { connectionId: config.connectionId, adapterId: config.adapterId,
      harnessKind: config.harnessKind, label: config.label, runtimeInstanceId, scopes: negotiated?.instance.scopes || [],
      capabilities: negotiated?.instance.capabilities || [], tools: negotiated?.instance.tools || [] } : {}) };
  }
  async function reportClientInfo(clientInfo, transport) {
    if (!clientInfo || !negotiated?.connectionFeatures?.includes('client-info')) return;
    const key = JSON.stringify({ clientInfo, transport });
    if (key === metadataKey && Date.now() - metadataAt < 60000) return metadataPromise;
    metadataKey = key; metadataAt = Date.now();
    const attempt = request('/api/v0/connections/' + config.connectionId + '/client-info', { method: 'POST', value: { clientInfo, transport } });
    metadataPromise = attempt;
    void attempt.catch(() => { if (metadataPromise === attempt) { metadataKey = null; metadataAt = 0; } });
    return metadataPromise;
  }
  async function dispose() {
    if (state === 'closed') return { state, remoteDisconnect: 'not_connected' };
    let remoteDisconnect = 'not_connected';
    try {
      if (metadataPromise) await Promise.allSettled([metadataPromise]);
      if (state === 'open') {
        remoteDisconnect = 'unconfirmed';
        await request('/api/v0/connections/' + config.connectionId + '/disconnect', { method: 'POST', value: {}, signal: AbortSignal.timeout(2000) });
        remoteDisconnect = 'confirmed';
      }
    } catch (error) {
      if (!['IRIS_CORE_SERVICE_UNAVAILABLE', 'IRIS_CORE_SERVICE_ABORTED', 'IRIS_CONNECTION_HANDSHAKE_REQUIRED',
        'IRIS_CONNECTION_AUTH_REQUIRED', 'IRIS_API_AUTH_REQUIRED', 'IRIS_API_UNAVAILABLE'].includes(error.code)) throw error;
    } finally { state = 'closed'; lifetime.abort(); negotiated = null; config = null; }
    return { state, remoteDisconnect };
  }
  function pageQuery(value = {}) {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['limit', 'cursor'].includes(key))
        || value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 30)
        || value.cursor !== undefined && typeof value.cursor !== 'string') input();
    return new URLSearchParams(Object.fromEntries(Object.entries(value).map(([key, value]) => [key, String(value)]))).toString();
  }
  return Object.freeze({ connect, dispose, snapshot, reportClientInfo,
    models: options => request('/api/v0/models', options),
    connections: options => request('/api/v0/connections', options),
    runs: (page, options) => request('/api/v0/runs?' + pageQuery(page), options),
    run: (id, options) => request('/api/v0/runs/' + reference(id, RUN), options),
    image: (id, options) => request('/api/v0/artifacts/' + reference(id, ARTIFACT) + '/content', { ...options, binary: true }),
    createImage({ key, bytes, mediaType }, options) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMPORT_IMAGE_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) input();
      return request('/api/v0/images', { ...options, method: 'POST', bytes, key, mediaType });
    },
    createRun({ key, value }, options) { return request('/api/v0/runs', { ...options, method: 'POST', value, key }); },
    createGeneration({ key, value }, options) { return request('/api/v0/generations', { ...options, method: 'POST', value, key }); },
    continueRun({ key, runId, expectedRevision }, options) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) input();
      return request('/api/v0/runs/' + reference(runId, RUN) + '/continue', { ...options, method: 'POST', value: { expectedRevision }, key });
    },
    operation: (id, options) => request('/api/v0/operations/' + reference(id, OP), options),
    lookup: (key, options) => request('/api/v0/operations?key=' + reference(key, UUID), options),
    operations: (runId, page, options) => request('/api/v0/runs/' + reference(runId, RUN) + '/operations?' + pageQuery(page), options),
    stop: (id, options) => request('/api/v0/operations/' + reference(id, OP) + '/cancel', { ...options, method: 'POST', value: {} })
  });
}
