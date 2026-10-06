/** 执行真实泡泡组件的点击/编辑路径；React/DOM stub，不声称浏览器视觉验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assemblePrompt } from '../lib/prompt-optimizer-core.js';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const anchor = 'var clientSlots = clientSlotsPort(ctx);';
assert.equal(source.split(anchor).length, 2);
const exposed = source.replace(anchor, 'window.__promptForTest = PromptOptimizerControl; window.__changesForTest = promptChanges;\n    ' + anchor);
const tick = () => new Promise(resolve => setImmediate(resolve));
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');

async function fixture({ supports = true } = {}) {
  let entry, cursor = 0, draft = '  画一只猫  ', phase = 'plain', occurrences = [], hold = false, confirm = false;
  const hooks = [], effects = [], requests = [], writes = [], pending = [], copied = [];
  let confirmations = 0;
  const config = { source: 'default', config: { enabled: true, route: { mode: 'session' }, generation: { reasoningEffort: 'off-if-supported', maxOutputTokens: 1200 } },
    ...(supports ? { capabilities: { rules: true, assemble: true } } : {}) };
  const react = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!hooks[index]) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect(run, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, i) => value !== hooks[index].deps[i])) {
        effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: run() }; });
      }
    }
  };
  function response(body) { return { ok: true, json: async () => body }; }
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/config')) return response(config);
    if (!url.endsWith('/optimize')) return response({});
    const body = JSON.parse(options.body);
    requests.push({ body, signal: options.signal });
    const result = body.mode === 'assemble' ? { ...assemblePrompt(body), route: null }
      : { ok: true, original: body.text, optimized: '模型优化后的正文', target: body.target, mode: 'optimize', rules: body.rules,
        route: { provider: 'p', model: 'm', reasoningEffort: 'provider-default' } };
    if (hold) return new Promise(resolve => pending.push({ resolve: () => resolve(response(result)) }));
    return response(result);
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } }, fetch,
    addEventListener() {}, removeEventListener() {}, confirm() { confirmations++; return confirm; } };
  vm.runInNewContext(exposed, { window, fetch, AbortController, navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    document: { getElementById() { return {}; } }, console: { log() {}, error() {} } });
  const module = entry.factory(name => { assert.equal(name, 'react'); return react; });
  module.apply({ slots: { inject(_name, run) { return run(); }, register() { return () => {}; } } });
  const props = { sessionId: 's', useInput(select) { return select({ draft, phase, occurrences }); },
    useProjection() { return { current: { provider: 'p', model: 'm' } }; },
    inputActions: { setDraft(value) { writes.push(value); draft = value; }, submit() { throw new Error('must not auto-send'); } } };
  const render = () => { cursor = 0; const tree = window.__promptForTest(props); for (const run of effects.splice(0)) run(); return tree; };
  const button = text => nodes(render()).find(node => node.type === 'button' && label(node) === text);
  const click = text => { const node = button(text); assert(node, text); assert(!node.props.disabled, `${text} disabled`); node.props.onClick(); };
  const field = text => {
    const node = nodes(render()).find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && label(child) === text));
    assert(node, text); return nodes(node).find(child => child.type === 'textarea');
  };
  const edit = (text, value) => { const node = field(text); assert(!node.props.disabled); node.props.onChange({ target: { value } }); };
  render(); await tick();
  // 触发器没有文本，按 aria-expanded 找到实际入口。
  nodes(render()).find(node => node.type === 'button' && node.props['aria-expanded'] !== undefined).props.onClick();
  return { render, button, click, edit, requests, writes, pending, copied,
    setDraft(value) { draft = value; }, setReferences(value) { occurrences = value; }, setPhase(value) { phase = value; },
    setConfirm(value) { confirm = value; }, setHold(value) { hold = value; }, get confirmations() { return confirmations; },
    setSession(value) { props.sessionId = value; },
    editPreview(value) { nodes(render()).find(node => node.props?.['aria-label'] === '结果预览').props.onChange({ target: { value } }); },
    diff: window.__changesForTest,
    close() { nodes(render()).find(node => node.type === 'button' && node.props.title === '关闭').props.onClick(); },
    open() { nodes(render()).find(node => node.type === 'button' && node.props['aria-expanded'] !== undefined).props.onClick(); }
  };
}

const ui = await fixture();
ui.edit('改写规则 · 仅智能优化使用', '保持简短');
ui.edit('输出前缀 · 原样加入结果开头', '摄影师视角');
ui.edit('输出后缀 · 原样加入结果末尾', '不要水印');
ui.click('只组装（不调用模型）'); await tick();
assert.equal(ui.requests.at(-1).body.mode, 'assemble');
assert.equal(ui.requests.at(-1).body.rules.length, 2, '只组装不发送改写规则');
assert.equal(ui.writes.length, 0, '预览不自动写回');
assert(nodes(ui.render()).some(node => label(node) === '本次只组装，未调用模型'));
ui.editPreview('手动编辑的最终结果');
ui.click('复制'); await tick();
assert.equal(ui.copied.at(-1), '手动编辑的最终结果');
ui.setDraft('用户新写的草稿');
ui.click('写回输入框'); assert.equal(ui.writes.length, 0);
ui.setConfirm(true); ui.click('写回输入框');
assert.equal(ui.writes.at(-1), '手动编辑的最终结果');
const confirmed = ui.confirmations;
ui.click('恢复原文');
assert.equal(ui.writes.at(-1), '  画一只猫  ');
assert.equal(ui.confirmations, confirmed, '恢复自己刚写入的内容不误报外部修改');
ui.setReferences([{}]); ui.click('写回输入框');
assert.equal(ui.writes.length, 2, '预览后新增结构化引用也不能破坏');
ui.setReferences([]); ui.setPhase('busy'); ui.click('写回输入框');
assert.equal(ui.writes.length, 2, '忙碌时不写回');
ui.setPhase('plain'); ui.editPreview(''); ui.click('写回输入框');
assert.equal(ui.writes.length, 2, '空编辑结果不写回');
ui.click('智能优化'); await tick();
assert.equal(ui.requests.at(-1).body.rules.length, 3);
assert.equal(ui.requests.at(-1).body.rules[0].kind, 'optimization');

ui.setHold(true); ui.click('智能优化');
const old = ui.requests.at(-1); ui.close(); assert(old.signal.aborted);
ui.open(); ui.click('智能优化');
ui.pending[0].resolve(); await tick();
assert.equal(ui.button('写回输入框'), undefined, '旧请求迟到结果不能进入新预览');
assert(ui.button('处理中…').props.disabled, '旧请求 finally 不解除新请求 busy');
ui.pending[1].resolve(); await tick(); assert(ui.button('写回输入框'));
assert.deepEqual(JSON.parse(JSON.stringify(ui.diff('😀猫', '😃猫'))), { removed: '😀', added: '😃' });
ui.setSession('new-session'); ui.render();
assert.equal(ui.button('写回输入框'), undefined, '会话切换清除旧预览，即便草稿文本相同');
ui.click('智能优化');
const switching = ui.requests.at(-1);
ui.setSession('next-session'); ui.render(); assert(switching.signal.aborted);
ui.pending[2].resolve(); await tick();
assert.equal(ui.button('写回输入框'), undefined, '会话切换后的迟到结果不能恢复预览');

const oldBackend = await fixture({ supports: false });
assert(oldBackend.button('只组装（不调用模型）').props.disabled, '没有后端能力声明时禁止只组装');
oldBackend.click('智能优化'); await tick();
assert.equal(oldBackend.requests.at(-1).body.rules.length, 0);
console.log('ALL OK —— 泡泡实际交互：规则分离、零自动写回、可编辑复制、草稿/引用保护、迟到结果隔离与旧后端能力门禁通过');
