import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_CONTRACT_VERSION,
  HOST_PORTS,
  HostCapabilityError,
  defineHostAdapter,
  hasHostPort,
  hostCapabilitySnapshot,
  requireHostPort
} from '../lib/host-contract.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};

assert(HOST_CONTRACT_VERSION === 0, '首版 Host 契约必须显式为 v0');
assert(HOST_PORTS.join(',') === 'attachments,browser,clientSlots,routes,sessions,skills,textModel,tools,visionModel',
  'Host Port 名单发生变化必须显式评审', HOST_PORTS);

const browser = { renderHtml: async () => ({ bytes: new Uint8Array() }) };
const adapter = defineHostAdapter({
  id: 'local-fixture',
  version: 'test',
  ports: { browser },
  unavailable: {
    attachments: { kind: 'unavailable', reason: '本地夹具未配置附件库' },
    skills: { kind: 'incompatible', reason: '宿主版本不支持 Skill registry' }
  }
});
assert(Object.isFrozen(adapter) && Object.isFrozen(adapter.ports), 'Adapter 描述必须只读');
assert(hasHostPort(adapter, 'browser') && requireHostPort(adapter, 'browser', 'HTML 截图') === browser,
  '可用端口必须保持借用对象身份');

for (const [port, code] of [
  ['attachments', 'IRIS_HOST_CAPABILITY_UNAVAILABLE'],
  ['skills', 'IRIS_HOST_CAPABILITY_INCOMPATIBLE']
]) {
  try {
    requireHostPort(adapter, port, '测试操作');
    assert(false, `缺失端口 ${port} 必须失败`);
  } catch (error) {
    assert(error instanceof HostCapabilityError && error.code === code && error.capability === port,
      `缺失端口 ${port} 必须返回稳定分类`, { name: error.name, code: error.code });
    assert(error.message.includes('测试操作') && error.message.includes(port), '错误必须说明操作与能力', error.message);
  }
}

const snapshot = hostCapabilitySnapshot(adapter);
assert(snapshot.host.id === 'local-fixture' && snapshot.capabilities.browser.status === 'available',
  '能力快照应保留宿主身份与可用事实', snapshot);
assert(snapshot.capabilities.skills.status === 'incompatible'
  && snapshot.capabilities.skills.reason === '宿主版本不支持 Skill registry',
  '能力快照应保留不兼容原因', snapshot.capabilities.skills);
assert(!JSON.stringify(snapshot).includes('renderHtml'), '能力快照不得泄露 live Host 对象');

for (const invalid of [
  { id: 'raw', ctx: {}, ports: {} },
  { id: 'raw', ports: { unknown: {} } },
  { id: 'raw', ports: { browser: null } },
  { id: 'raw', ports: { browser: {} }, unavailable: { browser: { kind: 'unavailable', reason: '重复' } } }
]) {
  try {
    defineHostAdapter(invalid);
    assert(false, '非法 Host Adapter 必须拒绝', invalid);
  } catch (_) { /* expected */ }
}

const source = fs.readFileSync(path.join(root, 'lib', 'host-contract.js'), 'utf8');
assert(!/@deepseek-ai\/|from ['"](?:cordis|dsh)/.test(source), 'Host 契约模块不得导入 DSH/Cordis');
const contract = fs.readFileSync(path.join(root, 'docs', 'HOST_ADAPTER_CONTRACT.md'), 'utf8');
for (const phrase of ['Command × Host Port', '不得接收原始 `ctx`', '不得自动产生新的远端媒体提交', 'Local Host fixture']) {
  assert(contract.includes(phrase), `Host 契约文档缺少不可违反规则：${phrase}`);
}

console.log('ALL OK —— Host Adapter v0 名称、快照、缺能力分类、严格输入和依赖方向通过');
