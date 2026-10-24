'use strict';

import { createCoreArtifact, exportCoreArtifact, readCoreArtifactBytes } from './core-artifacts.js';
import { assertFlowTaskMatches, claimFlowTask, findFlowTask, recoverCoreTask } from './core-tasks.js';
import { deliveryCacheNeedsProvider } from './core-delivery-cache.js';
import { normalizeGenerationInput } from './generation-input.js';
import { imageEditCandidates, readImageEditArtifact } from './image-edit-input.js';
import { parseModelRef } from './models.js';
import { pixelDiff } from './pixels.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { commitFlowCreation, flowFail, flowSha256, initializeFlowRoot, inspectFlowRoot, listFlowRuns, prepareFlowCreation, readFlowRun, updateFlowRun } from './flow-store.js';

function exact(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    flowFail('IRIS_FLOW_INPUT_INVALID', '流程输入包含不支持的字段');
  }
}
const reference = artifact => ({ artifactId: artifact.id, sha256: artifact.digest.value });

function readReference(root, expected) {
  const value = readCoreArtifactBytes(root, expected.artifactId);
  if (value.artifact.digest.value !== expected.sha256) flowFail('IRIS_FLOW_ARTIFACT_CONFLICT', '流程引用的作品摘要已改变');
  return value;
}

function facts(root, run) {
  const source = readReference(root, run.source);
  const task = findFlowTask(root, run);
  if (run.output) {
    if (task.deliveryState !== 'ready' || task.artifactIds.length !== 1 || task.artifactIds[0] !== run.output.artifactId) {
      flowFail('IRIS_FLOW_TASK_CONFLICT', '流程输出与原 Task 的交付事实不一致');
    }
    const { artifact } = readReference(root, run.output);
    if (artifact.metadata.taskId !== task.id || !artifact.relations.some(edge => edge.type === 'derived-from' && edge.artifactId === source.artifact.id)) {
      flowFail('IRIS_FLOW_ARTIFACT_CONFLICT', '流程输出缺少原 Task 或来源关系');
    }
  }
  let comparison;
  if (run.comparison) {
    comparison = readReference(root, run.comparison).artifact;
    if (comparison.kind !== 'pixel-diff' || comparison.relations.length !== 2
        || ![run.source.artifactId, run.output.artifactId].every(id => comparison.relations.some(edge => edge.type === 'derived-from' && edge.artifactId === id))) {
      flowFail('IRIS_FLOW_ARTIFACT_CONFLICT', '比较作品与流程来源不一致');
    }
  }
  let status = 'not_started';
  if (task?.acceptance === 'unknown' || ['unknown', 'failed', 'canceled'].includes(task?.outcome)) status = 'needs_attention';
  else if (task?.deliveryState === 'ready') status = run.comparison ? run.selection ? 'selected' : 'awaiting_selection' : 'needs_comparison';
  else if (task?.deliveryState === 'failed') status = 'delivery_failed';
  else if (task?.attempts.length) status = task.acceptance === 'accepted' ? 'running' : 'needs_attention';
  return { contractVersion: 0, run, task, status, ...(comparison ? { metrics: comparison.metadata } : {}) };
}

/** Internal fixed recipe. All state/leases belong to the supplied operation-scoped runtime. */
export function createImageFlowService(runtime, { resolveImageCandidates, resolveTaskAdapter } = {}) {
  function creationInput(input) {
    const normalized = normalizeGenerationInput('image', input);
    if (!normalized.sourceArtifactId || !parseModelRef(normalized.modelRef) || normalized.providerInput.n !== 1) {
      flowFail('IRIS_FLOW_INPUT_INVALID', '首版流程需要来源 Artifact、明确 model_ref 和 n=1');
    }
    return { prompt: normalized.providerInput.prompt, model_ref: normalized.modelRef,
      source_artifact_id: normalized.sourceArtifactId, n: 1,
      ...(normalized.providerInput.size !== undefined ? { size: normalized.providerInput.size } : {}) };
  }
  async function prepareCreation(root, signal, input) {
    const owned = creationInput(input);
    inspectFlowRoot(root);
    const source = await readImageEditArtifact(root, owned.source_artifact_id, signal);
    const candidates = await candidatesFor(owned, signal);
    return prepareFlowCreation({ source: { artifactId: owned.source_artifact_id, sha256: flowSha256(source.bytes) },
      input: owned, providerBinding: candidates[0].providerBinding });
  }
  async function candidatesFor(runInput, signal, binding) {
    if (!resolveImageCandidates) flowFail('IRIS_FLOW_PROVIDER_REQUIRED', '创建或首次提交流程需要显式 Provider 配置');
    signal.throwIfAborted();
    const candidates = await resolveImageCandidates({ modelRef: runInput.model_ref, signal });
    signal.throwIfAborted();
    const parsed = parseModelRef(runInput.model_ref);
    if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0].model !== runInput.model_ref
        || candidates[0].adapter?.id !== parsed.providerId || !/^sha256:[a-f0-9]{64}$/.test(candidates[0].providerBinding)) {
      flowFail('IRIS_FLOW_INPUT_CONFLICT', '流程必须绑定单一明确模型和有效的连接摘要');
    }
    if (binding !== undefined && candidates[0].providerBinding !== binding) flowFail('IRIS_FLOW_PROVIDER_CHANGED', '连接或协议已改变；原流程不重新绑定或生成');
    return imageEditCandidates([{ ...candidates[0], providerModel: parsed.modelId, selectionReason: 'explicit' }]);
  }

  async function adapterFor(task, signal) {
    if (!resolveTaskAdapter) flowFail('IRIS_FLOW_PROVIDER_REQUIRED', '观察或远端补交付需要原 Task 的 Provider 配置');
    const adapter = await resolveTaskAdapter(task, { signal });
    signal.throwIfAborted();
    return adapter;
  }

  async function continueRun(root, signal, id) {
    let run = readFlowRun(root, id);
    let task = facts(root, run).task;
    if (task?.attempts.length && !run.edit.claimed) flowFail('IRIS_FLOW_TASK_CONFLICT', '步骤检查点与已开始的 Task 冲突');
    const runner = createProviderTaskRunner(runtime);
    if (!task || !task.attempts.length) {
      const candidates = await candidatesFor(run.input, signal, run.providerBinding);
      task = claimFlowTask(root, run.id);
      if (!run.edit.claimed) run = updateFlowRun(root, run, { edit: { ...run.edit, claimed: true } });
      signal.throwIfAborted();
      const normalized = normalizeGenerationInput('image', run.input);
      task = (await runner.submit({ capability: 'image', candidates, providerInput: normalized.providerInput,
        sourceArtifactId: run.source.artifactId, flowRunId: run.id })).task;
    } else {
      task = recoverCoreTask(root, task.id);
      assertFlowTaskMatches(task, run);
      if (task.outcome === 'succeeded' && task.deliveryState === 'failed') {
        const adapter = task.deliveryCache && !deliveryCacheNeedsProvider(root, task) ? undefined : await adapterFor(task, signal);
        task = await runner.redeliver(task.id, adapter);
      } else if (task.acceptance === 'accepted' && task.outcome === 'none' && task.remoteTaskId) {
        task = await runner.observe(task.id, await adapterFor(task, signal), { resumeActive: true });
      }
    }
    signal.throwIfAborted();
    if (task.deliveryState !== 'ready') return facts(root, run);
    if (task.artifactIds.length !== 1) flowFail('IRIS_FLOW_RESULT_UNSUPPORTED', '首版流程只支持一个改图结果，原 Task 与作品已保留');
    const output = readCoreArtifactBytes(root, task.artifactIds[0]);
    if (!run.output) run = updateFlowRun(root, run, { output: reference(output.artifact) });
    facts(root, run);
    if (!run.comparison) {
      const source = readReference(root, run.source);
      const diff = await pixelDiff({ inputA: source.bytes, inputB: output.bytes, grid: 8, topRegions: 3 });
      signal.throwIfAborted();
      const artifact = createCoreArtifact(root, { artifactId: run.compare.artifactId, createdAt: run.createdAt,
        bytes: diff.heatmap, expectedDigest: flowSha256(diff.heatmap), expectedSize: diff.heatmap.length,
        kind: 'pixel-diff', mediaType: diff.mime,
        metadata: { ratio: diff.ratio, diffPixels: diff.diffPixels, totalPixels: diff.totalPixels,
          width: diff.width, height: diff.height, worstRegions: diff.worstRegions },
        relations: [run.source.artifactId, run.output.artifactId].map(artifactId => ({ type: 'derived-from', artifactId })) });
      run = updateFlowRun(root, run, { comparison: reference(artifact) });
    }
    return facts(root, run);
  }

  async function execute(name, input = {}) {
    if (name === 'flow.init') {
      exact(input, []);
      return runtime.run('execute', ({ dataRoot }) => ({ contractVersion: 0, root: initializeFlowRoot(dataRoot) }));
    }
    if (name === 'flow.create') {
      const owned = creationInput(input);
      return runtime.run('execute', async ({ dataRoot, signal }) => {
        const run = commitFlowCreation(dataRoot, await prepareCreation(dataRoot, signal, owned));
        return facts(dataRoot, run);
      });
    }
    if (name === 'flow.list') {
      exact(input, []);
      return runtime.run('inspect', ({ dataRoot }) => {
        const runs = listFlowRuns(dataRoot);
        return { contractVersion: 0, total: runs.length, runs: runs.map(run => ({ id: run.id, recipe: run.recipe,
          createdAt: run.createdAt, source: run.source, modelRef: run.input.model_ref, taskId: run.edit.taskId })) };
      });
    }
    if (name === 'flow.inspect') {
      exact(input, ['run_id']);
      return runtime.run('inspect', ({ dataRoot }) => facts(dataRoot, readFlowRun(dataRoot, input.run_id)));
    }
    if (name === 'flow.continue') {
      exact(input, ['run_id']);
      return runtime.run('execute', ({ dataRoot, signal }) => continueRun(dataRoot, signal, input.run_id));
    }
    if (name === 'flow.select' || name === 'flow.export') {
      exact(input, name === 'flow.select' ? ['run_id', 'artifact_id', 'expected_revision'] : ['run_id', 'output_path']);
      if (input.expected_revision !== undefined && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
        flowFail('IRIS_FLOW_INPUT_INVALID', '预期流程版本必须是正整数');
      }
      return runtime.run('execute', ({ dataRoot }) => {
        let run = readFlowRun(dataRoot, input.run_id);
        if (input.expected_revision !== undefined && run.revision !== input.expected_revision) {
          flowFail('IRIS_FLOW_REVISION_CONFLICT', '流程已改变，请读取当前版本后明确选择');
        }
        facts(dataRoot, run);
        if (!run.comparison) flowFail('IRIS_FLOW_NOT_READY', '请先完成改图与比较，再选择结果');
        if (name === 'flow.select') {
          const selected = [run.source, run.output].find(item => item.artifactId === input.artifact_id);
          if (!selected) flowFail('IRIS_FLOW_SELECTION_INVALID', '只能选择本流程的原图或新版');
          if (run.selection?.artifactId !== selected.artifactId) run = updateFlowRun(dataRoot, run, { selection: selected });
          return facts(dataRoot, run);
        }
        if (!run.selection) flowFail('IRIS_FLOW_SELECTION_REQUIRED', '请先明确选择要导出的原图或新版');
        return { ...facts(dataRoot, run), export: exportCoreArtifact(dataRoot, run.selection.artifactId, input.output_path) };
      });
    }
    throw new TypeError('未知的内部 Flow 命令');
  }
  return Object.freeze({ execute, prepareCreation, inspectCreation: (root, intent, options) => {
    readReference(root, intent.source);
    return facts(root, commitFlowCreation(root, intent, options));
  } });
}
