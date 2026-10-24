import { connectionFail } from './core-connections.js';

export const CONNECTION_TEMPLATE_EXAMPLE = Object.freeze({ schemaVersion: 0, title: 'My local MCP client', transport: 'stdio', format: 'mcpServers' });

/** Data only; neither template content nor a product name can add authority or a launch command. */
export function checkedConnectionTemplate(value) {
  const fail = () => connectionFail('IRIS_CONNECTION_INPUT_INVALID', '模板只接受标题、stdio/HTTP、mcpServers/entry 和可选 HTTPS 文档地址');
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['schemaVersion', 'title', 'transport', 'format', 'documentationUrl'].includes(key))
      || value.schemaVersion !== 0 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80
      || /[\x00-\x1f\x7f]/.test(value.title) || !['stdio', 'http'].includes(value.transport) || !['mcpServers', 'entry'].includes(value.format)) fail();
  let documentationUrl;
  if (value.documentationUrl !== undefined) {
    if (typeof value.documentationUrl !== 'string' || value.documentationUrl.length > 2048 || /[\x00-\x20\x7f]/.test(value.documentationUrl)) fail();
    let url;
    try { url = new URL(value.documentationUrl); } catch (_) { fail(); }
    if (url.protocol !== 'https:' || url.username || url.password) fail();
    documentationUrl = url.href;
  }
  return { schemaVersion: 0, title: value.title.trim(), transport: value.transport, format: value.format,
    ...(documentationUrl ? { documentationUrl } : {}) };
}
