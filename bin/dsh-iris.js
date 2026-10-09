#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { doctor, formatDoctorReport } from '../lib/doctor.js';
import { loadProviderCatalog, providerCatalogSnapshot, catalogCapabilitySnapshot, imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding, transcribeCandidatesFromCatalog, ttsCandidatesFromCatalog, videoCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { providerForImageModel } from '../lib/provider-protocol.js';
import { prepareProviderInput } from '../lib/provider-adapter.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { GenerationInputError, normalizeGenerationInput } from '../lib/generation-input.js';
import { executeVisionCommand, normalizeVisionInput } from '../lib/headless-vision.js';
import { videoTaskCandidates } from '../lib/video-input.js';
import { createChromiumBrowser } from '../lib/chromium-browser.js';
import { executeConfigCommand, recordCatalogRateLimit } from '../lib/provider-config-service.js';
import { probeVisionModel } from '../lib/vision-model-routing.js';
import { RED_TEST_IMAGE } from '../lib/vision.js';
import { parseModelRef, modelRef as qualifiedModelRef } from '../lib/models.js';
import { coreTaskWaitFinished } from '../lib/task-wait.js';

function trackedProviderAdapter(provider, options, task) {
  return createConfiguredProviderAdapter(provider, {
    modelId: parseModelRef(task?.modelRef)?.modelId,
    onRateLimit: event => recordCatalogRateLimit(options['provider-config'], event)
  });
}

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
    this.code = 'IRIS_CLI_USAGE';
  }
}

function usage() {
  return [
    'Usage:',
    '  JSON input: --input <json>, --input-file <path>, or --input - (stdin).',
    '  dsh-iris doctor [--data-root <absolute-path>] [--json]',
    '  dsh-iris runtime recover --data-root <absolute-path> --confirm-stale-pid <pid>',
    '  dsh-iris providers list --provider-config <absolute-path>',
    '  dsh-iris capabilities list --provider-config <absolute-path>',
    '  dsh-iris config <init|show|check> --provider-config <absolute-path>',
    '  dsh-iris providers <add|set> --provider-config <absolute-path> --input <provider-json>',
    '  dsh-iris providers remove <provider-id> --provider-config <absolute-path>',
    '  dsh-iris models list --provider-config <absolute-path>',
    '  dsh-iris models <add|remove|caps|protocol|vision-input> <providerId::modelId> --provider-config <absolute-path> [--input <json>]',
    '  dsh-iris models discover <provider-id> --provider-config <absolute-path> [--apply <true|false>]',
    '  dsh-iris models test <providerId::modelId> --capability <vision|tts|image-gen|video-gen|transcribe> --provider-config <absolute-path> [--data-root <absolute-path>]',
    '  dsh-iris assignments <list|set|clear> --provider-config <absolute-path> [--input <json>]',
    '  dsh-iris vision <look|locate|ocr|summarize> --provider-config <absolute-path> --input <json> [--model-ref <providerId::modelId>] [--format <json|text>] [--output <path>] [--timeout-ms <1..120000>]',
    '    Core artifact_id / frame_artifact_ids inputs or transcribe=true require --data-root <absolute-path>; summarize supports --sheet-output <path>.',
    '  dsh-iris run crop --data-root <absolute-path> --input <json>',
    '  dsh-iris media diff --data-root <absolute-path> --input <json>',
    '  dsh-iris media frames --data-root <absolute-path> --input <json>',
    '  dsh-iris media html --data-root <absolute-path> --input <json> --browser-executable <absolute-path> [--browser-no-sandbox <true|false>] [--output <absolute-path>]',
    '  dsh-iris run image --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run video --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run tts --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run transcribe --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris task inspect <id> --data-root <absolute-path>',
    '  dsh-iris task list --data-root <absolute-path>',
    '    list supports --offset, --limit, --status, --capability, --provider-id, --model-ref, --outcome, --delivery-state.',
    '  dsh-iris <task|artifact> inspect-many --data-root <absolute-path> --input <json>',
    '  dsh-iris task observe <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task wait <id> --data-root <absolute-path> [--provider-config <absolute-path>] [--timeout-ms <1..1200000>] [--poll-interval-ms <50..60000>]',
    '  dsh-iris task redeliver <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task cancel <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task retry <id> --data-root <absolute-path> --provider-config <absolute-path> --input <json> --confirm-billing [--model-ref <providerId::modelId>]',
    '  dsh-iris artifact inspect <id> --data-root <absolute-path>',
    '  dsh-iris artifact list --data-root <absolute-path>',
    '    artifact list supports --offset, --limit, --kind, --media-type, --task-id.',
    '  dsh-iris artifact export-many --data-root <absolute-path> --input <json> --output <absolute-directory>',
    '  dsh-iris artifact export <id> --data-root <absolute-path> --output <absolute-path>',
    '  dsh-iris artifact rebuild --data-root <absolute-path>',
    '  dsh-iris core <delete|cleanup> --data-root <absolute-path> [--input <json>] [--confirm-delete]',
    '    Default is a read-only preview. delete selects task_ids/artifact_ids; cleanup executes only explicitly selected preview paths.',
    '  dsh-iris core transactions --data-root <absolute-path>',
    '  dsh-iris core restore <transaction-id> --data-root <absolute-path>',
    '',
    'Commands never start DSH. run image and the task observe/redeliver/cancel/retry verbs contact a provider only when explicitly requested; credentials come from a private file. observe polls once, redeliver only re-downloads, and cancel is recorded as canceled only when the provider explicitly confirms; none of them ever submits an existing task again. task retry creates a NEW task that may incur duplicate generation billing and requires --confirm-billing; the prompt must be supplied again because Core never persists prompts.'
  ].join('\n');
}

function flags(args, allowed) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : '';
    if (!name || !(allowed.includes(name) || name === 'input-file' && allowed.includes('input')) || index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
      throw new CliUsageError('参数无效：' + String(flag || ''));
    }
    if (Object.prototype.hasOwnProperty.call(parsed, name)) throw new CliUsageError('参数重复：--' + name);
    parsed[name] = args[index + 1];
  }
  if (parsed['input-file']) {
    if (parsed.input !== undefined) throw new CliUsageError('--input 与 --input-file 只能选一个');
    parsed.input = readJsonSource(parsed['input-file']);
  } else if (parsed.input === '-') parsed.input = readJsonSource(0);
  return parsed;
}

function readJsonSource(file) {
  let fd;
  try {
    fd = file === 0 ? 0 : fs.openSync(file, 'r');
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let offset = 0, count;
    while (offset < bytes.length && (count = fs.readSync(fd, bytes, offset, bytes.length - offset, null))) offset += count;
    if (offset === bytes.length) throw new Error('too large');
    return bytes.subarray(0, offset).toString('utf8');
  } catch (_) { throw new CliUsageError('无法读取 JSON 输入，或大小超过 2 MiB'); }
  finally { if (fd !== undefined && fd !== 0) fs.closeSync(fd); }
}

function required(value, flag) {
  if (!String(value || '').trim()) throw new CliUsageError('缺少参数：--' + flag);
  return String(value);
}

function jsonInput(value) {
  try {
    const parsed = JSON.parse(required(value, 'input'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError('--input 必须是 JSON 对象');
  }
}

function generationInput(capability, input, options) {
  try { return normalizeGenerationInput(capability, input, options); }
  catch (error) {
    if (error instanceof GenerationInputError) throw new CliUsageError(error.message);
    throw error;
  }
}

/** C-8: catchable signals dispose active runtimes before the CLI exits. */
const activeRuntimes = new Set();
const cliAbortController = new AbortController();
let shuttingDown = false;

function registerRuntime(runtime) {
  activeRuntimes.add(runtime);
  return () => activeRuntimes.delete(runtime);
}

async function disposeActiveRuntimes() {
  await Promise.allSettled([...activeRuntimes].map((runtime) => runtime.dispose().catch(() => {})));
  activeRuntimes.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    if (shuttingDown) process.exit(exitCode);
    shuttingDown = true;
    cliAbortController.abort();
    disposeActiveRuntimes()
      .catch(() => {})
      .finally(() => process.exit(exitCode));
  });
}

async function withRawRuntime(mode, dataRoot, callback) {
  const runtime = createCoreRuntime({ dataRoot: required(dataRoot, 'data-root'), mode });
  const unregister = registerRuntime(runtime);
  try {
    runtime.start();
    return await callback(runtime);
  } finally {
    try { await runtime.dispose(); } finally { unregister(); }
  }
}

async function withRuntime(mode, dataRoot, callback, ports = {}) {
  return withRawRuntime(mode, dataRoot, (runtime) => callback(createCommandService(runtime, ports)));
}

async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return args.length ? 0 : 2;
  }

  if (args[0] === 'doctor') {
    const rest = args.slice(1);
    if (rest.filter((arg) => arg === '--json').length > 1) throw new CliUsageError('参数重复：--json');
    const options = flags(rest.filter((arg) => arg !== '--json'), ['data-root']);
    const report = await doctor({ ...(options['data-root'] ? { dataRoot: options['data-root'] } : {}) });
    console.log(rest.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    return report.exitCode;
  }

  if (args[0] === 'runtime' && args[1] === 'recover') {
    const options = flags(args.slice(2), ['data-root', 'confirm-stale-pid']);
    const confirmStalePid = Number(required(options['confirm-stale-pid'], 'confirm-stale-pid'));
    if (!Number.isSafeInteger(confirmStalePid) || confirmStalePid <= 0) {
      throw new CliUsageError('--confirm-stale-pid 必须是 Doctor 报告中的正整数 PID');
    }
    const result = recoverCoreWriterLease(required(options['data-root'], 'data-root'), { confirmStalePid });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'core' && ['delete', 'cleanup', 'transactions', 'restore'].includes(args[1])) {
    const verb = args[1], restoring = verb === 'restore', selecting = ['delete', 'cleanup'].includes(verb);
    const rest = args.slice(restoring ? 3 : 2);
    const confirmation = rest.filter(arg => arg === '--confirm-delete').length;
    if (confirmation > 1 || (confirmation && !selecting)) throw new CliUsageError('--confirm-delete 参数无效或重复');
    const options = flags(rest.filter(arg => arg !== '--confirm-delete'), ['data-root', ...(selecting ? ['input'] : [])]);
    const input = restoring ? { transaction_id: required(args[2], 'transaction-id') } : selecting
      ? { ...(options.input ? jsonInput(options.input) : {}), confirm_delete: confirmation === 1 } : {};
    const result = await withRuntime(restoring || confirmation ? 'writer' : 'reader', options['data-root'], commands => commands.execute('core.' + verb, input));
    console.log(JSON.stringify(result, null, 2));
    return result.allowed === false ? 1 : 0;
  }

  if (['providers', 'capabilities'].includes(args[0]) && args[1] === 'list') {
    const options = flags(args.slice(2), ['provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const report = args[0] === 'providers' ? providerCatalogSnapshot(catalog) : catalogCapabilitySnapshot(catalog);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (['config', 'providers', 'models', 'assignments'].includes(args[0])) {
    const [group, verb] = args;
    const verbs = { config: ['init', 'show', 'check'], providers: ['add', 'set', 'remove'], models: ['list', 'add', 'remove', 'caps', 'protocol', 'vision-input', 'discover', 'test'], assignments: ['list', 'set', 'clear'] };
    if (!verbs[group].includes(verb)) throw new CliUsageError('未知配置命令');
    const positional = (group === 'providers' && verb === 'remove') || (group === 'models' && verb !== 'list');
    const id = positional ? required(args[2], group === 'providers' || verb === 'discover' ? 'provider-id' : 'model-ref') : undefined;
    const options = flags(args.slice(positional ? 3 : 2), ['provider-config', 'input', 'apply', 'capability', 'data-root']);
    if (options.apply !== undefined && !['true', 'false'].includes(options.apply)) throw new CliUsageError('--apply 必须是 true 或 false');
    let input = options.input ? jsonInput(options.input) : {};
    const probeInput = { ...input };
    if (group === 'providers') input = ['add', 'set'].includes(verb) ? { provider: jsonInput(options.input) } : { provider_id: id };
    if (group === 'models' && positional) {
      if (verb === 'discover') input = { provider_id: id, apply: options.apply === 'true' };
      else {
        if (!parseModelRef(id)) throw new CliUsageError('模型必须用 providerId::modelId 复合引用');
        input = { ...input, model_ref: id, ...(verb === 'test' ? { capability: required(options.capability, 'capability') } : {}) };
      }
    }
    const result = await executeConfigCommand(required(options['provider-config'], 'provider-config'), group === 'config' ? verb : group + '.' + verb, input, {
      signal: cliAbortController.signal,
      probe: async ({ provider, modelId, capability, signal }) => {
        if (capability === 'vision') return probeVisionModel(provider, modelId, { bytes: Buffer.from(RED_TEST_IMAGE.split(',')[1], 'base64'), mediaType: 'image/png' }, { signal });
        if (['video-gen', 'transcribe'].includes(capability) && !options.input) return {
          skipped: true, ok: false, reason: '请用 models test --input 提供与 run video/transcribe 相同的真实素材；未发起请求'
        };
        return withRawRuntime('writer', options['data-root'], async runtime => {
          const mediaCapability = capability === 'image-gen' ? 'image' : capability === 'video-gen' ? 'video' : capability;
          if (mediaCapability === 'image') provider = providerForImageModel(provider, modelId);
          const adapter = createConfiguredProviderAdapter(provider, { allowRateLimited: true, modelId });
          let providerInput = mediaCapability === 'image'
            ? { prompt: 'red circle', n: 1, ...(['openai-chat-images', 'openai-responses-images'].includes(adapter.protocol) ? {} : {
              size: adapter.protocol === 'openai-images' ? '256x256' : '512*512'
            }) }
            : { text: '你好', voice: provider.ttsVoice || 'Cherry' };
          let candidates = [{ adapter, model: qualifiedModelRef(provider.id, modelId), selectionReason: 'explicit', providerBinding: providerTaskBinding(provider) }];
          if (['video', 'transcribe'].includes(mediaCapability)) {
            const normalized = generationInput(mediaCapability, { ...probeInput, model_ref: qualifiedModelRef(provider.id, modelId) },
              { allowVideoPaths: true, allowAudioPath: true });
            providerInput = normalized.providerInput;
            if (mediaCapability === 'video') candidates = videoTaskCandidates(candidates, normalized);
            else if (normalized.audioPath) {
              const prepared = await prepareProviderInput(adapter, { model: modelId, filePath: normalized.audioPath, signal });
              providerInput = generationInput('transcribe', { audio_url: prepared.url }).providerInput;
            }
          }
          const submitted = await createProviderTaskRunner(runtime).submit({ capability: mediaCapability,
            candidates, providerInput });
          const waited = await createCommandService(runtime, { resolveTaskAdapter: () => adapter }).execute('task.wait', {
            task_id: submitted.task.id, timeout_ms: 60000, poll_interval_ms: 1000 });
          const task = waited.task;
          return { ok: task.outcome === 'succeeded' && task.deliveryState === 'ready', taskId: task.id,
            category: task.lastError?.category, httpStatus: task.lastError?.httpStatus };
        });
      }
    });
    console.log(JSON.stringify(result, null, 2));
    return result.valid === false || result.passed === false ? 1 : 0;
  }

  if (args[0] === 'vision' && ['look', 'locate', 'ocr', 'summarize'].includes(args[1])) {
    const command = args[1];
    const options = flags(args.slice(2), ['provider-config', 'input', 'model-ref', 'format', 'output', 'sheet-output', 'data-root', 'timeout-ms']);
    const input = normalizeVisionInput(command, jsonInput(options.input));
    const format = options.format || 'json';
    if (!['json', 'text'].includes(format)) throw new CliUsageError('--format 只支持 json 或 text');
    if (options['sheet-output'] && command !== 'summarize') throw new CliUsageError('--sheet-output 仅适用于 summarize');
    const outputs = [options.output, options['sheet-output']].filter(Boolean).map(file => path.resolve(file));
    if (new Set(outputs).size !== outputs.length) throw new CliUsageError('结果文件与拼图文件不能是同一路径');
    for (const file of outputs) {
      try {
        if (fs.existsSync(file) || !fs.statSync(path.dirname(file)).isDirectory()) throw new Error();
        fs.accessSync(path.dirname(file), fs.constants.W_OK);
      } catch (_) { throw new CliUsageError('输出文件已存在或父目录不可写'); }
    }
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const execute = runtime => executeVisionCommand({ command, input, catalog, runtime,
      onRateLimit: event => recordCatalogRateLimit(options['provider-config'], event),
      modelRef: options['model-ref'] || '', signal: cliAbortController.signal,
      ...(options['timeout-ms'] !== undefined ? { timeoutMs: Number(options['timeout-ms']) } : {}) });
    const completed = input.transcribe
      ? await withRawRuntime('writer', options['data-root'], execute)
      : input.artifact_id || input.frame_artifact_ids ? await withRawRuntime('reader', options['data-root'], execute) : await execute();
    if (cliAbortController.signal.aborted) return 130;
    const rendered = (format === 'text' ? completed.text : JSON.stringify(completed.result, null, 2)) + '\n';
    try {
      if (options.output) fs.writeFileSync(path.resolve(options.output), rendered, { flag: 'wx', mode: 0o600 });
      if (options['sheet-output']) fs.writeFileSync(path.resolve(options['sheet-output']), completed.sheetBuffer, { flag: 'wx', mode: 0o600 });
    } catch (_) { throw new CliUsageError('无法保存输出文件（不会覆盖已有文件）'); }
    process.stdout.write(rendered);
    return completed.exitCode;
  }

  if (args[0] === 'media' && args[1] === 'html') {
    const options = flags(args.slice(2), ['data-root', 'input', 'browser-executable', 'browser-no-sandbox', 'output']);
    if (options['browser-no-sandbox'] !== undefined && !['true', 'false'].includes(options['browser-no-sandbox'])) throw new CliUsageError('--browser-no-sandbox 必须是 true 或 false');
    const browser = createChromiumBrowser({ executable: options['browser-executable'] || process.env.IRIS_BROWSER_EXECUTABLE,
      noSandbox: options['browser-no-sandbox'] === 'true' });
    const input = jsonInput(options.input);
    if (options.output && (!path.isAbsolute(options.output) || fs.existsSync(options.output))) throw new CliUsageError('--output 必须是未存在的绝对路径');
    const result = await withRuntime('writer', options['data-root'], async commands => {
      const rendered = await commands.execute('media.html', input);
      return options.output ? { ...rendered, export: await commands.execute('artifact.export', { artifact_id: rendered.artifact.id, output_path: options.output }) } : rendered;
    }, { browser });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'media' && ['diff', 'frames'].includes(args[1])) {
    const options = flags(args.slice(2), ['data-root', 'input']);
    const input = jsonInput(options.input);
    const command = args[1] === 'diff' ? 'media.diff' : 'media.frames';
    const result = await withRuntime('writer', options['data-root'], (commands) =>
      commands.execute(command, input));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'run' && args[1] === 'crop') {
    const options = flags(args.slice(2), ['data-root', 'input']);
    const input = jsonInput(options.input);
    const result = await withRuntime('writer', options['data-root'], (commands) =>
      commands.execute('crop', input));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'run' && args[1] === 'image') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const { providerInput, modelRef, sourceArtifactId } = generationInput('image', jsonInput(options.input));
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = imageCandidatesFromCatalog(catalog, modelRef);
    await withRawRuntime('writer', options['data-root'], async (runtime) => {
      const candidates = routes.map((route) => ({
        adapter: trackedProviderAdapter(route.provider, options), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'image', candidates,
        providerInput, sourceArtifactId
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return 0;
  }

  // 视频共用 Core；本地首帧/音频按实际候选在 Attempt 内准备。
  if (args[0] === 'run' && args[1] === 'video') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const normalized = generationInput('video', jsonInput(options.input), { allowVideoPaths: true });
    const { providerInput, modelRef } = normalized;
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = videoCandidatesFromCatalog(catalog, modelRef);
    await withRawRuntime('writer', options['data-root'], async (runtime) => {
      const candidates = videoTaskCandidates(routes.map((route) => ({
        adapter: trackedProviderAdapter(route.provider, options), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      })), normalized);
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'video', candidates,
        providerInput
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return 0;
  }

  // 语音合成输入冻结（E2 Profile）：同步完成型，一次命令内完成 Task → Artifact。
  if (args[0] === 'run' && args[1] === 'tts') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const { providerInput, modelRef } = generationInput('tts', jsonInput(options.input));
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = ttsCandidatesFromCatalog(catalog, modelRef);
    await withRawRuntime('writer', options['data-root'], async (runtime) => {
      const candidates = routes.map((route) => ({
        adapter: trackedProviderAdapter(route.provider, options), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'tts', candidates,
        providerInput
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return 0;
  }

  // 转写输入冻结（E3 Profile）：上传型异步——audio_url（公网/oss://）或
  // audio_path（本地文件，经首选候选 Provider 的临时存储上传，签名 URL 不落 Core）。
  if (args[0] === 'run' && args[1] === 'transcribe') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const normalized = generationInput('transcribe', jsonInput(options.input), { allowAudioPath: true });
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = transcribeCandidatesFromCatalog(catalog, normalized.modelRef);
    let providerInput = normalized.providerInput;
    if (normalized.audioPath) {
      if (!fs.existsSync(normalized.audioPath)) throw new CliUsageError('音频文件不存在');
      const prepared = await prepareProviderInput(trackedProviderAdapter(routes[0].provider, options), {
        model: routes[0].model, filePath: normalized.audioPath
      });
      providerInput = generationInput('transcribe', { audio_url: prepared.url }).providerInput;
    }
    await withRawRuntime('writer', options['data-root'], async (runtime) => {
      const candidates = routes.map((route) => ({
        adapter: trackedProviderAdapter(route.provider, options), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'transcribe', candidates,
        providerInput
      });
      console.log(JSON.stringify(result, null, 2));
    });
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'wait' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config', 'timeout-ms', 'poll-interval-ms']);
    const input = { task_id: args[2], ...(options['timeout-ms'] !== undefined ? { timeout_ms: Number(options['timeout-ms']) } : {}),
      ...(options['poll-interval-ms'] !== undefined ? { poll_interval_ms: Number(options['poll-interval-ms']) } : {}) };
    const inspected = await withRuntime('reader', options['data-root'], commands => commands.execute('task.inspect', { task_id: args[2] }));
    const catalog = coreTaskWaitFinished(inspected.task) ? null : loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const result = await withRuntime(catalog ? 'writer' : 'reader', options['data-root'], commands => commands.execute('task.wait', input), {
      ...(catalog ? { resolveTaskAdapter: task => trackedProviderAdapter(providerForTaskFromCatalog(catalog, task), options, task) } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return result.timedOut ? 3 : result.ready ? 0 : 1;
  }

  if (args[0] === 'task' && args[1] === 'observe' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.observe', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => trackedProviderAdapter(providerForTaskFromCatalog(catalog, task), options, task)
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'redeliver' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.redeliver', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => trackedProviderAdapter(providerForTaskFromCatalog(catalog, task), options, task)
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'cancel' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.cancel', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => trackedProviderAdapter(providerForTaskFromCatalog(catalog, task), options, task)
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'retry' && args[2]) {
    const rest = args.slice(3);
    const confirmBilling = rest.includes('--confirm-billing');
    const options = flags(rest.filter((arg) => arg !== '--confirm-billing'),
      ['data-root', 'provider-config', 'input', 'model-ref']);
    const input = jsonInput(options.input);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const dataRoot = required(options['data-root'], 'data-root');
    await withRuntime('reader', dataRoot, (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', dataRoot, (commands) => commands.execute('task.retry', {
      task_id: args[2],
      provider_input: input,
      model_ref: options['model-ref'],
      confirm_billing: confirmBilling
    }), {
      resolveTaskCandidates: ({ capability, modelRef }) => (capability === 'video'
        ? videoCandidatesFromCatalog(catalog, modelRef || undefined)
        : capability === 'tts'
          ? ttsCandidatesFromCatalog(catalog, modelRef || undefined)
          : capability === 'transcribe'
            ? transcribeCandidatesFromCatalog(catalog, modelRef || undefined)
            : imageCandidatesFromCatalog(catalog, modelRef || undefined)
      ).map((route) => ({
        adapter: trackedProviderAdapter(route.provider, options),
        model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }))
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'inspect' && args[2]) {
    const options = flags(args.slice(3), ['data-root']);
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('task.inspect', { task_id: args[2] }));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'list') {
    const options = flags(args.slice(2), ['data-root', 'offset', 'limit', 'status', 'capability', 'provider-id', 'model-ref', 'outcome', 'delivery-state']);
    const input = Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'data-root').map(([key, value]) => [key.replaceAll('-', '_'), ['offset', 'limit'].includes(key) ? Number(value) : value]));
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('task.list', input));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'artifact' && args[1] === 'inspect' && args[2]) {
    const options = flags(args.slice(3), ['data-root']);
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('artifact.inspect', { artifact_id: args[2] }));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'artifact' && args[1] === 'list') {
    const options = flags(args.slice(2), ['data-root', 'offset', 'limit', 'kind', 'media-type', 'task-id']);
    const input = Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'data-root').map(([key, value]) => [key.replaceAll('-', '_'), ['offset', 'limit'].includes(key) ? Number(value) : value]));
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('artifact.list', input));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (['task', 'artifact'].includes(args[0]) && ['inspect-many', 'export-many'].includes(args[1])) {
    if (args[0] === 'task' && args[1] === 'export-many') throw new CliUsageError('仅 Artifact 支持 export-many');
    const exporting = args[1] === 'export-many';
    const options = flags(args.slice(2), ['data-root', 'input', ...(exporting ? ['output'] : [])]);
    const input = { ...jsonInput(options.input), ...(exporting ? { output_directory: required(options.output, 'output') } : {}) };
    const result = await withRuntime(exporting ? 'writer' : 'reader', options['data-root'], commands => commands.execute(args[0] + '.' + args[1], input));
    console.log(JSON.stringify(result, null, 2));
    return result.results.some(entry => entry.error) ? 1 : 0;
  }

  if (args[0] === 'artifact' && args[1] === 'rebuild') {
    const options = flags(args.slice(2), ['data-root']);
    const result = await withRuntime('writer', options['data-root'], (commands) =>
      commands.execute('artifact.rebuild', {}));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'artifact' && args[1] === 'export' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'output']);
    const result = await withRuntime('writer', options['data-root'], (commands) =>
      commands.execute('artifact.export', {
        artifact_id: args[2],
        output_path: required(options.output, 'output')
      }));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  throw new CliUsageError('未知命令');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const code = error && error.code || 'IRIS_CLI_FAILED';
  const message = error && error.message || '命令执行失败';
  console.error(code + ': ' + message);
  if (error instanceof CliUsageError) console.error('\n' + usage());
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
