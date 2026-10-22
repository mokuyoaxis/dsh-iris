'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreatePrivate, atomicWritePrivate } from './private-storage.js';
import { WRITER_LEASE_DIR, WRITER_INTENT_FILE } from './core-writer-lease.js';
import { normalizeGenerationInput } from './generation-input.js';
import { parseModelRef } from './models.js';

const RUN = /^run_[a-f0-9]{24}$/;
const TASK = /^task_[a-f0-9]{24}$/;
const ARTIFACT = /^artifact_[a-f0-9]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
const BINDING = /^sha256:[a-f0-9]{64}$/;
const RECIPE = 'image-edit/v0';

export class FlowError extends Error {
  constructor(code, message) { super(message); this.name = 'FlowError'; this.code = code; }
}
export function flowFail(code, message) { throw new FlowError(code, message); }

function keys(value, allowed, required = allowed) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
const copy = value => Object.freeze(structuredClone(value));
export const flowId = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
export const flowSha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function validFlowBinding(value) {
  return keys(value, ['runId', 'stepId', 'inputDigest']) && RUN.test(value.runId)
    && value.stepId === 'edit' && BINDING.test(value.inputDigest);
}
export function flowTaskBinding(run) { return { runId: run.id, stepId: 'edit', inputDigest: run.inputDigest }; }

function inputDigest(run) {
  return 'sha256:' + flowSha256(JSON.stringify([RECIPE, run.source.artifactId, run.source.sha256,
    run.input.model_ref, run.providerBinding, run.input.prompt, run.input.size ?? null, 1]));
}

function reference(value) { return keys(value, ['artifactId', 'sha256']) && ARTIFACT.test(value.artifactId) && SHA.test(value.sha256); }
function validate(run, expectedId) {
  let normalized;
  try { normalized = normalizeGenerationInput('image', run?.input); }
  catch (_) { flowFail('IRIS_FLOW_RECORD_INVALID', '流程创作输入无效'); }
  if (!keys(run, ['schemaVersion', 'recipe', 'id', 'revision', 'createdAt', 'updatedAt', 'source', 'input', 'providerBinding',
    'inputDigest', 'edit', 'compare', 'output', 'comparison', 'selection'],
  ['schemaVersion', 'recipe', 'id', 'revision', 'createdAt', 'updatedAt', 'source', 'input', 'providerBinding', 'inputDigest', 'edit', 'compare'])
      || run.schemaVersion !== 0 || run.recipe !== RECIPE || !RUN.test(run.id) || run.id !== expectedId
      || !Number.isSafeInteger(run.revision) || run.revision < 1 || !iso(run.createdAt) || !iso(run.updatedAt)
      || !reference(run.source) || !BINDING.test(run.providerBinding)
      || !parseModelRef(run.input.model_ref) || normalized.modelRef !== run.input.model_ref
      || run.input.prompt !== normalized.providerInput.prompt || run.input.n !== 1
      || (run.input.size !== undefined && run.input.size !== normalized.providerInput.size)
      || normalized.sourceArtifactId !== run.source.artifactId
      || !keys(run.edit, ['taskId', 'claimed']) || !TASK.test(run.edit.taskId) || typeof run.edit.claimed !== 'boolean'
      || !keys(run.compare, ['artifactId']) || !ARTIFACT.test(run.compare.artifactId)
      || run.compare.artifactId === run.source.artifactId || run.inputDigest !== inputDigest(run)
      || (run.output !== undefined && (!reference(run.output) || !run.edit.claimed
        || [run.source.artifactId, run.compare.artifactId].includes(run.output.artifactId)))
      || (run.comparison !== undefined && (!reference(run.comparison) || !run.output || run.comparison.artifactId !== run.compare.artifactId))
      || (run.selection !== undefined && (!reference(run.selection) || !run.comparison
        || ![run.source, run.output].some(item => item.artifactId === run.selection.artifactId && item.sha256 === run.selection.sha256)))) {
    flowFail('IRIS_FLOW_RECORD_INVALID', '流程记录结构或绑定摘要冲突');
  }
  return run;
}

function directory(root, leaf, create = false) {
  let current = root;
  for (const segment of ['flow-store', 'v0', ...(leaf ? [leaf] : [])]) {
    current = path.join(current, segment);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) flowFail('IRIS_FLOW_STORE_UNSAFE', '流程存储目录不安全');
  }
  return current;
}
function jsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) flowFail('IRIS_FLOW_RECORD_INVALID', '流程记录不是受支持的普通文件');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { flowFail('IRIS_FLOW_RECORD_INVALID', '流程记录不是有效 JSON'); }
}

export function inspectFlowRoot(root) {
  let marker;
  try { marker = jsonFile(path.join(directory(root), 'root.json')); }
  catch (error) {
    if (error.code === 'ENOENT') flowFail('IRIS_FLOW_ROOT_REQUIRED', '请先在新的专用数据根执行 flow init，再导入图片');
    throw error;
  }
  if (!keys(marker, ['schemaVersion', 'kind', 'createdAt']) || marker.schemaVersion !== 0
      || marker.kind !== 'iris-image-flow-root' || !iso(marker.createdAt)) flowFail('IRIS_FLOW_RECORD_INVALID', '流程根声明无效或版本不受支持');
  directory(root, 'runs');
  return copy(marker);
}

export function initializeFlowRoot(root) {
  try { fs.lstatSync(path.join(root, 'flow-store')); return inspectFlowRoot(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fs.readdirSync(root).some(name => ![WRITER_LEASE_DIR, WRITER_INTENT_FILE].includes(name))) {
    flowFail('IRIS_FLOW_ROOT_NOT_EMPTY', '流程只在新的专用数据根启用；不迁移已有 Task/Artifact 数据根');
  }
  directory(root, 'runs', true);
  const marker = { schemaVersion: 0, kind: 'iris-image-flow-root', createdAt: new Date().toISOString() };
  atomicCreatePrivate(path.join(directory(root), 'root.json'), JSON.stringify(marker, null, 2) + '\n');
  return copy(marker);
}

function recordFile(root, id) {
  if (typeof id !== 'string' || !RUN.test(id)) flowFail('IRIS_FLOW_ID_INVALID', 'Run ID 格式无效');
  return path.join(directory(root, 'runs'), id + '.json');
}
export function readFlowRun(root, id) {
  inspectFlowRoot(root);
  let record;
  try { record = jsonFile(recordFile(root, id)); }
  catch (error) {
    if (error.code === 'ENOENT') flowFail('IRIS_FLOW_NOT_FOUND', '流程记录不存在');
    throw error;
  }
  return copy(validate(record, id));
}

/** Internal immutable creation intent; HTTP callers cannot choose these identities. */
export function prepareFlowCreation({ source, input, providerBinding }) {
  return { runId: flowId('run'), taskId: flowId('task'), comparisonArtifactId: flowId('artifact'),
    createdAt: new Date().toISOString(), source, input, providerBinding };
}

export function validateFlowCreation(intent) {
  if (!keys(intent, ['runId', 'taskId', 'comparisonArtifactId', 'createdAt', 'source', 'input', 'providerBinding'])) {
    flowFail('IRIS_FLOW_RECORD_INVALID', '流程创建意图无效');
  }
  const record = { schemaVersion: 0, recipe: RECIPE, id: intent.runId, revision: 1,
    createdAt: intent.createdAt, updatedAt: intent.createdAt, source: intent.source, input: intent.input,
    providerBinding: intent.providerBinding, edit: { taskId: intent.taskId, claimed: false },
    compare: { artifactId: intent.comparisonArtifactId } };
  record.inputDigest = inputDigest(record);
  return validate(record, record.id);
}

export function commitFlowCreation(root, intent, { allowCreate = true } = {}) {
  inspectFlowRoot(root);
  const record = validateFlowCreation(intent);
  let current;
  try { current = readFlowRun(root, record.id); }
  catch (error) { if (error.code !== 'IRIS_FLOW_NOT_FOUND') throw error; }
  if (current) {
    if (current.createdAt !== record.createdAt || current.inputDigest !== record.inputDigest
        || current.edit.taskId !== record.edit.taskId || current.compare.artifactId !== record.compare.artifactId) {
      flowFail('IRIS_FLOW_INPUT_CONFLICT', '原流程与预留创建身份不一致');
    }
    return current;
  }
  if (!allowCreate) flowFail('IRIS_FLOW_NOT_FOUND', '原流程记录已不可用');
  atomicCreatePrivate(recordFile(root, record.id), JSON.stringify(record, null, 2) + '\n');
  return copy(record);
}

export function createFlowRun(root, input) {
  return commitFlowCreation(root, prepareFlowCreation(input));
}

export function updateFlowRun(root, previous, patch) {
  const current = readFlowRun(root, previous.id);
  if (current.revision !== previous.revision) flowFail('IRIS_FLOW_REVISION_CONFLICT', '流程在本次操作期间已改变');
  if (!keys(patch, ['edit', 'output', 'comparison', 'selection'], [])) throw new TypeError('未知流程更新字段');
  const record = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
  validate(record, current.id);
  atomicWritePrivate(recordFile(root, record.id), JSON.stringify(record, null, 2) + '\n');
  return copy(record);
}

export function listFlowRuns(root) {
  inspectFlowRoot(root);
  const records = [];
  for (const name of fs.readdirSync(directory(root, 'runs'))) {
    if (/^run_[a-f0-9]{24}\.json\.tmp-[1-9][0-9]*-[a-f0-9]{12}$/.test(name)) continue; // 保留未发布的原子写现场。
    if (!/^run_[a-f0-9]{24}\.json$/.test(name)) flowFail('IRIS_FLOW_RECORD_INVALID', '流程目录包含未知记录，停止盘点');
    records.push(readFlowRun(root, name.slice(0, -5)));
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 管理入口不能忽略损坏/未知的流程根，从而丢掉引用。普通 Core 根保持零写。 */
export function flowReferences(root) {
  try { fs.lstatSync(path.join(root, 'flow-store')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return listFlowRuns(root).map(run => ({ run, taskIds: [run.edit.taskId],
    artifactIds: [...new Set([run.source.artifactId, run.compare.artifactId, run.output?.artifactId, run.selection?.artifactId].filter(Boolean))] }));
}
