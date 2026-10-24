import { connectionFail, checkedConnectionScopes } from './core-connections.js';
import { checkedBridgeCapabilities, checkedBridgeTools } from './core-bridge-selection.js';
import { bridgeToolsForScopes } from './core-bridge-tools.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => connectionFail('IRIS_SKILL_BUNDLE_INVALID', 'Skill 交付文件无效或包含不支持的字段；不接受外部 Markdown、脚本或凭据');

/** A portable public authorization snapshot, never an authorization credential or filesystem tree. */
export function checkedConnectionSkillBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'capabilities,connectionId,kind,label,revision,rootId,schemaVersion,scopes,tools'
      || value.schemaVersion !== 0 || value.kind !== 'iris-mcp-skill' || !UUID.test(value.rootId) || !UUID.test(value.connectionId)
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.label !== 'string' || !value.label.trim()
      || value.label.length > 80 || /[\x00-\x1f\x7f]/.test(value.label)) fail();
  checkedConnectionScopes(value.scopes); checkedBridgeCapabilities(value.capabilities); checkedBridgeTools(value.tools);
  const actual = bridgeToolsForScopes(value.scopes, value.capabilities, value.tools).map(tool => tool.name);
  if (!actual.length || actual.length !== value.tools.length) fail();
  return { schemaVersion: 0, kind: 'iris-mcp-skill', rootId: value.rootId, connectionId: value.connectionId,
    revision: value.revision, label: value.label.trim(), scopes: [...value.scopes], capabilities: [...value.capabilities], tools: actual };
}

const guidance = Object.freeze({
  iris_core_connection: 'Reconnect explicitly when needed. Check the returned connection/root identity and negotiated capabilities; a handshake does not test a media model.',
  iris_core_connections: 'Inspect this connection and its handshake facts. A connected record does not prove that a client process remains online.',
  iris_core_models: 'List configured image-edit candidates without probing them. Use an explicit model reference supplied by the user or returned here; candidate presence is not a health test.',
  iris_core_runs: 'Find saved image-edit Runs using bounded pagination. Listing never observes a provider or continues a Run.',
  iris_core_run: 'Read the original Run and its saved Task, acceptance, output and selection facts. Preserve their IDs and current revision.',
  iris_core_import_image: 'Import user-supplied PNG/JPEG/WebP bytes using a stable request UUID. Reuse that UUID and the same bytes after a lost response. Importing does not generate an image.',
  iris_core_create_run: 'Save a fixed image-edit Run from a Core source Artifact ID, explicit provider::model and the requested prompt. Reuse its creation UUID after a lost response. Creation does not submit media.',
  iris_core_continue: 'On an explicit request, continue the original Run ONCE using its current revision and a stable request UUID. First submission may incur billing. Preserve the returned Operation and original Task; never resubmit unknown acceptance as a new generation.',
  iris_core_operation: 'Read a saved Operation. succeeded describes one finite call; inspect the original Run/Task before claiming that the media finished.',
  iris_core_lookup: 'Recover an accepted Operation with its ORIGINAL request UUID after interruption or a lost response. This read must not be replaced by another submission.',
  iris_core_stop: 'Stop local waiting for the original Operation only when requested. The result does not prove remote cancellation, a refund or stopped billing.',
  iris_core_image: 'Read the original Core Artifact image. Present its returned image block in the host when supported. Describe visual content only after actually viewing it; file metadata alone is insufficient.'
});

export function connectionSkillResources(input, metadata) {
  const bundle = checkedConnectionSkillBundle(input), skillName = 'iris-mcp-' + bundle.connectionId;
  const write = bundle.tools.some(name => ['iris_core_import_image', 'iris_core_create_run', 'iris_core_continue', 'iris_core_stop'].includes(name));
  const description = `Use the configured Iris MCP connection ${bundle.connectionId} to ${write ? 'work with its explicitly selected image-edit and operation tools' : 'inspect its selected saved image or connection facts'}. Applies only to this connection and the tools listed in this skill.`;
  const body = [
    '---', 'name: ' + skillName, 'description: ' + JSON.stringify(description), '---', '',
    '# Iris MCP · 按连接授权使用工具', '',
    'Use the Iris MCP server configured by the user. Match tool basenames below to the host\'s actual MCP tool names; prefixes vary by host. This skill does not install or register that server.', '',
    `Connection: \`${bundle.connectionId}\`. Core root identity: \`${bundle.rootId}\`. Authorization snapshot revision: ${bundle.revision}. These are identities, not local paths or credentials.`, '',
    '## Available tools · 可用工具', '',
    ...bundle.tools.map(name => '- `' + name + '`: ' + guidance[name]), '',
    '## Work within the selection · 遵循所选范围', '',
    'Choose only the steps needed for the user\'s request and available in the list above. A partial selection may not support a complete edit workflow. Ask for missing input or report a missing tool rather than inventing IDs, changing grants, creating another connection, or bypassing permissions through a shell/CLI.', '',
    'This is a saved instruction snapshot. Core checks actual current authorization on every request; loading this skill grants no permission. If a tool is unavailable or denied, report the mismatch and have the owner regenerate the bundle when appropriate. Do not automatically retry a write.', '',
    '## Preserve outcomes · 保持结果与恢复事实', '',
    'Keep returned Run, Task, Artifact, Operation IDs and original request UUIDs at handoffs. A refresh or reconnect does not authorize generation. After an uncertain result, use an available read tool to recover the original identity; if the selection cannot do that, report the uncertainty.', '',
    'Distinguish configured capability, actual execution, saved media, image display and visual inspection. Deliver the actual returned image or its original reference; do not claim an export, selection or host attachment action that these tools did not perform.', ''
  ].join('\n');
  const bytes = { 'SKILL.md': Buffer.from(body) };
  const files = Object.fromEntries(Object.entries(bytes).map(([name, content]) => [name,
    { size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }]));
  return { skillName, metadata, bundle, bytes, files, directories: [] };
}
import crypto from 'node:crypto';
