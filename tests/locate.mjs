/**
 * dsh-iris 模型驱动定位测试（阶段 3A）：iris_locate。
 * 运行：node tests/locate.mjs
 * 覆盖：
 *   ① extractBboxJson：纯 JSON、代码围栏、多 JSON 取第一个、无 JSON；
 *   ② locateObject：有效 bbox 返回、found=false 明确、越界钳制、完全越界报错、
 *      x1>=x2 字段非法、数字不存在；
 *   ③ 后端复用：mock backend 返回 JSON → 走通 askWithBackends 流程。
 * 零网络，纯函数 + mock 后端。
 */
import { createServer } from 'node:http';

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const { extractBboxJson, locateObject, LocateError } = await import('../lib/locate.js');
const { buildVisionBackends, SelfStackVisionBackend } = await import('../lib/vision.js');

/* ---------- ① extractBboxJson ---------- */
assert(extractBboxJson('{"x1":10,"y1":20,"x2":30,"y2":40}') === '{"x1":10,"y1":20,"x2":30,"y2":40}', '纯 JSON');
assert(extractBboxJson('```json\n{"x1":1,"y1":2}\n```') === '{"x1":1,"y1":2}', '代码围栏');
assert(extractBboxJson('前文{"x1":1}后文') === '{"x1":1}', '前文后文忽略');
assert(extractBboxJson('{"a":{"b":1}}') === '{"a":{"b":1}}', '嵌套对象');
assert(extractBboxJson('无 JSON 字符') === null, '无 JSON 返回 null');
assert(extractBboxJson('') === null, '空串返回 null');

/* ---------- ② locateObject 单元（mock backend） ---------- */
class MockBackend {
  constructor(answer) { this.answer = answer; }
  get id() { return 'mock'; }
  get kind() { return 'mock'; }
  get model() { return 'mock-model'; }
  async analyze() { return this.answer; }
}

// 有效 bbox
const r1 = await locateObject([new MockBackend('{"x1":10,"y1":20,"x2":30,"y2":40}')], { target: '按钮', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 });
assert(r1.found === true && r1.x1 === 10 && r1.y1 === 20 && r1.x2 === 30 && r1.y2 === 40, '有效 bbox', JSON.stringify(r1));
assert(r1.via === 'mock' && r1.model === 'mock-model', '透传 via/model');

// found=false
const r2 = await locateObject([new MockBackend('{"found":false}')], { target: '不存在之物', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 });
assert(r2.found === false, 'found=false', JSON.stringify(r2));

// 轻微越界钳制（x2=105 > 100）
const r3 = await locateObject([new MockBackend('{"x1":-5,"y1":0,"x2":105,"y2":100}')], { target: 'x', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 });
assert(r3.x1 === 0 && r3.x2 === 100, '越界钳制', JSON.stringify(r3));

// 完全越界（x1=200 > 100）
try { await locateObject([new MockBackend('{"x1":200,"y1":0,"x2":300,"y2":100}')], { target: 'x', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 }); assert(false, '应抛完全越界'); }
catch (e) { assert(/完全超出/.test(e.message), '完全越界报错', e.message); }

// x1>=x2 字段非法
try { await locateObject([new MockBackend('{"x1":50,"y1":0,"x2":10,"y2":100}')], { target: 'x', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 }); assert(false, '应抛无效 bbox'); }
catch (e) { assert(/无效/.test(e.message), 'x1>=x2 报错', e.message); }

// 非数字字段
try { await locateObject([new MockBackend('{"x1":"a","y1":0,"x2":10,"y2":100}')], { target: 'x', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 }); assert(false, '应抛数字检查'); }
catch (e) { assert(/必须是数字/.test(e.message), '非数字字段报错', e.message); }

// 模型返回非 JSON
try { await locateObject([new MockBackend('我看到了一个按钮')], { target: 'x', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 }); assert(false, '应抛非 JSON'); }
catch (e) { assert(/未返回有效 JSON/.test(e.message), '非 JSON 报错', e.message); }

/* ---------- ③ 后端链集成：mock SSE 服务器返回 JSON bbox ---------- */
const srv = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"content":"{\\"x1\\":5,\\"y1\\":5,\\"x2\\":15,\\"y2\\":15}"}}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const backends = buildVisionBackends({ get: () => undefined }, {
  providers: [{ id: 'ptest', type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', visionModel: 'm' }]
});
const r4 = await locateObject(backends, { target: 'button', imageDataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 });
assert(r4.found === true && r4.x1 === 5 && r4.x2 === 15, 'SSE 后端集成', JSON.stringify(r4));
srv.close();
srv.closeAllConnections();

console.log('ALL OK —— 定位工具 8 组断言全部通过（JSON 提取/有效 bbox/found=false/越界钳制/完全越界/字段非法/非数字/SSE 集成）');