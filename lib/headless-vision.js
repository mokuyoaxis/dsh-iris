'use strict';
/** 独立视觉入口：显式配置/文件，复用共享业务；只有主动转写才使用 Core。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { CommandError } from './command-service.js';
import { visionCandidatesFromCatalog, transcribeCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from './provider-catalog.js';
import { createConfiguredVisionModelPort, readVisionImageFile } from './vision-model-routing.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { prepareProviderInput } from './provider-adapter.js';
import { createProviderTaskRunner } from './provider-task-runner.js';
import { readCoreArtifactBytes } from './core-artifacts.js';
import { createModelOperation } from './model-invoker.js';
import { ModelPortError, modelErrorRecord } from './model-port-contract.js';
import { completeVision, VISION_BUDGET } from './vision-core.js';
import { locateObject } from './locate.js';
import { longOcr, normalizeOcrSettings, formatOcrResult } from './ocr.js';
import { summarizeMedia } from './summarize.js';
import { extractFrames, normalizeFramesOptions, probeVideo, extractAudioTrack, ffmpegAvailable } from './media-probe.js';
import { waitForModelWork } from './model-call-runtime.js';

function invalid(message) { throw new CommandError('IRIS_COMMAND_INPUT_INVALID', message); }

export function normalizeVisionInput(command, input) {
  const fields = {
    look: ['image_path', 'question'], locate: ['image_path', 'target'],
    ocr: ['image_path', 'chunk_height', 'overlap', 'max_dimension', 'max_invocations'],
    summarize: ['video_path', 'question', 'max_frames', 'target_width', 'transcribe_text', 'transcribe', 'transcribe_model_ref']
  }[command];
  if (!fields) invalid('未知视觉命令');
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('--input 必须是 JSON 对象');
  if (Object.keys(input).some(key => !fields.includes(key))) invalid('视觉输入含不支持的字段');
  const fileField = command === 'summarize' ? 'video_path' : 'image_path';
  if (typeof input[fileField] !== 'string' || !path.isAbsolute(input[fileField])) invalid(fileField + ' 必须是绝对路径');
  try { if (!fs.statSync(input[fileField]).isFile()) throw new Error(); }
  catch (_) { invalid('输入媒体文件不存在或不是普通文件'); }
  for (const field of ['question', 'target', 'transcribe_text', 'transcribe_model_ref']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') invalid(field + ' 必须是字符串');
  }
  if (command === 'locate' && !input.target?.trim()) invalid('target 必须是非空字符串');
  if (input.transcribe !== undefined && typeof input.transcribe !== 'boolean') invalid('transcribe 必须是布尔值');
  if (input.transcribe && input.transcribe_text?.trim()) invalid('transcribe 与 transcribe_text 不能同时使用');
  if (input.transcribe_model_ref !== undefined && !input.transcribe) invalid('transcribe_model_ref 需要 transcribe=true');
  if (input.transcribe_model_ref !== undefined && !/^[^:]+::.+$/.test(input.transcribe_model_ref)) invalid('transcribe_model_ref 必须是 providerId::modelId');
  if (command === 'ocr') normalizeOcrSettings({ chunkHeight: input.chunk_height, overlap: input.overlap,
    maxDimension: input.max_dimension, maxInvocations: input.max_invocations });
  if (command === 'summarize') {
    try { normalizeFramesOptions({ maxFrames: input.max_frames, targetWidth: input.target_width }); }
    catch (_) { invalid('max_frames 或 target_width 无效'); }
  }
  return input;
}

function selectedModel(completion, routes) {
  const route = routes.find(value => value.provider.id === completion.identity?.providerId && value.model === completion.identity?.modelId);
  return route ? { modelRef: route.modelRef, selectionReason: route.selectionReason } : {};
}

function completionResult(completion, routes) {
  const { sheet: _sheet, ...result } = completion;
  return { ...result, ...selectedModel(completion, routes) };
}

async function transcribeVideo({ catalog, input, runtime, operation }) {
  const routes = transcribeCandidatesFromCatalog(catalog, input.transcribe_model_ref);
  const candidates = routes.map(route => ({ adapter: createConfiguredProviderAdapter(route.provider),
    model: route.modelRef, selectionReason: route.selectionReason, providerBinding: providerTaskBinding(route.provider) }));
  const audio = await waitForModelWork(() => extractAudioTrack({ inputPath: input.video_path, signal: operation.signal }), operation.signal);
  const abortRuntime = () => { void runtime.dispose().catch(() => {}); };
  operation.signal.addEventListener('abort', abortRuntime, { once: true });
  let task;
  try {
    const prepared = await waitForModelWork(() => prepareProviderInput(candidates[0].adapter, {
      model: routes[0].model, filePath: audio.filePath, signal: operation.signal
    }), operation.signal);
    const runner = createProviderTaskRunner(runtime);
    const submitted = await waitForModelWork(() => runner.submit({ capability: 'transcribe', candidates,
      providerInput: { audioUrl: prepared.url } }), operation.signal, 'invoke', 'unknown');
    task = submitted.task;
    if (task.acceptance === 'accepted' && task.outcome === 'none') {
      const adapter = createConfiguredProviderAdapter(providerForTaskFromCatalog(catalog, task));
      while (task.outcome === 'none') {
        task = await waitForModelWork(() => runner.observe(task.id, adapter), operation.signal, 'read', 'responded');
        if (task.outcome === 'none') await waitForModelWork(() => delay(1000, undefined, { signal: operation.signal }), operation.signal);
      }
    }
    const report = { taskId: task.id, modelRef: task.modelRef, artifactIds: task.artifactIds, status: 'failed' };
    if (task.outcome !== 'succeeded' || task.deliveryState !== 'ready') return { report, text: '' };
    const texts = await runtime.run('inspect', ({ dataRoot }) => task.artifactIds.map(id => {
      const artifact = readCoreArtifactBytes(dataRoot, id);
      return artifact.artifact.mediaType.startsWith('text/') ? artifact.bytes.toString('utf8') : '';
    }));
    return { report: { ...report, status: 'complete' }, text: texts.filter(Boolean).join('\n') };
  } catch (error) {
    const record = modelErrorRecord(error);
    if (['IRIS_MODEL_ABORTED', 'IRIS_MODEL_TIMEOUT'].includes(record.code)) throw error;
    return { report: { status: 'failed', code: record.code, ...(task ? { taskId: task.id, modelRef: task.modelRef, artifactIds: task.artifactIds } : {}) }, text: '' };
  } finally {
    operation.signal.removeEventListener('abort', abortRuntime);
    fs.rmSync(audio.outDir, { recursive: true, force: true });
  }
}

export async function executeVisionCommand({ command, input, catalog, modelRef = '', runtime, signal, timeoutMs = VISION_BUDGET.timeoutMs }) {
  normalizeVisionInput(command, input);
  if (modelRef && !/^[^:]+::.+$/.test(modelRef)) invalid('--model-ref 必须是 providerId::modelId');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > VISION_BUDGET.timeoutMs) invalid('--timeout-ms 必须是 1–120000 的整数');
  if (input.transcribe && !runtime) invalid('主动音轨转写需要 --data-root');
  const routes = visionCandidatesFromCatalog(catalog, modelRef);
  const ports = routes.map(route => createConfiguredVisionModelPort(route.provider, route.model));
  const budget = { ...VISION_BUDGET, timeoutMs };
  const operation = createModelOperation({ signal, budget: { timeoutMs, maxInvocations: command === 'ocr' ? input.max_invocations ?? 64 : ports.length } });
  const base = { schemaVersion: 1, command: 'vision.' + command, status: 'complete' };
  try {
    if (command === 'summarize') {
      if (!ffmpegAvailable()) throw new CommandError('IRIS_MEDIA_TOOL_UNAVAILABLE', '视频摘要需要 PATH 中的 ffmpeg 和 ffprobe');
      const meta = await waitForModelWork(() => probeVideo(input.video_path), operation.signal);
      const frames = await waitForModelWork(() => extractFrames({ inputPath: input.video_path,
        maxFrames: input.max_frames, targetWidth: input.target_width, signal: operation.signal }), operation.signal);
      let transcript = input.transcribe_text || '', transcription = { status: transcript.trim() ? 'provided' : 'disabled' };
      if (input.transcribe) {
        const asr = meta.hasAudio ? await transcribeVideo({ catalog, input, runtime, operation }) : { report: { status: 'no_audio' }, text: '' };
        transcript = asr.text; transcription = asr.report;
      }
      const completion = await summarizeMedia({ ports, frames, question: input.question, transcript, operation, budget });
      const sheet = completion.sheet;
      const note = transcription.status === 'failed' ? '音轨转写失败，本次摘要只分析画面。' : '';
      if (note) transcription.note = note;
      return { result: { ...base, ...completionResult(completion, routes), meta,
        frames: frames.map(({ atSec, width, height }) => ({ atSec, width, height })), transcription,
        contactSheet: { mediaType: 'image/png', width: sheet.width, height: sheet.height,
          sha256: createHash('sha256').update(sheet.buffer).digest('hex') } }, text: completion.text + (note ? '\n\n[iris] ' + note : ''), sheetBuffer: sheet.buffer, exitCode: 0 };
    }
    const mediaType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(input.image_path).toLowerCase()];
    if (!mediaType) invalid('图片只支持 PNG、JPEG、WebP、GIF');
    const image = await readVisionImageFile(input.image_path, mediaType, operation.signal);
    if (command === 'ocr') {
      const ocr = await longOcr({ image, ports, chunkHeight: input.chunk_height, overlap: input.overlap,
        maxDimension: input.max_dimension, maxInvocations: input.max_invocations, operation, budget });
      return { result: { ...base, ...ocr, chunks: ocr.chunks.map(chunk => ({ ...chunk, ...selectedModel(chunk, routes) })) },
        text: formatOcrResult(ocr), exitCode: ocr.status === 'complete' ? 0 : 1 };
    }
    let completion;
    if (command === 'locate') {
      const { width, height } = await waitForModelWork(() => sharp(Buffer.from(image.bytes)).metadata(), operation.signal);
      completion = await locateObject(ports, { target: input.target, image, width, height }, { operation, budget });
      return { result: { ...base, ...completionResult(completion, routes), width, height }, text: JSON.stringify(completion.bbox), exitCode: 0 };
    }
    completion = await completeVision(ports, { prompt: input.question?.trim() || '请用中文描述这张图片的内容。', image }, { operation, budget });
    return { result: { ...base, ...completionResult(completion, routes) }, text: completion.text, exitCode: 0 };
  } catch (error) {
    if (error instanceof ModelPortError || error instanceof CommandError || error.name === 'ProviderCatalogError') throw error;
    throw new ModelPortError('IRIS_MODEL_INPUT_INVALID', { stage: 'prepare', invocation: 'not_invoked' });
  } finally { operation.dispose(); }
}
