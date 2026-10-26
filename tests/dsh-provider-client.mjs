/** Execute the actual provider form with React/DOM fixtures; no real browser or service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const exposed = source.replace('var clientSlots = clientSlotsPort(ctx);',
  'window.__providerManager = ProviderManager; var clientSlots = clientSlotsPort(ctx);');
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : [tree, ...nodes(tree.props?.children)];
const label = node => (node.props?.children || []).filter(value => typeof value === 'string').join('');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(connections) {
  let entry, cursor, firstRender = true;
  const hooks = [], effects = [], requests = [];
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useEffect(effect) { cursor++; if (firstRender) effects.push(effect); },
    useRef(value) { return { current: value }; }, useMemo(factory) { return factory(); }
  };
  const fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    requests.push({ url, body });
    const result = url.endsWith('/providers_host_connections') ? { ok: true, connections }
      : url.endsWith('/providers_list') ? { ok: true, providers: [] }
        : { ok: true, providerId: 'fixture' };
    return { ok: true, async json() { return result; } };
  };
  const window = { __ModuleLoader__: { load(value) { entry = value; } }, fetch,
    addEventListener() {}, removeEventListener() {} };
  const document = { getElementById() { return {}; } };
  vm.runInNewContext(exposed, { window, document, fetch, setInterval: () => 1, clearInterval() {},
    setTimeout, clearTimeout, console, AbortController }, { filename: 'client.js' });
  entry.factory(name => { assert.equal(name, 'react'); return react; }).apply({ slots: {
    inject(_seat, callback) { callback(); }, register() {}
  } });
  function render() {
    cursor = 0;
    const tree = window.__providerManager();
    const pending = effects.splice(0); firstRender = false;
    for (const effect of pending) effect();
    return tree;
  }
  function button(text) {
    const result = nodes(render()).find(node => node.type === 'button' && label(node) === text);
    assert.ok(result, text); return result;
  }
  function field(text) {
    const wrapper = nodes(render()).find(node => node.props.children?.some(child => child?.type === 'label' && label(child) === text));
    assert.ok(wrapper, text);
    return wrapper.props.children.find(child => child?.type === 'input' || child?.type === 'select');
  }
  return { render, requests, button, field, async open() {
    render(); await tick(); button('+ 添加供应商').props.onClick(); await tick();
  } };
}

const shared = fixture([{ provider: 'workbuddy', settingsNs: 'llm-pi-ai', name: 'Workbuddy', available: true,
  baseUrl: 'http://127.0.0.1:7863/v1' }]);
await shared.open();
shared.field('连接来源').props.onChange({ target: { value: JSON.stringify(['llm-pi-ai', 'workbuddy']) } });
assert.ok(!nodes(shared.render()).some(node => node.type === 'input' && node.props.type === 'password'));
assert.ok(!nodes(shared.render()).some(node => node.type === 'label' && label(node) === 'Base URL *'));
shared.field('媒体协议').props.onChange({ target: { value: 'openai-images' } });
shared.button('保存').props.onClick(); await tick();
const saved = shared.requests.find(request => request.url.endsWith('/providers_upsert')).body;
assert.deepEqual(saved.dshProvider, { provider: 'workbuddy', settingsNs: 'llm-pi-ai' });
assert.equal(saved.mediaProtocol, 'openai-images');
assert.ok(!Object.hasOwn(saved, 'apiKey') && !Object.hasOwn(saved, 'baseUrl'));
assert.ok(shared.requests.filter(request => request.url.startsWith('/iris/api/actions/'))
  .every(request => /providers_(?:list|host_connections|upsert)$/.test(request.url)), 'configuration must never generate or probe');

const manual = fixture([]);
await manual.open();
manual.field('名称').props.onChange({ target: { value: 'manual' } });
manual.field('Base URL *').props.onChange({ target: { value: 'https://manual.fixture.invalid/v1' } });
manual.field('API Key *').props.onChange({ target: { value: 'manual-fixture-key' } });
manual.button('保存').props.onClick(); await tick();
const added = manual.requests.find(request => request.url.endsWith('/providers_upsert')).body;
assert.equal(added.apiKey, 'manual-fixture-key');
assert.equal(added.baseUrl, 'https://manual.fixture.invalid/v1');
assert.ok(!Object.hasOwn(added, 'dshProvider'));

const comfy = fixture([]);
await comfy.open();
comfy.field('连接预设').props.onChange({ target: { value: 'comfyui' } });
assert.equal(comfy.field('Base URL *').props.value, 'http://127.0.0.1:8188');
assert.equal(comfy.field('认证方式').props.value, 'none');
assert.ok(!nodes(comfy.render()).some(node => node.type === 'input' && node.props.type === 'password'));
comfy.button('保存').props.onClick(); await tick();
const local = comfy.requests.find(request => request.url.endsWith('/providers_upsert')).body;
assert.equal(local.auth, 'none'); assert.equal(local.apiKey, ''); assert.equal(local.mediaProtocol, 'comfyui');
assert(comfy.requests.filter(request => request.url.includes('/actions/')).every(request => /providers_(?:list|host_connections|upsert)$/.test(request.url)));

const switching = fixture([{ provider: 'workbuddy', settingsNs: 'llm-pi-ai', name: 'Workbuddy', available: true }]);
await switching.open(); switching.field('连接预设').props.onChange({ target: { value: 'comfyui' } });
switching.field('连接来源').props.onChange({ target: { value: JSON.stringify(['llm-pi-ai', 'workbuddy']) } });
assert.equal(switching.field('媒体协议').props.value, 'auto', 'Comfy preset must not leak into a DSH connection reference');
assert.equal(switching.field('名称').props.value, '');
console.log('ALL OK — actual provider form: host selection, hidden key fields, explicit protocol, reference-only save and manual configuration');
