// Finite user actions; reopening a Run never invokes continue.
const $ = selector => document.querySelector(selector);
const ACTIVE = new Set(['queued', 'running']);
const labels = { not_started: '开始改图', running: '查看原任务', delivery_failed: '恢复原结果', needs_comparison: '完成比较', needs_result: '接回结果' };
export function createCreationPanel({ openRun, refreshHistory, showDraft, describe, recover, renderOperation }) {
  let client, media, session, view = null, draft = {}, models = [], epoch = 0, intent = 0;
  let busy = false, stopping = false, loading = false, visible = true, job = null, activeOperation = null, timer, watchTicket = 0;
  let preview, retryAction = null, recoveryAfterLoad = null;
  const cap = name => Boolean(session?.operations.includes(name));
  const generating = () => view ? view.recipe === 'image-generate/v0' : draft.mode === 'generate';
  const createCapability = () => generating() ? 'generations.create' : 'runs.create';
  const valid = at => at === epoch && Boolean(client);
  const validJob = task => valid(task.epoch) && task.intent === intent && visible && job === task;
  function feedback(text = '', error = false) {
    $('#creation-feedback').hidden = !text; $('#creation-feedback').textContent = text;
    $('#creation-feedback').classList.toggle('error', error);
  }
  function releasePreview() { if (preview) URL.revokeObjectURL(preview); preview = null; }
  function stopWatch() { clearTimeout(timer); watchTicket++; }
  function controls() {
    const generate = generating();
    const pending = media?.snapshot(), unresolved = pending?.actions.some(action => ['image-import', 'flow-create', 'generation-create'].includes(action.kind)
      || view && action.runId === view.id);
    $('#draft-fields').disabled = !client || busy || loading || Boolean(view) || !(cap('runs.create') || cap('generations.create'));
    for (const button of document.querySelectorAll('[data-creation-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.creationMode === (generate ? 'generate' : 'edit')));
      button.disabled = !cap(button.dataset.creationMode === 'generate' ? 'generations.create' : 'runs.create');
    }
    $('#source-input').hidden = generate;
    $('#prompt-label').textContent = generate ? '想画些什么？' : '想改些什么？';
    $('#edit-prompt').placeholder = generate ? '描述画面、人物、色彩与风格…' : '描述想保留的细节，以及想尝试的变化…';
    const canCreate = cap(createCapability()) && cap('runs.continue') && (generate || cap('images.create') && Boolean(draft.file || draft.artifactId))
      && Boolean($('#model').value) && Boolean($('#edit-prompt').value.trim());
    const canContinue = view && cap('runs.continue') && Object.hasOwn(labels, view.status);
    const canRetry = retryAction && (retryAction.kind === 'image-import' ? cap('images.create') && Boolean(draft.file)
      : ['flow-create', 'generation-create'].includes(retryAction.kind) ? cap(createCapability()) && Boolean((generate || draft.artifactId) && $('#model').value && $('#edit-prompt').value.trim())
        : cap(retryAction.kind === 'stop' ? 'operations.stop' : 'runs.continue'));
    $('#start-edit').disabled = !client || busy || stopping || loading || pending?.blocked || unresolved && !retryAction
      || Boolean(activeOperation && ACTIVE.has(activeOperation.state)) || !(retryAction ? canRetry : view ? canContinue : canCreate);
    $('#start-edit').textContent = busy ? '正在处理…' : retryAction ? '按原 Key 接回' : view && view.status !== 'not_started'
      ? labels[view.status] || '查看已有作品' : generate ? '开始生成' : '开始改图';
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
        : !cap('runs.continue') ? cap('runs.select') ? '当前可选择已有作品。开始改图需要显式开启执行服务。' : '当前服务只读，可浏览和下载已有选择。'
          : !view && !models.some(model => generate || model.supportsImageEdit) ? '尚无可用图片候选。可在供应商页配置模型。'
            : view?.status === 'needs_attention' ? '先核对原任务；受理未知时请避免重复生成。'
              : '明确执行可能产生供应商费用。刷新不会自动生成。';
    $('#creation-settings').dataset.fixed = String(Boolean(view));
  }
  function fillModels(selected = '') {
    const candidates = models.filter(model => generating() || model.supportsImageEdit);
    $('#model').replaceChildren(new Option(candidates.length ? '选择一个图片模型' : '没有可用图片候选', ''));
    for (const model of candidates) $('#model').append(new Option(model.displayName + ' · ' + model.modelRef, model.modelRef));
    if (selected && !candidates.some(model => model.modelRef === selected)) $('#model').append(new Option(selected + ' · 原流程模型', selected));
    $('#model').value = selected;
  }
  function cancelChain() { intent++; stopWatch(); }
  function beginDraft({ file, artifactId, label, modelRef = '', mode = file || artifactId ? 'edit' : cap('generations.create') ? 'generate' : 'edit' } = {}) {
    cancelChain(); loading = false; recoveryAfterLoad = null; retryAction = null; activeOperation = null; view = null; draft = { file, artifactId, mode };
    releasePreview(); if (file) preview = URL.createObjectURL(file);
    $('#input-preview').hidden = !preview; $('#input-preview').removeAttribute('src'); if (preview) $('#input-preview').src = preview;
    $('#file-name').textContent = label || file?.name || (artifactId ? '已选作品' : '选择一张图片');
    $('#image-file').value = ''; $('#edit-prompt').value = ''; $('#edit-size').value = ''; fillModels(modelRef);
    $('#input-summary').textContent = mode === 'generate' ? '从一句想法开始' : file || artifactId ? '填写你的修改要求' : '从一张图片开始';
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
  async function finishOperation(operation, at, ticket) {
    if (!valid(at) || ticket !== watchTicket || !visible) return;
    activeOperation = operation; renderOperation(operation);
    if (ACTIVE.has(operation.state)) return;
    stopWatch(); await recover();
    if (!valid(at) || !visible || view?.id !== operation.runId) return;
    await openRun(operation.runId, { fromAction: true });
    if (!valid(at)) return;
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
    const task = { epoch, intent, runId: view?.id }; job = task; busy = true; controls();
    const generate = generating();
    const input = { ...(!generate ? { sourceArtifactId: draft.artifactId } : {}), modelRef: $('#model').value, prompt: $('#edit-prompt').value,
      ...($('#edit-size').value.trim() ? { size: $('#edit-size').value.trim() } : {}) };
    const file = draft.file, original = retryAction;
    try {
      if (original) {
        const value = await media.retry(original.id, original.kind === 'image-import' ? file : ['flow-create', 'generation-create'].includes(original.kind) ? input : undefined);
        if (!validJob(task)) return;
        retryAction = null;
        if (original.kind === 'image-import') { draft.artifactId = value.artifact.artifactId; feedback('原素材已接回。再次明确开始时才会创建并执行。'); }
        else if (['flow-create', 'generation-create'].includes(original.kind)) { await openRun(value.flow.id, { fromAction: true }); feedback('原流程已接回，尚未自动开始。'); }
        else { watch(value.operation); feedback('已接回原操作。'); }
        await recover(); return;
      }
      if (!view) {
        if (!generate && !input.sourceArtifactId) {
          feedback('正在保存素材…'); const imported = await media.uploadImage(file);
          if (!validJob(task)) return; draft.artifactId = input.sourceArtifactId = imported.artifact.artifactId;
        }
        feedback('正在建立流程…'); const created = await media[generate ? 'createGeneration' : 'createRun'](input);
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
    const prompt = $('#edit-prompt').value, size = $('#edit-size').value;
    beginDraft({ mode: button.dataset.creationMode }); $('#edit-prompt').value = prompt; $('#edit-size').value = size; controls();
  });
  $('#image-file').addEventListener('change', event => { void chooseFile(event.target.files[0]); event.target.value = ''; });
  for (const id of ['model', 'edit-prompt', 'edit-size']) $('#' + id).addEventListener('input', controls);
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
    setModels(values) { const selected = $('#model').value; models = values; fillModels(selected); controls(); },
    beginDraft,
    loading() { loading = true; recoveryAfterLoad = null; stopWatch(); controls(); },
    view(value, { sameRun = false } = {}) {
      const changed = view?.id !== value.id;
      loading = false; view = value; retryAction = null;
      if (changed) { activeOperation = null; stopWatch(); }
      if (!sameRun) { fillModels(value.input.modelRef); $('#edit-prompt').value = value.input.prompt; $('#edit-size').value = value.input.size || '';
        $('#input-summary').textContent = value.input.modelRef; $('#file-name').textContent = '流程原图';
        if (matchMedia('(max-width:640px)').matches) $('#creation-settings').open = false; }
      controls();
      if (recoveryAfterLoad) { const results = recoveryAfterLoad; recoveryAfterLoad = null; recovered(results); }
    },
    source(url) { $('#input-preview').src = url; $('#input-preview').hidden = false; },
    cancelChain,
    show(value) { const returning = value && !visible; visible = value; if (!value) cancelChain(); else if (returning && client) void recover(); },
    recovered,
    retry(action) {
      if (busy) return;
      if (['continue', 'stop'].includes(action.kind)) { retryAction = action; feedback('将使用原身份接回此操作，请确认后点击。'); controls(); return; }
      beginDraft({ artifactId: action.kind === 'flow-create' ? action.artifactId : undefined, mode: action.kind === 'generation-create' ? 'generate' : 'edit' });
      retryAction = action; feedback(action.kind === 'image-import' ? '请重新提供原图片字节，再按原 Key 接回。' : '请重新提供原模型、要求与参数，再按原 Key 接回。'); controls();
    },
    async refresh() { if (activeOperation && ACTIVE.has(activeOperation.state)) watch(activeOperation); controls(); },
    disconnect() {
      epoch++; intent++; stopWatch(); client = media = session = null; view = null; draft = {}; models = []; busy = stopping = loading = false; job = activeOperation = retryAction = recoveryAfterLoad = null;
      releasePreview(); $('#input-preview').removeAttribute('src'); $('#input-preview').hidden = true; $('#image-file').value = '';
      $('#edit-prompt').value = ''; $('#edit-size').value = ''; fillModels(); feedback(); controls();
    }
  });
}
