/**
 * dsh-iris /iris/api/state 离线冒烟（M4 host 侧数据层）。
 * 运行：node tests/api.mjs
 * 验证四条输出纪律：
 *   ① apiKey 永不明文（只给 hint）；② running/recent 正确分组；
 *   ③ 媒体链接为授权 URL（含 token，不含绝对路径）；④ 输出全标量可 JSON 序列化。
 * 全部用本地假数据，零网络、零费用。
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.DSH_HOME = '/tmp/iris-api-home-' + Date.now();
const irisV1 = path.join(process.env.DSH_HOME, 'iris', 'v1');
fs.mkdirSync(path.join(irisV1, 'outputs'), { recursive: true });

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : ' | ' + JSON.stringify(extra));
    process.exit(1);
  }
};

/* ---------- 假数据：一个供应商（带明文 key，必须被掩码） + 三条任务 ---------- */
fs.writeFileSync(path.join(irisV1, 'providers.json'), JSON.stringify({
  version: 1,
  providers: [{
    id: 'iris_testp',
    name: '本地测试供应商',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:9999/compatible-mode/v1',
    apiKey: 'sk-this-must-never-leak-secret-key-value-123456',
    enabled: true,
    mediaProtocol: 'dashscope',
    imageModel: 'wan2.2-t2i-flash',
    videoModel: 'wan2.2-t2v-flash',
    ttsModel: 'qwen-tts-latest',
    visionModel: 'qwen-vl-plus'
  }]
}, null, 2));

const now = new Date();
const iso = (minAgo) => new Date(now.getTime() - minAgo * 60000).toISOString();
fs.writeFileSync(path.join(irisV1, 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: [
    {
      id: 't_running_1', cap: 'video', status: 'running', progress: 'RUNNING',
      model: 'wan2.2-t2v-flash', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'a small pixel cottage on a hill', remoteTaskId: 'R1',
      createdAt: iso(0.2), updatedAt: iso(0.1)
    },
    {
      id: 't_done_1', cap: 'image', status: 'succeeded', saved: true,
      model: 'wan2.2-t2i-flash', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'pixel art scene', files: ['t_done_1-0.png'],
      media: [{ file: 't_done_1-0.png', token: 'ab'.repeat(16), mime: 'image/png', createdAt: iso(5) }],
      createdAt: iso(5), finishedAt: iso(4)
    },
    {
      id: 't_failed_1', cap: 'tts', status: 'failed', error: '配额不足',
      model: 'qwen-tts-latest', providerId: 'iris_testp', providerName: '本地测试供应商',
      prompt: 'hello', createdAt: iso(30), finishedAt: iso(29)
    }
  ]
}, null, 2));

/* ---------- 载入被测模块 ---------- */
const { buildState } = await import('../lib/api.js');

const state = buildState();

/* ① apiKey 掩码 */
const p0 = state.providers[0];
assert(p0 && typeof p0.apiKey === 'undefined', 'apiKey 绝不出现在输出', state.providers);
assert(typeof p0.apiKeyHint === 'string' && p0.apiKeyHint.includes('****'), 'key 只给 hint', p0.apiKeyHint);
assert(!JSON.stringify(state).includes('must-never-leak'), '序列化后不得含明文 key');

/* ② 分组：running 1 条，recent 2 条（succeeded+failed） */
assert(state.tasks.running.length === 1 && state.tasks.running[0].id === 't_running_1', 'running 分组', state.tasks.running.map((t) => t.id));
assert(state.tasks.recent.length === 2, 'recent 分组（排除 running）', state.tasks.recent.map((t) => t.id));

/* ③ 媒体链接：授权 URL 形态，且不含绝对路径 */
const done = state.tasks.recent.find((t) => t.id === 't_done_1');
const media = done && done.media && done.media[0];
assert(media && typeof media.url === 'string' && media.url.includes('/iris/media/t_done_1/'), '媒体给授权播放链接', media && media.url);
assert(media && !media.url.includes('/tmp/'), '链接不含本地绝对路径', media && media.url);
assert(media && typeof media.token === 'undefined' && typeof media.mime === 'string' && typeof media.file === 'string', '媒体条目只透 file/mime/url，token 不出 JSON', media);
assert(done && done.saved === true, 'saved 标记透传');

/* ④ 全标量可序列化 */
let roundtrip = null;
try {
  roundtrip = JSON.parse(JSON.stringify(state));
} catch (err) {
  roundtrip = null;
}
assert(roundtrip && Array.isArray(roundtrip.providers), 'state 全标量可 JSON 往返');

/* ⑤ 任务字段最小透出（不给枚举全量，只给面板需要的） */
const r0 = state.tasks.running[0];
assert(r0 && typeof r0.id === 'string' && typeof r0.cap === 'string' && typeof r0.status === 'string'
  && typeof r0.progress === 'string' && typeof r0.model === 'string' && typeof r0.prompt === 'string'
  && Array.isArray(r0.media), 'running 任务最小标量字段（media 恒为数组）');

console.log('ALL OK —— /iris/api/state 数据层 5 项断言全部通过（掩码/分组/播放链接/标量/最小透出）');