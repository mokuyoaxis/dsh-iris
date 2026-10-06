/**
 * dsh-iris 模型驱动定位测试（阶段 3A）：iris_locate。
 * 运行：node tests/locate.mjs
 * 覆盖：
 *   ① extractBboxJson：纯 JSON、代码围栏、多 JSON 取第一个、无 JSON；
 *   ② locateObject：有效 bbox 返回、found=false 明确、越界钳制、完全越界报错、
 *      x1>=x2 字段非法、数字不存在；
 *   ③ 共享端口：Fake/HTTP fixture 返回 JSON → 完整终态后解析。
 * 零外网，纯函数 + 共享端口 fixture。
 */
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { createHttpVisionFixture } from './fixtures/vision-models.mjs';

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const { extractBboxJson, locateObject, LocateError } = await import('../lib/locate.js');
const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' };
const locate = async (answer, options = {}) => {
  const { bbox, identity } = await locateObject([createFakeModelPort({ kind: 'vision', steps: [{ text: answer }] }).port],
    { target: '按钮', image, width: 100, height: 100, ...options });
  return { ...bbox, identity };
};

/* ---------- ① extractBboxJson ---------- */
assert(extractBboxJson('{"x1":10,"y1":20,"x2":30,"y2":40}') === '{"x1":10,"y1":20,"x2":30,"y2":40}', '纯 JSON');
assert(extractBboxJson('```json\n{"x1":1,"y1":2}\n```') === '{"x1":1,"y1":2}', '代码围栏');
assert(extractBboxJson('前文{"x1":1}后文') === '{"x1":1}', '前文后文忽略');
assert(extractBboxJson('{"a":{"b":1}}') === '{"a":{"b":1}}', '嵌套对象');
assert(extractBboxJson('无 JSON 字符') === null, '无 JSON 返回 null');
assert(extractBboxJson('') === null, '空串返回 null');

/* ---------- ② locateObject 单元（mock backend） ---------- */
// 有效 bbox
const r1 = await locate('{"x1":10,"y1":20,"x2":30,"y2":40}');
assert(r1.found === true && r1.x1 === 10 && r1.y1 === 20 && r1.x2 === 30 && r1.y2 === 40, '有效 bbox', JSON.stringify(r1));
assert(r1.identity.modelId === 'vision-v0', '透传完整模型身份');

// found=false
const r2 = await locate('{"found":false}', { target: '不存在之物' });
assert(r2.found === false, 'found=false', JSON.stringify(r2));

// 轻微越界钳制（x2=105 > 100）
const r3 = await locate('{"x1":-5,"y1":0,"x2":105,"y2":100}');
assert(r3.x1 === 0 && r3.x2 === 100, '越界钳制', JSON.stringify(r3));

// 完全越界（x1=200 > 100）
try { await locate('{"x1":200,"y1":0,"x2":300,"y2":100}'); assert(false, '应抛完全越界'); }
catch (e) { assert(/完全超出/.test(e.message), '完全越界报错', e.message); }

// x1>=x2 字段非法
try { await locate('{"x1":50,"y1":0,"x2":10,"y2":100}'); assert(false, '应抛无效 bbox'); }
catch (e) { assert(/无效/.test(e.message), 'x1>=x2 报错', e.message); }

// 非数字字段
try { await locate('{"x1":"a","y1":0,"x2":10,"y2":100}'); assert(false, '应抛数字检查'); }
catch (e) { assert(/必须是数字/.test(e.message), '非数字字段报错', e.message); }

// 模型返回非 JSON
try { await locate('我看到了一个按钮'); assert(false, '应抛非 JSON'); }
catch (e) { assert(/未返回有效 JSON/.test(e.message), '非 JSON 报错', e.message); }

/* ---------- ③ 后端链集成：mock SSE 服务器返回 JSON bbox ---------- */
const http = createHttpVisionFixture({ steps: [{ text: '{"x1":5,"y1":5,"x2":15,"y2":15}' }] });
const { bbox: r4 } = await locateObject([http.port], { target: 'button', image, width: 100, height: 100 });
assert(r4.found === true && r4.x1 === 5 && r4.x2 === 15, 'SSE 后端集成', JSON.stringify(r4));

console.log('ALL OK —— 定位工具 8 组断言全部通过（JSON 提取/有效 bbox/found=false/越界钳制/完全越界/字段非法/非数字/SSE 集成）');
