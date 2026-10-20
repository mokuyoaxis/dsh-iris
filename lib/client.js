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
  var IRIS_CLIENT_VERSION = '0.2.6';
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
    /* 工作台页面共用视觉规则；不改变对话泡泡和 composer 的布局。 */
    '.iris-workbench-page { --iris-workbench-accent: var(--dsw-alias-brand-primary, #8c9eff); display: grid; gap: 10px; }',
    '.iris-workbench-page *, .iris-workbench-page *::before { box-sizing: border-box; }',
    '.iris-workbench-page [hidden], .iris-health [hidden] { display: none !important; }',
    '.iris-workbench-page > .iris-wb-head { justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin: 2px 0 4px; }',
    '.iris-workbench-page > .iris-wb-head .iris-wb-title { font-size: 20px; font-weight: 650; letter-spacing: -.03em; }',
    '.iris-wb-section { min-width: 0; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-wb-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; list-style: none; }',
    '.iris-wb-section-head::-webkit-details-marker { display: none; }',
    '.iris-wb-section-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }',
    '.iris-wb-section-head p { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    'details.iris-wb-section > summary { cursor: pointer; border-radius: inherit; }',
    '.iris-wb-section-arrow { flex-shrink: 0; display: inline-flex; gap: 7px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-wb-section-arrow svg { transition: transform .15s; }',
    'details.iris-wb-section[open] > summary .iris-wb-section-arrow svg { transform: rotate(180deg); }',
    '.iris-wb-section-body { min-width: 0; padding: 0 14px 14px; display: grid; gap: 8px; }',
    '.iris-workbench-page .iris-wb-sec { margin: 4px 0 0; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); }',
    '.iris-workbench-page .iris-pm, .iris-workbench-page .iris-cap-grid, .iris-workbench-page .iris-act-group { gap: 8px; }',
    '.iris-workbench-page .iris-pm-card, .iris-workbench-page .iris-wb-card, .iris-workbench-page .iris-act-card, .iris-workbench-page .iris-cap-row { border-radius: 10px; }',
    '.iris-workbench-page .iris-pm-card, .iris-workbench-page .iris-cap-row { padding: 10px; }',
    '.iris-workbench-page .iris-pm-card { gap: 8px; }',
    '.iris-workbench-page .iris-pm-body { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-workbench-page .iris-pm-field { gap: 5px; font-size: 12px; }',
    '.iris-workbench-page :is(.iris-pm-btn, .iris-pm-add, .iris-ff-btn, .iris-act-run, .iris-clean-btn) { min-height: 32px; padding: 5px 9px; border-radius: 8px; font-family: inherit; font-size: 12px; }',
    '.iris-workbench-page :is(button, select, input):focus-visible, .iris-wb-section-head:focus-visible { outline: 2px solid var(--iris-workbench-accent, #8c9eff); outline-offset: 3px; }',
    '.iris-workbench-page :is(input, textarea, select) { font-family: inherit; accent-color: var(--iris-workbench-accent); }',
    '.iris-workbench-page input:not([type=checkbox]):not([type=radio]):not([type=file]), .iris-workbench-page textarea, .iris-workbench-page select { min-width: 0; max-width: 100%; min-height: 34px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; }',
    '.iris-workbench-page .iris-pm-note { line-height: 1.65; }',
    '.iris-workbench-page .iris-pm-mrows { max-height: 400px; gap: 8px; }',
    '.iris-workbench-page .iris-pm-mrow { min-width: 0; padding: 10px; gap: 6px; flex-wrap: wrap; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; }',
    '.iris-workbench-page .iris-pm-mname { flex-basis: 100%; white-space: normal; overflow-wrap: anywhere; font-size: 13px; }',
    '.iris-workbench-page .iris-pm-mrow > label { display: flex; align-items: center; flex: 1 1 230px; flex-wrap: wrap; gap: 6px; }',
    '.iris-workbench-page .iris-pm-mrow > label select { flex: 1; }',
    '.iris-workbench-page .iris-cap-row { gap: 7px; }',
    '.iris-workbench-page .iris-cap-row > select:first-of-type { margin-left: auto; }',
    '.iris-workbench-page .iris-cap-row > .iris-pm-note, .iris-workbench-page .iris-cap-row > .iris-cap-feedback { flex-basis: 100%; }',
    '.iris-workbench-page .iris-cap-row > .iris-pm-model-sel { margin-left: 0; }',
    '.iris-workbench-page .iris-cap-chip { padding: 3px 7px; border-radius: 8px; overflow-wrap: anywhere; }',
    '.iris-workbench-page .iris-cap-confirm { padding: 12px; border-radius: 10px; }',
    '.iris-workbench-page .iris-act-head { min-height: 40px; padding: 9px 12px; }',
    '.iris-workbench-page .iris-act-body { padding: 10px 12px 12px; gap: 8px; }',
    '.iris-workbench-page .iris-doctor-row { font-size: 12px; line-height: 1.6; }',
    '@media (max-width: 640px) { .iris-wb-section-head { padding: 12px; } .iris-wb-section-body { padding: 0 12px 12px; } .iris-workbench-page :is(.iris-pm-btn, .iris-pm-add, .iris-ff-btn, .iris-act-run, .iris-clean-btn) { min-height: 40px; } .iris-workbench-page input:not([type=checkbox]):not([type=radio]):not([type=file]), .iris-workbench-page textarea, .iris-workbench-page select { min-height: 36px; } }',
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
    '.iris-doctor-row > span:last-child { min-width: 0; overflow-wrap: anywhere; }',
    '.iris-doctor-row.ok { color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-doctor-row.warn { color: var(--dsw-alias-state-warn-primary, #d9a941); }',
    '.iris-doctor-row.error { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-doctor-details { margin-top: 7px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-doctor-details summary { cursor: pointer; font-size: 11px; }',
    '.iris-browser-check { border-top: 1px solid var(--dsw-alias-border-l1, #ffffff12); margin-top: 10px; padding-top: 9px; min-width: 0; }',
    '.iris-browser-check .iris-doctor-top { margin-bottom: 5px; }',
    '.iris-browser-check img { display: block; width: 100%; max-height: 200px; object-fit: contain; margin-top: 7px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #ffffff05); }',
    '.iris-browser-check-note { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }',
    '.iris-browser-check-note.error { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
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
    '.iris-pm-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
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
    'details[data-provider-directory] { min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; }',
    'details[data-provider-directory] > summary { cursor: pointer; overflow-wrap: anywhere; }',
    'details[data-provider-directory] p { margin: 6px 0; overflow-wrap: anywhere; }',
    'details[data-provider-directory] > summary:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #6b78e8); outline-offset: 3px; }',
    '.iris-pm-field input, .iris-pm-field textarea { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 100%; box-sizing: border-box; }',
    '.iris-pm-act { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-pm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #73737d); margin-right: 4px; }',
    '.iris-pm-dot.configured { background: #6f9df6; box-shadow: 0 0 7px rgba(111,157,246,.55); }',
    '.iris-pm-dot.verified { background: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 7px var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-pm-dot.failed { background: #b9656d; box-shadow: 0 0 6px rgba(185,101,109,.38); opacity: .82; }',
    '.iris-health { --iris-health-accent: var(--dsw-alias-brand-primary, #8c9eff); container-type: inline-size; padding: 0; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-health *, .iris-health *::before { box-sizing: border-box; }',
    '.iris-health-head, .iris-health-title-line, .iris-health-card-top, .iris-health-card-foot, .iris-health-detail-head, .iris-health-model-head, .iris-health-confirm-actions { display: flex; align-items: center; gap: 10px; }',
    '.iris-health-head { justify-content: space-between; flex-wrap: wrap; padding: 10px 14px; }',
    '.iris-health-content { padding: 0 14px 14px; }',
    '.iris-health-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }',
    '.iris-health-eyebrow { color: var(--iris-health-accent); font-size: 10px; font-weight: 600; letter-spacing: .14em; margin-bottom: 6px; }',
    '.iris-health h2, .iris-health h3, .iris-health p { margin: 0; }',
    '.iris-health h2 { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }',
    '.iris-health-subtitle, .iris-health-caption { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-health-subtitle { margin-top: 5px !important; }',
    '.iris-health-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 32px; padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }',
    '.iris-health-btn:hover { border-color: var(--iris-health-accent); }',
    '.iris-health-btn.primary { border-color: transparent; background: var(--iris-health-accent); color: var(--dsw-alias-label-primary-inverted, #1b2034); font-weight: 600; }',
    '.iris-health-btn:disabled { opacity: .5; cursor: default; }',
    '.iris-health button:focus-visible { outline: 2px solid var(--iris-health-accent); outline-offset: 3px; }',
    '.iris-health-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }',
    '.iris-health-row { --iris-health-tone: var(--dsw-alias-label-secondary, #9a9a9a); display: grid; gap: 10px; min-width: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #26262e); color: var(--dsw-alias-label-primary, #e6e6e6); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, transform .15s; }',
    '.iris-health-row:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--iris-health-accent); }',
    '.iris-health-row:disabled { cursor: wait; opacity: .7; }',
    '.iris-health-row.active { border-color: var(--iris-health-accent); box-shadow: inset 0 0 0 1px var(--iris-health-accent); }',
    '.iris-health-row.configured { --iris-health-tone: var(--iris-health-accent); }',
    '.iris-health-row.verified { --iris-health-tone: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-health-row.failed, .iris-health-row.rate-limited { --iris-health-tone: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-health-row.cooling { --iris-health-tone: #c68b23; }',
    '.iris-health-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 32px; height: 32px; border-radius: 9px; background: rgba(132,115,238,.1); color: var(--iris-health-accent); }',
    '.iris-health-card-top { justify-content: space-between; }',
    '.iris-health-name { font-size: 14px; font-weight: 600; }',
    '.iris-health-state { display: inline-flex; align-items: center; gap: 5px; margin-top: 7px; font-size: 11px; color: var(--iris-health-tone); }',
    '.iris-health-state::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }',
    '.iris-health-card-foot { justify-content: space-between; min-width: 0; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, #3a3a44); font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-health-link { color: var(--iris-health-accent); white-space: nowrap; }',
    '.iris-health-footer { margin-top: 13px !important; font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #9a9a9a); }',
    '.iris-health-notice { margin-top: 12px; padding: 11px 13px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }',
    '.iris-health-notice.error { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-health-detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-health-detail-head { justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }',
    '.iris-health-detail-head > button { flex-shrink: 0; }',
    '.iris-health h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }',
    '.iris-health-models { display: grid; gap: 8px; }',
    '.iris-health-model { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #26262e); min-width: 0; }',
    '.iris-health-model-head { justify-content: space-between; align-items: flex-start; }',
    '.iris-health-model-title { min-width: 0; flex: 1; }',
    '.iris-health-model-title strong { display: block; font-size: 13px; font-weight: 550; overflow-wrap: anywhere; }',
    '.iris-health-result { display: flex; gap: 7px; align-items: flex-start; margin-top: 10px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }',
    '.iris-health-result.passed { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-health-result.failed, .iris-health-result.unknown { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-health-result.running { color: var(--iris-health-accent); }',
    '.iris-health-spinner { display: inline-block; flex: 0 0 13px; width: 13px; height: 13px; margin-top: 3px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: iris-health-spin .8s linear infinite; }',
    '.iris-health-confirm { margin-top: 12px; padding: 14px; border-radius: 11px; border: 1px solid var(--iris-health-accent); background: rgba(132,115,238,.06); font-size: 12px; line-height: 1.7; }',
    '.iris-health-confirm-actions { margin-top: 12px; flex-wrap: wrap; }',
    '@keyframes iris-health-spin { to { transform: rotate(360deg); } }',
    '@container (max-width: 650px) { .iris-health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
    '@container (max-width: 420px) { .iris-health-grid { grid-template-columns: 1fr; } }',
    '@media (max-width: 640px) { .iris-health-head { flex-wrap: nowrap; padding: 12px; } .iris-health-head > div { flex: 1; min-width: 0; } .iris-health-head > button { flex-shrink: 0; } .iris-health-content { padding: 0 12px 12px; } .iris-health-grid { grid-template-columns: 1fr; gap: 8px; } .iris-health-row { position: relative; grid-template-columns: 32px minmax(0, 1fr); gap: 5px 9px; padding: 10px; } .iris-health-card-top { display: contents; } .iris-health-card-top .iris-health-icon { grid-row: 1 / 3; grid-column: 1; } .iris-health-card-top .iris-health-caption { position: absolute; right: 10px; top: 10px; font-size: 10px; } .iris-health-card-main { grid-column: 2; min-width: 0; } .iris-health-name { padding-right: 58px; } .iris-health-state { display: flex; line-height: 1.6; margin-top: 5px; } .iris-health-state::before { flex-shrink: 0; } .iris-health-card-foot { grid-column: 2; border: 0; padding-top: 0; font-size: 10px; flex-wrap: wrap; gap: 3px; } .iris-health-link { margin-left: auto; } .iris-health-btn { min-height: 40px; } .iris-health-model-head { flex-wrap: wrap; } .iris-health-model-head > .iris-health-btn { margin-left: auto; } }',
    '@media (prefers-reduced-motion: reduce) { .iris-health-row { transition: none; } .iris-health-row:hover { transform: none; } .iris-health-spinner { animation: none; } }',
    '.iris-cap-grid { display: grid; gap: 6px; }',
    '.iris-cap-row { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; padding: 6px 9px; font-size: 12px; }',
    '.iris-cap-name { font-weight: 600; min-width: 64px; }',
    '.iris-cap-chip { display: inline-flex; align-items: center; gap: 3px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 10px; padding: 1px 6px; font-size: 11px; }',
    '.iris-cap-chip b { color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-cap-auto { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11px; font-style: italic; }',
    '.iris-cap-feedback { flex-basis: 100%; color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-cap-feedback.saved { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-cap-feedback.unknown, .iris-cap-compatibility { color: var(--dsw-alias-state-error-primary, #e06c6c); }',
    '.iris-cap-confirm { flex-basis: 100%; padding: 8px; border: 1px solid var(--dsw-alias-brand-primary, #7aa2f7); border-radius: 6px; }',
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
    '.iris-gallery-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.iris-gallery-card.selected { border-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-gallery-select { display: flex; align-items: center; gap: 6px; font-size: 11px; }',
    '.iris-gallery-select input { width: 18px; height: 18px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #7aa2f7); }',
    '.iris-gallery-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }',
    '.iris-gallery-management { padding: 12px; margin-bottom: 12px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 13px; display: grid; gap: 10px; }',
    '.iris-gallery-management dl { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 12px; }',
    '.iris-gallery-management dt { color: var(--dsw-alias-label-tertiary, #7a7a85); }',
    '.iris-gallery-management dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }',
    '.iris-gallery-management-list { display: grid; gap: 8px; max-height: 45vh; overflow-y: auto; overflow-wrap: anywhere; font-size: 12px; }',
    '.iris-gallery-transaction { padding: 8px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; display: grid; gap: 6px; }',
    '.iris-gallery-filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }',
    '.iris-gallery-filters label { display: grid; gap: 3px; font-size: 11px; flex: 1; min-width: 110px; }',
    '.iris-gallery-filters select { min-height: 34px; padding: 4px 7px; background: var(--dsw-alias-bg-layer-2, #32323c); color: inherit; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 7px; font: inherit; }',
    '.iris-gallery-pagination { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 12px; }',
    '.iris-gallery-analysis { display: grid; grid-template-columns: minmax(120px, .6fr) minmax(0, 1fr); gap: 12px; padding: 12px; margin-bottom: 12px; border: 1px solid var(--dsw-alias-brand-primary, #7aa2f7); border-radius: 13px; background: var(--dsw-alias-bg-layer-1, #26262e); }',
    '.iris-gallery-analysis .iris-gallery-preview { max-height: 260px; border-radius: 8px; }',
    '.iris-gallery-analysis-body { display: grid; gap: 8px; min-width: 0; }',
    '.iris-gallery-analysis-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
    '.iris-gallery-analysis-head strong { flex: 1; }',
    '.iris-gallery-analysis textarea { width: 100%; box-sizing: border-box; min-height: 140px; max-height: 40vh; resize: vertical; font: inherit; line-height: 1.6; padding: 8px; color: inherit; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 7px; }',
    '.iris-gallery-analysis-options { display: grid; gap: 8px; }',
    '.iris-gallery-analysis-options label { display: grid; gap: 3px; font-size: 11px; }',
    '.iris-gallery-analysis-options input { box-sizing: border-box; width: 100%; padding: 6px; color: inherit; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 6px; }',
    '@media (max-width: 640px) { .iris-gallery-analysis { grid-template-columns: 1fr; } .iris-gallery-actions button, .iris-gallery-pagination button, .iris-gallery-analysis button, .iris-gallery-management button, .iris-gallery-bulk button { min-height: 40px; } }',
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
    '.iris-pm-ver { font: inherit; font-size: 11px; padding: 3px 7px; border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-secondary, #9a9a9a); cursor: pointer; }',
    '.iris-pm-ver.configured { color: #7da8fa; }',
    '.iris-pm-ver.verified { color: var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-pm-ver.failed { color: #c87a81; border-color: rgba(185,101,109,.5); }',
    '.iris-pm-ver.rate-limited { color: #f87171; border-color: #ef4444; box-shadow: 0 0 7px rgba(239,68,68,.35); }',
    '.iris-pm-ver.cooling, .iris-pm-dot.cooling, .iris-health-row.cooling .iris-health-state { color: #fbbf24; border-color: #f59e0b; box-shadow: none; }',
    '.iris-pm-dot.cooling { background: #fbbf24; opacity: 1; }',
    '.iris-bubble.health-cooling .iris-bubble-btn { border-color: #f59e0b; box-shadow: 0 0 11px rgba(245,158,11,.3); }',
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
    '.iris-po-panel:where(dialog) { left: auto; top: auto; margin: 0; max-width: none; }',
    'dialog.iris-po-panel::backdrop { background: rgba(8,10,18,.30); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }',
    '.iris-po-panel { position: fixed; z-index: 10020; right: max(14px, env(safe-area-inset-right)); bottom: max(78px, calc(env(safe-area-inset-bottom) + 68px)); width: min(560px, calc(100vw - 28px)); max-height: min(780px, calc(100dvh - 104px)); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; box-sizing: border-box; padding: 18px; display: grid; gap: 14px; background-color: rgba(35,36,47,.84); background: radial-gradient(circle at 10% -5%, rgba(132,160,255,.20), transparent 42%), color-mix(in srgb, var(--dsw-alias-bg-layer-1, #26262e) 92%, transparent); color: var(--dsw-alias-label-primary, #eeeeF2); border: 1px solid rgba(150,164,215,.25); border-radius: 22px; box-shadow: 0 24px 70px rgba(0,0,0,.36), inset 0 1px 0 rgba(255,255,255,.07); backdrop-filter: blur(28px) saturate(1.28); -webkit-backdrop-filter: blur(28px) saturate(1.28); animation: iris-po-rise .20s cubic-bezier(.2,.8,.2,1); scrollbar-width: thin; outline: none; }',
    '.iris-po-head { position: sticky; top: -18px; z-index: 1; margin: -18px -18px 0; padding: 16px 18px 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px; background: linear-gradient(to bottom, color-mix(in srgb, var(--dsw-alias-bg-layer-1, #26262e) 88%, transparent) 72%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }',
    '.iris-po-title { display: inline-flex; align-items: center; gap: 9px; font-size: 16px; letter-spacing: .01em; }',
    '.iris-po-intro { display: grid; gap: 9px; }',
    '.iris-po-principles { display: flex; flex-wrap: wrap; gap: 6px; }',
    '.iris-po-principles span { padding: 3px 8px; border-radius: 999px; background: rgba(113,139,219,.09); color: var(--dsw-alias-label-secondary, #b4bdd5); font-size: 10px; }',
    '.iris-po-section { min-width: 0; border: 1px solid rgba(137,155,218,.22); border-radius: 16px; background: rgba(128,150,221,.045); overflow: hidden; }',
    '.iris-po-section > summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px; cursor: pointer; list-style: none; font-size: 13px; font-weight: 650; }',
    '.iris-po-section > summary::-webkit-details-marker { display: none; }',
    '.iris-po-section > summary::after { content: "⌄"; color: var(--dsw-alias-label-secondary, #a6a6b2); transition: transform .15s; }',
    '.iris-po-section[open] > summary::after { transform: rotate(180deg); }',
    '.iris-po-section-caption { margin-left: auto; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary, #a6a6b2); }',
    '.iris-po-section-body { min-width: 0; display: grid; gap: 13px; padding: 0 14px 14px; }',
    '.iris-po-section:not([open]) > .iris-po-section-body { display: none; }',
    '.iris-po-targets { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; }',
    '.iris-po-target { min-width: 0; min-height: 42px; padding: 7px 3px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary, #a6a6b2); background: rgba(128,150,221,.05); }',
    '.iris-po-target[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #eeeef2); border-color: rgba(124,147,225,.48); background: rgba(124,147,225,.18); box-shadow: inset 0 1px 0 rgba(255,255,255,.1); font-weight: 650; }',
    '.iris-po-target:disabled { opacity: .45; cursor: not-allowed; }',
    '.iris-po-target:focus-visible, .iris-po-section > summary:focus-visible, .iris-po-config > summary:focus-visible { outline: 2px solid #8d9fe6; outline-offset: 2px; }',
    '.iris-po-source { min-width: 0; padding: 11px 12px; border-radius: 12px; border: 1px solid rgba(150,164,215,.14); background: rgba(128,150,221,.04); }',
    '.iris-po-source-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary, #a6a6b2); }',
    '.iris-po-source-text { margin: 8px 0 0; max-height: 112px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.65; }',
    '.iris-po-template { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow: auto; font-size: 11px; line-height: 1.65; padding: 10px; border-radius: 10px; background: rgba(128,150,221,.06); }',
    '.iris-po-mark, .iris-po-settings-mark { display: inline-flex; align-items: center; justify-content: center; width: 29px; height: 29px; border-radius: 999px; background: rgba(255,255,255,.055); box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 5px 16px rgba(67,83,168,.16); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); filter: drop-shadow(0 2px 5px rgba(105,128,235,.16)); }',
    '.iris-po-close { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 999px; background: rgba(255,255,255,.05); color: var(--dsw-alias-label-secondary, #a6a6b2); font-size: 14px; cursor: pointer; transition: background .15s, color .15s; }',
    '.iris-po-close:hover { background: rgba(255,255,255,.10); color: var(--dsw-alias-label-primary, #eeeef2); }',
    '.iris-po-muted, .iris-po-route, .iris-po-note { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #a6a6b2); word-break: break-word; }',
    '.iris-po-route { padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,.045); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.iris-po-note { padding: 8px 10px; border-radius: 10px; color: var(--dsw-alias-state-warn-primary, #dfbd69); background: rgba(217,169,65,.08); }',
    '.iris-po-field { display: grid; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #a6a6b2); }',
    '.iris-po-field select, .iris-po-field textarea, .iris-po-result textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,.055); color: var(--dsw-alias-label-primary, #eeeef2); border: 1px solid rgba(150,164,215,.20); border-radius: 11px; padding: 9px 11px; font: inherit; font-size: 12px; outline: none; transition: border-color .15s, background .15s, box-shadow .15s; }',
    '.iris-po-field select:focus, .iris-po-field textarea:focus, .iris-po-result textarea:focus { border-color: rgba(122,162,247,.72); background: rgba(255,255,255,.075); box-shadow: 0 0 0 3px rgba(122,162,247,.11); }',
    '.iris-po-field textarea { min-height: 60px; resize: vertical; line-height: 1.55; }',
    '.iris-po-rules { display: grid; gap: 10px; }',
    '.iris-po-editing { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid rgba(150,164,215,.16); border-radius: 12px; }',
    '.iris-po-editing label { display: flex; gap: 8px; align-items: center; font-size: 12px; cursor: pointer; }',
    '.iris-po-suggestion { display: grid; gap: 7px; padding: 10px; margin-top: 8px; border-radius: 10px; background: rgba(128,150,221,.065); overflow-wrap: anywhere; }',
    '.iris-po-suggestion label { display: flex; align-items: start; gap: 8px; font-size: 12px; }',
    '.iris-po-suggestion p { margin: 0; white-space: pre-wrap; font-size: 12px; line-height: 1.6; }',
    '.iris-po-diff { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 28dvh; overflow-y: auto; font-size: 12px; line-height: 1.6; }',
    '.iris-po-diff del, .iris-po-diff ins { display: block; padding: 6px 8px; border-radius: 7px; margin: 5px 0; }',
    '.iris-po-diff del { background: rgba(226,113,126,.12); }',
    '.iris-po-diff ins { background: rgba(99,198,156,.12); text-decoration: none; }',
    '.iris-po-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
    '.iris-po-btn, .iris-po-primary { min-height: 34px; border: 1px solid rgba(150,164,215,.20); border-radius: 10px; padding: 6px 11px; font: inherit; font-size: 11px; cursor: pointer; transition: transform .15s, background .15s, border-color .15s; }',
    '.iris-po-btn { background: rgba(255,255,255,.045); color: var(--dsw-alias-label-secondary, #b0b0bb); }',
    '.iris-po-btn:hover { background: rgba(255,255,255,.085); color: var(--dsw-alias-label-primary, #eeeef2); border-color: rgba(150,174,255,.50); }',
    '.iris-po-primary { background: linear-gradient(135deg, #779cf3, #8c79de); color: #fff; border-color: rgba(174,187,255,.55); font-weight: 650; box-shadow: 0 6px 18px rgba(76,92,188,.22); }',
    '.iris-po-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(76,92,188,.32); }',
    '.iris-po-primary:disabled, .iris-po-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }',
    '.iris-po-result { display: grid; gap: 8px; padding: 12px; border: 1px solid rgba(137,155,218,.18); border-radius: 15px; background: rgba(128,150,221,.045); }',
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
    var style = document.getElementById(STYLE_ID);
    if (style === null) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.dataset.plugin = 'dsh-iris';
      style.dataset.pluginCss = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== cssText) style.textContent = cssText;
  }

  var inject = ['slots'];

  function apply(ctx) {
    try {
      console.log('[iris] client apply start');
      adoptStyles();

    /* ---- 当前主视图会话（旧 current / 0.2 mainView 持有者；不猜测列表首项） ---- */
    var currentSessionId = null;
    try {
      var sessions = ctx && (typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions);
      var listObs = sessions && sessions.list;
      if (listObs && typeof listObs.getSnapshot === 'function') {
        function readCurrentSession() {
          var snap = listObs.getSnapshot() || {};
          if (Object.prototype.hasOwnProperty.call(snap, 'current')) {
            currentSessionId = typeof snap.current === 'string' && snap.current ? snap.current : null;
            return;
          }
          var rows = Object.values(snap.byId || {}).filter(function (row) {
            return row && typeof row.id === 'string' && row.id && row.retainedBy && row.retainedBy.mainView > 0;
          });
          currentSessionId = rows.length === 1 ? rows[0].id : null;
        }
        readCurrentSession();
        if (typeof listObs.subscribe === 'function') {
          // ObservableSnapshot 的变更通知不承诺携带快照，始终回读权威值。
          var unsubscribeSession = listObs.subscribe(readCurrentSession);
          if (typeof unsubscribeSession === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(function () { return unsubscribeSession; });
          }
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
      failed: { label: '调用受阻', symbol: '×' }
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

    function rateLimitLabel(health) {
      return health.retryAt ? '429 冷却中' : health.reason === 'budget' ? '预算耗尽已停用' : '额度耗尽已停用';
    }

    function healthClass(health) {
      return health.retryAt ? 'cooling' : health.rateLimited ? 'rate-limited' : health.status;
    }

    function healthText(health) {
      var status = health && HEALTH_META[health.status] ? health.status : 'unconfigured';
      var text = health && health.modelUnavailable ? '模型不存在，已暂停自动选用' : health && health.rateLimited
        ? rateLimitLabel(health) + (health.retryAt
          ? '，' + new Date(health.retryAt).toLocaleTimeString() + ' 恢复候选资格；可提前实测'
          : '，实测成功后恢复')
        : (status === 'failed' && health && ['authentication', 'auth', 'permission'].indexOf(health.category) >= 0
          ? '认证失败' : HEALTH_META[status].label);
      var age = relativeHealthTime(health && health.observedAt);
      return text + (age ? ' · ' + age : '');
    }

    var HEALTH_ROWS = [
      { cap: 'image-gen', label: '图片', action: 'draw', sample: '生成一张红色圆形测试图，可能需要约一分钟。', icon: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M8 8h.01' },
      { cap: 'video-gen', label: '视频', action: 'video', taskOnly: true, sample: '请到视频功能填写创作要求或素材，选择模型后提交验证。', icon: 'M3 6h12v12H3z M15 10l6-3v10l-6-3' },
      { cap: 'tts', label: '语音', action: 'tts', sample: '合成一句“你好”，以接口返回音频作为通过依据。', icon: 'M4 10h4l5-4v12l-5-4H4z M16 8c3 2 3 6 0 8 M19 5c5 4 5 10 0 14' },
      { cap: 'music-gen', label: '音乐', action: 'music', taskOnly: true, sample: '请到音乐功能填写实际创作要求，选择模型后提交验证。', icon: 'M9 17V5l11-2v12 M9 5v4l11-2 M9 17a3 3 0 1 1-3-3h3 M20 15a3 3 0 1 1-3-3h3' },
      { cap: 'transcribe', label: '转写', action: 'transcribe', taskOnly: true, sample: '请到转写功能提供真实音频，选择模型后提交验证。', icon: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8' },
      { cap: 'vision', label: '视觉', action: 'ocr', sample: '发送一张内置红色测试图，检查模型能否识别颜色。', icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0' }
    ];
    function capabilityIcon(row) {
      return React.createElement('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('path', { d: row.icon }));
    }
    function inspectionSupported(snapshot) {
      return !!(snapshot && snapshot.policies && snapshot.readiness && HEALTH_ROWS.every(function (row) {
        return snapshot.policies[row.cap] && ['auto', 'manual', 'disabled'].includes(snapshot.policies[row.cap].mode) && snapshot.readiness[row.cap];
      }));
    }
    function inspectionModels(snapshot, row, requested) {
      if (!snapshot) return [];
      var order = snapshot.order[row.cap] || [];
      var policy = snapshot.policies && snapshot.policies[row.cap];
      var options = (snapshot.poolByCapability[row.cap] || []).slice();
      if (requested && requested.ref && !options.some(function (option) { return option.ref === requested.ref; })) {
        options.push({ ...requested, removed: true });
      }
      return options.filter(function (option) {
        return order.includes(option.ref) || (requested && option.providerId === requested.providerId && option.id === requested.modelId);
      }).sort(function (a, b) { return order.indexOf(a.ref) - order.indexOf(b.ref); }).map(function (option) {
        var provider = snapshot.providers.find(function (item) { return item.id === option.providerId; });
        var model = provider && provider.models.find(function (item) { return item.id === option.id; });
        var capability = snapshot.health && snapshot.health.capabilities && snapshot.health.capabilities[row.cap];
        var evidence = capability && (capability.candidates || []).find(function (item) { return item.providerId === option.providerId && item.modelId === option.id; });
        var health = evidence || model && model.health && model.health[row.cap] || { status: 'configured' };
        var host = option.ref === 'host:current-vision';
        var reason = !inspectionSupported(snapshot) ? '请先让 DSH 加载新版功能池接口，再刷新配置。'
          : policy.mode === 'disabled' ? '此功能已停用，请先调整调用方式。'
          : option.removed ? '此模型已从当前配置中移除。'
          : !order.includes(option.ref) ? '此模型未纳入当前功能池，请先调整调用方式或所选模型。'
          : option.pendingConfirmation ? '请先在供应商中确认模型用途。'
          : !host && (!provider || provider.enabled === false) ? '供应商当前不可用，请先检查设置。'
          : provider && provider.dshProvider && (!provider.connection || !provider.connection.available) ? 'DSH 连接尚未就绪，请先检查宿主供应商设置。'
          : option.protocolSupported === false ? option.reason || '当前接口协议不支持此功能。'
          : option.unavailable && !health.rateLimited && !health.modelUnavailable && !option.modelUnavailable ? option.reason || '连接尚未就绪，请先检查供应商设置。' : '';
        return { ...option, providerName: provider ? provider.name : 'DSH 宿主', health: health,
          taskOnly: row.taskOnly || host, reason: reason, canTest: !reason };
      });
    }
    function CapabilityHealthOverview() {
      var state = useIrisState(5000);
      var expandedPair = React.useState(false), expanded = expandedPair[0];
      var snapshotPair = React.useState(null), snapshot = snapshotPair[0];
      var loadingPair = React.useState(false), loading = loadingPair[0];
      var freshPair = React.useState(false), fresh = freshPair[0];
      var errorPair = React.useState('');
      var checkedPair = React.useState('');
      var selectedPair = React.useState(null), selected = selectedPair[0];
      var requestedPair = React.useState(null), requested = requestedPair[0];
      var confirmPair = React.useState(null), confirmation = confirmPair[0];
      var resultsPair = React.useState({}), results = resultsPair[0];
      var busyPair = React.useState(null), busy = busyPair[0];
      var running = React.useRef(false), readVersion = React.useRef(0);
      function noteResult(key, value) { resultsPair[1](function (previous) { return { ...previous, [key]: value }; }); }
      function load() {
        var version = ++readVersion.current;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 10000);
        loadingPair[1](true); freshPair[1](false); errorPair[1]('');
        return Promise.all([
          postAction('assignments_get', {}, { signal: controller.signal }),
          postAction('providers_list', {}, { signal: controller.signal }),
          fetch('/iris/api/state', { signal: controller.signal }).then(function (r) {
            if (!r.ok) throw new Error('健康状态读取失败（HTTP ' + r.status + '）');
            return r.json();
          })
        ]).then(function (values) {
          if (version !== readVersion.current) return null;
          if (!values[0].ok || values[0].d.ok !== true || !values[1].ok || values[1].d.ok !== true) throw new Error('配置读取失败，请重新检查');
          var data = { ...values[0].d, providers: values[1].d.providers, health: values[2].health };
          snapshotPair[1](data); freshPair[1](true); checkedPair[1](new Date().toLocaleTimeString()); return data;
        }).catch(function (error) {
          if (version === readVersion.current) errorPair[1](error.name === 'AbortError' ? '配置检查超时，请重试；未发起模型实测。' : error.message);
          return null;
        }).finally(function () { clearTimeout(timer); controller.abort(); if (version === readVersion.current) loadingPair[1](false); });
      }
      function inspect(row, target) {
        if (running.current) return;
        expandedPair[1](true);
        selectedPair[1](row.cap); requestedPair[1](target || null); confirmPair[1](null);
      }
      React.useEffect(function () {
        load();
        function open(event) {
          var detail = event.detail || {};
          var row = HEALTH_ROWS.find(function (item) { return item.cap === detail.capability; });
          if (row && !running.current) {
            inspect(row, detail); load();
            var section = document.getElementById('iris-capability-health');
            if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }
        }
        window.addEventListener('iris-capability-inspect', open);
        window.addEventListener('iris-function-configuration-changed', load);
        return function () {
          ++readVersion.current;
          window.removeEventListener('iris-capability-inspect', open);
          window.removeEventListener('iris-function-configuration-changed', load);
        };
      }, []);
      function configure(row) {
        var field = document.querySelector('[data-function="' + row.cap + '"] > select');
        if (field) { revealWorkbenchItem(field); field.scrollIntoView({ block: 'center', behavior: 'smooth' }); field.focus({ preventScroll: true }); }
      }
      function openTask(row) {
        var card = document.querySelector('[data-iris-action="' + row.action + '"]');
        if (!card) return;
        revealWorkbenchItem(card);
        if (!card.classList.contains('open')) card.querySelector('.iris-act-head').click();
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      function probe(row, option) {
        if (running.current) return;
        running.current = true; confirmPair[1](null);
        requestedPair[1]({ ...option, modelId: option.id });
        var key = row.cap + '|' + option.ref;
        busyPair[1](key); noteResult(key, { phase: 'running', note: '正在核对当前模型范围…' });
        load().then(function (current) {
          var target = inspectionModels(current, row, option).find(function (item) { return item.ref === option.ref; });
          if (!current || !target || !target.canTest || target.taskOnly) {
            noteResult(key, { phase: 'skipped', note: target && target.reason || '配置未确认或调用范围已变化，未发起实测。' }); return;
          }
          noteResult(key, { phase: 'running', note: '正在实测…' + (row.cap === 'image-gen' ? '图片可能需要约一分钟，请勿重复提交。' : '请等待接口返回。') });
          var controller = new AbortController();
          var timer = setTimeout(function () { controller.abort(); }, 90000);
          return postAction('providers_test_model', { id: target.providerId, model_id: target.id, capability: row.cap, confirm_paid: true },
            { signal: controller.signal }).then(function (r) {
            if (!r.ok || !r.d || r.d.ok !== true || (r.d.skipped !== true && typeof r.d.passed !== 'boolean')) {
              noteResult(key, { phase: 'unknown', note: r.d && r.d.error || '未收到有效检测结果；请先核对供应商记录，避免重复计费。' }); return;
            }
            noteResult(key, { phase: r.d.skipped ? 'skipped' : r.d.passed ? 'passed' : 'failed',
              note: String(r.d.text || '').replace(/^\[iris\][^\n]*?：/, '') || (r.d.passed ? '接口实测通过' : '接口未通过实测') });
          }).catch(function () {
            noteResult(key, { phase: 'unknown', note: '结果未确认，请先核对供应商记录，避免重复计费。本页不会自动重试。' });
          }).finally(function () { clearTimeout(timer); });
        }).then(function () { return load(); }).finally(function () { running.current = false; busyPair[1](null); });
      }
      var currentHealth = snapshot && snapshot.health;
      if (!currentHealth || (state && state.health && state.health.generatedAt > currentHealth.generatedAt)) currentHealth = state && state.health;
      var viewSnapshot = snapshot && { ...snapshot, health: currentHealth };
      var supported = inspectionSupported(snapshot);
      var row = HEALTH_ROWS.find(function (item) { return item.cap === selected; });
      var modes = { auto: '自动选择', manual: '所选模型', disabled: '已停用' };
      var verifiedCount = HEALTH_ROWS.filter(function (item) { return capabilityHealth({ health: currentHealth }, item.cap).status === 'verified'; }).length;
      var blockedCount = HEALTH_ROWS.filter(function (item) { return capabilityHealth({ health: currentHealth }, item.cap).status === 'failed'; }).length;
      var summary = busy ? '正在检测，请等待本次结果。' : errorPair[0] ? '配置读取失败，展开查看详情。'
        : snapshot && !supported ? '服务端需重新加载，展开查看说明。'
        : currentHealth ? '6 项能力 · ' + verifiedCount + ' 项近期成功' + (blockedCount ? ' · ' + blockedCount + ' 项调用受阻' : '')
        : '正在读取能力状态…';
      return React.createElement('section', { className: 'iris-health', id: 'iris-capability-health', 'aria-label': '能力状态与检测' },
        React.createElement('div', { className: 'iris-health-head' },
          React.createElement('div', {}, React.createElement('h2', {}, '能力状态与检测'),
            React.createElement('p', { className: 'iris-health-subtitle', role: 'status' }, summary)),
          React.createElement('button', { className: 'iris-health-btn', 'aria-expanded': expanded, 'aria-controls': 'iris-health-content',
            onClick: function () { expandedPair[1](!expanded); confirmPair[1](null); } }, expanded ? '收起检测' : '展开检测')),
        React.createElement('div', { className: 'iris-health-content', id: 'iris-health-content', hidden: !expanded },
        React.createElement('div', { className: 'iris-health-toolbar' },
          React.createElement('span', { className: 'iris-health-caption' }, '配置检查只读；实测前单独确认。'),
          React.createElement('button', { className: 'iris-health-btn', 'data-health-refresh': true, disabled: loading || !!busy, onClick: function () { load(); } },
            loading ? '正在检查配置…' : '检查配置')),
        errorPair[0] ? React.createElement('div', { className: 'iris-health-notice error', role: 'alert' }, errorPair[0]) : null,
        snapshot && !supported ? React.createElement('div', { className: 'iris-health-notice', role: 'status' },
          '服务端尚未加载新版功能池接口。请重启 DSH 后刷新页面；当前只展示历史状态，暂停模型实测。') : null,
        React.createElement('div', { className: 'iris-health-grid' }, HEALTH_ROWS.map(function (item) {
          var health = capabilityHealth({ health: currentHealth }, item.cap);
          var candidates = inspectionModels(viewSnapshot, item);
          var verified = candidates.filter(function (model) { return model.health.status === 'verified'; }).length;
          var ready = snapshot && snapshot.readiness && snapshot.readiness[item.cap];
          var policy = snapshot && snapshot.policies && snapshot.policies[item.cap];
          return React.createElement('button', { key: item.cap, className: 'iris-health-row ' + healthClass(health) + (selected === item.cap ? ' active' : ''),
            'data-health-capability': item.cap, 'aria-expanded': selected === item.cap, 'aria-controls': 'iris-health-detail', disabled: !!busy,
            onClick: function () { inspect(item); } },
            React.createElement('div', { className: 'iris-health-card-top' },
              React.createElement('span', { className: 'iris-health-icon' }, capabilityIcon(item)),
              React.createElement('span', { className: 'iris-health-caption' }, policy ? modes[policy.mode] : '读取配置')),
            React.createElement('div', { className: 'iris-health-card-main' }, React.createElement('div', { className: 'iris-health-name' }, item.label),
              React.createElement('div', { className: 'iris-health-state', title: healthText(health) }, snapshot || state ? healthText(health) : '正在读取状态…')),
            React.createElement('div', { className: 'iris-health-card-foot' },
              React.createElement('span', {}, ready ? candidates.length ? ready.candidateCount + ' 个可用 · ' + verified + '/' + candidates.length + ' 近期成功' : '暂无候选模型' : '等待配置检查'),
              React.createElement('span', { className: 'iris-health-link' }, '查看检测 ›')));
        })),
        React.createElement('p', { className: 'iris-health-footer', role: 'status' },
          (checkedPair[0] ? '配置检查于 ' + checkedPair[0] + ' · ' : '') + '配置检查只读，实测需单独确认。绿色有效 7 天；不会后台探测。'),
        row ? React.createElement('div', { className: 'iris-health-detail', id: 'iris-health-detail' },
          React.createElement('div', { className: 'iris-health-detail-head' },
            React.createElement('div', {}, React.createElement('h3', {}, row.label + '能力检测'),
              React.createElement('p', { className: 'iris-health-caption' }, row.sample)),
            React.createElement('button', { className: 'iris-health-btn', disabled: !!busy, 'aria-label': '收起能力检测',
              onClick: function () { selectedPair[1](null); confirmPair[1](null); } }, '收起')),
          React.createElement('div', { className: 'iris-health-models' },
            inspectionModels(viewSnapshot, row, requested).map(function (option) {
              var key = row.cap + '|' + option.ref;
              var result = results[key];
              var pending = confirmation && confirmation.ref === option.ref && confirmation.cap === row.cap;
              return React.createElement('div', { key: option.ref, className: 'iris-health-model', 'data-health-model': option.ref, 'aria-busy': busy === key },
                React.createElement('div', { className: 'iris-health-model-head' },
                  React.createElement('div', { className: 'iris-health-model-title' }, React.createElement('strong', {}, option.id),
                    React.createElement('span', { className: 'iris-health-caption' }, option.providerName + ' · ' + healthText(option.health))),
                  React.createElement('button', { className: 'iris-health-btn' + (!option.taskOnly ? ' primary' : ''),
                    disabled: !fresh || !option.canTest || !!busy || !!(result && result.phase === 'unknown'),
                    onClick: function () { if (running.current) return; if (option.taskOnly) openTask(row); else confirmPair[1]({ cap: row.cap, ref: option.ref }); } },
                    option.taskOnly ? '前往功能验证 ↗' : result && result.phase === 'running' ? '正在实测…' : '实测此模型')),
                option.reason ? React.createElement('p', { className: 'iris-health-caption' }, option.reason) : null,
                option.ref === 'host:current-vision' ? React.createElement('p', { className: 'iris-health-caption' },
                  '宿主视觉通过真实图片任务验证，请在打开的表单中选择 DSH 当前默认模型。') : null,
                option.health.rateLimited ? React.createElement('p', { className: 'iris-health-caption' }, '显式实测成功后，会解除此模型的冷却或额度停用。') : null,
                option.modelUnavailable || option.health.modelUnavailable ? React.createElement('p', { className: 'iris-health-caption' },
                  '当前连接曾返回模型不存在，已暂停自动选用；同步目录不会代替实测。单独实测成功后恢复，可能产生费用。') : null,
                result ? React.createElement('div', { className: 'iris-health-result ' + result.phase, role: result.phase === 'unknown' ? 'alert' : 'status', 'aria-live': 'polite' },
                  result.phase === 'running' ? React.createElement('span', { className: 'iris-health-spinner', 'aria-hidden': true }) : null,
                  React.createElement('span', {}, (result.phase === 'passed' ? '实测通过 · ' : result.phase === 'failed' ? '实测未通过 · '
                    : result.phase === 'skipped' ? '未发起实测 · ' : '') + result.note)) : null,
                pending ? React.createElement('div', { className: 'iris-health-confirm', role: 'group', 'aria-label': '确认模型实测' },
                  React.createElement('strong', {}, '确认向此模型发起一次真实请求？'),
                  React.createElement('p', {}, row.sample + ' 可能产生费用。本次仅验证 ' + option.id + '，失败不会改用其他模型。'),
                  React.createElement('div', { className: 'iris-health-confirm-actions' },
                    React.createElement('button', { className: 'iris-health-btn primary', disabled: !!busy, onClick: function () { probe(row, option); } }, '确认并实测'),
                    React.createElement('button', { className: 'iris-health-btn', disabled: !!busy, onClick: function () { confirmPair[1](null); } }, '取消'))) : null);
            }),
            !inspectionModels(viewSnapshot, row, requested).length ? React.createElement('div', { className: 'iris-health-notice' },
              snapshot && snapshot.readiness && snapshot.readiness[row.cap] && snapshot.readiness[row.cap].note || '当前没有纳入调用范围的模型，请先配置此功能。') : null),
          React.createElement('div', { className: 'iris-health-confirm-actions' },
            React.createElement('button', { className: 'iris-health-btn', disabled: !!busy, onClick: function () { configure(row); } }, '查看功能设置'),
            React.createElement('span', { className: 'iris-health-caption' }, '只检测当前调用范围内的模型；历史成功不代表所有候选均可用。'))) : null));
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
    function postAction(action, body, options) {
      return fetch('/iris/api/actions/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
        ...(options && options.signal ? { signal: options.signal } : {}) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
    }

    /* ---- 模型池（阶段 9 P4）：发现/手动模型 + verified 标记 + 逐模型测试/移除 + 手动添加 ---- */
    var CAP_SHORT = { 'image-gen': '图', 'video-gen': '视', 'tts': '音', 'music-gen': '乐', 'transcribe': '转', 'vision': '视👁' };
    function ModelPool(props) {
      var p = props.provider;
      var models = p.models || [];
      function setImageProtocol(m, value) {
        postAction('providers_set_model_image_protocol', { id: p.id, model_id: m.id, imageProtocol: value })
          .then(function (r) { props.onNote(r.ok ? '模型图片协议已更新' : (r.d.error || '更新失败')); if (r.ok) props.onDone(); });
      }
      function setMusicProtocol(m, value) {
        if (!value) return;
        postAction('providers_set_model_music_protocol', { id: p.id, model_id: m.id, musicProtocol: value })
          .then(function (r) { props.onNote(r.ok ? '模型音乐协议已更新' : (r.d.error || '更新失败')); if (r.ok) props.onDone(); });
      }
      function verBadge(m, c) {
        var health = m.health && m.health[c];
        var status = health && HEALTH_META[health.status] ? health.status : 'configured';
        var cls = 'iris-pm-ver ' + status + (health && health.rateLimited ? ' ' + healthClass(health) : '');
        var title = healthText(health || { status: status });
        var symbol = health && health.retryAt ? '◷' : status === 'verified' ? '✓' : (status === 'failed' ? '×' : (status === 'unconfigured' ? '○' : '?'));
        return React.createElement('button', {
          key: c,
          className: cls,
          title: title + '；打开能力检测',
          'aria-label': (HEALTH_ROWS.find(function (row) { return row.cap === c; }) || { label: c }).label + '检测 · ' + m.id,
          onClick: function () { props.testModel(p, m, c); }
        }, (HEALTH_ROWS.find(function (row) { return row.cap === c; }) || { label: c }).label + ' ' + symbol);
      }
      var rows = models.map(function (m) {
        var caps = m.capabilities || [];
        var blocked = caps.map(function (c) { return m.health && m.health[c]; }).find(function (health) { return health && health.rateLimited; });
        return React.createElement('div', { key: m.id, className: 'iris-pm-mrow' },
          React.createElement('span', { className: 'iris-pm-mname' }, m.id, m.source === 'discovered'
            ? React.createElement('span', { className: 'iris-pm-mtag' }, '待确认用途') : null,
            m.catalogStatus === 'unlisted' ? React.createElement('span', { className: 'iris-pm-mtag' }, '目录未列出') : null),
          React.createElement('span', { className: 'iris-pm-mcaps' }, caps.length ? caps.map(function (c) {
            return m.directoryOnly ? React.createElement('span', { key: c }, (HEALTH_ROWS.find(function (row) { return row.cap === c; }) || { label: c }).label) : verBadge(m, c);
          }) : '未标注功能'),
          React.createElement(ModelCapabilityEditor, { provider: p, model: m, onNote: props.onNote, onDone: props.onDone }),
          !m.directoryOnly && caps.includes('image-gen') ? React.createElement('label', { className: 'iris-pm-note' }, '图片协议 ',
            React.createElement('select', { value: m.imageProtocol || 'auto', onChange: function (e) { setImageProtocol(m, e.target.value); } },
              React.createElement('option', { value: 'auto' }, '继承账号默认（' + (p.mediaProtocol || '自动') + '）'),
              React.createElement('option', { value: 'dashscope' }, 'DashScope'),
              React.createElement('option', { value: 'openai-images' }, 'OpenAI Images'),
              React.createElement('option', { value: 'openai-chat-images' }, '聊天生图（网关兼容）'),
              React.createElement('option', { value: 'openai-responses-images' }, 'Responses 生图')),
            m.imageRouting && m.imageRouting.protocolInferred ? ' · 协议待确认' : null) : null,
          !m.directoryOnly && caps.includes('music-gen') ? React.createElement('label', { className: 'iris-pm-note' }, '音乐协议 ',
            React.createElement('select', { value: m.musicProtocol || '', onChange: function (e) { setMusicProtocol(m, e.target.value); } },
              React.createElement('option', { value: '' }, '请选择音乐协议'),
              React.createElement('option', { value: 'gemini-web-music' }, 'Chat Completions（内嵌音频）'))) : null,
          !m.directoryOnly && (caps.includes('vision') || (caps.includes('image-gen') && m.imageRouting && m.imageRouting.editSupported)) ? React.createElement(VisionInputEditor, { key: 'vision-input', provider: p, model: m,
            onNote: props.onNote, onDone: props.onDone }) : null,
          blocked ? React.createElement('span', { className: 'iris-pm-ver failed ' + healthClass(blocked), title: healthText(blocked) }, rateLimitLabel(blocked)) : null,
          !m.directoryOnly ? React.createElement('button', { className: 'iris-pm-btn danger', title: '从池移除', onClick: function () { props.removeModel(p, m); } }, '✕') : null);
      });
      return React.createElement('div', { className: 'iris-pm-pool' },
        React.createElement('div', { className: 'iris-pm-note' }, '模型池（' + models.filter(function (m) { return !m.directoryOnly; }).length + '）'
          + (models.some(function (m) { return m.directoryOnly; }) ? ' · 目录待确认 ' + models.filter(function (m) { return m.directoryOnly; }).length + ' 项' : '') + '：'),
        rows.length ? React.createElement('div', { className: 'iris-pm-mrows' }, rows) : React.createElement('div', { className: 'iris-pm-note' }, '暂无模型 — 展开「模型目录」同步，或在下方手动添加'),
        React.createElement(ModelUsageForm, { provider: p, setupSuggested: props.setupSuggested,
          onNote: props.onNote, onDone: props.onDone }));
    }

    function ModelUsageForm(props) {
      var namePair = React.useState(props.model ? props.model.id : '');
      var capsPair = React.useState(props.model ? (props.model.capabilities || []).slice() : []);
      var autoPair = React.useState(!props.model && props.setupSuggested === true);
      var musicPair = React.useState(props.model && props.model.musicProtocol || '');
      var savingPair = React.useState(false);
      var selected = capsPair[0];
      var saving = savingPair[0];
      function save() {
        if (saving) return;
        if (!namePair[0].trim()) { props.onNote('请填写模型名称'); return; }
        if (selected.includes('music-gen') && !musicPair[0]) { props.onNote('请先选择该模型实际支持的音乐协议'); return; }
        savingPair[1](true);
        postAction('providers_confirm_model', { id: props.provider.id, model_id: namePair[0].trim(), capabilities: selected,
          enableAutomatic: autoPair[0], ...(selected.includes('music-gen') ? { musicProtocol: musicPair[0] } : {}) })
          .then(function (r) {
            if (r.ok) {
              if (!props.model) namePair[1]('');
              props.onNote(r.d.text || '模型用途已确认');
              props.onDone();
              window.dispatchEvent(new CustomEvent('iris-function-configuration-changed'));
            } else props.onNote(r.d.error || '保存失败');
          }).catch(function () { props.onNote('无法保存，请检查与宿主的连接');
          }).finally(function () { savingPair[1](false); });
      }
      return React.createElement('div', { className: 'iris-pm-card' },
        !props.model ? React.createElement('label', { className: 'iris-pm-field' }, '模型名称',
          React.createElement('input', { value: namePair[0], placeholder: '发现后选模型，或填写服务提供的模型名',
            onChange: function (e) { namePair[1](e.target.value); } })) : null,
        React.createElement('div', { className: 'iris-pm-note' }, '确认此模型用于哪些功能；名称和文字接口本身不证明媒体能力。'),
        React.createElement('div', { className: 'iris-wb-row' },
        CAP_ROWS.map(function (row) {
          return React.createElement('label', { key: row.cap, className: 'iris-pm-note' },
            React.createElement('input', { type: 'checkbox', value: row.cap, checked: selected.includes(row.cap), disabled: saving,
              onChange: function (e) {
                var checked = e.target.checked;
                capsPair[1](function (previous) {
                  return checked ? previous.filter(function (cap) { return cap !== row.cap; }).concat(row.cap)
                    : previous.filter(function (cap) { return cap !== row.cap; });
                });
              } }), row.label);
        })),
        selected.includes('music-gen') ? React.createElement('label', { className: 'iris-pm-note' }, '音乐协议 ',
          React.createElement('select', { value: musicPair[0], onChange: function (e) { musicPair[1](e.target.value); } },
            React.createElement('option', { value: '' }, '请选择音乐协议'),
            React.createElement('option', { value: 'gemini-web-music' }, 'Chat Completions（内嵌音频）'))) : null,
        React.createElement('label', { className: 'iris-pm-note' }, React.createElement('input', {
          type: 'checkbox', checked: autoPair[0], onChange: function (e) { autoPair[1](e.target.checked); }
        }), '同时启用所选功能的自动池（替换这些功能当前的调用方式，保留原手工名单）'),
        React.createElement('button', { className: 'iris-pm-btn', disabled: saving, onClick: save }, saving ? '保存中…' : '保存模型用途'));
    }

    function ModelCapabilityEditor(props) {
      var openPair = React.useState(false);
      if (!openPair[0]) return React.createElement('button', { className: 'iris-pm-btn', title: '确认模型用途，加入功能池',
        onClick: function () { openPair[1](true); } }, '设置功能');
      return React.createElement('div', {},
        React.createElement(ModelUsageForm, { provider: props.provider, model: props.model, onNote: props.onNote,
          onDone: function () { openPair[1](false); props.onDone(); } }),
        React.createElement('button', { className: 'iris-pm-btn', onClick: function () { openPair[1](false); } }, '取消'));
    }

    function VisionInputEditor(props) {
      var p = props.provider;
      var m = props.model;
      var limits = (m ? m.visionInput : p.visionInput) || {};
      var bytesPair = React.useState(limits.maxBytes === undefined ? '' : String(limits.maxBytes / 1048576));
      var dimensionPair = React.useState(limits.maxDimension === undefined ? '' : String(limits.maxDimension));
      React.useEffect(function () {
        bytesPair[1](limits.maxBytes === undefined ? '' : String(limits.maxBytes / 1048576));
        dimensionPair[1](limits.maxDimension === undefined ? '' : String(limits.maxDimension));
      }, [limits.maxBytes, limits.maxDimension]);
      function save(reset) {
        var value = {};
        if (bytesPair[0] !== '') value.maxBytes = Number(bytesPair[0]) * 1048576;
        if (dimensionPair[0] !== '') value.maxDimension = Number(dimensionPair[0]);
        if (!reset && Object.values(value).some(function (number) { return !Number.isSafeInteger(number) || number <= 0; })) {
          props.onNote('请输入正数 MiB 和正整数像素'); return;
        }
        var action = m ? 'providers_set_model_vision_input' : 'providers_upsert';
        postAction(action, { id: p.id, ...(m ? { model_id: m.id } : {}), visionInput: reset ? null : value })
          .then(function (r) { props.onNote(r.ok ? '视觉输入预算已更新' : (r.d.error || '更新失败')); if (r.ok) props.onDone(); });
      }
      return React.createElement('div', { className: 'iris-pm-field' },
        React.createElement('label', {}, m ? '模型视觉预算（留空继承账号）' : '账号视觉预算（留空使用默认 8 MiB）'),
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('input', { type: 'number', min: '0', step: 'any', 'aria-label': '视觉大小上限 MiB',
            placeholder: 'MiB', value: bytesPair[0], onChange: function (e) { bytesPair[1](e.target.value); } }),
          React.createElement('input', { type: 'number', min: '1', step: '1', 'aria-label': '视觉最长边像素',
            placeholder: '最长边 px（可选）', value: dimensionPair[0], onChange: function (e) { dimensionPair[1](e.target.value); } }),
          React.createElement('button', { className: 'iris-pm-btn', onClick: function () { save(false); } }, '保存预算'),
          React.createElement('button', { className: 'iris-pm-btn', onClick: function () { save(true); } }, '恢复继承')),
        React.createElement('span', { className: 'iris-pm-note' }, '用于看图、OCR 每块输入、定位和改图的发送副本。作品原图保留，定位结果换算回原图。'));
    }

    function ProviderDirectory(props) {
      var p = props.provider, directory = p.directory || { status: 'unknown' };
      var busyPair = React.useState(false), notePair = React.useState(''), running = React.useRef(false);
      function synchronize() {
        if (running.current || !p.directory) return;
        running.current = true; busyPair[1](true); notePair[1]('');
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 90000);
        postAction('providers_sync_directory', { id: p.id, force: true }, { signal: controller.signal }).then(function (r) {
          if (!r.ok || !r.d || r.d.ok !== true || typeof r.d.synced !== 'boolean') {
            notePair[1]('同步结果未确认，请刷新状态查看。' + (r.d && r.d.error ? ' ' + String(r.d.error) : '')); return;
          }
          notePair[1](r.d.text || (r.d.synced ? '模型目录已同步' : '目录同步失败，保留上次完整目录'));
          props.onDone();
        }).catch(function () { notePair[1]('同步结果未确认，请刷新状态查看；本次没有发起模型生成。'); })
          .finally(function () { clearTimeout(timer); running.current = false; busyPair[1](false); });
      }
      var summary = busyPair[0] ? '正在同步…' : directory.checkedAt
        ? (directory.status === 'stale' ? '缓存待更新' : '已同步') + ' · ' + directory.modelCount + ' 个模型 · 目录未列出 ' + (directory.missing || []).length + ' 项'
        : '尚未同步';
      return React.createElement('details', { className: 'iris-pm-field', 'data-provider-directory': p.id, 'aria-busy': busyPair[0] },
        React.createElement('summary', { className: 'iris-pm-note' }, '模型目录 · ' + summary),
        React.createElement('div', { className: 'iris-wb-row' },
          React.createElement('span', { className: 'iris-pm-note' }, directory.checkedAt ? '上次同步：' + new Date(directory.checkedAt).toLocaleString() : '目录与模型用途分别保存'),
          React.createElement('button', { className: 'iris-pm-btn', disabled: busyPair[0] || !p.directory || !p.enabled,
            onClick: synchronize }, busyPair[0] ? '正在同步…' : '同步目录')),
        !p.directory ? React.createElement('p', { className: 'iris-pm-note' }, '请先让 DSH 加载新版 Iris，再同步目录。') : null,
        directory.error && !notePair[0] ? React.createElement('p', { className: 'iris-pm-note', role: 'status' }, '上次同步未完成，保留旧目录：' + directory.error) : null,
        notePair[0] ? React.createElement('p', { className: 'iris-pm-note', role: 'status' }, notePair[0]) : null,
        React.createElement('p', { className: 'iris-pm-note' }, '同步只读取供应商目录，新模型仍需确认用途。目录未列出不等于下线；实测与生成需单独发起。'),
        (directory.added || []).length ? React.createElement('p', { className: 'iris-pm-note' }, '本次新增：' + directory.added.slice(0, 5).join('、')
          + (directory.added.length > 5 ? ' 等 ' + directory.added.length + ' 项，完整条目见下方列表' : '')) : null,
        (directory.missing || []).length ? React.createElement('p', { className: 'iris-pm-note' }, '目录未列出：' + directory.missing.slice(0, 5).join('、')
          + (directory.missing.length > 5 ? ' 等 ' + directory.missing.length + ' 项，原配置继续保留' : '')) : null);
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
      var hostConnections = React.useState([]);
      var hostChoice = React.useState('');
      var setupPair = React.useState(false);
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      function refresh() {
        postAction('providers_list', {}).then(function (r) { if (r.ok && r.d.providers) {
          setList(r.d.providers); setupPair[1](r.d.setupSuggested === true);
        } });
      }
      function loadHostConnections() {
        postAction('providers_host_connections', {}).then(function (r) {
          if (r.ok) { hostConnections[1](r.d.connections || []); if (r.d.note) setNote(r.d.note); }
          else setNote(r.d.error || '无法读取 DSH 连接');
        });
      }
      React.useEffect(function () {
        refresh();
        var timer = setInterval(refresh, 5000);
        return function () { clearInterval(timer); };
      }, []);
      function addProvider() {
        var f = newForm[0];
        if (hostChoice[0]) {
          var connection = hostConnections[0].find(function (item) { return JSON.stringify([item.settingsNs, item.provider]) === hostChoice[0]; });
          if (!connection || !connection.available) { setNote('请重新选择可用的 DSH 连接'); return; }
          postAction('providers_upsert', { name: f.name || connection.name, type: 'openai', enabled: true,
            mediaProtocol: f.mediaProtocol, dshProvider: { provider: connection.provider, settingsNs: connection.settingsNs } })
            .then(function (r) {
              if (r.ok) { setAdding(false); openPair[1](r.d.providerId); setNote('已引用 DSH 连接，请在下方确认模型用途，即可启用自动池'); refresh(); }
              else setNote(r.d.error || '添加失败');
            });
          return;
        }
        if (!f.baseUrl || !f.apiKey) { setNote('baseUrl 和 apiKey 必填'); return; }
        postAction('providers_upsert', f).then(function (r) {
          if (r.ok) { setAdding(false); openPair[1](r.d.providerId); setNote('已连接，请在下方确认模型用途'); refresh(); }
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
      function testModel(p, m, capability) {
        window.dispatchEvent(new CustomEvent('iris-capability-inspect', {
          detail: { capability: capability, providerId: p.id, modelId: m.id }
        }));
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
      var cards = (list || []).map(function (p) {
        var open = openPair[0] === p.id;
        var body = null;
        if (open) {
          body = React.createElement('div', { className: 'iris-pm-body', id: 'iris-provider-' + p.id },
            React.createElement('div', { className: 'iris-pm-note' }, 'Key ' + (p.apiKeyHint || '未配置') + ' · ' + (p.type || '') + ' · ' + (p.mediaProtocol || '')),
            p.dshProvider ? React.createElement('div', { className: 'iris-pm-note' }, '引用 DSH：' + p.dshProvider.provider
              + ' · 地址和密钥由宿主管理；' + (p.connection && p.connection.available ? '连接可用' : ((p.connection && p.connection.reason) || '连接不可用'))) : null,
            p.protocolInferred ? React.createElement('div', { className: 'iris-pm-note' }, '协议为推断值，请确认') : null,
            React.createElement(ProviderEndpointEditor, { provider: p, onNote: setNote, onDone: refresh }),
            React.createElement(VisionInputEditor, { provider: p, onNote: setNote, onDone: refresh }),
            React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体协议'), React.createElement('select', { value: p.protocolInferred ? 'auto' : (p.mediaProtocol || 'auto'), onChange: function (e) { setProtocol(p, e.target.value); } },
              React.createElement('option', { value: 'auto' }, '自动'),
              p.mediaProtocol && !['dashscope', 'openai-images', 'openai-chat-images', 'openai-responses-images', 'auto'].includes(p.mediaProtocol) ? React.createElement('option', { value: p.mediaProtocol }, p.mediaProtocol + '（未支持）') : null,
              React.createElement('option', { value: 'dashscope' }, 'DashScope（仅阿里云官方 HTTPS）'),
              React.createElement('option', { value: 'openai-images' }, 'OpenAI Images 兼容'),
              React.createElement('option', { value: 'openai-chat-images' }, '聊天生图（网关兼容）'),
              React.createElement('option', { value: 'openai-responses-images' }, 'Responses 生图'))),
            React.createElement('div', { className: 'iris-pm-note' }, '能力: ' + ((p.capabilities || []).join(' / ') || '无')),
            React.createElement(ProviderDirectory, { provider: p, onDone: refresh }),
            React.createElement(ModelPool, { provider: p, setupSuggested: setupPair[0], onNote: setNote, onDone: refresh, testModel: testModel, removeModel: removeModel }),
            React.createElement('div', { className: 'iris-wb-row' },
              React.createElement('button', { className: 'iris-pm-btn', onClick: function () { toggle(p); } }, p.enabled ? '停用' : '启用'),
              React.createElement('button', { className: 'iris-pm-btn danger', onClick: function () { remove(p); } }, '删除')));
        }
        return React.createElement('div', { key: p.id, className: 'iris-pm-card' + (open ? ' open' : '') },
          React.createElement('button', { type: 'button', className: 'iris-pm-top', 'aria-expanded': open, 'aria-controls': 'iris-provider-' + p.id,
            onClick: function () { setOpen(open ? null : p.id); } },
            React.createElement('span', { className: 'iris-pm-name' }, (p.name || p.id) + (p.enabled ? '' : '（停用）')),
            React.createElement('span', { className: 'iris-pm-btn' }, open ? '收起' : '管理')),
          body);
      });
      var addBlock = null;
      if (adding) {
        addBlock = React.createElement('div', { className: 'iris-pm-card' },
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '连接来源'),
            React.createElement('select', { value: hostChoice[0], onChange: function (e) { hostChoice[1](e.target.value); } },
              React.createElement('option', { value: '' }, '手动填写供应商'),
              hostConnections[0].map(function (connection) { return React.createElement('option', {
                key: JSON.stringify([connection.settingsNs, connection.provider]), value: JSON.stringify([connection.settingsNs, connection.provider]), disabled: !connection.available
              }, 'DSH · ' + connection.name + (connection.available ? '' : '（' + connection.reason + '）')); }))),
          hostChoice[0] ? React.createElement('div', { className: 'iris-pm-note' }, '地址与密钥随 DSH 连接更新，不保存密钥副本。请选择该服务实际支持的媒体协议；模型能力仍需明确配置。') : null,
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '名称'), React.createElement('input', { value: newForm[0].name, placeholder: '如 阿里云百炼', onChange: function (e) { newForm[1]({ ...newForm[0], name: e.target.value }); } })),
          !hostChoice[0] ? React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, 'Base URL *'), React.createElement('input', { value: newForm[0].baseUrl, placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1', onChange: function (e) { newForm[1]({ ...newForm[0], baseUrl: e.target.value }); } })) : null,
          !hostChoice[0] ? React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体 Base URL（可选）'), React.createElement('input', { value: newForm[0].mediaBaseUrl, placeholder: 'Workspace 媒体端点；留空沿用 Base URL', onChange: function (e) { newForm[1]({ ...newForm[0], mediaBaseUrl: e.target.value }); } })) : null,
          !hostChoice[0] ? React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, 'API Key *'), React.createElement('input', { type: 'password', value: newForm[0].apiKey, placeholder: 'sk-...', onChange: function (e) { newForm[1]({ ...newForm[0], apiKey: e.target.value }); } })) : null,
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, '媒体协议'), React.createElement('select', { value: newForm[0].mediaProtocol, onChange: function (e) { newForm[1]({ ...newForm[0], mediaProtocol: e.target.value }); } },
            React.createElement('option', { value: 'auto' }, hostChoice[0] ? '请选择该服务支持的媒体协议' : '自动（按媒体 Base URL 安全判断）'),
            React.createElement('option', { value: 'dashscope' }, 'DashScope（阿里云官方）'),
            React.createElement('option', { value: 'openai-images' }, 'OpenAI Images 兼容'),
            React.createElement('option', { value: 'openai-chat-images' }, '聊天生图（网关兼容）'),
            React.createElement('option', { value: 'openai-responses-images' }, 'Responses 生图'))),
          React.createElement('div', { className: 'iris-wb-row' },
            React.createElement('button', { className: 'iris-act-run', onClick: addProvider }, '保存'),
            React.createElement('button', { className: 'iris-pm-btn', onClick: function () { setAdding(false); } }, '取消')));
      }
      return React.createElement('div', { className: 'iris-pm' },
        React.createElement('div', { className: 'iris-pm-head' },
          React.createElement('span', { className: 'iris-wb-muted' }, (list ? list.length : 0) + ' 个供应商'),
          React.createElement('button', { className: 'iris-pm-add', onClick: function () { if (!adding) { hostChoice[1](''); loadHostConnections(); } setAdding(!adding); } }, adding ? '收起' : '+ 添加供应商')),
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
      function loadModels(event) {
        if (!capability) return;
        var snapshot = event && event.detail && event.detail.functionAssignments;
        (snapshot ? Promise.resolve({ ok: true, d: snapshot }) : postAction('assignments_get', {})).then(function (r) {
          if (!r.ok || !r.d) return;
          var opts = (r.d.poolByCapability && r.d.poolByCapability[capability]) || [];
          var ord = (r.d.order && r.d.order[capability]) || [];
          opts = ord.map(function (ref) { return opts.find(function (option) { return option.ref === ref; }); }).filter(Boolean);
          var assignedRef = ord[0] || '';
          var assignedOpt = opts.find(function (o) { return o.ref === assignedRef; });
          // 不再自动填 vals.model：留空 = 用能力分配的解析结果（避免绕过分配）
          setModelInfo({ assigned: assignedOpt ? assignedOpt.label : '', assignedRef: assignedRef, options: opts, loaded: true,
            mode: r.d.policies && r.d.policies[capability] && r.d.policies[capability].mode,
            readiness: r.d.readiness && r.d.readiness[capability] });
        });
      }
      React.useEffect(function () {
        if (!open || !capability) return;
        loadModels();
        window.addEventListener('iris-function-configuration-changed', loadModels);
        return function () { window.removeEventListener('iris-function-configuration-changed', loadModels); };
      }, [open]);
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
            setRun(res.ok ? { ok: true, text: res.d.text || '', img: res.d.imageUrl || res.d.imageDataUrl || null, audio: res.d.audioUrl || null } : { ok: false, text: res.d.error || '执行失败' });
            if (res.ok && res.d && res.d.storage === 'core') window.dispatchEvent(new CustomEvent('iris-core-artifacts-changed'));
          })
          .catch(function () { setRun({ ok: false, text: '网络错误' }); });
      }
      var cardHealth = capability ? capabilityHealth(irisState, capability) : { status: 'verified' };
      // Host references can be ready without raw endpoint/key fields in the state snapshot.
      if (modelInfo && modelInfo.readiness) {
        if (modelInfo.mode === 'disabled') cardHealth = { status: 'unconfigured' };
        else if (modelInfo.readiness.candidateCount > 0 && cardHealth.status === 'unconfigured') cardHealth = { status: 'configured' };
      }
      var body = null;
      if (open) {
        var inputs = fields.map(function (f) {
          var node;
          if (f.key === 'model' && capability) {
            node = React.createElement('select', { value: vals.model || '', onChange: function (e) { setVal('model', e.target.value); } },
              React.createElement('option', { value: '' }, modelInfo && modelInfo.mode === 'auto' ? '按功能池顺序自动选择' : '按所选模型顺序'),
              ((modelInfo && modelInfo.options) || []).map(function (option) {
                return React.createElement('option', { key: option.ref, value: option.ref, disabled: option.unavailable }, option.label + (option.unavailable ? ' · 当前不可用' : ''));
              }));
            return React.createElement('div', { key: f.key, className: 'iris-act-field' }, React.createElement('label', {}, f.label), node);
          }
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
          } else if (run.ok && run.audio) {
            result = React.createElement('div', { className: 'iris-act-result' }, React.createElement('div', {}, run.text),
              React.createElement('audio', { src: run.audio, controls: true, preload: 'metadata' }),
              React.createElement('a', { href: run.audio, download: '' }, '下载音乐'));
          } else {
            result = React.createElement('div', { className: 'iris-act-result' + (run.ok ? '' : ' err') }, run.text);
          }
        }
        // 只读模型提示：当前能力解析到的模型与持久健康事实。
        var modelBar = null;
        if (capability) {
          var available = modelInfo && modelInfo.loaded && (modelInfo.readiness ? modelInfo.readiness.candidateCount > 0 : modelInfo.options.length > 0);
          var shown = (vals.model && vals.model.trim()) || (modelInfo && modelInfo.assigned) || '';
          modelBar = React.createElement('div', { className: 'iris-act-field' },
            React.createElement('label', {},
              React.createElement('span', { className: 'iris-pm-dot ' + healthClass(cardHealth) }, cardHealth.retryAt ? '◷' : HEALTH_META[cardHealth.status].symbol),
              ' 模型：' + (shown || '未分配') + (available ? '' : '（无可用模型）')),
            React.createElement('div', { className: 'iris-wb-muted' },
              (modelInfo && modelInfo.readiness ? modelInfo.readiness.candidateCount + ' 个候选 · ' + (modelInfo.readiness.note || '实际权限以调用结果为准') : healthText(cardHealth))
                + ' · 调整方式 → 上方「功能池与调用方式」'));
        }
        body = React.createElement('div', { className: 'iris-act-body' },
          modelBar,
          inputs,
          React.createElement('button', { className: 'iris-act-run', disabled: run === 'running', onClick: submit },
            run === 'running' ? '执行中…' : (props.submitLabel || '执行')),
          result);
      }
      var headStatus = capability ? cardHealth.status : 'verified';
      var headTitle = capability ? healthText(cardHealth) : '本地功能';
      return React.createElement('div', {
        className: 'iris-act-card' + (open ? ' open' : '') + (capability ? ' health-' + headStatus : ''), 'data-iris-action': action
      },
        React.createElement('div', { className: 'iris-act-head', onClick: function () { setOpen(!open); } },
          React.createElement('span', { className: 'iris-act-title' }, title),
          capability ? React.createElement('span', {
            className: 'iris-pm-dot ' + healthClass(cardHealth),
            title: headTitle
          }, cardHealth.retryAt ? '◷' : HEALTH_META[headStatus].symbol) : null,
          React.createElement('span', { className: 'iris-act-arrow' }, '▶')),
        body);
    }

    /* ---- 操作卡片注册表（单一来源：设置页全量 / 泡泡常用子集 / 选择器三处共用） ---- */
    var CARD_DEFS = [
      { action: 'image_import', title: '📥 导入图片', submitLabel: '保存到作品', fields: [
        { key: 'image_path', label: '图片（静态 PNG/JPEG/WebP，最大20 MiB；保存副本，保留原文件）', type: 'file', accept: 'image/png,image/jpeg,image/webp' }] },
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
      { action: 'music', title: '🎵 音乐生成', capability: 'music-gen', fields: [
        { key: 'prompt', label: '音乐描述', type: 'textarea', placeholder: '描述风格、情绪、乐器；歌词、演唱语言和期望时长也可写在这里' },
        { key: 'model', label: '音乐模型' },
        { key: 'timeout_ms', label: '单次等待上限（毫秒，可选）', type: 'number', placeholder: '300000' },
        { key: 'retry_502', label: '502重新生成次数（可选，会额外占用调用额度）', type: 'number', placeholder: '2（0关闭，最多5）' },
        { key: 'retry_delay_ms', label: '重试等待（毫秒，可选）', type: 'number', placeholder: '5000' }] },
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
      { cap: 'music-gen', label: '🎵 音乐' },
      { cap: 'transcribe', label: '🎙️ 转写' },
      { cap: 'vision', label: '👁 视觉' }
    ];
    function CapabilityAssigner() {
      var dataPair = React.useState(null), data = dataPair[0], setData = dataPair[1];
      var notePair = React.useState('');
      var feedbackPair = React.useState({}), feedback = feedbackPair[0];
      var busyPair = React.useState(null), busy = busyPair[0];
      var loadingPair = React.useState(false), loading = loadingPair[0];
      var confirmPair = React.useState(null), confirmation = confirmPair[0];
      var saving = React.useRef(false), readVersion = React.useRef(0);
      var labels = { auto: '按功能自动选择', manual: '仅用所选模型', disabled: '停用' };
      function compatible(snapshot) {
        return !!(snapshot && snapshot.policies && snapshot.readiness && CAP_ROWS.every(function (row) {
          return snapshot.policies[row.cap] && ['auto', 'manual', 'disabled'].includes(snapshot.policies[row.cap].mode) && snapshot.readiness[row.cap];
        }));
      }
      function setFeedback(cap, value) {
        feedbackPair[1](function (previous) { return { ...previous, [cap]: value }; });
      }
      function request(action, body) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 10000);
        return postAction(action, body, { signal: controller.signal }).finally(function () { clearTimeout(timer); });
      }
      function load(event) {
        var version = ++readVersion.current;
        var shared = event && event.detail && event.detail.functionAssignments;
        if (shared) { setData(shared); loadingPair[1](false); return Promise.resolve(shared); }
        loadingPair[1](true);
        return request('assignments_get', {}).then(function (r) {
          if (version !== readVersion.current) return null;
          if (!r.ok || !r.d || r.d.ok !== true) throw new Error(r.d && r.d.error || '无法读取功能池');
          setData(r.d); notePair[1](''); return r.d;
        }).catch(function (error) {
          if (version === readVersion.current) notePair[1](error.name === 'AbortError' ? '读取状态超时，请重新检查' : '无法读取功能池，请检查与宿主的连接');
          return null;
        }).finally(function () { if (version === readVersion.current) loadingPair[1](false); });
      }
      React.useEffect(function () {
        load();
        window.addEventListener('iris-function-configuration-changed', load);
        return function () { window.removeEventListener('iris-function-configuration-changed', load); };
      }, []);
      function update(body) {
        if (saving.current || !compatible(data)) return;
        saving.current = true; busyPair[1](body.capability); confirmPair[1](null);
        ++readVersion.current; // A read started before this write cannot overwrite its result.
        loadingPair[1](false);
        var desired = body.mode || (body.model_refs.length ? 'manual' : 'disabled');
        setFeedback(body.capability, { phase: 'saving', message: '正在保存…' });
        request('assignments_set', body).then(function (r) {
          if (!r.ok || !r.d || r.d.ok !== true) throw new Error(r.d && r.d.error || '未收到保存确认，请刷新状态核对');
          if ((body.mode && r.d.mode !== body.mode) || !Array.isArray(r.d.model_refs)) {
            setData(function (previous) { return { ...previous, policies: null, readiness: null }; });
            throw new Error('服务端未确认新策略，请重启 DSH 后刷新页面');
          }
          setData(function (previous) { return { ...previous,
            policies: { ...previous.policies, [body.capability]: { ...previous.policies[body.capability], mode: desired,
              ...(body.hostVision !== undefined ? { hostVision: body.hostVision } : {}) } },
            order: { ...previous.order, [body.capability]: r.d.model_refs }
          }; });
          setFeedback(body.capability, { phase: 'refreshing', message: '已保存为“' + labels[desired] + '”，正在更新候选…' });
          return load().then(function (snapshot) {
            if (!snapshot) {
              setFeedback(body.capability, { phase: 'saved-stale', message: '已保存为“' + labels[desired] + '”，候选未能刷新，请核对状态' });
              return;
            }
            var policy = snapshot.policies && snapshot.policies[body.capability];
            var confirmed = compatible(snapshot) && policy.mode === desired
              && (body.hostVision === undefined || policy.hostVision === body.hostVision);
            setFeedback(body.capability, confirmed
              ? { phase: 'saved', message: '已保存：' + labels[desired] + ' · ' + snapshot.readiness[body.capability].candidateCount + ' 个可用候选' }
              : { phase: 'unknown', message: '读取的状态与本次选择不一致，请核对服务端状态' });
            window.dispatchEvent(new CustomEvent('iris-function-configuration-changed', { detail: { functionAssignments: snapshot } }));
          });
        }).catch(function (error) {
          setFeedback(body.capability, { phase: 'unknown', message: error.name === 'AbortError'
            ? '未收到保存确认，请刷新状态核对，暂勿重复提交' : error.message || '保存结果未确认，请刷新状态核对' });
        }).finally(function () { saving.current = false; busyPair[1](null); });
      }
      function check(cap) {
        if (saving.current) return;
        return load().then(function (snapshot) {
          if (compatible(snapshot)) setFeedback(cap, { phase: 'saved', message: '当前已保存：' + labels[snapshot.policies[cap].mode]
            + ' · ' + snapshot.readiness[cap].candidateCount + ' 个可用候选' });
        });
      }
      function save(cap, refs) { update({ capability: cap, model_refs: refs }); }
      if (!data) return React.createElement('div', { className: 'iris-wb-muted', role: 'status' },
        notePair[0] || '加载功能池…', notePair[0] ? React.createElement('button', { className: 'iris-pm-btn', disabled: loading,
          onClick: function () { load(); } }, loading ? '正在检查…' : '重新检查') : null);
      var supported = compatible(data);
      var order = data.order || {}, poolBy = data.poolByCapability || {};
      return React.createElement('div', { className: 'iris-cap-grid' },
        !supported ? React.createElement('div', { className: 'iris-cap-compatibility', role: 'alert' },
          '当前服务端尚未加载功能池策略，已暂停切换。请重启 DSH 后刷新页面；仅刷新页面无法更新服务端。',
          React.createElement('button', { className: 'iris-pm-btn', disabled: loading,
            onClick: function () { load(); } }, loading ? '正在检查…' : '重新检查服务端')) : null,
        CAP_ROWS.map(function (row) {
          var policy = data.policies && data.policies[row.cap] || { mode: (order[row.cap] || []).length ? 'manual' : 'disabled', models: order[row.cap] || [] };
          var mode = policy.mode;
          var list = order[row.cap] || [];
          var opts = poolBy[row.cap] || [];
          var status = data.readiness && data.readiness[row.cap];
          var available = opts.filter(function (o) { return list.indexOf(o.ref) < 0; });
          var message = feedback[row.cap];
          var blocked = !supported || !!busy || (message && message.phase === 'unknown');
          function setMode(value, hostVision) {
            if (blocked || saving.current) return;
            var body = { capability: row.cap, mode: value,
              ...(row.cap === 'vision' ? { hostVision: hostVision === undefined ? policy.hostVision === true : hostVision } : {}) };
            if (value === 'auto' && mode !== 'auto') {
              var count = opts.filter(function (o) { return !o.unavailable && !o.pendingConfirmation
                && (o.ref !== 'host:current-vision' || policy.hostVision === true); }).length;
              setFeedback(row.cap, null);
              confirmPair[1]({ cap: row.cap, body: body, count: count }); return;
            }
            update(body);
          }
          var chips = list.map(function (ref, i) {
            var opt = opts.find(function (o) { return o.ref === ref; });
            return React.createElement('span', { key: ref, className: 'iris-cap-chip' },
              React.createElement('b', {}, (i + 1) + '.'),
              opt ? opt.label + (opt.unavailable ? ' · ' + (opt.reason || '当前不可用') : '') : ref + ' · 配置已失效',
              mode === 'manual' && i > 0 ? React.createElement('button', { className: 'iris-pm-btn', title: '上移', disabled: blocked,
                onClick: function () { var n = list.slice(); var t = n.splice(i, 1)[0]; n.splice(i - 1, 0, t); save(row.cap, n); }
              }, '↑') : null,
              mode === 'manual' && i < list.length - 1 ? React.createElement('button', { className: 'iris-pm-btn', title: '下移', disabled: blocked,
                onClick: function () { var n = list.slice(); var t = n.splice(i, 1)[0]; n.splice(i + 1, 0, t); save(row.cap, n); }
              }, '↓') : null,
              mode === 'manual' ? React.createElement('button', { className: 'iris-pm-btn danger', title: '移出列表', disabled: blocked,
                onClick: function () { save(row.cap, list.filter(function (x) { return x !== ref; })); }
              }, '✕') : null);
          });
          return React.createElement('div', { key: row.cap, className: 'iris-cap-row', 'data-function': row.cap, 'aria-busy': busy === row.cap },
            React.createElement('span', { className: 'iris-cap-name' }, row.label),
            React.createElement('select', { 'aria-label': row.cap + ' 调用方式', value: confirmation && confirmation.cap === row.cap ? 'auto' : mode, disabled: blocked,
              onChange: function (e) { setMode(e.target.value); } },
              React.createElement('option', { value: 'auto' }, '按功能自动选择'),
              React.createElement('option', { value: 'manual' }, '仅用所选模型'),
              React.createElement('option', { value: 'disabled' }, '停用')),
            status && !(confirmation && confirmation.cap === row.cap) && !(message && ['saving', 'refreshing', 'saved-stale', 'unknown'].includes(message.phase)) ? React.createElement('span', { className: 'iris-pm-note', title: '候选来自配置和连接元数据；实际接口权限以调用结果为准' },
              status.candidateCount + ' 个可用候选' + (status.note ? ' · ' + status.note : '')) : null,
            confirmation && confirmation.cap === row.cap ? React.createElement('div', { className: 'iris-cap-confirm', role: 'group', 'aria-label': '确认自动选择' },
              React.createElement('div', {}, '尚未保存：将启用按功能自动选择，当前有 ' + confirmation.count + ' 个已确认候选。保留原手工名单；未确认的新发现模型不会自动调用。'),
              React.createElement('button', { className: 'iris-pm-btn', disabled: !!busy, onClick: function () { update(confirmation.body); } }, '确认启用自动池'),
              React.createElement('button', { className: 'iris-pm-btn', disabled: !!busy, onClick: function () { confirmPair[1](null); } }, '取消')) : null,
            message ? React.createElement('div', { className: 'iris-cap-feedback ' + message.phase, role: message.phase === 'unknown' ? 'alert' : 'status', 'aria-live': 'polite' },
              message.message, ['unknown', 'saved-stale'].includes(message.phase) ? React.createElement('button', { className: 'iris-pm-btn', disabled: !!busy || loading,
                onClick: function () { check(row.cap); } }, loading ? '正在核对…' : '刷新状态') : null) : null,
            mode === 'auto' ? React.createElement('span', { className: 'iris-pm-note' }, '按池顺序选择；确认模型用途后自动加入，无需再次分配。') : null,
            mode === 'auto' && row.cap === 'vision' ? React.createElement('label', { className: 'iris-pm-note' },
              React.createElement('input', { type: 'checkbox', checked: policy.hostVision === true, disabled: blocked,
                onChange: function (e) { setMode('auto', e.target.checked); } }),
              '使用DSH当前视觉模型（执行前核对图片能力）') : null,
            chips,
            mode === 'manual' && available.length ? React.createElement('select', { className: 'iris-pm-model-sel', value: '', disabled: blocked,
              onChange: function (e) { if (e.target.value) save(row.cap, list.concat([e.target.value])); } },
              React.createElement('option', { value: '' }, '+ 分配模型'),
              available.map(function (o) { return React.createElement('option', { key: o.ref, value: o.ref }, o.label); })) : null,
            mode === 'manual' && list.length ? React.createElement('button', { className: 'iris-pm-btn', title: '清空分配后，该功能不再发起新调用', disabled: blocked,
              onClick: function () { save(row.cap, []); }
            }, '清空分配') : null);
        }),
        notePair[0] ? React.createElement('div', { className: 'iris-pm-note' }, notePair[0]) : null);
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
        return artifact.kind !== 'host-input';
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

    function galleryKindLabel(kind) {
      return ({ __proto__: null, 'imported-image': '导入图片', 'generated-image': '生成图片', 'generated-video': '生成视频', 'generated-audio': '生成音频',
        'tts-audio': '合成语音', transcript: '转写文本', 'video-frame': '视频帧', crop: '裁剪图片',
        'cropped-image': '裁剪图片', 'pixel-diff': '差异热图', 'diff-heatmap': '差异热图', 'html-screenshot': 'HTML 截图',
        'legacy-output': '旧版作品' })[kind] || kind;
    }

    function fetchWorkbenchJson(url, input, signal) {
      var options = { signal: signal };
      if (input) { options.method = 'POST'; options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(input); }
      return fetch(url, options).then(function (res) { return res.json().then(function (data) {
        if (!res.ok || data.ok === false) throw new Error((data.error || '作品操作失败') + (data.transactionId ? '（事务 ' + data.transactionId + '）' : ''));
        return data;
      }); });
    }
    function copyWorkbenchText(text, setNote) {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { setNote('请手动选择并复制 ID：\n' + text); return; }
      navigator.clipboard.writeText(text).then(function () { setNote('已复制'); }).catch(function () { setNote('请手动选择并复制 ID：\n' + text); });
    }
    function saveWorkbenchBlob(blob, name) {
      var url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }
    function deletionBlockerLabel(blocker) {
      return ({ __proto__: null, task_not_settled: '任务尚未结束或结果未知', task_artifact_reference: '被任务记录引用', task_input_reference: '被改图任务作为原图引用',
        artifact_task_reference: '该任务仍关联其他作品', retry_reference: '被后续重试任务引用',
        artifact_relation: '被其他作品引用', uncommitted_relation: '被尚未提交的产物引用' })[blocker.reason] || '仍有引用';
    }

    function WorkbenchManagement(props) {
      var type = props.type;
      var dataPair = React.useState(null), data = dataPair[0], setData = dataPair[1];
      var busyPair = React.useState(true), busy = busyPair[0], setBusy = busyPair[1];
      var writingPair = React.useState(false), writing = writingPair[0], setWriting = writingPair[1];
      var notePair = React.useState(''), note = notePair[0], setNote = notePair[1];
      var tasksPair = React.useState([]), taskIds = tasksPair[0], setTaskIds = tasksPair[1];
      var request = React.useRef(null), view = React.useRef(null);
      var artifactIds = (props.items || []).map(function (item) { return item.id; });
      function query(tasks) {
        if (request.current) request.current.abort();
        var controller = new AbortController(); request.current = controller; setBusy(true); setNote('');
        var url = type === 'details' ? '/iris/api/works/' + props.item.source + '/' + props.item.id
          : type === 'transactions' ? '/iris/api/works/transactions' : '/iris/api/works/delete';
        fetchWorkbenchJson(url, type === 'delete' ? { artifact_ids: artifactIds, task_ids: tasks || [] } : null, controller.signal)
          .then(function (value) { if (request.current === controller && !controller.signal.aborted) setData(value); })
          .catch(function (error) { if (request.current === controller && !controller.signal.aborted) { setData(null); setNote(error.message); } })
          .finally(function () { if (request.current === controller) { request.current = null; setBusy(false); } });
      }
      React.useEffect(function () {
        query([]);
        if (view.current) view.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return function () { if (request.current) request.current.abort(); request.current = null; };
      }, []);
      function chooseTask(id, checked) {
        var next = checked ? taskIds.concat(id) : taskIds.filter(function (value) { return value !== id; });
        setTaskIds(next); query(next);
      }
      function execute(transaction) {
        var restoring = type === 'transactions';
        var message = restoring ? '恢复事务 ' + transaction.transactionId + ' 中的 ' + transaction.files + ' 个文件？已有文件不会被覆盖。'
          : '将 ' + artifactIds.length + ' 个 Core 作品' + (taskIds.length ? '及 ' + taskIds.length + ' 个已结束任务记录' : '') + '移入回收区？之后可以恢复。';
        if (!window.confirm(message)) return;
        var controller = new AbortController(); request.current = controller;
        setWriting(true); setBusy(true); setNote(''); props.onBusy(true);
        fetchWorkbenchJson('/iris/api/works/' + (restoring ? 'restore' : 'delete'), restoring
          ? { transaction_id: transaction.transactionId, confirm_restore: true }
          : { artifact_ids: artifactIds, task_ids: taskIds, confirm_delete: true }, controller.signal)
          .then(function (value) {
            if (request.current !== controller || controller.signal.aborted) return;
            props.onChanged(value);
            if (restoring) query([]); else props.onClose();
          })
          .catch(function (error) { if (request.current === controller && !controller.signal.aborted) setNote(error.message); })
          .finally(function () {
            props.onBusy(false); setWriting(false);
            if (request.current === controller) { request.current = null; setBusy(false); }
          });
      }
      var item = data && data.item;
      var titles = { details: '作品详情', delete: '删除预览', transactions: 'Core 回收区' };
      return React.createElement('section', { ref: view, className: 'iris-gallery-management', 'aria-label': titles[type], 'aria-busy': busy },
        React.createElement('div', { className: 'iris-gallery-analysis-head' }, React.createElement('strong', {}, titles[type]),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: writing, onClick: props.onClose }, '关闭面板')),
        busy ? React.createElement('div', { role: 'status', className: 'iris-wb-muted' }, writing ? '正在处理…' : '正在读取…') : null,
        item ? React.createElement('dl', {}, [
          ['ID', item.id], ['来源', item.source === 'core' ? 'Core' : '旧版'], ['文件名', item.file], ['媒体类型', item.mime],
          ['产物类型', galleryKindLabel(item.kind)], ['大小', fmtBytes(item.size)], ['创建时间', fmtTime(item.createdAt)],
          ['内容核验', item.integrity === 'verified' ? 'SHA-256 已核验' : '文件存在；旧版没有已存哈希'],
          ['SHA-256', item.digest], ['关联', (item.relations || []).map(function (edge) { return edge.type + ' → ' + edge.artifactId; }).join('\n')],
          ['元数据', item.metadata && Object.keys(item.metadata).length ? JSON.stringify(item.metadata, null, 2) : '']
        ].filter(function (row) { return !!row[1]; }).map(function (row) {
          return [React.createElement('dt', { key: row[0] + '-label' }, row[0]), React.createElement('dd', { key: row[0] }, row[1])];
        })) : null,
        item ? React.createElement('div', { className: 'iris-gallery-actions' },
          React.createElement('a', { className: 'iris-wb-link', href: item.url, target: '_blank', rel: 'noreferrer' }, '打开原文件'),
          React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: function () { copyWorkbenchText(item.id, setNote); } }, '复制 ID')) : null,
        type === 'delete' && data ? React.createElement('div', { className: 'iris-gallery-management-list' },
          React.createElement('div', {}, '选中 ' + artifactIds.length + ' 个作品 · ' + data.files + ' 个文件 · ' + fmtBytes(data.bytes)),
          artifactIds.map(function (id) { return React.createElement('div', { key: id }, id); }),
          (data.referencingTasks || []).length ? React.createElement('div', { className: 'iris-wb-muted' }, '如需同时移除关联任务记录，请逐项勾选；未结束任务及其他引用会阻止删除。') : null,
          (data.referencingTasks || []).map(function (task) { return React.createElement('label', { key: task.id, className: 'iris-gallery-select' },
            React.createElement('input', { type: 'checkbox', 'aria-label': '关联任务 ' + task.id, checked: taskIds.indexOf(task.id) >= 0,
              disabled: busy || !task.settled, onChange: function (event) { chooseTask(task.id, event.target.checked); } }),
            '同时移除任务记录 ' + task.id + (task.settled ? '' : '（未结束或结果未知）')); }),
          (data.blockers || []).map(function (blocker, index) { return React.createElement('div', { key: index, className: 'iris-wb-muted' },
            deletionBlockerLabel(blocker) + '：' + blocker.id + (blocker.referencedBy ? ' ← ' + blocker.referencedBy : '')); })) : null,
        type === 'delete' ? React.createElement('div', { className: 'iris-gallery-actions' },
          React.createElement('button', { className: 'iris-pm-btn danger', type: 'button', disabled: busy || !data || !data.allowed,
            onClick: function () { execute(); } }, '确认移入回收区'),
          React.createElement('button', { className: 'iris-pm-btn', type: 'button', disabled: busy, onClick: function () { query(taskIds); } }, '重新预览')) : null,
        type === 'transactions' && data ? React.createElement('div', { className: 'iris-gallery-management-list' },
          data.transactions.length ? data.transactions.map(function (transaction) {
            var states = { __proto__: null, prepared: '准备中', committed: '已隔离', interrupted: '操作中断', restored: '已恢复', 'rolled-back': '已回退' };
            return React.createElement('div', { key: transaction.transactionId, className: 'iris-gallery-transaction' },
              React.createElement('div', {}, transaction.transactionId),
              React.createElement('div', { className: 'iris-wb-muted' }, (transaction.operation === 'cleanup' ? '清理' : '删除') + ' · '
                + (states[transaction.state] || transaction.state) + ' · ' + transaction.files + ' 文件 · ' + fmtTime(transaction.createdAt)),
              React.createElement('button', { type: 'button', className: 'iris-pm-btn',
                disabled: busy || ['prepared', 'committed', 'interrupted'].indexOf(transaction.state) < 0,
                onClick: function () { execute(transaction); } }, '恢复'));
          }) : React.createElement('div', { className: 'iris-wb-muted' }, '回收区为空。')) : null,
        type === 'transactions' ? React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: busy, onClick: function () { query([]); } }, '刷新回收区') : null,
        note ? React.createElement('div', { role: 'status', className: 'iris-clean-note', style: { whiteSpace: 'pre-wrap' } }, note) : null);
    }

    function ArtifactAnalysis(props) {
      var item = props.item, action = props.action;
      var resultPair = React.useState(null), result = resultPair[0], setResult = resultPair[1];
      var optionsPair = React.useState({ question: '', chunk_height: '1200', overlap: '120' });
      var options = optionsPair[0], setOptions = optionsPair[1];
      var notePair = React.useState(''), note = notePair[0], setNote = notePair[1];
      var request = React.useRef(null);
      var view = React.useRef(null);
      var running = result && result.status === 'running';
      var text = result && result.text || '';
      function execute() {
        if (request.current) request.current.abort();
        var controller = new AbortController();
        request.current = controller;
        var input = { artifact_id: item.id };
        if (action === 'look') input.question = options.question;
        else {
          input.chunk_height = Number(options.chunk_height);
          input.overlap = Number(options.overlap);
        }
        setResult({ status: 'running', text: '' }); setNote('');
        fetch('/iris/api/actions/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input), signal: controller.signal })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (response) {
            if (request.current !== controller || controller.signal.aborted) return;
            var data = response.data;
            setResult({ status: !response.ok || data.ok === false ? 'failed' : (data.status || 'complete'),
              text: data.text || data.error || '未返回识别结果' });
          })
          .catch(function (error) {
            if (request.current !== controller || controller.signal.aborted) return;
            setResult({ status: 'failed', text: '识别请求失败：' + error.message });
          })
          .finally(function () { if (request.current === controller) request.current = null; });
      }
      function cancel() {
        if (request.current) request.current.abort();
        request.current = null;
        setResult({ status: 'canceled', text: '' });
      }
      React.useEffect(function () {
        execute();
        if (view.current) view.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return function () { if (request.current) request.current.abort(); request.current = null; };
      }, []);
      function option(key, value) { setOptions(function (current) { var next = Object.assign({}, current); next[key] = value; return next; }); }
      function copy() {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { setNote('请选中下方文字手动复制'); return; }
        navigator.clipboard.writeText(text).then(function () { setNote('已复制识别结果'); }).catch(function () { setNote('复制失败，请手动选择文字'); });
      }
      function download() {
        var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        var link = document.createElement('a'); link.href = url; link.download = item.id + '-' + action + '.txt'; link.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 0);
      }
      var status = result && result.status || 'running';
      var labels = { running: '识别中…', complete: '完成', partial: '部分完成', failed: '失败', canceled: '已取消' };
      return React.createElement('section', { ref: view, className: 'iris-gallery-analysis', 'aria-label': '作品识别', 'aria-busy': !!running },
        artifactPreview(item),
        React.createElement('div', { className: 'iris-gallery-analysis-body' },
          React.createElement('div', { className: 'iris-gallery-analysis-head' },
            React.createElement('strong', {}, action === 'look' ? '看图结果' : 'OCR 结果'),
            React.createElement('span', { role: 'status', className: 'iris-wb-badge ' + (status === 'partial' ? 'warn' : status === 'failed' ? 'err' : status === 'complete' ? 'ok' : '') }, labels[status]),
            running ? React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: cancel }, '取消识别') : null,
            React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: props.onClose }, '关闭结果')),
          React.createElement('details', {}, React.createElement('summary', {}, '更多选项'),
            React.createElement('div', { className: 'iris-gallery-analysis-options' }, action === 'look'
              ? React.createElement('label', {}, '看图问题', React.createElement('input', { value: options.question, placeholder: '默认：详细描述这张图片', onChange: function (e) { option('question', e.target.value); } }))
              : ['chunk_height', 'overlap'].map(function (key) {
                return React.createElement('label', { key: key }, key === 'chunk_height' ? '分块高度' : '重叠像素',
                  React.createElement('input', { type: 'number', min: key === 'chunk_height' ? 100 : 0, value: options[key], onChange: function (e) { option(key, e.target.value); } }));
              }),
              React.createElement('button', { className: 'iris-clean-btn', type: 'button', disabled: !!running, onClick: execute }, '按当前选项重新识别'))),
          text ? React.createElement('textarea', { 'aria-label': '识别结果', readOnly: true, value: text }) : null,
          text ? React.createElement('div', { className: 'iris-gallery-actions' },
            React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: copy }, '复制文本'),
            React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: download }, '下载文本')) : null,
          note ? React.createElement('div', { role: 'status', className: 'iris-clean-note' }, note) : null));
    }

    function ArtifactImageEdit(props) {
      var item = props.item;
      var promptPair = React.useState(''), prompt = promptPair[0], setPrompt = promptPair[1];
      var modelPair = React.useState(''), model = modelPair[0], setModel = modelPair[1];
      var modelsPair = React.useState(null), models = modelsPair[0], setModels = modelsPair[1];
      var resultPair = React.useState(null), result = resultPair[0], setResult = resultPair[1];
      var request = React.useRef(null);
      var running = result && result.status === 'running';
      React.useEffect(function () {
        var active = true;
        postAction('assignments_get', {}).then(function (response) {
          if (!active) return;
          if (!response.ok || !response.d.ok) throw new Error('模型列表读取失败');
          var choices = [];
          var pool = response.d.poolByCapability && response.d.poolByCapability['image-gen'] || [];
          (response.d.order && response.d.order['image-gen'] || []).forEach(function (ref) {
            var entry = pool.find(function (item) { return item.ref === ref; });
            if (!entry || !entry.imageRouting || !entry.imageRouting.editSupported) return;
            choices.push({ id: ref, label: entry.label, blocked: entry.unavailable === true });
          });
          setModels(choices);
        }).catch(function (error) { if (active) { setModels([]); setResult({ status: 'failed', text: error.message }); } });
        return function () { active = false; if (request.current) request.current.abort(); request.current = null; };
      }, []);
      function execute() {
        if (request.current || !prompt.trim()) return;
        var controller = new AbortController(); request.current = controller;
        setResult({ status: 'running', text: '' });
        fetch('/iris/api/actions/image_edit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_artifact_id: item.id, prompt: prompt.trim(), ...(model ? { model: model } : {}) }), signal: controller.signal })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok && data.ok !== false, data: data }; }); })
          .then(function (response) {
            if (request.current !== controller || controller.signal.aborted) return;
            var data = response.data;
            setResult({ status: response.ok ? 'complete' : 'failed', text: data.text || data.error || '未返回编辑结果',
              artifactIds: response.ok ? data.artifactIds || [] : [], taskId: data.taskId });
            if (response.ok) window.dispatchEvent(new CustomEvent('iris-core-artifacts-changed'));
          })
          .catch(function (error) {
            if (request.current === controller && !controller.signal.aborted) setResult({ status: 'failed', text: '改图请求失败：' + error.message + '。请在任务区检查结果。' });
          })
          .finally(function () { if (request.current === controller) request.current = null; });
      }
      function cancel() {
        if (request.current) request.current.abort(); request.current = null;
        setResult({ status: 'canceled', text: '已停止等待，请在任务区检查是否已生成。不会自动重新提交。' });
      }
      return React.createElement('section', { className: 'iris-gallery-analysis', 'aria-label': '作品改图', 'aria-busy': !!running },
        artifactPreview(item),
        React.createElement('div', { className: 'iris-gallery-analysis-body' },
          React.createElement('div', { className: 'iris-gallery-analysis-head' }, React.createElement('strong', {}, '编辑图片'),
            React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: props.onClose }, '关闭改图')),
          React.createElement('div', { className: 'iris-wb-muted' }, '原图保留，修改版会保存为新作品。此操作会调用生图模型。'),
          React.createElement('label', {}, '修改指令', React.createElement('textarea', { 'aria-label': '修改指令', value: prompt, disabled: !!running,
            placeholder: '例如：把蓝色发饰改成白色，保留人物、服装和构图', onChange: function (e) { setPrompt(e.target.value); } })),
          React.createElement('label', {}, '改图模型', React.createElement('select', { 'aria-label': '改图模型', value: model, disabled: !!running,
            onChange: function (e) { setModel(e.target.value); } }, React.createElement('option', { value: '' }, '按当前顺序选择可用改图模型'),
            (models || []).map(function (entry) { return React.createElement('option', { key: entry.id, value: entry.id, disabled: entry.blocked }, entry.label + (entry.blocked ? ' · 冷却或额度耗尽' : '')); }))),
          models && !models.some(function (entry) { return !entry.blocked; }) ? React.createElement('div', { role: 'status' }, '暂无可用改图模型，请检查图片功能的调用方式，确认聊天生图或 DashScope Qwen 改图模型用途及连接。') : null,
          React.createElement('div', { className: 'iris-gallery-actions' },
            React.createElement('button', { className: 'iris-clean-btn', type: 'button', disabled: !!running || !prompt.trim() || !models || !models.some(function (entry) { return !entry.blocked; }), onClick: execute }, running ? '编辑中…' : '生成修改版'),
            running ? React.createElement('button', { className: 'iris-pm-btn', type: 'button', onClick: cancel }, '停止等待') : null),
          result ? React.createElement('div', { role: 'status', className: 'iris-clean-note', style: { whiteSpace: 'pre-wrap' } }, result.text || '编辑中…',
            result.taskId ? React.createElement('div', {}, 'task: ' + result.taskId) : null) : null,
          result && result.artifactIds ? result.artifactIds.map(function (id) { return React.createElement('div', { key: id },
            React.createElement('a', { href: '/iris/api/core/artifact/' + encodeURIComponent(id) + '/media', target: '_blank', rel: 'noreferrer' }, '打开新作品：' + id)); }) : null));
    }

    function ArtifactGallery() {
      var dataPair = React.useState({ total: 0, offset: 0, limit: 24, items: [], kinds: [], counts: { core: 0, legacy: 0 } });
      var data = dataPair[0], setData = dataPair[1];
      var queryPair = React.useState({ offset: 0, media_type: 'all', source: 'all', kind: 'all' });
      var query = queryPair[0], setQuery = queryPair[1];
      var currentQuery = React.useRef(query); currentQuery.current = query;
      var busyPair = React.useState(false), busy = busyPair[0], setBusy = busyPair[1];
      var mutationPair = React.useState(false), mutating = mutationPair[0], setMutating = mutationPair[1];
      var notePair = React.useState('');
      var note = notePair[0];
      var setNote = notePair[1];
      var analysisPair = React.useState(null), analysis = analysisPair[0], setAnalysis = analysisPair[1];
      var selectionPair = React.useState([]), selected = selectionPair[0], setSelected = selectionPair[1];
      var managementPair = React.useState(null), management = managementPair[0], setManagement = managementPair[1];
      var operationNotePair = React.useState(''), operationNote = operationNotePair[0], setOperationNote = operationNotePair[1];
      var request = React.useRef(null), sequence = React.useRef(0);
      var downloadRequest = React.useRef(null);

      function load() {
        if (request.current) request.current.abort();
        var controller = new AbortController(); request.current = controller;
        setBusy(true);
        var input = currentQuery.current;
        var url = '/iris/api/works?offset=' + input.offset + '&limit=24&media_type=' + input.media_type
          + '&source=' + input.source + '&kind=' + encodeURIComponent(input.kind);
        fetch(url, { signal: controller.signal })
          .then(function (res) { if (!res.ok) throw new Error(res.status === 404 ? '请重新加载 DSH 后端以启用作品管理' : '作品读取失败（HTTP ' + res.status + '）'); return res.json(); })
          .then(function (value) {
            if (request.current !== controller || controller.signal.aborted) return;
            setData(value);
            setNote(value.coreError ? 'Core 作品暂时不可用，当前计数仅含可读取作品。'
              : value.droppedCore ? '已跳过 ' + value.droppedCore + ' 条不可读取的 Core 作品。' : '');
          })
          .catch(function (error) { if (request.current === controller && !controller.signal.aborted) setNote(error.message); })
          .finally(function () { if (request.current === controller) { request.current = null; setBusy(false); } });
      }

      function run(action, body, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return;
        setMutating(true);
        postAction(action, body || {}).then(function (result) {
          var succeeded = result.ok && result.d && result.d.ok !== false;
          setNote(succeeded ? (result.d.text || '完成') : ('失败：' + ((result.d && (result.d.error || result.d.text)) || '未知错误')));
          if (succeeded) {
            if (action === 'artifacts_clear' || action === 'artifacts_delete') setSelected(function (current) {
              return current.filter(function (item) { return item.source !== 'legacy' || (action !== 'artifacts_clear' && item.id !== body.artifact_id); });
            });
            load();
          }
        }).catch(function (error) { setNote('失败：' + error.message); }).finally(function () { setMutating(false); });
      }

      React.useEffect(function () {
        function changed() { load(); }
        window.addEventListener('iris-core-artifacts-changed', changed);
        window.addEventListener('iris-core-refresh-tick', changed);
        load();
        return function () {
          window.removeEventListener('iris-core-artifacts-changed', changed);
          window.removeEventListener('iris-core-refresh-tick', changed);
          if (request.current) request.current.abort(); request.current = null;
        };
      }, [query.offset, query.media_type, query.source, query.kind]);
      React.useEffect(function () { return function () { if (downloadRequest.current) downloadRequest.current.abort(); downloadRequest.current = null; }; }, []);
      function filter(key, value) {
        setSelected([]); if (management && management.type === 'delete') setManagement(null);
        setQuery(function (current) { var next = Object.assign({}, current, { offset: 0 }); next[key] = value; if (key !== 'kind') next.kind = 'all'; return next; });
      }
      function page(offset) { setQuery(function (current) { return Object.assign({}, current, { offset: offset }); }); }
      function analyze(item, action) { setManagement(null); sequence.current++; setAnalysis({ item: item, action: action, key: sequence.current }); }
      function manage(type, items) { setAnalysis(null); sequence.current++; setManagement({ type: type, items: items, item: items && items[0], key: sequence.current }); }
      function selectedItem(item) { return selected.some(function (value) { return value.source === item.source && value.id === item.id; }); }
      function choose(item, checked) {
        if (checked && selected.length >= 200) { setOperationNote('最多选择 200 个作品'); return; }
        setSelected(function (current) {
          var present = current.some(function (value) { return value.source === item.source && value.id === item.id; });
          return checked ? present || current.length >= 200 ? current : current.concat(item)
            : current.filter(function (value) { return value.source !== item.source || value.id !== item.id; });
        });
      }
      var pageSelected = data.items.length && data.items.every(selectedItem);
      function choosePage() {
        if (pageSelected) setSelected(function (current) { return current.filter(function (item) { return !data.items.some(function (value) { return value.source === item.source && value.id === item.id; }); }); });
        else {
          var additions = data.items.filter(function (item) { return !selectedItem(item); });
          if (selected.length + additions.length > 200) { setOperationNote('最多选择 200 个作品，请减少选择后再选本页'); return; }
          setSelected(function (current) {
            var next = current.concat(additions.filter(function (item) {
              return !current.some(function (value) { return value.source === item.source && value.id === item.id; });
            }));
            return next.length <= 200 ? next : current;
          });
        }
      }
      function changed(value) {
        if (value.state === 'committed') setSelected([]);
        setOperationNote((value.state === 'restored' ? '已恢复：' : '已移入回收区：') + value.transactionId);
        window.dispatchEvent(new CustomEvent('iris-core-artifacts-changed'));
      }
      function download(items) {
        var controller = new AbortController(); downloadRequest.current = controller;
        setMutating(true); setOperationNote('正在准备下载…');
        fetch('/iris/api/works/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ items: items.map(function (item) { return { source: item.source, id: item.id }; }) }) })
          .then(function (res) { if (!res.ok) return res.json().then(function (value) { throw new Error(value.error || '下载失败'); }); return res.blob(); })
          .then(function (blob) { if (downloadRequest.current === controller && !controller.signal.aborted) { saveWorkbenchBlob(blob, 'iris-works.zip'); setOperationNote('已下载选中作品'); } })
          .catch(function (error) { if (downloadRequest.current === controller && !controller.signal.aborted) setOperationNote(error.message); })
          .finally(function () { if (downloadRequest.current === controller) { downloadRequest.current = null; setMutating(false); } });
      }
      function cancelDownload() { if (downloadRequest.current) downloadRequest.current.abort(); downloadRequest.current = null; setMutating(false); setOperationNote('已取消下载'); }
      var pageNumber = Math.floor(data.offset / data.limit) + 1;
      var pageCount = Math.max(1, Math.ceil(data.total / data.limit));
      var blocked = busy || mutating;

      return React.createElement('div', {},
        React.createElement(ActionCard, CARD_DEFS.find(function (card) { return card.action === 'image_import'; })),
        React.createElement('div', { className: 'iris-gallery-tools' },
          React.createElement('span', { className: 'iris-clean-note' },
            '匹配 ' + data.total + ' 个作品 · Core ' + data.counts.core + ' · 旧版 ' + data.counts.legacy + ' · 清任务历史不会删除'),
          React.createElement('button', { className: 'iris-clean-btn', disabled: blocked, onClick: load }, '刷新'),
          React.createElement('button', { className: 'iris-clean-btn', disabled: mutating, onClick: function () { manage('transactions'); } }, 'Core 回收区'),
          React.createElement('button', { className: 'iris-clean-btn', disabled: blocked, onClick: function () { run('artifacts_reindex'); } }, '扫描旧版 outputs'),
          data.counts.legacy ? React.createElement('button', { className: 'iris-clean-btn danger', disabled: blocked, onClick: function () { run('artifacts_clear', {}, '永久删除旧版 outputs 作品？Core 作品不会删除；任务历史会保留。此操作不可逆。'); } }, '清空旧版作品') : null),
        React.createElement('div', { className: 'iris-gallery-filters' },
          React.createElement('label', {}, '媒体类型', React.createElement('select', { 'aria-label': '媒体类型', value: query.media_type, disabled: mutating && !!management, onChange: function (e) { filter('media_type', e.target.value); } },
            [['all', '全部媒体'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['text', '文本']].map(function (entry) { return React.createElement('option', { key: entry[0], value: entry[0] }, entry[1]); }))),
          React.createElement('label', {}, '作品来源', React.createElement('select', { 'aria-label': '作品来源', value: query.source, disabled: mutating && !!management, onChange: function (e) { filter('source', e.target.value); } },
            [['all', '全部来源'], ['core', 'Core'], ['legacy', '旧版']].map(function (entry) { return React.createElement('option', { key: entry[0], value: entry[0] }, entry[1]); }))),
          React.createElement('label', {}, '产物类型', React.createElement('select', { 'aria-label': '产物类型', value: query.kind, disabled: mutating && !!management, onChange: function (e) { filter('kind', e.target.value); } },
            ['all'].concat(data.kinds).map(function (kind) { return React.createElement('option', { key: kind, value: kind }, kind === 'all' ? '全部产物' : galleryKindLabel(kind)); })))),
        React.createElement('div', { className: 'iris-gallery-bulk' },
          React.createElement('span', { className: 'iris-wb-muted', role: 'status' }, '已选择 ' + selected.length + ' / 200 · 下载最多 128 MiB'),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: blocked || !data.items.length, onClick: choosePage }, pageSelected ? '取消本页选择' : '选择本页'),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: mutating || !selected.length,
            onClick: function () { setSelected([]); if (management && management.type === 'delete') setManagement(null); } }, '清空选择'),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: !selected.length,
            onClick: function () { copyWorkbenchText(selected.map(function (item) { return item.id; }).join('\n'), setOperationNote); } }, '复制选中 ID'),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: mutating || !selected.length, onClick: function () { download(selected); } }, '下载选中作品'),
          React.createElement('button', { type: 'button', className: 'iris-pm-btn danger', disabled: mutating || !selected.length || selected.some(function (item) { return item.source !== 'core'; }),
            title: '仅 Core 作品支持可恢复批量删除；请先按来源筛选', onClick: function () { manage('delete', selected); } }, '删除选中 Core 作品'),
          downloadRequest.current ? React.createElement('button', { type: 'button', className: 'iris-pm-btn', onClick: cancelDownload }, '取消下载') : null),
        analysis ? React.createElement(analysis.action === 'image_edit' ? ArtifactImageEdit : ArtifactAnalysis, { key: analysis.key, item: analysis.item, action: analysis.action, onClose: function () { setAnalysis(null); } }) : null,
        management ? React.createElement(WorkbenchManagement, { key: management.key, type: management.type, items: management.items, item: management.item,
          onBusy: setMutating, onChanged: changed, onClose: function () { setManagement(null); } }) : null,
        data.items.length ? React.createElement('div', { className: 'iris-gallery-grid', 'aria-busy': busy }, data.items.map(function (item) {
          var isCore = item.source === 'core';
          return React.createElement('div', { key: (isCore ? 'core-' : 'legacy-') + item.id, className: 'iris-gallery-card' + (selectedItem(item) ? ' selected' : '') },
            artifactPreview(item),
            React.createElement('div', { className: 'iris-gallery-info' },
              React.createElement('label', { className: 'iris-gallery-select' }, React.createElement('input', { type: 'checkbox',
                'aria-label': '选择作品 ' + item.id, checked: selectedItem(item), disabled: mutating || (!selectedItem(item) && selected.length >= 200),
                onChange: function (event) { choose(item, event.target.checked); } }), '选择'),
              React.createElement('div', { className: 'iris-gallery-file', title: item.file }, item.file),
              React.createElement('div', { className: 'iris-gallery-meta' },
                (isCore ? 'Core · ' + galleryKindLabel(item.kind) : '旧版') + ' · ' + fmtTime(item.createdAt) + ' · ' + fmtBytes(item.size)),
              React.createElement('div', { className: 'iris-gallery-actions' },
                React.createElement('a', { className: 'iris-wb-link', href: item.url, target: '_blank', rel: 'noreferrer' }, '打开'),
                React.createElement('button', { className: 'iris-pm-btn', type: 'button', disabled: mutating, onClick: function () { manage('details', [item]); } }, '详情'),
                isCore ? React.createElement('button', { className: 'iris-pm-btn danger', type: 'button', disabled: mutating, onClick: function () { manage('delete', [item]); } }, '移入回收区') : null,
                isCore && /^image\/(png|jpeg|webp|gif)$/.test(item.mime) ? ['look', 'ocr'].map(function (action) {
                  return React.createElement('button', { key: action, type: 'button', className: 'iris-pm-btn', disabled: mutating, onClick: function () { analyze(item, action); } }, action === 'look' ? '看图' : 'OCR');
                }) : null,
                isCore && /^image\/(png|jpeg|webp)$/.test(item.mime) ? React.createElement('button', { type: 'button', className: 'iris-pm-btn', disabled: mutating,
                  onClick: function () { analyze(item, 'image_edit'); } }, '改图') : null,
                isCore ? React.createElement('span', { className: 'iris-wb-muted', title: '打开或识别时核验原文件' }, '内容哈希保护')
                  : React.createElement('button', { className: 'iris-pm-btn danger', disabled: blocked, onClick: function () { run('artifacts_delete', { artifact_id: item.id }, '永久删除作品“' + item.file + '”？任务历史会保留，但媒体将无法打开。'); } }, '删除'))));
        })) : React.createElement('div', { className: 'iris-wb-empty' }, busy ? '正在读取作品…'
          : query.media_type !== 'all' || query.source !== 'all' || query.kind !== 'all' ? '没有匹配的作品，请调整筛选条件。' : '尚无作品；旧 outputs 文件可点“扫描旧版 outputs”找回。'),
        React.createElement('div', { className: 'iris-gallery-pagination' },
          React.createElement('button', { type: 'button', className: 'iris-clean-btn', disabled: blocked || pageNumber <= 1, onClick: function () { page(Math.max(0, data.offset - data.limit)); } }, '上一页'),
          React.createElement('span', { className: 'iris-wb-muted', role: 'status' }, '第 ' + pageNumber + ' / ' + pageCount + ' 页'),
          React.createElement('button', { type: 'button', className: 'iris-clean-btn', disabled: blocked || pageNumber >= pageCount, onClick: function () { page(data.offset + data.limit); } }, '下一页')),
        note ? React.createElement('div', { className: 'iris-clean-note', style: { marginTop: '7px' } }, note) : null,
        operationNote ? React.createElement('div', { role: 'status', className: 'iris-clean-note', style: { marginTop: '7px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, operationNote) : null);
    }

    function coreCapabilityLabel(value) {
      return ({ image: '图片生成', video: '视频生成', tts: '语音合成', music: '音乐生成', transcribe: '音频转写' })[value] || String(value || '媒体任务');
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
            var sourceArtifactId;
            if (props.row.sourceArtifactId) {
              sourceArtifactId = window.prompt('请确认新改图任务使用的原图 Artifact ID：', props.row.sourceArtifactId);
              if (sourceArtifactId === null || !String(sourceArtifactId).trim()) return null;
            }
            return isTts ? { text: draft, confirmBilling: true }
            : isTranscribe ? { audio_url: draft, confirmBilling: true }
            : { prompt: draft, confirmBilling: true, ...(sourceArtifactId ? { source_artifact_id: String(sourceArtifactId).trim() } : {}) };
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
            ? { id: selectedTask.id, capability: selectedTask.capability, sourceArtifactId: selectedTask.sourceArtifactId, retryable: true } : null
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

    function promptConfigFeedback(state) {
      var warnings = state && state.feedback && state.feedback.warnings;
      if (!Array.isArray(warnings) || !warnings.length) return null;
      return React.createElement('div', { className: 'iris-po-note', role: 'status' }, warnings.map(function (warning, index) {
        var text = '';
        if (warning.code === 'config-fallback') {
          text = warning.reason === 'read-failed' ? '配置读取失败，当前使用 Iris 默认设置。' : '配置内容无效，当前使用 Iris 默认设置。';
          text += warning.isolation === 'saved' ? '原文件已隔离保留，可在修正后重新导入。'
            : warning.isolation === 'failed' ? '隔离未完成，Iris 没有覆盖原文件；请检查原文件。' : '原文件未移动；请检查文件读取权限。';
        } else if (warning.code === 'ignored-fields' && Array.isArray(warning.fields)) {
          text = '已忽略不支持或当前路由未使用的字段：' + warning.fields.filter(function (field) { return typeof field === 'string'; }).map(function (field) { return JSON.stringify(field); }).join('、');
          if (warning.count > warning.fields.length) text += '（共 ' + warning.count + ' 个，仅显示前 ' + warning.fields.length + ' 个）';
          text += '。请检查字段名；这些字段未保存到配置。';
        }
        return text ? React.createElement('div', { key: index }, text) : null;
      }));
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
        promptConfigFeedback(state),
        note ? React.createElement('div', { className: 'iris-clean-note' }, note) : null);
    }

    function BrowserCheckPanel(props) {
      var statePair = React.useState({ status: 'idle', message: '尚未实测' });
      var state = statePair[0], setState = statePair[1];
      var request = React.useRef(null);
      React.useEffect(function () { return function () {
        var operation = request.current;
        request.current = null;
        if (operation) { clearTimeout(operation.timer); operation.controller.abort(); }
      }; }, []);

      function stop(timedOut) {
        var operation = request.current;
        if (!operation) return;
        request.current = null;
        clearTimeout(operation.timer);
        operation.controller.abort();
        setState({ status: 'canceled', message: timedOut
          ? '截图自检超过 60 秒，已停止等待。若恰好完成保存，可在作品库查看。'
          : '已取消本次自检等待。若恰好完成保存，可在作品库查看。' });
      }
      function start() {
        if (request.current || !props.available) return;
        var operation = { controller: new AbortController(), started: Date.now() };
        request.current = operation;
        setState({ status: 'running', message: '正在打开浏览器并生成测试截图…' });
        operation.timer = setTimeout(function () { if (request.current === operation) stop(true); }, 60000);
        fetch('/iris/api/actions/html', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          signal: operation.controller.signal,
          body: JSON.stringify({ fullPage: false, width: 480, height: 240,
            html: '<style>body{margin:0;background:#edf3f1;color:#183e34;font-family:system-ui,sans-serif}.iris-test{padding:32px}h1{font-size:26px;margin:0 0 12px}p{font-size:16px;margin:8px 0}</style><div class="iris-test"><h1>Iris · 截图自检</h1><p>中文与 HTML 渲染测试</p><p>本页只使用内联样式，不调用模型。</p></div>' })
        }).then(function (res) { return res.json().then(function (data) {
          if (!res.ok || data.ok !== true) throw Object.assign(new Error(data.error || '截图自检失败'), { code: data.code });
          var id = data.artifactIds && data.artifactIds[0];
          if (data.storage !== 'core' || !/^artifact_[a-f0-9]{24}$/.test(id || '')) throw new Error('服务端未返回有效截图作品，请核对前后端版本。');
          return id;
        }); }).then(function (id) {
          if (request.current !== operation || operation.controller.signal.aborted) return;
          setState({ status: 'passed', artifactId: id, message: '本次截图已保存 · ' + ((Date.now() - operation.started) / 1000).toFixed(1) + ' 秒 · ' + new Date().toLocaleTimeString() });
          window.dispatchEvent(new CustomEvent('iris-core-artifacts-changed'));
        }).catch(function (error) {
          if (request.current !== operation || operation.controller.signal.aborted) return;
          var code = String(error && error.code || '');
          var detail = String(error && error.message || error);
          var message = '截图自检未通过。请查看错误详情。';
          if (code === 'IRIS_RENDER_ADDRESS_INVALID') message = '截图地址配置有误，请核对 DSH_WEB_BASE。';
          else if (code === 'IRIS_CORE_DATA_ROOT_BUSY') message = '作品库正在被其他操作写入，请稍后重试。';
          else if (/^IRIS_HOST_CAPABILITY_/.test(code)) message = '宿主浏览器接口不可用，请检查浏览器插件是否启用。';
          else if (/Missing X server|DISPLAY|BROWSER_HOST_/.test(detail + code)) message = '浏览器进程未能启动，请检查运行环境与显示服务。';
          else if (/BROWSER_NAVIGATION|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED/.test(detail + code)) message = '浏览器未能打开渲染页面，请核对上方截图地址与宿主监听状态。';
          else if (/BROWSER_SCREENSHOT/.test(code)) message = '浏览器未能生成截图，请查看错误详情。';
          setState({ status: 'failed', message: message, detail: detail, code: code });
        }).finally(function () {
          clearTimeout(operation.timer);
          if (request.current === operation) request.current = null;
        });
      }
      var busy = state.status === 'running';
      return React.createElement('div', { className: 'iris-browser-check', 'data-iris-browser-check': state.status },
        React.createElement('div', { className: 'iris-doctor-top' },
          React.createElement('strong', { className: 'iris-doctor-score' }, 'HTML 截图'),
          React.createElement('button', { className: 'iris-pm-btn', disabled: busy || !props.available, onClick: start }, busy ? '检测中…' : '截图自检'),
          busy ? React.createElement('button', { className: 'iris-pm-btn', onClick: function () { stop(false); } }, '取消') : null),
        React.createElement('div', { className: 'iris-browser-check-note' + (state.status === 'failed' ? ' error' : ''), role: 'status', 'aria-live': 'polite' }, state.message),
        props.address ? React.createElement('div', { className: 'iris-browser-check-note iris-wb-muted' }, props.address) : null,
        React.createElement('div', { className: 'iris-wb-muted' }, '点击后打开浏览器，生成一张本地测试作品；不调用模型。'),
        state.artifactId ? React.createElement('details', { className: 'iris-doctor-details' },
          React.createElement('summary', {}, '查看测试截图'),
          React.createElement('img', { src: '/iris/api/core/artifact/' + state.artifactId + '/media', alt: 'Iris HTML 截图自检结果', loading: 'lazy' })) : null,
        state.detail ? React.createElement('details', { className: 'iris-doctor-details' },
          React.createElement('summary', {}, '错误详情'),
          React.createElement('div', { className: 'iris-browser-check-note' }, (state.code ? state.code + ' · ' : '') + state.detail)) : null);
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
      var renderAddress = checks.find(function (item) { return item.id === 'render-address'; });
      var mark = { ok: '✓', warn: '!', error: '×' };
      function rows(list) {
        return React.createElement('div', { className: 'iris-doctor-list' }, list.map(function (item) {
          return React.createElement('div', { key: item.id, className: 'iris-doctor-row ' + item.status },
            React.createElement('span', {}, mark[item.status] || '·'),
            React.createElement('span', {}, item.summary,
              item.status !== 'ok' && item.suggestion ? React.createElement('div', { className: 'iris-wb-muted' }, item.suggestion) : null));
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
        React.createElement('div', { className: 'iris-wb-muted' }, '刷新只读装载证据，不启动浏览器；接口已提供不代表截图已通过。'),
        React.createElement(BrowserCheckPanel, {
          available: Boolean(report && report.capabilities && report.capabilities.browser && report.capabilities.browser.status === 'available'),
          address: renderAddress && renderAddress.status === 'ok' ? renderAddress.summary : ''
        }));
    }

    function revealWorkbenchItem(node) {
      for (var parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    }
    function WorkbenchSection(props) {
      var expandedPair = React.useState(false);
      return React.createElement(props.collapsible ? 'details' : 'section', { className: 'iris-wb-section',
        'data-iris-section': props.name, 'aria-label': props.title,
        onToggle: props.collapsible ? function (event) { expandedPair[1](event.currentTarget.open); } : undefined },
        React.createElement(props.collapsible ? 'summary' : 'div', { className: 'iris-wb-section-head' },
          React.createElement('div', {}, React.createElement('h2', {}, props.title),
            props.description ? React.createElement('p', {}, props.description) : null),
          props.collapsible ? React.createElement('span', { className: 'iris-wb-section-arrow', 'aria-hidden': true }, expandedPair[0] ? '收起' : '展开',
            React.createElement('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 },
              React.createElement('path', { d: 'm6 9 6 6 6-6' }))) : null),
        React.createElement('div', { className: 'iris-wb-section-body' }, props.children));
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
      return React.createElement('div', { className: 'iris-wb iris-workbench-page' },
        React.createElement('div', { className: 'iris-wb-head' },
          React.createElement('span', { className: 'iris-wb-title' }, 'Iris 工作台'),
          React.createElement('span', { className: 'iris-wb-date' }, state ? '刷新于 ' + new Date().toLocaleTimeString() : '加载中…')),
        React.createElement(CapabilityHealthOverview, {}),
        React.createElement(WorkbenchSection, { name: 'providers', title: '供应商与模型', description: '管理连接、模型用途与接口协议。' },
          React.createElement(ProviderManager, {})),
        React.createElement(WorkbenchSection, { name: 'pools', title: '功能池与调用方式', description: '选择自动池、所选模型或停用，查看每项功能的候选范围。', collapsible: true },
          React.createElement(CapabilityAssigner, {})),
        React.createElement(WorkbenchSection, { name: 'running', title: '运行中任务' },
          React.createElement('div', { className: 'iris-wb-box' },
          running.length || coreGroups.live.length ? [].concat(
            running.map(function (t) { return taskRow(t, true, selectedTask === t.id, onSelect); }),
            coreGroups.live.map(coreTaskCard))
            : React.createElement('div', { className: 'iris-wb-empty' }, '暂无进行中任务'))),
        attention.length || coreGroups.attention.length || coreUser.degraded ? React.createElement(WorkbenchSection, { name: 'attention', title: '需要处理' },
          React.createElement('div', { className: 'iris-wb-box' },
            coreUser.degraded ? React.createElement('div', { className: 'iris-clean-note' },
              '部分 Core 记录损坏或媒体缺失，已跳过 ' + coreUser.droppedTasks + ' 条；其余事实照常显示。') : null,
            [].concat(
              attention.map(function (t) { return taskRow(t, false, selectedTask === t.id, onSelect); }),
              coreGroups.attention.map(coreTaskCard)))) : null,
        React.createElement(WorkbenchSection, { name: 'artifacts', title: '作品库', description: '查看、下载和继续处理已有作品。' },
          React.createElement(ArtifactGallery, { total: artifactTotal })),
        React.createElement(WorkbenchSection, { name: 'actions', title: '创作工具', description: '生成媒体、导入图片、识别与处理素材。', collapsible: true },
          React.createElement(ActionGroups, {})),
        React.createElement(WorkbenchSection, { name: 'preferences', title: '快捷入口与偏好', description: '设置泡泡快捷卡片与对话框提示词优化。', collapsible: true },
          React.createElement('div', { className: 'iris-wb-sec' }, 'Iris 泡泡快捷卡片（勾选后显示在「⚡ 常用」标签）'),
          React.createElement(BubbleCardPicker, {}),
          React.createElement('div', { className: 'iris-wb-sec' }, '对话框提示词优化'),
          React.createElement(PromptOptimizerSettings, {})),
        React.createElement(WorkbenchSection, { name: 'diagnostics', title: '诊断与运行信息', description: '查看宿主装载与 Core 任务事实。', collapsible: true },
          React.createElement('div', { className: 'iris-wb-sec' }, '宿主诊断'),
          React.createElement(HostDoctorPanel, {}),
          React.createElement('div', { className: 'iris-wb-sec' }, '高级诊断'),
          React.createElement(CoreRuntimePanel, {})),
        React.createElement(WorkbenchSection, { name: 'history', title: '历史任务', description: '查看历史记录与清理选项。', collapsible: true },
          React.createElement(CleanupBar, {}),
          React.createElement(HistoryBrowser, { recent: recent, coreHistory: [].concat(coreGroups.done, coreGroups.acknowledged), selected: selectedTask, onSelect: onSelect })));
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

    var PROMPT_TARGET_OPTIONS = [
      { value: 'general', label: '通用', description: '整理目标、背景、约束与输出要求。' },
      { value: 'image', label: '画图', description: '整理已有主体、场景与构图要求，未指定细节不自动补齐。' },
      { value: 'image-edit', label: '改图', description: '明确要修改的部分，保留原图其余特征。' },
      { value: 'video', label: '视频', description: '组织动作、镜头与时间上的连续性。' },
      { value: 's2v', label: '数字人', description: '围绕已有首帧与音频设计表情、动作和镜头。' }
    ];

    // 折叠相同首尾，只显示中间替换区；按 Unicode code point 比较，不拆开 emoji。
    function promptChanges(original, edited) {
      var before = Array.from(original);
      var after = Array.from(edited);
      var start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      var end = 0;
      while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
      return { removed: before.slice(start, before.length - end).join(''), added: after.slice(start, after.length - end).join('') };
    }

    function promptRequestSnapshot(processing, title) {
      var request = processing && processing.request;
      if (!request || typeof request.system !== 'string' || typeof request.prompt !== 'string') return null;
      return React.createElement('details', { className: 'iris-po-config' },
        React.createElement('summary', {}, title),
        React.createElement('div', { className: 'iris-po-muted' }, 'Iris 发送的指令快照；宿主或供应商后续处理可能不同。'),
        React.createElement('div', { className: 'iris-po-result-label' }, '系统指令 · 含本次规则与输出协议'),
        React.createElement('div', { className: 'iris-po-template', 'aria-label': title + ' · 系统指令' }, request.system),
        React.createElement('div', { className: 'iris-po-result-label' }, '用户输入 · 含素材包装'),
        React.createElement('div', { className: 'iris-po-template', 'aria-label': title + ' · 用户输入' }, request.prompt));
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
      var generalPair = React.useState(true);
      var generalOpen = generalPair[0];
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
      var optimizationPair = React.useState('');
      var optimizationText = optimizationPair[0];
      var setOptimizationText = optimizationPair[1];
      var prefixPair = React.useState('');
      var prefixText = prefixPair[0];
      var setPrefixText = prefixPair[1];
      var suffixPair = React.useState('');
      var suffixText = suffixPair[0];
      var setSuffixText = suffixPair[1];
      var editedPair = React.useState('');
      var edited = editedPair[0];
      var setEdited = editedPair[1];
      var editingPair = React.useState('faithful');
      var editing = editingPair[0];
      var suggestionsPair = React.useState(null);
      var suggestions = suggestionsPair[0];
      var setSuggestions = suggestionsPair[1];
      var selectedSuggestionsPair = React.useState([]);
      var selectedSuggestions = selectedSuggestionsPair[0];
      var setSelectedSuggestions = selectedSuggestionsPair[1];
      var undoPair = React.useState([]);
      var suggestionUndo = undoPair[0];
      var setSuggestionUndo = undoPair[1];
      var editedRef = React.useRef(edited);
      var resultRef = React.useRef(result);
      editedRef.current = edited;
      resultRef.current = result;
      var abortRef = React.useRef(null);
      var fileRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var lastWrittenRef = React.useRef(null);
      var resultSessionRef = React.useRef(null);
      var sessionRef = React.useRef(props.sessionId);
      sessionRef.current = props.sessionId;
      var supportsRules = !!(configState && configState.capabilities && configState.capabilities.rules === true);
      var supportsAssembly = !!(configState && configState.capabilities && configState.capabilities.assemble === true);
      var editingCapabilities = configState && configState.capabilities && configState.capabilities.editing;
      var supportsFaithful = Array.isArray(editingCapabilities) && editingCapabilities.indexOf('faithful') >= 0 && editingCapabilities.indexOf('rewrite') >= 0;
      var supportsLocalFaithful = supportsFaithful && configState.capabilities.localFaithful === true;
      var supportsSuggestions = Array.isArray(editingCapabilities) && editingCapabilities.indexOf('suggestions') >= 0;
      var supportsResetInstructions = !!(configState && configState.capabilities && configState.capabilities.resetInstructions === true);
      function supportsTarget(value) {
        var available = configState && configState.capabilities && configState.capabilities.targets;
        return Array.isArray(available) ? available.indexOf(value) >= 0 : value !== 'image-edit';
      }

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
          abortRef.current = null;
        };
      }, []);

      React.useEffect(function () {
        function changed(event) { if (event.detail && event.detail.config) setConfigState(event.detail); }
        window.addEventListener('iris-prompt-config-changed', changed);
        loadConfig();
        return function () { window.removeEventListener('iris-prompt-config-changed', changed); };
      }, []);

      React.useEffect(function () {
        cancel();
        setResult(null);
        setSuggestions(null); setSelectedSuggestions([]); setSuggestionUndo([]);
        lastWrittenRef.current = null;
        resultSessionRef.current = null;
      }, [props.sessionId]);

      React.useEffect(function () {
        if (!open) return;
        var previous = document.activeElement;
        var dialog = panelRef.current;
        if (dialog) { dialog.showModal(); dialog.focus(); }
        function keyboard(event) {
          if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
          if (event.key !== 'Tab' || !panelRef.current) return;
          var items = Array.from(panelRef.current.querySelectorAll('button:not(:disabled), textarea:not(:disabled), summary, input:not(:disabled)'))
            .filter(function (item) { return item.getClientRects().length > 0; });
          if (!items.length) return;
          var first = items[0], last = items[items.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
        window.addEventListener('keydown', keyboard);
        return function () {
          window.removeEventListener('keydown', keyboard);
          if (dialog && dialog.open) dialog.close();
          if (previous && previous.isConnected) previous.focus();
        };
      }, [open]);

      function publishConfig(data) {
        setConfigState(data);
        try { window.dispatchEvent(new CustomEvent('iris-prompt-config-changed', { detail: data })); } catch (_) {}
      }

      function selectedRules(mode) {
        var rules = [];
        if (!supportsRules) return rules;
        if (mode === 'optimize' && optimizationText.trim()) rules.push({ id: 'custom-optimization', label: '本次改写规则', kind: 'optimization', text: optimizationText });
        if (prefixText.trim()) rules.push({ id: 'custom-prefix', label: '输出前缀', kind: 'output', position: 'prefix', text: prefixText });
        if (suffixText.trim()) rules.push({ id: 'custom-suffix', label: '输出后缀', kind: 'output', position: 'suffix', text: suffixText });
        return rules;
      }

      function optimize(mode) {
        mode = mode === 'assemble' ? 'assemble' : 'optimize';
        if (!supportsTarget(target)) { setNote('当前后端尚未支持此优化目标，请更新并重新载入'); return; }
        if (mode === 'assemble' && !supportsAssembly) { setNote('当前后端尚未支持只组装，请更新并重新载入'); return; }
        if (!draft || !draft.trim()) { setNote('请先在输入框中写入提示词'); return; }
        if (refCount) { setNote('当前版本暂不改写含 @ 或 / 结构化引用的草稿，以免引用失效'); return; }
        if (phase !== 'plain') { setNote('输入框正忙，请稍后再试'); return; }
        if (mode === 'optimize' && supportsFaithful && editing === 'faithful' && optimizationText.trim()) {
          setNote('忠实整理只调整分段；使用本次改写规则前，请选择“改写表达”。'); return;
        }
        if (abortRef.current) abortRef.current.abort();
        var controller = new AbortController();
        var requestSessionId = props.sessionId;
        var previousResult = result;
        var previewSnapshot = edited;
        abortRef.current = controller;
        setBusy(true);
        setNote(mode === 'assemble' ? '正在组装，不调用模型…' : supportsLocalFaithful && editing === 'faithful'
          ? '正在忠实整理…需要分段时可能调用模型并产生费用' : '正在调用模型优化…这可能产生模型费用');
        promptRequest('optimize', {
          text: draft,
          target: target,
          mode: mode,
          editing: mode === 'optimize' && supportsFaithful ? editing : undefined,
          rules: selectedRules(mode),
          sessionId: props.sessionId,
          route: selectedRoute || undefined
        }, controller.signal).then(function (data) {
          if (abortRef.current !== controller || controller.signal.aborted) return;
          if (sessionRef.current !== requestSessionId) throw new Error('会话已切换，请在当前会话重新生成预览');
          if (!data.ok || typeof data.optimized !== 'string' || typeof data.original !== 'string') throw new Error('未收到完整优化结果');
          if (data.original !== draft) throw new Error('结果原稿与本次请求不一致');
          if (mode === 'optimize' && supportsFaithful && editing === 'faithful'
              && (data.editing?.strategy !== 'faithful' || data.editing.coverage !== 'exact' || data.editing.order !== 'preserved')) throw new Error('后端未确认完整的忠实整理结果');
          if (resultRef.current !== previousResult || editedRef.current !== previewSnapshot) {
            setNote('预览已变化，本次结果未替换；你的编辑已保留。'); return;
          }
          setResult(data);
          setEdited(data.optimized);
          setSuggestions(null); setSelectedSuggestions([]); setSuggestionUndo([]);
          lastWrittenRef.current = null;
          resultSessionRef.current = requestSessionId;
          setNote(data.execution?.reason === 'single-part-faithful' && data.execution.modelInvocations === 0
            ? '原文无需分段，未调用模型；尚未写回输入框' : '已生成预览，尚未写回输入框');
        }).catch(function (err) {
          if (abortRef.current !== controller) return;
          if (controller.signal.aborted) setNote('已取消');
          else setNote(String(err && err.message || err) + (previousResult ? '；原有预览已保留' : ''));
        }).finally(function () {
          if (abortRef.current === controller) { abortRef.current = null; setBusy(false); }
        });
      }

      function requestSuggestions() {
        if (!supportsSuggestions || !result || busy || !validEdited()) return;
        if (resultSessionRef.current !== props.sessionId) { setNote('会话已切换，请重新生成预览'); return; }
        var snapshot = edited;
        var previousResult = result;
        var requestSessionId = props.sessionId;
        var controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setNote('正在获取可选建议，正文保持原样；这会调用文本模型。');
        promptRequest('optimize', { text: snapshot, target: result.target, mode: 'optimize', editing: 'suggestions', rules: [],
          sessionId: props.sessionId, route: selectedRoute || undefined }, controller.signal).then(function (data) {
          if (abortRef.current !== controller || controller.signal.aborted) return;
          if (sessionRef.current !== requestSessionId || resultRef.current !== previousResult || editedRef.current !== snapshot) {
            setNote('预览已变化，本次建议未载入；请针对当前文字重新获取。'); return;
          }
          var ids = [];
          if (!data.ok || data.original !== snapshot || data.optimized !== snapshot || data.target !== previousResult.target || data.editing?.strategy !== 'suggestions'
              || !Array.isArray(data.suggestions) || data.suggestions.length > 6 || !Array.isArray(data.questions) || data.questions.length > 6
              || !data.suggestions.every(function (item) {
                if (!item || typeof item.id !== 'string' || !/^suggestion-[1-6]$/.test(item.id) || ids.indexOf(item.id) >= 0
                    || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80
                    || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 600) return false;
                ids.push(item.id); return true;
              }) || !data.questions.every(function (text) { return typeof text === 'string' && text.trim() && text.length <= 600; })) throw new Error('未收到完整补充建议');
          setSuggestions({ source: snapshot, items: data.suggestions, questions: data.questions, adopted: [], processing: data.processing });
          setSelectedSuggestions([]); setSuggestionUndo([]);
          setNote('建议尚未加入正文；只有采纳所选建议才会改变预览。');
        }).catch(function (err) {
          if (abortRef.current !== controller) return;
          setNote(controller.signal.aborted ? '已取消，原有预览保留' : String(err && err.message || err));
        }).finally(function () {
          if (abortRef.current === controller) { abortRef.current = null; setBusy(false); }
        });
      }

      function adoptSuggestions() {
        if (!suggestions || busy || !selectedSuggestions.length) return;
        var items = suggestions.items.filter(function (item) { return selectedSuggestions.indexOf(item.id) >= 0 && suggestions.adopted.indexOf(item.id) < 0; });
        if (!items.length) return;
        var next = edited + '\n\n' + items.map(function (item) { return item.text; }).join('\n\n');
        if (next.length > 16000) { setNote('采纳后将超过 16000 字符，请减少建议或手动编辑'); return; }
        var ids = items.map(function (item) { return item.id; });
        setSuggestionUndo(suggestionUndo.concat([{ before: edited, after: next, ids: ids }]));
        setSuggestions(Object.assign({}, suggestions, { adopted: suggestions.adopted.concat(ids) }));
        setEdited(next); editedRef.current = next; setSelectedSuggestions([]);
        setNote('已将所选建议加入预览，尚未写回；可以撤回上次采纳。');
      }

      function undoSuggestions() {
        var last = suggestionUndo[suggestionUndo.length - 1];
        if (!last || busy) return;
        if (edited !== last.after) { setNote('预览已被手动修改；请手动移除建议，撤回不会覆盖你的编辑。'); return; }
        setEdited(last.before); editedRef.current = last.before;
        setSuggestionUndo(suggestionUndo.slice(0, -1));
        if (suggestions) setSuggestions(Object.assign({}, suggestions, { adopted: suggestions.adopted.filter(function (id) { return last.ids.indexOf(id) < 0; }) }));
        setNote('已撤回上次采纳，尚未写回输入框。');
      }

      function editPreview(value) {
        setEdited(value); editedRef.current = value;
        setSuggestions(null); setSelectedSuggestions([]); setSuggestionUndo([]);
      }

      function cancel() {
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
          setBusy(false);
          setNote('已取消');
        }
      }

      function closePanel() { cancel(); setOpen(false); }

      function validEdited() {
        if (!edited.trim() || edited.length > 16000) { setNote('结果必须是非空文本且不超过 16000 字符'); return false; }
        return true;
      }

      function replaceDraft(text) {
        if (!result) return;
        if (resultSessionRef.current !== props.sessionId) { setNote('会话已切换，请在当前会话重新生成预览'); return; }
        if (refCount || phase !== 'plain') { setNote('当前输入框正忙或含结构化引用，暂不写回'); return; }
        if (text !== result.original && !validEdited()) return;
        if (draft !== result.original && draft !== lastWrittenRef.current && !window.confirm('输入框内容在优化期间已变化，仍要替换吗？')) return;
        props.inputActions.setDraft(text);
        lastWrittenRef.current = text;
        setNote(text === result.original ? '已恢复优化前原文' : '已写回输入框；不会自动发送');
      }

      function copyResult() {
        if (!result || !validEdited()) return;
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(edited).then(function () { setNote('已复制优化结果'); }).catch(function () { setNote('复制失败，请手动选择文本'); });
        } else {
          setNote('浏览器不支持自动复制，请手动选择文本');
        }
      }

      function importConfig(event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        file.text().then(function (raw) {
          var parsed;
          try { parsed = JSON.parse(raw); } catch (_) { throw new Error('文件不是有效 JSON，请检查格式后重新导入'); }
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

      function resetConfig(scope) {
        if (scope === 'instructions' && !supportsResetInstructions) { setNote('当前后端不支持仅恢复指令，请更新后重新载入'); return; }
        var question = scope === 'instructions' ? '仅恢复 Iris 内置系统指令和全部用途模板？模型路由、生成参数和入口开关保持不变。'
          : '恢复全部 Iris 提示词设置？系统指令、全部用途模板、模型路由、生成参数与预算、入口开关都会重置；模型路由恢复为当前会话，入口重新启用。';
        if (!window.confirm(question)) return;
        promptRequest('reset', { scope: scope }).then(function (data) {
          publishConfig(data);
          setNote(scope === 'instructions' ? '已恢复默认指令；模型路由、生成参数与入口开关保持不变' : '已恢复全部 Iris 提示词设置');
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
      var changes = result ? promptChanges(result.original, edited) : null;
      var targetInfo = PROMPT_TARGET_OPTIONS.find(function (item) { return item.value === target; }) || PROMPT_TARGET_OPTIONS[0];
      var resultTarget = result && PROMPT_TARGET_OPTIONS.find(function (item) { return item.value === result.target; });
      var config = configState && configState.config;
      var targetTemplate = config && config.targets && config.targets[target];
      var requestConfigFeedback = result && promptConfigFeedback({ feedback: result.configFeedback });
      function ruleField(label, value, update, placeholder) {
        return React.createElement('label', { className: 'iris-po-field' }, React.createElement('span', {}, label),
          React.createElement('textarea', { value: value, disabled: busy || !supportsRules, placeholder: placeholder,
            onChange: function (event) { update(event.target.value); } }));
      }

      var panel = null;
      if (open) {
        panel = React.createElement(React.Fragment, {},
          React.createElement('dialog', { ref: panelRef, tabIndex: -1, className: 'iris-po-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Iris 提示词优化',
            onCancel: function (event) { event.preventDefault(); closePanel(); },
            onClick: function (event) {
              event.stopPropagation();
              if (event.target !== event.currentTarget) return;
              var bounds = event.currentTarget.getBoundingClientRect();
              if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePanel();
            } },
          React.createElement('div', { className: 'iris-po-head' },
            React.createElement('strong', { className: 'iris-po-title' }, React.createElement('span', { className: 'iris-po-mark' }, '🫧'), 'Iris 提示词优化'),
            React.createElement('button', { className: 'iris-po-close', onClick: closePanel, title: '关闭', 'aria-label': '关闭提示词优化' }, '✕')),
          React.createElement('div', { className: 'iris-po-intro' },
          React.createElement('div', { className: 'iris-po-muted' }, '按用途整理草稿，先预览和编辑，再决定是否写回。'),
          promptConfigFeedback(configState),
            React.createElement('div', { className: 'iris-po-principles' },
              React.createElement('span', {}, '保留原意'), React.createElement('span', {}, '可查看改动'), React.createElement('span', {}, '确认后写回'))),
          React.createElement('details', { className: 'iris-po-section', open: generalOpen,
            onToggle: function (event) { generalPair[1](event.currentTarget.open); } },
            React.createElement('summary', {}, '一般功能',
              React.createElement('span', { className: 'iris-po-section-caption' }, targetInfo.label + ' · 提示词优化' + (result ? ' · 有预览' : ''))),
            React.createElement('div', { className: 'iris-po-section-body' },
          React.createElement('div', { className: 'iris-po-targets', role: 'group', 'aria-label': '优化目标' },
            PROMPT_TARGET_OPTIONS.map(function (item) {
              return React.createElement('button', { key: item.value, type: 'button', className: 'iris-po-target',
                'aria-pressed': target === item.value, value: item.value,
                disabled: busy || !supportsTarget(item.value), title: supportsTarget(item.value) ? item.description : '当前后端未提供此目标',
                onClick: function () { setTarget(item.value); } }, item.label);
            })),
          React.createElement('div', { className: 'iris-po-muted' }, targetInfo.description),
          supportsFaithful ? React.createElement('div', { className: 'iris-po-editing', role: 'group', 'aria-label': '编辑方式' },
            ['faithful', 'rewrite'].map(function (strategy) {
              return React.createElement('label', { key: strategy }, React.createElement('input', { type: 'radio', name: 'iris-prompt-editing',
                value: strategy, checked: editing === strategy, disabled: busy, onChange: function () { editingPair[1](strategy); } }), strategy === 'faithful' ? '忠实整理（默认）' : '改写表达');
            }),
            React.createElement('div', { className: 'iris-po-muted' }, editing === 'faithful' ? '保持原文和句序，只调整分组与分段；不补充细节。' : '按本次规则改写，结果需逐项核对；未授权内容保持原意。')) : null,
          React.createElement('div', { className: 'iris-po-source' },
            React.createElement('div', { className: 'iris-po-source-head' }, '当前草稿', React.createElement('span', {}, (draft || '').length + ' 字符')),
            React.createElement('p', { className: 'iris-po-source-text' }, draft || '先在对话输入框写下你的想法。')),
          React.createElement('details', { className: 'iris-po-config' },
            React.createElement('summary', {}, '本次规则（可选）'),
            React.createElement('div', { className: 'iris-po-rules' },
              ruleField('改写规则 · 仅智能优化使用', optimizationText, setOptimizationText, '例如：保持简短，保留全部否定条件'),
              ruleField('输出前缀 · 原样加入结果开头', prefixText, setPrefixText, '例如：请以摄影师的视角描述以下画面。'),
              ruleField('输出后缀 · 原样加入结果末尾', suffixText, setSuffixText, '例如：禁止添加文字和水印。')),
            React.createElement('div', { className: 'iris-po-muted' }, supportsRules ? '非空内容表示本次选择；只组装保留原稿，只添加前后缀。刷新后重置，不修改 JSON 配置。' : '当前后端尚未支持规则，请更新后重新载入。')),
          React.createElement('div', { className: 'iris-po-actions' },
            React.createElement('button', { className: 'iris-po-primary', disabled: busy || !draft || !draft.trim() || phase !== 'plain' || refCount > 0, onClick: function () { optimize('optimize'); } }, busy ? '处理中…' : supportsFaithful ? editing === 'faithful' ? '忠实整理' : '改写表达' : '智能优化'),
            React.createElement('button', { className: 'iris-po-btn', disabled: busy || !supportsAssembly || !draft || !draft.trim() || phase !== 'plain' || refCount > 0, onClick: function () { optimize('assemble'); } }, '只组装（不调用模型）'),
            busy ? React.createElement('button', { className: 'iris-po-btn', onClick: cancel }, '取消') : null),
          React.createElement('div', { className: 'iris-po-muted' }, supportsLocalFaithful
            ? '单片段忠实整理与只组装不调用模型；其他优化及获取建议可能产生模型费用。'
            : '智能优化调用文本模型，可能产生费用；只组装原稿与前后缀。'),
          result ? React.createElement('div', { className: 'iris-po-result' },
            React.createElement('div', { className: 'iris-po-result-label' }, '结果预览 · ' + (resultTarget ? resultTarget.label + ' · ' : '') + '可编辑 · ' + edited.length + ' 字符'),
            React.createElement('textarea', { 'aria-label': '结果预览', value: edited, onChange: function (event) { editPreview(event.target.value); } }),
            result.editing?.strategy === 'faithful' ? React.createElement('div', { className: 'iris-po-muted' }, '本次整理保留了全部原文片段与句序；手动编辑或采纳建议后，请重新核对内容。') : null,
            supportsSuggestions ? React.createElement('details', { className: 'iris-po-config' },
              React.createElement('summary', {}, '可选补充与待确认'),
              React.createElement('div', { className: 'iris-po-muted' }, '建议独立生成，默认未采纳；不会自动加入正文或写回。每次获取会调用文本模型。'),
              React.createElement('button', { className: 'iris-po-btn', disabled: busy || !edited.trim(), onClick: requestSuggestions }, '获取补充建议'),
              suggestions ? React.createElement('div', {},
                suggestions.items.map(function (item) {
                  var adopted = suggestions.adopted.indexOf(item.id) >= 0;
                  return React.createElement('div', { className: 'iris-po-suggestion', key: item.id },
                    React.createElement('label', {}, React.createElement('input', { type: 'checkbox', checked: adopted || selectedSuggestions.indexOf(item.id) >= 0, disabled: busy || adopted,
                      onChange: function (event) { setSelectedSuggestions(event.target.checked ? selectedSuggestions.concat([item.id]) : selectedSuggestions.filter(function (id) { return id !== item.id; })); } }), item.label + (adopted ? ' · 已加入预览' : '')),
                    React.createElement('p', {}, item.text));
                }),
                !suggestions.items.length ? React.createElement('div', { className: 'iris-po-muted' }, '没有额外补充建议。') : null,
                suggestions.questions.length ? React.createElement('div', { className: 'iris-po-suggestion' }, React.createElement('strong', {}, '待确认 · 尚未作为要求'),
                  suggestions.questions.map(function (question, index) { return React.createElement('p', { key: index }, question); })) : null,
                promptRequestSnapshot(suggestions.processing, '本次建议完整指令'),
                React.createElement('div', { className: 'iris-po-actions' },
                  React.createElement('button', { className: 'iris-po-btn', disabled: busy || !selectedSuggestions.length, onClick: adoptSuggestions }, '采纳所选建议'),
                  React.createElement('button', { className: 'iris-po-btn', disabled: busy || !suggestionUndo.length, onClick: undoSuggestions }, '撤回上次采纳'))) : null) : null,
            React.createElement('details', { className: 'iris-po-config' }, React.createElement('summary', {}, '原文与改动'),
              React.createElement('textarea', { 'aria-label': '优化前原文', readOnly: true, value: result.original }),
              React.createElement('div', { className: 'iris-po-muted' }, '以下折叠相同首尾，显示中间替换区：'),
              React.createElement('div', { className: 'iris-po-diff' },
                changes.removed ? React.createElement('del', {}, changes.removed) : null,
                changes.added ? React.createElement('ins', {}, changes.added) : null,
                !changes.removed && !changes.added ? '与原文相同' : null)),
            React.createElement('details', { className: 'iris-po-config' }, React.createElement('summary', {}, '本次参与规则'),
              (result.rules || []).length ? (result.rules || []).map(function (rule) {
                return React.createElement('div', { className: 'iris-po-diff', key: rule.id }, rule.label + '（' + (rule.kind === 'optimization' ? '指导改写' : rule.position === 'prefix' ? '输出前缀' : '输出后缀') + '）\n' + rule.text);
              }) : React.createElement('div', { className: 'iris-po-muted' }, '未选择额外规则'),
              result.processing ? React.createElement('div', { className: 'iris-po-diff' }, '优化处理规则：\n' + result.processing.systemPrompt + '\n\n目标模板：\n' + result.processing.targetTemplate) : null),
            promptRequestSnapshot(result.processing, '本次正文处理完整指令'),
            React.createElement('div', { className: 'iris-po-route' }, result.route ? '实际使用：' + result.route.provider + ' / ' + result.route.model + ' · 思考：' + (result.route.reasoningEffort === 'provider-default' ? '供应商默认' : result.route.reasoningEffort)
              : result.execution?.reason === 'single-part-faithful' && result.execution.modelInvocations === 0 ? '忠实整理：无需分段，未调用模型'
              : result.mode === 'assemble' ? '本次只组装，未调用模型' : '未提供模型调用信息'),
            result.route && result.route.reason ? React.createElement('div', { className: 'iris-po-muted' }, '选择原因：' + result.route.reason + ' · ' + (result.route.textInput === 'supported' ? '宿主声明支持文本输入' : '文本输入能力未知')) : null,
            requestConfigFeedback ? React.createElement('details', { className: 'iris-po-config' },
              React.createElement('summary', {}, '本次请求的配置反馈'), requestConfigFeedback) : null,
            React.createElement('div', { className: 'iris-po-actions' },
              React.createElement('button', { className: 'iris-po-primary', onClick: function () { replaceDraft(edited); } }, '写回输入框'),
              React.createElement('button', { className: 'iris-po-btn', onClick: copyResult }, '复制'),
              React.createElement('button', { className: 'iris-po-btn', disabled: busy, onClick: function () { optimize(result.mode); } }, '重新生成预览'),
              React.createElement('button', { className: 'iris-po-btn', onClick: function () { replaceDraft(result.original); } }, '恢复原文'))) : null,
          note ? React.createElement('div', { className: 'iris-po-note', role: 'status' }, note) : null)),
          React.createElement('details', { className: 'iris-po-config' },
            React.createElement('summary', {}, '指令与模型设置'),
            React.createElement('div', { className: 'iris-po-route', title: routeLabel }, '模型：' + routeLabel + ' · 思考：' + reasoningLabel + ' · 输出：' + outputBudget + ' tokens'),
            React.createElement('details', {}, React.createElement('summary', {}, '查看当前功能的优化指令'),
              React.createElement('div', { className: 'iris-po-template' }, config && config.systemPrompt || '配置尚未载入'),
              React.createElement('div', { className: 'iris-po-template' }, targetTemplate || '当前后端未提供此目标模板')),
            React.createElement('div', { className: 'iris-po-result-label' }, 'JSON 配置'),
            React.createElement('div', { className: 'iris-po-muted' }, '导入会替换当前配置；局部 JSON 缺少的字段使用内置默认值。可导出后修改 systemPrompt、targets、route 和 generation，再重新导入。'),
            React.createElement('div', { className: 'iris-po-actions' },
              React.createElement('button', { className: 'iris-po-btn', onClick: exportConfig }, '导出'),
              React.createElement('button', { className: 'iris-po-btn', disabled: busy, onClick: function () { if (fileRef.current) fileRef.current.click(); } }, '导入'),
              React.createElement('button', { className: 'iris-po-btn', disabled: busy || !supportsResetInstructions,
                title: supportsResetInstructions ? '只更新系统指令与全部用途模板' : '当前后端尚未支持仅恢复指令', onClick: function () { resetConfig('instructions'); } }, '仅恢复默认指令'),
              React.createElement('button', { className: 'iris-po-btn danger', disabled: busy, onClick: function () { resetConfig('all'); } }, '恢复全部设置'),
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
          onClick: function () { if (open) closePanel(); else setOpen(true); }
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

    /* 曲线鸢尾花：矢量源见 docs/assets/logo/iris-bubble.svg。
       使用实色与无 ID 的路径，多个座位同时渲染也不会发生 SVG 引用冲突。 */
    var IRIS_MARK_PARTS = [
      { fill: '#7db9a4', d: 'M30.5 39h3v18h-3z' },
      { fill: '#7db9a4', d: 'M32 55C24 55 20 50 19 44C26 45 31 48 32 55Z' },
      { fill: '#9cd1b7', d: 'M32 54C40 53 44 49 45 43C38 44 33 48 32 54Z' },
      { fill: '#b5a0f3', d: 'M29 31C18 30 11 22 15 14C24 13 30 20 29 31Z' },
      { fill: '#b5a0f3', d: 'M35 31C46 30 53 22 49 14C40 13 34 20 35 31Z' },
      { fill: '#e0d4ff', d: 'M32 7C24 13 23 23 32 34C41 23 40 13 32 7Z' },
      { fill: '#9b80df', d: 'M31 31C22 24 11 28 8 36C12 45 24 47 31 34Z' },
      { fill: '#9b80df', d: 'M33 31C42 24 53 28 56 36C52 45 40 47 33 34Z' },
      { fill: '#c4aff6', d: 'M32 29C24 35 23 44 32 50C41 44 40 35 32 29Z' },
      { fill: '#f2ce83', d: 'M32 31C29 32 28 34 29 36L32 40L35 36C36 34 35 32 32 31Z' }
    ];
    function IRIS_MARK_SVG() {
      return React.createElement('svg', {
        width: 26, height: 26, viewBox: '0 0 64 64',
        role: 'img', 'aria-label': 'Iris', focusable: 'false'
      }, IRIS_MARK_PARTS.map(function (part, i) {
        return React.createElement('path', { key: i, d: part.d, fill: part.fill });
      }));
    }

    function FloatingBubble() {
      var state = useIrisState(5000);
      var providers = (state && state.providers) || [];
      var fallbackConfigured = providers.some(function (p) { return p.enabled && p.apiKeyHint; });
      var overallState = state && state.health && HEALTH_META[state.health.overall]
        ? state.health.overall : (fallbackConfigured ? 'configured' : 'unconfigured');
      var overallCooling = overallState === 'failed' && state.health.retryAt;
      var overallHealth = overallCooling ? 'cooling' : overallState;
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
        title: 'Iris ' + healthText({ status: overallState, rateLimited: !!overallCooling, retryAt: overallCooling || undefined }) + '：点击打开快捷面板'
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
