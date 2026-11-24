import { createCommandService } from './command-service.js';
import crypto from 'node:crypto';
import { readCoreArtifactBytes, inspectCoreArtifactMetadata, createCoreArtifact } from './core-artifacts.js';
import { inspectArtifactLineage } from './core-lineage.js';
import { readImportImage } from './image-import.js';
import { readImportAudio } from './audio-flow-input.js';
import { MAX_VIDEO_BYTES, VIDEO_TYPES } from './video-flow-input.js';
import { PLUGIN_CORE_COMMANDS, pluginFail } from './plugin-contract.js';
import {
  isPluginSourceArtifact,
  PLUGIN_ARTIFACT_KINDS,
  PLUGIN_MEDIA_LIMITS,
  pluginArtifactInputKindsForId,
  pluginArtifactMediaKind,
  pluginOperationAllowedInputKinds
} from './plugin-source-image.js';

function sniffVideoContainer(bytes, mediaType) {
  const buf = Buffer.from(bytes);
  if (!Object.hasOwn(VIDEO_TYPES, mediaType) || !buf.length || buf.length > MAX_VIDEO_BYTES) {
    pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件视频导入仅支持不超过 32 MiB 的 MP4/WebM');
  }
  const actual = buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp' ? 'video/mp4'
    : buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 ? 'video/webm' : null;
  if (actual !== mediaType) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '视频容器与 media_type 不一致，或不是支持的 MP4/WebM');
  return { bytes: buf, mediaType: actual, metadata: {} };
}

async function preparePluginMediaImport(mediaType, bytes, signal) {
  const kind = pluginArtifactMediaKind(mediaType);
  if (!kind || !(bytes instanceof Uint8Array) || !bytes.length) {
    pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件多模态导入需要非空字节与支持的 media_type');
  }
  if (bytes.length > PLUGIN_MEDIA_LIMITS[kind]) {
    pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件导入内容超过该媒体类型大小上限');
  }
  if (kind === 'image') {
    let source;
    try { source = await readImportImage({ imageBytes: bytes }, signal); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      pluginFail('IRIS_PLUGIN_INPUT_INVALID', error?.message || '插件图片导入字节无效');
    }
    if (source.mediaType !== mediaType) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '图片真实格式与 media_type 不一致');
    return { ...source, artifactKind: PLUGIN_ARTIFACT_KINDS.image };
  }
  if (kind === 'audio') {
    let source;
    try { source = readImportAudio(bytes, mediaType); }
    catch (error) { pluginFail('IRIS_PLUGIN_INPUT_INVALID', error?.message || '插件音频导入字节与格式不匹配'); }
    return { ...source, artifactKind: PLUGIN_ARTIFACT_KINDS.audio };
  }
  if (kind === 'video') {
    const source = sniffVideoContainer(bytes, mediaType);
    return { ...source, artifactKind: PLUGIN_ARTIFACT_KINDS.video };
  }
  const buf = Buffer.from(bytes);
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件文本/JSON 导入必须是有效 UTF-8'); }
  if (kind === 'json') {
    try { JSON.parse(decoded); }
    catch (_) { pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件 JSON 导入不是有效 JSON'); }
  }
  return { bytes: buf, mediaType, metadata: {}, artifactKind: PLUGIN_ARTIFACT_KINDS[kind] };
}

/** One Core command boundary, shared by local Hosts and the durable runner. */
export async function invokeReservedPlugin(runtime, reserved, { imports } = {}) {
  const pending = new Set(); let accepting = true, commandTail = Promise.resolve();
  const produced = new Set();
  const context = Object.freeze({ signal: runtime.signal, dependency: reserved.dependency,
    core: Object.freeze({ execute(name, args) {
      if (!accepting) return Promise.reject(Object.assign(new Error('插件调用已结束'), { name: 'AbortError' }));
      const owned = structuredClone(args);
      const call = commandTail.then(async () => {
        runtime.signal.throwIfAborted();
        imports?.authorize?.();
        if (!reserved.commands.includes(name) || reserved.mode === 'reader' && PLUGIN_CORE_COMMANDS[name] !== 'reader') pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '插件未声明此 Core 命令或模式不允许写入');
        if (name === 'artifact.lineage') return runtime.run('inspect', ({ dataRoot }) => {
          if (!owned || Object.keys(owned).join(',') !== 'artifact_id') pluginFail('IRIS_PLUGIN_INPUT_INVALID', '血缘查询只接受 Artifact ID');
          if (imports && !imports.sources.includes(owned.artifact_id) && !produced.has(owned.artifact_id)) {
            pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '持久业务只能查询其绑定来源或本次产出的作品血缘');
          }
          const allowedArtifactIds = imports ? new Set([...imports.sources, ...produced]) : null;
          return {
            contractVersion: 0,
            ...inspectArtifactLineage(dataRoot, owned.artifact_id, { includeRuns: false, allowedArtifactIds })
          };
        });
        if (name === 'artifact.read') return runtime.run('inspect', ({ dataRoot }) => {
          if (!owned || Object.keys(owned).join(',') !== 'artifact_id') pluginFail('IRIS_PLUGIN_INPUT_INVALID', '作品读取只接受 Artifact ID');
          if (imports && !imports.sources.includes(owned.artifact_id)) pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '持久业务只能读取其声明并绑定的来源作品');
          const metadata = inspectCoreArtifactMetadata(dataRoot, owned.artifact_id);
          const allowedKinds = reserved.artifactInputTypes
            ? (imports ? pluginArtifactInputKindsForId(reserved, reserved.input, owned.artifact_id) : pluginOperationAllowedInputKinds(reserved))
            : null;
          if (!isPluginSourceArtifact(metadata, allowedKinds)) {
            pluginFail('IRIS_PLUGIN_INPUT_INVALID', allowedKinds
              ? '来源作品媒体类型或大小不符合插件 artifactInputTypes 声明'
              : '插件图片读取支持 8 MiB 内 PNG/JPEG/WebP');
          }
          const result = readCoreArtifactBytes(dataRoot, owned.artifact_id);
          const encoded = result.bytes.toString('base64');
          return {
            contractVersion: 0,
            artifact: result.artifact,
            ...(allowedKinds ? { mediaType: result.artifact.mediaType, bytesBase64: encoded } : {}),
            ...(result.artifact.mediaType.startsWith('image/') ? { imageBase64: encoded } : {})
          };
        });
        if (name === 'artifact.import') {
          const keys = owned && typeof owned === 'object' && !Array.isArray(owned) ? Object.keys(owned).sort().join(',') : '';
          const legacyImage = keys === 'image_bytes' && owned.image_bytes instanceof Uint8Array;
          const typedMedia = keys === 'bytes,media_type' && typeof owned.media_type === 'string' && owned.bytes instanceof Uint8Array;
          if (!legacyImage && !typedMedia) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '插件导入只接受图片字节或声明的多模态媒体字节，不接受主机路径');
          if (typedMedia) {
            const mediaKind = pluginArtifactMediaKind(owned.media_type);
            if (!mediaKind || !reserved.artifactOutputKinds?.includes(mediaKind)) {
              pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '插件未在 artifactOutputKinds 声明该媒体产出类型');
            }
          }
          return runtime.run('execute', async ({ dataRoot, signal }) => {
            const source = legacyImage
              ? { ...(await readImportImage({ imageBytes: owned.image_bytes }, signal)), artifactKind: PLUGIN_ARTIFACT_KINDS.image }
              : await preparePluginMediaImport(owned.media_type, owned.bytes, signal);
            signal.throwIfAborted(); imports?.authorize?.();
            const artifactId = imports?.reserve?.();
            const artifact = createCoreArtifact(dataRoot, {
              bytes: source.bytes,
              mediaType: source.mediaType,
              ...(artifactId ? { artifactId } : {}),
              expectedSize: source.bytes.length,
              expectedDigest: crypto.createHash('sha256').update(source.bytes).digest('hex'),
              kind: source.artifactKind,
              metadata: { ...source.metadata, ...(imports ? { pluginOperationId: imports.operationId } : {}) },
              ...(imports ? { relations: imports.sources.map(id => ({ type: 'derived-from', artifactId: id })) } : {})
            });
            produced.add(artifact.id);
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
