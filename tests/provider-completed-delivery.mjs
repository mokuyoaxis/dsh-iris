import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCoreArtifact } from '../lib/core-artifacts.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import {
  createDashScopeProviderAdapter,
  createOpenAiImagesProviderAdapter
} from '../lib/provider-adapters.js';
import { createProviderTaskRunner } from '../lib/provider-task-runner.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';

const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-provider-completed-'));
  roots.push(root);
  return root;
};
const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};
const provider = (id, protocol) => ({
  id,
  apiKey: 'sk-fixture-only',
  baseUrl: protocol === 'dashscope'
    ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    : 'https://api.fixture.invalid/v1',
  mediaProtocol: protocol
});

async function runCompleted(adapter, model, root) {
  const runtime = createCoreRuntime({ dataRoot: root, mode: 'writer' });
  runtime.start();
  try {
    return await createProviderTaskRunner(runtime).submit({
      capability: 'image',
      candidates: [{ adapter, model: adapter.id + '::' + model }],
      providerInput: { prompt: 'zero-network completed delivery', n: 2 }
    });
  } finally {
    await runtime.dispose();
  }
}

try {
  const openAiRoot = makeRoot();
  const openAiCalls = { submit: 0, remoteDownload: 0 };
  const inline = FAKE_PNG.toString('base64');
  const openAi = createOpenAiImagesProviderAdapter(provider('openai-completed', 'openai-images'), {
    transport: {
      async listModels() { return ['gpt-image-fixture']; },
      async openAiGenerateImage() {
        openAiCalls.submit++;
        return [{ b64: inline }, { url: 'https://fixture.invalid/second.png' }];
      },
      async downloadTo(_url, targetPath) {
        openAiCalls.remoteDownload++;
        fs.writeFileSync(targetPath, FAKE_PNG, { flag: 'wx', mode: 0o600 });
        return FAKE_PNG.length;
      }
    }
  });
  const openAiResult = await runCompleted(openAi, 'gpt-image-fixture', openAiRoot);
  assert(openAiResult.task.outcome === 'succeeded' && openAiResult.task.deliveryState === 'ready'
      && openAiResult.task.artifactIds.length === 2,
    'OpenAI 同步 base64/URL 必须在一次提交后成为两个 Core Artifact', openAiResult.task);
  assert(openAiCalls.submit === 1 && openAiCalls.remoteDownload === 1,
    'inline 产物本地物化，remote-url 只下载一次', openAiCalls);
  for (const id of openAiResult.task.artifactIds) {
    assert(inspectCoreArtifact(openAiRoot, id).size === FAKE_PNG.length,
      '每个同步产物都必须通过 Core hash/Manifest 校验', id);
  }
  const taskJson = fs.readFileSync(path.join(
    openAiRoot, 'task-store', 'v0', 'tasks', openAiResult.taskId + '.json'
  ), 'utf8');
  assert(!taskJson.includes(inline) && !taskJson.includes('fixture.invalid'),
    'Task 不得持久化 inline 正文或远端 URL');

  const dashRoot = makeRoot();
  const dashCalls = { submit: 0, download: 0 };
  const dash = createDashScopeProviderAdapter(provider('dash-completed', 'dashscope'), {
    transport: {
      async listModels() { return ['wan-sync-fixture']; },
      dashscopeImageMode() { return 'multimodal-sync'; },
      async generateImageMultimodal() {
        dashCalls.submit++;
        return ['https://fixture.invalid/dash.png'];
      },
      async downloadTo(_url, targetPath) {
        dashCalls.download++;
        fs.writeFileSync(targetPath, FAKE_PNG, { flag: 'wx', mode: 0o600 });
        return FAKE_PNG.length;
      }
    }
  });
  const dashResult = await runCompleted(dash, 'wan-sync-fixture', dashRoot);
  assert(dashResult.task.deliveryState === 'ready' && dashResult.task.artifactIds.length === 1
      && dashCalls.submit === 1 && dashCalls.download === 1,
    '同步 DashScope URL 必须恰好提交和物化一次', { task: dashResult.task, calls: dashCalls });

  const invalidRoot = makeRoot();
  let forbiddenSubmit = 0;
  const invalid = createOpenAiImagesProviderAdapter(provider('invalid-completed', 'openai-images'), {
    transport: {
      async listModels() { return []; },
      async openAiGenerateImage() { return [{ b64: 'not base64' }]; },
      async downloadTo() { throw new Error('不应下载'); }
    }
  });
  const forbidden = createOpenAiImagesProviderAdapter(provider('forbidden-after-completed', 'openai-images'), {
    transport: {
      async listModels() { return []; },
      async openAiGenerateImage() { forbiddenSubmit++; return [{ b64: inline }]; },
      async downloadTo() { throw new Error('不应下载'); }
    }
  });
  const runtime = createCoreRuntime({ dataRoot: invalidRoot, mode: 'writer' });
  runtime.start();
  let invalidResult;
  try {
    invalidResult = await createProviderTaskRunner(runtime).submit({
      capability: 'image',
      candidates: [
        { adapter: invalid, model: 'invalid-completed::bad' },
        { adapter: forbidden, model: 'forbidden-after-completed::image' }
      ],
      providerInput: { prompt: 'invalid completed response' }
    });
  } finally {
    await runtime.dispose();
  }
  assert(invalidResult.task.acceptance === 'unknown' && invalidResult.task.outcome === 'unknown'
      && forbiddenSubmit === 0,
    '已收到但无法规范化的同步响应必须停止 failover，禁止第二次生成', invalidResult.task);

  console.log('ALL OK —— completed 同步图片统一物化为 Core Artifact，base64/URL/多产物与零重提通过');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
