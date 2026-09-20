#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { recoverCoreWriterLease } from '../lib/core-lease-recovery.js';
import { doctor, formatDoctorReport } from '../lib/doctor.js';
import { loadProviderCatalog, providerCatalogSnapshot, catalogCapabilitySnapshot, imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding, transcribeCandidatesFromCatalog, ttsCandidatesFromCatalog, videoCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { prepareProviderInput } from '../lib/provider-adapter.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';

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
    '  dsh-iris doctor [--data-root <absolute-path>] [--json]',
    '  dsh-iris runtime recover --data-root <absolute-path> --confirm-stale-pid <pid>',
    '  dsh-iris providers list --provider-config <absolute-path>',
    '  dsh-iris capabilities list --provider-config <absolute-path>',
    '  dsh-iris run crop --data-root <absolute-path> --input <json>',
    '  dsh-iris media diff --data-root <absolute-path> --input <json>',
    '  dsh-iris media frames --data-root <absolute-path> --input <json>',
    '  dsh-iris run image --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run video --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run tts --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris run transcribe --data-root <absolute-path> --provider-config <absolute-path> --input <json>',
    '  dsh-iris task inspect <id> --data-root <absolute-path>',
    '  dsh-iris task list --data-root <absolute-path>',
    '  dsh-iris task observe <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task redeliver <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task cancel <id> --data-root <absolute-path> --provider-config <absolute-path>',
    '  dsh-iris task retry <id> --data-root <absolute-path> --provider-config <absolute-path> --input <json> --confirm-billing [--model-ref <providerId::modelId>]',
    '  dsh-iris artifact inspect <id> --data-root <absolute-path>',
    '  dsh-iris artifact list --data-root <absolute-path>',
    '  dsh-iris artifact export <id> --data-root <absolute-path> --output <absolute-path>',
    '  dsh-iris artifact rebuild --data-root <absolute-path>',
    '',
    'Commands never start DSH. run image and the task observe/redeliver/cancel/retry verbs contact a provider only when explicitly requested; credentials come from a private file. observe polls once, redeliver only re-downloads, and cancel is recorded as canceled only when the provider explicitly confirms; none of them ever submits an existing task again. task retry creates a NEW task that may incur duplicate generation billing and requires --confirm-billing; the prompt must be supplied again because Core never persists prompts.'
  ].join('\n');
}

function flags(args, allowed) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : '';
    if (!name || !allowed.includes(name) || index + 1 >= args.length || String(args[index + 1]).startsWith('--')) {
      throw new CliUsageError('参数无效：' + String(flag || ''));
    }
    if (Object.prototype.hasOwnProperty.call(parsed, name)) throw new CliUsageError('参数重复：--' + name);
    parsed[name] = args[index + 1];
  }
  return parsed;
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

async function withRuntime(mode, dataRoot, callback, ports = {}) {
  const runtime = createCoreRuntime({ dataRoot: required(dataRoot, 'data-root'), mode });
  runtime.start();
  try {
    return await callback(createCommandService(runtime, ports));
  } finally {
    await runtime.dispose();
  }
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

  if (['providers', 'capabilities'].includes(args[0]) && args[1] === 'list') {
    const options = flags(args.slice(2), ['provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const report = args[0] === 'providers' ? providerCatalogSnapshot(catalog) : catalogCapabilitySnapshot(catalog);
    console.log(JSON.stringify(report, null, 2));
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
    const input = jsonInput(options.input);
    const allowed = new Set(['prompt', 'size', 'n', 'model_ref']);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new CliUsageError('图片输入不支持字段：' + key);
    }
    const prompt = String(input.prompt || '').trim();
    if (!prompt || prompt.length > 20000) throw new CliUsageError('prompt 必须为 1–20000 字符');
    const n = input.n === undefined ? 1 : Number(input.n);
    if (!Number.isSafeInteger(n) || n < 1 || n > 4) throw new CliUsageError('n 必须为 1–4 的整数');
    const size = input.size === undefined ? undefined : String(input.size).trim();
    if (size !== undefined && (!size || size.length > 64)) throw new CliUsageError('size 格式无效');
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = imageCandidatesFromCatalog(catalog, input.model_ref);
    const runtime = createCoreRuntime({ dataRoot: required(options['data-root'], 'data-root'), mode: 'writer' });
    runtime.start();
    try {
      const candidates = routes.map((route) => ({
        adapter: createConfiguredProviderAdapter(route.provider), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'image', candidates,
        providerInput: { prompt, n, ...(size ? { size } : {}) }
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await runtime.dispose();
    }
    return 0;
  }

  // 视频输入冻结（E 阶段 Profile）：t2v/i2v 的 prompt/img_data_url/size/duration；
  // s2v 上传流程不在 headless 面开放。
  if (args[0] === 'run' && args[1] === 'video') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const input = jsonInput(options.input);
    const allowed = new Set(['prompt', 'size', 'duration', 'img_data_url', 'model_ref']);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new CliUsageError('视频输入不支持字段：' + key);
    }
    const prompt = String(input.prompt || '').trim();
    if (!prompt || prompt.length > 20000) throw new CliUsageError('prompt 必须为 1–20000 字符');
    if (input.size !== undefined && (!String(input.size).trim() || String(input.size).length > 64)) {
      throw new CliUsageError('size 格式无效');
    }
    if (input.duration !== undefined) {
      const duration = Number(input.duration);
      if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw new CliUsageError('duration 必须为 1–60 的数字');
    }
    if (input.img_data_url !== undefined && !String(input.img_data_url).startsWith('data:image/')) {
      throw new CliUsageError('img_data_url 必须是 data:image/ 开头的 data URL');
    }
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = videoCandidatesFromCatalog(catalog, input.model_ref);
    const runtime = createCoreRuntime({ dataRoot: required(options['data-root'], 'data-root'), mode: 'writer' });
    runtime.start();
    try {
      const candidates = routes.map((route) => ({
        adapter: createConfiguredProviderAdapter(route.provider), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'video', candidates,
        providerInput: {
          prompt,
          ...(input.size !== undefined ? { size: String(input.size) } : {}),
          ...(input.duration !== undefined ? { duration: Number(input.duration) } : {}),
          ...(input.img_data_url !== undefined ? { imgDataUrl: String(input.img_data_url) } : {})
        }
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await runtime.dispose();
    }
    return 0;
  }

  // 语音合成输入冻结（E2 Profile）：同步完成型，一次命令内完成 Task → Artifact。
  if (args[0] === 'run' && args[1] === 'tts') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const input = jsonInput(options.input);
    const allowed = new Set(['text', 'voice', 'model_ref']);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new CliUsageError('语音输入不支持字段：' + key);
    }
    const text = String(input.text || '').trim();
    if (!text || text.length > 20000) throw new CliUsageError('text 必须为 1–20000 字符');
    if (input.voice !== undefined && (!String(input.voice).trim() || String(input.voice).length > 64)) {
      throw new CliUsageError('voice 格式无效');
    }
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = ttsCandidatesFromCatalog(catalog, input.model_ref);
    const runtime = createCoreRuntime({ dataRoot: required(options['data-root'], 'data-root'), mode: 'writer' });
    runtime.start();
    try {
      const candidates = routes.map((route) => ({
        adapter: createConfiguredProviderAdapter(route.provider), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'tts', candidates,
        providerInput: {
          text,
          ...(input.voice !== undefined ? { voice: String(input.voice) } : {})
        }
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await runtime.dispose();
    }
    return 0;
  }

  // 转写输入冻结（E3 Profile）：上传型异步——audio_url（公网/oss://）或
  // audio_path（本地文件，经首选候选 Provider 的临时存储上传，签名 URL 不落 Core）。
  if (args[0] === 'run' && args[1] === 'transcribe') {
    const options = flags(args.slice(2), ['data-root', 'provider-config', 'input']);
    const input = jsonInput(options.input);
    const allowed = new Set(['audio_url', 'audio_path', 'model_ref']);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw new CliUsageError('转写输入不支持字段：' + key);
    }
    const audioUrlArg = String(input.audio_url || '').trim();
    const audioPath = String(input.audio_path || '').trim();
    if (Boolean(audioUrlArg) === Boolean(audioPath)) {
      throw new CliUsageError('转写必须且只能提供 audio_url 或 audio_path 之一');
    }
    if (audioUrlArg && !/^(https:\/\/|oss:\/\/)/.test(audioUrlArg)) {
      throw new CliUsageError('audio_url 必须是 https:// 或 oss:// 地址');
    }
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    const routes = transcribeCandidatesFromCatalog(catalog, input.model_ref);
    let audioUrl = audioUrlArg;
    if (!audioUrl) {
      if (!path.isAbsolute(audioPath)) throw new CliUsageError('audio_path 必须是绝对路径');
      if (!fs.existsSync(audioPath)) throw new CliUsageError('音频文件不存在');
      const prepared = await prepareProviderInput(createConfiguredProviderAdapter(routes[0].provider), {
        model: routes[0].model, filePath: audioPath
      });
      audioUrl = prepared.url;
    }
    const runtime = createCoreRuntime({ dataRoot: required(options['data-root'], 'data-root'), mode: 'writer' });
    runtime.start();
    try {
      const candidates = routes.map((route) => ({
        adapter: createConfiguredProviderAdapter(route.provider), model: route.modelRef,
        selectionReason: route.selectionReason,
        providerBinding: providerTaskBinding(route.provider)
      }));
      const result = await createProviderTaskRunner(runtime).submit({
        capability: 'transcribe', candidates,
        providerInput: { audioUrl }
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await runtime.dispose();
    }
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'observe' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.observe', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => createConfiguredProviderAdapter(providerForTaskFromCatalog(catalog, task))
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'redeliver' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.redeliver', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => createConfiguredProviderAdapter(providerForTaskFromCatalog(catalog, task))
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args[0] === 'task' && args[1] === 'cancel' && args[2]) {
    const options = flags(args.slice(3), ['data-root', 'provider-config']);
    const catalog = loadProviderCatalog(required(options['provider-config'], 'provider-config'));
    await withRuntime('reader', options['data-root'], (commands) => commands.execute('task.inspect', { task_id: args[2] }));
    const result = await withRuntime('writer', options['data-root'], (commands) => commands.execute('task.cancel', { task_id: args[2] }), {
      resolveTaskAdapter: (task) => createConfiguredProviderAdapter(providerForTaskFromCatalog(catalog, task))
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
        adapter: createConfiguredProviderAdapter(route.provider),
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
    const options = flags(args.slice(2), ['data-root']);
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('task.list', {}));
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
    const options = flags(args.slice(2), ['data-root']);
    const result = await withRuntime('reader', options['data-root'], (commands) =>
      commands.execute('artifact.list', {}));
    console.log(JSON.stringify(result, null, 2));
    return 0;
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
