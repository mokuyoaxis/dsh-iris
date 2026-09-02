/**
 * dsh-iris Provider 能力系统测试（阶段 1）。
 * 运行：node tests/capability.mjs
 * 覆盖：
 *   ① 能力常量与已知能力过滤；
 *   ② 旧配置迁移：显式声明权威 / 模型字段推断 / DashScope 裸账号全能力 / 未知返回空；
 *   ③ 严格选择：不具备能力的 provider 不被选中（不再兜底）；
 *   ④ 有序 failover：tryOrdered 首胜即止、错误累计、全败返回 null+errors。
 * 纯函数，零网络、零 I/O。
 */
import * as cap from '../lib/capability.js';

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

/* ---------- ① 常量与过滤 ---------- */
assert(cap.CAPABILITIES.IMAGE === 'image-gen', 'IMAGE 常量');
assert(cap.CAPABILITIES.VIDEO === 'video-gen', 'VIDEO 常量');
assert(cap.CAPABILITIES.TTS === 'tts', 'TTS 常量');
assert(cap.CAPABILITIES.VISION === 'vision', 'VISION 常量');
assert(cap.isKnownCapability('vision') && !cap.isKnownCapability('bogus'), '已知能力过滤');

/* ---------- ② 迁移 ---------- */
const dashscopeBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// 显式声明 → 权威（即使有模型字段也不额外推断）
const explicitP = { id: 'p1', capabilities: ['vision'], visionModel: 'x', imageModel: 'y' };
assert(JSON.stringify(cap.capabilitiesOf(explicitP)) === JSON.stringify(['vision']), '显式声明权威');

// 空 capabilities + 模型字段 → 按字段推断
const modelP = { id: 'p2', capabilities: [], imageModel: 'm1', videoModel: 'm2', ttsModel: 'm3' };
assert(cap.capabilitiesOf(modelP).sort().join(',') === 'image-gen,tts,video-gen', '模型字段推断', cap.capabilitiesOf(modelP));

// 空 capabilities + 无模型 + DashScope baseUrl → 全部能力（裸账号迁移）
const bareDash = { id: 'p3', capabilities: [], baseUrl: dashscopeBase };
assert(cap.capabilitiesOf(bareDash).sort().join(',') === 'image-gen,tts,video-gen,vision', '裸 DashScope 全能力', cap.capabilitiesOf(bareDash));

// 空 capabilities + 无模型 + 非 DashScope → 空
const bareOther = { id: 'p4', capabilities: [], baseUrl: 'https://other.example.com/v1' };
assert(cap.capabilitiesOf(bareOther).length === 0, '未知裸账号无能力');

// 非法能力名被过滤
const junkP = { id: 'p5', capabilities: ['vision', 'bogus', 'image-gen'] };
assert(cap.capabilitiesOf(junkP).sort().join(',') === 'image-gen,vision', '非法能力过滤');

// 空对象防御
assert(cap.capabilitiesOf(null).length === 0 && cap.capabilitiesOf(undefined).length === 0, '空对象防御');

/* ---------- ③ 严格选择 ---------- */
const list = [
  { id: 'a', capabilities: ['image-gen'], type: 'openai' },
  { id: 'b', capabilities: ['image-gen', 'vision'], type: 'openai' },
  { id: 'c', capabilities: [], baseUrl: 'https://other.example.com' } // 无能力
];
assert(cap.pickFor(list, cap.CAPABILITIES.VISION) && cap.pickFor(list, cap.CAPABILITIES.VISION).id === 'b', '严格选 vision → b');
assert(cap.pickFor(list, cap.CAPABILITIES.TTS) === null, '无 tts 能力 → null（不兜底）');
assert(cap.providersWith(list, cap.CAPABILITIES.IMAGE).map((p) => p.id).join(',') === 'a,b', '有序列表保序');

/* ---------- ④ 有序 failover ---------- */
let calls = [];
const ret = await cap.tryOrdered([{ id: 'x' }, { id: 'y' }], async (p) => {
  calls.push(p.id);
  if (p.id === 'x') throw new Error('429 模拟');
  return 'ok-from-y';
});
assert(ret.value === 'ok-from-y' && ret.provider.id === 'y', '首胜即止');
assert(JSON.stringify(calls) === JSON.stringify(['x', 'y']), '顺序尝试');
assert(ret.errors.length === 1 && /429/.test(ret.errors[0].message), '失败现场保留');

const allFail = await cap.tryOrdered([{ id: 'a' }, { id: 'b' }], async () => { throw new Error('down'); });
assert(allFail.value === null && allFail.provider === null && allFail.errors.length === 2, '全败 → null + errors');

const skipNull = await cap.tryOrdered([{ id: 'z' }], async () => null);
assert(skipNull.value === null && skipNull.provider === null, '返回 null 视为未成功');

console.log('ALL OK —— 能力系统 4 组断言全部通过（常量/迁移/严格选择/有序 failover）');
