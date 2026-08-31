'use strict';
/**
 * dsh-iris —— Client 半（M4 泡泡工作台）。
 *
 * 两个零替换风险的座位：
 * - settings.section（id: 'iris-workbench'）：常驻泡泡工作台整页 ——
 *   供应商状态（Key 只见 hint）+ 历史任务面板 + 运行中任务进度 + 播放链接；
 * - conversation.input.dock（id: 'iris-progress'）：composer 上方常驻进度条，
 *   有运行中任务时显式一行进度，无则渲染 null（零占用）。
 *
 * 数据通道：host 侧 /iris/api/state 同源 JSON 路由（复用 /iris/media 同款
 * webServer 前缀模式），client 侧 fetch 轮询 5s。全走标量，
 * apiKey 永不明文，产物给授权播放链接。
 */
export const name = 'dsh-iris-client';

export function apply(ctx) {
  // Client 依赖注入由 package.json 的 dsh.client.inject 声明（含 ui-slots），
  // 装载管线保证到达，这里直接使用注入面
  const slots = ctx.slots;
  if (!slots) return;

  const css = `
.iris-wb { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, #e6e6e6); }
.iris-wb-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 10px; }
.iris-wb-head .iris-wb-title { font-size: 14px; font-weight: 600; }
.iris-wb-head .iris-wb-date { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }
.iris-wb-sec { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.iris-wb-box { display: grid; gap: 8px; }
.iris-wb-card { background: var(--dsw-alias-bg-layer-1, #26262e); border: 1px solid var(--dsw-alias-border-l1, #3a3a44); border-radius: 8px; padding: 8px 10px; }
.iris-wb-card.iris-running { border-left: 3px solid var(--dsw-alias-state-warn-primary, #d9a941); }
.iris-wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.iris-wb-kv { color: var(--dsw-alias-label-secondary, #9a9a9a); }
.iris-wb-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #32323c); }
.iris-wb-badge.ok { color: var(--dsw-alias-state-success-primary, #6fcf6f); }
.iris-wb-badge.err { color: var(--dsw-alias-state-error-primary, #e06c6c); }
.iris-wb-progress { margin-top: 6px; }
.iris-wb-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #32323c); overflow: hidden; }
.iris-wb-bar i { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #7aa2f7); }
.iris-wb-link { color: var(--dsw-alias-brand-primary, #7aa2f7); text-decoration: none; }
.iris-wb-link:hover { text-decoration: underline; }
.iris-wb-muted { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; }
.iris-wb-empty { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 12px; padding: 6px 2px; }
.iris-progress-dock { display: grid; gap: 6px; }
.iris-progress-row { font-size: 12px; display: flex; gap: 8px; align-items: center; color: var(--dsw-alias-label-secondary, #9a9a9a); }
`;

  ctx.effect(() => styles.insert(css), 'iris: workbench styles');

  /* ---------------- 数据拉取（同源 /iris/api/state，5s 轮询） ---------------- */

  function useIrisState(tickMs) {
    const [state, setState] = React.useState(null);
    React.useEffect(() => {
      let alive = true;
      const load = async () => {
        try {
          const res = await fetch('/iris/api/state');
          if (!res.ok) return;
          const data = await res.json();
          if (alive) setState(data);
        } catch (_) {
          /* 网络抖动静默 */
        }
      };
      load();
      const id = setInterval(load, tickMs || 5000);
      return () => { alive = false; clearInterval(id); };
    }, [tickMs]);
    return state;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function fmtElapsed(ms) {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }

  function taskRow(task, isRunning) {
    const badge = task.status === 'succeeded'
      ? React.createElement('span', { className: 'iris-wb-badge ok' }, '成功')
      : task.status === 'failed'
        ? React.createElement('span', { className: 'iris-wb-badge err' }, '失败')
        : React.createElement('span', { className: 'iris-wb-badge' }, task.status);
    const cells = [
      React.createElement('span', { className: 'iris-wb-kv' }, task.cap),
      badge,
      React.createElement('span', { className: 'iris-wb-kv' }, task.model || ''),
      React.createElement('span', { className: 'iris-wb-muted' }, String(task.prompt || '').slice(0, 60))
    ];
    if (task.error) cells.push(React.createElement('span', { className: 'iris-wb-badge err' }, String(task.error).slice(0, 40)));
    const links = (task.media || [])
      .map((m) => React.createElement('a', {
        key: m.file, className: 'iris-wb-link', href: m.url, target: '_blank', rel: 'noreferrer'
      }, '▶ ' + m.file));
    const body = [
      React.createElement('div', { className: 'iris-wb-row' }, ...cells),
      links.length ? React.createElement('div', { className: 'iris-wb-row' }, ...links) : null
    ];
    if (isRunning) {
      const pct = String(task.progress || '');
      body.push(React.createElement('div', { className: 'iris-wb-progress' },
        React.createElement('div', { className: 'iris-wb-bar' },
          React.createElement('i', { style: { width: pct }} )),
        React.createElement('div', { className: 'iris-wb-muted' }, pct + (task.elapsedMs ? ' · ' + fmtElapsed(task.elapsedMs) : ''))));
    } else {
      body.push(React.createElement('div', { className: 'iris-wb-muted' },
        task.createdAt ? '发起 ' + fmtTime(task.createdAt) : '', task.finishedAt ? ' · 完成 ' + fmtTime(task.finishedAt) : ''));
    }
    return React.createElement('div', { key: task.id, className: 'iris-wb-card' + (isRunning ? ' iris-running' : '') }, ...body);
  }

  function WorkbenchPanel() {
    const state = useIrisState(5000);
    const running = (state && state.tasks && state.tasks.running) || [];
    const recent = (state && state.tasks && state.tasks.recent) || [];
    const providers = (state && state.providers) || [];
    return React.createElement('div', { className: 'iris-wb' },
      React.createElement('div', { className: 'iris-wb-head' },
        React.createElement('span', { className: 'iris-wb-title' }, '🫧 Iris 泡泡工作台'),
        React.createElement('span', { className: 'iris-wb-date' }, state ? '刷新于 ' + new Date().toLocaleTimeString() : '加载中…')),
      React.createElement('div', { className: 'iris-wb-sec' }, '供应商'),
      React.createElement('div', { className: 'iris-wb-box' },
        providers.length ? providers.map((p) => React.createElement('div', { key: p.id, className: 'iris-wb-card' },
          React.createElement('div', { className: 'iris-wb-row' },
            React.createElement('span', {}, p.name || p.id),
            React.createElement('span', { className: 'iris-wb-badge ' + (p.enabled ? 'ok' : '') }, p.enabled ? '已启用' : '已停用'),
            React.createElement('span', { className: 'iris-wb-kv' }, p.type || ''),
            React.createElement('span', { className: 'iris-wb-kv' }, p.baseUrl || '' )),
          React.createElement('div', { className: 'iris-wb-muted' },
            'Key ' + (p.apiKeyHint || '未配置') + ' · ' + (p.mediaProtocol || '') + (p.imageModel ? ' · 画:' + p.imageModel : '') +
            (p.videoModel ? ' · 视频:' + p.videoModel : '') + (p.ttsModel ? ' · 语音:' + p.ttsModel : '') + (p.visionModel ? ' · 视觉:' + p.visionModel : ''))))
          : React.createElement('div', { className: 'iris-wb-empty' }, '暂无可用供应商 — 在 Iris 设置页添加并启用')),
      React.createElement('div', { className: 'iris-wb-sec' }, '运行中任务'),
      React.createElement('div', { className: 'iris-wb-box' },
        running.length ? running.map((t) => taskRow(t, true)) : React.createElement('div', { className: 'iris-wb-empty' }, '暂无进行中任务')), 
      React.createElement('div', { className: 'iris-wb-sec' }, '最近任务'),
      React.createElement('div', { className: 'iris-wb-box' },
        recent.length ? recent.map((t) => taskRow(t, false)) : React.createElement('div', { className: 'iris-wb-empty' }, '尚无任务记录')));
  }

  function ProgressDock() {
    const state = useIrisState(5000);
    const running = (state && state.tasks && state.tasks.running) || [];
    if (!running.length) return null;
    return React.createElement('div', { className: 'iris-progress-dock' },
      running.map((t) => React.createElement('div', { key: t.id, className: 'iris-progress-row' },
        React.createElement('span', {}, '🫧 ' + t.cap),
        React.createElement('span', {}, t.model || ''),
        React.createElement('span', {}, String(t.progress || '')))));
  }

  /* ---------------- 注册座位 ---------------- */

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'iris-workbench',
    order: 140,
    label: () => 'Iris 泡泡工作台'
  }, WorkbenchPanel));

  slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'iris-progress',
    order: 0,
    label: () => 'Iris 任务进度'
  }, ProgressDock));
}