'use strict';

import { createCoreArtifact, exportCoreArtifact, inspectCoreArtifactMetadata, readCoreArtifactBytes } from './core-artifacts.js';
import { assertFlowTaskMatches, claimFlowTask, findFlowTask, recoverCoreTask } from './core-tasks.js';
import { deliveryCacheNeedsProvider } from './core-delivery-cache.js';
import { normalizeGenerationInput } from './generation-input.js';
import { videoModelSupportsMode } from './video-input.js';
import { imageEditCandidates, readImageEditArtifact } from './image-edit-input.js';
import { parseModelRef } from './models.js';
import { pixelDiff } from './pixels.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { prepareProviderInput } from './provider-adapter.js';
import { sameNetworkRequirement } from './network-policy.js';
import { VIDEO_RECIPE, VIDEO_TYPES, MAX_VIDEO_BYTES, normalizeVideoFlowInput } from './video-flow-input.js';
import { AUDIO_RECIPES, AUDIO_TYPES, isAudioRecipe, normalizeAudioFlowInput, readImportAudio } from './audio-flow-input.js';
import { isVisionRecipe, normalizeVisionFlowInput, readVisionFlowImage, visionProviderInput, parseOcrReport, projectOcrSummary } from './vision-flow-input.js';
import { commitFlowCreation, flowFail, flowSha256, flowStep, flowStepId, initializeFlowRoot, inspectFlowRoot,
  IMAGE_GENERATE_RECIPE, requireImageGenerationRoot, requireAudioRoot, requireVideoRoot, requireVisionRoot, listFlowRuns, prepareFlowCreation, readFlowRun, updateFlowRun } from './flow-store.js';

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
  const source = run.source ? readReference(root, run.source) : null;
  const task = findFlowTask(root, run);
  if (run.output) {
    if (task.deliveryState !== 'ready' || task.artifactIds.length !== (run.recipe === 'ocr/v0' ? 2 : 1) || task.artifactIds[0] !== run.output.artifactId) {
      flowFail('IRIS_FLOW_TASK_CONFLICT', '流程输出与原 Task 的交付事实不一致');
    }
    const { artifact } = readReference(root, run.output);
    if (artifact.metadata.taskId !== task.id || source && !artifact.relations.some(edge => edge.type === 'derived-from' && edge.artifactId === source.artifact.id)
        || !source && artifact.relations.length) {
      flowFail('IRIS_FLOW_ARTIFACT_CONFLICT', '流程输出缺少原 Task 或来源关系');
    }
  }
  let ocr;
  if (run.report) {
    const report = readReference(root, run.report);
    if (task.artifactIds[1] !== run.report.artifactId || report.artifact.mediaType !== 'application/json'
        || report.artifact.metadata.taskId !== task.id || !report.artifact.relations.some(edge => edge.type === 'derived-from' && edge.artifactId === run.source.artifactId)) {
      flowFail('IRIS_FLOW_ARTIFACT_CONFLICT', 'OCR报告与原任务或来源不一致');
    }
    ocr = projectOcrSummary(parseOcrReport(report.bytes, { plan: run.plan, maxInvocations: run.input.max_invocations }));
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
  else if (task?.deliveryState === 'ready') status = isVisionRecipe(run.recipe) ? run.output ? ocr && ocr.status !== 'complete' ? 'needs_attention' : 'ready' : 'needs_result'
    : isAudioRecipe(run.recipe) || run.recipe === VIDEO_RECIPE ? run.output ? 'ready' : 'needs_result'
    : run.output && (run.recipe === IMAGE_GENERATE_RECIPE || run.comparison)
    ? run.selection ? 'selected' : 'awaiting_selection' : run.recipe === IMAGE_GENERATE_RECIPE ? 'needs_result' : 'needs_comparison';
  else if (task?.deliveryState === 'failed') status = 'delivery_failed';
  else if (task?.attempts.length) status = task.acceptance === 'accepted' ? 'running' : 'needs_attention';
  return { contractVersion: 0, run, task, status, ...(comparison ? { metrics: comparison.metadata } : {}),
    ...(run.plan ? { plan: run.plan } : {}), ...(ocr ? { ocr } : {}) };
}

/** Fixed media recipes, sharing operation-scoped leases and the original Task. */
export function createImageFlowService(runtime, { resolveImageCandidates, resolveAudioCandidates, resolveVideoCandidates, resolveVisionCandidates, resolveTaskAdapter } = {}) {
  function creationInput(input) {
    if (isVisionRecipe(input?.recipe)) { const { recipe, ...value } = input; return { recipe, ...normalizeVisionFlowInput(recipe, value) }; }
    if (input?.recipe === VIDEO_RECIPE) { const { recipe, ...value } = input; return { recipe, ...normalizeVideoFlowInput(value) }; }
    if (isAudioRecipe(input?.recipe)) {
      const { recipe, ...value } = input;
      return { recipe, ...normalizeAudioFlowInput(recipe, value) };
    }
    const normalized = normalizeGenerationInput('image', input);
    if (!parseModelRef(normalized.modelRef) || normalized.providerInput.n !== 1) {
      flowFail('IRIS_FLOW_INPUT_INVALID', '图片流程需要明确 model_ref 和 n=1；改图还需来源 Artifact');
    }
    return { prompt: normalized.providerInput.prompt, model_ref: normalized.modelRef,
      ...(normalized.sourceArtifactId ? { source_artifact_id: normalized.sourceArtifactId } : {}), n: 1,
      ...(normalized.providerInput.size !== undefined ? { size: normalized.providerInput.size } : {}),
      ...(normalized.providerInput.workflow_parameters !== undefined ? { workflow_parameters: normalized.providerInput.workflow_parameters } : {}) };
  }
  async function prepareCreation(root, signal, input) {
    const owned = creationInput(input);
    inspectFlowRoot(root);
    const audio = isAudioRecipe(owned.recipe);
    const video = owned.recipe === VIDEO_RECIPE;
    const vision = isVisionRecipe(owned.recipe);
    if (vision) requireVisionRoot(root);
    else if (video) requireVideoRoot(root);
    else if (audio) requireAudioRoot(root);
    else if (!owned.source_artifact_id) requireImageGenerationRoot(root);
    const source = owned.source_artifact_id ? vision ? await readVisionFlowImage(root, owned.source_artifact_id, signal, owned)
      : audio ? readAudioSource(root, owned.source_artifact_id) : await readImageEditArtifact(root, owned.source_artifact_id, signal) : null;
    const candidates = await candidatesFor(owned, signal);
    const { recipe, ...audioInput } = owned;
    return prepareFlowCreation({ ...(source ? { source: { artifactId: owned.source_artifact_id, sha256: flowSha256(source.bytes) } } : {}),
      input: audio || video || vision ? audioInput : owned, providerBinding: candidates[0].providerBinding,
      ...(source?.plan ? { plan: source.plan } : {}),
      ...(candidates[0].adapter.networkRequirement ? { networkRequirement: candidates[0].adapter.networkRequirement } : {}), ...(audio || video || vision ? { recipe } : {}) });
  }
  function readAudioSource(root, id) {
    const source = readCoreArtifactBytes(root, id);
    readImportAudio(source.bytes, source.artifact.mediaType);
    return source;
  }
  async function candidatesFor(runInput, signal, binding) {
    const audio = isAudioRecipe(runInput.recipe), video = runInput.recipe === VIDEO_RECIPE, vision = isVisionRecipe(runInput.recipe),
      resolver = vision ? resolveVisionCandidates : video ? resolveVideoCandidates : audio ? resolveAudioCandidates : resolveImageCandidates;
    // Keep historical records readable; restrict only creation/first dispatch.
    if (video && !videoModelSupportsMode(parseModelRef(runInput.model_ref).modelId, 't2v')) {
      flowFail('IRIS_VIDEO_FLOW_INPUT_INVALID', '固定文生视频流程需要匹配的模型，不接受图生视频、S2V 或参考视频模型；已有 Task 仍可按原身份观察');
    }
    if (!resolver) flowFail('IRIS_FLOW_PROVIDER_REQUIRED', '创建或首次提交流程需要显式 Provider 配置');
    signal.throwIfAborted();
    const resolve = () => resolver({ modelRef: runInput.model_ref, signal, input: runInput,
      ...(audio ? { capability: AUDIO_RECIPES[runInput.recipe].capability } : {}) });
    const candidates = await (runtime.networkWait ? runtime.networkWait(resolve, 'candidates') : resolve());
    signal.throwIfAborted();
    const parsed = parseModelRef(runInput.model_ref);
    if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0].model !== runInput.model_ref
        || candidates[0].adapter?.id !== parsed.providerId || !/^sha256:[a-f0-9]{64}$/.test(candidates[0].providerBinding)) {
      flowFail('IRIS_FLOW_INPUT_CONFLICT', '流程必须绑定单一明确模型和有效的连接摘要');
    }
    if (binding !== undefined && candidates[0].providerBinding !== binding) flowFail('IRIS_FLOW_PROVIDER_CHANGED', '连接或协议已改变；原流程不重新绑定或生成');
    const resolved = [{ ...candidates[0], providerModel: parsed.modelId, selectionReason: 'explicit' }];
    return runInput.source_artifact_id && !audio && !vision ? imageEditCandidates(resolved) : resolved;
  }

  async function adapterFor(task, signal) {
    if (!resolveTaskAdapter) flowFail('IRIS_FLOW_PROVIDER_REQUIRED', '观察或远端补交付需要原 Task 的 Provider 配置');
    const resolve = () => resolveTaskAdapter(task, { signal });
    const adapter = await (runtime.networkWait ? runtime.networkWait(resolve, 'candidates') : resolve());
    signal.throwIfAborted();
    return adapter;
  }

  async function continueRun(root, signal, id) {
    let run = readFlowRun(root, id);
    let task = facts(root, run).task;
    if (task?.attempts.length && !flowStep(run).claimed) flowFail('IRIS_FLOW_TASK_CONFLICT', '步骤检查点与已开始的 Task 冲突');
    const runner = createProviderTaskRunner(runtime);
    if (task) runner.assertIdle(task.id);
    if (!task || !task.attempts.length) {
      const audio = isAudioRecipe(run.recipe);
      const video = run.recipe === VIDEO_RECIPE;
      const vision = isVisionRecipe(run.recipe);
      let candidates = await candidatesFor({ ...run.input, ...(audio || video || vision ? { recipe: run.recipe } : {}) }, signal, run.providerBinding);
      if (!sameNetworkRequirement(run.networkRequirement, candidates[0].adapter.networkRequirement)) flowFail('IRIS_NETWORK_REQUIREMENT_MISMATCH', '流程网络要求已改变，不会隐式转换或解除');
      if (run.recipe === 'transcribe/v0') {
        const source = readAudioSource(root, run.source.artifactId);
        candidates = candidates.map(candidate => ({ ...candidate, prepareInput: async ({ signal, taskId, attemptId, networkBudget, recordNetworkRoute, modelRef, providerId }) => {
          const prepared = await prepareProviderInput(candidate.adapter, { model: candidate.providerModel, bytes: source.bytes,
            filename: source.artifact.id + '.' + AUDIO_TYPES[source.artifact.mediaType], signal }, { taskId, attemptId, networkBudget, recordNetworkRoute, modelRef, providerId });
          return { audioUrl: prepared.url };
        } }));
      }
      task = claimFlowTask(root, run.id);
      if (!flowStep(run).claimed) run = updateFlowRun(root, run, { [flowStepId(run)]: { ...flowStep(run), claimed: true } });
      signal.throwIfAborted();
      const normalized = vision ? visionProviderInput(run.recipe, run.input)
        : audio || video ? Object.fromEntries(Object.entries(run.input).filter(([key]) => key !== 'model_ref'))
        : normalizeGenerationInput('image', run.input).providerInput;
      task = (await runner.submit({ capability: vision ? 'vision' : video ? 'video' : audio ? AUDIO_RECIPES[run.recipe].capability : 'image', candidates, providerInput: normalized,
        sourceArtifactId: run.source?.artifactId, flowRunId: run.id })).task;
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
    if (task.artifactIds.length !== (run.recipe === 'ocr/v0' ? 2 : 1)) flowFail('IRIS_FLOW_RESULT_UNSUPPORTED', '流程结果数量不符合契约，原 Task 与作品已保留');
    if (isVisionRecipe(run.recipe)) {
      const output = readCoreArtifactBytes(root, task.artifactIds[0]);
      if (output.artifact.mediaType !== 'text/plain') flowFail('IRIS_FLOW_RESULT_UNSUPPORTED', '视觉正文必须是text/plain');
      const report = run.recipe === 'ocr/v0' ? readCoreArtifactBytes(root, task.artifactIds[1]) : null;
      if (report) {
        if (report.artifact.mediaType !== 'application/json') flowFail('IRIS_FLOW_RESULT_UNSUPPORTED', 'OCR报告必须是application/json');
        parseOcrReport(report.bytes, { plan: run.plan, maxInvocations: run.input.max_invocations });
      }
      if (!run.output) run = updateFlowRun(root, run, { output: reference(output.artifact), ...(report ? { report: reference(report.artifact) } : {}) });
      return facts(root, run);
    }
    if (run.recipe === VIDEO_RECIPE) {
      const metadata = inspectCoreArtifactMetadata(root, task.artifactIds[0]);
      if (!Object.hasOwn(VIDEO_TYPES, metadata.mediaType) || metadata.size > MAX_VIDEO_BYTES) {
        flowFail('IRIS_FLOW_RESULT_UNSUPPORTED', '视频首片只交付不超过 32 MiB 的 MP4/WebM；原 Task 与作品已保留');
      }
    }
    const output = readCoreArtifactBytes(root, task.artifactIds[0]);
    if (!run.output) run = updateFlowRun(root, run, { output: reference(output.artifact) });
    facts(root, run);
    if (run.source && !run.comparison && !isAudioRecipe(run.recipe)) {
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
          createdAt: run.createdAt, ...(run.source ? { source: run.source } : {}), modelRef: run.input.model_ref, taskId: flowStep(run).taskId })) };
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
        if (isAudioRecipe(run.recipe) || run.recipe === VIDEO_RECIPE || isVisionRecipe(run.recipe)) {
          if (name === 'flow.select') flowFail('IRIS_FLOW_SELECTION_INVALID', '视频、音频和转写为单一结果，无需选择图片版本');
          if (!run.output) flowFail('IRIS_FLOW_NOT_READY', '请先接回原任务的结果');
          return { ...facts(dataRoot, run), export: exportCoreArtifact(dataRoot, run.output.artifactId, input.output_path) };
        }
        if (!run.output || run.source && !run.comparison) flowFail('IRIS_FLOW_NOT_READY', '请先保存生成结果；改图还需完成比较');
        if (name === 'flow.select') {
          const selected = [run.source, run.output].filter(Boolean).find(item => item.artifactId === input.artifact_id);
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
    if (intent.source) readReference(root, intent.source);
    return facts(root, commitFlowCreation(root, intent, options));
  } });
}
