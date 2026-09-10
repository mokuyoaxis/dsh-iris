/**
 * 零网络 Skill 行为契约：固定触发/不触发、路由、工具边界和新 Task 上限。
 * 真实模型触发率是显式 canary，不在 CI 中调用模型或供应商。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, 'tests', 'fixtures', 'skill-evals.json');
const suite = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(suite.version === 1, 'Skill eval fixture version 必须是 1');
assert(JSON.stringify(suite.skills) === JSON.stringify(['iris-compose-media', 'iris-verify-ui']),
  '0.1.4 默认必须恰好保留两项 Skill');
assert(Array.isArray(suite.cases) && suite.cases.length >= 10, '至少需要 10 条零费用行为用例');
assert(new Set(suite.cases.map((item) => item.id)).size === suite.cases.length, 'Skill eval id 必须唯一');

const knownSkills = new Set(suite.skills);
const knownTools = new Set([
  'iris_draw_image', 'iris_generate_video', 'iris_speak_text', 'iris_transcribe_audio',
  'iris_task_status', 'iris_look_at_image', 'iris_relook_attachment', 'iris_long_ocr',
  'iris_video_frames', 'iris_media_summarize', 'iris_html_screenshot', 'iris_pixel_diff',
  'iris_locate', 'iris_crop'
]);
for (const item of suite.cases) {
  assert(typeof item.id === 'string' && item.id && typeof item.prompt === 'string' && item.prompt,
    '每条 eval 必须包含 id 与 prompt');
  assert(item.expectedSkill === null || knownSkills.has(item.expectedSkill), `${item.id} 的 expectedSkill 非法`);
  assert(Array.isArray(item.expectedTools) && Array.isArray(item.forbiddenTools), `${item.id} 必须声明工具边界`);
  for (const tool of [...item.expectedTools, ...item.forbiddenTools]) {
    assert(knownTools.has(tool), `${item.id} 使用未知工具 ${tool}`);
  }
  assert(!item.expectedTools.some((tool) => item.forbiddenTools.includes(tool)), `${item.id} 工具期望相互冲突`);
  assert(Number.isInteger(item.maxNewTasks) && item.maxNewTasks >= 0 && item.maxNewTasks <= 2,
    `${item.id} 的新 Task 上限必须为 0–2`);
  assert(typeof item.mustStop === 'boolean', `${item.id} 必须声明 mustStop`);
  if (item.mustStop) assert(item.maxNewTasks === 0, `${item.id} 停止后不得新建 Task`);
}

assert(suite.cases.some((item) => item.expectedSkill === null), '必须覆盖不触发 Skill');
for (const skill of suite.skills) {
  assert(suite.cases.some((item) => item.expectedSkill === skill), `必须覆盖 ${skill} 正向触发`);
}
for (const id of ['accepted-observation-unknown', 'acceptance-unknown', 'cancel-stops-chain']) {
  const item = suite.cases.find((candidate) => candidate.id === id);
  assert(item?.mustStop && item.maxNewTasks === 0, `${id} 必须停止且不得创建新 Task`);
}
assert(JSON.stringify(suite.requiredReportFields) === JSON.stringify([
  'taskId', 'lastKnownStatus', 'assumptions', 'partialOutputs', 'nextAction'
]), '报告字段发生变化必须显式评审');

const compose = fs.readFileSync(path.join(root, '.dsh', 'skills', 'iris-compose-media', 'SKILL.md'), 'utf8');
const recovery = fs.readFileSync(path.join(root, '.dsh', 'skills', 'iris-compose-media', 'references', 'task-v2-recovery.md'), 'utf8');
for (const phrase of ['acceptance is explicitly `not_accepted`', 'new potentially billable user operation', 'never simulate recovery']) {
  assert(recovery.includes(phrase), `Task v2 reference 缺少规则：${phrase}`);
}
assert(compose.includes('references/task-v2-recovery.md'), 'compose Skill 必须按需路由 Task v2 reference');

console.log(`ALL OK —— ${suite.cases.length} 条 Skill 路由、工具边界、停止条件与新 Task 上限契约通过`);
