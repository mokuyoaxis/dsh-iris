/** 执行真实作品组件的交互；React/DOM fixture，不冒充浏览器目视验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
const exposed = source.replace(anchor, 'window.__gallery = ArtifactGallery; window.__analysis = ArtifactAnalysis;\n    ' + anchor);
const tick = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');

function fixture() {
  let entry, current, cursor = 0, holdActions = false, holdLists = false, actionStatus = 'complete', httpOk = true;
  let activePanel;
  const instances = new Map(), effects = [], events = new Map(), requests = [], pending = [], copied = [], downloads = [], blobs = new Map(), scrolls = [];
  const image = { id: 'artifact_' + 'a'.repeat(24), file: 'original.png', mime: 'image/png', source: 'core', kind: 'generated-image', size: 123, createdAt: '2026-10-08', url: '/image' };
  const legacy = { ...image, id: 'a_' + 'c'.repeat(24), source: 'legacy', kind: 'legacy-output' };
  const video = { ...image, id: 'artifact_' + 'b'.repeat(24), mime: 'video/mp4', kind: 'generated-video' };
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
      const body = { total: 49, offset, limit: 24, counts: { core: 48, legacy: 1 }, kinds: ['generated-image', 'generated-video', 'legacy-output'], items: offset ? [image] : [image, legacy, video] };
      if (holdLists) return new Promise(resolve => pending.push({ record, resolve: () => resolve(response(body)) }));
      return response(body);
    }
    const body = { ok: actionStatus !== 'failed', status: actionStatus, artifactId: record.body?.artifact_id,
      text: httpOk ? '识别正文 · ' + actionStatus : undefined, error: httpOk ? undefined : '模型不可用' };
    if (holdActions) return new Promise(resolve => pending.push({ record, resolve: () => resolve(response(body, httpOk)) }));
    return response(body, httpOk);
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); }, confirm() { return true; } };
  const FakeURL = class extends URL {};
  FakeURL.createObjectURL = blob => { const url = 'blob:' + blobs.size; blobs.set(url, blob); return url; };
  FakeURL.revokeObjectURL = () => {};
  const document = { getElementById() { return {}; }, createElement(type) { assert.equal(type, 'a'); return { click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }; } };
  vm.runInNewContext(exposed, { window, document, fetch, URL: FakeURL, Blob, AbortController, setTimeout,
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
    const panel = nodes(tree).find(node => node.type === window.__analysis);
    const next = panel ? 'panel:' + panel.props.key : null;
    if (activePanel && activePanel !== next) unmount(activePanel);
    activePanel = next;
    if (panel) panel.tree = renderOne(next, window.__analysis, panel.props);
    return [tree, ...(panel ? [panel.tree] : [])];
  }
  const button = text => nodes(render()).find(node => node.type === 'button' && label(node) === text);
  const click = text => { const node = button(text); assert(node, text); assert(!node.props.disabled, text + ' disabled'); node.props.onClick(); render(); };
  const change = (name, value) => { nodes(render()).find(node => node.type === 'select' && node.props['aria-label'] === name).props.onChange({ target: { value } }); render(); };
  return { render, button, click, change, requests, pending, copied, downloads, scrolls,
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
console.log('ALL OK —— 实际作品组件交互：分页/过滤/刷新、Core ID 识图、复制/下载、OCR 部分/失败、取消/切换/卸载与迟到结果');
