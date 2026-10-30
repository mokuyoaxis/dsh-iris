export async function mount(context) {
  const { container, api, session, theme, signal } = context;
  const evidence = window.__panelPlugin ??= { contexts: [], events: [] };
  evidence.contexts.push(context); evidence.events.push('library:mount');
  signal.addEventListener('abort', () => evidence.events.push('library:abort'), { once: true });
  const title = document.createElement('h2'); title.textContent = '你的创作，可以继续生长。';
  const note = document.createElement('p'); note.dataset.library = 'true'; note.textContent = '正在读取当前工作区…';
  const palette = document.createElement('p'); palette.className = 'palette';
  const update = value => { palette.textContent = value.mode + ' · ' + value.density; container.dataset.theme = value.mode; };
  update(theme.current()); const unsubscribe = theme.subscribe(update);
  container.append(title, note, palette);
  const runs = await api.runs({ limit: '3' }); signal.throwIfAborted();
  note.textContent = '当前工作区 · ' + runs.total + ' 个流程'; container.dataset.root = session.rootId;
  return () => {
    unsubscribe(); container.replaceChildren(); evidence.events.push('library:cleanup');
    if (evidence.failCleanup) throw new Error('Controlled cleanup failure');
  };
}
