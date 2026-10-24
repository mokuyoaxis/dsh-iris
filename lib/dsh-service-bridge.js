import { createCoreServiceClient } from './core-service-client.js';
import { bridgeToolsForScopes, callCoreBridgeTool } from './core-bridge-tools.js';
import { requireHostPort } from './host-contract.js';

/** Optional shared-Flow connection. Native DSH ports stay in the host; no remote ctx or local execution fallback. */
export function createDshServiceBridge({ connectionFile, requestedScopes = ['read'], getHost, harnessVersion = 'unknown', fetch } = {}) {
  if (typeof getHost !== 'function') throw new TypeError('DSH 服务桥需要真实 Host 工厂');
  const client = createCoreServiceClient({ connectionFile, requestedScopes, harnessVersion, fetch });
  const lifetime = new AbortController(), jobs = new Set();
  let state = 'new', disposal, remoteDisconnect = 'not_connected';
  async function start() {
    if (state !== 'new') throw new Error('DSH Core 服务桥只能启动一次');
    state = 'connecting';
    try {
      await client.connect();
      if (client.snapshot().adapterId !== 'iris.dsh-service') throw Object.assign(new Error('连接文件不是 DSH 适配授权'), { code: 'IRIS_CONNECTION_INPUT_INVALID' });
      const tools = requireHostPort(getHost(), 'tools', '注册 Core 服务工具');
      const selected = client.snapshot();
      for (const tool of bridgeToolsForScopes(selected.scopes, selected.capabilities, selected.tools)) {
        tools.register({ name: tool.name, description: tool.description, parameters: tool.parameters,
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
      }
      state = 'open'; return snapshot();
    } catch (error) { state = 'failed'; throw error; }
  }
  function snapshot() { return { state, connection: client.snapshot(), operations: jobs.size, remoteDisconnect }; }
  function dispose() {
    if (disposal) return disposal;
    state = 'closing'; lifetime.abort();
    disposal = (async () => {
      await Promise.allSettled([...jobs]);
      try { remoteDisconnect = (await client.dispose()).remoteDisconnect; } finally { state = 'closed'; }
      return snapshot();
    })();
    return disposal;
  }
  return Object.freeze({ start, snapshot, dispose });
}
