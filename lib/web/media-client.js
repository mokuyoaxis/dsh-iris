import { createRecoveryJournal, WorkbenchMediaError } from './recovery.js';
import { normalizeWorkflowValues } from './comfyui.js';

const CAPABILITY = { 'image-import': 'images.create', 'flow-create': 'runs.create', 'generation-create': 'generations.create', continue: 'runs.continue',
  'audio-import': 'audio.create', 'speech-create': 'speeches.create', 'transcription-create': 'transcriptions.create', selection: 'runs.select', stop: 'operations.stop' };
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const RUN = /^run_[a-f0-9]{24}$/, ARTIFACT = /^artifact_[a-f0-9]{24}$/, OPERATION = /^op_[a-f0-9]{64}$/;
const fail = (code, message) => { throw new WorkbenchMediaError(code, message); };
export const CREATIONS = ['image-import', 'flow-create', 'generation-create', 'audio-import', 'speech-create', 'transcription-create'];
export const IMPORTS = ['image-import', 'audio-import'];
const AUDIO_TYPES = ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'];
function audioInput(value, kind) {
  const required = kind === 'speech-create' ? ['modelRef', 'text'] : ['modelRef', 'sourceArtifactId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => typeof value[key] !== 'string' || !value[key].trim())
      || Object.keys(value).some(key => ![...required, ...(kind === 'speech-create' ? ['voice'] : [])].includes(key))
      || value.voice !== undefined && typeof value.voice !== 'string') throw new TypeError('音频流程输入无效');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item.trim()]));
}
function flowInput(value, generate = false) {
  const required = generate ? ['modelRef', 'prompt'] : ['sourceArtifactId', 'modelRef', 'prompt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => ![...required, 'size', ...(generate ? ['workflowParameters'] : [])].includes(key))
      || !required.every(key => typeof value[key] === 'string')
      || value.size !== undefined && typeof value.size !== 'string') throw new TypeError('流程输入无效');
  return { ...(!generate ? { sourceArtifactId: value.sourceArtifactId } : {}), modelRef: value.modelRef, prompt: value.prompt,
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.workflowParameters === undefined ? {} : { workflowParameters: normalizeWorkflowValues(value.workflowParameters) }) };
}
function operation(value, runId) {
  const item = value?.operation;
  if (value?.contractVersion !== 0 || typeof item?.id !== 'string' || !OPERATION.test(item.id)
      || typeof item.runId !== 'string' || !RUN.test(item.runId) || runId && item.runId !== runId
      || !['queued', 'running', ...TERMINAL].includes(item.state)) throw new TypeError('不支持的操作响应');
  return item;
}
function flow(value, runId) {
  if (value?.contractVersion !== 0 || value.id !== runId || !Number.isSafeInteger(value.revision) || value.revision < 1
      || value.selection !== null && (typeof value.selection?.artifactId !== 'string' || !ARTIFACT.test(value.selection.artifactId))) {
    throw new TypeError('不支持的流程响应');
  }
  return value;
}

/** Explicit actions only. Constructing, reconnecting and recovering never send POST. */
export function createMediaClient({ client, session, origin, getStorage }) {
  if (session?.contractVersion !== 0 || !Array.isArray(session.operations) || !session.operations.every(item => typeof item === 'string')) {
    throw new TypeError('不支持的工作台会话');
  }
  const journal = createRecoveryJournal({ origin, rootId: session.rootId, getStorage });
  const capabilities = new Set(session.operations), lifetime = new AbortController(), stops = new Map();
  let active = null, recovering = null;
  const open = () => lifetime.signal.throwIfAborted();
  const requireCapability = name => { if (!capabilities.has(name)) fail('IRIS_WEB_CAPABILITY_UNAVAILABLE', '当前服务未开启这项操作'); };
  const snapshot = () => ({ ...journal.snapshot(), busy: Boolean(active || stops.size || recovering) });
  function settle(record, response) {
    open();
    if (response?.contractVersion !== 0) throw new TypeError('不支持的媒体响应');
    if (IMPORTS.includes(record.kind)) {
      const id = response.artifact?.artifactId;
      if (typeof id !== 'string' || !ARTIFACT.test(id)) throw new TypeError('不支持的素材响应');
      journal.remove(record.id);
    } else if (CREATIONS.includes(record.kind)) {
      const result = flow(response.flow, response.flow?.id);
      const recipes = { 'flow-create': 'image-edit/v0', 'generation-create': 'image-generate/v0', 'speech-create': 'speech/v0', 'transcription-create': 'transcribe/v0' };
      if (typeof result.id !== 'string' || !RUN.test(result.id) || result.recipe !== recipes[record.kind]
          || (record.artifactId ? result.source?.artifactId !== record.artifactId : result.source !== null)) throw new TypeError('流程来源或类型与本次创建不一致');
      journal.remove(record.id);
    } else if (record.kind === 'selection') {
      const result = flow(response, record.runId);
      if (result.selection?.artifactId !== record.artifactId || result.revision < record.expectedRevision) throw new TypeError('选择结果与本次操作不一致');
      journal.remove(record.id);
    } else {
      const item = operation(response, record.kind === 'continue' ? record.runId : undefined);
      if (record.kind === 'stop' && item.id !== record.operationId) throw new TypeError('停止响应与原操作不一致');
      if (TERMINAL.has(item.state)) {
        journal.remove(record.id);
        if (record.kind === 'stop') for (const other of journal.snapshot().actions) {
          if (other.kind === 'continue' && other.operationId === item.id) journal.remove(other.id);
        }
      } else journal.update(record.id, { operationId: item.id });
    }
    return response;
  }
  function send(record, input) {
    const options = { key: record.key, signal: lifetime.signal };
    if (record.kind === 'image-import') return client.uploadImage(input, options);
    if (record.kind === 'flow-create') return client.createRun(input, options);
    if (record.kind === 'generation-create') return client.createGeneration(input, options);
    if (record.kind === 'audio-import') return client.uploadAudio(input, options);
    if (record.kind === 'speech-create') return client.createSpeech(input, options);
    if (record.kind === 'transcription-create') return client.createTranscription(input, options);
    if (record.kind === 'continue') return client.continueRun(record.runId, record.expectedRevision, options);
    if (record.kind === 'selection') return client.selectRun(record.runId, record.artifactId, record.expectedRevision, options);
    return client.stopOperation(record.operationId, options);
  }
  function perform(kind, input, original) {
    open(); requireCapability(CAPABILITY[kind]);
    if (journal.snapshot().blocked) fail('IRIS_WEB_RECOVERY_CORRUPT', '待核对记录损坏，请先明确处理原记录');
    if (recovering) fail('IRIS_WEB_BUSY', '正在核对原操作，请等待读取完成');
    const signature = IMPORTS.includes(kind) ? input : JSON.stringify([kind, input]);
    const running = kind === 'stop' ? stops.get(input.operationId) : active;
    if (running) {
      if (running.kind === kind && running.signature === signature && running.originalId === original?.id) return running.promise;
      fail('IRIS_WEB_BUSY', '本次操作尚未返回，请等待或读取原结果');
    }
    if (!original && journal.snapshot().actions.some(item => kind === 'stop'
      ? item.kind === 'stop' && item.operationId === input.operationId
      : CREATIONS.includes(kind) ? item.kind === kind : item.runId === input.runId)) {
      fail('IRIS_WEB_RECOVERY_REQUIRED', '原操作结果尚待核对，请先读取原结果或明确重试原动作');
    }
    const id = original?.id || crypto.randomUUID();
    const record = original || { id, kind,
      ...([...CREATIONS, 'continue'].includes(kind) ? { key: id } : {}),
      ...(['flow-create', 'transcription-create'].includes(kind) ? { artifactId: input.sourceArtifactId } : {}),
      ...(['continue', 'selection'].includes(kind) ? { runId: input.runId, expectedRevision: input.expectedRevision } : {}),
      ...(kind === 'selection' ? { artifactId: input.artifactId } : {}), ...(kind === 'stop' ? { operationId: input.operationId } : {}) };
    if (!original) journal.add(record);
    const promise = Promise.resolve().then(() => { open(); return send(record, input); }).then(response => settle(record, response)).finally(() => {
      if (kind === 'stop') { if (stops.get(input.operationId)?.promise === promise) stops.delete(input.operationId); }
      else if (active?.promise === promise) active = null;
    });
    const job = { kind, signature, originalId: original?.id, promise };
    if (kind === 'stop') stops.set(input.operationId, job); else active = job;
    return promise;
  }
  async function readAction(action) {
    const capability = CREATIONS.includes(action.kind) ? 'creation.lookup'
      : action.kind === 'selection' ? 'runs.inspect' : action.operationId ? 'operations.inspect' : 'operations.lookup';
    if (!capabilities.has(capability)) return { action, status: 'capability_unavailable' };
    try {
      let result;
      if (CREATIONS.includes(action.kind)) {
        result = await client.lookupCreation(action.kind, action.key, { signal: lifetime.signal }); open();
        if (result.contractVersion !== 0 || result.kind !== action.kind || !['prepared', 'succeeded'].includes(result.state)
            || result.state === 'succeeded' && !result.result) throw new TypeError('不支持的创建查询响应');
        if (result.result) {
          const field = IMPORTS.includes(action.kind) ? 'artifactId' : 'runId';
          journal.update(action.id, { [field]: result.result[field] });
        }
        if (result.state === 'succeeded') journal.remove(action.id);
        return { action, status: result.state === 'succeeded' ? 'confirmed' : 'prepared', result };
      }
      if (action.kind === 'selection') {
        result = flow(await client.getRun(action.runId, { signal: lifetime.signal }), action.runId); open();
        journal.remove(action.id);
        return { action, status: 'current', matches: result.selection?.artifactId === action.artifactId, result };
      }
      result = await (action.operationId ? client.getOperation(action.operationId, { signal: lifetime.signal })
        : client.lookupOperation(action.key, { signal: lifetime.signal })); open();
      const item = operation(result, action.runId);
      if (action.operationId && item.id !== action.operationId) throw new TypeError('查询响应与原操作不一致');
      if (TERMINAL.has(item.state)) journal.remove(action.id);
      else journal.update(action.id, { operationId: item.id });
      return { action, status: TERMINAL.has(item.state) ? 'confirmed' : 'active', result };
    } catch (error) {
      open();
      return { action, status: error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict' : 'unavailable', error };
    }
  }
  return Object.freeze({
    snapshot,
    uploadImage(image) {
      if (!(image instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) throw new TypeError('需要静态图片文件');
      return perform('image-import', image);
    },
    createRun(value) { return perform('flow-create', flowInput(value)); },
    createGeneration(value) { return perform('generation-create', flowInput(value, true)); },
    uploadAudio(audio) {
      if (!(audio instanceof Blob) || !AUDIO_TYPES.includes(audio.type)) throw new TypeError('需要支持的音频文件');
      return perform('audio-import', audio);
    },
    createSpeech(value) { return perform('speech-create', audioInput(value, 'speech-create')); },
    createTranscription(value) { return perform('transcription-create', audioInput(value, 'transcription-create')); },
    continueRun(runId, expectedRevision) { return perform('continue', { runId, expectedRevision }); },
    selectRun(runId, artifactId, expectedRevision) { return perform('selection', { runId, artifactId, expectedRevision }); },
    stopOperation(operationId) { return perform('stop', { operationId }); },
    retry(id, input) {
      const action = journal.snapshot().actions.find(item => item.id === id);
      if (!action) throw new TypeError('原操作身份不存在');
      if (IMPORTS.includes(action.kind)) {
        if (!(input instanceof Blob) || !(action.kind === 'audio-import' ? AUDIO_TYPES : ['image/png', 'image/jpeg', 'image/webp']).includes(input.type)) throw new TypeError('请重新提供原素材');
      } else if (['flow-create', 'generation-create'].includes(action.kind)) {
        input = flowInput(input, action.kind === 'generation-create');
        if (action.kind === 'flow-create' && input.sourceArtifactId !== action.artifactId) throw new TypeError('请提供原流程的来源图片与输入');
      } else if (['speech-create', 'transcription-create'].includes(action.kind)) {
        input = audioInput(input, action.kind);
        if (action.kind === 'transcription-create' && input.sourceArtifactId !== action.artifactId) throw new TypeError('请提供原转写音频');
      } else input = action;
      return perform(action.kind, input, action);
    },
    recover() {
      open();
      if (active || stops.size) fail('IRIS_WEB_BUSY', '本次写入尚未返回，请等待后核对');
      if (recovering) return recovering;
      if (journal.snapshot().blocked) return Promise.resolve([]);
      recovering = (async () => { const results = []; for (const item of journal.snapshot().actions) results.push(await readAction(item)); return results; })()
        .finally(() => { recovering = null; });
      return recovering;
    },
    forget(id) { open(); if (active || stops.size || recovering) fail('IRIS_WEB_BUSY', '请等待当前操作结束'); journal.remove(id); },
    clearRecovery() { open(); if (active || stops.size || recovering) fail('IRIS_WEB_BUSY', '请等待当前操作结束'); journal.clear(); },
    close() { lifetime.abort(); journal.close(); }
  });
}
