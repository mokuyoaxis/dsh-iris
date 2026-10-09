/** 执行真实作品组件的交互；React/DOM fixture，不冒充浏览器目视验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
const exposed = source.replace(anchor, 'window.__gallery = ArtifactGallery; window.__analysis = ArtifactAnalysis; window.__edit = ArtifactImageEdit; window.__management = WorkbenchManagement;\n    ' + anchor);
const tick = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');

function fixture() {
  let entry, current, cursor = 0, holdActions = false, holdLists = false, actionStatus = 'complete', httpOk = true;
  let activePanel;
  let holdWorks = false, confirmation = true, workError = '', referencingTasks = [], listSize = 0;
  let transactionState = 'committed';
  let editModels = [
    { id: 'chat-image', capabilities: ['image-gen'], imageRouting: { mediaProtocol: 'openai-chat-images' } },
    { id: 'ordinary', capabilities: ['image-gen'], imageRouting: { mediaProtocol: 'openai-images' } },
    { id: 'cooling', capabilities: ['image-gen'], imageRouting: { mediaProtocol: 'openai-chat-images' }, health: { 'image-gen': { rateLimited: true } } }
  ];
  const instances = new Map(), effects = [], events = new Map(), requests = [], pending = [], copied = [], downloads = [], blobs = new Map(), scrolls = [];
  const image = { id: 'artifact_' + 'a'.repeat(24), file: 'original.png', mime: 'image/png', source: 'core', kind: 'generated-image', size: 123, createdAt: '2026-10-08', url: '/image' };
  const legacy = { ...image, id: 'a_' + 'c'.repeat(24), source: 'legacy', kind: 'legacy-output' };
  const video = { ...image, id: 'artifact_' + 'b'.repeat(24), mime: 'video/mp4', kind: 'generated-video' };
  const extra = { ...image, id: 'artifact_' + 'd'.repeat(24) };
  const transactionId = 'delete_' + 'e'.repeat(24);
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++, hooks = current.hooks;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!current.hooks[index]) current.hooks[index] = { current: initial }; return current.hooks[index]; },
    useEffect(run, deps) {
      const index = cursor++, instance = current, hook = instance.hooks[index];
      if (!hook || deps.some((value, i) => value !== hook.deps[i])) {
        instance.hooks[index] = { deps, cleanup: hook?.cleanup };
        effects.push(() => { instance.hooks[index].cleanup?.(); instance.hooks[index].cleanup = run(); });
      }
    }
  };
  function response(body, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => body }; }
  const fetch = async (url, options = {}) => {
    const isList = url.startsWith('/iris/api/works?');
    const record = { url, signal: options.signal, body: options.body ? JSON.parse(options.body) : null }; requests.push(record);
    if (isList) {
      const query = new URL(url, 'http://fixture');
      const offset = Number(query.searchParams.get('offset'));
      const body = { total: listSize || 49, offset, limit: 24, counts: { core: 48, legacy: 1 }, kinds: ['generated-image', 'generated-video', 'legacy-output'],
        items: listSize ? Array.from({ length: Math.min(24, listSize - offset) }, (_, i) => ({ ...image, id: 'artifact_' + (offset + i + 1).toString(16).padStart(24, '0') }))
          : offset ? [image, extra] : [image, legacy, video] };
      if (holdLists) return new Promise(resolve => pending.push({ record, resolve: () => resolve(response(body)) }));
      return response(body);
    }
    if (url.startsWith('/iris/api/works/')) {
      const download = url.endsWith('/download');
      let body;
      if (url.endsWith('/delete')) {
        const input = record.body;
        body = input.confirm_delete ? { ok: true, state: 'committed', recoverable: true, transactionId }
          : { ok: true, preview: true, files: 3, bytes: 123, referencingTasks,
            allowed: referencingTasks.every(task => task.settled && (input.task_ids || []).includes(task.id)),
            blockers: referencingTasks.filter(task => !(input.task_ids || []).includes(task.id)).map(task => ({ reason: 'task_artifact_reference', id: input.artifact_ids[0], referencedBy: task.id })) };
      } else if (url.endsWith('/restore')) { transactionState = 'restored'; body = { ok: true, state: 'restored', transactionId }; }
      else if (url.endsWith('/transactions')) body = { ok: true, transactions: [{ transactionId, state: transactionState, operation: 'delete', files: 3, createdAt: '2026-10-08' }] };
      else body = { item: { ...image, id: url.split('/').at(-1), integrity: 'verified', digest: 'f'.repeat(64), relations: [], metadata: { width: 8, height: 6 } } };
      if (workError) body = { error: workError };
      const result = { ...response(body, !workError), blob: async () => new Blob(['ZIP fixture'], { type: 'application/zip' }) };
      if (holdWorks) return new Promise(resolve => pending.push({ record, download, resolve: () => resolve(result) }));
      return result;
    }
    if (url.endsWith('/providers_list')) return response({ ok: true, providers: [{ id: 'gateway', name: '网关', enabled: true, models: editModels }] });
    const body = { ok: actionStatus !== 'failed', status: actionStatus, artifactId: record.body?.artifact_id,
      ...(url.endsWith('/image_edit') ? { artifactIds: ['artifact_' + 'f'.repeat(24)], taskId: 'task_' + 'e'.repeat(24) } : {}),
      text: httpOk ? '识别正文 · ' + actionStatus : undefined, error: httpOk ? undefined : '模型不可用' };
    if (holdActions) return new Promise(resolve => pending.push({ record, resolve: () => resolve(response(body, httpOk)) }));
    return response(body, httpOk);
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(); }, confirm() { return confirmation; } };
  const FakeURL = class extends URL {};
  FakeURL.createObjectURL = blob => { const url = 'blob:' + blobs.size; blobs.set(url, blob); return url; };
  FakeURL.revokeObjectURL = () => {};
  const document = { getElementById() { return {}; }, createElement(type) { assert.equal(type, 'a'); return { click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }; } };
  vm.runInNewContext(exposed, { window, document, fetch, URL: FakeURL, Blob, AbortController, setTimeout, CustomEvent: class { constructor(type) { this.type = type; } },
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } }, console: { log() {}, error() {} } });
  entry.factory(name => { assert.equal(name, 'react'); return react; }).apply({ slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } } });
  function renderOne(id, component, props) {
    if (!instances.has(id)) instances.set(id, { hooks: [] }); current = instances.get(id); cursor = 0;
    const tree = component(props);
    for (const node of nodes(tree)) if (node.props.ref) node.props.ref.current = { scrollIntoView(options) { scrolls.push(options); } };
    for (const effect of effects.splice(0)) effect(); return tree;
  }
  function unmount(id) { for (const hook of instances.get(id)?.hooks || []) hook?.cleanup?.(); instances.delete(id); }
  function render() {
    const tree = renderOne('gallery', window.__gallery, {});
    const panel = nodes(tree).find(node => node.type === window.__analysis || node.type === window.__edit || node.type === window.__management);
    const next = panel ? 'panel:' + panel.props.key : null;
    if (activePanel && activePanel !== next) unmount(activePanel);
    activePanel = next;
    if (panel) panel.tree = renderOne(next, panel.type, panel.props);
    return [tree, ...(panel ? [panel.tree] : [])];
  }
  const button = text => nodes(render()).find(node => node.type === 'button' && label(node) === text);
  const click = text => { const node = button(text); assert(node, text); assert(!node.props.disabled, text + ' disabled'); node.props.onClick(); render(); };
  const change = (name, value) => { nodes(render()).find(node => node.type === 'select' && node.props['aria-label'] === name).props.onChange({ target: { value } }); render(); };
  const check = (name, checked) => { const input = nodes(render()).find(node => node.type === 'input' && node.props['aria-label'] === name);
    assert(input && !input.props.disabled, name); input.props.onChange({ target: { checked } }); render(); };
  return { render, button, click, change, requests, pending, copied, downloads, scrolls,
    setEditModels(value) { editModels = value; },
    input(name, value) { const node = nodes(render()).find(node => node.props['aria-label'] === name); assert(node, name); node.props.onChange({ target: { value } }); render(); },
    check, setHoldWorks(value) { holdWorks = value; }, setConfirmation(value) { confirmation = value; },
    setWorkError(value) { workError = value; }, setReferencingTasks(value) { referencingTasks = value; }, setListSize(value) { listSize = value; },
    setHoldActions(value) { holdActions = value; }, setHoldLists(value) { holdLists = value; },
    setStatus(value) { actionStatus = value; }, setHttpOk(value) { httpOk = value; },
    event(name) { for (const fn of events.get(name) || []) fn(); },
    close() { if (activePanel) unmount(activePanel); unmount('gallery'); },
    get actionRequests() { return requests.filter(item => item.url.startsWith('/iris/api/actions/')); } };
}

const ui = fixture(); ui.render(); await tick();
assert.equal(ui.actionRequests.length, 0, '浏览作品不启动模型');
assert(ui.button('上一页').props.disabled); assert(!ui.button('下一页').props.disabled);
const cards = nodes(ui.render()).filter(node => node.props.className === 'iris-gallery-card');
assert.equal(cards.length, 3);
assert.equal(nodes(cards[0]).filter(node => node.type === 'button' && ['看图', 'OCR'].includes(label(node))).length, 2);
assert.equal(nodes(cards[1]).filter(node => ['看图', 'OCR'].includes(label(node))).length, 0, '旧版 ID 不作为 Core 输入');
assert.equal(nodes(cards[2]).filter(node => ['看图', 'OCR'].includes(label(node))).length, 0, '非图片无识图入口');
ui.click('下一页'); await tick();
assert(ui.requests.at(-1).url.includes('offset=24'));
ui.click('刷新'); await tick(); assert(ui.requests.at(-1).url.includes('offset=24'));
ui.click('看图'); await tick();
assert.equal(ui.scrolls.at(-1).block, 'nearest', '卡片点击使结果面板可见');
assert.equal(ui.actionRequests.at(-1).body.artifact_id, 'artifact_' + 'a'.repeat(24));
assert.equal(ui.actionRequests.at(-1).body.image_path, undefined);
assert(nodes(ui.render()).some(node => label(node) === '完成'));
ui.click('复制文本'); await tick(); assert.equal(ui.copied.at(-1), '识别正文 · complete');
ui.click('下载文本'); assert(ui.downloads.at(-1).name.endsWith('-look.txt')); assert.equal(await ui.downloads.at(-1).blob.text(), '识别正文 · complete');
ui.click('关闭结果'); assert(!ui.button('关闭结果'));
assert(nodes(ui.render()).some(node => label(node) === '第 2 / 3 页'), '关闭结果保留页码');
ui.change('媒体类型', 'image'); await tick();
assert(ui.requests.at(-1).url.includes('offset=0') && ui.requests.at(-1).url.includes('media_type=image'));
ui.change('作品来源', 'core'); await tick(); ui.change('产物类型', 'generated-image'); await tick();
ui.click('刷新'); await tick(); assert(ui.requests.at(-1).url.includes('kind=generated-image'));
ui.event('iris-core-refresh-tick'); await tick(); assert(ui.requests.at(-1).url.includes('kind=generated-image'));
// 旧版扫描结束后的刷新必须使用此刻的筛选，不能用操作开始时的闭包覆盖新列表。
ui.setHoldActions(true); ui.click('扫描旧版 outputs'); const scanning = ui.pending.at(-1);
ui.change('媒体类型', 'audio'); await tick(); scanning.resolve(); await tick();
assert(ui.requests.at(-1).url.includes('media_type=audio'));
ui.setHoldActions(false); ui.change('媒体类型', 'image'); await tick();

ui.setStatus('partial'); ui.click('OCR'); await tick();
assert.equal(ui.actionRequests.at(-1).body.chunk_height, 1200); assert.equal(ui.actionRequests.at(-1).body.overlap, 120);
assert(nodes(ui.render()).some(node => label(node) === '部分完成'));
ui.setStatus('failed'); ui.click('按当前选项重新识别'); await tick();
assert(nodes(ui.render()).some(node => label(node) === '失败'), 'HTTP 200 + ok:false 不显示成功');
ui.setHttpOk(false); ui.click('按当前选项重新识别'); await tick();
assert(nodes(ui.render()).some(node => node.type === 'textarea' && node.props.value === '模型不可用'));

ui.setHttpOk(true); ui.setStatus('complete'); ui.setHoldActions(true);
ui.click('按当前选项重新识别');
const canceled = ui.pending.at(-1); ui.click('取消识别'); assert(canceled.record.signal.aborted);
canceled.resolve(); await tick(); assert(nodes(ui.render()).some(node => label(node) === '已取消'), '取消后迟到正文不能恢复成功');
ui.click('按当前选项重新识别'); const closing = ui.pending.at(-1);
ui.click('关闭结果'); assert(closing.record.signal.aborted);
ui.click('看图'); const newer = ui.pending.at(-1);
closing.resolve(); await tick(); assert(ui.button('取消识别'), '旧 OCR 迟到结果不能覆盖新看图');
newer.resolve(); await tick(); assert(nodes(ui.render()).some(node => label(node) === '完成'));
ui.click('OCR'); const switching = ui.pending.at(-1);
ui.click('看图'); assert(switching.record.signal.aborted, '切换作品分析取消前一次识别');
ui.close(); assert(ui.pending.at(-1).record.signal.aborted, '卸载取消当前识别');

const races = fixture(); races.setHoldLists(true); races.render();
const oldList = races.pending[0]; races.change('媒体类型', 'audio');
assert(oldList.record.signal.aborted); const nextList = races.pending[1];
oldList.resolve(); await tick(); assert(races.button('下一页').props.disabled, '旧列表不能覆盖新过滤');
nextList.resolve(); await tick(); assert(!races.button('下一页').props.disabled); races.close();

const bulk = fixture(); bulk.render(); await tick();
bulk.click('选择本页'); assert(bulk.button('删除选中 Core 作品').props.disabled, '混合来源不能进入 Core 批量删除');
bulk.click('下一页'); await tick(); bulk.click('选择本页');
assert(nodes(bulk.render()).some(node => label(node).startsWith('已选择 4 / 200')), '跨页选择按来源/ID 去重');
bulk.click('刷新'); await tick(); bulk.click('复制选中 ID'); await tick();
assert.equal(new Set(bulk.copied.at(-1).split('\n')).size, 4);
bulk.click('下载选中作品'); await tick(); assert.equal(bulk.downloads.at(-1).name, 'iris-works.zip');
const downloadInput = bulk.requests.find(request => request.url.endsWith('/download')).body;
assert.equal(downloadInput.items.length, 4); assert(downloadInput.items.some(item => item.source === 'legacy'));
assert(downloadInput.items.every(item => Object.keys(item).length === 2), '只发送来源和 ID，不发送宿主路径/token');
bulk.change('作品来源', 'core'); await tick();
assert(bulk.button('复制选中 ID').props.disabled, '切换筛选清空选择');
bulk.check('选择作品 artifact_' + 'a'.repeat(24), true);
bulk.click('详情'); await tick(); assert(nodes(bulk.render()).some(node => label(node) === 'SHA-256 已核验'));
bulk.click('关闭面板'); assert(nodes(bulk.render()).some(node => label(node).startsWith('已选择 1 / 200')));
bulk.click('删除选中 Core 作品'); await tick();
assert.equal(bulk.requests.at(-1).body.confirm_delete, undefined, '打开删除面板只做预览');
bulk.setConfirmation(false); const requestCount = bulk.requests.length; bulk.click('确认移入回收区'); await tick();
assert.equal(bulk.requests.length, requestCount, '用户取消确认时零执行');
bulk.setConfirmation(true); bulk.click('确认移入回收区'); await tick();
assert(bulk.requests.some(request => request.body?.confirm_delete === true));
assert(bulk.button('复制选中 ID').props.disabled, '完成删除清空选择并刷新作品');
bulk.click('Core 回收区'); await tick(); bulk.click('恢复'); await tick();
assert(bulk.requests.some(request => request.body?.confirm_restore === true));
assert(bulk.button('恢复').props.disabled, '已恢复事务不能重复恢复');
bulk.click('关闭面板');
const taskId = 'task_' + 'f'.repeat(24); bulk.setReferencingTasks([{ id: taskId, settled: true }]);
bulk.click('移入回收区'); await tick(); assert(bulk.button('确认移入回收区').props.disabled);
bulk.check('关联任务 ' + taskId, true); await tick();
assert.deepEqual(bulk.requests.at(-1).body.task_ids, [taskId]);
assert(!bulk.button('确认移入回收区').props.disabled, '显式勾选关联的已结束任务后重新预览');
bulk.click('关闭面板'); bulk.setReferencingTasks([{ id: taskId, settled: false }]);
bulk.click('移入回收区'); await tick();
assert(nodes(bulk.render()).find(node => node.props['aria-label'] === '关联任务 ' + taskId).props.disabled);
bulk.click('关闭面板'); bulk.setWorkError('恢复目标已存在，未覆盖已有作品');
bulk.click('Core 回收区'); await tick();
assert(nodes(bulk.render()).some(node => label(node) === '恢复目标已存在，未覆盖已有作品'));
bulk.click('关闭面板'); bulk.setWorkError(''); bulk.close();

const cancelBulk = fixture(); cancelBulk.render(); await tick(); cancelBulk.click('选择本页'); cancelBulk.setHoldWorks(true);
cancelBulk.click('下载选中作品'); const canceledDownload = cancelBulk.pending.at(-1); cancelBulk.click('取消下载');
assert(canceledDownload.record.signal.aborted); canceledDownload.resolve(); await tick(); assert.equal(cancelBulk.downloads.length, 0);
cancelBulk.click('详情'); const oldDetail = cancelBulk.pending.at(-1); cancelBulk.click('关闭面板');
assert(oldDetail.record.signal.aborted); cancelBulk.click('Core 回收区'); oldDetail.resolve(); await tick();
assert(!nodes(cancelBulk.render()).some(node => label(node) === 'SHA-256 已核验'), '旧详情不能覆盖新回收区'); cancelBulk.close();

const limits = fixture(); limits.setListSize(240); limits.render(); await tick();
for (let page = 0; page < 8; page++) { limits.click('选择本页'); limits.click('下一页'); await tick(); }
limits.click('选择本页');
assert(nodes(limits.render()).some(node => label(node).startsWith('已选择 192 / 200')), '超限整页选择拒绝，不隐式截断');
assert(nodes(limits.render()).some(node => label(node).includes('最多选择 200 个作品'))); limits.close();
const edits = fixture(); edits.render(); await tick();
const editCards = nodes(edits.render()).filter(node => node.props.className === 'iris-gallery-card');
assert.equal(nodes(editCards[0]).filter(node => label(node) === '改图').length, 1);
assert.equal(nodes(editCards[1]).filter(node => label(node) === '改图').length, 0, '旧版作品不能传入 Core 编辑');
assert.equal(nodes(editCards[2]).filter(node => label(node) === '改图').length, 0, '视频没有图片编辑入口');
edits.click('改图'); await tick();
assert.equal(edits.actionRequests.filter(request => request.url.endsWith('/image_edit')).length, 0, '打开面板不调用模型');
assert(edits.button('生成修改版').props.disabled, '修改指令必填');
const editOptions = nodes(edits.render()).filter(node => node.type === 'option');
assert(!editOptions.some(node => node.props.value === 'gateway::ordinary'), '只列出聊天生图模型');
assert(editOptions.find(node => node.props.value === 'gateway::cooling').props.disabled, '冷却模型不能选择');
edits.input('修改指令', '  把红色改成绿色  '); edits.change('改图模型', 'gateway::chat-image');
edits.click('生成修改版'); await tick();
const editRequest = edits.actionRequests.find(request => request.url.endsWith('/image_edit'));
assert.deepEqual(editRequest.body, { source_artifact_id: 'artifact_' + 'a'.repeat(24), prompt: '把红色改成绿色', model: 'gateway::chat-image' });
assert(nodes(edits.render()).some(node => node.type === 'a' && label(node).startsWith('打开新作品：')));
assert(edits.requests.at(-1).url.startsWith('/iris/api/works?'), '成功生成刷新作品区');
edits.setHoldActions(true); edits.click('生成修改版'); const stoppedEdit = edits.pending.at(-1);
assert(edits.button('编辑中…').props.disabled, '正在编辑不能再次提交');
edits.click('停止等待'); assert(stoppedEdit.record.signal.aborted);
stoppedEdit.resolve(); await tick();
assert(nodes(edits.render()).some(node => label(node).includes('已停止等待')), '迟到结果不能覆盖停止等待');
edits.click('生成修改版'); const closingEdit = edits.pending.at(-1); edits.click('关闭改图');
assert(closingEdit.record.signal.aborted); closingEdit.resolve(); await tick();
edits.click('改图'); await tick(); edits.input('修改指令', '保留构图'); edits.click('生成修改版');
const unmountEdit = edits.pending.at(-1); edits.close(); assert(unmountEdit.record.signal.aborted);
const noEdit = fixture(); noEdit.setEditModels([]); noEdit.render(); await tick(); noEdit.click('改图'); await tick();
noEdit.input('修改指令', '改颜色'); assert(noEdit.button('生成修改版').props.disabled, '没有支持改图的模型时不发请求'); noEdit.close();
console.log('ALL OK —— 实际作品组件：分页/过滤、Core ID 识图与改图、模型协议/冷却过滤、来源与结果、批量下载/删除/恢复、取消和迟到结果');
