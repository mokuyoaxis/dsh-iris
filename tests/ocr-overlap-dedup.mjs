import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { longOcr, deduplicateOcrChunks, formatOcrResult, OCR_DEDUP_MODE } from '../lib/ocr.js';
import { parseOcrReport, projectOcrSummary } from '../lib/vision-flow-input.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createVisionProviderAdapter } from '../lib/vision-provider-adapter.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createFakeModelPort } from './fixtures/fake-model-port.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-ocr-overlap-dedup');
const fakePort = steps => createFakeModelPort({ kind: 'vision', steps }).port;
const norm = value => value.normalize('NFKC').replace(/\s+/g, '');

// ① 复现 OCR_VALIDATION.md 的 1000×2380（chunkHeight=800, overlap=160）四块长图重叠场景
const tall = await sharp({ create: { width: 1000, height: 2380, channels: 3, background: '#ffffff' } }).png().toBuffer();
const markers = [
  '边界标记01：订单编号ORD-001金额100元整',
  '边界标记02：订单编号ORD-002金额200元整',
  '边界标记03：订单编号ORD-003金额300元整'
];
const chunkTexts = [
  ['第01行 项目清单开头说明', '第02行 客户名称：示例公司', markers[0]].join('\n'),
  [markers[0], '第03行 明细项目甲 数量十件', markers[1]].join('\n'),
  [markers[1], '第04行 明细项目乙 数量二十件', markers[2]].join('\n'),
  [markers[2], '第05行 验收签名与日期'].join('\n')
];
const longResult = await longOcr({
  image: { bytes: new Uint8Array(tall), mediaType: 'image/png' },
  ports: [fakePort(chunkTexts.map(text => ({ text })))],
  chunkHeight: 800, overlap: 160
});
assert.equal(longResult.status, 'complete');
assert.equal(longResult.totalChunks, 4);
assert.equal(longResult.deduplication.mode, OCR_DEDUP_MODE);
assert.equal(longResult.deduplication.appliedSeams, 3);
assert.equal(longResult.deduplication.ambiguousSeams, 0);
assert.equal(longResult.deduplication.removedLines, 3);
assert.equal(longResult.deduplication.removedChars, markers.reduce((sum, line) => sum + norm(line).length, 0));
// 每块原始 text 保持不变，便于回溯审计
assert.deepEqual(longResult.chunks.map(chunk => chunk.text), chunkTexts);
// fullText 中三个边界标记各自仅出现一次
const bodyOnly = longResult.fullText.replace(/^\[第\d+段 y=\d+\] /gm, '');
for (const marker of markers) {
  assert.equal(bodyOnly.split(marker).length - 1, 1, 'boundary marker must appear exactly once: ' + marker);
}
const expectedUnique = [
  '第01行 项目清单开头说明', '第02行 客户名称：示例公司', markers[0],
  '第03行 明细项目甲 数量十件', markers[1],
  '第04行 明细项目乙 数量二十件', markers[2],
  '第05行 验收签名与日期'
].join('\n');
assert.equal(norm(bodyOnly), norm(expectedUnique), 'unique full text matches 0% CER');
assert(formatOcrResult(longResult).includes('已按重叠边界合并 3 处重复'));

// ② 多行重叠 + 空白/全角规范化容忍 + 保留原格式
const multiLine = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '开头正文\n合同编号：A-1001\n签署日期：2026-11-15' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '合同编号: A-1001  \r\n签署日期：2026-11-15\r\n后续  保留空格  正文' }
]);
assert.equal(multiLine.deduplication.appliedSeams, 1);
assert.equal(multiLine.deduplication.removedLines, 2);
assert.equal(multiLine.fullText, '[第1段 y=0] 开头正文\n合同编号：A-1001\n签署日期：2026-11-15\n[第2段 y=640] 后续  保留空格  正文');

// ③ 尾块完全被前块重叠覆盖 → 不输出空段头，原始块仍保留
const absorbed = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '第一行内容\n最后一行完全重合' },
  { index: 2, y: 640, height: 160, status: 'succeeded', text: '最后一行完全重合' }
]);
assert.equal(absorbed.deduplication.appliedSeams, 1);
assert.equal(absorbed.fullText, '[第1段 y=0] 第一行内容\n最后一行完全重合');

// ④ 原文有意重复保护（绝不误删）：块内重复、非相邻重复、跨缝周期性重复、短噪声行
const interiorRepeat = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '合计：100元\n审批状态：通过\n审批状态：通过\n唯一边界说明行一' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '唯一边界说明行一\n审批状态：通过\n合计：100元' }
]);
assert.equal(interiorRepeat.deduplication.appliedSeams, 1);
assert.equal(interiorRepeat.fullText.split('审批状态：通过').length - 1, 3, 'interior and non-seam repeats stay intact');
assert.equal(interiorRepeat.fullText.split('合计：100元').length - 1, 2, 'non-adjacent repeats stay intact');

const periodicSeam = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '清单开始\n审批状态：通过\n审批状态：通过' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '审批状态：通过\n审批状态：通过\n清单结束' }
]);
assert.equal(periodicSeam.deduplication.appliedSeams, 0);
assert.equal(periodicSeam.deduplication.ambiguousSeams, 1);
assert.equal(periodicSeam.deduplication.seams[0].status, 'ambiguous');
assert.equal(periodicSeam.fullText.split('审批状态：通过').length - 1, 4, 'ambiguous repeated seam preserves all lines');

const adjacentRepeat = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '清单开始\n审批状态：通过\n审批状态：通过' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '审批状态：通过\n清单结束' }
]);
assert.equal(adjacentRepeat.deduplication.appliedSeams, 0);
assert.equal(adjacentRepeat.deduplication.ambiguousSeams, 1);
assert.equal(adjacentRepeat.fullText.split('审批状态：通过').length - 1, 3, 'adjacent duplicate protects intentional repetition');

const stanzaRepeat = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '甲条款内容\n乙条款内容\n甲条款内容\n乙条款内容' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '甲条款内容\n乙条款内容\n丙条款内容' }
]);
assert.equal(stanzaRepeat.deduplication.appliedSeams, 0);
assert.equal(stanzaRepeat.deduplication.ambiguousSeams, 1);

const shortBoundary = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '第一段正文\n---' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '---\n第二段正文' }
]);
assert.equal(shortBoundary.deduplication.appliedSeams, 0);
assert.equal(shortBoundary.deduplication.seams[0].status, 'none');
assert.equal(shortBoundary.fullText.split('---').length - 1, 2, 'short 3-char separator is never deleted');

// ⑤ 无物理重叠（overlap=0 或中间块失败导致间隙）不做跨缝去重
const zeroOverlap = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '同一段完整标题内容' },
  { index: 2, y: 800, height: 800, status: 'succeeded', text: '同一段完整标题内容' }
]);
assert.equal(zeroOverlap.deduplication.seams.length, 0);
assert.equal(zeroOverlap.fullText, '[第1段 y=0] 同一段完整标题内容\n[第2段 y=800] 同一段完整标题内容');

const gapPartial = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '相同重复标题一二三四' },
  { index: 2, y: 640, height: 800, status: 'failed', text: '' },
  { index: 3, y: 1280, height: 800, status: 'succeeded', text: '相同重复标题一二三四' }
]);
assert.equal(gapPartial.deduplication.seams.length, 0);
assert.equal(gapPartial.fullText, '[第1段 y=0] 相同重复标题一二三四\n[第3段 y=1280] 相同重复标题一二三四');

// ⑥ 未换行连续长段落的行内重叠合并，且不切裂英文单词
const inlineCjk = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: '前文说明部分，紧接着是跨越两块重叠区域的一整句关键内容。' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: '跨越两块重叠区域的一整句关键内容。后文补充说明。' }
]);
assert.equal(inlineCjk.deduplication.appliedSeams, 1);
assert.equal(inlineCjk.deduplication.seams[0].strategy, 'inline');
assert.equal(inlineCjk.fullText, '[第1段 y=0] 前文说明部分，紧接着是跨越两块重叠区域的一整句关键内容。\n[第2段 y=640] 后文补充说明。');

const inlineWordGuard = deduplicateOcrChunks([
  { index: 1, y: 0, height: 800, status: 'succeeded', text: 'prefix_hello_world_123456' },
  { index: 2, y: 640, height: 800, status: 'succeeded', text: 'world_123456suffix' }
]);
assert.equal(inlineWordGuard.deduplication.appliedSeams, 0, 'inline dedup does not cut inside an ASCII alphanumeric word');

// ⑦ 持久 Core v5 OCR Flow 端到端 + 旧报告兼容 + 诊断 v5 字段
const dataRoot = path.join(root, 'core-v5');
const config = path.join(root, 'providers.json');
let index = 0;
const adapter = createVisionProviderAdapter({ id: 'dedup-fixture', type: 'openai', baseUrl: 'https://dedup.invalid/v1', apiKey: 'PRIVATE_KEY' }, {
  fetchPort: async () => {
    const content = chunkTexts[index++];
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    });
  }
});
const modelRef = 'dedup-fixture::vision';
const ports = { resolveVisionCandidates: () => [{ adapter, model: modelRef, providerBinding: 'sha256:' + 'b'.repeat(64), selectionReason: 'explicit' }], resolveTaskAdapter: () => adapter };
fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'dedup-fixture', type: 'openai', baseUrl: 'https://dedup.invalid/v1', apiKey: 'PRIVATE_KEY',
  models: [{ id: 'vision', capabilities: ['vision'] }] }], assignments: { vision: [modelRef] } }), { mode: 0o600 });
const app = createApplicationRuntime({ dataRoot, ...ports });
let api, v4Api;
try {
  await app.execute('flow.init', {});
  await app.execute('execution.init', { vision: true });
  const source = (await app.execute('artifact.import', { image_bytes: tall })).artifact;
  const created = await app.execute('creation.ocr', { key: crypto.randomUUID(), value: { sourceArtifactId: source.id, modelRef, chunkHeight: 800, overlap: 160 } });
  const finished = await app.execute('flow.continue', { run_id: created.flow.run.id });
  assert.equal(finished.status, 'ready');
  assert.equal(finished.ocr.deduplication.appliedSeams, 3);
  assert.equal(finished.ocr.deduplication.removedLines, 3);
  const reportBytes = readCoreArtifactBytes(dataRoot, finished.run.report.artifactId).bytes;
  const parsed = parseOcrReport(reportBytes, { plan: finished.run.plan, maxInvocations: 32 });
  assert.equal(parsed.deduplication.appliedSeams, 3);
  assert.deepEqual(parsed.chunks.map(chunk => chunk.text), chunkTexts);
  // 兼容不含 deduplication 字段的历史 v5 报告
  const legacyReport = structuredClone(parsed);
  delete legacyReport.deduplication;
  assert.equal(parseOcrReport(Buffer.from(JSON.stringify(legacyReport)), { plan: finished.run.plan, maxInvocations: 32 }).deduplication, undefined);
  assert.equal(projectOcrSummary(legacyReport).deduplication, undefined);
  // 篡改的 deduplication 统计会被 parseOcrReport 拒绝
  const corruptReport = structuredClone(parsed);
  corruptReport.deduplication.removedLines = 99;
  assert.throws(() => parseOcrReport(Buffer.from(JSON.stringify(corruptReport)), { plan: finished.run.plan, maxInvocations: 32 }), { code: 'IRIS_FLOW_RESULT_UNSUPPORTED' });

  // 验证 /api/v0/provider-management/diagnostics 的 vision 标记（v5=true，v4=false）
  api = createLocalReadApi({ dataRoot, providerConfigPath: config, serveWorkbench: true, allowExecution: true, allowProviderManagement: true, executionPorts: ports });
  const v5Session = await api.start();
  const diagV5 = await (await fetch(v5Session.origin + '/api/v0/provider-management/diagnostics', { headers: { Authorization: 'Bearer ' + v5Session.accessToken } })).json();
  assert.equal(diagV5.vision, true);
  const runView = await (await fetch(v5Session.origin + '/api/v0/runs/' + finished.run.id, { headers: { Authorization: 'Bearer ' + v5Session.accessToken } })).json();
  assert.equal(runView.ocr.deduplication.appliedSeams, 3);
  const ocrList = await (await fetch(v5Session.origin + '/api/v0/runs?kind=ocr', { headers: { Authorization: 'Bearer ' + v5Session.accessToken } })).json();
  assert.equal(ocrList.total, 1);

  const v4Root = path.join(root, 'core-v4');
  const v4App = createApplicationRuntime({ dataRoot: v4Root });
  try { await v4App.execute('flow.init', {}); await v4App.execute('execution.init', { video: true }); }
  finally { await v4App.dispose(); }
  v4Api = createLocalReadApi({ dataRoot: v4Root, providerConfigPath: config, serveWorkbench: true, allowProviderManagement: true });
  const v4Session = await v4Api.start();
  const diagV4 = await (await fetch(v4Session.origin + '/api/v0/provider-management/diagnostics', { headers: { Authorization: 'Bearer ' + v4Session.accessToken } })).json();
  assert.equal(diagV4.vision, false);

  console.log('PASS OCR conservative overlap deduplication (benchmark 0% CER, multiline, absorption, intentional repetition & ambiguity protection, inline word boundary, durable v5 report compat, v5 diagnostics)');
} finally {
  await v4Api?.dispose();
  await api?.dispose();
  await app.dispose();
}
