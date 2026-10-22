import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApplicationRuntime } from './application-runtime.js';
import { normalizeCoreOptions } from './core-contract.js';
import { createCoreRuntime } from './core-runtime.js';
import { inspectFlowRoot } from './flow-store.js';
import { inspectCoreArtifactMetadata, readCoreArtifactBytes } from './core-artifacts.js';
import { imageCandidatesFromCatalog, loadProviderCatalog, providerTaskBinding } from './provider-catalog.js';
import { supportsImageEdit } from './provider-protocol.js';
import { projectLocalApiFlow, projectLocalApiRunSummary } from './local-api-projection.js';
import { inspectCreationRoot } from './creation-request-store.js';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';

export const MAX_LOCAL_API_IMAGE_BYTES = 64 * 1024 * 1024;
const RUN = /^run_[a-f0-9]{24}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const digest = value => crypto.createHash('sha256').update(value).digest();
const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export class LocalApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'LocalApiError'; this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new LocalApiError(code, message, status); }

function httpError(error) {
  if (error instanceof LocalApiError) return error;
  if (error?.code === 'IRIS_CORE_DATA_ROOT_BUSY') return new LocalApiError('IRIS_API_ROOT_BUSY', '该数据根已有活动写者，请稍后显式重试', 409);
  if (error?.code === 'IRIS_CREATION_RESULT_UNAVAILABLE') return new LocalApiError('IRIS_API_RESULT_UNAVAILABLE', '原创建结果已不可用；同 Key 不会重新创建或复活作品', 409);
  if (error?.code === 'IRIS_CREATION_KEY_CONFLICT') return new LocalApiError('IRIS_API_KEY_CONFLICT', '该 Key 已绑定其他输入', 409);
  if (['IRIS_CREATION_KEY_INVALID', 'IRIS_CREATION_INPUT_INVALID', 'IRIS_GENERATION_INPUT_INVALID',
    'IRIS_IMAGE_IMPORT_INVALID', 'IRIS_IMAGE_EDIT_INPUT_INVALID', 'IRIS_FLOW_INPUT_INVALID'].includes(error?.code)) {
    return new LocalApiError('IRIS_API_INPUT_INVALID', '创作输入或静态图片无效，请检查来源、模型和参数', 400);
  }
  if (error?.code === 'IRIS_CREATION_MEDIA_MISMATCH') return new LocalApiError('IRIS_API_MEDIA_UNSUPPORTED', '图片真实格式与 Content-Type 不一致', 415);
  if (/^IRIS_CREATION_/.test(error?.code || '')) return new LocalApiError('IRIS_API_RECORD_CONFLICT', '创建请求证据不一致，请在本机检查原记录', 409);
  if (['IRIS_FLOW_NOT_FOUND', 'IRIS_ARTIFACT_NOT_FOUND'].includes(error?.code)) {
    return new LocalApiError('IRIS_API_NOT_FOUND', '该实例中没有此流程或图片', 404);
  }
  if (/^IRIS_PROVIDER_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_CONFIG_UNAVAILABLE', '模型配置不可用，请在本机检查显式配置', 500);
  }
  if (error?.code === 'IRIS_APP_CLOSED' || error?.name === 'AbortError' || /^IRIS_CORE_DATA_ROOT_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_UNAVAILABLE', '服务正在关闭或数据根不可用', 503);
  }
  if (/^IRIS_(?:FLOW|ARTIFACT|TASK)_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_RECORD_CONFLICT', '流程或作品证据不一致，请在本机核对原记录', 409);
  }
  return new LocalApiError('IRIS_API_INTERNAL', '读取失败，请使用关联 ID 核对本机诊断', 500);
}

function reportUnexpected(error, requestId) {
  // Keep call sites for diagnosis, without the potentially private exception message or directory names.
  const frames = String(error?.stack || '').split('\n').slice(1, 7)
    .map(line => line.replace(/(?:file:\/\/)?(?:\/[^\s()]+)+(?=:\d+:\d+)/g, value => path.basename(value)));
  console.error(JSON.stringify({ event: 'iris_local_api_error', requestId, frames }));
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count;
}

function query(url, allowed = []) {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) {
      fail('IRIS_API_INPUT_INVALID', '查询参数无效或重复');
    }
  }
}

function send(request, response, status, bytes, headers = {}) {
  if (response.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { response.off('finish', finish); response.off('close', finish); resolve(); };
    response.once('finish', finish); response.once('close', finish);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer', ...headers });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
}
const json = (request, response, value, status = 200) => send(request, response, status, Buffer.from(JSON.stringify(value)));

/** Internal Host, read-only by default. Construction performs no I/O and never binds a port. */
export function createLocalReadApi({ dataRoot, providerConfigPath, allowLocalWrites = false } = {}) {
  if (typeof allowLocalWrites !== 'boolean') throw new TypeError('allowLocalWrites 必须是布尔值');
  const suppliedRoot = normalizeCoreOptions({ dataRoot, mode: 'reader' }).dataRoot;
  if (providerConfigPath !== undefined && (typeof providerConfigPath !== 'string' || !path.isAbsolute(providerConfigPath))) {
    throw new LocalApiError('IRIS_API_CONFIG_INVALID', 'Provider 配置必须是显式绝对路径');
  }
  let state = 'new', origin = null, tokenDigest = null, application, server, physicalRoot;
  let startPromise, disposal, closeRequested = false, activeReads = 0, activeUploads = 0, localWrites = 0;
  const jobs = new Set(), instanceId = crypto.randomUUID();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const snapshot = () => Object.freeze({ contractVersion: 0, state, origin, readOnly: !allowLocalWrites, activeReads });

  function authorize(request) {
    const headers = request.headers;
    if (headerCount(request, 'host') !== 1 || headers.host !== new URL(origin).host) {
      fail('IRIS_API_HOST_DENIED', '请求地址不可信，请使用启动时给出的本机地址', 403);
    }
    if (headerCount(request, 'origin') > 1 || (headers.origin !== undefined && headers.origin !== origin)
        || (headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(headers['sec-fetch-site']))) {
      fail('IRIS_API_ORIGIN_DENIED', '请求来源不可信', 403);
    }
    const match = headerCount(request, 'authorization') === 1 && /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(headers.authorization || '');
    if (!match || !crypto.timingSafeEqual(digest(match[1]), tokenDigest)) {
      fail('IRIS_API_AUTH_REQUIRED', '需要有效的本机会话 Token', 401);
    }
  }

  async function image(artifactId) {
    // Use an operation-owned reader, with no writer lease or local export path.
    const reader = createCoreRuntime({ dataRoot: physicalRoot, mode: 'reader' });
    try {
      reader.start();
      return await reader.run('inspect', ({ dataRoot: physicalRoot }) => {
        const metadata = inspectCoreArtifactMetadata(physicalRoot, artifactId);
        if (!IMAGE_TYPES.has(metadata.mediaType)) fail('IRIS_API_MEDIA_UNSUPPORTED', '此接口只提供 PNG、JPEG 或 WebP 图片', 415);
        if (metadata.size > MAX_LOCAL_API_IMAGE_BYTES) fail('IRIS_API_MEDIA_TOO_LARGE', '图片超过只读接口的 64 MiB 上限', 413);
        const result = readCoreArtifactBytes(physicalRoot, artifactId);
        if (result.bytes.length > MAX_LOCAL_API_IMAGE_BYTES || result.bytes.length !== result.artifact.size
            || digest(result.bytes).toString('hex') !== result.artifact.digest.value) {
          fail('IRIS_API_RECORD_CONFLICT', '图片字节与已保存记录不一致', 409);
        }
        return result;
      });
    } finally { await reader.dispose(); }
  }

  function models() {
    if (!providerConfigPath) return { contractVersion: 0, configured: false, models: [], total: 0 };
    const catalog = loadProviderCatalog(providerConfigPath);
    let candidates;
    try { candidates = imageCandidatesFromCatalog(catalog); }
    catch (error) { if (error.code !== 'IRIS_PROVIDER_MODEL_UNAVAILABLE') throw error; candidates = []; }
    const entries = candidates.map(route => ({ modelRef: route.modelRef, displayName: route.model,
      supportsImageEdit: supportsImageEdit(route.provider.mediaProtocol, route.model) }));
    return { contractVersion: 0, configured: true, models: entries, total: entries.length };
  }

  async function create(request, response, url) {
    query(url);
    if (!['/api/v0/images', '/api/v0/runs'].includes(url.pathname)) fail('IRIS_API_NOT_FOUND', '没有此本地创建接口', 404);
    const isImage = url.pathname === '/api/v0/images';
    if (headerCount(request, 'idempotency-key') !== 1 || !KEY.test(request.headers['idempotency-key'] || '')) {
      fail('IRIS_API_INPUT_INVALID', 'Idempotency-Key 须为单个小写 UUIDv4');
    }
    if (headerCount(request, 'content-type') !== 1 || request.headers['content-encoding'] !== undefined) {
      fail('IRIS_API_INPUT_INVALID', '正文需要单个 Content-Type，且不接受 Content-Encoding');
    }
    const mediaType = request.headers['content-type'];
    if (isImage ? !IMAGE_TYPES.has(mediaType) : !/^application\/json(?:;\s*charset=utf-8)?$/i.test(mediaType)) {
      fail('IRIS_API_MEDIA_UNSUPPORTED', '请提供静态 PNG/JPEG/WebP 原字节或 UTF-8 JSON', 415);
    }
    const limit = isImage ? MAX_IMPORT_IMAGE_BYTES : 64 * 1024;
    if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > limit) {
      fail('IRIS_API_INPUT_TOO_LARGE', '正文超过允许的大小', 413);
    }
    if (isImage && activeUploads >= 1 || localWrites >= 9) fail('IRIS_API_BUSY', '本地创建繁忙，请使用原 Key 稍后重试', 429);
    if (isImage) activeUploads++;
    localWrites++;
    const controller = new AbortController();
    let prepared = false;
    const disconnect = () => { if (!prepared) controller.abort(); };
    response.once('close', disconnect);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) fail('IRIS_API_INPUT_TOO_LARGE', '正文超过允许的大小', 413);
        chunks.push(chunk);
      }
      if (Object.keys(request.trailers).length || size === 0) fail('IRIS_API_INPUT_INVALID', '正文不能为空或包含尾部头字段');
      if (state !== 'open') fail('IRIS_API_UNAVAILABLE', '服务正在关闭', 503);
      const bytes = Buffer.concat(chunks, size);
      let value;
      if (!isImage) {
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch (_) { fail('IRIS_API_INPUT_INVALID', '需要有效的 UTF-8 JSON'); }
      }
      const result = await application.execute(isImage ? 'creation.image' : 'creation.flow', {
        key: request.headers['idempotency-key'], ...(isImage ? { bytes, mediaType } : { value })
      }, { signal: controller.signal, onPrepared: () => { prepared = true; } });
      const body = { contractVersion: 0, idempotentReplay: result.idempotentReplay,
        ...(isImage ? { artifact: { artifactId: result.artifact.id, mediaType: result.artifact.mediaType,
          size: result.artifact.size, width: result.artifact.metadata.width, height: result.artifact.metadata.height } }
          : { flow: projectLocalApiFlow(result.flow) }) };
      return await json(request, response, body, result.idempotentReplay ? 200 : 201);
    } catch (error) {
      if (request.aborted && !prepared) fail('IRIS_API_REQUEST_INTERRUPTED', '上传连接已中断，未接受本次创建');
      throw error;
    } finally {
      response.off('close', disconnect); localWrites--;
      if (isImage) activeUploads--;
    }
  }

  async function route(request, response) {
    if (state !== 'open') fail('IRIS_API_UNAVAILABLE', '服务正在关闭', 503);
    authorize(request);
    if (!['GET', 'HEAD'].includes(request.method) && !(allowLocalWrites && request.method === 'POST')) {
      fail('IRIS_API_READ_ONLY', allowLocalWrites ? '仅支持 GET/HEAD 与明确的本地创建 POST' : '当前接口仅支持只读 GET/HEAD', 405);
    }
    if (request.method !== 'POST' && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) {
      fail('IRIS_API_INPUT_INVALID', '只读请求不接受正文');
    }
    if (!request.url.startsWith('/') || request.url.startsWith('//')) fail('IRIS_API_INPUT_INVALID', '请求路径无效');
    const url = new URL(request.url, origin);
    if (url.pathname !== request.url.split('?')[0]) fail('IRIS_API_INPUT_INVALID', '请求路径无效');
    if (request.method === 'POST') return create(request, response, url);
    const matchRun = /^\/api\/v0\/runs\/([^/]+)(\/download)?$/.exec(url.pathname);
    const matchImage = /^\/api\/v0\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
    query(url, url.pathname === '/api/v0/runs' ? ['limit', 'cursor'] : []);
    if (matchRun && !RUN.test(matchRun[1]) || matchImage && !ARTIFACT.test(matchImage[1])) {
      fail('IRIS_API_INPUT_INVALID', '流程或图片 ID 格式无效');
    }
    if (activeReads >= 2) fail('IRIS_API_BUSY', '读取繁忙，请稍后再试', 429);
    activeReads++;
    try {
      if (url.pathname === '/api/v0/session') {
        return await json(request, response, { contractVersion: 0, instanceId, readOnly: !allowLocalWrites,
          operations: ['models.list', 'runs.list', 'runs.inspect', 'artifacts.content', 'runs.download',
            ...(allowLocalWrites ? ['images.create', 'runs.create'] : [])],
          limits: { runPageSize: 30, imageBytes: MAX_LOCAL_API_IMAGE_BYTES, activeReads: 2,
            ...(allowLocalWrites ? { uploadBytes: MAX_IMPORT_IMAGE_BYTES, jsonBytes: 64 * 1024, activeUploads: 1, localWrites: 9 } : {}) } });
      }
      if (url.pathname === '/api/v0/models') return await json(request, response, models());
      if (url.pathname === '/api/v0/runs') {
        const limitText = url.searchParams.get('limit') ?? '20';
        if (!/^(?:[1-9]|[12][0-9]|30)$/.test(limitText)) fail('IRIS_API_INPUT_INVALID', 'limit 必须是 1–30 的整数');
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && !RUN.test(cursor)) fail('IRIS_API_INPUT_INVALID', '游标无效');
        const result = await application.execute('flow.list', {});
        const ordered = [...result.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const index = cursor === null ? 0 : ordered.findIndex(run => run.id === cursor) + 1;
        if (cursor !== null && index === 0) fail('IRIS_API_INPUT_INVALID', '游标已失效，请重新读取列表');
        const page = ordered.slice(index, index + Number(limitText));
        return await json(request, response, { contractVersion: 0, total: ordered.length,
          runs: page.map(projectLocalApiRunSummary), nextCursor: index + page.length < ordered.length ? page.at(-1).id : null });
      }
      let artifactId;
      if (matchRun) {
        const view = projectLocalApiFlow(await application.execute('flow.inspect', { run_id: matchRun[1] }));
        if (!matchRun[2]) return await json(request, response, view);
        if (!view.selection) fail('IRIS_API_SELECTION_REQUIRED', '请先明确选择要下载的作品', 409);
        artifactId = view.selection.artifactId;
      } else if (matchImage) artifactId = matchImage[1];
      else fail('IRIS_API_NOT_FOUND', '没有此只读接口', 404);
      const result = await image(artifactId);
      return await send(request, response, 200, result.bytes, { 'Content-Type': result.artifact.mediaType,
        ...(matchRun ? { 'Content-Disposition': `attachment; filename="iris-${artifactId}.${IMAGE_TYPES.get(result.artifact.mediaType)}"` } : {}) });
    } finally { activeReads--; }
  }

  async function handle(request, response) {
    const requestId = crypto.randomUUID();
    try { await route(request, response); }
    catch (error) {
      const safe = httpError(error);
      if (safe.code === 'IRIS_API_INTERNAL') reportUnexpected(error, requestId);
      await send(request, response, safe.status, Buffer.from(JSON.stringify({ contractVersion: 0,
        error: { code: safe.code, message: safe.message, requestId } })), {
        Connection: 'close', ...(safe.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="iris-local"' } : {}),
        ...(safe.status === 405 ? { Allow: allowLocalWrites ? 'GET, HEAD, POST' : 'GET, HEAD' } : {}) });
    }
  }

  async function closeServer() {
    if (!server?.listening) return;
    const completion = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await completion;
  }

  function start({ port = 0 } = {}) {
    if (state !== 'new') return Promise.reject(new LocalApiError('IRIS_API_LIFECYCLE', '服务只能显式启动一次', 409));
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new LocalApiError('IRIS_API_INPUT_INVALID', '端口必须是 0–65535 的整数'));
    state = 'starting';
    const result = (async () => {
      try {
        const reader = createCoreRuntime({ dataRoot: suppliedRoot, mode: 'reader' });
        try {
          reader.start();
          physicalRoot = await reader.run('inspect', ({ dataRoot: root }) => {
            inspectFlowRoot(root);
            if (allowLocalWrites) inspectCreationRoot(root);
            return root;
          });
        } finally { await reader.dispose(); }
        if (closeRequested) fail('IRIS_API_UNAVAILABLE', '启动已取消', 503);
        application = createApplicationRuntime({ dataRoot: physicalRoot,
          ...(allowLocalWrites && providerConfigPath ? { resolveImageCandidates: ({ modelRef }) =>
            imageCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef).map(route => ({
              adapter: { id: route.provider.id, protocol: route.provider.mediaProtocol }, model: route.modelRef,
              providerBinding: providerTaskBinding(route.provider), selectionReason: 'explicit'
            })) } : {}) });
        server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000 }, (request, response) => {
          const job = handle(request, response).catch(error => {
            reportUnexpected(error, crypto.randomUUID()); response.destroy();
          });
          jobs.add(job); void job.then(() => jobs.delete(job));
        });
        server.keepAliveTimeout = 1000; server.maxConnections = 32;
        server.setTimeout(15000, socket => socket.destroy());
        server.on('upgrade', (_request, socket) => socket.destroy());
        server.on('connect', (_request, socket) => socket.destroy());
        await new Promise((resolve, reject) => {
          const onError = error => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError); server.once('listening', onListening); server.listen(port, '127.0.0.1');
        });
        origin = `http://127.0.0.1:${server.address().port}`;
        const accessToken = crypto.randomBytes(32).toString('base64url');
        tokenDigest = digest(accessToken);
        if (closeRequested) fail('IRIS_API_UNAVAILABLE', '启动已取消', 503);
        state = 'open';
        return Object.freeze({ origin, accessToken });
      } catch (error) {
        await closeServer(); await application?.dispose();
        state = closeRequested ? 'closing' : 'closed';
        if (!closeRequested) resolveClosed(snapshot());
        throw error;
      }
    })();
    // Retain only completion for lifecycle coordination; not the private start result containing the token.
    startPromise = result.then(() => undefined, () => undefined);
    return result;
  }

  function dispose() {
    if (disposal) return disposal;
    closeRequested = true; state = 'closing'; tokenDigest?.fill(0);
    disposal = (async () => {
      if (startPromise) await startPromise.catch(() => {}); // start's caller retains the original failure.
      await closeServer(); await application?.dispose(); await Promise.all([...jobs]);
      state = 'closed'; resolveClosed(snapshot());
      return snapshot();
    })();
    return disposal;
  }
  return Object.freeze({ start, dispose, snapshot, closed });
}

/** Explicit credential output, outside Core. Existing files and parent permissions are untouched. */
export function writeLocalApiTokenFile(file, token, dataRoot) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('IRIS_API_TOKEN_FILE_INVALID', '会话 Token 文件必须是新的绝对路径');
  let fd;
  try {
    const root = fs.realpathSync(dataRoot), parent = fs.realpathSync(path.dirname(file));
    const destination = path.join(parent, path.basename(file)), relative = path.relative(root, destination);
    if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      fail('IRIS_API_TOKEN_FILE_INVALID', '会话 Token 文件必须放在 Core 数据根之外');
    }
    fd = fs.openSync(destination, 'wx', 0o600);
    fs.writeFileSync(fd, token + '\n', 'utf8');
  } catch (error) {
    if (error instanceof LocalApiError) throw error;
    fail('IRIS_API_TOKEN_FILE_UNAVAILABLE', '会话 Token 文件不可写或已存在，请指定新的根外文件');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
