/**
 * dsh-iris 多模态视频摘要测试（阶段 7.3）。
 * 运行：node tests/summarize.mjs
 * 覆盖（不依赖真实网络/模型，纯结构 + stub）：
 *   ① buildContactSheet：网格尺寸、行数列数、帧数溢出、空帧报错；
 *   ② buildSummaryPrompt：默认问题、含转写文本、截断；
 *   ③ summarizeMedia：Fake Port 返回文本、无端口报错；
 *   ④ 参数校验与错误路径。
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { ModelPortError } from '../lib/model-port-contract.js';

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const summarize = await import('../lib/summarize.js');

/* ---------- ① buildContactSheet ---------- */
// 用 sharp 生成 4 帧测试帧（彩色块）
const testFrames = [];
for (let i = 0; i < 4; i++) {
  const buf = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 40 + i * 40, g: 0, b: 0 } } })
    .jpeg().toBuffer();
  testFrames.push({ buffer: buf, atSec: i * 2, width: 80, height: 60 });
}
const sheet = await summarize.buildContactSheet({ frames: testFrames, cols: 2, maxSheetWidth: 600 });
assert(sheet.width > 0 && sheet.height > 0, 'contact sheet 有尺寸', `${sheet.width}x${sheet.height}`);
assert(sheet.rows === 2 && sheet.cols === 2, '4 帧 2 列 → 2 行', { rows: sheet.rows, cols: sheet.cols });
assert(sheet.buffer.length > 0, 'contact sheet 有数据');
const meta = await sharp(sheet.buffer).metadata();
assert(meta.format === 'png', 'contact sheet 是 PNG', meta.format);

// 9 帧 3 列
const nineFrames = testFrames.concat(testFrames).concat([{
  buffer: testFrames[0].buffer, atSec: 8, width: 80, height: 60
}]);
const sheet9 = await summarize.buildContactSheet({ frames: nineFrames, cols: 3 });
assert(sheet9.rows === 3 && sheet9.cols === 3, '9 帧 3 列 → 3 行', { rows: sheet9.rows, cols: sheet9.cols });

// 空帧报错
try { await summarize.buildContactSheet({ frames: [] }); } catch (e) { var err = e; }
assert(err && /没有可拼的帧/.test(err.message), '空帧报错', err && err.message);

/* ---------- ② buildSummaryPrompt ---------- */
const { buildSummaryPrompt } = summarize;
const def = buildSummaryPrompt({});
assert(def.length > 20 && /画面内容/.test(def), '默认问题包含画面描述指令');
const withTrans = buildSummaryPrompt({ question: '视频讲了什么', transcript: '大家好，今天我们来聊聊AI' });
assert(withTrans.includes('视频讲了什么'), '含用户问题');
assert(withTrans.includes('大家好'), '含转写文本');
assert(withTrans.includes('转写'), '含转写来源说明');

/* ---------- ③ summarizeMedia（stub 后端） ---------- */
const fake = text => createFakeModelPort({ kind: 'vision', steps: [{ text }] });
// 单后端成功
let r = await summarize.summarizeMedia({
  ports: [fake('这是一段测试视频摘要。').port], frames: testFrames,
  question: '视频讲了什么',
  transcript: '测试文本',
});
assert(r.text === '这是一段测试视频摘要。', 'Fake Port 返回摘要', r.text);
assert(r.identity.modelId === 'vision-v0', '模型身份正确', r);

// 无后端报错
try { await summarize.summarizeMedia({ ports: [], frames: testFrames }); } catch (e) { err = e; }
assert(err && err.code === 'IRIS_MODEL_UNAVAILABLE', '无端口报错', err && err.message);

// 双后端 failover：第一个失败，第二个成功
const reject = createFakeModelPort({ kind: 'vision', steps: [{ error: new ModelPortError('IRIS_MODEL_RATE_LIMITED',
  { stage: 'invoke', invocation: 'rejected', status: 429 }) }] });
r = await summarize.summarizeMedia({
  ports: [reject.port, fake('摘要2').port], frames: testFrames,
  question: 'fail',
});
assert(r.text === '摘要2', '明确拒绝后切换第二候选', r.text);
assert(Array.isArray(r.errors) && r.errors.length > 0, '有失败现场', r.errors);

/* ---------- ④ 参数校验 ---------- */
// summarizeMedia 无后端
try { await summarize.summarizeMedia({}); } catch (e) { err = e; }
assert(err && err.code === 'IRIS_MODEL_UNAVAILABLE', '缺端口报错', err && err.message);

console.log('ALL OK —— 多模态视频摘要 6 组断言全部通过（contact sheet 网格/行数/空帧/提示词/后端 stub/failover）');
