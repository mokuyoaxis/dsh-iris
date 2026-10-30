import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApplicationRuntime } from './application-runtime.js';
import { normalizeCoreOptions } from './core-contract.js';
import { createCoreRuntime } from './core-runtime.js';
import { inspectFlowRoot, listFlowRuns, readFlowRun } from './flow-store.js';
import { inspectCoreArtifactMetadata, readCoreArtifactBytes, listCoreArtifacts } from './core-artifacts.js';
import { isPluginSourceImage } from './plugin-source-image.js';
import { imageCandidatesFromCatalog, ttsCandidatesFromCatalog, transcribeCandidatesFromCatalog, loadProviderCatalog, providerTaskBinding } from './provider-catalog.js';
import { AUDIO_TYPES, MAX_AUDIO_INPUT_BYTES, isAudioRecipe } from './audio-flow-input.js';
import { CREATION_KINDS } from './creation-request-store.js';
import { supportsImageEdit } from './provider-protocol.js';
import { projectComfyWorkflow, compileComfyWorkflow } from './comfyui-workflow.js';
import { projectLocalApiFlow, projectLocalApiRunSummary } from './local-api-projection.js';
import { inspectCreationRoot } from './creation-request-store.js';
import { MAX_IMPORT_IMAGE_BYTES } from './image-import.js';
import { DEFAULT_PANEL, LOCAL_WEB_CSP } from './local-web-assets.js';
import { loadPanelExtension } from './panel-extension.js';
import { createPluginPanelAssembly } from './plugin-web-assets.js';
import { executeConfigCommand } from './provider-config-service.js';
import { projectProviderDiagnostics, providerDependencies, providerRemovalImpact } from './provider-diagnostics.js';
import { createProviderMonitor } from './provider-monitor.js';
import { configuredImagePorts } from './configured-image-runtime.js';
import { ProviderContractError } from './provider-contract.js';
import { createProviderRegistry } from './provider-extensions.js';
import { createOperationRunner } from './operation-runner.js';
import { inspectExecutionRoot } from './operation-store.js';
import { readConnectionGrants, createConnectionRegistry } from './core-connections.js';
import { createManagedConnectionStore } from './core-connection-store.js';
import { CONNECTION_TEMPLATE_EXAMPLE } from './connection-template.js';
import { checkedBridgeCapabilities, DEFAULT_BRIDGE_CAPABILITIES } from './core-bridge-selection.js';
import { createCoreCapabilityCatalog, projectCoreSessionOperations, CORE_CAPABILITY_GROUPS } from './core-capability-catalog.js';
import { MCP_CONNECTION_PRESETS, MCP_CONFIG_FORMATS } from './mcp-delivery.js';
import { checkedPluginSelection, hasPluginSelection } from './plugin-selection.js';
import { readAllOperations, projectOperation } from './operation-store.js';
import { createWorkbenchAuth, WorkbenchAuthError } from './workbench-auth.js';

export const MAX_LOCAL_API_IMAGE_BYTES = 64 * 1024 * 1024;
const RUN = /^run_[a-f0-9]{24}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const AUDIO_MEDIA_TYPES = new Map(Object.entries(AUDIO_TYPES));
const digest = value => crypto.createHash('sha256').update(value).digest();
const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export class LocalApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'LocalApiError'; this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new LocalApiError(code, message, status); }

function httpError(error) {
  if (error instanceof LocalApiError) return error;
  if (error instanceof WorkbenchAuthError) return new LocalApiError(error.code, error.message, error.status);
  if (/^IRIS_PLUGIN_/.test(error?.code || '')) return new LocalApiError(error.code,
    error.code === 'IRIS_PLUGIN_INPUT_INVALID' ? '业务输入不符合当前插件参数要求' : '插件业务未授权、缺失或版本不一致；请读取原 Operation 并核对准确插件版本',
    error.code === 'IRIS_PLUGIN_INPUT_INVALID' ? 400 : error.code === 'IRIS_PLUGIN_OPERATION_DENIED' ? 403 : 409);
  if (['IRIS_CONFIG_CHANGED', 'IRIS_CONFIG_BUSY'].includes(error?.code)) return new LocalApiError(error.code,
    '配置已变化或有其他写入，请保留草稿并重新读取后核对', 409);
  if (error?.code === 'IRIS_CONFIG_INPUT_INVALID' || error?.code === 'IRIS_FUNCTION_POLICY_INVALID') return new LocalApiError('IRIS_CONFIG_INPUT_INVALID',
    '设置无效，请检查地址、协议、模型用途和密钥动作', 400);
  if (error?.code === 'IRIS_OPERATION_NOT_FOUND') return new LocalApiError(error.code, 'Operation 不存在', 404);
  if (error?.code === 'IRIS_OPERATION_KEY_CONFLICT') return new LocalApiError(error.code, '该 UUID 已绑定其他业务、输入或依赖，请先查询原操作', 409);
  if (error?.code === 'IRIS_OPERATION_QUEUE_FULL') return new LocalApiError(error.code, '活动操作已达上限，本次未接收', 429);
  if (error?.code === 'IRIS_OPERATION_INPUT_INVALID' || error?.code === 'IRIS_OPERATION_KEY_INVALID') return new LocalApiError(error.code, 'Operation 输入无效', 400);
  if (/^IRIS_CONNECTION_/.test(error?.code || '')) {
    const status = error.code === 'IRIS_CONNECTION_AUTH_REQUIRED' ? 401 : error.code === 'IRIS_CONNECTION_CAPABILITY_DENIED' ? 403
      : error.code === 'IRIS_CONNECTION_BUSY' ? 429 : error.code === 'IRIS_CONNECTION_INPUT_INVALID' ? 400 : 409;
    const message = {
      IRIS_CONNECTION_AUTH_REQUIRED: '连接凭据无效或已撤销，请由所有者核对并重新导出配置',
      IRIS_CONNECTION_CAPABILITY_DENIED: '所选功能、工具或权限未开放，请核对已保存授权和服务开关',
      IRIS_CONNECTION_INPUT_INVALID: '连接请求无效，请核对功能、权限与配置格式；预设或模板不能与手动格式混用',
      IRIS_CONNECTION_CONFIG_CHANGED: '连接或模板配置已变化，请刷新后核对原记录',
      IRIS_CONNECTION_REVOKED: '连接已撤销，无法继续导出或使用',
      IRIS_CONNECTION_HANDSHAKE_REQUIRED: '连接握手已失效，请重新连接原 Core 服务'
    }[error.code];
    return new LocalApiError(error.code, message || '连接身份、授权或握手状态不符合当前服务要求', status);
  }
  if (/^IRIS_EXECUTION_/.test(error?.code || '')) return new LocalApiError(error.code, '执行服务未就绪，请保留原 Operation 并在本机检查', 503);
  if (error?.code === 'IRIS_CORE_DATA_ROOT_BUSY') return new LocalApiError('IRIS_API_ROOT_BUSY', '该数据根已有活动写者，请稍后显式重试', 409);
  if (error?.code === 'IRIS_CREATION_RESULT_UNAVAILABLE') return new LocalApiError('IRIS_API_RESULT_UNAVAILABLE', '原创建结果已不可用；同 Key 不会重新创建或复活作品', 409);
  if (error?.code === 'IRIS_CREATION_KEY_CONFLICT') return new LocalApiError('IRIS_API_KEY_CONFLICT', '该 Key 已绑定其他输入', 409);
  if (error?.code === 'IRIS_CREATION_NOT_FOUND') return new LocalApiError('IRIS_API_NOT_FOUND', '该实例中没有此创建请求', 404);
  if (['IRIS_CREATION_KEY_INVALID', 'IRIS_CREATION_INPUT_INVALID', 'IRIS_GENERATION_INPUT_INVALID',
    'IRIS_IMAGE_IMPORT_INVALID', 'IRIS_IMAGE_EDIT_INPUT_INVALID', 'IRIS_FLOW_INPUT_INVALID', 'IRIS_COMFYUI_PARAMETERS_INVALID'].includes(error?.code)) {
    return new LocalApiError('IRIS_API_INPUT_INVALID', '创作输入或静态图片无效，请检查来源、模型和参数', 400);
  }
  if (error?.code === 'IRIS_CREATION_MEDIA_MISMATCH') return new LocalApiError('IRIS_API_MEDIA_UNSUPPORTED', '图片真实格式与 Content-Type 不一致', 415);
  if (/^IRIS_CREATION_/.test(error?.code || '')) return new LocalApiError('IRIS_API_RECORD_CONFLICT', '创建请求证据不一致，请在本机检查原记录', 409);
  if (['IRIS_FLOW_NOT_FOUND', 'IRIS_ARTIFACT_NOT_FOUND'].includes(error?.code)) {
    return new LocalApiError('IRIS_API_NOT_FOUND', '该实例中没有此流程或作品', 404);
  }
  if (error?.code === 'IRIS_FLOW_REVISION_CONFLICT') return new LocalApiError('IRIS_API_RUN_CHANGED', '流程已更新，请读取当前版本后重新选择', 409);
  if (error?.code === 'IRIS_FLOW_NOT_READY') return new LocalApiError('IRIS_API_RUN_NOT_READY', '请先保存任务结果；图片编辑还需完成比较', 409);
  if (error?.code === 'IRIS_FLOW_GENERATION_ROOT_REQUIRED') return new LocalApiError(error.code, '文生图需要新建 image-generation 执行根；已有根不自动迁移', 409);
  if (error?.code === 'IRIS_FLOW_AUDIO_ROOT_REQUIRED') return new LocalApiError(error.code, '音频需要新建 execution init --audio 执行根；已有根不自动迁移', 409);
  if (error?.code === 'IRIS_AUDIO_INPUT_INVALID') return new LocalApiError(error.code, '音频或创作输入无效：请核对模型、文字及WAV/MP3/OGG/FLAC容器和类型', 400);
  if (error?.code === 'IRIS_FLOW_SELECTION_INVALID') return new LocalApiError('IRIS_API_SELECTION_INVALID', '只能选择此流程的原图或生成结果', 409);
  if (/^IRIS_PROVIDER_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_CONFIG_UNAVAILABLE', '模型配置不可用，请在本机检查显式配置', 500);
  }
  if (error?.code === 'IRIS_APP_CLOSED' || error?.name === 'AbortError' || /^IRIS_CORE_DATA_ROOT_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_UNAVAILABLE', '服务正在关闭或数据根不可用', 503);
  }
  if (/^IRIS_(?:FLOW|ARTIFACT|TASK|OPERATION)_/.test(error?.code || '')) {
    return new LocalApiError('IRIS_API_RECORD_CONFLICT', '流程、作品或操作记录不一致，请在本机核对原记录', 409);
  }
  return new LocalApiError('IRIS_API_INTERNAL', '操作失败，请使用关联 ID 核对本机诊断', 500);
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
    let cleanupRequest = () => {};
    const finish = () => { cleanupRequest(); response.off('finish', finish); response.off('close', finish); resolve(); };
    response.once('finish', finish); response.once('close', finish);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer', ...headers });
    if (status >= 400 && !request.complete && !request.destroyed) {
      // Deliver the complete error before closing an upload with unread bytes. Closing immediately
      // can reset the socket on Windows before the client receives the response. Discard the rest
      // without buffering; the server's request/idle timeouts and dispose still bound the connection.
      const end = () => { cleanupRequest(); response.end(); };
      cleanupRequest = () => { request.off('end', end); request.off('close', end); };
      request.once('end', end); request.once('close', end);
      if (request.method === 'HEAD') response.flushHeaders();
      else response.write(bytes);
      request.resume();
    } else response.end(request.method === 'HEAD' ? undefined : bytes);
  });
}
const json = (request, response, value, status = 200) => send(request, response, status, Buffer.from(JSON.stringify(value)));

/** Internal Host, read-only by default. Construction performs no I/O and never binds a port. */
export function createLocalReadApi({ dataRoot, providerConfigPath, allowLocalWrites = false, serveWorkbench = false,
  allowExecution = false, allowSelection = false, allowMcp = false, connectionsFile, executionPorts, allowConnectionManagement = false, connectionStore, providerRegistry, pluginRegistry,
  allowProviderManagement = false, panelManifestPath, panelContributions, allowedOperations, workbenchAuth } = {}) {
  if (typeof allowExecution !== 'boolean') throw new TypeError('allowExecution 必须是布尔值');
  if (typeof allowSelection !== 'boolean') throw new TypeError('allowSelection 必须是布尔值');
  if (typeof allowMcp !== 'boolean') throw new TypeError('allowMcp 必须是布尔值');
  if (typeof allowConnectionManagement !== 'boolean') throw new TypeError('allowConnectionManagement 必须是布尔值');
  if (allowConnectionManagement !== Boolean(connectionStore)) fail('IRIS_API_CONFIG_INVALID', '连接管理须显式开启并指定专用目录');
  if (allowMcp && !connectionsFile && !connectionStore) fail('IRIS_API_CONFIG_INVALID', 'MCP HTTP 需要明确的连接授权文件或管理目录');
  if (allowExecution) allowLocalWrites = true;
  if (typeof allowLocalWrites !== 'boolean') throw new TypeError('allowLocalWrites 必须是布尔值');
  if (typeof serveWorkbench !== 'boolean') throw new TypeError('serveWorkbench 必须是布尔值');
  if (workbenchAuth !== undefined && (!serveWorkbench || !workbenchAuth || Object.keys(workbenchAuth).join(',') !== 'directory'
      || typeof workbenchAuth.directory !== 'string' || !path.isAbsolute(workbenchAuth.directory))) {
    fail('IRIS_API_CONFIG_INVALID', '工作台口令认证只接受明确的私有 directory，且仅用于 web serve');
  }
  if (typeof allowProviderManagement !== 'boolean') throw new TypeError('allowProviderManagement 必须是布尔值');
  if (pluginRegistry && providerRegistry && providerRegistry !== pluginRegistry.providers) fail('IRIS_API_CONFIG_INVALID', '插件与 Provider 注册器须来自同一装配实例');
  const suppliedRegistry = pluginRegistry?.providers ?? providerRegistry;
  const capabilityCatalog = createCoreCapabilityCatalog({ registry: pluginRegistry });
  const pluginExecution = allowedOperations !== undefined;
  const selectedOperations = pluginExecution ? capabilityCatalog.selectOperations(allowedOperations) : [];
  const allowedPluginIds = Object.freeze(selectedOperations.map(item => item.id));
  if (allowProviderManagement && !providerConfigPath) fail('IRIS_API_CONFIG_INVALID', '供应商管理需要显式 Provider 配置');
  if (panelManifestPath !== undefined && (!serveWorkbench || typeof panelManifestPath !== 'string' || !path.isAbsolute(panelManifestPath))) fail('IRIS_API_CONFIG_INVALID', '替代 Panel 只用于工作台，须指定绝对清单路径');
  if (panelContributions !== undefined && (!serveWorkbench || panelManifestPath !== undefined)) fail('IRIS_API_CONFIG_INVALID', '组合贡献用于默认工作台；请在组合挂载与整套 Panel 替换之间明确选择');
  const suppliedRoot = normalizeCoreOptions({ dataRoot, mode: 'reader' }).dataRoot;
  if (providerConfigPath !== undefined && (typeof providerConfigPath !== 'string' || !path.isAbsolute(providerConfigPath))) {
    throw new LocalApiError('IRIS_API_CONFIG_INVALID', 'Provider 配置必须是显式绝对路径');
  }
  if (allowExecution && !providerConfigPath && !executionPorts) fail('IRIS_API_CONFIG_INVALID', '执行模式需要显式 Provider 配置');
  if (connectionsFile !== undefined && (typeof connectionsFile !== 'string' || !path.isAbsolute(connectionsFile))) fail('IRIS_API_CONFIG_INVALID', '连接授权须为显式根外文件');
  let state = 'new', origin = null, tokenDigest = null, application, server, physicalRoot;
  let browserAuth;
  let providerMonitor;
  let runner, runnerStarted = false, connections, mcp, managed, imageGenerationEnabled = false, audioEnabled = false;
  let registry = suppliedRegistry, panel = DEFAULT_PANEL, pluginPanel, providerManagementBusy = false;
  const capabilityFacts = () => capabilityCatalog.snapshot({ audioEnabled, panelContributions: pluginPanel?.selection, allowedOperations: allowedPluginIds });
  const changedAuthorizations = new Set();
  let loginTicket = null;
  const browserSessions = new Set();
  let startPromise, disposal, closeRequested = false, cleanupFailed = false, activeReads = 0, activeUploads = 0, localWrites = 0;
  const jobs = new Set(), instanceId = crypto.randomUUID();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const snapshot = () => Object.freeze({ contractVersion: 0, state, origin, readOnly: !allowLocalWrites && !allowSelection, activeReads,
    ...(cleanupFailed ? { cleanupFailed: true } : {}),
    ...(allowMcp ? { mcpEndpoint: origin && origin + '/mcp' } : {}),
    ...(allowExecution || pluginExecution ? { executionEnabled: runner?.snapshot().executionEnabled === true } : {}) });
  const availableScopes = ['read', ...(allowLocalWrites ? ['create'] : []), ...(allowExecution || pluginExecution ? ['execute', 'stop'] : [])];
  // Sharing the execute scope with plugin businesses must not enable the read-only media runner.
  const availableTools = () => {
    const facts = capabilityFacts();
    return [...facts.tools, ...facts.pluginTools].filter(tool => tool.scope !== 'execute'
      || (tool.name === 'iris_core_plugin_call' ? pluginExecution : !pluginExecution || allowExecution)).map(tool => tool.name);
  };
  const availableCapabilities = () => capabilityCatalog.snapshot({ audioEnabled }).groups;

  function issueLoginLink() {
    const ticket = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    loginTicket = { digest: digest(ticket), expiresAt };
    return { loginUrl: origin + '/#login=' + ticket, loginExpiresAt: new Date(expiresAt).toISOString() };
  }

  function redeemLoginLink(ticket) {
    if (!loginTicket || Date.now() >= loginTicket.expiresAt || !crypto.timingSafeEqual(digest(ticket), loginTicket.digest)) {
      fail('IRIS_WEB_LOGIN_EXPIRED', '登录链接已失效或已使用，请从启动终端获取新链接，或展开备用登录', 401);
    }
    if (browserSessions.size >= 32) fail('IRIS_WEB_LOGIN_LIMIT', '本次服务的浏览器登录已达上限，请使用备用 Token 登录', 429);
    // Consume synchronously, before any response I/O; concurrent redemption can succeed only once.
    loginTicket = null;
    const accessToken = crypto.randomBytes(32).toString('base64url');
    browserSessions.add(digest(accessToken).toString('hex'));
    return { accessToken };
  }

  function authorizeOrigin(request, documentNavigation = false) {
    const headers = request.headers;
    if (headerCount(request, 'host') !== 1 || headers.host !== new URL(origin).host) {
      fail('IRIS_API_HOST_DENIED', '请求地址不可信，请使用启动时给出的本机地址', 403);
    }
    if (headerCount(request, 'origin') > 1 || (headers.origin !== undefined && headers.origin !== origin)
        || (headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(headers['sec-fetch-site'])
          && !(documentNavigation && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document'))) {
      fail('IRIS_API_ORIGIN_DENIED', '请求来源不可信', 403);
    }
  }

  function authorize(request) {
    authorizeOrigin(request);
    const headers = request.headers;
    const match = headerCount(request, 'authorization') === 1 && /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(headers.authorization || '');
    if (match && headerCount(request, 'iris-connection-id') === 1 && connections) {
      return { connectionId: connections.identify(headers['iris-connection-id'], match[1]), runtimeInstanceId: headers['iris-runtime-id'] };
    }
    if (!match || !crypto.timingSafeEqual(digest(match[1]), tokenDigest) && !browserSessions.has(digest(match[1]).toString('hex')) && !browserAuth?.authenticate(match[1])) {
      fail('IRIS_API_AUTH_REQUIRED', browserAuth ? '请用访问口令重新登录工作台' : '需要有效的本机会话 Token', 401);
    }
    if (headers['iris-connection-id'] !== undefined || headers['iris-runtime-id'] !== undefined) fail('IRIS_API_AUTH_REQUIRED', '连接头字段无效', 401);
    return { owner: true };
  }
  function scope(caller, required, tool) {
    if (!availableScopes.includes(required)) fail('IRIS_API_READ_ONLY', '此服务没有开启该操作', 405);
    return caller.owner ? availableScopes : connections.authorize(caller.connectionId, caller.runtimeInstanceId, required, tool);
  }
  async function requireFlowCapability(caller, runId) {
    if (caller.owner) return;
    const run = await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => readFlowRun(dataRoot, runId)));
    if (!allowsRun(caller, run)) {
      fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此连接未选择原流程所需的媒体能力', 403);
    }
  }
  function requirePluginChoice(caller, dependency) {
    if (!caller.owner && !hasPluginSelection(connections.selection(caller.connectionId, caller.runtimeInstanceId).pluginOperations || [], dependency)) {
      fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此连接没有选择该业务及准确版本', 403);
    }
  }
  async function requireOperationCapability(caller, operation) {
    if (operation.action === 'plugin.execute') return requirePluginChoice(caller, operation.dependency);
    return requireFlowCapability(caller, operation.runId);
  }
  function allowsRun(caller, run) {
    return caller.owner || CORE_CAPABILITY_GROUPS.some(group => group.recipe === run.recipe
      && connections.selection(caller.connectionId, caller.runtimeInstanceId).capabilities.includes(group.id));
  }
  async function requireArtifactCapability(caller, artifactId) {
    if (caller.owner) return;
    const metadata = await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => inspectCoreArtifactMetadata(dataRoot, artifactId)));
    const selection = connections.selection(caller.connectionId, caller.runtimeInstanceId);
    if (isPluginSourceImage(metadata) && (selection.pluginOperations || []).some(pin => selectedOperations.some(item => hasPluginSelection([pin], item.dependency) && item.artifactInputs?.length))) return;
    if (metadata.metadata?.pluginOperationId) {
      const record = await application.execute('operation.inspect', { id: metadata.metadata.pluginOperationId });
      requirePluginChoice(caller, record.operation.dependency); return;
    }
    const references = await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => listFlowRuns(dataRoot)))
      .then(runs => runs.filter(run => [run.source, run.output, run.comparison, run.selection].some(ref => ref?.artifactId === artifactId)));
    if (references.length) {
      if (references.some(run => allowsRun(caller, run))) return;
      fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此作品所属流程的媒体能力未被选择', 403);
    }
    // Delivery can commit a Task artifact before the Run's output checkpoint is saved.
    if (metadata.metadata?.taskId) {
      const task = await application.execute('task.inspect', { task_id: metadata.metadata.taskId });
      if (task.task.flowBinding) { await requireFlowCapability(caller, task.task.flowBinding.runId); return; }
    }
    // Unbound imports use the existing media/tool grant. Plugin control tools
    // alone only grant the declared eligible source images handled above.
    if (CORE_CAPABILITY_GROUPS.some(group => selection.capabilities.includes(group.id)
        && (metadata.mediaType.startsWith('image/') ? group.media === 'image'
          : metadata.mediaType.startsWith('audio/') ? group.requiresAudio
            : metadata.mediaType === 'text/plain' && group.media === 'transcribe'))) return;
    fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此连接没有选择该作品的媒体功能或图片来源用途', 403);
  }

  async function smallJson(request, limit = 8192) {
    if (headerCount(request, 'content-type') !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'])
        || request.headers['content-encoding'] !== undefined) fail('IRIS_API_INPUT_INVALID', '需要 UTF-8 JSON 正文');
    if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > limit) fail('IRIS_API_INPUT_TOO_LARGE', '正文过大', 413);
    const chunks = []; let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length; if (size > limit) fail('IRIS_API_INPUT_TOO_LARGE', '正文过大', 413); chunks.push(chunk);
    }
    if (Object.keys(request.trailers).length || state !== 'open') fail('IRIS_API_INPUT_INVALID', '请求已失效');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch (_) { fail('IRIS_API_INPUT_INVALID', '需要有效 JSON'); }
  }

  async function specialPost(request, response, url, caller) {
    query(url);
    if (url.pathname === '/api/v0/plugin-operations' && pluginExecution) {
      scope(caller, 'execute', 'iris_core_plugin_call');
      if (headerCount(request, 'idempotency-key') !== 1 || !KEY.test(request.headers['idempotency-key'] || '')) fail('IRIS_API_INPUT_INVALID', '需要稳定 UUIDv4 Key');
      const value = await smallJson(request, 65536);
      if (!value || Object.keys(value).sort().join(',') !== 'dependency,input,operationId') fail('IRIS_API_INPUT_INVALID', '需要准确业务、依赖和输入');
      const pin = checkedPluginSelection([value.dependency])[0];
      requirePluginChoice(caller, pin);
      if (pin.contributionId !== value.operationId) fail('IRIS_API_INPUT_INVALID', '业务与依赖不一致');
      const authorize = () => {
        if (!allowedPluginIds.includes(value.operationId)) fail('IRIS_PLUGIN_OPERATION_DENIED', '此业务未被服务明确启用', 403);
        if (!caller.owner) connections.authorizePlugin(caller.connectionId, pin);
      };
      return json(request, response, await runner.submit({ ...value, key: request.headers['idempotency-key'] }, { authorize }), 202);
    }
    if (url.pathname.startsWith('/api/v0/connection-management')) return manage(request, response, url, caller);
    if (url.pathname.startsWith('/api/v0/provider-management')) return manageProviders(request, response, url, caller);
    const selecting = /^\/api\/v0\/runs\/([^/]+)\/selection$/.exec(url.pathname);
    if (selecting) return selectRun(request, response, selecting[1], caller);
    const connection = /^\/api\/v0\/connections\/([a-f0-9-]{36})\/(handshake|disconnect|client-info)$/.exec(url.pathname);
    if (connection && connections) {
      const value = await smallJson(request);
      if (caller.owner && connection[2] === 'disconnect') {
        if (!value || Object.keys(value).length !== 1 || typeof value.runtimeInstanceId !== 'string') fail('IRIS_API_INPUT_INVALID', '需要明确断开的 runtimeInstanceId');
        return json(request, response, connections.disconnect(connection[1], value.runtimeInstanceId));
      }
      if (caller.owner || caller.connectionId !== connection[1] || headerCount(request, 'iris-runtime-id') !== 1) fail('IRIS_API_AUTH_REQUIRED', '连接身份不一致', 401);
      if (connection[2] === 'handshake') {
        if (value?.runtimeInstanceId !== caller.runtimeInstanceId) fail('IRIS_API_INPUT_INVALID', '实例头字段与握手不一致');
        return json(request, response, connections.handshake(caller.connectionId, value));
      }
      if (connection[2] === 'client-info') return json(request, response, connections.clientInfo(caller.connectionId, caller.runtimeInstanceId, value));
      if (!value || Array.isArray(value) || Object.keys(value).length) fail('IRIS_API_INPUT_INVALID', '断开操作只接受空对象');
      return json(request, response, connections.disconnect(caller.connectionId, caller.runtimeInstanceId));
    }
    const continuing = /^\/api\/v0\/runs\/(run_[a-f0-9]{24})\/continue$/.exec(url.pathname);
    const stopping = /^\/api\/v0\/operations\/(op_[a-f0-9]{64})\/cancel$/.exec(url.pathname);
    if ((allowExecution && continuing) || (allowExecution || pluginExecution) && stopping) {
      scope(caller, continuing ? 'execute' : 'stop', continuing ? 'iris_core_continue' : 'iris_core_stop');
      const value = await smallJson(request);
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || (continuing ? Object.keys(value).length !== 1 || !Object.hasOwn(value, 'expectedRevision')
            : Object.keys(value).length)) fail('IRIS_API_INPUT_INVALID', '操作正文包含不支持的字段');
      if (stopping) {
        const original = await application.execute('operation.inspect', { id: stopping[1] });
        await requireOperationCapability(caller, original.operation);
        return json(request, response, await runner.stop(stopping[1]));
      }
      if (headerCount(request, 'idempotency-key') !== 1 || !KEY.test(request.headers['idempotency-key'] || '')) fail('IRIS_API_INPUT_INVALID', '需要单个小写 UUIDv4 Key');
      await requireFlowCapability(caller, continuing[1]);
      const result = await runner.submit({ key: request.headers['idempotency-key'], runId: continuing[1], expectedRunRevision: value.expectedRevision });
      return json(request, response, result, result.idempotentReplay ? 200 : 202);
    }
    scope(caller, 'create', ({ '/api/v0/images': 'iris_core_import_image', '/api/v0/runs': 'iris_core_create_run',
      '/api/v0/generations': 'iris_core_create_generation', '/api/v0/audio': 'iris_core_import_audio',
      '/api/v0/speeches': 'iris_core_create_speech', '/api/v0/transcriptions': 'iris_core_create_transcription' })[url.pathname]);
    return create(request, response, url);
  }

  async function selectRun(request, response, runId, caller) {
    if (!caller.owner) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只有工作台所有者可以选择作品', 403);
    if (!allowSelection) fail('IRIS_API_READ_ONLY', '此服务没有开启作品选择', 405);
    if (!RUN.test(runId)) fail('IRIS_API_INPUT_INVALID', '流程 ID 无效');
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnect);
    try {
      const value = await smallJson(request);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
          || typeof value.artifactId !== 'string' || !ARTIFACT.test(value.artifactId)
          || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) {
        fail('IRIS_API_INPUT_INVALID', '选择需要作品 ID 与正整数 expectedRevision');
      }
      if (response.destroyed) controller.abort();
      controller.signal.throwIfAborted();
      const writes = application.snapshot(), execution = runner?.snapshot();
      if (writes.activeWrites || writes.queuedWrites || execution?.active || execution?.queued) {
        fail('IRIS_API_ROOT_BUSY', '当前有活动写入，请读取状态后明确重试选择', 409);
      }
      const facts = await application.execute('flow.select', { run_id: runId, artifact_id: value.artifactId,
        expected_revision: value.expectedRevision }, { signal: controller.signal });
      return await json(request, response, projectLocalApiFlow(facts));
    } catch (error) {
      if (error?.code === 'ECONNRESET' && request.aborted) { controller.abort(); controller.signal.throwIfAborted(); }
      throw error;
    } finally { response.off('close', disconnect); }
  }

  function managementFacts() {
    const runtime = connections.list().connections, stored = managed.list(), ids = new Set(stored.map(item => item.connectionId));
    return { contractVersion: 0, connections: [
      ...stored.map(item => ({ ...item, instances: runtime.find(value => value.connectionId === item.connectionId)?.instances || [] })),
      ...runtime.filter(item => !ids.has(item.connectionId)).map(item => ({ ...item, managed: false, state: 'configured' }))
    ] };
  }
  async function manageProviders(request, response, url, caller) {
    if (!caller.owner) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只有工作台所有者可以管理供应商', 403);
    if (!allowProviderManagement) fail('IRIS_API_READ_ONLY', '此服务未开启供应商管理', 405);
    query(url);
    if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/api/v0/provider-management/settings') {
      return json(request, response, await executeConfigCommand(providerConfigPath, 'settings.show', {}, { registry }));
    }
    const monitor = () => providerMonitor ||= createProviderMonitor({ configPath: providerConfigPath, registry });
    if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/api/v0/provider-management/diagnostics') {
      const settings = await executeConfigCommand(providerConfigPath, 'settings.show', {}, { registry });
      return json(request, response, { ...projectProviderDiagnostics(loadProviderCatalog(providerConfigPath), registry), revision: settings.revision,
        monitors: monitor().snapshot(), execution: allowExecution, imageGeneration: imageGenerationEnabled, audio: audioEnabled });
    }
    const command = { '/api/v0/provider-management/save': 'settings.save', '/api/v0/provider-management/discover': 'settings.discover',
      '/api/v0/provider-management/policies': 'settings.policies', '/api/v0/provider-management/enabled': 'settings.enabled',
      '/api/v0/provider-management/remove': 'settings.remove', '/api/v0/provider-management/impact': 'impact',
      '/api/v0/provider-management/check': 'check', '/api/v0/provider-management/monitor': 'monitor',
      '/api/v0/provider-management/workflow-check': 'settings.workflow-check' }[url.pathname];
    if (request.method !== 'POST' || !command) fail('IRIS_API_NOT_FOUND', '没有此供应商管理操作', 404);
    if (providerManagementBusy) fail('IRIS_API_BUSY', '供应商设置正在处理，请等待完成后再操作', 429);
    providerManagementBusy = true;
    const controller = new AbortController(), aborted = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', aborted);
    try {
      const value = await smallJson(request, 64 * 1024);
      controller.signal.throwIfAborted();
      if (['impact', 'check', 'monitor'].includes(command)) {
        const fields = command === 'monitor' ? ['expectedRevision', 'providerId', 'enabled', 'intervalSeconds'] : ['expectedRevision', 'providerId'];
        if (!value || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail('IRIS_API_INPUT_INVALID', '供应商操作字段无效');
        const settings = await executeConfigCommand(providerConfigPath, 'settings.show', {}, { registry });
        if (value.expectedRevision !== settings.revision) fail('IRIS_CONFIG_CHANGED', '配置已变化，请重新读取后操作', 409);
        if (!settings.providers.some(provider => provider.id === value.providerId)) fail('IRIS_API_INPUT_INVALID', '供应商不存在');
        if (command === 'check') return json(request, response, await monitor().check(value.providerId, value.expectedRevision, { signal: controller.signal }));
        if (command === 'monitor') return json(request, response, monitor().configure(value));
        const dependencies = await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => providerDependencies(dataRoot, value.providerId)), { signal: controller.signal });
        return json(request, response, { contractVersion: 0, revision: settings.revision, providerId: value.providerId,
          ...providerRemovalImpact(loadProviderCatalog(providerConfigPath), value.providerId), ...dependencies });
      }
      if (command === 'settings.remove') {
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'confirm,expectedRevision,providerId'
            || typeof value.providerId !== 'string' || !value.providerId || value.confirm !== true) fail('IRIS_API_INPUT_INVALID', '删除需要明确供应商、修订和确认');
        const result = await application.run('writer', runtime => runtime.run('execute', async ({ dataRoot }) => {
          const dependencies = providerDependencies(dataRoot, value.providerId);
          if (dependencies.blockingTasks.length || dependencies.blockingRuns.length) fail('IRIS_PROVIDER_REFERENCED', '当前工作区仍有未完成或可恢复流程依赖此供应商，请先处理原任务', 409);
          return executeConfigCommand(providerConfigPath, command, value, { registry, signal: controller.signal });
        }), { signal: controller.signal });
        providerMonitor?.snapshot(); return json(request, response, result);
      }
      const result = await executeConfigCommand(providerConfigPath, command, value, { registry, signal: controller.signal });
      if (command === 'settings.enabled' || command === 'settings.save') providerMonitor?.snapshot();
      return await json(request, response, result);
    } catch (error) {
      if (command === 'settings.workflow-check') {
        controller.signal.throwIfAborted();
        if (error instanceof ProviderContractError) fail('IRIS_COMFYUI_CHECK_UNAVAILABLE', '只读检查未完成，请核对 ComfyUI 服务、地址和认证；未提交生成', error.category === 'timeout' ? 504 : 502);
      }
      throw error;
    } finally { response.off('close', aborted); providerManagementBusy = false; }
  }
  async function manage(request, response, url, caller) {
    if (!caller.owner) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只有工作台所有者可以管理连接', 403);
    if (!allowConnectionManagement) fail('IRIS_API_READ_ONLY', '此服务未开启连接管理', 405);
    query(url);
    if (['GET', 'HEAD'].includes(request.method)) {
      if (url.pathname === '/api/v0/connection-management/connections') return json(request, response, managementFacts());
      if (url.pathname === '/api/v0/connection-management/templates') return json(request, response, { contractVersion: 0, templates: managed.listTemplates(), presets: MCP_CONNECTION_PRESETS, formats: MCP_CONFIG_FORMATS });
      if (url.pathname === '/api/v0/connection-management/catalog') return json(request, response, { contractVersion: 0, availableScopes, availableTools: availableTools(),
        httpEnabled: allowMcp, templateExample: CONNECTION_TEMPLATE_EXAMPLE,
        ...capabilityFacts(), defaults: { capabilities: DEFAULT_BRIDGE_CAPABILITIES } });
      fail('IRIS_API_NOT_FOUND', '没有此连接管理接口', 404);
    }
    const value = await smallJson(request);
    if (value?.capabilities !== undefined && checkedBridgeCapabilities(value.capabilities).some(id => !availableCapabilities().some(group => group.id === id))) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此工作区尚未开启所选媒体功能', 403);
    if (value?.pluginOperations !== undefined) {
      const pins = checkedPluginSelection(value.pluginOperations);
      const updating = /^\/api\/v0\/connection-management\/connections\/([a-f0-9-]{36})\/update$/.exec(url.pathname);
      const retained = updating ? managed.list().find(item => item.connectionId === updating[1])?.pluginOperations || [] : [];
      if (pins.some(pin => !hasPluginSelection(selectedOperations.map(item => item.dependency), pin) && !hasPluginSelection(retained, pin))) {
        fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只能选择此服务已启用的准确业务版本；旧连接可保留原依赖以读取历史记录', 403);
      }
    }
    if (url.pathname === '/api/v0/connection-management/templates') {
      const result = managed.importTemplate(value);
      return json(request, response, { contractVersion: 0, ...result }, result.idempotentReplay ? 200 : 201);
    }
    if (url.pathname === '/api/v0/connection-management/connections') {
      if (!Array.isArray(value?.scopes) || value.scopes.some(scope => !availableScopes.includes(scope))) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '选择了当前服务未开启的操作权限', 403);
      const result = managed.create(value);
      // A brand-new grant has no cached bridge to invalidate on its first later rename.
      changedAuthorizations.delete(result.connectionId);
      return json(request, response, { contractVersion: 0, ...result }, result.idempotentReplay ? 200 : 201);
    }
    const action = /^\/api\/v0\/connection-management\/connections\/([a-f0-9-]{36})\/(update|revoke|delete|export|skill)$/.exec(url.pathname);
    if (!action) fail('IRIS_API_NOT_FOUND', '没有此连接管理操作', 404);
    const [, id, verb] = action;
    if (verb === 'export') {
      if (managed.resolveExport(value).transport === 'http' && !allowMcp) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '此服务未开启 HTTP MCP', 403);
      return json(request, response, { contractVersion: 0, ...managed.exportConfig(id, value) });
    }
    if (verb === 'skill') return json(request, response, { contractVersion: 0, ...managed.exportSkill(id, value) });
    if (verb === 'update' && (!Array.isArray(value?.scopes) || value.scopes.some(scope => !availableScopes.includes(scope)))) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '选择了当前服务未开启的操作权限', 403);
    let result;
    try { result = verb === 'update' ? managed.update(id, value) : verb === 'delete' ? managed.remove(id, value) : managed.revoke(id, value); }
    finally { if (changedAuthorizations.delete(id)) await mcp?.invalidateConnection(id); }
    return json(request, response, { contractVersion: 0, ...result });
  }

  async function image(artifactId, kind = 'image') {
    // Use an operation-owned reader, with no writer lease or local export path.
    const reader = createCoreRuntime({ dataRoot: physicalRoot, mode: 'reader' });
    try {
      reader.start();
      return await reader.run('inspect', ({ dataRoot: physicalRoot }) => {
        const metadata = inspectCoreArtifactMetadata(physicalRoot, artifactId);
        if (!(kind === 'image' ? IMAGE_TYPES.has(metadata.mediaType) : kind === 'audio' ? AUDIO_MEDIA_TYPES.has(metadata.mediaType) : metadata.mediaType === 'text/plain')) {
          fail('IRIS_API_MEDIA_UNSUPPORTED', '此入口不支持该作品类型', 415);
        }
        if (metadata.size > (kind === 'text' ? 1024 * 1024 : MAX_LOCAL_API_IMAGE_BYTES)) fail('IRIS_API_MEDIA_TOO_LARGE', '作品超过此读取入口的大小上限', 413);
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
    try { candidates = imageCandidatesFromCatalog(catalog, '', registry); }
    catch (error) {
      if (error.code === 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID') {
        return { contractVersion: 0, configured: true, models: [], total: 0, gap: 'protocol_unavailable' };
      }
      if (error.code !== 'IRIS_PROVIDER_MODEL_UNAVAILABLE') throw error;
      candidates = [];
    }
    const entries = candidates.map(route => ({ modelRef: route.modelRef, displayName: route.model,
      ...(route.provider.mediaProtocol === 'comfyui' ? { comfyWorkflow: projectComfyWorkflow(route.provider.comfyWorkflow) } : {}),
      supportsImageEdit: supportsImageEdit(route.provider.mediaProtocol, route.model, registry) }));
    return { contractVersion: 0, configured: true, models: entries, total: entries.length };
  }

  function audioModels(caller) {
    if (!providerConfigPath) return { contractVersion: 0, configured: false, models: [], total: 0 };
    const catalog = loadProviderCatalog(providerConfigPath), entries = [];
    const capabilities = caller.owner ? ['tts', 'transcribe'] : connections.selection(caller.connectionId, caller.runtimeInstanceId).capabilities;
    for (const [capability, select] of [['tts', ttsCandidatesFromCatalog], ['transcribe', transcribeCandidatesFromCatalog]]) {
      if (!capabilities.includes(capability)) continue;
      let candidates;
      try { candidates = select(catalog, '', registry); }
      catch (error) { if (error.code !== 'IRIS_PROVIDER_MODEL_UNAVAILABLE') throw error; candidates = []; }
      entries.push(...candidates.map(route => ({ capability, modelRef: route.modelRef, displayName: route.model })));
    }
    return { contractVersion: 0, configured: true, models: entries, total: entries.length };
  }

  async function create(request, response, url) {
    query(url);
    if (!['/api/v0/images', '/api/v0/runs', '/api/v0/generations', '/api/v0/audio', '/api/v0/speeches', '/api/v0/transcriptions'].includes(url.pathname)) fail('IRIS_API_NOT_FOUND', '没有此本地创建接口', 404);
    const isImage = url.pathname === '/api/v0/images', isAudio = url.pathname === '/api/v0/audio', upload = isImage || isAudio;
    if (!audioEnabled && ['/api/v0/audio', '/api/v0/speeches', '/api/v0/transcriptions'].includes(url.pathname)) fail('IRIS_FLOW_AUDIO_ROOT_REQUIRED', '请使用新的音频执行根；原根不迁移', 409);
    if (headerCount(request, 'idempotency-key') !== 1 || !KEY.test(request.headers['idempotency-key'] || '')) {
      fail('IRIS_API_INPUT_INVALID', 'Idempotency-Key 须为单个小写 UUIDv4');
    }
    if (headerCount(request, 'content-type') !== 1 || request.headers['content-encoding'] !== undefined) {
      fail('IRIS_API_INPUT_INVALID', '正文需要单个 Content-Type，且不接受 Content-Encoding');
    }
    const mediaType = request.headers['content-type'];
    if (upload ? !(isImage ? IMAGE_TYPES : AUDIO_MEDIA_TYPES).has(mediaType) : !/^application\/json(?:;\s*charset=utf-8)?$/i.test(mediaType)) {
      fail('IRIS_API_MEDIA_UNSUPPORTED', isAudio ? '请提供WAV/MP3/OGG/FLAC原字节与匹配的Content-Type' : '请提供静态 PNG/JPEG/WebP 原字节或 UTF-8 JSON', 415);
    }
    const limit = isAudio ? MAX_AUDIO_INPUT_BYTES : isImage ? MAX_IMPORT_IMAGE_BYTES : 64 * 1024;
    if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > limit) {
      fail('IRIS_API_INPUT_TOO_LARGE', '正文超过允许的大小', 413);
    }
    if (upload && activeUploads >= 1 || localWrites >= 9) fail('IRIS_API_BUSY', '本地创建繁忙，请使用原 Key 稍后重试', 429);
    if (upload) activeUploads++;
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
      if (!upload) {
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch (_) { fail('IRIS_API_INPUT_INVALID', '需要有效的 UTF-8 JSON'); }
      }
      const command = { '/api/v0/images': 'creation.image', '/api/v0/audio': 'creation.audio', '/api/v0/runs': 'creation.flow',
        '/api/v0/generations': 'creation.generate', '/api/v0/speeches': 'creation.speech', '/api/v0/transcriptions': 'creation.transcribe' }[url.pathname];
      const result = await application.execute(command, {
        key: request.headers['idempotency-key'], ...(upload ? { bytes, mediaType } : { value })
      }, { signal: controller.signal, onPrepared: () => { prepared = true; } });
      const body = { contractVersion: 0, idempotentReplay: result.idempotentReplay,
        ...(upload ? { artifact: { artifactId: result.artifact.id, mediaType: result.artifact.mediaType,
          size: result.artifact.size, ...(isImage ? { width: result.artifact.metadata.width, height: result.artifact.metadata.height } : {}) } }
          : { flow: projectLocalApiFlow(result.flow) }) };
      return await json(request, response, body, result.idempotentReplay ? 200 : 201);
    } catch (error) {
      if (request.aborted && !prepared) fail('IRIS_API_REQUEST_INTERRUPTED', '上传连接已中断，未接受本次创建');
      throw error;
    } finally {
      response.off('close', disconnect); localWrites--;
      if (upload) activeUploads--;
    }
  }

  async function route(request, response) {
    if (state !== 'open') fail('IRIS_API_UNAVAILABLE', '服务正在关闭', 503);
    const passwordPath = browserAuth && /^\/api\/v0\/workbench\/(auth|setup|password-login|logout|setup-link|password-reset)$/.exec(request.url.split('?')[0]);
    if (passwordPath) {
      authorizeOrigin(request); query(new URL(request.url, origin));
      const action = passwordPath[1];
      if (action === 'auth') {
        if (!['GET', 'HEAD'].includes(request.method)) throw Object.assign(new LocalApiError('IRIS_API_METHOD_DENIED', '登录状态仅支持 GET/HEAD', 405), { allow: 'GET, HEAD' });
        if (request.headers['transfer-encoding'] !== undefined || request.headers['content-length'] && request.headers['content-length'] !== '0') fail('IRIS_API_INPUT_INVALID', '登录状态请求不接受正文');
        return json(request, response, { contractVersion: 0, ...browserAuth.info() });
      }
      if (request.method !== 'POST') fail('IRIS_API_METHOD_DENIED', '登录操作仅支持 POST', 405);
      const control = ['setup-link', 'password-reset'].includes(action);
      if (control) {
        const match = headerCount(request, 'authorization') === 1 && /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization || '');
        if (!match || !crypto.timingSafeEqual(digest(match[1]), tokenDigest)
            || request.headers['iris-connection-id'] !== undefined || request.headers['iris-runtime-id'] !== undefined) {
          fail('IRIS_API_AUTH_REQUIRED', '此操作需要本机工作台控制权限，请通过 CLI 执行', 401);
        }
      } else if (request.headers.origin !== origin) fail('IRIS_API_ORIGIN_DENIED', '请在当前工作台页面登录或退出', 403);
      const value = await smallJson(request, 1024);
      const keys = action === 'setup' ? ['ticket', 'password', 'remember'] : action === 'password-login' ? ['password', 'remember'] : [];
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        fail('IRIS_API_INPUT_INVALID', '登录请求字段无效');
      }
      if (action === 'setup') return json(request, response, { contractVersion: 0, ...await browserAuth.setup(value) });
      if (action === 'password-login') return json(request, response, { contractVersion: 0, ...await browserAuth.login(value) });
      if (action === 'logout') {
        const match = headerCount(request, 'authorization') === 1 && /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization || '');
        if (!match) fail('IRIS_API_AUTH_REQUIRED', '需要当前浏览器会话', 401);
        return json(request, response, { contractVersion: 0, ...browserAuth.logout(match[1]) });
      }
      if (action === 'password-reset') await browserAuth.reset();
      return json(request, response, { contractVersion: 0, setupUrl: browserAuth.setupLink(origin) });
    }
    const loginPath = serveWorkbench && /^\/api\/v0\/workbench\/(login|login-link)$/.exec(request.url.split('?')[0]);
    if (loginPath) {
      authorizeOrigin(request); query(new URL(request.url, origin));
      if (browserAuth) fail('IRIS_WEB_PASSWORD_REQUIRED', '请在工作台普通地址用访问口令登录；首次设置可运行 web login --data-root', 409);
      if (request.method !== 'POST') fail('IRIS_API_METHOD_DENIED', '登录入口仅接受 POST', 405);
      if (loginPath[1] === 'login') {
        if (request.headers.origin !== origin) fail('IRIS_API_ORIGIN_DENIED', '请在本机工作台打开登录链接', 403);
      } else if (!authorize(request).owner) fail('IRIS_API_AUTH_REQUIRED', '只有工作台所有者可以获取登录链接', 403);
      const value = await smallJson(request, 256);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== (loginPath[1] === 'login' ? 1 : 0)
          || loginPath[1] === 'login' && (typeof value.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket))) {
        fail('IRIS_API_INPUT_INVALID', '登录请求无效');
      }
      return json(request, response, { contractVersion: 0, ...(loginPath[1] === 'login' ? redeemLoginLink(value.ticket) : issueLoginLink()) });
    }
    if (allowMcp && request.url.split('?')[0] === '/mcp') {
      authorizeOrigin(request); query(new URL(request.url, origin));
      const match = headerCount(request, 'authorization') === 1 && /^Bearer +([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization || '');
      if (!match) fail('IRIS_CONNECTION_AUTH_REQUIRED', '需要有效的 MCP 连接凭据', 401);
      if (request.headers['iris-connection-id'] !== undefined || request.headers['iris-runtime-id'] !== undefined) fail('IRIS_CONNECTION_INPUT_INVALID', 'MCP 仅使用标准连接头');
      return mcp.handle(request, response, match[1]);
    }
    if (serveWorkbench && (panel.has(request.url.split('?')[0]) || pluginPanel?.has(request.url.split('?')[0]))) {
      // The shell contains no private data. API and image requests still require Bearer auth.
      authorizeOrigin(request, request.url.split('?')[0] === '/' && request.method === 'GET');
      if (!['GET', 'HEAD'].includes(request.method)) fail('IRIS_API_READ_ONLY', '页面资源仅支持 GET/HEAD', 405);
      if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
        fail('IRIS_API_INPUT_INVALID', '页面请求不接受正文');
      }
      const url = new URL(request.url, origin);
      query(url);
      const asset = panel.has(url.pathname) ? await panel.read(url.pathname) : await pluginPanel.read(url.pathname);
      if (!asset) fail('IRIS_API_UNAVAILABLE', '插件资源已关闭', 503);
      const bytes = browserAuth && url.pathname === '/' && panel.identity.id === 'iris.default-panel'
        ? Buffer.from(asset.bytes.toString('utf8').replace('data-auth="token"', 'data-auth="password"')) : asset.bytes;
      return send(request, response, 200, bytes, { 'Content-Type': asset.mediaType,
        'Content-Security-Policy': LOCAL_WEB_CSP, 'Cross-Origin-Resource-Policy': 'same-origin' });
    }
    const caller = authorize(request);
    const connectionPost = connections && /^\/api\/v0\/connections\/[a-f0-9-]{36}\/(?:handshake|disconnect|client-info)$/.test(request.url.split('?')[0]);
    const managementPost = allowConnectionManagement && request.url.split('?')[0].startsWith('/api/v0/connection-management/');
    const providerPost = allowProviderManagement && request.url.split('?')[0].startsWith('/api/v0/provider-management/');
    const pluginPost = pluginExecution && (request.url.split('?')[0] === '/api/v0/plugin-operations' || /^\/api\/v0\/operations\/op_[a-f0-9]{64}\/cancel$/.test(request.url.split('?')[0]));
    if (!['GET', 'HEAD'].includes(request.method) && !((allowLocalWrites || allowSelection || connectionPost || managementPost || providerPost || pluginPost) && request.method === 'POST')) {
      fail('IRIS_API_READ_ONLY', allowLocalWrites || allowSelection ? '仅支持 GET/HEAD 与明确开启的 POST 操作' : '当前接口仅支持只读 GET/HEAD', 405);
    }
    if (request.method !== 'POST' && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) {
      fail('IRIS_API_INPUT_INVALID', '只读请求不接受正文');
    }
    if (!request.url.startsWith('/') || request.url.startsWith('//')) fail('IRIS_API_INPUT_INVALID', '请求路径无效');
    const url = new URL(request.url, origin);
    if (url.pathname !== request.url.split('?')[0]) fail('IRIS_API_INPUT_INVALID', '请求路径无效');
    if (request.method === 'POST') return specialPost(request, response, url, caller);
    if (url.pathname.startsWith('/api/v0/connection-management')) return manage(request, response, url, caller);
    if (url.pathname.startsWith('/api/v0/provider-management')) return manageProviders(request, response, url, caller);
    const callerScopes = scope(caller, 'read');
    const matchRun = /^\/api\/v0\/runs\/([^/]+)(\/download)?$/.exec(url.pathname);
    const matchImage = /^\/api\/v0\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
    const matchAudio = audioEnabled && /^\/api\/v0\/artifacts\/([^/]+)\/(audio|text)$/.exec(url.pathname);
    const operation = (allowExecution || pluginExecution) && /^\/api\/v0\/operations\/(op_[a-f0-9]{64})$/.exec(url.pathname);
    const runOperations = allowExecution && /^\/api\/v0\/runs\/(run_[a-f0-9]{24})\/operations$/.exec(url.pathname);
    const operationLookup = (allowExecution || pluginExecution) && url.pathname === '/api/v0/operations';
    const pluginCatalog = pluginExecution && url.pathname === '/api/v0/plugin-operations/catalog';
    const pluginHistory = pluginExecution && url.pathname === '/api/v0/plugin-operations';
    const creationLookup = url.pathname === '/api/v0/creation-requests';
    if (creationLookup && !caller.owner) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只有工作台所有者可以定位原创建请求', 403);
    query(url, pluginCatalog ? ['limit', 'offset'] : pluginHistory ? ['limit', 'cursor'] : url.pathname === '/api/v0/runs' ? ['limit', 'cursor', 'selection', 'kind'] : runOperations ? ['limit', 'cursor']
      : creationLookup ? ['kind', 'key'] : operationLookup ? ['key'] : []);
    if (matchRun && !RUN.test(matchRun[1]) || matchImage && !ARTIFACT.test(matchImage[1]) || matchAudio && !ARTIFACT.test(matchAudio[1])) {
      fail('IRIS_API_INPUT_INVALID', '流程或图片 ID 格式无效');
    }
    const readTool = pluginCatalog ? 'iris_core_plugin_catalog' : pluginHistory ? 'iris_core_operation' : operation ? 'iris_core_operation' : runOperations ? 'iris_core_operation' : operationLookup ? 'iris_core_lookup'
      : matchAudio ? matchAudio[2] === 'audio' ? 'iris_core_audio' : 'iris_core_transcript'
        : matchImage ? 'iris_core_image' : matchRun ? matchRun[2] ? null : 'iris_core_run'
          : ({ '/api/v0/models': 'iris_core_models', '/api/v0/audio-models': 'iris_core_audio_models', '/api/v0/runs': 'iris_core_runs', '/api/v0/connections': 'iris_core_connections', '/api/v0/adapters': 'iris_core_connection' })[url.pathname];
    if (readTool) scope(caller, 'read', readTool);
    if (matchRun?.[2] && !caller.owner && !connections.selection(caller.connectionId, caller.runtimeInstanceId).tools
      .some(name => ['iris_core_image', 'iris_core_audio', 'iris_core_transcript'].includes(name))) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '未选择作品交付工具', 403);
    if (activeReads >= 2) fail('IRIS_API_BUSY', '读取繁忙，请稍后再试', 429);
    activeReads++;
    try {
      if (pluginCatalog) {
        const pins = caller.owner ? selectedOperations.map(item => item.dependency) : connections.selection(caller.connectionId, caller.runtimeInstanceId).pluginOperations || [];
        const limit = Number(url.searchParams.get('limit') ?? 20), offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || !Number.isSafeInteger(offset) || offset < 0) fail('IRIS_API_INPUT_INVALID', '作品分页无效');
        const catalog = capabilityFacts();
        const entries = pins.map(pin => { const found = catalog.contributions.operations.find(item => hasPluginSelection([pin], item.dependency));
          return catalog.state === 'active' && found && allowedPluginIds.includes(found.id) ? { ...found, available: true } : { id: pin.contributionId, dependency: pin, available: false }; });
        const artifacts = entries.some(item => item.available && item.artifactInputs?.length) ? await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => {
          const value = listCoreArtifacts(dataRoot, { offset, limit });
          return { ...value, nextOffset: offset + value.artifacts.length < value.total ? offset + value.artifacts.length : null,
            artifacts: value.artifacts.filter(isPluginSourceImage)
            .map(item => ({ id: item.id, mediaType: item.mediaType, size: item.size, createdAt: item.createdAt })) };
        })) : { artifacts: [], total: 0 };
        return json(request, response, { contractVersion: 0, operations: entries, ...artifacts });
      }
      if (pluginHistory) {
        const pins = caller.owner ? null : connections.selection(caller.connectionId, caller.runtimeInstanceId).pluginOperations || [];
        const limit = Number(url.searchParams.get('limit') ?? 20), cursor = url.searchParams.get('cursor');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || cursor !== null && !/^op_[a-f0-9]{64}$/.test(cursor)) fail('IRIS_API_INPUT_INVALID', '业务记录分页无效');
        const facts = await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => {
          const records = readAllOperations(dataRoot).filter(item => item.action === 'plugin.execute' && (!pins || hasPluginSelection(pins, item.dependency)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
          const offset = cursor === null ? 0 : records.findIndex(item => item.id === cursor) + 1;
          if (cursor !== null && offset === 0) fail('IRIS_API_INPUT_INVALID', '游标不属于此连接的业务记录');
          const page = records.slice(offset, offset + limit);
          return { operations: page.map(projectOperation), total: records.length, nextCursor: offset + page.length < records.length ? page.at(-1).id : null };
        }));
        return json(request, response, { contractVersion: 0, ...facts });
      }
      if (url.pathname === '/api/v0/capabilities') {
        if (!caller.owner) fail('IRIS_CONNECTION_CAPABILITY_DENIED', '只有工作台所有者可以查看完整贡献目录', 403);
        return await json(request, response, capabilityFacts());
      }
      if (url.pathname === '/api/v0/session') {
        const selection = caller.owner ? null : connections.selection(caller.connectionId, caller.runtimeInstanceId);
        const identity = caller.owner ? await application.execute('creation.root', {}) : null;
        const canSelect = Boolean(caller.owner && allowSelection);
        const mediaReadOnly = !callerScopes.includes('create') && !(allowExecution && callerScopes.includes('execute')) && !canSelect;
        return await json(request, response, { contractVersion: 0, instanceId, readOnly: mediaReadOnly,
          ...(identity ? { rootId: identity.rootId } : {}),
          connectionManagement: Boolean(caller.owner && allowConnectionManagement), workbenchMediaReadOnly: serveWorkbench && mediaReadOnly,
          providerManagement: Boolean(caller.owner && allowProviderManagement), ...(serveWorkbench && caller.owner ? { panel: panel.identity } : {}),
          ...(pluginPanel && caller.owner ? { panelContributions: pluginPanel.manifest } : {}),
          ...(pluginExecution ? { pluginExecution: true, pluginOperations: caller.owner ? selectedOperations.map(item => item.dependency) : selection?.pluginOperations || [] } : {}),
          ...(audioEnabled ? { audio: true } : {}),
          operations: projectCoreSessionOperations({ scopes: callerScopes, ...(selection ? { tools: selection.tools } : {}),
            imageGeneration: imageGenerationEnabled, audio: audioEnabled, execution: allowExecution, pluginExecution,
            creationLookup: Boolean(identity?.rootId), selection: canSelect }),
          ...(selection || {}),
          ...(allowExecution || pluginExecution ? { executionEnabled: runner.snapshot().executionEnabled } : {}),
          limits: { runPageSize: 30, imageBytes: MAX_LOCAL_API_IMAGE_BYTES, activeReads: 2,
            ...(allowLocalWrites ? { uploadBytes: MAX_IMPORT_IMAGE_BYTES, jsonBytes: 64 * 1024, activeUploads: 1, localWrites: 9 } : {}) } });
      }
      if (connections && ['/api/v0/connections', '/api/v0/adapters'].includes(url.pathname)) {
        const facts = connections.list(caller.owner ? undefined : caller.connectionId);
        return await json(request, response, url.pathname.endsWith('/adapters') ? { contractVersion: 0, adapters: facts.adapters } : facts);
      }
      if (operation) {
        const result = await application.execute('operation.inspect', { id: operation[1] });
        await requireOperationCapability(caller, result.operation);
        return await json(request, response, result);
      }
      if (creationLookup) {
        const kind = url.searchParams.get('kind'), key = url.searchParams.get('key');
        if (!CREATION_KINDS.includes(kind) || !KEY.test(key || '')) fail('IRIS_API_INPUT_INVALID', '需要明确的创建类型与原 UUIDv4 Key');
        return await json(request, response, await application.execute('creation.lookup', { kind, key }));
      }
      if (operationLookup) {
        if (!KEY.test(url.searchParams.get('key') || '')) fail('IRIS_API_INPUT_INVALID', '需要原 Operation Key');
        const result = await application.execute('operation.lookup', { key: url.searchParams.get('key') });
        await requireOperationCapability(caller, result.operation);
        return await json(request, response, result);
      }
      if (runOperations) {
        await requireFlowCapability(caller, runOperations[1]);
        const limit = url.searchParams.get('limit'), cursor = url.searchParams.get('cursor');
        if (limit !== null && !/^(?:[1-9]|[12][0-9]|30)$/.test(limit)) fail('IRIS_API_INPUT_INVALID', 'limit 必须是 1–30');
        return await json(request, response, await application.execute('operation.list', { runId: runOperations[1],
          ...(limit !== null ? { limit: Number(limit) } : {}), ...(cursor !== null ? { cursor } : {}) }));
      }
      if (url.pathname === '/api/v0/models') return await json(request, response, models());
      if (url.pathname === '/api/v0/audio-models' && audioEnabled) return await json(request, response, audioModels(caller));
      if (url.pathname === '/api/v0/runs') {
        const limitText = url.searchParams.get('limit') ?? '20';
        if (!/^(?:[1-9]|[12][0-9]|30)$/.test(limitText)) fail('IRIS_API_INPUT_INVALID', 'limit 必须是 1–30 的整数');
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && !RUN.test(cursor)) fail('IRIS_API_INPUT_INVALID', '游标无效');
        const selection = url.searchParams.get('selection') ?? 'all';
        if (!['all', 'selected', 'unselected'].includes(selection)) fail('IRIS_API_INPUT_INVALID', '选择筛选无效');
        const kind = url.searchParams.get('kind') ?? 'all';
        if (!['all', 'image', 'speech', 'transcribe'].includes(kind)) fail('IRIS_API_INPUT_INVALID', '作品类别无效');
        const records = (await application.run('reader', runtime => runtime.run('inspect', ({ dataRoot }) => listFlowRuns(dataRoot))))
          .filter(run => allowsRun(caller, run) && (kind === 'all' || kind === 'image' && !isAudioRecipe(run.recipe)
            || kind === 'speech' && run.recipe === 'speech/v0' || kind === 'transcribe' && run.recipe === 'transcribe/v0'));
        const selected = records.filter(run => Boolean(run.selection)).length;
        const counts = { all: records.length, selected, unselected: records.length - selected };
        const ordered = records.filter(run => selection === 'all' || Boolean(run.selection) === (selection === 'selected'))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const index = cursor === null ? 0 : ordered.findIndex(run => run.id === cursor) + 1;
        if (cursor !== null && index === 0) fail('IRIS_API_INPUT_INVALID', '游标已失效，请重新读取列表');
        const page = ordered.slice(index, index + Number(limitText));
        return await json(request, response, { contractVersion: 0, total: ordered.length, counts,
          runs: page.map(projectLocalApiRunSummary), nextCursor: index + page.length < ordered.length ? page.at(-1).id : null });
      }
      let artifactId, mediaKind = matchAudio ? matchAudio[2] : 'image';
      if (matchRun) {
        await requireFlowCapability(caller, matchRun[1]);
        const view = projectLocalApiFlow(await application.execute('flow.inspect', { run_id: matchRun[1] }));
        if (!matchRun[2]) return await json(request, response, view);
        const audio = isAudioRecipe(view.recipe);
        if (audio) {
          mediaKind = view.recipe === 'speech/v0' ? 'audio' : 'text';
          scope(caller, 'read', mediaKind === 'audio' ? 'iris_core_audio' : 'iris_core_transcript');
          if (!view.output) fail('IRIS_API_SELECTION_REQUIRED', '请先接回原任务结果', 409);
          artifactId = view.output.artifactId;
        } else {
          scope(caller, 'read', 'iris_core_image');
          if (!view.selection) fail('IRIS_API_SELECTION_REQUIRED', '请先明确选择要下载的作品', 409);
          artifactId = view.selection.artifactId;
        }
      } else if (matchImage) artifactId = matchImage[1];
      else if (matchAudio) artifactId = matchAudio[1];
      else fail('IRIS_API_NOT_FOUND', '没有此只读接口', 404);
      await requireArtifactCapability(caller, artifactId);
      const result = await image(artifactId, mediaKind);
      return await send(request, response, 200, result.bytes, { 'Content-Type': result.artifact.mediaType,
        ...(matchRun ? { 'Content-Disposition': `attachment; filename="iris-${artifactId}.${IMAGE_TYPES.get(result.artifact.mediaType) || AUDIO_TYPES[result.artifact.mediaType] || 'txt'}"` } : {}) });
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
        ...(safe.status === 405 ? { Allow: safe.allow || (safe.code === 'IRIS_API_METHOD_DENIED' ? 'POST'
          : allowLocalWrites || allowSelection || allowConnectionManagement || allowProviderManagement ? 'GET, HEAD, POST' : 'GET, HEAD') } : {}) });
    }
  }

  async function closeServer() {
    if (!server?.listening) return;
    const completion = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await completion;
  }

  async function cleanupResources() {
    const failures = [];
    for (const [stage, close] of [
      ['provider-monitor', () => providerMonitor?.dispose()],
      ['http', closeServer], ['mcp', () => mcp?.dispose()], ['runner', () => runnerStarted ? runner.dispose() : undefined],
      ['application', () => application?.dispose()], ['requests', () => Promise.all([...jobs])],
      ['connections-store', () => managed?.dispose()], ['connections', () => connections?.dispose()],
      ['workbench-auth', () => browserAuth?.dispose()],
      ['providers', () => suppliedRegistry ? undefined : registry?.dispose()]
    ]) {
      try { await close(); } catch (error) { failures.push({ stage, error }); }
    }
    if (failures.length) {
      cleanupFailed = true;
      throw Object.assign(new AggregateError(failures.map(item => item.error), '本地服务释放失败：' + failures.map(item => item.stage).join(', ')),
        { code: 'IRIS_API_CLEANUP_FAILED', stages: failures.map(item => item.stage) });
    }
  }

  function start({ port = 0 } = {}) {
    if (state !== 'new') return Promise.reject(new LocalApiError('IRIS_API_LIFECYCLE', '服务只能显式启动一次', 409));
    if (!Number.isInteger(port) || port < 0 || port > 65535) return Promise.reject(new LocalApiError('IRIS_API_INPUT_INVALID', '端口必须是 0–65535 的整数'));
    state = 'starting';
    const result = (async () => {
      try {
        if (pluginRegistry && pluginRegistry.snapshot().state !== 'active') fail('IRIS_API_CONFIG_INVALID', '插件注册实例须处于活动状态');
        registry ||= await createProviderRegistry();
        if (panelManifestPath) panel = loadPanelExtension(panelManifestPath);
        if (panelContributions !== undefined) pluginPanel = createPluginPanelAssembly(pluginRegistry, panelContributions);
        if (allowProviderManagement) loadProviderCatalog(providerConfigPath);
        const reader = createCoreRuntime({ dataRoot: suppliedRoot, mode: 'reader' });
        try {
          reader.start();
          physicalRoot = await reader.run('inspect', ({ dataRoot: root }) => {
            inspectFlowRoot(root);
            const version = inspectCreationRoot(root, { allowAbsent: !allowLocalWrites })?.schemaVersion;
            imageGenerationEnabled = [2, 3].includes(version); audioEnabled = version === 3;
            return root;
          });
        } finally { await reader.dispose(); }
        if (closeRequested) fail('IRIS_API_UNAVAILABLE', '启动已取消', 503);
        if (workbenchAuth) { browserAuth = createWorkbenchAuth({ ...workbenchAuth, dataRoot: physicalRoot }); browserAuth.start(); }
        let ports = {};
        if (allowExecution) {
          if (!executionPorts) loadProviderCatalog(providerConfigPath); // Static validation only; no discovery or model call.
          ports = executionPorts || configuredImagePorts(providerConfigPath, registry);
        }
        let grants = [];
        if (connectionsFile) {
          const file = fs.realpathSync.native(connectionsFile), relative = path.relative(physicalRoot, file);
          if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) fail('IRIS_API_CONFIG_INVALID', '授权文件须放在数据根之外');
          grants = readConnectionGrants(connectionsFile); const marker = inspectExecutionRoot(physicalRoot);
          if (grants.some(grant => grant.rootId !== marker.rootId)) fail('IRIS_API_CONFIG_INVALID', '连接授权属于另一数据空间');
        }
        if (connectionsFile || allowConnectionManagement) connections = createConnectionRegistry(grants, availableScopes,
          { availableCapabilities: availableCapabilities().map(group => group.id), availableTools: availableTools(), onClientInfo: (id, contact) => managed?.observe(id, contact) });
        if (allowConnectionManagement) {
          const marker = inspectExecutionRoot(physicalRoot);
          managed = createManagedConnectionStore({ directory: connectionStore, dataRoot: physicalRoot, rootId: marker.rootId,
            getOrigin: () => origin, availableScopes, availableTools: availableTools(), beforeCreate: id => {
              const active = connections.list().connections;
              if (active.some(item => item.connectionId === id)) fail('IRIS_CONNECTION_CONFIG_CHANGED', '连接身份与现有授权冲突', 409);
              if (active.length >= 32) fail('IRIS_CONNECTION_BUSY', '活动连接已达 32 项，请先撤销不用的连接', 429);
            }, onChange: (grant, id) => {
              if (!grant) { connections.revoke(id); changedAuthorizations.add(id); }
              else if (connections.setGrant(grant).authorizationChanged) changedAuthorizations.add(id);
            } });
          const dynamic = await managed.start();
          if (grants.length + dynamic.length > 32 || dynamic.some(value => grants.some(item => item.connectionId === value.connectionId || item.accessToken === value.accessToken))) {
            fail('IRIS_CONNECTION_CONFIG_CHANGED', '静态与面板授权冲突或超过容量', 409);
          }
          for (const grant of dynamic) connections.setGrant(grant);
        }
        application = createApplicationRuntime({ dataRoot: physicalRoot, ...ports,
          ...(!allowExecution && allowLocalWrites && providerConfigPath ? { resolveAudioCandidates: ({ capability, modelRef }) => {
            const select = capability === 'tts' ? ttsCandidatesFromCatalog : transcribeCandidatesFromCatalog;
            return select(loadProviderCatalog(providerConfigPath), modelRef, registry).map(route => ({
              adapter: { id: route.provider.id, protocol: route.provider.mediaProtocol }, model: route.modelRef,
              providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
            }));
          }, resolveImageCandidates: ({ modelRef, input }) =>
            imageCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef, registry).map(route => {
              if (input?.workflow_parameters !== undefined) {
                if (route.provider.mediaProtocol !== 'comfyui') throw Object.assign(new TypeError('工作流参数仅用于 ComfyUI 模板'), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
                compileComfyWorkflow(route.provider.comfyWorkflow, input);
              }
              return {
                adapter: { id: route.provider.id, protocol: route.provider.mediaProtocol }, model: route.modelRef,
                supportsImageEdit: supportsImageEdit(route.provider.mediaProtocol, route.model, registry),
                providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
              };
            }) } : {}) });
        if (allowExecution || pluginExecution) {
          runner = createOperationRunner({ dataRoot: physicalRoot, application, ...ports, onExecutionError: reportUnexpected, pluginRegistry, allowedOperations: allowedPluginIds });
          await runner.start(); runnerStarted = true;
        }
        if (allowMcp) {
          const { createMcpHttpGateway } = await import('./mcp-http.js');
          const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
          mcp = createMcpHttpGateway({ getOrigin: () => origin, authenticate: token => connections.identifyMcp(token),
            availableScopes, version: manifest.version });
          await mcp.start();
        }
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
        if (browserAuth) browserAuth.bindControl({ origin, accessToken });
        state = 'open';
        return Object.freeze({ origin, accessToken,
          ...(browserAuth ? { authentication: browserAuth.info(), loginUrl: browserAuth.info().configured ? origin : browserAuth.setupLink(origin) }
            : serveWorkbench ? issueLoginLink() : {}), ...(allowMcp ? { mcpEndpoint: origin + '/mcp' } : {}) });
      } catch (error) {
        try { await cleanupResources(); }
        catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], '本地服务启动与释放均失败'), { code: 'IRIS_API_STARTUP_CLEANUP_FAILED' }); }
        finally { state = closeRequested ? 'closing' : 'closed'; if (!closeRequested) resolveClosed(snapshot()); }
        throw error;
      }
    })();
    // Retain only completion for lifecycle coordination; not the private start result containing the token.
    startPromise = result.then(() => undefined, () => undefined);
    return result;
  }

  function dispose() {
    if (disposal) return disposal;
    closeRequested = true; state = 'closing'; tokenDigest?.fill(0); loginTicket = null; browserSessions.clear();
    disposal = (async () => {
      if (startPromise) await startPromise.catch(() => {}); // start's caller retains the original failure.
      try { await cleanupResources(); }
      finally { state = 'closed'; resolveClosed(snapshot()); }
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
    const root = fs.realpathSync.native(dataRoot), parent = fs.realpathSync(path.dirname(file));
    const destination = path.join(parent, path.basename(file));
    const relative = path.relative(root, path.join(fs.realpathSync.native(parent), path.basename(file)));
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
