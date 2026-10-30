import { createCommandService } from './command-service.js';
import crypto from 'node:crypto';
import { readCoreArtifactBytes, inspectCoreArtifactMetadata, createCoreArtifact } from './core-artifacts.js';
import { readImportImage } from './image-import.js';
import { PLUGIN_CORE_COMMANDS, pluginFail } from './plugin-contract.js';
import { isPluginSourceImage } from './plugin-source-image.js';

/** One Core command boundary, shared by local Hosts and the durable runner. */
export async function invokeReservedPlugin(runtime, reserved, { imports } = {}) {
  const pending = new Set(); let accepting = true, commandTail = Promise.resolve();
  const context = Object.freeze({ signal: runtime.signal, dependency: reserved.dependency,
    core: Object.freeze({ execute(name, args) {
      if (!accepting) return Promise.reject(Object.assign(new Error('插件调用已结束'), { name: 'AbortError' }));
      const owned = structuredClone(args);
      const call = commandTail.then(async () => {
        runtime.signal.throwIfAborted();
        imports?.authorize?.();
        if (!reserved.commands.includes(name) || reserved.mode === 'reader' && PLUGIN_CORE_COMMANDS[name] !== 'reader') pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '插件未声明此 Core 命令或模式不允许写入');
        if (name === 'artifact.read') return runtime.run('inspect', ({ dataRoot }) => {
          if (!owned || Object.keys(owned).join(',') !== 'artifact_id') pluginFail('IRIS_PLUGIN_INPUT_INVALID', '作品读取只接受 Artifact ID');
          if (imports && !imports.sources.includes(owned.artifact_id)) pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '持久业务只能读取其声明并绑定的来源作品');
          const metadata = inspectCoreArtifactMetadata(dataRoot, owned.artifact_id);
          if (!isPluginSourceImage(metadata)) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件图片读取支持 8 MiB 内 PNG/JPEG/WebP');
          const result = readCoreArtifactBytes(dataRoot, owned.artifact_id);
          return { contractVersion: 0, artifact: result.artifact, imageBase64: result.bytes.toString('base64') };
        });
        if (name === 'artifact.import') {
          if (!owned || Object.keys(owned).join(',') !== 'image_bytes' || !(owned.image_bytes instanceof Uint8Array)) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件导入只接受图片字节，不接受主机路径');
          if (imports) return runtime.run('execute', async ({ dataRoot, signal }) => {
            const source = await readImportImage({ imageBytes: owned.image_bytes }, signal); signal.throwIfAborted(); imports.authorize?.();
            const artifactId = imports.reserve();
            const artifact = createCoreArtifact(dataRoot, { ...source, artifactId, expectedSize: source.bytes.length,
              expectedDigest: crypto.createHash('sha256').update(source.bytes).digest('hex'), kind: 'plugin-image', metadata: { ...source.metadata, pluginOperationId: imports.operationId },
              relations: imports.sources.map(id => ({ type: 'derived-from', artifactId: id })) });
            return { contractVersion: 0, artifact };
          });
        }
        return createCommandService(runtime).execute(name, owned);
      });
      commandTail = call; void call.catch(() => {}); pending.add(call); return call;
    } }) });
  runtime.signal.throwIfAborted(); let result, failure;
  try { result = await reserved.invoke(context); } catch (error) { failure = error; }
  accepting = false;
  const results = await Promise.allSettled([...pending]);
  if (failure) throw failure;
  const rejected = results.find(item => item.status === 'rejected'); if (rejected) throw rejected.reason;
  runtime.signal.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(result.value)) > 128 * 1024) pluginFail('IRIS_PLUGIN_RESULT_INVALID', '插件业务结果超过 128 KiB');
  return result;
}
