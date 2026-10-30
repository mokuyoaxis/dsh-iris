import crypto from 'node:crypto';
import { checkedClientConnection, readPrivateConnectionJson, connectionFail } from './core-connections.js';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';
import { annotateCoreConnectionError } from './core-connection-diagnostics.js';
import { checkedPluginSelection, hasPluginSelection } from './plugin-selection.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN = /^run_[a-f0-9]{24}$/, OP = /^op_[a-f0-9]{64}$/, ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const input = () => connectionFail('IRIS_CONNECTION_INPUT_INVALID', 'Core 服务工具输入无效');
function reference(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) input(); return value; }

/** A bounded client of one explicitly authorized Core. It never owns a Core writer or falls back. */
export function createCoreServiceClient({ connectionFile, connection, requestedScopes = ['read'], requestedCapabilities, requestedTools, requestedPluginOperations,
  harnessVersion = 'unknown', fetch: fetchImpl = globalThis.fetch } = {}) {
  if (connectionFile !== undefined && connection !== undefined) throw new TypeError('连接配置只能明确提供一种来源');
  const runtimeInstanceId = crypto.randomUUID(), lifetime = new AbortController();
  let state = 'new', config, negotiated, connectionPromise, metadataPromise, metadataKey, metadataAt = 0, disposal;
  async function request(route, { method = 'GET', value, bytes, key, mediaType, binary = false, signal, handshake = false, disconnect = false } = {}) {
    if (state !== 'open' && !(handshake && state === 'connecting') && !(disconnect && state === 'closing')) connectionFail('IRIS_CORE_SERVICE_DISCONNECTED', 'Core 服务尚未连接，请显式连接');
    const headers = { Authorization: 'Bearer ' + config.accessToken, 'Iris-Connection-Id': config.connectionId, 'Iris-Runtime-Id': runtimeInstanceId };
    if (key !== undefined) headers['Idempotency-Key'] = reference(key, UUID);
    if (value !== undefined || bytes !== undefined) headers['Content-Type'] = mediaType || 'application/json';
    const combined = AbortSignal.any([...(disconnect ? [] : [lifetime.signal]), AbortSignal.timeout(disconnect ? 2000 : 15000), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetchImpl(config.origin + route, { method, headers, redirect: 'error', signal: combined,
        ...(value !== undefined ? { body: JSON.stringify(value) } : bytes !== undefined ? { body: bytes } : {}) });
    } catch (error) {
      if (signal?.aborted || !disconnect && lifetime.signal.aborted) throw Object.assign(new Error('Core 请求等待已停止；已接收操作需按原 Key 查询'), { name: 'AbortError', code: 'IRIS_CORE_SERVICE_ABORTED' });
      throw annotateCoreConnectionError(Object.assign(new Error('Core 服务无法连接，请检查服务状态'), {
        code: combined.reason?.name === 'TimeoutError' ? 'IRIS_CORE_SERVICE_TIMEOUT' : 'IRIS_CORE_SERVICE_UNAVAILABLE' }), 'transport');
    }
    const limit = binary && binary !== 'text' && response.ok ? 64 * 1024 * 1024 : 1024 * 1024;
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
      const allowed = binary === 'audio' ? ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'] : binary === 'text' ? ['text/plain'] : ['image/png', 'image/jpeg', 'image/webp'];
      if (!allowed.includes(mediaType)) connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core返回的作品类型与所选入口不一致');
      return { bytes: result, mediaType };
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)); }
    catch (_) { connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 返回无效 JSON'); }
    if (!response.ok) {
      const code = /^IRIS_[A-Z_]+$/.test(body?.error?.code) ? body.error.code : 'IRIS_CORE_SERVICE_REJECTED';
      throw annotateCoreConnectionError(Object.assign(new Error('Core 服务拒绝本次请求；请检查授权、原操作及服务状态'), {
        code, status: response.status, ...(UUID.test(body?.error?.requestId) ? { requestId: body.error.requestId } : {}) }), handshake ? 'handshake' : disconnect ? 'disconnect' : 'tool');
    }
    if (body?.contractVersion !== 0) connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 响应契约不受支持');
    return body;
  }
  function connect() {
    if (['closing', 'closed'].includes(state)) return Promise.reject(Object.assign(new Error('Core 连接已关闭'), { code: 'IRIS_CORE_SERVICE_DISCONNECTED' }));
    if (connectionPromise) return connectionPromise;
    connectionPromise = (async () => {
      let stage = 'configuration';
      try {
        config = checkedClientConnection(connection ?? readPrivateConnectionJson(connectionFile));
        state = 'connecting'; stage = 'handshake';
        const pluginChoice = requestedPluginOperations === undefined ? config.pluginOperations : requestedPluginOperations;
        const result = await request('/api/v0/connections/' + config.connectionId + '/handshake', { method: 'POST', handshake: true,
          value: { contractVersion: 0, adapterId: config.adapterId, harnessKind: config.harnessKind, runtimeInstanceId,
            harnessVersion, requestedScopes, requestedCapabilities: requestedCapabilities ?? config.capabilities,
            requestedTools: requestedTools ?? config.tools,
            ...(pluginChoice === undefined ? {} : { requestedPluginOperations: checkedPluginSelection(pluginChoice) }) } });
        if (state !== 'connecting') connectionFail('IRIS_CORE_SERVICE_ABORTED', '连接启动等待已停止');
        if (result.rootId !== config.rootId || result.connectionId !== config.connectionId || result.instance?.runtimeInstanceId !== runtimeInstanceId
            || !Array.isArray(result.instance.scopes) || result.instance.scopes.some(scope => !requestedScopes.includes(scope))
            || !Array.isArray(result.instance.capabilities) || result.instance.capabilities.some(id => !(requestedCapabilities ?? config.capabilities).includes(id))
            || !Array.isArray(result.instance.tools) || result.instance.tools.some(name => !(requestedTools ?? config.tools).includes(name))) {
          connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 数据空间或协商身份不一致');
        }
        if (checkedPluginSelection(result.instance.pluginOperations).some(pin => !hasPluginSelection(pluginChoice ?? [], pin))) {
          connectionFail('IRIS_CORE_SERVICE_RESPONSE_INVALID', 'Core 返回了未请求的插件业务依赖');
        }
        negotiated = result; metadataKey = null; metadataAt = 0; state = 'open'; return structuredClone(result);
      } catch (error) { if (!['closing', 'closed'].includes(state)) state = 'disconnected'; throw annotateCoreConnectionError(error, stage); }
    })();
    void connectionPromise.then(() => { connectionPromise = null; }, () => { connectionPromise = null; });
    return connectionPromise;
  }
  function snapshot() {
    return { contractVersion: 0, state, ...(config ? { connectionId: config.connectionId, adapterId: config.adapterId,
      harnessKind: config.harnessKind, label: config.label, runtimeInstanceId, scopes: negotiated?.instance.scopes || [],
      capabilities: negotiated?.instance.capabilities || [], tools: negotiated?.instance.tools || [],
      ...(negotiated?.instance.pluginOperations?.length ? { pluginOperations: structuredClone(negotiated.instance.pluginOperations) } : {}) } : {}) };
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
  function dispose() {
    if (disposal) return disposal;
    const wasOpen = state === 'open', starting = connectionPromise;
    state = 'closing'; lifetime.abort();
    disposal = (async () => {
      let remoteDisconnect = wasOpen ? 'unconfirmed' : 'not_connected';
      try {
        if (wasOpen) {
          await request('/api/v0/connections/' + config.connectionId + '/disconnect', { method: 'POST', value: {}, disconnect: true });
          remoteDisconnect = 'confirmed';
        }
      } catch (error) {
        if (!['IRIS_CORE_SERVICE_UNAVAILABLE', 'IRIS_CORE_SERVICE_TIMEOUT', 'IRIS_CORE_SERVICE_ABORTED', 'IRIS_CONNECTION_HANDSHAKE_REQUIRED',
          'IRIS_CONNECTION_AUTH_REQUIRED', 'IRIS_API_AUTH_REQUIRED', 'IRIS_API_UNAVAILABLE'].includes(error.code)) throw error;
      } finally {
        await Promise.allSettled([starting, metadataPromise].filter(Boolean));
        state = 'closed'; negotiated = null; config = null;
      }
      return { state, remoteDisconnect };
    })();
    return disposal;
  }
  function pageQuery(value = {}) {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['limit', 'cursor'].includes(key))
        || value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 30)
        || value.cursor !== undefined && typeof value.cursor !== 'string') input();
    return new URLSearchParams(Object.fromEntries(Object.entries(value).map(([key, value]) => [key, String(value)]))).toString();
  }
  return Object.freeze({ connect, dispose, snapshot, reportClientInfo,
    pluginCatalog: (page, options) => request('/api/v0/plugin-operations/catalog?' + new URLSearchParams(page), options),
    callPlugin({ key, ...value }, options) { return request('/api/v0/plugin-operations', { ...options, method: 'POST', value, key }); },
    models: options => request('/api/v0/models', options),
    audioModels: options => request('/api/v0/audio-models', options),
    connections: options => request('/api/v0/connections', options),
    runs: (page, options) => request('/api/v0/runs?' + pageQuery(page), options),
    run: (id, options) => request('/api/v0/runs/' + reference(id, RUN), options),
    image: (id, options) => request('/api/v0/artifacts/' + reference(id, ARTIFACT) + '/content', { ...options, binary: true }),
    audio: (id, options) => request('/api/v0/artifacts/' + reference(id, ARTIFACT) + '/audio', { ...options, binary: 'audio' }),
    transcript: (id, options) => request('/api/v0/artifacts/' + reference(id, ARTIFACT) + '/text', { ...options, binary: 'text' }),
    createImage({ key, bytes, mediaType }, options) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMPORT_IMAGE_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) input();
      return request('/api/v0/images', { ...options, method: 'POST', bytes, key, mediaType });
    },
    createRun({ key, value }, options) { return request('/api/v0/runs', { ...options, method: 'POST', value, key }); },
    createGeneration({ key, value }, options) { return request('/api/v0/generations', { ...options, method: 'POST', value, key }); },
    createAudio({ key, bytes, mediaType }, options) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 * 1024 * 1024 || !['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'].includes(mediaType)) input();
      return request('/api/v0/audio', { ...options, method: 'POST', bytes, key, mediaType });
    },
    createSpeech({ key, value }, options) { return request('/api/v0/speeches', { ...options, method: 'POST', value, key }); },
    createTranscription({ key, value }, options) { return request('/api/v0/transcriptions', { ...options, method: 'POST', value, key }); },
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
