// Finite user actions; reopening a Run never invokes continue.
import { renderWorkflowParameters, inspectionMessage } from './comfyui.js';
import { CREATIONS, IMPORTS } from './media-client.js';

const $ = selector => document.querySelector(selector);
const ACTIVE = new Set(['queued', 'running']);
const labels = { not_started: '开始改图', running: '查看原任务', delivery_failed: '恢复原结果', needs_comparison: '完成比较', needs_result: '接回结果' };
export function createCreationPanel({ openRun, refreshHistory, showDraft, describe, recover, renderOperation }) {
  let client, media, session, view = null, draft = {}, models = [], epoch = 0, intent = 0;
  let busy = false, stopping = false, loading = false, visible = true, job = null, activeOperation = null, timer, watchTicket = 0;
  let preview, retryAction = null, recoveryAfterLoad = null;
  let comfyForm = null, comfyKey = '', inspection = null;
  const cap = name => Boolean(session?.operations.includes(name));
  const mode = () => view ? ({ 'image-edit/v0': 'edit', 'image-generate/v0': 'generate', 'speech/v0': 'tts', 'transcribe/v0': 'transcribe' })[view.recipe] : draft.mode || 'edit';
  const generating = () => mode() === 'generate';
  const audio = () => ['tts', 'transcribe'].includes(mode());
  const createCapabilities = { generate: 'generations.create', edit: 'runs.create', tts: 'speeches.create', transcribe: 'transcriptions.create' };
  const createCapability = () => createCapabilities[mode()];
  const candidates = () => models.filter(model => audio() ? model.capability === mode() : !model.capability && (generating() || model.supportsImageEdit));
  const valid = at => at === epoch && Boolean(client);
  const validJob = task => valid(task.epoch) && task.intent === intent && visible && job === task;
  function feedback(text = '', error = false) {
    $('#creation-feedback').hidden = !text; $('#creation-feedback').textContent = text;
    $('#creation-feedback').classList.toggle('error', error);
  }
  function releasePreview() {
    $('#audio-input-preview').pause(); $('#audio-input-preview').removeAttribute('src'); $('#audio-input-preview').load(); $('#audio-input-preview').hidden = true;
    if (preview) URL.revokeObjectURL(preview); preview = null;
  }
  function stopWatch() { clearTimeout(timer); watchTicket++; }
  const selectedComfy = () => !view && generating() ? models.find(model => model.modelRef === $('#model').value && model.comfyWorkflow)?.comfyWorkflow : null;
  function invalidateInspection() {
    inspection?.controller.abort(); inspection = null;
    $('#comfy-creation-note').textContent = '尚未检查；生成前会核对实际参数，不会自动生成。';
  }
  function renderComfy(force = false, values = {}, checked = []) {
    const workflow = selectedComfy(), key = workflow ? $('#model').value + ':' + workflow.sha256 : '';
    if (!force && key === comfyKey) return;
    const preserveOpen = key === comfyKey;
    const updated = comfyKey && key && comfyKey !== key;
    invalidateInspection(); comfyKey = key; comfyForm = null;
    $('#comfy-creation').hidden = !workflow;
    if (!workflow) { $('#comfy-creation-fields').replaceChildren(); return; }
    const parameters = workflow.parameters || [];
    $('#comfy-creation-summary').textContent = parameters.length + ' 个开放参数 · 其余输入沿用工作流';
    comfyForm = renderWorkflowParameters($('#comfy-creation-fields'), parameters, { values, checked, preserveOpen, onChange() {
      invalidateInspection(); try { comfyForm.read(); } catch (error) { $('#comfy-creation-note').textContent = error.message; } controls();
    } });
    $('#comfy-creation-check').hidden = !session?.providerManagement;
    if (!workflow.sizeNode) $('#edit-size').value = '';
    if (updated) $('#comfy-creation-note').textContent = '已切换工作流，参数已按当前模板重新载入，请核对。';
  }
  async function checkComfy() {
    if (!client || busy || inspection || !selectedComfy() || !session.providerManagement) return;
    let values; try { values = comfyForm.read(); } catch (error) { feedback(error.message, true); return; }
    const job = { controller: new AbortController(), key: comfyKey, client, modelRef: $('#model').value };
    const workflow = selectedComfy(); inspection = job; controls(); $('#comfy-creation-note').textContent = '正在检查参数…';
    try {
      const settings = await job.client.get('/api/v0/provider-management/settings', { signal: job.controller.signal });
      if (inspection !== job) return;
      const current = settings.providers.flatMap(provider => provider.models.map(model => ({ ref: encodeURIComponent(provider.id) + '::' + encodeURIComponent(model.id), workflow: model.comfyWorkflow }))).find(item => item.ref === job.modelRef);
      if (current?.workflow?.sha256 !== workflow.sha256) throw new Error('工作流已变化，请重新读取模型后核对参数。');
      const result = await job.client.postProvider('workflow-check', { expectedRevision: settings.revision, modelRef: job.modelRef,
        ...(Object.keys(values).length ? { workflowParameters: values } : {}) }, { signal: job.controller.signal });
      if (inspection !== job) return;
      renderComfy(true, values, result.parameters);
      $('#comfy-creation-note').textContent = inspectionMessage(result);
    } catch (error) { if (inspection === job) $('#comfy-creation-note').textContent = describe(error); }
    finally { if (inspection === job) inspection = null; controls(); }
  }
  function controls() {
    const generate = generating(), currentMode = mode(), isAudio = audio(), transcribe = currentMode === 'transcribe';
    $('#studio-title').textContent = currentMode === 'tts' ? '让文字，有声音。' : transcribe ? '让声音，成文字。' : '让想法，有画面。';
    $('#studio-note').textContent = currentMode === 'tts' ? '写下要说的话，留下你的声音作品。' : transcribe ? '听见的内容，留成可以继续使用的文字。' : '保留喜欢的部分，试一点新的可能。';
    const needsSource = ['edit', 'transcribe'].includes(currentMode);
    const pending = media?.snapshot(), unresolved = pending?.actions.some(action => CREATIONS.includes(action.kind)
      || view && action.runId === view.id);
    $('#draft-fields').disabled = !client || busy || loading || Boolean(view) || !Object.values(createCapabilities).some(cap);
    for (const button of document.querySelectorAll('[data-creation-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.creationMode === currentMode));
      button.disabled = !cap(createCapabilities[button.dataset.creationMode]);
      if (['tts', 'transcribe'].includes(button.dataset.creationMode)) button.hidden = !session?.audio;
    }
    $('#source-input').hidden = currentMode !== 'edit'; $('#audio-source-input').hidden = !transcribe;
    $('#prompt-label').hidden = transcribe; $('#edit-prompt').hidden = transcribe; $('#edit-prompt').required = !transcribe;
    $('#speech-options').hidden = currentMode !== 'tts'; $('#advanced-settings').hidden = isAudio;
    $('#model-label').firstChild.textContent = currentMode === 'tts' ? '语音模型 ' : transcribe ? '转写模型 ' : '图片模型 ';
    $('#prompt-label').textContent = currentMode === 'tts' ? '要朗读的文字' : generate ? '想画些什么？' : '想改些什么？';
    $('#edit-prompt').maxLength = isAudio ? 20000 : 12000;
    $('#edit-prompt').placeholder = currentMode === 'tts' ? '写下希望朗读的内容…' : generate ? '描述画面、人物、色彩与风格…' : '描述想保留的细节，以及想尝试的变化…';
    const canCreate = cap(createCapability()) && cap('runs.continue') && (!needsSource || Boolean(draft.file || draft.artifactId)
      && (draft.artifactId || cap(transcribe ? 'audio.create' : 'images.create')))
      && Boolean($('#model').value) && (transcribe || Boolean($('#edit-prompt').value.trim()));
    const canContinue = view && cap('runs.continue') && Object.hasOwn(labels, view.status);
    const canRetry = retryAction && (IMPORTS.includes(retryAction.kind) ? cap(retryAction.kind === 'audio-import' ? 'audio.create' : 'images.create') && Boolean(draft.file)
      : CREATIONS.includes(retryAction.kind) ? cap(createCapability()) && Boolean((!needsSource || draft.artifactId) && $('#model').value && (transcribe || $('#edit-prompt').value.trim()))
        : cap(retryAction.kind === 'stop' ? 'operations.stop' : 'runs.continue'));
    $('#start-edit').disabled = !client || busy || stopping || loading || pending?.blocked || unresolved && !retryAction
      || Boolean(activeOperation && ACTIVE.has(activeOperation.state)) || Boolean(inspection) || comfyForm && !comfyForm.valid()
      || !(retryAction ? canRetry : view ? canContinue : canCreate);
    $('#start-edit').textContent = busy ? '正在处理…' : retryAction ? '按原 Key 接回' : view && view.status !== 'not_started'
      ? labels[view.status] || '查看已有作品' : currentMode === 'tts' ? '合成语音' : transcribe ? '开始转写' : generate ? '开始生成' : '开始改图';
    $('#locked-note').hidden = !view;
    $('#reuse-selected').disabled = busy || loading || !cap('runs.create') || !view?.selection;
    for (const kind of ['source', 'output']) {
      $('#select-' + kind).disabled = busy || stopping || loading || !view?.[kind] || !cap('runs.select') || !['awaiting_selection', 'selected'].includes(view?.status);
    }
    $('#stop-operation').hidden = !cap('operations.stop') || !activeOperation || !ACTIVE.has(activeOperation.state);
    $('#stop-operation').disabled = stopping; $('#stop-operation').textContent = stopping ? '正在停止…' : '停止等待';
    $('#creation-help').textContent = !client ? '读取权限中…' : loading ? '当前流程尚未确认，读取完成前暂停操作。可重新读取或新建流程。'
      : retryAction ? '使用原身份与原输入接回。明确执行仍可能产生供应商费用。'
      : pending?.blocked ? '恢复记录需要先明确处理，暂不接收新动作。'
        : !cap('runs.continue') ? isAudio ? '当前服务只读，可浏览和下载已保存的音频或文字。'
          : cap('runs.select') ? '当前可选择已有图片。开始创作需要显式开启执行服务。' : '当前服务只读，可浏览图片流程和下载已选作品。'
          : !view && !candidates().length ? isAudio ? '尚无此音频功能的可用候选。请在模型服务中配置并分配用途。' : '尚无可用图片候选。可在供应商页配置模型。'
            : view?.status === 'needs_attention' ? '先核对原任务；受理未知时请避免重复生成。'
              : '明确执行可能产生供应商费用。刷新不会自动生成。';
    $('#creation-settings').dataset.fixed = String(Boolean(view));
    $('#comfy-creation-check').disabled = Boolean(inspection) || busy || loading;
    $('#comfy-creation-check').textContent = inspection ? '正在检查…' : '检查参数并读取选项';
    const workflow = selectedComfy(); $('#edit-size').disabled = Boolean(workflow && !workflow.sizeNode);
    $('#edit-size-note').textContent = workflow && !workflow.sizeNode ? '此工作流未绑定尺寸节点，沿用模板尺寸。' : '填写模型支持的尺寸；留空使用默认值。';
  }
  function fillModels(selected = '') {
    const choices = candidates(), label = mode() === 'tts' ? '语音' : mode() === 'transcribe' ? '转写' : '图片';
    $('#model').replaceChildren(new Option(choices.length ? '选择一个' + label + '模型' : '没有可用' + label + '候选', ''));
    for (const model of choices) $('#model').append(new Option(model.displayName + ' · ' + model.modelRef, model.modelRef));
    if (selected && !choices.some(model => model.modelRef === selected)) $('#model').append(new Option(selected + ' · 原流程模型', selected));
    $('#model').value = selected;
  }
  function cancelChain() { intent++; stopWatch(); }
  function beginDraft({ file, artifactId, label, modelRef = '', mode = file || artifactId ? 'edit' : cap('generations.create') ? 'generate' : 'edit' } = {}) {
    cancelChain(); loading = false; recoveryAfterLoad = null; retryAction = null; activeOperation = null; view = null; draft = { file, artifactId, mode };
    releasePreview(); if (file) preview = URL.createObjectURL(file);
    $('#input-preview').hidden = !preview || mode === 'transcribe'; $('#input-preview').removeAttribute('src'); if (preview && mode !== 'transcribe') $('#input-preview').src = preview;
    if (preview && mode === 'transcribe') { $('#audio-input-preview').src = preview; $('#audio-input-preview').hidden = false; }
    $('#audio-file').value = ''; $('#speech-voice').value = ''; $('#audio-file-name').textContent = label || file?.name || (artifactId ? '已保存的原音频' : 'WAV / MP3 / OGG / FLAC，最大20 MiB。');
    $('#file-name').textContent = label || file?.name || (artifactId ? '已选作品' : '选择一张图片');
    $('#image-file').value = ''; $('#edit-prompt').value = ''; $('#edit-size').value = ''; fillModels(modelRef); renderComfy(true);
    $('#input-summary').textContent = mode === 'tts' ? '让文字成为声音' : mode === 'transcribe' ? '把声音留成文字' : mode === 'generate' ? '从一句想法开始' : file || artifactId ? '填写你的修改要求' : '从一张图片开始';
    $('#creation-settings').open = true; $('#advanced-settings').open = false; feedback();
    showDraft(preview, mode); controls();
  }
  async function chooseFile(file) {
    if (!client || busy || loading || view || !file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > (session.limits?.uploadBytes || 20 * 1024 * 1024)) {
      feedback('请选择不超过 20 MiB 的静态 PNG、JPEG 或 WebP 图片。', true); return;
    }
    const originalRetry = retryAction, modelRef = $('#model').value, prompt = $('#edit-prompt').value, size = $('#edit-size').value;
    beginDraft({ file, modelRef }); $('#edit-prompt').value = prompt; $('#edit-size').value = size;
    retryAction = originalRetry; controls();
  }
  function chooseAudio(file) {
    if (!client || busy || loading || view || !file) return;
    const types = { 'audio/x-wav': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac', 'application/ogg': 'audio/ogg' };
    const byExtension = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' };
    const type = types[file.type] || file.type || byExtension[file.name?.split('.').at(-1).toLowerCase()];
    if (!['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'].includes(type) || file.size > 20 * 1024 * 1024) { feedback('请选择最多20 MiB的WAV、MP3、OGG或FLAC音频。', true); return; }
    const original = retryAction;
    beginDraft({ mode: 'transcribe', file: type === file.type ? file : new Blob([file], { type }), label: file.name, modelRef: $('#model').value });
    retryAction = original; controls();
  }
  async function finishOperation(operation, at, ticket) {
    if (!valid(at) || ticket !== watchTicket || !visible) return;
    activeOperation = operation; renderOperation(operation);
    if (ACTIVE.has(operation.state)) return;
    stopWatch(); await recover();
    if (!valid(at) || !visible || view?.id !== operation.runId) return;
    await openRun(operation.runId, { fromAction: true });
    if (!valid(at)) return;
    if (view?.id === operation.runId && audio() && operation.state === 'succeeded') feedback();
    await refreshHistory(); controls();
  }
  function watch(operation) {
    stopWatch(); activeOperation = operation; renderOperation(operation); controls();
    if (!ACTIVE.has(operation.state)) { void finishOperation(operation, epoch, watchTicket).catch(error => feedback(describe(error), true)); return; }
    const at = epoch, ticket = watchTicket; let reads = 0;
    const poll = async () => {
      if (!valid(at) || ticket !== watchTicket || !visible || document.hidden || view?.id !== operation.runId) return;
      try {
        const result = await client.getOperation(operation.id);
        if (!valid(at) || ticket !== watchTicket) return;
        await finishOperation(result.operation, at, ticket);
        if (valid(at) && ticket === watchTicket && ACTIVE.has(result.operation.state)) {
          if (++reads < 40) timer = setTimeout(poll, 1500);
          else feedback('自动读取已暂停。可点“刷新”核对原操作，不会重新提交。');
        }
      } catch (error) { if (valid(at) && ticket === watchTicket) { stopWatch(); feedback('进度读取已暂停。' + describe(error), true); } }
    };
    if (visible && !document.hidden) timer = setTimeout(poll, 350);
  }
  async function execute() {
    if ($('#start-edit').disabled) return;
    let parameters;
    try { if (selectedComfy()) parameters = comfyForm.read(); } catch (error) { feedback(error.message, true); return; }
    const task = { epoch, intent, runId: view?.id }; job = task; busy = true; controls();
    const generate = generating(), currentMode = mode(), isAudio = audio(), transcribe = currentMode === 'transcribe';
    const input = isAudio ? { modelRef: $('#model').value, ...(transcribe ? { sourceArtifactId: draft.artifactId }
      : { text: $('#edit-prompt').value, ...($('#speech-voice').value.trim() ? { voice: $('#speech-voice').value.trim() } : {}) }) }
      : { ...(!generate ? { sourceArtifactId: draft.artifactId } : {}), modelRef: $('#model').value, prompt: $('#edit-prompt').value,
      ...($('#edit-size').value.trim() ? { size: $('#edit-size').value.trim() } : {}),
      ...(parameters && Object.keys(parameters).length ? { workflowParameters: parameters } : {}) };
    const file = draft.file, original = retryAction;
    try {
      if (original) {
        const value = await media.retry(original.id, IMPORTS.includes(original.kind) ? file : CREATIONS.includes(original.kind) ? input : undefined);
        if (!validJob(task)) return;
        retryAction = null;
        if (IMPORTS.includes(original.kind)) { draft.artifactId = value.artifact.artifactId; feedback('原素材已接回。再次明确开始时才会创建并执行。'); }
        else if (CREATIONS.includes(original.kind)) { await openRun(value.flow.id, { fromAction: true }); feedback('原流程已接回，尚未自动开始。'); }
        else { watch(value.operation); feedback('已接回原操作。'); }
        await recover(); return;
      }
      if (!view) {
        if ((transcribe || currentMode === 'edit') && !input.sourceArtifactId) {
          feedback('正在保存素材…'); const imported = await media[transcribe ? 'uploadAudio' : 'uploadImage'](file);
          if (!validJob(task)) return; draft.artifactId = input.sourceArtifactId = imported.artifact.artifactId;
        }
        feedback('正在建立流程…'); const created = await media[({ generate: 'createGeneration', edit: 'createRun', tts: 'createSpeech', transcribe: 'createTranscription' })[currentMode]](input);
        if (!validJob(task)) return; task.runId = created.flow.id;
        await openRun(created.flow.id, { fromAction: true });
        if (!validJob(task)) return;
      }
      feedback('正在提交本次操作…');
      const accepted = await media.continueRun(view.id, view.revision);
      if (!validJob(task)) return;
      feedback('已接收。正在读取本地进度…'); watch(accepted.operation); await refreshHistory();
    } catch (error) {
      if (valid(task.epoch) && task.intent === intent) {
        feedback('本次动作未确认完成，请先核对原结果。' + describe(error), true);
        await recover();
      }
    } finally { if (job === task) { job = null; busy = false; if (valid(task.epoch)) controls(); } }
  }
  async function select(kind) {
    if (!view || $('#select-' + kind).disabled) return;
    const at = epoch, id = view.id, artifactId = view[kind].artifactId, revision = view.revision;
    busy = true; controls(); $('#selection-feedback').textContent = '正在保存选择…';
    try {
      await media.selectRun(id, artifactId, revision);
      if (!valid(at) || view?.id !== id || !visible) return;
      await openRun(id, { fromAction: true });
      if (!valid(at) || view?.id !== id) return;
      $('#selection-feedback').textContent = '选择已保存，可以下载原始图片。'; await refreshHistory();
    } catch (error) {
      if (!valid(at) || view?.id !== id) return;
      await recover();
      if (!valid(at) || !visible || view?.id !== id) return;
      await openRun(id, { fromAction: true });
      $('#selection-feedback').textContent = '已核对当前选择；请确认后再决定。' + describe(error);
    } finally { if (valid(at)) { busy = false; controls(); } }
  }
  async function stop() {
    if (!activeOperation || stopping) return;
    const at = epoch, operation = activeOperation; stopping = true; controls();
    try {
      const result = await media.stopOperation(operation.id);
      if (!valid(at)) return; activeOperation = result.operation;
      stopWatch(); await recover();
      if (view?.id === operation.runId && visible) { await openRun(operation.runId, { fromAction: true }); renderOperation(result.operation); }
      feedback('已停止本地等待；远端取消未请求，不代表退款或未计费。');
    } catch (error) { if (valid(at)) { feedback('停止结果待核对。' + describe(error), true); await recover(); } }
    finally { if (valid(at)) { stopping = false; controls(); } }
  }
  async function reuse() {
    if (!view?.selection || $('#reuse-selected').disabled) return;
    const at = epoch, original = view, marker = intent; busy = true; controls();
    try {
      const file = await client.get('/api/v0/artifacts/' + original.selection.artifactId + '/content', { binary: true });
      if (valid(at) && intent === marker && visible) beginDraft({ file, artifactId: original.selection.artifactId, modelRef: original.input.modelRef, label: '已选作品 · 新流程' });
    } catch (error) { if (valid(at)) feedback(describe(error), true); }
    finally { if (valid(at)) { busy = false; controls(); } }
  }
  function recovered(results) {
    if (loading) { recoveryAfterLoad = results; controls(); return; }
    if (!view) { controls(); return; }
    const active = results.find(item => item.status === 'active' && item.result.operation.runId === view.id);
    if (active) watch(active.result.operation); else controls();
  }
  $('#edit-form').addEventListener('submit', event => { event.preventDefault(); void execute(); });
  for (const button of document.querySelectorAll('[data-creation-mode]')) button.addEventListener('click', () => {
    if (busy || loading || view || button.disabled || draft.mode === button.dataset.creationMode) return;
    const keepImageInput = !audio() && ['edit', 'generate'].includes(button.dataset.creationMode);
    const prompt = $('#edit-prompt').value, size = $('#edit-size').value;
    beginDraft({ mode: button.dataset.creationMode });
    if (keepImageInput) { $('#edit-prompt').value = prompt; $('#edit-size').value = size; } controls();
  });
  $('#image-file').addEventListener('change', event => { void chooseFile(event.target.files[0]); event.target.value = ''; });
  $('#model').addEventListener('change', () => { renderComfy(); controls(); });
  for (const id of ['model', 'edit-prompt', 'edit-size', 'speech-voice']) $('#' + id).addEventListener('input', () => { if (id === 'model') renderComfy(); else invalidateInspection(); controls(); });
  $('#audio-file').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; chooseAudio(file); });
  $('#comfy-creation-check').addEventListener('click', () => { void checkComfy(); });
  $('#image-drop').addEventListener('dragover', event => { event.preventDefault(); if (!view && !busy) $('#image-drop').classList.add('dragging'); });
  $('#image-drop').addEventListener('dragleave', () => $('#image-drop').classList.remove('dragging'));
  $('#image-drop').addEventListener('drop', event => { event.preventDefault(); $('#image-drop').classList.remove('dragging'); void chooseFile(event.dataTransfer.files[0]); });
  $('#select-source').addEventListener('click', () => { void select('source'); });
  $('#select-output').addEventListener('click', () => { void select('output'); });
  $('#stop-operation').addEventListener('click', () => { void stop(); });
  $('#reuse-selected').addEventListener('click', () => { void reuse(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopWatch(); });
  matchMedia('(max-width:640px)').addEventListener('change', event => { if (view) $('#creation-settings').open = !event.matches; });
  return Object.freeze({
    connect(http, coordinator, info) { client = http; media = coordinator; session = info; visible = true; controls(); },
    setModels(values) { const selected = $('#model').value; models = values; fillModels(selected); renderComfy(); controls(); },
    beginDraft,
    async prepareVerification({ capability, modelRef }) {
      if (!client || busy || !cap('runs.continue')) return;
      const at = epoch, next = capability === 'tts' ? 'tts' : capability === 'transcribe' ? 'transcribe' : cap('generations.create') ? 'generate' : 'edit';
      if (!cap(createCapabilities[next])) { feedback('当前工作区没有此验证流程，请使用已接入的 CLI / DSH 功能。', true); return; }
      let file;
      if (next === 'edit') {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 256, 256);
        context.fillStyle = '#e03131'; context.beginPath(); context.arc(128, 128, 64, 0, Math.PI * 2); context.fill();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) { feedback('无法准备测试图片，请手动选择素材。', true); return; }
        file = new File([blob], 'iris-test-circle.png', { type: 'image/png' });
      }
      if (!valid(at)) return;
      beginDraft({ mode: next, modelRef, file });
      $('#edit-prompt').value = next === 'tts' ? '你好' : next === 'edit' ? '将红色圆形改为蓝色，保留白色背景。' : next === 'generate' ? 'A simple red circle on a plain white background.' : '';
      feedback(next === 'transcribe' ? '验证草稿已准备。请选择实际音频，确认后点击开始转写，可能产生费用。'
        : '验证草稿已准备。请核对模型及参数，再明确点击生成；可能产生供应商费用。'); controls();
    },
    loading() { loading = true; recoveryAfterLoad = null; stopWatch(); invalidateInspection(); controls(); },
    view(value, { sameRun = false } = {}) {
      const changed = view?.id !== value.id;
      loading = false; view = value; retryAction = null;
      if (changed) { activeOperation = null; stopWatch(); }
      if (!sameRun) { fillModels(value.input.modelRef); $('#edit-prompt').value = value.input.text ?? value.input.prompt ?? ''; $('#edit-size').value = value.input.size || ''; $('#speech-voice').value = value.input.voice || '';
        $('#input-summary').textContent = value.input.modelRef; $('#file-name').textContent = '流程原图';
        if (matchMedia('(max-width:640px)').matches) $('#creation-settings').open = false; }
      renderComfy(); controls();
      if (recoveryAfterLoad) { const results = recoveryAfterLoad; recoveryAfterLoad = null; recovered(results); }
    },
    source(url) { $('#input-preview').src = url; $('#input-preview').hidden = false; },
    cancelChain,
    show(value) { const returning = value && !visible; visible = value; if (!value) cancelChain(); else if (returning && client) void recover(); },
    recovered,
    retry(action) {
      if (busy) return;
      if (['continue', 'stop'].includes(action.kind)) { retryAction = action; feedback('将使用原身份接回此操作，请确认后点击。'); controls(); return; }
      beginDraft({ artifactId: ['flow-create', 'transcription-create'].includes(action.kind) ? action.artifactId : undefined,
        mode: ({ 'generation-create': 'generate', 'audio-import': 'transcribe', 'transcription-create': 'transcribe', 'speech-create': 'tts' })[action.kind] || 'edit' });
      retryAction = action; feedback(IMPORTS.includes(action.kind) ? '请重新提供原素材字节，再按原 Key 接回。' : '请重新提供原模型、要求与参数，再按原 Key 接回。'); controls();
    },
    async refresh() { if (activeOperation && ACTIVE.has(activeOperation.state)) watch(activeOperation); controls(); },
    disconnect() {
      epoch++; intent++; stopWatch(); client = media = session = null; view = null; draft = {}; models = []; busy = stopping = loading = false; job = activeOperation = retryAction = recoveryAfterLoad = null;
      releasePreview(); $('#input-preview').removeAttribute('src'); $('#input-preview').hidden = true; $('#image-file').value = '';
      $('#audio-file').value = ''; $('#audio-file-name').textContent = 'WAV / MP3 / OGG / FLAC，最大20 MiB。'; $('#speech-voice').value = '';
      $('#edit-prompt').value = ''; $('#edit-size').value = ''; fillModels(); renderComfy(true); feedback(); controls();
    }
  });
}
