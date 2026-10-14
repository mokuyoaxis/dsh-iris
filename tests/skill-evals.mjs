/**
 * 零网络Skill场景夹具：维护路由期望、工具边界和Agent调用/Task预算。
 * 此检查不执行语言路由、不证明真实模型触发率；不调用模型或供应商。
 */
import fs from 'node:fs';
import { loadBundledSkills } from '../lib/bundled-skills.js';
import { EXPECTED_IRIS_TOOLS } from '../lib/host-runtime.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, 'tests', 'fixtures', 'skill-evals.json');
const suite = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(suite.version === 2, '当前Skill场景夹具版本必须是2');
assert(JSON.stringify([...suite.skills].sort()) === JSON.stringify(loadBundledSkills().map(skill => skill.name).sort()),
  '场景夹具应覆盖实际随包Skill');
assert(Array.isArray(suite.cases) && suite.cases.length >= 10, '至少需要 10 条零费用行为用例');
assert(new Set(suite.cases.map((item) => item.id)).size === suite.cases.length, 'Skill eval id 必须唯一');

const knownSkills = new Set(suite.skills);
const knownTools = new Set(EXPECTED_IRIS_TOOLS);
for (const item of suite.cases) {
  assert(typeof item.id === 'string' && item.id && typeof item.prompt === 'string' && item.prompt,
    '每条 eval 必须包含 id 与 prompt');
  assert(item.expectedSkill === null || knownSkills.has(item.expectedSkill), `${item.id} 的 expectedSkill 非法`);
  assert(Array.isArray(item.expectedTools) && Array.isArray(item.forbiddenTools), `${item.id} 必须声明工具边界`);
  for (const tool of [...item.expectedTools, ...item.forbiddenTools]) {
    assert(knownTools.has(tool), `${item.id} 使用未知工具 ${tool}`);
  }
  assert(!item.expectedTools.some((tool) => item.forbiddenTools.includes(tool)), `${item.id} 工具期望相互冲突`);
  assert(Number.isSafeInteger(item.maxNewTasks) && item.maxNewTasks >= 0,
    `${item.id} 的新 Task 预算必须为有界非负整数`);
  assert(Number.isInteger(item.maxAgentGenerationCalls) && item.maxAgentGenerationCalls >= 0
    && item.maxAgentGenerationCalls <= item.maxNewTasks, `${item.id} 必须区分Agent调用和内部Task预算`);
  if (item.expectedVerdict) assert(['Pass', 'Partial pass', 'Fail', 'Indeterminate'].includes(item.expectedVerdict), `${item.id} 验收结论无效`);
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

console.log(`ALL OK —— ${suite.cases.length} 条Skill场景夹具与当前工具/调用预算一致；此检查不代表真实模型选Skill行为`);
