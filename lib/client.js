/**
 * dsh-iris —— Client 半（Iris 工作台 + 悬浮泡泡）。
 *
 * DSH web client bundle 标准形态（与 dsh-at-file / dsh-better-sidebar 同构）：
 * window.__ModuleLoader__.load({ id, factory }) → CJS 工厂，require 解析宿主依赖，
 * `inject` 声明本 bundle 需要的 ctx 服务 key（这里是 slots），
 * `apply(ctx)` 通过本地 clientSlots 适配端口注册座位。
 *
 * 三个零替换风险的座位：
 * - settings.section（id: 'iris-workbench'）：Iris 工作台整页 ——
 *   供应商状态（Key 只见 hint）+ 历史任务面板 + 运行中任务进度 + 播放链接；
 * - conversation.input.dock（id: 'iris-progress'）：composer 上方常驻进度条，
 *   有运行中任务时显式一行进度，无则渲染 null（零占用）。
 *
 * 数据通道：host 侧 /iris/api/state 同源 JSON 路由（复用 /iris/media 同款
 * webServer 前缀模式），client 侧 fetch 轮询。全走标量，
 * apiKey 永不明文；legacy 产物使用 token 链接，Core 产物使用受 Host/浏览器来源守卫保护的 Artifact ID 链接。
 */
window.__ModuleLoader__.load({ id: '@mokuyoaxis/dsh-iris', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require('react');
  var IRIS_CLIENT_VERSION = '0.1.4';
  var HOST_CLIENT_PROTOCOL_VERSION = 0;
  var reportedSeats = [];

  function reportClientSeat(seat) {
    if (reportedSeats.indexOf(seat) < 0) reportedSeats.push(seat);
    if (!window || typeof window.fetch !== 'function') return;
    try {
      Promise.resolve(window.fetch('/iris/api/host-client', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          pluginId: '@mokuyoaxis/dsh-iris',
          version: IRIS_CLIENT_VERSION,
          protocolVersion: HOST_CLIENT_PROTOCOL_VERSION,
          seats: reportedSeats.slice()
        })
      })).catch(function () {});
    } catch (_) { /* Doctor handshake 不影响 UI */ }
  }

  // Client bundle 不能导入 server-side Host contract；只在此边界读取 DSH slots 服务。
  function clientSlotsPort(ctx) {
    var slots;
    try { slots = ctx && ctx.slots; } catch (_) { slots = null; }
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      var error = new Error('Iris clientSlots 不可用：DSH slots 需要 inject/register');
      error.code = slots ? 'IRIS_HOST_CAPABILITY_INCOMPATIBLE' : 'IRIS_HOST_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    return Object.freeze({
      inject: function (seat, callback) { return slots.inject(seat, callback); },
      register: function (definition, component) { return slots.register(definition, component); }
    });
  }

  var STYLE_ID = 'iris-wb-css';
  var cssText = [
    '.iris-wb { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, #e6e6e6); }',
    '.iris-wb-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 10px; }',
    '.iris-wb-head .iris-wb-title { font-size: 14px; font-weight: 600; }',
    '.iris-wb-head .iris-wb-date { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
    '.iris-wb-sec { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-wb-box { display: grid; gap: 8px; }',
    '.iris-wb-card { background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; padding: 8px 10px; }',
    '.iris-wb-card.iris-running { border-left: 3px solid var(--dsw-alias-state-warn-primary, #d9a941); }',
    '.iris-wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.iris-wb-kv { color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-wb-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #32323c); }',
    '.iris-wb-badge.ok { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-wb-badge.err { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-wb-badge.warn { color: var(--dsw-alias-state-warn-primary, #d9a941); }',
    '.iris-wb-progress { margin-top: 6px; }',
    '.iris-wb-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #32323c); overflow: hidden; }',
    '.iris-wb-bar i { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-wb-link { color: var(--dsw-alias-brand-primary, #7aa2f7); text-decoration: none; }',
    '.iris-wb-link:hover { text-decoration: underline; }',
    '.iris-wb-muted { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
    '.iris-wb-empty { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; padding: 6px 2px; }',
    '.iris-progress-dock { display: grid; gap: 6px; }',
    '.iris-progress-row { font-size: 12px; display: flex; gap: 8px; align-items: center; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-wb-card { cursor: pointer; }',
    '.iris-wb-card.selected { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-wb-drawer { margin-top: 8px; padding: 10px; border-top: 1px dashed var(--dsw-alias-border-l1, #3a3a44); display: grid; gap: 6px; font-size: 12px; line-height: 1.5; }',
    '.iris-wb-drawer .iris-wb-k { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11px; text-transform: uppercase; }',
    '.iris-wb-drawer .iris-wb-kv { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-wb-drawer .iris-wb-link { font-size: 11px; }',
    '.iris-wb-drawer .iris-wb-row { gap: 6px; }',
    '.iris-wb-drawer .iris-wb-prompt { white-space: pre-wrap; word-break: break-word; font-size: 12px; }',
    '.iris-wb-drawer .iris-wb-err { color: var(--dsw-alias-state-error-primary, #e06c6c); white-space: pre-wrap; word-break: break-word; font-size: 12px; }',
    '.iris-wb-loading { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
    '.iris-doctor-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.iris-doctor-score { font-weight: 600; flex: 1; }',
    '.iris-doctor-list { display: grid; gap: 4px; margin-top: 7px; }',
    '.iris-doctor-row { display: grid; grid-template-columns: 14px 1fr; gap: 6px; font-size: 11px; }',
    '.iris-doctor-row.ok { color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-doctor-row.warn { color: var(--dsw-alias-state-warn-primary, #d9a941); }',
    '.iris-doctor-row.error { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-doctor-details { margin-top: 7px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-doctor-details summary { cursor: pointer; font-size: 11px; }',
    '.iris-core-runtime { cursor: default; padding: 0; overflow: hidden; }',
    '.iris-core-runtime-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; }',
    '.iris-core-runtime-title { min-width: 0; flex: 1; display: grid; gap: 1px; }',
    '.iris-core-runtime-title strong { font-size: 12px; }',
    '.iris-core-runtime-body { display: grid; gap: 8px; padding: 0 10px 10px; border-top: 1px dashed var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-core-runtime-tools { display: flex; align-items: center; gap: 7px; padding-top: 8px; flex-wrap: wrap; }',
    '.iris-core-task-list { display: grid; gap: 6px; }',
    '.iris-core-task-row { width: 100%; box-sizing: border-box; display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px 9px; text-align: left; color: inherit; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-family: inherit; }',
    '.iris-core-task-row:hover, .iris-core-task-row.selected { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-core-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #73737d); }',
    '.iris-core-state-dot.ok { background: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 6px rgba(111,207,111,.45); }',
    '.iris-core-state-dot.warn { background: var(--dsw-alias-state-warn-primary, #d9a941); }',
    '.iris-core-state-dot.error { background: #b9656d; }',
    '.iris-core-task-main { min-width: 0; display: grid; gap: 1px; }',
    '.iris-core-task-main strong { font-size: 12px; font-weight: 600; }',
    '.iris-core-task-arrow { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 10px; }',
    '.iris-core-detail { display: grid; gap: 9px; padding: 10px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-core-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }',
    '.iris-core-detail-cell { min-width: 0; display: grid; gap: 1px; }',
    '.iris-core-detail-cell span:last-child { overflow-wrap: anywhere; }',
    '.iris-core-id { user-select: all; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }',
    '.iris-core-attempt { display: grid; gap: 3px; padding: 7px 8px; border-radius: 7px; background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-core-artifact { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 7px 8px; border-radius: 7px; background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '@media (max-width: 420px) { .iris-core-detail-grid { grid-template-columns: 1fr; } .iris-core-task-row { grid-template-columns: 8px minmax(0, 1fr) auto; padding: 8px; } }',
    /* ---- Core 用户侧只读投影（任务区安全 DTO 行） ---- */
    '.iris-core-user-row { cursor: default; }',
    '.iris-core-user-head { min-width: 0; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }',
    '.iris-core-user-model { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '@media (max-width: 420px) { .iris-core-user-head { display: grid; grid-template-columns: auto minmax(0, 1fr); row-gap: 2px; justify-items: start; } .iris-core-user-head .iris-wb-muted, .iris-core-user-row .iris-core-id { grid-column: 1 / -1; } }',
    /* ---- 操作卡片组（阶段 5 GUI 直连） ---- */
    '.iris-act-group { display: grid; gap: 8px; }',
    '.iris-act-card { background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; overflow: hidden; }',
    '.iris-act-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none; }',
    '.iris-act-head:hover { background: var(--dsw-alias-bg-layer-2, #32323c); }',
    '.iris-act-title { font-size: 13px; font-weight: 600; flex: 1; }',
    '.iris-act-arrow { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 10px; transition: transform 0.15s; }',
    '.iris-act-card.open .iris-act-arrow { transform: rotate(90deg); }',
    '.iris-act-body { padding: 4px 10px 12px; display: grid; gap: 8px; border-top: 1px dashed var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-act-field { display: grid; gap: 4px; }',
    '.iris-act-field label { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-act-field input, .iris-act-field textarea, .iris-act-field select { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 5px 7px; font-size: 12px; font-family: inherit; width: 100%; box-sizing: border-box; }',
    '.iris-act-field textarea { min-height: 48px; resize: vertical; }',
    '.iris-act-field input[type=checkbox] { width: auto; }',
    '.iris-act-run { background: var(--dsw-alias-brand-primary, #7aa2f7); color: #1a1a1e; border: none; border-radius: 5px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }',
    '.iris-act-run:disabled { opacity: 0.5; cursor: wait; }',
    '.iris-act-result { white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }',
    '.iris-act-result.err { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-act-img { max-width: 100%; max-height: 240px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); }',
    /* ---- 供应商管理（阶段 6） ---- */
    '.iris-pm { display: grid; gap: 8px; }',
    '.iris-pm-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.iris-pm-add { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px dashed var(--dsw-alias-border-l1, #3a3a44); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }',
    '.iris-pm-add:hover { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-pm-card { background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; padding: 8px 10px; display: grid; gap: 6px; }',
    '.iris-pm-card.open { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-pm-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; cursor: pointer; }',
    '.iris-pm-name { font-weight: 600; font-size: 13px; flex: 1; }',
    '.iris-pm-btn { background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; font-size: 11px; padding: 2px 7px; cursor: pointer; }',
    '.iris-pm-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-pm-btn.danger:hover { color: var(--dsw-alias-state-error-primary, #e06c6c); border-color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-pm-models { display: flex; flex-wrap: wrap; gap: 4px; }',
    '.iris-pm-model { font-size: 11px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; padding: 1px 8px; color: var(--dsw-alias-label-primary, #e6e6e6); }',
    '.iris-pm-model.dim { opacity: 0.55; }',
    '.iris-pm-cap { color: var(--dsw-alias-brand-primary, #7aa2f7); font-size: 10px; }',
    '.iris-pm-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-pm-field { display: grid; gap: 3px; }',
    '.iris-pm-field input, .iris-pm-field textarea { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 100%; box-sizing: border-box; }',
    '.iris-pm-act { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-pm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #73737d); margin-right: 4px; }',
    '.iris-pm-dot.configured { background: #6f9df6; box-shadow: 0 0 7px rgba(111,157,246,.55); }',
    '.iris-pm-dot.verified { background: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 7px var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-pm-dot.failed { background: #b9656d; box-shadow: 0 0 6px rgba(185,101,109,.38); opacity: .82; }',
    '.iris-health-grid { display: grid; gap: 5px; }',
    '.iris-health-row { display: grid; grid-template-columns: minmax(72px, auto) 1fr auto; align-items: center; gap: 7px; padding: 6px 9px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #26262e); font-size: 11px; }',
    '.iris-health-name { font-weight: 600; }',
    '.iris-health-state { color: var(--dsw-alias-label-secondary, #9a9a9a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.iris-health-row.failed .iris-health-state { color: #c87a81; }',
    '.iris-health-row.configured .iris-health-state { color: #7da8fa; }',
    '.iris-health-row.verified .iris-health-state { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-cap-grid { display: grid; gap: 6px; }',
    '.iris-cap-row { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; padding: 6px 9px; font-size: 12px; }',
    '.iris-cap-name { font-weight: 600; min-width: 64px; }',
    '.iris-cap-chip { display: inline-flex; align-items: center; gap: 3px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; padding: 1px 6px; font-size: 11px; }',
    '.iris-cap-chip b { color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-cap-auto { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11px; font-style: italic; }',
    '.iris-pm-model-sel { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 100%; }',
    '.iris-wb-drawer .iris-wb-loading { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
    '.iris-bubble { position: fixed; z-index: 9999; cursor: grab; user-select: none; touch-action: none; }',
    '.iris-bubble.dragging { cursor: grabbing; }',
    '.iris-bubble-btn { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); transition: box-shadow 0.2s, border-color 0.2s, opacity 0.2s; }',
    '.iris-bubble.health-configured .iris-bubble-btn { border-color: #6f9df6; box-shadow: 0 0 14px rgba(111,157,246,.55); }',
    '.iris-bubble.health-verified .iris-bubble-btn { border-color: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 14px var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-bubble.health-failed .iris-bubble-btn { opacity: .72; border-color: #b9656d; box-shadow: 0 0 11px rgba(185,101,109,.34); }',
    '.iris-bubble.health-unconfigured .iris-bubble-btn { opacity: 0.55; border-color: var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-bubble-badge { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--dsw-alias-state-warn-primary, #d9a941); color: #1a1a1e; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; padding: 0 3px; }',
    '.iris-bubble-panel { position: fixed; z-index: 9998; box-sizing: border-box; width: min(360px, calc(100vw - 16px)); max-height: min(520px, calc(100dvh - 16px)); overflow: auto; overscroll-behavior: contain; background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 12px; padding: 12px 14px; font-size: 12px; line-height: 1.45; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45); }',
    '.iris-bubble-panel-head { position: absolute; top: 6px; right: 6px; z-index: 2; }',
    '.iris-bubble-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 14px; cursor: pointer; padding: 4px 6px; }',
    '.iris-bubble-close:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }',
    /* 泡泡瘦身（阶段 4 续）：标签页 + 紧凑任务行 */
    '.iris-bubble-tabs { display: flex; gap: 6px; margin-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #3a3a44); padding-bottom: 8px; }',
    '.iris-bubble-tab { flex: 1; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-secondary, #9a9a9a); border-radius: 6px; padding: 5px 8px; font-size: 12px; cursor: pointer; }',
    '.iris-bubble-tab.active { color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-brand-primary, #7aa2f7); background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-task-mini { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }',
    '.iris-task-mini:hover { background: var(--dsw-alias-bg-layer-2, #32323c); }',
    '.iris-task-mini .iris-task-mini-prompt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-bubble-more { font-size: 11px; color: var(--dsw-alias-brand-primary, #7aa2f7); background: transparent; border: none; cursor: pointer; padding: 4px 2px; text-align: left; }',
    /* 历史浏览器（设置页按日期分组折叠） */
    '.iris-hist-group { margin-bottom: 4px; }',
    '.iris-hist-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #9a9a9a); cursor: pointer; padding: 4px 2px; }',
    '.iris-hist-head:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }',
    /* 常用卡片选择器 + 清理区 */
    '.iris-pick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }',
    '.iris-pick-item { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }',
    '.iris-clean { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
    '.iris-clean-btn { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer; }',
    '.iris-clean-btn:hover { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-clean-btn.danger:hover { color: var(--dsw-alias-state-error-primary, #e06c6c); border-color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-clean-note { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    /* 独立作品库 v0：任务清理后仍可浏览，窄屏自动收缩。 */
    '.iris-gallery-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }',
    '.iris-gallery-tools .iris-clean-note { flex: 1; min-width: 100px; }',
    '.iris-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; }',
    '.iris-gallery-card { min-width: 0; overflow: hidden; border: 1px solid rgba(150,164,215,.16); border-radius: 13px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #26262e) 92%, transparent); box-shadow: 0 7px 22px rgba(0,0,0,.12); }',
    '.iris-gallery-preview { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 1 / 1; overflow: hidden; background: rgba(8,10,16,.28); }',
    '.iris-gallery-preview img, .iris-gallery-preview video { width: 100%; height: 100%; object-fit: contain; }',
    '.iris-gallery-preview audio { width: calc(100% - 16px); }',
    '.iris-gallery-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }',
    '.iris-gallery-meta { color: var(--dsw-alias-label-tertiary, #7a7a85); font-size: 10px; }',
    '.iris-gallery-info { display: grid; gap: 4px; padding: 8px 9px 9px; }',
    '.iris-gallery-actions { display: flex; align-items: center; gap: 8px; }',
    '.iris-artifact-mini { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 4px 6px; border-radius: 7px; color: var(--dsw-alias-label-secondary, #9a9a9a); text-decoration: none; }',
    '.iris-artifact-mini:hover { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); }',
    '.iris-artifact-mini span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '@media (max-width: 360px) { .iris-gallery-grid { grid-template-columns: 1fr; } }',
    /* 模型池（阶段 9 P4） */
    '.iris-pm-pool { display: grid; gap: 4px; }',
    '.iris-pm-mrows { display: grid; gap: 3px; max-height: 220px; overflow: auto; }',
    '.iris-pm-mrow { display: flex; align-items: center; gap: 6px; font-size: 12px; }',
    '.iris-pm-mname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.iris-pm-mtag { font-size: 9px; color: var(--dsw-alias-brand-primary, #7aa2f7); border: 1px solid var(--dsw-alias-brand-primary, #7aa2f7); border-radius: 3px; padding: 0 3px; margin-left: 4px; }',
    '.iris-pm-mcaps { display: flex; gap: 3px; }',
    '.iris-pm-ver { font-size: 10px; padding: 0 4px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-pm-ver.configured { color: #7da8fa; }',
    '.iris-pm-ver.verified { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-pm-ver.failed { color: #c87a81; border-color: rgba(185,101,109,.5); }',
    '.iris-pm-ver.unconfigured { opacity: .55; }',
    '.iris-pm-madd { flex: 1; background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 3px 6px; font-size: 12px; }',
    /* 文件选择器（阶段 10） */
    '.iris-ff { display: grid; gap: 4px; }',
    '.iris-ff-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
    '.iris-ff-btn { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; }',
    '.iris-ff-btn:hover { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-ff-btn.primary { background: var(--dsw-alias-brand-primary, #7aa2f7); color: var(--dsw-alias-label-primary-inverted, #fff); border-color: var(--dsw-alias-brand-primary, #7aa2f7); font-weight: 600; }',
    '.iris-ff-btn.primary:hover { filter: brightness(1.1); }',
    '.iris-ff-btn.ghost { background: transparent; color: var(--dsw-alias-label-tertiary, #7a7a85); border-style: dashed; }',
    '.iris-ff-hint { font-size: 10px; line-height: 1.45; color: var(--dsw-alias-label-tertiary, #7a7a85); }',
    '.iris-ff-val { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }',
    '.iris-ff-val.set { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-ff-list { display: grid; gap: 2px; max-height: 160px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 6px; padding: 4px; background: var(--dsw-alias-bg-layer-2, #32323c); }',
    '.iris-ff-item { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }',
    '.iris-ff-item:hover { background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-ff-item .iris-ff-src { color: var(--dsw-alias-brand-primary, #7aa2f7); font-size: 10px; }',
    /* 对话框级提示词优化器：桌面浮层 + 窄屏底部 Sheet */
    '.iris-po-wrap { position: relative; display: inline-flex; flex: 0 0 auto; }',
    '.iris-po-trigger { appearance: none; -webkit-appearance: none; width: 30px; height: 30px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; outline: 0; background: transparent; color: inherit; font-size: 19px; line-height: 1; cursor: pointer; box-shadow: none; filter: drop-shadow(0 3px 7px rgba(91,113,220,.22)); transition: transform .18s ease, filter .18s ease, opacity .18s ease; }',
    '.iris-po-trigger:hover { transform: translateY(-2px) scale(1.10); filter: drop-shadow(0 5px 10px rgba(112,137,255,.42)); }',
    '.iris-po-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #7aa2f7); outline-offset: 2px; }',
    '.iris-po-backdrop { position: fixed; inset: 0; z-index: 10019; background: rgba(8,10,18,.30); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); touch-action: none; animation: iris-po-fade .16s ease-out; }',
    '.iris-po-panel { position: fixed; z-index: 10020; right: max(14px, env(safe-area-inset-right)); bottom: max(78px, calc(env(safe-area-inset-bottom) + 68px)); width: min(440px, calc(100vw - 28px)); max-height: min(680px, calc(100dvh - 104px)); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; box-sizing: border-box; padding: 18px; display: grid; gap: 13px; background-color: rgba(35,36,47,.84); background: radial-gradient(circle at 10% -5%, rgba(132,160,255,.24), transparent 42%), color-mix(in srgb, var(--dsw-alias-bg-layer-1, #26262e) 82%, transparent); color: var(--dsw-alias-label-primary, #eeeeF2); border: 1px solid rgba(150,164,215,.25); border-radius: 20px; box-shadow: 0 24px 70px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.07); backdrop-filter: blur(28px) saturate(1.28); -webkit-backdrop-filter: blur(28px) saturate(1.28); animation: iris-po-rise .20s cubic-bezier(.2,.8,.2,1); scrollbar-width: thin; }',
    '.iris-po-head { position: sticky; top: -18px; z-index: 1; margin: -18px -18px 0; padding: 16px 18px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; background: linear-gradient(to bottom, color-mix(in srgb, var(--dsw-alias-bg-layer-1, #26262e) 88%, transparent) 72%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }',
    '.iris-po-title { display: inline-flex; align-items: center; gap: 9px; font-size: 14px; letter-spacing: .01em; }',
    '.iris-po-mark, .iris-po-settings-mark { display: inline-flex; align-items: center; justify-content: center; width: 29px; height: 29px; border-radius: 999px; background: rgba(255,255,255,.055); box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 5px 16px rgba(67,83,168,.16); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); filter: drop-shadow(0 2px 5px rgba(105,128,235,.16)); }',
    '.iris-po-close { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 999px; background: rgba(255,255,255,.05); color: var(--dsw-alias-label-secondary, #a6a6b2); font-size: 14px; cursor: pointer; transition: background .15s, color .15s; }',
    '.iris-po-close:hover { background: rgba(255,255,255,.10); color: var(--dsw-alias-label-primary, #eeeef2); }',
    '.iris-po-muted, .iris-po-route, .iris-po-note { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #a6a6b2); word-break: break-word; }',
    '.iris-po-route { padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,.045); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.iris-po-note { padding: 8px 10px; border-radius: 10px; color: var(--dsw-alias-state-warn-primary, #dfbd69); background: rgba(217,169,65,.08); }',
    '.iris-po-field { display: grid; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #a6a6b2); }',
    '.iris-po-field select, .iris-po-result textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.055); color: var(--dsw-alias-label-primary, #eeeef2); border: 1px solid rgba(150,164,215,.20); border-radius: 11px; padding: 9px 11px; font: inherit; font-size: 12px; outline: none; transition: border-color .15s, background .15s, box-shadow .15s; }',
    '.iris-po-field select:focus, .iris-po-result textarea:focus { border-color: rgba(122,162,247,.72); background: rgba(255,255,255,.075); box-shadow: 0 0 0 3px rgba(122,162,247,.11); }',
    '.iris-po-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.iris-po-btn, .iris-po-primary { min-height: 34px; border: 1px solid rgba(150,164,215,.20); border-radius: 10px; padding: 6px 11px; font: inherit; font-size: 11px; cursor: pointer; transition: transform .15s, background .15s, border-color .15s; }',
    '.iris-po-btn { background: rgba(255,255,255,.045); color: var(--dsw-alias-label-secondary, #b0b0bb); }',
    '.iris-po-btn:hover { background: rgba(255,255,255,.085); color: var(--dsw-alias-label-primary, #eeeef2); border-color: rgba(150,174,255,.50); }',
    '.iris-po-primary { background: linear-gradient(135deg, #779cf3, #8c79de); color: #fff; border-color: rgba(174,187,255,.55); font-weight: 650; box-shadow: 0 6px 18px rgba(76,92,188,.22); }',
    '.iris-po-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(76,92,188,.32); }',
    '.iris-po-primary:disabled, .iris-po-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }',
    '.iris-po-result { display: grid; gap: 8px; padding: 12px; border: 1px solid rgba(137,155,218,.18); border-radius: 15px; background: rgba(10,12,20,.16); }',
    '.iris-po-result-label { font-size: 11px; font-weight: 650; letter-spacing: .02em; }',
    '.iris-po-result textarea { min-height: 156px; max-height: 34dvh; resize: vertical; line-height: 1.58; }',
    '.iris-po-config { padding: 11px 12px; border: 1px solid rgba(150,164,215,.14); border-radius: 13px; background: rgba(255,255,255,.025); font-size: 11px; }',
    '.iris-po-config summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #a6a6b2); }',
    '.iris-po-config[open] summary { margin-bottom: 9px; color: var(--dsw-alias-label-primary, #eeeef2); }',
    '.iris-po-config .iris-po-actions { margin: 9px 0; }',
    '.iris-po-btn.danger:hover { color: var(--dsw-alias-state-error-primary, #eb7d86); border-color: rgba(235,125,134,.55); background: rgba(235,125,134,.08); }',
    '.iris-po-file { display: none; }',
    '.iris-po-disable { justify-self: start; border: 0; padding: 2px 0; background: transparent; color: var(--dsw-alias-label-tertiary, #777986); font: inherit; font-size: 10px; cursor: pointer; }',
    '.iris-po-disable:hover { color: var(--dsw-alias-state-error-primary, #eb7d86); }',
    '@keyframes iris-po-fade { from { opacity: 0; } to { opacity: 1; } }',
    '@keyframes iris-po-rise { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }',
    '@media (max-width: 640px) { .iris-po-backdrop { background: rgba(6,8,14,.48); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); } .iris-po-panel { left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: max(8px, env(safe-area-inset-bottom)); width: auto; max-height: calc(100dvh - max(16px, env(safe-area-inset-top))); padding: 16px; gap: 11px; border-radius: 22px; } .iris-po-head { top: -16px; margin: -16px -16px 0; padding: 14px 16px 10px; } .iris-po-btn, .iris-po-primary { min-height: 42px; flex: 1 1 auto; } .iris-po-actions .iris-po-primary:first-child { flex-basis: 100%; } .iris-po-result textarea { min-height: 122px; max-height: 28dvh; resize: none; } .iris-po-route { white-space: normal; } }',
    '@media (max-width: 360px) { .iris-po-panel { left: 4px; right: 4px; bottom: max(4px, env(safe-area-inset-bottom)); padding: 13px; border-radius: 18px; } .iris-po-head { top: -13px; margin: -13px -13px 0; padding: 12px 13px 8px; } .iris-po-actions { gap: 6px; } }',
    '@media (prefers-reduced-motion: reduce) { .iris-po-panel, .iris-po-backdrop { animation: none; } .iris-po-trigger, .iris-po-btn, .iris-po-primary { transition: none; } }',
  ].join('\n');

  function adoptStyles() {
    if (document.getElementById(STYLE_ID) !== null) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.dataset.plugin = 'dsh-iris';
    style.dataset.pluginCss = STYLE_ID;
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  var inject = ['slots'];

  function apply(ctx) {
    try {
      console.log('[iris] client apply start');
      adoptStyles();

    /* ---- 当前会话 id（文件选择器 L1 用；ctx.sessions 是标准插件能力） ---- */
    var currentSessionId = null;
    try {
      var sessions = ctx && ctx.sessions;
      var listObs = sessions && sessions.list;
      if (listObs && typeof listObs.getSnapshot === 'function') {
        currentSessionId = (listObs.getSnapshot() || {}).current || null;
        if (typeof listObs.subscribe === 'function') {
          listObs.subscribe(function (snap) { currentSessionId = (snap || {}).current || null; });
        }
      }
    } catch (_) { /* 拿不到会话 → L1 退化为只列 iris 产物 */ }
    function sessionId() { return currentSessionId || ''; }

    /* ---- 三个座位共享一份状态订阅（模块级 pub/sub + SSE 实时推送） ---- */
    var sharedState = null;
    var sharedListeners = [];
    var sharedTimer = null;  // 兜底轮询（SSE 断线时状态仍会刷新）
    var sharedSource = null; // EventSource（SSE 主通道）

    function useIrisState(tickMs) {
      var pair = React.useState(sharedState);
      var setState = pair[1];
      React.useEffect(function () {
        function listener(data) {
          setState(data);
        }
        sharedListeners.push(listener);
        if (sharedState) setState(sharedState);
        if (!sharedTimer && !sharedSource) {
          function apply(data) {
            if (sharedState && data && sharedState.stateEpoch && data.stateEpoch === sharedState.stateEpoch
                && Number(data.stateRevision || 0) <= Number(sharedState.stateRevision || 0)) return;
            sharedState = data;
            for (var i = 0; i < sharedListeners.length; i++) {
              sharedListeners[i](data);
            }
          }
          function load() {
            fetch('/iris/api/state')
              .then(function (res) { return res.ok ? res.json() : null; })
              .then(function (data) {
                if (data) {
                  apply(data);
                  window.dispatchEvent(new CustomEvent('iris-core-refresh-tick'));
                }
              })
              .catch(function () { /* 网络抖动静默 */ });
          }
          load(); // 首屏立即拉一次（SSE 建连前/失败时仍有数据）
          // SSE 主通道：实时接收状态推送，替代 5s 轮询
          try {
            sharedSource = new EventSource('/iris/api/state/events');
            sharedSource.onmessage = function (e) {
              try { apply(JSON.parse(e.data)); } catch (_) { /* 忽略格式错误 */ }
            };
            sharedSource.onerror = function () {
              // 浏览器自动重连（retry: 3000）；兜底轮询 30s 在断线期间保持刷新
            };
          } catch (_) { sharedSource = null; }
          // 兜底轮询：SSE 断线/漏推时状态最终一致（30s 一次，远低于原 5s 频率）
          sharedTimer = setInterval(load, 30000);
        }
        return function () {
          var idx = sharedListeners.indexOf(listener);
          if (idx >= 0) sharedListeners.splice(idx, 1);
          if (sharedListeners.length === 0) {
            if (sharedSource) { try { sharedSource.close(); } catch (_) {} sharedSource = null; }
            if (sharedTimer) { clearInterval(sharedTimer); sharedTimer = null; }
          }
        };
      }, [tickMs]);
      return sharedState;
    }

    var HEALTH_META = {
      unconfigured: { label: '未配置', symbol: '○' },
      configured: { label: '已配置，待验证', symbol: '◌' },
      verified: { label: '近期验证成功', symbol: '●' },
      failed: { label: '认证失败', symbol: '×' }
    };

    function capabilityHealth(state, capability) {
      var health = state && state.health && state.health.capabilities
        && state.health.capabilities[capability];
      if (health && HEALTH_META[health.status]) return health;
      var providers = (state && state.providers) || [];
      var configured = providers.some(function (p) {
        return p.enabled && p.apiKeyHint && Array.isArray(p.capabilities)
          && p.capabilities.indexOf(capability) >= 0;
      });
      return { status: configured ? 'configured' : 'unconfigured', candidateCount: configured ? 1 : 0 };
    }

    function relativeHealthTime(value) {
      var ms = Date.now() - Date.parse(String(value || ''));
      if (!Number.isFinite(ms) || ms < 0) return '';
      if (ms < 60000) return '刚刚';
      if (ms < 3600000) return Math.floor(ms / 60000) + ' 分钟前';
      if (ms < 86400000) return Math.floor(ms / 3600000) + ' 小时前';
      return Math.floor(ms / 86400000) + ' 天前';
    }

    function healthText(health) {
      var status = health && HEALTH_META[health.status] ? health.status : 'unconfigured';
      var text = HEALTH_META[status].label;
      var age = relativeHealthTime(health && health.observedAt);
      return text + (age ? ' · ' + age : '');
    }

    function CapabilityHealthOverview() {
      var state = useIrisState(5000);
      var rows = [
        ['image-gen', '图片'],
        ['video-gen', '视频'],
        ['tts', '语音'],
        ['transcribe', '转写'],
        ['vision', '视觉']
      ];
      return React.createElement('div', { className: 'iris-health-grid' }, rows.map(function (row) {
        var health = capabilityHealth(state, row[0]);
        var meta = HEALTH_META[health.status] || HEALTH_META.unconfigured;
        return React.createElement('div', { key: row[0], className: 'iris-health-row ' + health.status },
          React.createElement('span', { className: 'iris-health-name' },
            React.createElement('span', { className: 'iris-pm-dot ' + health.status }, meta.symbol),
            row[1]),
          React.createElement('span', { className: 'iris-health-state', title: healthText(health) }, healthText(health)),
          React.createElement('span', { className: 'iris-wb-muted' }, String(health.candidateCount || 0) + ' 路'));
      }));
    }

    /* ---- 任务详情抽屉：按需拉取 /iris/api/task/:id ---- */
    function useTaskDetail(taskId, revision) {
      var pair = React.useState(null);
      var setDetail = pair[1];
      React.useEffect(function () {
        if (!taskId) { setDetail(null); return; }
        var alive = true;
        setDetail(null); // 换任务先清空，显示加载中
        fetch('/iris/api/task/' + encodeURIComponent(taskId))
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { if (alive && data) setDetail(data); })
          .catch(function () { /* 静默 */ });
        return function () { alive = false; };
      }, [taskId, revision]);
      return pair[0];
    }

    function fmtTime(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
    }

    function fmtElapsed(ms) {
      if (!ms) return '';
      var s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      return Math.floor(s / 60) + 'm' + (s % 60) + 's';
    }

    /* cap → 单字图标（紧凑行/历史分组用） */
    var CAP_EMOJI = { image: '🎨', video: '🎬', tts: '🔊', transcribe: '🎙️', summarize: '📝' };
    function capIcon(cap) { return CAP_EMOJI[cap] || '•'; }

    /* 相对时间（今天/昨天/更早分组） */
    function dayBucket(iso) {
      if (!iso) return '更早';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '更早';
      var now = new Date();
      var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      var t = d.getTime();
      if (t >= startToday) return '今天';
      if (t >= startToday - 86400000) return '昨天';
      return '更早';
    }

    var TASK_STATE_LABELS = {
      queued: '排队中', running: '运行中', watching_paused: '观察暂停', needs_attention: '需要确认',
      artifact_unavailable: '结果待取回', succeeded: '成功', failed: '失败', canceled: '已取消'
    };
    function taskState(task) {
      if (task && task.userState) return task.userState;
      if (task && task.status === 'succeeded') return 'succeeded';
      if (task && task.status === 'failed') return 'failed';
      if (task && task.status === 'canceled') return 'canceled';
      return 'running';
    }
    function taskStateLabel(task) {
      var state = taskState(task);
      return TASK_STATE_LABELS[state] || state;
    }
    function taskStateClass(task) {
      var state = taskState(task);
      if (state === 'succeeded') return 'ok';
      if (state === 'failed') return 'err';
      if (state === 'watching_paused' || state === 'needs_attention' || state === 'artifact_unavailable') return 'warn';
      return '';
    }
    function attentionDispositionLabel(task) {
      var disposition = task && task.attentionDisposition;
      if (!disposition || disposition.status !== 'acknowledged') return '';
      return disposition.reason === 'retried' ? '已通过重试处理' : '提醒已读';
    }

    /* 紧凑任务行：泡泡「任务」标签用，单行摘要 */
    function taskRowMini(task, selected, onSelect) {
      var st = taskStateClass(task);
      var label = taskStateLabel(task);
      return React.createElement('div', {
        key: task.id, className: 'iris-task-mini' + (selected ? ' selected' : ''),
        onClick: function () { onSelect(selected ? null : task.id); }, title: '点击展开详情'
      },
        React.createElement('span', {}, capIcon(task.cap)),
        React.createElement('span', { className: 'iris-wb-badge ' + st }, label),
        React.createElement('span', { className: 'iris-task-mini-prompt' }, String(task.prompt || task.model || task.cap)),
        React.createElement('span', { className: 'iris-wb-muted' }, task.createdAt ? new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''));
    }

    function TaskRecoveryActions({ detail, onDeleted }) {
      var pair = React.useState('');
      var note = pair[0];
      var setNote = pair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var state = taskState(detail);
      var attentionState = ['watching_paused', 'needs_attention', 'artifact_unavailable'].indexOf(state) >= 0;
      var acknowledged = detail.attentionDisposition && detail.attentionDisposition.status === 'acknowledged';
      var canAcknowledge = detail.schemaVersion === 2 && attentionState && !acknowledged;
      var canRestore = detail.schemaVersion === 2 && attentionState && acknowledged;
      var canReobserve = detail.schemaVersion === 2 && !acknowledged && detail.acceptance === 'accepted' && detail.remoteTaskId
        && detail.outcome !== 'succeeded' && detail.outcome !== 'failed' && detail.outcome !== 'canceled';
      var canRedeliver = detail.schemaVersion === 2 && !acknowledged && state === 'artifact_unavailable' && detail.remoteTaskId;
      var canRetry = detail.schemaVersion === 2 && !acknowledged && ['needs_attention', 'failed', 'canceled'].indexOf(state) >= 0
        && (detail.cap === 'image' || (detail.cap === 'video' && detail.mode === 't2v'));
      var canDelete = detail.status !== 'running' || (detail.schemaVersion === 2 && attentionState && acknowledged);
      if (!canAcknowledge && !canRestore && !canReobserve && !canRedeliver && !canRetry && !canDelete) return null;
      function run(action, body, confirmMessage) {
        if (confirmMessage && !window.confirm(confirmMessage)) return;
        setBusy(true);
        setNote('处理中…');
        postAction(action, body).then(function (r) {
          setNote(r.ok ? ((r.d && r.d.text) || '操作已接受') : ('失败：' + ((r.d && r.d.error) || '未知错误')));
          if (r.ok && action === 'tasks_delete' && typeof onDeleted === 'function') onDeleted();
        }).catch(function (error) { setNote('失败：' + String((error && error.message) || error)); })
          .finally(function () { setBusy(false); });
      }
      return React.createElement('div', { className: 'iris-wb-row', onClick: function (e) { e.stopPropagation(); } },
        canReobserve ? React.createElement('button', { className: 'iris-pm-btn', disabled: busy, onClick: function () { run('task_reobserve', { task_id: detail.id }); } }, '重新观察') : null,
        canRedeliver ? React.createElement('button', { className: 'iris-pm-btn', disabled: busy, onClick: function () { run('task_redeliver', { task_id: detail.id }); } }, '重新交付') : null,
        canRetry ? React.createElement('button', { className: 'iris-pm-btn danger', disabled: busy, onClick: function () {
          run('task_manual_retry', { task_id: detail.id, confirm_duplicate_charge: true },
            '远端任务可能已经产生，本次会创建新的生成任务，可能重复计费。确认知情重试？');
        } }, '知情重试') : null,
        canAcknowledge ? React.createElement('button', { className: 'iris-pm-btn', disabled: busy,
          onClick: function () { run('task_ack_attention', { task_id: detail.id }); } }, '标为已读') : null,
        canRestore ? React.createElement('button', { className: 'iris-pm-btn', disabled: busy,
          onClick: function () { run('task_restore_attention', { task_id: detail.id }); } }, '恢复提醒') : null,
        canDelete ? React.createElement('button', { className: 'iris-pm-btn danger', disabled: busy,
          onClick: function () { run('tasks_delete', { task_id: detail.id },
            attentionState ? '该任务仍含未知远程事实；删除后无法再观察。确认只删除任务记录？' : '确认删除该任务记录？作品文件保留。'); } }, '删除记录') : null,
        note ? React.createElement('span', { className: 'iris-clean-note' }, note) : null);
    }

    /* ---- 任务详情抽屉：点击任务卡片行展开 ---- */
    function TaskDetailDrawer({ taskId, revision, onDeleted }) {
      var detail = useTaskDetail(taskId, revision);
      if (!detail) {
        return React.createElement('div', { className: 'iris-wb-drawer iris-wb-loading' }, '加载任务详情…');
      }
      var el = [];
      el.push(React.createElement('div', { key: 'k', className: 'iris-wb-k' }, '提示词'));
      el.push(React.createElement('div', { key: 'p', className: 'iris-wb-prompt' }, detail.prompt || '（空）'));
      if (Number(detail.schemaVersion) === 1) {
        el.push(React.createElement('div', { key: 'legacy', className: 'iris-clean-note' },
          '旧版任务记录 · 仅支持查看恢复事实。由于缺少可靠的远端受理与交付事实，不提供重新观察、重新交付或知情重试；已终止记录仍可删除。'));
      }
      var dispositionLabel = attentionDispositionLabel(detail);
      if (dispositionLabel) {
        var related = detail.attentionDisposition.relatedTaskId ? ' · 关联任务 ' + detail.attentionDisposition.relatedTaskId : '';
        el.push(React.createElement('div', { key: 'attention-disposition', className: 'iris-clean-note' }, dispositionLabel + related));
      }
      if (detail.error) {
        el.push(React.createElement('div', { key: 'ek', className: 'iris-wb-k' }, '错误'));
        el.push(React.createElement('div', { key: 'e', className: 'iris-wb-err' }, detail.error));
      }
      var kv = [
        ['ID', detail.id],
        ['能力', detail.cap],
        ['状态', taskStateLabel(detail)],
        ['模型', detail.model],
        ['供应商', detail.providerName],
        ['模式', detail.mode || '—'],
        ['远端任务', detail.remoteTaskId || '—'],
        ['来源任务', detail.retryOf || '—'],
        ['后续重试', (detail.manualRetries || []).map(function (item) { return item.taskId; }).join('、') || '—'],
        ['发起', detail.createdAt ? fmtTime(detail.createdAt) : '—'],
        ['完成', detail.finishedAt ? fmtTime(detail.finishedAt) : '—'],
        ['耗时', detail.elapsedMs ? fmtElapsed(detail.elapsedMs) : '—']
      ];
      el.push(React.createElement('div', { key: 'kvk', className: 'iris-wb-k' }, '元数据'));
      el.push(React.createElement('div', { key: 'kv', className: 'iris-wb-row' },
        kv.map(function (pair, i) {
          return React.createElement('span', { key: i, className: 'iris-wb-kv' }, pair[0] + ': ' + pair[1]);
        })));
      var files = detail.files || [];
      if (files.length) {
        el.push(React.createElement('div', { key: 'fk', className: 'iris-wb-k' }, '产物文件'));
        el.push(React.createElement('div', { key: 'f', className: 'iris-wb-row' },
          files.map(function (f) {
            return React.createElement('span', { key: f, className: 'iris-wb-kv' }, f);
          })));
      }
      var media = detail.media || [];
      if (media.length) {
        el.push(React.createElement('div', { key: 'mk', className: 'iris-wb-k' }, '播放'));
        el.push(React.createElement('div', { key: 'm', className: 'iris-wb-row' },
          media.map(function (m) {
            return React.createElement('a', {
              key: m.file, className: 'iris-wb-link', href: m.url, target: '_blank', rel: 'noreferrer',
              onClick: function (e) { e.stopPropagation(); }
            }, '▶ ' + m.file);
          })));
      }
      var atts = detail.attachments || [];
      if (atts.length) {
        el.push(React.createElement('div', { key: 'ak', className: 'iris-wb-k' }, '附件'));
        el.push(React.createElement('div', { key: 'a', className: 'iris-wb-row' },
          atts.map(function (a) {
            return React.createElement('span', { key: a.attachmentId, className: 'iris-wb-kv' }, a.attachmentId + (a.file ? ' (' + a.file + ')' : ''));
          })));
      }
      el.push(React.createElement(TaskRecoveryActions, { key: 'recovery', detail: detail, onDeleted: onDeleted }));
      return React.createElement('div', { className: 'iris-wb-drawer' }, ...el);
    }

    function taskRow(task, isRunning, selected, onSelect) {
      var stateClass = taskStateClass(task);
      var badge = React.createElement('span', { className: 'iris-wb-badge' + (stateClass ? ' ' + stateClass : '') }, taskStateLabel(task));
      var cells = [
        React.createElement('span', { className: 'iris-wb-kv' }, task.cap),
        badge,
        React.createElement('span', { className: 'iris-wb-kv' }, task.model || ''),
        React.createElement('span', { className: 'iris-wb-muted' }, String(task.prompt || '').slice(0, 60))
      ];
      if (Number(task.schemaVersion) === 1) {
        cells.push(React.createElement('span', { className: 'iris-wb-badge', title: '旧版记录缺少可靠的远端受理与交付事实，仅支持查看' }, '旧任务 · 只读'));
      }
      var dispositionLabel = attentionDispositionLabel(task);
      if (dispositionLabel) cells.push(React.createElement('span', { className: 'iris-wb-badge ok' }, dispositionLabel));
      if (task.retryOf) cells.push(React.createElement('span', { className: 'iris-wb-badge' }, '重试任务'));
      if (task.error) cells.push(React.createElement('span', { className: 'iris-wb-badge err' }, String(task.error).slice(0, 40)));
      var links = (task.media || []).map(function (m) {
        return React.createElement('a', {
          key: m.file, className: 'iris-wb-link', href: m.url, target: '_blank', rel: 'noreferrer',
          onClick: function (e) { e.stopPropagation(); }
        }, '▶ ' + m.file);
      });
      var body = [
        React.createElement('div', { className: 'iris-wb-row' }, ...cells),
        links.length ? React.createElement('div', { className: 'iris-wb-row' }, ...links) : null
      ];
      if (isRunning) {
        var pct = String(task.progress || '');
        var isNumericPct = /^\d+(\.\d+)?%$/.test(pct);
        if (isNumericPct) {
          body.push(React.createElement('div', { className: 'iris-wb-progress' },
            React.createElement('div', { className: 'iris-wb-bar' },
              React.createElement('i', { style: { width: pct } })),
            React.createElement('div', { className: 'iris-wb-muted' }, pct + (task.elapsedMs ? ' · ' + fmtElapsed(task.elapsedMs) : ''))));
        } else {
          body.push(React.createElement('div', { className: 'iris-wb-muted' }, (pct || '运行中') + (task.elapsedMs ? ' · ' + fmtElapsed(task.elapsedMs) : '')));
        }
      } else {
        body.push(React.createElement('div', { className: 'iris-wb-muted' },
          task.createdAt ? '发起 ' + fmtTime(task.createdAt) : '',
          task.finishedAt ? ' · 完成 ' + fmtTime(task.finishedAt) : ''));
      }
      if (selected) body.push(React.createElement(TaskDetailDrawer, { key: 'drawer', taskId: task.id, revision: task.revision, onDeleted: function () { onSelect(null); } }));
      return React.createElement('div', {
        key: task.id,
        className: 'iris-wb-card' + (isRunning ? ' iris-running' : '') + (selected ? ' selected' : ''),
        onClick: function () { onSelect(selected ? null : task.id); },
        title: '点击展开任务详情'
      }, ...body);
    }

    /* ---- 供应商管理（阶段 6：增删 key + 模型列表 + 测试） ---- */
    function postAction(action, body) {
      return fetch('/iris/api/actions/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
    }

    /* ---- 模型池（阶段 9 P4）：发现/手动模型 + verified 标记 + 逐模型测试/移除 + 手动添加 ---- */
    var CAP_SHORT = { 'image-gen': '图', 'video-gen': '视', 'tts': '音', 'transcribe': '转', 'vision': '视👁' };
    function ModelPool(props) {
      var p = props.provider;
      var addPair = React.useState('');
      var newId = addPair[0];
      var setNewId = addPair[1];
      var models = p.models || [];
      function verBadge(m, c) {
        var health = m.health && m.health[c];
        var status = health && HEALTH_META[health.status] ? health.status : 'configured';
        var cls = 'iris-pm-ver ' + status;
        var title = healthText(health || { status: status });
        var symbol = status === 'verified' ? '✓' : (status === 'failed' ? '×' : (status === 'unconfigured' ? '○' : '?'));
        return React.createElement('button', {
          key: c,
          className: cls,
          title: title + '；点击单独验证此能力',
          onClick: function () { props.testModel(p, m, c); }
        }, c + symbol);
      }
      var rows = models.map(function (m) {
        var caps = m.capabilities || [];
        return React.createElement('div', { key: m.id, className: 'iris-pm-mrow' },
          React.createElement('span', { className: 'iris-pm-mname' }, m.id, m.source === 'manual' ? React.createElement('span', { className: 'iris-pm-mtag' }, '手动') : null),
          React.createElement('span', { className: 'iris-pm-mcaps' }, caps.map(function (c) { return verBadge(m, c); })),
          React.createElement('button', { className: 'iris-pm-btn danger', title: '从池移除', onClick: function () { props.removeModel(p, m); } }, '✕'));
      });
      return React.createElement('div', { className: 'iris-pm-pool' },
        React.createElement('div', { className: 'iris-pm-note' }, '模型池（' + models.length + '）：'),
        rows.length ? React.createElement('div', { className: 'iris-pm-mrows' }, rows) : React.createElement('div', { className: 'iris-pm-note' }, '暂无模型 — 点「发现模型」拉取，或下方手动添加'),
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('input', { className: 'iris-pm-madd', placeholder: '手动添加模型名，如 wan2.7-image', value: newId, onChange: function (e) { setNewId(e.target.value); } }),
          React.createElement('button', { className: 'iris-pm-btn', onClick: function () { props.addModel(p, newId.trim()); setNewId(''); } }, '+ 添加')));
    }

    function ProviderEndpointEditor(props) {
      var p = props.provider;
      var valuePair = React.useState(p.mediaBaseUrl || '');
      var value = valuePair[0];
      var setValue = valuePair[1];
      React.useEffect(function () { setValue(p.mediaBaseUrl || ''); }, [p.mediaBaseUrl]);
      function save() {
        postAction('providers_upsert', { id: p.id, mediaBaseUrl: value.trim() }).then(function (r) {
          props.onNote(r.ok ? '媒体 Base URL 已更新' : (r.d.error || '更新失败'));
          if (r.ok) props.onDone();
        });
      }
      return React.createElement('div', { className: 'iris-pm-field' },
        React.createElement('label', {}, '媒体 Base URL（可选）'),
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('input', { value: value, placeholder: '留空则沿用 Base URL', onChange: function (e) { setValue(e.target.value); } }),
          React.createElement('button', { className: 'iris-pm-btn', onClick: save }, '保存')),
        React.createElement('span', { className: 'iris-pm-note' }, '百炼 Workspace 可填 …maas.aliyuncs.com/compatible-mode/v1；视觉仍使用普通 Base URL。'));
    }

    function ProviderManager() {
      var listPair = React.useState(null);
      var list = listPair[0];
      var setList = listPair[1];
      var openPair = React.useState(null); // 展开的 provider id
      var setOpen = openPair[1];
      var addingPair = React.useState(false);
      var adding = addingPair[0];
      var setAdding = addingPair[1];
      var newForm = React.useState({ name: '', baseUrl: '', mediaBaseUrl: '', apiKey: '', type: 'openai', mediaProtocol: 'auto' });
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      function refresh() {
        postAction('providers_list', {}).then(function (r) { if (r.ok && r.d.providers) setList(r.d.providers); });
      }
      React.useEffect(function () { refresh(); }, []);
      function addProvider() {
        var f = newForm[0];
        if (!f.baseUrl || !f.apiKey) { setNote('baseUrl 和 apiKey 必填'); return; }
        postAction('providers_upsert', f).then(function (r) {
          if (r.ok) { setAdding(false); setNote('已添加 ' + f.name); refresh(); }
          else setNote(r.d.error || '添加失败');
        });
      }
      function toggle(p) {
        postAction('providers_upsert', { id: p.id, enabled: !p.enabled }).then(function (r) {
          if (r.ok) refresh();
          else setNote(r.d.error || '切换失败');
        });
      }
      function remove(p) {
        if (!window.confirm('删除供应商「' + (p.name || p.id) + '」？此操作不可撤销。')) return;
        postAction('providers_remove', { id: p.id }).then(function (r) { if (r.ok) refresh(); else setNote(r.d.error || '删除失败'); });
      }
      function testVision(p) {
        if (!window.confirm('视觉实测会向供应商发送一张内置测试图，可能产生费用。继续吗？')) return;
        setNote('测试「' + (p.name || p.id) + '」的视觉能力…');
        postAction('providers_test_vision', { id: p.id, confirm_paid: true }).then(function (r) { setNote(r.d.text || r.d.error || '测试完成'); refresh(); });
      }
      function discover(p) {
        setNote('正在发现「' + (p.name || p.id) + '」的模型…');
        postAction('providers_discover', { id: p.id }).then(function (r) { setNote(r.d.text || r.d.error || '发现完成'); refresh(); });
      }
      function testModel(p, m, capability) {
        var noProbe = capability === 'video-gen' || capability === 'transcribe';
        if (!noProbe && !window.confirm('将用模型「' + m.id + '」发起一次真实的 ' + capability + ' 请求，可能产生费用。继续吗？')) return;
        setNote('验证 ' + m.id + ' · ' + capability + '…');
        postAction('providers_test_model', { id: p.id, model_id: m.id, capability: capability, confirm_paid: !noProbe })
          .then(function (r) { setNote(r.d.text || r.d.error || ''); refresh(); });
      }
      function setProtocol(p, value) {
        postAction('providers_upsert', { id: p.id, mediaProtocol: value }).then(function (r) {
          setNote(r.ok ? '媒体协议已更新' : (r.d.error || '更新失败')); refresh();
        });
      }
      function removeModel(p, m) {
        if (!window.confirm('从池中移除模型「' + m.id + '」？')) return;
        postAction('providers_remove_model', { id: p.id, model_id: m.id }).then(function (r) { setNote(r.d.text || r.d.error || ''); refresh(); });
      }
      function addModel(p, modelId) {
        if (!modelId) { setNote('模型名不能为空'); return; }
        postAction('providers_add_model', { id: p.id, model_id: modelId }).then(function (r) { setNote(r.d.text || r.d.error || ''); refresh(); });
      }
      var cards = (list || []).map(function (p) {
        var open = openPair[0] === p.id;
        var body = null;
        if (open) {
          body = React.createElement('div', { className: 'iris-pm-body' },
            React.createElement('div', { className: 'iris-pm-note' }, 'Key ' + (p.apiKeyHint || '未配置') + ' · ' + (p.type || '') + ' · ' + (p.mediaProtocol || '')),
            p.protocolInferred ? React.createElement('div', { className: 'iris-pm-note' }, '协议为推断值，请确认') : null,
            React.createElement(ProviderEndpointEditor, { provider: p, onNote: setNote, onDone: refresh }),
            React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体协议'), React.createElement('select', { value: p.protocolInferred ? 'auto' : (p.mediaProtocol || 'auto'), onChange: function (e) { setProtocol(p, e.target.value); } },
              React.createElement('option', { value: 'auto' }, '自动'),
              p.mediaProtocol && !['dashscope', 'openai-images', 'auto'].includes(p.mediaProtocol) ? React.createElement('option', { value: p.mediaProtocol }, p.mediaProtocol + '（未支持）') : null,
              React.createElement('option', { value: 'dashscope' }, 'DashScope（仅阿里云官方 HTTPS）'),
              React.createElement('option', { value: 'openai-images' }, 'OpenAI Images 兼容'))),
            React.createElement('div', { className: 'iris-pm-note' }, '能力: ' + ((p.capabilities || []).join(' / ') || '无')),
            React.createElement(ModelPool, { provider: p, onNote: setNote, onDone: refresh, testModel: testModel, removeModel: removeModel, addModel: addModel }),
            React.createElement('div', { className: 'iris-wb-row' },
              React.createElement('button', { className: 'iris-pm-btn', onClick: function () { discover(p); } }, '发现模型'),
              React.createElement('button', { className: 'iris-pm-btn', onClick: function () { toggle(p); } }, p.enabled ? '停用' : '启用'),
              React.createElement('button', { className: 'iris-pm-btn danger', onClick: function () { remove(p); } }, '删除')));
        }
        return React.createElement('div', { key: p.id, className: 'iris-pm-card' + (open ? ' open' : '') },
          React.createElement('div', { className: 'iris-pm-top', onClick: function () { setOpen(open ? null : p.id); } },
            React.createElement('span', { className: 'iris-pm-name' }, (p.name || p.id) + (p.enabled ? '' : '（停用）')),
            React.createElement('span', { className: 'iris-pm-btn' }, open ? '收起' : '管理')),
          body);
      });
      var addBlock = null;
      if (adding) {
        addBlock = React.createElement('div', { className: 'iris-pm-card' },
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '名称'), React.createElement('input', { value: newForm[0].name, placeholder: '如 阿里云百炼', onChange: function (e) { newForm[1]({ ...newForm[0], name: e.target.value }); } })),
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, 'Base URL *'), React.createElement('input', { value: newForm[0].baseUrl, placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1', onChange: function (e) { newForm[1]({ ...newForm[0], baseUrl: e.target.value }); } })),
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体 Base URL（可选）'), React.createElement('input', { value: newForm[0].mediaBaseUrl, placeholder: 'Workspace 媒体端点；留空沿用 Base URL', onChange: function (e) { newForm[1]({ ...newForm[0], mediaBaseUrl: e.target.value }); } })),
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, 'API Key *'), React.createElement('input', { type: 'password', value: newForm[0].apiKey, placeholder: 'sk-...', onChange: function (e) { newForm[1]({ ...newForm[0], apiKey: e.target.value }); } })),
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体协议'), React.createElement('select', { value: newForm[0].mediaProtocol, onChange: function (e) { newForm[1]({ ...newForm[0], mediaProtocol: e.target.value }); } },
            React.createElement('option', { value: 'auto' }, '自动（按媒体 Base URL 安全判断）'),
            React.createElement('option', { value: 'dashscope' }, 'DashScope（阿里云官方）'),
            React.createElement('option', { value: 'openai-images' }, 'OpenAI Images 兼容'))),
          React.createElement('div', { className: 'iris-wb-row' },
            React.createElement('button', { className: 'iris-act-run', onClick: addProvider }, '保存'),
            React.createElement('button', { className: 'iris-pm-btn', onClick: function () { setAdding(false); } }, '取消')));
      }
      return React.createElement('div', { className: 'iris-pm' },
        React.createElement('div', { className: 'iris-pm-head' },
          React.createElement('span', { className: 'iris-wb-muted' }, (list ? list.length : 0) + ' 个供应商'),
          React.createElement('button', { className: 'iris-pm-add', onClick: function () { setAdding(!adding); } }, adding ? '收起' : '+ 添加供应商')),
        addBlock,
        cards.length ? cards : React.createElement('div', { className: 'iris-wb-empty' }, '暂无供应商 — 点右上角「+ 添加供应商」'),
        note ? React.createElement('div', { className: 'iris-pm-act' }, note) : null);
    }

    /* ---- 文件字段（阶段 10）：让用户"看见并选文件"，统一产出一个宿主路径 ---- */
    function FileField(props) {
      var value = props.value || '';
      var onChange = props.onChange;
      var accept = props.accept || '';
      var menuPair = React.useState(null); // null | 'att'
      var menu = menuPair[0];
      var setMenu = menuPair[1];
      var attPair = React.useState(null); // 附件列表
      var atts = attPair[0];
      var setAtts = attPair[1];
      var busyPair = React.useState('');
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      /* 上传优先：宿主路径是逃生口，默认收起，点「⌨️ 高级 · 宿主路径」才展开
         （旧写法以 !value 作初值，会让空字段默认就摊出高级输入框，与上传优先相反） */
      var manualPair = React.useState(false);
      var manual = manualPair[0];
      var setManual = manualPair[1];
      var fileInput = React.useRef(null);

      function onPickFile(e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        setBusy('上传中…');
        fetch('/iris/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d.ok) { onChange(d.path); setBusy(''); } else { setBusy('上传失败：' + (d.error || '')); } })
          .catch(function () { setBusy('上传失败：网络'); });
        e.target.value = '';
      }
      function openAttachments() {
        if (menu === 'att') { setMenu(null); return; }
        setMenu('att');
        if (!atts) {
          setBusy('加载附件…');
          postAction('attachments_list', { session_id: sessionId() }).then(function (r) {
            setAtts((r.ok && r.d.attachments) || []); setBusy('');
          });
        }
      }
      function pickAttachment(a) {
        setBusy('导出中…'); setMenu(null);
        postAction('attachment_export', { session_id: sessionId(), attachment_id: a.attachmentId }).then(function (r) {
          if (r.ok && r.d.path) { onChange(r.d.path); setBusy(''); }
          else setBusy('导出失败：' + ((r.d && r.d.error) || ''));
        });
      }
      var label = value ? (value.split('/').pop() || value) : '未选择文件';
      return React.createElement('div', { className: 'iris-ff' },
        React.createElement('div', { className: 'iris-ff-bar' },
          React.createElement('button', { className: 'iris-ff-btn primary', title: '从本机选文件，上传一份副本到宿主（跨设备 / WSL / 安卓都可用）', onClick: function () { fileInput.current && fileInput.current.click(); } }, '💻 上传文件'),
          React.createElement('button', { className: 'iris-ff-btn', title: '选本会话已有的附件：聊天里粘贴/上传的 🖼，或 🫧 iris 生成过的', onClick: openAttachments }, '📎 会话附件'),
          React.createElement('button', { className: 'iris-ff-btn ghost', title: '高级：直接引用 DSH 宿主机器上的文件路径', onClick: function () { setManual(!manual); } }, '⌨️ 高级 · 宿主路径'),
          React.createElement('input', { ref: fileInput, type: 'file', accept: accept, style: { display: 'none' }, onChange: onPickFile })),
        React.createElement('div', { className: 'iris-ff-val' + (value ? ' set' : ''), title: value || '' }, (value ? '✓ ' : '○ ') + label + (busy ? ' · ' + busy : '')),
        value ? null : React.createElement('div', { className: 'iris-ff-hint' }, '浏览器与 DSH 不在同一台机器（远程 / WSL / 安卓）时，宿主上没有你本机的文件——请用「💻 上传文件」或「📎 会话附件」。'),
        manual ? React.createElement('input', { className: 'iris-pm-madd', placeholder: '高级：粘贴 DSH 宿主上的绝对路径，如 /home/user/pic.png', value: value, onChange: function (e) { onChange(e.target.value); } }) : null,
        menu === 'att' ? React.createElement('div', { className: 'iris-ff-list' },
          (atts && atts.length) ? atts.map(function (a) {
            return React.createElement('div', { key: a.attachmentId, className: 'iris-ff-item', onClick: function () { pickAttachment(a); } },
              React.createElement('span', { className: 'iris-ff-src' }, a.source === 'iris' ? '🫧' : '🖼'),
              React.createElement('span', {}, a.name || a.attachmentId.slice(0, 18)));
          }) : React.createElement('div', { className: 'iris-wb-empty' }, '无可选附件（会话无图或 iris 未生成过）')) : null);
    }

    /* ---- 操作卡片组（阶段 5 GUI 直连：POST /iris/api/actions/:name） ---- */
    function ActionCard(props) {
      var title = props.title;
      var action = props.action;
      var capability = props.capability; // 可选：该卡片对应能力（如 'image-gen'），用于模型选择/亮暗
      var fields = props.fields || [];
      var openPair = React.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var valsPair = React.useState({});
      var vals = valsPair[0];
      var setVals = valsPair[1];
      var runPair = React.useState(null);
      var run = runPair[0];
      var setRun = runPair[1];
      var modelPair = React.useState(null); // { assigned, options:[{id,providerId}], tested }
      var modelInfo = modelPair[0];
      var setModelInfo = modelPair[1];
      var irisState = useIrisState(5000);
      function setVal(key, value) { var nv = {}; Object.keys(vals).forEach(function (k) { nv[k] = vals[k]; }); nv[key] = value; setVals(nv); }
      function loadModels() {
        if (!capability) return;
        postAction('assignments_get', {}).then(function (r) {
          if (!r.ok || !r.d) return;
          var opts = (r.d.poolByCapability && r.d.poolByCapability[capability]) || [];
          var ord = (r.d.order && r.d.order[capability]) || [];
          var assignedRef = ord[0] || (opts[0] && opts[0].ref) || '';
          var assignedOpt = opts.find(function (o) { return o.ref === assignedRef; });
          // 不再自动填 vals.model：留空 = 用能力分配的解析结果（避免绕过分配）
          setModelInfo({ assigned: assignedOpt ? assignedOpt.label : '', assignedRef: assignedRef, options: opts, loaded: true });
        });
      }
      React.useEffect(function () { if (open && capability) loadModels(); }, [open]);
      function submit() {
        if (run === 'running') return;
        setRun('running');
        fetch('/iris/api/actions/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vals)
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            setRun(res.ok ? { ok: true, text: res.d.text || '', img: res.d.imageUrl || res.d.imageDataUrl || null } : { ok: false, text: res.d.error || '执行失败' });
            if (res.ok && res.d && res.d.storage === 'core') window.dispatchEvent(new CustomEvent('iris-core-artifacts-changed'));
          })
          .catch(function () { setRun({ ok: false, text: '网络错误' }); });
      }
      var cardHealth = capability ? capabilityHealth(irisState, capability) : { status: 'verified' };
      var body = null;
      if (open) {
        var inputs = fields.map(function (f) {
          var node;
          if (f.type === 'file') {
            node = React.createElement(FileField, { value: vals[f.key] || '', accept: f.accept || '', onChange: function (v) { setVal(f.key, v); } });
            return React.createElement('div', { key: f.key, className: 'iris-act-field' },
              React.createElement('label', {}, f.label), node);
          }
          if (f.type === 'textarea') {
            node = React.createElement('textarea', {
              value: vals[f.key] || '', placeholder: f.placeholder || '',
              onChange: function (e) { setVal(f.key, e.target.value); }
            });
          } else if (f.type === 'checkbox') {
            node = React.createElement('input', { type: 'checkbox', checked: !!vals[f.key], onChange: function (e) { setVal(f.key, e.target.checked); } });
          } else {
            node = React.createElement('input', {
              value: vals[f.key] || '', placeholder: f.placeholder || '', type: f.type || 'text',
              onChange: function (e) { setVal(f.key, e.target.value); }
            });
          }
          return React.createElement('div', { key: f.key, className: 'iris-act-field' },
            React.createElement('label', {}, f.label), node);
        });
        var result = null;
        if (run) {
          if (run.ok && run.img) {
            result = React.createElement('div', { className: 'iris-act-result' },
              React.createElement('div', {}, run.text),
              React.createElement('img', { className: 'iris-act-img', src: run.img, alt: '结果' }));
          } else {
            result = React.createElement('div', { className: 'iris-act-result' + (run.ok ? '' : ' err') }, run.text);
          }
        }
        // 只读模型提示：当前能力解析到的模型与持久健康事实。
        var modelBar = null;
        if (capability) {
          var available = modelInfo && modelInfo.loaded && modelInfo.options.length > 0;
          var shown = (vals.model && vals.model.trim()) || (modelInfo && modelInfo.assigned) || '';
          modelBar = React.createElement('div', { className: 'iris-act-field' },
            React.createElement('label', {},
              React.createElement('span', { className: 'iris-pm-dot ' + cardHealth.status }, HEALTH_META[cardHealth.status].symbol),
              ' 模型：' + (shown || '自动') + (available ? '' : '（无可用模型）')),
            React.createElement('div', { className: 'iris-wb-muted' },
              healthText(cardHealth) + ' · 改分配 → 上方「能力分配（failover 顺序）」'));
        }
        body = React.createElement('div', { className: 'iris-act-body' },
          modelBar,
          inputs,
          React.createElement('button', { className: 'iris-act-run', disabled: run === 'running', onClick: submit },
            run === 'running' ? '执行中…' : '执行'),
          result);
      }
      var headStatus = capability ? cardHealth.status : 'verified';
      var headTitle = capability ? healthText(cardHealth) : '本地功能';
      return React.createElement('div', {
        className: 'iris-act-card' + (open ? ' open' : '') + (capability ? ' health-' + headStatus : '')
      },
        React.createElement('div', { className: 'iris-act-head', onClick: function () { setOpen(!open); } },
          React.createElement('span', { className: 'iris-act-title' }, title),
          capability ? React.createElement('span', {
            className: 'iris-pm-dot ' + headStatus,
            title: headTitle
          }, HEALTH_META[headStatus].symbol) : null,
          React.createElement('span', { className: 'iris-act-arrow' }, '▶')),
        body);
    }

    /* ---- 操作卡片注册表（单一来源：设置页全量 / 泡泡常用子集 / 选择器三处共用） ---- */
    var CARD_DEFS = [
      { action: 'image', title: '🎨 画图', capability: 'image-gen', fields: [
        { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '详细描述要生成的图片' },
        { key: 'size', label: '尺寸 (可选)', placeholder: '如 1024*1024' },
        { key: 'model', label: '模型 (可选)', placeholder: '默认 provider 模型' }] },
      { action: 'video', title: '🎬 视频', capability: 'video-gen', fields: [
        { key: 'prompt', label: '提示词', type: 'textarea', placeholder: '描述画面/运动' },
        { key: 'first_frame_path', label: '首帧图片', type: 'file', accept: 'image/*', placeholder: '/path/frame.png' },
        { key: 'size', label: '尺寸 (可选)', placeholder: '如 1280*720' },
        { key: 'model', label: '模型 (可选)', placeholder: '如 wan2.2-t2v-flash' }] },
      { action: 'tts', title: '🔊 语音合成', capability: 'tts', fields: [
        { key: 'text', label: '文本', type: 'textarea', placeholder: '要合成的文字' },
        { key: 'voice', label: '音色 (可选)', placeholder: '如 Cherry' }] },
      { action: 'transcribe', title: '🎙️ 音频转写', capability: 'transcribe', fields: [
        { key: 'audio_path', label: '音频文件', type: 'file', accept: 'audio/*', placeholder: '/path/audio.wav' }] },
      { action: 'video_frames', title: '🎞️ 视频抽帧', fields: [
        { key: 'video_path', label: '视频文件', type: 'file', accept: 'video/*', placeholder: '/path/video.mp4' },
        { key: 'max_frames', label: '最多帧数 (可选)', placeholder: '8（1-20）' },
        { key: 'target_width', label: '目标宽度 (可选)', placeholder: '640' },
        { key: 'format', label: '格式 (可选)', placeholder: 'jpeg 或 png' }] },
      { action: 'media_summarize', title: '📝 视频摘要', capability: 'vision', fields: [
        { key: 'video_path', label: '视频文件', type: 'file', accept: 'video/*', placeholder: '/path/video.mp4' },
        { key: 'question', label: '问题 (可选)', type: 'textarea', placeholder: '默认：总结画面内容/场景/主题' },
        { key: 'max_frames', label: '采样帧数 (可选)', placeholder: '8（1-12）' },
        { key: 'transcribe_text', label: '已有转写文本 (可选)', type: 'textarea', placeholder: '若已转写音轨可粘贴，摘要将结合语音内容' }] },
      { action: 'look', title: '👁 看图', capability: 'vision', fields: [
        { key: 'image_path', label: '图片', type: 'file', accept: 'image/*', placeholder: '/path/image.png' },
        { key: 'question', label: '问题 (可选)', placeholder: '默认：详细描述' }] },
      { action: 'crop', title: '✂️ 裁剪', fields: [
        { key: 'image_path', label: '图片', type: 'file', accept: 'image/*', placeholder: '/path/image.png' },
        { key: 'left', label: 'left', placeholder: '0' },
        { key: 'top', label: 'top', placeholder: '0' },
        { key: 'width', label: 'width', placeholder: '100' },
        { key: 'height', label: 'height', placeholder: '100' }] },
      { action: 'diff', title: '📷 像素差异', fields: [
        { key: 'image_a_path', label: '图 A', type: 'file', accept: 'image/*', placeholder: '/path/a.png' },
        { key: 'image_b_path', label: '图 B', type: 'file', accept: 'image/*', placeholder: '/path/b.png' }] },
      { action: 'locate', title: '📍 定位', capability: 'vision', fields: [
        { key: 'image_path', label: '图片', type: 'file', accept: 'image/*', placeholder: '/path/image.png' },
        { key: 'target', label: '目标', placeholder: '如 红色按钮' },
        { key: 'model', label: '模型 (可选)', placeholder: '如 qwen3-vl-235b-a22b-thinking' }] },
      { action: 'html', title: '🖼️ HTML 截图', fields: [
        { key: 'html', label: 'HTML', type: 'textarea', placeholder: '<h1>Hello</h1>' },
        { key: 'fullPage', label: '整页截图', type: 'checkbox' }] },
      { action: 'ocr', title: '📄 长截图 OCR', capability: 'vision', fields: [
        { key: 'image_path', label: '长截图', type: 'file', accept: 'image/*', placeholder: '/path/long.png' },
        { key: 'chunk_height', label: '分块高度 (可选)', placeholder: '1200' },
        { key: 'overlap', label: '重叠 (可选)', placeholder: '120' }] },
      { action: 'relook', title: '🔄 重看 (附件)', capability: 'vision', fields: [
        { key: 'attachment_id', label: 'attachment id (iris 画图产物)', placeholder: 'sha256:...' },
        { key: 'question', label: '问题', placeholder: '再问一次这张图' }] },
      { action: 'status', title: '📋 任务查询', fields: [
        { key: 'task_id', label: 'task id (留空查最近)', placeholder: 't_xxx 或留空' }] }
    ];
    function renderCard(def) {
      return React.createElement(ActionCard, { key: def.action, title: def.title, action: def.action, capability: def.capability, fields: def.fields });
    }
    function ActionGroups() {
      return React.createElement('div', { className: 'iris-act-group' }, CARD_DEFS.map(renderCard));
    }

    /* ---- 能力分配（阶段 6 条目 4）：每能力一个有序 failover 列表 ---- */
    var CAP_ROWS = [
      { cap: 'image-gen', label: '🎨 画图' },
      { cap: 'video-gen', label: '🎬 视频' },
      { cap: 'tts', label: '🔊 语音' },
      { cap: 'transcribe', label: '🎙️ 转写' },
      { cap: 'vision', label: '👁 视觉' }
    ];
    function CapabilityAssigner() {
      var dataPair = React.useState(null);
      var data = dataPair[0];
      var setData = dataPair[1];
      function load() {
        postAction('assignments_get', {}).then(function (r) {
          if (r.ok && r.d) setData(r.d);
        });
      }
      React.useEffect(function () { load(); }, []);
      function save(cap, refs) {
        postAction('assignments_set', { capability: cap, model_refs: refs }).then(function () {
          load(); // 成败都重载：成功显示新序，失败显示实际落盘序（不骗 UI）
        });
      }
      if (!data) return React.createElement('div', { className: 'iris-wb-muted' }, '加载能力分配…');
      var order = data.order || {};
      var poolBy = data.poolByCapability || {};
      return React.createElement('div', { className: 'iris-cap-grid' }, CAP_ROWS.map(function (row) {
        var list = order[row.cap] || [];
        var opts = poolBy[row.cap] || [];
        var available = opts.filter(function (o) { return list.indexOf(o.ref) < 0; });
        var chips = list.map(function (ref, i) {
          var opt = opts.find(function (o) { return o.ref === ref; });
          return React.createElement('span', { key: ref, className: 'iris-cap-chip' },
            React.createElement('b', {}, (i + 1) + '.'),
            opt ? opt.label : ref,
            i > 0 ? React.createElement('button', {
              className: 'iris-pm-btn', title: '上移',
              onClick: function () { var n = list.slice(); var t = n.splice(i, 1)[0]; n.splice(i - 1, 0, t); save(row.cap, n); }
            }, '↑') : null,
            i < list.length - 1 ? React.createElement('button', {
              className: 'iris-pm-btn', title: '下移',
              onClick: function () { var n = list.slice(); var t = n.splice(i, 1)[0]; n.splice(i + 1, 0, t); save(row.cap, n); }
            }, '↓') : null,
            React.createElement('button', {
              className: 'iris-pm-btn danger', title: '移出列表',
              onClick: function () { save(row.cap, list.filter(function (x) { return x !== ref; })); }
            }, '✕'));
        });
        return React.createElement('div', { key: row.cap, className: 'iris-cap-row' },
          React.createElement('span', { className: 'iris-cap-name' }, row.label),
          chips.length ? chips : React.createElement('span', { className: 'iris-cap-auto' }, '自动（按池顺序）'),
          available.length ? React.createElement('select', {
            className: 'iris-pm-model-sel', value: '',
            onChange: function (e) { if (e.target.value) save(row.cap, list.concat([e.target.value])); }
          },
            React.createElement('option', { value: '' }, '+ 加入 failover'),
            available.map(function (o) { return React.createElement('option', { key: o.ref, value: o.ref }, o.label); })) : null,
          list.length ? React.createElement('button', {
            className: 'iris-pm-btn', title: '清除手动分配，回退自动',
            onClick: function () { save(row.cap, []); }
          }, '恢复自动') : null);
      }));
    }

    /* ---- 泡泡常用卡片选择（localStorage + 跨座位响应） ---- */
    var BUBBLE_CARDS_KEY = 'iris-bubble-cards';
    var bubbleCardListeners = new Set();
    function readBubbleCards() {
      try {
        var raw = localStorage.getItem(BUBBLE_CARDS_KEY);
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(function (a) { return CARD_DEFS.some(function (d) { return d.action === a; }); }) : [];
      } catch (_) { return []; }
    }
    function writeBubbleCards(list) {
      try { localStorage.setItem(BUBBLE_CARDS_KEY, JSON.stringify(list)); } catch (_) {}
      bubbleCardListeners.forEach(function (fn) { fn(list); });
    }
    function useBubbleCards() {
      var pair = React.useState(readBubbleCards);
      var list = pair[0];
      var setList = pair[1];
      React.useEffect(function () {
        function onExt(e) { if (e && e.key === BUBBLE_CARDS_KEY) setList(readBubbleCards()); }
        bubbleCardListeners.add(setList);
        window.addEventListener('storage', onExt); // 跨标签页同步
        return function () { bubbleCardListeners.delete(setList); window.removeEventListener('storage', onExt); };
      }, []);
      return [list, writeBubbleCards];
    }

    /* ---- 历史浏览器（设置页：按今天/昨天/更早分组折叠） ---- */
    function HistoryBrowser(props) {
      var recent = props.recent || [];
      var coreHistory = props.coreHistory || [];
      var selected = props.selected;
      var onSelect = props.onSelect;
      var collapsedPair = React.useState({});
      var collapsed = collapsedPair[0];
      var setCollapsed = collapsedPair[1];
      if (!recent.length && !coreHistory.length) return React.createElement('div', { className: 'iris-wb-empty' }, '尚无任务记录');
      var buckets = { 今天: [], 昨天: [], 更早: [] };
      recent.forEach(function (t) { buckets[dayBucket(t.createdAt)].push({ legacy: t }); });
      coreHistory.forEach(function (row) { buckets[dayBucket(row.updatedAt)].push({ core: row }); });
      var order = ['今天', '昨天', '更早'];
      return React.createElement('div', {}, order.map(function (name) {
        var rows = buckets[name];
        if (!rows.length) return null;
        var isCollapsed = !!collapsed[name];
        return React.createElement('div', { key: name, className: 'iris-hist-group' },
          React.createElement('div', {
            className: 'iris-hist-head',
            onClick: function () { var n = {}; Object.keys(collapsed).forEach(function (k) { n[k] = collapsed[k]; }); n[name] = !isCollapsed; setCollapsed(n); }
          }, React.createElement('span', {}, isCollapsed ? '▶' : '▼'), name + ' · ' + rows.length),
          isCollapsed ? null : React.createElement('div', { className: 'iris-wb-box' },
            rows.map(function (entry) {
              return entry.core
                ? coreTaskCard(entry.core)
                : taskRow(entry.legacy, false, selected === entry.legacy.id, onSelect);
            })));
      }));
    }

    function fmtBytes(bytes) {
      var value = Number(bytes || 0);
      if (value < 1024) return value + 'B';
      if (value < 1048576) return (value / 1024).toFixed(0) + 'KB';
      return (value / 1048576).toFixed(1) + 'MB';
    }

    function artifactIcon(item) {
      var mime = String(item && item.mime || '');
      if (mime.indexOf('image/') === 0) return '🖼';
      if (mime.indexOf('video/') === 0) return '🎬';
      if (mime.indexOf('audio/') === 0) return '🔊';
      return '📄';
    }

    function artifactRowMini(item) {
      return React.createElement('a', { key: item.id, className: 'iris-artifact-mini', href: item.url, target: '_blank', rel: 'noreferrer', title: '打开作品' },
        React.createElement('span', {}, artifactIcon(item)),
        React.createElement('span', {}, item.file),
        React.createElement('span', { className: 'iris-gallery-meta' }, fmtBytes(item.size)));
    }

    function artifactPreview(item) {
      var mime = String(item.mime || '');
      if (mime.indexOf('image/') === 0) {
        return React.createElement('a', { className: 'iris-gallery-preview', href: item.url, target: '_blank', rel: 'noreferrer', title: '打开原图' },
          React.createElement('img', {
            src: item.url, alt: 'Iris 作品 ' + item.file, loading: 'lazy',
            // 媒体文件丢失（404/损坏）时局部降级为占位提示，作品区其余项不受影响
            onError: function (event) {
              var img = event && event.target;
              var box = img && img.parentNode;
              if (!box || box.querySelector('span')) return;
              img.style.display = 'none';
              var note = document.createElement('span');
              note.className = 'iris-gallery-meta';
              note.textContent = '作品文件暂时不可用';
              box.appendChild(note);
            }
          }));
      }
      if (mime.indexOf('video/') === 0) {
        return React.createElement('div', { className: 'iris-gallery-preview' },
          React.createElement('video', { src: item.url, controls: true, playsInline: true, preload: 'metadata' }));
      }
      if (mime.indexOf('audio/') === 0) {
        return React.createElement('div', { className: 'iris-gallery-preview' },
          React.createElement('audio', { src: item.url, controls: true, preload: 'metadata' }));
      }
      return React.createElement('a', { className: 'iris-gallery-preview iris-wb-link', href: item.url, target: '_blank', rel: 'noreferrer' }, '打开文件');
    }

    function coreGalleryItems(data, limit) {
      return (((data && data.artifacts && data.artifacts.recent) || []).filter(function (artifact) {
        return artifact.kind !== 'host-input' && String(artifact.mediaType || '').indexOf('image/') === 0;
      }).map(function (artifact) {
        return {
          id: artifact.id, file: artifact.id, mime: artifact.mediaType,
          size: artifact.size, createdAt: artifact.createdAt || '', source: 'core',
          kind: artifact.kind,
          digest: artifact.digest && artifact.digest.value ? artifact.digest.value.slice(0, 12) : '',
          url: '/iris/api/core/artifact/' + encodeURIComponent(artifact.id) + '/media'
        };
      })).slice(0, limit || 200);
    }

    function useCoreWorks(limit) {
      var pair = React.useState([]);
      var setItems = pair[1];
      React.useEffect(function () {
        var alive = true;
        function load() {
          fetch('/iris/api/core/snapshot?limit=' + Math.max(1, Math.min(200, Number(limit) || 6)))
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { if (alive && data) setItems(coreGalleryItems(data, limit)); })
            .catch(function () { /* Core 不可用不影响旧作品 */ });
        }
        function changed() { load(); }
        load();
        window.addEventListener('iris-core-artifacts-changed', changed);
        window.addEventListener('iris-core-refresh-tick', changed);
        return function () {
          alive = false;
          window.removeEventListener('iris-core-artifacts-changed', changed);
          window.removeEventListener('iris-core-refresh-tick', changed);
        };
      }, [limit]);
      return pair[0];
    }

    function ArtifactGallery(props) {
      var itemsPair = React.useState([]);
      var items = itemsPair[0];
      var setItems = itemsPair[1];
      var totalPair = React.useState(Number(props.total || 0));
      var total = totalPair[0];
      var setTotal = totalPair[1];
      var corePair = React.useState([]);
      var coreItems = corePair[0];
      var setCoreItems = corePair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];

      function load(append) {
        if (busy) return;
        setBusy(true);
        var offset = append ? items.length : 0;
        var legacyRequest = fetch('/iris/api/artifacts?offset=' + offset + '&limit=24')
          .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('旧版作品读取失败')); });
        var coreRequest = append ? Promise.resolve(null) : fetch('/iris/api/core/snapshot?limit=200')
          .then(function (res) {
            if (res.status === 404) return { available: false, backendReloadRequired: true, artifacts: { recent: [] } };
            return res.ok ? res.json() : Promise.reject(new Error('Core 作品读取失败（HTTP ' + res.status + '）'));
          }).catch(function (error) { return { available: false, error: error.message, artifacts: { recent: [] } }; });
        Promise.all([legacyRequest, coreRequest])
          .then(function (values) {
            var data = values[0];
            var core = values[1];
            setItems(append ? items.concat(data.items || []) : (data.items || []));
            setTotal(Number(data.total || 0));
            if (core) {
              var nextCore = coreGalleryItems(core, 200);
              setCoreItems(nextCore);
              if (core.error) setNote(core.error);
              else if (core.backendReloadRequired) setNote('DSH 后端尚未加载 Core 路由；重启后新作品会出现在这里。');
            }
          })
          .catch(function (error) { setNote('作品库读取失败：' + error.message); })
          .finally(function () { setBusy(false); });
      }

      function run(action, body, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return;
        setBusy(true);
        postAction(action, body || {}).then(function (result) {
          var succeeded = result.ok && result.d && result.d.ok !== false;
          setNote(succeeded ? (result.d.text || '完成') : ('失败：' + ((result.d && (result.d.error || result.d.text)) || '未知错误')));
          if (succeeded) load(false);
          else setBusy(false);
        }).catch(function (error) { setBusy(false); setNote('失败：' + error.message); });
      }

      React.useEffect(function () {
        function changed() { load(false); }
        window.addEventListener('iris-core-artifacts-changed', changed);
        window.addEventListener('iris-core-refresh-tick', changed);
        load(false);
        return function () {
          window.removeEventListener('iris-core-artifacts-changed', changed);
          window.removeEventListener('iris-core-refresh-tick', changed);
        };
      }, [props.total]);
      var galleryItems = coreItems.concat(items).sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
      var combinedTotal = coreItems.length + total;

      return React.createElement('div', {},
        React.createElement('div', { className: 'iris-gallery-tools' },
          React.createElement('span', { className: 'iris-clean-note' },
            '共 ' + combinedTotal + ' 个作品 · Core ' + coreItems.length + ' · 旧版 ' + total + ' · 清任务历史不会删除'),
          React.createElement('button', { className: 'iris-clean-btn', disabled: busy, onClick: function () { load(false); } }, '刷新'),
          React.createElement('button', { className: 'iris-clean-btn', disabled: busy, onClick: function () { run('artifacts_reindex'); } }, '扫描旧版 outputs'),
          total ? React.createElement('button', { className: 'iris-clean-btn danger', disabled: busy, onClick: function () { run('artifacts_clear', {}, '永久删除旧版 outputs 作品？Core 作品不会删除；任务历史会保留。此操作不可逆。'); } }, '清空旧版作品') : null),
        galleryItems.length ? React.createElement('div', { className: 'iris-gallery-grid' }, galleryItems.map(function (item) {
          var isCore = item.source === 'core';
          return React.createElement('div', { key: (isCore ? 'core-' : 'legacy-') + item.id, className: 'iris-gallery-card' },
            artifactPreview(item),
            React.createElement('div', { className: 'iris-gallery-info' },
              React.createElement('div', { className: 'iris-gallery-file', title: item.file }, item.file),
              React.createElement('div', { className: 'iris-gallery-meta' },
                (isCore ? 'Core · ' + (item.kind || 'artifact') + (item.digest ? ' · sha256 ' + item.digest : '') : fmtTime(item.createdAt)) + ' · ' + fmtBytes(item.size)),
              React.createElement('div', { className: 'iris-gallery-actions' },
                React.createElement('a', { className: 'iris-wb-link', href: item.url, target: '_blank', rel: 'noreferrer' }, '打开'),
                isCore ? React.createElement('span', { className: 'iris-wb-muted' }, '内容哈希保护')
                  : React.createElement('button', { className: 'iris-pm-btn danger', disabled: busy, onClick: function () { run('artifacts_delete', { artifact_id: item.id }, '永久删除作品“' + item.file + '”？任务历史会保留，但媒体将无法打开。'); } }, '删除'))));
        })) : React.createElement('div', { className: 'iris-wb-empty' }, busy ? '正在读取作品…' : '尚无作品；旧 outputs 文件可点“扫描旧版 outputs”找回。'),
        items.length < total ? React.createElement('button', { className: 'iris-clean-btn', disabled: busy, onClick: function () { load(true); } }, busy ? '加载中…' : '加载更多旧版作品') : null,
        note ? React.createElement('div', { className: 'iris-clean-note', style: { marginTop: '7px' } }, note) : null);
    }

    function coreCapabilityLabel(value) {
      return ({ image: '图片生成', video: '视频生成', tts: '语音合成', transcribe: '音频转写' })[value] || String(value || '媒体任务');
    }

    /* 高级诊断与用户任务区共用五类用户状态投影；与服务端 lib/core-user-projection.js 保持同一映射，
       文案必须区分“远端可能还在运行”和“已经明确失败”。 */
    function coreTaskState(task) {
      if (task.outcome === 'succeeded' && task.deliveryState === 'ready') return { tone: 'ok', state: 'succeeded', label: '已完成，作品可用' };
      if (task.outcome === 'succeeded' && task.deliveryState === 'failed') return { tone: 'error', state: 'delivery_failed', label: '已生成，作品取回失败' };
      if (task.outcome === 'succeeded') return { tone: 'warn', state: 'running', label: '已生成，正在保存作品' };
      if (task.outcome === 'failed') return { tone: 'error', state: 'attention', label: '已失败' };
      if (task.outcome === 'canceled') return { tone: 'idle', state: 'attention', label: '已取消' };
      if (task.outcome === 'unknown') return { tone: 'warn', state: 'attention', label: '任务结果未知，需要检查' };
      if (task.acceptance === 'unknown') return { tone: 'warn', state: 'attention', label: '提交结果未知，请检查后处理' };
      if (task.deliveryState === 'failed') return { tone: 'error', state: 'attention', label: '结果状态异常，需要检查' };
      if (task.watchState === 'suspended' || task.watchState === 'exhausted') return { tone: 'warn', state: 'observation_paused', label: '观察已暂停，远端可能仍在运行' };
      return { tone: 'idle', state: 'running', label: '运行中' };
    }

    function coreAttemptState(attempt) {
      if (attempt.resultKind === 'completed') return '已完成';
      if (attempt.acceptance === 'not_accepted') return '未受理';
      if (attempt.acceptance === 'unknown') return '是否受理未知';
      if (attempt.acceptance === 'accepted') return '已受理';
      return '正在提交';
    }

    function coreModelLabel(value) {
      var model = String(value || '');
      var separator = model.indexOf('::');
      return separator >= 0 ? model.slice(separator + 2) : (model || '未记录');
    }

    /* 诊断层允许更多事实：取消三态如实区分，不把"已请求/无法确认"显示成"已取消"。 */
    function coreCancelLabel(value) {
      if (value === 'remote_confirmed') return '供应商已明确确认取消';
      if (value === 'local_confirmed') return '本地已确认取消（远端未确认）';
      if (value === 'requested') return '取消请求进行中';
      if (value === 'unknown') return '已请求取消，远端结果未确认；可显式重新观察';
      return '无取消请求';
    }

    /* ---- Core 用户侧只读投影：任务区消费 /iris/api/core/snapshot 的 userTasks 安全 DTO ---- */
    var EMPTY_CORE_USER = Object.freeze({ rows: [], available: false, degraded: false, droppedTasks: 0 });

    function useCoreUserTasks() {
      var pair = React.useState(EMPTY_CORE_USER);
      var setData = pair[1];
      React.useEffect(function () {
        var alive = true;
        function load() {
          fetch('/iris/api/core/snapshot?limit=200')
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
              if (!alive || !data || !Array.isArray(data.userTasks)) return;
              setData({
                rows: data.userTasks,
                available: !!data.available,
                degraded: !!data.degraded,
                droppedTasks: Number(data.droppedTasks || 0)
              });
            })
            .catch(function () { /* Core 不可用不阻塞 legacy 任务区 */ });
        }
        function changed() { load(); }
        load();
        window.addEventListener('iris-core-artifacts-changed', changed);
        window.addEventListener('iris-core-refresh-tick', changed);
        return function () {
          alive = false;
          window.removeEventListener('iris-core-artifacts-changed', changed);
          window.removeEventListener('iris-core-refresh-tick', changed);
        };
      }, []);
      return pair[0];
    }

    /* 五类用户状态 → 既有 badge 色调；不新增第三套卡片样式，复用 iris-wb/iris-task-mini。 */
    function coreUserStateClass(state) {
      if (state === 'succeeded') return 'ok';
      if (state === 'delivery_failed' || state === 'attention') return 'err';
      if (state === 'observation_paused') return 'warn';
      return '';
    }

    function coreTaskBadge(row) {
      var tone = row.historical === true ? '' : coreUserStateClass(row.userState);
      return React.createElement('span', { className: 'iris-wb-badge' + (tone ? ' ' + tone : '') }, row.label);
    }

    /* 完成提示只出现一次：会话内 Map 记录 core:id@revision，刷新页面后从事实重新计算基线。 */
    var coreCompletionSeen = null; // null = 尚未建立基线（首屏把既有完成项记为已见）
    function coreRowKey(row) { return 'core:' + row.id + '@' + Number(row.revision || 0); }
    function noteCoreCompletions(rows) {
      var current = {};
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].userState === 'succeeded') current[coreRowKey(rows[i])] = true;
      }
      if (coreCompletionSeen === null) { coreCompletionSeen = current; return []; }
      var added = [];
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        if (row.userState === 'succeeded' && !coreCompletionSeen[coreRowKey(row)]) added.push(row);
      }
      for (var key in current) coreCompletionSeen[key] = true;
      return added;
    }

    /* D1/D2 人工动作按钮：投影门满足才出现；每次点击只调用一次显式单步 API，绝不
       重新提交、也不间接重新生成；点击期间按钮禁用防重复，完成后复用
       iris-core-refresh-tick 让任务区/高级诊断重拉同一快照。服务端 Command 门仍
       是最终裁决（binding/能力校验失败返回稳定错误，行内提示，不改任务事实）。 */
    function CoreTaskManualButton(props) {
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      function act() {
        if (busy) return; // 防重复触发：请求未结束前后端各拦一层
        var body = props.buildBody ? props.buildBody() : {};
        if (body === null) return; // 用户取消输入（如重试时放弃重新输入 prompt）
        if (props.confirm && !window.confirm(props.confirm)) return; // 改变远端事实/计费的动作需要二次确认
        setBusy(true);
        setNote('');
        fetch('/iris/api/core/task/' + encodeURIComponent(props.id) + '/' + props.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (res) {
          return res.json().then(function (data) { return { status: res.status, data: data }; })
            .catch(function () { return { status: res.status, data: null }; });
        }).then(function (result) {
          var detail = result.data && result.data.error;
          if (result.status !== 200) {
            setNote(props.failPrefix + '被拒绝：' + (detail && detail.message || '状态 ' + result.status));
            return;
          }
          var created = result.data && result.data.task;
          if (props.createdPrefix && created && created.id && created.id !== props.id) {
            setNote(props.createdPrefix + created.id);
          }
          window.dispatchEvent(new CustomEvent('iris-core-refresh-tick'));
        }).catch(function () {
          setNote(props.failPrefix + '请求失败；任务事实未改动');
        }).finally(function () { setBusy(false); });
      }
      return React.createElement('span', { className: 'iris-wb-row', style: { alignItems: 'center' } },
        React.createElement('button', {
          type: 'button', className: 'iris-pm-btn', disabled: busy,
          title: props.title,
          onClick: act
        }, busy ? props.busyLabel : props.idleLabel),
        note ? React.createElement('span', { className: 'iris-wb-err' }, note) : null);
    }

    /* D1 reobserve：显式单步观察入口，投影标记 observable 才出现。 */
    function CoreReobserveButton(props) {
      if (!props.row || props.row.observable !== true) return null;
      return React.createElement(CoreTaskManualButton, {
        id: props.row.id, action: 'reobserve',
        idleLabel: '重新观察', busyLabel: '观察中…', failPrefix: '重新观察',
        title: '只向供应商查询一次该任务的最新状态，绝不重新提交'
      });
    }

    /* D2 redeliver：delivery_failed 的唯一恢复入口；重新下载已生成的作品，不重新生成。 */
    function CoreRedeliverButton(props) {
      if (!props.row || props.row.redeliverable !== true) return null;
      return React.createElement(CoreTaskManualButton, {
        id: props.row.id, action: 'redeliver',
        idleLabel: '重新取回作品', busyLabel: '取回中…', failPrefix: '重新取回作品',
        title: '重新下载已生成的作品，不会再次生成，也不会增加生成费用'
      });
    }

    /* D3 cancel：改变远端事实，需二次确认。只有供应商明确确认才会显示「已取消」；
       不支持或无法确认时保持真实状态（观察暂停/结果未知），绝不伪造已取消。 */
    function CoreCancelButton(props) {
      if (!props.row || props.row.cancelable !== true) return null;
      return React.createElement(CoreTaskManualButton, {
        id: props.row.id, action: 'cancel',
        idleLabel: '取消任务', busyLabel: '取消中…', failPrefix: '取消任务',
        title: '请求远端取消该任务；只有供应商明确确认才会记为已取消',
        confirm: '请求远端取消该任务？\n只有供应商明确确认后才会记为「已取消」；不支持或无法确认时保持真实状态，绝不伪造已取消。'
      });
    }

    /* D4 retry as new task：产生新的真实计费。Core 记录不持久化生成指令，所以必须
       重新输入 prompt（绝不从旧任务"恢复"）；二次确认文案明确重复计费。 */
    function CoreRetryButton(props) {
      if (!props.row || props.row.retryable !== true) return null;
      return React.createElement(CoreTaskManualButton, {
        id: props.row.id, action: 'retry',
        idleLabel: '重试为新任务', busyLabel: '创建中…', failPrefix: '重试',
        title: '创建一个新任务重新生成，可能产生重复费用；生成指令需要重新输入',
        confirm: '将创建一个新任务并可能产生重复生成费用，确定继续？',
        createdPrefix: '已创建新任务：',
        buildBody: function () {
          var isTts = props.row.capability === 'tts';
          var isTranscribe = props.row.capability === 'transcribe';
          var draft = window.prompt(isTts
            ? 'Core 记录不保存合成文本。请重新输入新任务要合成的文本：'
            : isTranscribe
              ? 'Core 记录不保存音频地址。请重新输入新任务要转写音频的公网或 oss:// 地址：'
              : 'Core 记录不保存生成指令。请重新输入新任务使用的生成指令：');
          if (draft === null) return null;
          draft = String(draft).trim();
          if (!draft) return null;
          return isTts ? { text: draft, confirmBilling: true }
            : isTranscribe ? { audio_url: draft, confirmBilling: true }
            : { prompt: draft, confirmBilling: true };
        }
      });
    }

    /* 注意力处置（Host 偏好，零 Core 写入）：不再提醒/恢复提醒/移除/恢复显示。
       文案明确"仅在本机隐藏提醒，任务与产物记录保留"，不使用"消除记录"类措辞。 */
    function CoreDispositionButtons(props) {
      var row = props.row;
      if (!row || row.suppressed === true || row.historical === true) return null;
      if (row.disposition === 'hidden') {
        return React.createElement(CoreTaskManualButton, {
          id: row.id, action: 'unhide',
          idleLabel: '恢复显示', busyLabel: '恢复中…', failPrefix: '恢复显示',
          title: '在本机恢复显示该任务；Core 记录一直在，只是被隐藏'
        });
      }
      var attentionish = row.userState === 'attention' || row.userState === 'delivery_failed';
      var children = [];
      if (attentionish && row.disposition !== 'acknowledged') {
        children.push(React.createElement(CoreTaskManualButton, {
          key: 'ack', id: row.id, action: 'acknowledge',
          idleLabel: '不再提醒', busyLabel: '处理中…', failPrefix: '不再提醒',
          title: '仅在本机不再提醒该任务；任务与产物记录保留在 Core'
        }));
        children.push(React.createElement(CoreTaskManualButton, {
          key: 'hide', id: row.id, action: 'hide',
          idleLabel: '移除', busyLabel: '移除中…', failPrefix: '移除',
          title: '仅在本机隐藏提醒，任务与产物记录保留在 Core',
          confirm: '仅在本机隐藏此任务的提醒；任务与产物记录保留在 Core，可随时在高级诊断恢复显示。确定移除？'
        }));
      }
      if (attentionish && row.disposition === 'acknowledged') {
        children.push(React.createElement(CoreTaskManualButton, {
          key: 'restore', id: row.id, action: 'restore',
          idleLabel: '恢复提醒', busyLabel: '恢复中…', failPrefix: '恢复提醒',
          title: '取消"不再提醒"，该任务重新出现在需要处理分区'
        }));
      }
      return children.length ? React.createElement('span', {}, children) : null;
    }

    /* 只读卡片：显示稳定 Task ID、模型、更新时间和关联作品；不渲染供应商身份、错误原文或路径，无展开/删除入口。
       「重新观察」/「重新取回作品」/「取消任务」/「重试为新任务」是仅有的动作（子组件，卡片本体仍不 fetch），
       且仅当投影标记对应门时出现。 */
    function coreTaskCard(row) {
      var artifactIds = Array.isArray(row.artifactIds) ? row.artifactIds : [];
      var links = row.mediaReady && artifactIds.length
        ? React.createElement('div', { className: 'iris-wb-row' }, artifactIds.map(function (id, index) {
          return React.createElement('a', {
            key: id, className: 'iris-wb-link', target: '_blank', rel: 'noreferrer',
            href: '/iris/api/core/artifact/' + encodeURIComponent(id) + '/media'
          }, '▶ 作品 ' + (index + 1));
        }))
        : null;
      return React.createElement('div', {
        key: 'core:' + row.id,
        className: 'iris-wb-card iris-core-user-row',
        title: '只读投影：更多事实见下方「高级诊断 · Core 任务事实」'
      },
        React.createElement('div', { className: 'iris-core-user-head' },
          React.createElement('span', {}, capIcon(row.capability)),
          coreTaskBadge(row),
          React.createElement('span', { className: 'iris-wb-kv iris-core-user-model' }, row.model || '未记录'),
          React.createElement('span', { className: 'iris-wb-muted' }, '更新 ' + fmtTime(row.updatedAt))),
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('span', { className: 'iris-core-id' }, row.id)),
        React.createElement(CoreReobserveButton, { row: row }),
        React.createElement(CoreRedeliverButton, { row: row }),
        React.createElement(CoreCancelButton, { row: row }),
        React.createElement(CoreRetryButton, { row: row }),
        React.createElement(CoreDispositionButtons, { row: row }),
        row.userState === 'succeeded' && !row.mediaReady
          ? React.createElement('div', { className: 'iris-wb-row' },
            React.createElement('span', { className: 'iris-wb-badge warn', title: '关联作品记录不在当前快照中，请稍后刷新' }, '作品文件暂时不可用'))
          : null,
        links);
    }

    function coreTaskMini(row) {
      return React.createElement('div', {
        key: 'core:' + row.id, className: 'iris-task-mini',
        title: row.label + ' · ' + row.id
      },
        React.createElement('span', {}, capIcon(row.capability)),
        coreTaskBadge(row),
        React.createElement('span', { className: 'iris-task-mini-prompt' }, row.model || row.id),
        React.createElement('span', { className: 'iris-wb-muted' }, fmtTime(row.updatedAt)));
    }

    /* hidden 与 suppressed（重试成功自动静默）从用户任务区整体消失；canceled
       用 historical 进入历史且不计 attention；acknowledged 异常行也进入历史但可恢复。 */
    function splitCoreUserRows(rows) {
      var live = [], attention = [], done = [], acknowledged = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || row.suppressed === true || row.disposition === 'hidden') continue;
        if (row.historical === true) done.push(row);
        else if (row.userState === 'running' || row.userState === 'observation_paused') live.push(row);
        else if (row.userState === 'attention' || row.userState === 'delivery_failed') {
          if (row.disposition === 'acknowledged') acknowledged.push(row);
          else attention.push(row);
        }
        else if (row.userState === 'succeeded') done.push(row);
      }
      return { live: live, attention: attention, done: done, acknowledged: acknowledged };
    }

    function CoreRuntimePanel() {
      var dataPair = React.useState(null);
      var data = dataPair[0];
      var setData = dataPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = React.useState('');
      var error = errorPair[0];
      var setError = errorPair[1];
      var openPair = React.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var selectedPair = React.useState('');
      var selectedCoreTask = selectedPair[0];
      var setSelectedCoreTask = selectedPair[1];
      var copyPair = React.useState('');
      var copyNote = copyPair[0];
      var setCopyNote = copyPair[1];
      function load() {
        if (busy) return;
        setBusy(true);
        setError('');
        fetch('/iris/api/core/snapshot?limit=12')
          .then(function (res) {
            if (res.status === 404) return { available: false, backendReloadRequired: true, tasks: { total: 0, recent: [] }, artifacts: { total: 0, recent: [] } };
            return res.ok ? res.json() : Promise.reject(new Error('读取失败（HTTP ' + res.status + '）'));
          }).then(setData)
          .catch(function (caught) { setError('Core 运行事实读取失败：' + caught.message); })
          .finally(function () { setBusy(false); });
      }
      function copyCoreId(value, label) {
        setCopyNote('');
        var clipboard = window.navigator && window.navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          setCopyNote('浏览器不允许自动复制；请长按上方 ID 复制。');
          return;
        }
        clipboard.writeText(value)
          .then(function () { setCopyNote(label + ' 已复制'); })
          .catch(function () { setCopyNote('复制失败；请长按上方 ID 复制。'); });
      }
      React.useEffect(function () {
        function changed() { load(); }
        load();
        window.addEventListener('iris-core-artifacts-changed', changed);
        window.addEventListener('iris-core-refresh-tick', changed);
        return function () {
          window.removeEventListener('iris-core-artifacts-changed', changed);
          window.removeEventListener('iris-core-refresh-tick', changed);
        };
      }, []);
      var taskData = data && data.tasks || { total: 0, recent: [] };
      var artifactData = data && data.artifacts || { total: 0, recent: [] };
      /* 处置偏好投影：诊断层可见 hidden/acknowledged/suppressed，并可恢复显示。 */
      var dispositionMap = {};
      ((data && data.userTasks) || []).forEach(function (row) { dispositionMap[row.id] = row; });
      function dispositionLabelOf(row) {
        if (!row) return '';
        if (row.suppressed) return '已由新任务成功交付自动静默';
        if (row.disposition === 'hidden') return '已在本机隐藏（记录保留，可恢复显示）';
        if (row.disposition === 'acknowledged') return '已设「不再提醒」（本机偏好，记录保留）';
        return '';
      }
      var selectedTask = (taskData.recent || []).find(function (task) { return task.id === selectedCoreTask; });
      var taskRows = (taskData.recent || []).slice(0, 6).map(function (task) {
        var state = coreTaskState(task);
        var disposed = dispositionMap[task.id];
        var hiddenMark = disposed && disposed.disposition === 'hidden' ? ' · 已隐藏' : '';
        var selected = selectedCoreTask === task.id;
        return React.createElement('button', {
          key: task.id,
          type: 'button',
          className: 'iris-core-task-row' + (selected ? ' selected' : ''),
          'aria-expanded': selected,
          onClick: function () { setSelectedCoreTask(selected ? '' : task.id); }
        },
        React.createElement('span', { className: 'iris-core-state-dot ' + state.tone }),
        React.createElement('span', { className: 'iris-core-task-main' },
          React.createElement('strong', {}, coreCapabilityLabel(task.capability) + ' · ' + state.label + hiddenMark),
          React.createElement('span', { className: 'iris-wb-muted' }, coreModelLabel(task.modelRef) + ' · ' + fmtTime(task.updatedAt))),
        React.createElement('span', { className: 'iris-core-task-arrow' }, selected ? '▼' : '›'));
      });
      var selectedArtifacts = selectedTask ? (selectedTask.artifactIds || []).map(function (id) {
        return (artifactData.recent || []).find(function (artifact) { return artifact.id === id; }) || { id: id };
      }) : [];
      var selectedDisposition = selectedTask ? dispositionMap[selectedTask.id] : null;
      var dispositionNote = dispositionLabelOf(selectedDisposition);
      var detail = selectedTask ? React.createElement('div', { className: 'iris-core-detail' },
        React.createElement('div', { className: 'iris-doctor-top' },
          React.createElement('strong', { className: 'iris-doctor-score' }, '任务事实'),
          React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: function () { copyCoreId(selectedTask.id, 'Task ID'); } }, '复制 Task ID')),
        React.createElement('div', { className: 'iris-core-id' }, selectedTask.id),
        React.createElement('div', { className: 'iris-core-detail-grid' },
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '模型'), React.createElement('span', {}, coreModelLabel(selectedTask.modelRef))),
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, 'Provider'), React.createElement('span', { className: 'iris-core-id' }, selectedTask.providerId || '未记录')),
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '取消状态'), React.createElement('span', {}, coreCancelLabel(selectedTask.cancelState))),
          dispositionNote ? React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '处置状态'), React.createElement('span', {}, dispositionNote)) : null,
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '重试来源'), React.createElement('span', { className: 'iris-core-id' }, selectedTask.retriedFrom || '无')),
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '创建时间'), React.createElement('span', {}, fmtTime(selectedTask.createdAt))),
          React.createElement('div', { className: 'iris-core-detail-cell' }, React.createElement('span', { className: 'iris-wb-muted' }, '最后更新'), React.createElement('span', {}, fmtTime(selectedTask.updatedAt)))),
        React.createElement('div', {},
          React.createElement('div', { className: 'iris-wb-muted', style: { marginBottom: '4px' } }, '尝试记录 · ' + (selectedTask.attempts || []).length),
          React.createElement('div', { className: 'iris-core-task-list' }, (selectedTask.attempts || []).map(function (attempt) {
            return React.createElement('div', { key: attempt.id, className: 'iris-core-attempt' },
              React.createElement('span', {}, '第 ' + attempt.ordinal + ' 次 · ' + coreAttemptState(attempt) + ' · ' + coreModelLabel(attempt.model)),
              React.createElement('span', { className: 'iris-wb-muted' }, fmtTime(attempt.finishedAt || attempt.startedAt)),
              attempt.error && attempt.error.safeMessage ? React.createElement('span', { className: 'iris-wb-err' }, attempt.error.safeMessage) : null);
          }))),
        React.createElement('div', {},
          React.createElement('div', { className: 'iris-wb-muted', style: { marginBottom: '4px' } }, '关联作品 · ' + selectedArtifacts.length),
          selectedArtifacts.length ? React.createElement('div', { className: 'iris-core-task-list' }, selectedArtifacts.map(function (artifact) {
            var canOpen = selectedTask.capability === 'image' && (!artifact.mediaType || String(artifact.mediaType).indexOf('image/') === 0);
            return React.createElement('div', { key: artifact.id, className: 'iris-core-artifact' },
              React.createElement('span', { className: 'iris-core-id', style: { flex: 1 } }, artifact.id),
              artifact.size ? React.createElement('span', { className: 'iris-wb-muted' }, fmtBytes(artifact.size)) : null,
              canOpen ? React.createElement('a', { className: 'iris-wb-link', href: '/iris/api/core/artifact/' + encodeURIComponent(artifact.id) + '/media', target: '_blank', rel: 'noreferrer' }, '打开作品') : null,
              React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: function () { copyCoreId(artifact.id, 'Artifact ID'); } }, '复制 ID'));
          })) : React.createElement('div', { className: 'iris-wb-empty' }, '当前任务没有可用作品')),
        selectedTask.lastError && selectedTask.lastError.safeMessage ? React.createElement('div', { className: 'iris-wb-err' }, selectedTask.lastError.safeMessage) : null,
        React.createElement(CoreReobserveButton, {
          row: selectedTask && selectedTask.acceptance === 'accepted' && selectedTask.remoteTaskId
              && ['none', 'unknown'].indexOf(selectedTask.outcome) >= 0 && selectedTask.phase !== 'terminal'
            ? { id: selectedTask.id, observable: true } : null
        }),
        React.createElement(CoreRedeliverButton, {
          row: selectedTask && selectedTask.outcome === 'succeeded'
              && selectedTask.deliveryState === 'failed' && selectedTask.remoteTaskId
            ? { id: selectedTask.id, redeliverable: true } : null
        }),
        React.createElement(CoreCancelButton, {
          row: selectedTask && selectedTask.acceptance === 'accepted' && selectedTask.remoteTaskId
              && ['none', 'unknown'].indexOf(selectedTask.outcome) >= 0 && selectedTask.phase !== 'terminal'
              && (!selectedTask.cancelState || selectedTask.cancelState === 'none')
            ? { id: selectedTask.id, cancelable: true } : null
        }),
        React.createElement(CoreRetryButton, {
          row: selectedTask && selectedTask.phase === 'terminal'
              && !(selectedTask.outcome === 'succeeded' && selectedTask.deliveryState === 'ready')
            ? { id: selectedTask.id, retryable: true } : null
        }),
        React.createElement(CoreDispositionButtons, {
          row: selectedDisposition
            ? { id: selectedDisposition.id, userState: selectedDisposition.userState,
                disposition: selectedDisposition.disposition, suppressed: selectedDisposition.suppressed }
            : null
        }),
        React.createElement('div', { className: 'iris-clean-note' }, '事实面板：「重新观察」只查询远端最新状态、「重新取回作品」只重新下载已生成的产物、「取消任务」只有供应商明确确认才记为已取消、「重试为新任务」会创建新任务并可能产生重复费用；这里不会重新提交、删除或修改既有任务。')) : null;
      var countText = data && data.available
        ? taskData.total + ' 个任务 · ' + artifactData.total + ' 个作品'
        : (busy ? '正在读取…' : '查看底层任务与作品关系');
      return React.createElement('div', { className: 'iris-wb-card iris-core-runtime' },
        React.createElement('div', { className: 'iris-core-runtime-head' },
          React.createElement('div', { className: 'iris-core-runtime-title' },
            React.createElement('strong', {}, 'Core 任务事实'),
            React.createElement('span', { className: 'iris-wb-muted' }, countText)),
          React.createElement('button', { className: 'iris-pm-btn', type: 'button', 'aria-expanded': open, onClick: function () { setOpen(!open); } }, open ? '收起' : '展开')),
        open ? React.createElement('div', { className: 'iris-core-runtime-body' },
          React.createElement('div', { className: 'iris-core-runtime-tools' },
            React.createElement('span', { className: 'iris-wb-muted', style: { flex: 1 } }, '只读开发诊断 · 点击任务查看尝试与作品'),
            React.createElement('button', { className: 'iris-pm-btn', type: 'button', disabled: busy, onClick: load }, busy ? '读取中…' : '刷新')),
          error ? React.createElement('div', { className: 'iris-doctor-row error' }, React.createElement('span', {}, '×'), React.createElement('span', {}, error)) : null,
          data && !data.available ? React.createElement('div', { className: 'iris-wb-empty' },
            data.backendReloadRequired ? 'DSH 后端尚未加载 Core 路由；请重启 DSH 后重试。' : '尚无 Core 运行事实；读取不会创建目录。') : null,
          data && data.available ? (taskRows.length ? React.createElement('div', { className: 'iris-core-task-list' }, taskRows)
            : React.createElement('div', { className: 'iris-wb-empty' }, '当前没有 Core Task')) : null,
          detail,
          copyNote ? React.createElement('div', { className: 'iris-clean-note' }, copyNote) : null) : null);
    }

    /* ---- 泡泡常用卡片选择器（设置页：多项勾选 → 出现在悬浮窗「常用」标签） ---- */
    function BubbleCardPicker() {
      var pair = useBubbleCards();
      var selected = pair[0];
      var save = pair[1];
      function toggle(action) {
        var next = selected.indexOf(action) >= 0
          ? selected.filter(function (a) { return a !== action; })
          : selected.concat([action]);
        save(next);
      }
      return React.createElement('div', { className: 'iris-pick-grid' }, CARD_DEFS.map(function (d) {
        return React.createElement('label', { key: d.action, className: 'iris-pick-item' },
          React.createElement('input', { type: 'checkbox', checked: selected.indexOf(d.action) >= 0, onChange: function () { toggle(d.action); } }),
          d.title);
      }));
    }

    /* ---- 清理区（设置页：删记录/清孤儿产物，破坏性操作二次确认） ---- */
    function CleanupBar() {
      var state = useIrisState(5000);
      var total = (state && state.tasks && state.tasks.recentTotal) || 0;
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      function run(action, body, confirmMsg) {
        if (confirmMsg && !window.confirm(confirmMsg)) return;
        postAction(action, body || {}).then(function (r) {
          setNote(r.ok ? (r.d.text || '完成') : ('失败：' + ((r.d && r.d.error) || '')));
        });
      }
      return React.createElement('div', { className: 'iris-clean' },
        React.createElement('span', { className: 'iris-clean-note' }, '共 ' + total + ' 条终态记录'),
        React.createElement('button', { className: 'iris-clean-btn', onClick: function () { run('tasks_clear', { scope: 'completed' }, '删除全部终态任务记录？产物文件保留在 outputs/。'); } }, '清空已完成'),
        React.createElement('button', { className: 'iris-clean-btn', onClick: function () { run('tasks_clear', { scope: 'older_than', days: 7 }, '删除 7 天前的任务记录？'); } }, '清理 7 天前'),
        React.createElement('button', { className: 'iris-clean-btn', onClick: function () { run('tasks_orphans'); } }, '扫描孤儿产物'),
        React.createElement('button', { className: 'iris-clean-btn danger', onClick: function () { run('tasks_purge_orphans', {}, '删除所有无任务引用的产物文件？此操作不可逆。'); } }, '删除孤儿产物'),
        note ? React.createElement('div', { className: 'iris-clean-note', style: { width: '100%' } }, note) : null);
    }

    function PromptOptimizerSettings() {
      var pair = React.useState(null);
      var state = pair[0];
      var setState = pair[1];
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];

      function load() {
        fetch('/iris/api/prompt-optimizer/config')
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { if (data && data.config) setState(data); })
          .catch(function () { setNote('读取提示词优化配置失败'); });
      }
      React.useEffect(function () {
        function changed(event) { if (event.detail && event.detail.config) setState(event.detail); }
        window.addEventListener('iris-prompt-config-changed', changed);
        load();
        return function () { window.removeEventListener('iris-prompt-config-changed', changed); };
      }, []);

      function toggle() {
        var enabled = !(state && state.config && state.config.enabled !== false);
        fetch('/iris/api/prompt-optimizer/enabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled })
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || '更新失败');
            setState(data);
            window.dispatchEvent(new CustomEvent('iris-prompt-config-changed', { detail: data }));
            setNote(enabled ? '对话框 🫧 入口已启用' : '对话框入口已关闭；Iris 工作台与后台能力不受影响');
          });
        }).catch(function (err) { setNote(String(err && err.message || err)); });
      }

      var enabled = !state || !state.config || state.config.enabled !== false;
      return React.createElement('div', { className: 'iris-wb-card' },
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('span', { className: 'iris-po-settings-mark' }, '🫧'),
          React.createElement('span', { style: { flex: 1 } }, enabled ? '对话框入口已启用' : '对话框入口已关闭'),
          React.createElement('button', { className: 'iris-pm-btn', onClick: toggle }, enabled ? '关闭入口' : '重新启用')),
        React.createElement('div', { className: 'iris-wb-muted' }, '这里只控制对话框提示词优化入口；Iris 工作台、Agent 工具和任务后台始终保持运行。'),
        note ? React.createElement('div', { className: 'iris-clean-note' }, note) : null);
    }

    function HostDoctorPanel() {
      var pair = React.useState(null);
      var report = pair[0];
      var setReport = pair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var errorPair = React.useState('');
      var error = errorPair[0];
      var setError = errorPair[1];

      function load() {
        setBusy(true);
        setError('');
        fetch('/iris/api/doctor')
          .then(function (res) { return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || '诊断失败'); return data; }); })
          .then(function (data) { setReport(data); })
          .catch(function (err) { setError(String(err && err.message || err)); })
          .finally(function () { setBusy(false); });
      }
      React.useEffect(function () { load(); }, []);

      var checks = report && Array.isArray(report.checks) ? report.checks : [];
      var issues = checks.filter(function (item) { return item.status !== 'ok'; });
      var mark = { ok: '✓', warn: '!', error: '×' };
      function rows(list) {
        return React.createElement('div', { className: 'iris-doctor-list' }, list.map(function (item) {
          return React.createElement('div', { key: item.id, className: 'iris-doctor-row ' + item.status },
            React.createElement('span', {}, mark[item.status] || '·'),
            React.createElement('span', {}, item.summary));
        }));
      }
      var score = report
        ? report.summary.errors + ' 错误 · ' + report.summary.warnings + ' 警告'
        : (busy ? '正在检查宿主…' : '尚未运行');
      return React.createElement('div', { className: 'iris-wb-card' },
        React.createElement('div', { className: 'iris-doctor-top' },
          React.createElement('span', { className: 'iris-doctor-score' }, score),
          report && report.host ? React.createElement('span', { className: 'iris-wb-muted' }, 'DSH ' + report.host.version) : null,
          React.createElement('button', { className: 'iris-pm-btn', disabled: busy, onClick: load }, busy ? '检查中…' : '刷新')),
        error ? React.createElement('div', { className: 'iris-doctor-row error' }, React.createElement('span', {}, '×'), React.createElement('span', {}, error)) : null,
        issues.length ? rows(issues) : (report ? React.createElement('div', { className: 'iris-wb-muted' }, '当前可观察项全部健康') : null),
        checks.length ? React.createElement('details', { className: 'iris-doctor-details' },
          React.createElement('summary', {}, '查看全部 ' + checks.length + ' 项'),
          rows(checks)) : null,
        React.createElement('div', { className: 'iris-wb-muted' }, '只读本机注册证据；不调用 Browser、模型或供应商。'));
    }

    function WorkbenchPanel() {
      var state = useIrisState(5000);
      var running = (state && state.tasks && state.tasks.running) || [];
      var recent = (state && state.tasks && state.tasks.recent) || [];
      var attention = (state && state.tasks && state.tasks.attention) || [];
      var artifactTotal = (state && state.artifacts && state.artifacts.total) || 0;
      // 同一任务区合并 legacy 与 Core 只读投影；Core 行仅有的动作是「重新观察」「重新取回作品」与需确认的「取消任务」。
      var coreUser = useCoreUserTasks();
      var coreGroups = splitCoreUserRows(coreUser.rows || []);
      var selPair = React.useState(null);
      var selectedTask = selPair[0];
      var setSelectedTask = selPair[1];
      function onSelect(id) { setSelectedTask(id); }
      return React.createElement('div', { className: 'iris-wb' },
        React.createElement('div', { className: 'iris-wb-head' },
          React.createElement('span', { className: 'iris-wb-title' }, 'Iris 工作台'),
          React.createElement('span', { className: 'iris-wb-date' }, state ? '刷新于 ' + new Date().toLocaleTimeString() : '加载中…')),
        React.createElement('div', { className: 'iris-wb-sec' }, '供应商'),
        React.createElement(ProviderManager, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '能力健康'),
        React.createElement(CapabilityHealthOverview, {}),
        React.createElement('div', { className: 'iris-wb-muted' }, '绿色有效 7 天；真实成功或显式实测会刷新。不会后台探测，也不会因 429、网络或供应商 5xx 变红。'),
        React.createElement('div', { className: 'iris-wb-sec' }, '能力分配（failover 顺序）'),
        React.createElement(CapabilityAssigner, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, 'Iris 泡泡快捷卡片（勾选后显示在「⚡ 常用」标签）'),
        React.createElement(BubbleCardPicker, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '对话框提示词优化'),
        React.createElement(PromptOptimizerSettings, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '宿主诊断'),
        React.createElement(HostDoctorPanel, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '运行中任务'),
        React.createElement('div', { className: 'iris-wb-box' },
          running.length || coreGroups.live.length ? [].concat(
            running.map(function (t) { return taskRow(t, true, selectedTask === t.id, onSelect); }),
            coreGroups.live.map(coreTaskCard))
            : React.createElement('div', { className: 'iris-wb-empty' }, '暂无进行中任务')),
        attention.length || coreGroups.attention.length || coreUser.degraded ? React.createElement('div', {},
          React.createElement('div', { className: 'iris-wb-sec' }, '需要处理'),
          React.createElement('div', { className: 'iris-wb-box' },
            coreUser.degraded ? React.createElement('div', { className: 'iris-clean-note' },
              '部分 Core 记录损坏或媒体缺失，已跳过 ' + coreUser.droppedTasks + ' 条；其余事实照常显示。') : null,
            [].concat(
              attention.map(function (t) { return taskRow(t, false, selectedTask === t.id, onSelect); }),
              coreGroups.attention.map(coreTaskCard)))) : null,
        React.createElement('div', { className: 'iris-wb-sec' }, '作品库'),
        React.createElement(ArtifactGallery, { total: artifactTotal }),
        React.createElement('div', { className: 'iris-wb-sec' }, '高级诊断'),
        React.createElement(CoreRuntimePanel, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '历史任务'),
        React.createElement(CleanupBar, {}),
        React.createElement(HistoryBrowser, { recent: recent, coreHistory: [].concat(coreGroups.done, coreGroups.acknowledged), selected: selectedTask, onSelect: onSelect }),
        React.createElement('div', { className: 'iris-wb-sec' }, '操作'),
        React.createElement(ActionGroups, {}));
    }

    /* ---- 泡泡浮层（阶段 4 续：两标签，尽量干净）---- */
    function BubblePanel() {
      var state = useIrisState(5000);
      var running = (state && state.tasks && state.tasks.running) || [];
      var recent = (state && state.tasks && state.tasks.recent) || [];
      var attention = (state && state.tasks && state.tasks.attention) || [];
      var recentTotal = (state && state.tasks && state.tasks.recentTotal) || recent.length;
      var legacyWorks = (state && state.artifacts && state.artifacts.recent) || [];
      var coreWorks = useCoreWorks(6);
      // 同一任务/作品区合并 Core 只读投影；完成提示会话内只出现一次，刷新后从事实重算。
      var coreUser = useCoreUserTasks();
      var coreGroups = splitCoreUserRows(coreUser.rows || []);
      var arrivedPair = React.useState([]);
      var coreArrived = arrivedPair[0];
      var setCoreArrived = arrivedPair[1];
      var coreRowsKey = (coreUser.rows || []).map(function (row) { return row.id + '@' + row.revision; }).join(',');
      React.useEffect(function () {
        var added = noteCoreCompletions(coreUser.rows || []);
        if (added.length) setCoreArrived(added);
      }, [coreRowsKey]);
      var works = coreWorks.concat(legacyWorks).sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      }).slice(0, 6);
      var artifactTotal = ((state && state.artifacts && state.artifacts.total) || legacyWorks.length) + coreWorks.length;
      var cards = useBubbleCards()[0];
      var tabPair = React.useState('tasks');
      var tab = tabPair[0];
      var setTab = tabPair[1];
      var selPair = React.useState(null);
      var selectedTask = selPair[0];
      var setSelectedTask = selPair[1];
      function onSelect(id) { setSelectedTask(id); }
      var body;
      if (tab === 'tasks') {
        // 快捷面板承载当前任务、需要处理的异常事实与独立作品库中的最近作品。
        body = React.createElement('div', { className: 'iris-wb-box' },
          coreArrived.length ? React.createElement('div', { className: 'iris-wb-badge ok', role: 'status' },
            '新完成：' + coreArrived.map(function (row) { return row.model || row.id; }).join('、')) : null,
          running.length || coreGroups.live.length ? React.createElement('div', {},
            React.createElement('div', { className: 'iris-wb-sec' }, '运行中'),
            running.map(function (t) { return taskRow(t, true, selectedTask === t.id, onSelect); }),
            coreGroups.live.map(coreTaskMini)) : null,
          attention.length || coreGroups.attention.length ? React.createElement('div', {},
            React.createElement('div', { className: 'iris-wb-sec' }, '需要处理'),
            attention.slice(0, 4).map(function (t) { return taskRowMini(t, selectedTask === t.id, onSelect); }),
            coreGroups.attention.slice(0, 4).map(coreTaskMini)) : null,
          React.createElement('div', { className: 'iris-wb-sec' }, '最近作品'),
          works.length ? works.map(artifactRowMini)
            : React.createElement('div', { className: 'iris-wb-empty' }, '尚无作品'),
          artifactTotal > works.length || recentTotal > 0
            ? React.createElement('div', { className: 'iris-bubble-more', style: { cursor: 'default' } },
              '完整作品库、失败与取消历史请到 Iris 工作台查看') : null);
      } else {
        var defs = CARD_DEFS.filter(function (d) { return cards.indexOf(d.action) >= 0; });
        body = defs.length
          ? React.createElement('div', { className: 'iris-act-group' }, defs.map(renderCard))
          : React.createElement('div', { className: 'iris-wb-empty' }, '还没有常用卡片——去设置页勾选');
      }
      return React.createElement('div', {},
        React.createElement('div', { className: 'iris-bubble-tabs' },
          React.createElement('button', { className: 'iris-bubble-tab' + (tab === 'tasks' ? ' active' : ''), onClick: function () { setTab('tasks'); } }, '📋 任务'),
          React.createElement('button', { className: 'iris-bubble-tab' + (tab === 'cards' ? ' active' : ''), onClick: function () { setTab('cards'); } }, '⚡ 常用' + (cards.length ? ' (' + cards.length + ')' : ''))),
        body,
        selectedTask ? React.createElement(TaskDetailDrawer, { taskId: selectedTask }) : null);
    }

    function PromptOptimizerControl(props) {
      var draft = props.useInput(function (value) { return value.draft; });
      var phase = props.useInput(function (value) { return value.phase; });
      var refCount = props.useInput(function (value) { return (value.occurrences || []).length; });
      var projection = props.useProjection('modelSelection');
      var selectedRoute = projection && (projection.current || projection.selection || projection.next || projection.lastUsed || (projection.provider && projection.model ? projection : null));

      var openPair = React.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var targetPair = React.useState('general');
      var target = targetPair[0];
      var setTarget = targetPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      var configPair = React.useState(null);
      var configState = configPair[0];
      var setConfigState = configPair[1];
      var abortRef = React.useRef(null);
      var fileRef = React.useRef(null);

      function promptRequest(operation, body, signal) {
        return fetch('/iris/api/prompt-optimizer/' + operation, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: signal
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
            return data;
          });
        });
      }

      function loadConfig() {
        fetch('/iris/api/prompt-optimizer/config')
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { if (data && data.config) setConfigState(data); })
          .catch(function () { setNote('无法读取提示词优化配置'); });
      }

      React.useEffect(function () {
        return function () {
          if (abortRef.current) abortRef.current.abort();
        };
      }, []);

      React.useEffect(function () {
        function changed(event) { if (event.detail && event.detail.config) setConfigState(event.detail); }
        window.addEventListener('iris-prompt-config-changed', changed);
        loadConfig();
        return function () { window.removeEventListener('iris-prompt-config-changed', changed); };
      }, []);

      function publishConfig(data) {
        setConfigState(data);
        try { window.dispatchEvent(new CustomEvent('iris-prompt-config-changed', { detail: data })); } catch (_) {}
      }

      function optimize() {
        if (!draft || !draft.trim()) { setNote('请先在输入框中写入提示词'); return; }
        if (refCount) { setNote('当前版本暂不改写含 @ 或 / 结构化引用的草稿，以免引用失效'); return; }
        if (phase !== 'plain') { setNote('输入框正忙，请稍后再试'); return; }
        if (abortRef.current) abortRef.current.abort();
        var controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setNote('正在调用模型优化…这可能产生模型费用');
        setResult(null);
        promptRequest('optimize', {
          text: draft,
          target: target,
          sessionId: props.sessionId,
          route: selectedRoute || undefined
        }, controller.signal).then(function (data) {
          setResult(data);
          setNote('已生成预览，尚未写回输入框');
        }).catch(function (err) {
          if (controller.signal.aborted) setNote('已取消');
          else setNote(String(err && err.message || err));
        }).finally(function () {
          if (abortRef.current === controller) abortRef.current = null;
          setBusy(false);
        });
      }

      function cancel() {
        if (abortRef.current) abortRef.current.abort();
      }

      function replaceDraft(text) {
        if (!result) return;
        if (draft !== result.original && !window.confirm('输入框内容在优化期间已变化，仍要替换吗？')) return;
        props.inputActions.setDraft(text);
        setNote(text === result.original ? '已恢复优化前原文' : '已写回输入框；不会自动发送');
      }

      function copyResult() {
        if (!result) return;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(result.optimized).then(function () { setNote('已复制优化结果'); }).catch(function () { setNote('复制失败，请手动选择文本'); });
        } else {
          setNote('浏览器不支持自动复制，请手动选择文本');
        }
      }

      function importConfig(event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        file.text().then(function (raw) {
          var parsed = JSON.parse(raw);
          return promptRequest('import', { config: parsed });
        }).then(function (data) {
          publishConfig(data);
          setNote('JSON 配置已导入并生效');
        }).catch(function (err) {
          setNote('导入失败：' + String(err && err.message || err));
        });
      }

      function exportConfig() {
        if (!configState || !configState.config) { setNote('配置尚未载入'); return; }
        try {
          var blob = new Blob([JSON.stringify(configState.config, null, 2) + '\n'], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'iris-prompt-optimizer.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 0);
          setNote('已导出当前 JSON 配置');
        } catch (_) {
          setNote('导出失败');
        }
      }

      function resetConfig() {
        if (!window.confirm('恢复 Iris 内置默认 Prompt、目标模板和会话模型路由？')) return;
        promptRequest('reset', {}).then(function (data) {
          publishConfig(data);
          setNote('已恢复 Iris 内置默认配置');
        }).catch(function (err) {
          setNote('重置失败：' + String(err && err.message || err));
        });
      }

      function disableEntry() {
        if (busy) return;
        promptRequest('enabled', { enabled: false }).then(function (data) {
          publishConfig(data);
          setOpen(false);
        }).catch(function (err) { setNote('关闭失败：' + String(err && err.message || err)); });
      }

      if (configState && configState.config && configState.config.enabled === false) return null;

      var routeLabel = 'DSH 默认模型';
      if (configState && configState.config && configState.config.route.mode === 'fixed') {
        routeLabel = configState.config.route.provider + ' / ' + configState.config.route.model;
      } else if (selectedRoute) {
        routeLabel = selectedRoute.provider + ' / ' + selectedRoute.model;
      }
      var reasoningSetting = configState && configState.config && configState.config.generation && configState.config.generation.reasoningEffort || 'off-if-supported';
      var reasoningLabel = reasoningSetting === 'off-if-supported' ? '支持时关闭' : reasoningSetting === 'provider-default' ? '供应商默认' : reasoningSetting === 'inherit' ? '跟随会话' : reasoningSetting;
      var outputBudget = configState && configState.config && configState.config.generation && configState.config.generation.maxOutputTokens || 1200;

      var panel = null;
      if (open) {
        panel = React.createElement(React.Fragment, {},
          React.createElement('div', { className: 'iris-po-backdrop', onClick: function () { setOpen(false); }, 'aria-hidden': 'true' }),
          React.createElement('div', { className: 'iris-po-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Iris 提示词优化', onClick: function (e) { e.stopPropagation(); } },
          React.createElement('div', { className: 'iris-po-head' },
            React.createElement('strong', { className: 'iris-po-title' }, React.createElement('span', { className: 'iris-po-mark' }, '🫧'), 'Iris 提示词优化'),
            React.createElement('button', { className: 'iris-po-close', onClick: function () { setOpen(false); }, title: '关闭' }, '✕')),
          React.createElement('div', { className: 'iris-po-muted' }, '只处理当前未发送草稿，不读取会话历史；调用模型可能产生费用。'),
          React.createElement('label', { className: 'iris-po-field' },
            React.createElement('span', {}, '优化目标'),
            React.createElement('select', { value: target, disabled: busy, onChange: function (e) { setTarget(e.target.value); } },
              React.createElement('option', { value: 'general' }, '通用对话'),
              React.createElement('option', { value: 'image' }, '图片生成'),
              React.createElement('option', { value: 'video' }, '视频生成'),
              React.createElement('option', { value: 's2v' }, '首尾帧视频'))),
          React.createElement('div', { className: 'iris-po-route', title: routeLabel }, '模型：' + routeLabel + ' · 思考：' + reasoningLabel + ' · 输出：' + outputBudget + ' tokens'),
          React.createElement('div', { className: 'iris-po-actions' },
            React.createElement('button', { className: 'iris-po-primary', disabled: busy || !draft || !draft.trim() || phase !== 'plain' || refCount > 0, onClick: optimize }, busy ? '优化中…' : '生成预览'),
            busy ? React.createElement('button', { className: 'iris-po-btn', onClick: cancel }, '取消') : null),
          result ? React.createElement('div', { className: 'iris-po-result' },
            React.createElement('div', { className: 'iris-po-result-label' }, '优化结果'),
            React.createElement('textarea', { readOnly: true, value: result.optimized }),
            React.createElement('div', { className: 'iris-po-route' }, '实际使用：' + result.route.provider + ' / ' + result.route.model + ' · 思考：' + (result.route.reasoningEffort === 'provider-default' ? '供应商默认' : result.route.reasoningEffort)),
            React.createElement('div', { className: 'iris-po-actions' },
              React.createElement('button', { className: 'iris-po-primary', onClick: function () { replaceDraft(result.optimized); } }, '写回输入框'),
              React.createElement('button', { className: 'iris-po-btn', onClick: copyResult }, '复制'),
              React.createElement('button', { className: 'iris-po-btn', onClick: optimize }, '再优化'),
              React.createElement('button', { className: 'iris-po-btn', onClick: function () { replaceDraft(result.original); } }, '恢复原文'))) : null,
          note ? React.createElement('div', { className: 'iris-po-note' }, note) : null,
          React.createElement('details', { className: 'iris-po-config' },
            React.createElement('summary', {}, 'JSON 配置'),
            React.createElement('div', { className: 'iris-po-muted' }, '可导出后修改 systemPrompt、targets、route 和 generation，再重新导入。'),
            React.createElement('div', { className: 'iris-po-actions' },
              React.createElement('button', { className: 'iris-po-btn', onClick: exportConfig }, '导出'),
              React.createElement('button', { className: 'iris-po-btn', onClick: function () { if (fileRef.current) fileRef.current.click(); } }, '导入'),
              React.createElement('button', { className: 'iris-po-btn danger', onClick: resetConfig }, '恢复默认'),
              React.createElement('input', { ref: fileRef, className: 'iris-po-file', type: 'file', accept: 'application/json,.json', onChange: importConfig })),
            React.createElement('div', { className: 'iris-po-muted' }, '当前：' + (configState && configState.source === 'custom' ? '用户 JSON' : 'Iris 默认'))),
          React.createElement('button', { className: 'iris-po-disable', disabled: busy, onClick: disableEntry }, '关闭此对话入口（工作台仍保留）')));
      }

      return React.createElement('div', { className: 'iris-po-wrap' },
        React.createElement('button', {
          className: 'iris-po-trigger',
          type: 'button',
          title: refCount ? '含结构化引用的草稿暂不支持优化' : '优化当前输入框提示词',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { setOpen(!open); }
        }, '🫧'),
        panel);
    }

    function ProgressDock() {
      var state = useIrisState(5000);
      var running = (state && state.tasks && state.tasks.running) || [];
      if (!running.length) return null;
      return React.createElement('div', { className: 'iris-progress-dock' },
        running.map(function (t) {
          return React.createElement('div', { key: t.id, className: 'iris-progress-row' },
            React.createElement('span', {}, '🫧 ' + t.cap),
            React.createElement('span', {}, t.model || ''),
            React.createElement('span', {}, String(t.progress || '')));
        }));
    }

    /* 像素块鸢尾图形标（与 docs/assets/logo 同一设计矩阵的剪影，9×10 cell），
       悬浮泡泡按钮内使用，替代 🫧 表情。 */
    var IRIS_MARK_PATH = 'M4 0h1v1h-1zM3 1h1v1h-1zM4 1h1v1h-1zM5 1h1v1h-1zM2 2h1v1h-1zM3 2h1v1h-1zM4 2h1v1h-1zM5 2h1v1h-1zM6 2h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1zM4 3h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM0 4h1v1h-1zM3 4h1v1h-1zM4 4h1v1h-1zM5 4h1v1h-1zM8 4h1v1h-1zM0 5h1v1h-1zM1 5h1v1h-1zM3 5h1v1h-1zM4 5h1v1h-1zM5 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM1 6h1v1h-1zM2 6h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1zM7 6h1v1h-1zM2 7h1v1h-1zM3 7h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM4 8h1v1h-1zM4 9h1v1h-1z';
    function IRIS_MARK_SVG() {
      return React.createElement('svg', {
        width: 20, height: 22, viewBox: '0 0 9 10',
        role: 'img', 'aria-label': 'Iris', shapeRendering: 'crispEdges',
        fill: '#dcd8f7'
      }, React.createElement('path', { d: IRIS_MARK_PATH }));
    }

    function FloatingBubble() {
      var state = useIrisState(5000);
      var providers = (state && state.providers) || [];
      var fallbackConfigured = providers.some(function (p) { return p.enabled && p.apiKeyHint; });
      var overallHealth = state && state.health && HEALTH_META[state.health.overall]
        ? state.health.overall : (fallbackConfigured ? 'configured' : 'unconfigured');
      var running = (state && state.tasks && state.tasks.running) || [];
      var attention = (state && state.tasks && state.tasks.attention) || [];

      var posPair = React.useState(function () {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem('iris-bubble-pos') || 'null'); } catch (_) {}
        return saved && typeof saved.x === 'number' && typeof saved.y === 'number'
          ? saved : { x: null, y: null };
      });
      var pos = posPair[0];
      var setPos = posPair[1];
      var openPair = React.useState(false);
      var open = openPair[0];
      var setOpen = openPair[1];
      var dragRef = React.useRef(null);

      var DEFAULT_X = 70, DEFAULT_Y = 170; // 距右/下（CSS 默认角）

      function bubbleXY() {
        return {
          x: pos.x != null ? pos.x : (window.innerWidth - DEFAULT_X),
          y: pos.y != null ? pos.y : (window.innerHeight - DEFAULT_Y)
        };
      }

      function onPointerDown(e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        // 面板内部交互不触发外层拖动/开关：只有点在泡泡按钮上才起拖
        if (!e.target || !e.target.closest || !e.target.closest('.iris-bubble-btn')) return;
        var target = e.currentTarget;
        try { target.setPointerCapture(e.pointerId); } catch (_) {}
        var xy = bubbleXY();
        dragRef.current = { px: e.clientX, py: e.clientY, moved: false, ox: xy.x, oy: xy.y };
      }

      // 窗口变化后把泡泡约束回可视区（同步持久化）
      React.useEffect(function () {
        function onResize() {
          setPos(function (old) {
            if (!old || old.x == null || old.y == null) return old;
            var nx = Math.min(window.innerWidth - 52, Math.max(6, old.x));
            var ny = Math.min(window.innerHeight - 52, Math.max(6, old.y));
            if (nx !== old.x || ny !== old.y) {
              var np = { x: nx, y: ny };
              try { localStorage.setItem('iris-bubble-pos', JSON.stringify(np)); } catch (_) {}
              return np;
            }
            return old;
          });
        }
        window.addEventListener('resize', onResize);
        return function () { window.removeEventListener('resize', onResize); };
      }, []);

      function onPointerMove(e) {
        var drag = dragRef.current;
        if (!drag) return;
        var dx = e.clientX - drag.px;
        var dy = e.clientY - drag.py;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (drag.moved) {
          var nx = Math.min(window.innerWidth - 52, Math.max(6, drag.ox + dx));
          var ny = Math.min(window.innerHeight - 52, Math.max(6, drag.oy + dy));
          setPos({ x: nx, y: ny });
        }
      }

      function persistCurrentPosition() {
        setPos(function (current) {
          if (current && current.x != null && current.y != null) {
            try { localStorage.setItem('iris-bubble-pos', JSON.stringify(current)); } catch (_) {}
          }
          return current;
        });
      }

      function onPointerUp(e) {
        var drag = dragRef.current;
        if (!drag) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
        var moved = drag.moved;
        dragRef.current = null;
        if (moved) persistCurrentPosition();
        else setOpen(!open);
      }

      function onPointerCancel(e) {
        if (!dragRef.current) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
        dragRef.current = null;
        persistCurrentPosition();
      }

      var style;
      if (pos.x != null && pos.y != null) {
        style = { left: pos.x + 'px', top: pos.y + 'px' };
      } else {
        style = { right: DEFAULT_X + 'px', bottom: DEFAULT_Y + 'px' };
      }

      var badgeCount = running.length + attention.length;
      var badge = badgeCount
        ? React.createElement('span', { className: 'iris-bubble-badge', title: attention.length ? attention.length + ' 个任务需要处理' : '' }, badgeCount)
        : null;

      var panel = null;
      if (open) {
        var xy = bubbleXY();
        var panelWidth = Math.min(360, Math.max(0, window.innerWidth - 16));
        var panelHeight = Math.min(520, Math.max(0, window.innerHeight - 16));
        var panelLeft = Math.max(8, Math.min(xy.x - panelWidth + 30, window.innerWidth - panelWidth - 8));
        var panelTop = Math.max(8, Math.min(xy.y - 260, window.innerHeight - panelHeight - 8));
        panel = React.createElement('div', { className: 'iris-bubble-panel', style: { left: panelLeft + 'px', top: panelTop + 'px' } },
          React.createElement('div', { className: 'iris-bubble-panel-head' },
            React.createElement('button', { className: 'iris-bubble-close', onClick: function () { setOpen(false); } }, '✕')),
          React.createElement(BubblePanel, {}));
      }

      return React.createElement('div', {
        className: 'iris-bubble health-' + overallHealth + (dragRef.current ? ' dragging' : ''),
        style: style,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerCancel,
        title: 'Iris ' + healthText({ status: overallHealth }) + '：点击打开快捷面板'
      },
        React.createElement('div', { className: 'iris-bubble-btn' }, React.createElement(IRIS_MARK_SVG)),
        badge,
        panel);
    }

    var clientSlots = clientSlotsPort(ctx);

    clientSlots.inject('settings.section', function () {
      var dispose = clientSlots.register({
        name: 'settings.section',
        id: 'iris-workbench',
        order: 140,
        label: function () { return 'Iris 工作台'; }
      }, WorkbenchPanel);
      reportClientSeat('settings.section');
      return dispose;
    });

    clientSlots.inject('conversation.input.right', function () {
      var dispose = clientSlots.register({
        name: 'conversation.input.right',
        id: 'iris-prompt-optimizer',
        order: 40,
        label: function () { return 'Iris 提示词优化'; }
      }, PromptOptimizerControl);
      reportClientSeat('conversation.input.right');
      return dispose;
    });

    clientSlots.inject('conversation.input.dock', function () {
      var dispose = clientSlots.register({
        name: 'conversation.input.dock',
        id: 'iris-progress',
        order: 0,
        label: function () { return 'Iris 任务进度'; }
      }, ProgressDock);
      reportClientSeat('conversation.input.dock');
      return dispose;
    });

    clientSlots.inject('shell.overlay', function () {
      var dispose = clientSlots.register({
        name: 'shell.overlay',
        id: 'iris-bubble',
        order: 200,
        label: function () { return 'Iris 泡泡'; }
      }, FloatingBubble);
      reportClientSeat('shell.overlay');
      return dispose;
    });
      console.log('[iris] client slots registered');
    } catch (err) {
      console.error('[iris] client apply failed:', err && err.message);
      throw err;
    }
  }

  module.exports = { inject: inject, apply: apply };
  return module.exports;
}});
