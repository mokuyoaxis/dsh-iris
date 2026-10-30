export async function mount(context) {
  const evidence = window.__panelPlugin ??= { contexts: [], events: [] }; evidence.contexts.push(context); evidence.events.push('slow:mount');
  await new Promise(resolve => { evidence.resumeSlow = resolve; });
  const label = document.createElement('p'); label.textContent = '旧挂载的延迟内容'; context.container.append(label);
  return () => { context.container.replaceChildren(); evidence.events.push('slow:cleanup'); };
}
