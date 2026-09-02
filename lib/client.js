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

    function taskRow(task, isRunning) {
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
          key: m.file, className: 'iris-wb-link', href: m.url, target: '_blank', rel: 'noreferrer'
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
      return React.createElement('div', { key: task.id, className: 'iris-wb-card' + (isRunning ? ' iris-running' : '') }, ...body);
    }

    function WorkbenchPanel() {
      var state = useIrisState(5000);
      var running = (state && state.tasks && state.tasks.running) || [];
      var recent = (state && state.tasks && state.tasks.recent) || [];
      var providers = (state && state.providers) || [];
      return React.createElement('div', { className: 'iris-wb' },
        React.createElement('div', { className: 'iris-wb-head' },
          React.createElement('span', { className: 'iris-wb-title' }, '🫧 Iris 泡泡工作台'),
          React.createElement('span', { className: 'iris-wb-date' }, state ? '刷新于 ' + new Date().toLocaleTimeString() : '加载中…')),
        React.createElement('div', { className: 'iris-wb-sec' }, '供应商'),
        React.createElement('div', { className: 'iris-wb-box' },
          providers.length ? providers.map(function (p) {
            return React.createElement('div', { key: p.id, className: 'iris-wb-card' },
              React.createElement('div', { className: 'iris-wb-row' },
                React.createElement('span', {}, p.name || p.id),
                React.createElement('span', { className: 'iris-wb-badge ' + (p.enabled ? 'ok' : '') }, p.enabled ? '已启用' : '已停用'),
                React.createElement('span', { className: 'iris-wb-kv' }, p.type || ''),
                React.createElement('span', { className: 'iris-wb-kv' }, p.baseUrl || '')),
              React.createElement('div', { className: 'iris-wb-muted' },
                'Key ' + (p.apiKeyHint || '未配置') + ' · ' + (p.mediaProtocol || '') +
                (p.imageModel ? ' · 画:' + p.imageModel : '') +
                (p.videoModel ? ' · 视频:' + p.videoModel : '') +
                (p.ttsModel ? ' · 语音:' + p.ttsModel : '') +
                (p.visionModel ? ' · 视觉:' + p.visionModel : '')));
          }) : React.createElement('div', { className: 'iris-wb-empty' }, '暂无可用供应商 — 在 Iris 设置页添加并启用')),
        React.createElement('div', { className: 'iris-wb-sec' }, '运行中任务'),
        React.createElement('div', { className: 'iris-wb-box' },
          running.length ? running.map(function (t) { return taskRow(t, true); })
            : React.createElement('div', { className: 'iris-wb-empty' }, '暂无进行中任务')),
        React.createElement('div', { className: 'iris-wb-sec' }, '最近任务'),
        React.createElement('div', { className: 'iris-wb-box' },
          recent.length ? recent.map(function (t) { return taskRow(t, false); })
            : React.createElement('div', { className: 'iris-wb-empty' }, '尚无任务记录')));
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