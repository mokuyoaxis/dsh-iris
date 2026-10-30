import { createCoreServiceClient } from './core-service-client.js';
import { bridgeToolsForScopes, callCoreBridgeTool } from './core-bridge-tools.js';
import { requireHostPort } from './host-contract.js';

/** Optional shared-Flow connection. Native DSH ports stay in the host; no remote ctx or local execution fallback. */
export function createDshServiceBridge({ connectionFile, requestedScopes = ['read'], getHost, harnessVersion = 'unknown', fetch } = {}) {
  if (typeof getHost !== 'function') throw new TypeError('DSH 服务桥需要真实 Host 工厂');
  const client = createCoreServiceClient({ connectionFile, requestedScopes, harnessVersion, fetch });
  const lifetime = new AbortController(), jobs = new Set();
  const toolDisposers = [];
  let state = 'new', disposal, remoteDisconnect = 'not_connected';
  async function start() {
    if (state !== 'new') throw new Error('DSH Core 服务桥只能启动一次');
    state = 'connecting';
    try {
      await client.connect();
      if (client.snapshot().adapterId !== 'iris.dsh-service') throw Object.assign(new Error('连接文件不是 DSH 适配授权'), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
      const selected = client.snapshot();
      if (selected.capabilities.some(id => ['tts', 'transcribe'].includes(id))) throw Object.assign(new Error('DSH 原生共享桥尚未接入音频附件交付；请为此桥选择图片功能，音频使用通用 MCP 或 Core 工作台'), { code: 'IRIS_DSH_AUDIO_NOT_SUPPORTED' });
      const tools = requireHostPort(getHost(), 'tools', '注册 Core 服务工具');
      for (const tool of bridgeToolsForScopes(selected.scopes, selected.capabilities, selected.tools, selected.pluginOperations)) {
        const remove = tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
          isConcurrencySafe: () => tool.scope === 'read' || tool.scope === 'stop',
          output: { schema: { type: 'object' }, render: (_args, result) => result.blocks },
          async execute(args, exec = {}) {
            const signal = AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : [])]);
            const job = (async () => {
              signal.throwIfAborted();
              const result = await callCoreBridgeTool(client, tool.name, args, { signal });
              if (!result.image) return { value: result.value, blocks: [{ type: 'text', text: JSON.stringify(result.value) }] };
              const attachments = requireHostPort(getHost(), 'attachments', '显示 Core 图片');
              const attachment = await attachments.saveImage({ data: new Uint8Array(result.image.bytes), mediaType: result.image.mediaType,
                name: 'iris-core-' + result.image.artifactId + '.' + (result.image.mediaType === 'image/jpeg' ? 'jpg' : result.image.mediaType.slice(6)) });
              signal.throwIfAborted();
              if (!attachment?.attachmentId) throw Object.assign(new Error('DSH 没有返回图片附件身份'), { code: 'IRIS_DSH_PROJECTION_FAILED' });
              return { artifactId: result.image.artifactId, blocks: [{ type: 'image', attachment }] };
            })();
            jobs.add(job); try { return await job; } finally { jobs.delete(job); }
          }
        });
        if (typeof remove === 'function') toolDisposers.push(remove);
      }
      state = 'open'; return snapshot();
    } catch (error) {
      try { await dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'DSH 服务桥启动与释放均失败'); }
      throw error;
    }
  }
  function snapshot() { return { state, connection: client.snapshot(), operations: jobs.size, remoteDisconnect }; }
  function dispose() {
    if (disposal) return disposal;
    state = 'closing'; lifetime.abort();
    disposal = (async () => {
      const errors = [];
      for (const remove of toolDisposers.splice(0).reverse()) { try { await remove(); } catch (error) { errors.push(error); } }
      await Promise.allSettled([...jobs]);
      try { remoteDisconnect = (await client.dispose()).remoteDisconnect; } catch (error) { errors.push(error); }
      state = 'closed';
      if (errors.length) throw new AggregateError(errors, 'DSH 服务桥释放失败');
      return snapshot();
    })();
    return disposal;
  }
  return Object.freeze({ start, snapshot, dispose });
}
