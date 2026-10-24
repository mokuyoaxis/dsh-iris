// Shared, finite tool contract for MCP and the optional native DSH service connection.
import { connectionFail } from './core-connections.js';
import { selectedBridgeTools } from './core-bridge-selection.js';

const key = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' };
const runId = { type: 'string', pattern: '^run_[a-f0-9]{24}$' }, operationId = { type: 'string', pattern: '^op_[a-f0-9]{64}$' };
const artifactId = { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
function tool(name, scope, description, properties = {}, required = Object.keys(properties)) {
  return Object.freeze({ name: 'iris_core_' + name, scope, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } });
}
export const CORE_BRIDGE_TOOLS = Object.freeze([
  tool('connection', 'read', 'Reconnect explicitly to the configured Iris Core and report negotiated connection capabilities. Never executes or resumes media.'),
  tool('models', 'read', 'List configured image-edit models from Iris Core. Read-only; never probes a model.'),
  tool('runs', 'read', 'List durable Iris image-edit flows with bounded pagination. Never executes or polls a provider.',
    { limit: { type: 'integer', minimum: 1, maximum: 30 }, cursor: runId }, []),
  tool('run', 'read', 'Read the original durable Run, Task acceptance, output and comparison references. Never executes.', { runId }),
  tool('import_image', 'create', 'Import PNG/JPEG/WebP bytes into Core using a stable request UUID. Reuse the same key after a lost response; no generation.',
    { key, imageBase64: text(8 * 1024 * 1024), mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] } }),
  tool('create_run', 'create', 'Create a fixed image-edit flow from a Core source artifact and explicit provider::model. Persists the prompt; does not generate. Reuse the request UUID.',
    { key, sourceArtifactId: artifactId, modelRef: text(300), prompt: text(16000), size: text(100) }, ['key', 'sourceArtifactId', 'modelRef', 'prompt']),
  tool('continue', 'execute', 'Explicitly request ONE finite continue of an Iris Run. May incur generation billing on first submission. Supply the current Run revision and stable UUID key. Reuse that key to recover a lost response; inspect the returned Operation and Run. Never automatically resubmit unknown acceptance.',
    { key, runId, expectedRevision: { type: 'integer', minimum: 1 } }),
  tool('operation', 'read', 'Read a saved Operation. succeeded means its finite call returned, not necessarily that the media is complete.', { operationId }),
  tool('lookup', 'read', 'Recover an accepted Operation by its original request UUID after a lost response or reconnect. Never starts it.', { key }),
  tool('stop', 'stop', 'Stop local waiting for an original Operation and wait for its saved terminal state. This does not cancel the remote provider or prove billing stopped.', { operationId }),
  tool('image', 'read', 'Read the exact original bytes of a Core PNG/JPEG/WebP artifact for display. Never regenerates or exports to an arbitrary path.', { artifactId }),
  tool('connections', 'read', 'Read this authorized connection and its handshake facts. Connection verification does not imply media or reverse host services were tested.')
]);

export function bridgeToolsForScopes(scopes, capabilities, selection) {
  const enabled = selectedBridgeTools(capabilities, selection);
  return CORE_BRIDGE_TOOLS.filter(tool => scopes.includes(tool.scope) && enabled.includes(tool.name));
}
export function validateBridgeArguments(tool, value) {
  const schema = tool.parameters;
  const invalid = () => connectionFail('IRIS_CONNECTION_INPUT_INVALID', '工具参数无效或包含未授权字段');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))
      || schema.required.some(key => !Object.hasOwn(value, key))) invalid();
  // This tool surface has only finite flat string/integer fields; no generic command or nested dispatch.
  for (const [name, item] of Object.entries(value)) {
    const field = schema.properties[name];
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
  if (!bridgeToolsForScopes(snapshot.scopes, snapshot.capabilities, snapshot.tools).some(item => item.name === name)) {
    connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '工具不在本次明确选择的能力或权限范围内');
  }
  if (name === 'iris_core_connection') return { value: await client.connect() };
  if (!client.snapshot().scopes.includes(tool.scope)) connectionFail('IRIS_CONNECTION_CAPABILITY_DENIED', '工具未获本次握手授权');
  const options = { signal };
  if (name === 'iris_core_models') return { value: await client.models(options) };
  if (name === 'iris_core_runs') return { value: await client.runs(args, options) };
  if (name === 'iris_core_run') return { value: await client.run(args.runId, options) };
  if (name === 'iris_core_import_image') {
    const bytes = Buffer.from(args.imageBase64, 'base64');
    if (bytes.toString('base64') !== args.imageBase64) connectionFail('IRIS_CONNECTION_INPUT_INVALID', '需要原静态图片的标准 Base64');
    return { value: await client.createImage({ key: args.key, bytes, mediaType: args.mediaType }, options) };
  }
  if (name === 'iris_core_create_run') {
    const { key, ...value } = args; return { value: await client.createRun({ key, value }, options) };
  }
  if (name === 'iris_core_continue') return { value: await client.continueRun(args, options) };
  if (name === 'iris_core_operation') return { value: await client.operation(args.operationId, options) };
  if (name === 'iris_core_lookup') return { value: await client.lookup(args.key, options) };
  if (name === 'iris_core_stop') return { value: await client.stop(args.operationId, options) };
  if (name === 'iris_core_connections') return { value: await client.connections(options) };
  return { image: { artifactId: args.artifactId, ...await client.image(args.artifactId, options) } };
}
