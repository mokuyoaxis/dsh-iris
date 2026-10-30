// Shared invocation boundary. Core capability declarations supply both transports.
import { connectionFail } from './core-connections.js';
import { selectedBridgeTools } from './core-bridge-selection.js';
import { normalizeComfyParameters } from './comfyui-workflow.js';
import { CORE_CAPABILITY_TOOLS, CORE_PLUGIN_BRIDGE_TOOLS } from './core-capability-catalog.js';
import { z } from 'zod';

export const CORE_BRIDGE_TOOLS = Object.freeze([...CORE_CAPABILITY_TOOLS, ...CORE_PLUGIN_BRIDGE_TOOLS].map(({ name, scope, description, parameters }) =>
  Object.freeze({ name, scope, description, parameters })));

export function bridgeToolsForScopes(scopes, capabilities, selection, pluginOperations = []) {
  const enabled = selectedBridgeTools(capabilities, selection, pluginOperations);
  return CORE_BRIDGE_TOOLS.filter(tool => scopes.includes(tool.scope) && enabled.includes(tool.name));
}
export function validateBridgeArguments(tool, value) {
  if (tool.name === 'iris_core_plugin_call') {
    const result = z.fromJSONSchema(tool.parameters).safeParse(value);
    if (!result.success) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '插件业务参数无效'); return result.data;
  }
  const schema = tool.parameters;
  const invalid = () => connectionFail('IRIS_CONNECTION_INPUT_INVALID', '工具参数无效或包含未授权字段');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))
      || schema.required.some(key => !Object.hasOwn(value, key))) invalid();
  // Only generation accepts one finite scalar parameter map; no generic command or graph patch.
  for (const [name, item] of Object.entries(value)) {
    const field = schema.properties[name];
    if (field.type === 'object') {
      try { normalizeComfyParameters(item); } catch (_) { invalid(); }
      continue;
    }
    if (field.type === 'integer' ? !Number.isSafeInteger(item) || item < field.minimum || field.maximum !== undefined && item > field.maximum
      : typeof item !== 'string' || field.minLength !== undefined && item.length < field.minLength || field.maxLength !== undefined && item.length > field.maxLength
        || field.pattern && !new RegExp(field.pattern).test(item) || field.enum && !field.enum.includes(item)) invalid();
  }
  return value;
}
export async function callCoreBridgeTool(client, name, args, { signal } = {}) {
  const tool = CORE_BRIDGE_TOOLS.find(tool => tool.name === name);
  if (!tool) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '没有此 Core 服务工具');
  validateBridgeArguments(tool, args);
  const snapshot = client.snapshot();
  if (!bridgeToolsForScopes(snapshot.scopes, snapshot.capabilities, snapshot.tools, snapshot.pluginOperations).some(item => item.name === name)) {
    connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '工具不在本次明确选择的能力或权限范围内');
  }
  if (name === 'iris_core_connection') return { value: await client.connect() };
  if (!client.snapshot().scopes.includes(tool.scope)) connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '工具未获本次握手授权');
  const options = { signal };
  if (name === 'iris_core_plugin_catalog') return { value: await client.pluginCatalog(args, options) };
  if (name === 'iris_core_plugin_call') return { value: await client.callPlugin(args, options) };
  if (name === 'iris_core_models') return { value: await client.models(options) };
  if (name === 'iris_core_audio_models') return { value: await client.audioModels(options) };
  if (name === 'iris_core_runs') return { value: await client.runs(args, options) };
  if (name === 'iris_core_run') return { value: await client.run(args.runId, options) };
  if (name === 'iris_core_import_image') {
    const bytes = Buffer.from(args.imageBase64, 'base64');
    if (bytes.toString('base64') !== args.imageBase64) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '需要原静态图片的标准 Base64');
    return { value: await client.createImage({ key: args.key, bytes, mediaType: args.mediaType }, options) };
  }
  if (name === 'iris_core_import_audio') {
    const bytes = Buffer.from(args.audioBase64, 'base64');
    if (bytes.toString('base64') !== args.audioBase64) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '需要音频原字节的标准Base64');
    return { value: await client.createAudio({ key: args.key, bytes, mediaType: args.mediaType }, options) };
  }
  if (['iris_core_create_speech', 'iris_core_create_transcription'].includes(name)) {
    const { key, ...value } = args;
    return { value: await client[name === 'iris_core_create_speech' ? 'createSpeech' : 'createTranscription']({ key, value }, options) };
  }
  if (name === 'iris_core_audio') return { audio: { artifactId: args.artifactId, ...await client.audio(args.artifactId, options) } };
  if (name === 'iris_core_transcript') {
    const result = await client.transcript(args.artifactId, options);
    return { value: { contractVersion: 0, artifactId: args.artifactId, text: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes) } };
  }
  if (['iris_core_create_run', 'iris_core_create_generation'].includes(name)) {
    const { key, ...value } = args;
    return { value: await client[name === 'iris_core_create_run' ? 'createRun' : 'createGeneration']({ key, value }, options) };
  }
  if (name === 'iris_core_continue') return { value: await client.continueRun(args, options) };
  if (name === 'iris_core_operation') return { value: await client.operation(args.operationId, options) };
  if (name === 'iris_core_lookup') return { value: await client.lookup(args.key, options) };
  if (name === 'iris_core_stop') return { value: await client.stop(args.operationId, options) };
  if (name === 'iris_core_connections') return { value: await client.connections(options) };
  return { image: { artifactId: args.artifactId, ...await client.image(args.artifactId, options) } };
}
