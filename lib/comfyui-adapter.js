// Native ComfyUI HTTP API. No embedded server, global interrupt, or local output-path access.
import { defineProviderAdapter } from './provider-adapter.js';
import { ProviderContractError, providerErrorRecord } from './provider-contract.js';
import { checkedComfyWorkflow, compileComfyWorkflow } from './comfyui-workflow.js';
import { parseImageSize } from './provider-protocol.js';
import { createComfyUiClient, comfyFail as fail } from './comfyui-client.js';
import { inspectComfyWorkflow } from './comfyui-inspection.js';
import { writePrivateFile } from './private-storage.js';

const TASK = /^[A-Za-z0-9_-]{1,200}$/;
function imageLocation(value) {
  const safe = (text, empty = false) => typeof text === 'string' && (empty || text.length > 0) && text.length <= 1024
    && !/[\x00-\x1f\x7f\\]/.test(text) && !text.startsWith('/') && !text.split('/').some(part => ['..', '.'].includes(part));
  if (!value || !safe(value.filename) || value.filename.includes('/') || !safe(value.subfolder, true) || !['output', 'temp'].includes(value.type)) {
    fail('ComfyUI 图片位置无效', 'poll');
  }
  return { filename: value.filename, subfolder: value.subfolder, type: value.type };
}
export function createComfyUiProviderAdapter(provider, { fetchPort = globalThis.fetch } = {}) {
  const client = createComfyUiClient(provider, { fetchPort }), { route, request } = client;
  function workflow(model) {
    const value = model ? provider.models?.find(entry => entry.id === model)?.comfyWorkflow : provider.comfyWorkflow;
    try { return checkedComfyWorkflow(value); }
    catch (_) { fail('此模型尚未配置有效的 ComfyUI API 工作流', 'validate', 'invalid_request'); }
  }
  function historyResult(history, id, selected) {
    if (!history || typeof history !== 'object' || Array.isArray(history)) fail('ComfyUI 历史响应无效', 'poll');
    if (!Object.hasOwn(history, id)) return null;
    const entry = history[id];
    if (entry?.status?.status_str === 'error') return { kind: 'failed', error: { stage: 'poll', category: 'provider', acceptance: 'accepted', safeMessage: 'ComfyUI 工作流执行失败，请在原服务查看该任务' } };
    if (entry?.status?.completed !== true) return { kind: 'pending' };
    const images = entry.outputs?.[selected.outputNode]?.images;
    if (!Array.isArray(images) || images.length !== 1) fail('所选 ComfyUI 输出节点需要恰好一张图片；原任务已保留', 'poll');
    return { kind: 'succeeded', artifacts: [{ kind: 'remote-url', url: route('view') + '?' + new URLSearchParams(imageLocation(images[0])) }] };
  }
  return defineProviderAdapter({ id: provider.id, protocol: 'comfyui', capabilities: ['image'],
    operations: {
      async discover({ signal, timeoutMs } = {}) {
        await request(route('system_stats'), { signal, timeoutMs, stage: 'validate' });
        return { models: (provider.models || []).filter(model => model.comfyWorkflow).map(model => ({ id: model.id, capabilities: ['image-gen'] })) };
      },
      async submit({ capability, model, input = {}, signal, timeoutMs }) {
        if (capability !== 'image' || input.image || input.n !== undefined && input.n !== 1) fail('ComfyUI 首版仅支持单张文生图', 'validate', 'invalid_request');
        let selected;
        try { selected = compileComfyWorkflow(workflow(model), input); }
        catch (error) {
          if (error.code !== 'IRIS_COMFYUI_PARAMETERS_INVALID') throw error;
          fail(error.message, 'validate', 'invalid_request');
        }
        const graph = selected.graph;
        if (input.size !== undefined) {
          const size = parseImageSize(input.size);
          if (!selected.sizeNode || !size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)) {
            fail('此工作流需要有效的宽x高以及明确的尺寸节点；未绑定时请留空', 'validate', 'invalid_request');
          }
          Object.assign(graph[selected.sizeNode].inputs, { width: size.width, height: size.height });
        }
        if (selected.version === 1) {
          const report = await inspectComfyWorkflow(client, selected, { signal, timeoutMs });
          if (!report.ok) fail('ComfyUI 工作流检查未通过：' + report.issues.slice(0, 3).map(issue => issue.message).join('；'), 'validate', 'invalid_request');
        }
        const result = await request(route('prompt'), { method: 'POST', value: { prompt: graph }, signal, timeoutMs, stage: 'submit' });
        if (typeof result?.prompt_id !== 'string' || !TASK.test(result.prompt_id)) fail('ComfyUI 未返回可恢复的任务 ID，请核对原服务，避免重复提交', 'response', 'protocol', 'unknown');
        return { kind: 'accepted', remoteTaskId: result.prompt_id };
      },
      async poll({ remoteTaskId, model, signal, timeoutMs }) {
        if (typeof remoteTaskId !== 'string' || !TASK.test(remoteTaskId)) fail('ComfyUI 原任务 ID 无效', 'poll');
        const selected = workflow(model), readHistory = () => request(route('history/' + encodeURIComponent(remoteTaskId)), { signal, timeoutMs, stage: 'poll' });
        const result = historyResult(await readHistory(), remoteTaskId, selected);
        if (result) return result;
        const queue = await request(route('queue'), { signal, timeoutMs, stage: 'poll' });
        if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) fail('ComfyUI 队列响应无效', 'poll');
        if ([...queue.queue_running, ...queue.queue_pending].some(entry => Array.isArray(entry) && entry[1] === remoteTaskId)) return { kind: 'pending' };
        // Completion may move from queue to history between the two reads. Never resubmit.
        return historyResult(await readHistory(), remoteTaskId, selected) || { kind: 'unknown', error: {
          stage: 'poll', category: 'unknown', acceptance: 'accepted', safeMessage: '原任务已不在 ComfyUI 队列或历史中，请核对原服务；不会重新提交' } };
      },
      async download({ artifact, targetPath, signal, timeoutMs }) {
        const url = new URL(artifact?.url || ''), expected = new URL(route('view'));
        if (artifact.kind !== 'remote-url' || url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash
            || [...url.searchParams.keys()].some(name => !['filename', 'subfolder', 'type'].includes(name))
            || ['filename', 'subfolder', 'type'].some(name => url.searchParams.getAll(name).length !== 1)) fail('ComfyUI 交付地址不属于原服务的图片接口', 'download');
        imageLocation(Object.fromEntries(url.searchParams));
        const bytes = await request(url.href, { signal, timeoutMs, stage: 'download', binary: true });
        writePrivateFile(targetPath, bytes, { flag: 'wx' }); return { bytes: bytes.length };
      },
      mapError: (error, context) => providerErrorRecord(error, { ...context, stage: error.stage || context.stage,
        acceptance: error.acceptance || context.acceptance, category: error.category || (error.name === 'AbortError' ? 'aborted' : error.name === 'TimeoutError' ? 'timeout' : 'network'),
        safeMessage: error instanceof ProviderContractError ? error.message : 'ComfyUI 服务通信失败，请核对原任务与服务状态' })
    },
    unsupported: { cancel: 'ComfyUI /interrupt 控制当前工作流，首版不对共享服务发送全局中断' },
    unsupportedPreparation: 'ComfyUI 首版不支持带图编辑或输入上传'
  });
}
