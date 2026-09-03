/**
 * dsh-iris —— Client 半（M4 泡泡工作台）。
 *
 * DSH web client bundle 标准形态（与 dsh-at-file / dsh-better-sidebar 同构）：
 * window.__ModuleLoader__.load({ id, factory }) → CJS 工厂，require 解析宿主依赖，
 * `inject` 声明本 bundle 需要的 ctx 服务 key（这里是 slots），
 * `apply(ctx)` 里直接 `ctx.slots.inject(...)` 注册座位。
 *
 * 两个零替换风险的座位：
 * - settings.section（id: 'iris-workbench'）：常驻泡泡工作台整页 ——
 *   供应商状态（Key 只见 hint）+ 历史任务面板 + 运行中任务进度 + 播放链接；
 * - conversation.input.dock（id: 'iris-progress'）：composer 上方常驻进度条，
 *   有运行中任务时显式一行进度，无则渲染 null（零占用）。
 *
 * 数据通道：host 侧 /iris/api/state 同源 JSON 路由（复用 /iris/media 同款
 * webServer 前缀模式），client 侧 fetch 轮询。全走标量，
 * apiKey 永不明文，产物给授权播放链接。
 */
window.__ModuleLoader__.load({ id: 'dsh-iris', factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;

  var React = require('react');

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
    '.iris-wb-drawer { margin-top: 8px; padding: 10px; border-top: 1px dashed var(--dsw-alias-border-l1, #3a3a44); display: grid; gap: 6px; }',
    '.iris-wb-drawer .iris-wb-k { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11px; text-transform: uppercase; }',
    '.iris-wb-drawer .iris-wb-prompt { white-space: pre-wrap; word-break: break-word; font-size: 12px; }',
    '.iris-wb-drawer .iris-wb-err { color: var(--dsw-alias-state-error-primary, #e06c6c); white-space: pre-wrap; word-break: break-word; font-size: 12px; }',
    '.iris-wb-loading { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
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
    '.iris-pm-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary, #9a9a9a); margin-right: 4px; }',
    '.iris-pm-dot.lit { background: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 6px var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-pm-model-sel { background: var(--dsw-alias-bg-layer-2, #32323c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 4px; padding: 4px 6px; font-size: 12px; width: 100%; }',
    '.iris-wb-drawer .iris-wb-loading { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }',
    '.iris-bubble { position: fixed; z-index: 9999; cursor: grab; user-select: none; touch-action: none; }',
    '.iris-bubble.dragging { cursor: grabbing; }',
    '.iris-bubble-btn { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--dsw-alias-bg-layer-2, #32323c); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); transition: box-shadow 0.2s, border-color 0.2s, opacity 0.2s; }',
    '.iris-bubble.lit .iris-bubble-btn { border-color: var(--dsw-alias-state-success-primary, #6fcf6f); box-shadow: 0 0 14px var(--dsw-alias-state-success-primary, #6fcf6f); }',
    '.iris-bubble.dim .iris-bubble-btn { opacity: 0.55; border-color: var(--dsw-alias-border-l1, #3a3a44); }',
    '.iris-bubble-badge { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--dsw-alias-state-warn-primary, #d9a941); color: #1a1a1e; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; padding: 0 3px; }',
    '.iris-bubble-panel { position: fixed; z-index: 9998; width: 360px; max-height: min(520px, 70vh); overflow: auto; background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 12px; padding: 12px 14px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45); }',
    '.iris-bubble-panel-head { position: absolute; top: 6px; right: 6px; z-index: 2; }',
    '.iris-bubble-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 14px; cursor: pointer; padding: 4px 6px; }',
    '.iris-bubble-close:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }'
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

    /* ---- 三个座位共享一份状态订阅（模块级 pub/sub，不再各自轮询） ---- */
    var sharedState = null;
    var sharedListeners = [];
    var sharedTimer = null;

    function useIrisState(tickMs) {
      var pair = React.useState(sharedState);
      var setState = pair[1];
      React.useEffect(function () {
        function listener(data) {
          setState(data);
        }
        sharedListeners.push(listener);
        if (sharedState) setState(sharedState);
        if (!sharedTimer) {
          function load() {
            fetch('/iris/api/state')
              .then(function (res) { return res.ok ? res.json() : null; })
              .then(function (data) {
                if (data) {
                  sharedState = data;
                  for (var i = 0; i < sharedListeners.length; i++) {
                    sharedListeners[i](data);
                  }
                }
              })
              .catch(function () { /* 网络抖动静默 */ });
          }
          load();
          sharedTimer = setInterval(load, tickMs || 5000);
        }
        return function () {
          var idx = sharedListeners.indexOf(listener);
          if (idx >= 0) sharedListeners.splice(idx, 1);
          if (sharedListeners.length === 0 && sharedTimer) {
            clearInterval(sharedTimer);
            sharedTimer = null;
          }
        };
      }, [tickMs]);
      return sharedState;
    }

    /* ---- 任务详情抽屉：按需拉取 /iris/api/task/:id ---- */
    function useTaskDetail(taskId) {
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
      }, [taskId]);
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

    /* ---- 任务详情抽屉：点击任务卡片行展开 ---- */
    function TaskDetailDrawer({ taskId }) {
      var detail = useTaskDetail(taskId);
      if (!detail) {
        return React.createElement('div', { className: 'iris-wb-drawer iris-wb-loading' }, '加载任务详情…');
      }
      var el = [];
      el.push(React.createElement('div', { key: 'k', className: 'iris-wb-k' }, '提示词'));
      el.push(React.createElement('div', { key: 'p', className: 'iris-wb-prompt' }, detail.prompt || '（空）'));
      if (detail.error) {
        el.push(React.createElement('div', { key: 'ek', className: 'iris-wb-k' }, '错误'));
        el.push(React.createElement('div', { key: 'e', className: 'iris-wb-err' }, detail.error));
      }
      var kv = [
        ['ID', detail.id],
        ['能力', detail.cap],
        ['状态', detail.status],
        ['模型', detail.model],
        ['供应商', detail.providerName],
        ['模式', detail.mode || '—'],
        ['远端任务', detail.remoteTaskId || '—'],
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
      return React.createElement('div', { className: 'iris-wb-drawer' }, ...el);
    }

    function taskRow(task, isRunning, selected, onSelect) {
      var badge;
      if (task.status === 'succeeded') {
        badge = React.createElement('span', { className: 'iris-wb-badge ok' }, '成功');
      } else if (task.status === 'failed') {
        badge = React.createElement('span', { className: 'iris-wb-badge err' }, '失败');
      } else {
        badge = React.createElement('span', { className: 'iris-wb-badge' }, task.status);
      }
      var cells = [
        React.createElement('span', { className: 'iris-wb-kv' }, task.cap),
        badge,
        React.createElement('span', { className: 'iris-wb-kv' }, task.model || ''),
        React.createElement('span', { className: 'iris-wb-muted' }, String(task.prompt || '').slice(0, 60))
      ];
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
      if (selected) body.push(React.createElement(TaskDetailDrawer, { key: 'drawer', taskId: task.id }));
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

    function ProviderManager() {
      var listPair = React.useState(null);
      var list = listPair[0];
      var setList = listPair[1];
      var openPair = React.useState(null); // 展开的 provider id
      var setOpen = openPair[1];
      var addingPair = React.useState(false);
      var adding = addingPair[0];
      var setAdding = addingPair[1];
      var newForm = React.useState({ name: '', baseUrl: '', apiKey: '', type: 'openai' });
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
        setNote('测试「' + (p.name || p.id) + '」的视觉能力…');
        postAction('providers_test_vision', { id: p.id }).then(function (r) { setNote(r.d.text || r.d.error || '测试完成'); refresh(); });
      }
      var cards = (list || []).map(function (p) {
        var open = openPair[0] === p.id;
        var body = null;
        if (open) {
          var modelChips = (p.models || []).map(function (m) {
            return React.createElement('span', { key: m.id, className: 'iris-pm-model' },
              m.id + ' ',
              React.createElement('span', { className: 'iris-pm-cap' }, (m.capabilities || []).join(',')));
          });
          body = React.createElement('div', { className: 'iris-pm-body' },
            React.createElement('div', { className: 'iris-pm-note' }, 'Key ' + (p.apiKeyHint || '未配置') + ' · ' + (p.type || '') + ' · ' + (p.mediaProtocol || '')),
            React.createElement('div', { className: 'iris-pm-note' }, '能力: ' + (p.capabilities || []).join(' / ') || '无'),
            React.createElement('div', { className: 'iris-pm-note' }, '模型池:'),
            React.createElement('div', { className: 'iris-pm-models' }, modelChips.length ? modelChips : React.createElement('span', { className: 'iris-pm-note' }, '暂无模型 — 配置模型字段或等待自动发现')),
            React.createElement('div', { className: 'iris-wb-row' },
              React.createElement('button', { className: 'iris-pm-btn', onClick: function () { toggle(p); } }, p.enabled ? '停用' : '启用'),
              React.createElement('button', { className: 'iris-pm-btn', onClick: function () { testVision(p); } }, '测试视觉'),
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
          React.createElement('div', { className: 'iris-pm-field' }, React.createElement('label', {}, 'API Key *'), React.createElement('input', { type: 'password', value: newForm[0].apiKey, placeholder: 'sk-...', onChange: function (e) { newForm[1]({ ...newForm[0], apiKey: e.target.value }); } })),
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
      function setVal(key, value) { var nv = {}; Object.keys(vals).forEach(function (k) { nv[k] = vals[k]; }); nv[key] = value; setVals(nv); }
      function loadModels() {
        if (!capability) return;
        postAction('assignments_get', {}).then(function (r) {
          if (!r.ok || !r.d) return;
          var opts = (r.d.poolByCapability && r.d.poolByCapability[capability]) || [];
          var assigned = (r.d.assignments && r.d.assignments[capability]) || (opts[0] && opts[0].id) || '';
          if (!vals.model && opts.length) setVal('model', opts[0].id);
          setModelInfo({ assigned: assigned, options: opts, loaded: true });
        });
      }
      React.useEffect(function () { if (open && capability) loadModels(); }, [open]);
      function assignModel(id) {
        setVal('model', id);
        postAction('assignments_set', { capability: capability, model_id: id }).then(function () { loadModels(); });
      }
      function submit() {
        if (run === 'running') return;
        setRun('running');
        fetch('/iris/api/actions/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(vals)
        })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) { setRun(res.ok ? { ok: true, text: res.d.text || '', img: res.d.imageDataUrl || null } : { ok: false, text: res.d.error || '执行失败' }); })
          .catch(function () { setRun({ ok: false, text: '网络错误' }); });
      }
      var body = null;
      if (open) {
        var inputs = fields.map(function (f) {
          var node;
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
        // 能力分配 UI：下拉选模型 + 亮/暗指示（有模型淡绿，无模型黯淡）
        var modelBar = null;
        if (capability) {
          var lit = modelInfo && modelInfo.loaded && modelInfo.options.length > 0;
          var select = null;
          if (modelInfo && modelInfo.loaded) {
            var opts = [React.createElement('option', { key: '', value: '' }, '（自动选择）')].concat(
              (modelInfo.options || []).map(function (o) {
                return React.createElement('option', { key: o.id, value: o.id }, o.id + (o.providerId ? ' · ' + o.providerId : ''));
              }));
            select = React.createElement('select', {
              className: 'iris-pm-model-sel', value: vals.model || modelInfo.assigned || '',
              onChange: function (e) { assignModel(e.target.value); }
            }, opts);
          }
          modelBar = React.createElement('div', { className: 'iris-act-field' },
            React.createElement('label', {},
              React.createElement('span', { className: lit ? 'iris-pm-dot lit' : 'iris-pm-dot' }, '●'),
              ' 模型分配' + (lit ? '' : '（无可用模型）')),
            select || React.createElement('div', { className: 'iris-wb-muted' }, '加载模型池…'));
        }
        body = React.createElement('div', { className: 'iris-act-body' },
          modelBar,
          inputs,
          React.createElement('button', { className: 'iris-act-run', disabled: run === 'running', onClick: submit },
            run === 'running' ? '执行中…' : '执行'),
          result);
      }
      var headLit = !capability || (modelInfo && modelInfo.loaded && modelInfo.options.length > 0);
      return React.createElement('div', { className: 'iris-act-card' + (open ? ' open' : '') + (headLit ? ' lit' : ' dim') },
        React.createElement('div', { className: 'iris-act-head', onClick: function () { setOpen(!open); } },
          React.createElement('span', { className: 'iris-act-title' }, title),
          capability ? React.createElement('span', { className: headLit ? 'iris-pm-dot lit' : 'iris-pm-dot', title: headLit ? '模型可用' : '无可用模型' }, '●') : null,
          React.createElement('span', { className: 'iris-act-arrow' }, '▶')),
        body);
    }

    function ActionGroups() {
      return React.createElement('div', { className: 'iris-act-group' },
        React.createElement(ActionCard, {
          title: '🎨 画图', action: 'image', capability: 'image-gen',
          fields: [{ key: 'prompt', label: '提示词', type: 'textarea', placeholder: '详细描述要生成的图片' },
            { key: 'size', label: '尺寸 (可选)', placeholder: '如 1024*1024' },
            { key: 'model', label: '模型 (可选)', placeholder: '默认 provider 模型' }]
        }),
        React.createElement(ActionCard, {
          title: '🎬 视频', action: 'video', capability: 'video-gen',
          fields: [{ key: 'prompt', label: '提示词', type: 'textarea', placeholder: '描述画面/运动' },
            { key: 'first_frame_path', label: '首帧路径 (可选)', placeholder: '/path/frame.png' },
            { key: 'size', label: '尺寸 (可选)', placeholder: '如 1280*720' },
            { key: 'model', label: '模型 (可选)', placeholder: '如 wan2.2-t2v-flash' }]
        }),
        React.createElement(ActionCard, {
          title: '🔊 语音合成', action: 'tts', capability: 'tts',
          fields: [{ key: 'text', label: '文本', type: 'textarea', placeholder: '要合成的文字' },
            { key: 'voice', label: '音色 (可选)', placeholder: '如 Cherry' }]
        }),
        React.createElement(ActionCard, {
          title: '🎙️ 音频转写', action: 'transcribe',
          fields: [{ key: 'audio_path', label: '音频路径', placeholder: '/path/audio.wav' }]
        }),
        React.createElement(ActionCard, {
          title: '🎞️ 视频抽帧', action: 'video_frames',
          fields: [{ key: 'video_path', label: '视频路径', placeholder: '/path/video.mp4' },
            { key: 'max_frames', label: '最多帧数 (可选)', placeholder: '8（1-20）' },
            { key: 'target_width', label: '目标宽度 (可选)', placeholder: '640' },
            { key: 'format', label: '格式 (可选)', placeholder: 'jpeg 或 png' }]
        }),
        React.createElement(ActionCard, {
          title: '📝 视频摘要', action: 'media_summarize', capability: 'vision',
          fields: [{ key: 'video_path', label: '视频路径', placeholder: '/path/video.mp4' },
            { key: 'question', label: '问题 (可选)', type: 'textarea', placeholder: '默认：总结画面内容/场景/主题' },
            { key: 'max_frames', label: '采样帧数 (可选)', placeholder: '8（1-12）' },
            { key: 'transcribe_text', label: '已有转写文本 (可选)', type: 'textarea', placeholder: '若已转写音轨可粘贴，摘要将结合语音内容' }]
        }),
        React.createElement(ActionCard, {
          title: '👁 看图', action: 'look', capability: 'vision',
          fields: [{ key: 'image_path', label: '图片路径', placeholder: '/path/image.png' },
            { key: 'question', label: '问题 (可选)', placeholder: '默认：详细描述' }]
        }),
        React.createElement(ActionCard, {
          title: '✂️ 裁剪', action: 'crop',
          fields: [{ key: 'image_path', label: '图片路径', placeholder: '/path/image.png' },
            { key: 'left', label: 'left', placeholder: '0' },
            { key: 'top', label: 'top', placeholder: '0' },
            { key: 'width', label: 'width', placeholder: '100' },
            { key: 'height', label: 'height', placeholder: '100' }]
        }),
        React.createElement(ActionCard, {
          title: '📷 像素差异', action: 'diff',
          fields: [{ key: 'image_a_path', label: '图 A 路径', placeholder: '/path/a.png' },
            { key: 'image_b_path', label: '图 B 路径', placeholder: '/path/b.png' }]
        }),
        React.createElement(ActionCard, {
          title: '📍 定位', action: 'locate', capability: 'vision',
          fields: [{ key: 'image_path', label: '图片路径', placeholder: '/path/image.png' },
            { key: 'target', label: '目标', placeholder: '如 红色按钮' },
            { key: 'model', label: '模型 (可选)', placeholder: '如 qwen3-vl-235b-a22b-thinking' }]
        }),
        React.createElement(ActionCard, {
          title: '🖼️ HTML 截图', action: 'html',
          fields: [{ key: 'html', label: 'HTML', type: 'textarea', placeholder: '<h1>Hello</h1>' },
            { key: 'fullPage', label: '整页截图', type: 'checkbox' }]
        }),
        React.createElement(ActionCard, {
          title: '📄 长截图 OCR', action: 'ocr', capability: 'vision',
          fields: [{ key: 'image_path', label: '图片路径', placeholder: '/path/long.png' },
            { key: 'chunk_height', label: '分块高度 (可选)', placeholder: '1200' },
            { key: 'overlap', label: '重叠 (可选)', placeholder: '120' }]
        }),
        React.createElement(ActionCard, {
          title: '🔄 重看 (附件)', action: 'relook', capability: 'vision',
          fields: [{ key: 'attachment_id', label: 'attachment id (iris 画图产物)', placeholder: 'sha256:...' },
            { key: 'question', label: '问题', placeholder: '再问一次这张图' }]
        }),
        React.createElement(ActionCard, {
          title: '📋 任务查询', action: 'status',
          fields: [{ key: 'task_id', label: 'task id (留空查最近)', placeholder: 't_xxx 或留空' }]
        }));
    }

    function WorkbenchPanel() {
      var state = useIrisState(5000);
      var running = (state && state.tasks && state.tasks.running) || [];
      var recent = (state && state.tasks && state.tasks.recent) || [];
      var selPair = React.useState(null);
      var selectedTask = selPair[0];
      var setSelectedTask = selPair[1];
      function onSelect(id) { setSelectedTask(id); }
      return React.createElement('div', { className: 'iris-wb' },
        React.createElement('div', { className: 'iris-wb-head' },
          React.createElement('span', { className: 'iris-wb-title' }, '🫧 Iris 泡泡工作台'),
          React.createElement('span', { className: 'iris-wb-date' }, state ? '刷新于 ' + new Date().toLocaleTimeString() : '加载中…')),
        React.createElement('div', { className: 'iris-wb-sec' }, '供应商'),
        React.createElement(ProviderManager, {}),
        React.createElement('div', { className: 'iris-wb-sec' }, '运行中任务'),
        React.createElement('div', { className: 'iris-wb-box' },
          running.length ? running.map(function (t) { return taskRow(t, true, selectedTask === t.id, onSelect); })
            : React.createElement('div', { className: 'iris-wb-empty' }, '暂无进行中任务')),
        React.createElement('div', { className: 'iris-wb-sec' }, '最近任务'),
        React.createElement('div', { className: 'iris-wb-box' },
          recent.length ? recent.map(function (t) { return taskRow(t, false, selectedTask === t.id, onSelect); })
            : React.createElement('div', { className: 'iris-wb-empty' }, '尚无任务记录')),
        React.createElement('div', { className: 'iris-wb-sec' }, '操作'),
        React.createElement(ActionGroups, {}));
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

    function FloatingBubble() {
      var state = useIrisState(5000);
      var providers = (state && state.providers) || [];
      var configured = providers.some(function (p) { return p.enabled && p.apiKeyHint; });
      var running = (state && state.tasks && state.tasks.running) || [];

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

      function onPointerUp(e) {
        var drag = dragRef.current;
        if (!drag) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
        var moved = drag.moved;
        dragRef.current = null;
        if (moved) {
          try { localStorage.setItem('iris-bubble-pos', JSON.stringify(pos)); } catch (_) {}
        } else {
          setOpen(!open);
        }
      }

      var style;
      if (pos.x != null && pos.y != null) {
        style = { left: pos.x + 'px', top: pos.y + 'px' };
      } else {
        style = { right: DEFAULT_X + 'px', bottom: DEFAULT_Y + 'px' };
      }

      var badge = running.length
        ? React.createElement('span', { className: 'iris-bubble-badge' }, running.length)
        : null;

      var panel = null;
      if (open) {
        var xy = bubbleXY();
        var panelLeft = Math.max(8, xy.x - 330);
        var panelTop = Math.max(8, Math.min(xy.y - 260, window.innerHeight - 520));
        panel = React.createElement('div', { className: 'iris-bubble-panel', style: { left: panelLeft + 'px', top: panelTop + 'px' } },
          React.createElement('div', { className: 'iris-bubble-panel-head' },
            React.createElement('button', { className: 'iris-bubble-close', onClick: function () { setOpen(false); } }, '✕')),
          React.createElement(WorkbenchPanel, {}),
          React.createElement('div', { className: 'iris-wb-muted' }, '完整工作台：设置 → Iris 泡泡工作台'));
      }

      return React.createElement('div', {
        className: 'iris-bubble' + (configured ? ' lit' : ' dim') + (dragRef.current ? ' dragging' : ''),
        style: style,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        title: configured ? 'Iris 已就绪：点击展开工作室' : 'Iris 未配置 API：点击展开工作室'
      },
        React.createElement('div', { className: 'iris-bubble-btn' }, '🫧'),
        badge,
        panel);
    }

    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register({
        name: 'settings.section',
        id: 'iris-workbench',
        order: 140,
        label: function () { return 'Iris 泡泡工作台'; }
      }, WorkbenchPanel);
    });

    ctx.slots.inject('conversation.input.dock', function () {
      return ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'iris-progress',
        order: 0,
        label: function () { return 'Iris 任务进度'; }
      }, ProgressDock);
    });

    ctx.slots.inject('shell.overlay', function () {
      return ctx.slots.register({
        name: 'shell.overlay',
        id: 'iris-bubble',
        order: 200,
        label: function () { return 'Iris 悬浮泡泡'; }
      }, FloatingBubble);
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