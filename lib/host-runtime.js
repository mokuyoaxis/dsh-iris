'use strict';

/**
 * Host Doctor 的运行时证据账本。
 *
 * 只记录 Iris 自己完成的注册事实和浏览器握手标量；不保存 ctx、service、
 * API Key、会话、附件或其他 live object。
 */
export const IRIS_PLUGIN_ID = '@mokuyoaxis/dsh-iris';
export const HOST_CLIENT_PROTOCOL_VERSION = 0;

export const EXPECTED_IRIS_TOOLS = Object.freeze([
  'iris_draw_image',
  'iris_generate_video',
  'iris_speak_text',
  'iris_transcribe_audio',
  'iris_task_status',
  'iris_look_at_image',
  'iris_relook_attachment',
  'iris_crop',
  'iris_pixel_diff',
  'iris_locate',
  'iris_html_screenshot',
  'iris_long_ocr',
  'iris_video_frames',
  'iris_media_summarize'
]);

export const EXPECTED_IRIS_SKILLS = Object.freeze([
  'iris-verify-ui',
  'iris-compose-media'
]);

export const EXPECTED_IRIS_ROUTES = Object.freeze([
  '/iris/media',
  '/iris/api',
  '/iris/api/actions',
  '/iris/render'
]);

export const EXPECTED_IRIS_CLIENT_SEATS = Object.freeze([
  'settings.section',
  'conversation.input.right',
  'conversation.input.dock',
  'shell.overlay'
]);

function fresh() {
  return {
    server: {
      loaded: false,
      pluginId: IRIS_PLUGIN_ID,
      version: 'unknown',
      startedAt: ''
    },
    tools: new Set(),
    skills: new Set(),
    routes: new Set(),
    client: null
  };
}

let runtime = fresh();

function safeText(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function record(set, values) {
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = safeText(value);
    if (text && set.size < 100) set.add(text);
  }
}

export function beginHostRuntime({ pluginId = IRIS_PLUGIN_ID, version = 'unknown' } = {}) {
  runtime = fresh();
  runtime.server = {
    loaded: true,
    pluginId: safeText(pluginId) || IRIS_PLUGIN_ID,
    version: safeText(version) || 'unknown',
    startedAt: new Date().toISOString()
  };
}

export function recordHostTool(name) {
  record(runtime.tools, name);
}

export function recordHostSkills(names) {
  record(runtime.skills, names);
}

export function recordHostRoutes(paths) {
  record(runtime.routes, paths);
}

/**
 * 接受同源客户端报告。严格限制字段和枚举；报告只是诊断证据，不参与认证。
 */
export function recordHostClient(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Host client report 必须是对象');
  }
  const allowed = new Set(['pluginId', 'version', 'protocolVersion', 'seats']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError('Host client report 不允许字段：' + key);
  }
  const pluginId = safeText(input.pluginId);
  const version = safeText(input.version);
  const protocolVersion = Number(input.protocolVersion);
  if (pluginId !== IRIS_PLUGIN_ID) throw new TypeError('Host client report 插件身份不匹配');
  if (!version) throw new TypeError('Host client report 缺少版本');
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 0) {
    throw new TypeError('Host client report protocolVersion 无效');
  }
  if (!Array.isArray(input.seats) || input.seats.length > 20) {
    throw new TypeError('Host client report seats 无效');
  }
  const incomingSeats = [...new Set(input.seats.map((value) => safeText(value)).filter(Boolean))];
  const invalidSeat = incomingSeats.find((seat) => !EXPECTED_IRIS_CLIENT_SEATS.includes(seat));
  if (invalidSeat) throw new TypeError('Host client report 未知 seat：' + invalidSeat);
  const previous = runtime.client
    && runtime.client.pluginId === pluginId
    && runtime.client.version === version
    && runtime.client.protocolVersion === protocolVersion
    ? runtime.client.seats : [];
  // 同一客户端版本的 Slot 回调可能分别发出请求且乱序完成，只允许单调并集。
  const seats = [...new Set(previous.concat(incomingSeats))];
  runtime.client = {
    loaded: true,
    pluginId,
    version,
    protocolVersion,
    seats,
    reportedAt: new Date().toISOString()
  };
  return { ok: true, acceptedSeats: seats.length };
}

export function hostRuntimeEvidence() {
  return Object.freeze({
    server: Object.freeze({ ...runtime.server }),
    tools: Object.freeze([...runtime.tools]),
    skills: Object.freeze([...runtime.skills]),
    routes: Object.freeze([...runtime.routes]),
    client: runtime.client
      ? Object.freeze({ ...runtime.client, seats: Object.freeze([...runtime.client.seats]) })
      : null
  });
}

/** 仅供隔离测试复位；生产装载使用 beginHostRuntime。 */
export function resetHostRuntimeForTests() {
  runtime = fresh();
}
